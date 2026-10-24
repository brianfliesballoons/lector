-- 2026-10-23: the Claude connector (build step F). Additive only.
--
-- A personal connector link is a credential like any other: credentials.kind = 'connector', only its SHA-256 stored,
-- one live per person (POST /connector rotates, DELETE /connector revokes). authenticate() never accepts it, so a
-- connector link can reach /mcp/<token> and nothing else; a session or invite can never reach /mcp.
-- (No schema change needed for that: credentials.kind is free text and credentials.hash is already UNIQUE.)

-- "Go deeper" bundles: the app posts the word, its sentence and what it already explained (POST /context) just
-- before it opens Claude, and puts the short ref ("lx-k3m9q2zt") in the ?q= prompt. Claude's get_context reads it
-- back through the connector. Owner-only (user_id), gone after 24 hours.
CREATE TABLE context_refs (
  id          TEXT PRIMARY KEY,              -- 'lx-' + 8 characters
  user_id     TEXT NOT NULL REFERENCES users(id),
  data        TEXT NOT NULL,                 -- JSON: word, lang, gloss, sentence, note, source, question
  thread_id   TEXT,                          -- set only when the person allowed nearby messages for this question
  message_id  INTEGER,
  created     INTEGER NOT NULL,
  expires     INTEGER NOT NULL
);
CREATE INDEX context_refs_expires ON context_refs(expires);
CREATE INDEX context_refs_user ON context_refs(user_id);
