// The ONE read and write path for a person's synced profile. PUT /sync (accounts.js) and the Claude connector
// (mcp.js) both write through saveProfile(), so a save from Claude merges exactly like a save from another
// device, and the app picks it up on its next GET /sync.
//
// Storage (migration 0005, 2026-10-24): one D1 row per top-level key and one per entry of an entry map, in
// profile_items(user_id, k, id, v, t). The key's own row has id = ''; its v is the key's JSON, or NULL when the
// key is a map whose entries are the other rows. So a request reads and writes only what it touches, and the
// entry-by-entry merge ("newer t wins") runs inside D1 as one upsert per key. The Worker never parses or
// re-serialises the whole profile: that cost 10 to 39 ms of CPU per call with an 850 KB profile (Free plan: 10 ms).
//
// profiles(user_id) keeps version (bumped on every write that changes something), stamps (per-key times, small),
// bytes (kept exact by triggers on profile_items) and updated. Its old `doc` column is no longer used ('{}').
import { ENTRY_KEYS, MAX_BYTES, WIPE_LIMIT, keyStamp, removedBy, decide } from './sync.js';

const isMapKey = k => ENTRY_KEYS.includes(k);
const CHUNK = 90;   // D1 allows 100 bound parameters per statement

// ---------------------------------------------------------------- reading
// The whole profile as the JSON text of {doc, stamps, version, updated, bytes, …extra}. D1 assembles the document
// itself (json_group_object), so the Worker receives ONE string and never parses or re-serialises the profile.
export async function profileJson(DB, userId, extra = {}) {
  const r = await DB.prepare(`SELECT p.version, p.stamps, p.bytes, p.updated,
      (SELECT json_group_object(h.k, CASE WHEN h.v IS NULL
          THEN (SELECT json_group_object(e.id, json(e.v)) FROM profile_items e WHERE e.user_id = h.user_id AND e.k = h.k AND e.id != '')
          ELSE json(h.v) END)
        FROM profile_items h WHERE h.user_id = p.user_id AND h.id = '') AS doc
    FROM profiles p WHERE p.user_id = ?`).bind(userId).first();
  const head = { version: r ? r.version : 0, updated: r ? r.updated : null, bytes: r ? r.bytes : 2, ...extra };
  return `{"doc":${r && r.doc ? r.doc : '{}'},"stamps":${r ? r.stamps : '{}'},${JSON.stringify(head).slice(1)}`;
}

export async function profileVersion(DB, userId) {
  const r = await DB.prepare('SELECT version FROM profiles WHERE user_id = ?').bind(userId).first();
  return r ? r.version : 0;
}

// What is stored under each key: {k: 'map' | 'value' | 'null'} ('null' = a stored null; absent keys are left out).
export async function shapes(DB, userId, keys) {
  if (!keys.length) return {};
  const rows = (await DB.prepare(`SELECT k, v IS NULL AS m, v = 'null' AS n FROM profile_items WHERE user_id = ? AND id = '' AND k IN (${keys.map(() => '?').join(',')})`)
    .bind(userId, ...keys).all()).results;
  return Object.fromEntries(rows.map(r => [r.k, r.m ? 'map' : r.n ? 'null' : 'value']));
}

// Some entries of one map, parsed: {id: entry}. Missing ids are left out.
export async function entries(DB, userId, k, ids) {
  const out = {};
  const list = [...new Set(ids)];
  for (let i = 0; i < list.length; i += CHUNK) {
    const part = list.slice(i, i + CHUNK);
    const rows = (await DB.prepare(`SELECT id, v FROM profile_items WHERE user_id = ? AND k = ? AND id IN (${part.map(() => '?').join(',')})`)
      .bind(userId, k, ...part).all()).results;
    for (const r of rows) { try { out[r.id] = JSON.parse(r.v); } catch {} }
  }
  return out;
}

// ---------------------------------------------------------------- writing
// Merges {doc, stamps} into the stored profile. Returns {ok:true, version, changed, bytes} or {ok:false, status, error, extra?}.
//
// Every statement of one write runs in one D1 batch (a transaction). Concurrency is handled PER KEY, so two
// devices (or the app and Claude) writing different keys never get in each other's way:
//   - an entry merge needs only that the key is still a map; the "newer t wins" rule is applied by D1 itself;
//   - a whole-key replacement applies only while that key's stamp is still the one it was decided against.
// A key whose condition no longer holds is planned again on top of what is there now (up to 8 tries).
// Key names are checked by KEY_RE ([A-Za-z0-9_-]) and stamps are numbers, so both are safe to write into the SQL.
const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function saveProfile(DB, userId, doc, stamps = {}, now = Date.now(), { confirmWipe = false } = {}) {
  let keys = Object.keys(doc);
  const changed = new Set();
  let wrote = false;
  for (let attempt = 0; attempt < 8 && keys.length; attempt++) {
    if (attempt) await sleep(15 + Math.random() * 40 * attempt);
    const [p, h] = await DB.batch([
      DB.prepare('SELECT stamps FROM profiles WHERE user_id = ?').bind(userId),
      DB.prepare(`SELECT k, v IS NULL AS m, CASE WHEN v IS NOT NULL AND length(v) <= 200000 THEN v END AS v FROM profile_items
        WHERE user_id = ? AND id = '' AND k IN (${keys.map(() => '?').join(',')})`).bind(userId, ...keys),
    ]);
    const baseStamps = p.results[0] ? JSON.parse(p.results[0].stamps || '{}') : {};
    const heads = Object.fromEntries(h.results.map(r => [r.k, r]));
    const plan = [];
    for (const k of keys) {
      const v = doc[k], s = keyStamp(stamps[k], now), have = k in baseStamps && Number.isFinite(baseStamps[k]) ? baseStamps[k] : -1;
      const hd = heads[k];
      const head = { kind: !hd ? 'absent' : hd.m ? 'map' : 'value' };
      const how = decide(k, v, s, have, head);
      if (how === 'skip') continue;
      if (how !== 'entries') {
        // the wipe guard: a whole-key replacement may not drop more than WIPE_LIMIT entries without confirmWipe
        let removed = 0;
        if (head.kind === 'map') removed = (await DB.prepare(`SELECT COUNT(*) n FROM profile_items WHERE user_id = ? AND k = ? AND id != ''
          AND COALESCE(json_extract(v, '$.deleted'), 0) = 0`).bind(userId, k).first()).n;
        else if (head.kind === 'value') {
          let before = null;
          try { before = JSON.parse(hd.v !== null ? hd.v : (await DB.prepare(`SELECT v FROM profile_items WHERE user_id = ? AND k = ? AND id = ''`).bind(userId, k).first()).v); } catch {}
          removed = removedBy(before, v, isMapKey(k));
        }
        if (removed > WIPE_LIMIT && !confirmWipe)
          return { ok: false, status: 409, error: `That would remove ${removed} entries from "${k}" at once. Send confirmWipe: true if that is really meant.`, extra: { needsConfirm: true, key: k, removing: removed } };
      }
      plan.push({ k, how, s, have, n: how === 'replace' ? 0 : Object.keys(v).length, json: JSON.stringify(v) });
    }
    if (!plan.length) { keys = []; break; }

    const path = k => `'$."${k}"'`;
    const STAMPS = `(SELECT stamps FROM profiles WHERE user_id = ?1)`;
    // the condition each planned key was decided under
    const cond = it => it.how === 'entries'
      ? `EXISTS (SELECT 1 FROM profile_items WHERE user_id = ?1 AND k = '${it.k}' AND id = '' AND v IS NULL)`
      : `COALESCE(json_extract(${STAMPS}, ${path(it.k)}), -1) = ${it.have}`;
    const st = [DB.prepare(`INSERT INTO profiles(user_id, doc, stamps, version, bytes, updated) VALUES(?, '{}', '{}', 0, 0, ?) ON CONFLICT(user_id) DO NOTHING`).bind(userId, now)];
    const probe = [];   // [statement index, item]: a row back means the item applied
    for (const it of plan) {
      const c = cond(it);
      if (it.how === 'entries') probe.push([st.length, it]), st.push(DB.prepare(`SELECT 1 AS ok WHERE ${c}`).bind(userId));
      else {
        st.push(DB.prepare(`DELETE FROM profile_items WHERE user_id = ?1 AND k = ?2 AND id != '' AND ${c}`).bind(userId, it.k));
        probe.push([st.length, it]);
        st.push(DB.prepare(`INSERT INTO profile_items(user_id, k, id, v, t) SELECT ?1, ?2, '', ?3, NULL WHERE ${c}
          ON CONFLICT(user_id, k, id) DO UPDATE SET v = excluded.v RETURNING k`).bind(userId, it.k, it.how === 'replace' ? it.json : null));   // a map's own row holds NULL
      }
      if (it.n) {
        // the entry merge, done by D1 over the incoming map: an entry is compared on its own t (an entry without one
        // takes the key's stamp; one from the future is stored with t = now), and replaces the stored entry only if newer
        it.entriesAt = st.length;
        const T = `json_extract(j.value, '$.t')`, HAS_T = `json_type(j.value, '$.t') IN ('integer', 'real')`;
        st.push(DB.prepare(`INSERT INTO profile_items(user_id, k, id, v, t)
            SELECT ?1, ?2, j.key, CASE WHEN ${HAS_T} AND ${T} > ${now} THEN json_set(j.value, '$.t', ${now}) ELSE j.value END,
              CASE WHEN ${HAS_T} THEN MIN(${T}, ${now}) ELSE ${it.s} END
            FROM json_each(?3) j WHERE ${c}
            ON CONFLICT(user_id, k, id) DO UPDATE SET v = excluded.v, t = excluded.t WHERE excluded.t > profile_items.t`)
          .bind(userId, it.k, it.json));
      }
    }
    // stamps move per key, only for the keys that applied; the version moves only when something changed
    // (the item triggers set dirty) or a stamp moved. profiles_cap aborts the whole batch past MAX_BYTES.
    const stampsExpr = plan.reduce((acc, it) => `json_patch(${acc}, CASE WHEN ${cond(it)} THEN json_object('${it.k}', ${it.how === 'entries'
      ? `MAX(COALESCE(json_extract(stamps, ${path(it.k)}), -1), ${it.s})` : it.s}) ELSE '{}' END)`, 'stamps');
    st.push(DB.prepare(`UPDATE profiles SET stamps = ${stampsExpr}, version = version + 1, updated = ?2, dirty = 0
      WHERE user_id = ?1 AND (dirty = 1 OR ${stampsExpr} != stamps)`).bind(userId, now));
    let res;
    try { res = await DB.batch(st); }
    catch (e) {
      if (/profile too large/.test(String(e && e.message || e)))
        return { ok: false, status: 413, error: `That would make your profile bigger than ${MAX_BYTES / 1e6} MB. Remove old entries and try again.` };
      throw e;
    }
    if (res[res.length - 1].meta.changes) wrote = true;
    const retry = new Set();
    for (const [i, it] of probe) {
      if (!(res[i].results || []).length) { retry.add(it.k); continue; }       // its condition no longer held: plan it again
      if (it.how !== 'entries' || (it.entriesAt !== undefined && res[it.entriesAt].meta.changes > 0)) changed.add(it.k);
    }
    keys = keys.filter(k => retry.has(k));
  }
  if (keys.length) return { ok: false, status: 409, error: 'Your profile is being saved from another device right now. Please try again.' };
  const b = wrote ? await DB.prepare('SELECT version, bytes FROM profiles WHERE user_id = ?').bind(userId).first() : null;
  return { ok: true, version: b ? b.version : null, changed: [...changed], bytes: b ? b.bytes : null };
}
