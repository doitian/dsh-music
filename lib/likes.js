/**
 * NetEase's like state for the tracks the panel is showing.
 *
 * A like lives in the account, not in this plugin: `/api/song/like/check` is
 * where the truth is, and this class is the cache in front of it. Four
 * properties are deliberate:
 *
 *   - **Unknown is not "not liked".** A track nobody has asked about has no
 *     answer; `isLiked` reads false for it, and `known` says which of the two
 *     it is. The panel renders a hollow heart either way, so the difference
 *     only matters to a caller that is about to write.
 *   - **A refusal is not an answer.** An anonymous session answers `code: 301`
 *     for every id. Caching that as "not liked" would leave every heart empty
 *     for the rest of the session, so a refused check caches nothing and is
 *     retried after a cool-off instead.
 *   - **A write is authoritative.** `set()` writes through to NetEase and then
 *     updates the cache, so the panel's next poll does not need a round trip to
 *     see the change it just made. It never claims a like the account does not
 *     have: a refused write leaves the cache untouched.
 *   - **Nothing here is persisted.** The account is the storage; a restart
 *     re-reads it, and a different account must not inherit the last one's
 *     answers, which is what `clear()` is for.
 *
 * @module dsh-music/likes
 */

/** How long one answer is trusted before it is asked again. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Ids per `/api/song/like/check` request; it takes a list, but not a URL. */
const CHECK_BATCH = 100;

/** How long a refused or failed check waits before trying again. */
const RETRY_AFTER_MS = 30_000;

export class LikeState {
  /**
   * @param {object} options
   * @param {import('./netease.js').Netease} options.api
   * @param {{warn: Function, info: Function, debug: Function}} [options.logger]
   * @param {number} [options.ttlMs] how long one answer stays fresh.
   * @param {number} [options.batchSize] ids per check request.
   */
  constructor({ api, logger, ttlMs = DEFAULT_TTL_MS, batchSize = CHECK_BATCH } = {}) {
    this.api = api;
    this.logger = logger;
    this.ttlMs = ttlMs;
    this.batchSize = batchSize;
    /** @type {Map<number, {liked: boolean, at: number}>} */
    this.answers = new Map();
    /** @type {Map<number, Promise<void>>} in-flight checks, so polls share one. */
    this.pending = new Map();
    /** Earliest time a refused check may be attempted again. */
    this.retryAt = 0;
    /** Why the last check did not produce answers, for `/music/health`. */
    this.error = null;
  }

  /** The cached answer; false when there is none. See {@link known}. */
  isLiked(id) {
    return this.answers.get(Number(id))?.liked === true;
  }

  /** Whether a fresh answer for this track is cached — either way. */
  known(id) {
    const entry = this.answers.get(Number(id));
    return Boolean(entry) && Date.now() - entry.at < this.ttlMs;
  }

  /** Forget every answer. A session change invalidates all of them. */
  clear() {
    this.answers.clear();
    this.pending.clear();
    this.retryAt = 0;
    this.error = null;
    return this;
  }

  /**
   * Resolve the like state of `ids`, asking NetEase only about the tracks with
   * no fresh answer. Never throws: a like check must not fail a poll, and an
   * unresolved id simply stays unknown.
   */
  async ensure(ids) {
    // Nothing can be liked on an anonymous session, so there is nothing to ask.
    if (!this.api?.authenticated) return;
    const list = [...new Set([...ids].map(Number).filter(Number.isFinite))];
    const stale = list.filter((id) => !this.known(id) && !this.pending.has(id));
    if (stale.length === 0) return;
    if (Date.now() < this.retryAt) return;

    const work = this.#load(stale).finally(() => {
      for (const id of stale) this.pending.delete(id);
    });
    for (const id of stale) this.pending.set(id, work);
    await work;
  }

  /** Ask for `ids` in batches and cache every answer in them. */
  async #load(ids) {
    for (let offset = 0; offset < ids.length; offset += this.batchSize) {
      const chunk = ids.slice(offset, offset + this.batchSize);
      let result;
      try {
        result = await this.api.likedIds(chunk);
      } catch (error) {
        this.#coolOff(`like check failed: ${error.message}`);
        return;
      }
      if (!result.ok) {
        // Not an answer: cache nothing, so signing in or a retry can still
        // resolve these tracks rather than freezing them as unliked.
        this.#coolOff(`like check refused (code ${result.code}): ${result.reason}`);
        return;
      }
      const liked = new Set(result.ids);
      const at = Date.now();
      for (const id of chunk) this.answers.set(id, { liked: liked.has(id), at });
      this.error = null;
    }
  }

  #coolOff(reason) {
    this.retryAt = Date.now() + RETRY_AFTER_MS;
    this.error = reason;
    this.logger?.debug?.(`[music] ${reason}`);
  }

  /**
   * Like or un-like one track on NetEase.
   *
   * The account is written first and the cache only follows a confirmed change,
   * so the panel can never show a heart the account would contradict.
   *
   * @param {number|string} trackId
   * @param {boolean} liked
   * @returns {Promise<{ok: boolean, id: number, liked?: boolean, code?: number|string, reason?: string}>}
   */
  async set(trackId, liked) {
    const id = Number(trackId);
    if (!Number.isFinite(id)) {
      return { ok: false, id: trackId, code: 'BAD_ID', reason: `invalid track id "${trackId}"` };
    }
    if (!this.api?.authenticated) {
      return { ok: false, id, code: 'ANONYMOUS', reason: 'the NetEase session is anonymous' };
    }
    let result;
    try {
      result = await this.api.likeSong(id, liked);
    } catch (error) {
      return { ok: false, id, code: 'NETWORK', reason: error.message };
    }
    if (!result.ok) return result;
    this.answers.set(id, { liked: Boolean(liked), at: Date.now() });
    this.error = null;
    return result;
  }

  /** What the cache holds, for `/music/health`. */
  status() {
    return {
      cached: this.answers.size,
      pending: this.pending.size,
      error: this.error,
    };
  }
}

export { CHECK_BATCH, DEFAULT_TTL_MS, RETRY_AFTER_MS };
