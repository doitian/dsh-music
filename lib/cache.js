/**
 * How the DJ reads its sources: a time-bounded cache, the sampling it draws
 * its pool with, and the pacing its requests are sent at.
 *
 * Most of the DJ's sources change on the scale of hours or days — a chart
 * daily, similarity effectively never — so fetching each one on every plan
 * spends requests to learn nothing. The cache keeps each source for as long as
 * it plausibly stays the same, and the DJ samples from what it holds, so a
 * long cached list still yields a different handful each time. What does go
 * out is paced like a person browsing, not fired as a burst.
 *
 * @module dsh-music/cache
 */

/** Entries kept at most; the oldest are dropped first. */
const MAX_ENTRIES = 2_000;

export class TtlCache {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now] clock, injectable for tests.
   * @param {number} [options.maxEntries]
   */
  constructor({ now = Date.now, maxEntries = MAX_ENTRIES } = {}) {
    this.now = now;
    this.maxEntries = maxEntries;
    /** @type {Map<string, {value: unknown, expiresAt: number}>} */
    this.entries = new Map();
  }

  /** The live value for `key`, or `undefined` when absent or expired. */
  peek(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    return value;
  }

  /**
   * The cached value for `key`, loading it when absent or expired.
   *
   * The pending load is what gets cached, so two plans racing for the same
   * source share one request. A failed load is forgotten rather than cached:
   * the next plan should try again, not inherit the outage for the whole TTL.
   *
   * @template T
   * @param {string} key
   * @param {number} ttlMs
   * @param {() => Promise<T>} load
   * @returns {Promise<T>}
   */
  get(key, ttlMs, load) {
    const cached = this.peek(key);
    if (cached !== undefined) return cached;
    const pending = Promise.resolve().then(load);
    this.set(key, pending, ttlMs);
    pending.catch(() => {
      if (this.entries.get(key)?.value === pending) this.entries.delete(key);
    });
    return pending;
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}

/**
 * A random `count` of `items`, kept in their original order.
 *
 * Random so a cached list still yields a different handful each plan — taking
 * the first `count` would serve the same tracks until the source changes. In
 * order, because a source's order carries meaning (chart rank, search
 * relevance), and the pool keeps it.
 *
 * @template T
 * @param {T[]} items
 * @param {number} count
 * @param {() => number} [random]
 * @returns {T[]}
 */
export function sampleInOrder(items, count, random = Math.random) {
  if (count >= items.length) return [...items];
  if (count <= 0) return [];
  const indices = items.map((_, index) => index);
  for (let index = 0; index < count; index += 1) {
    const swap = index + Math.floor(random() * (indices.length - index));
    [indices[index], indices[swap]] = [indices[swap], indices[index]];
  }
  return indices
    .slice(0, count)
    .sort((a, b) => a - b)
    .map((index) => items[index]);
}

/**
 * Spaces out request starts by a randomised gap.
 *
 * A plan touches up to a dozen sources, and firing them at once is a crawler's
 * signature: a tight burst at a machine-regular rhythm. Starts are spaced
 * instead, each by its own random gap, so the traffic reads like someone
 * clicking through the app. Only starts are spaced — a request already sent may
 * still be in flight when the next starts, as on any page that is loading.
 */
export class Pacer {
  /**
   * @param {object} [options]
   * @param {number} [options.minGapMs] the shortest gap between two starts.
   * @param {number} [options.jitterMs] the random span added to each gap.
   * @param {() => number} [options.now]
   * @param {(ms: number) => Promise<void>} [options.sleep]
   * @param {() => number} [options.random]
   */
  constructor({
    minGapMs = 250,
    jitterMs = 500,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
  } = {}) {
    this.minGapMs = minGapMs;
    this.jitterMs = jitterMs;
    this.now = now;
    this.sleep = sleep;
    this.random = random;
    /** The earliest the next request may start. */
    this.nextAt = 0;
  }

  /**
   * Run `task` at the next free start slot.
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  run(task) {
    const at = Math.max(this.now(), this.nextAt);
    this.nextAt = at + this.minGapMs + this.random() * this.jitterMs;
    const wait = at - this.now();
    return (wait > 0 ? this.sleep(wait) : Promise.resolve()).then(task);
  }
}
