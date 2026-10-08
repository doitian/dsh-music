/**
 * HTTP surface for the music plugin.
 *
 * Everything the panel needs is served from one prefix (default `/music`):
 *
 *   GET  /music/panel                  the player page
 *   GET  /music/playback.js            audio playback core, for the page and the engine
 *   GET  /music/vendor/qrcode.js       vendored QR encoder (MIT)
 *   GET  /music/stream/<id>            audio bytes, Range-aware
 *   GET  /music/api/events             the state as an event stream (see feed.js)
 *   *    /music/api/*                  JSON API
 *
 * The audio route is a proxy rather than a redirect. Two reasons: the CDN URL
 * only lives 20 minutes and needs the session cookie at *resolution* time, and
 * proxying keeps playback same-origin so the page never mixes http and https.
 *
 * Every state response annotates each queued track with its taste — `liked`
 * from the NetEase account, `disliked` from the local feedback — because that
 * is what the panel draws its hearts from. See {@link MusicRouter#snapshot}.
 *
 * @module dsh-music/router
 */

import { Readable } from 'node:stream';

import { TtlCache } from './cache.js';
import { SnapshotVersions, StateFeed } from './feed.js';
import { DEFAULT_LEVEL, LEVELS, isLevel } from './netease.js';
import { BOOST_DIRECTIONS, TASTE_LEVELS } from './session.js';

/** Resolved CDN URLs are reused for this long (they live 20 minutes). */
const URL_CACHE_MS = 15 * 60 * 1000;

/** Song details are kept this long: a wiki or an introduction is edited rarely. */
const INFO_TTL_MS = 6 * 60 * 60 * 1000;

/** Lyrics are kept a day: they are rarely corrected, and "instrumental" is an answer too. */
const LYRIC_TTL_MS = 24 * 60 * 60 * 1000;

/** A written introduction is kept longer: each one costs a model call. */
const INTRO_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Version of the page/engine boundary, advertised on `/health`.
 *
 * Contract 2 moved playback out of the player page and into the client
 * plugin's always-mounted engine. A client bundle that does not see this value
 * stays out of the way, because a host predating it still serves a page that
 * owns its own `<audio>` — starting both would play every track twice.
 *
 * The engine also runs this host's `/music/playback.js`, so the contract
 * covers that file's interface as well.
 */
const PANEL_CONTRACT = 2;

/** Response headers copied from the CDN, mapped to their canonical spelling. */
const FORWARDED_HEADERS = {
  'content-type': 'Content-Type',
  'content-length': 'Content-Length',
  'content-range': 'Content-Range',
  'cache-control': 'Cache-Control',
  'etag': 'ETag',
  'last-modified': 'Last-Modified',
};

/**
 * HTTP status for a refused taste change, so the panel can tell "sign in" from
 * "NetEase refused" from "the network is down" without parsing a sentence.
 */
const TASTE_STATUS = {
  BAD_ID: 400,
  ANONYMOUS: 401,
  NETWORK: 502,
};

/** A small JSON/HTTP helper set. */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value ?? null), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length });
  res.end(body);
}

/** Read and parse a JSON request body, bounded. */
async function readJson(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid JSON body');
  }
}

export class MusicRouter {
  /**
   * @param {object} options
   * @param {string} options.base route prefix, e.g. `/music`.
   * @param {import('./netease.js').Netease} options.api
   * @param {import('./state.js').Player} options.player
   * @param {import('./session.js').SessionStore} options.store
   * @param {import('./session.js').QrLogin} options.qr
   * @param {import('./dj.js').AiDj} options.dj
   * @param {import('./likes.js').LikeState} options.likes
   * @param {string} options.panelHtml
   * @param {string} options.playbackJs
   * @param {string} options.qrcodeJs
   * @param {object} [options.config]
   * @param {() => Promise<object>} [options.listRoutes] model routes for the picker.
   * @param {() => object} [options.diagnostics] extra facts for `/health`.
   * @param {{warn: Function, info: Function, debug: Function}} [options.logger]
   */
  constructor({ base, api, player, store, qr, dj, likes, scrobbler, panelHtml, playbackJs, qrcodeJs, config = {}, listRoutes, diagnostics, logger }) {
    this.base = base.replace(/\/+$/, '');
    this.api = api;
    this.player = player;
    this.store = store;
    this.qr = qr;
    this.dj = dj;
    this.scrobbler = scrobbler;
    this.likes = likes;
    this.panelHtml = panelHtml;
    this.playbackJs = playbackJs;
    this.qrcodeJs = qrcodeJs;
    this.config = config;
    this.listRoutes = listRoutes;
    this.diagnostics = diagnostics;
    this.logger = logger;
    /** @type {Map<string, {url: string, payload: object, expiresAt: number}>} */
    this.urlCache = new Map();
    /** In-flight audio resolutions, so parallel Range requests share one call. */
    this.pendingUrls = new Map();
    /** What the last stream request actually resolved, for the UI and health. */
    this.lastAudio = null;
    /** Song details for the panel, which barely change; each costs up to six requests. */
    this.infoCache = new TtlCache({ maxEntries: 200 });
    /** Lyrics, so the panel's prefetch of the next track's costs nothing when it plays. */
    this.lyricCache = new TtlCache({ maxEntries: 200 });
    /** Model-written introductions, per track and language. */
    this.introCache = new TtlCache({ maxEntries: 400 });
    this.versions = new SnapshotVersions();
    this.feed = new StateFeed({ snapshot: () => this.snapshot(), logger });
    /** The current track, next track and level last pre-resolved, so a position report does not repeat it. */
    this.audioPrefetchKey = null;
    this.unsubscribe = player.subscribe(() => {
      this.feed.changed();
      this.prefetchNextAudio();
    });
    this.prefetchNextAudio();
  }

  /** Close the event streams; the route is being withdrawn. */
  dispose() {
    this.unsubscribe();
    this.feed.close();
  }

  /** A song's details, shared by the details pane and the introduction written from them. */
  songInfo(id) {
    return this.infoCache.get(`info:${id}`, INFO_TTL_MS, () => this.api.songInfo(id));
  }

  /**
   * The level to stream at.
   *
   * The player's saved choice wins over the profile patch, matching how the
   * DJ's model route resolves — a GUI choice should not be silently overridden.
   * An unknown value falls back rather than failing a request.
   */
  preferredLevel() {
    const asked = this.store.settings.level || this.config.audioLevel || DEFAULT_LEVEL;
    return isLevel(asked) ? asked : DEFAULT_LEVEL;
  }

  /** The levels the player may choose, with labels. */
  levelChoices() {
    return { levels: LEVELS, preferred: this.preferredLevel() };
  }

  // ------------------------------------------------------------------ audio

  /**
   * Resolve the next track's CDN URL while this one plays, so a track change
   * skips that round trip. Only in list mode: shuffle has no known next track,
   * and repeat-one's next is this one. Runs whether or not the panel is open.
   */
  prefetchNextAudio() {
    const current = this.player.current();
    const next = this.player.mode === 'list'
      ? this.player.queue[(this.player.index + 1) % this.player.queue.length]
      : null;
    if (!this.player.playing || !current || !next || next.id === current.id) {
      this.audioPrefetchKey = null;
      return;
    }
    const level = this.preferredLevel();
    const key = `${current.id}:${next.id}:${level}`;
    if (this.audioPrefetchKey === key) return;
    this.audioPrefetchKey = key;
    // Keep speculative failures out of playback diagnostics and avoid retrying on every report.
    void Promise.resolve().then(() => this.resolveAudio(next.id, level)).catch(() => {});
  }

  /**
   * Resolve (and cache) the signed CDN URL for one track at one level.
   *
   * Keyed by level as well as id: the same track at two qualities is two
   * different files, and serving one while the browser expects the other would
   * corrupt the byte stream it is range-requesting.
   */
  async resolveAudio(id, level = this.preferredLevel()) {
    const key = `${id}:${level}`;
    const cached = this.urlCache.get(key);
    // The cache holds a record; callers get the resolution payload itself.
    if (cached && cached.expiresAt > Date.now()) return cached.payload;
    if (this.pendingUrls.has(key)) return this.pendingUrls.get(key);
    const pending = this.api
      .songUrl(id, { level })
      .then((resolved) => {
        if (resolved.ok) {
          this.urlCache.set(key, {
            url: resolved.url,
            payload: resolved,
            expiresAt: Date.now() + Math.min(resolved.expiresInMs, URL_CACHE_MS),
          });
        }
        return resolved;
      })
      .finally(() => this.pendingUrls.delete(key));
    this.pendingUrls.set(key, pending);
    return pending;
  }

  /**
   * Stream one track's bytes, forwarding the browser's Range header upstream so
   * seeking works and the browser can buffer progressively.
   *
   * `?level=` names the quality. It is part of the URL rather than implicit
   * state so that changing the preference yields a different resource: the
   * browser then loads a fresh file instead of range-requesting offsets of one
   * encoding against another.
   */
  async handleStream(req, res, id, level) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    const trackId = Number(id);
    if (!Number.isFinite(trackId)) {
      sendJson(res, 400, { error: 'invalid track id' });
      return;
    }
    const requestedLevel = isLevel(level) ? level : this.preferredLevel();

    let resolved;
    try {
      resolved = await this.resolveAudio(trackId, requestedLevel);
    } catch (error) {
      this.logger?.warn?.(`[music] could not resolve audio for ${trackId}: ${error.message}`);
      sendJson(res, 502, { error: `could not resolve audio: ${error.message}` });
      return;
    }
    if (!resolved.ok) {
      // 403 tells the panel this is an entitlement problem, not a transient one.
      this.lastAudio = {
        trackId,
        requested: requestedLevel,
        served: null,
        downgraded: false,
        error: resolved.reason,
        at: Date.now(),
      };
      this.feed.changed();
      sendJson(res, 403, { error: `track ${trackId} is ${resolved.reason}`, code: resolved.code });
      return;
    }

    // Recorded here rather than at resolution time, so a cache hit still
    // reports what is actually being served — otherwise switching back to a
    // cached level would leave the UI describing the previous one.
    this.lastAudio = {
      trackId,
      requested: requestedLevel,
      served: resolved.level,
      downgraded: resolved.downgraded,
      br: resolved.br,
      type: resolved.type,
      size: resolved.size,
      at: Date.now(),
    };
    this.feed.changed();

    let upstream;
    try {
      upstream = await this.api.fetchAudio(resolved.url, {
        range: req.headers.range,
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      });
    } catch (error) {
      this.urlCache.delete(`${trackId}:${requestedLevel}`);
      sendJson(res, 502, { error: `CDN request failed: ${error.message}` });
      return;
    }

    // A CDN miss expiry can still answer 403/404; drop the cache so the next
    // attempt re-resolves instead of serving a dead URL.
    if (upstream.status === 403 || upstream.status === 404) {
      this.urlCache.delete(`${trackId}:${requestedLevel}`);
    }

    const headers = { 'Accept-Ranges': 'bytes' };
    for (const [lower, canonical] of Object.entries(FORWARDED_HEADERS)) {
      const value = upstream.headers.get(lower);
      if (value) headers[canonical] = value;
    }
    if (!headers['Content-Type']) headers['Content-Type'] = 'audio/mpeg';

    res.writeHead(upstream.status, headers);
    if (req.method === 'HEAD' || !upstream.body) {
      res.end();
      return;
    }
    try {
      await new Promise((resolve, reject) => {
        const source = Readable.fromWeb(upstream.body);
        source.on('error', reject);
        res.on('error', reject);
        res.on('close', () => source.destroy());
        source.pipe(res);
        res.on('finish', resolve);
      });
    } catch (error) {
      this.logger?.debug?.(`[music] stream ended early for ${trackId}: ${error.message}`);
      res.destroy();
    }
  }

  // -------------------------------------------------------------------- API

  /**
   * Resolve the like state of everything the panel is about to draw.
   *
   * A like is the account's, so this is a network read — but a cached one: only
   * tracks with no fresh answer cost a call, which after the first poll of a
   * queue is normally none of them.
   */
  async refreshLikes() {
    const ids = [this.player.current()?.id, ...this.player.queue.map((track) => track.id)].filter(Boolean);
    if (ids.length > 0) await this.likes.ensure(ids);
  }

  /**
   * One track as the panel needs it: the metadata plus its taste.
   *
   * `liked` is the account's answer (cached, see {@link LikeState}) and
   * `disliked` is the local level. They are two values of one three-level
   * taste, never both true: liking a disliked track clears the dislike and
   * disliking a liked track removes it on NetEase.
   */
  tasteView(track) {
    if (!track) return null;
    return {
      ...track,
      liked: this.likes.isLiked(track.id),
      disliked: this.store.taste(track.id) === 'disliked',
      /** A temporary "more/less like this", or null. */
      boost: this.store.boostOf(track.id),
    };
  }

  /**
   * Boost a track for a while, or clear its boost, and let the DJ act on it now.
   *
   * The track is looked up in the queue first, so the boost can name it without
   * a request; one that is not queued is resolved through NetEase.
   *
   * @returns {Promise<{ok: boolean, status?: number, reason?: string, boost?: object|null, effect?: object}>}
   */
  async applyBoost(trackId, direction, minutes) {
    const id = Number(trackId);
    if (!Number.isFinite(id)) return { ok: false, status: 400, reason: `invalid track id "${trackId}"` };
    if (direction !== 'none' && !BOOST_DIRECTIONS.includes(direction)) {
      return { ok: false, status: 400, reason: `unknown boost "${direction}" (expected more, less or none)` };
    }
    const track =
      this.player.queue.find((entry) => entry.id === id) ??
      (await this.api.songDetail([id]).then((found) => found[0]).catch(() => null));
    if (!track) return { ok: false, status: 404, reason: `track ${id} not found` };
    const boost = this.store.setBoost(track, direction, minutes);
    const effect = await this.dj.applyBoost(track, direction).catch(() => ({ queued: 0, removed: 0 }));
    this.player.bump();
    return { ok: true, boost, effect };
  }

  /**
   * What the panel and the engine read and are pushed: the full player
   * snapshot, including account and DJ.
   *
   * Async because `liked` is NetEase's answer rather than the host's: the queued
   * tracks' like state is resolved (once, then cached) before the document is
   * written, so a heart never lags a poll behind the track it belongs to.
   *
   * Every answer carries a `version` (see {@link SnapshotVersions}), stamped
   * once the snapshot is complete, so the clients can tell which of two
   * answers is newer.
   */
  async snapshot(extra = {}) {
    await this.refreshLikes();
    const base = this.player.snapshot();
    const snapshot = this.versions.stamp({
      ...base,
      queue: base.queue.map((track) => this.tasteView(track)),
      current: this.tasteView(base.current),
      /** Boosts still in force, newest first, with when each ends. */
      boosts: this.store.activeBoosts(),
      account: this.api.account,
      authenticated: this.api.authenticated,
      settings: this.store.settings,
      modelSource: this.modelSource(),
      /** Whether plays reach the NetEase listening history, for the player's switch. */
      scrobble: this.scrobbler?.status() ?? null,
      /** Preferred quality, plus what the last stream request actually served. */
      audio: { preferred: this.preferredLevel(), last: this.lastAudio },
    });
    return { ...snapshot, ...extra };
  }

  /** Where the DJ's model route comes from. */
  modelSource() {
    const settings = this.store.settings;
    if (settings.djProvider || settings.djModel) return 'panel';
    if (this.config?.dj?.provider || this.config?.dj?.model) return 'config';
    // Nothing pinned: the DJ follows the session's own model when the
    // deployment publishes one, and falls back to discovery when it does not.
    if (this.dj.sessionModel?.()) return 'agent-default';
    return 'discovered';
  }

  /**
   * Move one track to a taste level, keeping the account and the local mirror
   * in step.
   *
   * The NetEase half is written first: a level that claimed a like the account
   * never received would be contradicted by the next poll's heart. Removing a
   * like is therefore a real request, which is why a track the account has not
   * liked can be cleared locally without one.
   *
   * @param {number|string} trackId
   * @param {'liked'|'none'|'disliked'} level
   * @returns {Promise<{ok: boolean, id?: number, level?: string, status?: number, code?: string, reason?: string}>}
   */
  async applyTaste(trackId, level) {
    const id = Number(trackId);
    if (!Number.isFinite(id)) {
      return { ok: false, status: 400, code: 'BAD_ID', reason: `invalid track id "${trackId}"` };
    }
    if (!TASTE_LEVELS.includes(level)) {
      return {
        ok: false,
        status: 400,
        code: 'BAD_LEVEL',
        reason: `unknown taste level "${level}" (expected ${TASTE_LEVELS.join(', ')})`,
      };
    }

    // Any level but `liked` means the account must not still have the like —
    // including `disliked`, because the two are exclusive. A track with no
    // cached answer is resolved first, so the two levels cannot both end up
    // true; an anonymous session has nothing to resolve and skips the call.
    if (level !== 'liked' && !this.likes.known(id)) await this.likes.ensure([id]);
    if (level !== 'liked' && this.likes.isLiked(id)) {
      const removed = await this.likes.set(id, false);
      if (!removed.ok) return { ok: false, status: TASTE_STATUS[removed.code] ?? 502, code: removed.code, reason: removed.reason };
    }
    if (level === 'liked') {
      const added = await this.likes.set(id, true);
      if (!added.ok) return { ok: false, status: TASTE_STATUS[added.code] ?? 502, code: added.code, reason: added.reason };
    }

    this.store.setTaste(id, level);
    // A disliked track leaves the queue wherever it sits — the playing one
    // too, which moves playback on to the next. Every dislike comes through
    // here, so the transport's ✕, the legacy feedback route and a row removal
    // all agree, and the page no longer presses next on top of it.
    if (level === 'disliked') {
      const at = this.player.queue.findIndex((track) => track.id === id);
      if (at >= 0) this.player.remove(at);
    }
    return { ok: true, id, level };
  }

  /**
   * Start a queue action and report the track it acts on.
   *
   * Only `jump` and `remove` name a position, and only `remove` is read as a
   * judgement about the track — see {@link MusicRouter#removeFromQueue}. The two
   * share this so the index is resolved the same way, and so a track is never
   * re-read from a queue it has already left.
   *
   * @returns {{track: object|null, wasCurrent: boolean, dropped: boolean}}
   */
  #queueAction(action, index) {
    const at = Number(index);
    const track = Number.isInteger(at) ? (this.player.queue[at] ?? null) : null;
    if (action === 'remove') return { ...this.player.removeAt(at), dropped: Boolean(track) };
    this.player.jump(at);
    return { track, wasCurrent: false, dropped: false };
  }

  /**
   * Take one track out of the queue, and read that as a dislike of it.
   *
   * Removing a queued track is the listener saying "not this one", and the row
   * is gone afterwards — so the judgement has to be recorded now or not at all.
   * Without it the DJ re-derives the same track from the same similarity and
   * charts within a batch or two, which is what "removing does nothing" looks
   * like from the outside.
   *
   * Two edges are deliberate. A track already rated does not get its level
   * changed, because `remove` is often just queue housekeeping — clearing out
   * music already heard — and silently rewriting a like would be worse than
   * missing a signal. And a *failed* dislike write never comes back to the
   * panel as a failed removal: the queue action is what the click asked for, and
   * the taste write is a consequence of it.
   *
   * @param {object|null} track the track that was removed.
   * @param {boolean} wasCurrent whether it was the playing one.
   * @returns {Promise<object|null>} the applied level, or null when nothing was.
   */
  async removeFromQueue(track, wasCurrent) {
    if (!track) return null;
    if (this.store.taste(track.id) !== 'none') return null;
    const applied = await this.applyTaste(track.id, 'disliked');
    if (applied.ok) return applied;
    this.logger?.debug?.(`[music] track ${track.id} removed but not marked disliked: ${applied.reason}`);
    // The track left the queue and it was the one playing, so playback has
    // nowhere to go. A disliked track auto-advances; a removal must too.
    if (wasCurrent) this.player.move(1, { auto: true });
    return null;
  }

  /** Route one `/music/api/*` request. */
  async handleApi(req, res, pathname) {
    const route = pathname.slice(`${this.base}/api`.length).replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams;

    // ---- player state -----------------------------------------------------
    if (route === '/state' && method === 'GET') {
      return sendJson(res, 200, await this.snapshot());
    }
    if (route === '/events' && method === 'GET') {
      return this.feed.attach(req, res);
    }
    if (route === '/report' && method === 'POST') {
      const body = await readJson(req);
      this.player.report(body);
      return sendJson(res, 200, await this.snapshot());
    }
    if (route === '/seek-consumed' && method === 'POST') {
      this.player.takeSeek();
      return sendJson(res, 200, await this.snapshot());
    }
    if (route === '/control' && method === 'POST') {
      const { action, value } = await readJson(req);
      switch (action) {
        case 'play': this.player.setPlaying(true); break;
        case 'pause': this.player.setPlaying(false); break;
        case 'toggle': this.player.toggle(); break;
        case 'next': this.player.move(1); break;
        case 'previous': this.player.move(-1); break;
        case 'seek': this.player.seek(value); break;
        case 'volume': this.player.setVolume(value); break;
        case 'mute': this.player.setMuted(value); break;
        case 'mode': this.player.setMode(value); break;
        default: return sendJson(res, 400, { error: `unknown action "${action}"` });
      }
      return sendJson(res, 200, await this.snapshot());
    }

    // ---- queue ------------------------------------------------------------
    if (route === '/play' && method === 'POST') {
      const { tracks, startIndex } = await readJson(req);
      if (!Array.isArray(tracks) || tracks.length === 0) {
        return sendJson(res, 400, { error: 'tracks must be a non-empty array' });
      }
      this.player.setQueue(tracks, { startIndex, source: 'user' });
      return sendJson(res, 200, await this.snapshot());
    }
    if (route === '/queue' && method === 'POST') {
      const { action, tracks, index, keepCurrent } = await readJson(req);
      let removal = null;
      if (action === 'replace' && Array.isArray(tracks)) this.player.setQueue(tracks, { source: 'user' });
      else if (action === 'append' && Array.isArray(tracks)) this.player.append(tracks, { source: 'user' });
      else if (action === 'insert' && Array.isArray(tracks)) this.player.insertNext(tracks, { source: 'user' });
      else if (action === 'remove' || action === 'jump') removal = this.#queueAction(action, index);
      else if (action === 'clear') {
        // Unlike `remove`, clearing is housekeeping, not a judgement: nothing is rated.
        if (keepCurrent) this.player.clearKeepingCurrent();
        else this.player.clear();
        this.player.requestExtension();
      } else return sendJson(res, 400, { error: `unknown queue action "${action}"` });
      // Answer with the queue as it now stands, but record the judgement first:
      // the snapshot's hearts should already show it.
      if (removal?.dropped && removal.wasCurrent) await this.removeFromQueue(removal.track, true);
      else if (removal?.dropped) void this.removeFromQueue(removal.track, false);
      return sendJson(res, 200, await this.snapshot());
    }

    // ---- catalogue --------------------------------------------------------
    if (route === '/search' && method === 'GET') {
      const keyword = (query.get('q') ?? '').trim();
      if (!keyword) return sendJson(res, 400, { error: 'missing q' });
      const limit = Math.min(Math.max(Number(query.get('limit')) || 30, 1), 100);
      const result = await this.api.searchSongs(keyword, { limit });
      result.tracks = await this.api.withCovers(result.tracks);
      return sendJson(res, 200, result);
    }
    if (route.startsWith('/track/') && method === 'GET') {
      const id = Number(route.slice('/track/'.length));
      const [track] = await this.api.songDetail([id]);
      if (!track) return sendJson(res, 404, { error: `track ${id} not found` });
      return sendJson(res, 200, { track });
    }
    if (route.startsWith('/lyric/') && method === 'GET') {
      const id = Number(route.slice('/lyric/'.length));
      if (!Number.isInteger(id) || id <= 0) return sendJson(res, 400, { error: 'invalid track id' });
      const lyric = await this.lyricCache.get(`lyric:${id}`, LYRIC_TTL_MS, () => this.api.lyric(id));
      return sendJson(res, 200, lyric);
    }
    if (route.startsWith('/info/') && method === 'GET') {
      const id = Number(route.slice('/info/'.length));
      if (!Number.isInteger(id) || id <= 0) return sendJson(res, 400, { error: 'invalid track id' });
      return sendJson(res, 200, await this.songInfo(id));
    }
    /**
     * A model-written introduction to the song. Always 200: with no model, or a
     * failed one, `text` is empty and the panel shows NetEase's own prose. Only
     * a written one is cached, so a model set up later is used at once.
     */
    if (route.startsWith('/intro/') && method === 'GET') {
      const id = Number(route.slice('/intro/'.length));
      if (!Number.isInteger(id) || id <= 0) return sendJson(res, 400, { error: 'invalid track id' });
      const lang = query.get('lang') === 'zh' ? 'zh' : 'en';
      try {
        const intro = await this.introCache.get(`intro:${id}:${lang}`, INTRO_TTL_MS, async () => {
          const written = await this.dj.introduce(await this.songInfo(id), { lang });
          if (!written) throw new Error('no model route is available');
          return written;
        });
        return sendJson(res, 200, intro);
      } catch (error) {
        this.logger?.debug?.(`[music] no introduction for ${id}: ${error.message}`);
        return sendJson(res, 200, { text: '', reason: error.message });
      }
    }
    if (route === '/charts' && method === 'GET') {
      return sendJson(res, 200, await this.api.toplists());
    }
    if (route === '/playlists' && method === 'GET') {
      return sendJson(res, 200, await this.api.personalizedPlaylists(12));
    }
    if (route === '/new' && method === 'GET') {
      const tracks = await this.api.personalizedNewsongs(20);
      return sendJson(res, 200, await this.api.withCovers(tracks));
    }
    if (route.startsWith('/playlist/') && method === 'GET') {
      const id = Number(route.slice('/playlist/'.length));
      const playlist = await this.api.playlistDetail(id);
      return sendJson(res, 200, {
        id: playlist.id,
        name: playlist.name,
        cover: playlist.cover,
        tracks: await this.api.withCovers(playlist.tracks),
      });
    }

    // ---- taste ------------------------------------------------------------
    /**
     * Move one track to a taste level: `liked`, `none` (the like removed), or
     * `disliked`.
     *
     * One endpoint rather than a like/unlike pair, because the three levels are
     * exclusive states of one thing: the panel always says which level it wants,
     * so a click cannot be turned into the wrong direction by a stale poll, and
     * disliking a liked track is one request rather than two racing ones.
     */
    /**
     * A temporary push on the DJ: `direction` is `more` or `less` for an hour
     * (or `minutes`), and `none` clears it. Unlike a taste level it expires on
     * its own.
     */
    /**
     * The player's listening-history switch. The choice is saved and beats
     * `config.scrobble`, so a stale profile setting cannot override it.
     */
    if (route === '/scrobble' && method === 'POST') {
      const { enabled } = await readJson(req);
      if (typeof enabled !== 'boolean') return sendJson(res, 400, { error: 'enabled must be true or false' });
      this.store.updateSettings({ scrobble: enabled });
      if (this.scrobbler) this.scrobbler.enabled = enabled;
      this.logger?.info?.(`[music] listening history ${enabled ? 'on' : 'off'} from the player`);
      return sendJson(res, 200, await this.snapshot());
    }

    if (route === '/boost' && method === 'POST') {
      const { trackId, direction, minutes } = await readJson(req);
      const applied = await this.applyBoost(trackId, direction, minutes);
      if (!applied.ok) return sendJson(res, applied.status ?? 502, { error: applied.reason });
      return sendJson(res, 200, await this.snapshot({ boostEffect: applied.effect }));
    }

    if (route === '/taste' && method === 'POST') {
      const { trackId, level } = await readJson(req);
      const applied = await this.applyTaste(trackId, level);
      if (!applied.ok) return sendJson(res, applied.status ?? 502, { error: applied.reason, code: applied.code });
      return sendJson(res, 200, await this.snapshot());
    }

    // ---- feedback ---------------------------------------------------------
    /**
     * The local taste signals: skips, and dislikes, plus the older toggle
     * spelling of a like. Kept because a page cached from an earlier build
     * still reaches for it.
     */
    if (route === '/feedback' && method === 'POST') {
      const { kind, trackId } = await readJson(req);
      if (kind === 'skips') {
        this.store.recordFeedback(kind, trackId);
        return sendJson(res, 200, await this.snapshot());
      }
      if (kind === 'likes' || kind === 'dislikes') {
        const level = kind === 'likes' ? 'liked' : 'disliked';
        const applied = await this.applyTaste(trackId, this.store.taste(trackId) === level ? 'none' : level);
        if (!applied.ok) return sendJson(res, applied.status ?? 502, { error: applied.reason, code: applied.code });
        return sendJson(res, 200, await this.snapshot());
      }
      return sendJson(res, 400, { error: `unknown feedback kind "${kind}"` });
    }

    // ---- streaming quality ------------------------------------------------
    if (route === '/quality' && method === 'GET') {
      return sendJson(res, 200, { ...this.levelChoices(), last: this.lastAudio });
    }
    if (route === '/quality' && method === 'POST') {
      const { level } = await readJson(req);
      if (!isLevel(level)) {
        return sendJson(res, 400, {
          error: `unknown level "${level}"`,
          levels: LEVELS.map((entry) => entry.id),
        });
      }
      this.store.updateSettings({ level });
      this.prefetchNextAudio();
      this.logger?.info?.(`[music] streaming quality set to ${level} from the player`);
      // The running stream keeps its bytes; the next load or seek uses this.
      return sendJson(res, 200, await this.snapshot());
    }

    // ---- AI DJ ------------------------------------------------------------
    if (route === '/dj/models' && method === 'GET') {
      const listed = this.listRoutes ? await this.listRoutes() : { routes: [], error: 'no model service is mounted' };
      return sendJson(res, 200, {
        ...listed,
        selected: { provider: this.dj.model.provider ?? null, model: this.dj.model.model ?? null },
        source: this.modelSource(),
        /** The patch's pin, so the picker can offer "revert". */
        configured: {
          provider: this.config?.dj?.provider ?? null,
          model: this.config?.dj?.model ?? null,
        },
      });
    }
    if (route === '/dj/test' && method === 'POST') {
      // One throwaway plan: the candidate pool is real, but nothing is queued,
      // so the picker can answer "does this route actually work?" safely.
      const plan = await this.dj.plan({ prompt: this.store.settings.djPrompt ?? '', count: 1 });
      return sendJson(res, 200, {
        source: plan.source,
        route: plan.route ?? null,
        modelError: this.dj.modelError,
        note: plan.note ?? null,
        vibe: plan.vibe ?? null,
        picked: plan.tracks.map((track) => `${track.name} — ${(track.artists ?? []).join('/')}`),
      });
    }
    if (route === '/dj' && method === 'POST') {
      const { enabled, prompt, replan, provider, model } = await readJson(req);

      if (provider !== undefined || model !== undefined) {
        const nextProvider = provider === undefined ? this.store.settings.djProvider : String(provider ?? '');
        const nextModel = model === undefined ? this.store.settings.djModel : String(model ?? '');
        this.store.updateSettings({ djProvider: nextProvider, djModel: nextModel });
        // Empty means "no choice made here", which reverts to the patch pin.
        const configured = this.config?.dj ?? {};
        this.dj.setModel({
          provider: nextProvider || configured.provider || null,
          model: nextModel || configured.model || null,
        });
        this.logger?.info?.(
          `[music] DJ model route set to ${this.dj.model.provider ?? '(none)'}/${this.dj.model.model ?? '(none)'} from the player`,
        );
      }
      if (prompt !== undefined) this.dj.setPrompt(prompt);
      if (enabled !== undefined) this.dj.setEnabled(enabled);
      if (replan || (enabled && this.player.queue.length === 0)) {
        // Planning is slow; answer immediately, and the plan is pushed when it lands.
        void this.dj.topUp({ force: true });
      } else if (prompt !== undefined && this.player.dj.enabled) {
        void this.dj.topUp({ force: true });
      }
      return sendJson(res, 200, await this.snapshot());
    }

    // ---- login ------------------------------------------------------------
    if (route === '/login/qr' && method === 'POST') {
      const attempt = await this.qr.start();
      return sendJson(res, 200, { ...attempt, loggedIn: this.api.authenticated });
    }
    if (route === '/login/poll' && method === 'POST') {
      const result = await this.qr.poll();
      return sendJson(res, 200, { ...result, loggedIn: this.api.authenticated, account: this.api.account });
    }
    if (route === '/login/cookie' && method === 'POST') {
      const { cookie } = await readJson(req);
      if (!cookie || typeof cookie !== 'string') return sendJson(res, 400, { error: 'missing cookie' });
      this.api.setCookie(cookie.trim());
      const account = await this.api.fetchAccount().catch(() => null);
      if (!account) {
        return sendJson(res, 400, { error: 'the cookie did not yield an account (expired or malformed?)' });
      }
      this.store.setSession(this.api.jar.header(), account);
      return sendJson(res, 200, { account, loggedIn: true });
    }
    if (route === '/login/logout' && method === 'POST') {
      this.api.clearCookie();
      this.store.clearSession();
      // The likes belong to the account that just left, not to the next one.
      this.likes.clear();
      this.qr.reset();
      return sendJson(res, 200, { loggedIn: false });
    }
    if (route === '/login/status' && method === 'GET') {
      const account = this.api.authenticated ? await this.api.fetchAccount().catch(() => null) : null;
      return sendJson(res, 200, { loggedIn: Boolean(account), account, qr: this.qr.snapshot() });
    }

    return sendJson(res, 404, { error: `unknown endpoint ${route}` });
  }

  /**
   * Top-level dispatcher for every request under the configured prefix.
   * @returns {Promise<boolean>} whether the request was handled.
   */
  async handle(req, res) {
    const parsed = new URL(req.url ?? '/', 'http://localhost');
    const pathname = parsed.pathname;
    const query = parsed.searchParams;
    if (pathname !== this.base && !pathname.startsWith(`${this.base}/`)) return false;

    try {
      const rest = pathname.slice(this.base.length);

      if (rest === '' || rest === '/' || rest === '/panel' || rest === '/panel/') {
        const html = this.panelHtml.replaceAll('__BASE__', this.base);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(html);
        return true;
      }
      if (rest === '/playback.js') {
        // Never cached: the page and the engine must run the copy this host
        // was read with, not one left over from an earlier generation.
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(this.playbackJs);
        return true;
      }
      if (rest === '/vendor/qrcode.js') {
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(this.qrcodeJs);
        return true;
      }
      if (rest === '/health') {
        sendJson(res, 200, {
          ok: true,
          prefix: this.base,
          panelContract: PANEL_CONTRACT,
          audio: { preferred: this.preferredLevel(), last: this.lastAudio },
          authenticated: this.api.authenticated,
          account: this.api.account,
          playing: this.player.playing,
          queued: this.player.queue.length,
          /** Open `/api/events` streams: the engine's, plus the page's while it is shown. */
          eventStreams: this.feed.clients.size,
          ...(this.diagnostics ? this.diagnostics() : {}),
        });
        return true;
      }
      if (rest.startsWith('/stream/')) {
        await this.handleStream(req, res, rest.slice('/stream/'.length), query.get('level'));
        return true;
      }
      if (rest.startsWith('/api/')) {
        await this.handleApi(req, res, pathname);
        // Not every write goes through the player: settings, the session and
        // the like cache change behind it, so any write is worth a comparison.
        if (req.method !== 'GET') this.feed.changed();
        return true;
      }
      sendJson(res, 404, { error: `not found: ${pathname}` });
      return true;
    } catch (error) {
      this.logger?.warn?.(`[music] request ${pathname} failed: ${error.stack ?? error.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: error.message });
      else res.destroy();
      return true;
    }
  }
}

export { sendJson, sendText, readJson, PANEL_CONTRACT };
