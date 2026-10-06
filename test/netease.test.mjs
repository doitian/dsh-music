/**
 * Pure unit tests: track normalisation, the cookie jar, the like endpoints,
 * player state, and the taste levels the DJ reads.
 *
 * No network. Run with `node test/netease.test.mjs`.
 *
 * @module dsh-music/test/netease
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CookieJar, LEVELS, Netease, cleanText, isLevel, normalizeTrack, parseSongWiki, resizeImage } from '../lib/netease.js';
import { SessionStore, TASTE_LEVELS } from '../lib/session.js';
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

// ------------------------------------------------------------- song details

/** A music-wiki answer in the shape NetEase sends: facts are creatives of the basic block. */
function wikiAnswer() {
  const titled = (title) => ({ uiElement: { mainTitle: { title } } });
  const linked = (text) => ({ uiElement: { textLinks: [{ text }] } });
  return {
    code: 200,
    data: {
      blocks: [
        { code: 'SONG_PLAY_ABOUT_MUSIC_MEMORY', creatives: [{ creativeType: 'songTag', resources: [titled('not this')] }] },
        {
          code: 'SONG_PLAY_ABOUT_SONG_BASIC',
          creatives: [
            { creativeType: 'songTag', resources: [titled('原声带-动画片原声'), titled('流行-华语流行')] },
            { creativeType: 'songBizTag', resources: [titled('热血励志'), titled('自信')] },
            { creativeType: 'language', ...linked('国语') },
            { creativeType: 'bpm', ...linked('64') },
            { creativeType: 'songAward', resources: [titled('第30届东方风云榜')] },
            { creativeType: 'entertainment', resources: [titled('动画《双城之战》主题曲')] },
            { creativeType: 'sheet', resources: [{ uiElement: {} }] },
            {
              creativeType: 'songComment',
              resources: [{ uiElement: { mainTitle: { title: '乐评来自 神经蛙' }, descriptions: [{ description: '一首主题曲。[3]' }] } }],
            },
          ],
        },
      ],
    },
  };
}

test('the music wiki yields the song facts, from its basic block only', () => {
  assert.deepEqual(parseSongWiki(wikiAnswer()), {
    genres: ['原声带-动画片原声', '流行-华语流行'],
    tags: ['热血励志', '自信'],
    language: '国语',
    bpm: 64,
    awards: ['第30届东方风云榜'],
    featuredIn: ['动画《双城之战》主题曲'],
    review: { text: '一首主题曲。', by: '神经蛙' },
  });
  assert.deepEqual(parseSongWiki(null).genres, [], 'no wiki is no facts, not a failure');
});

test('encyclopedia prose loses its citation marks and ragged gaps', () => {
  assert.equal(cleanText('出生于台湾 [38]。获奖[1-2]\n\n\n\n其后'), '出生于台湾。获奖\n\n其后');
  assert.equal(cleanText(undefined), '');
});

test('songInfo keeps the song when its album, wiki or artist cannot be read', async () => {
  const api = new Netease();
  api.call = async (endpoint) => {
    if (endpoint === '/api/song/detail') {
      return {
        songs: [
          {
            id: 7,
            name: 'Song',
            alias: ['Alias'],
            album: { id: 70, name: 'Album', company: 'Label', publishTime: 1 },
            artists: [{ id: 700, name: 'Singer' }, { id: 701, name: 'Other' }],
          },
        ],
      };
    }
    if (endpoint === '/api/artist/introduction') return { briefDesc: 'Born somewhere. [2]' };
    throw new Error('offline');
  };
  const info = await api.songInfo(7);
  assert.equal(info.album.name, 'Album', 'the song detail names the album when its own page fails');
  assert.equal(info.album.company, 'Label');
  assert.deepEqual(info.alias, ['Alias']);
  assert.deepEqual(info.artists.map((artist) => artist.intro), ['Born somewhere.', 'Born somewhere.']);
  assert.deepEqual(info.genres, []);

  api.call = async () => ({ code: 200, songs: [] });
  await assert.rejects(api.songInfo(8), /not found/);
});

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

// ------------------------------------------------------------- audio fetch

/** A loopback "CDN" that answers slowly, on a schedule the caller controls. */
async function slowServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: (route) => `http://127.0.0.1:${server.address().port}${route}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('fetchAudio bounds the headers only, never the streaming body', async () => {
  // Headers arrive at once; the body then trickles for ~500 ms — far past the
  // 100 ms deadline. This is the mid-song skip regression: a whole-request
  // timeout cut every stream still open when it fired.
  const app = await slowServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    // writeHead only queues the headers, so without this they ride the first
    // trickle tick — a 50 ms timer racing the 100 ms deadline below. A loaded
    // runner delayed that tick past the deadline and aborted a request whose
    // headers were never the problem (the publish job failed on exactly that).
    res.flushHeaders();
    let chunk = 0;
    const timer = setInterval(() => {
      chunk += 1;
      if (chunk >= 10) {
        clearInterval(timer);
        res.end(`chunk-${chunk}`);
      } else {
        res.write(`chunk-${chunk};`);
      }
    }, 50);
  });
  try {
    const api = new Netease();
    const response = await api.fetchAudio(app.url('/track'), { headerTimeoutMs: 100 });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body, 'chunk-1;chunk-2;chunk-3;chunk-4;chunk-5;chunk-6;chunk-7;chunk-8;chunk-9;chunk-10');
  } finally {
    await app.close();
  }
});

test('fetchAudio still aborts when the headers never arrive', async () => {
  const app = await slowServer(() => {
    // Never answer: the deadline must still fire for a stuck connect.
  });
  try {
    const api = new Netease();
    await assert.rejects(api.fetchAudio(app.url('/track'), { headerTimeoutMs: 100 }), { name: 'AbortError' });
  } finally {
    await app.close();
  }
});

// -------------------------------------------------------------- like endpoints

/** A client whose like endpoints answer from a scripted table. */
function likeClient(handler, { authenticated = true } = {}) {
  const api = new Netease({ cookie: authenticated ? 'MUSIC_U=fake' : 'os=pc' });
  const calls = [];
  api.call = async (endpoint, options = {}) => {
    calls.push({ endpoint, method: options.method, query: options.query });
    return handler(endpoint, options);
  };
  return { api, calls };
}

test('likeSong asks for the direction it was given, not a toggle', async () => {
  const { api, calls } = likeClient(() => ({ playlistId: 12434976821, code: 200 }));

  const liked = await api.likeSong(42, true);
  assert.equal(calls[0].endpoint, '/api/song/like');
  assert.equal(calls[0].method, 'POST', 'a write, not a read');
  assert.deepEqual(calls[0].query, { trackId: 42, like: true });
  assert.deepEqual(liked, { ok: true, id: 42, liked: true, playlistId: 12434976821 });

  const removed = await api.likeSong(42, false);
  assert.deepEqual(calls[1].query, { trackId: 42, like: false }, 'removing the like is its own request');
  assert.equal(removed.liked, false);
  assert.equal(removed.ok, true);
});

test('likeSong reports a refusal with NetEase\'s own reason', async () => {
  // A delisted track answers 400 with a message rather than a code the caller
  // can act on, and an anonymous session answers 301.
  const { api } = likeClient(() => ({ code: 400, message: '歌曲已经下架了' }));
  const refused = await api.likeSong(42, true);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 400);
  assert.match(refused.reason, /下架/);

  const anonymous = await likeClient(() => ({ code: 301, message: '系统错误' }), { authenticated: false }).api.likeSong(42, true);
  assert.equal(anonymous.ok, false);
  assert.equal(anonymous.code, 301);
});

test('likeSong never asks about an id that is not one', async () => {
  const { api, calls } = likeClient(() => ({ code: 200 }));
  const refused = await api.likeSong('not-a-track', true);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'BAD_ID');
  assert.deepEqual(calls, []);
});

test('likedIds reads the liked subset of a bracketed id list', async () => {
  const { api, calls } = likeClient(() => ({ ids: [2], code: 200 }));
  const result = await api.likedIds([1, 2, 2, 'nonsense']);

  assert.equal(calls[0].endpoint, '/api/song/like/check');
  assert.equal(calls[0].method, undefined, 'a plain read');
  assert.equal(calls[0].query.trackIds, '[1,2]', 'deduplicated, and only real ids');
  assert.deepEqual(result, { ok: true, ids: [2] });
});

test('likedIds treats a refusal as a refusal, not as nothing liked', async () => {
  const { api } = likeClient(() => ({ code: 301, message: '系统错误' }));
  const refused = await api.likedIds([7]);
  assert.equal(refused.ok, false, 'the caller must be able to tell this from "not liked"');
  assert.equal(refused.code, 301);
  assert.deepEqual(refused.ids, []);
});

test('likedIds does not spend a request on an empty question', async () => {
  const { api, calls } = likeClient(() => ({ ids: [], code: 200 }));
  assert.deepEqual(await api.likedIds([]), { ok: true, ids: [] });
  assert.deepEqual(calls, [], 'NetEase answers an empty batch with code 400 anyway');
});

test('likedPlaylistIds reads the whole like list in one pass', async () => {
  // The likes are a playlist (`specialType: 5`) whose `trackIds` come back
  // complete regardless of `n`, so one read reconciles a mirror of any size.
  const { api, calls } = likeClient((endpoint) =>
    endpoint === '/api/user/playlist'
      ? {
          playlist: [
            { id: 8, name: 'Collected', specialType: 0, trackCount: 12 },
            { id: 9, name: '我喜欢的音乐', specialType: 5, trackCount: 3 },
          ],
        }
      : { playlist: { trackIds: [{ id: 3 }, { id: 1 }, { id: 3 }] } },
  );

  assert.deepEqual(await api.likedPlaylistIds(7), [3, 1, 3]);
  assert.deepEqual(calls[0], { endpoint: '/api/user/playlist', method: undefined, query: { uid: 7, offset: 0, limit: 1000 } });
  assert.deepEqual(calls[1], { endpoint: '/api/v6/playlist/detail', method: undefined, query: { id: 9, n: 1 } });
});

test('likedPlaylistIds answers null rather than an empty account', async () => {
  // `null` and `[]` mean different things: the caller must not wipe a mirror
  // because the account could not be read.
  const anonymous = likeClient(() => ({}));
  assert.equal(await anonymous.api.likedPlaylistIds(), null);
  assert.deepEqual(anonymous.calls, [], 'no account, no request');

  const noLiked = likeClient(() => ({ playlist: [{ id: 8, name: 'Collected', specialType: 0 }] }));
  assert.equal(await noLiked.api.likedPlaylistIds(7), null);
});

// ---------------------------------------------------------------- taste levels

/** A store over a throwaway file, so `touch()` has somewhere to write. */
function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-music-taste-'));
  const store = new SessionStore({ file: path.join(dir, 'session.json') });
  store.dir = dir;
  store.dispose = () => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return store;
}

test('a track holds exactly one taste level', () => {
  assert.deepEqual(TASTE_LEVELS, ['liked', 'none', 'disliked']);
  const store = tempStore();
  try {
    assert.equal(store.taste(42), 'none', 'unrated to begin with');

    store.setTaste(42, 'liked');
    assert.equal(store.taste(42), 'liked');
    assert.deepEqual(store.feedback.likes, [42]);
    store.setTaste(42, 'liked');
    assert.deepEqual(store.feedback.likes, [42], 'setting the same level twice is not a duplicate');

    // A like and a dislike are the same three levels, not two flags.
    store.setTaste(42, 'disliked');
    assert.equal(store.taste(42), 'disliked');
    assert.deepEqual(store.feedback.likes, [], 'the like is gone');
    assert.deepEqual(store.feedback.dislikes, [42]);

    store.setTaste(42, 'none');
    assert.equal(store.taste(42), 'none');
    assert.deepEqual(store.feedback.dislikes, []);
  } finally {
    store.dispose();
  }
});

test('an unknown level or track id changes nothing', () => {
  const store = tempStore();
  try {
    store.setTaste(1, 'sideways');
    store.setTaste('not-a-track', 'liked');
    assert.deepEqual(store.feedback, { likes: [], dislikes: [], skips: [] });
  } finally {
    store.dispose();
  }
});

test('the liked mirror can be reconciled with the account', () => {
  const store = tempStore();
  try {
    store.setTaste(1, 'liked');
    store.setTaste(2, 'disliked');

    store.setLikedIds([5, 5, 'nonsense', 6]);
    assert.deepEqual(store.feedback.likes, [5, 6], 'deduplicated, and only real ids');
    assert.equal(store.taste(1), 'none', 'a like the account does not have is dropped');
    assert.deepEqual(store.feedback.dislikes, [2], 'a dislike is local, so it survives');
  } finally {
    store.dispose();
  }
});

test('recordFeedback is the toggle spelling of the same levels', () => {
  const store = tempStore();
  try {
    store.recordFeedback('likes', 7);
    assert.deepEqual(store.feedback.likes, [7]);
    store.recordFeedback('likes', 7);
    assert.deepEqual(store.feedback.likes, [], 'the second click takes the like back');

    store.recordFeedback('dislikes', 7);
    assert.deepEqual(store.feedback.dislikes, [7]);
    store.recordFeedback('likes', 7);
    assert.equal(store.taste(7), 'liked', 'liking a disliked track replaces the level');
    assert.deepEqual(store.feedback.dislikes, []);
  } finally {
    store.dispose();
  }
});

test('skips stay counters rather than membership', () => {
  const store = tempStore();
  try {
    store.recordFeedback('skips', 3);
    store.recordFeedback('skips', 3);
    assert.deepEqual(store.feedback.skips, [3, 3], 'each skip is an occurrence');
    assert.equal(store.taste(3), 'none', 'a skip is not a taste level');
    store.recordFeedback('shrug', 3);
    assert.deepEqual(store.feedback.skips, [3, 3], 'an unknown kind is ignored');
  } finally {
    store.dispose();
  }
});

test('a skip marks the play it cut short, which then stops counting as affinity', () => {
  const store = tempStore();
  try {
    store.recordPlay({ id: 1, name: 'kept', artists: ['Loved'] });
    store.recordPlay({ id: 2, name: 'cut', artists: ['Shunned'] });
    store.recordPlay({ id: 3, name: 'cut again', artists: ['Shunned'] });
    store.recordSkip(2);
    store.recordSkip(3);
    store.recordFeedback('skips', 3);

    assert.deepEqual(store.feedback.skips, [3, 3, 2]);
    assert.deepEqual(store.topArtists(), ['Loved'], 'a skipped play is not a play');

    const digest = store.tasteDigest();
    assert.deepEqual([...digest.skipCounts], [[3, 2], [2, 1]]);
    assert.deepEqual([...digest.skippedArtists], [['Shunned', 2]]);
    assert.deepEqual(digest.skipped, ['cut again — Shunned', 'cut — Shunned'], 'one line per track, newest first');
  } finally {
    store.dispose();
  }
});

// ------------------------------------------------------------ player state
test('a manual next early in a track is a skip, and nothing else is', () => {
  const player = new Player();
  const skipped = [];
  player.onSkip = (track) => skipped.push(track.id);
  const tracks = [1, 2, 3, 4, 5, 6].map((id) => ({ id, name: `T${id}`, artists: ['A'], duration: 240_000 }));
  player.setQueue(tracks, { startIndex: 0 });
  const heard = (position) => player.report({ trackId: player.current().id, position, duration: 240_000 });

  heard(10_000);
  player.move(1);
  assert.deepEqual(skipped, [1], 'ten seconds in is a skip');

  heard(45_000);
  player.move(1);
  assert.deepEqual(skipped, [1, 2], 'a quarter of a four-minute track is a minute, so 45 s still is');

  heard(90_000);
  player.move(1);
  assert.deepEqual(skipped, [1, 2], 'past the window, moving on is not a rejection');

  player.move(1);
  assert.deepEqual(skipped, [1, 2], 'a track that never reported a position was not heard');

  heard(5_000);
  player.move(-1);
  assert.deepEqual(skipped, [1, 2], 'going back is not a skip');

  heard(5_000);
  player.report({ trackId: player.current().id, ended: true });
  assert.deepEqual(skipped, [1, 2], 'an automatic advance is not a skip');

  player.setMode('single');
  heard(5_000);
  player.move(1);
  assert.deepEqual(skipped, [1, 2], 'single mode stays on the track, so nothing was left');
});

test('a track is heard through once past the skip window, or at its end, and only once', () => {
  const player = new Player();
  const heard = [];
  player.onHeard = (track) => heard.push(track.id);
  const tracks = [1, 2, 3, 4].map((id) => ({ id, name: `T${id}`, artists: ['A'], duration: 240_000 }));
  player.setQueue(tracks, { startIndex: 0 });
  const at = (position, extra = {}) => player.report({ trackId: player.current().id, position, duration: 240_000, ...extra });

  at(30_000);
  assert.deepEqual(heard, [], 'inside the window, a minute for a four-minute track');
  at(61_000);
  at(120_000);
  assert.deepEqual(heard, [1], 'past it, once');

  player.move(1);
  at(5_000, { ended: true });
  assert.deepEqual(heard, [1, 2], 'a track that ends was heard, however short its report');

  at(10_000);
  player.move(1);
  assert.deepEqual(heard, [1, 2], 'a skip is not heard');

  at(0, { error: 'refused' });
  assert.deepEqual(heard, [1, 2], 'nor is a failure');
});

test('each play opens once it is really playing, and closes however it ends', () => {
  const player = new Player();
  const events = [];
  player.onStart = (track) => events.push(['start', track.id]);
  player.onFinish = (track, play) => events.push(['finish', track.id, Math.round(play.seconds), play.ended, play.heard]);
  const tracks = [1, 2, 3, 4].map((id) => ({ id, name: `T${id}`, artists: ['A'], duration: 200_000 }));
  player.setQueue(tracks, { startIndex: 0 });
  const at = (position, extra = {}) => player.report({ trackId: player.current().id, position, duration: 200_000, ...extra });

  at(0);
  assert.deepEqual(events, [], 'a track that has not played a moment has not started');
  at(1_000);
  at(80_000);
  at(120_000, { ended: true });
  assert.deepEqual(events, [['start', 1], ['finish', 1, 200, true, true]], 'played out: ended, its full length');

  at(10_000);
  player.move(1);
  assert.deepEqual(events.slice(2), [['start', 2], ['finish', 2, 10, false, false]], 'skipped: closed, not heard');

  at(90_000);
  player.jump(0);
  assert.deepEqual(events.slice(4), [['start', 3], ['finish', 3, 90, false, true]], 'left after the window: heard, interrupted');

  player.jump(1);
  assert.deepEqual(events.slice(6), [], 'a track that never started is never closed');

  player.setMode('single');
  at(5_000);
  at(60_000, { ended: true });
  at(3_000);
  assert.deepEqual(
    events.slice(6),
    [['start', 2], ['finish', 2, 200, true, true], ['start', 2]],
    'a repeat is a play of its own',
  );

  player.clear();
  assert.deepEqual(events.at(-1), ['finish', 2, 3, false, false], 'clearing closes the play too');
});

test('the player marks who queued a track', () => {
  const player = new Player();
  player.setQueue([{ id: 1, name: 'a', artists: ['A'] }], { queuedBy: 'dj' });
  player.append([{ id: 2, name: 'b', artists: ['B'] }], { queuedBy: 'dj' });
  player.append([{ id: 3, name: 'c', artists: ['C'] }]);
  assert.deepEqual(player.queue.map((track) => track.queuedBy), ['dj', 'dj', undefined]);
});

test('a tentative play counts as played but not as taste, until it is confirmed', () => {
  const store = tempStore();
  try {
    store.recordPlay({ id: 1, name: 'picked', artists: ['DJ Pick'] }, { tentative: true });
    store.recordPlay({ id: 2, name: 'chosen', artists: ['Chosen'] });
    assert.deepEqual(store.recentIds(), [2, 1], 'both still avoid a repeat');
    assert.deepEqual(store.topArtists(), ['Chosen']);
    store.confirmPlay(1);
    assert.deepEqual(store.topArtists(), ['Chosen', 'DJ Pick']);
  } finally {
    store.dispose();
  }
});

test('a boost lasts its span, replaces the track\'s previous one, and can be cleared', () => {
  const store = tempStore();
  try {
    const track = { id: 7, name: 'Seven', artists: ['S'] };
    const boost = store.setBoost(track, 'more');
    assert.equal(boost.direction, 'more');
    assert.ok(Math.abs(boost.until - Date.now() - 60 * 60_000) < 1_000, 'an hour by default');
    assert.equal(store.boostOf(7), 'more');

    store.setBoost(track, 'less', 30);
    assert.equal(store.activeBoosts().length, 1, 'one boost per track');
    assert.equal(store.boostOf(7), 'less');
    assert.equal(store.boostOf(7, Date.now() + 31 * 60_000), null, 'and it expires on its own');

    assert.equal(store.setBoost(track, 'sideways'), null);
    assert.equal(store.boostOf(7), null, 'anything but more or less clears it');

    assert.ok(store.setBoost(track, 'more', 1).until - Date.now() >= 5 * 60_000 - 1_000, 'at least five minutes');
    assert.ok(store.setBoost(track, 'more', 10_000).until - Date.now() <= 12 * 60 * 60_000, 'at most twelve hours');
  } finally {
    store.dispose();
  }
});

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

test('removing a queue position reports what left', () => {
  // The report is the point: the caller cannot read the track off the queue
  // afterwards, because the row whose index it asked about is the one that is
  // gone — and removing a track is a judgement about the track.
  const player = new Player();
  player.setQueue([1, 2, 3].map((id) => ({ id, name: `T${id}`, artists: ['A'], duration: 1000 })));
  player.jump(1);

  const middle = player.removeAt(1);
  assert.equal(middle.track.id, 2);
  assert.equal(middle.wasCurrent, true, 'it was the playing one');
  assert.deepEqual(middle.snapshot.queue.map((track) => track.id), [1, 3]);
  assert.equal(middle.snapshot.index, 1, 'and the next track took its place');

  const other = player.removeAt(1);
  assert.equal(other.track.id, 3);
  assert.equal(other.wasCurrent, true, 'the cursor is on the same index again');

  const queued = player.removeAt(0);
  assert.equal(queued.wasCurrent, true);
  assert.equal(queued.snapshot.queue.length, 0);

  // An index that is not there removes nothing and reports nothing, so a caller
  // cannot mistake it for a track it just rejected.
  const nowhere = player.removeAt(5);
  assert.equal(nowhere.track, null);
  assert.equal(nowhere.wasCurrent, false);
  assert.equal(nowhere.snapshot.queue.length, 0);
});

test('a refused start is kept until audio plays', () => {
  const player = new Player();
  player.setQueue([{ id: 1, name: 'T1', artists: ['A'], duration: 1000 }]);
  assert.equal(player.reported.blocked, false);

  player.report({ trackId: 1, playing: false, blocked: true });
  player.report({ trackId: 1, position: 0, playing: false });
  assert.equal(player.reported.blocked, true, 'a report that does not say keeps it');

  player.report({ trackId: 1, position: 10, playing: true });
  assert.equal(player.reported.blocked, false, 'audio that plays ends it');
});

test('clearing around the playing track leaves its play open', () => {
  const player = new Player();
  const finished = [];
  player.onFinish = (track) => finished.push(track.id);
  player.setQueue([1, 2, 3].map((id) => ({ id, name: `T${id}`, artists: ['A'], duration: 1000 })));
  player.jump(1);
  player.report({ trackId: 2, position: 1, playing: true });
  finished.length = 0;

  player.clearKeepingCurrent();
  assert.deepEqual(player.queue.map((track) => track.id), [2]);
  assert.equal(player.index, 0);
  assert.deepEqual(finished, [], 'the playing track is not ended, so it is not reported twice');

  player.clear();
  player.clearKeepingCurrent();
  assert.equal(player.queue.length, 0, 'with nothing playing there is nothing to keep');
});

test('a restored queue is paused at its cursor, and an empty one restores nothing', () => {
  const player = new Player();
  player.restore({ tracks: [{ id: 1 }, { id: 2 }, null], index: 7 });
  assert.deepEqual(player.queue.map((track) => track.id), [1, 2]);
  assert.equal(player.index, 1, 'a cursor past the end is clamped');
  assert.equal(player.playing, false);

  const fresh = new Player();
  fresh.restore({ tracks: [], index: 0 });
  assert.equal(fresh.index, -1);
});

test('the saved queue drops its oldest played tracks first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-music-queue-'));
  try {
    const store = new SessionStore({ file: path.join(dir, 'session.json') });
    const tracks = Array.from({ length: 600 }, (_, index) => ({ id: index + 1 }));
    store.saveQueue(tracks, 550);
    assert.equal(store.savedQueue.tracks.length, 500);
    assert.equal(store.savedQueue.tracks[store.savedQueue.index].id, 551, 'the cursor still names the same track');
    assert.equal(store.savedQueue.tracks.at(-1).id, 600, 'nothing upcoming is lost');

    store.saveQueue(tracks, 10);
    assert.equal(store.savedQueue.tracks[0].id, 11, 'every played track goes before an upcoming one');
    assert.equal(store.savedQueue.index, 0);
    assert.equal(store.savedQueue.tracks.at(-1).id, 510, 'then the furthest upcoming');
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removing the playing track moves on, and past the end wraps to the start', () => {
  const player = new Player();
  player.setQueue([1, 2, 3, 4].map((id) => ({ id, name: `T${id}`, artists: ['A'], duration: 1000 })));
  player.jump(1);
  player.remove(1);
  assert.equal(player.current().id, 3, 'the next track takes its place');

  player.jump(2);
  player.remove(2);
  assert.equal(player.current().id, 1, 'the last one wraps to the start, as next does, rather than going back');
  assert.equal(player.pendingSeek, 0, 'and starts from the top');
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
