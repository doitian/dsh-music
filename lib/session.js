/**
 * Session persistence and the QR-login state machine.
 *
 * The NetEase session is a single `MUSIC_U` cookie, so persistence is a small
 * JSON document under the plugin's data directory. It also carries the local
 * taste signals the AI DJ reads: play history plus like/dislike/skip feedback.
 *
 * @module dsh-music/session
 */

import fs from 'node:fs';
import path from 'node:path';

/** Cookie sent for anonymous browsing; `os=pc` selects the desktop payloads. */
export const ANONYMOUS_COOKIE = 'os=pc; appver=2.10.6; channel=netease';

/** Play-history entries retained for DJ context. */
const MAX_HISTORY = 300;

/** Feedback lists are bounded so the file cannot grow without limit. */
const MAX_FEEDBACK = 500;

/** QR codes are refreshed before the API reports them expired. */
const QR_TTL_MS = 110_000;

/** Empty persisted document. */
function emptyState() {
  return {
    version: 1,
    cookie: '',
    account: null,
    savedAt: null,
    settings: {
      /**
       * Streaming quality chosen in the player. Empty means "no choice made
       * here", so the profile patch's `audioLevel` supplies the initial value;
       * a persisted `'exhigh'` would silently mask it.
       */
      level: '',
      /** Whether the continuous DJ keeps the queue topped up. */
      djEnabled: false,
      /** Free-text taste/mood brief the DJ includes in its prompt. */
      djPrompt: '',
      /**
       * DJ model route chosen from the player. Empty means "use the profile
       * patch's `config.dj`", so clearing the picker reverts to it.
       */
      djProvider: '',
      djModel: '',
      djAutoExtendBelow: 3,
      djBatchSize: 5,
      /**
       * The DJ's model-call identity, minted on first use and persisted here.
       *
       * A leaf call cannot carry headers, so this string is the only identity
       * the DJ can give a provider — and adapters map it onto whatever that
       * provider calls a per-conversation header (pi-ai emits
       * `x-opencode-session` for `opencode-go`). Persisting it keeps every plan
       * and every restart inside one conversation.
       */
      djSessionId: '',
    },
    history: [],
    feedback: { likes: [], dislikes: [], skips: [] },
  };
}

/**
 * JSON-document store for the plugin's data directory.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write cannot leave a
 * truncated session behind, and every mutation schedules a debounced save so
 * high-frequency updates such as playback position do not thrash the disk.
 */
export class SessionStore {
  /**
   * @param {object} options
   * @param {string} options.file absolute path to the JSON document.
   * @param {{warn: Function, info: Function, debug: Function}} [options.logger]
   * @param {number} [options.saveDelayMs] debounce window for `touch()`.
   */
  constructor({ file, logger, saveDelayMs = 1_500 }) {
    this.file = file;
    this.logger = logger;
    this.saveDelayMs = saveDelayMs;
    this.state = emptyState();
    this.timer = undefined;
    this.closed = false;
  }

  /** Read the document, tolerating absence and corruption. */
  load() {
    try {
      const text = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(text);
      this.state = { ...emptyState(), ...parsed, settings: { ...emptyState().settings, ...parsed.settings } };
      this.logger?.debug?.(`[music] session loaded (${this.state.cookie ? 'authenticated' : 'anonymous'})`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger?.warn?.(`[music] could not read session file, starting fresh: ${error.message}`);
      }
    }
    return this.state;
  }

  /** Write immediately. */
  save() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.state.savedAt = new Date().toISOString();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      fs.renameSync(temp, this.file);
    } catch (error) {
      this.logger?.warn?.(`[music] could not save session: ${error.message}`);
    }
  }

  /** Persist after a quiet period; used by frequently changing fields. */
  touch() {
    if (this.closed) return;
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.save();
    }, this.saveDelayMs);
    this.timer.unref?.();
  }

  /** Stop the debounce timer, flushing pending work. */
  close() {
    this.closed = true;
    this.save();
  }

  // ---------------------------------------------------------------- session

  get cookie() {
    return this.state.cookie || '';
  }

  setSession(cookie, account) {
    this.state.cookie = cookie || '';
    this.state.account = account ?? null;
    this.save();
  }

  clearSession() {
    this.state.cookie = '';
    this.state.account = null;
    this.save();
  }

  get settings() {
    return this.state.settings;
  }

  updateSettings(patch) {
    Object.assign(this.state.settings, patch);
    this.save();
    return this.state.settings;
  }

  // --------------------------------------------------------------- history

  /**
   * Record a play and return the durable taste picture the DJ reasons over.
   * @param {{id: number, name: string, artists: string[]}} track
   */
  recordPlay(track) {
    this.state.history.unshift({
      id: track.id,
      name: track.name,
      artists: track.artists ?? [],
      at: Date.now(),
    });
    if (this.state.history.length > MAX_HISTORY) this.state.history.length = MAX_HISTORY;
    this.touch();
  }

  /** Recent track ids, newest first — used to avoid repeats. */
  recentIds(limit = 50) {
    return this.state.history.slice(0, limit).map((entry) => entry.id);
  }

  /** Most-played artists, most frequent first. */
  topArtists(limit = 8) {
    const counts = new Map();
    for (const entry of this.state.history.slice(0, 150)) {
      for (const artist of entry.artists) counts.set(artist, (counts.get(artist) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([artist]) => artist);
  }

  /** Record like/dislike/skip feedback for one track. */
  recordFeedback(kind, trackId) {
    const list = this.state.feedback[kind];
    if (!list || !Number.isFinite(Number(trackId))) return this.state.feedback;
    const id = Number(trackId);
    const index = list.indexOf(id);
    if (kind === 'skips') {
      // Skips are counters, not membership: keep the newest occurrence.
      list.unshift(id);
      if (list.length > MAX_FEEDBACK) list.length = MAX_FEEDBACK;
    } else if (index >= 0) {
      list.splice(index, 1);
    } else {
      list.unshift(id);
      if (list.length > MAX_FEEDBACK) list.length = MAX_FEEDBACK;
      // Liking and disliking a track are mutually exclusive.
      const opposite = kind === 'likes' ? this.state.feedback.dislikes : this.state.feedback.likes;
      const oppositeIndex = opposite.indexOf(id);
      if (oppositeIndex >= 0) opposite.splice(oppositeIndex, 1);
    }
    this.touch();
    return this.state.feedback;
  }

  get feedback() {
    return this.state.feedback;
  }

  /**
   * A compact digest for the DJ prompt: what has been played, what is liked,
   * what is disliked — never the raw cookie or account details.
   */
  tasteDigest({ history = 15 } = {}) {
    const name = (entry) =>
      typeof entry === 'object' ? `${entry.name} — ${(entry.artists ?? []).join('/')}` : `#${entry}`;
    const byId = new Map(this.state.history.map((entry) => [entry.id, entry]));
    return {
      recentlyPlayed: this.state.history.slice(0, history).map(name),
      topArtists: this.topArtists(8),
      liked: this.state.feedback.likes.slice(0, 15).map((id) => byId.get(id)).filter(Boolean).map(name),
      disliked: this.state.feedback.dislikes.slice(0, 15).map((id) => byId.get(id)).filter(Boolean).map(name),
      dislikedIds: this.state.feedback.dislikes.slice(0, 80),
      recentIds: this.recentIds(60),
    };
  }
}

/**
 * One QR-login attempt at a time, refreshed automatically as codes expire.
 *
 * The panel shows `loginUrl` as a QR image; the mobile app scans it and the
 * poll below turns `803` into the session cookie on the caller's client.
 */
export class QrLogin {
  /**
   * @param {object} options
   * @param {import('./netease.js').Netease} options.api
   * @param {SessionStore} options.store
   * @param {{warn: Function, info: Function, debug: Function}} [options.logger]
   */
  constructor({ api, store, logger }) {
    this.api = api;
    this.store = store;
    this.logger = logger;
    this.current = null;
    this.lastError = null;
  }

  /** Start a fresh QR code, replacing any previous one. */
  async start() {
    const { unikey, loginUrl } = await this.api.qrStart();
    this.current = {
      unikey,
      loginUrl,
      state: 'waiting',
      message: '等待扫码 (waiting for scan)',
      startedAt: Date.now(),
      expiresAt: Date.now() + QR_TTL_MS,
    };
    this.lastError = null;
    this.logger?.debug?.(`[music] QR login started ${unikey}`);
    return this.current;
  }

  /** Existing QR code, or a new one when none is live. */
  async ensure() {
    if (!this.current) return this.start();
    if (Date.now() >= this.current.expiresAt && this.current.state !== 'scanned') {
      return this.start();
    }
    return this.current;
  }

  /** Forget the current attempt (used on logout). */
  reset() {
    this.current = null;
  }

  /**
   * Advance the attempt by one poll. On success the cookie is written to the
   * session store so it survives a restart.
   * @returns {Promise<{state: string, message: string, account?: object|null, loginUrl?: string}>}
   */
  async poll() {
    if (!this.current) await this.start();
    const attempt = this.current;
    if (attempt.state === 'success') {
      return { state: 'success', message: '已登录 (signed in)', account: this.api.account };
    }
    if (Date.now() >= attempt.expiresAt) {
      await this.start();
      return { state: 'expired', message: '二维码已刷新 (QR refreshed)', loginUrl: this.current.loginUrl };
    }

    let result;
    try {
      result = await this.api.qrPoll(attempt.unikey);
    } catch (error) {
      this.lastError = error.message;
      this.logger?.warn?.(`[music] QR poll failed: ${error.message}`);
      // `error` is the machine-usable half; the panel localizes around it,
      // while `message` stays bilingual for the agent-facing login tool.
      return { state: attempt.state, message: `轮询失败 (poll failed): ${error.message}`, error: error.message, loginUrl: attempt.loginUrl };
    }

    if (result.code === 800) {
      await this.start();
      return { state: 'expired', message: '二维码已过期，已刷新 (expired, refreshed)', loginUrl: this.current.loginUrl };
    }
    if (result.code === 802) {
      attempt.state = 'scanned';
      attempt.message = '已扫码，请在手机上确认 (scanned, confirm on phone)';
    } else if (result.done) {
      attempt.state = 'success';
      attempt.message = '登录成功 (signed in)';
      const account = this.api.account ?? (await this.api.fetchAccount().catch(() => null));
      this.store.setSession(this.api.jar.header(), account);
      this.logger?.info?.(`[music] QR login succeeded${account ? ` as ${account.nickname}` : ''}`);
      return { state: 'success', message: attempt.message, account };
    }

    return { state: attempt.state, message: attempt.message, loginUrl: attempt.loginUrl };
  }

  /** Serializable view for the panel and the agent-facing login tool. */
  snapshot() {
    if (!this.current) return { state: 'idle', message: '未开始 (not started)' };
    return {
      state: this.current.state,
      message: this.current.message,
      loginUrl: this.current.loginUrl,
      unikey: this.current.unikey,
      expiresAt: this.current.expiresAt,
      error: this.lastError,
    };
  }
}
