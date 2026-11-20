import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EnvConfig, resolveDatabasePath } from './config.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: 'admin' | 'user';
  is_active: number;
  must_change_password: number;
  quota_bytes: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export type FileStatus =
  | 'RECEIVING'
  | 'STAGED'
  | 'QUEUED'
  | 'UPLOADING'
  | 'VERIFYING'
  | 'SYNCED'
  | 'FAILED';

export interface FileRow {
  id: string;
  user_id: string;
  relative_path: string;
  folder_path: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string | null;
  md5: string | null;
  sha1: string | null;
  status: FileStatus;
  local_present: number;
  cloud_present: number;
  local_mtime_ms: number | null;
  cloud_path: string | null;
  verification_method: string | null;
  verified_at: string | null;
  last_error: string | null;
  generation: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyncJobRow {
  id: string;
  file_id: string;
  user_id: string;
  generation: number;
  source_relative_path: string;
  cloud_relative_path: string;
  status: 'QUEUED' | 'UPLOADING' | 'VERIFYING' | 'SYNCED' | 'FAILED' | 'CANCELLED';
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  last_error: string | null;
  verification_method: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export function generateId(prefix = ''): string {
  const raw = crypto.randomBytes(12).toString('hex');
  return prefix ? `${prefix}_${raw}` : raw;
}

/**
 * Opens SQLite database, enables WAL + foreign keys, runs ordered SQL migrations,
 * and bootstraps the initial admin user if no admin exists yet.
 */
export function initDatabase(config: EnvConfig): Database.Database {
  const dbPath = resolveDatabasePath(config.databaseUrl);
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  runMigrations(db);
  bootstrapAdmin(db, config);

  return db;
}

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found at ${migrationsDir}`);
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const appliedRows = db
    .prepare('SELECT version FROM schema_migrations')
    .all() as Array<{ version: string }>;
  const applied = new Set(appliedRows.map((r) => r.version));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const applyMigration = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(file);
    });
    applyMigration();
  }
}

function bootstrapAdmin(db: Database.Database, config: EnvConfig): void {
  const existingAdmin = db
    .prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`)
    .get() as { id: string } | undefined;

  if (existingAdmin) return;

  const adminId = generateId('usr');
  const passwordHash = bcrypt.hashSync(config.adminPassword, 12);

  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, role, is_active, must_change_password, quota_bytes)
     VALUES (?, ?, ?, ?, 'admin', 1, 1, ?)`
  ).run(
    adminId,
    config.adminUsername,
    'System Administrator',
    passwordHash,
    config.defaultUserQuota * 2
  );

  logActivity(db, {
    userId: adminId,
    actorUsername: config.adminUsername,
    action: 'system.bootstrap_admin',
    targetType: 'user',
    targetId: adminId,
    details: 'Initial administrator account created (password change required on first login)',
    level: 'info',
  });
}

export function logActivity(
  db: Database.Database,
  entry: {
    userId?: string | null;
    actorUsername?: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    details?: string;
    level?: 'info' | 'warn' | 'error';
  }
): void {
  try {
    db.prepare(
      `INSERT INTO activity_logs (user_id, actor_username, action, target_type, target_id, details, level)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.userId ?? null,
      entry.actorUsername ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.details ?? null,
      entry.level ?? 'info'
    );
  } catch {
    // Audit log write failures should not crash critical file paths
  }
}

export function getUserUsage(
  db: Database.Database,
  userId: string
): { totalBytes: number; stagedBytes: number; cloudBytes: number; fileCount: number } {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(size_bytes), 0) AS total_bytes,
         COALESCE(SUM(CASE WHEN local_present = 1 THEN size_bytes ELSE 0 END), 0) AS staged_bytes,
         COALESCE(SUM(CASE WHEN cloud_present = 1 THEN size_bytes ELSE 0 END), 0) AS cloud_bytes,
         COUNT(*) AS file_count
       FROM files
       WHERE user_id = ? AND deleted_at IS NULL AND status != 'RECEIVING'`
    )
    .get(userId) as {
    total_bytes: number;
    staged_bytes: number;
    cloud_bytes: number;
    file_count: number;
  };

  return {
    totalBytes: row.total_bytes,
    stagedBytes: row.staged_bytes,
    cloudBytes: row.cloud_bytes,
    fileCount: row.file_count,
  };
}
