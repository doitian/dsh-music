/**
 * Like-state tests: the cache in front of the account's likes.
 *
 * No network. The API client is a stub, so these cover the properties that are
 * easy to get wrong and expensive to debug in the browser: what counts as an
 * answer, what a refusal must not be cached as, and when a write reaches the
 * account.
 *
 * Run with `node test/likes.test.mjs`.
 *
 * @module dsh-music/test/likes
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { LikeState } from '../lib/likes.js';

/**
 * A stand-in for `Netease`: records what was asked and answers from `liked`.
 * `fail` makes every call refuse with that business code (301 anonymous, 400
 * delisted), which is how the live API reports them.
 */
function fakeApi({ authenticated = true, liked = [], fail = null } = {}) {
  const calls = { like: [], check: [] };
  return {
    calls,
    authenticated,
    async likedIds(ids) {
      calls.check.push([...ids]);
      if (fail) return { ok: false, ids: [], code: fail, reason: `refused with ${fail}` };
      return { ok: true, ids: ids.filter((id) => liked.includes(id)) };
    },
    async likeSong(id, like) {
      calls.like.push({ id, like });
      if (fail) return { ok: false, id, code: fail, reason: `refused with ${fail}` };
      return { ok: true, id, liked: like };
    },
  };
}

test('an unknown track is not a track that is not liked', async () => {
  const api = fakeApi({ liked: [7] });
  const likes = new LikeState({ api });

  assert.equal(likes.isLiked(7), false, 'no answer yet');
  assert.equal(likes.known(7), false, 'and the cache says so');

  await likes.ensure([7, 8]);
  assert.equal(likes.isLiked(7), true);
  assert.equal(likes.isLiked(8), false);
  assert.equal(likes.known(8), true, 'a "not liked" answer is still an answer');
});

test('ensure asks once and then answers from the cache', async () => {
  const api = fakeApi();
  const likes = new LikeState({ api });

  await likes.ensure([1, 2, 3]);
  assert.deepEqual(api.calls.check, [[1, 2, 3]], 'one batched question');

  await likes.ensure([1, 2, 3, 1]);
  assert.equal(api.calls.check.length, 1, 'a repeated poll must not re-ask');

  await likes.ensure([1, 4]);
  assert.deepEqual(api.calls.check[1], [4], 'only the tracks with no answer cost a call');
});

test('a stale answer is asked again, a fresh one is not', async () => {
  const api = fakeApi({ liked: [5] });
  const likes = new LikeState({ api, ttlMs: 0 });
  await likes.ensure([5]);
  await likes.ensure([5]);
  assert.equal(api.calls.check.length, 2, 'a zero-ttl answer expires immediately');
  assert.equal(likes.isLiked(5), true, 'and still answers while it refreshes');
});

test('checks are batched so a long queue is not one oversized URL', async () => {
  const api = fakeApi();
  const likes = new LikeState({ api, batchSize: 2 });
  await likes.ensure([1, 2, 3, 4, 5]);
  assert.deepEqual(api.calls.check, [[1, 2], [3, 4], [5]]);
});

test('a refused check caches nothing and waits before trying again', async () => {
  // An anonymous session answers 301 for every id. Caching that as "not liked"
  // would leave every heart empty for the rest of the session, even after a
  // sign-in.
  const api = fakeApi({ fail: 301 });
  const likes = new LikeState({ api });

  await likes.ensure([11]);
  assert.equal(likes.known(11), false, 'a refusal is not an answer');
  assert.match(likes.status().error, /301/);

  await likes.ensure([11]);
  assert.equal(api.calls.check.length, 1, 'the cool-off holds the retry back');

  likes.retryAt = 0; // as if the cool-off had passed
  await likes.ensure([11]);
  assert.equal(api.calls.check.length, 2, 'and it is retried afterwards');
});

test('a network failure is not fatal to a poll', async () => {
  const api = fakeApi();
  api.likedIds = async () => {
    throw new Error('socket hang up');
  };
  const likes = new LikeState({ api });

  await assert.doesNotReject(likes.ensure([1]));
  assert.equal(likes.known(1), false);
  assert.match(likes.status().error, /socket hang up/);
  assert.ok(likes.retryAt > Date.now(), 'the cool-off covers a thrown request too');
});

test('liking writes to the account and then answers from the cache', async () => {
  const api = fakeApi();
  const likes = new LikeState({ api });

  const liked = await likes.set(42, true);
  assert.equal(liked.ok, true);
  assert.deepEqual(api.calls.like, [{ id: 42, like: true }], 'the direction the caller asked for');
  assert.equal(likes.isLiked(42), true, 'a confirmed write is the cache’s answer, with no second read');

  const removed = await likes.set(42, false);
  assert.equal(removed.ok, true);
  assert.deepEqual(api.calls.like[1], { id: 42, like: false });
  assert.equal(likes.isLiked(42), false);
  assert.equal(api.calls.check.length, 0, 'a write never needs a read to be believed');
});

test('a refusal leaves the cache untouched', async () => {
  // The heart must not fill for a like NetEase never received — the next poll
  // would contradict it, and the DJ's taste mirror would be wrong meanwhile.
  const api = fakeApi({ fail: 400 });
  const likes = new LikeState({ api });

  const refused = await likes.set(9, true);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 400);
  assert.equal(likes.isLiked(9), false);
  assert.equal(likes.known(9), false, 'not even as "not liked"');
});

test('an anonymous session is refused before any request', async () => {
  const api = fakeApi({ authenticated: false });
  const likes = new LikeState({ api });

  const refused = await likes.set(9, true);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'ANONYMOUS');
  assert.deepEqual(api.calls.like, [], 'nothing to ask NetEase about');

  await likes.ensure([9]);
  assert.deepEqual(api.calls.check, [], 'and nothing can be liked, so there is nothing to read');
});

test('an invalid track id never reaches the API', async () => {
  const api = fakeApi();
  const likes = new LikeState({ api });
  const refused = await likes.set('not-a-track', true);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'BAD_ID');
  assert.deepEqual(api.calls.like, []);
});

test('clear() forgets the previous account’s answers', async () => {
  const api = fakeApi({ liked: [3] });
  const likes = new LikeState({ api });
  await likes.ensure([3]);
  assert.equal(likes.isLiked(3), true);

  likes.clear();
  assert.equal(likes.isLiked(3), false);
  assert.equal(likes.known(3), false);
  assert.equal(likes.status().cached, 0);
  assert.equal(likes.status().error, null, 'a new session starts with a clean slate');
});

test('concurrent polls share one in-flight check', async () => {
  const api = fakeApi();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  api.likedIds = async (ids) => {
    api.calls.check.push([...ids]);
    await gate;
    return { ok: true, ids };
  };
  const likes = new LikeState({ api });

  const first = likes.ensure([1]);
  const second = likes.ensure([1]);
  release();
  await Promise.all([first, second]);
  assert.equal(api.calls.check.length, 1, 'an id already being asked about is not asked again');

  // A second poll that names an id nobody has asked about still asks about that
  // one: batching follows what is unknown, not what one request happened to
  // include.
  await likes.ensure([1, 2]);
  assert.deepEqual(api.calls.check[1], [2]);
});
