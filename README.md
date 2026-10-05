# @doitian/dsh-music

NetEase Cloud Music ([music.163.com](https://music.163.com)) playback and an AI DJ for DeepSeek Harness.

A **Music** entry in the DSH sidebar opens a player: queue, synced lyrics, QR sign-in, NetEase likes, and an AI DJ that keeps the queue stocked. The agent can drive the same player through seven tools.

Developing the plugin, or curious how it works? See [docs/DESIGN.md](https://github.com/doitian/dsh-music/blob/main/docs/DESIGN.md).

## Install

In the desktop app: **Plugins** → **Add plugin** → `@doitian/dsh-music`, then restart the app. **Music** appears in the sidebar.

For a profile other than `desktop`, install from a terminal instead:

```powershell
dsh plugin --profile <name> add @doitian/dsh-music
```

The player follows the Harness language setting (中文 or English).

## Sign in

Optional. Signed out, search, charts, playlists, lyrics and non-VIP playback all work; VIP tracks return no audio.

Click **登录 Sign in** in the player and scan the QR code with the NetEase Cloud Music app, or ask the agent to use `music_login`. The cookie is stored in `$DSH_HOME/music/session.json`.

## Agent tools

| Tool | Purpose |
|---|---|
| `music_search` | Search NetEase for songs |
| `music_play` | Queue and play, by ids or a search query |
| `music_queue` | Show, append, insert, replace, remove, jump, clear |
| `music_control` | Play, pause, next, previous, seek, volume, mute, mode |
| `music_dj` | Run or configure the AI DJ, with an optional mood brief |
| `music_now_playing` | What is playing and next, and whether you're signed in |
| `music_login` | Status, QR, poll, set a cookie, log out |

Music plays in the Harness window, so keep it open. Playback continues while you switch to a conversation.

## Using the player

**Quality.** Pick a level in the transport row: `standard`, `higher`, `exhigh` (320 kbps, the default), `lossless`, `hires`, or the spatial tiers `jymaster`, `dolby`, `sky`, `jyeffect`. If a track doesn't offer the level, playback steps down until something plays, and the caption shows what was actually served.

**Taste.** Each track is liked, unrated or disliked:

| Control | Effect |
|---|---|
| ♡ (row or transport) | Like on your NetEase account. Click again to unlike. |
| ✕ (transport) | Dislike and move to the next track. Local only; the DJ stops picking it. |
| ✕ (queue row) | Remove the track. An unrated track is also recorded as disliked. |

**Skips.** Pressing next before 30 s (or before a quarter of a long track) counts as a skip. One skip lowers a track's rank; two remove it from the DJ's picks, and skipped plays count against the artist. A dislike's own next is not also counted as a skip.

## The AI DJ

Turn it on in the player or with `music_dj`. When fewer than 3 tracks remain, the DJ appends a batch of 5. It only stocks the queue; it never starts or stops playback.

**Where it looks:** songs similar to what you've listened through, personal FM and liked songs you haven't heard in three days (when signed in), the daily recommendations, new songs, and the four main charts. Each source is cached for hours and sampled, so batches vary; requests to NetEase are spaced out rather than sent in a burst.

**Mood brief.** Type a mood such as `雨天 爵士` or `90s cantopop`. The DJ searches NetEase playlists for it. With a model available, the brief is first rewritten into Chinese search terms, once per brief.

**Who chooses:**

- **Model tier:** a model picks from the candidates by your taste and the mood, and writes a one-line vibe. It calls the model directly; it is not an agent and starts no conversation.
- **Heuristic tier:** used when no model is available or a call fails. Candidates are scored by mood match, favourite artists, and your likes, dislikes and skips.

### Choosing the model

By default the DJ uses your session's default model. To use another, pick a provider and model in the player's **AI DJ 模型 / DJ model** panel (**测试 Test** checks it without touching the queue), or set it in your profile's `cordis.patch.yml`:

```yaml
- id: music
  name: '@doitian/dsh-music'
  config:
    dj:
      provider: opencode-go
      model: deepseek-v4.1-flash
```

The player's choice wins over the profile; **回退 Revert** hands control back. If the DJ falls back to heuristics, the health page shows why in `dj.modelError` (see [Troubleshooting](#troubleshooting)).

## Configuration

All fields are optional, under the plugin entry's `config` in your profile's `cordis.patch.yml`. The loader replaces `config` as a whole, so keep every option in one block.

| Field | Default | Meaning |
|---|---|---|
| `audioLevel` | `exhigh` | Starting quality, until you pick one in the player |
| `dataDir` | `$DSH_HOME/music` | Where `session.json` lives |
| `requestTimeoutMs` | `15000` | NetEase request deadline |
| `dj.provider` / `dj.model` | session model | The DJ's model, as above |

Batch size (`djBatchSize`, 5) and refill threshold (`djAutoExtendBelow`, 3) have no control in the player. Edit them in `session.json` while the harness is stopped.

## Troubleshooting

- **No sound:** Chromium blocks audio until you interact with the page. Click anywhere in the window once.
- **The DJ isn't using the model:** check `dj.modelError` on the health page.
- **A provider says your usage breaks its conventions:** use the provider's catalog route name (for example `opencode-go`), and don't set `x-opencode-session` in the profile's `headers`.
- **Changed a setting in the profile and nothing happened:** restart the app.

**The health page** is `/music/health` on the Harness's own address — for example `http://127.0.0.1:<port>/music/health`, using the port the Harness window is served on. It reports the account, the queue, the DJ's model state, and which tools registered.

## Security

- The `/music` routes have no authentication of their own; they are served on loopback only. Anyone who can reach the port can browse, stream, and change the account's likes.
- The NetEase cookie is stored in plain text in `session.json` and is never returned by any endpoint.

## Known limitations

- VIP tracks don't play while signed out, and some tracks are sold per album, so they don't play even with VIP (for example 晴天, `id 186016`).
- Without NetEase's encrypted API there is no scrobbling, no playlist editing and no heartbeat mode (心动模式), and a dislike stays local.
- The DJ's model mode hasn't yet been tested end to end with a real model. If it misbehaves, `dj.modelError` says why, and the DJ keeps working without it.
- Only your newest 500 likes are offered back as candidates.
