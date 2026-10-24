// The profile sync rules: validation of an incoming PUT and the per-key decisions of the merge. Pure, so they
// are tested in Node without a database. The entry-by-entry merge itself runs inside D1 (src/profile.js) and is
// tested end to end in test/sync.mjs.
//
// A profile is a JSON object of top-level keys (settings, words, progress, library, reports, …) plus a stamp
// per key: the time (ms) that key last changed on the device that sent it.
//
// Rules:
//  1. Whole-key last-writer-wins: an incoming key replaces the stored one only when its stamp is NEWER.
//     An equal stamp keeps what is stored, so re-sending the same PUT changes nothing.
//  2. ENTRY-MAP keys (ENTRY_KEYS): when both the stored and the incoming value are maps, they merge entry by
//     entry instead, each entry winning on its own `t` (ms). That is what lets a phone and a tablet review
//     different words on the same day without one erasing the other. An entry missing from the incoming map
//     is KEPT (absence is not deletion); delete with a tombstone {t, deleted:true}.
//     An entry without a numeric `t` takes its key's stamp.
//  3. A value of null clears a key (rule 1 applies to it like any value).
//  4. Stamps from the future are pulled back to the server's clock, so one device with a wrong clock
//     cannot win every merge for months.
//  5. (2026-10-24) Types are checked: an entry-map key must be a map of objects (or null), `settings` an object.
//     A whole-key replacement that would remove more than WIPE_LIMIT entries at once is refused unless the
//     PUT says {confirmWipe: true}, so a buggy client can never empty a word list by accident.

// srs (review state per word) and notes (Claude's explanations per word) added 2026-10-23 for the Claude connector:
// both are keyed like words ("es:desde"), so a review on the phone and a note from Claude never overwrite each other.
export const ENTRY_KEYS = ['words', 'srs', 'notes', 'progress', 'library', 'reports'];
export const KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
export const MAX_KEYS = 40;
export const MAX_BYTES = 1_000_000;
export const MAX_ID = 300;          // longest entry id ("es:<a long phrase>")
export const WIPE_LIMIT = 20;       // a whole-key replacement may drop at most this many entries without confirmWipe

export class SyncError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }

export const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = v => typeof v === 'number' && Number.isFinite(v);

// Throws SyncError(400) with a plain sentence for anything that is not a well-formed PUT.
export function validateIncoming(b) {
  if (!plain(b) || !plain(b.doc)) throw new SyncError(400, 'Send {doc: {...}, stamps: {...}}.');
  if (b.stamps !== undefined && !plain(b.stamps)) throw new SyncError(400, 'stamps must be an object of times.');
  if (b.confirmWipe !== undefined && typeof b.confirmWipe !== 'boolean') throw new SyncError(400, 'confirmWipe must be true or false.');
  const keys = Object.keys(b.doc);
  if (keys.length > MAX_KEYS) throw new SyncError(400, `A profile can have up to ${MAX_KEYS} top-level keys.`);
  for (const k of keys) {
    if (!KEY_RE.test(k)) throw new SyncError(400, `"${String(k).slice(0, 40)}" is not a usable key name.`);
    const v = b.doc[k];
    if (v === undefined) throw new SyncError(400, `"${k}" has no value.`);
    if (ENTRY_KEYS.includes(k)) validateMap(k, v);
    else if (k === 'settings' && v !== null && !plain(v)) throw new SyncError(400, 'settings must be an object or null.');
    else if (k === 'last' && v !== null && !plain(v)) throw new SyncError(400, 'last must be an object or null.');
  }
  if (b.stamps) for (const [k, s] of Object.entries(b.stamps))
    if (k in b.doc && s !== null && !num(s)) throw new SyncError(400, `The stamp for "${String(k).slice(0, 40)}" must be a time in ms.`);
}

function validateMap(k, v) {
  if (v === null) return;
  if (!plain(v)) throw new SyncError(400, `"${k}" must be an object keyed by id (or null), not ${Array.isArray(v) ? 'a list' : typeof v}.`);
  for (const [id, e] of Object.entries(v)) {
    const where = `"${k}" › "${id.slice(0, 60)}"`;
    if (!id || id.length > MAX_ID) throw new SyncError(400, `"${k}" has an entry id that is empty or longer than ${MAX_ID} characters.`);
    if (!plain(e)) throw new SyncError(400, `${where} must be an object.`);
    if (e.t !== undefined && !num(e.t)) throw new SyncError(400, `${where}: t must be a time in ms.`);
    if (e.deleted !== undefined && typeof e.deleted !== 'boolean') throw new SyncError(400, `${where}: deleted must be true or false.`);
    if (e.deleted) continue;
    if (k === 'words') {
      if (typeof e.w !== 'string' || !e.w) throw new SyncError(400, `${where}: a word needs w (the word itself).`);
      if (e.lang !== undefined && typeof e.lang !== 'string') throw new SyncError(400, `${where}: lang must be text.`);
    }
    if (k === 'srs') for (const f of ['due', 's', 'd', 'reps', 'lapses', 'st', 'lr'])
      if (e[f] !== undefined && e[f] !== null && !num(e[f])) throw new SyncError(400, `${where}: ${f} must be a number.`);
    if (k === 'notes' && e.items !== undefined && !Array.isArray(e.items)) throw new SyncError(400, `${where}: items must be a list.`);
  }
}

// The stamp a key is written with: a missing or bad stamp means "now", a future one is pulled back to now.
export function keyStamp(s, now) {
  s = Number(s);
  if (!Number.isFinite(s) || s <= 0) return now;
  return Math.min(s, now);
}

// How many entries a value holds, for the wipe guard: live map entries, list items, or object keys.
export function countEntries(v, isMap) {
  if (Array.isArray(v)) return v.length;
  if (!plain(v)) return 0;
  return isMap ? Object.values(v).filter(e => !(plain(e) && e.deleted)).length : Object.keys(v).length;
}

// How many of `before` a whole-key replacement by `after` removes.
export function removedBy(before, after, isMap) {
  const n = countEntries(before, isMap);
  if (!n) return 0;
  if (Array.isArray(before)) return Array.isArray(after) ? Math.max(0, before.length - after.length) : before.length;
  if (plain(before) && plain(after)) return Object.keys(before).filter(k => !(k in after) && !(isMap && plain(before[k]) && before[k].deleted)).length;
  return n;
}

// The decision for one incoming key. `head` is what is stored: {kind:'absent'} | {kind:'map'} | {kind:'value'}.
//   'skip'    : the stored key is newer (or as new): nothing happens
//   'entries' : merge the incoming map entry by entry into the stored map
//   'replace' : replace the whole key (the stored stamp is older)
export function decide(k, v, s, have, head) {
  if (ENTRY_KEYS.includes(k) && plain(v) && head.kind === 'map') return 'entries';
  if (s > have) return ENTRY_KEYS.includes(k) && plain(v) ? 'replace-map' : 'replace';
  return 'skip';
}
