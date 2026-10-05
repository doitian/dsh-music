/**
 * Authoritative playback state and the browser sync channel.
 *
 * The host owns the queue, the cursor, and the *desired* transport state; the
 * browser panel owns the `<audio>` element and therefore the actual playback.
 * They reconcile through revisions:
 *
 *   - `rev`           changes on any state change; the panel re-reads on change.
 *   - `transportRev`  changes when the panel must act (load a track, play,
 *                     pause, seek, change volume).
 *   - `report`        the panel's feedback: position, actual playing state, and
 *                     track-ended / track-failed signals.
 *
 * This keeps agent tools, the panel, and the AI DJ all driving one state
 * machine instead of three competing ones.
 *
 * @module dsh-music/state
 */

import { normalizeTrack } from './netease.js';

/** Playback modes the panel can select. */
export const MODES = ['list', 'single', 'shuffle'];

/** A pending seek is delivered once and then cleared. */
const SEEK_EPSILON_MS = 1_000;

/**
 * A manual "next" before this much of a track has played is a skip: the
 * listener rejected the track rather than finished with it. The window is 30 s,
 * or a quarter of the track when that is longer.
 */
const SKIP_WINDOW_MS = 30_000;
const SKIP_WINDOW_FRACTION = 0.25;

/**
 * Mark who queued a track. A track the DJ chose has to be heard through
 * before it counts as taste; one the listener chose counts at once.
 */
function tag(track, queuedBy) {
  return queuedBy && track?.id ? { ...track, queuedBy } : track;
}

export class Player {
  /**
   * @param {object} [options]
   * @param {{warn: Function, info: Function, debug: Function}} [options.logger]
   */
  constructor({ logger } = {}) {
    this.logger = logger;
    this.listeners = new Set();
    this.rev = 0;
    this.transportRev = 0;
    /** @type {object[]} */
    this.queue = [];
    /** Index into {@link queue}; -1 means "nothing selected". */
    this.index = -1;
    this.playing = false;
    this.volume = 0.8;
    this.mode = 'list';
    this.muted = false;
    /** One-shot absolute seek target in milliseconds. */
    this.pendingSeek = null;
    /** Last state the panel reported back. */
    this.reported = { trackId: null, position: 0, duration: 0, playing: false, at: 0, error: null };
    /**
     * Last playback failure, preserved across the automatic skip that follows
     * it. `reported.error` is per-track and cleared on every move, so without
     * this the agent could never learn *why* a track was skipped.
     */
    this.lastError = null;
    /** AI DJ status, surfaced in the panel so a plan can be watched. */
    this.dj = {
      enabled: false,
      busy: false,
      lastPlanAt: null,
      lastPlan: null,
      error: null,
      /** Why the model tier last declined, when it did. */
      modelError: null,
      source: null,
    };
    /**
     * Called when the queue runs low so a producer can extend it.
     * @type {(() => Promise<void>) | undefined}
     */
    this.onLowQueue = undefined;
    /**
     * Called with a track the listener moved past early, for the taste record.
     * @type {((track: object) => void) | undefined}
     */
    this.onSkip = undefined;
    /**
     * Called once with the current track when the listener has heard it
     * through: past the skip window, or to its end.
     * @type {((track: object) => void) | undefined}
     */
    this.onHeard = undefined;
    /** The track `onHeard` was last called for, so it fires once per play. */
    this.heardId = null;
    /**
     * Called once when a track starts playing — its first reported position —
     * and once when that play ends, however it ends: the track finishing or
     * failing, a skip, a jump, the queue replaced or cleared. `seconds` is how
     * much was heard, `ended` whether it played to its end, and `heard`
     * whether it got past the skip window. The listening history is built
     * from these.
     * @type {((track: object) => void) | undefined}
     */
    this.onStart = undefined;
    /** @type {((track: object, play: {seconds: number, ended: boolean, heard: boolean}) => void) | undefined} */
    this.onFinish = undefined;
    /** The track whose play `onStart` opened and `onFinish` has not closed yet. */
    this.startedId = null;
  }

  /** Subscribe to state changes. @returns {() => void} unsubscribe */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Mark every field dirty and notify subscribers. */
  bump({ transport = false } = {}) {
    this.rev += 1;
    if (transport) this.transportRev += 1;
    for (const listener of this.listeners) {
      try {
        listener(this);
      } catch (error) {
        this.logger?.warn?.(`[music] state listener failed: ${error.message}`);
      }
    }
  }

  // ------------------------------------------------------------------ queue

  /** The track at the cursor, or null. */
  current() {
    return this.queue[this.index] ?? null;
  }

  /** Tracks after the cursor, for DJ top-up decisions. */
  remaining() {
    if (this.queue.length === 0) return [];
    return this.queue.slice(Math.max(this.index + 1, 0));
  }

  /** Replace the whole queue. `startIndex` selects what plays first. */
  setQueue(tracks, { startIndex = 0, play = true, source, queuedBy } = {}) {
    const normalized = tracks
      .map((track) => normalizeTrack(track) ?? track)
      .filter((track) => track?.id)
      .map((track) => tag(track, queuedBy));
    this.#finish();
    this.heardId = null;
    this.queue = normalized;
    this.index = normalized.length === 0 ? -1 : Math.min(Math.max(startIndex, 0), normalized.length - 1);
    this.pendingSeek = null;
    if (play && normalized.length > 0) this.playing = true;
    if (source) this.dj.source = source;
    this.logger?.debug?.(`[music] queue replaced with ${normalized.length} track(s)`);
    this.bump({ transport: true });
    return this.snapshot();
  }

  /** Append tracks, de-duplicating against the queue tail. */
  append(tracks, { source, play = true, queuedBy } = {}) {
    const existing = new Set(this.queue.map((track) => track.id));
    const added = [];
    for (const raw of tracks) {
      const track = tag(normalizeTrack(raw) ?? raw, queuedBy);
      if (!track?.id || existing.has(track.id)) continue;
      existing.add(track.id);
      added.push(track);
    }
    if (added.length === 0) return { added: 0, snapshot: this.snapshot() };
    this.queue.push(...added);
    if (this.index < 0) this.index = 0;
    if (play && !this.playing) this.playing = true;
    if (source) this.dj.source = source;
    this.bump({ transport: true });
    return { added: added.length, snapshot: this.snapshot() };
  }

  /** Insert tracks directly after the cursor. */
  insertNext(tracks, { source, queuedBy } = {}) {
    const existing = new Set(this.queue.map((track) => track.id));
    const added = [];
    for (const raw of tracks) {
      const track = tag(normalizeTrack(raw) ?? raw, queuedBy);
      if (!track?.id || existing.has(track.id)) continue;
      existing.add(track.id);
      added.push(track);
    }
    if (added.length === 0) return { added: 0, snapshot: this.snapshot() };
    this.queue.splice(this.index + 1, 0, ...added);
    if (source) this.dj.source = source;
    this.bump({ transport: true });
    return { added: added.length, snapshot: this.snapshot() };
  }

  /**
   * Remove one queue position and report what was removed.
   *
   * The report matters: taking a track out of the queue is a judgement about the
   * track, not just about the list, and the caller cannot read it off the queue
   * afterwards — the row whose index it was asking about is the one that is
   * gone. `snapshot` is the state after the removal.
   *
   * @returns {{track: object|null, wasCurrent: boolean, snapshot: object}}
   */
  removeAt(index) {
    const track = this.queue[index] ?? null;
    return { track, wasCurrent: index >= 0 && index === this.index, snapshot: this.remove(index) };
  }

  /** Remove one queue position. */
  remove(index) {
    if (index < 0 || index >= this.queue.length) return this.snapshot();
    const wasCurrent = index === this.index;
    if (wasCurrent) this.#finish();
    this.queue.splice(index, 1);
    if (this.queue.length === 0) {
      this.index = -1;
      this.playing = false;
    } else if (index < this.index) {
      this.index -= 1;
    } else if (wasCurrent) {
      // The next track takes the removed one's place. Past the end, the queue
      // wraps to its start, as `next` does, rather than going back a track.
      if (this.index >= this.queue.length) this.index = 0;
      this.pendingSeek = 0;
    }
    this.bump({ transport: true });
    return this.snapshot();
  }

  /** Empty the queue and stop. */
  clear() {
    this.#finish();
    this.queue = [];
    this.index = -1;
    this.playing = false;
    this.pendingSeek = null;
    this.reported = { trackId: null, position: 0, duration: 0, playing: false, at: Date.now(), error: null };
    this.lastError = null;
    this.bump({ transport: true });
    return this.snapshot();
  }

  // --------------------------------------------------------------- transport

  /** Index to advance to, honouring the repeat/shuffle mode. */
  #nextIndex(step) {
    if (this.queue.length === 0) return -1;
    if (this.mode === 'shuffle' && this.queue.length > 1) {
      let next = this.index;
      while (next === this.index) next = Math.floor(Math.random() * this.queue.length);
      return next;
    }
    const raw = this.index + step;
    if (this.mode === 'single') return this.index < 0 ? 0 : this.index;
    if (raw < 0) return this.queue.length - 1;
    if (raw >= this.queue.length) return 0;
    return raw;
  }

  /**
   * Move the cursor.
   * @param {number} step +1 next, -1 previous.
   * @param {{auto?: boolean}} [options] `auto` marks an automatic advance.
   */
  move(step, { auto = false } = {}) {
    if (this.queue.length === 0) return this.snapshot();
    const left = this.current();
    const skipped = !auto && step > 0 && this.#heardBriefly();
    this.#finish();
    this.index = this.#nextIndex(step);
    if (this.current() !== left) this.heardId = null;
    this.pendingSeek = 0;
    this.playing = true;
    this.reported = { ...this.reported, position: 0, duration: 0, error: null, at: Date.now() };
    this.bump({ transport: true });
    if (skipped && this.current() !== left) this.#notifySkip(left);
    if (auto) this.#maybeExtend();
    return this.snapshot();
  }

  /**
   * Whether the current track was heard, but only briefly.
   *
   * Only a reported position counts: a track the panel never started (paused,
   * blocked by autoplay, still loading) was not listened to, so moving past it
   * says nothing about it.
   */
  #heardBriefly() {
    const current = this.current();
    if (!current || this.reported.trackId !== current.id) return false;
    const position = Number(this.reported.position) || 0;
    if (position <= 0) return false;
    return position < this.#skipWindow(current);
  }

  /** How much of `track` must play before moving on is no longer a skip. */
  #skipWindow(track) {
    const duration = Number(this.reported.duration) || Number(track.duration) || 0;
    return Math.max(SKIP_WINDOW_MS, duration * SKIP_WINDOW_FRACTION);
  }

  /**
   * Tell the taste record, once per play, that the current track was heard
   * through — past the skip window, or to its end. The two windows are one:
   * a track is either skipped or heard, never both and never neither once it
   * has played that far.
   */
  #noteHeard({ ended = false } = {}) {
    const current = this.current();
    if (!current || this.heardId === current.id || this.reported.trackId !== current.id) return;
    if (!ended && (Number(this.reported.position) || 0) < this.#skipWindow(current)) return;
    this.heardId = current.id;
    try {
      this.onHeard?.(current);
    } catch (error) {
      this.logger?.warn?.(`[music] heard listener failed: ${error.message}`);
    }
  }

  /** Open the play of the current track once it is really playing. */
  #noteStart({ ended = false } = {}) {
    const current = this.current();
    if (!current || this.startedId === current.id || this.reported.trackId !== current.id) return;
    if (!ended && !((Number(this.reported.position) || 0) > 0)) return;
    this.startedId = current.id;
    try {
      this.onStart?.(current);
    } catch (error) {
      this.logger?.warn?.(`[music] start listener failed: ${error.message}`);
    }
  }

  /**
   * Close the current play, if one is open. Called before anything moves the
   * cursor or restarts the track, while the report still describes the play
   * that is ending. A replay of the same track — single repeat, a jump to
   * itself — then opens a play of its own, and has to be heard again.
   */
  #finish({ ended = false } = {}) {
    const track = this.current();
    if (!track || this.startedId !== track.id) return;
    const heard = this.heardId === track.id;
    const durationMs = Number(this.reported.duration) || Number(track.duration) || 0;
    const seconds = (ended ? durationMs : Number(this.reported.position) || 0) / 1000;
    this.startedId = null;
    this.heardId = null;
    try {
      this.onFinish?.(track, { seconds, ended, heard });
    } catch (error) {
      this.logger?.warn?.(`[music] finish listener failed: ${error.message}`);
    }
  }

  #notifySkip(track) {
    try {
      this.onSkip?.(track);
    } catch (error) {
      this.logger?.warn?.(`[music] skip listener failed: ${error.message}`);
    }
  }

  /** Jump to an explicit queue position. */
  jump(index) {
    if (index < 0 || index >= this.queue.length) return this.snapshot();
    this.#finish();
    if (index !== this.index) this.heardId = null;
    this.index = index;
    this.pendingSeek = 0;
    this.playing = true;
    this.reported = { ...this.reported, position: 0, duration: 0, error: null, at: Date.now() };
    this.bump({ transport: true });
    return this.snapshot();
  }

  setPlaying(playing) {
    const next = Boolean(playing);
    if (this.playing === next) return this.snapshot();
    this.playing = next;
    this.bump({ transport: true });
    return this.snapshot();
  }

  toggle() {
    return this.setPlaying(!this.playing);
  }

  setVolume(volume) {
    const next = Math.min(Math.max(Number(volume) || 0, 0), 1);
    if (Math.abs(next - this.volume) < 0.001) return this.snapshot();
    this.volume = next;
    this.bump({ transport: true });
    return this.snapshot();
  }

  setMuted(muted) {
    const next = Boolean(muted);
    if (this.muted === next) return this.snapshot();
    this.muted = next;
    this.bump({ transport: true });
    return this.snapshot();
  }

  setMode(mode) {
    if (!MODES.includes(mode) || this.mode === mode) return this.snapshot();
    this.mode = mode;
    this.bump();
    return this.snapshot();
  }

  /** Absolute seek in milliseconds. */
  seek(positionMs) {
    const next = Math.max(Number(positionMs) || 0, 0);
    this.pendingSeek = next;
    this.reported = { ...this.reported, position: next, at: Date.now() };
    this.bump({ transport: true });
    return this.snapshot();
  }

  /** True when a seek target is waiting for the panel to apply. */
  takeSeek() {
    const value = this.pendingSeek;
    this.pendingSeek = null;
    return value;
  }

  // ---------------------------------------------------------------- reporting

  /**
   * Absorb the panel's report. Returns a hint telling the caller what the host
   * did in response, so the caller can run follow-up work such as a DJ top-up.
   * @returns {{ended: boolean, failed: boolean, advanced: boolean}}
   */
  report({ trackId, position, duration, playing, ended, error } = {}) {
    const current = this.current();
    // Ignore reports for a track the user already moved away from; they arrive
    // for a moment after every skip.
    if (trackId !== undefined && current && Number(trackId) !== current.id) {
      return { ended: false, failed: false, advanced: false };
    }
    if (Number.isFinite(position)) this.reported.position = Number(position);
    if (Number.isFinite(duration) && duration > 0) this.reported.duration = Number(duration);
    if (typeof playing === 'boolean') this.reported.playing = playing;
    this.reported.trackId = current?.id ?? null;
    this.reported.at = Date.now();
    if (error) {
      this.reported.error = String(error).slice(0, 300);
      this.lastError = this.reported.error;
    }

    this.#noteStart({ ended: Boolean(ended) });
    this.#noteHeard({ ended: Boolean(ended) });
    if (ended) this.#finish({ ended: true });

    let advanced = false;
    if (ended || error) {
      this.logger?.info?.(`[music] track ${ended ? 'ended' : 'failed'}, advancing`);
      this.move(1, { auto: true });
      advanced = true;
    }
    this.bump();
    return { ended: Boolean(ended), failed: Boolean(error), advanced };
  }

  /** Ask the producer to extend a nearly drained queue. */
  #maybeExtend() {
    if (!this.onLowQueue) return;
    void this.onLowQueue().catch((error) => {
      this.logger?.warn?.(`[music] queue extension failed: ${error.message}`);
    });
  }

  /** Trigger a top-up check explicitly (used after a DJ plan is consumed). */
  requestExtension() {
    this.#maybeExtend();
  }

  /**
   * Panel-facing snapshot. `track` is duplicated for the current item so the
   * panel does not have to search the queue on every poll.
   */
  snapshot() {
    const current = this.current();
    return {
      rev: this.rev,
      transportRev: this.transportRev,
      queue: this.queue,
      index: this.index,
      current,
      playing: this.playing,
      volume: this.volume,
      muted: this.muted,
      mode: this.mode,
      pendingSeek: this.pendingSeek,
      reported: this.reported,
      dj: this.dj,
      counts: {
        queued: this.queue.length,
        remaining: this.remaining().length,
      },
    };
  }

  /**
   * Compact view for agent tools — no queue dump, just enough to report what is
   * playing and what comes next.
   */
  summary() {
    const current = this.current();
    const describe = (track, at) => ({
      at,
      id: track.id,
      name: track.name,
      artists: track.artists,
      album: track.album,
      durationMs: track.duration,
      vip: track.vip,
    });
    return {
      playing: this.playing,
      mode: this.mode,
      volume: this.volume,
      current: current ? describe(current, this.index) : null,
      positionMs: current && this.reported.trackId === current.id ? this.reported.position : 0,
      upNext: this.remaining().slice(0, 5).map((track, offset) => describe(track, this.index + 1 + offset)),
      queued: this.queue.length,
      remaining: this.remaining().length,
      dj: {
        enabled: this.dj.enabled,
        busy: this.dj.busy,
        lastPlanAt: this.dj.lastPlanAt,
        lastPlan: this.dj.lastPlan,
        source: this.dj.source,
        error: this.dj.error,
      },
      lastError: this.lastError,
    };
  }
}

export { SEEK_EPSILON_MS };
