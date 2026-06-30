import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
    authenticateDashboardAccess,
    clearDashboardMagicTokenCookie,
    clearDashboardSessionAuthCache,
    isLocalDashboardOrigin,
    readDashboardMagicTokenCookie,
    revokeDashboardSession,
    setDashboardMagicTokenCookie
} from '../lib/dashboardAuth.ts';

const ORIGINAL_SECRET = process.env.SECRET_API_KEY;
const ORIGINAL_SESSION_AUTH_CACHE_SECONDS = process.env.DASHBOARD_SESSION_AUTH_CACHE_SECONDS;

function request({ origin, authorization, cookie } = {}) {
    const headers = {};
    if (origin !== undefined) headers.origin = origin;
    if (authorization) headers.authorization = authorization;
    if (cookie) headers.cookie = cookie;
    return { headers, ip: '127.0.0.1', protocol: 'http' };
}

function response() {
    return {
        statusCode: null,
        payload: null,
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
});

describe('dashboard local origin detection', () => {
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
    test('accepts the admin bearer key only from local dashboard origins', async () => {
        const pool = {
            query() {
                throw new Error('Local bearer auth should not query sessions.');
            }
        };

        const result = await runDashboardAuth(request({
            origin: 'null',
            authorization: 'Bearer test-secret'
        }), pool);

        expect(result.nextCalled).toBe(true);
        expect(result.res.statusCode).toBeNull();
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

    test('accepts a valid dashboard session from a remote browser origin', async () => {
        const pool = {
            async query() {
                return { rows: [{ id: 'session-id' }] };
            }
        };

        const result = await runDashboardAuth(request({
            origin: 'https://dashboard.example',
            cookie: `dashboard_session=${encodeURIComponent('a'.repeat(43))}`
        }), pool);

        expect(result.nextCalled).toBe(true);
        expect(result.res.statusCode).toBeNull();
    });

    test('caches valid dashboard session checks briefly to avoid repeated DB auth updates', async () => {
        const queries = [];
        const cookie = `dashboard_session=${encodeURIComponent('b'.repeat(43))}`;
        const pool = {
            async query(sql) {
                queries.push(String(sql));
                return { rows: [{ id: 'session-id' }] };
            }
        };

        const first = await runDashboardAuth(request({ origin: 'https://dashboard.example', cookie }), pool);
        const second = await runDashboardAuth(request({ origin: 'https://dashboard.example', cookie }), pool);

        expect(first.nextCalled).toBe(true);
        expect(second.nextCalled).toBe(true);
        expect(queries).toHaveLength(1);
    });

    test('revoke clears a cached dashboard session before the next auth check', async () => {
        const queries = [];
        let valid = true;
        const cookie = `dashboard_session=${encodeURIComponent('c'.repeat(43))}`;
        const req = request({ origin: 'https://dashboard.example', cookie });
        const pool = {
            async query(sql) {
                queries.push(String(sql));
                if (String(sql).includes('RETURNING id')) {
                    return { rows: valid ? [{ id: 'session-id' }] : [] };
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
        expect(queries.filter(sql => sql.includes('RETURNING id'))).toHaveLength(2);
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
