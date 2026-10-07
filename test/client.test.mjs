/**
 * Browser-half tests.
 *
 * The client bundle is a plain `window.__ModuleLoader__.load({…})` script, so
 * it can be executed here against a minimal fake DOM. That is enough to prove
 * the property this module exists for: **playback does not depend on the Music
 * panel being mounted.**
 *
 * No network and no real browser. Run with `node test/client.test.mjs`.
 *
 * @module dsh-music/test/client
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_SOURCE = fs.readFileSync(path.join(HERE, '..', 'lib', 'client.js'), 'utf8');
const PANEL_SOURCE = fs.readFileSync(path.join(HERE, '..', 'lib', 'panel.html'), 'utf8');
const ROUTER_SOURCE = fs.readFileSync(path.join(HERE, '..', 'lib', 'router.js'), 'utf8');

const ORIGIN = 'http://127.0.0.1:19387';

/** A DOM element with just the surface the engine and components touch. */
function makeElement(tag, playState = { refusals: 0, attempts: 0 }) {
  return {
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    attributes: {},
    children: [],
    listeners: {},
    parentNode: null,
    paused: true,
    volume: 1,
    currentTime: 0,
    duration: Number.NaN,
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    addEventListener(type, listener) {
      (this.listeners[type] ??= []).push(listener);
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    /** Detach from the parent, like the real thing. */
    remove() {
      if (this.parentNode) {
        const index = this.parentNode.children.indexOf(this);
        if (index >= 0) this.parentNode.children.splice(index, 1);
      }
      this.parentNode = null;
      this.removed = true;
    },
    load() {},
    pause() {
      this.paused = true;
    },
    /**
     * Mirrors the browser's autoplay policy: the first attempts are refused
     * until the page has been activated by a gesture.
     */
    play() {
      playState.attempts += 1;
      if (playState.refusals > 0) {
        playState.refusals -= 1;
        const refusal = new Error("play() failed because the user didn't interact with the document first");
        refusal.name = 'NotAllowedError';
        return Promise.reject(refusal);
      }
      this.paused = false;
      return Promise.resolve();
    },
  };
}

/** A `Response`-shaped stub; only what the engine reads. */
function jsonResponse(body, ok = true) {
  const text = JSON.stringify(body);
  return {
    ok,
    status: ok ? 200 : 500,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

/** A plain-text `Response`-shaped stub, for the served page. */
function textResponse(body) {
  return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
}

/** The state document the fake host answers with. */
function stateDocument(overrides = {}) {
  return {
    rev: 1,
    transportRev: 1,
    queue: [],
    index: 0,
    current: { id: 123, name: 'Track', artists: ['Artist'], album: 'Album', duration: 180000, picUrl: null, vip: false },
    playing: true,
    volume: 0.8,
    muted: false,
    mode: 'list',
    pendingSeek: null,
    reported: { trackId: null, position: 0, duration: 0, playing: false, at: 0, error: null },
    dj: { enabled: false },
    audio: { preferred: 'exhigh', last: null },
    counts: { queued: 0, remaining: 0 },
    ...overrides,
  };
}

/**
 * Execute the client bundle against a fake window/document and return the
 * module exports it registers, plus the harness state to assert on.
 */
async function loadClientBundle({
  state = stateDocument(),
  fetchImpl,
  contract = 2,
  pageContract,
  playRefusals = 0,
  documentOrigin = ORIGIN,
  transport,
} = {}) {
  const registered = [];
  const registrations = [];
  const calls = [];
  /** Shared by every created element so tests control the autoplay refusal. */
  const playState = { refusals: playRefusals, attempts: 0 };
  const body = makeElement('body', playState);
  const document = {
    body,
    documentElement: makeElement('html', playState),
    createElement: (tag) => makeElement(tag, playState),
  };
  /** The element `document.activeElement` currently reports. */
  const active = { node: null };
  Object.defineProperty(document, 'activeElement', { get: () => active.node });

  const savedWindow = globalThis.window;
  const savedDocument = globalThis.document;
  const savedFetch = globalThis.fetch;

  const loaded = {};
  globalThis.window = {
    location: { origin: documentOrigin },
    __DSH_TRANSPORT__: transport,
    __ModuleLoader__: {
      load({ id, factory }) {
        loaded[id] = factory;
      },
    },
  };
  globalThis.document = document;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    calls.push({ url: href, init });
    if (fetchImpl) return fetchImpl(href, init, { state });
    if (href.endsWith('/music/health')) {
      // `contract: null` models a host module without the advertisement.
      return jsonResponse(contract === null ? { ok: true } : { ok: true, panelContract: contract });
    }
    if (href.endsWith('/music/panel')) {
      const declared = pageContract === undefined ? contract : pageContract;
      return textResponse(
        declared === null
          ? '<!doctype html><html><head><title>player</title></head><body></body></html>'
          : `<!doctype html><html><head><meta name="dsh-music-panel-contract" content="${declared}" /></head><body></body></html>`,
      );
    }
    if (href.endsWith('/state')) return jsonResponse(state);
    if (href.endsWith('/report')) return jsonResponse(state);
    return jsonResponse({});
  };

  try {
    // Dynamic import so the bundle evaluates against the globals above.
    await import(`../lib/client.js?test=${Math.random()}`);
  } finally {
    // Restored by the caller via the returned teardown.
  }

  const factory = loaded['@doitian/dsh-music'];
  assert.ok(factory, 'the bundle must register itself under its package name');

  const fakeRequire = (specifier) => {
    if (specifier === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {},
      };
    }
    throw new Error(`unexpected require(${specifier})`);
  };
  const bundle = factory(fakeRequire);

  const ctx = {
    slots: {
      inject(name, callback) {
        registered.push(name);
        const result = callback();
        return () => result?.dispose?.();
      },
      register(spec) {
        registrations.push(spec);
        return { dispose() {} };
      },
    },
    /**
     * A minimal `locale` service: dictionaries are recorded so tests can
     * translate through them exactly as the host's runtime would.
     */
    locale: {
      dictionaries: {},
      register(ns, dict) {
        this.dictionaries[ns] = dict;
        return () => {
          delete this.dictionaries[ns];
        };
      },
      bind(ns) {
        return (key) => this.dictionaries[ns]?.en?.[key] ?? key;
      },
    },
    inject(_deps, callback) {
      callback();
      return { dispose() {} };
    },
  };

  return {
    bundle,
    ctx,
    body,
    calls,
    registered,
    registrations,
    /** The state document the stub host answers with; tests may mutate it. */
    state,
    playState,
    /** The element the engine created, or undefined. */
    audio: () => body.children.find((child) => child.tagName === 'AUDIO'),
    restore() {
      // Tear down any engine a failed test left polling, so one assertion
      // failure cannot keep the process alive.
      try {
        globalThis.window?.__dshMusicEngine?.dispose?.();
      } catch { /* nothing to clean up */ }
      globalThis.window = savedWindow;
      globalThis.document = savedDocument;
      globalThis.fetch = savedFetch;
    },
  };
}

/** Let the engine's first poll settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

const FADE_MS = Number(/const FADE_MS = (\d+)/.exec(CLIENT_SOURCE)[1]);
const SEEK_FADE_MS = Number(/const SEEK_FADE_MS = (\d+)/.exec(CLIENT_SOURCE)[1]);
const SEEK_SETTLE_MS = Number(/const SEEK_SETTLE_MS = (\d+)/.exec(CLIENT_SOURCE)[1]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Outlast a play or pause fade. */
const fadeOut = () => new Promise((resolve) => setTimeout(resolve, FADE_MS + 100));

test('the bundle registers its id, apply, and inject list', async () => {
  const harness = await loadClientBundle();
  try {
    assert.equal(typeof harness.bundle.apply, 'function');
    assert.deepEqual(harness.bundle.inject, ['slots', 'locale']);
    assert.equal(harness.bundle.PANEL_ID, 'music');
  } finally {
    harness.restore();
  }
});

test('the UI registers against the locale service with zh/en dictionaries', async () => {
  const harness = await loadClientBundle();
  let dispose;
  try {
    dispose = await harness.bundle.apply(harness.ctx);
    await settle();

    const dict = harness.ctx.locale.dictionaries['music'];
    assert.ok(dict, 'apply() must register the dictionary');
    for (const key of Object.keys(dict.en)) {
      assert.ok(dict.zh[key], `the zh dictionary must cover "${key}"`);
    }
    for (const key of Object.keys(dict.zh)) {
      assert.ok(dict.en[key], `the en dictionary must cover "${key}"`);
    }

    const sidebar = harness.registrations.find((spec) => spec.name === 'sidebar.panellist');
    const main = harness.registrations.find((spec) => spec.name === 'main');
    assert.equal(sidebar.locale, 'music', 'the sidebar entry follows the locale');
    assert.equal(main.locale, 'music', 'the page follows the locale');
    assert.equal(typeof sidebar.label, 'function', 'the label resolves at render time');
    assert.equal(sidebar.label(), 'Music');
    assert.equal(dict.zh.panel, '音乐');
  } finally {
    await dispose?.();
    harness.restore();
  }
});

test('the engine owns the audio element, independently of any panel', async () => {
  const harness = await loadClientBundle();
  let dispose;
  try {
    // Nothing React-related is ever rendered in this test: no component is
    // mounted, no slot occupant is invoked. The audio element must exist anyway.
    dispose = await harness.bundle.apply(harness.ctx);
    await settle();

    const audio = harness.audio();
    assert.ok(audio, 'apply() must create the audio element on the plugin context');
    assert.equal(audio.attributes['aria-hidden'], 'true');
    assert.equal(audio.dataset.trackId, '123', 'the engine must load the current track');
    assert.equal(audio.src, `${ORIGIN}/music/stream/123?level=exhigh`, 'the level is part of the resource URL');
    assert.ok(audio.volume < 0.8, 'playback starts by fading in');
    await fadeOut();
    assert.equal(audio.volume, 0.8, 'the engine applies the host volume');
    assert.equal(audio.paused, false, 'the engine starts playback when the host says so');

    // Both slots still register, so the page and sidebar row exist too.
    assert.deepEqual(harness.registered, ['main', 'sidebar.panellist']);
    // A usable engine must advertise that it plays, or the page takes over.
    assert.equal(globalThis.window.__dshMusicEngine.playback, true);
    // The handshake runs first, then state: both same-origin relative requests.
    assert.equal(harness.calls[0].url, '/music/health');
    assert.equal(harness.calls[1].url, '/music/api/state');
  } finally {
    await dispose?.();
    harness.restore();
  }
});

test('the engine reports position and consumes a seek exactly once', async () => {
  const harness = await loadClientBundle({
    state: stateDocument({ transportRev: 7, pendingSeek: 45000, playing: false }),
  });
  let dispose;
  try {
    dispose = await harness.bundle.apply(harness.ctx);
    await settle();

    const audio = harness.audio();
    assert.equal(audio.currentTime, 45, 'the seek target is applied in seconds');
    const consumed = harness.calls.filter((call) => call.url.endsWith('/seek-consumed'));
    assert.equal(consumed.length, 1, 'the one-shot seek is consumed exactly once');

    // Paused state must be mirrored onto the element.
    assert.equal(audio.paused, true);
  } finally {
    await dispose?.();
    harness.restore();
  }
});

test('the engine reports failures so the host can skip the track', async () => {
  const harness = await loadClientBundle();
  let dispose;
  try {
    dispose = await harness.bundle.apply(harness.ctx);
    await settle();
    harness.calls.length = 0;

    const audio = harness.audio();
    for (const listener of audio.listeners.error ?? []) listener();
    await settle();

    const report = harness.calls.find((call) => call.url.endsWith('/report'));
    assert.ok(report, 'an audio error must be reported');
    assert.match(report.init.body, /"error":/);
  } finally {
    await dispose?.();
    harness.restore();
  }
});

test('disposing stops playback, removes the element, and unregisters', async () => {
  const harness = await loadClientBundle();
  try {
    const dispose = await harness.bundle.apply(harness.ctx);
    await settle();
    assert.ok(harness.audio());
    assert.ok(globalThis.window.__dshMusicEngine, 'the panel pokes the engine through this handle');

    await dispose();
    assert.equal(harness.audio(), undefined, 'the element must leave the document');
    assert.equal(globalThis.window.__dshMusicEngine, undefined);
  } finally {
    harness.restore();
  }
});

test('re-applying never leaves two audio elements playing', async () => {
  const harness = await loadClientBundle();
  try {
    await harness.bundle.apply(harness.ctx);
    await settle();
    const first = harness.audio();
    assert.ok(first);

    await harness.bundle.apply(harness.ctx);
    await settle();
    const elements = harness.body.children.filter((child) => child.tagName === 'AUDIO');
    assert.equal(elements.length, 1, 'a re-materialized plugin must not double up');
    assert.equal(first.removed, true, 'the previous element is disposed');
  } finally {
    harness.restore();
  }
});

test('a refused play is retried without a transport change', async () => {
  // Regression: the retry used to sit behind the `transportRev` gate, so the
  // first browser refusal stopped the music for good — the panel showed the
  // autoplay hint and pressing it could never clear it.
  const harness = await loadClientBundle({ playRefusals: 1 });
  let dispose;
  try {
    dispose = await harness.bundle.apply(harness.ctx);
    await settle();

    assert.equal(harness.playState.attempts, 1, 'the engine tried to play');
    assert.equal(harness.audio().paused, true, 'and the browser refused it');

    // Force another poll exactly as the panel does; the desired state and the
    // transport revision are unchanged.
    globalThis.window.__dshMusicEngine.sync();
    await settle();

    assert.equal(harness.playState.attempts, 2, 'a later tick must retry the play');
    assert.equal(harness.audio().paused, false, 'the retry succeeds once the page is activated');
  } finally {
    await dispose?.();
    harness.restore();
  }
});

test('a refused play is reported at once so the hint can appear', async () => {
  const harness = await loadClientBundle({ playRefusals: 1 });
  let dispose;
  try {
    dispose = await harness.bundle.apply(harness.ctx);
    await settle();

    const reports = harness.calls.filter((call) => call.url.endsWith('/report'));
    assert.ok(reports.length >= 1, 'the refusal is reported without waiting for the idle cadence');
    assert.match(reports.at(-1).init.body, /"playing":false/);
    assert.match(reports.at(-1).init.body, /"blocked":true/, 'as a refusal, the only thing the hint is for');

    globalThis.window.__dshMusicEngine.playNow();
    await settle();
    const after = harness.calls.filter((call) => call.url.endsWith('/report')).at(-1).init.body;
    assert.match(after, /"blocked":false/, 'and audio that starts clears it');
  } finally {
    await dispose?.();
    harness.restore();
  }
});

test('playNow attempts playback inside the click', async () => {
  const harness = await loadClientBundle({ playRefusals: 1 });
  let dispose;
  try {
    dispose = await harness.bundle.apply(harness.ctx);
    await settle();
    assert.equal(harness.audio().paused, true);

    const before = harness.playState.attempts;
    globalThis.window.__dshMusicEngine.playNow();
    assert.equal(harness.playState.attempts, before + 1, 'the attempt happens synchronously, during the gesture');
    await settle();
    assert.equal(harness.audio().paused, false);
  } finally {
    await dispose?.();
    harness.restore();
  }
});

test('a quality change loads a new resource and resumes in place', async () => {
  // Two levels are two different files, so switching must not keep
  // range-requesting byte offsets into the other encoding.
  const harness = await loadClientBundle();
  let dispose;
  try {
    dispose = await harness.bundle.apply(harness.ctx);
    await settle();
    const audio = harness.audio();
    assert.equal(audio.src, `${ORIGIN}/music/stream/123?level=exhigh`);

    audio.currentTime = 42; // 42 s into the track
    harness.state.audio = { preferred: 'lossless', last: null };
    globalThis.window.__dshMusicEngine.sync();
    await settle();

    assert.equal(audio.src, `${ORIGIN}/music/stream/123?level=lossless`, 'a fresh resource, not the same URL');
    assert.equal(audio.dataset.trackId, '123', 'still the same track');
    assert.equal(audio.dataset.trackKey, `123:lossless:${ORIGIN}`);

    // The position is restored once the new file's metadata arrives.
    for (const listener of audio.listeners.loadedmetadata ?? []) listener();
    assert.equal(audio.currentTime, 42, 'a quality switch must not restart the song');
  } finally {
    await dispose?.();
    harness.restore();
  }
});

test('audio streams from the shell-published HTTP origin, not the custom scheme', async () => {
  // Chromium cannot byte-range a `dsh-app://` response, so audio served from
  // the document origin in the desktop shell restarts on every seek.
  const harness = await loadClientBundle({ documentOrigin: 'dsh-app://app' });
  let dispose;
  try {
    dispose = await harness.bundle.apply(harness.ctx);
    await settle();
    const audio = harness.audio();
    assert.equal(audio.src, 'dsh-app://app/music/stream/123?level=exhigh', 'no stream base yet');

    // A shell that publishes its stream base after boot moves the element over.
    audio.currentTime = 42;
    globalThis.window.__DSH_TRANSPORT__ = { streamBaseUrl: `${ORIGIN}/api/` };
    globalThis.window.__dshMusicEngine.sync();
    await settle();
    assert.equal(audio.src, `${ORIGIN}/music/stream/123?level=exhigh`);
    for (const listener of audio.listeners.loadedmetadata ?? []) listener();
    assert.equal(audio.currentTime, 42, 'switching origin resumes in place');
  } finally {
    await dispose?.();
    harness.restore();
  }
});

test('a malformed stream base falls back to the document origin', async () => {
  const harness = await loadClientBundle({ transport: { streamBaseUrl: 'not a url' } });
  let dispose;
  try {
    dispose = await harness.bundle.apply(harness.ctx);
    await settle();
    assert.equal(harness.audio().src, `${ORIGIN}/music/stream/123?level=exhigh`);
  } finally {
    await dispose?.();
    harness.restore();
  }
});

test('the page fallback transport also streams from the published origin', () => {
  assert.match(PANEL_SOURCE, /window\.parent\?\.__DSH_TRANSPORT__\?\.streamBaseUrl/);
  assert.match(PANEL_SOURCE, /audio\.src = base \+ BASE \+ '\/stream\/'/);
});

test('volume follows the host without a transport change', async () => {
  const harness = await loadClientBundle();
  let dispose;
  try {
    dispose = await harness.bundle.apply(harness.ctx);
    await fadeOut();
    assert.equal(harness.audio().volume, 0.8);

    harness.state.volume = 0.2; // no transportRev change, as a plain volume edit
    globalThis.window.__dshMusicEngine.sync();
    await settle();
    assert.equal(harness.audio().volume, 0.2, 'enforce() must not be gated on transportRev');
  } finally {
    await dispose?.();
    harness.restore();
  }
});

test('a pause fades out before the element stops, and play fades back in', async () => {
  const harness = await loadClientBundle();
  let dispose;
  try {
    dispose = await harness.bundle.apply(harness.ctx);
    await fadeOut();
    const audio = harness.audio();

    harness.state.playing = false;
    globalThis.window.__dshMusicEngine.sync();
    await settle();
    assert.equal(audio.paused, false, 'still audible while fading out');
    assert.ok(audio.volume > 0 && audio.volume < 0.8, 'and getting quieter');

    await fadeOut();
    assert.equal(audio.paused, true, 'paused once silent');
    const report = harness.calls.filter((call) => call.url.endsWith('/report')).at(-1);
    assert.match(report.init.body, /"playing":false/, 'the real pause is reported');

    harness.state.playing = true;
    globalThis.window.__dshMusicEngine.sync();
    await settle();
    assert.equal(audio.paused, false);
    assert.ok(audio.volume < 0.8, 'resuming fades in');
    await fadeOut();
    assert.equal(audio.volume, 0.8);
  } finally {
    await dispose?.();
    harness.restore();
  }
});

test('play during the fade-out cancels the pause', async () => {
  const harness = await loadClientBundle();
  let dispose;
  try {
    dispose = await harness.bundle.apply(harness.ctx);
    await fadeOut();

    harness.state.playing = false;
    globalThis.window.__dshMusicEngine.sync();
    await settle();
    harness.state.playing = true;
    globalThis.window.__dshMusicEngine.sync();
    await fadeOut();
    assert.equal(harness.audio().paused, false, 'the pause never lands');
    assert.equal(harness.audio().volume, 0.8);
  } finally {
    await dispose?.();
    harness.restore();
  }
});

/** Send the host's next seek and let the engine pick it up. */
async function seekTo(harness, rev, target) {
  Object.assign(harness.state, { transportRev: rev, pendingSeek: target });
  globalThis.window.__dshMusicEngine.sync();
  await settle();
}

test('a burst of seeks stays silent and lands once, at the latest target', async () => {
  const harness = await loadClientBundle();
  let dispose;
  try {
    dispose = await harness.bundle.apply(harness.ctx);
    await fadeOut();
    const audio = harness.audio();
    audio.currentTime = 5;

    await seekTo(harness, 2, 30000);
    await seekTo(harness, 3, 60000);
    assert.equal(audio.currentTime, 5, 'nothing jumps while seeks are still arriving');

    await sleep(SEEK_FADE_MS + SEEK_SETTLE_MS + SEEK_FADE_MS + 100);
    assert.equal(audio.currentTime, 60, 'only the last target is applied');
    assert.equal(audio.volume, 0.8, 'and the volume comes back');
  } finally {
    await dispose?.();
    harness.restore();
  }
});

test('a seek during the silent hold cancels the playback queued for the previous one', async () => {
  const harness = await loadClientBundle();
  let dispose;
  try {
    dispose = await harness.bundle.apply(harness.ctx);
    await fadeOut();
    const audio = harness.audio();
    audio.currentTime = 5;

    await seekTo(harness, 2, 30000);
    // Silent and holding, most of the way to the resume.
    await sleep(SEEK_FADE_MS + SEEK_SETTLE_MS - 100);
    assert.equal(audio.volume, 0);
    await seekTo(harness, 3, 60000);

    // Past the moment the first seek would have resumed.
    await sleep(200);
    assert.equal(audio.currentTime, 5, 'the first target never plays');
    assert.equal(audio.volume, 0, 'still silent, waiting on the second');

    await sleep(SEEK_SETTLE_MS + SEEK_FADE_MS);
    assert.equal(audio.currentTime, 60);
    assert.equal(audio.volume, 0.8);
  } finally {
    await dispose?.();
    harness.restore();
  }
});

test('the engine takes the contract from the served page when the host is silent', async () => {
  // The host module and the page are refreshed independently: a plugin mount
  // re-reads panel.html from disk while Node keeps serving the cached module.
  // The page decides whether to defer, so it is the authority — and this is the
  // path that lets a background-playback fix land without a process restart.
  const harness = await loadClientBundle({ contract: null, pageContract: 2 });
  let dispose;
  try {
    dispose = await harness.bundle.apply(harness.ctx);
    await settle();

    assert.ok(harness.audio(), 'the engine must start when the served page asks for it');
    assert.equal(globalThis.window.__dshMusicEngine.playback, true);
    assert.equal(harness.calls[1].url, '/music/panel', 'the page is consulted when health stays silent');
  } finally {
    await dispose?.();
    harness.restore();
  }
});

test('a page that does not implement the contract keeps the engine inert', async () => {
  const harness = await loadClientBundle({ contract: null, pageContract: 1 });
  let dispose;
  try {
    dispose = await harness.bundle.apply(harness.ctx);
    await settle();
    assert.equal(harness.audio(), undefined, 'an older page still owns its own audio');
    assert.equal(globalThis.window.__dshMusicEngine.playback, false);
  } finally {
    await dispose?.();
    harness.restore();
  }
});

test('a page with no declaration at all keeps the engine inert', async () => {
  const harness = await loadClientBundle({ contract: null, pageContract: null });
  let dispose;
  try {
    dispose = await harness.bundle.apply(harness.ctx);
    await settle();
    assert.equal(harness.audio(), undefined, 'silence is not consent');
    assert.equal(globalThis.window.__dshMusicEngine.playback, false);
  } finally {
    await dispose?.();
    harness.restore();
  }
});

test('an older host contract keeps the engine inert', async () => {
  // A host that predates contract 2 still serves a page owning its own <audio>.
  // Starting this engine as well would play the track twice, so it must not.
  const harness = await loadClientBundle({ contract: 1 });
  let dispose;
  try {
    dispose = await harness.bundle.apply(harness.ctx);
    await settle();

    assert.equal(harness.audio(), undefined, 'no second audio element against an older host');
    assert.deepEqual(harness.registered, ['main', 'sidebar.panellist'], 'the UI still registers');
    assert.ok(globalThis.window.__dshMusicEngine, 'the page still gets a handle to poke');
    // The page reads this to decide it must own the audio element itself.
    assert.equal(globalThis.window.__dshMusicEngine.playback, false);
    assert.doesNotThrow(() => globalThis.window.__dshMusicEngine.sync());
    assert.equal(globalThis.window.__dshMusicEngine.state(), null);
  } finally {
    await dispose?.();
    harness.restore();
  }
});

test('all three artifacts agree on the panel contract', () => {
  // The page declares it, the bundle needs it, the host advertises it. They are
  // versioned independently — the page is re-read on every mount while the
  // module is cached — so a silent drift here is exactly the bug that produced
  // "nothing owns the audio element".
  const page = /name="dsh-music-panel-contract"\s+content="(\d+)"/.exec(PANEL_SOURCE);
  assert.ok(page, 'the page must declare its panel contract');
  const client = /const PANEL_CONTRACT = (\d+)/.exec(CLIENT_SOURCE);
  assert.ok(client, 'the bundle must declare the contract it needs');
  const host = /const PANEL_CONTRACT = (\d+)/.exec(ROUTER_SOURCE);
  assert.ok(host, 'the host must advertise a contract');
  assert.equal(page[1], client[1], 'the page and the bundle must agree');
  assert.equal(host[1], client[1], 'the host and the bundle must agree');
  // The bundle's reader must match the page's spelling exactly.
  assert.match(CLIENT_SOURCE, /name="dsh-music-panel-contract"/);
  assert.match(ROUTER_SOURCE, /panelContract: PANEL_CONTRACT/);
});

// ------------------------------------------------------------- static checks
test('the page defers to a usable engine, and owns audio when there is none', () => {
  // No <audio> in the markup: the element is created at runtime, and only when
  // no usable engine exists. A page-owned element dies with the page, which is
  // the "music stops when I open a session" bug, so the engine is preferred.
  assert.equal(/<audio\s+id=/i.test(PANEL_SOURCE), false, 'the markup must not hard-code an audio element');
  assert.equal(PANEL_SOURCE.includes("getElementById('audio')"), false);

  // Defer only to an engine that declares it really plays.
  assert.match(PANEL_SOURCE, /candidate\?\.playback === true \? candidate : undefined/);
  // Otherwise fall back to page-local playback rather than going silent.
  assert.match(PANEL_SOURCE, /function createLocalTransport\(\)/);
  // And stand the unusable engine down first, so exactly one transport plays.
  assert.match(PANEL_SOURCE, /__dshMusicEngine\?\.dispose\?\.\(\)/);
  // The local transport keeps the same retry-outside-the-gate discipline.
  assert.match(PANEL_SOURCE, /if \(next\.playing && audio\.paused\) attemptPlay\(\);/);
  assert.match(PANEL_SOURCE, /positionMs\(\)/);
  assert.match(PANEL_SOURCE, /pokeEngine\(\)/);
});

test('the client bundle parses and keeps the engine wiring', () => {
  assert.doesNotThrow(() => new Function(CLIENT_SOURCE), 'the client bundle must parse');
  assert.match(CLIENT_SOURCE, /createEngine/);
  assert.match(CLIENT_SOURCE, /__dshMusicEngine/);
  assert.match(CLIENT_SOURCE, /PANEL_CONTRACT/);
  // The engine must be created in apply(), not inside a slot component.
  assert.match(CLIENT_SOURCE, /const engine = await createEngine\(\)/);
  // The retry must live outside the transportRev gate (see the regression test).
  assert.match(CLIENT_SOURCE, /function enforce\(next\)/);
  assert.match(CLIENT_SOURCE, /enforce\(next\);/);
});

// ------------------------------------------------------------- the panel page
/** One fake element; only the surface the page touches. */
/** The page's `<html>`: its theme mark and the colours set on it inline. */
function makeRootElement() {
  const properties = new Map();
  return {
    lang: '',
    dataset: {},
    style: {
      setProperty: (name, value) => properties.set(name, value),
      removeProperty: (name) => properties.delete(name),
      getPropertyValue: (name) => properties.get(name) ?? '',
    },
  };
}

function makePageElement(id) {
  const classes = new Set();
  return {
    id,
    style: {},
    dataset: {},
    children: [],
    value: '',
    disabled: false,
    textContent: '',
    innerHTML: '',
    src: '',
    width: 220,
    height: 220,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, on) => {
        const next = on === undefined ? !classes.has(name) : Boolean(on);
        if (next) classes.add(name); else classes.delete(name);
        return next;
      },
    },
    addEventListener() {},
    removeEventListener() {},
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    appendChild(child) { this.children.push(child); return child; },
    append(child) { child.parent = this; this.children.push(child); },
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter((child) => child !== this);
      this.parent = null;
    },
    before() {},
    focus() {},
    showModal() {},
    close() {},
    getContext: () => ({ fillRect() {}, fillText() {}, fillStyle: '', font: '' }),
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
  };
}

/**
 * Mirror one taste level onto the fake state, the way the host's snapshot does:
 * the two levels are exclusive, and a track the list does not hold is untouched.
 */
function applyTaste(state, trackId, level) {
  for (const track of [state.current, ...(state.queue ?? [])]) {
    if (!track || track.id !== trackId) continue;
    track.liked = level === 'liked';
    track.disliked = level === 'disliked';
  }
  // As the host does: a disliked track leaves the queue, the playing one too.
  if (level === 'disliked') {
    const index = (state.queue ?? []).findIndex((track) => track.id === trackId);
    if (index >= 0) applyQueueAction(state, { action: 'remove', index });
  }
}

/** Mirror a boost onto the fake state, as the host's `/boost` route does. */
function applyBoost(state, trackId, direction) {
  const boost = direction === 'none' ? null : direction;
  for (const track of [state.current, ...(state.queue ?? [])]) {
    if (track?.id === trackId) track.boost = boost;
  }
  const named = (state.queue ?? []).find((track) => track.id === trackId);
  state.boosts = (state.boosts ?? []).filter((entry) => entry.id !== trackId);
  if (boost) state.boosts.unshift({ id: trackId, name: named?.name ?? '', artists: named?.artists ?? [], direction: boost, until: Date.now() + 60 * 60_000 });
}

/**
 * Mirror one queue action onto the fake state, the way the host's `/queue` route
 * does.
 *
 * A removal is what the page's rows ask for: the row leaves the list and the
 * cursor follows it. The host reads an unrated removal as a dislike as well,
 * which the snapshot cannot show afterwards — the row it belonged to is gone.
 * Clear is the header's, and keeps only the playing track.
 */
function applyQueueAction(state, { action, index, keepCurrent } = {}) {
  if (action === 'clear') {
    state.queue = keepCurrent && state.current ? [state.current] : [];
    state.index = state.queue.length - 1;
    state.current = state.queue[0] ?? null;
    return;
  }
  if (action !== 'remove') return;
  const at = Number(index);
  if (!Number.isInteger(at) || at < 0 || at >= state.queue.length) return;
  state.queue.splice(at, 1);
  if (at < state.index) state.index -= 1;
  else if (at === state.index) {
    if (state.index >= state.queue.length) state.index = state.queue.length === 0 ? -1 : 0;
    state.current = state.queue[state.index] ?? null;
  }
}

/**
 * Boot `lib/panel.html` itself against a fake DOM.
 *
 * The page is inline script, so it runs through `new Function` with just the
 * globals it touches. The engine in `window.parent` reports `playback: true` —
 * the shell document owns the audio element, which is the normal case and the
 * one where the page must still fetch everything it renders by itself. The fake
 * shell document declares `lang="en"` unless `options.lang` says otherwise, and
 * `options.storage` seeds the page's local storage. `options.handle` may answer
 * one path itself — a refusal the page has to localize, for instance.
 */
async function bootPanel(options = {}) {
  const state = options.state ?? stateDocument();
  const lyricsById = options.lyricsById ?? {};
  const infoById = options.infoById ?? {};
  // No model by default: every introduction comes back empty.
  const introById = options.introById ?? {};
  const stored = new Map(Object.entries(options.storage ?? {}));
  const requests = [];
  const calls = [];
  const elements = new Map();
  const intervals = [];

  const document = {
    activeElement: null,
    getElementById(id) {
      if (id === 'gesture') return (elements.get('notices')?.children ?? []).find((child) => child.id === 'gesture') ?? null;
      if (!elements.has(id)) elements.set(id, makePageElement(id));
      return elements.get(id);
    },
    createElement: (tag) => ({ ...makePageElement(tag), querySelector: () => makePageElement('child') }),
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    documentElement: makeRootElement(),
  };
  // `options.shell` stands in for the DSH document's theme: whether its body
  // carries the dark mark, and the token values its computed style answers.
  const shellBody = options.shell
    ? { hasAttribute: (name) => name === 'data-ds-dark-theme' && Boolean(options.shell.dark) }
    : undefined;
  const window = {
    parent: {
      __dshMusicEngine: { playback: true, apply() {}, sync() {}, position: () => 0 },
      // The page follows the shell's `<html lang>`; pin it so assertions on
      // labels do not depend on the machine's own locale.
      document: { documentElement: { lang: options.lang ?? 'en' }, body: shellBody },
    },
    addEventListener() {},
  };
  const getComputedStyle = (node) => ({
    getPropertyValue: (name) => (node === shellBody ? (options.shell?.colors?.[name] ?? '') : ''),
  });
  // The page remembers which pane the info card shows here.
  const localStorage = {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => { stored.set(key, String(value)); },
    removeItem: (key) => { stored.delete(key); },
  };
  const fetch = async (url, init) => {
    const path = String(url).replace(/^.*\/api/, '');
    requests.push(path);
    // Details and introductions are read in the background after a render —
    // the next track's details too — so keeping them out of `calls` leaves
    // `calls.at(-1)` naming what a click sent.
    if (!/^\/(info|intro)\//.test(path)) calls.push({ path, body: init?.body ? JSON.parse(init.body) : null });
    const custom = options.handle ? await options.handle(path) : null;
    if (custom) return custom;
    let body = {};
    // Every mutating route answers with the fresh snapshot, as the host does.
    if (path === '/state' || path === '/control' || path === '/report') body = state;
    else if (path.startsWith('/intro/')) {
      const id = Number(path.slice('/intro/'.length).split('?')[0]);
      body = introById[id] ?? { text: '', reason: 'no model route is available' };
    }
    else if (path === '/queue') {
      applyQueueAction(state, calls.at(-1).body);
      body = state;
    } else if (path === '/taste') {
      const { trackId, level } = calls.at(-1).body;
      applyTaste(state, trackId, level);
      body = state;
    } else if (path === '/scrobble') {
      state.scrobble = { ...(state.scrobble ?? {}), enabled: calls.at(-1).body.enabled };
      body = state;
    } else if (path === '/boost') {
      const { trackId, direction } = calls.at(-1).body;
      applyBoost(state, trackId, direction);
      body = state;
    } else if (path === '/dj/models') body = { routes: [], selected: {}, configured: {}, source: 'auto' };
    else if (path === '/quality') body = { levels: [] };
    else if (path.startsWith('/info/')) {
      const id = Number(path.slice('/info/'.length));
      body = infoById[id] ?? songInfo({ id });
    } else if (path.startsWith('/lyric/')) {
      const id = Number(path.slice('/lyric/'.length));
      body = {
        lrc: lyricsById[id] ?? '[00:01.00]first line\n[00:05.00]second line',
        translated: '',
        noLyric: false,
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };

  const inline = [...PANEL_SOURCE.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  // A no-op `setTimeout` keeps a stray toast timer from outliving the test.
  new Function(
    'document', 'window', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'console',
    'localStorage', 'getComputedStyle',
    inline.at(-1)[1],
  )(
    document, window, fetch,
    (fn, ms) => intervals.push({ fn, ms }),
    () => {},
    () => 0,
    () => {},
    console,
    localStorage,
    getComputedStyle,
  );
  await settle();

  const lyricRequests = () => requests.filter((path) => path.startsWith('/lyric/'));
  const infoRequests = () => requests.filter((path) => path.startsWith('/info/'));
  const introRequests = () => requests.filter((path) => path.startsWith('/intro/'));
  return {
    state,
    requests,
    calls,
    lyricRequests,
    infoRequests,
    introRequests,
    storage: stored,
    root: document.documentElement,
    element: (id) => document.getElementById(id),
    /** Run the page's 1.5 s poll once, the way the browser would. */
    async poll() {
      intervals.find((entry) => entry.ms === 1500)?.fn();
      await settle();
    },
  };
}

/** What the host's `/info/:id` answers, filled for 晴天 unless overridden. */
function songInfo(overrides = {}) {
  return {
    id: 123,
    name: '晴天',
    alias: [],
    publishTime: 1059580800000,
    album: {
      id: 18905,
      name: '叶惠美',
      type: '专辑',
      subType: '录音室版',
      company: '杰威尔',
      publishTime: 1059580800000,
      size: 11,
      intro: 'The fourth album.',
    },
    artists: [{ id: 6452, name: '周杰伦', intro: 'A singer-songwriter from Taiwan.\n\n　　Debuted in 2000.' }],
    genres: ['流行-华语流行'],
    tags: ['思念', '浪漫'],
    language: '国语',
    bpm: 69,
    awards: ['第2届hito流行音乐奖'],
    featuredIn: [],
    review: { text: 'A song about a rainy day.', by: '某人' },
    ...overrides,
  };
}

const LYRICS_SHOWN = { 'dsh-music.info.view': 'lyrics' };

test('the info card opens on the details, and fetches only them', async () => {
  const panel = await bootPanel();
  assert.equal(panel.element('tab-details').classList.contains('on'), true);
  assert.equal(panel.element('details').hidden, false);
  assert.equal(panel.element('lyrics').hidden, true);
  assert.deepEqual(panel.infoRequests(), ['/info/123']);
  assert.deepEqual(panel.lyricRequests(), [], 'hidden lyrics are not fetched');
});

test('the details show the album, genre, tags and the prose about the song and its artists', async () => {
  const panel = await bootPanel();
  await panel.poll();
  const html = panel.element('details').innerHTML;
  assert.match(html, /<dt>Album<\/dt><dd>叶惠美 <span class="muted">· 录音室版 · 2003-07-31 · 杰威尔 · 11 tracks<\/span>/, 'a NetEase date is a day in China');
  assert.match(html, /<dt>Genre<\/dt><dd><span class="chips"><span class="chip genre">华语流行<\/span>/, 'a genre is named by its leaf');
  assert.match(html, /<span class="chip ">思念<\/span><span class="chip ">浪漫<\/span>/);
  assert.match(html, /<dt>Language<\/dt><dd>国语 · 69 BPM<\/dd>/);
  assert.match(html, /<h4>About the song<\/h4><div class="prose"[^>]*><p>A song about a rainy day\.<\/p><\/div><div class="by">Review by 某人<\/div>/);
  assert.match(html, /<h4>周杰伦<\/h4><div class="prose"[^>]*><p>A singer-songwriter from Taiwan\.<\/p><p>Debuted in 2000\.<\/p><\/div>/, 'each line is its own paragraph');
  assert.match(html, /<h4>About the album<\/h4><div class="prose"[^>]*><p>The fourth album\.<\/p><\/div>/);
  assert.doesNotMatch(html, /Featured in/, 'an empty fact is left out');
});

test('a song NetEase knows nothing more about says so', async () => {
  const bare = songInfo({
    album: {},
    artists: [{ id: 1, name: 'Nobody', intro: '' }],
    genres: [],
    tags: [],
    language: '',
    bpm: null,
    awards: [],
    review: null,
  });
  const panel = await bootPanel({ infoById: { 123: bare } });
  await panel.poll();
  assert.match(panel.element('details').innerHTML, /No details for this song/);
});

test('NetEase text is escaped, never markup', async () => {
  const panel = await bootPanel({ infoById: { 123: songInfo({ tags: ['<img src=x onerror=alert(1)>'] }) } });
  assert.doesNotMatch(panel.element('details').innerHTML, /<img/);
});

test('the introduction is asked for only after the details land, and leads once written', async () => {
  const panel = await bootPanel({ introById: { 123: { text: 'A rainy-day song.\n\nBy a singer from Taiwan.' } } });
  assert.deepEqual(panel.introRequests(), [], 'nothing waits on the model before the facts are shown');
  assert.match(panel.element('details').innerHTML, /<dt>Album<\/dt>/);
  assert.match(panel.element('details').innerHTML, /Writing an introduction…/);
  assert.doesNotMatch(panel.element('details').innerHTML, /<h4>周杰伦<\/h4>/, 'NetEase prose waits behind a click');

  await panel.poll();
  assert.deepEqual(panel.introRequests(), ['/intro/123?lang=en']);
  const html = panel.element('details').innerHTML;
  assert.match(html, /<h4>Introduction<span class="badge">AI<\/span><\/h4><div class="written"[^>]*><p>A rainy-day song\.<\/p><p>By a singer from Taiwan\.<\/p><\/div>/);
  assert.match(html, /data-source="netease">Show what NetEase says<\/button>/);

  await panel.poll();
  assert.deepEqual(panel.introRequests(), ['/intro/123?lang=en'], 'one request per track and language');
});

test('a click on the introduction shows what NetEase says, and the switch goes back', async () => {
  const panel = await bootPanel({ introById: { 123: { text: 'Written.' } } });
  await panel.poll();
  const details = panel.element('details');
  const click = (selector, data) => details.onclick({ target: { closest: (asked) => (asked === selector ? data : null) } });

  click('.written', {});
  assert.match(details.innerHTML, /<h4>周杰伦<\/h4>/);
  assert.doesNotMatch(details.innerHTML, /Written\./);
  assert.match(details.innerHTML, /data-source="ai">Show the AI introduction<\/button>/);

  click('[data-source]', { dataset: { source: 'ai' } });
  assert.match(details.innerHTML, /Written\./);
  assert.doesNotMatch(details.innerHTML, /<h4>周杰伦<\/h4>/);
});

test('without a model, NetEase prose shows, and the next track does not wait on one', async () => {
  const panel = await bootPanel();
  await panel.poll();
  assert.match(panel.element('details').innerHTML, /<h4>周杰伦<\/h4>/);
  assert.doesNotMatch(panel.element('details').innerHTML, /Writing an introduction|data-source/);

  panel.state.current = { ...panel.state.current, id: 456, name: 'Two' };
  await panel.poll();
  assert.match(panel.element('details').innerHTML, /<h4>周杰伦<\/h4>/, 'shown while the next answer is awaited');
});

test('hidden details ask for no introduction', async () => {
  const panel = await bootPanel({ storage: LYRICS_SHOWN });
  await panel.poll();
  await panel.poll();
  assert.deepEqual(panel.introRequests(), []);
});

test('details are fetched once per track, and again for the next one', async () => {
  const panel = await bootPanel({ infoById: { 456: songInfo({ id: 456, album: { name: 'Second album' } }) } });
  await panel.poll();
  assert.deepEqual(panel.infoRequests(), ['/info/123'], 'a repeated poll must not refetch');

  panel.state.current = { ...panel.state.current, id: 456, name: 'Two' };
  await panel.poll();
  assert.deepEqual(panel.infoRequests(), ['/info/123', '/info/456']);
  assert.match(panel.element('details').innerHTML, /Second album/);
});

test('only the shown pane follows the track; the other catches up when shown', async () => {
  const panel = await bootPanel();
  panel.element('tab-lyrics').onclick();
  await settle();
  assert.equal(panel.element('details').hidden, true);
  assert.equal(panel.element('lyrics').hidden, false);
  assert.deepEqual(panel.lyricRequests(), ['/lyric/123'], 'the lyrics load when first shown');
  assert.equal(panel.storage.get('dsh-music.info.view'), 'lyrics', 'the choice is remembered');

  panel.state.current = { ...panel.state.current, id: 456, name: 'Two' };
  await panel.poll();
  assert.deepEqual(panel.lyricRequests(), ['/lyric/123', '/lyric/456']);
  assert.deepEqual(panel.infoRequests(), ['/info/123'], 'hidden details do not follow the track');

  panel.element('tab-details').onclick();
  await settle();
  assert.deepEqual(panel.infoRequests(), ['/info/123', '/info/456'], 'shown again, they catch up');

  panel.element('tab-lyrics').onclick();
  await settle();
  assert.deepEqual(panel.lyricRequests(), ['/lyric/123', '/lyric/456'], 'lyrics still current are not refetched');
});

/** A playing track with two more after it, in `mode`. */
function upNextState(mode = 'list') {
  const track = (id) => ({ id, name: `T${id}`, artists: ['A'], album: 'X', duration: 1000, picUrl: null, vip: false });
  const queue = [track(1), track(2), track(3)];
  return stateDocument({ queue, index: 0, current: queue[0], mode, counts: { queued: 3, remaining: 2 } });
}

test('the next track\'s details are fetched once the shown ones land, and show the moment it starts', async () => {
  const panel = await bootPanel({ state: upNextState() });
  assert.deepEqual(panel.infoRequests(), ['/info/1'], 'the shown track first, alone');

  await panel.poll();
  assert.deepEqual(panel.infoRequests(), ['/info/1', '/info/2'], 'then the next one, and only the next');
  await panel.poll();
  assert.deepEqual(panel.infoRequests(), ['/info/1', '/info/2'], 'once');

  panel.state.index = 1;
  panel.state.current = panel.state.queue[1];
  await panel.poll();
  assert.match(panel.element('details').innerHTML, /<dt>Album<\/dt>/);
  assert.deepEqual(panel.infoRequests(), ['/info/1', '/info/2', '/info/3'], 'from what was fetched ahead, and the next is fetched in turn');
});

test('nothing is fetched ahead while the lyrics are shown, or in shuffle', async () => {
  const lyrics = await bootPanel({ state: upNextState(), storage: LYRICS_SHOWN });
  await lyrics.poll();
  assert.deepEqual(lyrics.infoRequests(), []);

  const shuffled = await bootPanel({ state: upNextState('shuffle') });
  await shuffled.poll();
  assert.deepEqual(shuffled.infoRequests(), ['/info/1'], 'the next track is anyone\'s guess');
});

test('switching back to a track already seen reuses its details', async () => {
  const panel = await bootPanel();
  panel.state.current = { ...panel.state.current, id: 456, name: 'Two' };
  await panel.poll();
  panel.state.current = { ...panel.state.current, id: 123, name: 'One' };
  await panel.poll();
  assert.deepEqual(panel.infoRequests(), ['/info/123', '/info/456']);
  assert.match(panel.element('details').innerHTML, /叶惠美/);
});

test('the page fetches the lyrics for the track it renders, engine or not', async () => {
  // Lyrics used to be requested only from the local fallback transport's
  // `applySource`, which never runs while the shell engine owns the audio
  // element — so the pane sat on "—" through every track.
  const panel = await bootPanel({ storage: LYRICS_SHOWN });
  assert.equal(panel.element('tab-lyrics').classList.contains('on'), true, 'a remembered choice is applied');
  assert.deepEqual(panel.lyricRequests(), ['/lyric/123'], 'the rendered track must be asked for');
  assert.match(panel.element('lyrics').innerHTML, /first line/, 'and the lines must reach the pane');
  assert.deepEqual(panel.infoRequests(), [], 'hidden details are not fetched');
});

test('lyrics are fetched once per track, not once per poll', async () => {
  const panel = await bootPanel({ storage: LYRICS_SHOWN });
  await panel.poll();
  await panel.poll();
  assert.deepEqual(panel.lyricRequests(), ['/lyric/123'], 'a repeated poll must not refetch');
});

test('a track change refetches and replaces the lyrics', async () => {
  const panel = await bootPanel({ storage: LYRICS_SHOWN, lyricsById: { 456: '[00:01.00]the next track' } });
  assert.match(panel.element('lyrics').innerHTML, /first line/);

  panel.state.current = { ...panel.state.current, id: 456, name: 'Two' };
  await panel.poll();

  assert.deepEqual(panel.lyricRequests(), ['/lyric/123', '/lyric/456']);
  assert.match(panel.element('lyrics').innerHTML, /the next track/);
  assert.doesNotMatch(panel.element('lyrics').innerHTML, /first line/);
});

// ------------------------------------------------------------ autoplay hint

/** The host wants playback; the transport's last report for the track says it is not playing. */
function wantedState(reported) {
  return stateDocument({
    playing: true,
    reported: { trackId: 123, position: 0, duration: 0, playing: false, at: 1, error: null, ...reported },
  });
}

test('a Play click the audio has not caught up with shows no autoplay hint', async () => {
  // Wanted and not yet playing is every Play click's first half second; the
  // hint used to flash on each one.
  const panel = await bootPanel({ state: wantedState({}) });
  await panel.poll();
  assert.equal(panel.element('gesture'), null);
});

test('a refusal shows the autoplay hint, and audio that starts takes it away', async () => {
  const panel = await bootPanel({ state: wantedState({ blocked: true }) });
  assert.match(panel.element('gesture')?.innerHTML ?? '', /needs one interaction/);
  assert.equal(panel.element('notices').children.length, 1, 'over the page, in the notices');

  panel.state.reported = { ...panel.state.reported, playing: true, blocked: false };
  await panel.poll();
  assert.equal(panel.element('gesture'), null);
});

// ------------------------------------------------------------------ theme

test('inside DSH the page takes the shell\'s theme and its live colours', async () => {
  const dark = await bootPanel({
    shell: { dark: true, colors: { '--dsw-alias-bg-base': '#151517', '--dsw-alias-label-primary': '#f9fafb', '--dsh-scrollbar-thumb': '#3c3c3d' } },
  });
  assert.equal(dark.root.dataset.theme, 'dark');
  assert.equal(dark.root.style.getPropertyValue('--bg'), '#151517');
  assert.equal(dark.root.style.getPropertyValue('--fg'), '#f9fafb');
  assert.equal(dark.root.style.getPropertyValue('--scrollbar-thumb'), '#3c3c3d');
  assert.equal(dark.root.style.getPropertyValue('--scrollbar-thumb-hover'), '', 'a colour the shell lacks keeps the palette\'s');

  const light = await bootPanel({ shell: { dark: false } });
  assert.equal(light.root.dataset.theme, 'light');
});

test('standalone, the page leaves the theme to the system', async () => {
  const panel = await bootPanel();
  assert.equal(panel.root.dataset.theme, undefined);
});

// ----------------------------------------------------------------- the hearts
/** A state document with a queue, so the list has rows to draw hearts into. */
function queueState({ liked = [], disliked = [], currentId = 1 } = {}) {
  const track = (id) => ({
    id,
    name: `T${id}`,
    artists: ['A'],
    album: 'X',
    duration: 1000,
    picUrl: null,
    vip: false,
    liked: liked.includes(id),
    disliked: disliked.includes(id),
  });
  const queue = [track(1), track(2)];
  return stateDocument({ queue, current: queue.find((entry) => entry.id === currentId), counts: { queued: 2, remaining: 1 } });
}

/** A click event whose target sits inside one row control (`like`, `jump`, …). */
const rowClick = (control, value) => ({
  target: {
    closest: (asked) => (asked === `[data-${control}]` ? { dataset: { [control]: String(value) } } : null),
  },
});

test('the song list draws a filled heart only for a liked track', async () => {
  const panel = await bootPanel({ state: queueState({ liked: [2] }) });
  const html = panel.element('queue').innerHTML;

  const rows = html.split('<div class="row').slice(1);
  assert.equal(rows.length, 2, 'one row per queued track');
  assert.doesNotMatch(rows[0], /class="heart on"/, 'an unrated track has no filled heart');
  assert.match(rows[0], /data-like="0"[^>]*><svg class="i small"/, 'and offers the outline');
  assert.match(rows[1], /class="heart on" data-like="1" title="Unlike"><svg class="i filled small"/, 'a liked track keeps its filled heart');
});

test('the row heart is a switcher, and it does not play the row', async () => {
  const panel = await bootPanel({ state: queueState({ liked: [1] }) });

  // A liked track: the same button takes the like back.
  await panel.element('queue').onclick(rowClick('like', 0));
  assert.deepEqual(panel.calls.at(-1), { path: '/taste', body: { trackId: 1, level: 'none' } });
  assert.equal(panel.state.queue[0].liked, false, 'and the heart empties');

  await panel.element('queue').onclick(rowClick('like', 0));
  assert.deepEqual(panel.calls.at(-1), { path: '/taste', body: { trackId: 1, level: 'liked' } });
  assert.equal(panel.state.queue[0].liked, true);

  // A click on the row itself still plays it, so the heart's branch is what
  // keeps the two apart.
  await panel.element('queue').onclick(rowClick('jump', 1));
  assert.deepEqual(panel.calls.at(-1), { path: '/queue', body: { action: 'jump', index: 1 } });
  assert.equal(panel.calls.filter((call) => call.path === '/taste').length, 2, 'a row click must not like anything');
});

test('Clear empties the queue around the playing track, rating nothing', async () => {
  const panel = await bootPanel({ state: queueState() });
  assert.equal(panel.element('queue-clear').disabled, false);

  await panel.element('queue-clear').onclick();
  assert.deepEqual(panel.calls.at(-1), { path: '/queue', body: { action: 'clear', keepCurrent: true } });
  assert.equal(panel.calls.some((call) => call.path === '/taste'), false);
  assert.deepEqual(panel.state.queue.map((track) => track.id), [1]);
  assert.equal(panel.element('queue-clear').disabled, true, 'with only the playing track left, there is nothing to clear');
});

test('the transport row is a switcher too', async () => {
  const panel = await bootPanel({ state: queueState({ liked: [1] }) });
  assert.equal(panel.element('like').dataset.icon, 'heart:filled');
  assert.equal(panel.element('like').classList.contains('on'), true);
  assert.equal(panel.element('like').title, 'Unlike');

  await panel.element('like').onclick();
  assert.deepEqual(panel.calls.at(-1), { path: '/taste', body: { trackId: 1, level: 'none' } });
  assert.equal(panel.element('like').dataset.icon, 'heart', 'the button follows the level it just set');
  assert.equal(panel.element('like').title, 'Like');

  await panel.element('like').onclick();
  assert.deepEqual(panel.calls.at(-1), { path: '/taste', body: { trackId: 1, level: 'liked' } });
  assert.equal(panel.element('like').dataset.icon, 'heart:filled');
});

test('the arrows boost the playing track, and a filled arrow clears it', async () => {
  const panel = await bootPanel({ state: queueState({ currentId: 1 }) });
  await panel.element('boost-more').onclick();
  assert.deepEqual(panel.calls.at(-1), { path: '/boost', body: { trackId: 1, direction: 'more' } });
  assert.equal(panel.element('boost-more').classList.contains('on'), true, 'the arrow fills');
  assert.equal(panel.element('boost-more').title, 'Clear this boost', 'and says what a second click does');
  assert.equal(panel.element('toast').textContent, 'More like this for the next hour');

  await panel.element('boost-more').onclick();
  assert.deepEqual(panel.calls.at(-1), { path: '/boost', body: { trackId: 1, direction: 'none' } });
  assert.equal(panel.element('boost-more').classList.contains('on'), false);

  await panel.element('boost-less').onclick();
  assert.deepEqual(panel.calls.at(-1), { path: '/boost', body: { trackId: 1, direction: 'less' } });
  assert.equal(panel.element('boost-less').classList.contains('on'), true);
  assert.equal(panel.element('boost-more').classList.contains('on'), false, 'one direction at a time');
});

test('the boosts in force are listed with their time left, and each can be ended', async () => {
  const state = queueState({ currentId: 1 });
  state.boosts = [{ id: 2, name: 'T2', artists: ['A'], direction: 'less', until: Date.now() + 42 * 60_000 }];
  const panel = await bootPanel({ state });
  const html = panel.element('boosts').innerHTML;
  assert.match(html, /<path d="m7 6 5 5 5-5"\/>.*<\/svg> T2 · 4[12] min/, 'the "fewer" icon, the track and the minutes left');

  await panel.element('boosts').onclick({ target: { closest: (asked) => (asked === '[data-unboost]' ? { dataset: { unboost: '2' } } : null) } });
  assert.deepEqual(panel.calls.at(-1), { path: '/boost', body: { trackId: 2, direction: 'none' } });
  assert.equal(panel.element('boosts').innerHTML, '', 'nothing left to list');
});

test('the listening-history switch shows its state, and a click turns it the other way', async () => {
  const state = queueState({ currentId: 1 });
  Object.assign(state, { authenticated: true, scrobble: { enabled: true, active: true, last: null } });
  const panel = await bootPanel({ state });
  assert.equal(panel.element('history').hidden, false, 'signed in, the switch is there');
  assert.equal(panel.element('scrobble-toggle').classList.contains('on'), true);
  assert.match(panel.element('scrobble-toggle').title, /click to stop/);

  await panel.element('scrobble-toggle').onclick();
  assert.deepEqual(panel.calls.at(-1), { path: '/scrobble', body: { enabled: false } });
  assert.equal(panel.element('scrobble-toggle').classList.contains('on'), false);
  assert.equal(panel.element('toast').textContent, 'Plays will stay local');
});

test('signed out, there is no listening-history switch', async () => {
  const state = queueState({ currentId: 1 });
  Object.assign(state, { authenticated: false, scrobble: { enabled: true, active: false, last: null } });
  const panel = await bootPanel({ state });
  assert.equal(panel.element('history').hidden, true);
});

test('the boost labels follow the shell language', async () => {
  const panel = await bootPanel({ state: queueState({ currentId: 1 }), lang: 'zh-CN' });
  assert.equal(panel.element('boost-more').title, '接下来一小时多放类似的');
  assert.equal(panel.element('boost-less').title, '接下来一小时少放类似的');
});

test('a dislike takes the playing track out of the queue, in one request', async () => {
  const panel = await bootPanel({ state: queueState({ currentId: 1 }) });
  await panel.element('dislike').onclick();
  assert.deepEqual(
    panel.calls.filter((call) => call.path === '/taste'),
    [{ path: '/taste', body: { trackId: 1, level: 'disliked' } }],
  );
  assert.equal(
    panel.calls.some((call) => call.path === '/control'),
    false,
    'the host moves on; pressing next as well would skip a second track',
  );
  assert.equal(panel.element('toast').textContent, 'Disliked');
  assert.deepEqual(panel.state.queue.map((track) => track.id), [2], 'the disliked track left the queue');
  assert.equal(panel.state.current.id, 2, 'and playback moved to the next one');
  assert.doesNotMatch(panel.element('queue').innerHTML, /T1/);
});

test('a disliked track queued again on purpose shows the level, and the ✕ clears it', async () => {
  // Disliking removes a track; queueing it again afterwards is the listener's
  // own choice, so it stays, drawn as disliked, and the filled ✕ takes it back.
  const panel = await bootPanel({ state: queueState({ currentId: 1, disliked: [1] }) });
  await panel.element('dislike').onclick();
  assert.deepEqual(panel.calls.at(-1), { path: '/taste', body: { trackId: 1, level: 'none' } });
  assert.equal(panel.state.current.id, 1, 'clearing a dislike stays on the track');
  assert.equal(panel.state.current.disliked, false);
});

test('removing a row takes the song out of the list', async () => {
  // The row's ✕ is a judgement about the track as well as a removal, and the
  // queue endpoint is where the host does both in one request: the row leaves
  // the list and an unrated track is recorded as disliked, so the DJ does not
  // offer it again. Read as `/taste` alone it only wrote the level and the row
  // stayed, which is the bug this covers.
  const panel = await bootPanel({ state: queueState() });
  assert.match(panel.element('queue').innerHTML, /T2/, 'the row starts in the list');

  await panel.element('queue').onclick(rowClick('remove', 1));
  assert.deepEqual(panel.calls.at(-1), { path: '/queue', body: { action: 'remove', index: 1 } });
  assert.equal(panel.element('toast').textContent, 'Removed', 'the confirm names the removal, not the judgement');
  assert.deepEqual(panel.state.queue.map((track) => track.id), [1], 'and the row is gone from the state');
  assert.doesNotMatch(panel.element('queue').innerHTML, /T2/, 'and from the list the page drew');
  assert.equal(panel.calls.some((call) => call.path === '/taste'), false, 'the removal is one request, not two');

  // Unlike a dislike from the transport row, this does not skip: nothing was
  // playing that the click asked to move past.
  assert.equal(panel.calls.some((call) => call.path === '/control'), false);
});

test('removing a row that carries a level confirms the removal, not a dislike', async () => {
  // The host leaves a rated track's level alone — removing is often queue
  // housekeeping — so the confirm names what the click did: the row is gone.
  const panel = await bootPanel({ state: queueState({ liked: [2] }) });

  await panel.element('queue').onclick(rowClick('remove', 1));
  assert.deepEqual(panel.calls.at(-1), { path: '/queue', body: { action: 'remove', index: 1 } });
  assert.deepEqual(panel.state.queue.map((track) => track.id), [1], 'the row leaves the list');
  assert.equal(panel.element('toast').textContent, 'Removed');
  assert.equal(panel.calls.some((call) => call.path === '/taste'), false, 'and its like is not rewritten');
});

test('removing the playing row adopts the track the host moved on to', async () => {
  // The row's ✕ on the playing track is not just a list edit: the host drops
  // the row and moves the cursor, so the page has to draw the new current track
  // rather than one it no longer holds.
  const panel = await bootPanel({ state: queueState({ currentId: 1 }) });

  await panel.element('queue').onclick(rowClick('remove', 0));
  // The new current track's lyrics are fetched after the render, so the removal
  // is not necessarily the last call the page made.
  assert.deepEqual(
    panel.calls.find((call) => call.path === '/queue'),
    { path: '/queue', body: { action: 'remove', index: 0 } },
  );
  assert.equal(panel.state.current.id, 2, 'playback moved to the next queued track');
  assert.equal(panel.element('np-title').textContent, 'T2', 'and the transport row follows it');
});

test('a row removal cannot be fired twice while it is in flight', async () => {
  // The request is a trip to NetEase, so a second click before it lands would
  // toggle the level straight back.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const panel = await bootPanel({
    state: queueState(),
    handle: async (path) => {
      if (path !== '/queue') return null;
      await gate;
      return { ok: true, status: 200, text: async () => JSON.stringify(panel.state) };
    },
  });

  const button = { disabled: false, dataset: { remove: '1' } };
  const click = { target: { closest: (asked) => (asked === '[data-remove]' ? button : null) } };
  const inFlight = panel.element('queue').onclick(click);
  // The handler reaches the request on the first microtask, and the button is
  // disabled on the way in.
  await null;
  assert.equal(button.disabled, true, 'the row is locked while the host answers');
  assert.deepEqual(panel.calls.at(-1), { path: '/queue', body: { action: 'remove', index: 1 } });
  release();
  await inFlight;
  assert.equal(button.disabled, false, 'and released afterwards, so the list stays usable');
});

test('the taste labels follow the shell language', async () => {
  // These two buttons carry no `data-i18n`: their label says which direction a
  // click moves the track, so the page paints them — including before the first
  // state document, which is when a zh shell would otherwise flash English.
  const panel = await bootPanel({ state: queueState({ liked: [1] }), lang: 'zh' });
  assert.equal(panel.element('like').title, '取消喜欢');
  assert.equal(panel.element('dislike').title, '不喜欢');
  assert.match(panel.element('queue').innerHTML, /title="取消喜欢"/, 'and the rows follow it too');

  // The row's confirm comes from the page's own dictionary as well.
  await panel.element('queue').onclick(rowClick('remove', 1));
  assert.equal(panel.element('toast').textContent, '已移除');
});

test('a refused like says so in the page’s own language, and changes nothing', async () => {
  // The host answers 401 with a machine code for an anonymous session; the
  // sentence it also carries is English, so the page must not show it raw.
  const panel = await bootPanel({
    state: queueState(),
    handle: (path) =>
      path === '/taste'
        ? { ok: false, status: 401, text: async () => JSON.stringify({ error: 'the NetEase session is anonymous', code: 'ANONYMOUS' }) }
        : null,
  });

  await panel.element('like').onclick();
  assert.equal(panel.element('toast').textContent, 'Sign in to NetEase to like tracks');
  assert.equal(panel.state.current.liked, false, 'no heart for a like NetEase never received');
  assert.equal(panel.element('like').dataset.icon, 'heart');
});

test('a refusal the page does not know is reported in the host’s words', async () => {
  const panel = await bootPanel({
    state: queueState(),
    handle: (path) =>
      path === '/taste'
        ? { ok: false, status: 502, text: async () => JSON.stringify({ error: '歌曲已经下架了', code: 400 }) }
        : null,
  });
  await panel.element('like').onclick();
  assert.equal(panel.element('toast').textContent, '歌曲已经下架了');
});

// ------------------------------------------------------------- the model card
test('the DJ model card stays folded until asked, and the choice sticks', async () => {
  const panel = await bootPanel();
  const body = panel.element('dj-model-body');
  const toggle = panel.element('dj-model-toggle');

  assert.equal(body.classList.contains('collapsed'), true, 'folded by default');
  assert.equal(toggle.textContent, '▸');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');

  // The header is the click target; the chevron inside it is what a keyboard
  // reaches, and its click bubbles to the same handler.
  panel.element('dj-model-head').onclick();
  assert.equal(body.classList.contains('collapsed'), false, 'the click unfolds the form');
  assert.equal(toggle.textContent, '▾', 'and the chevron points the way back');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(panel.storage.get('dsh-music.djmodel.expanded'), '1', 'the choice is remembered');

  panel.element('dj-model-head').onclick();
  assert.equal(body.classList.contains('collapsed'), true);
  assert.equal(toggle.textContent, '▸');
  assert.equal(panel.storage.get('dsh-music.djmodel.expanded'), '0');
});

test('the folded card names the effective route, and a remembered fold is applied', async () => {
  // The fold is only honest if the one visible line answers "which model is the
  // DJ using?" — otherwise a closed picker hides its own answer.
  const panel = await bootPanel({
    storage: { 'dsh-music.djmodel.expanded': '1' },
    handle: (path) =>
      path === '/dj/models'
        ? {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                routes: [],
                selected: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
                configured: {},
                source: 'panel',
              }),
          }
        : null,
  });

  assert.equal(panel.element('dj-model-body').classList.contains('collapsed'), false, 'the remembered fold opens it');
  assert.equal(panel.element('dj-model-toggle').textContent, '▾');
  assert.equal(panel.element('dj-model-route').textContent, 'opencode-go/deepseek-v4.1-flash');
  assert.equal(panel.element('dj-model-source').textContent, ' · panel', 'and where the pin came from');
});

test('an error the folded card would hide is marked on its header', async () => {
  // A broken route or a host that predates the endpoint writes to the status
  // line, which is inside the folded body — so the header has to carry a mark.
  const panel = await bootPanel({
    handle: (path) =>
      path === '/dj/models'
        ? {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({ routes: [], selected: {}, configured: {}, source: 'auto', error: 'no model service is mounted' }),
          }
        : null,
  });

  assert.equal(panel.element('dj-model-status').textContent, 'no model service is mounted');
  assert.equal(panel.element('dj-model-warn').textContent, ' ⚠');
  assert.equal(panel.element('dj-model-warn').title, 'no model service is mounted');
});
