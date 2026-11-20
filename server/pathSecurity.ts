import fs from 'node:fs';
import path from 'node:path';

/**
 * Strict path and filename security helpers.
 * All user-facing paths are normalized POSIX-style relative paths without leading
 * or trailing slashes (e.g. "" for root, "Documents/2026/report.pdf").
 * Filesystem resolution always confines operations inside `<hardDiskPath>/<userId>`.
 */

const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255;
// Disallow ASCII control chars, Windows-invalid chars, and NUL
const INVALID_SEGMENT_RE = /[\x00-\x1f\x7f\\:*?"<>|]/;
const RESERVED_SEGMENTS = new Set(['.', '..', '.tmp']);

export class PathSecurityError extends Error {
  public readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'PathSecurityError';
  }
}

/**
 * Validates and sanitizes a single filename or folder name segment.
 */
export function sanitizeSegment(raw: string): string {
  if (typeof raw !== 'string') {
    throw new PathSecurityError('Name must be a string');
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new PathSecurityError('Name cannot be empty');
  }
  if (trimmed.length > MAX_SEGMENT_LENGTH) {
    throw new PathSecurityError(`Name exceeds maximum length (${MAX_SEGMENT_LENGTH})`);
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new PathSecurityError('Name cannot contain path separators');
  }
  if (RESERVED_SEGMENTS.has(trimmed)) {
    throw new PathSecurityError(`Invalid reserved name: ${trimmed}`);
  }
  if (INVALID_SEGMENT_RE.test(trimmed)) {
    throw new PathSecurityError('Name contains prohibited characters');
  }
  return trimmed;
}

/**
 * Validates and normalizes a relative folder or file path (POSIX style).
 * Rejects path traversal (`..`), NUL bytes, backslashes, and absolute roots.
 * Returns "" for root folder when `allowEmpty` is true.
 */
export function normalizeRelativePath(raw: string | undefined | null, allowEmpty = false): string {
  if (raw === undefined || raw === null || raw === '' || raw === '/') {
    if (allowEmpty) return '';
    throw new PathSecurityError('Path cannot be empty');
  }
  if (typeof raw !== 'string') {
    throw new PathSecurityError('Path must be a string');
  }
  if (raw.includes('\0')) {
    throw new PathSecurityError('Path contains null byte');
  }
  if (raw.includes('\\')) {
    throw new PathSecurityError('Backslashes are not permitted in paths');
  }
  // Reject URL-encoded traversal attempts like %2e%2e or %2f
  const lower = raw.toLowerCase();
  if (lower.includes('%2e') || lower.includes('%2f') || lower.includes('%5c') || lower.includes('%00')) {
    throw new PathSecurityError('Encoded traversal characters are not permitted');
  }

  // Strip leading/trailing slashes for normalization, but reject explicit absolute drive roots
  if (/^[a-zA-Z]:/.test(raw)) {
    throw new PathSecurityError('Absolute drive paths are not permitted');
  }

  const stripped = raw.replace(/^\/+|\/+$/g, '');
  if (!stripped) {
    if (allowEmpty) return '';
    throw new PathSecurityError('Path cannot be empty');
  }
  if (stripped.length > MAX_PATH_LENGTH) {
    throw new PathSecurityError(`Path exceeds maximum length (${MAX_PATH_LENGTH})`);
  }

  const parts = stripped.split('/');
  const cleanParts: string[] = [];
  for (const part of parts) {
    if (!part) {
      throw new PathSecurityError('Path contains empty segment');
    }
    if (part === '.' || part === '..') {
      throw new PathSecurityError('Path traversal segments are not permitted');
    }
    cleanParts.push(sanitizeSegment(part));
  }

  return cleanParts.join('/');
}

/**
 * Joins a folder path (possibly "") and a filename segment into a validated relative path.
 */
export function joinRelativePath(folderPath: string, name: string): string {
  const cleanFolder = normalizeRelativePath(folderPath, true);
  const cleanName = sanitizeSegment(name);
  return cleanFolder ? `${cleanFolder}/${cleanName}` : cleanName;
}

/**
 * Splits a validated relative path into { folderPath, name }.
 */
export function splitRelativePath(relativePath: string): { folderPath: string; name: string } {
  const clean = normalizeRelativePath(relativePath, false);
  const idx = clean.lastIndexOf('/');
  if (idx === -1) {
    return { folderPath: '', name: clean };
  }
  return {
    folderPath: clean.slice(0, idx),
    name: clean.slice(idx + 1),
  };
}

/**
 * Validates an internal user ID so it can never inject path segments.
 */
export function assertSafeUserId(userId: string): string {
  if (!userId || !/^[a-zA-Z0-9_-]{4,64}$/.test(userId)) {
    throw new PathSecurityError('Invalid user namespace identifier');
  }
  return userId;
}

/**
 * Returns the canonical root directory for a user on the staging hard disk:
 * `<hardDiskPath>/<userId>`
 */
export function getUserStagingRoot(hardDiskPath: string, userId: string): string {
  const safeId = assertSafeUserId(userId);
  const baseResolved = path.resolve(hardDiskPath);
  const userRoot = path.resolve(baseResolved, safeId);
  if (!userRoot.startsWith(baseResolved + path.sep)) {
    throw new PathSecurityError('User staging root escapes base hard disk path');
  }
  return userRoot;
}

/**
 * Resolves a user's relative file path to an absolute filesystem path inside
 * `<hardDiskPath>/<userId>/...`, verifying both lexical containment AND
 * realpath/symlink containment so symlinks can never escape the user's namespace.
 */
export function resolveUserStagingPath(
  hardDiskPath: string,
  userId: string,
  relativePath: string,
  allowRoot = false
): string {
  const userRoot = getUserStagingRoot(hardDiskPath, userId);
  const cleanRel = normalizeRelativePath(relativePath, allowRoot);

  // Ensure the staging root exists so realpath checks work reliably
  fs.mkdirSync(userRoot, { recursive: true });
  const realUserRoot = fs.realpathSync(userRoot);

  const target = cleanRel ? path.resolve(realUserRoot, ...cleanRel.split('/')) : realUserRoot;

  if (target !== realUserRoot && !target.startsWith(realUserRoot + path.sep)) {
    throw new PathSecurityError('Resolved path escapes user staging directory');
  }

  // Walk every existing ancestor segment from realUserRoot downwards to reject symlinks
  if (cleanRel) {
    let cursor = realUserRoot;
    for (const seg of cleanRel.split('/')) {
      cursor = path.join(cursor, seg);
      if (fs.existsSync(cursor)) {
        const stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink()) {
          throw new PathSecurityError('Symbolic links are not permitted in user storage');
        }
        const realCursor = fs.realpathSync(cursor);
        if (realCursor !== realUserRoot && !realCursor.startsWith(realUserRoot + path.sep)) {
          throw new PathSecurityError('Symlink escape detected outside user namespace');
        }
      } else {
        break;
      }
    }
  }

  return target;
}

/**
 * Builds the cloud relative path `<userId>/<relativePath>` (POSIX style).
 */
export function buildUserCloudPath(userId: string, relativePath: string): string {
  const safeId = assertSafeUserId(userId);
  const cleanRel = normalizeRelativePath(relativePath, false);
  return `${safeId}/${cleanRel}`;
}
