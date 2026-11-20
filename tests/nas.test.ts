import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNasApp, type NasApplicationContext } from '../server/app.ts';
import {
  type CloudDriver,
  type CloudVerifyExpectation,
  type CloudVerifyResult,
  LocalRcloneCompatDriver,
} from '../server/cloudDriver.ts';
import { loadEnvConfig } from '../server/config.ts';
import {
  normalizeRelativePath,
  PathSecurityError,
  resolveUserStagingPath,
} from '../server/pathSecurity.ts';

interface TestHarness {
  ctx: NasApplicationContext;
  baseUrl: string;
  tmpRoot: string;
  stagingDir: string;
  cloudDir: string;
  rcloneConfPath: string;
  close: () => Promise<void>;
}

async function createTestHarness(overrides?: {
  syncRetryLimit?: number;
  syncRetryBackoff?: number;
  startWorker?: boolean;
  customStagingDir?: string;
  customCloudDir?: string;
}): Promise<TestHarness> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultstage-test-'));
  const stagingDir = overrides?.customStagingDir ?? path.join(tmpRoot, 'staging');
  const cloudDir = overrides?.customCloudDir ?? path.join(tmpRoot, 'cloud');
  const dbPath = path.join(tmpRoot, 'db', 'nas.sqlite');
  const rcloneConfPath = path.join(tmpRoot, 'rclone', 'rclone.conf');

  fs.mkdirSync(path.dirname(rcloneConfPath), { recursive: true });
  fs.mkdirSync(cloudDir, { recursive: true });
  fs.writeFileSync(rcloneConfPath, `[testcloud]\ntype = local\n`, 'utf8');

  const config = loadEnvConfig({
    hardDiskPath: stagingDir,
    cloudRemote: `testcloud:${cloudDir}`,
    rcloneConfigPath: rcloneConfPath,
    databaseUrl: dbPath,
    secretKey: 'test-secret-key-0123456789abcdef0123456789abcdef',
    adminUsername: 'admin',
    adminPassword: 'initial-admin-password',
    syncConcurrency: 2,
    syncRetryLimit: overrides?.syncRetryLimit ?? 3,
    syncRetryBackoff: overrides?.syncRetryBackoff ?? 40,
    uploadChunkSize: 64 * 1024,
  });

  const ctx = createNasApp(config, {
    startWorker: overrides?.startWorker ?? false,
    pollIntervalMs: 30,
  });

  const server = http.createServer(ctx.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    ctx,
    baseUrl,
    tmpRoot,
    stagingDir,
    cloudDir,
    rcloneConfPath,
    close: async () => {
      ctx.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

async function apiCall(
  baseUrl: string,
  urlPath: string,
  opts?: {
    method?: string;
    token?: string;
    body?: unknown;
    rawBody?: Buffer;
    headers?: Record<string, string>;
  }
): Promise<{ status: number; json: any; buffer: Buffer; headers: Headers }> {
  const headers: Record<string, string> = { ...(opts?.headers ?? {}) };
  if (opts?.token) {
    headers.Authorization = `Bearer ${opts.token}`;
  }
  let body: BodyInit | undefined;
  if (opts?.rawBody) {
    body = new Uint8Array(opts.rawBody);
  } else if (opts?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: opts?.method ?? 'GET',
    headers,
    body,
  });
  const arrayBuf = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  let json: any = null;
  try {
    json = JSON.parse(buffer.toString('utf8'));
  } catch {
    // non-json response (e.g. binary download)
  }
  return { status: res.status, json, buffer, headers: res.headers };
}

async function loginAndBootstrapAdmin(baseUrl: string): Promise<{ token: string; userId: string }> {
  const login = await apiCall(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'initial-admin-password' },
  });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.mustChangePassword, true);

  const token = login.json.token as string;
  // Verify forced password change blocks normal endpoints
  const blocked = await apiCall(baseUrl, '/api/files', { token });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.code, 'PASSWORD_CHANGE_REQUIRED');

  const changed = await apiCall(baseUrl, '/api/auth/change-password', {
    method: 'POST',
    token,
    body: { currentPassword: 'initial-admin-password', newPassword: 'strong-admin-password-1' },
  });
  assert.equal(changed.status, 200);
  return { token, userId: login.json.user.id };
}

async function uploadBufferChunked(
  baseUrl: string,
  token: string,
  fileName: string,
  folderPath: string,
  payload: Buffer,
  chunkSize = 1024
): Promise<{ file: any; job: any }> {
  const init = await apiCall(baseUrl, '/api/uploads/init', {
    method: 'POST',
    token,
    body: {
      folderPath,
      fileName,
      sizeBytes: payload.length,
      mimeType: 'application/octet-stream',
    },
  });
  assert.equal(init.status, 201, `Upload init failed: ${JSON.stringify(init.json)}`);
  const uploadId = init.json.uploadId as string;

  let offset = 0;
  while (offset < payload.length) {
    const slice = payload.subarray(offset, Math.min(offset + chunkSize, payload.length));
    const put = await apiCall(baseUrl, `/api/uploads/${uploadId}/chunk?offset=${offset}`, {
      method: 'PUT',
      token,
      rawBody: slice,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    assert.equal(put.status, 200);
    offset = put.json.receivedBytes;
  }

  const complete = await apiCall(baseUrl, `/api/uploads/${uploadId}/complete`, {
    method: 'POST',
    token,
  });
  assert.equal(complete.status, 201, `Upload complete failed: ${JSON.stringify(complete.json)}`);
  return complete.json;
}

// ============================================================================
// TEST 1: User Isolation & Role-Based Access Control
// ============================================================================
test('User isolation: two users cannot see, download, rename, search, or delete each other files', async () => {
  const h = await createTestHarness({ startWorker: false });
  try {
    const admin = await loginAndBootstrapAdmin(h.baseUrl);

    // Admin creates Alice and Bob
    const createAlice = await apiCall(h.baseUrl, '/api/admin/users', {
      method: 'POST',
      token: admin.token,
      body: {
        username: 'alice',
        displayName: 'Alice',
        password: 'alice-password-123',
        role: 'user',
        mustChangePassword: false,
      },
    });
    assert.equal(createAlice.status, 201);

    const createBob = await apiCall(h.baseUrl, '/api/admin/users', {
      method: 'POST',
      token: admin.token,
      body: {
        username: 'bob',
        displayName: 'Bob',
        password: 'bob-password-123',
        role: 'user',
        mustChangePassword: false,
      },
    });
    assert.equal(createBob.status, 201);

    const aliceLogin = await apiCall(h.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'alice', password: 'alice-password-123' },
    });
    const bobLogin = await apiCall(h.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'bob', password: 'bob-password-123' },
    });
    const aliceToken = aliceLogin.json.token as string;
    const bobToken = bobLogin.json.token as string;

    // Regular users are blocked from admin endpoints
    const bobAdminAttempt = await apiCall(h.baseUrl, '/api/admin/users', { token: bobToken });
    assert.equal(bobAdminAttempt.status, 403);

    // Alice uploads a secret file
    const alicePayload = Buffer.from('Top secret payroll ledger for Alice only');
    const uploaded = await uploadBufferChunked(h.baseUrl, aliceToken, 'secret.txt', 'private', alicePayload);
    const aliceFileId = uploaded.file.id as string;

    // Sync to cloud so we test isolation after local deletion too
    await h.ctx.syncEngine.processJob(uploaded.job.id);

    // Bob lists files and searches for "secret" -> sees nothing
    const bobList = await apiCall(h.baseUrl, '/api/files', { token: bobToken });
    assert.equal(bobList.status, 200);
    assert.equal(bobList.json.files.length, 0);

    const bobSearch = await apiCall(h.baseUrl, '/api/files?q=secret', { token: bobToken });
    assert.equal(bobSearch.status, 200);
    assert.equal(bobSearch.json.files.length, 0);

    // Bob tries direct file ID access (inspect, download, rename, delete) -> all 404
    assert.equal((await apiCall(h.baseUrl, `/api/files/${aliceFileId}`, { token: bobToken })).status, 404);
    assert.equal(
      (await apiCall(h.baseUrl, `/api/files/${aliceFileId}/download`, { token: bobToken })).status,
      404
    );
    assert.equal(
      (
        await apiCall(h.baseUrl, `/api/files/${aliceFileId}`, {
          method: 'PATCH',
          token: bobToken,
          body: { name: 'stolen.txt' },
        })
      ).status,
      404
    );
    assert.equal(
      (await apiCall(h.baseUrl, `/api/files/${aliceFileId}`, { method: 'DELETE', token: bobToken })).status,
      404
    );

    // Even admin cannot directly read Alice's personal file via /api/files/:id
    assert.equal(
      (await apiCall(h.baseUrl, `/api/files/${aliceFileId}/download`, { token: admin.token })).status,
      404
    );

    // Alice can still download her own file from cloud
    const aliceDl = await apiCall(h.baseUrl, `/api/files/${aliceFileId}/download`, { token: aliceToken });
    assert.equal(aliceDl.status, 200);
    assert.equal(aliceDl.headers.get('x-storage-source'), 'cloud');
    assert.deepEqual(aliceDl.buffer, alicePayload);
  } finally {
    await h.close();
  }
});

// ============================================================================
// TEST 2: Path Traversal & Symlink Escape Protection
// ============================================================================
test('Path security: blocks traversal, encoded traversal, null bytes, and symlink escapes', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultstage-path-'));
  try {
    const stagingDir = path.join(tmpRoot, 'staging');
    const outsideSecret = path.join(tmpRoot, 'outside-secret.txt');
    fs.writeFileSync(outsideSecret, 'host-secret');

    const badPaths = [
      '../etc/passwd',
      'docs/../../other-user/secret.txt',
      'docs/%2e%2e/secret.txt',
      'docs/..\\secret.txt',
      'file\0name.txt',
      'C:/Windows/System32',
      '.tmp/leak.part',
    ];

    for (const p of badPaths) {
      assert.throws(() => normalizeRelativePath(p), PathSecurityError, `Should reject path: ${p}`);
    }

    // Create a symlink inside user's staging namespace pointing outside
    const userDir = path.join(stagingDir, 'usr_testuser01');
    fs.mkdirSync(userDir, { recursive: true });
    fs.symlinkSync(tmpRoot, path.join(userDir, 'escape_link'));

    assert.throws(
      () => resolveUserStagingPath(stagingDir, 'usr_testuser01', 'escape_link/outside-secret.txt'),
      PathSecurityError,
      'Must block symlink escape outside user staging directory'
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// TEST 3: State Machine, "No Local Delete Before Verification", & Cloud Download
// ============================================================================
test('Sync pipeline: never deletes local file before verification succeeds, deletes only after verified', async () => {
  const h = await createTestHarness({ startWorker: false, syncRetryLimit: 1 });
  try {
    const admin = await loginAndBootstrapAdmin(h.baseUrl);
    const payload = crypto.randomBytes(150 * 1024); // 150 KiB multi-chunk upload
    const expectedSha256 = crypto.createHash('sha256').update(payload).digest('hex');

    const uploaded = await uploadBufferChunked(
      h.baseUrl,
      admin.token,
      'archive.bin',
      'backups/2026',
      payload,
      32 * 1024
    );

    const fileId = uploaded.file.id as string;
    const jobId = uploaded.job.id as string;
    const localFilePath = path.join(h.stagingDir, admin.userId, 'backups', '2026', 'archive.bin');
    const cloudFilePath = path.join(h.cloudDir, admin.userId, 'backups', '2026', 'archive.bin');

    // After chunked upload completes: file is QUEUED, local copy exists, SHA-256 stored
    assert.equal(uploaded.file.status, 'QUEUED');
    assert.equal(uploaded.file.sha256, expectedSha256);
    assert.equal(fs.existsSync(localFilePath), true, 'File must be staged on local hard disk');

    // Wrap the real local driver to observe state transitions AND simulate a verification failure first
    const realDriver = new LocalRcloneCompatDriver(h.ctx.config);
    let failVerifyOnce = true;
    const observedDuringVerify: { localExistsDuringVerify: boolean; dbStatusDuringVerify: string }[] = [];

    const spyDriver: CloudDriver = {
      engine: realDriver.engine,
      uploadFile: (l, c, s) => realDriver.uploadFile(l, c, s),
      verifyFile: async (c: string, expected: CloudVerifyExpectation, s?: AbortSignal): Promise<CloudVerifyResult> => {
        const row = h.ctx.db.prepare('SELECT status FROM files WHERE id = ?').get(fileId) as {
          status: string;
        };
        observedDuringVerify.push({
          localExistsDuringVerify: fs.existsSync(localFilePath),
          dbStatusDuringVerify: row.status,
        });
        if (failVerifyOnce) {
          failVerifyOnce = false;
          return {
            verified: false,
            method: 'sha256',
            reason: 'Simulated corrupted cloud checksum',
          };
        }
        return realDriver.verifyFile(c, expected, s);
      },
      createReadStream: (c) => realDriver.createReadStream(c),
      deleteFile: (c) => realDriver.deleteFile(c),
      moveFile: (a, b) => realDriver.moveFile(a, b),
      deleteUserNamespace: (u) => realDriver.deleteUserNamespace(u),
      checkHealth: () => realDriver.checkHealth(),
    };
    h.ctx.syncEngine.setDriver(spyDriver);

    // Attempt 1: verification fails -> local file MUST NOT be deleted!
    await h.ctx.syncEngine.processJob(jobId);

    assert.equal(observedDuringVerify.length, 1);
    assert.equal(observedDuringVerify[0].dbStatusDuringVerify, 'VERIFYING');
    assert.equal(
      observedDuringVerify[0].localExistsDuringVerify,
      true,
      'Local file must still exist while VERIFYING'
    );
    assert.equal(
      fs.existsSync(localFilePath),
      true,
      'CRITICAL: Local file MUST NOT be deleted when verification fails'
    );

    const failedFile = h.ctx.db.prepare('SELECT status, local_present, last_error FROM files WHERE id = ?').get(fileId) as any;
    assert.equal(failedFile.status, 'FAILED');
    assert.equal(failedFile.local_present, 1);
    assert.match(failedFile.last_error, /checksum/i);

    // Attempt 2: admin retries job -> verification succeeds -> local file deleted, cloud copy verified
    const retryRes = await apiCall(h.baseUrl, `/api/admin/sync-jobs/${jobId}/retry`, {
      method: 'POST',
      token: admin.token,
    });
    assert.equal(retryRes.status, 200);
    await h.ctx.syncEngine.processJob(retryRes.json.job.id);

    assert.equal(fs.existsSync(cloudFilePath), true, 'Cloud copy must exist after sync');
    assert.equal(fs.existsSync(localFilePath), false, 'Local copy must be deleted after verified sync');

    const syncedFile = h.ctx.db
      .prepare('SELECT status, local_present, cloud_present, verification_method FROM files WHERE id = ?')
      .get(fileId) as any;
    assert.equal(syncedFile.status, 'SYNCED');
    assert.equal(syncedFile.local_present, 0);
    assert.equal(syncedFile.cloud_present, 1);
    assert.equal(syncedFile.verification_method, 'sha256');

    // Reading after local deletion: streams exact bytes from cloud
    const dl = await apiCall(h.baseUrl, `/api/files/${fileId}/download`, { token: admin.token });
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('x-storage-source'), 'cloud');
    assert.equal(crypto.createHash('sha256').update(dl.buffer).digest('hex'), expectedSha256);
  } finally {
    await h.close();
  }
});

// ============================================================================
// TEST 4: Cloud Unreachable -> Exponential Backoff Retries -> FAILED -> Recovery
// ============================================================================
test('Retry on failure: unreachable cloud retries up to limit, preserves local file, surfaces FAILED', async () => {
  const h = await createTestHarness({ startWorker: false, syncRetryLimit: 3, syncRetryBackoff: 30 });
  try {
    const admin = await loginAndBootstrapAdmin(h.baseUrl);
    const payload = Buffer.from('Important document uploaded during cloud outage');

    const uploaded = await uploadBufferChunked(h.baseUrl, admin.token, 'outage.txt', '', payload);
    const fileId = uploaded.file.id as string;
    const jobId = uploaded.job.id as string;
    const localFilePath = path.join(h.stagingDir, admin.userId, 'outage.txt');

    // Inject unreachable cloud driver
    let uploadAttempts = 0;
    const realDriver = new LocalRcloneCompatDriver(h.ctx.config);
    h.ctx.syncEngine.setDriver({
      ...realDriver,
      engine: realDriver.engine,
      uploadFile: async () => {
        uploadAttempts++;
        throw new Error('dial tcp: connection refused (cloud remote unreachable)');
      },
      verifyFile: (c, e, s) => realDriver.verifyFile(c, e, s),
      createReadStream: (c) => realDriver.createReadStream(c),
      deleteFile: (c) => realDriver.deleteFile(c),
      moveFile: (a, b) => realDriver.moveFile(a, b),
      deleteUserNamespace: (u) => realDriver.deleteUserNamespace(u),
      checkHealth: () => realDriver.checkHealth(),
    });

    // Run worker loop until job exhausts all 3 attempts with exponential backoff
    h.ctx.syncEngine.start(20);
    await h.ctx.syncEngine.waitForIdle(5000);
    h.ctx.syncEngine.stop();

    assert.equal(uploadAttempts, 3, 'Must retry exactly up to SYNC_RETRY_LIMIT (3)');
    assert.equal(fs.existsSync(localFilePath), true, 'Local staging file must remain intact on outage');

    const fileRow = h.ctx.db.prepare('SELECT status, local_present, last_error FROM files WHERE id = ?').get(fileId) as any;
    assert.equal(fileRow.status, 'FAILED');
    assert.equal(fileRow.local_present, 1);
    assert.match(fileRow.last_error, /connection refused/i);

    // User can still download the file directly from staging while cloud is down!
    const stagedDl = await apiCall(h.baseUrl, `/api/files/${fileId}/download`, { token: admin.token });
    assert.equal(stagedDl.status, 200);
    assert.equal(stagedDl.headers.get('x-storage-source'), 'staging');
    assert.deepEqual(stagedDl.buffer, payload);

    // Cloud comes back online -> Admin retries -> Sync succeeds
    h.ctx.syncEngine.setDriver(realDriver);
    const retryRes = await apiCall(h.baseUrl, `/api/admin/sync-jobs/${jobId}/retry`, {
      method: 'POST',
      token: admin.token,
    });
    assert.equal(retryRes.status, 200);
    await h.ctx.syncEngine.processJob(retryRes.json.job.id);

    const recovered = h.ctx.db.prepare('SELECT status, local_present, cloud_present FROM files WHERE id = ?').get(fileId) as any;
    assert.equal(recovered.status, 'SYNCED');
    assert.equal(recovered.local_present, 0);
    assert.equal(recovered.cloud_present, 1);
  } finally {
    await h.close();
  }
});

// ============================================================================
// TEST 5: Crash Recovery & Startup Reconciliation
// ============================================================================
test('Crash recovery: reconciles stuck UPLOADING jobs, orphaned temp files, and leftover verified files', async () => {
  const h = await createTestHarness({ startWorker: false });
  try {
    const admin = await loginAndBootstrapAdmin(h.baseUrl);
    const payload = Buffer.from('Crash resilient payload');
    const uploaded = await uploadBufferChunked(h.baseUrl, admin.token, 'crash-test.dat', '', payload);
    const fileId = uploaded.file.id as string;
    const jobId = uploaded.job.id as string;

    // 1. Simulate crash mid-upload: mark DB rows stuck in UPLOADING
    h.ctx.db.prepare(`UPDATE sync_jobs SET status = 'UPLOADING' WHERE id = ?`).run(jobId);
    h.ctx.db.prepare(`UPDATE files SET status = 'UPLOADING' WHERE id = ?`).run(fileId);

    // 2. Plant an orphaned temp file in <HARD_DISK_PATH>/.tmp/
    const orphanPart = path.join(h.stagingDir, '.tmp', 'upl_orphaned_crash.part');
    fs.writeFileSync(orphanPart, 'partial garbage bytes');

    // Run startup reconciliation (same routine invoked on container restart)
    const report = await h.ctx.syncEngine.reconcileOnStartup();

    assert.equal(report.requeuedInterruptedJobs, 1, 'Should re-queue stuck UPLOADING job');
    assert.equal(report.cleanedOrphanTempFiles, 1, 'Should delete orphaned .part temp file');
    assert.equal(fs.existsSync(orphanPart), false, 'Orphaned temp file must be removed');

    const recoveredJob = h.ctx.db.prepare('SELECT status FROM sync_jobs WHERE id = ?').get(jobId) as {
      status: string;
    };
    assert.equal(recoveredJob.status, 'QUEUED', 'Interrupted job must return to QUEUED');

    // Process the recovered job and verify zero data loss
    await h.ctx.syncEngine.processJob(jobId);
    const dl = await apiCall(h.baseUrl, `/api/files/${fileId}/download`, { token: admin.token });
    assert.equal(dl.status, 200);
    assert.deepEqual(dl.buffer, payload);
  } finally {
    await h.close();
  }
});

// ============================================================================
// TEST 6: Overwrite & Delete While Sync In Progress (Generation Safety)
// ============================================================================
test('Edge cases: overwriting a file while queued supersedes stale job without losing new version', async () => {
  const h = await createTestHarness({ startWorker: false });
  try {
    const admin = await loginAndBootstrapAdmin(h.baseUrl);
    const v1 = Buffer.from('version 1 content');
    const v2 = Buffer.from('version 2 brand new content with different length');

    const first = await uploadBufferChunked(h.baseUrl, admin.token, 'doc.txt', '', v1);
    const second = await uploadBufferChunked(h.baseUrl, admin.token, 'doc.txt', '', v2);

    assert.equal(first.file.id, second.file.id, 'Overwrite should update same file record');
    assert.equal(second.file.generation, 2, 'Generation must increment on overwrite');

    const oldJob = h.ctx.db.prepare('SELECT status FROM sync_jobs WHERE id = ?').get(first.job.id) as {
      status: string;
    };
    assert.equal(oldJob.status, 'CANCELLED', 'Stale job from v1 must be cancelled');

    // Attempt to run stale job (should be no-op) then run v2 job
    await h.ctx.syncEngine.processJob(first.job.id);
    await h.ctx.syncEngine.processJob(second.job.id);

    const dl = await apiCall(h.baseUrl, `/api/files/${second.file.id}/download`, { token: admin.token });
    assert.equal(dl.status, 200);
    assert.deepEqual(dl.buffer, v2, 'Cloud file must strictly match v2 content');
  } finally {
    await h.close();
  }
});

// ============================================================================
// TEST 7: Env-Configurable HARD_DISK_PATH and CLOUD_REMOTE
// ============================================================================
test('Configuration: changing HARD_DISK_PATH and CLOUD_REMOTE routes storage without code changes', async () => {
  const customBase = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultstage-custom-env-'));
  const customStaging = path.join(customBase, 'alt-hard-disk');
  const customCloud = path.join(customBase, 'alt-cloud-drive');

  const h = await createTestHarness({
    startWorker: false,
    customStagingDir: customStaging,
    customCloudDir: customCloud,
  });

  try {
    const admin = await loginAndBootstrapAdmin(h.baseUrl);
    const payload = Buffer.from('Routed via custom env paths');
    const uploaded = await uploadBufferChunked(h.baseUrl, admin.token, 'env-check.txt', '', payload);

    const expectedStaged = path.join(customStaging, admin.userId, 'env-check.txt');
    const expectedCloud = path.join(customCloud, admin.userId, 'env-check.txt');

    assert.equal(fs.existsSync(expectedStaged), true, 'Must stage inside custom HARD_DISK_PATH');
    await h.ctx.syncEngine.processJob(uploaded.job.id);
    assert.equal(fs.existsSync(expectedStaged), false, 'Must remove from custom HARD_DISK_PATH after verify');
    assert.equal(fs.existsSync(expectedCloud), true, 'Must land inside custom CLOUD_REMOTE');
  } finally {
    await h.close();
    fs.rmSync(customBase, { recursive: true, force: true });
  }
});
