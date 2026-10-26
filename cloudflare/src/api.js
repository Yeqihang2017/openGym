/* First authenticated Worker API slice: passkeys, sessions and profile sync.
 * This does not yet replace upstream admin, device-pairing, media or Coach routes.
 * Registration is intentionally single-owner bootstrap-only until invitations and
 * account administration are ported. Never deploy publicly without secrets.
 */
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';
import { clearSessionCookies, makeSession, needsBearerRenewal, publicUser,
  readSession, sessionCookies } from './sessions.js';
import { forClient, readProfile, readRevision, writeProfile } from './state-store.js';

const MAX_AUTH_BODY = 64 * 1024;
const MAX_STATE_BODY = 5 * 1024 * 1024;
const CHALLENGE_TTL = 5 * 60 * 1000;
const defaultWebAuthn = {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
};

function requireSessionSecret(env) {
  // A successful ceremony changes D1; fail before that write if we cannot
  // issue the session cookie that the browser needs to continue.
  if (typeof env.SESSION_SECRET !== 'string' || env.SESSION_SECRET.length < 32) {
    throw new HttpFault(503, 'session signing is not configured');
  }
}

class HttpFault extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const response = (status, body, cookies = []) => {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
};

async function bodyOf(request, max = MAX_AUTH_BODY) {
  const declared = Number(request.headers.get('content-length'));
  if (declared > max) throw new HttpFault(413, 'body too large');
  if (!request.body) return {};
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, value = '';
  try {
    for (;;) {
      const { done, value: bytes } = await reader.read();
      if (done) break;
      size += bytes.byteLength;
      if (size > max) { await reader.cancel(); throw new HttpFault(413, 'body too large'); }
      value += decoder.decode(bytes, { stream: true });
    }
    value += decoder.decode();
  } finally { reader.releaseLock(); }
  try {
    const obj = JSON.parse(value || '{}');
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not object');
    return obj;
  } catch { throw new HttpFault(400, 'invalid JSON'); }
}

function sameOrigin(request, env) {
  const expected = new URL(env.PUBLIC_ORIGIN || request.url).origin;
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  return !origin || origin === expected;
}

function config(request, env) {
  const origin = new URL(env.PUBLIC_ORIGIN || request.url);
  if (!['https:', 'http:'].includes(origin.protocol)) throw new HttpFault(503, 'invalid public origin');
  return { origin: origin.origin, rpId: env.RP_ID || origin.hostname, rpName: 'openGym' };
}

function randomId() { return crypto.randomUUID().replaceAll('-', ''); }

async function codeMatches(raw, secret) {
  if (typeof secret !== 'string' || secret.length < 24 || typeof raw !== 'string' || raw.length > 200) return false;
  const bytes = new TextEncoder();
  const a = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.encode(raw.trim())));
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.encode(secret)));
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function addChallenge(db, kind, fields) {
  const cid = randomId();
  const expires = Date.now() + CHALLENGE_TTL;
  await db.prepare(`INSERT INTO auth_challenges (challenge_id, challenge_json, expires_at)
    VALUES (?, ?, ?)`).bind(cid, JSON.stringify({ kind, ...fields }), expires).run();
  return cid;
}

// DELETE ... RETURNING consumes the challenge exactly once, even on different edge workers.
async function takeChallenge(db, cid, kind) {
  if (typeof cid !== 'string' || !/^[a-f0-9]{32}$/.test(cid)) return null;
  const row = await db.prepare(`DELETE FROM auth_challenges WHERE challenge_id = ?
    RETURNING challenge_json, expires_at`).bind(cid).first();
  if (!row || row.expires_at < Date.now()) return null;
  const value = JSON.parse(row.challenge_json);
  return value.kind === kind ? value : null;
}

async function registerOptions(request, env, webAuthn) {
  requireSessionSecret(env);
  const body = await bodyOf(request);
  if (!await codeMatches(body.code, env.BOOTSTRAP_CODE)) {
    return response(403, { error: 'a valid setup code is required', code: 'invite' });
  }
  const existing = await env.DB.prepare('SELECT id FROM users LIMIT 1').first();
  if (existing) return response(403, { error: 'initial profile already created; registration is closed', code: 'invite' });
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
  if (!name) return response(400, { error: 'name required' });
  const uid = randomId();
  const { rpName, rpId } = config(request, env);
  const options = await webAuthn.generateRegistrationOptions({
    rpName, rpID: rpId, userID: new TextEncoder().encode(uid),
    userName: name, userDisplayName: name, attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    excludeCredentials: []
  });
  const cid = await addChallenge(env.DB, 'register', { challenge: options.challenge, uid, name });
  return response(200, { cid, options });
}

async function registerVerify(request, env, webAuthn) {
  requireSessionSecret(env);
  const body = await bodyOf(request);
  const challenge = await takeChallenge(env.DB, body.cid, 'register');
  if (!challenge?.uid) return response(400, { error: 'challenge expired, try again', code: 'challenge-expired' });
  let verified;
  const { origin, rpId } = config(request, env);
  try {
    verified = await webAuthn.verifyRegistrationResponse({
      response: body.credential, expectedChallenge: challenge.challenge,
      expectedOrigin: origin, expectedRPID: rpId, requireUserVerification: false
    });
  } catch { return response(400, { error: 'passkey verification failed' }); }
  if (!verified?.verified || !verified.registrationInfo?.credential) {
    return response(400, { error: 'not verified' });
  }
  const credential = verified.registrationInfo.credential;
  const transports = Array.isArray(body.credential?.response?.transports)
    ? body.credential.response.transports.filter(x => typeof x === 'string' && x.length < 32).slice(0, 8) : [];
  const now = Date.now();
  try {
    // These statements are one D1 transaction. Conditional first-owner insert
    // plus the passkey FK means two racing signups cannot both become admin.
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id, name, created_at, is_admin, is_owner)
        SELECT ?, ?, ?, 1, 1 WHERE NOT EXISTS (SELECT 1 FROM users)`)
        .bind(challenge.uid, challenge.name, now),
      env.DB.prepare(`INSERT INTO passkeys (credential_id, user_id, public_key, counter, transports_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(credential.id, challenge.uid, credential.publicKey, credential.counter || 0, JSON.stringify(transports), now)
    ]);
  } catch (error) {
    if (await env.DB.prepare('SELECT id FROM users LIMIT 1').first()) {
      return response(409, { error: 'initial profile already created or passkey already registered' });
    }
    throw error;
  }
  const user = { id: challenge.uid, name: challenge.name, is_admin: 1, is_owner: 1, session_version: 0 };
  return response(200, { user: publicUser(user) }, await sessionCookies(user, env.SESSION_SECRET, request.url));
}

async function loginOptions(request, env, webAuthn) {
  requireSessionSecret(env);
  const { rpId } = config(request, env);
  const options = await webAuthn.generateAuthenticationOptions({
    rpID: rpId, userVerification: 'preferred', allowCredentials: []
  });
  const cid = await addChallenge(env.DB, 'login', { challenge: options.challenge });
  return response(200, { cid, options });
}

async function loginVerify(request, env, webAuthn) {
  requireSessionSecret(env);
  const body = await bodyOf(request);
  const challenge = await takeChallenge(env.DB, body.cid, 'login');
  if (!challenge) return response(400, { error: 'challenge expired, try again', code: 'challenge-expired' });
  const row = await env.DB.prepare(`SELECT p.credential_id, p.user_id, p.public_key, p.counter, p.transports_json,
    u.id, u.name, u.is_admin, u.is_owner, u.disabled, u.session_version
    FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.credential_id = ? LIMIT 1`)
    .bind(body.credential?.id || '').first();
  if (!row) return response(404, { error: 'unknown passkey, create a profile first', code: 'unknown-credential' });
  if (row.disabled) return response(403, { error: 'this account has been disabled', code: 'disabled' });
  const { origin, rpId } = config(request, env);
  let verified;
  try {
    verified = await webAuthn.verifyAuthenticationResponse({
      response: body.credential, expectedChallenge: challenge.challenge,
      expectedOrigin: origin, expectedRPID: rpId, requireUserVerification: false,
      credential: {
        id: row.credential_id, publicKey: Uint8Array.from(row.public_key),
        counter: row.counter, transports: JSON.parse(row.transports_json)
      }
    });
  } catch { return response(400, { error: 'passkey verification failed' }); }
  if (!verified?.verified) return response(400, { error: 'not verified' });
  const nextCounter = verified.authenticationInfo?.newCounter;
  if (!Number.isSafeInteger(nextCounter) || nextCounter < 0) {
    return response(400, { error: 'invalid passkey counter' });
  }
  const saved = await env.DB.prepare(`UPDATE passkeys SET counter = ?
    WHERE credential_id = ? AND counter = ?`)
    .bind(nextCounter, row.credential_id, row.counter).run();
  if (saved.meta?.changes !== 1) return response(409, { error: 'passkey was used concurrently, try again' });
  return response(200, { user: publicUser(row) }, await sessionCookies(row, env.SESSION_SECRET, request.url));
}

async function authenticated(request, env, path) {
  const session = await readSession(request, env);
  if (!session) return response(401, { error: 'not signed in' });
  const { user } = session;
  if (path === 'GET /api/me') {
    const renewal = needsBearerRenewal(session) ? { token: await makeSession(user, env.SESSION_SECRET) } : {};
    return response(200, { user: publicUser(user), ...renewal });
  }
  if (path === 'POST /api/logout/all') {
    await env.DB.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').bind(user.id).run();
    return response(200, { ok: true }, clearSessionCookies(request.url));
  }
  if (path === 'GET /api/data/rev') return response(200, await readRevision(env.DB, user.id));
  if (path === 'GET /api/data') {
    const current = await readProfile(env.DB, env.MEDIA, user.id);
    return response(200, { state: forClient(current.state), rev: current.rev });
  }
  if (path === 'PUT /api/data') {
    const body = await bodyOf(request, MAX_STATE_BODY);
    const answer = await writeProfile(env.DB, env.MEDIA, user.id, body);
    return response(answer.status, answer.body);
  }
  return null;
}

const AUTHENTICATED = new Set(['GET /api/me', 'POST /api/logout/all', 'GET /api/data',
  'GET /api/data/rev', 'PUT /api/data']);

export async function handleApi(request, env, webAuthn = defaultWebAuthn) {
  const url = new URL(request.url);
  const path = `${request.method} ${url.pathname}`;
  if (!AUTHENTICATED.has(path) && ![
    'POST /api/register/options', 'POST /api/register/verify',
    'POST /api/login/options', 'POST /api/login/verify', 'POST /api/logout'
  ].includes(path)) return null;

  try {
    if (request.method !== 'GET' && !sameOrigin(request, env)) return response(403, { error: 'wrong origin' });
    if (path === 'POST /api/register/options') return await registerOptions(request, env, webAuthn);
    if (path === 'POST /api/register/verify') return await registerVerify(request, env, webAuthn);
    if (path === 'POST /api/login/options') return await loginOptions(request, env, webAuthn);
    if (path === 'POST /api/login/verify') return await loginVerify(request, env, webAuthn);
    if (path === 'POST /api/logout') return response(200, { ok: true }, clearSessionCookies(request.url));
    return await authenticated(request, env, path);
  } catch (error) {
    if (error instanceof HttpFault) return response(error.status, { error: error.message });
    console.error(JSON.stringify({ event: 'api_error', route: path, message: error?.name || 'unknown' }));
    return response(503, { error: 'API temporarily unavailable' });
  }
}
