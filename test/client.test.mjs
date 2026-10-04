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
        return Promise.reject(
          new Error('NotAllowedError: play() failed because the user did not interact with the document first'),
        );
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
    location: { origin: ORIGIN },
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
    assert.equal(audio.dataset.trackKey, '123:lossless');

    // The position is restored once the new file's metadata arrives.
    for (const listener of audio.listeners.loadedmetadata ?? []) listener();
    assert.equal(audio.currentTime, 42, 'a quality switch must not restart the song');
  } finally {
    await dispose?.();
    harness.restore();
  }
});

test('volume follows the host without a transport change', async () => {
  const harness = await loadClientBundle();
  let dispose;
  try {
    dispose = await harness.bundle.apply(harness.ctx);
    await settle();
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
    remove() {},
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
  const stored = new Map(Object.entries(options.storage ?? {}));
  const requests = [];
  const calls = [];
  const elements = new Map();
  const intervals = [];

  const document = {
    activeElement: null,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makePageElement(id));
      return elements.get(id);
    },
    createElement: (tag) => makePageElement(tag),
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const window = {
    parent: {
      __dshMusicEngine: { playback: true, apply() {}, sync() {}, position: () => 0 },
      // The page follows the shell's `<html lang>`; pin it so assertions on
      // labels do not depend on the machine's own locale.
      document: { documentElement: { lang: options.lang ?? 'en' } },
    },
    addEventListener() {},
  };
  // The page remembers the lyrics pane's collapse state here.
  const localStorage = {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => { stored.set(key, String(value)); },
    removeItem: (key) => { stored.delete(key); },
  };
  const fetch = async (url, init) => {
    const path = String(url).replace(/^.*\/api/, '');
    requests.push(path);
    calls.push({ path, body: init?.body ? JSON.parse(init.body) : null });
    const custom = options.handle ? await options.handle(path) : null;
    if (custom) return custom;
    let body = {};
    // Every mutating route answers with the fresh snapshot, as the host does.
    if (path === '/state' || path === '/control' || path === '/queue' || path === '/report') body = state;
    else if (path === '/taste') {
      const { trackId, level } = calls.at(-1).body;
      applyTaste(state, trackId, level);
      body = state;
    } else if (path === '/dj/models') body = { routes: [], selected: {}, configured: {}, source: 'auto' };
    else if (path === '/quality') body = { levels: [] };
    else if (path.startsWith('/lyric/')) {
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
    'localStorage',
    inline.at(-1)[1],
  )(
    document, window, fetch,
    (fn, ms) => intervals.push({ fn, ms }),
    () => {},
    () => 0,
    () => {},
    console,
    localStorage,
  );
  await settle();

  const lyricRequests = () => requests.filter((path) => path.startsWith('/lyric/'));
  return {
    state,
    requests,
    calls,
    lyricRequests,
    storage: stored,
    element: (id) => document.getElementById(id),
    /** Run the page's 1.5 s poll once, the way the browser would. */
    async poll() {
      intervals.find((entry) => entry.ms === 1500)?.fn();
      await settle();
    },
  };
}

test('the page fetches the lyrics for the track it renders, engine or not', async () => {
  // Lyrics used to be requested only from the local fallback transport's
  // `applySource`, which never runs while the shell engine owns the audio
  // element — so the pane sat on "—" through every track.
  const panel = await bootPanel();
  assert.deepEqual(panel.lyricRequests(), ['/lyric/123'], 'the rendered track must be asked for');
  assert.match(panel.element('lyrics').innerHTML, /first line/, 'and the lines must reach the pane');
});

test('lyrics are fetched once per track, not once per poll', async () => {
  const panel = await bootPanel();
  await panel.poll();
  await panel.poll();
  assert.deepEqual(panel.lyricRequests(), ['/lyric/123'], 'a repeated poll must not refetch');
});

test('a track change refetches and replaces the pane', async () => {
  const panel = await bootPanel({ lyricsById: { 456: '[00:01.00]the next track' } });
  assert.match(panel.element('lyrics').innerHTML, /first line/);

  panel.state.current = { ...panel.state.current, id: 456, name: 'Two' };
  await panel.poll();

  assert.deepEqual(panel.lyricRequests(), ['/lyric/123', '/lyric/456']);
  assert.match(panel.element('lyrics').innerHTML, /the next track/);
  assert.doesNotMatch(panel.element('lyrics').innerHTML, /first line/);
});

test('the lyrics pane collapses to its header on demand, and the choice sticks', async () => {
  const panel = await bootPanel();
  const pane = panel.element('lyrics');
  const toggle = panel.element('lyrics-toggle');
  assert.equal(pane.classList.contains('collapsed'), false, 'open by default');
  assert.equal(toggle.textContent, 'Hide');

  toggle.onclick();
  assert.equal(pane.classList.contains('collapsed'), true, 'the click collapses the pane');
  assert.equal(toggle.textContent, 'Show', 'and the button offers the way back');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(panel.storage.get('dsh-music.lyrics.collapsed'), '1', 'the choice is remembered');

  toggle.onclick();
  assert.equal(pane.classList.contains('collapsed'), false);
  assert.equal(toggle.textContent, 'Hide');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(panel.storage.get('dsh-music.lyrics.collapsed'), '0');
});

test('a remembered collapse is applied when the page loads', async () => {
  const panel = await bootPanel({ storage: { 'dsh-music.lyrics.collapsed': '1' } });
  assert.equal(panel.element('lyrics').classList.contains('collapsed'), true);
  assert.equal(panel.element('lyrics-toggle').textContent, 'Show');
  // The lines are still fetched while hidden, so expanding is instant.
  assert.deepEqual(panel.lyricRequests(), ['/lyric/123']);
  assert.match(panel.element('lyrics').innerHTML, /first line/);
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
  assert.match(rows[0], /data-like="0"[^>]*>♡</, 'and offers the hollow one');
  assert.match(rows[1], /class="heart on" data-like="1" title="Unlike">♥</, 'a liked track keeps its filled heart');
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

test('the transport row is a switcher too', async () => {
  const panel = await bootPanel({ state: queueState({ liked: [1] }) });
  assert.equal(panel.element('like').textContent, '♥');
  assert.equal(panel.element('like').classList.contains('on'), true);
  assert.equal(panel.element('like').title, 'Unlike');

  await panel.element('like').onclick();
  assert.deepEqual(panel.calls.at(-1), { path: '/taste', body: { trackId: 1, level: 'none' } });
  assert.equal(panel.element('like').textContent, '♡', 'the button follows the level it just set');
  assert.equal(panel.element('like').title, 'Like');

  await panel.element('like').onclick();
  assert.deepEqual(panel.calls.at(-1), { path: '/taste', body: { trackId: 1, level: 'liked' } });
  assert.equal(panel.element('like').textContent, '♥');
});

test('a dislike is the third level, and it skips the track', async () => {
  const panel = await bootPanel({ state: queueState({ currentId: 1 }) });
  await panel.element('dislike').onclick();
  assert.deepEqual(panel.calls.at(-2), { path: '/taste', body: { trackId: 1, level: 'disliked' } });
  assert.deepEqual(panel.calls.at(-1), { path: '/control', body: { action: 'next' } }, 'a disliked track is skipped');
  assert.equal(panel.state.current.disliked, true);

  // Clicking the filled ✕ takes the level back and stays on the track.
  await panel.element('dislike').onclick();
  assert.deepEqual(panel.calls.at(-1), { path: '/taste', body: { trackId: 1, level: 'none' } });
  assert.equal(panel.state.current.disliked, false);
});

test('removing a row records a dislike through the same endpoint', async () => {
  // The row's ✕ is a judgement about the track, not just about the list: the
  // host marks it disliked so the DJ does not offer it again. That is why this
  // is the taste endpoint and not `/queue`, and why it confirms like the ✕.
  const panel = await bootPanel({ state: queueState() });

  await panel.element('queue').onclick(rowClick('remove', 1));
  assert.deepEqual(panel.calls.at(-1), { path: '/taste', body: { trackId: 2, level: 'disliked' } });
  assert.equal(panel.element('toast').textContent, 'Disliked');
  assert.equal(panel.state.queue[1].disliked, true, 'and the row is gone with the level set');
  assert.equal(panel.calls.some((call) => call.path === '/queue'), false, 'the removal is one request, not two');

  // Unlike a dislike from the transport row, this does not skip: nothing was
  // playing that the click asked to move past.
  assert.equal(panel.calls.some((call) => call.path === '/control'), false);
});

test('a row removal cannot be fired twice while it is in flight', async () => {
  // The request is a trip to NetEase, so a second click before it lands would
  // toggle the level straight back.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const panel = await bootPanel({
    state: queueState(),
    handle: async (path) => {
      if (path !== '/taste') return null;
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
  assert.deepEqual(panel.calls.at(-1), { path: '/taste', body: { trackId: 2, level: 'disliked' } });
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
  assert.equal(panel.element('like').textContent, '♡');
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
