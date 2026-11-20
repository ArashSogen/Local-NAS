-- VaultStage NAS initial database schema (SQLite)
-- Migration 001: Core tables for multi-user isolation, chunked uploads,
-- explicit sync state machine, activity audit logs, and runtime settings.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')) DEFAULT 'user',
  is_active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  quota_bytes INTEGER NOT NULL DEFAULT 5368709120,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_address TEXT,
  user_agent TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path TEXT NOT NULL, -- Normalized relative path e.g. 'Documents/2026' (no leading/trailing slash)
  parent_path TEXT NOT NULL DEFAULT '', -- '' for root
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, path)
);

CREATE INDEX IF NOT EXISTS idx_folders_user_parent ON folders(user_id, parent_path);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL, -- e.g. 'Documents/report.pdf' or 'photo.jpg'
  folder_path TEXT NOT NULL DEFAULT '', -- '' for root, else 'Documents'
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  md5 TEXT,
  sha1 TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('RECEIVING', 'STAGED', 'QUEUED', 'UPLOADING', 'VERIFYING', 'SYNCED', 'FAILED')
  ) DEFAULT 'RECEIVING',
  local_present INTEGER NOT NULL DEFAULT 0,
  cloud_present INTEGER NOT NULL DEFAULT 0,
  local_mtime_ms INTEGER,
  cloud_path TEXT, -- Relative path inside <CLOUD_REMOTE> e.g. '<user_id>/<relative_path>'
  verification_method TEXT, -- 'sha256' | 'md5' | 'sha1' | 'size_mtime'
  verified_at TEXT,
  last_error TEXT,
  generation INTEGER NOT NULL DEFAULT 1, -- Monotonic version to prevent stale sync race conditions
  deleted_at TEXT, -- Non-null if user deleted while sync was in progress
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_files_user_active_path
  ON files(user_id, relative_path)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_files_user_folder ON files(user_id, folder_path) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  relative_path TEXT NOT NULL,
  folder_path TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  expected_size INTEGER NOT NULL,
  received_bytes INTEGER NOT NULL DEFAULT 0,
  temp_file_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'COMPLETED', 'ABORTED', 'EXPIRED')) DEFAULT 'ACTIVE',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_user ON upload_sessions(user_id, status);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  source_relative_path TEXT NOT NULL,
  cloud_relative_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('QUEUED', 'UPLOADING', 'VERIFYING', 'SYNCED', 'FAILED', 'CANCELLED')
  ) DEFAULT 'QUEUED',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error TEXT,
  verification_method TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_status_next ON sync_jobs(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_file ON sync_jobs(file_id);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_user ON sync_jobs(user_id);

CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_username TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details TEXT,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')) DEFAULT 'info',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
