CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY NOT NULL,
  display_name text NOT NULL,
  login_id text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('super_admin', 'manager', 'response', 'observer', 'reporter')),
  region_id TEXT,
  is_active boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY NOT NULL,
  name text NOT NULL,
  code text NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY NOT NULL,
  crn text NOT NULL UNIQUE,
  incident_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('1', '2', '3')),
  status text NOT NULL DEFAULT 'new',
  reporter_name text NOT NULL,
  reporter_phone text,
  customer_address text,
  subscription_number text,
  region_id TEXT REFERENCES regions(id) ON DELETE SET NULL,
  created_by TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  assignee_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  latitude double precision,
  longitude double precision,
  started_at TEXT,
  completed_at TEXT,
  ops_card TEXT NOT NULL DEFAULT '{}',
  extra_data TEXT NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS reports_created_at_idx ON reports (created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS reports_status_created_idx ON reports (status, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS reports_severity_created_idx ON reports (severity, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS reports_region_created_idx ON reports (region_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS reports_assignee_created_idx ON reports (assignee_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS report_events (
  id TEXT PRIMARY KEY NOT NULL,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  note text NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS report_events_report_time_idx ON report_events (report_id, occurred_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY NOT NULL,
  report_id TEXT REFERENCES reports(id) ON DELETE SET NULL,
  message text NOT NULL,
  created_by TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  dismissed_at TEXT
);

CREATE INDEX IF NOT EXISTS alerts_created_at_idx ON alerts (created_at DESC) WHERE dismissed_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_created_idx ON audit_log (actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT REFERENCES app_users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash BLOB PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS login_attempts (
  identity_hash BLOB NOT NULL,
  ip_hash BLOB NOT NULL,
  window_started_at TEXT NOT NULL,
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  locked_until TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (identity_hash, ip_hash)
);

