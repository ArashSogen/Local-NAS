import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { EnvConfig, inspectRcloneConfigSafe, parseCloudRemoteSpec } from './config.ts';

export interface CloudVerifyExpectation {
  sizeBytes: number;
  sha256: string | null;
  md5: string | null;
  sha1: string | null;
  localMtimeMs: number | null;
}

export interface CloudVerifyResult {
  verified: boolean;
  method: 'sha256' | 'md5' | 'sha1' | 'size_mtime' | 'none';
  remoteSize?: number;
  remoteHash?: string;
  reason?: string;
}

export interface CloudHealthResult {
  ok: boolean;
  engine: 'rclone' | 'local-rclone-compat' | 'unconfigured';
  remoteName: string;
  remoteType: string;
  message: string;
}

export interface CloudDriver {
  readonly engine: 'rclone' | 'local-rclone-compat' | 'unconfigured';
  uploadFile(localFilePath: string, cloudRelativePath: string, signal?: AbortSignal): Promise<void>;
  verifyFile(
    cloudRelativePath: string,
    expected: CloudVerifyExpectation,
    signal?: AbortSignal
  ): Promise<CloudVerifyResult>;
  createReadStream(cloudRelativePath: string): Promise<{ stream: Readable; cleanup?: () => void }>;
  deleteFile(cloudRelativePath: string): Promise<void>;
  moveFile(oldCloudRelativePath: string, newCloudRelativePath: string): Promise<void>;
  deleteUserNamespace(userId: string): Promise<void>;
  checkHealth(): Promise<CloudHealthResult>;
}

/**
 * Strips any potential credentials or secret-looking key/value tokens from rclone stderr.
 */
function sanitizeProcessError(stderr: string, configPath: string): string {
  return stderr
    .replace(new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<rclone.conf>')
    .replace(/(token|secret|password|pass|access_key|client_secret)\s*[:=]\s*\S+/gi, '$1=<redacted>')
    .trim()
    .slice(0, 800);
}

function joinCloudTarget(cloudRemote: string, cloudRelativePath: string): string {
  const cleanRel = cloudRelativePath.replace(/^\/+/, '');
  const { remoteName, basePath } = parseCloudRemoteSpec(cloudRemote);
  const cleanBase = basePath.replace(/\/+$/, '');
  if (!cleanBase) {
    return `${remoteName}:${cleanRel}`;
  }
  return `${remoteName}:${cleanBase}/${cleanRel}`;
}

function joinCloudBase(cloudRemote: string): string {
  const { remoteName, basePath } = parseCloudRemoteSpec(cloudRemote);
  const cleanBase = basePath.replace(/\/+$/, '');
  return cleanBase ? `${remoteName}:${cleanBase}` : `${remoteName}:`;
}

/**
 * Primary production CloudDriver using the `rclone` CLI binary.
 * Invokes `rclone` with `shell: false` (immune to shell injection) and passes `--config`.
 */
export class RcloneDriver implements CloudDriver {
  public readonly engine = 'rclone' as const;
  private readonly config: EnvConfig;

  constructor(config: EnvConfig) {
    this.config = config;
  }

  private runRclone(
    args: string[],
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Sync operation aborted'));
        return;
      }

      const fullArgs = ['--config', this.config.rcloneConfigPath, ...args];
      const child = spawn(this.config.rcloneBin, fullArgs, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      const onAbort = () => {
        child.kill('SIGTERM');
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => {
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`rclone execution failed: ${err.message}`));
      });

      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) {
          reject(new Error('Sync operation aborted'));
          return;
        }
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          const cleanErr = sanitizeProcessError(stderr || stdout, this.config.rcloneConfigPath);
          reject(new Error(`rclone exited with code ${code}: ${cleanErr || 'unknown error'}`));
        }
      });
    });
  }

  async uploadFile(
    localFilePath: string,
    cloudRelativePath: string,
    signal?: AbortSignal
  ): Promise<void> {
    const remoteTarget = joinCloudTarget(this.config.cloudRemote, cloudRelativePath);
    await this.runRclone(
      ['copyto', '--no-traverse', '--retries', '1', localFilePath, remoteTarget],
      signal
    );
  }

  async verifyFile(
    cloudRelativePath: string,
    expected: CloudVerifyExpectation,
    signal?: AbortSignal
  ): Promise<CloudVerifyResult> {
    const remoteTarget = joinCloudTarget(this.config.cloudRemote, cloudRelativePath);
    let rawJson: string;
    try {
      const result = await this.runRclone(['lsjson', '--stat', '--hash', remoteTarget], signal);
      rawJson = result.stdout;
    } catch (err) {
      return {
        verified: false,
        method: 'none',
        reason: err instanceof Error ? err.message : 'Remote stat check failed',
      };
    }

    let stat: {
      Size?: number;
      ModTime?: string;
      Hashes?: Record<string, string>;
      IsDir?: boolean;
    };
    try {
      stat = JSON.parse(rawJson);
    } catch {
      return {
        verified: false,
        method: 'none',
        reason: 'Could not parse rclone lsjson metadata',
      };
    }

    if (stat.IsDir) {
      return { verified: false, method: 'none', reason: 'Remote path resolved to a directory' };
    }

    if (typeof stat.Size !== 'number' || stat.Size !== expected.sizeBytes) {
      return {
        verified: false,
        method: 'none',
        remoteSize: stat.Size,
        reason: `Size mismatch: expected ${expected.sizeBytes} bytes, remote has ${stat.Size ?? 'unknown'}`,
      };
    }

    const hashes = stat.Hashes ?? {};
    const normalizedHashes: Record<string, string> = {};
    for (const [k, v] of Object.entries(hashes)) {
      if (typeof v === 'string' && v.trim()) {
        normalizedHashes[k.toLowerCase().replace(/[^a-z0-9]/g, '')] = v.trim().toLowerCase();
      }
    }

    if (normalizedHashes.sha256 && expected.sha256) {
      if (normalizedHashes.sha256 === expected.sha256.toLowerCase()) {
        return {
          verified: true,
          method: 'sha256',
          remoteSize: stat.Size,
          remoteHash: normalizedHashes.sha256,
        };
      }
      return {
        verified: false,
        method: 'sha256',
        remoteSize: stat.Size,
        remoteHash: normalizedHashes.sha256,
        reason: 'SHA-256 checksum mismatch between staging and cloud',
      };
    }

    if (normalizedHashes.md5 && expected.md5) {
      if (normalizedHashes.md5 === expected.md5.toLowerCase()) {
        return {
          verified: true,
          method: 'md5',
          remoteSize: stat.Size,
          remoteHash: normalizedHashes.md5,
        };
      }
      return {
        verified: false,
        method: 'md5',
        remoteSize: stat.Size,
        remoteHash: normalizedHashes.md5,
        reason: 'MD5 checksum mismatch between staging and cloud',
      };
    }

    if (normalizedHashes.sha1 && expected.sha1) {
      if (normalizedHashes.sha1 === expected.sha1.toLowerCase()) {
        return {
          verified: true,
          method: 'sha1',
          remoteSize: stat.Size,
          remoteHash: normalizedHashes.sha1,
        };
      }
      return {
        verified: false,
        method: 'sha1',
        remoteSize: stat.Size,
        remoteHash: normalizedHashes.sha1,
        reason: 'SHA-1 checksum mismatch between staging and cloud',
      };
    }

    // Fallback for cloud providers that do not expose SHA-256/MD5/SHA-1 hashes via lsjson:
    // verify exact byte size + ModTime within 5 seconds of local file mtime (or valid ModTime present).
    if (stat.ModTime) {
      const remoteMtimeMs = Date.parse(stat.ModTime);
      if (!Number.isNaN(remoteMtimeMs)) {
        if (expected.localMtimeMs !== null) {
          const deltaMs = Math.abs(remoteMtimeMs - expected.localMtimeMs);
          // Allow up to 5s clock/fs granularity drift; if remote preserves mtime, this validates tightly
          if (deltaMs <= 5000 || remoteMtimeMs >= expected.localMtimeMs - 5000) {
            return {
              verified: true,
              method: 'size_mtime',
              remoteSize: stat.Size,
            };
          }
          return {
            verified: false,
            method: 'size_mtime',
            remoteSize: stat.Size,
            reason: `Remote modification time (${stat.ModTime}) predates local upload`,
          };
        }
        return { verified: true, method: 'size_mtime', remoteSize: stat.Size };
      }
    }

    return {
      verified: false,
      method: 'none',
      reason: 'Provider returned neither supported checksum nor valid modification timestamp',
    };
  }

  async createReadStream(
    cloudRelativePath: string
  ): Promise<{ stream: Readable; cleanup?: () => void }> {
    const remoteTarget = joinCloudTarget(this.config.cloudRemote, cloudRelativePath);
    const child = spawn(
      this.config.rcloneBin,
      ['--config', this.config.rcloneConfigPath, 'cat', remoteTarget],
      { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    return {
      stream: child.stdout,
      cleanup: () => {
        if (!child.killed) {
          child.kill('SIGTERM');
        }
      },
    };
  }

  async deleteFile(cloudRelativePath: string): Promise<void> {
    const remoteTarget = joinCloudTarget(this.config.cloudRemote, cloudRelativePath);
    try {
      await this.runRclone(['deletefile', remoteTarget]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      // Treat already-absent file as idempotent success
      if (msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('object not found')) {
        return;
      }
      throw err;
    }
  }

  async moveFile(oldCloudRelativePath: string, newCloudRelativePath: string): Promise<void> {
    const src = joinCloudTarget(this.config.cloudRemote, oldCloudRelativePath);
    const dst = joinCloudTarget(this.config.cloudRemote, newCloudRelativePath);
    await this.runRclone(['moveto', src, dst]);
  }

  async deleteUserNamespace(userId: string): Promise<void> {
    const target = joinCloudTarget(this.config.cloudRemote, userId);
    try {
      await this.runRclone(['purge', target]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('directory not found')) {
        return;
      }
      throw err;
    }
  }

  async checkHealth(): Promise<CloudHealthResult> {
    const summary = inspectRcloneConfigSafe(this.config.rcloneConfigPath, this.config.cloudRemote);
    try {
      const base = joinCloudBase(this.config.cloudRemote);
      await this.runRclone(['mkdir', base]);
      return {
        ok: true,
        engine: this.engine,
        remoteName: summary.remoteName,
        remoteType: summary.remoteType,
        message: `Connected to rclone remote "${summary.remoteName}" (${summary.remoteType})`,
      };
    } catch (err) {
      return {
        ok: false,
        engine: this.engine,
        remoteName: summary.remoteName,
        remoteType: summary.remoteType,
        message: err instanceof Error ? err.message : 'Unable to reach rclone remote',
      };
    }
  }
}

/**
 * Local-backend rclone-compatible driver.
 * Used automatically when `rclone` binary is not present on the host AND `rclone.conf`
 * configures a `type = local` remote (ideal for local development, sandbox previews,
 * and hermetic automated test suites).
 */
export class LocalRcloneCompatDriver implements CloudDriver {
  public readonly engine = 'local-rclone-compat' as const;
  private readonly config: EnvConfig;
  private readonly baseDir: string;
  private readonly remoteName: string;

  constructor(config: EnvConfig) {
    this.config = config;
    const { remoteName, basePath } = parseCloudRemoteSpec(config.cloudRemote);
    this.remoteName = remoteName;
    if (!basePath) {
      throw new Error('Local rclone remote requires a base path in CLOUD_REMOTE');
    }
    this.baseDir = path.resolve(basePath);
  }

  private assertRemoteConfigured(): void {
    const summary = inspectRcloneConfigSafe(this.config.rcloneConfigPath, this.config.cloudRemote);
    if (!summary.configPathExists) {
      throw new Error(`rclone config not found at ${this.config.rcloneConfigPath}`);
    }
    if (summary.remoteType !== 'local') {
      throw new Error(
        `rclone binary is not installed; remote "${this.remoteName}" has type "${summary.remoteType}" which requires the rclone CLI`
      );
    }
    // If parent directory or base directory has been intentionally marked unreachable (e.g. a file blocking it or missing unreadable mount)
    if (fs.existsSync(this.baseDir)) {
      const st = fs.lstatSync(this.baseDir);
      if (!st.isDirectory()) {
        throw new Error(`Cloud remote target is unreachable (not a directory): ${this.baseDir}`);
      }
      fs.accessSync(this.baseDir, fs.constants.R_OK | fs.constants.W_OK);
    }
  }

  private resolveTarget(cloudRelativePath: string): string {
    const cleanRel = cloudRelativePath.replace(/^\/+/, '');
    const resolved = path.resolve(this.baseDir, ...cleanRel.split('/'));
    if (resolved !== this.baseDir && !resolved.startsWith(this.baseDir + path.sep)) {
      throw new Error('Cloud target path escapes base remote directory');
    }
    return resolved;
  }

  async uploadFile(
    localFilePath: string,
    cloudRelativePath: string,
    signal?: AbortSignal
  ): Promise<void> {
    this.assertRemoteConfigured();
    if (signal?.aborted) throw new Error('Sync operation aborted');

    const destPath = this.resolveTarget(cloudRelativePath);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    const tmpDest = `${destPath}.rclone_tmp_${crypto.randomBytes(6).toString('hex')}`;
    const srcStat = fs.statSync(localFilePath);

    await new Promise<void>((resolve, reject) => {
      const read = fs.createReadStream(localFilePath);
      const write = fs.createWriteStream(tmpDest);

      const onAbort = () => {
        read.destroy(new Error('Sync operation aborted'));
        write.destroy();
        try {
          if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest);
        } catch {
          // ignore
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      read.on('error', (err) => {
        signal?.removeEventListener('abort', onAbort);
        write.destroy();
        try {
          if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest);
        } catch {
          // ignore
        }
        reject(err);
      });

      write.on('error', (err) => {
        signal?.removeEventListener('abort', onAbort);
        read.destroy();
        try {
          if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest);
        } catch {
          // ignore
        }
        reject(err);
      });

      write.on('finish', () => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) {
          try {
            if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest);
          } catch {
            // ignore
          }
          reject(new Error('Sync operation aborted'));
          return;
        }
        try {
          fs.utimesSync(tmpDest, srcStat.atime, srcStat.mtime);
          fs.renameSync(tmpDest, destPath);
          resolve();
        } catch (err) {
          try {
            if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest);
          } catch {
            // ignore
          }
          reject(err);
        }
      });

      read.pipe(write);
    });
  }

  async verifyFile(
    cloudRelativePath: string,
    expected: CloudVerifyExpectation,
    signal?: AbortSignal
  ): Promise<CloudVerifyResult> {
    try {
      this.assertRemoteConfigured();
    } catch (err) {
      return {
        verified: false,
        method: 'none',
        reason: err instanceof Error ? err.message : 'Cloud remote unavailable',
      };
    }
    if (signal?.aborted) {
      return { verified: false, method: 'none', reason: 'Sync operation aborted' };
    }

    const destPath = this.resolveTarget(cloudRelativePath);
    if (!fs.existsSync(destPath)) {
      return { verified: false, method: 'none', reason: 'Remote file does not exist' };
    }

    const stat = fs.statSync(destPath);
    if (stat.size !== expected.sizeBytes) {
      return {
        verified: false,
        method: 'none',
        remoteSize: stat.size,
        reason: `Size mismatch: expected ${expected.sizeBytes}, remote has ${stat.size}`,
      };
    }

    if (expected.sha256) {
      const remoteSha256 = await computeFileHash(destPath, 'sha256');
      if (remoteSha256 === expected.sha256.toLowerCase()) {
        return {
          verified: true,
          method: 'sha256',
          remoteSize: stat.size,
          remoteHash: remoteSha256,
        };
      }
      return {
        verified: false,
        method: 'sha256',
        remoteSize: stat.size,
        remoteHash: remoteSha256,
        reason: 'SHA-256 checksum mismatch between staged file and cloud copy',
      };
    }

    return { verified: true, method: 'size_mtime', remoteSize: stat.size };
  }

  async createReadStream(
    cloudRelativePath: string
  ): Promise<{ stream: Readable; cleanup?: () => void }> {
    this.assertRemoteConfigured();
    const destPath = this.resolveTarget(cloudRelativePath);
    if (!fs.existsSync(destPath)) {
      throw new Error('File not found on cloud remote');
    }
    const stream = fs.createReadStream(destPath);
    return {
      stream,
      cleanup: () => stream.destroy(),
    };
  }

  async deleteFile(cloudRelativePath: string): Promise<void> {
    this.assertRemoteConfigured();
    const destPath = this.resolveTarget(cloudRelativePath);
    if (fs.existsSync(destPath)) {
      fs.unlinkSync(destPath);
    }
  }

  async moveFile(oldCloudRelativePath: string, newCloudRelativePath: string): Promise<void> {
    this.assertRemoteConfigured();
    const src = this.resolveTarget(oldCloudRelativePath);
    const dst = this.resolveTarget(newCloudRelativePath);
    if (!fs.existsSync(src)) {
      throw new Error('Source cloud object not found for move');
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
  }

  async deleteUserNamespace(userId: string): Promise<void> {
    this.assertRemoteConfigured();
    const userDir = this.resolveTarget(userId);
    if (fs.existsSync(userDir)) {
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  }

  async checkHealth(): Promise<CloudHealthResult> {
    const summary = inspectRcloneConfigSafe(this.config.rcloneConfigPath, this.config.cloudRemote);
    try {
      this.assertRemoteConfigured();
      fs.mkdirSync(this.baseDir, { recursive: true });
      return {
        ok: true,
        engine: this.engine,
        remoteName: summary.remoteName,
        remoteType: summary.remoteType,
        message: `Connected to local rclone remote "${summary.remoteName}" (${this.baseDir})`,
      };
    } catch (err) {
      return {
        ok: false,
        engine: this.engine,
        remoteName: summary.remoteName,
        remoteType: summary.remoteType,
        message: err instanceof Error ? err.message : 'Local cloud remote unreachable',
      };
    }
  }
}

export function computeFileHash(
  filePath: string,
  algorithm: 'sha256' | 'md5' | 'sha1'
): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function computeAllFileHashes(
  filePath: string
): Promise<{ sha256: string; md5: string; sha1: string; sizeBytes: number }> {
  return new Promise((resolve, reject) => {
    const sha256 = crypto.createHash('sha256');
    const md5 = crypto.createHash('md5');
    const sha1 = crypto.createHash('sha1');
    let sizeBytes = 0;

    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk: string | Buffer) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      sizeBytes += buf.length;
      sha256.update(buf);
      md5.update(buf);
      sha1.update(buf);
    });
    stream.on('error', reject);
    stream.on('end', () =>
      resolve({
        sha256: sha256.digest('hex'),
        md5: md5.digest('hex'),
        sha1: sha1.digest('hex'),
        sizeBytes,
      })
    );
  });
}

export function isRcloneBinaryAvailable(rcloneBin: string): boolean {
  try {
    const res = spawnSync(rcloneBin, ['version'], { stdio: 'ignore', timeout: 3000 });
    return res.status === 0;
  } catch {
    return false;
  }
}

export function createCloudDriver(config: EnvConfig): CloudDriver {
  if (isRcloneBinaryAvailable(config.rcloneBin)) {
    return new RcloneDriver(config);
  }
  const summary = inspectRcloneConfigSafe(config.rcloneConfigPath, config.cloudRemote);
  if (summary.remoteType === 'local') {
    return new LocalRcloneCompatDriver(config);
  }
  // Fall back to RcloneDriver so attempting to sync surfaces the real missing-rclone error cleanly
  return new RcloneDriver(config);
}
