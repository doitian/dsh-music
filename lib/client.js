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
 * command at once.
 *
 * ## How the engine hears about changes
 *
 * The host pushes its state over `/music/api/events` (an event stream; see
 * lib/feed.js) whenever something the engine acts on changes. The engine
 * re-reads `/state` itself only while that stream is down. A short local clock
 * still runs regardless, because two things never reach the host as a change:
 * a play the browser refused, which must be retried until it is allowed, and
 * the position reports the engine owes the host.
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

    /**
     * The engine's own clock: it retries a refused play, sends a report when one
     * is due, and re-reads the host while the event stream is down.
     */
    const TICK_MS = 500;
    /** A stream the browser gave up on (an error answer) is opened again after this. */
    const RELISTEN_MS = 10_000;
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
     * `/health`. It covers the host's playback core too: see
     * {@link loadPlayback}, and {@link createEngine} for why it is checked at all.
     */
    const PANEL_CONTRACT = 2;

    /** An engine that does nothing, for a host that predates the contract. */
    function inertEngine() {
      // `playback: false` is the page's cue to own the audio element itself.
      return { playback: false, inert: true, sync() {}, playNow() {}, state: () => null, position: () => 0, dispose() {} };
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
     * Load the playback core the host serves beside the page.
     *
     * The page's fallback transport runs the same file, which is the point:
     * the fades, the seek hold and the autoplay retry exist once. It comes
     * from the host rather than this bundle because the host and the page are
     * one generation and this bundle may be another; the handshake has already
     * established that the host's generation is the one this engine expects.
     * A host from before the core was split out does not serve it, and that
     * leaves the engine inert like any other mismatch.
     *
     * @returns {Promise<{createPlayback: Function} | null>}
     */
    function loadPlayback() {
      return new Promise((resolve) => {
        const script = document.createElement('script');
        const settle = (core) => {
          script.remove();
          resolve(typeof core?.createPlayback === 'function' ? core : null);
        };
        script.addEventListener('load', () => settle(window.__dshMusicPlayback));
        script.addEventListener('error', () => settle(null));
        script.src = `${BASE}/playback.js`;
        (document.head ?? document.documentElement).appendChild(script);
      });
    }

    /**
     * Start the persistent audio engine, after a contract handshake.
     *
     * Playback lives here rather than in the page, so the two halves have to
     * agree. When they do not, the page owns its own `<audio>` and starting
     * this engine as well would play every track twice — so the engine stays
     * inert and the old behaviour applies until the two are refreshed together.
     *
     * @returns {Promise<{sync: () => void, state: () => object | null, position: () => number, dispose: () => void}>}
     */
    async function createEngine() {
      if (!(await pageAcceptsEngine())) {
        console.warn(
          `[music] the served page does not implement panel contract ${PANEL_CONTRACT}; ` +
            'leaving playback to the page until the harness restarts.',
        );
        return inertEngine();
      }
      const core = await loadPlayback();
      if (!core) {
        console.warn('[music] the host serves no playback core; leaving playback to the page until the harness restarts.');
        return inertEngine();
      }

      // A hot re-materialization must not leave a second element playing.
      try {
        window.__dshMusicEngine?.dispose?.();
      } catch { /* ignore a stale engine */ }

      let state = null;
      // Start the clock now so the first tick reconciles without also posting a
      // redundant position report.
      let lastReportAt = Date.now();
      let disposed = false;
      let inflight = false;
      /** The host's event stream, and whether it is open. */
      let events = null;
      let streaming = false;
      let relisten = null;
      /** The newest snapshot version adopted; see {@link take}. */
      let versionFloor = 0;

      const playback = core.createPlayback({ base: BASE, streamOrigin, call, report });
      const { audio, reconcile, applySource, enforce } = playback;

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

      /** Tell the host where playback actually is. */
      async function report(extra) {
        if (!state?.current) return;
        lastReportAt = Date.now();
        try {
          const next = await call('/report', {
            method: 'POST',
            body: { trackId: state.current.id, ...playback.progress(), ...extra },
          });
          // Taken, not acted on: acting here would retry a refused play from
          // the answer to its own refusal, as fast as the host can reply.
          if (next?.rev !== undefined) take(next);
        } catch { /* the next update carries the host's view */ }
      }

      /**
       * Adopt one host state, unless it is older than the one held.
       *
       * A report's answer and a pushed frame travel on different connections,
       * so one read earlier can land later; adopting it would undo the newer
       * one — resume a pause, or load the quality just left — with no frame
       * coming to repair it. While the stream is open, a state whose `version`
       * is older than the newest one adopted is dropped. A reconnect drops the
       * floor, since a restarted host counts its versions from zero again.
       * A host without versions is taken as it comes.
       *
       * @returns {boolean} whether it was adopted.
       */
      function take(next) {
        if (disposed || !next) return false;
        const version = Number(next.version);
        if (Number.isFinite(version)) {
          if (streaming && version < versionFloor) return false;
          versionFloor = version;
        }
        state = next;
        reconcile(next);
        return true;
      }

      /** Adopt one host state and bring the element in line with it. */
      function receive(next) {
        if (!take(next)) return;
        applySource(next);
        enforce(next);
      }

      /** Read the host's state over a plain request. */
      async function poll() {
        if (disposed || inflight) return;
        inflight = true;
        try {
          receive(await call('/state'));
        } catch { /* host not reachable yet; the next tick tries again */ } finally {
          inflight = false;
        }
      }

      /** Subscribe to the host's pushed state, where the browser can. */
      function listen() {
        relisten = null;
        const Source = window.EventSource;
        if (disposed || typeof Source !== 'function') return;
        events = new Source(`${API}/events`);
        events.onopen = () => {
          streaming = true;
          versionFloor = 0;
        };
        events.onerror = () => {
          streaming = false;
          // A dropped connection is retried by the browser; an error status
          // (a host that predates the route) closes the stream for good.
          if (events?.readyState === Source.CLOSED) {
            events = null;
            if (!disposed) relisten = setTimeout(listen, RELISTEN_MS);
          }
        };
        events.addEventListener('state', (event) => {
          try {
            receive(JSON.parse(event.data));
          } catch { /* a garbled frame; the next one carries the whole state */ }
        });
      }

      function tick() {
        if (disposed) return;
        if (!streaming) void poll();
        else if (state) {
          // The host has nothing new to say about a refused play, so it is
          // retried here, against the state already held — which a report's
          // answer may have moved to the next track without loading it.
          applySource(state);
          enforce(state);
        }
        const due = state?.playing && !audio.paused ? REPORT_MS : IDLE_REPORT_MS;
        if (audio.dataset.trackId && Date.now() - lastReportAt >= due) void report({});
      }

      const timer = setInterval(tick, TICK_MS);
      void poll();
      listen();

      return {
        /**
         * Declares that this engine really owns and drives the audio element.
         * The page checks it before deferring, so a host that cannot run the
         * engine never leaves playback unowned.
         */
        playback: true,
        /** Re-read the host now: the page just sent a command and wants it applied. */
        sync() {
          void poll();
        },
        /**
         * Retry playback synchronously, for a click on the autoplay hint.
         *
         * Called from inside the gesture so the attempt lands while the page is
         * being activated, rather than on the next tick.
         */
        playNow() {
          playback.playNow();
        },
        state() {
          return state;
        },
        /**
         * Where playback is, in milliseconds, read off the element itself, so
         * the page's bar moves smoothly without a report per frame. A held seek
         * counts as already there.
         */
        position() {
          return playback.position();
        },
        dispose() {
          disposed = true;
          clearInterval(timer);
          clearTimeout(relisten);
          events?.close();
          events = null;
          streaming = false;
          playback.dispose();
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
