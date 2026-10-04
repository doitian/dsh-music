# @doitian/dsh-music

NetEase Cloud Music ([music.163.com](https://music.163.com)) playback and an AI DJ, inside DeepSeek Harness.

A **Music** entry appears in the DSH sidebar. It opens a player — your queue, synced lyrics, an `<audio>` element that streams through the host, QR sign-in, and a continuous AI DJ. The same player is also exposed to the agent through seven tools, so it can search, queue, and curate from a conversation.

```
┌──────────────────────────────────────────────────────────────────┐
│ 音乐 music.163.com              [AI DJ] [mood] [account]         │
│                                                                  │
│ ♪ 海屿你 — 马也_Crabbit                                          │
│ 上一首 · 播放 · 下一首 · 列表 · 喜欢 · 静音 · 音量               │
│                                                                  │
│ 歌词 Lyrics                                                      │
│ [00:12.40] ...                                                   │
│ 播放队列 Queue (12)                                              │
└──────────────────────────────────────────────────────────────────┘
```

## Install

The package is self-contained — **no dependencies, no build step, no peer
packages** — so it installs either from npm or straight from a checkout.

### From npm

The package is published as **`@doitian/dsh-music`**. In the Desktop app, install
it from the GUI, because the `dsh plugin` CLI refuses this profile
(`profile "desktop" is managed exclusively by the Electron application`):

**Plugins** page → **Add plugin** → `@doitian/dsh-music`

For any other profile, from a shell:

```powershell
dsh plugin --profile <name> add @doitian/dsh-music
```

### From a checkout

Point the profile at a working tree instead — this is what developing the plugin
looks like. Add it to the profile's `package.json` directly:

```json
{
  "dependencies": {
    "@doitian/dsh-music": "link:C:/path/to/dsh-music"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@doitian/dsh-music"
      ]
    }
  }
}
```

A `link:` dependency keeps the profile pointing at the working tree, so edits
need no reinstall. Note that this is what makes a plugin *remount* re-read the
served page while the module stays cached — see
[Reloading a change](#reloading-a-change).

**Language.** The UI follows the Harness language (Settings → Language): the
sidebar label and error page register a zh/en dictionary with the host's
`locale` service, and the player page follows the shell's `<html lang>` live.
Switching language re-renders both in place — no restart.

While a profile is linked, the Desktop app's **Add plugin** flow is the wrong
tool for it: that flow installs the published tarball, which replaces the
`link:` dependency. Re-add the link if it happens.

### Either way

The bundle's own `cordis.patch.yml` inserts the plugin entry, so no
`cordis.patch.yml` edit is required. Restart the app (or reload the profile) and
**Music** appears in the sidebar.

## Sign in (optional)

Without credentials the plugin works anonymously: search, charts, playlists,
lyrics, and non-VIP playback all function. VIP tracks return no audio URL.

Sign in from the player (**登录 Sign in** in the header), which renders a QR
code to scan with the NetEase Cloud Music mobile app, or ask the agent to use
`music_login`. The session cookie is stored in `$DSH_HOME/music/session.json`.

`fee=1` (VIP-only) tracks are gated by NetEase for anonymous sessions; that is
an upstream entitlement rule, not a plugin limit.

## Agent tools

| Tool | Purpose |
|---|---|
| `music_search` | Search NetEase for songs; returns ids usable below. |
| `music_play` | Queue and start playback, by ids or by search query. |
| `music_queue` | Show / append / insert / replace / remove / jump / clear the queue. |
| `music_control` | play, pause, toggle, next, previous, seek, volume, mute, mode. |
| `music_dj` | Run or configure the AI DJ, with an optional mood brief. |
| `music_now_playing` | What is playing, what is next, and whether the account is signed in. |
| `music_login` | status / qr / poll / set_cookie / logout. |

Playback happens in the browser panel, so nothing is audible until the user has
opened the Music page.

## Streaming quality

The transport row carries a quality picker. Levels, richest first:

| Level | What it serves |
|---|---|
| `jymaster` / `dolby` / `sky` / `jyeffect` | the object-audio tiers; often answered with the Hi-Res stream, and `sky` is frequently refused outright |
| `hires` | FLAC, ~1677–1785 kbps (51–63 MB per track on a VIP account) |
| `lossless` | FLAC, ~908–1016 kbps (28–36 MB) |
| `exhigh` *(default)* | 320 kbps MP3 (~10 MB) |
| `higher` / `standard` | 192 / 128 kbps MP3 |

**A refusal walks down the ladder.** Entitlement and availability are per track:
a track with no lossless master, or a level the region does not carry, answers
`code -110` while the same track streams fine one tier lower. The request steps
down until something plays, and the caption reports what was *actually* served —
`▶ FLAC · 1677 kbps`, or `▶ MP3 · 320 kbps (exhigh, 已降级/downgraded)` when the
rich request could not be honoured. It never silently pretends, and it never
leaves you with silence because you asked for more than the track has.

The choice is saved in `session.json` and beats `config.audioLevel` in the
profile patch, the same precedence the DJ's model route uses. An unknown value in
either place falls back to `exhigh` rather than failing a stream.

Two implementation details worth knowing:

- **The level rides in the stream URL** (`/music/stream/<id>?level=lossless`),
  and the CDN-URL cache is keyed by level as well as track. The same track at
  two qualities is two different files, so reusing one resolution while the
  browser range-requests the other would corrupt the byte stream.
- **Switching quality mid-track loads a fresh resource and resumes in place**,
  restoring the position from the previous file once metadata arrives, rather
  than restarting the song. The resource check runs on every poll, not behind
  the transport-revision gate — quality is not a one-shot transport change, and
  gating it meant a switch did nothing until something else moved the revision.

`/music/health` reports both: `audio.preferred` and `audio.last` (what the last
stream actually served, including `downgraded`).

## The AI DJ

The DJ keeps the queue stocked. When the queue drops below
`djAutoExtendBelow`, it gathers candidates and appends a batch:

- similar songs for the current and recently played tracks (`simiSong`),
- the daily recommendations and the anonymous new-song feed,
- the official charts,
- keyword search for the mood brief.

Then one of two tiers chooses:

- **Model tier** — when `dj.provider` and `dj.model` are configured (or a
  single provider is discoverable), the candidate pool plus a taste digest
  (recently played, favourite artists, likes, dislikes) goes to
  `ctx.llm.stream()`, and the model returns the picks and a one-line vibe. This
  is the tier that reasons about a mood.
- **Heuristic tier** — always available: candidates are scored by artist
  affinity, novelty against play history, and explicit like/dislike feedback,
  then interleaved so consecutive tracks do not share an artist.

**Every model call carries a session identity.** A leaf call cannot set headers
— `GenerateOptions` has no `headers` field — so `sessionId` is the only identity
a plugin can give a provider, and each adapter maps it onto whatever that
provider calls a per-conversation header: pi-ai emits `x-opencode-session` for
the `opencode-go` route. Without it, a provider that keys on the conversation
sees an anonymous client ignoring its conventions.

The identity is minted once per install and persisted in `session.json`, so
every plan and every restart stays inside one conversation; `dj.sessionId` pins
it explicitly instead. A request with no identity is refused rather than sent
bare, so the failure is a recorded `dj.modelError` rather than a silent one.

Two other properties are worth knowing:

- **The DJ is not an agent, and does not start one.** It is plugin code that
  gathers candidates, makes one model call, and stocks the queue. Routing that
  call through a DSH agent would buy conversation memory and an audit trail at
  the cost of a session lifecycle (rotation, tool masking, disposal).
- **The model tier is stateless.** Each plan sends its own pool and gets its
  picks back; there is no accumulated transcript, no context growth and no drift
  from a previous mood — which is the property, not a limitation, for this job.

The model tier is optional and silent on failure; the DJ never blocks playback.
It only ever **stocks the queue** — it never starts or stops playback, so a
top-up while paused stays paused, and one that refills an empty queue after the
last track ended resumes on its own because the desired state was already
"playing".

### Choosing the model

**In the player.** The right column carries a **AI DJ 模型 / DJ model**
panel: a provider picker, a model picker, and three buttons.

| Control | What it does |
|---|---|
| **保存 Save** | Applies the pair immediately and persists it in `session.json` |
| **测试 Test** | Runs one throwaway plan (nothing is queued) and reports the route it used, the track it would have picked, and — on failure — exactly why |
| **回退 Revert** | Clears the saved choice so the profile patch applies again |

The picker lists every registered provider route and that route's catalogued
models. The catalogue is **advisory**: core resolution accepts unlisted ids, so
**其他… / Other…** reveals a text field for any id the route serves — which is
how you keep using a model the adapter's catalogue does not list.

Selection precedence, highest first:

1. **the player's saved choice** (`settings.djProvider` / `settings.djModel`)
2. **the profile patch** (`config.dj.provider` / `config.dj.model`)
3. **discovery** — the first route, then its first catalogued model

The source is shown next to the heading: *面板 / panel*, *配置 / profile*, or
*自动 / auto*. Saving beats the patch deliberately; otherwise a stale patch pin
would silently override what you just picked. **回退 Revert** is how you hand
control back to the patch.

**In the profile patch**, as a default for a fresh install:

```yaml
- id: music
  name: '@doitian/dsh-music'
  config:
    dj:
      provider: opencode-go
      model: deepseek-v4.1-flash
```

Both names must be ones the host actually serves. `provider` is a registered
adapter route — read them from the `llm-pi-ai` entry's `config.providers` (or
ask the agent for `ctx.llm.listProviders()`); `model` is any id that route
accepts.

**Pin it, or follow the session.** With both fields unset the DJ inherits
`agent-default-model` — the same selection the composer's model picker writes,
so it is the model the agent loop itself runs on — which is why "use my session
model" needs no configuration. Pinning `dj.provider`/`dj.model` curates on
something else instead, and pinning is what makes the two choices independent:

```yaml
- id: agent-default-model        # the agent loop / session model
  config: { provider: opencode-go, model: deepseek-v4.1-flash }
- id: music
  config:
    dj:                          # the DJ's own model, when you want a different one
      provider: opencode-go
      model: minimax-m3
```

Three things worth knowing:

- **`config` is replaced, not merged.** The loader assigns the whole object
  (`entry.ts`: `this.options.config = value`), so if you also want, say,
  `audioLevel`, keep every option in one block. Schema defaults fill the rest.
- **Discovery is the last resort, and its choice is arbitrary.** Only when
  neither a pin nor `agent-default-model` exists does the DJ ask the mounted LLM
  service for its routes (`listProviders()`), take the first, then take that
  route's first catalogue entry. On this machine `opencode-go`'s catalogue is
  `minimax-m3, deepseek-v4-flash, gpt-5.6-luna`, so discovery curates with
  **MiniMax-M3** — not a recommendation, just the first row.
- **Partial pins are honoured.** A `provider` alone keeps that route and picks
  its first catalogue model; a `model` alone keeps that model on the first
  route.

Confirm it took effect:

| Where | What to look for |
|---|---|
| `/music/health` | `dj.model` is your pinned pair; `dj.modelSource` is `panel`, `config`, `agent-default` or `discovered`; `dj.resolvedFrom` is what the last plan actually used (`pin`, `agent-default`, `discovered`); `dj.sessionModel` is the deployment's own model; `dj.lastRoute` is the route that curated the last batch; `dj.sessionId` is the identity every call carries; `dj.modelError` is `null` once the tier works |
| Player, DJ status line | **AI DJ** plus the route (heuristic runs read **AI DJ (heuristic)**, and a declined tier prints the reason) |
| **测试 Test** in the player | Answers "does this route work?" in one click, without touching the queue |
| `music_dj` tool result | `AI DJ is on (model via opencode-go/deepseek-v4.1-flash)` |

**If the tier declines, `dj.modelError` says why** — the tier is non-fatal by
design, so without that field every cause looks the same. It reports
`no LLM service is mounted (ctx.get("llm") returned nothing)` when no adapter
service is present, names a half-configured pin (`opencode-go/?`), or carries
the provider's own failure (a `LlmError` code such as `NO_ADAPTER`,
`MISSING_CREDENTIAL`, `AUTH`, `RATE_LIMIT`). The heuristic tier covers that batch
either way.

**If a provider says your usage does not follow its conventions**, the first
thing to check is the route's identity, not the request: pi-ai adds
`x-opencode-session` only for its own catalog routes `opencode-go` and
`opencode`. A hand-declared route id that merely points at
`https://opencode.ai/zen/go/v1` gets no wrapper and therefore no header, with
nothing in the logs to say so — keep the catalog route name. For the same
reason, do not set `x-opencode-session` in a profile's `headers`: the adapter
lets a configured value win over the generated one, which would freeze a single
id across every conversation. What remains after that is entitlement rather
than convention — a plan that only permits its own client's traffic cannot be
satisfied by a header, only by delegating transport to that client.

To see the bytes rather than trust the reasoning, run the bundled probe, point a
route's `baseURL` at it for one plan, and read what actually leaves the process:

```powershell
npm run probe:headers          # http://127.0.0.1:8787 -> https://opencode.ai
```

You should see `x-opencode-session` carrying the DJ's id, and
`user-agent: deepseek-harness/<version> (+…)` — attribution that must never be
replaced by a provider-shaped one. Take the `baseURL` back out afterwards.

Editing `config` recomposes the running host, but **the plugin module itself is
cached** — restart the harness for the new route to take effect. If the model
tier fails for any reason (no adapter, bad credentials, unparseable reply,
rate limit) the DJ logs a warning and falls back to the heuristic tier for that
batch; it never leaves the queue empty.

### Heuristic tier

Always available, used whenever the model tier is unavailable:

## Configuration

Defaults live in the package, so the profile patch stays empty. To override,
add `config` to the inserted entry:

```yaml
- insert:
    - id: music
      name: '@doitian/dsh-music'
      config:
        audioLevel: exhigh          # exhigh (320 kbps) | standard | higher | lossless
        dataDir: D:\dsh-data\music  # default $DSH_HOME/music
        requestTimeoutMs: 15000
        dj:
          provider: opencode-go     # enables the model tier
          model: deepseek-v4.1-flash
          sessionId: music-dj-mine  # optional: pin the provider-visible identity
```

| Field | Default | Meaning |
|---|---|---|
| `apiPrefix` | `music` | Route prefix. **Changing this also requires editing `BASE` in `lib/client.js`.** |
| `dataDir` | `$DSH_HOME/music` | Where `session.json` (cookie, history, feedback, settings) lives. |
| `audioLevel` | `exhigh` | Initial streaming quality, until the player's picker records a choice. One of the levels above; an unknown value falls back to `exhigh`. |
| `requestTimeoutMs` | `15000` | Per-request deadline for NetEase calls. |
| `dj.provider` / `dj.model` | unset | Model route for the DJ's model tier — see [Choosing the model](#choosing-the-model). Unset, the tier follows `agent-default-model` and only then falls back to discovery; any failure falls back to heuristics. |
| `dj.sessionId` | minted, persisted | The identity every model call carries. Adapters map it onto the provider's per-conversation header. Pin it to control what a provider sees, or leave it unset and let the DJ mint one per install. |

Player preferences (quality, DJ on/off, mood brief, batch size, extend
threshold) are persisted in `session.json` and edited from the panel.

## How it works

```
browser (DSH web GUI, http://127.0.0.1:<port>)
  ├─ client plugin — mounted for the plugin's whole lifetime
  │    └─ audio engine ── <audio src="/music/stream/<id>"> ──▶ host audio proxy
  │         (keeps playing while you are in a session)
  └─ sidebar "音乐 Music" ── iframe ──▶ /music/panel   (player UI, no audio)
                                            │  fetch (same origin)
                                            ▼
                                      /music/api/*          (JSON)
                                      /music/stream/<id>    (audio bytes)
                                            │
                        host plugin  ───────┘
                          ├─ lib/netease.js   NetEase web API (no weapi encryption)
                          ├─ lib/session.js   cookie store + QR login state machine
                          ├─ lib/state.js     queue, cursor, transport revisions
                          ├─ lib/dj.js        candidate pool + model/heuristic tiers
                          └─ lib/router.js    JSON API, HTML, Range-capable audio proxy
```

Four design notes:

- **Audio is proxied, not redirected.** CDN URLs expire after 20 minutes and
  need the session cookie at *resolution* time, so the host resolves and streams
  the bytes (cache 15 min, `Range` forwarded upstream so seeking works). It also
  keeps playback same-origin, avoiding mixed-content and CORS entirely.
- **Playback lives in the shell document, not in the page.** The layout renders
  only the **active** `main` slot entry —
  `renderSlot('main', {}, { entryKey: activePanelId ?? 'conversation' })` — so
  opening a Session unmounts the Music page and discards its document. An
  `<audio>` owned by that page would stop the music, which is exactly what
  happened before contract 2. The engine is created on the client plugin's own
  lifetime, survives every panel switch, and the page is a remote control:
  `window.__dshMusicEngine.sync()` applies a command without waiting for the
  next poll. A `panelContract` value on `/music/health` keeps a half-updated
  browser (new bundle, old host) from playing every track twice.
- **The host owns the desired state; the engine owns the audio element.** They
  reconcile through `rev` / `transportRev` counters, so agent tools, the page,
  and the DJ all drive one state machine instead of three.
- **The client half is hand-written.** `lib/client.js` is a plain
  `window.__ModuleLoader__` bundle using only baseline `react`, so there is no
  tsdown/Vite step. It registers the sidebar row (`sidebar.panellist`, a list
  slot) and the page (`main`, the layout's keyed slot) with the same id, and
  `ctx.slots.inject` waits for those slots to be declared.

## Security notes

- The `/music` route prefix is registered on the bare HTTP server, which owns no
  authentication of its own. Anyone who can reach the port can browse the
  library and stream audio; the route is loopback-only in the shipped
  composition. It exposes no credentials — only search results, the queue, and
  audio bytes.
- The NetEase cookie lives in `$DSH_HOME/music/session.json` in plain text, the
  same posture as the rest of the profile's session data. `music_login` with
  `set_cookie` accepts a pasted `MUSIC_U`, and the value is never returned by any
  endpoint.

### Diagnostics

`GET /music/health` is unauthenticated and answers with the facts worth having
when something looks wrong:

```json
{
  "ok": true,
  "prefix": "/music",
  "panelContract": 2,
  "authenticated": true,
  "account": { "nickname": "…", "vip": true },
  "playing": false,
  "queued": 0,
  "tools": ["music_search", "music_play", "music_queue", "music_control",
            "music_dj", "music_now_playing", "music_login"],
  "dj": { "enabled": false, "model": null, "lastRoute": null,
          "modelError": null, "lastPlanAt": null, "error": null },
  "dataDir": "C:\\Users\\…\\.dsh\\music",
  "session": { "authenticated": true, "nickname": "…", "vip": true },
  "uptimeMs": 123456
}
```

`tools` is the point: the HTTP route is registered before the tools, so a tool
that failed to register would otherwise leave a route that answers normally.
Seeing all seven names is what proves startup completed. `panelContract` is the
page/engine boundary the browser half checks before it starts playback.

### If the browser blocks autoplay

Chromium refuses to start audio until the page has been **interacted with**, and
the plugin's desired state can say "playing" long before that — the agent
queued something, or the DJ refilled the queue while the page was loading. The
player then shows:

> 浏览器需要你先与页面交互一次才会播放声音 / Chromium needs one interaction with this window before it will play audio

**Click the button, or anywhere in the window.** That one gesture grants sticky
activation for the rest of the page's life, after which agent- and DJ-initiated
playback works without asking again. Typing in the chat counts too.

The engine retries on every 500 ms poll, so recovery is automatic — and it must
be, because a refused `play()` does not change the transport revision. Gating
the retry behind that revision (an earlier bug) left the music stopped for good,
with the hint showing and pressing it doing nothing.

### Who owns the `<audio>` element

Normally the client plugin's **engine in the shell document**, so playback
survives opening a session (the layout renders only the *active* panel). But the
player page is re-read from disk on every plugin mount, while the browser bundle
it pairs with is pinned to its own revision — so the two can disagree. When they
do, `GET /music/health` will not advertise the matching `panelContract`, the
engine declares itself inert, and **the page owns the audio element itself**.
That is the older behaviour: it plays normally, it just stops when you open a
session. Exactly one transport ever owns playback; the unusable one is stood
down first. A restart brings both halves back into agreement.

## Development

```powershell
npm run check        # node --check on every module
npm test             # 76 deterministic tests: pure, DJ, browser half
npm run test:live    # 23 integration tests against the live NetEase API
npm run test:all     # both
```

The split matters for CI. `npm test` never touches the network, so it is what
runs on every push and gates a release. `npm run test:live` drives the real API,
and **GitHub's runners cannot reach it** — from a US runner
`/api/search/get/web` answers in ~350 ms with an empty result set, so its first
assertion fails on a network condition rather than a regression. It therefore
lives in `.github/workflows/live.yml` on manual dispatch only, and the
authoritative run is local, before a release. `MUSIC_OFFLINE=1` skips the
network cases inside it.

Or run one file directly:

```powershell
node test/netease.test.mjs   # 18 pure: normalisation, quality ladder, cookies, player state
node test/dj.test.mjs        # 37 AI DJ: model call identity, route resolution, failure reporting, queue invariants
node test/client.test.mjs    # 21 browser half: the engine against a fake DOM, and the page it pairs with
node test/host.test.mjs      # 23 integration: routes, streaming, curation, quality
```

The DJ tests drive `ctx.llm.stream()` with a stub that emits the documented
chunks, and stub `ctx.agentDefaultModel` for route inheritance. So the
pinned-route happy path, both chunk spellings (`type`/`kind`), index filtering,
prose-wrapped JSON, the session identity every call must carry, inheritance from
the session model, discovery, and every fallback are covered without a provider.

The integration tests mount the plugin against stand-in `tools`/`webServer`
services and drive the captured route over a real `node:http` server, so they
exercise the same path the browser takes — including a real `Range` request
against the NetEase CDN and a real AI DJ plan. Because they talk to a live
third-party API, an occasional failure there can be the network rather than the
code; re-run before investigating.

The browser-half tests execute `lib/client.js` for real against a minimal fake
DOM (fake `window`, `document`, `fetch`), which is how the central property is
proven: **the engine creates and drives the `<audio>` element with no React
component ever rendered**, so playback cannot depend on the Music page being
mounted. They also cover the seek handshake, failure reporting, disposal, and
the contract handshake.

The same fake DOM boots `lib/panel.html` itself, with an engine that reports
`playback: true` — the shell document owns the audio element. That is the case
where the page must fetch everything it renders on its own: lyrics used to be
requested only from the local fallback transport's `applySource`, so with the
engine playing the pane stayed empty for every track. Three tests hold the
line: the rendered track is asked for, one fetch per track rather than one per
poll, and a track change replaces the pane. Two more cover the pane's shape: it
is capped to a few lines, collapses to its header on demand, and remembers that
choice across loads — while still fetching the lines, so expanding is instant.

`npm test` runs the three deterministic files in sequence (`npm run test:all`
adds the live one), deliberately **not** `node --test <dir>`: the directory form forks one child process per file, which
is blocked in sandboxed environments.

### Reloading a change

- **Profile configuration** changes (bundle selection, `cordis.patch.yml`)
  recompose the running host: the loader re-reads the layers and mounts or
  unmounts the affected entry. Adding the bundle to `dsh.profile.bundles` and
  touching `cordis.patch.yml` was enough to load the plugin into an already
  running host.
- **Plugin source** changes need a **process restart**. A disable/enable
  round-trip does remount the entry (the route genuinely goes away and comes
  back), but Node caches the ESM module, so the remounted entry runs the *old*
  code. Treat `lib/*.js` and `lib/panel.html` edits as restart-required.
- **Agent tools** register on the host, so they appear in **new** agent
  sessions. A session that was already running keeps the tool list it started
  with.

`lib/vendor/qrcode.js` is the MIT-licensed
[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by
Kazuhiko Arase, vendored so QR sign-in needs no network call or build step.

### Releasing

Releases are cut from GitHub and published by the `publish` workflow with **npm
trusted publishing (OIDC)**. There is no `NPM_TOKEN` secret and no
`NODE_AUTH_TOKEN` in the repository, and adding one would disable the OIDC
exchange and break publishing.

1. Bump `version` in `package.json`, commit, and push.
2. Create a GitHub release whose tag is `v<version>` — `v0.1.2` for `0.1.2` —
   pointing at that commit.

The workflow runs `npm run check`, the deterministic suites, asserts the tag
matches `package.json`, and publishes. A tag push alone publishes nothing: the
trigger is `release: published`.

Two timings look like failures and are not:

- **A green job is not yet a live version.** The registry records a
  `0.0.0-stage` placeholder first and reports the package as *being processed*;
  the version becomes installable roughly a minute later. Inside that window the
  packument still answers `404`, and publishing the same version from a second
  place is refused with `409 Cannot publish over previously staged version`.
- **Registry reads can lag the publish**, so an `npm view` run immediately
  afterwards may still say `404`. Wait a minute, or read it from CI instead.

Versions published this way carry a SLSA provenance attestation naming the
workflow, tag, and commit — `npm view @doitian/dsh-music@<version> dist.attestations`.
`0.1.0` predates the trusted publisher: it was published by hand and has none.

## Known limitations

- **Anonymous sessions cannot play VIP tracks**; NetEase returns `url: null`.
- **Some tracks are gated by *purchase*, not VIP**, and stay unplayable even for
  a signed-in VIP account — 周杰伦's 晴天 (`id 186016`) is the canonical example,
  because it belongs to a digital album. The plugin surfaces NetEase's own
  refusal (`403` plus a reason) rather than retrying.
- **No `weapi`/`eapi` encryption**, so like/scrobble/playlist-write endpoints
  (which require it) are not implemented. Liking a track is recorded locally and
  fed to the DJ instead.
- **`apiPrefix` must stay `music`** unless `BASE` in `lib/client.js` is changed
  to match.
- **The DJ's model tier is covered against stub contracts, not a live
  provider** — request building, the session identity, route resolution, both
  chunk spellings, index filtering and every fallback are tested, but a real
  end-to-end model call has not been observed here. The heuristic tier is what
  the live runs exercised.
- **The identity only becomes a header on the catalog routes that define one.**
  pi-ai adds `x-opencode-session` for its own `opencode-go`/`opencode` routes. A
  hand-declared route id pointing at the same endpoint gets no wrapper, so the
  header is simply absent — keep the catalog route name, and never pin
  `x-opencode-session` in a profile's `headers` (a configured value wins over
  the generated one and freezes a single id for every conversation).
- **Chromium autoplay policy** may block playback the agent starts before the
  user has interacted with the page; the panel then shows a *click to play* hint.
