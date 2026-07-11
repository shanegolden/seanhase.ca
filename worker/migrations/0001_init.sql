-- seanhase.ca D1 schema v1
-- Times are stored as UTC ISO-8601 strings; all slot math happens in the clinic
-- timezone (settings.timezone) inside the Worker.

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL -- JSON-encoded
);

CREATE TABLE IF NOT EXISTS availability_windows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0=Sunday
  start_min INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min INTEGER NOT NULL CHECK (end_min > start_min AND end_min <= 1440)
);

CREATE TABLE IF NOT EXISTS blackout_dates (
  date TEXT PRIMARY KEY, -- YYYY-MM-DD in clinic timezone
  reason TEXT
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_start TEXT NOT NULL, -- UTC ISO
  slot_end TEXT NOT NULL,   -- UTC ISO
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
  manage_token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  cancelled_at TEXT,
  cancelled_by TEXT CHECK (cancelled_by IN (NULL,'client','admin'))
);
-- Backstop: only one CONFIRMED booking can occupy a given start.
-- (Primary guard is the conditional-overlap INSERT in code.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_confirmed_start
  ON bookings (slot_start) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS idx_bookings_range ON bookings (status, slot_start, slot_end);

CREATE TABLE IF NOT EXISTS admin_user (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  email TEXT NOT NULL,
  pass_hash TEXT NOT NULL,     -- hex
  salt TEXT NOT NULL,          -- hex
  iterations INTEGER NOT NULL,
  must_change_pw INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, -- sha256 hex of the cookie token
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  last_seen TEXT
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,        -- e.g. 'login:1.2.3.4', 'contact:1.2.3.4'
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS content_drafts (
  key TEXT PRIMARY KEY,        -- 'content'
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS draft_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,      -- target path under site/assets/img/
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,         -- capped at 2MB by the API, purged on publish / after 7 days
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS ical_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  url TEXT,                    -- feed URL the cached payload came from
  fetched_at TEXT,
  ok INTEGER NOT NULL DEFAULT 0,
  payload TEXT,                -- raw ics of last GOOD fetch
  last_error TEXT,
  last_error_at TEXT
);

CREATE TABLE IF NOT EXISTS mail_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  kind TEXT NOT NULL,          -- 'contact','booking','cancel','alert','reset'
  status TEXT NOT NULL,        -- 'sent','failed','stubbed'
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS publish_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  commit_sha TEXT,
  status TEXT NOT NULL DEFAULT 'committing', -- committing|commit_failed|building|live|build_failed
  error TEXT,
  finished_at TEXT
);
