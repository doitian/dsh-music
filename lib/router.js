/**
 * HTTP surface for the music plugin.
 *
 * Everything the panel needs is served from one prefix (default `/music`):
 *
 *   GET  /music/panel                  the player page
 *   GET  /music/vendor/qrcode.js       vendored QR encoder (MIT)
 *   GET  /music/stream/<id>            audio bytes, Range-aware
 *   *    /music/api/*                  JSON API
 *
 * The audio route is a proxy rather than a redirect. Two reasons: the CDN URL
 * only lives 20 minutes and needs the session cookie at *resolution* time, and
 * proxying keeps playback same-origin so the page never mixes http and https.
 *
 * @module dsh-music/router
 */

import { Readable } from 'node:stream';

import { DEFAULT_LEVEL, LEVELS, isLevel } from './netease.js';

/** Resolved CDN URLs are reused for this long (they live 20 minutes). */
const URL_CACHE_MS = 15 * 60 * 1000;

/**
 * Version of the page/engine boundary, advertised on `/health`.
 *
 * Contract 2 moved playback out of the player page and into the client
 * plugin's always-mounted engine. A client bundle that does not see this value
 * stays out of the way, because a host predating it still serves a page that
 * owns its own `<audio>` — starting both would play every track twice.
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
   * @param {string} options.panelHtml
   * @param {string} options.qrcodeJs
   * @param {object} [options.config]
   * @param {() => Promise<object>} [options.listRoutes] curator routes for the picker.
   * @param {() => object} [options.diagnostics] extra facts for `/health`.
   * @param {{warn: Function, info: Function, debug: Function}} [options.logger]
   */
  constructor({ base, api, player, store, qr, dj, panelHtml, qrcodeJs, config = {}, listRoutes, diagnostics, logger }) {
    this.base = base.replace(/\/+$/, '');
    this.api = api;
    this.player = player;
    this.store = store;
    this.qr = qr;
    this.dj = dj;
    this.panelHtml = panelHtml;
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
  }

  /**
   * The level to stream at.
   *
   * The player's saved choice wins over the profile patch, matching how the
   * curator route resolves — a GUI choice should not be silently overridden.
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

  /** The panel's poll target: full player snapshot including account and DJ. */
  snapshot(extra = {}) {
    return {
      ...this.player.snapshot(),
      account: this.api.account,
      authenticated: this.api.authenticated,
      settings: this.store.settings,
      modelSource: this.modelSource(),
      /** Preferred quality, plus what the last stream request actually served. */
      audio: { preferred: this.preferredLevel(), last: this.lastAudio },
      ...extra,
    };
  }

  /** Where the live curator route came from. */
  modelSource() {
    const settings = this.store.settings;
    if (settings.djProvider || settings.djModel) return 'panel';
    if (this.config?.dj?.provider || this.config?.dj?.model) return 'config';
    return 'discovered';
  }

  /** Route one `/music/api/*` request. */
  async handleApi(req, res, pathname) {
    const route = pathname.slice(`${this.base}/api`.length).replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams;

    // ---- player state -----------------------------------------------------
    if (route === '/state' && method === 'GET') {
      return sendJson(res, 200, this.snapshot());
    }
    if (route === '/report' && method === 'POST') {
      const body = await readJson(req);
      this.player.report(body);
      return sendJson(res, 200, this.snapshot());
    }
    if (route === '/seek-consumed' && method === 'POST') {
      this.player.takeSeek();
      return sendJson(res, 200, this.snapshot());
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
      return sendJson(res, 200, this.snapshot());
    }

    // ---- queue ------------------------------------------------------------
    if (route === '/play' && method === 'POST') {
      const { tracks, startIndex } = await readJson(req);
      if (!Array.isArray(tracks) || tracks.length === 0) {
        return sendJson(res, 400, { error: 'tracks must be a non-empty array' });
      }
      this.player.setQueue(tracks, { startIndex, source: 'user' });
      this.store.recordPlay(this.player.current() ?? tracks[0]);
      return sendJson(res, 200, this.snapshot());
    }
    if (route === '/queue' && method === 'POST') {
      const { action, tracks, index } = await readJson(req);
      if (action === 'replace' && Array.isArray(tracks)) this.player.setQueue(tracks, { source: 'user' });
      else if (action === 'append' && Array.isArray(tracks)) this.player.append(tracks, { source: 'user' });
      else if (action === 'insert' && Array.isArray(tracks)) this.player.insertNext(tracks, { source: 'user' });
      else if (action === 'remove') this.player.remove(Number(index));
      else if (action === 'jump') this.player.jump(Number(index));
      else if (action === 'clear') this.player.clear();
      else return sendJson(res, 400, { error: `unknown queue action "${action}"` });
      return sendJson(res, 200, this.snapshot());
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
      return sendJson(res, 200, await this.api.lyric(id));
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

    // ---- feedback ---------------------------------------------------------
    if (route === '/feedback' && method === 'POST') {
      const { kind, trackId } = await readJson(req);
      if (!['likes', 'dislikes', 'skips'].includes(kind)) {
        return sendJson(res, 400, { error: `unknown feedback kind "${kind}"` });
      }
      this.store.recordFeedback(kind, trackId);
      return sendJson(res, 200, { feedback: this.store.feedback });
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
      this.logger?.info?.(`[music] streaming quality set to ${level} from the player`);
      // The running stream keeps its bytes; the next load or seek uses this.
      return sendJson(res, 200, this.snapshot());
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
          `[music] curator route set to ${this.dj.model.provider ?? '(none)'}/${this.dj.model.model ?? '(none)'} from the player`,
        );
      }
      if (prompt !== undefined) this.store.updateSettings({ djPrompt: String(prompt) });
      if (enabled !== undefined) this.dj.setEnabled(enabled);
      if (replan || (enabled && this.player.queue.length === 0)) {
        // Planning is slow; answer immediately and let the panel poll the result.
        void this.dj.topUp({ force: true });
      } else if (prompt !== undefined && this.player.dj.enabled) {
        void this.dj.topUp({ force: true });
      }
      return sendJson(res, 200, this.snapshot());
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
