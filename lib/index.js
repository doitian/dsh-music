/**
 * `music` — NetEase Cloud Music (music.163.com) playback and AI DJ for DSH.
 *
 * The host half owns the NetEase session, the playback queue, the audio proxy,
 * and the agent-facing tools. The browser half (`lib/client.js`) adds a sidebar
 * page that embeds the player served from this plugin's own route prefix.
 *
 * Deliberately dependency-free: only `node:` builtins plus global `fetch`, so
 * the plugin installs from a local path with no package build or peer
 * resolution. Tool definitions and the single HTTP route are written directly
 * against the documented registry shapes.
 *
 * @module @doitian/dsh-music
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Netease } from './netease.js';
import { QrLogin, SessionStore, ANONYMOUS_COOKIE } from './session.js';
import { Player } from './state.js';
import { AiDj } from './dj.js';
import { LikeState } from './likes.js';
import { MusicRouter } from './router.js';
import { Scrobbler } from './scrobble.js';

export const name = 'music';

/** Requires the tool registry and the HTTP server to compose the plugin. */
export const inject = ['tools', 'webServer'];

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Read a shipped asset once at module load; both are small. */
function readAsset(...segments) {
  return fs.readFileSync(path.join(HERE, ...segments), 'utf8');
}

/**
 * Shipped browser assets, read once per module generation.
 *
 * Deliberately module-scoped rather than read inside {@link apply}: a plugin
 * remount re-runs `apply`, and reading here instead would let a remounted
 * plugin serve a page from a *newer* working tree than the code it is running
 * beside. The page and the module must describe the same contract.
 */
const PANEL_HTML = readAsset('panel.html');
const QRCODE_JS = readAsset('vendor', 'qrcode.js');

/**
 * Build a `{warn, info, debug}` logger over the Cordis logger.
 * @param {object} ctx plugin context.
 */
function makeLogger(ctx) {
  const write = (level, message) => {
    const logger = ctx?.logger;
    if (typeof logger?.[level] === 'function') logger[level](message);
    else if (level === 'warn') console.warn(message);
  };
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    debug: (message) => write('debug', message),
  };
}

/**
 * Wrap a definition into the registry-ready tool shape.
 *
 * `ctx.tools.register()` accepts a plain object; `defineTool()` in
 * `@deepseek-ai/dsh-tools` only compiles a friendlier spec into exactly this
 * shape. Writing it directly keeps this plugin free of DSH imports.
 *
 * @param {object} spec
 * @param {string} spec.name
 * @param {string} spec.description
 * @param {object} spec.parameters JSON Schema for the arguments.
 * @param {string} spec.title card title shown in the transcript.
 * @param {(args: object, exec: object) => Promise<object>} spec.execute
 * @param {(args: object, value: object) => object[]} spec.render content blocks.
 */
function defineMusicTool({ name: toolName, description, parameters, title, execute, render }) {
  return {
    name: toolName,
    description,
    parameters,
    output: {
      // Results are heterogeneous per action; the model reads the rendered text
      // and the panel reads its own HTTP endpoints, so the schema stays open.
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (args, value) => render(args, value),
    },
    presentCall: (args) => ({ card: 'generic', title, kind: 'other', rawInput: args }),
    execute: (args, exec) => execute(args ?? {}, exec),
  };
}

/** One line per track, the form the model reads best. */
function trackLine(track, index) {
  const artists = (track.artists ?? []).join('/');
  const minutes = Math.floor((track.duration ?? 0) / 60000);
  const seconds = String(Math.floor(((track.duration ?? 0) % 60000) / 1000)).padStart(2, '0');
  return `${index === undefined ? '' : `${index + 1}. `}${track.name} — ${artists}${track.album ? ` (${track.album})` : ''} [id:${track.id}, ${minutes}:${seconds}${track.vip ? ', VIP' : ''}]`;
}

/** Resolve the harness home the way the rest of DSH does. */
function dshHome() {
  const fromEnv = process.env.DSH_HOME?.trim();
  return fromEnv || path.join(os.homedir(), '.dsh');
}

export function apply(ctx, config = {}) {
  const logger = makeLogger(ctx);
  const base = `/${String(config.apiPrefix ?? 'music').replace(/^\/+|\/+$/g, '')}`;
  const dataDir = config.dataDir || path.join(dshHome(), 'music');

  const store = new SessionStore({ file: path.join(dataDir, 'session.json'), logger });
  store.load();

  const api = new Netease({
    cookie: store.cookie || ANONYMOUS_COOKIE,
    timeoutMs: config.requestTimeoutMs ?? 15_000,
    logger,
  });

  const player = new Player({ logger });
  // Restore the persisted DJ preference so continuous mode survives a restart.
  player.dj.enabled = Boolean(store.settings.djEnabled);
  player.restore(store.savedQueue);

  const qr = new QrLogin({ api, store, logger });

  // The account owns its likes; this is the cache the panel's hearts read.
  const likes = new LikeState({ api, logger });

  /**
   * The LLM service is optional: the DJ falls back to its heuristic tier when
   * absent, so the plugin still works in a composition without a model route.
   */
  const resolveLlm = () => {
    try {
      return ctx.get?.('llm') ?? ctx.llm ?? undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * The deployment's default model selection: the route a freshly created agent
   * starts on, and the same choice the composer/command model picker writes.
   *
   * This is the seam that makes the session's model and the DJ's model two
   * separate decisions; only the choice is shared, since the DJ calls its model
   * directly rather than through an agent. `agent-default-model` owns the first; `dj.provider` /
   * `dj.model` owns the second; and the DJ follows the session model when the
   * plugin pins nothing, instead of picking an arbitrary first route.
   */
  const readAgentDefault = () => {
    try {
      const service = ctx.get?.('agentDefaultModel') ?? ctx.agentDefaultModel;
      const selection = service?.currentSelection?.();
      if (!selection?.provider || !selection?.model) return null;
      return {
        provider: String(selection.provider),
        model: String(selection.model),
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: String(selection.reasoningEffort) }),
      };
    } catch {
      return null;
    }
  };

  const dj = new AiDj({
    api,
    player,
    store,
    resolveLlm,
    readAgentDefault,
    // An operator-supplied identity for the DJ's model calls; otherwise one is
    // minted on first use and persisted in session.json.
    sessionId: config.dj?.sessionId,
    logger,
    // The picker's saved choice wins over the profile patch, so a route chosen
    // in the GUI is not silently overridden by a stale `config.dj` pin.
    model: {
      provider: store.settings.djProvider || config.dj?.provider,
      model: store.settings.djModel || config.dj?.model,
    },
  });
  player.onLowQueue = () => dj.topUp();
  player.onSkip = (track) => {
    // The panel's ✕ records the dislike and then presses next, so an early
    // dislike would also count as a skip — but only inside the skip window,
    // which would make the same judgement weigh differently by when it came.
    if (store.taste(track.id) === 'disliked') return;
    store.recordSkip(track.id);
    logger.debug(`[music] skip recorded for ${track.id}`);
  };

  /** Tool names that registered successfully; surfaced by `/music/health`. */
  const registeredTools = [];

  // ------------------------------------------------------------ session boot
  void api
    .fetchAccount()
    .then(async (account) => {
      if (account) logger.info(`[music] signed in as ${account.nickname}`);
      else if (api.authenticated) logger.warn('[music] session cookie present but the account check failed');
      else logger.info('[music] anonymous session (search and non-VIP playback only)');

      // The account holds the likes; the local list is a copy the DJ reads.
      // Reconciling it here keeps that copy honest across a like made on the
      // phone, and migrates a list an earlier build recorded locally because it
      // had no endpoint to send it to.
      try {
        const likedIds = await api.likedPlaylistIds(account?.uid);
        if (likedIds) {
          store.setLikedIds(likedIds);
          logger.debug(`[music] like mirror reconciled with the account (${likedIds.length} track(s))`);
        }
      } catch (error) {
        logger.warn(`[music] could not read the account's likes: ${error.message}`);
      }
    })
    .catch((error) => logger.warn(`[music] account check failed: ${error.message}`));

  // ---------------------------------------------------------- history + DJ
  // The one place a play is recorded: whenever the current track changes, by
  // whatever path. Recording it again where the queue is set counted every
  // played track twice, and an appended one as a play of the current track.
  // A restored current track was recorded by the run that played it.
  let lastRecorded = player.current()?.id ?? null;
  player.subscribe(() => {
    const current = player.current();
    if (!current || current.id === lastRecorded) return;
    lastRecorded = current.id;
    store.recordPlay(current, { tentative: current.queuedBy === 'dj' });
  });

  // Saved only when the queue or cursor moves, not on every position report.
  let savedQueueKey = null;
  player.subscribe(() => {
    const key = `${player.index}:${player.queue.map((track) => track.id).join(',')}`;
    if (key === savedQueueKey) return;
    savedQueueKey = key;
    store.saveQueue(player.queue, player.index);
  });
  player.onHeard = (track) => store.confirmPlay(track.id);

  // Plays reach the account's listening history the way the web player's do.
  // On by default; the player's switch, then `config.scrobble: false`, keep them local.
  const scrobbler = new Scrobbler({
    api,
    enabled: typeof store.settings.scrobble === 'boolean' ? store.settings.scrobble : config.scrobble !== false,
    logger,
  });
  player.onStart = (track) => scrobbler.start(track);
  player.onFinish = (track, play) => void scrobbler.finish(track, play);

  // A periodic sweep catches the cases the track-end hook misses: a paused
  // panel, a failed track, or a DJ that was switched on with a short queue.
  const sweep = setInterval(() => {
    if (!player.dj.enabled || player.dj.busy) return;
    const threshold = Math.max(Number(store.settings.djAutoExtendBelow) || 3, 0);
    if (player.remaining().length < threshold) void dj.topUp();
  }, 20_000);
  sweep.unref?.();

  // ------------------------------------------------------------------ routes
  const router = new MusicRouter({
    base,
    api,
    player,
    store,
    qr,
    dj,
    likes,
    scrobbler,
    panelHtml: PANEL_HTML,
    qrcodeJs: QRCODE_JS,
    config,
    listRoutes: () => dj.listRoutes(),
    diagnostics: () => ({
      tools: registeredTools,
      dj: {
        enabled: player.dj.enabled,
        busy: player.dj.busy,
        source: player.dj.source,
        model: dj.modelConfigured ? `${dj.model.provider}/${dj.model.model}` : null,
        /** Where the live route came from: the player, the patch, or a default. */
        modelSource: store.settings.djProvider || store.settings.djModel
          ? 'panel'
          : config.dj?.provider || config.dj?.model
            ? 'config'
            : readAgentDefault()
              ? 'agent-default'
              : 'discovered',
        /** Route that actually curated the last batch, model tier or not. */
        lastRoute: player.dj.lastPlan?.route ?? null,
        /** Why the model tier last declined; null once it succeeds. */
        modelError: player.dj.modelError ?? null,
        /** Where the route comes from, what the last plan resolved, and the
         *  identity every call carries (the provider sees it as a header). */
        ...dj.modelStatus(),
        lastPlanAt: player.dj.lastPlanAt,
        error: player.dj.error,
      },
      /** How much of the account's like state is cached, and why it is not. */
      likes: likes.status(),
      /** Whether plays are reported to the listening history, and how the last went. */
      scrobble: scrobbler.status(),
      dataDir,
      session: { authenticated: api.authenticated, nickname: api.account?.nickname ?? null, vip: Boolean(api.account?.vip) },
      uptimeMs: Math.round(process.uptime() * 1000),
    }),
    logger,
  });

  const disposeRoute = ctx.webServer.register({
    kind: 'prefix',
    path: base,
    handler: (req, res) => router.handle(req, res),
  });
  const panelUrl = () => `http://127.0.0.1:${ctx.webServer.port}${base}/panel`;
  logger.info(`[music] player panel at ${panelUrl()}`);

  // ------------------------------------------------------------------- tools
  /**
   * Register a tool and record its name for `/music/health`.
   *
   * The route is registered before these calls, so a tool that failed to
   * register would otherwise leave a route that answers normally; reporting the
   * names makes that partial state observable instead of silent.
   */
  const registerTool = (spec) => {
    ctx.tools.register(defineMusicTool(spec));
    registeredTools.push(spec.name);
  };

  registerTool({
      name: 'music_search',
      title: 'Search NetEase Cloud Music',
      description:
        'Search NetEase Cloud Music (music.163.com) for songs. Returns track ids usable with music_play. ' +
        'Use this to resolve a request such as "play 周杰伦 晴天" into concrete tracks before queueing anything.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'Search text: song, artist, or album.' },
          limit: { type: 'integer', description: 'Maximum results (1-50, default 10).' },
        },
        required: ['query'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.tracks.length === 0
              ? `No tracks matched "${value.query}" on NetEase Cloud Music.`
              : `${value.total} match(es) for "${value.query}"; showing ${value.tracks.length}:\n` +
                value.tracks.map((track, index) => trackLine(track, index)).join('\n'),
        },
      ],
      async execute(args) {
        const query = String(args.query ?? '').trim();
        if (!query) throw new Error('query is required');
        const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
        const result = await api.searchSongs(query, { limit });
        const tracks = await api.withCovers(result.tracks).catch(() => result.tracks);
        return { query, total: result.total, tracks };
      },
  });

  registerTool({
      name: 'music_play',
      title: 'Play on NetEase Cloud Music',
      description:
        'Queue and start NetEase Cloud Music playback in the user\'s DSH music panel. ' +
        'Pass `ids` when you already have track ids from music_search, or `query` to search and play the best match. ' +
        'Playback happens in the browser panel, so nothing is audible if the user has not opened the Music page.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ids: { type: 'array', items: { type: 'integer' }, description: 'Track ids to play, in order.' },
          query: { type: 'string', description: 'Search text; the top matches are played when `ids` is omitted.' },
          mode: {
            type: 'string',
            enum: ['replace', 'append', 'next'],
            description: 'replace the queue (default), append to it, or insert right after the current track.',
          },
          limit: { type: 'integer', description: 'How many search matches to queue when using `query` (default 1).' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `${value.added} track(s) ${value.mode === 'replace' ? 'queued' : value.mode === 'next' ? 'inserted next' : 'appended'}. ` +
            `Now playing: ${value.current ? `${value.current.name} — ${value.current.artists.join('/')}` : '(nothing)'}. ` +
            `${value.remaining} track(s) after it.` +
            (value.current?.vip ? ' This track is VIP-gated; it needs a signed-in NetEase account.' : '') +
            (value.authenticated ? '' : ' NOTE: the NetEase session is anonymous, so VIP tracks will not play.'),
        },
      ],
      async execute(args) {
        let tracks = [];
        if (Array.isArray(args.ids) && args.ids.length > 0) {
          tracks = await api.songDetail(args.ids);
        } else if (args.query) {
          const limit = Math.min(Math.max(Number(args.limit) || 1, 1), 25);
          const result = await api.searchSongs(String(args.query), { limit });
          tracks = await api.withCovers(result.tracks).catch(() => result.tracks);
        }
        if (tracks.length === 0) throw new Error('nothing to play: pass `ids` or a `query` that matches a track');

        const mode = args.mode ?? 'replace';
        if (mode === 'append') player.append(tracks, { source: 'agent' });
        else if (mode === 'next') player.insertNext(tracks, { source: 'agent' });
        else player.setQueue(tracks, { startIndex: 0, play: true, source: 'agent' });

        const summary = player.summary();
        return {
          added: tracks.length,
          mode,
          current: summary.current,
          remaining: summary.remaining,
          authenticated: api.authenticated,
          panelUrl: panelUrl(),
        };
      },
  });

  registerTool({
      name: 'music_queue',
      title: 'Edit the music queue',
      description:
        'Inspect or edit the NetEase Cloud Music queue in the user\'s DSH music panel: append, insert, replace, remove one entry, jump to an entry, or clear.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['show', 'append', 'insert', 'replace', 'remove', 'jump', 'clear'],
            description: 'Queue operation. `show` only reports the current queue.',
          },
          ids: { type: 'array', items: { type: 'integer' }, description: 'Track ids for append/insert/replace.' },
          index: { type: 'integer', description: 'Zero-based queue position for remove/jump.' },
        },
        required: ['action'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `Queue: ${value.queued} track(s), ${value.remaining} after the current one.\n` +
            (value.upNext.length
              ? `Up next:\n${value.upNext.map((track, index) => trackLine(track, index)).join('\n')}`
              : 'Nothing is queued after the current track.'),
        },
      ],
      async execute(args) {
        const action = String(args.action ?? 'show');
        if (action === 'show') return player.summary();
        if (action === 'clear') {
          player.clear();
          return player.summary();
        }
        if (action === 'remove' || action === 'jump') {
          const index = Number(args.index);
          if (!Number.isInteger(index)) throw new Error(`\`index\` is required for ${action}`);
          if (action === 'remove') player.remove(index);
          else player.jump(index);
          return player.summary();
        }
        const tracks = await api.songDetail(args.ids ?? []);
        if (tracks.length === 0) throw new Error('`ids` must name at least one known track');
        if (action === 'append') player.append(tracks, { source: 'agent' });
        else if (action === 'insert') player.insertNext(tracks, { source: 'agent' });
        else if (action === 'replace') player.setQueue(tracks, { startIndex: 0, play: true, source: 'agent' });
        else throw new Error(`unknown action "${action}"`);
        return player.summary();
      },
  });

  registerTool({
      name: 'music_control',
      title: 'Control music playback',
      description:
        'Control the NetEase Cloud Music panel: play, pause, next, previous, seek, volume, mute, or repeat mode. ' +
        'Use music_now_playing first when you need to know what is playing.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['play', 'pause', 'toggle', 'next', 'previous', 'seek', 'volume', 'mute', 'mode'],
          },
          value: {
            description:
              'seek: absolute milliseconds. volume: 0-1. mute: boolean. mode: list | single | shuffle.',
          },
        },
        required: ['action'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `${value.playing ? 'Playing' : 'Paused'}${
              value.current ? `: ${value.current.name} — ${value.current.artists.join('/')}` : ' (queue empty)'
            }. Mode ${value.mode}, volume ${Math.round(value.volume * 100)}%. ` +
            `${value.remaining} track(s) after the current one.`,
        },
      ],
      async execute(args) {
        switch (args.action) {
          case 'play': player.setPlaying(true); break;
          case 'pause': player.setPlaying(false); break;
          case 'toggle': player.toggle(); break;
          case 'next': player.move(1); break;
          case 'previous': player.move(-1); break;
          case 'seek': player.seek(Number(args.value) || 0); break;
          case 'volume': player.setVolume(args.value); break;
          case 'mute': player.setMuted(Boolean(args.value)); break;
          case 'mode': player.setMode(String(args.value)); break;
          default: throw new Error(`unknown action "${args.action}"`);
        }
        return player.summary();
      },
  });

  registerTool({
      name: 'music_dj',
      title: 'AI DJ (NetEase Cloud Music)',
      description:
        'Run or configure the continuous AI DJ for the user\'s NetEase Cloud Music panel. ' +
        'With `enabled: true` the DJ keeps the queue stocked: it gathers candidates from similar songs, personal FM, ' +
        'liked songs not heard lately, the daily recommendations, the charts and any mood brief, then either asks the model to choose or scores them by the ' +
        'listener\'s liked artists and their likes, dislikes and skips. Pass `prompt` for a mood or vibe, and `replan` to refill now. ' +
        'Pass `boost` to steer it for a while — `more` or `less` songs like a track (the playing one by default) for an hour, ' +
        'or `none` to clear — when the listener wants more or fewer like a song without a lasting like or dislike.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean', description: 'Turn continuous queue topping-up on or off.' },
          prompt: { type: 'string', description: 'Mood or request, e.g. "rainy afternoon jazz", "90s cantopop".' },
          replan: { type: 'boolean', description: 'Plan and queue a fresh batch immediately.' },
          count: {
            type: 'integer',
            description: 'How many tracks to plan (1-25; default 8 for `start`, the player\'s batch size for `replan`).',
          },
          start: { type: 'boolean', description: 'Replace the queue with a freshly planned batch (a full DJ session).' },
          boost: {
            type: 'string',
            enum: ['more', 'less', 'none'],
            description: 'Temporarily steer the DJ toward (`more`) or away from (`less`) songs like a track, or clear its boost (`none`).',
          },
          boostTrackId: { type: 'integer', description: 'The track to boost; defaults to the one playing.' },
          boostMinutes: { type: 'integer', description: 'How long the boost lasts, 5-720 minutes (default 60).' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `AI DJ is ${value.enabled ? 'on' : 'off'} (${value.source}${value.route ? ` via ${value.route}` : ''}). ` +
            (value.modelError ? `Model tier unavailable: ${value.modelError}. ` : '') +
            (value.vibe ? `Vibe: ${value.vibe}. ` : '') +
            (value.searchedAs.length ? `Brief searched as: ${value.searchedAs.join('; ')}. ` : '') +
            (value.boostError ? `Boost not applied: ${value.boostError}. ` : '') +
            (value.boosted
              ? `Boost: ${value.boosted.direction === 'more' ? 'more' : 'fewer'} songs like ${value.boosted.name} for ` +
                `${value.boosted.minutes} min${value.boosted.queued ? `, ${value.boosted.queued} queued next` : ''}` +
                `${value.boosted.removed ? `, ${value.boosted.removed} removed from the queue` : ''}. `
              : '') +
            (value.boosts.length
              ? `Active boosts: ${value.boosts.map((boost) => `${boost.direction} like ${boost.name} (${boost.minutesLeft} min left)`).join('; ')}. `
              : '') +
            (value.names.length
              ? `Queued ${value.added} track(s):\n${value.names.map((entry, index) => `${index + 1}. ${entry}`).join('\n')}`
              : value.note || 'No new tracks were queued.') +
            (value.authenticated ? '' : ' The NetEase session is anonymous, so VIP tracks will be skipped by the browser.'),
        },
      ],
      async execute(args) {
        const enabled = args.enabled === undefined ? undefined : Boolean(args.enabled);
        const prompt = args.prompt === undefined ? undefined : String(args.prompt);
        if (enabled !== undefined || prompt !== undefined) dj.setEnabled(enabled ?? player.dj.enabled, { prompt });

        let boosted = null;
        let boostError = null;
        if (args.boost !== undefined) {
          const trackId = args.boostTrackId ?? player.current()?.id;
          const applied = trackId === undefined
            ? { ok: false, reason: 'nothing is playing, so pass boostTrackId' }
            : await router.applyBoost(trackId, String(args.boost), args.boostMinutes);
          if (!applied.ok) boostError = applied.reason;
          else if (applied.boost) {
            boosted = {
              direction: applied.boost.direction,
              name: applied.boost.name,
              minutes: Math.round((applied.boost.until - Date.now()) / 60_000),
              ...applied.effect,
            };
          }
        }

        const count = Math.min(Math.max(Number(args.count) || 8, 1), 25);
        let plan = null;
        if (args.start) {
          plan = await dj.start({ prompt, count });
        } else if (args.replan || (enabled === true && player.queue.length === 0)) {
          plan = await dj.topUp({ force: true, count: args.count === undefined ? undefined : count });
        }

        const summary = player.summary();
        return {
          enabled: summary.dj.enabled,
          source: plan?.source ?? summary.dj.source ?? (dj.modelConfigured ? 'model' : 'heuristic'),
          route: plan?.route ?? summary.dj.lastPlan?.route ?? null,
          modelError: player.dj.modelError ?? null,
          vibe: plan?.vibe ?? summary.dj.lastPlan?.vibe ?? '',
          searchedAs: plan?.searchedAs ?? summary.dj.lastPlan?.searchedAs ?? [],
          note: plan?.note ?? (plan && plan.tracks.length === 0 ? 'no candidates were available' : ''),
          added: plan?.tracks.length ?? 0,
          names: (plan?.tracks ?? []).map((track) => `${track.name} — ${(track.artists ?? []).join('/')}`),
          authenticated: api.authenticated,
          current: summary.current,
          remaining: summary.remaining,
          boosted,
          boostError,
          boosts: store.activeBoosts().map((boost) => ({
            id: boost.id,
            name: boost.name,
            direction: boost.direction,
            minutesLeft: Math.max(Math.round((boost.until - Date.now()) / 60_000), 1),
          })),
        };
      },
  });

  registerTool({
      name: 'music_now_playing',
      title: 'What is playing',
      description:
        'Report what the NetEase Cloud Music panel is playing, what comes next, and whether the NetEase account is signed in.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            (value.current
              ? `${value.playing ? 'Playing' : 'Paused'}: ${value.current.name} — ${value.current.artists.join('/')} ` +
                `at ${Math.floor((value.positionMs ?? 0) / 1000)}s of ${Math.floor((value.current.durationMs ?? 0) / 1000)}s.`
              : 'Nothing is playing; the music queue is empty.') +
            `\nUp next: ${value.upNext.length ? value.upNext.map((track) => `${track.name} — ${track.artists.join('/')}`).join('; ') : '(nothing)'}` +
            `\nAccount: ${value.account ? `${value.account.nickname}${value.account.vip ? ' (VIP)' : ''}` : 'anonymous (VIP tracks unavailable)'}` +
            (value.lastError ? `\nNote: a track failed and was skipped (${value.lastError}).` : '') +
            `\nPanel: ${value.panelUrl}`,
        },
      ],
      async execute() {
        return { ...player.summary(), account: api.account, authenticated: api.authenticated, panelUrl: panelUrl() };
      },
  });

  registerTool({
      name: 'music_login',
      title: 'NetEase Cloud Music sign-in',
      description:
        'Check or change the NetEase Cloud Music sign-in. `status` reports the account. `qr` starts a QR sign-in and ' +
        'returns a URL the user scans with the NetEase Cloud Music mobile app (they can also just open the Music page). ' +
        '`set_cookie` accepts a MUSIC_U cookie pasted from a browser session. `logout` forgets the session.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['status', 'qr', 'poll', 'set_cookie', 'logout'] },
          cookie: { type: 'string', description: 'Cookie header value, for `set_cookie`.' },
        },
        required: ['action'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.loggedIn
              ? `Signed in to NetEase Cloud Music as ${value.account?.nickname ?? '(unknown)'}${value.account?.vip ? ' (VIP)' : ''}.`
              : `Not signed in to NetEase Cloud Music (${value.message ?? 'anonymous'}). Only non-VIP tracks play.` +
                (value.scanUrl ? `\nScan this QR with the NetEase Cloud Music app, or open ${value.panelUrl} and use 登录: ${value.scanUrl}` : ''),
        },
      ],
      async execute(args) {
        const panel = panelUrl();
        switch (args.action) {
          case 'status': {
            const account = api.authenticated ? await api.fetchAccount().catch(() => null) : null;
            return { loggedIn: Boolean(account), account, message: account ? '' : 'anonymous session', panelUrl: panel };
          }
          case 'qr': {
            const attempt = await qr.start();
            return {
              loggedIn: false,
              account: null,
              message: 'QR code ready; it expires in about two minutes',
              scanUrl: attempt.loginUrl,
              panelUrl: panel,
            };
          }
          case 'poll': {
            const result = await qr.poll();
            return {
              loggedIn: Boolean(api.account),
              account: api.account,
              message: result.message,
              scanUrl: result.loginUrl,
              panelUrl: panel,
            };
          }
          case 'set_cookie': {
            if (!args.cookie) throw new Error('`cookie` is required for set_cookie');
            api.setCookie(String(args.cookie).trim());
            const account = await api.fetchAccount();
            if (!account) throw new Error('that cookie did not yield an account (expired or malformed)');
            store.setSession(api.jar.header(), account);
            return { loggedIn: true, account, message: 'signed in', panelUrl: panel };
          }
          case 'logout': {
            api.clearCookie();
            store.clearSession();
            qr.reset();
            return { loggedIn: false, account: null, message: 'signed out', panelUrl: panel };
          }
          default:
            throw new Error(`unknown action "${args.action}"`);
        }
      },
  });

  // ----------------------------------------------------------------- cleanup
  ctx.effect(() => () => {
    clearInterval(sweep);
    try {
      disposeRoute();
    } catch {
      // The route table is already gone when the webserver unloads first.
    }
    store.close();
    logger.debug('[music] unloaded');
  });
}
