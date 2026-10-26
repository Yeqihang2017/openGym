import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handleApi } from '../src/api.js';
import { makeSession, verifySessionToken } from '../src/sessions.js';

const BASE = 'https://gym.example.test';
const BOOTSTRAP = 'ABCDEFGHIJKLMNOPQRSTUVWX12345678';
const SECRET = 'session-secret-for-tests-0123456789abcdef';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  const prepare = (sql, params = []) => ({
    bind: (...next) => prepare(sql, next),
    first: async () => sqlite.prepare(sql).get(...params) || null,
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...params).changes) } })
  });
  const DB = {
    prepare,
    // Model the D1 batch guarantee: statements are executed in one transaction.
    batch: async statements => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
  const blobs = new Map();
  const MEDIA = {
    get: async key => blobs.has(key) ? { text: async () => blobs.get(key), size: blobs.get(key).length } : null,
    put: async (key, value) => { blobs.set(key, value); },
    delete: async key => { blobs.delete(key); }
  };
  const env = { DB, MEDIA, BOOTSTRAP_CODE: BOOTSTRAP, SESSION_SECRET: SECRET, PUBLIC_ORIGIN: BASE };
  let counter = 0;
  const webAuthn = {
    generateRegistrationOptions: async () => ({ challenge: 'register-challenge', rp: { id: 'gym.example.test' } }),
    verifyRegistrationResponse: async () => ({ verified: true,
      registrationInfo: { credential: { id: 'credential-one', publicKey: new Uint8Array([1, 2, 3]), counter: 0 } } }),
    generateAuthenticationOptions: async () => ({ challenge: 'login-challenge' }),
    verifyAuthenticationResponse: async () => ({ verified: true, authenticationInfo: { newCounter: ++counter } })
  };
  async function call(path, { method = 'GET', body, cookie, origin = BASE, extraHeaders } = {}) {
    const headers = new Headers(extraHeaders || {});
    if (method !== 'GET') headers.set('origin', origin);
    if (cookie) headers.set('cookie', cookie);
    if (body !== undefined) headers.set('content-type', 'application/json');
    return handleApi(new Request(BASE + path, { method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, webAuthn);
  }
  async function register() {
    const options = await call('/api/register/options', { method: 'POST', body: { name: 'Kai', code: BOOTSTRAP } });
    assert.equal(options.status, 200);
    const { cid } = await options.json();
    const verify = await call('/api/register/verify', { method: 'POST', body: {
      cid, credential: { id: 'credential-one', response: { transports: ['internal'] } }
    } });
    assert.equal(verify.status, 200);
    const cookie = verify.headers.getSetCookie().find(v => v.startsWith('__Host-gymsid=')).split(';')[0];
    return { cookie, verify };
  }
  return { sqlite, env, blobs, webAuthn, call, register };
}

const plan = name => ({ workouts: [], routines: [{ id: 'plan-1', name }] });

test('guarded first-owner registration creates one account, session and passkey', async t => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const invalid = await f.call('/api/register/options', { method: 'POST', body: { name: 'Kai', code: 'wrong' } });
  assert.equal(invalid.status, 403);

  const { cookie, verify } = await f.register();
  assert.deepEqual((await verify.json()).user, { id: f.sqlite.prepare('SELECT id FROM users').get().id,
    name: 'Kai', admin: true, owner: true });
  assert.ok(cookie.includes('__Host-gymsid='));
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM users').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM passkeys').get().n, 1);
  const me = await f.call('/api/me', { cookie });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.name, 'Kai');
  assert.equal((await f.call('/api/register/options', { method: 'POST', body: {
    name: 'Other', code: BOOTSTRAP
  } })).status, 403);
});

test('registration challenges are single-use and racing first-owner registrations cannot add a second user', async t => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const start = () => f.call('/api/register/options', { method: 'POST', body: { name: 'Kai', code: BOOTSTRAP } });
  const first = (await (await start()).json()).cid;
  const second = (await (await start()).json()).cid;
  const complete = cid => f.call('/api/register/verify', { method: 'POST', body: {
    cid, credential: { id: 'credential-one' }
  } });
  assert.equal((await complete(first)).status, 200);
  assert.equal((await complete(first)).status, 400);
  assert.equal((await complete(second)).status, 409);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM users').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM passkeys').get().n, 1);
});

test('passkey login, session invalidation and logout cookies', async t => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const { cookie } = await f.register();
  const login = await f.call('/api/login/options', { method: 'POST', body: {} });
  assert.equal(login.status, 200);
  const { cid } = await login.json();
  const done = await f.call('/api/login/verify', { method: 'POST', body: {
    cid, credential: { id: 'credential-one' }
  } });
  assert.equal(done.status, 200);
  const secondCookie = done.headers.getSetCookie().find(v => v.startsWith('__Host-gymsid=')).split(';')[0];
  assert.equal(f.sqlite.prepare('SELECT counter FROM passkeys').get().counter, 1);
  assert.equal((await f.call('/api/login/verify', { method: 'POST', body: { cid, credential: { id: 'credential-one' } } })).status, 400);
  const revoked = await f.call('/api/logout/all', { method: 'POST', body: {}, cookie });
  assert.equal(revoked.status, 200);
  assert.ok(revoked.headers.getSetCookie().some(x => x.includes('Max-Age=0')));
  assert.equal((await f.call('/api/me', { cookie })).status, 401);
  assert.equal((await f.call('/api/me', { cookie: secondCookie })).status, 401);
});

test('profile data sync preserves revision, conflicts and server-private stamp fields', async t => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const { cookie } = await f.register();
  assert.deepEqual(await (await f.call('/api/data/rev', { cookie })).json(), { rev: 0 });
  const created = await f.call('/api/data', { method: 'PUT', cookie, body: { state: plan('Push') } });
  assert.equal(created.status, 200);
  const { rev, wid } = await created.json();
  assert.equal(rev, 1);
  assert.equal((await f.call('/api/data/rev', { cookie })).status, 200);
  const pulled = await (await f.call('/api/data', { cookie })).json();
  assert.equal(pulled.rev, 1);
  assert.equal(pulled.state.routines[0].name, 'Push');
  const bad = await f.call('/api/data', { method: 'PUT', cookie,
    body: { baseRev: 0, state: plan('Legs') } });
  assert.equal(bad.status, 409);
  assert.equal((await bad.json()).state.routines[0].name, 'Push');
  const next = await f.call('/api/data', { method: 'PUT', cookie,
    body: { baseRev: 1, baseWid: wid, state: plan('Legs') } });
  assert.equal(next.status, 200);
  assert.equal((await f.call('/api/data/rev', { cookie })).status, 200);
  assert.equal(f.blobs.size, 2);
  // Original Node API hides two internal sync-stamp bookkeeping fields.
  const pointer = f.sqlite.prepare('SELECT object_key FROM profile_state').get().object_key;
  const stored = JSON.parse(f.blobs.get(pointer));
  stored._prior = { private: true };
  stored._unstamped = ['private'];
  f.blobs.set(pointer, JSON.stringify(stored));
  const publicCopy = await (await f.call('/api/data', { cookie })).json();
  assert.equal('_prior' in publicCopy.state, false);
  assert.equal('_unstamped' in publicCopy.state, false);
});

test('origin checks, missing signing secret and malformed requests fail closed', async t => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const malicious = await f.call('/api/register/options', { method: 'POST', origin: 'https://attacker.test',
    body: { name: 'Kai', code: BOOTSTRAP } });
  assert.equal(malicious.status, 403);
  f.env.SESSION_SECRET = '';
  const unconfigured = await f.call('/api/register/options', { method: 'POST',
    body: { name: 'Kai', code: BOOTSTRAP } });
  assert.equal(unconfigured.status, 503);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM users').get().n, 0);
  f.env.SESSION_SECRET = SECRET;
  const wrongType = await f.call('/api/register/options', { method: 'POST', body: [] });
  assert.equal(wrongType.status, 400);
  assert.equal((await f.call('/api/data')).status, 401);
  assert.equal((await verifySessionToken('malformed', SECRET)), null);
  const expired = await makeSession({ id: 'abcd', session_version: 0 }, SECRET, 'c', -100 * 86400000);
  assert.equal(await verifySessionToken(expired, SECRET), null);
});
