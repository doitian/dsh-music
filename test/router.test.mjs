import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { MusicRouter } from '../lib/router.js';
import { Player } from '../lib/state.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const tracks = [1, 2, 3].map((id) => ({ id, name: `Track ${id}`, duration: 180_000 }));
const audio = (id, level) => ({ ok: true, url: `https://cdn.test/${id}/${level}`, level, expiresInMs: 20 * 60_000 });

function harness(t, api = {}) {
  const calls = [];
  const player = new Player();
  const store = {
    settings: {},
    updateSettings(settings) { Object.assign(this.settings, settings); },
    taste: () => 'none',
    boostOf: () => null,
    activeBoosts: () => [],
  };
  const router = new MusicRouter({
    base: '/music', player, store, dj: {},
    api: {
      songUrl: async (id, { level }) => {
        calls.push([id, level]);
        return audio(id, level);
      },
      ...api,
    },
    likes: { ensure: async () => {}, isLiked: () => false },
  });
  t.after(() => router.dispose());
  const request = async (route, body) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = body === undefined ? 'GET' : 'POST';
    req.url = `/music/api${route}`;
    const res = {
      writeHead(status) { this.status = status; },
      end(data) { this.body = JSON.parse(data.toString()); },
    };
    await router.handleApi(req, res, req.url);
    return res;
  };
  return { router, player, store, calls, request };
}

test('lyrics share an in-flight host request and expire after 24 hours', async (t) => {
  let now = 0;
  let loads = 0;
  let finish;
  const { router, request } = harness(t, {
    lyric: () => {
      loads += 1;
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  router.lyricCache.now = () => now;
  const first = request('/lyric/1');
  const second = request('/lyric/1');
  await settle();
  assert.equal(loads, 1);
  const data = { lrc: '[00:01.00]Hello', translated: '', noLyric: false };
  finish(data);
  assert.deepEqual((await first).body, data);
  assert.deepEqual((await second).body, data);
  now = 24 * 60 * 60_000 - 1;
  assert.deepEqual((await request('/lyric/1')).body, data);
  assert.equal(loads, 1);
  now += 1;
  const expired = request('/lyric/1');
  await settle();
  assert.equal(loads, 2);
  finish(data);
  await expired;
});

test('failed lyric loads are retried, and instrumental answers are cached', async (t) => {
  let loads = 0;
  const { request } = harness(t, {
    lyric: async () => {
      loads += 1;
      if (loads === 1) throw new Error('offline');
      return { lrc: '', noLyric: true };
    },
  });
  await assert.rejects(request('/lyric/1'), /offline/);
  assert.equal((await request('/lyric/1')).body.noLyric, true);
  await request('/lyric/1');
  assert.equal(loads, 2);
  for (const id of ['abc', '0', '-1', '1.5']) assert.equal((await request(`/lyric/${id}`)).status, 400);
});

test('starting playback warms only the next audio URL, without changing diagnostics', async (t) => {
  const { router, player, calls } = harness(t);
  player.setQueue(tracks, { play: false });
  await settle();
  assert.deepEqual(calls, []);
  player.setPlaying(true);
  await settle();
  assert.deepEqual(calls, [[2, 'exhigh']]);
  assert.equal(router.lastAudio, null);
  assert.equal((await router.resolveAudio(2)).url, audio(2, 'exhigh').url);
  player.report({ trackId: 1, position: 1_000, playing: true });
  player.setVolume(0.5);
  await settle();
  assert.equal(calls.length, 1);
  player.move(1);
  await settle();
  assert.deepEqual(calls, [[2, 'exhigh'], [3, 'exhigh']]);
  assert.equal((await router.resolveAudio(2)).url, audio(2, 'exhigh').url);
  assert.equal(calls.length, 2);
});

test('audio prefetch follows queue changes, quality changes and list wrapping', async (t) => {
  const { player, calls, request } = harness(t);
  player.setQueue(tracks);
  await settle();
  player.insertNext([{ id: 4, name: 'Inserted' }]);
  await settle();
  assert.deepEqual(calls, [[2, 'exhigh'], [4, 'exhigh']]);
  await request('/quality', { level: 'hires' });
  await settle();
  assert.deepEqual(calls.at(-1), [4, 'hires']);
  player.jump(player.queue.length - 1);
  await settle();
  assert.deepEqual(calls.at(-1), [1, 'hires']);
});

test('shuffle, repeat-one and a one-track queue do not resolve speculative audio', async (t) => {
  const { player, calls } = harness(t);
  player.setMode('shuffle');
  player.setQueue(tracks);
  await settle();
  player.setMode('single');
  await settle();
  player.setQueue([tracks[0]]);
  player.setMode('list');
  await settle();
  assert.deepEqual(calls, []);
});

test('playback shares a pending pre-resolution and respects URL expiry and level keys', async (t) => {
  let finish;
  const calls = [];
  const { router, player } = harness(t, {
    songUrl: (id, { level }) => {
      calls.push([id, level]);
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  player.setQueue(tracks);
  await settle();
  const foreground = router.resolveAudio(2);
  assert.equal(calls.length, 1);
  finish({ ...audio(2, 'exhigh'), expiresInMs: 60_000 });
  await foreground;
  assert.ok(router.urlCache.get('2:exhigh').expiresAt <= Date.now() + 60_000);
  router.urlCache.get('2:exhigh').expiresAt = Date.now() - 1;
  const expired = router.resolveAudio(2);
  assert.equal(calls.length, 2);
  finish(audio(2, 'exhigh'));
  await expired;
  assert.ok(router.urlCache.get('2:exhigh').expiresAt <= Date.now() + 15 * 60_000);
  const otherLevel = router.resolveAudio(2, 'standard');
  assert.deepEqual(calls.at(-1), [2, 'standard']);
  finish(audio(2, 'standard'));
  await otherLevel;
  assert.equal(router.urlCache.size, 2);
});

test('prefetch failures and entitlement refusals neither poll repeatedly nor poison playback', async (t) => {
  for (const fail of [() => { throw new Error('offline'); }, () => ({ ok: false, reason: 'vip' })]) {
    let loads = 0;
    const { router, player } = harness(t, {
      songUrl: async (id, { level }) => {
        loads += 1;
        return loads === 1 ? fail() : audio(id, level);
      },
    });
    player.setQueue(tracks);
    await settle();
    player.report({ trackId: 1, position: 1_000, playing: true });
    await settle();
    assert.equal(loads, 1);
    assert.equal(router.lastAudio, null);
    assert.equal(router.urlCache.size, 0);
    assert.equal((await router.resolveAudio(2)).ok, true);
    assert.equal(loads, 2);
  }
});
