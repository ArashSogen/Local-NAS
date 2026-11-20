import bcrypt from 'bcryptjs';
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { EnvConfig } from './config.ts';
import { generateId, type UserRow } from './db.ts';

export const SESSION_COOKIE_NAME = 'vaultstage_session';
export const CSRF_COOKIE_NAME = 'vaultstage_csrf';

export interface AuthenticatedUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'user';
  isActive: boolean;
  mustChangePassword: boolean;
  quotaBytes: number;
}

export interface RequestWithAuth extends Request {
  authUser?: AuthenticatedUser;
  authSessionId?: string;
  authCsrfToken?: string;
  authSource?: 'cookie' | 'bearer';
}

export function getBcryptRounds(): number {
  const parsed = Number.parseInt(process.env.BCRYPT_ROUNDS ?? '', 10);
  if (!Number.isNaN(parsed) && parsed >= 4 && parsed <= 14) return parsed;
  return 12;
}

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, getBcryptRounds());
}

export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash);
}

export function hashSessionToken(token: string, secretKey: string): string {
  return crypto.createHmac('sha256', secretKey).update(token).digest('hex');
}

export function createSession(
  db: Database.Database,
  config: EnvConfig,
  userId: string,
  meta: { ip?: string; userAgent?: string }
): { token: string; csrfToken: string; expiresAt: string; sessionId: string } {
  const sessionId = generateId('ses');
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(token, config.secretKey);
  const csrfToken = crypto.randomBytes(24).toString('hex');
  const expiresMs = Date.now() + config.sessionTtlHours * 3600 * 1000;
  const expiresAt = new Date(expiresMs).toISOString();

  db.prepare(
    `INSERT INTO sessions (id, token_hash, csrf_token, user_id, ip_address, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, tokenHash, csrfToken, userId, meta.ip ?? null, meta.userAgent ?? null, expiresAt);

  // Opportunistic cleanup of expired sessions
  db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(new Date().toISOString());

  return { token, csrfToken, expiresAt, sessionId };
}

export function destroySession(db: Database.Database, sessionId: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function destroyAllUserSessions(db: Database.Database, userId: string): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function isRequestSecure(req: Request): boolean {
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',')[0].trim() === 'https') return true;
  return false;
}

export function setAuthCookies(
  req: Request,
  res: Response,
  token: string,
  csrfToken: string,
  ttlHours: number
): void {
  const secure = isRequestSecure(req);
  const maxAgeSec = ttlHours * 3600;
  // Use SameSite=None; Secure; Partitioned when served over HTTPS (works inside iframes & reverse proxies)
  // and SameSite=Lax on plain local HTTP.
  const commonFlags = secure
    ? `Path=/; Max-Age=${maxAgeSec}; SameSite=None; Secure; Partitioned`
    : `Path=/; Max-Age=${maxAgeSec}; SameSite=Lax`;

  res.append('Set-Cookie', `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; ${commonFlags}`);
  res.append('Set-Cookie', `${CSRF_COOKIE_NAME}=${encodeURIComponent(csrfToken)}; ${commonFlags}`);
}

export function clearAuthCookies(req: Request, res: Response): void {
  const secure = isRequestSecure(req);
  const commonFlags = secure
    ? 'Path=/; Max-Age=0; SameSite=None; Secure; Partitioned'
    : 'Path=/; Max-Age=0; SameSite=Lax';
  res.append('Set-Cookie', `${SESSION_COOKIE_NAME}=; HttpOnly; ${commonFlags}`);
  res.append('Set-Cookie', `${CSRF_COOKIE_NAME}=; ${commonFlags}`);
}

/**
 * Sliding-window login rate limiter keyed by client IP and attempted username.
 * Protects against credential stuffing & brute-force login attempts.
 */
export class LoginRateLimiter {
  private readonly attempts = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxAttempts: number;

  constructor(maxAttempts = 10, windowMs = 15 * 60 * 1000) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
  }

  private prune(key: string, now: number): number[] {
    const list = this.attempts.get(key) ?? [];
    const cutoff = now - this.windowMs;
    const recent = list.filter((t) => t > cutoff);
    if (recent.length === 0) {
      this.attempts.delete(key);
    } else {
      this.attempts.set(key, recent);
    }
    return recent;
  }

  check(ip: string, username: string): { allowed: boolean; retryAfterSec: number } {
    const now = Date.now();
    const ipKey = `ip:${ip}`;
    const userKey = `usr:${ip}:${username.toLowerCase()}`;
    const ipList = this.prune(ipKey, now);
    const userList = this.prune(userKey, now);

    if (userList.length >= this.maxAttempts || ipList.length >= this.maxAttempts * 3) {
      const oldest = Math.min(userList[0] ?? now, ipList[0] ?? now);
      const retryAfterSec = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      return { allowed: false, retryAfterSec };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  recordFailure(ip: string, username: string): void {
    const now = Date.now();
    const ipKey = `ip:${ip}`;
    const userKey = `usr:${ip}:${username.toLowerCase()}`;
    const ipList = this.prune(ipKey, now);
    ipList.push(now);
    this.attempts.set(ipKey, ipList);

    const userList = this.prune(userKey, now);
    userList.push(now);
    this.attempts.set(userKey, userList);
  }

  recordSuccess(ip: string, username: string): void {
    this.attempts.delete(`usr:${ip}:${username.toLowerCase()}`);
  }
}

export function createAuthMiddleware(db: Database.Database, config: EnvConfig) {
  function resolveSession(req: RequestWithAuth): boolean {
    let rawToken: string | undefined;
    let source: 'cookie' | 'bearer' | undefined;

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      rawToken = authHeader.slice('Bearer '.length).trim();
      source = 'bearer';
    } else if (req.cookies && typeof req.cookies[SESSION_COOKIE_NAME] === 'string') {
      rawToken = req.cookies[SESSION_COOKIE_NAME];
      source = 'cookie';
    }

    if (!rawToken || !source) return false;

    const tokenHash = hashSessionToken(rawToken, config.secretKey);
    const row = db
      .prepare(
        `SELECT s.id AS session_id, s.csrf_token, s.expires_at,
                u.id, u.username, u.display_name, u.role, u.is_active, u.must_change_password, u.quota_bytes
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`
      )
      .get(tokenHash) as
      | (Omit<UserRow, 'password_hash' | 'created_at' | 'updated_at' | 'last_login_at'> & {
          session_id: string;
          csrf_token: string;
          expires_at: string;
        })
      | undefined;

    if (!row) return false;
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(row.session_id);
      return false;
    }
    if (!row.is_active) return false;

    req.authUser = {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      isActive: Boolean(row.is_active),
      mustChangePassword: Boolean(row.must_change_password),
      quotaBytes: row.quota_bytes,
    };
    req.authSessionId = row.session_id;
    req.authCsrfToken = row.csrf_token;
    req.authSource = source;
    return true;
  }

  /**
   * Verifies session and enforces CSRF token header on state-changing cookie-authenticated requests.
   * Also enforces forced password change before accessing regular endpoints.
   */
  function requireAuth(options?: { allowPasswordChangeOnly?: boolean }) {
    return (req: RequestWithAuth, res: Response, next: NextFunction): void => {
      if (!resolveSession(req) || !req.authUser) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const isMutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase());
      if (isMutating && req.authSource === 'cookie') {
        const headerToken = req.headers['x-csrf-token'];
        if (
          typeof headerToken !== 'string' ||
          !req.authCsrfToken ||
          headerToken.length !== req.authCsrfToken.length ||
          !crypto.timingSafeEqual(Buffer.from(headerToken), Buffer.from(req.authCsrfToken))
        ) {
          res.status(403).json({ error: 'Invalid or missing CSRF token' });
          return;
        }
      }

      if (req.authUser.mustChangePassword && !options?.allowPasswordChangeOnly) {
        res.status(403).json({
          error: 'Password change required before accessing this resource',
          code: 'PASSWORD_CHANGE_REQUIRED',
        });
        return;
      }

      next();
    };
  }

  function requireAdmin(req: RequestWithAuth, res: Response, next: NextFunction): void {
    if (!req.authUser || req.authUser.role !== 'admin') {
      res.status(403).json({ error: 'Administrator privileges required' });
      return;
    }
    next();
  }

  return { resolveSession, requireAuth, requireAdmin };
}
