import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import 'fake-indexeddb/auto';
import { openDB } from 'idb';

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalIdb = globalThis.idb;
const originalFetch = globalThis.fetch;
const originalCustomEvent = globalThis.CustomEvent;

describe('named-user offline storage isolation and pending logout', () => {
    let offline;
    const cookieJar = new Map();

    beforeAll(async () => {
        globalThis.window = {
            location: { origin: 'https://dashboard.example' },
            dispatchEvent() {}
        };
        globalThis.document = {};
        Object.defineProperty(globalThis.document, 'cookie', {
            configurable: true,
            get() {
                return Array.from(cookieJar, ([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');
            },
            set(header) {
                const [pair, ...attributes] = String(header).split(';');
                const separator = pair.indexOf('=');
                if (separator < 1) return;
                const name = pair.slice(0, separator).trim();
                const value = decodeURIComponent(pair.slice(separator + 1));
                const expired = attributes.some(attribute => /^\s*Max-Age=0\s*$/i.test(attribute));
                if (expired) cookieJar.delete(name);
                else cookieJar.set(name, value);
            }
        });
        globalThis.idb = { openDB };
        if (!globalThis.CustomEvent) {
            globalThis.CustomEvent = class CustomEvent {
                constructor(type, options = {}) {
                    this.type = type;
                    this.detail = options.detail;
                }
            };
        }
        await import('../client/offline.js');
        offline = globalThis.window.ZenseeoOffline;
    });

    beforeEach(async () => {
        cookieJar.clear();
        cookieJar.set('dashboard_csrf', 'csrf-from-cookie');
        offline.setCsrfToken(null);
        await offline.detachPrivateContext();
        const db = await offline.openDb();
        for (const store of ['offlineSessions', 'dashboardResponses', 'leadLabelQueue', 'conflicts']) {
            await db.clear(store);
        }
    });

    afterAll(() => {
        globalThis.window = originalWindow;
        globalThis.document = originalDocument;
        globalThis.idb = originalIdb;
        globalThis.fetch = originalFetch;
        globalThis.CustomEvent = originalCustomEvent;
    });

    test('magic mode detaches the previous named user from offline reopening without deleting namespaced data', async () => {
        const user = { mode: 'user', user: { id: 'user-a', email: 'a@example.com', name: 'Admin A' } };
        await offline.refreshSession(user);
        expect(offline.activeSession.userId).toBe('user-a');

        await offline.refreshSession({ mode: 'magic', user: null });

        expect(offline.activeSession).toBeNull();
        expect(await offline.lastActiveValidSession()).toBeNull();
        const db = await offline.openDb();
        expect(await db.get('offlineSessions', 'user:user-a')).toBeDefined();
        expect(await db.get('offlineSessions', 'lastActiveUser')).toBeUndefined();
    });

    test('pending logout keeps its marker on HTTP failure and clears it only after server logout succeeds', async () => {
        await offline.refreshSession({ mode: 'user', user: { id: 'user-a', email: 'a@example.com', name: 'Admin A' } });
        await offline.markOfflineLogout();
        const db = await offline.openDb();
        expect(await db.get('offlineSessions', 'logout_pending:user-a')).toBeDefined();

        globalThis.fetch = async () => new Response(JSON.stringify({ error: 'CSRF token required.' }), { status: 403 });
        expect(await offline.completePendingLogout('')).toBe(false);
        expect(await db.get('offlineSessions', 'logout_pending:user-a')).toBeDefined();

        let csrfHeader = null;
        globalThis.fetch = async (_url, options) => {
            csrfHeader = new Headers(options.headers).get('X-CSRF-Token');
            return new Response('Signed out', { status: 200 });
        };
        expect(await offline.completePendingLogout('')).toBe(true);
        expect(csrfHeader).toBe('csrf-from-cookie');
        expect(await db.get('offlineSessions', 'logout_pending:user-a')).toBeUndefined();
    });

    test('fresh explicit authentication discards stale pending logout without logging out the new session', async () => {
        const db = await offline.openDb();
        await db.put('offlineSessions', { key: 'logout_pending:stale-user', userId: 'stale-user', createdAt: Date.now() });
        let fetchCalls = 0;
        globalThis.fetch = async () => {
            fetchCalls += 1;
            return new Response('Signed out', { status: 200 });
        };

        await offline.clearPendingLogoutMarkers();

        expect(await db.get('offlineSessions', 'logout_pending:stale-user')).toBeUndefined();
        expect(fetchCalls).toBe(0);
    });

    test('successful queued lead sync invalidates stale dashboard snapshots', async () => {
        await offline.refreshSession({ mode: 'user', user: { id: 'user-a', email: 'a@example.com', name: 'Admin A' } });
        const dashboardUrl = '/api/dashboard?view=overview';
        await offline.cachedDashboardFetch(
            dashboardUrl,
            async () => new Response(JSON.stringify({ summary: { clicks: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        );
        await offline.queueLeadStatus({ sessionKey: 'session:one', status: 'qualified', baseUpdatedAt: '2026-07-10T00:00:00.000Z' });
        globalThis.fetch = async () => new Response(JSON.stringify({ status: 'qualified', updatedAt: '2026-07-10T00:01:00.000Z' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

        expect(await offline.syncLeadQueue('')).toEqual({ synced: 1, conflicts: 0 });
        await expect(offline.cachedDashboardFetch(dashboardUrl, async () => {
            throw new TypeError('offline');
        })).rejects.toThrow('offline');
    });

    test('refuses offline lead edits without an optimistic-concurrency version', async () => {
        await offline.refreshSession({ mode: 'user', user: { id: 'user-a', email: 'a@example.com', name: 'Admin A' } });

        await expect(offline.queueLeadStatus({ sessionKey: 'session:missing-version', status: 'qualified' }))
            .rejects.toThrow('server version');

        const db = await offline.openDb();
        expect(await db.get('leadLabelQueue', 'user-a:session:missing-version')).toBeUndefined();
    });

    test('does not cache an in-flight response after the active user changes', async () => {
        await offline.refreshSession({ mode: 'user', user: { id: 'user-a', email: 'a@example.com', name: 'Admin A' } });
        let resolveFetch;
        const pending = offline.cachedDashboardFetch('/api/dashboard?view=overview', () => new Promise(resolve => {
            resolveFetch = resolve;
        }));

        await offline.refreshSession({ mode: 'user', user: { id: 'user-b', email: 'b@example.com', name: 'Admin B' } });
        resolveFetch(new Response(JSON.stringify({ owner: 'user-a' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        }));

        await expect(pending).rejects.toThrow('active dashboard user changed');
        const db = await offline.openDb();
        expect(await db.get('dashboardResponses', 'user-a:/api/dashboard?view=overview')).toBeUndefined();
        expect(await db.get('dashboardResponses', 'user-b:/api/dashboard?view=overview')).toBeUndefined();
    });

    test('does not disguise a successful non-JSON server response as offline cached data', async () => {
        await offline.refreshSession({ mode: 'user', user: { id: 'user-a', email: 'a@example.com', name: 'Admin A' } });
        const url = '/api/dashboard?view=overview';
        await offline.cachedDashboardFetch(
            url,
            async () => new Response(JSON.stringify({ owner: 'cached-user-a' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        );

        const response = await offline.cachedDashboardFetch(
            url,
            async () => new Response('<html>unexpected proxy response</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
        );

        expect(response.headers.get('X-Zenseeo-Offline')).toBeNull();
        expect(await response.text()).toContain('unexpected proxy response');
    });

    test('moves only complete 409 responses to the explicit conflict store', async () => {
        await offline.refreshSession({ mode: 'user', user: { id: 'user-a', email: 'a@example.com', name: 'Admin A' } });
        await offline.queueLeadStatus({
            sessionKey: 'session:conflict',
            status: 'qualified',
            baseUpdatedAt: '2026-07-10T00:00:00.000Z'
        });
        globalThis.fetch = async () => new Response(JSON.stringify({
            conflict: { serverStatus: 'converted', serverUpdatedAt: '2026-07-10T00:01:00.000Z' }
        }), { status: 409, headers: { 'Content-Type': 'application/json' } });

        expect(await offline.syncLeadQueue('')).toEqual({ synced: 0, conflicts: 1 });
        expect(await offline.queuedLeadStatus('session:conflict')).toBeNull();
        expect(await offline.conflicts()).toMatchObject([{
            sessionKey: 'session:conflict',
            offlineStatus: 'qualified',
            serverStatus: 'converted',
            serverUpdatedAt: '2026-07-10T00:01:00.000Z'
        }]);

        await offline.queueLeadStatus({
            sessionKey: 'session:malformed-conflict',
            status: 'qualified',
            baseUpdatedAt: '2026-07-10T00:00:00.000Z'
        });
        globalThis.fetch = async () => new Response(JSON.stringify({ conflict: { serverStatus: 'converted' } }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' }
        });

        expect(await offline.syncLeadQueue('')).toEqual({ synced: 0, conflicts: 0 });
        expect(await offline.queuedLeadStatus('session:malformed-conflict')).toBeDefined();
    });

    test('pauses queued writes on CSRF rejection instead of hammering unrelated leads', async () => {
        await offline.refreshSession({ mode: 'user', user: { id: 'user-a', email: 'a@example.com', name: 'Admin A' } });
        for (const sessionKey of ['session:csrf-one', 'session:csrf-two']) {
            await offline.queueLeadStatus({
                sessionKey,
                status: 'qualified',
                baseUpdatedAt: '2026-07-10T00:00:00.000Z'
            });
        }
        let fetchCalls = 0;
        globalThis.fetch = async () => {
            fetchCalls += 1;
            return new Response(JSON.stringify({ error: 'CSRF token required.' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' }
            });
        };

        expect(await offline.syncLeadQueue('')).toEqual({ synced: 0, conflicts: 0 });
        expect(fetchCalls).toBe(1);
        expect(await offline.queuedLeadStatus('session:csrf-one')).toBeDefined();
        expect(await offline.queuedLeadStatus('session:csrf-two')).toBeDefined();
    });
});
