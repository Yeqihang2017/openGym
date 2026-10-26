/* WebCrypto-backed, revocable openGym sessions on Workers.
 * Session tokens deliberately retain the upstream <uid>:<expiry>:<version>:<kind>
 * payload and HMAC-SHA256 framing. The signing secret must be provisioned through
 * a Worker secret, never checked into git. Callers always read current user state
 * from D1 before trusting a valid token.
 */
const DAYS = 90;
const encoder = new TextEncoder();

function toBase64Url(bytes) {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), c => c.charCodeAt(0));
  } catch { return null; }
}

async function signingKey(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function makeSession(user, secret, kind = 'b', now = Date.now()) {
  const expiry = now + DAYS * 86400000;
  const payload = `${user.id}:${expiry}:${user.session_version || 0}:${kind}`;
  const key = await signingKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifySessionToken(token, secret, now = Date.now()) {
  if (!token || typeof token !== 'string' || token.length > 512) return null;
  const cut = token.lastIndexOf('.');
  if (cut <= 0) return null;
  const payload = token.slice(0, cut);
  const bytes = fromBase64Url(token.slice(cut + 1));
  if (!bytes || bytes.byteLength !== 32) return null;
  const parts = payload.split(':');
  if (parts.length !== 4) return null;
  const [uid, expiryRaw, versionRaw, kind] = parts;
  if (!/^[A-Za-z0-9_-]{4,100}$/.test(uid) || !/^\d+$/.test(expiryRaw) || !/^\d+$/.test(versionRaw)) return null;
  if (kind !== 'c' && kind !== 'b') return null;
  const expiry = Number(expiryRaw), version = Number(versionRaw);
  if (!Number.isSafeInteger(expiry) || expiry <= now || !Number.isSafeInteger(version)) return null;
  const key = await signingKey(secret);
  if (!await crypto.subtle.verify('HMAC', key, bytes, encoder.encode(payload))) return null;
  return { uid, expiry, version, kind };
}

function cookies(request, name) {
  return (request.headers.get('cookie') || '').split(';').flatMap(part => {
    const equals = part.indexOf('=');
    return equals >= 0 && part.slice(0, equals).trim() === name ? [part.slice(equals + 1).trim()] : [];
  });
}

function cookieToken(request) {
  for (const name of ['__Host-gymsid', 'gymsid']) {
    const values = cookies(request, name);
    if (!values.length) continue;
    if (values.some(value => value !== values[0])) return null;
    return values[0];
  }
  return null;
}

export async function readSession(request, env) {
  const cookie = cookieToken(request);
  const header = request.headers.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  const token = cookie || bearer;
  const decoded = await verifySessionToken(token, env.SESSION_SECRET);
  if (!decoded) return null;
  const user = await env.DB.prepare(`SELECT id, name, is_admin, is_owner, disabled, session_version
    FROM users WHERE id = ? LIMIT 1`).bind(decoded.uid).first();
  if (!user || user.disabled || user.session_version !== decoded.version) return null;
  return { user, bearer: !cookie, expiry: decoded.expiry, kind: decoded.kind };
}

export const publicUser = user => ({ id: user.id, name: user.name, admin: !!user.is_admin,
  ...(user.is_owner ? { owner: true } : {}) });

const cookieName = url => new URL(url).protocol === 'https:' ? '__Host-gymsid' : 'gymsid';
const expired = (name, secure) => `${name}=; Path=/; Max-Age=0; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax`;

export async function sessionCookies(user, secret, url) {
  const secure = new URL(url).protocol === 'https:';
  const name = cookieName(url);
  const signed = await makeSession(user, secret, 'c');
  const active = `${name}=${signed}; Path=/; Max-Age=${DAYS * 86400}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax`;
  return secure ? [active, expired('gymsid', true)] : [active];
}

export const clearSessionCookies = url => {
  const secure = new URL(url).protocol === 'https:';
  return secure ? [expired('__Host-gymsid', true), expired('gymsid', true)] : [expired('gymsid', false)];
};

export const needsBearerRenewal = s => !!s && s.bearer && s.kind !== 'c' &&
  s.expiry - Date.now() < DAYS * 86400000 / 2;
