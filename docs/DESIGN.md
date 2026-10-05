# dsh-music: developer and design notes

The [README](../README.md) is for people using the plugin. This document is
for working on it: how to run it from a checkout, how it is built and tested,
and the reasoning behind its behaviour — why each choice was made, what was
tried and dropped, and the numbers behind the DJ.

## Running from a checkout

The package has no dependencies and no build step. Point a profile at a
working tree by linking it in the profile's `package.json`:

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

A `link:` dependency keeps the profile on the working tree, so edits need no
reinstall — but they do need a restart; see
[Reloading a change](#reloading-a-change). The desktop app's **Add plugin**
flow installs the published tarball, which replaces the `link:` dependency, so
don't use it on a linked profile. The bundle's own `cordis.patch.yml` inserts
the plugin entry.

The UI's language follows the Harness: the sidebar label and error page
register a zh/en dictionary with the host's `locale` service, and the player
page follows the shell's `<html lang>` live, re-rendering in place.

## Streaming quality

The player carries a quality picker under the transport controls. Levels, richest first:

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

## Likes and taste

A track holds one of three taste levels — **liked**, **unrated**, or
**disliked** — and the player draws whichever it is:

| Control | Level it sets |
|---|---|
| the **♡ / ♥** in a queue row, or the heart beside the title | **liked** — the track goes into the account's 我喜欢的音乐 playlist on NetEase. Clicking the filled heart takes the like back. |
| the **✕** beside the title | **disliked** — local, and fed to the DJ, which stops picking the track. The track leaves the queue, so playback moves on to the next one. |
| the **✕** on a queue row | **disliked** as well. Taking a track out of the queue is a judgement about the track, not just about the list — without recording it the DJ re-derives the same track from the same similarity and charts within a batch or two. |
| neither | unrated. |

A like is a **NetEase** like, not a plugin flag, and the two halves of what that
needs are both plain endpoints:

- `POST /api/song/like` — one of the few *write* endpoints the web API still
  serves unencrypted, so no `weapi` client is needed. It takes the direction
  rather than toggling: the page always says which level it wants, so a stale
  poll cannot turn a click into the wrong one, and disliking a liked track is one
  request instead of two racing ones.
- `GET /api/song/like/check` — which of a batch of ids are liked. The answer is
  cached per track (5 minutes), so a whole queue's hearts cost one request, and
  only tracks with no fresh answer ever cost another.

Six properties are worth knowing, because they are what makes a heart mean
something:

- **An unknown track is not an unliked one.** A track nobody has asked about has
  no answer, and renders as unrated until NetEase gives one.
- **A refusal is not an answer.** An anonymous session answers `code 301` for
  every id, and a delisted track answers `400` with NetEase's own reason
  (`下架歌曲无法收藏` for 晴天, for instance). Both leave the heart empty and say
  why in the toast; a refused check is retried later instead of being cached as
  "not liked", so signing in mid-session fills the hearts without a restart.
- **The account is the record.** `feedback.likes` in `session.json` is a *copy*
  of the account's likes, kept for the DJ's taste digest. It is reconciled with
  the account at startup — one read of the liked playlist — so a like made on
  the phone counts, and a like an earlier build recorded locally (because it had
  nowhere to send it) does not linger as a phantom. The copy keeps the newest
  500 likes.
- **A dislike is local.** The plain web API has no dislike endpoint, so this is
  where the plugin's own taste memory is the only record. Liking and disliking
  are the same three levels rather than two flags: one replaces the other, and
  disliking a liked track removes it on NetEase as well.
- **A dislike leaves the queue.** Whatever sends it — the transport's ✕, the
  legacy `/feedback` route, a row removal — a dislike passes through
  `applyTaste`, which takes the track out of the queue wherever it sits. The
  playing track goes too, and playback moves on to the next; past the end of
  the queue it wraps to the start, as `next` does. The page therefore sends the
  level alone: pressing next as well would skip a second track. A disliked
  track queued again on purpose stays, drawn with a filled ✕, which clears the
  level.
- **Removing a queued track is a dislike, once.** The row's ✕ goes through the
  queue endpoint, whose removal *is* the judgement: the row leaves the list and
  an unrated track is recorded as disliked in the same request, so the DJ does
  not derive it again from the same similarity. The confirm names the removal —
  the judgement is the host's side of it. A track that already carries a level
  keeps it, because removing is often just queue housekeeping (clearing out what
  has already been heard) and rewriting a like into a dislike would be worse
  than missing the signal. Removing the track that is playing also advances
  playback.

### Skips

A skip is a fourth, softer signal, with no button of its own:
**moving to the next track before 30 seconds, or before a quarter of the track
when that is longer**, records one — from the player's next button or the agent's
`music_control next`; jumping to a queue row does not count. It is local, like
a dislike.

What does *not* count is as deliberate as what does: going back, a track ending
or failing on its own, single-repeat mode (which stays on the track), and a
track that never reported a position — paused, blocked by autoplay, or still
loading — because a track nobody heard was not rejected. Nor does disliking:
the host removes a disliked track and moves on without a next, and a next
pressed on a disliked track queued again on purpose is not counted either. The
dislike is already the record, and counting it as a skip too would weigh an
early dislike more than a later one.

### Heard through

The other side of a skip. Every track that plays is recorded in the history,
which the DJ reads its favourites and similarity seeds from — so a track the
DJ queued itself used to count as approval of itself. On one account, a few
batches drawn from the charts made Chinese pop the favourites, the favourites
seeded more of it, and the history ended up 74% Chinese while the account's
likes were 31%.

A track the DJ queued is therefore marked (`queuedBy: 'dj'`) and recorded as
**tentative**. It still counts as played, so it is not picked again soon, but
it counts as taste only once the listener is past the skip window or it ends;
`Player.onHeard` reports that, once per play. A track the listener or the
agent chose counts at once. Plays recorded before the marker existed count as
heard: there is no telling who queued them, so they are left to age out of the
60- and 150-play windows the taste is read from rather than rewritten.

The likes balance the history. The DJ looks up the newest 200 likes (cached
per track, 50 per request), counts each liked track's artists twice toward
the favourites, and shows the model liked songs by name — before, it saw only
likes that happened to be in the play history, which on that account was 2 of
119.

The DJ reads skips at two grains:

- **Per track.** One skip is a penalty, since it may have been the wrong
  moment rather than the wrong song. A second takes the track out of the pool
  for good, like a dislike.
- **Per artist.** The skip marks the play it cut short in the history, and that
  play stops counting toward the artist's affinity — otherwise abandoning an
  artist's songs would keep making them a "favourite". Skipped plays then count
  against the artist instead, and the model is shown the recently skipped
  tracks and the artists skipped more than once.

## The AI DJ

The DJ keeps the queue stocked. When the queue drops below
`djAutoExtendBelow`, it gathers candidates and appends a batch:

- similar songs (`simiSong`) seeded half from what is playing and recent
  plays heard through, half from random likes — never a disliked or skipped
  track, and each half filling in when the other is thin,
- personal FM (私人FM), two calls of three tracks, when signed in,
- up to six liked tracks not played in the last three days, marked `[liked]`
  for the model,
- the daily recommendations and the anonymous new-song feed,
- the four general charts — 飙升榜, 新歌榜, 原创榜, 热歌榜 — sampled together,
- for a mood brief, its best-loved playlists, and a keyword song search.

Personal FM stands in for heartbeat mode (心动模式), which would be the better
personalised source but answers `code 500` on the plain web API for every seed;
it needs the `weapi` transport this plugin does not implement. `simiSong`
answers five tracks whatever `limit` asks for.

**A brief finds music through playlists.** A song search only matches titles
and lyrics, so "rainy afternoon jazz" mostly finds library tracks literally
named *Rainy Afternoon Jazz*. Listeners name and tag playlists by mood (雨天,
爵士, 深夜…), so the brief searches playlists, takes the most played among
the six most relevant (skipping any under ten tracks), and samples across
them.

**The model rewrites the brief first.** Playlists are named in Chinese, so an
English brief searched as written matches badly — live, "90s cantopop" found
Notorious B.I.G. and Eminem. When a model route is available, one call turns
the brief into up to three Chinese search terms the way listeners name
playlists (`90年代 粤语金曲`, `港乐 经典`, `粤语老歌`), and the same brief then
found 张国荣, 刘德华 and 许冠杰. Each term gets its own playlist, so one broad
term cannot take every slot, and the song search uses the first.

The rewrite is made **once per brief, not per plan**, and kept for a week: a
brief means the same thing next week. It uses the curation route and the same
session identity. Without a model, or when the rewrite answers nothing usable,
the brief is searched as written — the plan never fails over it — and the
rewrite is tried again after half an hour rather than on every plan. The terms
used are reported as `searchedAs` on the plan and on `dj.lastPlan`, and the
`music_dj` result says *Brief searched as: …*.

Then one of two tiers chooses:

- **Model tier** — whenever a model route resolves (a pin, the session's
  default model, or discovery — see [Choosing the model](#choosing-the-model)),
  the candidate pool plus a taste digest — recently played, favourite artists,
  likes, dislikes, skips, what is already queued and which track the picks will
  follow — goes to the model in one `ctx.llm.stream()` call, and it returns the
  picks and a one-line vibe. This is the tier that reasons about a mood.
- **Heuristic tier** — always available: candidates are scored by mood-brief
  match and artist affinity, then interleaved so consecutive tracks do not
  share an artist. See [Heuristic tier](#heuristic-tier).

Either way, the pool never holds a track that is disliked, recently played, or
**already in the queue** — a batch is appended, so a pick the queue already
holds would be dropped and the batch would come up short. The model is also
told which track its picks will follow, and is held to the count it was asked
for.

**Every model call carries a session identity.** The DJ's model calls are leaf
calls — single requests to the LLM service, outside any agent — and a leaf call
cannot set headers: `GenerateOptions` has no `headers` field. So `sessionId` is
the only identity a plugin can give a provider, and each adapter maps it onto
whatever that provider calls a per-conversation header: pi-ai emits
`x-opencode-session` for the `opencode-go` route. Without it, a provider that keys on the conversation
sees an anonymous client ignoring its conventions.

The identity is minted once per install and persisted in `session.json`, so
every plan and every restart stays inside one conversation; `dj.sessionId` pins
it explicitly instead. A request with no identity is refused rather than sent
bare, so the failure is a recorded `dj.modelError` rather than a silent one.

Two other properties are worth knowing:

- **The DJ is not an agent, and does not start one.** It is plugin code that
  gathers candidates, makes leaf calls — one `ctx.llm.stream()` request in, one
  answer out — and stocks the queue. A plan
  makes one such call to curate, plus one to rewrite a brief the first time
  that brief is seen. Nothing runs through the agent loop: routing the call
  through a DSH agent would buy conversation memory and an audit trail at the
  cost of a session lifecycle (rotation, tool masking, disposal).
- **The model tier is stateless.** Each plan sends its own pool and gets its
  picks back; there is no accumulated transcript, no context growth and no drift
  from a previous mood — which is the property, not a limitation, for this job.
  The only thing kept between calls is a brief's search terms, cached so the
  rewrite is not repeated.

The model tier is optional and silent on failure; the DJ never blocks playback.
It only ever **stocks the queue** — it never starts or stops playback, so a
top-up while paused stays paused, and one that refills an empty queue after the
last track ended resumes on its own because the desired state was already
"playing".

### Boosts

A boost is a temporary push — "more like this" or "fewer like this" for one
track — that expires on its own, by default after an hour. It is for a mood,
not a judgement: a like or dislike is a standing preference the DJ keeps
learning from, and a passing wish for more of one sound should not become
one. Boosts live in `session.json` with their end time (`boosts`, newest
first, one per track, at most 10), so a restart inside the hour keeps them;
expired ones are simply not read. `POST /music/api/boost` sets or clears one
(`direction: more | less | none`, optional `minutes`, 5–720), and `music_dj`
takes `boost`, `boostTrackId` (the playing track by default) and
`boostMinutes`.

What "like this track" means is the track's similar songs — or, for a track
NetEase has none for (晴天 is one), its first artist's songs, so a boost is
never silently a no-op — together with its artists.

- **More.** The track seeds similarity ahead of the regular seeds (up to two
  boosts), and its neighbours are kept whole rather than sampled. Candidates
  near it are marked `[more]` for the model, which is told to favour them,
  and score +3.0 in the heuristic tier — as much as the mood brief, since
  both are the listener saying what they want now.
- **Less.** The track never seeds and is kept out of the pool; candidates
  near it are marked `[fewer]`, which the model is told to avoid unless
  nothing else fits, and score −3.0. A candidate near both is treated as
  `less`.

A boost is also felt at once rather than a batch or two later, but only
while the DJ is on — with it off, the queue is the listener's alone. **More**
queues three of the track's neighbours straight after the current one, as DJ
picks (so they count as taste only once heard through). **Less** removes the
DJ's own upcoming picks that are near it; a track the listener queued, and
the one playing, are never touched.

### Caching, sampling and pacing

Most sources change on the scale of hours or days, so each is cached for
about as long as it stays the same, per account where it is personal:

| Source | Kept for |
|---|---|
| similar songs (per seed), track details (per id) | 24 h |
| a playlist's track list | 12 h |
| a brief's rewrite into search terms | 7 days (30 min after a failed one) |
| the charts, a brief's searches | 6 h |
| the daily recommendations | 3 h |
| the new-song feed | 1 h |
| personal FM | never — every call answers a different three |

**Every plan samples.** Each source contributes a random handful up to its
quota — similar 14, daily 8, charts 8, new songs 6, likes 6, FM 6, and for a
brief 15 from its playlists plus 8 from the song search. Signed in, the
generic feeds give way to the account's own: daily 12, likes 9, charts 4, new
songs 3. The charts are 80–95% Chinese whatever the listener likes, which is a
fair default for an anonymous listener and a poor one for an account whose
daily list says otherwise. Samples are drawn only from
tracks still eligible, and kept in the source's own order. Taking the first
few would serve the same tracks until the source changed; sampling a cached
list yields a different handful every plan for free. It also reaches past
what NetEase sends in full: for a playlist the account does not own, only
the first 20 tracks come with details, but every id does, so the DJ samples
ids from the whole list and looks up just the ones it chose. The quotas also
keep any one source from crowding the others out of the pool.

**Requests are paced, not fired as a burst.** Each request starts a random
0.25–0.75 s after the previous one, so a plan reads like someone clicking
through the app rather than a crawler. Only the DJ's own probing is paced;
searches and plays you ask for go out at once. Live, a first plan with a
brief sends 14 requests over about 7 s; the next one, mostly from cache,
sends 2. The DJ stocks the queue before it runs dry, so the wait is not
heard.

### Choosing the model

**In the player.** The AI DJ card in the right column folds in an **AI DJ 模型 / DJ model**
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
3. **the session's default model** (`agent-default-model`)
4. **discovery** — the first route, then its first catalogued model

The source is shown next to the heading: *面板 / panel*, *配置 / profile*,
*会话模型 / session model*, or *自动 / auto*. Saving beats the patch deliberately; otherwise a stale patch pin
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

**Pin it, or follow the session.** With both fields unset the DJ uses the
session's default model — the `agent-default-model` selection, which the
composer's model picker writes and new conversations start on — which is why
"use my session model" needs no configuration. Only the *choice of model* is
shared: the DJ still calls it with its own leaf calls, never through an agent
or a conversation. Pinning `dj.provider`/`dj.model` curates on something else
instead, and pinning is what makes the two choices independent:

```yaml
- id: agent-default-model        # the session's default model
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

Always available, used whenever the model tier is unavailable. Each candidate
scores:

| Signal | Weight |
|---|---|
| matches the mood brief (its playlists or song search) | +3.0 |
| from personal FM | +1.0 |
| similar to the current or recent tracks | +0.6 |
| a rested like | +0.5 |
| per artist among the favourites — liked tracks' artists (each like counts twice) and plays heard through | +2.2 |
| per artist shared with the current track | +1.4 |
| per artist play heard through, in the last 60 plays | +0.15 each, capped at +1.0 |
| per artist skip among the last 150 plays | −0.6 each, capped at −2.4 |
| skipped once (twice excludes it) | −1.5 |
| near a "more" / "less" boost | +3.0 / −3.0 |
| VIP-only | −0.4 |
| jitter, so repeat plans differ | 0–0.8 |

The brief outweighs a favourite artist on purpose: it is the listener's explicit
ask, and without that weight a chart hit by a favourite would outrank every
track that matches it. The ranked list is then interleaved starting from the
track the batch is appended after, so no two adjacent tracks share an artist —
including the seam between the old queue and the new batch.

## Configuration

Defaults live in the package, so the profile patch stays empty. To override,
add `config` to the inserted entry:

```yaml
- insert:
    - id: music
      name: '@doitian/dsh-music'
      config:
        audioLevel: exhigh          # any level under Streaming quality; exhigh is 320 kbps
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

Player preferences are persisted in `session.json`. Quality, DJ on/off, the
mood brief and the DJ's model route are edited from the panel. The batch size
(`djBatchSize`, default 5) and the refill threshold (`djAutoExtendBelow`,
default 3 — the DJ tops up when fewer tracks than this remain) have no control
in the panel: edit them in `session.json` while the harness is stopped, or pass
`count` to `music_dj` for one batch.

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
                          ├─ lib/cache.js     source cache, pool sampling, request pacing
                          ├─ lib/likes.js     the account's like state, cached
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
  library, stream audio, and **change the account's likes** — `POST
  /music/api/taste` is the panel's own control, so it is a real write to the
  NetEase account. The route is loopback-only in the shipped composition. It
  exposes no credentials — only search results, the queue, the like state, and
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
  "audio": { "preferred": "exhigh", "last": null },
  "authenticated": true,
  "account": { "nickname": "…", "vip": true },
  "playing": false,
  "queued": 0,
  "tools": ["music_search", "music_play", "music_queue", "music_control",
            "music_dj", "music_now_playing", "music_login"],
  "dj": { "enabled": false, "busy": false, "source": null,
          "model": null, "modelSource": "agent-default", "lastRoute": null,
          "modelError": null, "pinned": null,
          "sessionModel": "opencode-go/deepseek-v4.1-flash",
          "resolvedFrom": null, "sessionId": "music-dj-…",
          "lastPlanAt": null, "error": null },
  "likes": { "cached": 12, "pending": 0, "error": null },
  "dataDir": "C:\\Users\\…\\.dsh\\music",
  "session": { "authenticated": true, "nickname": "…", "vip": true },
  "uptimeMs": 123456
}
```

`tools` is the point: the HTTP route is registered before the tools, so a tool
that failed to register would otherwise leave a route that answers normally.
Seeing all seven names is what proves startup completed. `panelContract` is the
page/engine boundary the browser half checks before it starts playback. `likes`
is the cache behind the hearts: `cached` is how many answers it holds, and
`error` names why a check produced none — an anonymous session never asks, so
both stay empty.

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
npm test             # 176 deterministic tests: pure, source cache, like state, DJ, browser half
npm run test:live    # 38 integration tests against the live NetEase API
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
node test/netease.test.mjs   # 39 pure: normalisation, quality ladder, likes, cookies, taste, skips, player state
node test/cache.test.mjs     # 10 source cache: lifetimes, shared loads, sampling, pacing
node test/likes.test.mjs     # 12 like-state cache: what counts as an answer, refusals, batching, writes
node test/dj.test.mjs        # 73 AI DJ: model call identity, route resolution, failure reporting, curation, skips, pool sources, caching, brief rewriting, queue invariants
node test/client.test.mjs    # 42 browser half: the engine against a fake DOM, and the page it pairs with
node test/host.test.mjs      # 38 integration: routes, streaming, curation, quality, taste, skips
```

The DJ tests drive `ctx.llm.stream()` with a stub that emits the documented
chunks — answering curation and brief rewrites separately — and stub
`ctx.agentDefaultModel` for route inheritance. So the pinned-route happy path,
both chunk spellings (`type`/`kind`), index filtering, prose-wrapped JSON, the
session identity every call must carry, inheritance from the session model,
discovery, the brief rewrite and every fallback are covered without a
provider. NetEase is stubbed too, with a pacer that waits for nothing, so the
suite never sits out the pacing meant for the real API.

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

`npm test` runs the five deterministic files in sequence (`npm run test:all`
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
