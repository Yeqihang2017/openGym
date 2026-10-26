import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { readProfile, readRevision, writeProfile } from '../src/state-store.js';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  sqlite.prepare('INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)').run('alice', 'Alice', 0);
  const db = { prepare: sql => ({ bind: (...args) => ({
    first: async () => sqlite.prepare(sql).get(...args) || null,
    run: async () => {
      const info = sqlite.prepare(sql).run(...args);
      return { meta: { changes: Number(info.changes) } };
    }
  }) }) };
  const objects = new Map();
  const media = {
    get: async key => objects.has(key) ? { text: async () => objects.get(key) } : null,
    put: async (key, value) => { objects.set(key, value); },
    delete: async key => { objects.delete(key); }
  };
  return { sqlite, db, objects, media };
}

const plan = text => ({ workouts: [], routines: [{ id: 'push', name: text }] });

test('new profile writes to R2 and publishes a D1 pointer', async () => {
  const { sqlite, db, objects, media } = fixture();
  const result = await writeProfile(db, media, 'alice', { state: plan('Push') }, 100);
  assert.equal(result.status, 200);
  assert.equal(result.body.rev, 1);
  assert.deepEqual((await readProfile(db, media, 'alice')).state.routines.map(x => x.name), ['Push']);
  assert.deepEqual((await readRevision(db, 'alice')).rev, 1);
  assert.equal(objects.size, 1);
  const pointer = sqlite.prepare('SELECT object_key FROM profile_state WHERE user_id = ?').get('alice').object_key;
  assert.ok(pointer.startsWith('profiles/alice/'));
  assert.ok(objects.has(pointer));
  sqlite.close();
});

test('stale baseRev and baseWid return 409 without uploading', async () => {
  const { db, objects, media } = fixture();
  const first = await writeProfile(db, media, 'alice', { state: plan('Push') });
  const a = await writeProfile(db, media, 'alice', { state: plan('Pull'), baseRev: 0 });
  assert.equal(a.status, 409);
  assert.deepEqual(a.body.state.routines.map(x => x.name), ['Push']);
  const b = await writeProfile(db, media, 'alice', { state: plan('Pull'), baseRev: 1, baseWid: 'wrong' });
  assert.equal(b.status, 409);
  assert.equal(objects.size, 1);
  assert.equal((await readRevision(db, 'alice')).wid, first.body.wid);
});

test('a multi-megabyte state bypasses D1 row limit using R2', async () => {
  const { sqlite, db, objects, media } = fixture();
  const state = { ...plan('Push'), largeText: 'x'.repeat(2_100_000) };
  assert.equal((await writeProfile(db, media, 'alice', { state })).status, 200);
  assert.equal((await readProfile(db, media, 'alice')).state.largeText.length, 2_100_000);
  assert.equal(objects.size, 1);
  assert.ok(sqlite.prepare('SELECT length(object_key) AS n FROM profile_state').get().n < 150);
});

test('SQL CAS detects a concurrent writer after the R2 upload', async () => {
  const { sqlite, db, objects, media } = fixture();
  await writeProfile(db, media, 'alice', { state: plan('Push') });
  const old = await readProfile(db, media, 'alice');
  let raced = false;
  media.put = async (key, value) => {
    objects.set(key, value);
    if (!raced) {
      raced = true;
      objects.set('other-writer.json', JSON.stringify({ ...plan('Legs'), _rev: 2, _wid: 'other-wid' }));
      sqlite.prepare('UPDATE profile_state SET revision = 2, write_id = ?, object_key = ? WHERE user_id = ?')
        .run('other-wid', 'other-writer.json', 'alice');
    }
  };
  const result = await writeProfile(db, media, 'alice', {
    state: plan('Pull'), baseRev: old.rev, baseWid: old.wid, stamped: true
  });
  assert.equal(result.status, 409);
  assert.deepEqual(result.body.state.routines.map(x => x.name), ['Legs']);
  assert.equal((await readRevision(db, 'alice')).rev, 2);
  // The loser only deletes its own new upload, not the previous or winner's blob.
  assert.equal(objects.size, 2);
});

test('invalid and empty profile documents are rejected', async () => {
  const { db, objects, media } = fixture();
  assert.equal((await writeProfile(db, media, 'alice', { state: {} })).status, 400);
  assert.equal((await writeProfile(db, media, 'alice', { state: { workouts: {} } })).status, 400);
  assert.equal((await writeProfile(db, media, 'alice', {
    state: { ...plan('Push'), largeText: 'x'.repeat(5 * 1024 * 1024) }
  })).status, 413);
  assert.equal(objects.size, 0);
});
