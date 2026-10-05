/**
 * AI DJ tests, including the model tier.
 *
 * The model tier talks to `ctx.llm.stream()`, whose chunk vocabulary is
 * documented but was never exercised here. These tests drive it with a stub
 * service that emits the documented chunks, so both the happy path and every
 * fallback are covered without a provider.
 *
 * No network. Run with `node test/dj.test.mjs`.
 *
 * @module dsh-music/test/dj
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Pacer } from '../lib/cache.js';
import { AiDj, curationRequest, curationSessionId } from '../lib/dj.js';
import { Player } from '../lib/state.js';
import { SessionStore } from '../lib/session.js';

// --------------------------------------------------------------- fixtures

/** Disjoint id ranges per source make the candidate pool order predictable. */
function makeApi(overrides = {}) {
  const range = (base, count, origin) =>
    Array.from({ length: count }, (_, index) => ({
      id: base + index,
      name: `${origin} ${index}`,
      artists: [`Artist ${index % 3}`],
      album: `${origin} album`,
      duration: 180_000,
      picUrl: `http://p1.music.126.net/${base + index}.jpg`,
      fee: 8,
      vip: false,
    }));
  const daily = range(1000, 4, 'daily');
  const fresh = range(2000, 4, 'new');
  const chart = range(3000, 4, 'chart');
  const similar = range(4000, 4, 'similar');
  const prompt = range(5000, 4, 'prompt');

  return {
    daily,
    fresh,
    chart,
    similar,
    prompt,
    simiSongs: async (_id, { limit } = {}) => similar.slice(0, limit ?? similar.length),
    searchSongs: async (_query, { limit } = {}) => ({ total: prompt.length, tracks: prompt.slice(0, limit ?? prompt.length) }),
    recommendSongs: async () => daily,
    personalizedNewsongs: async () => fresh,
    playlistDetail: async () => ({ id: 1, name: 'chart', tracks: chart }),
    withCovers: async (tracks) => tracks,
    ...overrides,
  };
}

/**
 * A stub LLM service emitting the documented stream chunks.
 * @see {@link AiDj} — the model tier reads `type`/`kind` and `text`.
 */
function makeLlm({ reply, fail, kind = 'type', providers, models, chunks } = {}) {
  const calls = [];
  return {
    calls,
    listProviders: () => providers ?? [{ id: 'opencode-go' }, { id: 'xiaomi-token-plan-cn' }],
    listModels: async (provider) =>
      (models ?? { 'opencode-go': [{ id: 'minimax-m3' }, { id: 'deepseek-v4-flash' }], 'xiaomi-token-plan-cn': [{ id: 'qwen3-max' }] })[provider] ?? [],
    stream(options) {
      calls.push(options);
      return (async function* emitted() {
        // `chunks` yields a verbatim stream, for asserting on protocol shapes.
        if (chunks) {
          for (const chunk of chunks) yield chunk;
          return;
        }
        if (fail) {
          // The real terminal shape: the descriptor is `reason.failure`, and it
          // carries the stable code. There is no top-level `failure`.
          const failure = typeof fail === 'string' ? { message: fail, code: 'PROVIDER_ERROR' } : fail;
          yield { type: 'finish', reason: { kind: 'error', failure } };
          return;
        }
        const half = Math.ceil((reply ?? '').length / 2);
        // Deliberately emit under the `kind` spelling for half the suite: the
        // service README documents `kind` while the implementation emits
        // `type`, and the assembler must accept either.
        const delta = kind === 'kind' ? { kind: 'text-delta' } : { type: 'text-delta' };
        yield { ...delta, index: 0, text: reply.slice(0, half) };
        yield { ...delta, index: 0, text: reply.slice(half) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

/**
 * Build a DJ over real Player/SessionStore and stub everything external.
 *
 * `agentDefault` stands in for `ctx.agentDefaultModel.currentSelection()` — the
 * model the agent loop itself runs on, which an unpinned DJ follows.
 */
function makeDj({
  api = makeApi(),
  llm,
  model = {},
  agentDefault = null,
  sessionId,
  now,
  // No gaps by default, so the suite does not wait out a pacing meant for NetEase.
  pacer = new Pacer({ minGapMs: 0, jitterMs: 0 }),
} = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-music-dj-'));
  const store = new SessionStore({ file: path.join(dataDir, 'session.json') });
  store.load();
  store.updateSettings({ djBatchSize: 3, djAutoExtendBelow: 2, djPrompt: '' });
  const player = new Player();
  const dj = new AiDj({
    api,
    player,
    store,
    resolveLlm: () => llm,
    readAgentDefault: () => agentDefault,
    sessionId,
    logger: { info() {}, warn() {}, debug() {} },
    model,
    now,
    pacer,
  });
  return { dj, player, store, api, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

const picks = (...indices) => JSON.stringify({ vibe: 'late night drive', picks: indices.map((index) => ({ index, why: 'fits' })) });

// ------------------------------------------------------------ model tier

test('the model tier curates when a route is pinned', async () => {
  const llm = makeLlm({ reply: picks(3, 1) });
  const harness = makeDj({ llm, model: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } });
  try {
    const plan = await harness.dj.plan({ prompt: 'rainy afternoon jazz', count: 3 });

    assert.equal(plan.source, 'model');
    assert.equal(plan.route, 'opencode-go/deepseek-v4.1-flash');
    assert.equal(plan.vibe, 'late night drive');
    // The pinned route must be the one actually called.
    assert.equal(llm.calls[0].provider, 'opencode-go');
    assert.equal(llm.calls[0].model, 'deepseek-v4.1-flash');
    // With a mood brief, prompt matches carry priority 0 and lead the pool, so
    // indices 3 and 1 select the fourth and second search hits.
    assert.deepEqual(plan.tracks.map((track) => track.id), [5003, 5001]);

    // The prompt must carry the mood and the catalogue the model chooses from.
    const brief = llm.calls[0].messages[0].content[1].text;
    assert.match(brief, /rainy afternoon jazz/);
    assert.match(brief, /CANDIDATES/);
    assert.match(brief, /prompt 0/, 'the search hits are the candidates');
    assert.match(llm.calls[0].messages[0].content[0].text, /JSON only/);
  } finally {
    harness.cleanup();
  }
});

test('the model tier accepts the `kind` chunk spelling', async () => {
  // The service README documents `kind`; the implementation emits `type`.
  const llm = makeLlm({ reply: picks(0), kind: 'kind' });
  const harness = makeDj({ llm, model: { provider: 'opencode-go', model: 'm' } });
  try {
    const plan = await harness.dj.plan({ count: 1 });
    assert.equal(plan.source, 'model', 'the assembler must read either spelling');
    assert.deepEqual(plan.tracks.map((track) => track.id), [1000]);
  } finally {
    harness.cleanup();
  }
});

test('out-of-range and repeated picks are discarded', async () => {
  const llm = makeLlm({ reply: picks(0, 0, 99, 2, -3) });
  const harness = makeDj({ llm, model: { provider: 'opencode-go', model: 'm' } });
  try {
    const plan = await harness.dj.plan({ count: 3 });
    assert.deepEqual(plan.tracks.map((track) => track.id), [1000, 1002], 'duplicates and invalid indices drop');
  } finally {
    harness.cleanup();
  }
});

test('prose around the JSON is tolerated', async () => {
  const llm = makeLlm({ reply: `Sure! Here is my set:\n\`\`\`json\n${picks(1)}\n\`\`\`\nEnjoy.` });
  const harness = makeDj({ llm, model: { provider: 'opencode-go', model: 'm' } });
  try {
    const plan = await harness.dj.plan({ count: 1 });
    assert.equal(plan.source, 'model');
    assert.deepEqual(plan.tracks.map((track) => track.id), [1001]);
  } finally {
    harness.cleanup();
  }
});

test('a malformed reply falls back to the heuristic tier', async () => {
  const llm = makeLlm({ reply: 'I would rather not answer in JSON.' });
  const harness = makeDj({ llm, model: { provider: 'opencode-go', model: 'm' } });
  try {
    const plan = await harness.dj.plan({ count: 3 });
    assert.equal(plan.source, 'heuristic');
    assert.match(plan.note, /model tier unavailable/);
    assert.match(plan.note, /no JSON object/, 'the reason is carried, not swallowed');
    assert.match(harness.dj.modelError, /no JSON object/);
    assert.equal(plan.tracks.length, 3, 'the queue is still stocked');
  } finally {
    harness.cleanup();
  }
});

test('a failed model stream falls back and records why', async () => {
  const llm = makeLlm({ fail: 'RATE_LIMIT' });
  const harness = makeDj({ llm, model: { provider: 'opencode-go', model: 'm' } });
  try {
    const plan = await harness.dj.plan({ count: 2 });
    assert.equal(plan.source, 'heuristic');
    assert.match(plan.note, /RATE_LIMIT/);
    assert.match(harness.dj.modelError, /RATE_LIMIT/);
    // A top-up surfaces the same reason to the panel and `/music/health`.
    await harness.dj.topUp({ force: true });
    assert.match(harness.player.dj.modelError, /RATE_LIMIT/);
  } finally {
    harness.cleanup();
  }
});

test('a missing LLM service is reported as such, not as a model failure', async () => {
  const harness = makeDj({ llm: undefined });
  try {
    const plan = await harness.dj.plan({ count: 2 });
    assert.equal(plan.source, 'heuristic');
    assert.match(plan.note, /no LLM service is mounted/);
    assert.match(harness.dj.modelError, /no LLM service is mounted/);
    assert.equal(plan.tracks.length, 2, 'the queue is still stocked without a model');
  } finally {
    harness.cleanup();
  }
});

test('a successful model plan clears the recorded reason', async () => {
  const llm = makeLlm({ fail: 'RATE_LIMIT' });
  const harness = makeDj({ llm, model: { provider: 'opencode-go', model: 'm' } });
  try {
    await harness.dj.plan({ count: 1 });
    assert.ok(harness.dj.modelError, 'a reason is recorded first');

    // Retry with a working stream.
    const working = makeLlm({ reply: picks(0) });
    harness.dj.resolveLlm = () => working;
    const plan = await harness.dj.plan({ count: 1 });
    assert.equal(plan.source, 'model');
    assert.equal(harness.dj.modelError, null, 'success clears the stale reason');
    assert.equal(harness.player.dj.modelError, null);
  } finally {
    harness.cleanup();
  }
});

test('an incomplete pin that cannot be completed names what it tried', async () => {
  // A pin with no model needs the catalogue to fill the gap; when that comes
  // back empty the reason has to name the half-configured pair, because the
  // user's config is the thing to fix.
  const llm = makeLlm({ reply: picks(0), providers: [{ id: 'opencode-go' }], models: {} });
  const harness = makeDj({ llm, model: { provider: 'opencode-go' } });
  try {
    const plan = await harness.dj.plan({ count: 1 });
    assert.equal(plan.source, 'heuristic');
    assert.match(harness.dj.modelError, /opencode-go\/\?/, 'the configured pair is named');
    assert.equal(llm.calls.length, 0, 'no provider call is attempted without a model');
  } finally {
    harness.cleanup();
  }
});

test('an empty pick list falls back to the heuristic tier', async () => {
  const llm = makeLlm({ reply: JSON.stringify({ vibe: 'nothing fits', picks: [] }) });
  const harness = makeDj({ llm, model: { provider: 'opencode-go', model: 'm' } });
  try {
    const plan = await harness.dj.plan({ count: 2 });
    assert.equal(plan.source, 'heuristic');
    assert.equal(plan.tracks.length, 2);
  } finally {
    harness.cleanup();
  }
});

// ------------------------------------- model-call identity (the header)

test('every model call carries the DJ session identity', async () => {
  const llm = makeLlm({ reply: picks(1) });
  const harness = makeDj({ llm, model: { provider: 'opencode-go', model: 'm' } });
  try {
    await harness.dj.plan({ count: 1 });

    // A leaf call cannot set headers: the session id is the only identity lever
    // a plugin has, and each adapter maps it onto its provider's own
    // per-conversation header.
    const call = llm.calls[0];
    assert.equal(typeof call.sessionId, 'string');
    assert.ok(call.sessionId.length > 0, 'an empty id is falsy, and pi-ai skips the header for it');
    assert.match(call.sessionId, /^music-dj-[0-9a-f-]{36}$/);
    assert.equal(call.headers, undefined, 'a leaf call has no headers to set');
  } finally {
    harness.cleanup();
  }
});

test('the identity is minted once, persisted, and per install', async () => {
  const first = makeDj({ llm: makeLlm({ reply: picks(0) }), model: { provider: 'p', model: 'm' } });
  let minted;
  try {
    minted = first.dj.sessionId;
    assert.equal(minted.length > 0, true);
    assert.equal(first.store.settings.djSessionId, minted, 'it is written to session.json');
    assert.equal(curationSessionId(first.store), minted, 'a reload resumes the same conversation');
  } finally {
    first.cleanup();
  }

  const second = makeDj({ llm: makeLlm({ reply: picks(0) }), model: { provider: 'p', model: 'm' } });
  try {
    assert.notEqual(second.dj.sessionId, minted, 'another install is another conversation');
  } finally {
    second.cleanup();
  }
});

test('a configured identity wins over the minted one', async () => {
  const harness = makeDj({
    llm: makeLlm({ reply: picks(0) }),
    model: { provider: 'p', model: 'm' },
    sessionId: 'music-dj-pinned',
  });
  try {
    assert.equal(harness.dj.sessionId, 'music-dj-pinned');
    assert.equal(harness.store.settings.djSessionId, '', 'a configured id is not written over the stored one');
  } finally {
    harness.cleanup();
  }
});

test('a request without an identity is refused instead of sent bare', () => {
  const target = { provider: 'p', model: 'm' };
  assert.throws(() => curationRequest({ target, messages: [], sessionId: '' }), /sessionId/);
  assert.throws(() => curationRequest({ target, messages: [] }), /sessionId/);

  const request = curationRequest({ target, messages: [], sessionId: 'music-dj-x' });
  assert.deepEqual(request, { provider: 'p', model: 'm', messages: [], sessionId: 'music-dj-x' });
  assert.equal('headers' in request, false);
});

// ------------------------------------------------- where the route comes from

test('an unpinned DJ follows the session model instead of discovery', async () => {
  // The catalogue would offer xiaomi first; the deployment's own model must win,
  // because that is the model the agent loop itself runs on.
  const llm = makeLlm({
    reply: picks(0),
    providers: [{ id: 'xiaomi-token-plan-cn' }],
    models: { 'xiaomi-token-plan-cn': [{ id: 'qwen3-max' }] },
  });
  const session = { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' };
  const harness = makeDj({ llm, agentDefault: session });
  try {
    const plan = await harness.dj.plan({ count: 1 });

    assert.equal(plan.route, 'opencode-go/deepseek-v4.1-flash', 'the session model is the default, not the first route');
    assert.equal(harness.dj.resolvedFrom, 'agent-default');
    assert.equal(llm.calls[0].provider, 'opencode-go');
    assert.equal(llm.calls[0].sessionId, harness.dj.sessionId);

    const status = harness.dj.modelStatus();
    assert.equal(status.sessionModel, 'opencode-go/deepseek-v4.1-flash');
    assert.equal(status.pinned, null);
    assert.equal(status.resolvedFrom, 'agent-default');
    assert.equal(status.sessionId, harness.dj.sessionId);
  } finally {
    harness.cleanup();
  }
});

test('a pinned route overrides the session model', async () => {
  const llm = makeLlm({ reply: picks(0) });
  const harness = makeDj({
    llm,
    model: { provider: 'opencode-go', model: 'minimax-m3' },
    agentDefault: { provider: 'deepseek-official', model: 'deepseek-chat' },
  });
  try {
    const plan = await harness.dj.plan({ count: 1 });

    assert.equal(plan.route, 'opencode-go/minimax-m3');
    assert.equal(harness.dj.resolvedFrom, 'pin');
    assert.equal(harness.dj.modelStatus().pinned, 'opencode-go/minimax-m3');
    assert.equal(llm.calls[0].model, 'minimax-m3');
  } finally {
    harness.cleanup();
  }
});

// ------------------------------------------------------------- discovery

test('discovery picks the first provider and its first catalogue model', async () => {
  const llm = makeLlm({ reply: picks(0) });
  const harness = makeDj({ llm });
  try {
    const plan = await harness.dj.plan({ count: 1 });
    assert.equal(plan.route, 'opencode-go/minimax-m3', 'discovery is a convenience, not a recommendation');
    assert.equal(llm.calls[0].provider, 'opencode-go');
    assert.equal(llm.calls[0].model, 'minimax-m3');
  } finally {
    harness.cleanup();
  }
});

test('a pinned provider alone wins over the first one', async () => {
  const llm = makeLlm({ reply: picks(0) });
  const harness = makeDj({ llm, model: { provider: 'xiaomi-token-plan-cn' } });
  try {
    const plan = await harness.dj.plan({ count: 1 });
    assert.equal(plan.route, 'xiaomi-token-plan-cn/qwen3-max');
    assert.equal(llm.calls[0].provider, 'xiaomi-token-plan-cn');
  } finally {
    harness.cleanup();
  }
});

test('a pinned model alone wins over the first catalogue model', async () => {
  const llm = makeLlm({ reply: picks(0) });
  const harness = makeDj({ llm, model: { model: 'deepseek-v4-flash' } });
  try {
    const plan = await harness.dj.plan({ count: 1 });
    assert.equal(plan.route, 'opencode-go/deepseek-v4-flash');
    assert.equal(llm.calls[0].model, 'deepseek-v4-flash');
  } finally {
    harness.cleanup();
  }
});

test('a host with no adapters yields no model tier', async () => {
  const llm = makeLlm({ reply: picks(0), providers: [] });
  const harness = makeDj({ llm });
  try {
    const plan = await harness.dj.plan({ count: 2 });
    assert.equal(plan.source, 'heuristic');
    assert.equal(llm.calls.length, 0, 'nothing to call');
  } finally {
    harness.cleanup();
  }
});

test('an adapter that fails to list models yields no model tier', async () => {
  const llm = makeLlm({ reply: picks(0), models: {} });
  const harness = makeDj({ llm });
  try {
    const plan = await harness.dj.plan({ count: 2 });
    assert.equal(plan.source, 'heuristic');
  } finally {
    harness.cleanup();
  }
});

// ------------------------------------------------------- failure reporting

test('a provider failure reports its stable code, not just its message', async () => {
  // Regression: the descriptor lives at `reason.failure`. Reading only a
  // top-level `failure` discarded the code and invented `Error: error`, which
  // turned a provider outage into an unactionable line.
  const harness = makeDj({
    llm: makeLlm({ chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'error' } } }] }),
    model: { provider: 'opencode-go', model: 'm' },
  });
  try {
    await harness.dj.plan({ count: 1 });
    assert.match(harness.dj.modelError, /AUTH/, 'the documented code must survive');
    assert.doesNotMatch(harness.dj.modelError, /^Error: error$/, 'and must not be replaced by a guess');
  } finally {
    harness.cleanup();
  }
});

test('an aborted stream reports ABORTED when the failure carries no code', async () => {
  const harness = makeDj({
    llm: makeLlm({ chunks: [{ type: 'finish', reason: { kind: 'aborted', failure: { message: 'stopped' } } }] }),
    model: { provider: 'opencode-go', model: 'm' },
  });
  try {
    await harness.dj.plan({ count: 1 });
    assert.match(harness.dj.modelError, /ABORTED: stopped/);
  } finally {
    harness.cleanup();
  }
});

test('a finish with no descriptor at all still reports something truthful', async () => {
  const harness = makeDj({
    llm: makeLlm({ chunks: [{ type: 'finish', reason: { kind: 'error' } }] }),
    model: { provider: 'opencode-go', model: 'm' },
  });
  try {
    await harness.dj.plan({ count: 1 });
    assert.match(harness.dj.modelError, /UNKNOWN: stream error/);
  } finally {
    harness.cleanup();
  }
});

test('the legacy top-level failure shape still parses', async () => {
  const harness = makeDj({
    llm: makeLlm({ chunks: [{ type: 'finish', reason: { kind: 'error' }, failure: { code: 'RATE_LIMIT', message: 'slow down' } }] }),
    model: { provider: 'opencode-go', model: 'm' },
  });
  try {
    await harness.dj.plan({ count: 1 });
    assert.match(harness.dj.modelError, /RATE_LIMIT: slow down/);
  } finally {
    harness.cleanup();
  }
});

test('failure details are carried through when present', async () => {
  const harness = makeDj({
    llm: makeLlm({
      chunks: [
        { type: 'finish', reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: 'none', details: { provider: 'nope' } } } },
      ],
    }),
    model: { provider: 'nope', model: 'm' },
  });
  try {
    await harness.dj.plan({ count: 1 });
    assert.match(harness.dj.modelError, /NO_ADAPTER: none/);
    assert.match(harness.dj.modelError, /provider.*nope/, 'the details are the part that names what to fix');
  } finally {
    harness.cleanup();
  }
});

// ------------------------------------------------------- model listing

test('listRoutes reports the routes and catalogues the picker shows', async () => {
  const llm = makeLlm({ reply: picks(0) });
  const harness = makeDj({ llm });
  try {
    const listed = await harness.dj.listRoutes();
    assert.equal(listed.error, null);
    assert.deepEqual(
      listed.routes.map((route) => route.provider),
      ['opencode-go', 'xiaomi-token-plan-cn'],
    );
    assert.deepEqual(
      listed.routes[0].models,
      [
        { id: 'minimax-m3', name: 'minimax-m3' },
        { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' },
      ],
    );
  } finally {
    harness.cleanup();
  }
});

test('listRoutes explains an absent model service instead of returning nothing', async () => {
  const harness = makeDj({ llm: undefined });
  try {
    const listed = await harness.dj.listRoutes();
    assert.deepEqual(listed.routes, []);
    assert.match(listed.error, /no LLM service is mounted/);
  } finally {
    harness.cleanup();
  }
});

test('listRoutes keeps a provider whose catalogue fails', async () => {
  const llm = makeLlm({ reply: picks(0) });
  llm.listModels = async (provider) => {
    if (provider === 'opencode-go') throw new Error('catalogue unavailable');
    return [{ id: 'qwen3-max', name: 'Qwen3 Max' }];
  };
  const harness = makeDj({ llm });
  try {
    const listed = await harness.dj.listRoutes();
    assert.equal(listed.error, null, 'one broken catalogue does not hide the other route');
    assert.deepEqual(listed.routes[0], { provider: 'opencode-go', models: [], error: 'could not list models: catalogue unavailable' });
    assert.deepEqual(listed.routes[1].models, [{ id: 'qwen3-max', name: 'Qwen3 Max' }]);
  } finally {
    harness.cleanup();
  }
});

test('setModel switches the route and clears the previous verdict', async () => {
  const failing = makeLlm({ fail: 'RATE_LIMIT' });
  const harness = makeDj({ llm: failing, model: { provider: 'opencode-go', model: 'm' } });
  try {
    await harness.dj.plan({ count: 1 });
    assert.match(harness.dj.modelError, /RATE_LIMIT/);

    // Picking a different route invalidates the old verdict.
    harness.dj.setModel({ provider: 'xiaomi-token-plan-cn', model: 'qwen3-max' });
    assert.equal(harness.dj.modelError, null);
    assert.equal(harness.player.dj.modelError, null);

    const working = makeLlm({ reply: picks(0) });
    harness.dj.resolveLlm = () => working;
    const plan = await harness.dj.plan({ count: 1 });
    assert.equal(plan.route, 'xiaomi-token-plan-cn/qwen3-max', 'the new route is used');
  } finally {
    harness.cleanup();
  }
});

test('setModel accepts clearing a half so discovery can fill it', async () => {
  const llm = makeLlm({ reply: picks(0) });
  const harness = makeDj({ llm, model: { provider: 'xiaomi-token-plan-cn', model: 'qwen3-max' } });
  try {
    harness.dj.setModel({ provider: null, model: null });
    assert.equal(harness.dj.modelConfigured, false);
    const plan = await harness.dj.plan({ count: 1 });
    assert.equal(plan.route, 'opencode-go/minimax-m3', 'discovery takes over once unpinned');
  } finally {
    harness.cleanup();
  }
});

// -------------------------------------------------- pool and queue behaviour

test('disliked and recently played tracks never reach the pool', async () => {
  const llm = makeLlm({ reply: picks(0) });
  const harness = makeDj({ llm, model: { provider: 'opencode-go', model: 'm' } });
  try {
    harness.store.recordFeedback('dislikes', 1001);
    harness.store.recordPlay({ id: 1002, name: 'daily 2', artists: ['Artist 2'] });

    const plan = await harness.dj.plan({ count: 4 });
    const ids = plan.tracks.map((track) => track.id);
    assert.equal(ids.includes(1001), false, 'a disliked track is excluded');
    assert.equal(ids.includes(1002), false, 'a recently played track is excluded');

    const brief = llm.calls[0].messages[0].content[1].text;
    assert.match(brief, /Recently played/, 'the digest reaches the model');
  } finally {
    harness.cleanup();
  }
});

test('a mood brief searches NetEase for candidates', async () => {
  const llm = makeLlm({ reply: picks(0) });
  const harness = makeDj({ llm, model: { provider: 'opencode-go', model: 'm' } });
  try {
    const plan = await harness.dj.plan({ prompt: '90s cantopop', count: 2 });
    const ids = plan.tracks.map((track) => track.id);
    // Prompt matches carry priority 0, so they lead the pool.
    assert.ok(ids.every((id) => id >= 5000 && id < 5004), `expected prompt matches, got ${ids}`);
  } finally {
    harness.cleanup();
  }
});

/** Run `body` with the ranker's jitter pinned, so heuristic orders are exact. */
async function withoutJitter(body) {
  const random = Math.random;
  Math.random = () => 0;
  try {
    return await body();
  } finally {
    Math.random = random;
  }
}

const tracksBy = (base, count, artist) =>
  Array.from({ length: count }, (_, index) => {
    const name = typeof artist === 'function' ? artist(index) : artist;
    return { id: base + index, name: `${name} ${index}`, artists: [name], duration: 180_000 };
  });

test('queued tracks never reach the pool, so every top-up adds a full batch', async () => {
  // The sources answer the same candidates every time, exactly as similarity
  // expansion does from a seed that has not changed; without jitter the ranker
  // would pick the same top three for every batch.
  const llm = makeLlm({ fail: 'offline' });
  const harness = makeDj({ llm, model: { provider: 'opencode-go', model: 'm' } });
  try {
    harness.player.dj.enabled = true;
    harness.player.setQueue([{ id: 900, name: 'seed', artists: ['Seed'], duration: 1000 }]);
    for (let batch = 0; batch < 3; batch += 1) {
      const before = harness.player.queue.length;
      const plan = await withoutJitter(() => harness.dj.topUp({ force: true }));
      assert.equal(harness.player.queue.length - before, 3, `batch ${batch} must land in full`);
      assert.equal(harness.player.dj.lastPlan.added, plan.tracks.length, 'the report counts what was queued');
    }
    const ids = harness.player.queue.map((track) => track.id);
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    harness.cleanup();
  }
});

test('topUp honours an explicit batch size', async () => {
  const llm = makeLlm({ fail: 'offline' });
  const harness = makeDj({ llm, model: { provider: 'opencode-go', model: 'm' } });
  try {
    const plan = await harness.dj.topUp({ force: true, count: 6 });
    assert.equal(plan.tracks.length, 6, 'the setting is 3; the argument wins');
  } finally {
    harness.cleanup();
  }
});

test('a model that over-picks is held to the requested count', async () => {
  const llm = makeLlm({ reply: picks(0, 1, 2, 3, 4, 5, 6) });
  const harness = makeDj({ llm, model: { provider: 'opencode-go', model: 'm' } });
  try {
    const plan = await harness.dj.plan({ count: 2 });
    assert.deepEqual(plan.tracks.map((track) => track.id), [1000, 1001]);
  } finally {
    harness.cleanup();
  }
});

test('the model is told what its picks follow', async () => {
  const llm = makeLlm({ reply: picks(0) });
  const harness = makeDj({ llm, model: { provider: 'opencode-go', model: 'm' } });
  try {
    harness.player.setQueue([
      { id: 900, name: 'Now', artists: ['Cur'], duration: 1000 },
      { id: 901, name: 'Last', artists: ['Tail'], duration: 1000 },
    ]);
    await harness.dj.plan({ count: 1 });
    const brief = llm.calls[0].messages[0].content[1].text;
    assert.match(brief, /Already queued after it: Last — Tail/);
    assert.match(brief, /Your picks play after: Last — Tail/);
  } finally {
    harness.cleanup();
  }
});

test('the heuristic tier puts a mood-brief match ahead of a favourite artist', async () => {
  const api = makeApi({
    simiSongs: async () => [],
    recommendSongs: async () => [],
    personalizedNewsongs: async () => [],
    playlistDetail: async () => ({ tracks: tracksBy(3000, 4, 'Fav') }),
    searchSongs: async () => ({ tracks: tracksBy(5000, 4, (index) => `P${index}`) }),
  });
  const harness = makeDj({ api });
  try {
    harness.store.recordPlay({ id: 1, name: 'old', artists: ['Fav'] });
    harness.store.recordPlay({ id: 2, name: 'older', artists: ['Fav'] });
    const plan = await withoutJitter(() => harness.dj.plan({ prompt: 'rainy jazz', count: 3 }));
    assert.equal(plan.source, 'heuristic');
    assert.ok(
      plan.tracks.every((track) => track.id >= 5000),
      `the brief's matches lead, got ${plan.tracks.map((track) => track.name)}`,
    );
  } finally {
    harness.cleanup();
  }
});

test('the heuristic batch does not open on the artist it is appended after', async () => {
  const api = makeApi({
    simiSongs: async () => [],
    personalizedNewsongs: async () => [],
    playlistDetail: async () => ({ tracks: tracksBy(3000, 4, 'Tail') }),
    recommendSongs: async () => tracksBy(1000, 4, 'Other'),
  });
  const harness = makeDj({ api });
  try {
    harness.store.recordPlay({ id: 1, name: 'old', artists: ['Tail'] });
    harness.player.setQueue([
      { id: 900, name: 'Now', artists: ['Cur'], duration: 1000 },
      { id: 901, name: 'Last', artists: ['Tail'], duration: 1000 },
    ]);
    const plan = await withoutJitter(() => harness.dj.plan({ count: 2 }));
    assert.deepEqual(
      plan.tracks.map((track) => track.artists[0]),
      ['Other', 'Tail'],
      'the favourite is held back one slot rather than doubling up on the queue tail',
    );
  } finally {
    harness.cleanup();
  }
});

/**
 * Record a play and then a skip of it, as the player does — then push it out
 * of the recently played window, which would otherwise exclude it on its own.
 */
function skipAndForget(store, track, times = 1) {
  for (let skip = 0; skip < times; skip += 1) {
    store.recordPlay(track);
    store.recordSkip(track.id);
  }
  for (let filler = 0; filler < 60; filler += 1) {
    store.recordPlay({ id: 90_000 + filler, name: `filler ${filler}`, artists: [`Filler ${filler}`] });
  }
}

test('a track skipped twice leaves the pool; once is only a penalty', async () => {
  const api = makeApi({
    simiSongs: async () => [],
    recommendSongs: async () => [],
    personalizedNewsongs: async () => [],
    playlistDetail: async () => ({ tracks: tracksBy(3000, 3, (index) => `C${index}`) }),
  });
  const harness = makeDj({ api });
  try {
    const [once, twice] = await api.playlistDetail().then((chart) => chart.tracks);
    harness.store.recordPlay(once);
    harness.store.recordSkip(once.id);
    skipAndForget(harness.store, twice, 2);

    const plan = await withoutJitter(() => harness.dj.plan({ count: 3 }));
    assert.deepEqual(plan.tracks.map((track) => track.id), [3002, 3000], 'the twice-skipped track is gone, the once-skipped one ranks last');
  } finally {
    harness.cleanup();
  }
});

test('an often-skipped artist ranks below one never skipped', async () => {
  const api = makeApi({
    simiSongs: async () => [],
    personalizedNewsongs: async () => [],
    playlistDetail: async () => ({ tracks: tracksBy(3000, 2, 'Shunned') }),
    recommendSongs: async () => tracksBy(1000, 2, 'Neutral'),
  });
  const harness = makeDj({ api });
  try {
    skipAndForget(harness.store, { id: 1, name: 'cut', artists: ['Shunned'] });
    harness.store.recordPlay({ id: 2, name: 'cut too', artists: ['Shunned'] });
    harness.store.recordSkip(2);

    const plan = await withoutJitter(() => harness.dj.plan({ count: 1 }));
    assert.equal(plan.tracks[0].artists[0], 'Neutral');
  } finally {
    harness.cleanup();
  }
});

test('the model is told what the listener skips', async () => {
  const llm = makeLlm({ reply: picks(0) });
  const harness = makeDj({ llm, model: { provider: 'opencode-go', model: 'm' } });
  try {
    for (const id of [1, 2]) {
      harness.store.recordPlay({ id, name: `cut ${id}`, artists: ['Shunned'] });
      harness.store.recordSkip(id);
    }
    await harness.dj.plan({ count: 1 });
    const brief = llm.calls[0].messages[0].content[1].text;
    assert.match(brief, /Skipped early \(steer away from these\): cut 2 — Shunned; cut 1 — Shunned/);
    assert.match(brief, /Often skipped artists \(skips\): Shunned \(2\)/);
    assert.doesNotMatch(brief, /Favourite artists: .*Shunned/, 'skipped plays do not make a favourite');
  } finally {
    harness.cleanup();
  }
});

/** An api whose similarity source records which tracks it was seeded from. */
function seedRecordingApi(overrides = {}) {
  const seeds = [];
  const api = makeApi({
    simiSongs: async (id) => {
      seeds.push(id);
      return [];
    },
    ...overrides,
  });
  return { api, seeds };
}

test('a disliked or skipped track never seeds similarity', async () => {
  const { api, seeds } = seedRecordingApi();
  const harness = makeDj({ api });
  try {
    harness.store.recordPlay({ id: 803, name: 'enjoyed', artists: ['A'] });
    harness.store.recordPlay({ id: 802, name: 'skipped', artists: ['B'] });
    harness.store.recordSkip(802);
    // The ✕ order: the play is in the history, then the dislike, then next.
    harness.store.recordPlay({ id: 801, name: 'disliked', artists: ['C'] });
    harness.store.setTaste(801, 'disliked');
    harness.player.setQueue([{ id: 900, name: 'now', artists: ['D'], duration: 1000 }]);

    await harness.dj.plan({ count: 1 });
    assert.deepEqual(seeds, [900, 803]);
  } finally {
    harness.cleanup();
  }
});

test('a thin history is seeded from likes', async () => {
  const { api, seeds } = seedRecordingApi();
  const harness = makeDj({ api });
  try {
    harness.store.setLikedIds([701, 702]);
    await harness.dj.plan({ count: 1 });
    assert.deepEqual(seeds, [701, 702], 'a fresh install still has something to expand');
  } finally {
    harness.cleanup();
  }
});

test('personal FM joins the pool for a signed-in account, and outranks similarity', async () => {
  let calls = 0;
  const fm = tracksBy(6000, 3, (index) => `FM${index}`);
  const api = makeApi({
    authenticated: true,
    personalFm: async () => {
      calls += 1;
      return fm;
    },
    recommendSongs: async () => [],
    personalizedNewsongs: async () => [],
    playlistDetail: async () => ({ tracks: [] }),
  });
  const harness = makeDj({ api });
  try {
    harness.player.setQueue([{ id: 900, name: 'now', artists: ['D'], duration: 1000 }]);
    const plan = await withoutJitter(() => harness.dj.plan({ count: 3 }));
    assert.equal(calls, 2, 'two calls, because each answers only three');
    assert.deepEqual(plan.tracks.map((track) => track.id), [6000, 6001, 6002]);
  } finally {
    harness.cleanup();
  }

  const anonymous = makeDj({ api: makeApi({ authenticated: false, personalFm: async () => assert.fail('FM needs a session') }) });
  try {
    await anonymous.dj.plan({ count: 1 });
  } finally {
    anonymous.cleanup();
  }
});

test('liked tracks that have rested come back as marked candidates', async () => {
  const requested = [];
  const api = makeApi({
    songDetail: async (ids) => {
      requested.push(...ids);
      return ids.map((id) => ({ id, name: `liked ${id}`, artists: [`L${id}`], duration: 1000 }));
    },
  });
  const llm = makeLlm({ reply: picks(0) });
  const harness = makeDj({ api, llm, model: { provider: 'opencode-go', model: 'm' } });
  try {
    const day = 24 * 60 * 60 * 1000;
    harness.store.setLikedIds([1101, 1102, 1103]);
    harness.store.recordPlay({ id: 1102, name: 'liked 1102', artists: ['L'] });
    harness.store.recordPlay({ id: 1103, name: 'liked 1103', artists: ['L'] });
    // Past the recent-plays window either way: only the rest period decides.
    for (let filler = 0; filler < 60; filler += 1) {
      harness.store.recordPlay({ id: 90_000 + filler, name: `filler ${filler}`, artists: ['F'] });
    }
    harness.store.state.history.find((entry) => entry.id === 1102).at = Date.now() - day;
    harness.store.state.history.find((entry) => entry.id === 1103).at = Date.now() - 4 * day;

    await harness.dj.plan({ count: 1 });
    assert.deepEqual(requested.sort(), [1101, 1103], 'a like heard yesterday rests; one from four days ago returns');
    const brief = llm.calls[0].messages[0].content[1].text;
    assert.match(brief, /liked 1101 — L1101 \[liked\]/);
  } finally {
    harness.cleanup();
  }
});

// ------------------------------------------------------- source cache and quotas

/** Wrap every source of an api so each call is counted. */
function counting(api) {
  const calls = {};
  const wrapped = { ...api, calls };
  for (const name of ['simiSongs', 'searchSongs', 'searchPlaylists', 'recommendSongs', 'personalizedNewsongs', 'playlistDetail', 'songDetail', 'personalFm']) {
    if (typeof api[name] !== 'function') continue;
    wrapped[name] = (...args) => {
      calls[name] = (calls[name] ?? 0) + 1;
      return api[name](...args);
    };
  }
  return wrapped;
}

test('each source is fetched once per lifetime, and FM on every plan', async () => {
  const HOUR = 60 * 60 * 1000;
  let now = 1_000;
  const api = counting(makeApi({ authenticated: true, personalFm: async () => [] }));
  const harness = makeDj({ api, now: () => now });
  try {
    harness.player.setQueue([{ id: 900, name: 'now', artists: ['D'], duration: 1000 }]);
    await harness.dj.plan({ prompt: 'jazz', count: 1 });
    await harness.dj.plan({ prompt: 'jazz', count: 1 });
    assert.deepEqual(api.calls, {
      simiSongs: 1,
      searchSongs: 1,
      recommendSongs: 1,
      personalizedNewsongs: 1,
      playlistDetail: 4,
      personalFm: 4,
    }, 'a second plan refetches only personal FM; the four charts are one fetch each');

    now += 3 * HOUR;
    await harness.dj.plan({ prompt: 'jazz', count: 1 });
    assert.equal(api.calls.recommendSongs, 2, 'the daily recommendations live three hours');
    assert.equal(api.calls.personalizedNewsongs, 2, 'the new-song feed lives one');
    assert.equal(api.calls.playlistDetail, 4, 'the charts live six');
    assert.equal(api.calls.simiSongs, 1, 'similarity lives a day');
  } finally {
    harness.cleanup();
  }
});

test('the personal sources are cached per account', async () => {
  let cookie = 'first';
  const api = counting(makeApi({ authenticated: true, jar: { get: () => cookie } }));
  const harness = makeDj({ api });
  try {
    await harness.dj.plan({ count: 1 });
    cookie = 'second';
    await harness.dj.plan({ count: 1 });
    assert.equal(api.calls.recommendSongs, 2, "another sign-in never sees the first one's daily list");
    assert.equal(api.calls.personalizedNewsongs, 1, 'the anonymous feed is shared');
  } finally {
    harness.cleanup();
  }
});

test('a long source yields its quota, and a different handful each plan', async () => {
  const daily = tracksBy(10_000, 100, (index) => `D${index}`);
  const harness = makeDj({ api: makeApi({ recommendSongs: async () => daily }) });
  try {
    const draws = [];
    for (let plan = 0; plan < 4; plan += 1) {
      const llm = makeLlm({ reply: picks(0) });
      harness.dj.resolveLlm = () => llm;
      harness.dj.setModel({ provider: 'opencode-go', model: 'm' });
      await harness.dj.plan({ count: 1 });
      const catalogue = llm.calls[0].messages[0].content[1].text;
      draws.push((catalogue.match(/D\d+ \d+/g) ?? []).join());
      assert.equal(catalogue.match(/D\d+ \d+/g)?.length, 8, 'eight daily tracks per plan');
    }
    assert.ok(new Set(draws).size > 1, 'the cached list is sampled, not cut at its head');
  } finally {
    harness.cleanup();
  }
});

test('the first seed keeps all its similar tracks; the others share the rest', async () => {
  const bySeed = { 900: tracksBy(7000, 5, 'S900'), 801: tracksBy(7100, 5, 'S801'), 802: tracksBy(7200, 5, 'S802'), 803: tracksBy(7300, 5, 'S803') };
  const harness = makeDj({ api: makeApi({ simiSongs: async (id) => bySeed[id] ?? [] }) });
  try {
    for (const id of [803, 802, 801]) harness.store.recordPlay({ id, name: `p${id}`, artists: ['P'] });
    harness.player.setQueue([{ id: 900, name: 'now', artists: ['D'], duration: 1000 }]);
    const llm = makeLlm({ reply: picks(0) });
    harness.dj.resolveLlm = () => llm;
    harness.dj.setModel({ provider: 'opencode-go', model: 'm' });
    await harness.dj.plan({ count: 1 });
    const catalogue = llm.calls[0].messages[0].content[1].text;
    assert.equal(catalogue.match(/S900 \d/g).length, 5, 'what is playing leads');
    assert.equal(catalogue.match(/S8\d\d \d/g).length, 9, 'fourteen in all');
  } finally {
    harness.cleanup();
  }
});

test('a brief draws from its best-loved playlists, past their first twenty tracks', async () => {
  const resolved = [];
  const playlist = (id, size) => ({
    id,
    // Only the head comes with details, as for a playlist the account does not own.
    tracks: tracksBy(id * 1000, 20, `M${id}`),
    trackIds: Array.from({ length: size }, (_, index) => id * 1000 + index),
  });
  const api = makeApi({
    searchPlaylists: async () => [
      { id: 21, name: 'thin', trackCount: 8, playCount: 9_000_000 },
      { id: 22, name: 'quiet', trackCount: 100, playCount: 10 },
      { id: 23, name: 'loved', trackCount: 100, playCount: 5_000_000 },
      { id: 24, name: 'liked', trackCount: 100, playCount: 2_000_000 },
      { id: 25, name: 'known', trackCount: 100, playCount: 1_000_000 },
    ],
    playlistDetail: async (id) => (id >= 21 && id <= 25 ? playlist(id, 100) : { tracks: [] }),
    songDetail: async (ids) => {
      resolved.push(...ids);
      return ids.map((id) => ({ id, name: `M deep ${id}`, artists: ['Deep'], duration: 1000 }));
    },
  });
  const llm = makeLlm({ reply: picks(0) });
  const harness = makeDj({ api, llm, model: { provider: 'opencode-go', model: 'm' } });
  try {
    await harness.dj.plan({ prompt: '雨天 爵士', count: 1 });
    const catalogue = llm.calls[0].messages[0].content[1].text;
    const sources = new Set([...catalogue.matchAll(/(?:M|M deep )(\d\d)\d{3}/g)].map((match) => Number(match[1])));
    assert.deepEqual([...sources].sort(), [23, 24, 25], 'the three most played among the relevant, never a thin one');
    assert.ok(resolved.length > 0 && resolved.every((id) => id % 1000 >= 20), 'only tracks past the head are looked up');
    assert.match(catalogue, /^0\. M/m, "the brief's playlist tracks lead the catalogue");
  } finally {
    harness.cleanup();
  }
});

test('every NetEase request a plan sends goes through the pacer', async () => {
  let paced = 0;
  const pacer = { run: (task) => ((paced += 1), task()) };
  const api = counting(
    makeApi({
      authenticated: true,
      personalFm: async () => [],
      searchPlaylists: async () => [{ id: 31, trackCount: 40, playCount: 1 }],
      // A cover is missing, so the cover lookup is a real request too.
      withCovers: async (tracks) => tracks,
      recommendSongs: async () => [{ id: 1500, name: 'no cover', artists: ['N'], duration: 1000 }],
    }),
  );
  const harness = makeDj({ api, pacer });
  try {
    harness.store.setLikedIds([1101]);
    api.songDetail = async (ids) => {
      api.calls.songDetail = (api.calls.songDetail ?? 0) + 1;
      return ids.map((id) => ({ id, name: `x${id}`, artists: ['X'], duration: 1000, picUrl: 'p' }));
    };
    await harness.dj.plan({ prompt: 'jazz', count: 1 });
    const sent = Object.values(api.calls).reduce((sum, calls) => sum + calls, 0) + 1;
    assert.equal(paced, sent, `${JSON.stringify(api.calls)} plus the cover lookup`);
  } finally {
    harness.cleanup();
  }
});

test('topUp stocks the queue without touching the transport', async () => {
  const llm = makeLlm({ fail: 'offline' });
  const harness = makeDj({ llm, model: { provider: 'opencode-go', model: 'm' } });
  try {
    harness.player.dj.enabled = true;
    harness.player.setPlaying(false);

    const plan = await harness.dj.topUp({ force: true });
    assert.ok(plan, 'a forced top-up always plans');
    assert.equal(harness.player.queue.length, plan.tracks.length);
    assert.equal(harness.player.playing, false, 'the DJ never starts playback');
    assert.equal(harness.player.index, 0, 'but the refilled queue becomes current');
    assert.equal(harness.player.dj.lastPlan.added, plan.tracks.length);
    assert.equal(harness.player.dj.lastPlan.source, 'heuristic');
    assert.equal(harness.player.dj.busy, false, 'the busy flag is released');
  } finally {
    harness.cleanup();
  }
});

test('topUp is a no-op while the queue is deep enough', async () => {
  const llm = makeLlm({ fail: 'offline' });
  const harness = makeDj({ llm });
  try {
    harness.player.dj.enabled = true;
    harness.player.setQueue(Array.from({ length: 8 }, (_, index) => ({ id: 900 + index, name: `q${index}`, artists: ['A'], duration: 1000 })));
    harness.player.jump(0);

    const plan = await harness.dj.topUp();
    assert.equal(plan, null, 'no plan when enough tracks remain');
    assert.equal(harness.player.queue.length, 8);
  } finally {
    harness.cleanup();
  }
});

test('a concurrent top-up cannot double-plan', async () => {
  const llm = makeLlm({ reply: picks(0, 1) });
  const harness = makeDj({ llm, model: { provider: 'opencode-go', model: 'm' } });
  try {
    harness.player.dj.enabled = true;
    const [first, second] = await Promise.all([harness.dj.topUp({ force: true }), harness.dj.topUp({ force: true })]);
    assert.equal([first, second].filter(Boolean).length, 1, 'the busy flag admits one plan at a time');
    assert.equal(llm.calls.length, 1);
  } finally {
    harness.cleanup();
  }
});

test('start() enables the DJ and plays the plan', async () => {
  const llm = makeLlm({ reply: picks(0, 1, 2) });
  const harness = makeDj({ llm, model: { provider: 'opencode-go', model: 'm' } });
  try {
    const plan = await harness.dj.start({ prompt: 'focus', count: 3 });
    assert.equal(plan.tracks.length, 3);
    assert.equal(harness.player.dj.enabled, true);
    assert.equal(harness.store.settings.djEnabled, true, 'the preference persists');
    assert.equal(harness.store.settings.djPrompt, 'focus');
    assert.equal(harness.player.playing, true, 'start() is an explicit play request');
    assert.equal(harness.player.dj.lastPlan.route, 'opencode-go/m');
  } finally {
    harness.cleanup();
  }
});
