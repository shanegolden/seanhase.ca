-- Multi-user admin: replaces the single-row admin_user table with admin_users.
-- Preserves the existing live account (email + password hash) and keeps live
-- sessions valid by backfilling user_id. Safe on a fresh DB too (the SELECT
-- simply copies zero rows and bootstrap creates the first user).

CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  must_change_pw INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  reset_token_hash TEXT,
  reset_token_expires TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- NOT EXISTS guard makes a re-run after a partial failure skip the copy instead
-- of tripping the UNIQUE index (recovery: statements after the failure point can
-- then run individually; a D1 Time Travel bookmark is taken before remote apply).
INSERT INTO admin_users (email, pass_hash, salt, iterations, must_change_pw)
  SELECT email, pass_hash, salt, iterations, must_change_pw FROM admin_user
  WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM admin_users);

ALTER TABLE sessions ADD COLUMN user_id INTEGER;

UPDATE sessions SET user_id = (SELECT MIN(id) FROM admin_users);

DROP TABLE admin_user;
