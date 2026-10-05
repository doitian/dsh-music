/**
 * Minimal, dependency-free client for the NetEase Cloud Music (music.163.com)
 * web API.
 *
 * Only the plain (non-`weapi`/`eapi`) endpoints are used: they need no request
 * encryption and work with a normal browser session cookie. Authentication
 * upgrades the client from anonymous browsing to personal recommendations and
 * VIP song URLs; everything else works without it.
 *
 * Verified against the live API:
 *   - `api/search/get/web`            anonymous OK
 *   - `api/song/enhance/player/url`   anonymous OK for fee=8, `url: null` for fee=1 (VIP)
 *   - `api/v6/playlist/detail`        anonymous OK
 *   - `api/toplist`                   anonymous OK
 *   - `api/discovery/simiSong`        anonymous OK
 *   - `api/personalized/newsong`      anonymous OK
 *   - `api/song/like`                 POST: like / un-like, needs a session
 *   - `api/song/like/check`           which of these ids the account liked
 *   - `api/login/qrcode/*`            QR login handshake
 *
 * @module dsh-music/netease
 */

/** Hosts used by the public web client. */
const API_ORIGIN = 'https://music.163.com';

/** A desktop-browser UA; NetEase serves different shapes to unknown agents. */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * NetEase `fee` codes seen in track payloads.
 * 0 = free, 1 = VIP only, 4 = paid album, 8 = free but high-quality needs VIP.
 * Anonymous callers still receive a stream for most `fee=8` tracks.
 */
const FEE = { FREE: 0, VIP: 1, ALBUM: 4, LIMITED: 8 };

/**
 * Requestable audio levels, richest first.
 *
 * Order matters: it is the downgrade ladder. NetEase refuses a level per track
 * (`code -110` for the object-audio tiers, `url: null` when a track has no
 * lossless master), and several of the richer ids resolve to the same Hi-Res
 * stream, so a refusal walks down this list until something plays.
 *
 * Measured on a VIP account: `hires` served FLAC at ~1677–1785 kbps,
 * `lossless` ~908–1016 kbps, and the rest 320/192/128 kbps MP3.
 */
export const LEVELS = [
  { id: 'jymaster', label: '超清母带 / Master', kind: 'flac' },
  { id: 'dolby', label: '杜比全景声 / Dolby Atmos', kind: 'flac' },
  { id: 'sky', label: '沉浸环绕声 / Immersive', kind: 'flac' },
  { id: 'jyeffect', label: '沉浸声 / Spatial', kind: 'flac' },
  { id: 'hires', label: 'Hi-Res 无损 / Hi-Res lossless', kind: 'flac' },
  { id: 'lossless', label: '无损 / Lossless', kind: 'flac' },
  { id: 'exhigh', label: '极高 / 320 kbps', kind: 'mp3' },
  { id: 'higher', label: '较高 / 192 kbps', kind: 'mp3' },
  { id: 'standard', label: '标准 / 128 kbps', kind: 'mp3' },
];

/** The default level, matching NetEase's own web player. */
export const DEFAULT_LEVEL = 'exhigh';

/** Whether a string names a level this client knows. */
export function isLevel(value) {
  return LEVELS.some((entry) => entry.id === value);
}

/** Raised for a request the API answered with a non-success business code. */
export class NeteaseError extends Error {
  constructor(message, { code, endpoint, payload } = {}) {
    super(message);
    this.name = 'NeteaseError';
    this.code = code;
    this.endpoint = endpoint;
    this.payload = payload;
  }
}

/**
 * A small cookie store good enough for one NetEase web session.
 *
 * NetEase sets `MUSIC_U` on the QR-login success response; that cookie alone
 * carries the account, so persistence is just serialising this map.
 */
export class CookieJar {
  /** @type {Map<string, string>} */
  #map = new Map();

  constructor(initial) {
    if (initial) this.load(initial);
  }

  /** Merge a `Cookie:` header string. Existing names are overwritten. */
  load(header) {
    for (const part of String(header ?? '').split(';')) {
      const match = /^\s*([^=;]+)=([^;]*)\s*$/.exec(part);
      if (match) this.#map.set(match[1], match[2]);
    }
    return this;
  }

  /** Merge every `Set-Cookie` header a response carried. */
  absorb(response) {
    const list =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
    for (const cookie of list) {
      // A single header may pack several cookies, each starting `name=`.
      for (const part of String(cookie).split(/,(?=[^;=]+=[^;]*)/)) {
        const match = /^\s*([^=;]+)=([^;]*)/.exec(part);
        if (match) this.#map.set(match[1].trim(), match[2]);
      }
    }
    return this;
  }

  has(name) {
    return this.#map.has(name);
  }

  get(name) {
    return this.#map.get(name);
  }

  set(name, value) {
    this.#map.set(name, value);
    return this;
  }

  delete(name) {
    return this.#map.delete(name);
  }

  /** The `Cookie:` header value. */
  header() {
    return [...this.#map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** Plain object, for persistence. */
  toJSON() {
    return Object.fromEntries(this.#map);
  }

  clear() {
    this.#map.clear();
    return this;
  }
}

/** `?param=` sizing suffix for a NetEase image URL. */
export function resizeImage(url, size = 224) {
  if (!url) return null;
  if (!/music\.126\.net/.test(url)) return url;
  // Idempotent: a URL that already carries `?param=` is re-sized, not doubled.
  const base = String(url).split('?')[0];
  return `${base}?param=${size}y${size}`;
}

/**
 * Normalise the several track shapes NetEase returns into one.
 *
 * Search results use `artists`/`album`/`duration`; playlist and detail payloads
 * use `ar`/`al`/`dt`; `personalized/newsong` nests the track under `song`.
 *
 * This is **idempotent**: tracks flow through several layers (the API client,
 * the agent tools, the DJ, the panel's `/play` round-trip), so an
 * already-normalised track — where `artists` holds plain strings and `album` is
 * a string — must survive a second pass unchanged. Reading `artist.name` there
 * would silently drop every artist.
 */
export function normalizeTrack(raw) {
  const track = raw?.song && raw.song.id ? raw.song : raw;
  if (!track?.id) return null;
  const artists = (track.ar ?? track.artists ?? [])
    .map((artist) => (typeof artist === 'string' ? artist : artist?.name))
    .filter(Boolean);
  const albumRaw = track.al ?? track.album ?? {};
  const album = typeof albumRaw === 'string' ? albumRaw : (albumRaw?.name ?? '');
  const duration = track.dt ?? track.duration ?? 0;
  const fee = track.fee ?? 0;
  return {
    id: track.id,
    name: track.name ?? '',
    artists,
    album,
    picUrl: resizeImage(track.picUrl ?? albumRaw?.picUrl ?? null),
    duration,
    fee,
    /** VIP-gated tracks still play when the session is entitled. */
    vip: fee === FEE.VIP || fee === FEE.ALBUM,
    mvid: track.mvid ?? track.mv ?? 0,
  };
}

/** Normalise a list, dropping entries the API returned without an id. */
function normalizeTracks(list) {
  return (list ?? []).map(normalizeTrack).filter(Boolean);
}

/** `[1,2]` — NetEase wants bracketed ids in query strings. */
function idList(ids) {
  return encodeURIComponent(JSON.stringify([...ids].map(Number)));
}

/**
 * Anonymous-or-authenticated NetEase web API client.
 */
export class Netease {
  /**
   * @param {object} [options]
   * @param {string} [options.cookie] initial `Cookie:` header value.
   * @param {number} [options.timeoutMs] per-request deadline.
   * @param {{warn: Function, info: Function, debug: Function}} [options.logger]
   */
  constructor({ cookie, timeoutMs = 15_000, logger } = {}) {
    this.jar = new CookieJar(cookie);
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    /** Logged-in account summary, refreshed on demand. */
    this.account = null;
  }

  /** Whether a `MUSIC_U` session cookie is held. */
  get authenticated() {
    return this.jar.has('MUSIC_U');
  }

  /** Replace the session cookie wholesale (manual paste or QR success). */
  setCookie(header) {
    this.jar.clear().load('os=pc; appver=2.10.6; channel=netease').load(header);
    this.account = null;
    return this;
  }

  clearCookie() {
    this.jar.clear().load('os=pc; appver=2.10.6; channel=netease');
    this.account = null;
    return this;
  }

  /**
   * One API call. Absorbs cookies, parses JSON, and never throws for a
   * business-level failure code — callers inspect `code`.
   */
  async call(pathname, { method = 'GET', query, body, headers = {} } = {}) {
    const url = new URL(pathname, API_ORIGIN);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }
    const init = {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        Referer: `${API_ORIGIN}/`,
        Origin: API_ORIGIN,
        'User-Agent': UA,
        Cookie: this.jar.header(),
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
      },
      ...(body ? { body: typeof body === 'string' ? body : new URLSearchParams(body).toString() } : {}),
    };

    let response;
    try {
      response = await fetch(url, init);
    } catch (cause) {
      throw new NeteaseError(`NetEase request failed: ${pathname}`, {
        code: 'NETWORK',
        endpoint: pathname,
        payload: cause,
      });
    }
    this.jar.absorb(response);

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // NetEase answers HTML for a few error pages; surface a short excerpt.
      throw new NeteaseError(`NetEase returned non-JSON for ${pathname} (HTTP ${response.status})`, {
        code: 'BAD_PAYLOAD',
        endpoint: pathname,
        payload: text.slice(0, 200),
      });
    }
    this.logger?.debug?.(`[music] ${pathname} -> code=${data?.code} http=${response.status}`);
    return data;
  }

  /**
   * Raw streaming fetch, used by the audio proxy. The caller owns the body.
   *
   * The deadline covers only the connect and the response headers. The body
   * then streams for as long as the browser keeps reading — potentially the
   * whole track, because the element pauses and resumes its reads as its
   * buffer fills and drains. A whole-request timeout here (`AbortSignal`
   * watches the body too) used to cut every stream still open at that point;
   * the panel read the truncation as a failed track and skipped mid-song. A
   * body that stops flowing is still bounded by undici's own idle timeout.
   *
   * @returns {Promise<Response>}
   */
  async fetchAudio(url, { range, method = 'GET', headerTimeoutMs = 30_000 } = {}) {
    const headers = {
      Referer: `${API_ORIGIN}/`,
      'User-Agent': UA,
      Cookie: this.jar.header(),
    };
    if (range) headers.Range = range;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), headerTimeoutMs);
    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        redirect: 'follow',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(deadline);
    }
    this.jar.absorb(response);
    return response;
  }

  // ---------------------------------------------------------------- browsing

  /** Full-text song search. `songCount` reports the total match count. */
  async searchSongs(keyword, { limit = 20, offset = 0 } = {}) {
    const data = await this.call('/api/search/get/web', {
      query: { csrf_token: '', s: keyword, type: 1, offset, limit },
    });
    const result = data?.result ?? {};
    return {
      total: result.songCount ?? 0,
      tracks: normalizeTracks(result.songs),
    };
  }

  /**
   * Fill in cover art for tracks that arrived without any.
   *
   * The search endpoint omits `album.picUrl` entirely, so a search result list
   * renders without artwork unless the detail endpoint is consulted.
   */
  async withCovers(tracks) {
    const missing = tracks.filter((track) => !track.picUrl).map((track) => track.id);
    if (missing.length === 0) return tracks;
    // The detail endpoint accepts a bracketed id list; batch it so a 200-track
    // playlist does not ride on one oversized request.
    const covers = new Map();
    for (let offset = 0; offset < missing.length; offset += 50) {
      const details = await this.songDetail(missing.slice(offset, offset + 50)).catch(() => []);
      for (const track of details) covers.set(track.id, track.picUrl);
    }
    return tracks.map((track) => ({ ...track, picUrl: track.picUrl ?? covers.get(track.id) ?? null }));
  }

  /** Search across all entity types; used to resolve a playlist/artist query. */
  async search(keyword, { type = 1, limit = 20, offset = 0 } = {}) {
    const data = await this.call('/api/search/get/web', {
      query: { csrf_token: '', s: keyword, type, offset, limit },
    });
    return data?.result ?? {};
  }

  /**
   * Playlists matching a keyword. Listeners name and tag playlists by mood
   * (雨天, 爵士, 深夜…), so this is how a mood finds music, where a song search
   * only matches titles and lyrics.
   */
  async searchPlaylists(keyword, { limit = 10 } = {}) {
    const result = await this.search(keyword, { type: 1000, limit });
    return (result.playlists ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      trackCount: item.trackCount ?? 0,
      playCount: item.playCount ?? 0,
    }));
  }

  /** Track metadata, including cover art and the VIP fee code. */
  async songDetail(ids) {
    const list = [...ids].map(Number).filter(Number.isFinite);
    if (list.length === 0) return [];
    const data = await this.call('/api/song/detail', { query: { ids: JSON.stringify(list) } });
    return normalizeTracks(data?.songs);
  }

  /**
   * Resolve a playable audio URL for one track at the requested level.
   *
   * Walks down {@link LEVELS} from the requested level until the API serves
   * something, because entitlement and availability are per track: a track with
   * no lossless master, or a level the region does not carry, is refused while
   * the same track streams fine one tier lower. `downgraded` reports when that
   * happened so a caller can say so rather than pretending.
   *
   * `ok: false` with `code: 404` means nothing was available at any level
   * (unavailable to this session, or gated behind a purchase).
   *
   * @param {number|string} id track id.
   * @param {{level?: string}} [options] `level` is one of {@link LEVELS}.
   */
  async songUrl(id, { level = DEFAULT_LEVEL } = {}) {
    const requestedLevel = isLevel(level) ? level : DEFAULT_LEVEL;
    const ladder = LEVELS.slice(LEVELS.findIndex((entry) => entry.id === requestedLevel));

    let lastCode;
    for (const candidate of ladder) {
      const entry = await this.#songUrlAt(id, candidate);
      if (entry?.url) {
        const served = entry.level ?? candidate.id;
        return {
          ok: true,
          id: Number(id),
          url: entry.url,
          br: entry.br ?? 0,
          size: entry.size ?? 0,
          type: entry.type ?? candidate.kind,
          level: served,
          requestedLevel,
          downgraded: served !== requestedLevel,
          gain: entry.gain ?? 0,
          peak: entry.peak ?? 0,
          expiresInMs: (entry.expi ?? 1200) * 1000,
        };
      }
      lastCode = entry?.code ?? lastCode;
    }

    return {
      ok: false,
      id: Number(id),
      code: lastCode,
      requestedLevel,
      reason: this.authenticated
        ? 'unavailable to this account at any quality (needs a purchase such as a digital album, or is region-locked or removed)'
        : 'unavailable without a signed-in session (VIP-only or region-locked)',
    };
  }

  /** One level attempt against the v1 player-url endpoint. */
  async #songUrlAt(id, candidate) {
    const data = await this.call('/api/song/enhance/player/url/v1', {
      query: {
        ids: JSON.stringify([Number(id)]),
        level: candidate.id,
        encodeType: candidate.kind,
      },
    });
    return data?.data?.[0];
  }

  /** Synced lyric text. `noLyric: true` marks an instrumental. */
  async lyric(id) {
    const data = await this.call('/api/song/lyric', {
      query: { id: Number(id), lv: 1, kv: 1, tv: -1 },
    });
    return {
      lrc: data?.lrc?.lyric ?? '',
      translated: data?.tlyric?.lyric ?? '',
      romaji: data?.romalrc?.lyric ?? '',
      noLyric: Boolean(data?.nolyric),
    };
  }

  /** Playlist header plus its first `limit` tracks. */
  async playlistDetail(id, { limit = 500 } = {}) {
    const data = await this.call('/api/v6/playlist/detail', {
      query: { id: Number(id), n: limit },
    });
    const playlist = data?.playlist;
    if (!playlist) {
      throw new NeteaseError(`playlist ${id} not found`, { code: data?.code, endpoint: 'playlist/detail' });
    }
    return {
      id: playlist.id,
      name: playlist.name,
      description: playlist.description ?? '',
      cover: resizeImage(playlist.coverImgUrl, 500),
      trackCount: playlist.trackCount ?? 0,
      playCount: playlist.playCount ?? 0,
      creator: playlist.creator?.nickname ?? '',
      tracks: normalizeTracks(playlist.tracks),
      /**
       * Every track id, in order. For a playlist the account does not own,
       * `tracks` stops at the first 20 while this list is complete, so it is
       * the only way to reach the rest.
       */
      trackIds: (playlist.trackIds ?? []).map((entry) => entry.id).filter(Number.isFinite),
    };
  }

  /** The public charts (飙升榜/新歌榜/热歌榜/...). */
  async toplists() {
    const data = await this.call('/api/toplist');
    return (data?.list ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      cover: resizeImage(item.coverImgUrl, 300),
      updateFrequency: item.updateFrequency ?? '',
      trackCount: item.trackCount ?? 0,
    }));
  }

  /** Similar tracks — the main "more like this" signal for the DJ. */
  async simiSongs(id, { limit = 20 } = {}) {
    const data = await this.call('/api/discovery/simiSong', {
      query: { songid: Number(id), limit },
    });
    return normalizeTracks(data?.songs);
  }

  /** Anonymous "new songs picked for you" feed. */
  async personalizedNewsongs(limit = 10) {
    const data = await this.call('/api/personalized/newsong', { query: { limit } });
    return normalizeTracks(data?.result);
  }

  /** Anonymous recommended playlists. */
  async personalizedPlaylists(limit = 10) {
    const data = await this.call('/api/personalized/playlist', { query: { limit } });
    return (data?.result ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      cover: resizeImage(item.picUrl, 300),
      playCount: item.playCount ?? 0,
      trackCount: item.trackCount ?? 0,
    }));
  }

  /** Daily recommendations. Requires a session; empty list when anonymous. */
  async recommendSongs(limit = 20) {
    const data = await this.call('/api/v1/discovery/recommend/songs', { query: { limit } });
    const result = data?.data;
    return normalizeTracks(result?.dailySongs ?? result?.recommend);
  }

  /**
   * 私人FM (personal FM): a few tracks NetEase picks for this account, a
   * different few on every call. Requires a session.
   *
   * This is the personalised feed the plain API still serves; heartbeat mode
   * ({@link intelligenceList}) answers `code 500` there for every seed.
   */
  async personalFm() {
    const data = await this.call('/api/v1/radio/get');
    return normalizeTracks(data?.data);
  }

  /**
   * 心动模式 (heartbeat mode): a personalised continuation of a seed track
   * inside a playlist context. Requires a session.
   */
  async intelligenceList(songId, playlistId, { limit = 20 } = {}) {
    const data = await this.call('/api/playmode/intelligence/list', {
      query: {
        id: Number(songId),
        pid: Number(playlistId),
        sid: Number(songId),
        count: limit,
      },
    });
    if (String(data?.code) !== '200') {
      throw new NeteaseError('intelligence list unavailable', {
        code: data?.code,
        endpoint: 'playmode/intelligence/list',
      });
    }
    return normalizeTracks(data?.data);
  }

  // ------------------------------------------------------------------ likes

  /**
   * Like or un-like one track on the account.
   *
   * `/api/song/like` is one of the few *write* endpoints the plain web API
   * still serves unencrypted — it answers `{playlistId, code: 200}` and puts the
   * track in (or takes it out of) the account's 我喜欢的音乐 playlist. It takes
   * the direction rather than toggling, so the caller must know which one it
   * means; ask {@link likedIds} when it does not.
   *
   * A refusal is reported, not thrown: an anonymous session answers `code: 301`
   * and a delisted track answers `code: 400` with NetEase's own reason
   * ("歌曲已经下架了"), and both are ordinary outcomes of a click. Only a
   * transport failure throws.
   *
   * @param {number|string} id track id.
   * @param {boolean} like `true` to like, `false` to remove the like.
   */
  async likeSong(id, like = true) {
    const trackId = Number(id);
    if (!Number.isFinite(trackId)) {
      return { ok: false, id, code: 'BAD_ID', reason: `invalid track id "${id}"` };
    }
    const data = await this.call('/api/song/like', {
      method: 'POST',
      query: { trackId, like: Boolean(like) },
    });
    if (Number(data?.code) !== 200) {
      return {
        ok: false,
        id: trackId,
        code: data?.code ?? 'UNKNOWN',
        reason:
          data?.message ||
          data?.msg ||
          (this.authenticated ? 'NetEase refused the change' : 'sign in to NetEase first'),
      };
    }
    return { ok: true, id: trackId, liked: Boolean(like), playlistId: data?.playlistId ?? null };
  }

  /**
   * Which of these tracks the account has liked.
   *
   * `/api/song/like/check` answers `{ids: [...the liked subset...]}`, so one
   * request covers a whole queue. An anonymous session answers `code: 301` for
   * every id — a refusal, not "nothing is liked" — and comes back as
   * `ok: false` so a caller never caches it as an answer.
   *
   * @param {Iterable<number|string>} ids
   * @returns {Promise<{ok: boolean, ids: number[], code?: number|string, reason?: string}>}
   */
  async likedIds(ids) {
    const list = [...new Set([...ids].map(Number).filter(Number.isFinite))];
    // NetEase answers an empty batch with `code: 400`, and an empty question has
    // no answer to fetch anyway.
    if (list.length === 0) return { ok: true, ids: [] };
    const data = await this.call('/api/song/like/check', {
      query: { trackIds: JSON.stringify(list) },
    });
    if (Number(data?.code) !== 200 || !Array.isArray(data?.ids)) {
      return {
        ok: false,
        ids: [],
        code: data?.code ?? 'UNKNOWN',
        reason: data?.message || data?.msg || 'NetEase refused the like check',
      };
    }
    return { ok: true, ids: data.ids.map(Number) };
  }

  // -------------------------------------------------------------- account

  /** Account summary; `null` when the session is anonymous or expired. */
  async fetchAccount() {
    if (!this.authenticated) {
      this.account = null;
      return null;
    }
    const data = await this.call('/api/nuser/account/get');
    const profile = data?.profile;
    this.account = profile
      ? {
          uid: profile.userId,
          nickname: profile.nickname,
          avatar: resizeImage(profile.avatarUrl, 120),
          vip: Boolean(profile.vipType && profile.vipType > 0),
          vipType: profile.vipType ?? 0,
        }
      : null;
    return this.account;
  }

  /** The user's own playlists (created + collected). */
  async userPlaylists(uid, { limit = 100 } = {}) {
    const data = await this.call('/api/user/playlist', {
      query: { uid: Number(uid), offset: 0, limit },
    });
    return (data?.playlist ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      cover: resizeImage(item.coverImgUrl, 300),
      trackCount: item.trackCount ?? 0,
      subscribed: Boolean(item.subscribed),
      /** `5` marks 我喜欢的音乐 — the account's likes, as a playlist. */
      specialType: item.specialType ?? 0,
    }));
  }

  /**
   * Every track id in the account's 我喜欢的音乐 playlist, or `null` when there
   * is no account or no such playlist.
   *
   * This is the whole like state in one read, which is what makes it useful for
   * reconciling a local mirror; use {@link likedIds} to ask about specific
   * tracks. The playlist's length is not capped by `n` — NetEase returns the
   * complete `trackIds` list — so one request covers a library of any size.
   *
   * @param {number|string} [uid] owner; defaults to the fetched account.
   */
  async likedPlaylistIds(uid) {
    const owner = Number(uid ?? this.account?.uid);
    if (!Number.isFinite(owner)) return null;
    const playlists = await this.userPlaylists(owner, { limit: 1000 });
    const liked = playlists.find((playlist) => playlist.specialType === 5);
    if (!liked) return null;
    const detail = await this.call('/api/v6/playlist/detail', { query: { id: liked.id, n: 1 } });
    return (detail?.playlist?.trackIds ?? []).map((entry) => entry.id).filter(Number.isFinite);
  }

  // ------------------------------------------------------------ QR login

  /**
   * Start a QR login: the returned `loginUrl` is what the QR image encodes and
   * the mobile app scans. Poll with {@link qrPoll}.
   */
  async qrStart() {
    const data = await this.call('/api/login/qrcode/unikey', { query: { type: 1 } });
    if (data?.code !== 200 || !data?.unikey) {
      throw new NeteaseError('could not start QR login', {
        code: data?.code,
        endpoint: 'login/qrcode/unikey',
        payload: data,
      });
    }
    return { unikey: data.unikey, loginUrl: `${API_ORIGIN}/login?codekey=${data.unikey}` };
  }

  /**
   * Poll one QR login attempt.
   *
   * Codes: `800` expired, `801` waiting for scan, `802` scanned awaiting
   * confirmation, `803` success — on which the session cookie is set.
   * @returns {Promise<{code: number, message: string, done: boolean}>}
   */
  async qrPoll(unikey) {
    const data = await this.call('/api/login/qrcode/client/login', {
      query: { key: unikey, type: 1 },
    });
    const code = Number(data?.code);
    if (code === 803) {
      // Some responses carry the cookie in the body as well as in Set-Cookie.
      if (typeof data?.cookie === 'string' && data.cookie) this.jar.load(data.cookie);
      if (!this.authenticated) {
        return { code, message: data?.message ?? '登录成功但未收到会话 cookie', done: false };
      }
      await this.fetchAccount().catch(() => null);
    }
    return { code, message: data?.message ?? '', done: code === 803 && this.authenticated };
  }
}

export { API_ORIGIN, FEE, UA };
