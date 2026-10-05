/**
 * The source cache and the pool sampler.
 *
 * No network. Run with `node test/cache.test.mjs`.
 *
 * @module dsh-music/test/cache
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { Pacer, TtlCache, sampleInOrder } from '../lib/cache.js';

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms) => (now += ms) };
}

test('a value is loaded once while it lives, and again once it expires', async () => {
  const time = clock();
  const cache = new TtlCache({ now: time.now });
  let loads = 0;
  const load = async () => (loads += 1);

  assert.equal(await cache.get('daily', 100, load), 1);
  time.advance(99);
  assert.equal(await cache.get('daily', 100, load), 1, 'still alive');
  time.advance(1);
  assert.equal(await cache.get('daily', 100, load), 2, 'expired at its TTL, not after');
});

test('racing callers share one load', async () => {
  const cache = new TtlCache();
  let loads = 0;
  const load = () => new Promise((resolve) => setTimeout(() => resolve((loads += 1)), 5));
  const [first, second] = await Promise.all([cache.get('chart', 1_000, load), cache.get('chart', 1_000, load)]);
  assert.deepEqual([first, second, loads], [1, 1, 1]);
});

test('a failed load is forgotten, not cached for its whole TTL', async () => {
  const cache = new TtlCache();
  await assert.rejects(cache.get('fm', 60_000, async () => Promise.reject(new Error('offline'))), /offline/);
  assert.equal(cache.size, 0);
  assert.equal(await cache.get('fm', 60_000, async () => 'back'), 'back');
});

test('the oldest entries go first when the cache is full', () => {
  const cache = new TtlCache({ maxEntries: 2 });
  cache.set('a', 1, 1_000);
  cache.set('b', 2, 1_000);
  cache.set('a', 3, 1_000);
  cache.set('c', 4, 1_000);
  assert.equal(cache.peek('b'), undefined, 'rewriting `a` made `b` the oldest');
  assert.deepEqual([cache.peek('a'), cache.peek('c')], [3, 4]);
});

test('a sample keeps the source order and varies between draws', () => {
  const items = Array.from({ length: 100 }, (_, index) => index);
  const draws = Array.from({ length: 5 }, () => sampleInOrder(items, 8));
  for (const draw of draws) {
    assert.equal(draw.length, 8);
    assert.deepEqual(draw, [...draw].sort((a, b) => a - b), 'rank order survives the sampling');
    assert.equal(new Set(draw).size, 8);
  }
  assert.ok(new Set(draws.map(String)).size > 1, 'not the first eight every time');
  assert.ok(draws.flat().some((item) => item >= 8), 'the sample reaches past the head of the list');
});

test('a sample of a short list is the whole list, and of nothing is nothing', () => {
  assert.deepEqual(sampleInOrder([3, 1, 2], 5), [3, 1, 2]);
  assert.deepEqual(sampleInOrder([3, 1, 2], 0), []);
});

/**
 * A pacer over a fake clock, recording each start. A sleep wakes at its own
 * target time: concurrent sleeps overlap, as real timers do, rather than add up.
 */
function pacedClock({ minGapMs = 250, jitterMs = 500, random = () => 0.5 } = {}) {
  const time = clock(0);
  const starts = [];
  const pacer = new Pacer({
    minGapMs,
    jitterMs,
    random,
    now: time.now,
    sleep: async (ms) => {
      const target = time.now() + ms;
      await new Promise((resolve) => setImmediate(resolve));
      time.advance(Math.max(target - time.now(), 0));
    },
  });
  const request = (name) => pacer.run(async () => starts.push({ name, at: time.now() }));
  return { time, starts, request };
}

test('a burst of requests goes out spaced, not at once', async () => {
  const { starts, request } = pacedClock();
  await Promise.all(['simiSong', 'daily', 'chart', 'fm'].map(request));
  assert.deepEqual(starts.map((start) => start.at), [0, 500, 1000, 1500], 'each start waits min + jitter × random');
});

test('the gap is random within its span, so the rhythm is not machine-regular', async () => {
  const draws = [0, 0.9, 0.2];
  const { starts, request } = pacedClock({ random: () => draws.shift() });
  await Promise.all(['a', 'b', 'c', 'd'].map(request));
  const gaps = starts.slice(1).map((start, index) => start.at - starts[index].at);
  assert.deepEqual(gaps, [250, 700, 350]);
});

test('an idle pacer starts the next request at once', async () => {
  const { time, starts, request } = pacedClock();
  await request('first');
  time.advance(10_000);
  await request('later');
  assert.equal(starts[1].at, 10_000, 'no wait after a quiet spell');
});

test('pacing spaces the starts only; a slow request does not hold the next one back', async () => {
  const pacer = new Pacer({ minGapMs: 0, jitterMs: 0 });
  let release;
  const slow = pacer.run(() => new Promise((resolve) => (release = resolve)));
  assert.equal(await pacer.run(async () => 'fast'), 'fast');
  release('slow');
  assert.equal(await slow, 'slow');
});
