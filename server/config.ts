import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

export interface EnvConfig {
  port: number;
  nodeEnv: string;
  hardDiskPath: string;
  cloudRemote: string;
  rcloneConfigPath: string;
  databaseUrl: string;
  secretKey: string;
  maxUploadSize: number;
  defaultUserQuota: number;
  uploadChunkSize: number;
  syncConcurrency: number;
  syncRetryLimit: number;
  syncRetryBackoff: number;
  adminUsername: string;
  adminPassword: string;
  trustProxy: boolean;
  rcloneBin: string;
  sessionTtlHours: number;
}

export interface RuntimeSettings {
  maxUploadSize: number;
  defaultUserQuota: number;
  uploadChunkSize: number;
  syncConcurrency: number;
  syncRetryLimit: number;
  syncRetryBackoff: number;
}

export interface SafeRemoteSummary {
  remoteName: string;
  basePath: string;
  remoteType: string;
  configPathExists: boolean;
}

function parseIntEnv(key: string, fallback: number, min = 1): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < min) return fallback;
  return parsed;
}

export function resolveDatabasePath(databaseUrl: string): string {
  if (databaseUrl === ':memory:') return ':memory:';
  let cleaned = databaseUrl.trim();
  if (cleaned.startsWith('sqlite:///')) {
    cleaned = cleaned.slice('sqlite://'.length);
  } else if (cleaned.startsWith('sqlite://')) {
    cleaned = cleaned.slice('sqlite://'.length);
  } else if (cleaned.startsWith('file:')) {
    cleaned = cleaned.slice('file:'.length);
  }
  return path.resolve(cleaned);
}

/**
 * Loads configuration from environment variables with sensible defaults.
 * Calling this dynamically allows tests and deployments to override
 * HARD_DISK_PATH, CLOUD_REMOTE, RCLONE_CONFIG_PATH, etc. without code changes.
 */
export function loadEnvConfig(overrides?: Partial<EnvConfig>): EnvConfig {
  const hardDiskPath = path.resolve(
    overrides?.hardDiskPath ?? process.env.HARD_DISK_PATH ?? './data/staging'
  );
  const rcloneConfigPath = path.resolve(
    overrides?.rcloneConfigPath ?? process.env.RCLONE_CONFIG_PATH ?? './data/rclone/rclone.conf'
  );
  const defaultCloudDir = path.resolve('./data/cloud');
  const cloudRemote =
    overrides?.cloudRemote ?? process.env.CLOUD_REMOTE ?? `localcloud:${defaultCloudDir}`;
  const databaseUrl =
    overrides?.databaseUrl ?? process.env.DATABASE_URL ?? './data/db/nas.sqlite';

  const secretKey =
    overrides?.secretKey ??
    process.env.SECRET_KEY ??
    crypto.createHash('sha256').update(`vaultstage-dev-${hardDiskPath}`).digest('hex');

  return {
    port: overrides?.port ?? parseIntEnv('PORT', 3000, 1),
    nodeEnv: overrides?.nodeEnv ?? process.env.NODE_ENV ?? 'development',
    hardDiskPath,
    cloudRemote,
    rcloneConfigPath,
    databaseUrl,
    secretKey,
    maxUploadSize: overrides?.maxUploadSize ?? parseIntEnv('MAX_UPLOAD_SIZE', 1024 * 1024 * 1024, 1024),
    defaultUserQuota:
      overrides?.defaultUserQuota ?? parseIntEnv('DEFAULT_USER_QUOTA', 5 * 1024 * 1024 * 1024, 1024),
    uploadChunkSize:
      overrides?.uploadChunkSize ?? parseIntEnv('UPLOAD_CHUNK_SIZE', 4 * 1024 * 1024, 64 * 1024),
    syncConcurrency: overrides?.syncConcurrency ?? parseIntEnv('SYNC_CONCURRENCY', 2, 1),
    syncRetryLimit: overrides?.syncRetryLimit ?? parseIntEnv('SYNC_RETRY_LIMIT', 3, 1),
    syncRetryBackoff: overrides?.syncRetryBackoff ?? parseIntEnv('SYNC_RETRY_BACKOFF', 5000, 10),
    adminUsername: overrides?.adminUsername ?? process.env.ADMIN_USERNAME ?? 'admin',
    adminPassword: overrides?.adminPassword ?? process.env.ADMIN_PASSWORD ?? 'changeme-admin-123',
    trustProxy:
      overrides?.trustProxy ??
      (process.env.TRUST_PROXY !== undefined ? process.env.TRUST_PROXY === 'true' : true),
    rcloneBin: overrides?.rcloneBin ?? process.env.RCLONE_BIN ?? 'rclone',
    sessionTtlHours: overrides?.sessionTtlHours ?? parseIntEnv('SESSION_TTL_HOURS', 24, 1),
  };
}

/**
 * Splits CLOUD_REMOTE like "gdrive:nas-storage/prod" into { remoteName: "gdrive", basePath: "nas-storage/prod" }.
 */
export function parseCloudRemoteSpec(cloudRemote: string): { remoteName: string; basePath: string } {
  const colonIdx = cloudRemote.indexOf(':');
  if (colonIdx === -1) {
    return { remoteName: 'local', basePath: cloudRemote };
  }
  const remoteName = cloudRemote.slice(0, colonIdx).trim();
  const basePath = cloudRemote.slice(colonIdx + 1).trim();
  return { remoteName, basePath };
}

/**
 * Safely parses rclone.conf to extract ONLY section names and `type = ...`.
 * NEVER returns tokens, secrets, passwords, client_secret, or access keys.
 */
export function inspectRcloneConfigSafe(
  rcloneConfigPath: string,
  cloudRemote: string
): SafeRemoteSummary {
  const { remoteName, basePath } = parseCloudRemoteSpec(cloudRemote);
  if (!fs.existsSync(rcloneConfigPath)) {
    return {
      remoteName,
      basePath,
      remoteType: 'unconfigured',
      configPathExists: false,
    };
  }

  try {
    const content = fs.readFileSync(rcloneConfigPath, 'utf8');
    const lines = content.split(/\r?\n/);
    let currentSection = '';
    let detectedType = 'unknown';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
      if (sectionMatch) {
        currentSection = sectionMatch[1].trim();
        continue;
      }
      if (currentSection === remoteName) {
        const kvMatch = /^type\s*=\s*(.+)$/i.exec(line);
        if (kvMatch) {
          detectedType = kvMatch[1].trim();
          break;
        }
      }
    }

    return {
      remoteName,
      basePath,
      remoteType: detectedType,
      configPathExists: true,
    };
  } catch {
    return {
      remoteName,
      basePath,
      remoteType: 'unreadable',
      configPathExists: true,
    };
  }
}

/**
 * Ensures a default local rclone.conf exists ONLY when the default `localcloud:`
 * remote is used and no config file exists yet, so out-of-the-box local staging
 * + cloud sync works immediately without manual setup.
 */
export function ensureDefaultLocalRcloneConfig(config: EnvConfig): void {
  const { remoteName, basePath } = parseCloudRemoteSpec(config.cloudRemote);
  if (remoteName === 'localcloud' && !fs.existsSync(config.rcloneConfigPath)) {
    fs.mkdirSync(path.dirname(config.rcloneConfigPath), { recursive: true });
    fs.writeFileSync(
      config.rcloneConfigPath,
      `# Auto-generated local rclone backend for VaultStage NAS\n[localcloud]\ntype = local\n`,
      { mode: 0o600 }
    );
    if (basePath) {
      fs.mkdirSync(path.resolve(basePath), { recursive: true });
    }
  }
}

const RUNTIME_SETTING_KEYS: Record<keyof RuntimeSettings, string> = {
  maxUploadSize: 'max_upload_size',
  defaultUserQuota: 'default_user_quota',
  uploadChunkSize: 'upload_chunk_size',
  syncConcurrency: 'sync_concurrency',
  syncRetryLimit: 'sync_retry_limit',
  syncRetryBackoff: 'sync_retry_backoff',
};

export function getRuntimeSettings(db: Database.Database, env: EnvConfig): RuntimeSettings {
  const rows = db
    .prepare('SELECT key, value FROM app_settings')
    .all() as Array<{ key: string; value: string }>;
  const map = new Map(rows.map((r) => [r.key, r.value]));

  const readNum = (key: string, fallback: number, min = 1): number => {
    const raw = map.get(key);
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) || parsed < min ? fallback : parsed;
  };

  return {
    maxUploadSize: readNum(RUNTIME_SETTING_KEYS.maxUploadSize, env.maxUploadSize, 1024),
    defaultUserQuota: readNum(RUNTIME_SETTING_KEYS.defaultUserQuota, env.defaultUserQuota, 1024),
    uploadChunkSize: readNum(RUNTIME_SETTING_KEYS.uploadChunkSize, env.uploadChunkSize, 64 * 1024),
    syncConcurrency: readNum(RUNTIME_SETTING_KEYS.syncConcurrency, env.syncConcurrency, 1),
    syncRetryLimit: readNum(RUNTIME_SETTING_KEYS.syncRetryLimit, env.syncRetryLimit, 1),
    syncRetryBackoff: readNum(RUNTIME_SETTING_KEYS.syncRetryBackoff, env.syncRetryBackoff, 10),
  };
}

export function updateRuntimeSettings(
  db: Database.Database,
  env: EnvConfig,
  partial: Partial<RuntimeSettings>
): RuntimeSettings {
  const upsert = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `);

  const tx = db.transaction(() => {
    if (partial.maxUploadSize !== undefined) {
      const val = Math.max(1024, Math.floor(partial.maxUploadSize));
      upsert.run(RUNTIME_SETTING_KEYS.maxUploadSize, String(val));
    }
    if (partial.defaultUserQuota !== undefined) {
      const val = Math.max(1024, Math.floor(partial.defaultUserQuota));
      upsert.run(RUNTIME_SETTING_KEYS.defaultUserQuota, String(val));
    }
    if (partial.uploadChunkSize !== undefined) {
      const val = Math.max(64 * 1024, Math.min(64 * 1024 * 1024, Math.floor(partial.uploadChunkSize)));
      upsert.run(RUNTIME_SETTING_KEYS.uploadChunkSize, String(val));
    }
    if (partial.syncConcurrency !== undefined) {
      const val = Math.max(1, Math.min(16, Math.floor(partial.syncConcurrency)));
      upsert.run(RUNTIME_SETTING_KEYS.syncConcurrency, String(val));
    }
    if (partial.syncRetryLimit !== undefined) {
      const val = Math.max(1, Math.min(20, Math.floor(partial.syncRetryLimit)));
      upsert.run(RUNTIME_SETTING_KEYS.syncRetryLimit, String(val));
    }
    if (partial.syncRetryBackoff !== undefined) {
      const val = Math.max(100, Math.min(300000, Math.floor(partial.syncRetryBackoff)));
      upsert.run(RUNTIME_SETTING_KEYS.syncRetryBackoff, String(val));
    }
  });
  tx();

  return getRuntimeSettings(db, env);
}
