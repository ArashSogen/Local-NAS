import cookieParser from 'cookie-parser';
import type Database from 'better-sqlite3';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  clearAuthCookies,
  createAuthMiddleware,
  createSession,
  destroyAllUserSessions,
  destroySession,
  hashPassword,
  LoginRateLimiter,
  type RequestWithAuth,
  setAuthCookies,
  verifyPassword,
} from './auth.ts';
import {
  type CloudDriver,
  computeAllFileHashes,
  createCloudDriver,
} from './cloudDriver.ts';
import {
  ensureDefaultLocalRcloneConfig,
  type EnvConfig,
  getRuntimeSettings,
  inspectRcloneConfigSafe,
  updateRuntimeSettings,
} from './config.ts';
import {
  type FileRow,
  generateId,
  getUserUsage,
  initDatabase,
  logActivity,
  type UserRow,
} from './db.ts';
import {
  buildUserCloudPath,
  getUserStagingRoot,
  joinRelativePath,
  normalizeRelativePath,
  PathSecurityError,
  resolveUserStagingPath,
  sanitizeSegment,
  splitRelativePath,
} from './pathSecurity.ts';
import { SyncEngine } from './syncEngine.ts';

export interface NasApplicationContext {
  app: Express;
  db: Database.Database;
  config: EnvConfig;
  cloudDriver: CloudDriver;
  syncEngine: SyncEngine;
  close: () => void;
}

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function guessMimeType(filename: string, provided?: string): string {
  if (provided && provided !== 'application/octet-stream' && provided.length < 120) {
    return provided;
  }
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.ts': 'text/typescript; charset=utf-8',
    '.yml': 'text/yaml; charset=utf-8',
    '.yaml': 'text/yaml; charset=utf-8',
    '.log': 'text/plain; charset=utf-8',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
    '.tar': 'application/x-tar',
  };
  return map[ext] || 'application/octet-stream';
}

function measureDirBytes(dirPath: string): { totalBytes: number; fileCount: number } {
  if (!fs.existsSync(dirPath)) return { totalBytes: 0, fileCount: 0 };
  let totalBytes = 0;
  let fileCount = 0;
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          totalBytes += fs.statSync(full).size;
          fileCount++;
        } catch {
          // ignore transient unlink
        }
      }
    }
  }
  return { totalBytes, fileCount };
}

function ensureFolderAncestors(
  db: Database.Database,
  userId: string,
  folderPath: string
): void {
  if (!folderPath) return;
  const parts = folderPath.split('/');
  let acc = '';
  for (const part of parts) {
    const parent = acc;
    acc = acc ? `${acc}/${part}` : part;
    db.prepare(
      `INSERT OR IGNORE INTO folders (id, user_id, path, parent_path, name)
       VALUES (?, ?, ?, ?, ?)`
    ).run(generateId('fld'), userId, acc, parent, part);
  }
}

export function createNasApp(
  config: EnvConfig,
  options?: { cloudDriver?: CloudDriver; startWorker?: boolean; pollIntervalMs?: number }
): NasApplicationContext {
  fs.mkdirSync(config.hardDiskPath, { recursive: true });
  fs.mkdirSync(path.join(config.hardDiskPath, '.tmp'), { recursive: true });
  ensureDefaultLocalRcloneConfig(config);

  const db = initDatabase(config);
  const cloudDriver = options?.cloudDriver ?? createCloudDriver(config);
  const syncEngine = new SyncEngine(db, config, cloudDriver);
  const { requireAuth, requireAdmin } = createAuthMiddleware(db, config);
  const loginLimiter = new LoginRateLimiter(12, 15 * 60 * 1000);

  const app = express();
  if (config.trustProxy) {
    app.set('trust proxy', 1);
  }

  // Baseline security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '0');
    next();
  });

  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));

  // =========================================================================
  // Health Check (Docker Compose healthcheck)
  // =========================================================================
  app.get('/api/health', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'unhealthy' });
    }
  });

  // =========================================================================
  // Authentication Routes
  // =========================================================================
  app.post('/api/auth/login', (req: Request, res: Response) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    const ip = getClientIp(req);
    const rate = loginLimiter.check(ip, username);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSec));
      res.status(429).json({
        error: `Too many failed login attempts. Try again in ${rate.retryAfterSec} seconds.`,
      });
      return;
    }

    const user = db
      .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
      .get(username) as UserRow | undefined;

    if (!user || !verifyPassword(password, user.password_hash)) {
      loginLimiter.recordFailure(ip, username);
      logActivity(db, {
        actorUsername: username,
        action: 'auth.login_failed',
        details: `Failed login attempt from ${ip}`,
        level: 'warn',
      });
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    if (!user.is_active) {
      res.status(403).json({ error: 'Account is disabled. Contact your administrator.' });
      return;
    }

    loginLimiter.recordSuccess(ip, username);

    const session = createSession(db, config, user.id, {
      ip,
      userAgent: req.headers['user-agent'],
    });

    db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(user.id);
    setAuthCookies(req, res, session.token, session.csrfToken, config.sessionTtlHours);

    logActivity(db, {
      userId: user.id,
      actorUsername: user.username,
      action: 'auth.login',
      details: `Signed in from ${ip}`,
      level: 'info',
    });

    const usage = getUserUsage(db, user.id);
    const runtime = getRuntimeSettings(db, config);

    res.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        mustChangePassword: Boolean(user.must_change_password),
        quotaBytes: user.quota_bytes,
      },
      usage,
      csrfToken: session.csrfToken,
      token: session.token,
      runtime: {
        maxUploadSize: runtime.maxUploadSize,
        uploadChunkSize: runtime.uploadChunkSize,
      },
    });
  });

  app.post('/api/auth/logout', requireAuth({ allowPasswordChangeOnly: true }), (req: RequestWithAuth, res: Response) => {
    if (req.authSessionId) {
      destroySession(db, req.authSessionId);
    }
    clearAuthCookies(req, res);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth({ allowPasswordChangeOnly: true }), (req: RequestWithAuth, res: Response) => {
    const user = req.authUser!;
    const usage = getUserUsage(db, user.id);
    const runtime = getRuntimeSettings(db, config);
    res.json({
      user,
      usage,
      csrfToken: req.authCsrfToken,
      runtime: {
        maxUploadSize: runtime.maxUploadSize,
        uploadChunkSize: runtime.uploadChunkSize,
      },
    });
  });

  app.post(
    '/api/auth/change-password',
    requireAuth({ allowPasswordChangeOnly: true }),
    (req: RequestWithAuth, res: Response) => {
      const currentPassword =
        typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
      const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';

      if (!currentPassword || !newPassword) {
        res.status(400).json({ error: 'Current password and new password are required' });
        return;
      }
      if (newPassword.length < 8) {
        res.status(400).json({ error: 'New password must be at least 8 characters long' });
        return;
      }
      if (newPassword === currentPassword) {
        res.status(400).json({ error: 'New password must differ from current password' });
        return;
      }

      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.authUser!.id) as
        | UserRow
        | undefined;
      if (!row || !verifyPassword(currentPassword, row.password_hash)) {
        res.status(401).json({ error: 'Current password is incorrect' });
        return;
      }

      const newHash = hashPassword(newPassword);
      db.prepare(
        `UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = datetime('now') WHERE id = ?`
      ).run(newHash, row.id);

      logActivity(db, {
        userId: row.id,
        actorUsername: row.username,
        action: 'auth.password_changed',
        targetType: 'user',
        targetId: row.id,
        details: 'User updated their account password',
        level: 'info',
      });

      res.json({ ok: true });
    }
  );

  // =========================================================================
  // User Files & Folders (strictly isolated to req.authUser.id)
  // =========================================================================
  app.get('/api/files', requireAuth(), (req: RequestWithAuth, res: Response, next: NextFunction) => {
    try {
      const userId = req.authUser!.id;
      const folderParam = typeof req.query.folder === 'string' ? req.query.folder : '';
      const searchParam = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const folderPath = normalizeRelativePath(folderParam, true);

      let folders: Array<{
        id: string;
        path: string;
        parent_path: string;
        name: string;
        created_at: string;
        updated_at: string;
      }>;
      let files: FileRow[];

      if (searchParam) {
        const pattern = `%${searchParam.replace(/[%_]/g, '\\$&')}%`;
        folders = db
          .prepare(
            `SELECT id, path, parent_path, name, created_at, updated_at
             FROM folders
             WHERE user_id = ? AND name LIKE ? ESCAPE '\\'
             ORDER BY path ASC`
          )
          .all(userId, pattern) as typeof folders;

        files = db
          .prepare(
            `SELECT * FROM files
             WHERE user_id = ? AND deleted_at IS NULL AND status != 'RECEIVING'
               AND (name LIKE ? ESCAPE '\\' OR relative_path LIKE ? ESCAPE '\\')
             ORDER BY updated_at DESC`
          )
          .all(userId, pattern, pattern) as FileRow[];
      } else {
        folders = db
          .prepare(
            `SELECT id, path, parent_path, name, created_at, updated_at
             FROM folders
             WHERE user_id = ? AND parent_path = ?
             ORDER BY name COLLATE NOCASE ASC`
          )
          .all(userId, folderPath) as typeof folders;

        files = db
          .prepare(
            `SELECT * FROM files
             WHERE user_id = ? AND folder_path = ? AND deleted_at IS NULL AND status != 'RECEIVING'
             ORDER BY name COLLATE NOCASE ASC`
          )
          .all(userId, folderPath) as FileRow[];
      }

      const usage = getUserUsage(db, userId);

      res.json({
        folderPath,
        folders: folders.map((f) => ({
          id: f.id,
          path: f.path,
          parentPath: f.parent_path,
          name: f.name,
          createdAt: f.created_at,
          updatedAt: f.updated_at,
        })),
        files: files.map(serializeFile),
        usage,
        quotaBytes: req.authUser!.quotaBytes,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/files/folders', requireAuth(), (req: RequestWithAuth, res: Response) => {
    const userId = req.authUser!.id;
    const rows = db
      .prepare(`SELECT id, path, parent_path, name FROM folders WHERE user_id = ? ORDER BY path ASC`)
      .all(userId) as Array<{ id: string; path: string; parent_path: string; name: string }>;
    res.json({
      folders: rows.map((r) => ({
        id: r.id,
        path: r.path,
        parentPath: r.parent_path,
        name: r.name,
      })),
    });
  });

  app.post('/api/files/folders', requireAuth(), (req: RequestWithAuth, res: Response, next: NextFunction) => {
    try {
      const userId = req.authUser!.id;
      const parentPath = normalizeRelativePath(
        typeof req.body?.parentPath === 'string' ? req.body.parentPath : '',
        true
      );
      const name = sanitizeSegment(req.body?.name);
      const fullPath = joinRelativePath(parentPath, name);

      // Verify path containment & ensure parent chain exists
      resolveUserStagingPath(config.hardDiskPath, userId, fullPath);

      const existing = db
        .prepare(`SELECT id FROM folders WHERE user_id = ? AND path = ?`)
        .get(userId, fullPath);
      if (existing) {
        res.status(409).json({ error: 'A folder with that name already exists here' });
        return;
      }

      const fileConflict = db
        .prepare(`SELECT id FROM files WHERE user_id = ? AND relative_path = ? AND deleted_at IS NULL`)
        .get(userId, fullPath);
      if (fileConflict) {
        res.status(409).json({ error: 'A file with that name already exists here' });
        return;
      }

      const id = generateId('fld');
      db.transaction(() => {
        ensureFolderAncestors(db, userId, parentPath);
        db.prepare(
          `INSERT INTO folders (id, user_id, path, parent_path, name) VALUES (?, ?, ?, ?, ?)`
        ).run(id, userId, fullPath, parentPath, name);
      })();

      res.status(201).json({
        folder: { id, path: fullPath, parentPath, name },
      });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/files/folders/:id', requireAuth(), async (req: RequestWithAuth, res: Response, next: NextFunction) => {
    try {
      const userId = req.authUser!.id;
      const folder = db
        .prepare(`SELECT * FROM folders WHERE id = ? AND user_id = ?`)
        .get(req.params.id, userId) as
        | { id: string; user_id: string; path: string; name: string }
        | undefined;

      if (!folder) {
        res.status(404).json({ error: 'Folder not found' });
        return;
      }

      const prefix = `${folder.path}/`;
      const affectedFiles = db
        .prepare(
          `SELECT * FROM files
           WHERE user_id = ? AND deleted_at IS NULL
             AND (folder_path = ? OR folder_path LIKE ?)`
        )
        .all(userId, folder.path, `${prefix}%`) as FileRow[];

      for (const file of affectedFiles) {
        await deleteFileRecord(db, config, syncEngine, cloudDriver, file);
      }

      db.prepare(
        `DELETE FROM folders WHERE user_id = ? AND (path = ? OR path LIKE ?)`
      ).run(userId, folder.path, `${prefix}%`);

      try {
        const localDir = resolveUserStagingPath(config.hardDiskPath, userId, folder.path);
        if (fs.existsSync(localDir)) {
          fs.rmSync(localDir, { recursive: true, force: true });
        }
      } catch {
        // ignore
      }

      logActivity(db, {
        userId,
        actorUsername: req.authUser!.username,
        action: 'folder.deleted',
        targetType: 'folder',
        targetId: folder.id,
        details: `Deleted folder "${folder.path}" (${affectedFiles.length} file(s))`,
      });

      res.json({ ok: true, deletedFiles: affectedFiles.length });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/files/:id', requireAuth(), (req: RequestWithAuth, res: Response) => {
    const userId = req.authUser!.id;
    const file = db
      .prepare(`SELECT * FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
      .get(req.params.id, userId) as FileRow | undefined;

    if (!file || file.status === 'RECEIVING') {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const jobs = db
      .prepare(`SELECT * FROM sync_jobs WHERE file_id = ? ORDER BY created_at DESC LIMIT 10`)
      .all(file.id);

    res.json({ file: serializeFile(file), jobs });
  });

  app.get('/api/files/:id/download', requireAuth(), async (req: RequestWithAuth, res: Response, next: NextFunction) => {
    try {
      const userId = req.authUser!.id;
      const file = db
        .prepare(`SELECT * FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
        .get(req.params.id, userId) as FileRow | undefined;

      if (!file || file.status === 'RECEIVING') {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      const inline = req.query.inline === '1' || req.query.inline === 'true';
      const safeDownloadName = file.name.replace(/["\r\n]/g, '_');
      res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        `${inline ? 'inline' : 'attachment'}; filename="${safeDownloadName}"`
      );
      if (file.sha256) {
        res.setHeader('ETag', `"${file.sha256}"`);
      }

      // 1. If still present in local staging, serve directly from local hard disk
      if (file.local_present) {
        const localPath = resolveUserStagingPath(config.hardDiskPath, userId, file.relative_path);
        if (fs.existsSync(localPath)) {
          const stat = fs.statSync(localPath);
          res.setHeader('Content-Length', String(stat.size));
          res.setHeader('X-Storage-Source', 'staging');
          const stream = fs.createReadStream(localPath);
          stream.on('error', (err) => {
            if (!res.headersSent) next(err);
            else res.destroy();
          });
          stream.pipe(res);
          return;
        }
      }

      // 2. Otherwise, stream directly from the cloud drive through the app (permission-checked)
      if (file.cloud_present && file.cloud_path) {
        res.setHeader('Content-Length', String(file.size_bytes));
        res.setHeader('X-Storage-Source', 'cloud');
        const { stream, cleanup } = await cloudDriver.createReadStream(file.cloud_path);
        res.on('close', () => cleanup?.());
        stream.on('error', (err) => {
          cleanup?.();
          if (!res.headersSent) {
            res.status(502).json({ error: `Failed to stream file from cloud: ${err.message}` });
          } else {
            res.destroy();
          }
        });
        stream.pipe(res);
        return;
      }

      res.status(404).json({ error: 'File payload unavailable in staging or cloud' });
    } catch (err) {
      next(err);
    }
  });

  app.patch('/api/files/:id', requireAuth(), async (req: RequestWithAuth, res: Response, next: NextFunction) => {
    try {
      const userId = req.authUser!.id;
      const file = db
        .prepare(`SELECT * FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
        .get(req.params.id, userId) as FileRow | undefined;

      if (!file || file.status === 'RECEIVING') {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      const newName =
        typeof req.body?.name === 'string' ? sanitizeSegment(req.body.name) : file.name;
      const newFolder =
        typeof req.body?.targetFolder === 'string'
          ? normalizeRelativePath(req.body.targetFolder, true)
          : file.folder_path;

      const newRelPath = joinRelativePath(newFolder, newName);
      if (newRelPath === file.relative_path) {
        res.json({ file: serializeFile(file) });
        return;
      }

      // Prevent collision with existing file or folder
      const collision = db
        .prepare(
          `SELECT id FROM files WHERE user_id = ? AND relative_path = ? AND deleted_at IS NULL AND id != ?`
        )
        .get(userId, newRelPath, file.id);
      if (collision) {
        res.status(409).json({ error: 'A file already exists at the destination path' });
        return;
      }

      const folderCollision = db
        .prepare(`SELECT id FROM folders WHERE user_id = ? AND path = ?`)
        .get(userId, newRelPath);
      if (folderCollision) {
        res.status(409).json({ error: 'A folder already exists at the destination path' });
        return;
      }

      const newCloudPath = buildUserCloudPath(userId, newRelPath);
      const oldCloudPath = file.cloud_path;
      const newMime = guessMimeType(newName, file.mime_type);

      // Cancel any in-flight sync jobs before mutating paths
      syncEngine.cancelJobsForFile(file.id, 'File renamed/moved while sync in progress');

      if (file.local_present) {
        const oldLocal = resolveUserStagingPath(config.hardDiskPath, userId, file.relative_path);
        const newLocal = resolveUserStagingPath(config.hardDiskPath, userId, newRelPath);
        if (fs.existsSync(oldLocal)) {
          fs.mkdirSync(path.dirname(newLocal), { recursive: true });
          fs.renameSync(oldLocal, newLocal);
        }
      }

      if (file.cloud_present && oldCloudPath && oldCloudPath !== newCloudPath) {
        await cloudDriver.moveFile(oldCloudPath, newCloudPath);
      }

      const updated = db.transaction(() => {
        ensureFolderAncestors(db, userId, newFolder);
        db.prepare(
          `UPDATE files
           SET relative_path = ?, folder_path = ?, name = ?, mime_type = ?,
               cloud_path = ?, generation = generation + 1, updated_at = datetime('now')
           WHERE id = ?`
        ).run(newRelPath, newFolder, newName, newMime, newCloudPath, file.id);
        return db.prepare('SELECT * FROM files WHERE id = ?').get(file.id) as FileRow;
      })();

      // If still only staged locally (not yet verified in cloud), re-queue at the new path
      if (updated.local_present && updated.status !== 'SYNCED') {
        syncEngine.enqueueFile(updated.id);
      }

      const refreshed = db.prepare('SELECT * FROM files WHERE id = ?').get(file.id) as FileRow;
      logActivity(db, {
        userId,
        actorUsername: req.authUser!.username,
        action: 'file.moved',
        targetType: 'file',
        targetId: file.id,
        details: `Moved "${file.relative_path}" to "${newRelPath}"`,
      });

      res.json({ file: serializeFile(refreshed) });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/files/:id', requireAuth(), async (req: RequestWithAuth, res: Response, next: NextFunction) => {
    try {
      const userId = req.authUser!.id;
      const file = db
        .prepare(`SELECT * FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
        .get(req.params.id, userId) as FileRow | undefined;

      if (!file) {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      await deleteFileRecord(db, config, syncEngine, cloudDriver, file);

      logActivity(db, {
        userId,
        actorUsername: req.authUser!.username,
        action: 'file.deleted',
        targetType: 'file',
        targetId: file.id,
        details: `Deleted "${file.relative_path}"`,
      });

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/files/:id/retry', requireAuth(), (req: RequestWithAuth, res: Response, next: NextFunction) => {
    try {
      const userId = req.authUser!.id;
      const file = db
        .prepare(`SELECT * FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
        .get(req.params.id, userId) as FileRow | undefined;

      if (!file) {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      if (!file.local_present) {
        res.status(400).json({ error: 'File has no local staged copy available to retry' });
        return;
      }

      const job = syncEngine.enqueueFile(file.id);
      const updated = db.prepare('SELECT * FROM files WHERE id = ?').get(file.id) as FileRow;
      res.json({ file: serializeFile(updated), job });
    } catch (err) {
      next(err);
    }
  });

  // =========================================================================
  // Chunked / Resumable Upload Pipeline
  // =========================================================================
  app.post('/api/uploads/init', requireAuth(), (req: RequestWithAuth, res: Response, next: NextFunction) => {
    try {
      const user = req.authUser!;
      const runtime = getRuntimeSettings(db, config);

      const folderPath = normalizeRelativePath(
        typeof req.body?.folderPath === 'string' ? req.body.folderPath : '',
        true
      );
      const fileName = sanitizeSegment(req.body?.fileName);
      const expectedSize = Number(req.body?.sizeBytes);
      const mimeType = guessMimeType(
        fileName,
        typeof req.body?.mimeType === 'string' ? req.body.mimeType : undefined
      );

      if (!Number.isInteger(expectedSize) || expectedSize < 0) {
        res.status(400).json({ error: 'Valid non-negative sizeBytes is required' });
        return;
      }

      if (expectedSize > runtime.maxUploadSize) {
        res.status(413).json({
          error: `File size (${expectedSize} B) exceeds maximum allowed upload size (${runtime.maxUploadSize} B)`,
        });
        return;
      }

      const relativePath = joinRelativePath(folderPath, fileName);
      // Validate path containment before accepting any data
      resolveUserStagingPath(config.hardDiskPath, user.id, relativePath);

      const folderConflict = db
        .prepare(`SELECT id FROM folders WHERE user_id = ? AND path = ?`)
        .get(user.id, relativePath);
      if (folderConflict) {
        res.status(409).json({ error: 'Cannot upload: a folder already exists at this path' });
        return;
      }

      // Check quota (subtract existing file size if overwriting the same path)
      const existingFile = db
        .prepare(
          `SELECT id, size_bytes FROM files WHERE user_id = ? AND relative_path = ? AND deleted_at IS NULL`
        )
        .get(user.id, relativePath) as { id: string; size_bytes: number } | undefined;

      const usage = getUserUsage(db, user.id);
      const netDelta = expectedSize - (existingFile?.size_bytes ?? 0);
      if (usage.totalBytes + netDelta > user.quotaBytes) {
        res.status(413).json({
          error: 'Storage quota exceeded. Delete files or ask an administrator to increase your quota.',
        });
        return;
      }

      const uploadId = generateId('upl');
      const tmpDir = path.join(config.hardDiskPath, '.tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      const tempFilePath = path.join(tmpDir, `${uploadId}.part`);
      fs.writeFileSync(tempFilePath, Buffer.alloc(0));

      const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

      // If this is a brand-new path, record an internal RECEIVING file entry (never exposed in listings/downloads).
      // If overwriting an existing path, defer file modification until atomic commit so partial overwrites never break existing files.
      let receivingFileId: string | null = null;
      db.transaction(() => {
        if (!existingFile) {
          receivingFileId = generateId('fil');
          db.prepare(
            `INSERT INTO files (
               id, user_id, relative_path, folder_path, name, mime_type,
               size_bytes, status, local_present, cloud_present
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'RECEIVING', 0, 0)`
          ).run(receivingFileId, user.id, relativePath, folderPath, fileName, mimeType, expectedSize);
        }

        db.prepare(
          `INSERT INTO upload_sessions (
             id, user_id, file_id, relative_path, folder_path, name, mime_type,
             expected_size, received_bytes, temp_file_path, status, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'ACTIVE', ?)`
        ).run(
          uploadId,
          user.id,
          receivingFileId,
          relativePath,
          folderPath,
          fileName,
          mimeType,
          expectedSize,
          tempFilePath,
          expiresAt
        );
      })();

      res.status(201).json({
        uploadId,
        relativePath,
        chunkSize: runtime.uploadChunkSize,
        expectedSize,
        receivedBytes: 0,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/uploads/:uploadId', requireAuth(), (req: RequestWithAuth, res: Response) => {
    const sess = db
      .prepare(`SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?`)
      .get(req.params.uploadId, req.authUser!.id) as
      | {
          id: string;
          relative_path: string;
          expected_size: number;
          received_bytes: number;
          status: string;
        }
      | undefined;

    if (!sess) {
      res.status(404).json({ error: 'Upload session not found' });
      return;
    }

    res.json({
      uploadId: sess.id,
      relativePath: sess.relative_path,
      expectedSize: sess.expected_size,
      receivedBytes: sess.received_bytes,
      status: sess.status,
    });
  });

  app.put(
    '/api/uploads/:uploadId/chunk',
    requireAuth(),
    async (req: RequestWithAuth, res: Response, next: NextFunction) => {
      try {
        const userId = req.authUser!.id;
        const sess = db
          .prepare(`SELECT * FROM upload_sessions WHERE id = ? AND user_id = ? AND status = 'ACTIVE'`)
          .get(req.params.uploadId, userId) as
          | {
              id: string;
              expected_size: number;
              received_bytes: number;
              temp_file_path: string;
            }
          | undefined;

        if (!sess) {
          res.status(404).json({ error: 'Active upload session not found' });
          return;
        }

        const offsetParam = req.query.offset ?? req.headers['x-upload-offset'];
        const offset = Number(offsetParam ?? sess.received_bytes);
        if (!Number.isInteger(offset) || offset < 0 || offset > sess.received_bytes) {
          res.status(409).json({
            error: `Invalid chunk offset ${offset}; expected <= ${sess.received_bytes}`,
            receivedBytes: sess.received_bytes,
          });
          return;
        }

        const runtime = getRuntimeSettings(db, config);
        const maxChunkBytes = Math.max(runtime.uploadChunkSize * 2, 16 * 1024 * 1024);

        // Stream request body directly into the temp .part file at the specified offset
        const written = await new Promise<number>((resolve, reject) => {
          const fd = fs.openSync(sess.temp_file_path, 'r+');
          let bytesWritten = 0;
          let pos = offset;
          let closed = false;

          const closeFd = () => {
            if (!closed) {
              closed = true;
              try {
                fs.closeSync(fd);
              } catch {
                // ignore
              }
            }
          };

          req.on('data', (chunk: Buffer) => {
            bytesWritten += chunk.length;
            if (bytesWritten > maxChunkBytes || offset + bytesWritten > sess.expected_size) {
              closeFd();
              req.pause();
              reject(new Error('Chunk exceeds declared upload size or chunk limit'));
              return;
            }
            try {
              fs.writeSync(fd, chunk, 0, chunk.length, pos);
              pos += chunk.length;
            } catch (writeErr) {
              closeFd();
              reject(writeErr);
            }
          });

          req.on('end', () => {
            closeFd();
            resolve(bytesWritten);
          });

          req.on('error', (err) => {
            closeFd();
            reject(err);
          });
        });

        const newReceived = Math.max(sess.received_bytes, offset + written);
        db.prepare(
          `UPDATE upload_sessions SET received_bytes = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(newReceived, sess.id);

        res.json({
          uploadId: sess.id,
          receivedBytes: newReceived,
          expectedSize: sess.expected_size,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/uploads/:uploadId/complete',
    requireAuth(),
    async (req: RequestWithAuth, res: Response, next: NextFunction) => {
      try {
        const user = req.authUser!;
        const sess = db
          .prepare(`SELECT * FROM upload_sessions WHERE id = ? AND user_id = ? AND status = 'ACTIVE'`)
          .get(req.params.uploadId, user.id) as
          | {
              id: string;
              file_id: string | null;
              relative_path: string;
              folder_path: string;
              name: string;
              mime_type: string;
              expected_size: number;
              received_bytes: number;
              temp_file_path: string;
            }
          | undefined;

        if (!sess) {
          res.status(404).json({ error: 'Active upload session not found' });
          return;
        }

        if (!fs.existsSync(sess.temp_file_path)) {
          res.status(410).json({ error: 'Temporary upload file is missing; please re-upload' });
          return;
        }

        const diskStat = fs.statSync(sess.temp_file_path);
        if (diskStat.size !== sess.expected_size) {
          res.status(400).json({
            error: `Upload incomplete: received ${diskStat.size} of ${sess.expected_size} bytes`,
          });
          return;
        }

        // Compute SHA-256 (plus MD5 & SHA-1 for broad rclone provider checksum verification)
        const hashes = await computeAllFileHashes(sess.temp_file_path);

        // Atomically move temp file into `<HARD_DISK_PATH>/<user_id>/<relative_path>`
        const finalLocalPath = resolveUserStagingPath(
          config.hardDiskPath,
          user.id,
          sess.relative_path
        );
        fs.mkdirSync(path.dirname(finalLocalPath), { recursive: true });

        // Check if overwriting an existing active file at the same path
        const existingActive = db
          .prepare(
            `SELECT * FROM files
             WHERE user_id = ? AND relative_path = ? AND deleted_at IS NULL AND status != 'RECEIVING'`
          )
          .get(user.id, sess.relative_path) as FileRow | undefined;

        if (existingActive) {
          // Supersede any in-flight sync jobs for the older generation before replacing the file
          syncEngine.cancelJobsForFile(existingActive.id, 'Superseded by newer file upload');
        }

        fs.renameSync(sess.temp_file_path, finalLocalPath);
        const finalStat = fs.statSync(finalLocalPath);
        const cloudPath = buildUserCloudPath(user.id, sess.relative_path);

        // Transition RECEIVING -> STAGED atomically in DB
        const stagedFileId = db.transaction(() => {
          ensureFolderAncestors(db, user.id, sess.folder_path);

          let fileId: string;
          if (existingActive) {
            // Overwrite existing file: bump generation, set STAGED, mark local_present=1, cloud_present=0 until new gen is verified
            fileId = existingActive.id;
            db.prepare(
              `UPDATE files
               SET size_bytes = ?, mime_type = ?, sha256 = ?, md5 = ?, sha1 = ?,
                   status = 'STAGED', local_present = 1, cloud_present = 0,
                   local_mtime_ms = ?, cloud_path = ?, verification_method = NULL,
                   verified_at = NULL, last_error = NULL,
                   generation = generation + 1, updated_at = datetime('now')
               WHERE id = ?`
            ).run(
              hashes.sizeBytes,
              sess.mime_type,
              hashes.sha256,
              hashes.md5,
              hashes.sha1,
              Math.floor(finalStat.mtimeMs),
              cloudPath,
              fileId
            );
            if (sess.file_id && sess.file_id !== fileId) {
              db.prepare(`DELETE FROM files WHERE id = ? AND status = 'RECEIVING'`).run(sess.file_id);
            }
          } else if (sess.file_id) {
            fileId = sess.file_id;
            db.prepare(
              `UPDATE files
               SET size_bytes = ?, mime_type = ?, sha256 = ?, md5 = ?, sha1 = ?,
                   status = 'STAGED', local_present = 1, cloud_present = 0,
                   local_mtime_ms = ?, cloud_path = ?, updated_at = datetime('now')
               WHERE id = ?`
            ).run(
              hashes.sizeBytes,
              sess.mime_type,
              hashes.sha256,
              hashes.md5,
              hashes.sha1,
              Math.floor(finalStat.mtimeMs),
              cloudPath,
              fileId
            );
          } else {
            fileId = generateId('fil');
            db.prepare(
              `INSERT INTO files (
                 id, user_id, relative_path, folder_path, name, mime_type,
                 size_bytes, sha256, md5, sha1, status, local_present, cloud_present,
                 local_mtime_ms, cloud_path
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'STAGED', 1, 0, ?, ?)`
            ).run(
              fileId,
              user.id,
              sess.relative_path,
              sess.folder_path,
              sess.name,
              sess.mime_type,
              hashes.sizeBytes,
              hashes.sha256,
              hashes.md5,
              hashes.sha1,
              Math.floor(finalStat.mtimeMs),
              cloudPath
            );
          }

          db.prepare(
            `UPDATE upload_sessions SET status = 'COMPLETED', file_id = ?, updated_at = datetime('now') WHERE id = ?`
          ).run(fileId, sess.id);

          return fileId;
        })();

        logActivity(db, {
          userId: user.id,
          actorUsername: user.username,
          action: existingActive ? 'file.overwritten' : 'file.staged',
          targetType: 'file',
          targetId: stagedFileId,
          details: `Staged "${sess.relative_path}" (${hashes.sizeBytes} B, sha256:${hashes.sha256.slice(0, 12)})`,
        });

        // Transition STAGED -> QUEUED for background rclone upload & verification
        const job = syncEngine.enqueueFile(stagedFileId);
        const fileRow = db.prepare('SELECT * FROM files WHERE id = ?').get(stagedFileId) as FileRow;

        res.status(201).json({
          file: serializeFile(fileRow),
          job,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  app.delete('/api/uploads/:uploadId', requireAuth(), (req: RequestWithAuth, res: Response) => {
    const sess = db
      .prepare(`SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?`)
      .get(req.params.uploadId, req.authUser!.id) as
      | { id: string; file_id: string | null; temp_file_path: string }
      | undefined;

    if (!sess) {
      res.status(404).json({ error: 'Upload session not found' });
      return;
    }

    try {
      if (fs.existsSync(sess.temp_file_path)) {
        fs.unlinkSync(sess.temp_file_path);
      }
    } catch {
      // ignore
    }

    db.transaction(() => {
      db.prepare(
        `UPDATE upload_sessions SET status = 'ABORTED', updated_at = datetime('now') WHERE id = ?`
      ).run(sess.id);
      if (sess.file_id) {
        db.prepare(`DELETE FROM files WHERE id = ? AND status = 'RECEIVING'`).run(sess.file_id);
      }
    })();

    res.json({ ok: true });
  });

  // =========================================================================
  // Admin Endpoints (server-enforced RBAC)
  // =========================================================================
  app.get('/api/admin/overview', requireAuth(), requireAdmin, async (_req: RequestWithAuth, res: Response) => {
    const stagingDisk = measureDirBytes(config.hardDiskPath);

    const fileStats = db
      .prepare(
        `SELECT
           COUNT(*) AS total_files,
           COALESCE(SUM(size_bytes), 0) AS total_bytes,
           COALESCE(SUM(CASE WHEN local_present = 1 THEN size_bytes ELSE 0 END), 0) AS staged_bytes,
           COALESCE(SUM(CASE WHEN cloud_present = 1 THEN size_bytes ELSE 0 END), 0) AS cloud_bytes,
           SUM(CASE WHEN status IN ('STAGED', 'QUEUED') THEN 1 ELSE 0 END) AS queued_files,
           SUM(CASE WHEN status IN ('UPLOADING', 'VERIFYING') THEN 1 ELSE 0 END) AS active_files,
           SUM(CASE WHEN status = 'SYNCED' THEN 1 ELSE 0 END) AS synced_files,
           SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed_files
         FROM files
         WHERE deleted_at IS NULL AND status != 'RECEIVING'`
      )
      .get() as Record<string, number>;

    const jobCounts = db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END) AS queued,
           SUM(CASE WHEN status IN ('UPLOADING', 'VERIFYING') THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'SYNCED' THEN 1 ELSE 0 END) AS synced
         FROM sync_jobs`
      )
      .get() as Record<string, number>;

    const users = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.role, u.is_active, u.quota_bytes, u.last_login_at,
                COALESCE(SUM(CASE WHEN f.deleted_at IS NULL AND f.status != 'RECEIVING' THEN f.size_bytes ELSE 0 END), 0) AS used_bytes,
                COALESCE(SUM(CASE WHEN f.deleted_at IS NULL AND f.local_present = 1 THEN f.size_bytes ELSE 0 END), 0) AS staged_bytes,
                COALESCE(SUM(CASE WHEN f.deleted_at IS NULL AND f.cloud_present = 1 THEN f.size_bytes ELSE 0 END), 0) AS cloud_bytes,
                COUNT(CASE WHEN f.deleted_at IS NULL AND f.status != 'RECEIVING' THEN 1 END) AS file_count
         FROM users u
         LEFT JOIN files f ON f.user_id = u.id
         GROUP BY u.id
         ORDER BY used_bytes DESC, u.username ASC`
      )
      .all() as Array<Record<string, unknown>>;

    const recentActivity = db
      .prepare(`SELECT * FROM activity_logs ORDER BY id DESC LIMIT 25`)
      .all();

    const cloudHealth = await cloudDriver.checkHealth();

    res.json({
      stagingDisk,
      storage: {
        totalFiles: fileStats.total_files ?? 0,
        totalBytes: fileStats.total_bytes ?? 0,
        stagedBytes: fileStats.staged_bytes ?? 0,
        cloudBytes: fileStats.cloud_bytes ?? 0,
        queuedFiles: fileStats.queued_files ?? 0,
        activeFiles: fileStats.active_files ?? 0,
        syncedFiles: fileStats.synced_files ?? 0,
        failedFiles: fileStats.failed_files ?? 0,
      },
      queue: {
        queued: jobCounts.queued ?? 0,
        active: jobCounts.active ?? 0,
        failed: jobCounts.failed ?? 0,
        synced: jobCounts.synced ?? 0,
      },
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.display_name,
        role: u.role,
        isActive: Boolean(u.is_active),
        quotaBytes: u.quota_bytes,
        usedBytes: u.used_bytes,
        stagedBytes: u.staged_bytes,
        cloudBytes: u.cloud_bytes,
        fileCount: u.file_count,
        lastLoginAt: u.last_login_at,
      })),
      recentActivity,
      cloudHealth,
    });
  });

  app.get('/api/admin/users', requireAuth(), requireAdmin, (_req: RequestWithAuth, res: Response) => {
    const rows = db
      .prepare(
        `SELECT u.id, u.username, u.display_name, u.role, u.is_active, u.must_change_password,
                u.quota_bytes, u.created_at, u.last_login_at,
                COALESCE(SUM(CASE WHEN f.deleted_at IS NULL AND f.status != 'RECEIVING' THEN f.size_bytes ELSE 0 END), 0) AS used_bytes,
                COALESCE(SUM(CASE WHEN f.deleted_at IS NULL AND f.local_present = 1 THEN f.size_bytes ELSE 0 END), 0) AS staged_bytes,
                COALESCE(SUM(CASE WHEN f.deleted_at IS NULL AND f.cloud_present = 1 THEN f.size_bytes ELSE 0 END), 0) AS cloud_bytes,
                COUNT(CASE WHEN f.deleted_at IS NULL AND f.status != 'RECEIVING' THEN 1 END) AS file_count
         FROM users u
         LEFT JOIN files f ON f.user_id = u.id
         GROUP BY u.id
         ORDER BY u.created_at ASC`
      )
      .all() as Array<Record<string, unknown>>;

    res.json({
      users: rows.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.display_name,
        role: u.role,
        isActive: Boolean(u.is_active),
        mustChangePassword: Boolean(u.must_change_password),
        quotaBytes: u.quota_bytes,
        usedBytes: u.used_bytes,
        stagedBytes: u.staged_bytes,
        cloudBytes: u.cloud_bytes,
        fileCount: u.file_count,
        createdAt: u.created_at,
        lastLoginAt: u.last_login_at,
      })),
    });
  });

  app.post('/api/admin/users', requireAuth(), requireAdmin, (req: RequestWithAuth, res: Response) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const displayName =
      typeof req.body?.displayName === 'string' && req.body.displayName.trim()
        ? req.body.displayName.trim()
        : username;
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const role = req.body?.role === 'admin' ? 'admin' : 'user';
    const runtime = getRuntimeSettings(db, config);
    const quotaBytes =
      req.body?.quotaBytes !== undefined
        ? Math.max(1024 * 1024, Math.floor(Number(req.body.quotaBytes)))
        : runtime.defaultUserQuota;
    const mustChangePassword = req.body?.mustChangePassword ? 1 : 0;

    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
      res.status(400).json({
        error: 'Username must be 3–32 characters using letters, numbers, dots, underscores, or hyphens',
      });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters long' });
      return;
    }

    const exists = db
      .prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
      .get(username);
    if (exists) {
      res.status(409).json({ error: 'A user with that username already exists' });
      return;
    }

    const id = generateId('usr');
    const hash = hashPassword(password);
    db.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, role, is_active, must_change_password, quota_bytes)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(id, username, displayName, hash, role, mustChangePassword, quotaBytes);

    logActivity(db, {
      userId: req.authUser!.id,
      actorUsername: req.authUser!.username,
      action: 'admin.user_created',
      targetType: 'user',
      targetId: id,
      details: `Created ${role} "${username}" with quota ${quotaBytes} B`,
    });

    res.status(201).json({
      user: {
        id,
        username,
        displayName,
        role,
        isActive: true,
        mustChangePassword: Boolean(mustChangePassword),
        quotaBytes,
      },
    });
  });

  app.patch('/api/admin/users/:id', requireAuth(), requireAdmin, (req: RequestWithAuth, res: Response) => {
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as
      | UserRow
      | undefined;
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const nextDisplayName =
      typeof req.body?.displayName === 'string' && req.body.displayName.trim()
        ? req.body.displayName.trim()
        : target.display_name;
    const nextRole =
      req.body?.role === 'admin' || req.body?.role === 'user' ? req.body.role : target.role;
    const nextActive =
      typeof req.body?.isActive === 'boolean' ? (req.body.isActive ? 1 : 0) : target.is_active;
    const nextQuota =
      req.body?.quotaBytes !== undefined
        ? Math.max(1024 * 1024, Math.floor(Number(req.body.quotaBytes)))
        : target.quota_bytes;

    // Prevent disabling or demoting the only active admin
    if (target.role === 'admin' && (nextRole !== 'admin' || nextActive === 0)) {
      const otherAdmins = db
        .prepare(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?`)
        .get(target.id) as { cnt: number };
      if (otherAdmins.cnt === 0) {
        res.status(400).json({ error: 'Cannot disable or demote the last active administrator' });
        return;
      }
    }

    db.prepare(
      `UPDATE users
       SET display_name = ?, role = ?, is_active = ?, quota_bytes = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(nextDisplayName, nextRole, nextActive, nextQuota, target.id);

    if (nextActive === 0) {
      destroyAllUserSessions(db, target.id);
    }

    logActivity(db, {
      userId: req.authUser!.id,
      actorUsername: req.authUser!.username,
      action: 'admin.user_updated',
      targetType: 'user',
      targetId: target.id,
      details: `Updated "${target.username}" (role=${nextRole}, active=${Boolean(nextActive)}, quota=${nextQuota})`,
    });

    res.json({
      user: {
        id: target.id,
        username: target.username,
        displayName: nextDisplayName,
        role: nextRole,
        isActive: Boolean(nextActive),
        quotaBytes: nextQuota,
      },
    });
  });

  app.post(
    '/api/admin/users/:id/reset-password',
    requireAuth(),
    requireAdmin,
    (req: RequestWithAuth, res: Response) => {
      const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as
        | UserRow
        | undefined;
      if (!target) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
      const forceChange = req.body?.mustChangePassword !== false ? 1 : 0;
      if (newPassword.length < 8) {
        res.status(400).json({ error: 'Password must be at least 8 characters long' });
        return;
      }

      db.prepare(
        `UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(hashPassword(newPassword), forceChange, target.id);

      destroyAllUserSessions(db, target.id);

      logActivity(db, {
        userId: req.authUser!.id,
        actorUsername: req.authUser!.username,
        action: 'admin.password_reset',
        targetType: 'user',
        targetId: target.id,
        details: `Reset password for "${target.username}"`,
      });

      res.json({ ok: true });
    }
  );

  app.delete('/api/admin/users/:id', requireAuth(), requireAdmin, async (req: RequestWithAuth, res: Response) => {
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as
      | UserRow
      | undefined;
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (target.id === req.authUser!.id) {
      res.status(400).json({ error: 'Cannot delete your own active administrator account' });
      return;
    }

    // Cancel any active sync jobs for this user
    const userFiles = db
      .prepare('SELECT id FROM files WHERE user_id = ?')
      .all(target.id) as Array<{ id: string }>;
    for (const f of userFiles) {
      syncEngine.cancelJobsForFile(f.id, 'User account deleted');
    }

    // Remove local staging namespace & cloud namespace
    try {
      const userRoot = getUserStagingRoot(config.hardDiskPath, target.id);
      if (fs.existsSync(userRoot)) {
        fs.rmSync(userRoot, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }

    try {
      await cloudDriver.deleteUserNamespace(target.id);
    } catch {
      // best-effort cloud cleanup
    }

    db.prepare('DELETE FROM users WHERE id = ?').run(target.id);

    logActivity(db, {
      userId: req.authUser!.id,
      actorUsername: req.authUser!.username,
      action: 'admin.user_deleted',
      targetType: 'user',
      targetId: target.id,
      details: `Deleted user "${target.username}" and purged isolated storage`,
    });

    res.json({ ok: true });
  });

  app.get('/api/admin/sync-jobs', requireAuth(), requireAdmin, (req: RequestWithAuth, res: Response) => {
    const statusFilter = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : '';
    const validStatuses = new Set(['QUEUED', 'UPLOADING', 'VERIFYING', 'SYNCED', 'FAILED', 'CANCELLED']);

    let rows: Array<Record<string, unknown>>;
    if (statusFilter === 'ACTIVE') {
      rows = db
        .prepare(
          `SELECT j.*, u.username, f.name AS file_name, f.size_bytes, f.local_present, f.cloud_present
           FROM sync_jobs j
           LEFT JOIN users u ON u.id = j.user_id
           LEFT JOIN files f ON f.id = j.file_id
           WHERE j.status IN ('UPLOADING', 'VERIFYING')
           ORDER BY j.updated_at DESC
           LIMIT 100`
        )
        .all() as Array<Record<string, unknown>>;
    } else if (validStatuses.has(statusFilter)) {
      rows = db
        .prepare(
          `SELECT j.*, u.username, f.name AS file_name, f.size_bytes, f.local_present, f.cloud_present
           FROM sync_jobs j
           LEFT JOIN users u ON u.id = j.user_id
           LEFT JOIN files f ON f.id = j.file_id
           WHERE j.status = ?
           ORDER BY j.updated_at DESC
           LIMIT 100`
        )
        .all(statusFilter) as Array<Record<string, unknown>>;
    } else {
      rows = db
        .prepare(
          `SELECT j.*, u.username, f.name AS file_name, f.size_bytes, f.local_present, f.cloud_present
           FROM sync_jobs j
           LEFT JOIN users u ON u.id = j.user_id
           LEFT JOIN files f ON f.id = j.file_id
           ORDER BY j.updated_at DESC
           LIMIT 100`
        )
        .all() as Array<Record<string, unknown>>;
    }

    res.json({ jobs: rows });
  });

  app.post(
    '/api/admin/sync-jobs/:id/retry',
    requireAuth(),
    requireAdmin,
    (req: RequestWithAuth, res: Response, next: NextFunction) => {
      try {
        const newJob = syncEngine.retryJob(req.params.id);
        logActivity(db, {
          userId: req.authUser!.id,
          actorUsername: req.authUser!.username,
          action: 'admin.sync_retry',
          targetType: 'sync_job',
          targetId: newJob.id,
          details: `Re-queued sync job for file ${newJob.source_relative_path}`,
        });
        res.json({ job: newJob });
      } catch (err) {
        next(err);
      }
    }
  );

  app.post(
    '/api/admin/sync-jobs/retry-all-failed',
    requireAuth(),
    requireAdmin,
    (req: RequestWithAuth, res: Response) => {
      const failedFiles = db
        .prepare(
          `SELECT id FROM files WHERE status = 'FAILED' AND local_present = 1 AND deleted_at IS NULL`
        )
        .all() as Array<{ id: string }>;

      let retried = 0;
      for (const f of failedFiles) {
        try {
          syncEngine.enqueueFile(f.id);
          retried++;
        } catch {
          // ignore individual failure
        }
      }

      logActivity(db, {
        userId: req.authUser!.id,
        actorUsername: req.authUser!.username,
        action: 'admin.sync_retry_all',
        details: `Re-queued ${retried} failed sync job(s)`,
      });

      res.json({ ok: true, retried });
    }
  );

  app.post(
    '/api/admin/sync-jobs/:id/cancel',
    requireAuth(),
    requireAdmin,
    (req: RequestWithAuth, res: Response, next: NextFunction) => {
      try {
        syncEngine.cancelJob(req.params.id);
        logActivity(db, {
          userId: req.authUser!.id,
          actorUsername: req.authUser!.username,
          action: 'admin.sync_cancel',
          targetType: 'sync_job',
          targetId: req.params.id,
          details: `Cancelled sync job ${req.params.id}`,
        });
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    }
  );

  app.get('/api/admin/logs', requireAuth(), requireAdmin, (req: RequestWithAuth, res: Response) => {
    const level = typeof req.query.level === 'string' ? req.query.level : '';
    const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 100));

    const logs = ['info', 'warn', 'error'].includes(level)
      ? db
          .prepare(`SELECT * FROM activity_logs WHERE level = ? ORDER BY id DESC LIMIT ?`)
          .all(level, limit)
      : db.prepare(`SELECT * FROM activity_logs ORDER BY id DESC LIMIT ?`).all(limit);

    res.json({ logs });
  });

  app.get('/api/admin/settings', requireAuth(), requireAdmin, (_req: RequestWithAuth, res: Response) => {
    const runtime = getRuntimeSettings(db, config);
    const remoteSummary = inspectRcloneConfigSafe(config.rcloneConfigPath, config.cloudRemote);

    res.json({
      runtime,
      // Read-only active environment & storage configuration (NO secrets, NO rclone credentials)
      activeConfig: {
        hardDiskPath: config.hardDiskPath,
        cloudRemote: config.cloudRemote,
        rcloneConfigPath: config.rcloneConfigPath,
        rcloneRemoteName: remoteSummary.remoteName,
        rcloneRemoteType: remoteSummary.remoteType,
        rcloneConfigExists: remoteSummary.configPathExists,
        cloudDriverEngine: cloudDriver.engine,
        databasePath: config.databaseUrl,
        sessionTtlHours: config.sessionTtlHours,
        trustProxy: config.trustProxy,
      },
    });
  });

  app.patch('/api/admin/settings', requireAuth(), requireAdmin, (req: RequestWithAuth, res: Response) => {
    const updated = updateRuntimeSettings(db, config, {
      maxUploadSize: req.body?.maxUploadSize !== undefined ? Number(req.body.maxUploadSize) : undefined,
      defaultUserQuota:
        req.body?.defaultUserQuota !== undefined ? Number(req.body.defaultUserQuota) : undefined,
      uploadChunkSize:
        req.body?.uploadChunkSize !== undefined ? Number(req.body.uploadChunkSize) : undefined,
      syncConcurrency:
        req.body?.syncConcurrency !== undefined ? Number(req.body.syncConcurrency) : undefined,
      syncRetryLimit:
        req.body?.syncRetryLimit !== undefined ? Number(req.body.syncRetryLimit) : undefined,
      syncRetryBackoff:
        req.body?.syncRetryBackoff !== undefined ? Number(req.body.syncRetryBackoff) : undefined,
    });

    logActivity(db, {
      userId: req.authUser!.id,
      actorUsername: req.authUser!.username,
      action: 'admin.settings_updated',
      details: JSON.stringify(updated),
    });

    res.json({ runtime: updated });
  });

  app.post('/api/admin/test-cloud', requireAuth(), requireAdmin, async (_req: RequestWithAuth, res: Response) => {
    const health = await cloudDriver.checkHealth();
    res.json({ health });
  });

  app.post('/api/admin/reconcile', requireAuth(), requireAdmin, async (_req: RequestWithAuth, res: Response) => {
    const report = await syncEngine.reconcileOnStartup();
    res.json({ report });
  });

  // =========================================================================
  // Error Handler
  // =========================================================================
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof PathSecurityError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : 'Internal server error';
    const status = message.toLowerCase().includes('not found') ? 404 : 500;
    res.status(status).json({ error: message });
  });

  if (options?.startWorker !== false) {
    void syncEngine.reconcileOnStartup().then(() => {
      syncEngine.start(options?.pollIntervalMs ?? 500);
    });
  }

  return {
    app,
    db,
    config,
    cloudDriver,
    syncEngine,
    close: () => {
      syncEngine.stop();
      db.close();
    },
  };
}

function serializeFile(f: FileRow) {
  return {
    id: f.id,
    relativePath: f.relative_path,
    folderPath: f.folder_path,
    name: f.name,
    mimeType: f.mime_type,
    sizeBytes: f.size_bytes,
    sha256: f.sha256,
    status: f.status,
    localPresent: Boolean(f.local_present),
    cloudPresent: Boolean(f.cloud_present),
    verificationMethod: f.verification_method,
    verifiedAt: f.verified_at,
    lastError: f.last_error,
    generation: f.generation,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
  };
}

async function deleteFileRecord(
  db: Database.Database,
  config: EnvConfig,
  syncEngine: SyncEngine,
  cloudDriver: CloudDriver,
  file: FileRow
): Promise<void> {
  // 1. Mark tombstone immediately so in-flight syncs know the file was deleted
  db.prepare(`UPDATE files SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(
    file.id
  );

  // 2. Abort & cancel any active or queued sync jobs
  syncEngine.cancelJobsForFile(file.id, 'File deleted by user');

  // 3. Remove local staged file if present
  if (file.local_present) {
    try {
      const localPath = resolveUserStagingPath(config.hardDiskPath, file.user_id, file.relative_path);
      if (fs.existsSync(localPath)) {
        fs.unlinkSync(localPath);
      }
    } catch {
      // ignore
    }
  }

  // 4. Remove cloud copy if present (or potentially landed mid-upload)
  if (file.cloud_path) {
    try {
      await cloudDriver.deleteFile(file.cloud_path);
    } catch {
      // best-effort cloud cleanup
    }
  }

  // 5. Mark local_present=0, cloud_present=0 cleanly
  db.prepare(
    `UPDATE files SET local_present = 0, cloud_present = 0, updated_at = datetime('now') WHERE id = ?`
  ).run(file.id);
}
