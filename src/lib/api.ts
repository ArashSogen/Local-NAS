/**
 * Authenticated API client with automatic CSRF header injection and
 * session token fallback for partitioned iframe contexts.
 */

let csrfTokenMemory: string | null = null;
const SESSION_FALLBACK_KEY = 'vaultstage_bearer_fallback';

function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  const parts = document.cookie.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length));
    }
  }
  return null;
}

export function setClientAuthTokens(csrfToken: string | null, bearerToken?: string | null): void {
  csrfTokenMemory = csrfToken;
  if (bearerToken !== undefined) {
    try {
      if (bearerToken) {
        sessionStorage.setItem(SESSION_FALLBACK_KEY, bearerToken);
      } else {
        sessionStorage.removeItem(SESSION_FALLBACK_KEY);
      }
    } catch {
      // sessionStorage may be restricted in some environments
    }
  }
}

export function getBearerToken(): string | null {
  try {
    return sessionStorage.getItem(SESSION_FALLBACK_KEY);
  } catch {
    return null;
  }
}

export function getCsrfToken(): string | null {
  return csrfTokenMemory || readCookie('vaultstage_csrf');
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function buildAuthHeaders(extra?: HeadersInit, isMutating = false): Headers {
  const headers = new Headers(extra);
  if (isMutating) {
    const csrf = getCsrfToken();
    if (csrf) {
      headers.set('X-CSRF-Token', csrf);
    }
  }
  const bearer = getBearerToken();
  if (bearer) {
    headers.set('Authorization', `Bearer ${bearer}`);
  }
  return headers;
}

export async function apiRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: HeadersInit;
    signal?: AbortSignal;
  } = {}
): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const isMutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const headers = buildAuthHeaders(options.headers, isMutating);

  let bodyPayload: BodyInit | undefined;
  if (options.body !== undefined) {
    if (options.body instanceof Blob || options.body instanceof ArrayBuffer || ArrayBuffer.isView(options.body)) {
      bodyPayload = options.body as BodyInit;
    } else {
      headers.set('Content-Type', 'application/json');
      bodyPayload = JSON.stringify(options.body);
    }
  }

  const res = await fetch(path, {
    method,
    headers,
    body: bodyPayload,
    credentials: 'include',
    signal: options.signal,
  });

  const text = await res.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  if (!res.ok) {
    const msg = typeof data.error === 'string' ? data.error : `Request failed (${res.status})`;
    const code = typeof data.code === 'string' ? data.code : undefined;
    throw new ApiError(msg, res.status, code);
  }

  return data as T;
}

/**
 * Downloads or fetches a file stream with full auth headers (works reliably even when
 * third-party cookies are restricted in embedded previews).
 */
export async function fetchAuthenticatedBlob(
  url: string,
  signal?: AbortSignal
): Promise<{ blob: Blob; contentType: string; storageSource: string | null }> {
  const headers = buildAuthHeaders(undefined, false);
  const res = await fetch(url, {
    method: 'GET',
    headers,
    credentials: 'include',
    signal,
  });
  if (!res.ok) {
    let msg = `Download failed (${res.status})`;
    try {
      const json = (await res.json()) as { error?: string };
      if (json.error) msg = json.error;
    } catch {
      // ignore
    }
    throw new ApiError(msg, res.status);
  }
  const blob = await res.blob();
  return {
    blob,
    contentType: res.headers.get('content-type') || 'application/octet-stream',
    storageSource: res.headers.get('x-storage-source'),
  };
}
