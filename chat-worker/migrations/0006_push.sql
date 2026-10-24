-- 2026-10-24: web push notifications for new messages. Additive only.
-- No foreign keys on purpose: a test or an admin deleting a person must never be blocked by a push row
-- (the rows for a person who is gone simply stop being used, and a dead endpoint is deleted on its first 404/410).

-- One row per browser that asked to be told about new messages (a phone, a laptop).
-- endpoint  the push service URL the browser gave (FCM for Chrome/Android, Apple's for iPhone). UNIQUE: subscribing
--           again from the same browser updates the row; a browser that changes person moves to the new person.
-- p256dh, auth  the browser's encryption key and secret (base64url); every push is encrypted for this browser alone.
-- lang      that browser's app language when it subscribed ('en' | 'es'): the words used when the preview is off.
-- cred_id   the credential (session or invite) the browser was signed in with when it subscribed. A push goes out only
--           while that credential is live, so a phone signed out from another device stops getting messages at once.
-- last_ok   ms time of the last push the service accepted; fail_count = failures in a row (deleted after 5).
CREATE TABLE push_subs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  lang        TEXT NOT NULL DEFAULT 'en',
  cred_id     TEXT,
  created     INTEGER NOT NULL,
  last_ok     INTEGER,
  fail_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subs_user ON push_subs(user_id);

-- Per person (all their devices). notify = 0 stops every push to them; preview = 0 leaves the message text out of
-- the notification ("New message" only). Both default to on; no row = both on.
CREATE TABLE push_prefs (
  user_id  TEXT PRIMARY KEY,
  notify   INTEGER NOT NULL DEFAULT 1,
  preview  INTEGER NOT NULL DEFAULT 1,
  updated  INTEGER NOT NULL
);

-- The throttle: at most one push per person per conversation per 20 s. Messages inside the window are held
-- (held = how many) and go out together once the window ends, as one updated notification ("3 new messages").
-- flush_at = when the held ones go; last_msg = the newest message id, used for that notification's text.
CREATE TABLE push_state (
  user_id    TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  last_sent  INTEGER NOT NULL DEFAULT 0,
  held       INTEGER NOT NULL DEFAULT 0,
  flush_at   INTEGER,
  last_msg   INTEGER,
  PRIMARY KEY (user_id, thread_id)
);
