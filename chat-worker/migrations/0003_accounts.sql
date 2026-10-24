-- 2026-10-23: accounts (build step G). Passkeys, Google sign-in, sessions, profile sync, rate limits.
-- Additive only: the code from before this migration keeps working against it unchanged.

-- Sessions are credentials too (kind = 'session'), so authenticate() stays one query.
-- expires: ms epoch; sessions slide to now + 60 days as they are used. NULL = never (invites).
-- via: how a session was made ('passkey' | 'google' | 'signup-passkey' | 'signup-google' | 'upgrade').
ALTER TABLE credentials ADD COLUMN expires INTEGER;
ALTER TABLE credentials ADD COLUMN via TEXT;
CREATE INDEX credentials_user_kind ON credentials(user_id, kind);

-- WebAuthn passkeys. A passkey belongs to ONE relying party (rp_id): one made on lector-preview.pages.dev
-- cannot sign in on brianfliesballoons.github.io, and the reverse. The browser enforces it; so does the lookup.
CREATE TABLE passkeys (
  id           TEXT PRIMARY KEY,               -- WebAuthn credential id, base64url
  user_id      TEXT NOT NULL REFERENCES users(id),
  rp_id        TEXT NOT NULL,                  -- 'brianfliesballoons.github.io' | 'lector-preview.pages.dev' | 'localhost'
  public_key   TEXT NOT NULL,                  -- COSE public key, base64url
  counter      INTEGER NOT NULL DEFAULT 0,
  transports   TEXT,                           -- JSON array, e.g. ["internal","hybrid"]
  device_type  TEXT,                           -- 'singleDevice' | 'multiDevice' (synced passkey)
  backed_up    INTEGER NOT NULL DEFAULT 0,
  label        TEXT,                           -- e.g. 'iPhone'
  created      INTEGER NOT NULL,
  last_used    INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);

-- One-time challenges for passkeys and one-time nonces for Google sign-in. Five-minute life,
-- consumed (deleted) on first use whether or not the check passes. Never KV: KV allows 1,000 writes a day.
CREATE TABLE challenges (
  id         TEXT PRIMARY KEY,                 -- the handle the client sends back
  kind       TEXT NOT NULL,                    -- 'reg' | 'auth' | 'google'
  challenge  TEXT NOT NULL,                    -- base64url challenge, or the Google nonce
  rp_id      TEXT,
  origin     TEXT,
  user_id    TEXT,                             -- 'reg' adding to a signed-in person; NULL = a new account
  data       TEXT,                             -- JSON: new-account name, how the caller was signed in
  expires    INTEGER NOT NULL
);
CREATE INDEX challenges_expires ON challenges(expires);
CREATE INDEX challenges_nonce ON challenges(kind, challenge);

-- Fixed-window counters for the auth endpoints. k = bucket | sha256(ip) | window start. No raw IPs stored.
CREATE TABLE rate (
  k        TEXT PRIMARY KEY,
  n        INTEGER NOT NULL DEFAULT 0,
  expires  INTEGER NOT NULL
);
CREATE INDEX rate_expires ON rate(expires);

-- The synced profile: one JSON document per person, merged per top-level key (see CLAUDE.md, "Profile sync").
CREATE TABLE profiles (
  user_id  TEXT PRIMARY KEY REFERENCES users(id),
  doc      TEXT NOT NULL DEFAULT '{}',
  stamps   TEXT NOT NULL DEFAULT '{}',          -- JSON {key: ms} — when each top-level key last changed
  version  INTEGER NOT NULL DEFAULT 0,          -- bumps on every write; guards read-merge-write races
  bytes    INTEGER NOT NULL DEFAULT 0,
  updated  INTEGER NOT NULL
);
