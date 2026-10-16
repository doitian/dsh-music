/**
 * Standalone music server: run the player without DeepSeek Harness.
 *
 * Mirrors the host wiring of `lib/index.js#apply`, minus the parts only the
 * harness supplies: the tool registry, the LLM service (the DJ falls back to
 * its heuristic tier), and the shared web server — a plain `node:http` server
 * dispatches everything to `MusicRouter` instead.
 *
 *   node scripts/standalone.mjs [--port 8321] [--data-dir ~/.dsh-music] [--open]
 *          [--dj-api-base URL --dj-api-key KEY [--dj-provider NAME] [--dj-model ID]]
 *
 * Then open http://127.0.0.1:<port>/music/panel
 *
 * The AI DJ runs its heuristic tier by default. Point it at any
 * OpenAI-compatible endpoint (DeepSeek, OpenAI, a local server, …) with the
 * --dj-* flags or the DSH_MUSIC_DJ_* environment variables and the model tier
 * curates instead; the panel's DJ model picker lists what the endpoint serves.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { Netease } from '../lib/netease.js';
import { QrLogin, SessionStore, ANONYMOUS_COOKIE } from '../lib/session.js';
import { Player } from '../lib/state.js';
import { AiDj } from '../lib/dj.js';
import { LikeState } from '../lib/likes.js';
import { MusicRouter } from '../lib/router.js';
import { Scrobbler } from '../lib/scrobble.js';
import { OpenAiCompatibleLlm } from './openai-compatible-llm.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readAsset = (...segments) => fs.readFileSync(path.join(HERE, '..', 'lib', ...segments), 'utf8');

const PANEL_HTML = readAsset('panel.html');
const PLAYBACK_JS = readAsset('playback.js');
const QRCODE_JS = readAsset('vendor', 'qrcode.js');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const port = Number(option('port', process.env.DSH_MUSIC_PORT ?? 8321));
const dataDir = option('data-dir', process.env.MUSIC_HOME ?? path.join(os.homedir(), '.dsh-music'));
const base = '/music';

const logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  debug: (message) => {
    if (process.env.DEBUG) console.debug(message);
  },
};

const store = new SessionStore({ file: path.join(dataDir, 'session.json'), logger });
store.load();

const api = new Netease({ cookie: store.cookie || ANONYMOUS_COOKIE, logger });

const player = new Player({ logger });
player.dj.enabled = Boolean(store.settings.djEnabled);
player.restore(store.savedQueue);

const qr = new QrLogin({ api, store, logger });
const likes = new LikeState({ api, logger });

// The DJ's model tier is opt-in: with no --dj-* configuration the service is
// absent (modelStatus and listRoutes in dj.js tolerate that) and the heuristic
// tier curates. With one, the panel's saved route choice still wins over it.
const djApiBase = option('dj-api-base', process.env.DSH_MUSIC_DJ_API_BASE);
const djApiKey = option('dj-api-key', process.env.DSH_MUSIC_DJ_API_KEY);
const djProvider = option('dj-provider', process.env.DSH_MUSIC_DJ_PROVIDER ?? 'openai-compatible');
const djModel = option('dj-model', process.env.DSH_MUSIC_DJ_MODEL);

let llm;
if (djApiBase && djApiKey) {
  llm = new OpenAiCompatibleLlm({ baseUrl: djApiBase, apiKey: djApiKey, provider: djProvider, model: djModel, logger });
  logger.info(`[music] DJ model tier on ${djProvider} via ${djApiBase}${djModel ? ` (default ${djModel})` : ''}`);
} else if (djApiBase || djApiKey) {
  logger.warn('[music] --dj-api-base and --dj-api-key must both be set; the DJ stays heuristic');
}

const dj = new AiDj({
  api,
  player,
  store,
  resolveLlm: () => llm,
  readAgentDefault: () => null,
  logger,
  model: {
    provider: store.settings.djProvider || (llm ? djProvider : undefined),
    model: store.settings.djModel || (llm ? djModel : undefined),
  },
});
player.onLowQueue = () => dj.topUp();
player.onSkip = (track) => {
  if (store.taste(track.id) === 'disliked') return;
  store.recordSkip(track.id);
  logger.debug(`[music] skip recorded for ${track.id}`);
};

void api
  .fetchAccount()
  .then(async (account) => {
    if (account) logger.info(`[music] signed in as ${account.nickname}`);
    else logger.info('[music] anonymous session (search and non-VIP playback only)');
    try {
      const likedIds = await api.likedPlaylistIds(account?.uid);
      if (likedIds) store.setLikedIds(likedIds);
    } catch (error) {
      logger.warn(`[music] could not read the account's likes: ${error.message}`);
    }
  })
  .catch((error) => logger.warn(`[music] account check failed: ${error.message}`));

let lastRecorded = player.current()?.id ?? null;
player.subscribe(() => {
  const current = player.current();
  if (!current || current.id === lastRecorded) return;
  lastRecorded = current.id;
  store.recordPlay(current, { tentative: current.queuedBy === 'dj' });
});

let savedQueueKey = null;
player.subscribe(() => {
  const key = `${player.index}:${player.queue.map((track) => track.id).join(',')}`;
  if (key === savedQueueKey) return;
  savedQueueKey = key;
  store.saveQueue(player.queue, player.index);
});
player.onHeard = (track) => store.confirmPlay(track.id);

const scrobbler = new Scrobbler({
  api,
  enabled: typeof store.settings.scrobble === 'boolean' ? store.settings.scrobble : true,
  logger,
});
player.onStart = (track) => scrobbler.start(track);
player.onFinish = (track, play) => void scrobbler.finish(track, play);

const sweep = setInterval(() => {
  if (!player.dj.enabled || player.dj.busy) return;
  const threshold = Math.max(Number(store.settings.djAutoExtendBelow) || 3, 0);
  if (player.remaining().length < threshold) void dj.topUp();
}, 20_000);
sweep.unref?.();

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
  playbackJs: PLAYBACK_JS,
  qrcodeJs: QRCODE_JS,
  listRoutes: () => dj.listRoutes(),
  diagnostics: () => ({
    dj: {
      enabled: player.dj.enabled,
      busy: player.dj.busy,
      source: player.dj.source,
      model: dj.modelConfigured ? `${dj.model.provider}/${dj.model.model}` : null,
      modelSource: store.settings.djProvider || store.settings.djModel ? 'panel' : 'discovered',
      lastRoute: player.dj.lastPlan?.route ?? null,
      modelError: player.dj.modelError ?? null,
      ...dj.modelStatus(),
      lastPlanAt: player.dj.lastPlanAt,
      error: player.dj.error,
    },
    likes: likes.status(),
    scrobble: scrobbler.status(),
    dataDir,
    session: { authenticated: api.authenticated, nickname: api.account?.nickname ?? null, vip: Boolean(api.account?.vip) },
    uptimeMs: Math.round(process.uptime() * 1000),
  }),
  logger,
});

const server = http.createServer((req, res) => {
  router
    .handle(req, res)
    .then((handled) => {
      if (!handled && !res.headersSent) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`not found: ${req.url}`);
      }
    })
    .catch((error) => {
      logger.warn(`[music] request failed: ${error.stack ?? error.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(error.message);
      } else res.destroy();
    });
});

/** Open a URL in the system browser, best-effort and detached. */
function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const argsFor = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = execFile(command, argsFor, (error) => {
    if (error) logger.warn(`[music] could not open a browser: ${error.message}`);
  });
  child.unref?.();
}

const panelUrl = `http://127.0.0.1:${port}${base}/panel`;
server.listen(port, '127.0.0.1', () => {
  logger.info(`[music] standalone player at ${panelUrl}`);
  if (flag('open')) openBrowser(panelUrl);
});

function shutdown() {
  clearInterval(sweep);
  router.dispose();
  store.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
