/**
 * Scrobbling: the weapi encryption, the play-log request, and when a play is
 * reported.
 *
 * No network. Run with `node test/scrobble.test.mjs`.
 *
 * @module dsh-music/test/scrobble
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { Netease } from '../lib/netease.js';
import { Scrobbler } from '../lib/scrobble.js';
import { weapiEncrypt } from '../lib/weapi.js';

// ------------------------------------------------------------------ weapi

const MODULUS = BigInt(
  '0x00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7',
);

/** Textbook RSA with BigInt, as an independent check on the padding-free encryption. */
function rsaReference(text) {
  let message = 0n;
  for (const byte of Buffer.from(text)) message = (message << 8n) | BigInt(byte);
  let result = 1n;
  let base = message % MODULUS;
  for (let exponent = 0x10001n; exponent > 0n; exponent >>= 1n) {
    if (exponent & 1n) result = (result * base) % MODULUS;
    base = (base * base) % MODULUS;
  }
  return result.toString(16).padStart(256, '0');
}

function aesDecrypt(base64, key) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(key), Buffer.from('0102030405060708'));
  return Buffer.concat([decipher.update(Buffer.from(base64, 'base64')), decipher.final()]).toString('utf8');
}

test('weapi wraps the body in two AES layers, and the key in RSA', () => {
  const key = 'abcdefghij012345';
  const body = { logs: '[{"action":"play"}]', csrf_token: 'c' };
  const { params, encSecKey } = weapiEncrypt(body, key);

  const inner = aesDecrypt(params, key);
  assert.deepEqual(JSON.parse(aesDecrypt(inner, '0CoJUm6Qyw8W8jud')), body, 'the fixed key, then the random one');
  assert.equal(encSecKey, rsaReference([...key].reverse().join('')), 'the reversed key, raw RSA under the public key');
});

test('every request gets its own key', () => {
  const first = weapiEncrypt({ a: 1 });
  const second = weapiEncrypt({ a: 1 });
  assert.notEqual(first.encSecKey, second.encSecKey);
  assert.match(first.encSecKey, /^[0-9a-f]{256}$/);
});

// --------------------------------------------------------------- weblog

function loggingClient(answer = { code: 200, data: 'success' }) {
  const api = new Netease({ cookie: 'os=pc; appver=2.10.6; channel=netease; MUSIC_U=u; __csrf=token; NMTID=n' });
  const calls = [];
  api.call = async (url, options) => {
    calls.push({ url, ...options });
    return answer;
  };
  return { api, calls };
}

test('weblog goes to the log host as the web player, without the desktop-client cookies', async () => {
  const { api, calls } = loggingClient();
  await api.weblog([{ action: 'play', json: { id: 1 } }]);
  const [call] = calls;
  // music.163.com accepts the same request and records nothing.
  assert.equal(call.url, 'https://clientlogusf.music.163.com/weapi/feedback/weblog');
  assert.equal(call.method, 'POST');
  assert.deepEqual(call.query, { csrf_token: 'token' });
  assert.deepEqual(call.headers.Cookie.split('; ').sort(), ['MUSIC_U=u', 'NMTID=n', '__csrf=token']);
  assert.deepEqual(Object.keys(call.body).sort(), ['encSecKey', 'params']);
});

test('a refused log is an error, not a silent success', async () => {
  const { api } = loggingClient({ code: 301, message: 'need login' });
  await assert.rejects(api.weblog([]), /need login/);
});

// ------------------------------------------------------------- scrobbler

function scrobbler({ authenticated = true, enabled = true, fail = null } = {}) {
  const sent = [];
  const api = {
    authenticated,
    weblog: async (logs) => {
      if (fail) throw new Error(fail);
      sent.push(...logs);
      return { code: 200 };
    },
  };
  return { scrobbler: new Scrobbler({ api, enabled, logger: { warn() {}, info() {}, debug() {} } }), sent };
}

const TRACK = { id: 108640, name: '阴天' };
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a start is a startplay, as the web player sends it', async () => {
  const { scrobbler: reporter, sent } = scrobbler();
  reporter.start(TRACK);
  await flush();
  assert.deepEqual(sent, [
    { action: 'startplay', json: { id: 108640, type: 'song', content: 'id=108640', mainsite: '1', mainsiteWeb: '1' } },
  ]);
});

test('a play heard to its end is reported as ended in the player, with its length', async () => {
  const { scrobbler: reporter, sent } = scrobbler();
  await reporter.finish(TRACK, { seconds: 242.4, ended: true, heard: true });
  assert.deepEqual(sent, [
    {
      action: 'play',
      json: { type: 'song', wifi: 0, download: 0, id: 108640, time: 242, end: 'ui', mainsite: '1', mainsiteWeb: '1', content: 'id=108640' },
    },
  ]);
  assert.equal(reporter.status().last.error, null);
});

test('a play left after the skip window is reported as interrupted, with the time heard', async () => {
  const { scrobbler: reporter, sent } = scrobbler();
  await reporter.finish(TRACK, { seconds: 95, ended: false, heard: true });
  assert.deepEqual([sent[0].json.end, sent[0].json.time], ['interrupt', 95]);
});

test('a play left inside the skip window is not reported', async () => {
  const { scrobbler: reporter, sent } = scrobbler();
  await reporter.finish(TRACK, { seconds: 12, ended: false, heard: false });
  assert.deepEqual(sent, []);
  assert.equal(reporter.status().last, null);
});

test('nothing is reported when switched off, or without a session', async () => {
  for (const options of [{ enabled: false }, { authenticated: false }]) {
    const { scrobbler: reporter, sent } = scrobbler(options);
    reporter.start(TRACK);
    await reporter.finish(TRACK, { seconds: 200, ended: true, heard: true });
    await flush();
    assert.deepEqual(sent, [], JSON.stringify(options));
    assert.equal(reporter.status().active, false);
  }
});

test('a failed report is recorded for health and never thrown', async () => {
  const { scrobbler: reporter } = scrobbler({ fail: 'ECONNRESET' });
  reporter.start(TRACK);
  await reporter.finish(TRACK, { seconds: 200, ended: true, heard: true });
  assert.equal(reporter.status().last.error, 'ECONNRESET');
});
