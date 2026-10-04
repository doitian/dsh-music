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
 *   2. **Heuristic tier** — always available, no model required: NetEase's own
 *      signals (similar songs, daily recommendations, anonymous new-song feed,
 *      charts, keyword search) scored by artist affinity, novelty, and the
 *      listener's like/dislike/skip feedback, then interleaved so consecutive
 *      tracks do not share an artist.
 *
 * The DJ never blocks playback: every entry point resolves to a plan or to
 * `null`, and the caller keeps whatever is already queued.
 *
 * @module dsh-music/dj
 */

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
const MAX_POOL = 45;

/** Only the first `MAX_SEEDS` history entries seed similarity expansion. */
const MAX_SEEDS = 4;

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
   * @param {{warn: Function, info: Function, debug: Function}} [options.logger]
   * @param {object} [options.model] `{ provider, model }` enabling the model tier.
   */
  constructor({ api, player, store, resolveLlm, logger, model = {} } = {}) {
    this.api = api;
    this.player = player;
    this.store = store;
    this.resolveLlm = resolveLlm;
    this.logger = logger;
    this.model = { provider: model.provider ?? null, model: model.model ?? null };
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

  /** Whether a model tier is configured. */
  get modelConfigured() {
    return Boolean(this.model.provider && this.model.model);
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
   * Gather a de-duplicated candidate pool from every available signal.
   *
   * Every source is independent and failure-tolerant: a source that throws or
   * needs a session the listener lacks contributes nothing.
   */
  async #candidates({ prompt = '', count = 30 } = {}) {
    const digest = this.store.tasteDigest();
    const excluded = new Set([...digest.dislikedIds, ...digest.recentIds]);
    const pool = [];
    const seen = new Set();
    const add = (tracks, origin) => {
      for (const track of tracks ?? []) {
        if (!track?.id || seen.has(track.id) || excluded.has(track.id)) continue;
        seen.add(track.id);
        pool.push({ ...track, origin });
      }
    };

    const current = this.player.current();
    const seeds = [current?.id, ...this.store.recentIds(MAX_SEEDS)].filter(Boolean).slice(0, MAX_SEEDS);

    const tasks = [];
    // Similarity expansion from what is playing and what was played recently.
    for (const seed of seeds) {
      tasks.push(
        this.api.simiSongs(seed, { limit: 12 }).then((tracks) => add(tracks, 'similar')).catch(() => {}),
      );
    }
    // A mood brief is a search term; the raw text searches well enough.
    if (prompt.trim()) {
      tasks.push(
        this.api.searchSongs(prompt.trim(), { limit: 15 }).then((r) => add(r.tracks, 'prompt')).catch(() => {}),
      );
    }
    // Editorial and anonymous feeds keep the pool from collapsing to one genre.
    tasks.push(this.api.recommendSongs(20).then((tracks) => add(tracks, 'daily')).catch(() => {}));
    tasks.push(this.api.personalizedNewsongs(15).then((tracks) => add(tracks, 'new')).catch(() => {}));
    tasks.push(
      this.api
        .playlistDetail('3778678', { limit: 40 })
        .then((playlist) => add(playlist.tracks, 'chart'))
        .catch(() => {}),
    );
    await Promise.all(tasks);

    // Keep the prompt cheap when the pool overflowed: prefer prompt/similar
    // matches, then the feeds.
    const priority = { prompt: 0, similar: 1, daily: 2, new: 3, chart: 4 };
    pool.sort((a, b) => (priority[a.origin] ?? 9) - (priority[b.origin] ?? 9));
    const trimmed = pool.slice(0, Math.max(count, MAX_POOL));
    return { pool: await this.api.withCovers(trimmed).catch(() => trimmed), digest };
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
   * An explicit pin always wins. Otherwise the gaps are filled from the
   * registered adapters' catalogues, preferring a pinned provider (or model)
   * over the first one. Discovery is a convenience, not a recommendation: the
   * catalogue's first entry is arbitrary, so pinning both fields is the only
   * way to know which model curates.
   *
   * @param {object} llm the mounted LLM service.
   * @returns {Promise<{provider: string, model: string} | null>}
   */
  async #resolveTarget(llm) {
    const pinned = { provider: this.model.provider, model: this.model.model };
    if (pinned.provider && pinned.model) return pinned;

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
    return model ? { provider, model } : null;
  }

  /**
   * Ask the model to choose from the pool.
   * @returns {Promise<{picks: number[], vibe: string} | null>} `null` when the
   *   tier is unavailable or answered with nothing usable.
   */
  async #askModel({ pool, digest, prompt, count }) {
    const llm = this.resolveLlm?.();
    if (!llm?.stream) {
      return this.#decline('no LLM service is mounted (ctx.get("llm") returned nothing)');
    }
    const target = await this.#resolveTarget(llm);
    if (!target?.provider || !target?.model) {
      return this.#decline(
        this.model.provider || this.model.model
          ? `no usable route for the configured provider/model (${this.model.provider ?? '?'}/${this.model.model ?? '?'})`
          : 'no provider route is registered, and none could be discovered',
      );
    }

    const catalogue = pool
      .map((track, index) => `${index}. ${track.name} — ${(track.artists ?? []).join('/')}${track.album ? ` (${track.album})` : ''}`)
      .join('\n');
    const brief = [
      `Mood or request: ${prompt?.trim() || '(none — continue the current listening session)'}`,
      `Currently playing: ${this.player.current() ? `${this.player.current().name} — ${this.player.current().artists.join('/')}` : '(nothing)'}`,
      digest.recentlyPlayed.length ? `Recently played: ${digest.recentlyPlayed.join('; ')}` : '',
      digest.topArtists.length ? `Favourite artists: ${digest.topArtists.join(', ')}` : '',
      digest.liked.length ? `Liked: ${digest.liked.join('; ')}` : '',
      digest.disliked.length ? `Disliked (never pick): ${digest.disliked.join('; ')}` : '',
      '',
      `CANDIDATES (choose only by index):\n${catalogue}`,
      '',
      `Choose exactly ${count} tracks in play order.`,
    ]
      .filter(Boolean)
      .join('\n');

    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'You are the music programmer for a personal NetEase Cloud Music player. ' +
              'Choose the next tracks from the CANDIDATES list only, by index. ' +
              'Favour artists the listener likes and the requested mood; keep variety — never place two tracks by the same artist back to back; ' +
              'avoid anything listed as recently played or disliked. ' +
              'Reply with JSON only, no prose, no code fence: ' +
              '{"vibe":"<one short line describing the set>","picks":[{"index":<candidate index>,"why":"<max 8 words>"}]}',
          },
          { type: 'text', text: brief },
        ],
      },
    ];

    try {
      const text = await this.#collect(llm.stream({ ...target, messages }));
      const json = /\{[\s\S]*\}/.exec(text);
      if (!json) throw new Error('response contained no JSON object');
      const parsed = JSON.parse(json[0]);
      const picks = (parsed.picks ?? [])
        .map((pick) => Number(typeof pick === 'object' ? pick.index : pick))
        .filter((index) => Number.isInteger(index) && index >= 0 && index < pool.length);
      if (picks.length === 0) return this.#decline('the model returned no usable picks');
      const seen = new Set();
      const ordered = [];
      for (const index of picks) {
        if (seen.has(index)) continue;
        seen.add(index);
        ordered.push(index);
      }
      this.logger?.info?.(`[music] DJ model tier chose ${ordered.length} track(s) via ${target.provider}/${target.model}`);
      this.modelError = null;
      this.player.dj.modelError = null;
      return { picks: ordered, vibe: typeof parsed.vibe === 'string' ? parsed.vibe : '', target };
    } catch (error) {
      return this.#decline(describeFailure(error));
    }
  }

  // ----------------------------------------------------------- heuristic tier

  /**
   * Score and interleave candidates without a model.
   *
   * Scoring is deliberately simple and explainable: artist affinity dominates,
   * familiarity is penalised, explicit dislikes are excluded earlier, and a
   * small jitter keeps repeat requests from returning an identical order.
   */
  #rank({ pool, digest, count }) {
    const favourites = new Set(digest.topArtists);
    const currentArtists = new Set(this.player.current()?.artists ?? []);
    const playedArtists = new Map();
    for (const entry of this.store.state.history.slice(0, 60)) {
      for (const artist of entry.artists ?? []) playedArtists.set(artist, (playedArtists.get(artist) ?? 0) + 1);
    }
    const recentlyPlayed = new Set(digest.recentIds);

    const scored = pool.map((track) => {
      let score = Math.random() * 0.8;
      for (const artist of track.artists ?? []) {
        if (favourites.has(artist)) score += 2.2;
        if (currentArtists.has(artist)) score += 1.4;
        score += Math.min((playedArtists.get(artist) ?? 0) * 0.15, 1.0);
      }
      if (!recentlyPlayed.has(track.id)) score += 1.0;
      if (track.vip) score -= 0.4; // still playable when signed in, but riskier
      return { track, score };
    });
    scored.sort((a, b) => b.score - a.score);

    // Interleave so one artist cannot own consecutive slots.
    const picked = [];
    let lastArtist = this.player.current()?.artists?.[0] ?? null;
    while (picked.length < count && scored.length > 0) {
      let chosen = scored.findIndex((entry) => entry.track.artists?.[0] !== lastArtist);
      if (chosen === -1) chosen = 0;
      const [entry] = scored.splice(chosen, 1);
      picked.push(entry.track);
      lastArtist = entry.track.artists?.[0] ?? null;
    }
    return picked;
  }

  // ------------------------------------------------------------------- plans

  /**
   * Produce the next batch.
   * @param {object} [options]
   * @param {string} [options.prompt] mood/request brief.
   * @param {number} [options.count] how many tracks to choose.
   * @returns {Promise<Plan>}
   */
  async plan({ prompt = '', count = 5 } = {}) {
    const size = Math.min(Math.max(Number(count) || 5, 1), 25);
    const { pool, digest } = await this.#candidates({ prompt, count: size });
    if (pool.length === 0) {
      return { tracks: [], source: 'heuristic', note: 'no candidates were available', poolSize: 0 };
    }
    const answer = await this.#askModel({ pool, digest, prompt, count: size });
    if (answer) {
      return {
        tracks: answer.picks.map((index) => pool[index]),
        source: 'model',
        vibe: answer.vibe,
        /** Which provider route curated, so the choice is observable. */
        route: `${answer.target.provider}/${answer.target.model}`,
        poolSize: pool.length,
      };
    }
    return {
      tracks: this.#rank({ pool, digest, count: size }),
      source: 'heuristic',
      note: this.modelError
        ? `model tier unavailable (${this.modelError}); used similarity, charts and taste feedback`
        : 'no model configured; used similarity, charts and taste feedback',
      poolSize: pool.length,
    };
  }

  /**
   * Extend the queue when it runs low. Safe to call on every track change: the
   * busy flag and the threshold check make it a no-op most of the time.
   * @returns {Promise<Plan | null>}
   */
  async topUp({ force = false } = {}) {
    const settings = this.store.settings;
    if (!this.player.dj.enabled && !force) return null;
    if (this.busy) return null;
    const threshold = Math.max(Number(settings.djAutoExtendBelow) || 3, 0);
    if (!force && this.player.index >= 0 && this.player.remaining().length >= threshold) return null;

    this.busy = true;
    this.player.dj.busy = true;
    this.player.bump();
    try {
      const plan = await this.plan({ prompt: settings.djPrompt ?? '', count: settings.djBatchSize ?? 5 });
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
    const plan = await this.plan({ prompt: prompt ?? this.store.settings.djPrompt ?? '', count });
    if (plan.tracks.length > 0) {
      this.player.setQueue(plan.tracks, { startIndex: 0, play: true, source: plan.source });
      this.player.dj.lastPlanAt = Date.now();
      this.player.dj.lastPlan = {
        source: plan.source,
        vibe: plan.vibe ?? plan.note ?? '',
        route: plan.route ?? null,
        added: plan.tracks.length,
        names: plan.tracks.map((track) => `${track.name} — ${(track.artists ?? []).join('/')}`),
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
