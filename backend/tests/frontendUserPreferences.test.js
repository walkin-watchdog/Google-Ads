import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { validatePreferenceValue } from '../lib/userPreferences.ts';

const appSource = fs.readFileSync(path.join(import.meta.dir, '..', 'client', 'app.js'), 'utf8');
const preferenceBlock = appSource.slice(
    appSource.indexOf('const OVERVIEW_TIME_SERIES_METRICS ='),
    appSource.indexOf('\nfunction renderCharts()', appSource.indexOf('const OVERVIEW_TIME_SERIES_METRICS ='))
);

const DEFAULT_METRICS = ['impressions', 'clicks', 'conversions', 'spend', 'ctr', 'avgCpc', 'cvr'];
const METRICS_KEY = 'zenseeo:overview-time-series-card-metrics:v2';
const VISIBILITY_KEY = 'zenseeo:overview-time-series-card-visibility:v2';

class MemoryStorage {
    constructor(entries = {}) {
        this.values = new Map(Object.entries(entries));
    }

    getItem(key) {
        return this.values.has(key) ? this.values.get(key) : null;
    }

    setItem(key, value) {
        this.values.set(key, String(value));
    }

    removeItem(key) {
        this.values.delete(key);
    }
}

function userKey(userId, baseKey) {
    return `zenseeo:user_${userId}:${baseKey}`;
}

function createPreferenceHarness({ storage, dashboardFetch, auth, online = true }) {
    let kpiRenders = 0;
    let chartRenders = 0;
    const factory = new Function(
        'localStorage',
        'dashboardFetch',
        'navigator',
        'renderGlobalKPIs',
        'renderOverviewTimeSeries',
        'initialAuth',
        `
            let DASHBOARD_AUTH = initialAuth;
            let API_BASE_GLOBAL = '';
            let dashboardData = null;
            ${preferenceBlock}
            return {
                migrate: migrateLegacyOverviewTimeSeriesPreferences,
                reload() {
                    overviewTimeSeriesCardMetrics = loadOverviewTimeSeriesMetrics();
                    overviewTimeSeriesVisibleSlots = loadOverviewTimeSeriesVisibility();
                },
                sync: syncUserPreferencesFromBackend,
                saveVisibility: saveOverviewTimeSeriesVisibilityPreference,
                setVisibility(value) { overviewTimeSeriesVisibleSlots = [...value]; },
                metricKeys() { return Object.keys(OVERVIEW_TIME_SERIES_METRICS); },
                metrics() { return [...overviewTimeSeriesCardMetrics]; },
                visibility() { return [...overviewTimeSeriesVisibleSlots]; },
                async flush() { await userPreferenceMutationChain; }
            };
        `
    );
    const harness = factory(
        storage,
        dashboardFetch,
        { onLine: online },
        () => { kpiRenders += 1; },
        () => { chartRenders += 1; },
        auth
    );
    return {
        ...harness,
        renderCounts: () => ({ kpi: kpiRenders, chart: chartRenders })
    };
}

describe('frontend user preference synchronization', () => {
    test('initializes named-user preferences in both online and offline session paths', () => {
        const bootstrapSource = appSource.slice(
            appSource.indexOf('async function bootstrapDashboardSession'),
            appSource.indexOf('\nfunction isStandalonePwa')
        );

        expect(bootstrapSource.match(/migrateLegacyOverviewTimeSeriesPreferences\(\);/g)).toHaveLength(2);
        expect(bootstrapSource.match(/overviewTimeSeriesCardMetrics = loadOverviewTimeSeriesMetrics\(\);/g)).toHaveLength(2);
        expect(bootstrapSource.match(/overviewTimeSeriesVisibleSlots = loadOverviewTimeSeriesVisibility\(\);/g)).toHaveLength(2);
        expect(bootstrapSource.indexOf('setCsrfToken?.(auth.csrfToken || null)'))
            .toBeLessThan(bootstrapSource.indexOf('syncUserPreferencesFromBackend(apiBase)'));
        expect(preferenceBlock).not.toContain('apiBase = API_BASE)');
    });

    test('keeps the frontend metric catalog compatible with backend validation', () => {
        const harness = createPreferenceHarness({
            storage: new MemoryStorage(),
            dashboardFetch: async () => new Response('{}'),
            auth: { user: null }
        });
        const metricKeys = harness.metricKeys();

        for (const metricKey of metricKeys) {
            const selection = [metricKey, ...metricKeys.filter(key => key !== metricKey)].slice(0, 7);
            expect(() => validatePreferenceValue('overviewCardMetrics', selection)).not.toThrow();
        }
    });

    test('claims an unscoped legacy value once instead of leaking it to later users', () => {
        const firstUser = '11111111-2222-4333-8444-555555555555';
        const secondUser = 'aaaaaaaa-1111-4111-8111-111111111111';
        const legacyMetrics = ['conversions', 'cpa', 'cvr', 'allConversions', 'spend', 'impressions', 'clicks'];
        const storage = new MemoryStorage({ [METRICS_KEY]: JSON.stringify(legacyMetrics) });
        const fetcher = async () => new Response('{}');

        const first = createPreferenceHarness({ storage, dashboardFetch: fetcher, auth: { user: { id: firstUser } } });
        first.migrate();
        first.reload();
        expect(first.metrics()).toEqual(legacyMetrics);
        expect(storage.getItem(METRICS_KEY)).toBeNull();
        expect(JSON.parse(storage.getItem(userKey(firstUser, METRICS_KEY)))).toEqual(legacyMetrics);

        const second = createPreferenceHarness({ storage, dashboardFetch: fetcher, auth: { user: { id: secondUser } } });
        second.migrate();
        second.reload();
        expect(second.metrics()).toEqual(DEFAULT_METRICS);
    });

    test('applies valid backend values without rendering before dashboard data exists', async () => {
        const userId = '11111111-2222-4333-8444-555555555555';
        const backendMetrics = ['conversions', 'cpa', 'cvr', 'allConversions', 'spend', 'impressions', 'clicks'];
        const backendVisibility = [true, false, true, false, true, false, true];
        const storage = new MemoryStorage();
        const requests = [];
        const harness = createPreferenceHarness({
            storage,
            auth: { user: { id: userId } },
            dashboardFetch: async (_url, options = {}) => {
                requests.push(options.method || 'GET');
                return new Response(JSON.stringify({
                    preferences: {
                        overviewCardMetrics: backendMetrics,
                        overviewCardVisibility: backendVisibility
                    }
                }), { headers: { 'Content-Type': 'application/json' } });
            }
        });

        await harness.sync();

        expect(harness.metrics()).toEqual(backendMetrics);
        expect(harness.visibility()).toEqual(backendVisibility);
        expect(harness.renderCounts()).toEqual({ kpi: 0, chart: 0 });
        expect(requests).toEqual(['GET']);
    });

    test('uploads pending local changes on reconnect instead of overwriting them with stale server state', async () => {
        const userId = '11111111-2222-4333-8444-555555555555';
        const localMetrics = ['ctr', 'avgCpc', 'cvr', 'conversions', 'spend', 'impressions', 'clicks'];
        const localVisibility = [false, true, false, true, false, true, false];
        const storage = new MemoryStorage({
            [userKey(userId, METRICS_KEY)]: JSON.stringify(localMetrics),
            [`${userKey(userId, METRICS_KEY)}:pending-sync`]: '1',
            [userKey(userId, VISIBILITY_KEY)]: JSON.stringify(localVisibility),
            [`${userKey(userId, VISIBILITY_KEY)}:pending-sync`]: '1'
        });
        const uploads = [];
        const harness = createPreferenceHarness({
            storage,
            auth: { user: { id: userId } },
            dashboardFetch: async (_url, options = {}) => {
                if (!options.method) {
                    return new Response(JSON.stringify({
                        preferences: {
                            overviewCardMetrics: DEFAULT_METRICS,
                            overviewCardVisibility: DEFAULT_METRICS.map(() => true)
                        }
                    }), { headers: { 'Content-Type': 'application/json' } });
                }
                uploads.push(JSON.parse(options.body));
                return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
            }
        });

        await harness.sync();

        expect(harness.metrics()).toEqual(localMetrics);
        expect(harness.visibility()).toEqual(localVisibility);
        expect(uploads).toEqual([{ preferences: {
            overviewCardMetrics: localMetrics,
            overviewCardVisibility: localVisibility
        } }]);
        expect(storage.getItem(`${userKey(userId, METRICS_KEY)}:pending-sync`)).toBeNull();
        expect(storage.getItem(`${userKey(userId, VISIBILITY_KEY)}:pending-sync`)).toBeNull();
    });

    test('serializes rapid writes so an older response cannot win last', async () => {
        const userId = '11111111-2222-4333-8444-555555555555';
        const storage = new MemoryStorage();
        const bodies = [];
        let activeRequests = 0;
        let maxActiveRequests = 0;
        const harness = createPreferenceHarness({
            storage,
            auth: { user: { id: userId } },
            dashboardFetch: async (_url, options = {}) => {
                activeRequests += 1;
                maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
                bodies.push(JSON.parse(options.body));
                await Promise.resolve();
                activeRequests -= 1;
                return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
            }
        });
        const first = [false, true, true, true, true, true, true];
        const second = [false, false, true, true, true, true, true];

        harness.setVisibility(first);
        harness.saveVisibility();
        harness.setVisibility(second);
        harness.saveVisibility();
        await harness.flush();

        expect(maxActiveRequests).toBe(1);
        expect(bodies.map(body => body.preferences.overviewCardVisibility)).toEqual([first, second]);
        expect(storage.getItem(`${userKey(userId, VISIBILITY_KEY)}:pending-sync`)).toBeNull();
    });
});
