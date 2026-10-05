/**
 * NetEase's `weapi` request encryption, for the few endpoints the plain web
 * API accepts but ignores.
 *
 * The plugin talks to the plain (`/api/…`) endpoints wherever they work,
 * because they need no client secrets. Scrobbling is the exception that
 * forced this module: a play reaches the listening history only when it is
 * sent the way the web player sends it — encrypted, to the log host, without
 * the desktop-client cookies — and the plain endpoint answers `success` to
 * anything, even an empty request, while recording nothing. See
 * `Netease#weblog`.
 *
 * The scheme is the web player's own: the JSON body is AES-128-CBC encrypted
 * with a fixed key, then again with a random 16-character key, and that key —
 * reversed — is RSA-encrypted without padding under NetEase's published
 * public key. The constants are the web player's, as documented by the
 * MIT-licensed NeteaseCloudMusicApi project.
 *
 * @module dsh-music/weapi
 */

import crypto from 'node:crypto';

const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const IV = '0102030405060708';
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;

function aes(text, key) {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(IV));
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64');
}

function rsa(text) {
  const message = Buffer.from(text);
  const padded = Buffer.concat([Buffer.alloc(128 - message.length), message]);
  return crypto.publicEncrypt({ key: PUBLIC_KEY, padding: crypto.constants.RSA_NO_PADDING }, padded).toString('hex');
}

/**
 * Encrypt one request body the way the web player does.
 *
 * @param {object} data the body, `csrf_token` included.
 * @param {string} [secretKey] the per-request key; random unless a test pins it.
 * @returns {{params: string, encSecKey: string}} the form fields to POST.
 */
export function weapiEncrypt(data, secretKey = randomKey()) {
  return {
    params: aes(aes(JSON.stringify(data), PRESET_KEY), secretKey),
    encSecKey: rsa([...secretKey].reverse().join('')),
  };
}

function randomKey() {
  return Array.from(crypto.randomBytes(16), (byte) => BASE62[byte % BASE62.length]).join('');
}
