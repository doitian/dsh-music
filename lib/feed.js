/**
 * Server-sent player state, for the player page and the audio engine.
 *
 * `GET /music/api/events` holds the response open as an event stream and
 * writes the full snapshot whenever something either of them would show or
 * act on changes. Both used to re-read `/state` on a timer — the page every
 * 1.5 s, the engine every 500 ms — and the page rebuilt its lists on every
 * read whether or not anything had moved.
 *
 * A change is found by comparing snapshots rather than by trusting every
 * mutation to announce itself: the snapshot draws on the player, the session
 * store, the like cache, the scrobbler and the stream resolver, and several of
 * those change without passing through the player. Announcements only decide
 * *when* to compare: on a player bump, after any API write, and on a slow
 * sweep that catches what announces nothing (a boost running out, a like
 * resolved in the background, a sign-in from an agent tool). The position
 * report the engine posts every second bumps the player, but moves nothing
 * the comparison sees, so a playing track sends no frames.
 *
 * @module dsh-music/feed
 */

/** Keeps idle connections, and the desktop shell's forwarding fetch, alive. */
const HEARTBEAT_MS = 25_000;

/** How soon a dropped browser connection reconnects. */
const RETRY_MS = 2_000;

/** Compare this often even when nothing announced a change. */
const SWEEP_MS = 5_000;

/**
 * The snapshot as the page and engine see it, minus what moves while a track
 * plays: the position, its timestamp, and the revision a position report bumps.
 * The last stream request's time goes too: every seek is a new range request,
 * and the time is all that changes about it.
 */
export function visibleKey(snapshot) {
  const { rev, version, reported, audio, ...rest } = snapshot ?? {};
  const { position, at, ...steady } = reported ?? {};
  const { at: requestedAt, ...last } = audio?.last ?? {};
  return JSON.stringify({ ...rest, reported: steady, audio: { ...audio, last } });
}

/**
 * Numbers snapshots by what they show, for the clients' ordering guard.
 *
 * The player's `rev` cannot order them: a streaming quality, a setting or a
 * resolved like changes the snapshot without bumping it, so a report's late
 * answer and a newer pushed frame could share a `rev` and the stale one win.
 * `version` moves whenever {@link visibleKey} does, whatever moved it, and
 * never for a position report.
 */
export class SnapshotVersions {
  constructor() {
    this.key = undefined;
    this.version = 0;
  }

  /** `snapshot` with its `version`. */
  stamp(snapshot) {
    const key = visibleKey(snapshot);
    if (key !== this.key) {
      this.key = key;
      this.version += 1;
    }
    return { ...snapshot, version: this.version };
  }
}

function frame(snapshot) {
  return `event: state\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

export class StateFeed {
  /**
   * @param {object} options
   * @param {() => Promise<object>} options.snapshot the state document to send.
   * @param {{warn: Function}} [options.logger]
   * @param {number} [options.sweepMs]
   * @param {number} [options.heartbeatMs]
   */
  constructor({ snapshot, logger, sweepMs = SWEEP_MS, heartbeatMs = HEARTBEAT_MS }) {
    this.snapshot = snapshot;
    this.logger = logger;
    this.sweepMs = sweepMs;
    this.heartbeatMs = heartbeatMs;
    /** @type {Set<import('node:http').ServerResponse>} */
    this.clients = new Set();
    /** Clients that have not been sent a state yet. */
    this.newcomers = new Set();
    /** What the clients were last sent, as {@link visibleKey}. */
    this.lastKey = undefined;
    /** The comparison under way, and whether another was asked for meanwhile. */
    this.pending = null;
    this.dirty = false;
    this.sweep = undefined;
    this.heartbeat = undefined;
  }

  /** Take over one `GET /events` response for as long as the client stays. */
  attach(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: ${RETRY_MS}\n\n`);
    this.clients.add(res);
    this.newcomers.add(res);
    this.#start();
    const leave = () => {
      this.newcomers.delete(res);
      if (!this.clients.delete(res)) return;
      if (this.clients.size === 0) this.#stop();
    };
    req.on('close', leave);
    res.on('close', leave);
    res.on('error', leave);
    // Through the same queue as every other frame, so a newcomer's first state
    // can never land after a newer one.
    this.changed();
  }

  /** Something may have changed; compare once the current burst has settled. */
  changed() {
    if (this.clients.size === 0) return;
    if (this.pending) {
      this.dirty = true;
      return;
    }
    this.pending = this.#flush().finally(() => {
      this.pending = null;
      if (this.dirty) {
        this.dirty = false;
        this.changed();
      }
    });
  }

  /** End every stream and stop the timers; the route is going away. */
  close() {
    for (const res of this.clients) {
      try {
        res.end();
      } catch { /* the socket is already gone */ }
    }
    this.clients.clear();
    this.newcomers.clear();
    this.#stop();
  }

  async #flush() {
    // One comparison for a burst of synchronous mutations, not one each.
    await new Promise((resolve) => setImmediate(resolve));
    let snapshot;
    try {
      snapshot = await this.snapshot();
    } catch (error) {
      this.logger?.warn?.(`[music] event stream could not read the state: ${error.message}`);
      return;
    }
    const key = visibleKey(snapshot);
    // Everyone when it moved; otherwise only those who have nothing yet.
    const targets = key === this.lastKey ? [...this.newcomers] : [...this.clients];
    this.lastKey = key;
    this.newcomers.clear();
    if (targets.length === 0) return;
    const text = frame(snapshot);
    for (const res of targets) res.write(text);
  }

  #start() {
    if (this.sweep !== undefined) return;
    this.sweep = setInterval(() => this.changed(), this.sweepMs);
    this.sweep.unref?.();
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) res.write(': ping\n\n');
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  #stop() {
    clearInterval(this.sweep);
    clearInterval(this.heartbeat);
    this.sweep = undefined;
    this.heartbeat = undefined;
    // Nobody holds the last frame any more; the next client starts afresh.
    this.lastKey = undefined;
  }
}
