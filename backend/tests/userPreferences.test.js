import { describe, expect, test } from 'bun:test';
import {
    ensureUserPreferencesSchema,
    getUserPreference,
    getUserPreferences,
    setUserPreference,
    setUserPreferences,
    UserPreferenceValidationError,
    validatePreferenceKey,
    validatePreferenceValue
} from '../lib/userPreferences.ts';
import { migrationIds } from '../lib/migrations.ts';

describe('user preferences validation and persistence', () => {
    test('validates preference keys correctly', () => {
        expect(validatePreferenceKey('overviewCardMetrics')).toBe('overviewCardMetrics');
        expect(validatePreferenceKey('overviewCardVisibility')).toBe('overviewCardVisibility');

        expect(() => validatePreferenceKey('')).toThrow(UserPreferenceValidationError);
        expect(() => validatePreferenceKey('  ')).toThrow('Preference key is required');
        expect(() => validatePreferenceKey('key with spaces')).toThrow('invalid characters');
        expect(() => validatePreferenceKey('a'.repeat(101))).toThrow('100 characters or fewer');
        expect(() => validatePreferenceKey('custom_key-1')).toThrow("Unsupported preference key 'custom_key-1'");
    });

    test('validates overviewCardMetrics array format strictly', () => {
        const validMetrics = ['impressions', 'clicks', 'conversions', 'spend', 'ctr', 'avgCpc', 'cvr'];
        expect(validatePreferenceValue('overviewCardMetrics', validMetrics)).toEqual(validMetrics);

        // Wrong length (needs exactly 7)
        expect(() => validatePreferenceValue('overviewCardMetrics', ['impressions', 'clicks'])).toThrow(
            'array of exactly 7 metric keys'
        );

        // Duplicate items
        expect(() =>
            validatePreferenceValue('overviewCardMetrics', [
                'impressions',
                'clicks',
                'conversions',
                'spend',
                'ctr',
                'avgCpc',
                'clicks'
            ])
        ).toThrow('cannot contain duplicate metric keys');

        // Invalid metric name
        expect(() =>
            validatePreferenceValue('overviewCardMetrics', [
                'impressions',
                'clicks',
                'conversions',
                'spend',
                'ctr',
                'avgCpc',
                'invalidMetricKey'
            ])
        ).toThrow("Invalid metric key 'invalidMetricKey'");
    });

    test('validates overviewCardVisibility array format strictly', () => {
        const validVisibility = [true, true, false, true, true, false, true];
        expect(validatePreferenceValue('overviewCardVisibility', validVisibility)).toEqual(validVisibility);

        // Wrong length
        expect(() => validatePreferenceValue('overviewCardVisibility', [true, false])).toThrow(
            'array of exactly 7 booleans'
        );

        // Non-boolean item
        expect(() =>
            validatePreferenceValue('overviewCardVisibility', [true, true, 'false', true, true, false, true])
        ).toThrow('must be booleans');
    });

    test('ensures schema creation query is idempotent and creates required table', async () => {
        let executedSql = '';
        const mockPool = {
            async query(sql) {
                executedSql += sql;
                return { rows: [] };
            }
        };

        await ensureUserPreferencesSchema(mockPool);
        expect(executedSql).toContain('CREATE TABLE IF NOT EXISTS dashboard_user_preferences');
        expect(executedSql).toContain('CREATE INDEX IF NOT EXISTS dashboard_user_preferences_user_idx');
        expect(migrationIds()).toContain('202607220001_dashboard_user_preferences');
    });

    test('stores and retrieves user preferences using mock pool', async () => {
        const userId = '11111111-2222-4333-8444-555555555555';
        const dbStore = new Map();

        const mockDb = {
            async query(sql, params = []) {
                const text = String(sql);
                if (text.includes('INSERT INTO dashboard_user_preferences')) {
                    const [uId, key, jsonStr] = params;
                    dbStore.set(`${uId}:${key}`, JSON.parse(jsonStr));
                    return { rows: [] };
                }
                if (text.includes('SELECT pref_key, pref_value')) {
                    const [uId] = params;
                    const rows = [];
                    for (const [storeKey, val] of dbStore.entries()) {
                        if (storeKey.startsWith(`${uId}:`)) {
                            const prefKey = storeKey.split(':')[1];
                            rows.push({ pref_key: prefKey, pref_value: val });
                        }
                    }
                    return { rows };
                }
                if (text.includes('SELECT pref_value')) {
                    const [uId, key] = params;
                    const val = dbStore.get(`${uId}:${key}`);
                    return { rows: val !== undefined ? [{ pref_value: val }] : [] };
                }
                return { rows: [] };
            }
        };

        const testMetrics = ['conversions', 'cpa', 'cvr', 'allConversions', 'spend', 'impressions', 'clicks'];
        await setUserPreference(mockDb, userId, 'overviewCardMetrics', testMetrics);

        const fetchedMetric = await getUserPreference(mockDb, userId, 'overviewCardMetrics');
        expect(fetchedMetric).toEqual(testMetrics);

        const testVisibility = [true, false, true, false, true, false, true];
        await setUserPreference(mockDb, userId, 'overviewCardVisibility', testVisibility);

        const allPrefs = await getUserPreferences(mockDb, userId);
        expect(allPrefs).toEqual({
            overviewCardMetrics: testMetrics,
            overviewCardVisibility: testVisibility
        });
    });

    test('enforces user isolation between User A and User B', async () => {
        const userA = 'aaaaaaaa-1111-4111-8111-111111111111';
        const userB = 'bbbbbbbb-2222-4222-8222-222222222222';
        const dbStore = new Map();

        const mockDb = {
            async query(sql, params = []) {
                const text = String(sql);
                if (text.includes('INSERT INTO dashboard_user_preferences')) {
                    const [uId, key, jsonStr] = params;
                    dbStore.set(`${uId}:${key}`, JSON.parse(jsonStr));
                    return { rows: [] };
                }
                if (text.includes('SELECT pref_key, pref_value')) {
                    const [uId] = params;
                    const rows = [];
                    for (const [storeKey, val] of dbStore.entries()) {
                        if (storeKey.startsWith(`${uId}:`)) {
                            const prefKey = storeKey.split(':')[1];
                            rows.push({ pref_key: prefKey, pref_value: val });
                        }
                    }
                    return { rows };
                }
                return { rows: [] };
            }
        };

        const metricsA = ['ctr', 'avgCpc', 'cvr', 'conversions', 'spend', 'impressions', 'clicks'];
        const metricsB = ['impressions', 'clicks', 'conversions', 'spend', 'ctr', 'avgCpc', 'cvr'];

        await setUserPreference(mockDb, userA, 'overviewCardMetrics', metricsA);
        await setUserPreference(mockDb, userB, 'overviewCardMetrics', metricsB);

        const prefsA = await getUserPreferences(mockDb, userA);
        const prefsB = await getUserPreferences(mockDb, userB);

        expect(prefsA.overviewCardMetrics).toEqual(metricsA);
        expect(prefsB.overviewCardMetrics).toEqual(metricsB);
        expect(prefsA.overviewCardMetrics).not.toEqual(prefsB.overviewCardMetrics);
    });

    test('stores a multi-preference update in one atomic statement', async () => {
        const userId = '11111111-2222-4333-8444-555555555555';
        const stored = new Map();
        let insertCount = 0;
        const mockDb = {
            async query(sql, params = []) {
                const text = String(sql);
                if (text.includes('FROM jsonb_each')) {
                    insertCount += 1;
                    const [uId, json] = params;
                    for (const [key, value] of Object.entries(JSON.parse(json))) {
                        stored.set(`${uId}:${key}`, value);
                    }
                    return { rows: [] };
                }
                if (text.includes('SELECT pref_key, pref_value')) {
                    const [uId] = params;
                    return {
                        rows: [...stored.entries()]
                            .filter(([key]) => key.startsWith(`${uId}:`))
                            .map(([key, value]) => ({ pref_key: key.slice(key.indexOf(':') + 1), pref_value: value }))
                    };
                }
                return { rows: [] };
            }
        };
        const preferences = {
            overviewCardMetrics: ['conversions', 'cpa', 'cvr', 'allConversions', 'spend', 'impressions', 'clicks'],
            overviewCardVisibility: [true, false, true, false, true, false, true]
        };

        await expect(setUserPreferences(mockDb, userId, preferences)).resolves.toEqual(preferences);
        expect(insertCount).toBe(1);
    });
});
