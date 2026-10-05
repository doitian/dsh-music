/**
 * The AI DJ: keeps the queue stocked with tracks that fit what is being
 * listened to.
 *
 * Two tiers, tried in order:
 *
 *   1. **Model tier** — when a model is configured (or discoverable), the
 *      candidate pool plus a taste digest go to `ctx.llm.stream()`, and the
 *      model returns the picks and a one-line vibe. This is what makes the DJ
 *      reason about a mood brief rather than only follow similarity edges.
 *
 *      The call carries a **session id** ({@link curationSessionId}). A plugin
 *      cannot set headers on a leaf call — `GenerateOptions` has no `headers`
 *      field — so the session id is the only identity lever it has, and each
 *      adapter maps it onto whatever its provider calls a per-conversation
 *      header (pi-ai emits `x-opencode-session` for the `opencode-go` route).
 *      Without it the request reaches such a provider looking like an anonymous
 *      client that ignores its conventions.
 *   2. **Heuristic tier** — always available, no model required: NetEase's own
 *      signals (similar songs, personal FM, rested likes, daily
 *      recommendations, anonymous new-song feed, charts, keyword search)
 *      scored by mood match, artist affinity, and the listener's
 *      like/dislike/skip feedback, then interleaved so consecutive tracks do
 *      not share an artist.
 *
 * The DJ never blocks playback: every entry point resolves to a plan or to
 * `null`, and the caller keeps whatever is already queued.
 *
 * @module dsh-music/dj
 */

import { createHash, randomUUID } from 'node:crypto';

import { Pacer, TtlCache, sampleInOrder } from './cache.js';

/**
 * Render a model-tier failure so its stable code survives.
 *
 * `dsh-llm` documents that consumers must route on the failure `code`, never on
 * message text — and a provider is free to send a message as useless as
 * `"error"`. Reporting only `name: message` collapses every distinct failure,
 * including a whole provider being down, into one unactionable line.
 */
function describeFailure(error) {
  const code = error?.code === undefined ? '' : String(error.code);
  const message = error?.message === undefined ? String(error) : String(error.message);
  const head = code && !message.startsWith(code) ? `${code}: ${message}` : message || code;
  const details = error?.failure?.details;
  if (details === undefined) return head;
  try {
    return `${head} | ${JSON.stringify(details).slice(0, 200)}`;
  } catch {
    return head;
  }
}

/** Candidate pool handed to the model; keeps the prompt inside a small budget. */
const MAX_POOL = 70;

/** How many tracks seed similarity expansion. */
const MAX_SEEDS = 4;

/** How far back in the history a seed may come from, so seeds stay current. */
const SEED_HISTORY = 20;

/** Liked tracks offered back to the pool per plan. */
const LIKED_SAMPLE = 6;

/** A liked track played more recently than this is not offered back yet. */
const LIKED_REST_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The order the pool is assembled in: a track two sources share is claimed by
 * the earlier one, and the model reads the catalogue in this order.
 */
const ORIGINS = ['prompt', 'liked', 'fm', 'similar', 'daily', 'new', 'chart'];

/**
 * Tracks each source may contribute per plan. Every source gets a share, so
 * no single one can crowd discovery out of the pool; without a brief they sum
 * to 48, and a brief adds up to 23 that match it.
 */
const QUOTA = { promptPlaylists: 15, promptSongs: 8, similar: 14, daily: 8, new: 6, chart: 8 };

const HOUR = 60 * 60 * 1000;

/**
 * How long each source is kept. Matched to how often it actually changes:
 * similarity effectively never, a chart daily or weekly, the daily
 * recommendations once a day. Personal FM is never cached, because every call
 * answers something new.
 */
const TTL = {
  similar: 24 * HOUR,
  track: 24 * HOUR,
  playlist: 12 * HOUR,
  chart: 6 * HOUR,
  search: 6 * HOUR,
  daily: 3 * HOUR,
  new: HOUR,
  /** A brief's rewrite into search terms: what it means does not drift. */
  terms: 7 * 24 * HOUR,
  /** A brief that could not be rewritten is searched as written, and retried after this. */
  termsRetry: HOUR / 2,
};

/** 飙升榜, 新歌榜, 原创榜, 热歌榜: the general charts, updated daily or weekly. */
const CHARTS = [19723756, 3779629, 2884035, 3778678];

/** How many of a brief's playlists are drawn from. */
const BRIEF_PLAYLISTS = 3;

/** How many search terms a brief is rewritten into. */
const BRIEF_TERMS = 3;

/** A playlist shorter than this is too thin to stand for a mood. */
const MIN_PLAYLIST_TRACKS = 10;

/** Personal FM calls per plan; NetEase answers three tracks per call. */
const FM_CALLS = 2;

/**
 * A track skipped this often leaves the pool for good, like a dislike. One
 * skip is only a penalty: it may have been the wrong moment, not the wrong song.
 */
const SKIPS_TO_EXCLUDE = 2;

/** An artist is reported to the model as often skipped from this many skips. */
const SKIPS_TO_REPORT_ARTIST = 2;

/** Prefix for the minted curation identity, so logs and health read clearly. */
const SESSION_ID_PREFIX = 'music-dj-';

/**
 * The provider-visible identity of the DJ's curation conversation.
 *
 * Minted once and persisted, so every plan of one installation is the *same*
 * conversation to the provider: session affinity and prompt caching work, and a
 * restart does not look like a new client. `config.dj.sessionId` overrides it,
 * and a store that cannot be written still yields a usable in-memory id.
 *
 * @param {import('./session.js').SessionStore} [store] the plugin's store.
 * @param {string} [configured] an operator-supplied id.
 * @returns {string} a non-empty session id.
 */
export function curationSessionId(store, configured) {
  if (typeof configured === 'string' && configured.length > 0) return configured;
  const persisted = store?.settings?.djSessionId;
  if (typeof persisted === 'string' && persisted.length > 0) return persisted;
  const minted = `${SESSION_ID_PREFIX}${randomUUID()}`;
  try {
    store?.updateSettings?.({ djSessionId: minted });
  } catch {
    // A read-only store costs stability across restarts, not correctness now.
  }
  return minted;
}

/**
 * Build one model-tier request.
 *
 * The guard is the point: a leaf call with no `sessionId` still succeeds against
 * a permissive provider, so the failure this prevents is silent — a request
 * that quietly stops following the provider's conventions. Throwing here turns
 * it into a recorded `dj.modelError` instead. No headers are set, because a
 * leaf call cannot set any.
 *
 * @param {object} options
 * @param {{provider: string, model: string}} options.target the resolved route.
 * @param {object[]} options.messages the prompt.
 * @param {string} options.sessionId the provider-visible conversation identity.
 * @returns {object} the request to hand to `ctx.llm.stream()`.
 */
export function curationRequest({ target, messages, sessionId }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(
      'the DJ model call needs a non-empty sessionId: it is the only identity a leaf call can ' +
        "carry, and the adapter maps it onto the provider's per-conversation header",
    );
  }
  return { ...target, messages, sessionId };
}

/**
 * @typedef {object} Plan
 * @property {object[]} tracks chosen tracks, in play order.
 * @property {'model'|'heuristic'} source which tier produced the picks.
 * @property {string} [vibe] one-line description of the set.
 * @property {string} [note] why the heuristic tier ran, when it did.
 * @property {number} poolSize how many candidates were considered.
 */

export class AiDj {
  /**
   * @param {object} options
   * @param {import('./netease.js').Netease} options.api
   * @param {import('./state.js').Player} options.player
   * @param {import('./session.js').SessionStore} options.store
   * @param {() => object | undefined} [options.resolveLlm] returns the LLM service when mounted.
   * @param {() => {provider: string, model: string, reasoningEffort?: string} | null} [options.readAgentDefault]
   *   reads the deployment's default model selection — the model a fresh agent
   *   starts on, which is the same choice the composer picker writes.
   * @param {string} [options.sessionId] configured curation identity, overriding the minted one.
   * @param {{warn: Function, info: Function, debug: Function}} [options.logger]
   * @param {object} [options.model] `{ provider, model }` enabling the model tier.
   * @param {() => number} [options.now] the source cache's clock, injectable for tests.
   * @param {Pacer} [options.pacer] spaces out the NetEase requests a plan sends.
   */
  constructor({
    api,
    player,
    store,
    resolveLlm,
    readAgentDefault,
    sessionId,
    logger,
    model = {},
    now = Date.now,
    pacer = new Pacer(),
  } = {}) {
    this.api = api;
    this.player = player;
    this.store = store;
    this.resolveLlm = resolveLlm;
    this.readAgentDefault = readAgentDefault;
    this.logger = logger;
    this.model = { provider: model.provider ?? null, model: model.model ?? null };
    /**
     * The curation conversation's provider-visible identity. Minted once, then
     * persisted, so every plan and every restart is the same conversation.
     */
    this.sessionId = curationSessionId(store, sessionId);
    /**
     * Where the last resolved route came from: `pin`, `agent-default`, or
     * `discovered`, or `null` when none resolved. Reported by `/music/health`
     * so "which model actually curated" never has to be inferred.
     */
    this.resolvedFrom = null;
    /**
     * Why the model tier last declined, or `null` when it last succeeded.
     *
     * The tier is deliberately non-fatal, which makes a silent fallback the
     * default failure mode: a bad route, a missing credential and a
     * misconfigured model all look identical from the outside. Recording the
     * reason here is what makes `/music/health` able to explain it.
     */
    this.modelError = null;
    /** Guards against overlapping plans when a track ends mid-plan. */
    this.busy = false;
    /** The sources' answers, each kept for as long as it plausibly stays the same. */
    this.cache = new TtlCache({ now });
    /** Every source request goes through this, so a plan never arrives as a burst. */
    this.pacer = pacer;
  }

  /** Record a model-tier decline and carry on with the heuristic tier. */
  #decline(reason) {
    this.modelError = reason;
    this.player.dj.modelError = reason;
    this.logger?.warn?.(`[music] DJ model tier unavailable: ${reason}`);
    return null;
  }

  /** Update the configured model target at runtime. */
  setModel({ provider, model } = {}) {
    if (provider !== undefined) this.model.provider = provider || null;
    if (model !== undefined) this.model.model = model || null;
    // A changed route invalidates the previous verdict, so the next plan is
    // judged on its own result rather than the old failure.
    this.modelError = null;
    this.player.dj.modelError = null;
    return this.model;
  }

  /** The model tier's observable state, for `/music/health`. */
  modelStatus() {
    const sessionModel = this.sessionModel();
    return {
      /** The route pinned from the panel or the profile patch, if any. */
      pinned: this.modelConfigured ? `${this.model.provider}/${this.model.model}` : null,
      /** The deployment's own model, which an unpinned DJ follows. */
      sessionModel: sessionModel ? `${sessionModel.provider}/${sessionModel.model}` : null,
      /** Where the last plan's route came from: pin, agent-default, discovered. */
      resolvedFrom: this.resolvedFrom,
      /** The identity every model call carries; the provider sees it as a header. */
      sessionId: this.sessionId,
    };
  }

  /** Whether a model tier is configured. */
  get modelConfigured() {
    return Boolean(this.model.provider && this.model.model);
  }

  /**
   * The model the session itself runs on, when the deployment publishes one.
   *
   * `agent-default-model` owns this selection, and the composer/command model
   * picker writes it. Reading it here is what lets the DJ's model be a
   * *separate* choice: pin `dj.provider`/`dj.model` to curate on something
   * else, or leave both unset and follow the session.
   *
   * @returns {{provider: string, model: string, reasoningEffort?: string} | null}
   */
  sessionModel() {
    try {
      const selection = this.readAgentDefault?.();
      if (!selection?.provider || !selection?.model) return null;
      return {
        provider: String(selection.provider),
        model: String(selection.model),
        ...(selection.reasoningEffort === undefined || selection.reasoningEffort === null
          ? {}
          : { reasoningEffort: String(selection.reasoningEffort) }),
      };
    } catch {
      return null;
    }
  }

  /**
   * Enumerate the provider routes and catalogued models the DJ could use, for
   * the player's picker.
   *
   * The catalogue is advisory only: core resolution accepts unlisted ids, so
   * the picker also allows a typed model. Without a mounted LLM service there
   * is nothing to offer, and `error` says so rather than returning a bare
   * empty list.
   *
   * @returns {Promise<{routes: {provider: string, models: {id: string, name: string}[], error?: string}[], error: string | null}>}
   */
  async listRoutes() {
    const llm = this.resolveLlm?.();
    if (!llm?.stream) {
      return { routes: [], error: 'no LLM service is mounted (ctx.get("llm") returned nothing)' };
    }
    let providers = [];
    try {
      providers = (llm.listProviders?.() ?? [])
        .map((entry) => entry?.id ?? entry?.provider)
        .filter(Boolean);
    } catch (error) {
      return { routes: [], error: `could not list providers: ${error.message}` };
    }
    const routes = [];
    for (const provider of providers) {
      try {
        const models = (await llm.listModels?.(provider)) ?? [];
        routes.push({
          provider,
          models: models
            .map((model) => ({
              id: model?.id ?? model?.model ?? null,
              name: model?.name ?? model?.id ?? model?.model ?? null,
            }))
            .filter((model) => model.id),
        });
      } catch (error) {
        routes.push({ provider, models: [], error: `could not list models: ${error.message}` });
      }
    }
    return { routes, error: routes.length === 0 ? 'no provider route is registered' : null };
  }

  // ------------------------------------------------------------- candidates

  /**
   * The tracks similarity expands from: what is playing and what was recently
   * heard through, topped up with likes when the history is thin.
   *
   * A rejected track never seeds. The ✕ records a dislike and then moves on, so
   * seeding from the raw history would make the very next plan fetch more of
   * exactly what was just turned down.
   */
  #seeds(digest) {
    const rejected = (id) => this.store.taste(id) === 'disliked' || digest.skipCounts.has(id);
    const seeds = [];
    const offer = (id) => {
      if (seeds.length < MAX_SEEDS && id && !rejected(id) && !seeds.includes(id)) seeds.push(id);
    };
    offer(this.player.current()?.id);
    for (const entry of this.store.state.history.slice(0, SEED_HISTORY)) {
      if (!entry.skipped) offer(entry.id);
    }
    for (const id of this.store.feedback.likes) offer(id);
    return seeds;
  }

  /**
   * A random handful of liked tracks that have rested long enough to be worth
   * hearing again. A personal DJ that never returns to what the listener loves
   * is only a discovery feed.
   */
  #likedSample(excluded) {
    const restedSince = Date.now() - LIKED_REST_MS;
    const heardRecently = new Set(
      this.store.state.history.filter((entry) => (entry.at ?? 0) > restedSince).map((entry) => entry.id),
    );
    const ids = this.store.feedback.likes.filter((id) => !excluded.has(id) && !heardRecently.has(id));
    return sampleInOrder(ids, LIKED_SAMPLE);
  }

  /**
   * Gather a de-duplicated candidate pool from every available signal.
   *
   * Every source is independent and failure-tolerant: a source that throws or
   * needs a session the listener lacks contributes nothing.
   */
  async #candidates({ prompt = '' } = {}) {
    const digest = this.store.tasteDigest();
    // Queued tracks are excluded too: a batch is appended, and a pick the queue
    // already holds is dropped there, so the batch would silently come up short.
    const excluded = new Set([
      ...digest.dislikedIds,
      ...digest.recentIds,
      ...this.player.queue.map((track) => track.id),
      ...[...digest.skipCounts].filter(([, skips]) => skips >= SKIPS_TO_EXCLUDE).map(([id]) => id),
    ]);
    const brief = prompt.trim();
    const seeds = this.#seeds(digest);
    // Every source is fetched at once and fails alone; the pool is then
    // assembled in priority order, so a track two sources share is claimed by
    // the one that ranks it higher, however the requests happened to finish.
    const settled = (promise) => promise.catch(() => []);
    const briefing = brief ? this.#briefTracks(brief, excluded).catch(() => ({ tracks: [], terms: [brief] })) : null;
    const sources = {
      prompt: brief ? settled(briefing.then((result) => result.tracks)) : [],
      liked: settled(this.#tracksByIds(this.#likedSample(excluded))),
      fm: settled(this.#fmTracks()),
      similar: settled(this.#similarTracks(seeds, excluded)),
      daily: settled(this.#feedTracks(`daily:${this.#account()}`, TTL.daily, () => this.api.recommendSongs(30), QUOTA.daily, excluded)),
      new: settled(this.#feedTracks('new', TTL.new, () => this.api.personalizedNewsongs(30), QUOTA.new, excluded)),
      chart: settled(this.#chartTracks(excluded)),
    };

    const pool = [];
    const seen = new Set();
    for (const origin of ORIGINS) {
      for (const track of await sources[origin]) {
        if (!track?.id || seen.has(track.id) || excluded.has(track.id)) continue;
        seen.add(track.id);
        pool.push({ ...track, origin });
      }
    }
    const trimmed = pool.slice(0, MAX_POOL);
    // Covers cost a request only when some track came without one.
    const covered = trimmed.some((track) => !track.picUrl)
      ? await this.pacer.run(() => this.api.withCovers(trimmed)).catch(() => trimmed)
      : trimmed;
    return { pool: covered, digest, terms: briefing ? (await briefing).terms : [] };
  }

  /**
   * Who the personal sources belong to. The cookie, not the account record,
   * because the record is fetched after a sign-in and would briefly read the
   * same for two different people. Only a digest of it is ever kept.
   */
  #account() {
    const cookie = this.api.jar?.get?.('MUSIC_U');
    if (cookie) return createHash('sha256').update(cookie).digest('hex').slice(0, 12);
    return this.api.authenticated ? 'session' : 'anonymous';
  }

  /** Track details by id, each cached on its own so a sample costs only the misses. */
  async #tracksByIds(ids) {
    if (ids.length === 0 || !this.api.songDetail) return [];
    const missing = ids.filter((id) => this.cache.peek(`track:${id}`) === undefined);
    if (missing.length > 0) {
      for (const track of await this.pacer.run(() => this.api.songDetail(missing))) {
        if (track?.id) this.cache.set(`track:${track.id}`, track, TTL.track);
      }
    }
    return ids.map((id) => this.cache.peek(`track:${id}`)).filter(Boolean);
  }

  /** A cached list, sampled down to its quota of eligible tracks. */
  async #feedTracks(key, ttlMs, load, quota, excluded) {
    const tracks = await this.cache.get(key, ttlMs, () => this.pacer.run(load));
    return sampleInOrder((tracks ?? []).filter((track) => track?.id && !excluded.has(track.id)), quota);
  }

  /** Personal FM answers a different three on every call, so it is never cached. */
  async #fmTracks() {
    if (!this.api.authenticated || !this.api.personalFm) return [];
    const calls = Array.from({ length: FM_CALLS }, () => this.pacer.run(() => this.api.personalFm()).catch(() => []));
    return (await Promise.all(calls)).flat();
  }

  /**
   * Similar tracks for each seed. Every eligible track of the first seed — the
   * one playing — is kept, and the other seeds share what is left of the quota.
   */
  async #similarTracks(seeds, excluded) {
    const lists = await Promise.all(
      seeds.map((seed) =>
        this.cache
          .get(`similar:${seed}`, TTL.similar, () => this.pacer.run(() => this.api.simiSongs(seed, { limit: 20 })))
          .catch(() => []),
      ),
    );
    const eligible = (tracks) => (tracks ?? []).filter((track) => track?.id && !excluded.has(track.id));
    const [first = [], ...rest] = lists.map(eligible);
    const lead = first.slice(0, QUOTA.similar);
    return [...lead, ...sampleInOrder(rest.flat(), QUOTA.similar - lead.length)];
  }

  /**
   * One playlist's track ids and whatever full tracks came with them, cached.
   *
   * For a playlist the account does not own NetEase returns full tracks only
   * for the first 20, but every id. Sampling from the ids is what reaches the
   * rest of a 100-track playlist, rather than serving its first 20 forever.
   */
  async #playlist(id, ttlMs) {
    const playlist = await this.cache.get(`playlist:${id}`, ttlMs, () =>
      this.pacer.run(() => this.api.playlistDetail(id, { limit: 1000 })),
    );
    const tracks = playlist?.tracks ?? [];
    return {
      ids: playlist?.trackIds?.length ? playlist.trackIds : tracks.map((track) => track.id),
      known: new Map(tracks.map((track) => [track.id, track])),
    };
  }

  /** Sample eligible ids from playlists, resolving only those that came without details. */
  async #samplePlaylists(playlists, quota, excluded) {
    const known = new Map();
    const ids = [];
    for (const playlist of playlists) {
      for (const [id, track] of playlist.known) known.set(id, track);
      for (const id of playlist.ids) if (!excluded.has(id) && !ids.includes(id)) ids.push(id);
    }
    const chosen = sampleInOrder(ids, quota);
    const resolved = await this.#tracksByIds(chosen.filter((id) => !known.has(id))).catch(() => []);
    for (const track of resolved) known.set(track.id, track);
    return chosen.map((id) => known.get(id)).filter(Boolean);
  }

  /**
   * A sample across the four general charts. One chart alone served the same
   * forty hits every plan; the genre charts are left out because a classical
   * or rap chart is as likely to be off-taste as on it.
   */
  async #chartTracks(excluded) {
    const charts = await Promise.all(CHARTS.map((id) => this.#playlist(id, TTL.chart).catch(() => null)));
    return this.#samplePlaylists(charts.filter(Boolean), QUOTA.chart, excluded);
  }

  /**
   * Tracks for a mood brief. Song search only matches titles and lyrics, so a
   * mood mostly finds tracks literally named after it; listeners name and tag
   * playlists by mood, so the brief's best-loved playlists carry most of it.
   *
   * @returns {Promise<{tracks: object[], terms: string[]}>}
   */
  async #briefTracks(brief, excluded) {
    const terms = await this.#briefTerms(brief);
    const songs = this.#feedTracks(
      `songs:${terms[0]}`,
      TTL.search,
      () => this.api.searchSongs(terms[0], { limit: 30 }).then((result) => result.tracks),
      QUOTA.promptSongs,
      excluded,
    ).catch(() => []);
    const playlists = (async () => {
      if (!this.api.searchPlaylists) return [];
      // Every term gets its share, so one broad term cannot take every slot.
      const perTerm = Math.ceil(BRIEF_PLAYLISTS / terms.length);
      const found = await Promise.all(
        terms.map((term) =>
          this.cache
            .get(`playlists:${term}`, TTL.search, () => this.pacer.run(() => this.api.searchPlaylists(term, { limit: 10 })))
            .catch(() => []),
        ),
      );
      // Among the most relevant few, the most played: relevance alone surfaces
      // a 14-track playlist nobody listens to as readily as a curated one.
      const chosen = new Map();
      for (const results of found) {
        const best = results
          .slice(0, 6)
          .filter((playlist) => playlist.trackCount >= MIN_PLAYLIST_TRACKS && !chosen.has(playlist.id))
          .sort((a, b) => b.playCount - a.playCount)
          .slice(0, perTerm);
        for (const playlist of best) chosen.set(playlist.id, playlist);
      }
      const ids = [...chosen.keys()].slice(0, BRIEF_PLAYLISTS);
      const loaded = await Promise.all(ids.map((id) => this.#playlist(id, TTL.playlist).catch(() => null)));
      return this.#samplePlaylists(loaded.filter(Boolean), QUOTA.promptPlaylists, excluded);
    })().catch(() => []);
    // Playlist tracks first: they are the stronger match for a mood.
    return { tracks: [...(await playlists), ...(await songs)], terms };
  }

  /**
   * The search terms a brief is looked up by: the model's rewrite when there is
   * one, the brief as written otherwise.
   *
   * NetEase playlists are named in Chinese, so an English brief matches badly —
   * "90s cantopop" finds 90s hip-hop. One model call turns the brief into the
   * terms a listener would name such a playlist, and it is made once per brief,
   * not per plan: a brief means the same thing next week. A brief that could
   * not be rewritten is searched as written, and retried after a while rather
   * than on every plan.
   *
   * @returns {Promise<string[]>}
   */
  #briefTerms(brief) {
    const key = `terms:${brief}`;
    const cached = this.cache.peek(key);
    if (cached !== undefined) return cached;
    const pending = this.#rewriteBrief(brief).then(
      (terms) => {
        if (!terms) {
          this.cache.set(key, Promise.resolve([brief]), TTL.termsRetry);
          return [brief];
        }
        this.cache.set(key, Promise.resolve(terms), TTL.terms);
        this.logger?.info?.(`[music] DJ brief "${brief}" will be searched as: ${terms.join('; ')}`);
        return terms;
      },
      (error) => {
        this.logger?.warn?.(`[music] DJ brief could not be rewritten, searching it as written: ${describeFailure(error)}`);
        this.cache.set(key, Promise.resolve([brief]), TTL.termsRetry);
        return [brief];
      },
    );
    this.cache.set(key, pending, TTL.termsRetry);
    return pending;
  }

  /**
   * Ask the model for a brief's search terms, on the same route and under the
   * same identity as curation.
   *
   * @returns {Promise<string[] | null>} `null` when no model route is available.
   * @throws {Error} when the model answered with nothing usable.
   */
  async #rewriteBrief(brief) {
    const llm = this.resolveLlm?.();
    if (!llm?.stream) return null;
    const target = await this.#resolveTarget(llm);
    if (!target?.provider || !target?.model) return null;
    const request = curationRequest({
      target,
      sessionId: this.sessionId,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                "Rewrite a listener's music brief into short search keywords for NetEase Cloud Music playlist search. " +
                `Give up to ${BRIEF_TERMS} keywords, each 2 to 8 words, the way listeners name playlists there: ` +
                'in Chinese, by genre, mood, era, language or scene; keep an artist or genre name in its usual form. ' +
                'Each keyword should find the brief on its own. ' +
                'Reply with JSON only, no prose, no code fence: {"terms":["<keyword>"]}',
            },
            { type: 'text', text: `Brief: ${brief}` },
          ],
        },
      ],
    });
    const text = await this.#collect(llm.stream(request));
    const json = /\{[\s\S]*\}/.exec(text ?? '');
    if (!json) throw new Error('the rewrite contained no JSON object');
    const terms = (JSON.parse(json[0]).terms ?? [])
      .filter((term) => typeof term === 'string')
      .map((term) => term.trim())
      .filter((term) => term.length > 0 && term.length <= 40);
    const unique = [...new Set(terms)].slice(0, BRIEF_TERMS);
    if (unique.length === 0) throw new Error('the model returned no search terms');
    return unique;
  }

  // --------------------------------------------------------------- model tier

  /**
   * Assemble streamed chunks into text.
   *
   * The terminal failure lives at `reason.failure` and carries the stable code
   * the service documents (`AUTH`, `RATE_LIMIT`, `NO_ADAPTER`, …). No top-level
   * `failure` exists, so reading only that discards the code and leaves an
   * invented message — which is how a provider outage once read as `Error: error`.
   */
  async #collect(stream) {
    let text = '';
    let failure = null;
    for await (const chunk of stream) {
      // The service emits `type`; its documentation says `kind`. Accept both.
      const type = chunk?.type ?? chunk?.kind;
      if (type === 'text-delta') {
        text += chunk.text ?? '';
      } else if (type === 'finish') {
        const reason = chunk?.reason;
        const kind = typeof reason === 'string' ? reason : reason?.kind;
        if (kind === 'error' || kind === 'aborted') {
          // Keep the reason kind alongside the descriptor: a descriptor with no
          // code still has a kind, and that is the only signal left for the code.
          failure = { kind, ...(reason?.failure ?? chunk?.failure ?? {}) };
        }
      } else if (type === 'error') {
        failure = { kind: 'error', ...(chunk?.failure ?? {}) };
      }
    }
    if (failure) {
      const code =
        failure.code ?? failure.name ?? (failure.kind === 'aborted' ? 'ABORTED' : 'UNKNOWN');
      const error = new Error(
        failure.message ?? (failure.kind ? `stream ${failure.kind}` : 'stream failed'),
      );
      error.code = code;
      error.failure = failure;
      throw error;
    }
    return text;
  }

  /**
   * Decide which provider route to call.
   *
   * An explicit pin always wins. Otherwise the deployment's own model selection
   * is inherited — `agent-default-model`, which is the same choice the composer
   * picker writes and therefore the model the agent loop runs on — so the
   * session model and the DJ's model are two separable decisions that agree
   * by default. Only when neither exists does discovery run.
   *
   * Discovery is a convenience, not a recommendation: the catalogue's first
   * entry is arbitrary, so pinning both fields is the only way to know which
   * model curates.
   *
   * @param {object} llm the mounted LLM service, for the catalogue.
   * @returns {Promise<{provider: string, model: string, source: string, reasoningEffort?: string} | null>}
   */
  async #resolveTarget(llm) {
    const pinned = { provider: this.model.provider, model: this.model.model };
    if (pinned.provider && pinned.model) return { ...pinned, source: 'pin' };

    if (!pinned.provider && !pinned.model) {
      const inherited = this.sessionModel();
      if (inherited?.provider && inherited.model) return { ...inherited, source: 'agent-default' };
    }

    if (!llm?.stream) return null;

    let providers = [];
    try {
      providers = (llm.listProviders?.() ?? [])
        .map((entry) => entry?.id ?? entry?.provider)
        .filter(Boolean);
    } catch {
      providers = [];
    }
    const provider = pinned.provider ?? providers[0];
    if (!provider) return null;

    let model = pinned.model;
    if (!model) {
      try {
        const models = await llm.listModels?.(provider);
        model = models?.[0]?.id ?? models?.[0]?.model ?? null;
      } catch {
        model = null;
      }
    }
    return model ? { provider, model, source: 'discovered' } : null;
  }

  /**
   * The candidate catalogue and the listener's taste, as one prompt.
   *
   * One place builds the prompt, so a leaf call and any future caller reason
   * about exactly the same brief.
   */
  #brief({ pool, digest, prompt, count, follows }) {
    const label = (track) => `${track.name} — ${(track.artists ?? []).join('/')}`;
    const catalogue = pool
      .map((track, index) =>
        `${index}. ${label(track)}${track.album ? ` (${track.album})` : ''}${track.origin === 'liked' ? ' [liked]' : ''}`)
      .join('\n');
    const current = this.player.current();
    const upNext = follows ? this.player.remaining().slice(-5) : [];
    const skippedArtists = [...digest.skippedArtists]
      .filter(([, skips]) => skips >= SKIPS_TO_REPORT_ARTIST)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([artist, skips]) => `${artist} (${skips})`);
    return [
      `Mood or request: ${prompt?.trim() || '(none — continue the current listening session)'}`,
      `Currently playing: ${current ? label(current) : '(nothing)'}`,
      upNext.length ? `Already queued after it: ${upNext.map(label).join('; ')}` : '',
      follows && follows !== current ? `Your picks play after: ${label(follows)}` : '',
      digest.recentlyPlayed.length ? `Recently played: ${digest.recentlyPlayed.join('; ')}` : '',
      digest.topArtists.length ? `Favourite artists: ${digest.topArtists.join(', ')}` : '',
      digest.liked.length ? `Liked: ${digest.liked.join('; ')}` : '',
      digest.disliked.length ? `Disliked (never pick): ${digest.disliked.join('; ')}` : '',
      digest.skipped.length ? `Skipped early (steer away from these): ${digest.skipped.join('; ')}` : '',
      skippedArtists.length ? `Often skipped artists (skips): ${skippedArtists.join(', ')}` : '',
      '',
      `CANDIDATES (choose only by index):\n${catalogue}`,
      '',
      `Choose exactly ${count} tracks in play order.`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** The two-block user message both transports send: instruction, then brief. */
  #messages(brief) {
    return [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'You are the music programmer for a personal NetEase Cloud Music player. ' +
              'Choose the next tracks from the CANDIDATES list only, by index. ' +
              'Favour artists the listener likes and the requested mood; keep variety — never place two tracks by the same artist back to back; ' +
              'avoid anything listed as recently played or disliked, and pick less of what the listener skips. ' +
              'Candidates marked [liked] are the listener\'s own likes, not heard for a while: mix one in when it fits, but do not fill the set with them. ' +
              'Reply with JSON only, no prose, no code fence: ' +
              '{"vibe":"<one short line describing the set>","picks":[{"index":<candidate index>,"why":"<max 8 words>"}]}',
          },
          { type: 'text', text: brief },
        ],
      },
    ];
  }

  /**
   * Turn an answer into ordered candidate indices.
   *
   * Tolerant on purpose: a model may wrap the object in prose or a code fence,
   * and indices outside the pool are dropped rather than trusted.
   *
   * @throws {Error} when the answer carries no JSON object or no usable index.
   */
  #parseAnswer(text, pool, count) {
    const json = /\{[\s\S]*\}/.exec(text ?? '');
    if (!json) throw new Error('response contained no JSON object');
    const parsed = JSON.parse(json[0]);
    const picks = (parsed.picks ?? [])
      .map((pick) => Number(typeof pick === 'object' ? pick.index : pick))
      .filter((index) => Number.isInteger(index) && index >= 0 && index < pool.length);
    if (picks.length === 0) throw new Error('the model returned no usable picks');
    const seen = new Set();
    const ordered = [];
    for (const index of picks) {
      if (seen.has(index)) continue;
      seen.add(index);
      ordered.push(index);
    }
    // A model asked for five that answers with twenty would otherwise flood the queue.
    return { picks: ordered.slice(0, count), vibe: typeof parsed.vibe === 'string' ? parsed.vibe : '' };
  }

  /** Record a model-tier success: clear the stale reason and log what ran. */
  #accept(answer, target) {
    this.modelError = null;
    this.player.dj.modelError = null;
    this.logger?.info?.(
      `[music] DJ model tier chose ${answer.picks.length} track(s) via ${target.provider}/${target.model}` +
        `${target.source === 'discovered' ? ' (discovered)' : ''}`,
    );
    return { ...answer, target };
  }

  /**
   * Ask the model to choose from the pool.
   *
   * One leaf call, carrying the DJ's session identity. A failure declines to the
   * heuristic tier and records the coded reason rather than being retried: a
   * second full prompt against a provider that just failed is how one outage
   * becomes two.
   *
   * @returns {Promise<{picks: number[], vibe: string} | null>}
   *   `null` when the tier is unavailable or answered with nothing usable.
   */
  async #askModel({ pool, digest, prompt, count, follows }) {
    const llm = this.resolveLlm?.();
    if (!llm?.stream) {
      return this.#decline('no LLM service is mounted (ctx.get("llm") returned nothing)');
    }

    const target = await this.#resolveTarget(llm);
    if (!target?.provider || !target?.model) {
      this.resolvedFrom = null;
      return this.#decline(
        this.model.provider || this.model.model
          ? `no usable route for the configured provider/model (${this.model.provider ?? '?'}/${this.model.model ?? '?'})`
          : 'no provider route is registered, and none could be discovered',
      );
    }
    this.resolvedFrom = target.source;

    const brief = this.#brief({ pool, digest, prompt, count, follows });
    try {
      const request = curationRequest({
        target,
        messages: this.#messages(brief),
        sessionId: this.sessionId,
      });
      const text = await this.#collect(llm.stream(request));
      return this.#accept(this.#parseAnswer(text, pool, count), target);
    } catch (error) {
      return this.#decline(describeFailure(error));
    }
  }

  // ----------------------------------------------------------- heuristic tier

  /**
   * Score and interleave candidates without a model.
   *
   * Scoring is deliberately simple and explainable: a mood-brief match and
   * artist affinity dominate, skips count against a track and its artists,
   * recently played and disliked tracks were already excluded from the pool,
   * and a small jitter keeps repeat requests from returning an identical order.
   */
  #rank({ pool, digest, count, follows }) {
    const favourites = new Set(digest.topArtists);
    const currentArtists = new Set(this.player.current()?.artists ?? []);
    const playedArtists = new Map();
    for (const entry of this.store.state.history.slice(0, 60)) {
      if (entry.skipped) continue;
      for (const artist of entry.artists ?? []) playedArtists.set(artist, (playedArtists.get(artist) ?? 0) + 1);
    }

    const scored = pool.map((track) => {
      let score = Math.random() * 0.8;
      // The brief is the listener's explicit ask; without this weight a chart
      // hit by a favourite artist outranks every track that matches it.
      // FM is personalised, similarity is not; a like is a known good song,
      // weighted lightly so the set stays a discovery rather than a replay.
      if (track.origin === 'prompt') score += 3.0;
      else if (track.origin === 'fm') score += 1.0;
      else if (track.origin === 'similar') score += 0.6;
      else if (track.origin === 'liked') score += 0.5;
      for (const artist of track.artists ?? []) {
        if (favourites.has(artist)) score += 2.2;
        if (currentArtists.has(artist)) score += 1.4;
        score += Math.min((playedArtists.get(artist) ?? 0) * 0.15, 1.0);
        score -= Math.min((digest.skippedArtists.get(artist) ?? 0) * 0.6, 2.4);
      }
      if (digest.skipCounts.has(track.id)) score -= 1.5;
      if (track.vip) score -= 0.4; // still playable when signed in, but riskier
      return { track, score };
    });
    scored.sort((a, b) => b.score - a.score);

    // Interleave so one artist cannot own consecutive slots, starting from the
    // track the batch will actually follow.
    const picked = [];
    let lastArtists = new Set(follows?.artists ?? []);
    while (picked.length < count && scored.length > 0) {
      let chosen = scored.findIndex((entry) => !(entry.track.artists ?? []).some((artist) => lastArtists.has(artist)));
      if (chosen === -1) chosen = 0;
      const [entry] = scored.splice(chosen, 1);
      picked.push(entry.track);
      lastArtists = new Set(entry.track.artists ?? []);
    }
    return picked;
  }

  // ------------------------------------------------------------------- plans

  /**
   * Produce the next batch.
   * @param {object} [options]
   * @param {string} [options.prompt] mood/request brief.
   * @param {number} [options.count] how many tracks to choose.
   * @param {object|null} [options.follows] the track the batch will play after;
   *   the queue's last track by default, since a batch is appended.
   * @returns {Promise<Plan>}
   */
  async plan({ prompt = '', count = 5, follows = this.player.queue.at(-1) ?? null } = {}) {
    const size = Math.min(Math.max(Number(count) || 5, 1), 25);
    const { pool, digest, terms } = await this.#candidates({ prompt });
    /** What the brief was searched as, so a rewrite is observable. */
    const searchedAs = terms;
    if (pool.length === 0) {
      return { tracks: [], source: 'heuristic', note: 'no candidates were available', poolSize: 0, searchedAs };
    }
    const answer = await this.#askModel({ pool, digest, prompt, count: size, follows });
    if (answer) {
      return {
        tracks: answer.picks.map((index) => pool[index]),
        source: 'model',
        vibe: answer.vibe,
        /** Which provider route curated, so the choice is observable. */
        route: `${answer.target.provider}/${answer.target.model}`,
        poolSize: pool.length,
        searchedAs,
      };
    }
    return {
      tracks: this.#rank({ pool, digest, count: size, follows }),
      source: 'heuristic',
      note: this.modelError
        ? `model tier unavailable (${this.modelError}); used similarity, charts and taste feedback`
        : 'no model configured; used similarity, charts and taste feedback',
      poolSize: pool.length,
      searchedAs,
    };
  }

  /**
   * Extend the queue when it runs low. Safe to call on every track change: the
   * busy flag and the threshold check make it a no-op most of the time.
   * @param {object} [options]
   * @param {boolean} [options.force] plan even when disabled or the queue is deep.
   * @param {number} [options.count] batch size, overriding the player's setting.
   * @returns {Promise<Plan | null>}
   */
  async topUp({ force = false, count } = {}) {
    const settings = this.store.settings;
    if (!this.player.dj.enabled && !force) return null;
    if (this.busy) return null;
    const threshold = Math.max(Number(settings.djAutoExtendBelow) || 3, 0);
    if (!force && this.player.index >= 0 && this.player.remaining().length >= threshold) return null;

    this.busy = true;
    this.player.dj.busy = true;
    this.player.bump();
    try {
      const planned = await this.plan({ prompt: settings.djPrompt ?? '', count: count ?? settings.djBatchSize ?? 5 });
      // The queue can change while the plan is in flight; report only what lands.
      const queued = new Set(this.player.queue.map((track) => track.id));
      const plan = { ...planned, tracks: planned.tracks.filter((track) => !queued.has(track.id)) };
      if (plan.tracks.length === 0) {
        this.player.dj = { ...this.player.dj, busy: false, error: plan.note ?? 'no tracks found', lastPlanAt: Date.now() };
        return plan;
      }
      // The DJ only stocks the queue; it never changes the transport state.
      // `play: false` preserves whatever the listener chose, so a top-up while
      // paused does not start playback, while a queue refilled after the last
      // track ended still resumes because `playing` was already true.
      this.player.append(plan.tracks, { source: plan.source, play: false });
      this.player.dj = {
        ...this.player.dj,
        busy: false,
        error: null,
        lastPlanAt: Date.now(),
        lastPlan: {
          source: plan.source,
          vibe: plan.vibe ?? plan.note ?? '',
          route: plan.route ?? null,
          added: plan.tracks.length,
          names: plan.tracks.map((track) => `${track.name} — ${(track.artists ?? []).join('/')}`),
          searchedAs: plan.searchedAs ?? [],
        },
      };
      this.player.bump();
      this.logger?.info?.(`[music] DJ added ${plan.tracks.length} track(s) via ${plan.source}`);
      return plan;
    } catch (error) {
      this.player.dj = { ...this.player.dj, busy: false, error: error.message };
      this.player.bump();
      this.logger?.warn?.(`[music] DJ top-up failed: ${error.message}`);
      return null;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Start a DJ session: enable continuous mode, then replace the queue with a
   * freshly planned batch.
   * @returns {Promise<Plan>}
   */
  async start({ prompt, count = 8 } = {}) {
    this.store.updateSettings({ djEnabled: true, ...(prompt === undefined ? {} : { djPrompt: prompt }) });
    this.player.dj.enabled = true;
    // The batch replaces the queue, so nothing precedes its first track.
    const plan = await this.plan({ prompt: prompt ?? this.store.settings.djPrompt ?? '', count, follows: null });
    if (plan.tracks.length > 0) {
      this.player.setQueue(plan.tracks, { startIndex: 0, play: true, source: plan.source });
      this.player.dj.lastPlanAt = Date.now();
      this.player.dj.lastPlan = {
        source: plan.source,
        vibe: plan.vibe ?? plan.note ?? '',
        route: plan.route ?? null,
        added: plan.tracks.length,
        names: plan.tracks.map((track) => `${track.name} — ${(track.artists ?? []).join('/')}`),
        searchedAs: plan.searchedAs ?? [],
      };
      this.player.dj.error = null;
    } else {
      this.player.dj.error = plan.note ?? 'no tracks found';
    }
    this.player.bump();
    return plan;
  }

  /** Turn continuous mode on or off without touching the queue. */
  setEnabled(enabled, { prompt } = {}) {
    const next = Boolean(enabled);
    this.store.updateSettings({ djEnabled: next, ...(prompt === undefined ? {} : { djPrompt: prompt }) });
    this.player.dj.enabled = next;
    this.player.bump();
    return next;
  }
}
