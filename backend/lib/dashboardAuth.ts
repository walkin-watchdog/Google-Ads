import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import type { DashboardUserRow } from './dashboardUsers';

const MAGIC_TOKEN_BYTES = 32;
const SESSION_TOKEN_BYTES = 32;
const DEFAULT_MAGIC_TTL_MINUTES = 10;
const DEFAULT_SESSION_MINUTES = 60;
const MAX_MAGIC_TTL_MINUTES = 60;
const MAX_SESSION_MINUTES = 12 * 60;
const AUTH_RECORD_RETENTION_DAYS = 7;
const SESSION_COOKIE = 'dashboard_session';
const MAGIC_TOKEN_COOKIE = 'dashboard_magic_token';
const CSRF_COOKIE = 'dashboard_csrf';
const OFFLINE_BLOCK_COOKIE = 'dashboard_offline_block';
const LOGOUT_PENDING_COOKIE = 'zenseeo_logout_pending';
const CSRF_TOKEN_BYTES = 32;
const DEFAULT_USER_SESSION_DAYS = 30;
const DEFAULT_USER_IDLE_DAYS = 7;
const DEFAULT_USER_SESSION_TOUCH_INTERVAL_SECONDS = 5 * 60;
const DEFAULT_DASHBOARD_SESSION_AUTH_CACHE_SECONDS = 60;
const DEFAULT_DASHBOARD_SESSION_AUTH_CACHE_MAX_ENTRIES = 1000;

type DashboardSessionAuthCacheEntry = {
  expiresAt: number;
  lastAccessedAt: number;
};

const dashboardSessionAuthCache = new Map<string, DashboardSessionAuthCacheEntry>();

type DashboardAuthOptions = {
  pool: Pool;
  pushConfig?: (eligible: boolean) => {
    eligible: boolean;
    enabled: boolean;
    available: boolean;
    publicKey: string | null;
    reason: string | null;
  };
};

export type DashboardAuthMode = 'user' | 'magic' | 'api_key';

export type DashboardAuthContext = {
  mode: DashboardAuthMode;
  sessionId: string | null;
  sessionTokenHash: string | null;
  csrfHash: string | null;
  user: DashboardUserRow | null;
  expiresAt: string | null;
  idleExpiresAt: string | null;
};

type MagicLinkInput = {
  ttl_minutes?: unknown;
  session_minutes?: unknown;
  reason?: unknown;
  redirect_path?: unknown;
  created_by?: unknown;
};

export type MagicLinkResult = {
  url: string;
  expires_at: string;
};

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function rowToDashboardUser(row: any): DashboardUserRow {
  return {
    id: String(row.user_id),
    email: String(row.email),
    emailNormalized: String(row.email_normalized),
    name: String(row.name),
    status: row.status,
    invitedAt: row.invited_at ? new Date(row.invited_at).toISOString() : null,
    activatedAt: row.activated_at ? new Date(row.activated_at).toISOString() : null,
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
    createdAt: new Date(row.user_created_at).toISOString(),
    updatedAt: new Date(row.user_updated_at).toISOString()
  };
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function dashboardSessionAuthCacheTtlMs(): number {
  return positiveIntegerEnv('DASHBOARD_SESSION_AUTH_CACHE_SECONDS', DEFAULT_DASHBOARD_SESSION_AUTH_CACHE_SECONDS) * 1000;
}

function dashboardSessionAuthCacheMaxEntries(): number {
  return positiveIntegerEnv('DASHBOARD_SESSION_AUTH_CACHE_MAX_ENTRIES', DEFAULT_DASHBOARD_SESSION_AUTH_CACHE_MAX_ENTRIES);
}

function pruneDashboardSessionAuthCache(now = Date.now()): void {
  for (const [sessionHash, entry] of dashboardSessionAuthCache) {
    if (entry.expiresAt <= now) dashboardSessionAuthCache.delete(sessionHash);
  }
  const maxEntries = dashboardSessionAuthCacheMaxEntries();
  if (maxEntries <= 0) {
    dashboardSessionAuthCache.clear();
    return;
  }
  while (dashboardSessionAuthCache.size > maxEntries) {
    const oldest = Array.from(dashboardSessionAuthCache.entries())
      .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt)[0];
    if (!oldest) break;
    dashboardSessionAuthCache.delete(oldest[0]);
  }
}

export function clearDashboardSessionAuthCache(sessionToken?: string): void {
  if (sessionToken) {
    dashboardSessionAuthCache.delete(sha256(sessionToken));
    return;
  }
  dashboardSessionAuthCache.clear();
}

function randomToken(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function numericMinutes(value: unknown, fallback: number, max: number, field: string): number {
  if (value === undefined || value === null || value === '') return fallback;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || !Number.isInteger(numberValue)) {
    throw new Error(`${field} must be an integer number of minutes.`);
  }
  if (numberValue < 1 || numberValue > max) {
    throw new Error(`${field} must be between 1 and ${max} minutes.`);
  }
  return numberValue;
}

function optionalText(value: unknown, maxLength: number, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > maxLength) throw new Error(`${field} must be ${maxLength} characters or fewer.`);
  return text;
}

function normalizeRedirectPath(value: unknown): string {
  if (value === undefined || value === null || value === '') return '/';
  const text = String(value).trim();
  if (!text.startsWith('/') || text.startsWith('//') || text.includes('\\') || /[\u0000-\u001F\u007F]/.test(text)) {
    throw new Error('redirect_path must be a same-origin path starting with /.');
  }
  if (text.length > 300) throw new Error('redirect_path must be 300 characters or fewer.');
  return text;
}

function normalizePublicBaseUrl(value: string): string {
  const text = value.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('PUBLIC_DASHBOARD_BASE_URL must be a valid absolute http(s) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('PUBLIC_DASHBOARD_BASE_URL must be an absolute http(s) URL without credentials, query, or fragment.');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(hostname);
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:' && !loopback) {
    throw new Error('PUBLIC_DASHBOARD_BASE_URL must use HTTPS in production.');
  }
  return text;
}

function publicDashboardBaseUrl(req?: Request): string {
  const configured = process.env.PUBLIC_DASHBOARD_BASE_URL;
  if (configured) return normalizePublicBaseUrl(configured);
  if (process.env.NODE_ENV === 'production') {
    throw new Error('PUBLIC_DASHBOARD_BASE_URL is required to create dashboard magic links in production.');
  }
  if (!req) throw new Error('PUBLIC_DASHBOARD_BASE_URL is required to create dashboard magic links.');
  const proto = String(req.protocol || 'http').trim();
  const host = String(req.headers.host || '').trim();
  if (!['http', 'https'].includes(proto)) throw new Error('Unable to infer dashboard base URL. Set PUBLIC_DASHBOARD_BASE_URL.');
  if (!host) throw new Error('Unable to infer dashboard base URL. Set PUBLIC_DASHBOARD_BASE_URL.');
  return normalizePublicBaseUrl(`${proto}://${host}`);
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === name) {
      try {
        return decodeURIComponent(rawValue.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function readDashboardCookie(req: Request, name: string): string | null {
  return readCookie(req, name);
}

function clearCookieOptions(req?: Request, path = '/'): { path: string; secure: boolean; sameSite: 'lax' } {
  return {
    path,
    secure: dashboardCookieSecure(req),
    sameSite: 'lax'
  };
}

function bearerToken(req: Request): string | null {
  const customKey = req.headers['x-api-key'];
  if (customKey && typeof customKey === 'string') {
    return customKey;
  }
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

function tokenMatchesSecret(token: string | null): boolean {
  const expected = process.env.SECRET_API_KEY;
  if (!expected || !token) return false;
  const expectedBuffer = Buffer.from(expected);
  const tokenBuffer = Buffer.from(token);
  return expectedBuffer.length === tokenBuffer.length && crypto.timingSafeEqual(expectedBuffer, tokenBuffer);
}

function requestIp(req?: Request): string | null {
  if (!req) return null;
  return req.ip || req.socket?.remoteAddress || null;
}

function userAgent(req?: Request): string | null {
  if (!req) return null;
  const value = String(req.headers['user-agent'] || '').trim();
  return value ? value.slice(0, 500) : null;
}

export function isLocalDashboardOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  if (origin === 'null') return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host === '127.0.0.1'
    || host === '::1';
}

export function setAuthNoStoreHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self'; script-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
}

export async function cleanupExpiredDashboardAuth(pool: Pool): Promise<void> {
  await pool.query(
    `DELETE FROM dashboard_sessions
         WHERE expires_at < now() - ($1::int * INTERVAL '1 day')
            OR revoked_at < now() - ($1::int * INTERVAL '1 day')`,
    [AUTH_RECORD_RETENTION_DAYS]
  );
  await pool.query(
    `DELETE FROM dashboard_magic_links
         WHERE expires_at < now() - ($1::int * INTERVAL '1 day')
            OR used_at < now() - ($1::int * INTERVAL '1 day')`,
    [AUTH_RECORD_RETENTION_DAYS]
  );
}

function authContextFromLocals(res: Response): DashboardAuthContext | null {
  return (res.locals.dashboardAuth || null) as DashboardAuthContext | null;
}

export function dashboardAuthContext(res: Response): DashboardAuthContext | null {
  return authContextFromLocals(res);
}

function csrfCookieOptions(req?: Request): { path: string; secure: boolean; sameSite: 'lax'; httpOnly: false } {
  return {
    path: '/',
    secure: dashboardCookieSecure(req),
    sameSite: 'lax',
    httpOnly: false
  };
}

function setDashboardCsrfCookie(res: Response, token: string, req?: Request): void {
  res.cookie(CSRF_COOKIE, token, {
    ...csrfCookieOptions(req),
    maxAge: DEFAULT_USER_IDLE_DAYS * 24 * 60 * 60 * 1000
  });
}

export function clearDashboardCsrfCookie(res: Response, req?: Request): void {
  res.clearCookie(CSRF_COOKIE, clearCookieOptions(req));
}

export function setDashboardOfflineBlockCookie(res: Response, req?: Request): void {
  res.cookie(OFFLINE_BLOCK_COOKIE, '1', {
    path: '/',
    secure: dashboardCookieSecure(req),
    sameSite: 'lax',
    httpOnly: false,
    maxAge: DEFAULT_USER_SESSION_DAYS * 24 * 60 * 60 * 1000
  });
}

export function clearDashboardOfflineBlockCookie(res: Response, req?: Request): void {
  res.clearCookie(OFFLINE_BLOCK_COOKIE, clearCookieOptions(req));
}

export function clearDashboardLogoutPendingCookie(res: Response, req?: Request): void {
  res.clearCookie(LOGOUT_PENDING_COOKIE, clearCookieOptions(req));
}

function sameOriginRequest(req: Request): boolean {
  let expected = '';
  const configured = String(process.env.PUBLIC_DASHBOARD_BASE_URL || '').trim();
  if (configured) {
    try {
      expected = new URL(configured).origin;
    } catch {
      return false;
    }
  } else {
    const host = String(req.headers.host || '').trim();
    const proto = String(req.protocol || 'http').trim();
    if (!host || !['http', 'https'].includes(proto)) return false;
    expected = `${proto}://${host}`;
  }
  for (const raw of [req.headers.origin, req.headers.referer]) {
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) continue;
    try {
      const actual = new URL(String(value));
      if (`${actual.protocol}//${actual.host}` !== expected) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function isSameOriginDashboardRequest(req: Request): boolean {
  return sameOriginRequest(req);
}

function timingSafeEqualText(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
}

export async function ensureDashboardAuthSchema(pool: Pool): Promise<void> {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  await pool.query(`
        CREATE TABLE IF NOT EXISTS dashboard_magic_links (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            token_hash TEXT NOT NULL UNIQUE,
            reason TEXT,
            redirect_path TEXT NOT NULL DEFAULT '/',
            session_minutes INTEGER NOT NULL DEFAULT ${DEFAULT_SESSION_MINUTES},
            expires_at TIMESTAMPTZ NOT NULL,
            used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            created_by TEXT,
            consumed_ip TEXT,
            consumed_user_agent TEXT
        )
    `);
  await pool.query(`
        CREATE TABLE IF NOT EXISTS dashboard_sessions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            session_hash TEXT NOT NULL UNIQUE,
            magic_link_id UUID REFERENCES dashboard_magic_links(id) ON DELETE SET NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            revoked_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_seen_at TIMESTAMPTZ,
            ip_address TEXT,
            user_agent TEXT
        )
    `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_dashboard_magic_links_expires_at ON dashboard_magic_links (expires_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_expires_at ON dashboard_sessions (expires_at)`);
  await cleanupExpiredDashboardAuth(pool);
}

export async function createDashboardMagicLink(pool: Pool, input: MagicLinkInput = {}, req?: Request): Promise<MagicLinkResult> {
  await cleanupExpiredDashboardAuth(pool).catch(() => undefined);
  const ttlMinutes = numericMinutes(input.ttl_minutes, DEFAULT_MAGIC_TTL_MINUTES, MAX_MAGIC_TTL_MINUTES, 'ttl_minutes');
  const sessionMinutes = numericMinutes(input.session_minutes, DEFAULT_SESSION_MINUTES, MAX_SESSION_MINUTES, 'session_minutes');
  const reason = optionalText(input.reason, 500, 'reason');
  const createdBy = optionalText(input.created_by, 120, 'created_by');
  const redirectPath = normalizeRedirectPath(input.redirect_path);
  const token = randomToken(MAGIC_TOKEN_BYTES);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

  await pool.query(
    `INSERT INTO dashboard_magic_links
         (token_hash, reason, redirect_path, session_minutes, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
    [sha256(token), reason, redirectPath, sessionMinutes, expiresAt.toISOString(), createdBy]
  );

  const url = `${publicDashboardBaseUrl(req)}/auth/magic?token=${encodeURIComponent(token)}`;
  return { url, expires_at: expiresAt.toISOString() };
}

export async function createNamedDashboardSession(pool: Pool, userId: string, req?: Request): Promise<{ sessionToken: string; csrfToken: string; expiresAt: Date }> {
  const sessionToken = randomToken(SESSION_TOKEN_BYTES);
  const csrfToken = randomToken(CSRF_TOKEN_BYTES);
  const expiresAt = new Date(Date.now() + DEFAULT_USER_SESSION_DAYS * 24 * 60 * 60 * 1000);
  const idleExpiresAt = new Date(Date.now() + DEFAULT_USER_IDLE_DAYS * 24 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO dashboard_sessions
       (session_hash, user_id, auth_method, csrf_hash, expires_at, idle_expires_at, last_seen_at, ip_address, user_agent)
     VALUES ($1, $2, 'user', $3, $4, $5, now(), $6, $7)`,
    [sha256(sessionToken), userId, sha256(csrfToken), expiresAt.toISOString(), idleExpiresAt.toISOString(), requestIp(req), userAgent(req)]
  );
  return { sessionToken, csrfToken, expiresAt };
}

export function renderMagicLanding(token: string): string {
  const escaped = token.replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char] || char));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Open Dashboard | Zenseeo</title>
  <style>
    :root {
      --bg-base: #f4f7f6;
      --bg-surface: #ffffff;
      --border-light: #e2e8f0;
      --text-primary: #0f172a;
      --text-secondary: #475569;
      --text-muted: #64748b;
      --primary: #f25e36;
      --primary-hover: #e04d27;
      --primary-glow: rgba(242, 94, 54, 0.12);
      --shadow: 0 20px 40px rgba(15, 23, 42, 0.05), 0 1px 3px rgba(15, 23, 42, 0.02);
      --radius-lg: 16px;
      --radius-md: 10px;
      --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
      --font-heading: 'Outfit', system-ui, -apple-system, sans-serif;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg-base: #0a0e17;
        --bg-surface: #111827;
        --border-light: #1f2937;
        --text-primary: #f9fafb;
        --text-secondary: #cbd5e1;
        --text-muted: #64748b;
        --primary: #ff6f47;
        --primary-hover: #ff8361;
        --primary-glow: rgba(255, 111, 71, 0.15);
        --shadow: 0 20px 40px rgba(0, 0, 0, 0.25), 0 1px 3px rgba(0, 0, 0, 0.05);
      }
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      background-color: var(--bg-base);
      color: var(--text-primary);
      font-family: var(--font-sans);
      position: relative;
      overflow: hidden;
    }

    .blob {
      position: absolute;
      width: 320px;
      height: 320px;
      border-radius: 50%;
      filter: blur(90px);
      opacity: 0.12;
      z-index: 0;
      pointer-events: none;
      animation: pulse 12s infinite alternate;
    }

    .blob-1 {
      background: var(--primary);
      top: 10%;
      left: 15%;
    }

    .blob-2 {
      background: #3b82f6;
      bottom: 10%;
      right: 15%;
      animation-delay: -6s;
    }

    @keyframes pulse {
      0% { transform: scale(1) translate(0, 0); }
      100% { transform: scale(1.2) translate(15px, -30px); }
    }

    main {
      width: min(440px, calc(100vw - 32px));
      background: var(--bg-surface);
      border: 1px solid var(--border-light);
      border-radius: var(--radius-lg);
      padding: 36px;
      box-shadow: var(--shadow);
      z-index: 1;
      position: relative;
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      animation: fadeInUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) both;
    }

    @keyframes fadeInUp {
      from {
        opacity: 0;
        transform: translateY(20px) scale(0.98);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    .logo-container {
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 24px;
    }

    .brand-logo-img {
      height: 64px;
      width: auto;
      object-fit: contain;
      transition: filter 0.3s ease;
    }

    @media (prefers-color-scheme: dark) {
      .brand-logo-img {
        filter: invert(0.9) brightness(1.2) hue-rotate(180deg);
      }
    }

    h1 {
      font-family: var(--font-heading);
      font-size: 1.5rem;
      font-weight: 600;
      text-align: center;
      margin-bottom: 10px;
      letter-spacing: -0.02em;
    }

    p {
      color: var(--text-secondary);
      font-size: 0.9rem;
      line-height: 1.6;
      text-align: center;
      margin-bottom: 28px;
    }

    button {
      width: 100%;
      border: 0;
      border-radius: var(--radius-md);
      background: linear-gradient(135deg, var(--primary) 0%, #ff7c5c 100%);
      color: white;
      font-family: var(--font-heading);
      font-size: 0.95rem;
      font-weight: 600;
      padding: 14px 20px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      box-shadow: 0 4px 12px var(--primary-glow);
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }

    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 20px var(--primary-glow);
      filter: brightness(1.05);
    }

    button:active {
      transform: translateY(0);
    }

    button svg {
      transition: transform 0.2s ease;
    }

    button:hover svg {
      transform: translateX(4px);
    }

    .divider {
      height: 1px;
      background-color: var(--border-light);
      margin: 28px 0;
    }

    .security-features {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .feature-item {
      display: flex;
      align-items: flex-start;
      gap: 14px;
      text-align: left;
    }

    .feature-item svg {
      color: var(--primary);
      flex-shrink: 0;
      margin-top: 2px;
    }

    .feature-text {
      display: flex;
      flex-direction: column;
    }

    .feature-text strong {
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .feature-text span {
      font-size: 0.75rem;
      color: var(--text-muted);
    }

    .footer {
      text-align: center;
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 24px;
    }
  </style>
</head>
<body>
  <div class="blob blob-1"></div>
  <div class="blob blob-2"></div>
  <main>
    <div class="logo-container">
      <img src="/logo.png" alt="Zenseeo Logo" class="brand-logo-img">
    </div>

    <h1>Verify Session</h1>
    <p>You requested access to the Google Ads Dashboard. Continue to proceed securely.</p>

    <form method="post" action="/auth/magic/consume" autocomplete="off">
      <input id="magic-token" type="hidden" name="token" value="${escaped}">
      <button type="submit">
        <span>Continue to dashboard</span>
      </button>
    </form>

    <div class="divider"></div>

    <div class="security-features">
      <div class="feature-item">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
        <div class="feature-text">
          <strong>One-Time Access Link</strong>
          <span>This secure token is single-use and will be invalidated instantly.</span>
        </div>
      </div>
      <div class="feature-item">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
        <div class="feature-text">
          <strong>Auto-Expiration</strong>
          <span>Unused links expire shortly. Session will timeout automatically.</span>
        </div>
      </div>
    </div>

    <div class="footer">
      Secured by Zenseeo
    </div>
  </main>
  <script>
    const form = document.querySelector('form');
    if (form) {
      form.addEventListener('submit', () => {
        const button = form.querySelector('button[type="submit"]');
        if (button) {
          button.disabled = true;
          button.textContent = "Opening dashboard...";
        }
      });
    }
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, "", "/auth/magic");
    }
  </script>
</body>
</html>`;
}

export async function consumeDashboardMagicLink(pool: Pool, token: string, req?: Request): Promise<{ sessionToken: string, redirectPath: string, expiresAt: Date }> {
  if (!token || token.length < 20 || token.length > 200) {
    throw new Error('Invalid or expired dashboard link.');
  }
  await cleanupExpiredDashboardAuth(pool).catch(() => undefined);
  const sessionToken = randomToken(SESSION_TOKEN_BYTES);
  const sessionHash = sha256(sessionToken);
  const ip = requestIp(req);
  const ua = userAgent(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const linkResult = await client.query(
      `SELECT id, redirect_path, session_minutes
             FROM dashboard_magic_links
             WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
             FOR UPDATE`,
      [sha256(token)]
    );
    if (linkResult.rows.length === 0) {
      throw new Error('Invalid or expired dashboard link.');
    }
    const link = linkResult.rows[0];
    await client.query(
      `UPDATE dashboard_magic_links
             SET used_at = now(), consumed_ip = $2, consumed_user_agent = $3
             WHERE id = $1`,
      [link.id, ip, ua]
    );
    const sessionMinutes = Number(link.session_minutes || DEFAULT_SESSION_MINUTES);
    const expiresAt = new Date(Date.now() + sessionMinutes * 60_000);
    await client.query(
      `INSERT INTO dashboard_sessions (session_hash, magic_link_id, expires_at, ip_address, user_agent)
             VALUES ($1, $2, $3, $4, $5)`,
      [sessionHash, link.id, expiresAt.toISOString(), ip, ua]
    );
    await client.query('COMMIT');
    return { sessionToken, redirectPath: link.redirect_path || '/', expiresAt };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function loadDashboardSession(pool: Pool, req: Request, options: { ensureCsrf?: boolean } = {}): Promise<DashboardAuthContext | null> {
  const sessionToken = readCookie(req, SESSION_COOKIE);
  if (!sessionToken) return null;
  if (sessionToken.length < 20 || sessionToken.length > 200) return null;
  const sessionHash = sha256(sessionToken);
  const ttlMs = dashboardSessionAuthCacheTtlMs();
  if (ttlMs > 0 && !options.ensureCsrf) {
    const now = Date.now();
    const cached = dashboardSessionAuthCache.get(sessionHash);
    if (cached && cached.expiresAt > now) {
      cached.lastAccessedAt = now;
      const result = await pool.query(
        `UPDATE dashboard_sessions
         SET last_seen_at = now()
         WHERE session_hash = $1
           AND auth_method = 'magic'
           AND revoked_at IS NULL
           AND expires_at > now()
         RETURNING id, session_hash, auth_method, csrf_hash, expires_at, idle_expires_at`,
        [sessionHash]
      );
      const row = result.rows[0];
      return row ? {
        mode: 'magic',
        sessionId: row.id,
        sessionTokenHash: row.session_hash,
        csrfHash: row.csrf_hash || null,
        user: null,
        expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
        idleExpiresAt: row.idle_expires_at ? new Date(row.idle_expires_at).toISOString() : null
      } : null;
    }
    if (cached) dashboardSessionAuthCache.delete(sessionHash);
  }
  const result = await pool.query(
    `SELECT s.id,
            s.session_hash,
            s.auth_method,
            s.csrf_hash,
            s.expires_at,
            s.idle_expires_at,
            s.last_seen_at,
            s.user_id,
            u.email,
            u.email_normalized,
            u.name,
            u.status,
            u.invited_at,
            u.activated_at,
            u.last_login_at,
            u.created_at AS user_created_at,
            u.updated_at AS user_updated_at
     FROM dashboard_sessions s
     LEFT JOIN dashboard_users u ON u.id = s.user_id
     WHERE s.session_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND (s.auth_method = 'magic' OR s.idle_expires_at IS NULL OR s.idle_expires_at > now())`,
    [sessionHash]
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.auth_method === 'user') {
    if (!row.user_id || row.status !== 'active') return null;
    let csrfHash = row.csrf_hash || null;
    const csrfCookie = readCookie(req, CSRF_COOKIE);
    const csrfCookieMatches = Boolean(csrfHash && csrfCookie && timingSafeEqualText(sha256(csrfCookie), csrfHash));
    if (options.ensureCsrf && !csrfCookieMatches) {
      const csrfToken = randomToken(CSRF_TOKEN_BYTES);
      csrfHash = sha256(csrfToken);
      await pool.query(`UPDATE dashboard_sessions SET csrf_hash = $2 WHERE id = $1`, [row.id, csrfHash]);
      (req as any).__dashboardNewCsrfToken = csrfToken;
    }
    let refreshedIdleExpiresAt = row.idle_expires_at;
    const configuredTouchIntervalMs = positiveIntegerEnv(
      'DASHBOARD_SESSION_TOUCH_INTERVAL_SECONDS',
      DEFAULT_USER_SESSION_TOUCH_INTERVAL_SECONDS
    ) * 1000;
    const touchIntervalMs = Math.min(configuredTouchIntervalMs, DEFAULT_USER_IDLE_DAYS * 12 * 60 * 60 * 1000);
    const lastSeenAt = row.last_seen_at ? new Date(row.last_seen_at).getTime() : Number.NaN;
    if (touchIntervalMs === 0 || !Number.isFinite(lastSeenAt) || Date.now() - lastSeenAt >= touchIntervalMs) {
      const idleUpdate = await pool.query(
        `UPDATE dashboard_sessions session
         SET last_seen_at = now(),
             idle_expires_at = LEAST(session.expires_at, now() + ($2::int * INTERVAL '1 day'))
         FROM dashboard_users user_row
         WHERE session.id = $1
           AND session.user_id = user_row.id
           AND session.auth_method = 'user'
           AND session.revoked_at IS NULL
           AND session.expires_at > now()
           AND session.idle_expires_at > now()
           AND user_row.status = 'active'
         RETURNING session.idle_expires_at`,
        [row.id, DEFAULT_USER_IDLE_DAYS]
      );
      if (!idleUpdate.rows[0]) return null;
      refreshedIdleExpiresAt = idleUpdate.rows[0].idle_expires_at;
    }
    return {
      mode: 'user',
      sessionId: row.id,
      sessionTokenHash: row.session_hash,
      csrfHash,
      user: rowToDashboardUser(row),
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
      idleExpiresAt: refreshedIdleExpiresAt ? new Date(refreshedIdleExpiresAt).toISOString() : null
    };
  }
  let csrfHash = row.csrf_hash || null;
  const csrfCookie = readCookie(req, CSRF_COOKIE);
  const csrfCookieMatches = Boolean(csrfHash && csrfCookie && timingSafeEqualText(sha256(csrfCookie), csrfHash));
  if (options.ensureCsrf && !csrfCookieMatches) {
    const csrfToken = randomToken(CSRF_TOKEN_BYTES);
    csrfHash = sha256(csrfToken);
    await pool.query(`UPDATE dashboard_sessions SET csrf_hash = $2 WHERE id = $1`, [row.id, csrfHash]);
    (req as any).__dashboardNewCsrfToken = csrfToken;
  }
  await pool.query(`UPDATE dashboard_sessions SET last_seen_at = now() WHERE id = $1`, [row.id]);
  if (ttlMs > 0) {
    const now = Date.now();
    dashboardSessionAuthCache.set(sessionHash, {
      expiresAt: now + ttlMs,
      lastAccessedAt: now
    });
    pruneDashboardSessionAuthCache(now);
  }
  return {
    mode: 'magic',
    sessionId: row.id,
    sessionTokenHash: row.session_hash,
    csrfHash,
    user: null,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    idleExpiresAt: row.idle_expires_at ? new Date(row.idle_expires_at).toISOString() : null
  };
}

function dashboardCookieSecure(req?: Request): boolean {
  const explicit = String(process.env.DASHBOARD_COOKIE_SECURE || '').trim().toLowerCase();
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  if (process.env.NODE_ENV === 'production') return true;
  const configuredBase = process.env.PUBLIC_DASHBOARD_BASE_URL;
  if (configuredBase && /^https:\/\//i.test(configuredBase.trim())) return true;
  return Boolean(req?.secure);
}

export function setDashboardSessionCookie(res: Response, sessionToken: string, expiresAt: Date, req?: Request): void {
  const secure = dashboardCookieSecure(req);
  const maxAge = Math.max(expiresAt.getTime() - Date.now(), 0);
  res.cookie(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    expires: expiresAt,
    maxAge,
    path: '/'
  });
}

export function clearDashboardSessionCookie(res: Response, req?: Request): void {
  res.clearCookie(SESSION_COOKIE, clearCookieOptions(req));
}

export function setDashboardCsrfResponseCookie(res: Response, token: string, req?: Request): void {
  setDashboardCsrfCookie(res, token, req);
}

export function setDashboardMagicTokenCookie(res: Response, token: string, req?: Request): void {
  res.cookie(MAGIC_TOKEN_COOKIE, token, {
    httpOnly: true,
    secure: dashboardCookieSecure(req),
    sameSite: 'lax',
    maxAge: DEFAULT_MAGIC_TTL_MINUTES * 60_000,
    path: '/auth/magic/consume'
  });
}

export function clearDashboardMagicTokenCookie(res: Response, req?: Request): void {
  res.clearCookie(MAGIC_TOKEN_COOKIE, clearCookieOptions(req, '/auth/magic/consume'));
}

export function readDashboardMagicTokenCookie(req: Request): string {
  return readCookie(req, MAGIC_TOKEN_COOKIE) || '';
}

export async function revokeDashboardSession(pool: Pool, req: Request): Promise<void> {
  const sessionToken = readCookie(req, SESSION_COOKIE);
  if (!sessionToken) return;
  clearDashboardSessionAuthCache(sessionToken);
  await pool.query(
    `UPDATE dashboard_sessions
         SET revoked_at = COALESCE(revoked_at, now())
         WHERE session_hash = $1 AND revoked_at IS NULL`,
    [sha256(sessionToken)]
  );
}

export function authenticateAdminBearer(req: Request, res: Response, next: NextFunction): void {
  if (!tokenMatchesSecret(bearerToken(req))) {
    res.status(403).json({ error: 'Forbidden: Invalid API Key' });
    return;
  }
  next();
}

function requestAllowsLocalDashboardSecret(req: Request): boolean {
  return isLocalDashboardOrigin(String(req.headers.origin || '')) && tokenMatchesSecret(bearerToken(req));
}

export function authenticateDashboardAccess({ pool }: DashboardAuthOptions) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    if (requestAllowsLocalDashboardSecret(req)) {
      res.locals.dashboardAuth = {
        mode: 'api_key',
        sessionId: null,
        sessionTokenHash: null,
        csrfHash: null,
        user: null,
        expiresAt: null,
        idleExpiresAt: null
      } satisfies DashboardAuthContext;
      next();
      return;
    }
    try {
      const context = await loadDashboardSession(pool, req);
      if (context) {
        res.locals.dashboardAuth = context;
        next();
        return;
      }
    } catch (err) {
      console.error('Dashboard session auth failed:', err);
      res.status(500).json({ error: 'Dashboard session auth failed' });
      return;
    }
    res.status(401).json({ error: 'Dashboard session required' });
  };
}

export function authenticateDashboardOrAdminAccess(options: DashboardAuthOptions) {
  const authenticateDashboard = authenticateDashboardAccess(options);
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Server-to-server callers such as cron-job.org have no browser Origin header.
    // Preserve the explicit admin bearer path while dashboard browsers use sessions.
    if (bearerToken(req)) {
      authenticateAdminBearer(req, res, next);
      return;
    }
    await authenticateDashboard(req, res, next);
  };
}

export function requireDashboardPageSession({ pool }: DashboardAuthOptions) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const context = await loadDashboardSession(pool, req);
      if (context) {
        res.locals.dashboardAuth = context;
        next();
        return;
      }
    } catch (err) {
      console.error('Dashboard page auth failed:', err);
      res.status(500).send('Dashboard auth failed.');
      return;
    }
    res.status(401).send('You do not have the permission to access this.');
  };
}

export function requireDashboardCsrf(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase())) {
    next();
    return;
  }
  const context = authContextFromLocals(res);
  if (!context || context.mode === 'api_key') {
    next();
    return;
  }
  if (!sameOriginRequest(req)) {
    res.status(403).json({ error: 'Invalid request origin.' });
    return;
  }
  const header = String(req.headers['x-csrf-token'] || '').trim();
  if (!header || !context.csrfHash || !timingSafeEqualText(sha256(header), context.csrfHash)) {
    res.status(403).json({ error: 'CSRF token required.' });
    return;
  }
  next();
}

export function authenticateDashboardSession({ pool, pushConfig }: DashboardAuthOptions) {
  return async (req: Request, res: Response): Promise<void> => {
    setAuthNoStoreHeaders(res);
    if (requestAllowsLocalDashboardSecret(req)) {
      res.json({
        mode: 'api_key',
        user: null,
        csrfToken: null,
        expiresAt: null,
        idleExpiresAt: null,
        pushConfig: pushConfig?.(false) || null
      });
      return;
    }
    try {
      const context = await loadDashboardSession(pool, req, { ensureCsrf: true });
      const csrfToken = (req as any).__dashboardNewCsrfToken || readCookie(req, CSRF_COOKIE) || null;
      if (!context) {
        clearDashboardCsrfCookie(res, req);
        res.status(401).json({ error: 'Dashboard session required' });
        return;
      }
      if (context.mode === 'user') clearDashboardOfflineBlockCookie(res, req);
      if (csrfToken) setDashboardCsrfCookie(res, csrfToken, req);
      res.json({
        mode: context.mode,
        user: context.user ? {
          id: context.user.id,
          email: context.user.email,
          name: context.user.name,
          status: context.user.status
        } : null,
        csrfToken,
        expiresAt: context.expiresAt,
        idleExpiresAt: context.idleExpiresAt,
        pushConfig: pushConfig?.(context.mode === 'user') || null
      });
    } catch (err) {
      console.error('Dashboard session lookup failed:', err);
      res.status(500).json({ error: 'Dashboard session lookup failed' });
    }
  };
}
