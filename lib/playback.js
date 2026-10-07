/**
 * Audio playback, shared by both owners of the `<audio>` element.
 *
 * Normally that is the client plugin's engine in the shell document
 * (lib/client.js); when the engine is inert, it is the player page's fallback
 * transport (lib/panel.html). Both run this one file, so the fades, the seek
 * hold, the autoplay retry and the resource identity cannot drift apart.
 *
 * The host serves it at `/music/playback.js`, read in the same module
 * generation as the page, and the page loads it with a `<script>` of its own:
 * the page never runs code from the bundle. The engine loads the same URL only
 * after the panel-contract handshake, which makes what `createPlayback` takes
 * and returns part of that contract — changing either needs a new
 * `PANEL_CONTRACT`.
 *
 * A classic script rather than a module, since no bundler stands in front of
 * either document. Everything but `window.__dshMusicPlayback` stays in its own
 * scope, so nothing here can collide with the page's top-level names.
 *
 * @module dsh-music/playback
 */

(function () {
  /**
   * Volume fades: play and pause ease over `FADE_MS`. A seek fades to silence
   * over `SEEK_FADE_MS` and holds there until no other seek has arrived for
   * `SEEK_SETTLE_MS`; only then does it jump and fade back in, so a burst of
   * seeks plays nothing in between and jumps once.
   */
  const FADE_MS = 300;
  const SEEK_FADE_MS = 120;
  const SEEK_SETTLE_MS = 400;
  const FADE_STEP_MS = 16;

  /**
   * Create a hidden `<audio>` element in this document and keep it in line
   * with the host's desired state.
   *
   * The owner keeps everything about where that state comes from: it hands
   * each snapshot over, and `report` posts to `/report` with the track it
   * believes is current, {@link progress}, and `extra`.
   *
   * @param {object} options
   * @param {string} options.base route prefix, e.g. `/music`.
   * @param {() => string} options.streamOrigin origin that serves audio bytes; `''` keeps the document's.
   * @param {(path: string, init?: object) => Promise<object>} options.call one JSON round-trip under `${base}/api`.
   * @param {(extra: object) => unknown} options.report tell the host where playback actually is.
   */
  function createPlayback({ base, streamOrigin, call, report }) {
    const audio = document.createElement('audio');
    audio.preload = 'auto';
    audio.setAttribute('aria-hidden', 'true');
    audio.style.display = 'none';
    (document.body ?? document.documentElement).appendChild(audio);

    let appliedTransport = -1;
    let disposed = false;
    /** Guards against stacking overlapping `play()` attempts. */
    let playing = false;
    /** The host's volume; the element plays at `level * gain`. */
    let level = 1;
    /** Fade multiplier, eased by {@link fadeTo}. */
    let gain = 1;
    /** The running fade, if any: its timer and the gain it heads for. */
    let fade = null;
    /** Fading out towards a pause that has not happened yet. */
    let pausing = false;
    /** Seek target in seconds, held until the seeks settle (or a pause lands). */
    let seekTarget = null;
    /** The silent wait after a seek; any fade, or another seek, cancels it. */
    let hold = null;

    function applyVolume() {
      audio.volume = Math.min(Math.max(level * gain, 0), 1);
    }

    /**
     * Ease `gain` to `to`, then call `done`.
     *
     * Paced by the clock rather than by counting steps, so a throttled timer
     * in a hidden window makes the ramp coarser but not longer. The duration
     * scales with the distance left, so reversing halfway keeps the rate. A
     * new fade replaces the running one, `done` included.
     */
    function fadeTo(to, ms, done) {
      clearInterval(fade?.timer);
      clearTimeout(hold);
      hold = null;
      const from = gain;
      const start = Date.now();
      const span = Math.abs(to - from) * ms;
      const current = { to, timer: 0 };
      const step = () => {
        const progress = span > 0 ? Math.min((Date.now() - start) / span, 1) : 1;
        gain = from + (to - from) * progress;
        applyVolume();
        if (progress < 1) return;
        clearInterval(current.timer);
        if (fade === current) fade = null;
        done?.();
      };
      current.timer = setInterval(step, FADE_STEP_MS);
      fade = current;
      step();
    }

    function land() {
      if (seekTarget === null) return;
      try {
        audio.currentTime = seekTarget;
      } catch { /* not seekable until metadata arrives */ }
      seekTarget = null;
    }

    /**
     * Fade to silence and wait there for the seeks to settle, then jump and
     * fade back in. Called again while silent, it restarts the wait at once,
     * which is what cancels the playback queued for the previous target.
     */
    function holdForSeek() {
      fadeTo(0, SEEK_FADE_MS, () => {
        hold = setTimeout(() => {
          land();
          fadeTo(1, SEEK_FADE_MS);
        }, SEEK_SETTLE_MS);
      });
    }

    /**
     * Seek, debounced while audible. A seek during the fade-out only moves
     * the target; the pause that may be fading out lands it instead.
     */
    function seek(seconds) {
      seekTarget = seconds;
      if (audio.paused) land();
      else if (fade?.to !== 0) holdForSeek();
    }

    function fadeOutAndPause() {
      if (pausing) return;
      pausing = true;
      fadeTo(0, FADE_MS, () => {
        pausing = false;
        land();
        audio.pause();
        void report({});
      });
    }

    /** Play was asked for again before the fade-out reached the pause. */
    function cancelPause() {
      pausing = false;
      if (seekTarget !== null) holdForSeek();
      else fadeTo(1, FADE_MS);
    }

    /**
     * Start playback, tolerating a refusal.
     *
     * Chromium blocks audio until the page has been activated by a gesture,
     * so an attempt can legitimately fail and has to be repeatable. Both
     * outcomes are reported at once, so the host — and the panel's hint —
     * learns the real state instead of waiting for the next scheduled report.
     * `blocked` says which: only the autoplay policy's `NotAllowedError` is a
     * reason to ask for a click, not an attempt still under way or one
     * interrupted by a new source.
     */
    function attemptPlay() {
      if (playing || disposed) return;
      // Already playing (a repeated `playNow()`): restarting the fade would
      // drop the audio out, so only call off a pause that is fading out.
      if (!audio.paused) {
        if (pausing) cancelPause();
        return;
      }
      playing = true;
      // Start silent and fade in once the browser has agreed to play.
      pausing = false;
      fadeTo(0, 0);
      land();
      audio.play().then(
        () => {
          playing = false;
          // A seek that arrived while play() was pending owns the fade-in.
          if (seekTarget === null) fadeTo(1, FADE_MS);
          void report({ blocked: false });
        },
        (error) => {
          playing = false;
          void report(error?.name === 'NotAllowedError' ? { blocked: true } : {});
        },
      );
    }

    /** Apply what a transport revision carries: the one-shot seek, once. */
    function reconcile(next) {
      if (next.transportRev === appliedTransport) return;
      appliedTransport = next.transportRev;

      if (next.pendingSeek !== null && next.pendingSeek !== undefined) {
        seek(next.pendingSeek / 1000);
        // One-shot: drop it so the next read cannot re-apply the seek.
        void call('/seek-consumed', { method: 'POST', body: {} }).catch(() => {});
      }
    }

    /**
     * Decide which resource the element should be playing.
     *
     * Runs on every update rather than behind the `transportRev` gate,
     * because the resource identity includes the streaming quality: quality
     * is not a one-shot transport change, and gating it meant a switch did
     * nothing until something else moved the revision.
     *
     * The level is part of the URL, not implicit host state: the same track at
     * two levels is two different files, so a change must load a new one
     * instead of range-requesting offsets into the other encoding. The track
     * id stays in the key so a switch resumes in place.
     */
    function applySource(next) {
      const track = next.current;
      if (!track) {
        if (audio.dataset.trackKey !== undefined) {
          delete audio.dataset.trackKey;
          delete audio.dataset.trackId;
          audio.pause();
          audio.removeAttribute('src');
          audio.load();
        }
        return;
      }

      const quality = next.audio?.preferred ?? 'exhigh';
      const origin = streamOrigin();
      // The origin is part of the identity, so a stream base published after
      // boot still moves the element off the unseekable scheme.
      const key = `${track.id}:${quality}:${origin}`;
      if (audio.dataset.trackKey === key) return;

      const sameTrack = audio.dataset.trackId === String(track.id);
      // A held seek belongs to the track it was aimed at: a reload of the
      // same track resumes there, another track drops it.
      const resumeAt = sameTrack ? (seekTarget ?? audio.currentTime) : 0;
      seekTarget = null;
      audio.dataset.trackKey = key;
      audio.dataset.trackId = String(track.id);
      if (resumeAt > 0.5) {
        audio.addEventListener(
          'loadedmetadata',
          () => {
            try {
              audio.currentTime = resumeAt;
            } catch { /* not seekable */ }
          },
          { once: true },
        );
      }
      audio.src = `${origin}${base}/stream/${track.id}?level=${encodeURIComponent(quality)}`;
      audio.load();
    }

    /**
     * Keep the element in line with the desired transport, on every update.
     *
     * Deliberately outside the `transportRev` gate: a refused `play()` does
     * not change the revision, so gating this would leave the music stopped
     * for good after the first refusal — the panel would show the autoplay
     * hint and pressing it would fix nothing.
     */
    function enforce(next) {
      level = next.muted ? 0 : next.volume;
      applyVolume();
      if (!next.current) return;
      if (next.playing && audio.paused) attemptPlay();
      else if (next.playing && pausing) cancelPause();
      else if (!next.playing && !audio.paused) fadeOutAndPause();
    }

    /** Milliseconds into the track. A held seek counts as already there. */
    function position() {
      return ((seekTarget ?? audio.currentTime) || 0) * 1000;
    }

    /**
     * The fields of a `/report`, apart from the track. A held seek is where
     * playback is about to be; reporting the old position would pull the
     * panel's bar back while it waits.
     */
    function progress() {
      return {
        position: Math.round(position()),
        duration: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined,
        playing: !audio.paused,
      };
    }

    audio.addEventListener('ended', () => {
      // The old position plays on silently while a seek is held; reaching its
      // end is not the track finishing, so land the seek instead of advancing.
      if (seekTarget !== null) {
        land();
        if (audio.paused) attemptPlay();
        return;
      }
      void report({ ended: true });
    });
    audio.addEventListener('error', () => {
      // Fires for an unavailable track and for a dropped connection alike;
      // the host skips to the next track on either.
      if (audio.dataset.trackId) void report({ error: 'audio element error (track unavailable or network)' });
    });

    return {
      audio,
      /** Bring the element in line with one host state. */
      apply(next) {
        if (disposed || !next) return;
        reconcile(next);
        applySource(next);
        enforce(next);
      },
      reconcile,
      applySource,
      enforce,
      /** Retry playback synchronously, from inside a click. */
      playNow: attemptPlay,
      position,
      progress,
      dispose() {
        disposed = true;
        clearInterval(fade?.timer);
        clearTimeout(hold);
        try {
          audio.pause();
          audio.removeAttribute('src');
          audio.remove();
        } catch { /* the document may already be gone */ }
      },
    };
  }

  window.__dshMusicPlayback = { createPlayback };
})();
