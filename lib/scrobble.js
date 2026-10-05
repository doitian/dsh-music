/**
 * Reports plays to NetEase, so they appear in the account's listening history
 * (最近播放, 听歌排行) like plays in the official clients.
 *
 * It sends what the web player sends: `startplay` when a track starts, and
 * `play` when that play ends, with the seconds heard and how it ended (`ui`
 * when it played out, `interrupt` when the listener moved on). A play left
 * inside the skip window is not reported at all — a track skipped after ten
 * seconds was not listened to, and the history should not say it was.
 *
 * Reporting is best-effort: a failure is logged and recorded for
 * `/music/health`, and never reaches playback.
 *
 * @module dsh-music/scrobble
 */

export class Scrobbler {
  /**
   * @param {object} options
   * @param {import('./netease.js').Netease} options.api
   * @param {boolean} [options.enabled] `config.scrobble`; on unless set to false.
   * @param {{warn: Function, info: Function, debug: Function}} [options.logger]
   */
  constructor({ api, enabled = true, logger } = {}) {
    this.api = api;
    this.enabled = enabled;
    this.logger = logger;
    /** The last `play` report: which track, when, and whether NetEase took it. */
    this.last = null;
  }

  /** A track started playing. */
  start(track) {
    if (!this.#active() || !track?.id) return;
    void this.#send([
      { action: 'startplay', json: { id: track.id, type: 'song', content: `id=${track.id}`, mainsite: '1', mainsiteWeb: '1' } },
    ]).catch(() => {});
  }

  /**
   * A play ended. Only a play heard past the skip window is reported.
   * @param {{id: number, name?: string}} track
   * @param {{seconds: number, ended: boolean, heard: boolean}} play
   * @returns {Promise<void>}
   */
  async finish(track, { seconds, ended, heard }) {
    if (!this.#active() || !track?.id || !heard) return;
    const time = Math.max(Math.round(seconds), 1);
    try {
      await this.#send([
        {
          action: 'play',
          json: {
            type: 'song',
            wifi: 0,
            download: 0,
            id: track.id,
            time,
            end: ended ? 'ui' : 'interrupt',
            mainsite: '1',
            mainsiteWeb: '1',
            content: `id=${track.id}`,
          },
        },
      ]);
      this.last = { id: track.id, name: track.name ?? '', seconds: time, ended, at: Date.now(), error: null };
    } catch (error) {
      this.last = { id: track.id, name: track.name ?? '', seconds: time, ended, at: Date.now(), error: error.message };
      this.logger?.warn?.(`[music] could not report the play of ${track.id}: ${error.message}`);
    }
  }

  /** What `/music/health` shows. */
  status() {
    return { enabled: this.enabled, active: this.#active(), last: this.last };
  }

  #active() {
    return this.enabled && Boolean(this.api?.authenticated);
  }

  #send(logs) {
    return this.api.weblog(logs);
  }
}
