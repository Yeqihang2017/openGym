/* Profile state storage on D1 + R2, not yet exposed as HTTP routes.
 *
 * An R2 object is written under a fresh immutable key first. Only once it exists
 * does a conditional D1 update publish it as the current version. Concurrent
 * writers can never overwrite each other, and a reader that fetched the old D1
 * pointer can still fetch that object (we deliberately retain old versions).
 *
 * Callers MUST derive userId from a verified session. Never take it directly
 * from a client body or query parameter.
 */
import { stampPut } from '../../api/sync-stamps.js';

const WID_KEEP = 50;
const MAX_STATE_BYTES = 5 * 1024 * 1024;
const getRow = (db, userId) => db.prepare(
  'SELECT revision, write_id, object_key FROM profile_state WHERE user_id = ? LIMIT 1'
).bind(userId).first();

const records = entries => entries.filter(x => x && typeof x === 'object' && !Array.isArray(x));
const hasData = state => Object.keys(state).some(k => k !== '_rev' && k !== '_ts');
const isList = x => x == null || Array.isArray(x);
const hexId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');

async function readBlob(media, key) {
  const object = await media.get(key);
  if (!object) throw new Error('profile state object missing from R2');
  if (object.size != null && object.size > MAX_STATE_BYTES) throw new Error('stored profile state exceeds size limit');
  // The upstream API limits HTTP JSON bodies and can store a multi-MB state.
  // R2, rather than D1's 2 MB row, owns that immutable serialized document.
  const state = JSON.parse(await object.text());
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('invalid stored profile state');
  return state;
}

// Server-side stamp bookkeeping is not part of the sync document the client
// merges. Keep exactly the upstream Node API's public document shape.
export function forClient(state) {
  if (!state || typeof state !== 'object' || !('_unstamped' in state || '_prior' in state)) return state;
  const { _unstamped, _prior, ...rest } = state;
  return rest;
}

export async function readProfile(db, media, userId) {
  const row = await getRow(db, userId);
  return row ? { state: await readBlob(media, row.object_key), rev: row.revision, wid: row.write_id } : { state: null, rev: 0, wid: null };
}

export async function readRevision(db, userId) {
  const row = await db.prepare('SELECT revision, write_id FROM profile_state WHERE user_id = ? LIMIT 1')
    .bind(userId).first();
  return { rev: row?.revision || 0, ...(row?.write_id ? { wid: row.write_id } : {}) };
}

/** Preserve the current Node API's return shapes for the later HTTP route. */
export async function writeProfile(db, media, userId, body, now = Date.now()) {
  if (!body || !body.state || typeof body.state !== 'object' || Array.isArray(body.state) || !hasData(body.state)) {
    return { status: 400, body: { error: 'state required' } };
  }
  if (!isList(body.state.workouts) || !isList(body.state.routines)) {
    return { status: 400, body: { error: 'invalid state' } };
  }

  const row = await getRow(db, userId);
  const curRev = row?.revision || 0;
  const curWid = row?.write_id || null;
  const conflict = body.baseRev != null && (
    body.baseRev !== curRev ||
    (typeof body.baseWid === 'string' && curWid && body.baseWid !== curWid)
  );
  if (conflict) {
    return { status: 409, body: { error: 'conflict', rev: curRev,
      state: row ? forClient(await readBlob(media, row.object_key)) : null } };
  }

  let next;
  try { next = JSON.parse(JSON.stringify(body.state)); }
  catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) return { status: 400, body: { error: 'invalid state' } };
    throw error;
  }
  for (const k of ['workouts', 'routines']) if (Array.isArray(next[k])) next[k] = records(next[k]);
  delete next.active;

  const old = row ? await readBlob(media, row.object_key) : null;
  if ((Number(old?.resetAt) || 0) > (Number(next.resetAt) || 0)) {
    next.resetAt = old.resetAt;
    if (old.resetIds && typeof old.resetIds === 'object') next.resetIds = old.resetIds;
    else delete next.resetIds;
  }

  const report = {};
  try { stampPut(old, next, { overRead: body.baseRev != null && body.baseRev === curRev,
    stamped: body.stamped === true, now, report }); }
  catch (error) {
    if (error instanceof RangeError) return { status: 400, body: { error: 'invalid state' } };
    throw error;
  }
  next._rev = curRev + (report.changed ? 2 : 1);
  next._wids = [...(Array.isArray(old?._wids) ? old._wids : []), ...(old?._wid ? [old._wid] : [])]
    .filter(x => typeof x === 'string').slice(-WID_KEEP);
  next._wid = hexId();

  let serialized;
  try { serialized = JSON.stringify(next); }
  catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) return { status: 400, body: { error: 'invalid state' } };
    throw error;
  }
  if (new TextEncoder().encode(serialized).length > MAX_STATE_BYTES) {
    return { status: 413, body: { error: 'state too large' } };
  }
  const newKey = `profiles/${encodeURIComponent(userId)}/${crypto.randomUUID()}.json`;
  await media.put(newKey, serialized, { httpMetadata: { contentType: 'application/json' } });

  // SQL CAS publishes the entire new document in a single atomic metadata change.
  // If a competing writer published first, its document wins; the caller merges
  // the 409 body exactly as with the Node implementation.
  const query = row
    ? db.prepare(`UPDATE profile_state SET revision = ?, write_id = ?, object_key = ?, updated_at = ?
       WHERE user_id = ? AND revision = ? AND write_id IS ?`)
      .bind(next._rev, next._wid, newKey, now, userId, curRev, curWid)
    : db.prepare(`INSERT INTO profile_state (user_id, revision, write_id, object_key, updated_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO NOTHING`)
      .bind(userId, next._rev, next._wid, newKey, now);

  // A thrown D1 call might have committed before its reply was lost. Never
  // eagerly delete the object in that case: it might now be the live pointer.
  const result = await query.run();
  if ((result.meta?.changes || 0) !== 1) {
    // Here the SQL statement definitely completed without changing a row.
    try { await media.delete(newKey); } catch { /* best-effort orphan cleanup */ }
    const latest = await readProfile(db, media, userId);
    return { status: 409, body: { error: 'conflict', rev: latest.rev, state: forClient(latest.state) } };
  }
  return { status: 200, body: { ok: true, ts: next._ts || null, rev: curRev + 1, wid: next._wid } };
}
