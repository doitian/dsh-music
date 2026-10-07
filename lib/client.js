/**
 * Browser half of `@doitian/dsh-music`.
 *
 * Hand-written against the client module contract (`window.__ModuleLoader__`),
 * so the package needs no bundler step:
 *
 *   - the shell's frozen `PLATFORM_MODULES` table supplies `react`;
 *   - `apply(ctx)` starts a **persistent audio engine** and registers the
 *     sidebar entry (`sidebar.panellist`, a list slot) plus the page it opens
 *     (the layout's keyed `main` slot, same id);
 *   - `ctx.slots.inject(slot, …)` is declaration-aware, so registration waits
 *     for the sidebar and layout packages that own those slots.
 *
 * ## Why the audio element is not in the page
 *
 * The layout renders only the **active** `main` slot entry:
 *
 *     renderSlot('main', {}, { entryKey: activePanelId ?? 'conversation' })
 *
 * so opening a Session unmounts the Music page and discards its document. An
 * `<audio>` element owned by that page therefore stops the music the moment the
 * user goes back to chatting. Playback instead belongs to this engine, created
 * on the plugin's own lifetime in the shell document, which keeps running no
 * matter which panel is on screen. The page becomes a remote control over the
 * host's shared state, and `window.__dshMusicEngine.sync()` lets it apply a
 * command without waiting for the next poll.
 *
 * @module @doitian/dsh-music/client
 */

window.__ModuleLoader__.load({
  id: '@doitian/dsh-music',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    /** Must match the host plugin's `apiPrefix` (see lib/index.js). */
    const BASE = '/music';
    const API = `${BASE}/api`;
    /** Shared by the sidebar entry and the main panel it opens. */
    const PANEL_ID = 'music';

    /**
     * The locale namespace and its dictionary, registered with the host's
     * `locale` service so the UI follows the Settings language. The service
     * requires both shipped locales up front.
     */
    const NS = 'music';
    const DICTIONARY = {
      zh: {
        panel: '音乐',
        iframeTitle: '网易云音乐播放器',
        unreachableTitle: '无法连接到音乐插件',
        unreachableBody: '音乐插件路由没有响应。请确认插件已在当前 profile 中启用，然后',
        unreachableLink: '直接打开播放器',
        unreachableSuffix: '。',
      },
      en: {
        panel: 'Music',
        iframeTitle: 'NetEase Cloud Music player',
        unreachableTitle: 'Music is not reachable',
        unreachableBody:
          'The music plugin route did not answer. Check that the plugin is enabled in this profile, then ',
        unreachableLink: 'open the player directly',
        unreachableSuffix: '.',
      },
    };
    /** Bound in apply() once the dictionary is registered; English until then. */
    let t = (key) => DICTIONARY.en[key] ?? key;

    /** How often the engine re-reads the host state; bounds control latency. */
    const POLL_MS = 500;
    /** Position report cadence while playing, and while idle. */
    const REPORT_MS = 1000;
    const IDLE_REPORT_MS = 5000;

    /** Services required before the slot registrations can be made. */
    const inject = ['slots', 'locale'];

    /** Absolute URL helper; the shell page and the panel share one origin. */
    function origin() {
      return window.location?.origin && window.location.origin !== 'null'
        ? window.location.origin
        : '';
    }

    /**
     * Origin that serves audio bytes.
     *
     * The desktop shell runs on the `dsh-app://` custom scheme, whose responses
     * Chromium cannot byte-range (electron/electron#38749): audio plays, but a
     * seek collapses to zero and restarts the track. The shell publishes its
     * real HTTP origin as `__DSH_TRANSPORT__.streamBaseUrl` for exactly this;
     * in a browser it is absent and the document origin serves.
     */
    function streamOrigin() {
      try {
        const base = window.__DSH_TRANSPORT__?.streamBaseUrl;
        if (typeof base === 'string' && base) return new URL(base).origin;
      } catch { /* a malformed base falls back to the document origin */ }
      return origin();
    }

    /** Player page URL, shown in errors and used as the iframe source. */
    function panelUrl() {
      return `${origin()}${BASE}/panel`;
    }

    // ------------------------------------------------------------------ engine

    /**
     * The page/engine boundary this bundle expects, mirrored from the host's
     * `/health`. See {@link createEngine} for why it is checked at all.
     */
    const PANEL_CONTRACT = 2;

    /** An engine that does nothing, for a host that predates the contract. */
    function inertEngine() {
      // `playback: false` is the page's cue to own the audio element itself.
      return { playback: false, inert: true, sync() {}, playNow() {}, state: () => null, dispose() {} };
    }

    /**
     * Does the page this host serves expect an engine to own the audio?
     *
     * Asked in two steps, because two independently versioned artifacts are
     * involved. The host module and the page are *not* refreshed together: a
     * plugin mount re-reads `panel.html` from disk while Node keeps serving the
     * cached module. The page therefore wins when the two disagree — it is the
     * component that actually decides whether to defer, so it is the authority
     * on the question being asked.
     *
     * @returns {Promise<boolean>}
     */
    async function pageAcceptsEngine() {
      try {
        const health = await (await fetch(`${BASE}/health`)).json();
        // A host that advertises the boundary answers definitively, either way.
        if (health?.panelContract !== undefined) return health.panelContract === PANEL_CONTRACT;
      } catch { /* fall through to the page itself */ }

      try {
        const html = await (await fetch(`${BASE}/panel`)).text();
        const declared = /name="dsh-music-panel-contract"\s+content="(\d+)"/.exec(html);
        return declared !== null && Number(declared[1]) === PANEL_CONTRACT;
      } catch {
        return false;
      }
    }

    /**
     * Start the persistent audio engine, after a contract handshake.
     *
     * Playback lives here rather than in the page, so the two halves have to
     * agree. When they do not, the page owns its own `<audio>` and starting
     * this engine as well would play every track twice — so the engine stays
     * inert and the old behaviour applies until the two are refreshed together.
     *
     * @returns {Promise<{sync: () => void, state: () => object | null, dispose: () => void}>}
     */
    async function createEngine() {
      if (!(await pageAcceptsEngine())) {
        console.warn(
          `[music] the served page does not implement panel contract ${PANEL_CONTRACT}; ` +
            'leaving playback to the page until the harness restarts.',
        );
        return inertEngine();
      }

      // A hot re-materialization must not leave a second element playing.
      try {
        window.__dshMusicEngine?.dispose?.();
      } catch { /* ignore a stale engine */ }

      const audio = document.createElement('audio');
      audio.preload = 'auto';
      audio.setAttribute('aria-hidden', 'true');
      audio.style.display = 'none';
      (document.body ?? document.documentElement).appendChild(audio);

      let state = null;
      let appliedTransport = -1;
      // Start the clock now so the first tick reconciles without also posting a
      // redundant position report.
      let lastReportAt = Date.now();
      let disposed = false;
      let inflight = false;
      /** Guards against stacking overlapping `play()` attempts. */
      let playing = false;

      /** One JSON round-trip to the host. */
      async function call(path, init) {
        const response = await fetch(`${API}${path}`, {
          headers: { 'Content-Type': 'application/json' },
          ...init,
          ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
        });
        const text = await response.text();
        return text ? JSON.parse(text) : {};
      }

      /** Push the audio element back in line with the host's desired state. */
      function reconcile(next) {
        if (next.transportRev === appliedTransport) return;
        appliedTransport = next.transportRev;

        if (next.pendingSeek !== null && next.pendingSeek !== undefined) {
          try {
            audio.currentTime = next.pendingSeek / 1000;
          } catch { /* not seekable until metadata arrives */ }
          // One-shot: drop it so the next poll cannot re-apply the seek.
          void call('/seek-consumed', { method: 'POST', body: {} }).catch(() => {});
        }
      }

      /**
       * Decide which resource the element should be playing.
       *
       * Runs on every tick rather than behind the `transportRev` gate, because
       * the resource identity includes the streaming quality: quality is not a
       * one-shot transport change, and gating it meant a switch did nothing
       * until something else moved the revision.
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

        const level = next.audio?.preferred ?? 'exhigh';
        const base = streamOrigin();
        // The origin is part of the identity, so a stream base published after
        // boot still moves the element off the unseekable scheme.
        const key = `${track.id}:${level}:${base}`;
        if (audio.dataset.trackKey === key) return;

        const sameTrack = audio.dataset.trackId === String(track.id);
        const resumeAt = sameTrack ? audio.currentTime : 0;
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
        audio.src = `${base}${BASE}/stream/${track.id}?level=${encodeURIComponent(level)}`;
        audio.load();
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
        playing = true;
        audio.play().then(
          () => {
            playing = false;
            void report({ blocked: false });
          },
          (error) => {
            playing = false;
            void report(error?.name === 'NotAllowedError' ? { blocked: true } : {});
          },
        );
      }

      /**
       * Keep the element in line with the desired transport, on every tick.
       *
       * Deliberately outside the `transportRev` gate: a refused `play()` does
       * not change the revision, so gating this would leave the music stopped
       * for good after the first refusal — the panel would show the autoplay
       * hint and pressing it would fix nothing.
       */
      function enforce(next) {
        audio.volume = next.muted ? 0 : next.volume;
        if (!next.current) return;
        if (next.playing && audio.paused) {
          attemptPlay();
        } else if (!next.playing && !audio.paused) {
          audio.pause();
          void report({});
        }
      }

      /** Tell the host where playback actually is. */
      async function report(extra) {
        if (!state?.current) return;
        lastReportAt = Date.now();
        try {
          const next = await call('/report', {
            method: 'POST',
            body: {
              trackId: state.current.id,
              position: Math.round((audio.currentTime || 0) * 1000),
              duration: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined,
              playing: !audio.paused,
              ...extra,
            },
          });
          if (next?.rev !== undefined) {
            state = next;
            reconcile(next);
          }
        } catch { /* the host will be re-read on the next tick */ }
      }

      audio.addEventListener('ended', () => void report({ ended: true }));
      audio.addEventListener('error', () => {
        // Fires for an unavailable track and for a dropped connection alike;
        // the host skips to the next track on either.
        if (audio.dataset.trackId) void report({ error: 'audio element error (track unavailable or network)' });
      });

      /** One poll: read state, reconcile, and report when due. */
      async function tick() {
        if (disposed || inflight) return;
        inflight = true;
        try {
          const next = await call('/state');
          state = next;
          reconcile(next);
          applySource(next);
          enforce(next);
          const due = next.playing && !audio.paused ? REPORT_MS : IDLE_REPORT_MS;
          if (audio.dataset.trackId && Date.now() - lastReportAt >= due) void report({});
        } catch { /* host not reachable yet; keep polling */ } finally {
          inflight = false;
        }
      }

      const timer = setInterval(() => void tick(), POLL_MS);
      void tick();

      return {
        /**
         * Declares that this engine really owns and drives the audio element.
         * The page checks it before deferring, so a host that cannot run the
         * engine never leaves playback unowned.
         */
        playback: true,
        /** Apply a pending command immediately instead of waiting for a poll. */
        sync() {
          if (!disposed) void tick();
        },
        /**
         * Retry playback synchronously, for a click on the autoplay hint.
         *
         * Called from inside the gesture so the attempt lands while the page is
         * being activated, rather than on the next 500 ms poll.
         */
        playNow() {
          attemptPlay();
        },
        state() {
          return state;
        },
        dispose() {
          disposed = true;
          clearInterval(timer);
          try {
            audio.pause();
            audio.removeAttribute('src');
            audio.remove();
          } catch { /* the document may already be gone */ }
        },
      };
    }

    // --------------------------------------------------------------- components

    /** Sidebar destination inside the iframe, shown when the host is down. */
    function PanelError() {
      return h(
        'div',
        {
          style: {
            padding: '28px',
            font: '13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
            opacity: 0.75,
          },
        },
        h('div', { style: { fontWeight: 650, marginBottom: 6 } }, t('unreachableTitle')),
        h(
          'div',
          null,
          t('unreachableBody'),
          h('a', { href: panelUrl(), target: '_blank', rel: 'noreferrer' }, t('unreachableLink')),
          t('unreachableSuffix'),
        ),
      );
    }

    /** The page component registered into the layout's keyed `main` slot. */
    function MusicPanel() {
      const [status, setStatus] = React.useState('loading');

      React.useEffect(() => {
        let cancelled = false;
        fetch(`${BASE}/health`)
          .then((response) => {
            if (!cancelled) setStatus(response.ok ? 'ready' : 'error');
          })
          .catch(() => {
            if (!cancelled) setStatus('error');
          });
        return () => {
          cancelled = true;
        };
      }, []);

      if (status === 'error') return h(PanelError);

      return h('iframe', {
        src: panelUrl(),
        title: t('iframeTitle'),
        allow: 'autoplay; clipboard-write; encrypted-media',
        style: {
          width: '100%',
          height: '100%',
          minHeight: '520px',
          border: 0,
          display: 'block',
          background: 'transparent',
        },
      });
    }

    /** The sidebar row icon; the shell renders it in both states of the rail. */
    function MusicIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        h('path', { d: 'M9 18V5l10-2v13' }),
        h('circle', { cx: 6, cy: 18, r: 3 }),
        h('circle', { cx: 16, cy: 16, r: 3 }),
      );
    }

    /**
     * Register the sidebar entry and the page it opens.
     *
     * Both registrations carry `locale: NS` and resolve their text through
     * `t` at render time, so the slot system re-renders them in place when
     * the user switches the Harness language — no remount, no refresh.
     */
    function registerUi(ctx) {
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, MusicPanel),
      );
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS, label: () => t('panel') }, MusicIcon),
      );
    }

    /**
     * Activate the music contribution.
     *
     * The UI registers first, then the engine starts behind its contract
     * handshake. The engine is deliberately not tied to any slot: the layout
     * unmounts the Music page whenever another panel is active, and playback
     * must outlive that.
     *
     * @param ctx client runtime.
     * @returns disposer stopping playback and withdrawing both registrations.
     */
    async function apply(ctx) {
      // The dictionary goes in before anything renders, and bound `t` reads
      // the live snapshot, so a later language switch needs no rewiring.
      const disposeLocale = ctx.locale.register(NS, DICTIONARY);
      t = ctx.locale.bind(NS);
      const ui = ctx.inject(['slots'], () => registerUi(ctx));
      const engine = await createEngine();
      // The panel is same-origin, so it can nudge the engine after a command.
      window.__dshMusicEngine = engine;
      return () => {
        ui?.dispose?.();
        engine.dispose();
        disposeLocale?.();
        if (window.__dshMusicEngine === engine) delete window.__dshMusicEngine;
      };
    }

    exports.PANEL_ID = PANEL_ID;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
