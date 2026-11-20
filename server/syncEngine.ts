import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { CloudDriver } from './cloudDriver.ts';
import { EnvConfig, getRuntimeSettings } from './config.ts';
import { type FileRow, generateId, logActivity, type SyncJobRow } from './db.ts';
import { buildUserCloudPath, resolveUserStagingPath } from './pathSecurity.ts';

export interface ReconciliationReport {
  cleanedOrphanTempFiles: number;
  expiredUploadSessions: number;
  requeuedInterruptedJobs: number;
  requeuedStagedFiles: number;
  cleanedVerifiedLocalFiles: number;
  markedFailedMissingLocal: number;
}

/**
 * Explicit Sync Pipeline State Machine + Bounded-Concurrency Worker Queue.
 *
 * State transitions persisted in SQLite:
 *   RECEIVING -> STAGED -> QUEUED -> UPLOADING -> VERIFYING -> SYNCED (local deleted) | FAILED
 *
 * Core safety invariants:
 *   1. Local staged copy is NEVER deleted before cloud verification returns verified=true.
 *   2. Every job binds to a file `generation`; overwrites, renames, or deletes increment
 *      generation or set `deleted_at`, preventing stale jobs from touching newer files.
 *   3. Failed jobs retry with exponential backoff (`backoff * 2^(attempts-1)`) up to
 *      `max_attempts`, keeping the local file intact on failure.
 *   4. On startup, `reconcileOnStartup()` recovers interrupted jobs and cleans temp files.
 */
export class SyncEngine {
  private readonly db: Database.Database;
  private readonly config: EnvConfig;
  private driver: CloudDriver;
  private readonly activeAbortControllers = new Map<string, AbortController>();
  private readonly activeJobs = new Set<string>();
  private pollTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(db: Database.Database, config: EnvConfig, driver: CloudDriver) {
    this.db = db;
    this.config = config;
    this.driver = driver;
  }

  public getDriver(): CloudDriver {
    return this.driver;
  }

  /**
   * Replaces the cloud driver (useful in tests for injecting transient failures or verification mismatches).
   */
  public setDriver(driver: CloudDriver): void {
    this.driver = driver;
  }

  /**
   * Startup crash reconciliation: guarantees zero data loss and no stuck jobs
   * after an abrupt kill/restart mid-upload or mid-sync.
   */
  public async reconcileOnStartup(): Promise<ReconciliationReport> {
    const report: ReconciliationReport = {
      cleanedOrphanTempFiles: 0,
      expiredUploadSessions: 0,
      requeuedInterruptedJobs: 0,
      requeuedStagedFiles: 0,
      cleanedVerifiedLocalFiles: 0,
      markedFailedMissingLocal: 0,
    };

    const tmpDir = path.join(this.config.hardDiskPath, '.tmp');
    fs.mkdirSync(tmpDir, { recursive: true });

    // 1. Expire stale upload sessions and delete their partial files
    const nowIso = new Date().toISOString();
    const expiredSessions = this.db
      .prepare(
        `SELECT id, file_id, temp_file_path FROM upload_sessions
         WHERE status = 'ACTIVE' AND expires_at <= ?`
      )
      .all(nowIso) as Array<{ id: string; file_id: string | null; temp_file_path: string }>;

    for (const sess of expiredSessions) {
      try {
        if (fs.existsSync(sess.temp_file_path)) {
          fs.unlinkSync(sess.temp_file_path);
        }
      } catch {
        // ignore
      }
      this.db
        .prepare(`UPDATE upload_sessions SET status = 'EXPIRED', updated_at = datetime('now') WHERE id = ?`)
        .run(sess.id);
      if (sess.file_id) {
        this.db
          .prepare(`DELETE FROM files WHERE id = ? AND status = 'RECEIVING'`)
          .run(sess.file_id);
      }
      report.expiredUploadSessions++;
    }

    // 2. Clean orphaned .part files in <HARD_DISK_PATH>/.tmp not linked to any active upload session
    const activeTempPaths = new Set(
      (
        this.db
          .prepare(`SELECT temp_file_path FROM upload_sessions WHERE status = 'ACTIVE'`)
          .all() as Array<{ temp_file_path: string }>
      ).map((r) => path.resolve(r.temp_file_path))
    );

    if (fs.existsSync(tmpDir)) {
      for (const entry of fs.readdirSync(tmpDir)) {
        const full = path.resolve(tmpDir, entry);
        if (!activeTempPaths.has(full)) {
          try {
            fs.rmSync(full, { recursive: true, force: true });
            report.cleanedOrphanTempFiles++;
          } catch {
            // ignore
          }
        }
      }
    }

    // 3. Reconcile jobs stuck in UPLOADING or VERIFYING from an interrupted run
    const interruptedJobs = this.db
      .prepare(
        `SELECT * FROM sync_jobs WHERE status IN ('UPLOADING', 'VERIFYING')`
      )
      .all() as SyncJobRow[];

    for (const job of interruptedJobs) {
      const file = this.db
        .prepare(`SELECT * FROM files WHERE id = ?`)
        .get(job.file_id) as FileRow | undefined;

      if (!file || file.deleted_at !== null || file.generation !== job.generation) {
        this.db
          .prepare(
            `UPDATE sync_jobs SET status = 'CANCELLED', last_error = 'Superseded or deleted prior to crash recovery', updated_at = datetime('now') WHERE id = ?`
          )
          .run(job.id);
        continue;
      }

      const localPath = this.safeLocalPath(file);
      if (localPath && fs.existsSync(localPath)) {
        // Local file is intact: reset job and file cleanly to QUEUED for immediate retry
        this.db.transaction(() => {
          this.db
            .prepare(
              `UPDATE sync_jobs
               SET status = 'QUEUED', next_run_at = ?, last_error = 'Recovered after server restart', updated_at = datetime('now')
               WHERE id = ?`
            )
            .run(new Date().toISOString(), job.id);
          this.db
            .prepare(
              `UPDATE files SET status = 'QUEUED', local_present = 1, updated_at = datetime('now') WHERE id = ?`
            )
            .run(file.id);
        })();
        report.requeuedInterruptedJobs++;
      } else {
        // Local file missing: verify if it actually landed and matches in cloud
        const verify = await this.driver.verifyFile(job.cloud_relative_path, {
          sizeBytes: file.size_bytes,
          sha256: file.sha256,
          md5: file.md5,
          sha1: file.sha1,
          localMtimeMs: file.local_mtime_ms,
        });
        if (verify.verified) {
          this.db.transaction(() => {
            this.db
              .prepare(
                `UPDATE files
                 SET status = 'SYNCED', local_present = 0, cloud_present = 1,
                     verification_method = ?, verified_at = datetime('now'), last_error = NULL, updated_at = datetime('now')
                 WHERE id = ?`
              )
              .run(verify.method, file.id);
            this.db
              .prepare(
                `UPDATE sync_jobs
                 SET status = 'SYNCED', verification_method = ?, completed_at = datetime('now'), updated_at = datetime('now')
                 WHERE id = ?`
              )
              .run(verify.method, job.id);
          })();
        } else {
          this.db.transaction(() => {
            this.db
              .prepare(
                `UPDATE files SET status = 'FAILED', local_present = 0, last_error = ?, updated_at = datetime('now') WHERE id = ?`
              )
              .run('Local staged file missing after restart and cloud verification failed', file.id);
            this.db
              .prepare(
                `UPDATE sync_jobs SET status = 'FAILED', last_error = ?, updated_at = datetime('now') WHERE id = ?`
              )
              .run('Local staged file missing after restart and cloud verification failed', job.id);
          })();
          report.markedFailedMissingLocal++;
        }
      }
    }

    // 4. Re-queue any STAGED or QUEUED files that have no active sync job
    const unqueuedFiles = this.db
      .prepare(
        `SELECT f.* FROM files f
         WHERE f.deleted_at IS NULL
           AND f.status IN ('STAGED', 'QUEUED')
           AND NOT EXISTS (
             SELECT 1 FROM sync_jobs j
             WHERE j.file_id = f.id AND j.generation = f.generation
               AND j.status IN ('QUEUED', 'UPLOADING', 'VERIFYING')
           )`
      )
      .all() as FileRow[];

    for (const file of unqueuedFiles) {
      const localPath = this.safeLocalPath(file);
      if (localPath && fs.existsSync(localPath)) {
        this.enqueueFile(file.id);
        report.requeuedStagedFiles++;
      } else {
        this.db
          .prepare(
            `UPDATE files SET status = 'FAILED', local_present = 0, last_error = 'Local staged file not found on disk during recovery', updated_at = datetime('now') WHERE id = ?`
          )
          .run(file.id);
        report.markedFailedMissingLocal++;
      }
    }

    // 5. Complete cleanup for files marked SYNCED (verified) where crash happened right before unlink
    const syncedWithLocal = this.db
      .prepare(
        `SELECT * FROM files WHERE status = 'SYNCED' AND local_present = 1 AND deleted_at IS NULL`
      )
      .all() as FileRow[];

    for (const file of syncedWithLocal) {
      const cloudPath = file.cloud_path ?? buildUserCloudPath(file.user_id, file.relative_path);
      const verify = await this.driver.verifyFile(cloudPath, {
        sizeBytes: file.size_bytes,
        sha256: file.sha256,
        md5: file.md5,
        sha1: file.sha1,
        localMtimeMs: file.local_mtime_ms,
      });
      if (verify.verified) {
        const localPath = this.safeLocalPath(file);
        if (localPath && fs.existsSync(localPath)) {
          fs.unlinkSync(localPath);
          this.pruneEmptyParentDirs(localPath, file.user_id);
        }
        this.db
          .prepare(`UPDATE files SET local_present = 0, updated_at = datetime('now') WHERE id = ?`)
          .run(file.id);
        report.cleanedVerifiedLocalFiles++;
      }
    }

    logActivity(this.db, {
      action: 'system.reconcile',
      details: JSON.stringify(report),
      level: 'info',
    });

    return report;
  }

  public start(pollIntervalMs = 500): void {
    this.running = true;
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.tick();
    }, pollIntervalMs);
    void this.tick();
  }

  public stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const controller of this.activeAbortControllers.values()) {
      controller.abort();
    }
    this.activeAbortControllers.clear();
  }

  /**
   * Transitions a STAGED (or FAILED) file into QUEUED and inserts a sync_jobs entry.
   */
  public enqueueFile(fileId: string): SyncJobRow {
    const file = this.db
      .prepare(`SELECT * FROM files WHERE id = ? AND deleted_at IS NULL`)
      .get(fileId) as FileRow | undefined;

    if (!file) {
      throw new Error(`File ${fileId} not found`);
    }

    const settings = getRuntimeSettings(this.db, this.config);
    const cloudPath = buildUserCloudPath(file.user_id, file.relative_path);
    const jobId = generateId('job');

    const job = this.db.transaction(() => {
      // Cancel any older queued/failed jobs for this file
      this.db
        .prepare(
          `UPDATE sync_jobs
           SET status = 'CANCELLED', updated_at = datetime('now')
           WHERE file_id = ? AND status IN ('QUEUED', 'FAILED')`
        )
        .run(file.id);

      this.db
        .prepare(
          `UPDATE files
           SET status = 'QUEUED', cloud_path = ?, last_error = NULL, updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(cloudPath, file.id);

      this.db
        .prepare(
          `INSERT INTO sync_jobs (
             id, file_id, user_id, generation, source_relative_path, cloud_relative_path,
             status, attempts, max_attempts, next_run_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', 0, ?, ?)`
        )
        .run(
          jobId,
          file.id,
          file.user_id,
          file.generation,
          file.relative_path,
          cloudPath,
          settings.syncRetryLimit,
          new Date().toISOString()
        );

      return this.db.prepare('SELECT * FROM sync_jobs WHERE id = ?').get(jobId) as SyncJobRow;
    })();

    // Trigger immediate worker check only if background worker loop is running
    if (this.running) {
      void this.tick();
    }

    return job;
  }

  /**
   * Cancels any active or queued sync jobs for a file (used when a user overwrites,
   * renames, or deletes a file while sync is in progress).
   */
  public cancelJobsForFile(fileId: string, reason: string): void {
    const running = this.db
      .prepare(
        `SELECT id FROM sync_jobs WHERE file_id = ? AND status IN ('QUEUED', 'UPLOADING', 'VERIFYING')`
      )
      .all(fileId) as Array<{ id: string }>;

    this.db
      .prepare(
        `UPDATE sync_jobs
         SET status = 'CANCELLED', last_error = ?, updated_at = datetime('now')
         WHERE file_id = ? AND status IN ('QUEUED', 'UPLOADING', 'VERIFYING')`
      )
      .run(reason, fileId);

    for (const row of running) {
      const ctrl = this.activeAbortControllers.get(row.id);
      if (ctrl) {
        ctrl.abort();
      }
    }
  }

  /**
   * Manually retries a FAILED or CANCELLED sync job (preserving the local staged file).
   */
  public retryJob(jobId: string): SyncJobRow {
    const job = this.db.prepare('SELECT * FROM sync_jobs WHERE id = ?').get(jobId) as
      | SyncJobRow
      | undefined;
    if (!job) {
      throw new Error('Sync job not found');
    }
    const file = this.db
      .prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL')
      .get(job.file_id) as FileRow | undefined;
    if (!file) {
      throw new Error('Associated file no longer exists');
    }
    const localPath = this.safeLocalPath(file);
    if (!localPath || !fs.existsSync(localPath)) {
      throw new Error('Cannot retry: local staged file is no longer on disk');
    }

    return this.enqueueFile(file.id);
  }

  /**
   * Cancels a specific sync job by ID (admin control).
   */
  public cancelJob(jobId: string): void {
    const job = this.db.prepare('SELECT * FROM sync_jobs WHERE id = ?').get(jobId) as
      | SyncJobRow
      | undefined;
    if (!job) {
      throw new Error('Sync job not found');
    }
    const ctrl = this.activeAbortControllers.get(jobId);
    if (ctrl) ctrl.abort();

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE sync_jobs
           SET status = 'CANCELLED', last_error = 'Cancelled by administrator', updated_at = datetime('now')
           WHERE id = ? AND status IN ('QUEUED', 'UPLOADING', 'VERIFYING', 'FAILED')`
        )
        .run(jobId);
      // Keep file safely staged on disk (or failed) without deleting local copy
      this.db
        .prepare(
          `UPDATE files
           SET status = CASE WHEN local_present = 1 THEN 'FAILED' ELSE status END,
               last_error = 'Sync job cancelled by administrator',
               updated_at = datetime('now')
           WHERE id = ? AND generation = ? AND status != 'SYNCED'`
        )
        .run(job.file_id, job.generation);
    })();
  }

  /**
   * Claims eligible QUEUED jobs up to `syncConcurrency` and processes them asynchronously.
   */
  public async tick(): Promise<void> {
    if (!this.running || !this.db.open) return;
    const settings = getRuntimeSettings(this.db, this.config);
    const availableSlots = settings.syncConcurrency - this.activeJobs.size;
    if (availableSlots <= 0) return;

    const nowIso = new Date().toISOString();
    const candidates = this.db
      .prepare(
        `SELECT * FROM sync_jobs
         WHERE status = 'QUEUED' AND next_run_at <= ?
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(nowIso, availableSlots) as SyncJobRow[];

    for (const job of candidates) {
      if (this.activeJobs.has(job.id)) continue;
      this.activeJobs.add(job.id);
      void this.processJob(job.id).finally(() => {
        this.activeJobs.delete(job.id);
        this.activeAbortControllers.delete(job.id);
      });
    }
  }

  /**
   * Processes a single job immediately (also usable deterministically in tests).
   */
  public async processJob(jobId: string): Promise<void> {
    const abortController = new AbortController();
    this.activeAbortControllers.set(jobId, abortController);

    // Atomically transition QUEUED -> UPLOADING
    const claimed = this.db.transaction(() => {
      const job = this.db
        .prepare(`SELECT * FROM sync_jobs WHERE id = ? AND status = 'QUEUED'`)
        .get(jobId) as SyncJobRow | undefined;
      if (!job) return null;

      const file = this.db.prepare('SELECT * FROM files WHERE id = ?').get(job.file_id) as
        | FileRow
        | undefined;
      if (!file || file.deleted_at !== null || file.generation !== job.generation) {
        this.db
          .prepare(
            `UPDATE sync_jobs SET status = 'CANCELLED', last_error = 'File deleted or superseded', updated_at = datetime('now') WHERE id = ?`
          )
          .run(job.id);
        return null;
      }

      const nextAttempts = job.attempts + 1;
      this.db
        .prepare(
          `UPDATE sync_jobs
           SET status = 'UPLOADING', attempts = ?, started_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(nextAttempts, job.id);

      this.db
        .prepare(
          `UPDATE files SET status = 'UPLOADING', last_error = NULL, updated_at = datetime('now') WHERE id = ? AND generation = ?`
        )
        .run(file.id, job.generation);

      return { job: { ...job, attempts: nextAttempts }, file };
    })();

    if (!claimed) return;

    const { job, file } = claimed;
    let localPath: string;
    try {
      localPath = resolveUserStagingPath(this.config.hardDiskPath, file.user_id, file.relative_path);
    } catch (err) {
      this.handleJobFailure(job, file, err instanceof Error ? err.message : 'Invalid local path', true);
      return;
    }

    if (!fs.existsSync(localPath)) {
      this.handleJobFailure(job, file, 'Local staged file missing before upload', true);
      return;
    }

    try {
      // PHASE 1: UPLOADING (local file remains strictly untouched)
      await this.driver.uploadFile(localPath, job.cloud_relative_path, abortController.signal);

      // Re-check generation & deletion before entering VERIFYING
      if (!this.isJobStillCurrent(job)) {
        await this.cleanupStaleCloudObject(job);
        return;
      }

      // PHASE 2: VERIFYING (confirm remote object exists, size matches, checksum/mtime matches)
      this.db.transaction(() => {
        this.db
          .prepare(`UPDATE sync_jobs SET status = 'VERIFYING', updated_at = datetime('now') WHERE id = ?`)
          .run(job.id);
        this.db
          .prepare(`UPDATE files SET status = 'VERIFYING', updated_at = datetime('now') WHERE id = ? AND generation = ?`)
          .run(file.id, job.generation);
      })();

      const verify = await this.driver.verifyFile(
        job.cloud_relative_path,
        {
          sizeBytes: file.size_bytes,
          sha256: file.sha256,
          md5: file.md5,
          sha1: file.sha1,
          localMtimeMs: file.local_mtime_ms,
        },
        abortController.signal
      );

      // Re-check generation & deletion after verification BEFORE ever deleting local file
      if (!this.isJobStillCurrent(job)) {
        await this.cleanupStaleCloudObject(job);
        return;
      }

      if (!verify.verified) {
        // CRITICAL INVARIANT: Verification failed -> DO NOT DELETE LOCAL FILE!
        throw new Error(`Cloud verification failed: ${verify.reason ?? 'checksum/size mismatch'}`);
      }

      // PHASE 3: VERIFIED -> Persist verified state, then delete local staged copy
      const committed = this.db.transaction(() => {
        const currentFile = this.db
          .prepare('SELECT generation, deleted_at FROM files WHERE id = ?')
          .get(file.id) as { generation: number; deleted_at: string | null } | undefined;

        if (!currentFile || currentFile.deleted_at !== null || currentFile.generation !== job.generation) {
          return false;
        }

        this.db
          .prepare(
            `UPDATE files
             SET status = 'SYNCED', cloud_present = 1, cloud_path = ?,
                 verification_method = ?, verified_at = datetime('now'),
                 last_error = NULL, updated_at = datetime('now')
             WHERE id = ? AND generation = ?`
          )
          .run(job.cloud_relative_path, verify.method, file.id, job.generation);

        this.db
          .prepare(
            `UPDATE sync_jobs
             SET status = 'SYNCED', verification_method = ?, last_error = NULL,
                 completed_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ?`
          )
          .run(verify.method, job.id);

        return true;
      })();

      if (!committed) {
        await this.cleanupStaleCloudObject(job);
        return;
      }

      // Only NOW, strictly after verification & DB confirmation, delete the local file!
      try {
        if (fs.existsSync(localPath)) {
          fs.unlinkSync(localPath);
          this.pruneEmptyParentDirs(localPath, file.user_id);
        }
        this.db
          .prepare(
            `UPDATE files SET local_present = 0, updated_at = datetime('now') WHERE id = ? AND generation = ?`
          )
          .run(file.id, job.generation);
      } catch (unlinkErr) {
        // Even if unlink fails temporarily, file is verified in cloud; next reconciliation will clean it up.
        logActivity(this.db, {
          userId: file.user_id,
          action: 'sync.local_cleanup_deferred',
          targetType: 'file',
          targetId: file.id,
          details: unlinkErr instanceof Error ? unlinkErr.message : 'Unlink deferred',
          level: 'warn',
        });
      }

      logActivity(this.db, {
        userId: file.user_id,
        action: 'sync.completed',
        targetType: 'file',
        targetId: file.id,
        details: `Synced "${file.relative_path}" (${file.size_bytes} B), verified via ${verify.method}, local copy removed`,
        level: 'info',
      });
    } catch (err) {
      if (abortController.signal.aborted || !this.isJobStillCurrent(job)) {
        await this.cleanupStaleCloudObject(job);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.handleJobFailure(job, file, message, false);
    }
  }

  private isJobStillCurrent(job: SyncJobRow): boolean {
    const row = this.db
      .prepare(
        `SELECT f.generation, f.deleted_at, j.status AS job_status
         FROM files f
         JOIN sync_jobs j ON j.file_id = f.id
         WHERE f.id = ? AND j.id = ?`
      )
      .get(job.file_id, job.id) as
      | { generation: number; deleted_at: string | null; job_status: string }
      | undefined;

    if (!row) return false;
    if (row.deleted_at !== null) return false;
    if (row.generation !== job.generation) return false;
    if (row.job_status === 'CANCELLED') return false;
    return true;
  }

  private async cleanupStaleCloudObject(job: SyncJobRow): Promise<void> {
    const file = this.db.prepare('SELECT deleted_at, relative_path FROM files WHERE id = ?').get(job.file_id) as
      | { deleted_at: string | null; relative_path: string }
      | undefined;
    // Delete the cloud object only if the file was deleted OR moved to a different path
    if (!file || file.deleted_at !== null || file.relative_path !== job.source_relative_path) {
      try {
        await this.driver.deleteFile(job.cloud_relative_path);
      } catch {
        // best-effort cleanup
      }
    }
  }

  private handleJobFailure(
    job: SyncJobRow,
    file: FileRow,
    errorMessage: string,
    permanent: boolean
  ): void {
    const settings = getRuntimeSettings(this.db, this.config);
    const maxAttempts = job.max_attempts || settings.syncRetryLimit;
    const shouldRetry = !permanent && job.attempts < maxAttempts;

    if (shouldRetry) {
      const backoffMs = settings.syncRetryBackoff * Math.pow(2, Math.max(0, job.attempts - 1));
      const nextRunDate = new Date(Date.now() + backoffMs);
      const nextRunIso = nextRunDate.toISOString();

      this.db.transaction(() => {
        this.db
          .prepare(
            `UPDATE sync_jobs
             SET status = 'QUEUED', next_run_at = ?, last_error = ?, updated_at = datetime('now')
             WHERE id = ? AND status IN ('UPLOADING', 'VERIFYING')`
          )
          .run(nextRunIso, errorMessage, job.id);

        this.db
          .prepare(
            `UPDATE files
             SET status = 'QUEUED', last_error = ?, updated_at = datetime('now')
             WHERE id = ? AND generation = ? AND deleted_at IS NULL`
          )
          .run(`Retry ${job.attempts}/${maxAttempts} scheduled: ${errorMessage}`, file.id, job.generation);
      })();

      logActivity(this.db, {
        userId: file.user_id,
        action: 'sync.retry_scheduled',
        targetType: 'file',
        targetId: file.id,
        details: `Attempt ${job.attempts}/${maxAttempts} failed for "${file.relative_path}": ${errorMessage} (next retry in ${backoffMs}ms)`,
        level: 'warn',
      });
    } else {
      // Exhausted retries: mark FAILED and KEEP local staged file intact!
      this.db.transaction(() => {
        this.db
          .prepare(
            `UPDATE sync_jobs
             SET status = 'FAILED', last_error = ?, completed_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ?`
          )
          .run(errorMessage, job.id);

        this.db
          .prepare(
            `UPDATE files
             SET status = 'FAILED', last_error = ?, updated_at = datetime('now')
             WHERE id = ? AND generation = ? AND deleted_at IS NULL`
          )
          .run(errorMessage, file.id, job.generation);
      })();

      logActivity(this.db, {
        userId: file.user_id,
        action: 'sync.failed',
        targetType: 'file',
        targetId: file.id,
        details: `Sync failed for "${file.relative_path}" after ${job.attempts} attempt(s). Local staging copy retained. Error: ${errorMessage}`,
        level: 'error',
      });
    }
  }

  private safeLocalPath(file: FileRow): string | null {
    try {
      return resolveUserStagingPath(this.config.hardDiskPath, file.user_id, file.relative_path);
    } catch {
      return null;
    }
  }

  private pruneEmptyParentDirs(filePath: string, userId: string): void {
    try {
      const userRoot = resolveUserStagingPath(this.config.hardDiskPath, userId, '', true);
      let cursor = path.dirname(filePath);
      while (cursor.startsWith(userRoot + path.sep)) {
        const entries = fs.readdirSync(cursor);
        if (entries.length === 0) {
          fs.rmdirSync(cursor);
          cursor = path.dirname(cursor);
        } else {
          break;
        }
      }
    } catch {
      // non-fatal
    }
  }

  /**
   * Helper for tests and operational shutdown: waits until all currently executing jobs finish.
   */
  public async waitForIdle(timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pending = this.db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM sync_jobs WHERE status IN ('QUEUED', 'UPLOADING', 'VERIFYING')`
        )
        .get() as { cnt: number };
      if (pending.cnt === 0 && this.activeJobs.size === 0) return;
      await this.tick();
      await new Promise((r) => setTimeout(r, 30));
    }
  }
}
