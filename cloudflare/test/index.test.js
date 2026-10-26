import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';

const request = (path, method = 'GET') => new Request(`https://gym.example.test${path}`, { method });
const env = {
  DB: { prepare: sql => ({ first: async () => {
    assert.equal(sql, 'SELECT 1 AS ready');
    return { ready: 1 };
  } }) },
  ASSETS: { fetch: async () => new Response('app shell', { status: 200 }) }
};

test('public config allows guest mode without advertising unavailable features', async () => {
  const response = await worker.fetch(request('/api/config'), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { invite_only: false, allow_guest: true });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('health checks D1 and reports preview status', async () => {
  const response = await worker.fetch(request('/api/health'), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, storage: 'd1', phase: 'preview' });
});

test('health returns 503 when D1 is unavailable', async () => {
  const response = await worker.fetch(request('/api/health'), {
    ...env, DB: { prepare: () => ({ first: async () => { throw new Error('offline'); } }) }
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).ok, false);
});

test('unported API routes do not fall through to the web app', async () => {
  for (const path of ['/api/me', '/api/data', '/api/media/0123']) {
    const response = await worker.fetch(request(path), env);
    assert.equal(response.status, 501);
    assert.equal((await response.json()).code, 'migration-incomplete');
  }
});

test('web and exercise-media files use the static assets binding', async () => {
  for (const path of ['/', '/exercise-media/clip/10000.mp4']) {
    const response = await worker.fetch(request(path), env);
    assert.equal(await response.text(), 'app shell');
  }
});

test('non-GET non-API methods are rejected', async () => {
  const response = await worker.fetch(request('/', 'POST'), env);
  assert.equal(response.status, 405);
});
