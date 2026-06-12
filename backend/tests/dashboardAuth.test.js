import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import crypto from 'crypto';
import {
    authenticateAdminBearer,
    authenticateDashboardAccess,
    authenticateDashboardOrAdminAccess,
    authenticateDashboardSession,
    clearDashboardMagicTokenCookie,
    clearDashboardSessionAuthCache,
    createNamedDashboardSession,
    isLocalDashboardOrigin,
    readDashboardMagicTokenCookie,
    requireDashboardCsrf,
    revokeDashboardSession,
    setAuthNoStoreHeaders,
    setDashboardMagicTokenCookie
} from '../lib/dashboardAuth.ts';

const ORIGINAL_SECRET = process.env.SECRET_API_KEY;
const ORIGINAL_SESSION_AUTH_CACHE_SECONDS = process.env.DASHBOARD_SESSION_AUTH_CACHE_SECONDS;
const ORIGINAL_SESSION_TOUCH_INTERVAL_SECONDS = process.env.DASHBOARD_SESSION_TOUCH_INTERVAL_SECONDS;
const ORIGINAL_PUBLIC_DASHBOARD_BASE_URL = process.env.PUBLIC_DASHBOARD_BASE_URL;

function request({ origin, authorization, cookie, query, xApiKey } = {}) {
    const headers = {};
    if (origin !== undefined) headers.origin = origin;
    if (authorization) headers.authorization = authorization;
    if (xApiKey) headers['x-api-key'] = xApiKey;
    if (cookie) headers.cookie = cookie;
    return { headers, query: query || {}, ip: '127.0.0.1', protocol: 'http' };
}

function response() {
    return {
        locals: {},
        headers: {},
        cookies: [],
        statusCode: null,
        payload: null,
        setHeader(name, value) {
            this.headers[name] = value;
            return this;
        },
        cookie(name, value, options) {
            this.cookies.push({ name, value, options });
            return this;
        },
        clearCookie(name, options) {
            this.cookies.push({ name, value: null, options });
            return this;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.payload = payload;
            return this;
        }
    };
}

async function runDashboardAuth(req, pool) {
    const res = response();
    let nextCalled = false;
    const next = () => {
        nextCalled = true;
    };
    await authenticateDashboardAccess({ pool })(req, res, next);
    return { nextCalled, res };
}

beforeEach(() => {
    process.env.SECRET_API_KEY = 'test-secret';
    delete process.env.PUBLIC_DASHBOARD_BASE_URL;
});

afterEach(() => {
    clearDashboardSessionAuthCache();
    if (ORIGINAL_SECRET === undefined) {
        delete process.env.SECRET_API_KEY;
    } else {
        process.env.SECRET_API_KEY = ORIGINAL_SECRET;
    }
    if (ORIGINAL_SESSION_AUTH_CACHE_SECONDS === undefined) {
        delete process.env.DASHBOARD_SESSION_AUTH_CACHE_SECONDS;
    } else {
        process.env.DASHBOARD_SESSION_AUTH_CACHE_SECONDS = ORIGINAL_SESSION_AUTH_CACHE_SECONDS;
    }
    if (ORIGINAL_SESSION_TOUCH_INTERVAL_SECONDS === undefined) {
        delete process.env.DASHBOARD_SESSION_TOUCH_INTERVAL_SECONDS;
    } else {
        process.env.DASHBOARD_SESSION_TOUCH_INTERVAL_SECONDS = ORIGINAL_SESSION_TOUCH_INTERVAL_SECONDS;
    }
    if (ORIGINAL_PUBLIC_DASHBOARD_BASE_URL === undefined) {
        delete process.env.PUBLIC_DASHBOARD_BASE_URL;
    } else {
        process.env.PUBLIC_DASHBOARD_BASE_URL = ORIGINAL_PUBLIC_DASHBOARD_BASE_URL;
    }
});

describe('dashboard local origin detection', () => {
    test('public auth CSP permits same-origin fetch requests only', () => {
        const res = response();
        setAuthNoStoreHeaders(res);
        const policy = res.headers['Content-Security-Policy'];
        expect(policy).toContain("connect-src 'self'");
        expect(policy).not.toMatch(/connect-src[^;]*https?:/);
    });

    test('allows file and loopback origins for local config.js mode', () => {
        expect(isLocalDashboardOrigin('null')).toBe(true);
        expect(isLocalDashboardOrigin('http://localhost:5173')).toBe(true);
        expect(isLocalDashboardOrigin('http://127.0.0.1:8080')).toBe(true);
        expect(isLocalDashboardOrigin('http://[::1]:8080')).toBe(true);
    });

    test('rejects remote browser origins', () => {
        expect(isLocalDashboardOrigin(undefined)).toBe(false);
        expect(isLocalDashboardOrigin('https://example.com')).toBe(false);
        expect(isLocalDashboardOrigin('https://localhost.example.com')).toBe(false);
    });
});

describe('dashboard access middleware', () => {
    test('accepts header API key from file-mode dashboard origins', async () => {
        const pool = {
            async query() {
                return { rows: [] };
            }
        };

        const result = await runDashboardAuth(request({
            origin: 'null',
            authorization: 'Bearer test-secret'
        }), pool);

        expect(result.nextCalled).toBe(true);
        expect(result.res.statusCode).toBeNull();
    });

    test('rejects query-string keys even from file-mode dashboard origins', async () => {
        const pool = {
            async query() {
                return { rows: [] };
            }
        };

        const result = await runDashboardAuth(request({
            origin: 'null',
            query: { key: 'test-secret' }
        }), pool);

        expect(result.nextCalled).toBe(false);
        expect(result.res.statusCode).toBe(401);
        expect(result.res.payload.error).toBe('Dashboard session required');
    });

    test('rejects the admin bearer key from remote browser origins without a session', async () => {
        const pool = {
            async query() {
                return { rows: [] };
            }
        };

        const result = await runDashboardAuth(request({
            origin: 'https://evil.example',
            authorization: 'Bearer test-secret'
        }), pool);

        expect(result.nextCalled).toBe(false);
        expect(result.res.statusCode).toBe(401);
        expect(result.res.payload.error).toBe('Dashboard session required');
    });

    test('admin bearer middleware rejects query-string keys', () => {
        const res = response();
        let nextCalled = false;
        authenticateAdminBearer(request({ query: { key: 'test-secret' } }), res, () => {
            nextCalled = true;
        });
        expect(nextCalled).toBe(false);
        expect(res.statusCode).toBe(403);
    });

    test('admin bearer middleware accepts header keys', () => {
        const res = response();
        let nextCalled = false;
        authenticateAdminBearer(request({ xApiKey: 'test-secret' }), res, () => {
            nextCalled = true;
        });
        expect(nextCalled).toBe(true);
        expect(res.statusCode).toBeNull();
    });

    test('combined dashboard/admin middleware accepts an external cron bearer without an origin', async () => {
        const pool = {
            async query() {
                throw new Error('A valid admin bearer must not fall through to session lookup.');
            }
        };
        const req = request({ authorization: 'Bearer test-secret' });
        const res = response();
        let nextCalled = false;

        await authenticateDashboardOrAdminAccess({ pool })(req, res, () => {
            nextCalled = true;
        });

        expect(nextCalled).toBe(true);
        expect(res.statusCode).toBeNull();
    });

    test('accepts a valid dashboard session from a remote browser origin', async () => {
        const pool = {
            async query() {
                return {
                    rows: [{
                        id: 'session-id',
                        session_hash: 'hash',
                        auth_method: 'magic',
                        csrf_hash: null,
                        expires_at: new Date(Date.now() + 3600000),
                        idle_expires_at: null
                    }]
                };
            }
        };

        const result = await runDashboardAuth(request({
            origin: 'https://dashboard.example',
            cookie: `dashboard_session=${encodeURIComponent('a'.repeat(43))}`
        }), pool);

        expect(result.nextCalled).toBe(true);
        expect(result.res.statusCode).toBeNull();
    });

    test('fails closed when a named session is revoked or disabled during validation', async () => {
        const pool = {
            async query(sql) {
                const text = String(sql);
                if (text.includes('FROM dashboard_sessions s')) {
                    return {
                        rows: [{
                            id: 'session-id',
                            session_hash: 'hash',
                            auth_method: 'user',
                            csrf_hash: null,
                            expires_at: new Date(Date.now() + 3600000),
                            idle_expires_at: new Date(Date.now() + 3600000),
                            user_id: '11111111-1111-4111-8111-111111111111',
                            email: 'admin@example.com',
                            email_normalized: 'admin@example.com',
                            name: 'Admin',
                            status: 'active',
                            invited_at: new Date(),
                            activated_at: new Date(),
                            last_login_at: new Date(),
                            user_created_at: new Date(),
                            user_updated_at: new Date()
                        }]
                    };
                }
                if (text.includes('UPDATE dashboard_sessions session')) return { rows: [], rowCount: 0 };
                return { rows: [], rowCount: 0 };
            }
        };

        const result = await runDashboardAuth(request({
            origin: 'https://dashboard.example',
            cookie: `dashboard_session=${encodeURIComponent('n'.repeat(43))}`
        }), pool);

        expect(result.nextCalled).toBe(false);
        expect(result.res.statusCode).toBe(401);
    });

    test('revalidates named users without writing the idle lease on every request', async () => {
        process.env.DASHBOARD_SESSION_TOUCH_INTERVAL_SECONDS = '300';
        const queries = [];
        const pool = {
            async query(sql) {
                const text = String(sql);
                queries.push(text);
                if (text.includes('FROM dashboard_sessions s')) {
                    return {
                        rows: [{
                            id: 'session-id',
                            session_hash: 'hash',
                            auth_method: 'user',
                            csrf_hash: 'csrf-hash',
                            expires_at: new Date(Date.now() + 30 * 86400000),
                            idle_expires_at: new Date(Date.now() + 7 * 86400000),
                            last_seen_at: new Date(),
                            user_id: '11111111-1111-4111-8111-111111111111',
                            email: 'admin@example.com',
                            email_normalized: 'admin@example.com',
                            name: 'Admin',
                            status: 'active',
                            invited_at: new Date(),
                            activated_at: new Date(),
                            last_login_at: new Date(),
                            user_created_at: new Date(),
                            user_updated_at: new Date()
                        }]
                    };
                }
                throw new Error(`Unexpected session write: ${text}`);
            }
        };

        const result = await runDashboardAuth(request({
            origin: 'https://dashboard.example',
            cookie: `dashboard_session=${encodeURIComponent('t'.repeat(43))}`
        }), pool);

        expect(result.nextCalled).toBe(true);
        expect(queries).toHaveLength(1);
        expect(queries[0]).toContain('u.status');
    });

    test('caches valid magic dashboard sessions without repeating the full session lookup', async () => {
        const queries = [];
        const cookie = `dashboard_session=${encodeURIComponent('b'.repeat(43))}`;
        const pool = {
            async query(sql) {
                queries.push(String(sql));
                return {
                    rows: [{
                        id: 'session-id',
                        session_hash: 'hash',
                        auth_method: 'magic',
                        csrf_hash: null,
                        expires_at: new Date(Date.now() + 3600000),
                        idle_expires_at: null
                    }]
                };
            }
        };

        const first = await runDashboardAuth(request({ origin: 'https://dashboard.example', cookie }), pool);
        const second = await runDashboardAuth(request({ origin: 'https://dashboard.example', cookie }), pool);

        expect(first.nextCalled).toBe(true);
        expect(second.nextCalled).toBe(true);
        expect(queries.filter(sql => sql.includes('FROM dashboard_sessions s'))).toHaveLength(1);
    });

    test('revoke clears a cached dashboard session before the next auth check', async () => {
        const queries = [];
        let valid = true;
        const cookie = `dashboard_session=${encodeURIComponent('c'.repeat(43))}`;
        const req = request({ origin: 'https://dashboard.example', cookie });
        const pool = {
            async query(sql) {
                queries.push(String(sql));
                if (String(sql).includes('FROM dashboard_sessions s') || String(sql).includes('RETURNING id')) {
                    return {
                        rows: valid ? [{
                            id: 'session-id',
                            session_hash: 'hash',
                            auth_method: 'magic',
                            csrf_hash: null,
                            expires_at: new Date(Date.now() + 3600000),
                            idle_expires_at: null
                        }] : []
                    };
                }
                return { rows: [], rowCount: 1 };
            }
        };

        const first = await runDashboardAuth(req, pool);
        valid = false;
        await revokeDashboardSession(pool, req);
        const second = await runDashboardAuth(req, pool);

        expect(first.nextCalled).toBe(true);
        expect(second.nextCalled).toBe(false);
        expect(second.res.statusCode).toBe(401);
        expect(queries.filter(sql => sql.includes('FROM dashboard_sessions s') || sql.includes('RETURNING id'))).toHaveLength(2);
    });
});

describe('dashboard CSRF bootstrap', () => {
    test('creates independent sessions when the same named user logs in from multiple devices', async () => {
        const inserts = [];
        const pool = {
            async query(sql, params) {
                inserts.push({ sql: String(sql), params });
                return { rows: [], rowCount: 1 };
            }
        };
        const userId = '11111111-1111-4111-8111-111111111111';

        const first = await createNamedDashboardSession(pool, userId, request({ origin: 'https://dashboard.example' }));
        const second = await createNamedDashboardSession(pool, userId, request({ origin: 'https://dashboard.example' }));

        expect(first.sessionToken).not.toBe(second.sessionToken);
        expect(first.csrfToken).not.toBe(second.csrfToken);
        expect(inserts).toHaveLength(2);
        expect(inserts.every(entry => entry.sql.includes("VALUES ($1, $2, 'user'"))).toBe(true);
        expect(inserts.every(entry => entry.params[1] === userId)).toBe(true);
    });

    test('rotates a missing or mismatched readable CSRF cookie to match the named session', async () => {
        const sessionToken = 's'.repeat(43);
        const updates = [];
        const pool = {
            async query(sql, params = []) {
                const text = String(sql);
                if (text.includes('FROM dashboard_sessions s')) {
                    return {
                        rows: [{
                            id: 'session-id',
                            session_hash: crypto.createHash('sha256').update(sessionToken).digest('hex'),
                            auth_method: 'user',
                            csrf_hash: crypto.createHash('sha256').update('old-csrf').digest('hex'),
                            expires_at: new Date(Date.now() + 30 * 86400000),
                            idle_expires_at: new Date(Date.now() + 86400000),
                            user_id: '11111111-1111-4111-8111-111111111111',
                            email: 'admin@example.com',
                            email_normalized: 'admin@example.com',
                            name: 'Admin',
                            status: 'active',
                            invited_at: new Date(),
                            activated_at: new Date(),
                            last_login_at: new Date(),
                            user_created_at: new Date(),
                            user_updated_at: new Date()
                        }]
                    };
                }
                if (text.includes('SET csrf_hash')) {
                    updates.push(params);
                    return { rows: [], rowCount: 1 };
                }
                if (text.includes('RETURNING session.idle_expires_at')) {
                    return { rows: [{ idle_expires_at: new Date(Date.now() + 7 * 86400000) }], rowCount: 1 };
                }
                return { rows: [], rowCount: 1 };
            }
        };
        const req = request({
            origin: 'https://dashboard.example',
            cookie: `dashboard_session=${sessionToken}; dashboard_csrf=wrong-csrf`
        });
        const res = response();

        await authenticateDashboardSession({
            pool,
            pushConfig: eligible => ({
                eligible,
                enabled: true,
                available: eligible,
                publicKey: eligible ? 'public-key' : null,
                reason: eligible ? null : 'Named user login is required for push notifications.'
            })
        })(req, res);

        expect(res.statusCode).toBeNull();
        expect(res.payload.mode).toBe('user');
        expect(res.payload.pushConfig).toEqual({
            eligible: true,
            enabled: true,
            available: true,
            publicKey: 'public-key',
            reason: null
        });
        expect(res.payload.csrfToken).not.toBe('wrong-csrf');
        expect(updates).toHaveLength(1);
        expect(updates[0][1]).toBe(crypto.createHash('sha256').update(res.payload.csrfToken).digest('hex'));
        expect(res.cookies.find(cookie => cookie.name === 'dashboard_csrf')?.value).toBe(res.payload.csrfToken);
    });

    test('requires a matching token and same-origin request for cookie-authenticated mutations', () => {
        const token = 'csrf-token';
        const context = {
            mode: 'user',
            sessionId: 'session-id',
            sessionTokenHash: 'session-hash',
            csrfHash: crypto.createHash('sha256').update(token).digest('hex'),
            user: null,
            expiresAt: null,
            idleExpiresAt: null
        };
        const goodReq = request({ origin: 'http://dashboard.example' });
        goodReq.method = 'POST';
        goodReq.headers.host = 'dashboard.example';
        goodReq.headers['x-csrf-token'] = token;
        const goodRes = response();
        goodRes.locals.dashboardAuth = context;
        let nextCalled = false;
        requireDashboardCsrf(goodReq, goodRes, () => { nextCalled = true; });
        expect(nextCalled).toBe(true);

        const badReq = request({ origin: 'https://evil.example' });
        badReq.method = 'POST';
        badReq.headers.host = 'dashboard.example';
        badReq.headers['x-csrf-token'] = token;
        const badRes = response();
        badRes.locals.dashboardAuth = context;
        requireDashboardCsrf(badReq, badRes, () => undefined);
        expect(badRes.statusCode).toBe(403);
        expect(badRes.payload.error).toBe('Invalid request origin.');
    });
});

describe('dashboard magic token cookie', () => {
    test('stores the landing token on the consume path and reads it back', () => {
        const calls = [];
        const res = {
            cookie(name, value, options) {
                calls.push({ type: 'cookie', name, value, options });
            },
            clearCookie(name, options) {
                calls.push({ type: 'clearCookie', name, options });
            }
        };
        const token = 'magic-token-abcdefghijklmnopqrstuvwxyz';
        const req = request({ cookie: `dashboard_magic_token=${encodeURIComponent(token)}` });

        setDashboardMagicTokenCookie(res, token, req);
        clearDashboardMagicTokenCookie(res, req);

        expect(readDashboardMagicTokenCookie(req)).toBe(token);
        expect(calls[0]).toMatchObject({
            type: 'cookie',
            name: 'dashboard_magic_token',
            value: token,
            options: {
                httpOnly: true,
                sameSite: 'lax',
                path: '/auth/magic/consume'
            }
        });
        expect(calls[1]).toMatchObject({
            type: 'clearCookie',
            name: 'dashboard_magic_token',
            options: {
                sameSite: 'lax',
                path: '/auth/magic/consume'
            }
        });
    });
});
