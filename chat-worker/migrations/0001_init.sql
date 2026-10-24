-- lector-chat: first schema (2026-10-23).
-- Shaped for the coming account step: users have a stable id and nullable email / google_sub,
-- and an invite token is just one kind of credential that a later account can be linked to.

CREATE TABLE users (
  id          TEXT PRIMARY KEY,              -- stable, random; never changes when an account is linked
  name        TEXT NOT NULL,
  native      TEXT NOT NULL,                 -- 'en' | 'es'  (language they speak)
  learning    TEXT NOT NULL,                 -- 'es' | 'en'  (language they practise)
  level       TEXT NOT NULL DEFAULT 'elementary',  -- 'beginner' | 'elementary' | 'getting by' | 'intermediate' | 'advanced'
  email       TEXT UNIQUE,                   -- filled by the account step (Google sign-in)
  google_sub  TEXT UNIQUE,                   -- Google's stable subject id, filled by the account step
  created     INTEGER NOT NULL
);

-- Anything that proves "this request is user X". Only SHA-256 hashes are stored.
-- kind: 'invite' (the ?join= token the app keeps as its device key) now; 'session' / 'passkey' later.
CREATE TABLE credentials (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL,
  hash       TEXT NOT NULL UNIQUE,
  label      TEXT,
  created    INTEGER NOT NULL,
  last_used  INTEGER,
  revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX credentials_user ON credentials(user_id);

CREATE TABLE threads (
  id       TEXT PRIMARY KEY,
  title    TEXT,
  langs    TEXT NOT NULL DEFAULT 'es,en',   -- the two languages this thread translates between
  created  INTEGER NOT NULL
);

CREATE TABLE members (
  thread_id  TEXT NOT NULL REFERENCES threads(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  prefs      TEXT NOT NULL DEFAULT '{}',    -- JSON, e.g. {"languageDays": true}
  joined     INTEGER NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);
CREATE INDEX members_user ON members(user_id);

-- seq is a global change counter: every insert, late translation and delete takes the next value,
-- so polling with ?since=<last seq> returns new messages, filled-in translations and deletions alike.
CREATE TABLE messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL REFERENCES threads(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  text       TEXT NOT NULL,                 -- the original, exactly as sent ('' once deleted)
  lang       TEXT,                          -- 'es' | 'en' | 'mixed'
  base       TEXT,                          -- the language most of it is in
  versions   TEXT,                          -- JSON {"es": "...", "en": "..."}: a full rendering in each thread language
  pending    INTEGER NOT NULL DEFAULT 0,    -- 1 = translation not done yet (daily allowance used up or the model failed)
  deleted    INTEGER NOT NULL DEFAULT 0,
  created    INTEGER NOT NULL,
  seq        INTEGER NOT NULL
);
CREATE INDEX messages_thread_seq ON messages(thread_id, seq);
CREATE INDEX messages_pending ON messages(pending) WHERE pending = 1;

CREATE TABLE reports (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  TEXT NOT NULL,
  kind     TEXT NOT NULL,                   -- 'translation' | 'check' | 'helper' | 'other'
  ref      TEXT,                            -- e.g. 'msg:42', or a short client reference
  note     TEXT,
  context  TEXT,                            -- JSON snapshot of what was shown (filled server-side for msg: refs)
  created  INTEGER NOT NULL,
  done     INTEGER NOT NULL DEFAULT 0
);

-- Workers AI neurons spent per UTC day (the free allowance resets at 00:00 UTC).
CREATE TABLE ai_usage (
  day      TEXT PRIMARY KEY,                -- 'YYYY-MM-DD' UTC
  neurons  REAL NOT NULL DEFAULT 0,
  calls    INTEGER NOT NULL DEFAULT 0,
  blocked  INTEGER NOT NULL DEFAULT 0       -- 1 once Cloudflare refused a call for the day
);

-- Per-user daily counters for the AI-backed endpoints (abuse guard, not billing).
CREATE TABLE uses (
  user_id  TEXT NOT NULL,
  kind     TEXT NOT NULL,
  day      TEXT NOT NULL,
  n        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, kind, day)
);

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
INSERT INTO meta (k, v) VALUES ('seq', '0');
