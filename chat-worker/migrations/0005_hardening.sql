-- 2026-10-24: hardening after the independent review (S1 translation loop, S3-8 sync types, S3-9 fair AI use,
-- S3-10 invite expiry, S3-12 CPU). Additive, plus a one-time copy of any stored profile into the new layout.

-- ---------- S1: a translation that keeps failing stops after a few tries ----------
-- tries    = model attempts that failed (a used-up allowance does not count: nothing was tried)
-- next_try = ms time before which no poll retries it (backoff)
-- failed   = set once it has failed for good: a short reason; pending is 0 then, and POST /messages/:id/retranslate clears it
ALTER TABLE messages ADD COLUMN tries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN next_try INTEGER;
ALTER TABLE messages ADD COLUMN failed TEXT;

-- ---------- S3-9: each person's share of the day's AI allowance ----------
-- neurons = everything charged to this person (translation of their own messages + their checks + their helpers)
-- extra   = the check + helpers part of it
CREATE TABLE ai_person (
  day      TEXT NOT NULL,                  -- 'YYYY-MM-DD' UTC
  user_id  TEXT NOT NULL,
  neurons  REAL NOT NULL DEFAULT 0,
  extra    REAL NOT NULL DEFAULT 0,
  calls    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id)
);

-- ---------- S3-10: invites expire ----------
-- New invites get expires = minted + 14 days (POST /admin/invites). The two invites minted 2026-10-23 had none:
-- they get 2026-11-08 12:00 UTC (at least 14 days from this migration). An invite already used to make a session
-- was retired (revoked) then, as before.
UPDATE credentials SET expires = 1794139200000 WHERE kind = 'invite' AND revoked = 0 AND expires IS NULL;

-- ---------- S3-12: the profile split into rows, so a call reads only what it needs ----------
-- One row per top-level key (id = '') and one per entry of an entry map (id = the entry id).
-- On the key's own row, v is the key's JSON, or NULL when the key is a map whose entries are the other rows.
-- t = the time the entry merge compares (the entry's own t, or its key's stamp when it had none).
CREATE TABLE profile_items (
  user_id  TEXT NOT NULL,
  k        TEXT NOT NULL,
  id       TEXT NOT NULL,
  v        TEXT,
  t        REAL,
  PRIMARY KEY (user_id, k, id)
);

-- dirty = something in profile_items changed during the current write (set by the triggers, cleared by the version bump)
ALTER TABLE profiles ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0;

-- profiles.bytes stays exact (about the size of the profile as JSON) without the Worker ever reading the whole profile
CREATE TRIGGER profile_items_ins AFTER INSERT ON profile_items BEGIN
  UPDATE profiles SET bytes = bytes + length(CAST(NEW.k AS BLOB)) + length(CAST(NEW.id AS BLOB)) + COALESCE(length(CAST(NEW.v AS BLOB)), 2) + 6, dirty = 1 WHERE user_id = NEW.user_id;
END;
CREATE TRIGGER profile_items_upd AFTER UPDATE ON profile_items BEGIN
  UPDATE profiles SET bytes = bytes - COALESCE(length(CAST(OLD.v AS BLOB)), 2) + COALESCE(length(CAST(NEW.v AS BLOB)), 2), dirty = 1 WHERE user_id = NEW.user_id;
END;
CREATE TRIGGER profile_items_del AFTER DELETE ON profile_items BEGIN
  UPDATE profiles SET bytes = bytes - length(CAST(OLD.k AS BLOB)) - length(CAST(OLD.id AS BLOB)) - COALESCE(length(CAST(OLD.v AS BLOB)), 2) - 6, dirty = 1 WHERE user_id = OLD.user_id;
END;
-- the 1 MB cap: a write that would pass it is rolled back whole (the Worker answers 413)
CREATE TRIGGER profiles_cap BEFORE UPDATE OF version ON profiles WHEN NEW.bytes > 1000000 BEGIN
  SELECT RAISE(ABORT, 'profile too large');
END;

-- copy any profile stored the old way (one JSON document) into rows
UPDATE profiles SET bytes = 0;
INSERT INTO profile_items(user_id, k, id, v, t)
  SELECT p.user_id, d.key, '',
    CASE WHEN d.key IN ('words', 'srs', 'notes', 'progress', 'library', 'reports') AND d.type = 'object' THEN NULL
         WHEN d.type IN ('object', 'array') THEN d.value
         WHEN d.type = 'true' THEN 'true' WHEN d.type = 'false' THEN 'false' WHEN d.type = 'null' THEN 'null'
         WHEN d.type = 'text' THEN json_quote(d.value)
         ELSE CAST(d.value AS TEXT) END,
    NULL
  FROM profiles p, json_each(p.doc) d;
INSERT INTO profile_items(user_id, k, id, v, t)
  SELECT p.user_id, d.key, e.key,
    CASE WHEN e.type IN ('object', 'array') THEN e.value
         WHEN e.type = 'true' THEN 'true' WHEN e.type = 'false' THEN 'false' WHEN e.type = 'null' THEN 'null'
         WHEN e.type = 'text' THEN json_quote(e.value)
         ELSE CAST(e.value AS TEXT) END,
    COALESCE(CASE WHEN e.type = 'object' THEN json_extract(e.value, '$.t') END, json_extract(p.stamps, '$."' || d.key || '"'), 0)
  FROM profiles p, json_each(p.doc) d, json_each(d.value) e
  WHERE d.key IN ('words', 'srs', 'notes', 'progress', 'library', 'reports') AND d.type = 'object' AND e.key != '';
UPDATE profiles SET doc = '{}', dirty = 0;
