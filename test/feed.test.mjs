/**
 * The state event stream, against stand-in requests and responses.
 *
 * Run with `node test/feed.test.mjs`.
 *
 * @module dsh-music/test/feed
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { SnapshotVersions, StateFeed, visibleKey } from '../lib/feed.js';

/** One open `GET /events`: the request, and a response recording what it was sent. */
function connection() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.chunks = [];
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers;
  };
  res.write = (chunk) => {
    res.chunks.push(chunk);
    return true;
  };
  res.end = () => {
    res.ended = true;
  };
  /** The state frames received, parsed. */
  res.states = () =>
    res.chunks.filter((chunk) => chunk.startsWith('event: state')).map((chunk) => JSON.parse(chunk.split('data: ')[1]));
  return { req, res };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function makeFeed(initial = {}) {
  let state = { rev: 1, playing: true, queue: [1, 2], reported: { position: 0, at: 0, playing: true }, ...initial };
  let reads = 0;
  const feed = new StateFeed({
    snapshot: async () => {
      reads += 1;
      return structuredClone(state);
    },
    sweepMs: 60_000,
    heartbeatMs: 60_000,
  });
  return {
    feed,
    set(patch) {
      state = { ...state, ...patch };
    },
    reads: () => reads,
  };
}

test('a client is answered as an event stream and sent the state at once', async () => {
  const { feed } = makeFeed();
  const { req, res } = connection();
  try {
    feed.attach(req, res);
    await settle();
    assert.equal(res.status, 200);
    assert.match(res.headers['Content-Type'], /^text\/event-stream/);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.match(res.chunks[0], /^retry: \d+\n\n$/);
    assert.deepEqual(res.states().map((state) => state.queue), [[1, 2]]);
  } finally {
    feed.close();
  }
});

test('a change is sent to every client, once per burst', async () => {
  const app = makeFeed();
  const first = connection();
  const second = connection();
  try {
    app.feed.attach(first.req, first.res);
    app.feed.attach(second.req, second.res);
    await settle();

    app.set({ queue: [1, 2, 3] });
    app.feed.changed();
    app.feed.changed();
    app.feed.changed();
    await settle();

    for (const { res } of [first, second]) {
      assert.deepEqual(res.states().at(-1).queue, [1, 2, 3]);
      assert.equal(res.states().length, 2, 'the opening state, then one frame for the burst');
    }
  } finally {
    app.feed.close();
  }
});

test('a position report moves nothing the clients see, so nothing is sent', async () => {
  const app = makeFeed();
  const { req, res } = connection();
  try {
    app.feed.attach(req, res);
    await settle();

    app.set({ rev: 2, reported: { position: 1000, at: 1, playing: true } });
    app.feed.changed();
    await settle();
    assert.equal(res.states().length, 1);

    // A report that does change something visible still goes out.
    app.set({ rev: 3, reported: { position: 2000, at: 2, playing: false } });
    app.feed.changed();
    await settle();
    assert.equal(res.states().length, 2);
    assert.equal(res.states().at(-1).reported.playing, false);
  } finally {
    app.feed.close();
  }
});

test('a client joining later gets the current state without resending to the others', async () => {
  const app = makeFeed();
  const early = connection();
  const late = connection();
  try {
    app.feed.attach(early.req, early.res);
    await settle();
    app.feed.attach(late.req, late.res);
    await settle();
    assert.equal(early.res.states().length, 1);
    assert.equal(late.res.states().length, 1);
  } finally {
    app.feed.close();
  }
});

test('nothing is read while nobody listens, and a closed client is forgotten', async () => {
  const app = makeFeed();
  const { req, res } = connection();
  app.feed.changed();
  await settle();
  assert.equal(app.reads(), 0);

  app.feed.attach(req, res);
  await settle();
  req.emit('close');
  assert.equal(app.feed.clients.size, 0);
  assert.equal(app.feed.sweep, undefined, 'the timers stop with the last client');

  const before = app.reads();
  app.set({ queue: [] });
  app.feed.changed();
  await settle();
  assert.equal(app.reads(), before);
  assert.equal(res.states().length, 1);
});

test('closing the feed ends every stream', async () => {
  const app = makeFeed();
  const { req, res } = connection();
  app.feed.attach(req, res);
  await settle();
  app.feed.close();
  assert.equal(res.ended, true);
  assert.equal(app.feed.clients.size, 0);
});

test('the sweep finds a change nothing announced', async () => {
  let queue = [1];
  const feed = new StateFeed({ snapshot: async () => ({ rev: 1, queue, reported: {} }), sweepMs: 30, heartbeatMs: 60_000 });
  const { req, res } = connection();
  try {
    feed.attach(req, res);
    await settle();
    queue = [1, 2];
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(res.states().at(-1).queue, [1, 2]);
  } finally {
    feed.close();
  }
});

test('idle connections are kept alive with comments', async () => {
  const feed = new StateFeed({ snapshot: async () => ({ rev: 1, reported: {} }), sweepMs: 60_000, heartbeatMs: 30 });
  const { req, res } = connection();
  try {
    feed.attach(req, res);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(res.chunks.includes(': ping\n\n'));
  } finally {
    feed.close();
  }
});

test('the comparison ignores the position, its time, and the revision', () => {
  const base = { rev: 1, playing: true, reported: { position: 0, at: 0, duration: 1000, playing: true } };
  assert.equal(
    visibleKey(base),
    visibleKey({ ...base, rev: 9, reported: { ...base.reported, position: 5000, at: 99 } }),
  );
  assert.notEqual(visibleKey(base), visibleKey({ ...base, reported: { ...base.reported, duration: 2000 } }));
  // A seek's range request re-records the stream with a new time and nothing else.
  const streamed = { ...base, audio: { preferred: 'exhigh', last: { trackId: 1, type: 'mp3', at: 1 } } };
  assert.equal(visibleKey(streamed), visibleKey({ ...streamed, audio: { ...streamed.audio, last: { ...streamed.audio.last, at: 2 } } }));
  assert.notEqual(visibleKey(streamed), visibleKey({ ...streamed, audio: { ...streamed.audio, last: { trackId: 1, type: 'flac', at: 2 } } }));
  assert.notEqual(visibleKey(base), visibleKey({ ...base, playing: false }));
});

test('a snapshot version moves with what is shown, and only with that', () => {
  const versions = new SnapshotVersions();
  const base = { rev: 1, audio: { preferred: 'exhigh', last: null }, reported: { position: 0, at: 0 } };
  const first = versions.stamp(base).version;
  assert.equal(versions.stamp({ ...base, rev: 2, reported: { position: 900, at: 5 } }).version, first, 'a position report');
  const quality = versions.stamp({ ...base, audio: { preferred: 'lossless', last: null } }).version;
  assert.ok(quality > first, 'a setting moves it, though the player revision did not');
  assert.ok(versions.stamp(base).version > quality, 'and moving back is newer still');
});
