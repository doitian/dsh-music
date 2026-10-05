# @doitian/dsh-music

NetEase Cloud Music ([music.163.com](https://music.163.com)) playback and an AI DJ for DeepSeek Harness.

A **Music** entry in the DSH sidebar opens a player: queue, song details and synced lyrics, QR sign-in, NetEase likes, and an AI DJ that keeps the queue stocked. The agent can drive the same player through seven tools.

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

**Listening history.** Signed in, songs you play here show up in your NetEase history — 最近播放 and 听歌排行 — on every device, as plays from the web. A song counts once you've listened past the skip window (30 seconds, or a quarter of a long song); one you skip sooner isn't recorded. To keep your plays local, turn off the **Listening history** switch at the top of the player (it's there while you're signed in), or set `scrobble: false` in the config; the switch wins over the config.

## Agent tools

| Tool | Purpose |
|---|---|
| `music_search` | Search NetEase for songs |
| `music_play` | Queue and play, by ids or a search query |
| `music_queue` | Show, append, insert, replace, remove, jump, clear |
| `music_control` | Play, pause, next, previous, seek, volume, mute, mode |
| `music_dj` | Run or configure the AI DJ, with an optional mood brief or a temporary boost |
| `music_now_playing` | What is playing and next, and whether you're signed in |
| `music_login` | Status, QR, poll, set a cookie, log out |

Music plays in the Harness window, so keep it open. Playback continues while you switch to a conversation.

## Using the player

On a wide window the player has two columns: what is playing on the left — cover, the song's controls, transport, and the song's details or lyrics — and what comes next on the right — the AI DJ card and the queue. On a narrow one they stack.

**Details and lyrics.** Under the transport controls, **Details** shows what NetEase knows about the song: its album (edition, release date, label), genre, tags, language and tempo, awards, and the films or shows it was featured in. Below them, the DJ's model writes a short introduction to the song and its singer from what NetEase holds. It loads after everything else, so the song starts at once. Click the introduction to see NetEase's own text instead: a review, and introductions to each singer and to the album. Click one of those paragraphs to read all of it. Without a model, NetEase's text shows directly. Switch to **Lyrics** for the synced lines. The player remembers which one you chose.

**Quality.** Pick a level under the transport controls: `standard`, `higher`, `exhigh` (320 kbps, the default), `lossless`, `hires`, or the spatial tiers `jymaster`, `dolby`, `sky`, `jyeffect`. If a track doesn't offer the level, playback steps down until something plays, and the caption shows what was actually served.

**Taste.** Each track is liked, unrated or disliked:

| Control | Effect |
|---|---|
| ♡ (beside the title, or on a queue row) | Like on your NetEase account. Click again to unlike. |
| ✕ (beside the title) | Dislike: the track leaves the queue, and the next one plays. Local only; the DJ stops picking it. |
| ✕ (queue row) | Remove the track. An unrated track is also recorded as disliked. |
| Clear (queue header) | Empty the queue except the song playing. Nothing is rated. |

**Skips.** Pressing next before 30 s (or before a quarter of a long track) counts as a skip. One skip lowers a track's rank; two remove it from the DJ's picks, and skipped plays count against the artist. A dislike is not also counted as a skip.

## The AI DJ

Turn it on with the switch in the player's AI DJ card, or with `music_dj`. When fewer than 3 tracks remain, the DJ appends a batch of 5. It only stocks the queue; it never starts or stops playback.

The queue is saved, so after a restart it's back where you left it, paused, and you can press play before the DJ plans anything.

**How it learns your taste:** from your NetEase likes, and from songs you hear through. A song the DJ picked counts only once you've listened past the skip window, so its own picks can't teach it what you like.

**Where it looks:** songs similar to what you've heard and liked, personal FM and liked songs you haven't heard in three days (when signed in), the daily recommendations, new songs, and the four main charts. Signed in, the charts and new songs get fewer slots and your own sources more. Each source is cached for hours and sampled, so batches vary; requests to NetEase are spaced out rather than sent in a burst.

**Boosts.** Want more songs like the one playing for a while, or fewer, without a lasting like or dislike? Press **▲** (more like this) or **▼** (fewer like this) beside the song title. A boost lasts an hour, then expires on its own. While the DJ is on, **▲** also queues a few similar songs right after the current one, and **▼** takes the DJ's upcoming picks that are like it out of the queue (songs you queued yourself stay). Active boosts are listed in the AI DJ card with their time left; press ✕ on one, or the filled arrow, to end it early. The agent can set them too, for any length from 5 minutes to 12 hours.

**Mood brief.** Type a mood in the AI DJ card, such as `雨天 爵士` or `90s cantopop`. The DJ searches NetEase playlists for it. With a model available, the brief is first rewritten into Chinese search terms, once per brief.

After you change the mood or set a boost, the DJ's next batch replaces its own picks that haven't played yet, so the new direction starts right away. The song playing and songs you queued yourself stay.

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
| `scrobble` | `true` | Report your plays to your NetEase listening history, until you use the player's switch |
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
- There is no playlist editing and no heartbeat mode (心动模式), and a dislike stays local: NetEase has no plain endpoint for any of them.
- The DJ's model mode hasn't yet been tested end to end with a real model. If it misbehaves, `dj.modelError` says why, and the DJ keeps working without it.
- Only your newest 500 likes are offered back as candidates.
