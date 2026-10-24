-- 2026-10-23: a translation claim, so a message is never translated twice when the sender's request
-- and the other person's poll (or two polls) reach the same pending message at once.
-- claimed = ms time a request took the job; a claim older than 60 s is treated as abandoned.
ALTER TABLE messages ADD COLUMN claimed INTEGER;
