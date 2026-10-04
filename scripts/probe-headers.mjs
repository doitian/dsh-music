/**
 * Prove — on the wire — which headers the DJ's model call actually carries.
 *
 * The plugin can only guarantee that it passes a non-empty `sessionId`; the
 * mapping from that field to a provider header belongs to the adapter (pi-ai
 * emits `x-opencode-session` for its `opencode-go`/`opencode` routes). Nothing
 * in the plugin can observe the bytes, so this probe sits between the harness
 * and the provider and prints what leaves the process.
 *
 * Point a route at it for one plan, then take the `baseURL` back out:
 *
 *   - id: llm-pi-ai
 *     config:
 *       providers:
 *         opencode-go:
 *           apiKeyEnv: OPENCODE_GO_API_KEY
 *           baseURL: http://127.0.0.1:8787     # temporary
 *
 *   node scripts/probe-headers.mjs
 *   # then press 测试 Test in the player, or:
 *   curl -X POST http://127.0.0.1:<dsh-port>/music/api/dj/test
 *
 * What to look for: `x-opencode-session` present with the id the plugin minted
 * (or the one pinned in `dj.sessionId`), and a `user-agent` of
 * `deepseek-harness/<version> (+…)` — the honest attribution that must never be
 * replaced by a provider-shaped one.
 *
 * If `x-opencode-session` is *absent*, the cause is almost always the route
 * identity rather than the request: the wrapper belongs to the catalog route,
 * so a hand-declared route id pointing at the same endpoint gets none.
 *
 * Nothing is logged into a file, the body is forwarded byte for byte, and the
 * only credential this script touches is the one already in the request.
 *
 * @module dsh-music/scripts/probe-headers
 */

import http from 'node:http';
import https from 'node:https';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

/** Upstream origin to forward to; the request path is preserved verbatim. */
const UPSTREAM = new URL(flag('upstream', 'https://opencode.ai'));
/** Local port the route's temporary `baseURL` should point at. */
const PORT = Number(flag('port', '8787'));
/** Header names worth calling out; everything else is summarized by count. */
const WATCHED = ['x-opencode-session', 'user-agent', 'authorization', 'x-api-key', 'anthropic-version'];

/** Render one header for the log without leaking a credential. */
function showHeader(name, value) {
  if (name === 'authorization' || name === 'x-api-key') {
    const text = String(value);
    return `${text.slice(0, 12)}…(${text.length} chars)`;
  }
  return String(value);
}

let requestCount = 0;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    requestCount += 1;
    const seen = new Set();

    console.log(`\n#${requestCount} ${req.method} ${req.url} → ${UPSTREAM.origin} (${body.length} byte body)`);
    for (const [name, value] of Object.entries(req.headers)) {
      seen.add(name.toLowerCase());
      if (WATCHED.includes(name.toLowerCase())) console.log(`  ${name}: ${showHeader(name.toLowerCase(), value)}`);
    }
    for (const name of WATCHED) {
      if (!seen.has(name)) console.log(`  ${name}: (absent)`);
    }
    const others = Object.keys(req.headers).filter((name) => !WATCHED.includes(name.toLowerCase()));
    console.log(`  other headers: ${others.length ? others.join(', ') : '(none)'}`);

    // Forward exactly what arrived, with the upstream host swapped in.
    const forwarded = { ...req.headers, host: UPSTREAM.host };
    delete forwarded['content-length'];
    const options = {
      method: req.method,
      headers: { ...forwarded, 'content-length': body.length },
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port || (UPSTREAM.protocol === 'https:' ? 443 : 80),
      path: req.url,
    };
    const upstream = (UPSTREAM.protocol === 'https:' ? https : http).request(options, (reply) => {
      console.log(`  ← ${reply.statusCode} ${reply.headers['content-type'] ?? ''}`);
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    });
    upstream.on('error', (error) => {
      console.error(`  upstream failed: ${error.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `probe could not reach ${UPSTREAM.origin}: ${error.message}` }));
    });
    upstream.end(body);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`header probe listening on http://127.0.0.1:${PORT} → ${UPSTREAM.origin}`);
  console.log('set that as a route baseURL temporarily, run one plan, then remove it. Ctrl-C to stop.');
});
