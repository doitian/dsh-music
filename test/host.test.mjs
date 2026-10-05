/**
 * Host-half integration tests.
 *
 * The plugin is a cordis plugin, so these tests supply the two services it
 * injects (`tools`, `webServer`) as small stand-ins, mount the captured route
 * on a real `node:http` server, and drive it over HTTP — exactly the path the
 * browser panel takes.
 *
 * Network-dependent cases hit the live NetEase API. Set `MUSIC_OFFLINE=1` to
 * skip them.
 *
 * @module dsh-music/test/host
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apply, inject, name } from '../lib/index.js';

const OFFLINE = Boolean(process.env.MUSIC_OFFLINE);

/** Minimal stand-ins for the cordis services the plugin injects. */
function makeContext({ llm } = {}) {
  const tools = new Map();
  const disposers = [];
  let route;
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    webServer: {
      port: 0,
      register(registration) {
        assert.equal(registration.kind, 'prefix');
        assert.equal(registration.path, '/music');
        assert.equal(typeof registration.handler, 'function');
        route = registration;
        return () => {
          route = undefined;
        };
      },
    },
    effect(callback) {
      const disposer = callback();
      if (typeof disposer === 'function') disposers.push(disposer);
      return () => disposer?.();
    },
    /** The plugin reads the optional LLM service with `ctx.get('llm')`. */
    get(name) {
      return name === 'llm' ? llm : undefined;
    },
  };
  return { ctx, tools, disposers, route: () => route };
}

/**
 * A stub LLM service: two routes with catalogues, and a stream that answers
 * with `reply` (defaulting to a valid plan).
 */
function makeFakeLlm({ reply } = {}) {
  const calls = [];
  return {
    calls,
    listProviders: () => [{ id: 'opencode-go' }, { id: 'xiaomi-token-plan-cn' }],
    listModels: async (provider) =>
      provider === 'opencode-go'
        ? [
            { id: 'minimax-m3', name: 'MiniMax-M3' },
            { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
          ]
        : [{ id: 'qwen3-max', name: 'Qwen3 Max' }],
    stream(options) {
      calls.push(options);
      const text = reply ?? JSON.stringify({ vibe: 'a test set', picks: [{ index: 0, why: 'first' }] });
      return (async function* chunks() {
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

/** Mount the plugin and return an HTTP client bound to its route. */
async function mount({ llm, config, dataDir: supplied } = {}) {
  const dataDir = supplied ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-music-test-'));
  const ownsDataDir = supplied === undefined;
  const harness = makeContext({ llm });
  apply(harness.ctx, { dataDir, ...config });

  const server = http.createServer((req, res) => {
    const registration = harness.route();
    if (!registration) {
      res.writeHead(503).end('no route');
      return;
    }
    registration.handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  return {
    harness,
    dataDir,
    origin,
    url: (suffix) => `${origin}${suffix}`,
    /** The persisted session document, for asserting what survives a reload. */
    readSession() {
      return JSON.parse(fs.readFileSync(path.join(dataDir, 'session.json'), 'utf8'));
    },
    async json(suffix, init) {
      const response = await fetch(`${origin}${suffix}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: response.status, body, headers: response.headers };
    },
    post(suffix, body) {
      return this.json(suffix, { method: 'POST', body: JSON.stringify(body ?? {}) });
    },
    async close() {
      for (const dispose of harness.disposers) await dispose();
      await new Promise((resolve) => server.close(resolve));
      if (ownsDataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test('exports the cordis plugin shape', () => {
  assert.equal(name, 'music');
  assert.deepEqual(inject, ['tools', 'webServer']);
  assert.equal(typeof apply, 'function');
});

test('registers the seven music tools with valid schemas', async () => {
  const app = await mount();
  try {
    const expected = [
      'music_search',
      'music_play',
      'music_queue',
      'music_control',
      'music_dj',
      'music_now_playing',
      'music_login',
    ];
    assert.deepEqual([...app.harness.tools.keys()].sort(), [...expected].sort());

    for (const [toolName, definition] of app.harness.tools) {
      assert.equal(definition.name, toolName);
      assert.equal(typeof definition.description, 'string');
      assert.ok(definition.description.length > 40, `${toolName} needs a real description`);
      // Parameters must be an object-rooted JSON Schema for the model.
      assert.equal(definition.parameters.type, 'object');
      assert.equal(typeof definition.parameters.properties, 'object');
      // The registry validates the output schema at register time, but assert
      // the object-rooted contract here so a bad edit fails loudly in tests.
      assert.equal(definition.output.schema.type, 'object');
      assert.equal(typeof definition.output.render, 'function');
      assert.equal(typeof definition.execute, 'function');
      assert.equal(typeof definition.presentCall, 'function');
    }
  } finally {
    await app.close();
  }
});

test('serves health, the panel page, and the vendored QR encoder', async () => {
  const app = await mount();
  try {
    const health = await app.json('/music/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.prefix, '/music');
    // The browser half refuses to start its engine unless the host advertises
    // the matching page/engine boundary (see lib/client.js).
    assert.equal(health.body.panelContract, 2);
    // The route is registered before the tools, so health must prove the tools
    // actually registered rather than merely that the route answers.
    assert.deepEqual(health.body.tools, [
      'music_search',
      'music_play',
      'music_queue',
      'music_control',
      'music_dj',
      'music_now_playing',
      'music_login',
    ]);
    assert.ok(health.body.dataDir, 'health should report the data directory');
    assert.equal(health.body.dj.model, null, 'no DJ model is configured in tests');
    // The like cache answers why a heart is empty; an anonymous session never
    // asks, so it holds nothing and has nothing to report.
    assert.deepEqual(health.body.likes, { cached: 0, pending: 0, error: null });

    const panel = await app.json('/music/panel');
    assert.equal(panel.status, 200);
    assert.match(panel.body, /id="qr"/);
    // Playback belongs to the always-mounted engine in the shell document, not
    // to this page: the layout unmounts the page whenever another panel is
    // active, and an <audio> here would stop the music (see client.test.mjs).
    assert.equal(/<audio\s+id=/i.test(panel.body), false, 'the panel must not own playback');
    // The base placeholder must be substituted everywhere.
    assert.equal(panel.body.includes('__BASE__'), false);
    assert.match(panel.body, /\/music\/vendor\/qrcode\.js/);

    // The player's inline script must compile: a syntax error there would only
    // ever surface in the browser, not in the host.
    const inline = [...panel.body.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    assert.ok(inline.length >= 1, 'the panel must ship its inline player script');
    for (const source of inline) {
      assert.doesNotThrow(() => new Function(source), 'the inline panel script must parse');
    }

    const vendor = await app.json('/music/vendor/qrcode.js');
    assert.equal(vendor.status, 200);
    assert.match(vendor.body, /QR Code Generator for JavaScript/);

    const missing = await app.json('/music/nope');
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
  }
});

test('routes outside the prefix are left to the next handler', async () => {
  const app = await mount();
  try {
    const registration = app.harness.route();
    let forwarded = false;
    const fakeRes = { writeHead() { return this; }, end() {}, on() {} };
    const handled = await registration.handler({ url: '/api/session', method: 'GET' }, fakeRes);
    forwarded = handled === false;
    assert.equal(forwarded, true);
  } finally {
    await app.close();
  }
});

// --------------------------------------------------------- streaming quality

test('quality defaults to exhigh and lists every level', async () => {
  const app = await mount();
  try {
    const quality = await app.json('/music/api/quality');
    assert.equal(quality.status, 200);
    assert.equal(quality.body.preferred, 'exhigh');
    assert.equal(quality.body.last, null, 'nothing streamed yet');
    assert.deepEqual(
      quality.body.levels.map((entry) => entry.id),
      ['jymaster', 'dolby', 'sky', 'jyeffect', 'hires', 'lossless', 'exhigh', 'higher', 'standard'],
    );
    // The state carries it too, so the page can mirror the host.
    const state = await app.json('/music/api/state');
    assert.equal(state.body.audio.preferred, 'exhigh');
  } finally {
    await app.close();
  }
});

test('quality is settable, validated, and persisted', async () => {
  const app = await mount();
  try {
    const saved = await app.post('/music/api/quality', { level: 'lossless' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.audio.preferred, 'lossless');
    assert.equal(app.readSession().settings.level, 'lossless');

    const rejected = await app.post('/music/api/quality', { level: 'ultra-mega' });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /unknown level/);
    assert.ok(rejected.body.levels.includes('hires'), 'the refusal names the valid options');
    // A rejected write must not change anything.
    assert.equal(app.readSession().settings.level, 'lossless');
  } finally {
    await app.close();
  }
});

test('the player\'s quality choice beats the profile patch', async () => {
  const app = await mount({ config: { audioLevel: 'standard' } });
  try {
    const initial = await app.json('/music/api/quality');
    assert.equal(initial.body.preferred, 'standard', 'the patch is the starting point');

    await app.post('/music/api/quality', { level: 'hires' });
    const after = await app.json('/music/api/quality');
    assert.equal(after.body.preferred, 'hires', 'a GUI choice is not overridden by the patch');
  } finally {
    await app.close();
  }
});

test('an unknown configured level falls back instead of failing a stream', async () => {
  const app = await mount({ config: { audioLevel: 'not-a-level' } });
  try {
    const quality = await app.json('/music/api/quality');
    assert.equal(quality.body.preferred, 'exhigh');
  } finally {
    await app.close();
  }
});

test('the stream URL carries the level, and each level resolves separately', { skip: OFFLINE }, async () => {
  // The test harness has no session cookie, so entitlement varies with the
  // environment. What must hold regardless: the URL names the level, 320 kbps
  // MP3 is always servable, and a richer request either succeeds or downgrades
  // *visibly* rather than failing.
  const app = await mount();
  try {
    const playlist = await app.json('/music/api/playlist/3778678');
    const track = playlist.body.tracks.find((entry) => !entry.vip);
    assert.ok(track, 'expected a non-VIP chart track');

    const mp3 = await fetch(app.url(`/music/stream/${track.id}?level=exhigh`), { headers: { Range: 'bytes=0-1023' } });
    assert.equal(mp3.status, 206);
    assert.equal(mp3.headers.get('content-type'), 'audio/mpeg; charset=UTF-8');
    let state = await app.json('/music/api/state');
    assert.equal(state.body.audio.last.requested, 'exhigh');
    assert.equal(state.body.audio.last.served, 'exhigh');
    assert.equal(state.body.audio.last.downgraded, false);
    assert.equal(state.body.audio.last.type, 'mp3');
    const mp3Size = state.body.audio.last.size;

    // A richer request against the same track: a distinct cache entry, and
    // either the real thing or a reported downgrade.
    const rich = await fetch(app.url(`/music/stream/${track.id}?level=lossless`), { headers: { Range: 'bytes=0-1023' } });
    assert.equal(rich.status, 206, 'an unentitled level must still play, one tier down');
    state = await app.json('/music/api/state');
    assert.equal(state.body.audio.last.requested, 'lossless');
    assert.equal(state.body.audio.last.downgraded, state.body.audio.last.served !== 'lossless');
    assert.ok(['lossless', 'exhigh'].includes(state.body.audio.last.served), `served ${state.body.audio.last.served}`);
    if (!state.body.audio.last.downgraded) {
      assert.equal(state.body.audio.last.type, 'flac');
      assert.ok(
        state.body.audio.last.size > mp3Size * 2,
        `lossless must be a substantially larger file (${state.body.audio.last.size} vs ${mp3Size})`,
      );
    }

    // Both resolutions stay cached side by side rather than evicting each other.
    const again = await fetch(app.url(`/music/stream/${track.id}?level=exhigh`), { headers: { Range: 'bytes=0-1023' } });
    assert.equal(again.status, 206);
    state = await app.json('/music/api/state');
    assert.equal(state.body.audio.last.requested, 'exhigh');
  } finally {
    await app.close();
  }
});

test('the URL wins over the stored preference for one request', { skip: OFFLINE }, async () => {
  const app = await mount();
  try {
    const playlist = await app.json('/music/api/playlist/3778678');
    const track = playlist.body.tracks.find((entry) => !entry.vip);
    await app.post('/music/api/quality', { level: 'standard' });

    // An explicit level in the URL is what the page uses, so it must be honoured
    // over the stored preference — that is what makes a quality switch reload.
    await fetch(app.url(`/music/stream/${track.id}?level=exhigh`), { headers: { Range: 'bytes=0-0' } });
    const state = await app.json('/music/api/state');
    assert.equal(state.body.audio.preferred, 'standard');
    assert.equal(state.body.audio.last.requested, 'exhigh');
  } finally {
    await app.close();
  }
});

// ------------------------------------------------------------ model picker

test('the picker enumerates routes, catalogues and the current choice', async () => {
  const app = await mount({ llm: makeFakeLlm() });
  try {
    const listed = await app.json('/music/api/dj/models');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.error, null);
    assert.deepEqual(
      listed.body.routes.map((route) => route.provider),
      ['opencode-go', 'xiaomi-token-plan-cn'],
    );
    assert.deepEqual(
      listed.body.routes[0].models.map((model) => model.id),
      ['minimax-m3', 'deepseek-v4-flash'],
      'catalogue ids reach the picker',
    );
    assert.deepEqual(listed.body.selected, { provider: null, model: null }, 'nothing pinned yet');
    assert.equal(listed.body.source, 'discovered');
    assert.deepEqual(listed.body.configured, { provider: null, model: null });
  } finally {
    await app.close();
  }
});

test('the picker explains itself when no model service is mounted', async () => {
  const app = await mount();
  try {
    const listed = await app.json('/music/api/dj/models');
    assert.deepEqual(listed.body.routes, []);
    assert.match(listed.body.error, /no LLM service is mounted/);
  } finally {
    await app.close();
  }
});

test('a route picked in the player is saved and beats the profile patch', async () => {
  const app = await mount({
    llm: makeFakeLlm(),
    config: { dj: { provider: 'opencode-go', model: 'from-config' } },
  });
  try {
    const before = await app.json('/music/api/dj/models');
    assert.deepEqual(before.body.selected, { provider: 'opencode-go', model: 'from-config' });
    assert.equal(before.body.source, 'config', 'the patch pin is the starting point');

    const saved = await app.post('/music/api/dj', { provider: 'xiaomi-token-plan-cn', model: 'qwen3-max' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.modelSource, 'panel');
    assert.equal(saved.body.settings.djProvider, 'xiaomi-token-plan-cn');

    const after = await app.json('/music/api/dj/models');
    assert.deepEqual(after.body.selected, { provider: 'xiaomi-token-plan-cn', model: 'qwen3-max' });
    assert.equal(after.body.source, 'panel');
    // Written through, so it also survives a restart.
    assert.equal(app.readSession().settings.djProvider, 'xiaomi-token-plan-cn');
    assert.equal(app.readSession().settings.djModel, 'qwen3-max');

    // Health reports the live pair and where it came from.
    const health = await app.json('/music/health');
    assert.equal(health.body.dj.model, 'xiaomi-token-plan-cn/qwen3-max');
    assert.equal(health.body.dj.modelSource, 'panel');

    // Clearing reverts to the patch rather than to nothing.
    const reverted = await app.post('/music/api/dj', { provider: '', model: '' });
    assert.equal(reverted.body.modelSource, 'config');
    const final = await app.json('/music/api/dj/models');
    assert.deepEqual(final.body.selected, { provider: 'opencode-go', model: 'from-config' });
    assert.equal(app.readSession().settings.djProvider, '');
  } finally {
    await app.close();
  }
});

test('a saved route survives a plugin reload', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-music-reload-'));
  try {
    const first = await mount({ llm: makeFakeLlm(), dataDir });
    await first.post('/music/api/dj', { provider: 'opencode-go', model: 'deepseek-v4-flash' });
    await first.close();

    // A fresh mount over the same data directory is what a restart does.
    const second = await mount({ llm: makeFakeLlm(), dataDir });
    try {
      const listed = await second.json('/music/api/dj/models');
      assert.deepEqual(listed.body.selected, { provider: 'opencode-go', model: 'deepseek-v4-flash' });
      assert.equal(listed.body.source, 'panel', "the saved choice is remembered as the panel's");
    } finally {
      await second.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Test runs one throwaway plan and reports the route', { skip: OFFLINE }, async () => {
  const llm = makeFakeLlm();
  const app = await mount({ llm, config: { dj: { provider: 'opencode-go', model: 'deepseek-v4-flash' } } });
  try {
    const result = await app.post('/music/api/dj/test', {});
    assert.equal(result.status, 200);
    assert.equal(result.body.source, 'model', JSON.stringify(result.body));
    assert.equal(result.body.route, 'opencode-go/deepseek-v4-flash');
    assert.equal(result.body.modelError, null);
    assert.equal(result.body.picked.length, 1, 'it says what would have been chosen');
    assert.equal(llm.calls.length, 1, 'exactly one model call');
    // A test must not touch the queue.
    const state = await app.json('/music/api/state');
    assert.equal(state.body.queue.length, 0);
  } finally {
    await app.close();
  }
});

test('Test reports why the model tier declined', { skip: OFFLINE }, async () => {
  const app = await mount({ config: { dj: { provider: 'opencode-go', model: 'deepseek-v4-flash' } } });
  try {
    const result = await app.post('/music/api/dj/test', {});
    assert.equal(result.body.source, 'heuristic');
    assert.match(result.body.modelError, /no LLM service is mounted/, 'the reason becomes visible');
  } finally {
    await app.close();
  }
});

test('queue, transport and reporting round-trip through the API', async () => {
  const app = await mount();
  try {
    const tracks = [
      { id: 111, name: 'First', artists: ['A'], album: 'X', duration: 1000, fee: 0 },
      { id: 222, name: 'Second', artists: ['B'], album: 'Y', duration: 2000, fee: 8 },
      { id: 333, name: 'Third', artists: ['C'], album: 'Z', duration: 3000, fee: 0 },
    ];
    const played = await app.post('/music/api/play', { tracks, startIndex: 0 });
    assert.equal(played.status, 200);
    assert.equal(played.body.queue.length, 3);
    assert.equal(played.body.current.id, 111);
    assert.equal(played.body.playing, true);
    assert.equal(played.body.counts.remaining, 2);
    const firstTransport = played.body.transportRev;

    const paused = await app.post('/music/api/control', { action: 'pause' });
    assert.equal(paused.body.playing, false);
    assert.ok(paused.body.transportRev > firstTransport, 'transport must advance on pause');

    const next = await app.post('/music/api/control', { action: 'next' });
    assert.equal(next.body.current.id, 222);
    assert.equal(next.body.playing, true);

    const previous = await app.post('/music/api/control', { action: 'previous' });
    assert.equal(previous.body.current.id, 111);

    const volume = await app.post('/music/api/control', { action: 'volume', value: 0.25 });
    assert.equal(volume.body.volume, 0.25);

    const mode = await app.post('/music/api/control', { action: 'mode', value: 'shuffle' });
    assert.equal(mode.body.mode, 'shuffle');

    // Back to ordered playback: the auto-advance assertions below need a
    // deterministic next track, and shuffle picks at random.
    const ordered = await app.post('/music/api/control', { action: 'mode', value: 'list' });
    assert.equal(ordered.body.mode, 'list');

    const seek = await app.post('/music/api/control', { action: 'seek', value: 45_000 });
    assert.equal(seek.body.pendingSeek, 45_000);
    const consumed = await app.post('/music/api/seek-consumed', {});
    assert.equal(consumed.body.pendingSeek, null);

    // A report for a track the host already left must not move the cursor.
    const stale = await app.post('/music/api/report', { trackId: 222, ended: true, position: 10 });
    assert.equal(stale.body.current.id, 111, 'stale report must be ignored');

    // Ending the current track advances automatically.
    const ended = await app.post('/music/api/report', { ended: true, position: 1000 });
    assert.equal(ended.body.current.id, 222);

    const appended = await app.post('/music/api/queue', {
      action: 'append',
      tracks: [{ id: 444, name: 'Fourth', artists: ['D'], duration: 500 }],
    });
    assert.equal(appended.body.queue.length, 4);
    // Duplicates are dropped rather than queued twice.
    const duplicate = await app.post('/music/api/queue', {
      action: 'append',
      tracks: [{ id: 444, name: 'Fourth', artists: ['D'], duration: 500 }],
    });
    assert.equal(duplicate.body.queue.length, 4);

    const removed = await app.post('/music/api/queue', { action: 'remove', index: 0 });
    assert.equal(removed.body.queue.length, 3);

    const jumped = await app.post('/music/api/queue', { action: 'jump', index: 2 });
    assert.equal(jumped.body.current.id, 444);

    const cleared = await app.post('/music/api/queue', { action: 'clear' });
    assert.equal(cleared.body.queue.length, 0);
    assert.equal(cleared.body.playing, false);

    const bad = await app.post('/music/api/control', { action: 'explode' });
    assert.equal(bad.status, 400);
  } finally {
    await app.close();
  }
});

// -------------------------------------------------------------- taste + likes

/** Three tracks with distinct ids, for the taste round-trips. */
const TASTE_TRACKS = [
  { id: 111, name: 'First', artists: ['A'], album: 'X', duration: 1000, fee: 0 },
  { id: 222, name: 'Second', artists: ['B'], album: 'Y', duration: 2000, fee: 8 },
  { id: 333, name: 'Third', artists: ['C'], album: 'Z', duration: 3000, fee: 0 },
];

test('removing a queued track records a dislike, so the DJ stops offering it', async () => {
  const app = await mount();
  try {
    await app.post('/music/api/play', { tracks: TASTE_TRACKS, startIndex: 0 });

    const removed = await app.post('/music/api/queue', { action: 'remove', index: 1 });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.queue.map((track) => track.id), [111, 333]);
    // The snapshot already carries it: the answer describes the queue the click
    // produced, and the judgement is part of it.
    assert.equal(removed.body.queue.some((track) => track.disliked), false, 'the removed row is no longer there to read');
    assert.deepEqual(app.readSession().feedback.dislikes, [222]);

    // And the DJ will not re-offer it: the candidate pool excludes the disliked.
    const dj = app.harness.tools.get('music_dj');
    await dj.execute({ replan: true, count: 5 }, {});
    const state = await app.json('/music/api/state');
    assert.equal(state.body.queue.some((track) => track.id === 222), false, 'a removed track must not come back');
  } finally {
    await app.close();
  }
});

test('removing the playing track marks it and moves on', async () => {
  const app = await mount();
  try {
    await app.post('/music/api/play', { tracks: TASTE_TRACKS, startIndex: 1 });
    const current = await app.json('/music/api/state');
    assert.equal(current.body.current.id, 222, 'the playing track is the one about to be removed');

    const removed = await app.post('/music/api/queue', { action: 'remove', index: 1 });
    assert.deepEqual(removed.body.queue.map((track) => track.id), [111, 333]);
    // Removing the row must not leave playback pointing at nothing.
    assert.equal(removed.body.current.id, 333, 'playback advances to the next track');
    assert.equal(removed.body.playing, true);
    // This one was playing, so the answer is waited on and must already hold it.
    assert.deepEqual(app.readSession().feedback.dislikes, [222]);
  } finally {
    await app.close();
  }
});

test('removing an unrated track stays a queue action when the dislike is refused', async () => {
  // A refusal must not turn a successful removal into a failed request: the
  // click asked for the row to go, and the row is gone.
  const app = await mount();
  try {
    await app.post('/music/api/play', { tracks: TASTE_TRACKS, startIndex: 0 });
    // 186016 is delisted on NetEase, so the account refuses to like it — and a
    // dislike of an unliked track is local, so this stays 200 either way.
    const removed = await app.post('/music/api/queue', { action: 'remove', index: 2 });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.queue.length, 2);
  } finally {
    await app.close();
  }
});

test('removing an unrated track marks it, and repeating the removal changes nothing', async () => {
  // `remove` is often queue housekeeping, so a track that already carries a
  // level is left as it is rather than having it rewritten.
  const app = await mount();
  try {
    await app.post('/music/api/play', { tracks: TASTE_TRACKS, startIndex: 0 });
    await app.post('/music/api/taste', { trackId: 222, level: 'disliked' });

    // 222 arrives already disliked; 333 arrives with the field present and set
    // to the unrated value, which must still count as unrated.
    await app.post('/music/api/taste', { trackId: 333, level: 'none' });
    await app.post('/music/api/queue', { action: 'remove', index: 1 });
    await app.post('/music/api/queue', { action: 'remove', index: 1 });

    assert.deepEqual(app.readSession().feedback.dislikes, [333, 222], 'each unrated track is marked once');

    // And a level that is already a dislike is not restated: the list is a set.
    const before = app.readSession().feedback.dislikes.length;
    await app.post('/music/api/queue', { action: 'clear' });
    assert.equal(app.readSession().feedback.dislikes.length, before, 'clearing the queue judges nothing');
  } finally {
    await app.close();
  }
});

test('removing a liked track does not rewrite the like into a dislike', async () => {
  // The case the guard exists for — and the only one where it changes an
  // outcome — needs a track the account has liked, so it is driven through the
  // router against a stub like state rather than a live session.
  const { MusicRouter } = await import('../lib/router.js');
  const { Player } = await import('../lib/state.js');

  const player = new Player();
  /** Levels the removal recorded, so a re-rate is visible rather than silent. */
  const applied = [];
  let muted = false;
  const store = { taste: () => 'liked', setTaste: (id, level) => applied.push([id, level]) };
  const router = new MusicRouter({
    base: '/music',
    api: { authenticated: true, account: null },
    player,
    store,
    qr: {},
    dj: {},
    likes: {
      isLiked: () => true,
      known: () => true,
      ensure: async () => {},
      set: () => {
        if (!muted) throw new Error('a liked track must not be un-liked by a removal');
        return { ok: true, id: 9, liked: false };
      },
      status: () => ({}),
    },
    panelHtml: '',
    qrcodeJs: '',
  });

  assert.equal(await router.removeFromQueue({ id: 7, name: 'T7' }, false), null);
  assert.deepEqual(applied, [], 'a removal must not reach setTaste for a rated track');
  assert.equal(await router.removeFromQueue(null, false), null, 'nothing removed, nothing judged');

  // An unrated track does get judged, and the store keeps the level.
  muted = true;
  router.store = { taste: () => 'none', setTaste: (id, level) => applied.push([id, level]) };
  assert.deepEqual(await router.removeFromQueue({ id: 9, name: 'T9' }, false), { ok: true, id: 9, level: 'disliked' });
  assert.deepEqual(applied, [[9, 'disliked']]);
});

test('a jump is not a judgement about the track', async () => {
  const app = await mount();
  try {
    await app.post('/music/api/play', { tracks: TASTE_TRACKS, startIndex: 0 });
    const jumped = await app.post('/music/api/queue', { action: 'jump', index: 2 });
    assert.equal(jumped.body.current.id, 333);
    assert.deepEqual(jumped.body.queue.map((track) => track.disliked), [false, false, false]);
    assert.deepEqual(app.readSession().feedback.dislikes, [], 'playing a track is not disliking it');
  } finally {
    await app.close();
  }
});

test('a removed track can be given back its level', async () => {
  // The two ends of the same level: removing dislikes, and the ✕ switcher
  // clears it — after which the DJ may offer the track again.
  const app = await mount();
  try {
    await app.post('/music/api/play', { tracks: TASTE_TRACKS, startIndex: 0 });
    await app.post('/music/api/queue', { action: 'remove', index: 1 });
    assert.deepEqual(app.readSession().feedback.dislikes, [222]);

    const restored = await app.post('/music/api/taste', { trackId: 222, level: 'none' });
    assert.equal(restored.status, 200);
    assert.deepEqual(app.readSession().feedback.dislikes, []);
  } finally {
    await app.close();
  }
});

test('every queued track carries its taste, and a dislike is durable', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-music-taste-'));
  try {
    const app = await mount({ dataDir });
    const played = await app.post('/music/api/play', { tracks: TASTE_TRACKS, startIndex: 0 });
    assert.deepEqual(
      played.body.queue.map((track) => [track.liked, track.disliked]),
      [[false, false], [false, false], [false, false]],
      'nothing is rated yet',
    );

    const disliked = await app.post('/music/api/taste', { trackId: 222, level: 'disliked' });
    assert.equal(disliked.status, 200);
    assert.equal(disliked.body.queue[1].disliked, true, 'the list can see it');
    assert.equal(disliked.body.queue[1].liked, false);
    assert.equal(disliked.body.current.disliked, false, 'and only that track changed');

    // The level is a stored preference, not a display flag: a restart keeps it.
    await app.close();
    const second = await mount({ dataDir });
    try {
      const again = await second.post('/music/api/play', { tracks: TASTE_TRACKS, startIndex: 0 });
      assert.equal(again.body.queue[1].disliked, true, 'the DJ reads the same list, so it must survive');
      assert.deepEqual(second.readSession().feedback.dislikes, [222]);

      // Clearing the dislike is how a track becomes recommendable again.
      const cleared = await second.post('/music/api/taste', { trackId: 222, level: 'none' });
      assert.equal(cleared.body.queue[1].disliked, false);
      assert.deepEqual(second.readSession().feedback.dislikes, [], 'and the file agrees at once');
    } finally {
      await second.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('liking is a NetEase write and needs a signed-in session', async () => {
  // The test harness has no session cookie, which is exactly the state that
  // must not be papered over: a like the account never received would be
  // contradicted by the next poll's heart, and would lie to the DJ meanwhile.
  const app = await mount();
  try {
    const played = await app.post('/music/api/play', { tracks: TASTE_TRACKS, startIndex: 0 });
    assert.equal(played.body.authenticated, false);

    const refused = await app.post('/music/api/taste', { trackId: 111, level: 'liked' });
    assert.equal(refused.status, 401);
    assert.equal(refused.body.code, 'ANONYMOUS', 'the page localizes around this code');
    assert.ok(refused.body.error, 'and there is a reason for anything that does not');

    // Nothing was recorded locally, so the next poll has no heart to take back —
    // while the local level, which needs no session, still lands.
    const disliked = await app.post('/music/api/taste', { trackId: 111, level: 'disliked' });
    assert.equal(disliked.status, 200);
    assert.deepEqual(app.readSession().feedback.likes, []);

    // The older toggle spelling of a like reaches the same wall.
    const legacy = await app.post('/music/api/feedback', { kind: 'likes', trackId: 111 });
    assert.equal(legacy.status, 401);
    assert.equal(legacy.body.code, 'ANONYMOUS');
  } finally {
    await app.close();
  }
});

test('a taste level replaces the previous one', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-music-taste-'));
  try {
    const app = await mount({ dataDir });
    try {
      await app.post('/music/api/play', { tracks: TASTE_TRACKS, startIndex: 0 });

      const disliked = await app.post('/music/api/feedback', { kind: 'dislikes', trackId: 333 });
      assert.equal(disliked.body.queue[2].disliked, true, 'the older feedback door still works');
      assert.deepEqual(app.readSession().feedback.dislikes, [333], 'a taste level is written through, not debounced');

      // Clicking the same control again clears the level rather than restating it.
      const cleared = await app.post('/music/api/feedback', { kind: 'dislikes', trackId: 333 });
      assert.equal(cleared.body.queue[2].disliked, false);
      assert.deepEqual(app.readSession().feedback.dislikes, []);

      // A skip is counted rather than rated, and it changes no heart.
      const skipped = await app.post('/music/api/feedback', { kind: 'skips', trackId: 333 });
      assert.equal(skipped.status, 200);
      assert.equal(skipped.body.queue[2].disliked, false);
    } finally {
      await app.close();
    }

    // Skips are debounced — they are frequent — so the unload flush is what
    // lands them, which is the path a real shutdown takes.
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'session.json'), 'utf8'));
    assert.deepEqual(saved.feedback.skips, [333]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('an early next is a skip, but the dislike button\'s next is only a dislike', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-music-skip-'));
  try {
    const app = await mount({ dataDir });
    try {
      await app.post('/music/api/play', { tracks: TASTE_TRACKS, startIndex: 0 });

      await app.post('/music/api/report', { trackId: 111, position: 5_000, duration: 200_000, playing: true });
      await app.post('/music/api/control', { action: 'next' });

      // The panel's ✕: the level first, then the same next the transport sends.
      await app.post('/music/api/report', { trackId: 222, position: 5_000, duration: 200_000, playing: true });
      await app.post('/music/api/taste', { trackId: 222, level: 'disliked' });
      const after = await app.post('/music/api/control', { action: 'next' });
      assert.equal(after.body.current.id, 333);
    } finally {
      await app.close();
    }

    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'session.json'), 'utf8'));
    assert.deepEqual(saved.feedback.skips, [111], 'the plain next counts');
    assert.deepEqual(saved.feedback.dislikes, [222], 'the dislike is the record of the ✕');
    assert.equal(saved.history.find((entry) => entry.id === 222).skipped, undefined, 'its play is not marked either');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a DJ pick counts as taste only once it is heard through', { skip: OFFLINE }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-music-heard-'));
  try {
    const app = await mount({ dataDir });
    let first;
    try {
      await app.post('/music/api/dj', { enabled: true, replan: true });
      let state;
      for (let attempt = 0; attempt < 60 && !(state?.queue?.length > 1); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        state = (await app.json('/music/api/state')).body;
      }
      assert.ok(state.queue.length > 1, 'the DJ stocked the queue from the live sources');
      first = state.current;
      const entry = () => app.readSession().history.find((play) => play.id === first.id);

      await app.post('/music/api/report', { trackId: first.id, position: 5_000, duration: 200_000, playing: true });
      // The play itself is flushed on the debounce; force it by reading after a save.
      await app.post('/music/api/quality', { level: 'exhigh' });
      assert.equal(entry()?.tentative, true, 'a DJ pick starts out tentative');

      await app.post('/music/api/report', { trackId: first.id, position: 90_000, duration: 200_000, playing: true });
      await app.post('/music/api/quality', { level: 'exhigh' });
      assert.equal(entry()?.tentative, undefined, 'heard through, it counts');
    } finally {
      await app.close();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('an unknown taste level or feedback kind is refused', async () => {
  const app = await mount();
  try {
    const level = await app.post('/music/api/taste', { trackId: 1, level: 'sideways' });
    assert.equal(level.status, 400);
    assert.match(level.body.error, /liked, none, disliked/, 'the refusal names the levels');

    const track = await app.post('/music/api/taste', { trackId: 'not-a-track', level: 'liked' });
    assert.equal(track.status, 400);
    assert.equal(track.body.code, 'BAD_ID');

    const kind = await app.post('/music/api/feedback', { kind: 'shrug', trackId: 1 });
    assert.equal(kind.status, 400);
  } finally {
    await app.close();
  }
});

test('login status reports an anonymous session without credentials', async () => {
  const app = await mount();
  try {
    const status = await app.json('/music/api/login/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.loggedIn, false);
    assert.equal(status.body.account, null);

    const bad = await app.post('/music/api/login/cookie', { cookie: 'MUSIC_U=definitely-not-valid' });
    assert.equal(bad.status, 400);
  } finally {
    await app.close();
  }
});

test('search resolves real tracks and returns them to the panel', { skip: OFFLINE }, async () => {
  const app = await mount();
  try {
    const result = await app.json('/music/api/search?q=' + encodeURIComponent('海屿你') + '&limit=3');
    assert.equal(result.status, 200);
    assert.ok(result.body.tracks.length > 0, 'expected at least one match');
    const track = result.body.tracks[0];
    assert.ok(Number.isFinite(track.id));
    assert.ok(typeof track.name === 'string' && track.name.length > 0);
    assert.ok(Array.isArray(track.artists));

    const missing = await app.json('/music/api/search');
    assert.equal(missing.status, 400);

    const detail = await app.json(`/music/api/track/${track.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.track.id, track.id);

    const lyric = await app.json(`/music/api/lyric/${track.id}`);
    assert.equal(lyric.status, 200);
    assert.equal(typeof lyric.body.lrc, 'string');

    const charts = await app.json('/music/api/charts');
    assert.equal(charts.status, 200);
    assert.ok(charts.body.length >= 3);
    assert.ok(charts.body.every((chart) => Number.isFinite(chart.id) && chart.name));

    const playlist = await app.json(`/music/api/playlist/${charts.body[0].id}`);
    assert.equal(playlist.status, 200);
    assert.ok(playlist.body.tracks.length > 5);
  } finally {
    await app.close();
  }
});

test('audio streams through the proxy with Range support', { skip: OFFLINE }, async () => {
  const app = await mount();
  try {
    // Pick a non-VIP track from the chart so the anonymous session can play it.
    const playlist = await app.json('/music/api/playlist/3778678');
    const track = playlist.body.tracks.find((entry) => !entry.vip);
    assert.ok(track, 'expected a non-VIP chart track');

    const ranged = await fetch(app.url(`/music/stream/${track.id}`), { headers: { Range: 'bytes=0-2047' } });
    assert.equal(ranged.status, 206, 'CDN Range must be forwarded, not re-fetched whole');
    assert.equal(ranged.headers.get('content-type'), 'audio/mpeg; charset=UTF-8');
    assert.match(ranged.headers.get('content-range'), /^bytes 0-2047\/\d+$/);
    assert.equal(ranged.headers.get('accept-ranges'), 'bytes');
    const bytes = Buffer.from(await ranged.arrayBuffer());
    assert.equal(bytes.length, 2048);
    assert.equal(bytes.subarray(0, 3).toString('latin1'), 'ID3', 'expected an MP3 frame header');

    // A mid-file seek must work too: this is what makes the scrubber usable.
    const seek = await fetch(app.url(`/music/stream/${track.id}`), { headers: { Range: 'bytes=1000000-1000255' } });
    assert.equal(seek.status, 206);
    assert.equal((await seek.arrayBuffer()).byteLength, 256);

    // A VIP-only track must fail with a clear, non-retryable status.
    const vip = await fetch(app.url('/music/stream/186016'));
    assert.equal(vip.status, 403);
    const reason = await vip.json();
    assert.match(reason.error, /unavailable/);
  } finally {
    await app.close();
  }
});

test('the DJ tool plans a batch', { skip: OFFLINE }, async (t) => {
  const app = await mount();
  try {
    const dj = app.harness.tools.get('music_dj');
    const result = await dj.execute({ enabled: true, prompt: '轻快的华语流行', count: 5 }, {});
    assert.equal(result.enabled, true);
    assert.ok(['model', 'heuristic'].includes(result.source));
    assert.ok(result.names.length > 0, `expected queued tracks, got: ${JSON.stringify(result)}`);
    assert.equal(result.added, result.names.length);

    // The queued tracks must be visible to the player and the panel.
    const state = await app.json('/music/api/state');
    assert.ok(state.body.queue.length >= result.added);
    assert.ok(state.body.dj.enabled);
    assert.ok(state.body.dj.lastPlan, 'the DJ should record what it planned');

    // A second forced plan must not duplicate tracks already queued.
    const before = state.body.queue.length;
    await dj.execute({ replan: true, count: 5 }, {});
    const after = await app.json('/music/api/state');
    const ids = after.body.queue.map((track) => track.id);
    assert.equal(new Set(ids).size, ids.length, 'queue must not contain duplicates');
    assert.ok(after.body.queue.length >= before);
  } finally {
    await app.close();
  }
});

test('unloading removes the route', async () => {
  const app = await mount();
  const registration = app.harness.route();
  assert.ok(registration, 'route must be registered');
  for (const dispose of app.harness.disposers) await dispose();
  assert.equal(app.harness.route(), undefined);
  await app.close();
});
