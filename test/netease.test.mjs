/**
 * Pure unit tests: track normalisation, the cookie jar, and player state.
 *
 * No network. Run with `node test/netease.test.mjs`.
 *
 * @module dsh-music/test/netease
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CookieJar, LEVELS, Netease, isLevel, normalizeTrack, resizeImage } from '../lib/netease.js';
import { Player } from '../lib/state.js';

// --------------------------------------------------------------- fixtures
/** A `/api/search/get/web` entry: `artists`/`album`/`duration`. */
const SEARCH_SHAPE = {
  id: 1973665667,
  name: '海屿你',
  artists: [{ id: 1, name: '马也_Crabbit' }, { id: 2, name: '另一人' }],
  album: { id: 9, name: '海屿你', picUrl: 'http://p4.music.126.net/x==/y.jpg' },
  duration: 295940,
  fee: 8,
  mvid: 0,
};

/** A `/api/v6/playlist/detail` entry: `ar`/`al`/`dt`. */
const PLAYLIST_SHAPE = {
  id: 1901371647,
  name: '孤勇者',
  ar: [{ name: '陈奕迅' }],
  al: { name: '孤勇者', picUrl: 'http://p1.music.126.net/a==/b.jpg' },
  dt: 256000,
  fee: 1,
};

/** A `personalized/newsong` entry: the track nests under `song`. */
const NESTED_SHAPE = {
  id: 999,
  type: 4,
  name: 'outer name is ignored',
  song: {
    id: 999,
    name: '两难pt.2',
    artists: [{ name: '加木' }],
    album: { name: '两难', picUrl: 'http://p1.music.126.net/n==/m.jpg' },
    duration: 180000,
    fee: 8,
  },
};

test('normalizes every payload shape NetEase returns', () => {
  const search = normalizeTrack(SEARCH_SHAPE);
  assert.deepEqual(search.artists, ['马也_Crabbit', '另一人']);
  assert.equal(search.album, '海屿你');
  assert.equal(search.duration, 295940);
  assert.equal(search.vip, false);
  assert.match(search.picUrl, /^http:\/\/p4\.music\.126\.net\/x==\/y\.jpg\?param=224y224$/);

  const playlist = normalizeTrack(PLAYLIST_SHAPE);
  assert.deepEqual(playlist.artists, ['陈奕迅']);
  assert.equal(playlist.album, '孤勇者');
  assert.equal(playlist.duration, 256000);
  assert.equal(playlist.vip, true, 'fee=1 is VIP-gated');

  const nested = normalizeTrack(NESTED_SHAPE);
  assert.equal(nested.id, 999);
  assert.equal(nested.name, '两难pt.2', 'the nested song wins over the wrapper');
  assert.deepEqual(nested.artists, ['加木']);

  assert.equal(normalizeTrack({ name: 'no id' }), null);
  assert.equal(normalizeTrack(null), null);
});

test('normalizeTrack is idempotent', () => {
  // This is the regression that made every artist vanish: tracks flow through
  // the API client, the agent tools, the DJ and the panel's /play round-trip,
  // so an already-normalized track is normalized again.
  for (const raw of [SEARCH_SHAPE, PLAYLIST_SHAPE, NESTED_SHAPE]) {
    const once = normalizeTrack(raw);
    const twice = normalizeTrack(once);
    assert.deepEqual(twice, once, 'a second pass must not drop artists, album, or re-size the cover');
    assert.deepEqual(normalizeTrack(twice), once, 'and it must stay stable');
  }
});

test('resizeImage is idempotent and leaves foreign hosts alone', () => {
  const source = 'http://p1.music.126.net/a==/b.jpg';
  const once = resizeImage(source, 224);
  assert.equal(once, `${source}?param=224y224`);
  assert.equal(resizeImage(once, 224), once, 'a sized URL must not gain a second param');
  assert.equal(resizeImage(once, 500), `${source}?param=500y500`, 'but it may be re-sized');
  assert.equal(resizeImage('https://example.com/a.png'), 'https://example.com/a.png');
  assert.equal(resizeImage(null), null);
});

// ------------------------------------------------------------ quality ladder

/** A client whose API calls are answered from a scripted table. */
function scriptedClient(handler) {
  const api = new Netease({ cookie: 'MUSIC_U=fake' });
  const attempts = [];
  api.call = async (endpoint, options) => {
    attempts.push({ endpoint, level: options?.query?.level, encodeType: options?.query?.encodeType });
    return handler(options?.query?.level);
  };
  return { api, attempts };
}

/** Answers a served level with that level's real encoding, or a refusal. */
const serveAt = (levels) => (level) => {
  if (!levels.includes(level)) return { data: [{ code: -110 }] };
  const kind = LEVELS.find((entry) => entry.id === level)?.kind ?? 'mp3';
  return {
    data: [
      {
        url: `http://cdn/${level}.${kind}`,
        level,
        br: kind === 'flac' ? 900_000 : 320_000,
        type: kind,
        size: kind === 'flac' ? 30_000_000 : 10_000_000,
        expi: 600,
      },
    ],
  };
};

test('songUrl asks for the chosen level on the v1 endpoint', async () => {
  const { api, attempts } = scriptedClient(serveAt(['lossless']));
  const resolved = await api.songUrl(42, { level: 'lossless' });

  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].endpoint, '/api/song/enhance/player/url/v1');
  assert.equal(attempts[0].level, 'lossless');
  assert.equal(attempts[0].encodeType, 'flac', 'the level picks the encoding');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.level, 'lossless');
  assert.equal(resolved.downgraded, false);
});

test('songUrl walks down the ladder until something plays', async () => {
  // `sky` is refused per track in practice (code -110), and a track with no
  // master has no hires either, so the request has to keep stepping down.
  const { api, attempts } = scriptedClient(serveAt(['exhigh']));
  const resolved = await api.songUrl(42, { level: 'sky' });

  assert.deepEqual(
    attempts.map((attempt) => attempt.level),
    ['sky', 'jyeffect', 'hires', 'lossless', 'exhigh'],
  );
  assert.equal(resolved.ok, true);
  assert.equal(resolved.level, 'exhigh');
  assert.equal(resolved.requestedLevel, 'sky');
  assert.equal(resolved.downgraded, true, 'the shortfall is reported, not hidden');
  assert.equal(resolved.type, 'mp3');
});

test('songUrl reports a total refusal with a reason', async () => {
  const { api, attempts } = scriptedClient(() => ({ data: [{ code: 404 }] }));
  const resolved = await api.songUrl(42, { level: 'standard' });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, 404);
  assert.equal(resolved.requestedLevel, 'standard');
  assert.equal(attempts.length, 1, 'the cheapest level has nowhere to fall back to');
  assert.match(resolved.reason, /unavailable to this account at any quality/);
});

test('songUrl falls back to the default for an unknown level', async () => {
  const { api, attempts } = scriptedClient(serveAt(['exhigh']));
  const resolved = await api.songUrl(42, { level: 'ultra-mega' });

  assert.equal(resolved.requestedLevel, 'exhigh');
  assert.deepEqual(attempts.map((attempt) => attempt.level), ['exhigh'], 'not a ladder from nowhere');
});

test('every level id is distinct and ordered best-first', () => {
  const ids = LEVELS.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(LEVELS.every((entry) => typeof entry.label === 'string' && entry.label.length > 0));
  assert.ok(LEVELS.every((entry) => ['mp3', 'flac'].includes(entry.kind)));
  assert.equal(isLevel('exhigh'), true);
  assert.equal(isLevel('nonsense'), false);
  // The ladder only ever descends, so the best level must come first.
  assert.equal(ids[0], 'jymaster');
  assert.equal(ids.at(-1), 'standard');
});

// ------------------------------------------------------------- cookie jar
test('cookie jar merges, splits and clears cookies', () => {
  const jar = new CookieJar('os=pc; appver=2.10.6');
  assert.equal(jar.get('os'), 'pc');
  assert.equal(jar.has('MUSIC_U'), false);

  // One header carrying several cookies must yield all of them.
  jar.absorb(new Response('{}', { headers: { 'set-cookie': 'NMTID=abc; Path=/, MUSIC_U=session-value; Path=/' } }));
  assert.equal(jar.get('NMTID'), 'abc');
  assert.equal(jar.get('MUSIC_U'), 'session-value');
  assert.match(jar.header(), /MUSIC_U=session-value/);

  // An explicit cookie header replaces the whole session.
  jar.clear().load('os=pc; MUSIC_U=fresh');
  assert.equal(jar.get('MUSIC_U'), 'fresh');
  assert.equal(jar.get('NMTID'), undefined, 'clear() drops the previous session');

  assert.deepEqual(new CookieJar('a=1; b=2').toJSON(), { a: '1', b: '2' });
});

// ------------------------------------------------------------ player state
test('the player preserves metadata on an already-normalized track', () => {
  const player = new Player();
  const track = normalizeTrack(SEARCH_SHAPE);
  player.setQueue([track], { startIndex: 0 });
  const summary = player.summary();
  assert.deepEqual(summary.current.artists, ['马也_Crabbit', '另一人'], 'artists must survive setQueue');
  assert.equal(summary.current.album, '海屿你');
  // The panel reads the full snapshot (which carries artwork); the agent-facing
  // summary stays small on purpose.
  assert.match(player.snapshot().current.picUrl, /^http:\/\/p4\.music\.126\.net\/x==\/y\.jpg\?param=224y224$/);
  assert.equal(player.snapshot().current.picUrl, normalizeTrack(SEARCH_SHAPE).picUrl, 'the cover is not re-sized on the way through');

  // Appending the same normalised shape must also keep metadata.
  const second = normalizeTrack(PLAYLIST_SHAPE);
  player.append([second]);
  assert.deepEqual(player.queue[1].artists, ['陈奕迅']);
  assert.equal(player.queue[1].album, '孤勇者');
});

test('the player drops duplicates when appending and inserting', () => {
  const player = new Player();
  const a = normalizeTrack(SEARCH_SHAPE);
  const b = normalizeTrack(PLAYLIST_SHAPE);
  player.setQueue([a]);
  assert.equal(player.append([a, b]).added, 1, 'the existing track is not re-queued');
  player.jump(0);
  assert.equal(player.insertNext([a, b]).added, 0, 'both are already queued');
  assert.equal(player.queue.length, 2);
});

test('the player never lets the DJ change the transport state', () => {
  const player = new Player();
  player.setQueue([normalizeTrack(SEARCH_SHAPE)]);
  player.setPlaying(false);
  // What AiDj.topUp does.
  player.append([normalizeTrack(PLAYLIST_SHAPE)], { source: 'heuristic', play: false });
  assert.equal(player.playing, false, 'a top-up must not start playback');

  // But a queue refilled after the last track ended still resumes, because the
  // desired state was already "playing".
  const fresh = new Player();
  fresh.setPlaying(true);
  fresh.append([normalizeTrack(PLAYLIST_SHAPE)], { play: false });
  assert.equal(fresh.playing, true);
  assert.equal(fresh.index, 0, 'the refilled queue becomes current');
});

test('repeat modes and stale reports', () => {
  const player = new Player();
  const tracks = [1, 2, 3].map((id) => ({ id, name: `T${id}`, artists: ['A'], album: 'X', duration: 1000 }));
  player.setQueue(tracks, { startIndex: 0 });

  player.setMode('single');
  player.move(1);
  assert.equal(player.index, 0, 'single mode repeats the current track');

  player.setMode('list');
  player.move(-1);
  assert.equal(player.index, 2, 'previous from the first track wraps to the last');
  player.move(1);
  assert.equal(player.index, 0, 'next from the last track wraps to the first');

  // A report for a track the host has already left must not move the cursor.
  const hint = player.report({ trackId: 2, ended: true });
  assert.equal(hint.advanced, false);
  assert.equal(player.index, 0);

  const advanced = player.report({ ended: true, position: 500 });
  assert.equal(advanced.advanced, true);
  assert.equal(player.index, 1);
});

test('a failed track advances, and a seek is consumed once', () => {
  const player = new Player();
  player.setQueue([1, 2].map((id) => ({ id, name: `T${id}`, artists: ['A'], duration: 1000 })));
  player.seek(45_000);
  assert.equal(player.pendingSeek, 45_000);
  assert.equal(player.takeSeek(), 45_000);
  assert.equal(player.takeSeek(), null, 'the seek target is delivered once');

  const hint = player.report({ error: 'audio element error' });
  assert.equal(hint.failed, true);
  assert.equal(player.index, 1);
  // The per-track error is cleared by the move, but the failure itself is kept
  // so the agent can still explain why the track was skipped.
  assert.equal(player.reported.error, null);
  assert.match(player.lastError, /audio element error/);
  assert.match(player.summary().lastError, /audio element error/);

  player.clear();
  assert.equal(player.lastError, null, 'clearing the queue forgets the failure');
});

test('volume, mute and mode are clamped and ignore no-ops', () => {
  const player = new Player();
  player.setVolume(2);
  assert.equal(player.volume, 1, 'volume clamps to 1');
  player.setVolume(-5);
  assert.equal(player.volume, 0);
  const rev = player.rev;
  player.setVolume(0);
  assert.equal(player.rev, rev, 'a no-op must not bump the revision');
  player.setMode('nonsense');
  assert.equal(player.mode, 'list', 'an unknown mode is ignored');
  player.setMuted(true);
  assert.equal(player.muted, true);
});

test('clearing the queue resets the cursor and transport', () => {
  const player = new Player();
  player.setQueue([{ id: 1, name: 'A', artists: ['X'], duration: 1 }]);
  player.clear();
  const snapshot = player.snapshot();
  assert.equal(snapshot.queue.length, 0);
  assert.equal(snapshot.index, -1);
  assert.equal(snapshot.playing, false);
  assert.equal(snapshot.current, null);
  assert.equal(player.summary().current, null);
});
