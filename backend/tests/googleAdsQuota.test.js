import { afterEach, describe, expect, test } from 'bun:test';
import {
    configureGoogleAdsQuotaGovernor,
    ensureGoogleAdsQuotaSchema,
    googleAdsApiOperationCount,
    GoogleAdsQuotaError,
    googleAdsQuotaBucketRules,
    googleAdsQuotaFeedbackDelayMs,
    googleAdsOperationQuotaRule,
    googleAdsQueryResourceConsumptionCost,
    deferGoogleAdsQuota,
    recordGoogleAdsQueryResourceConsumption,
    waitForGoogleAdsQuota
} from '../lib/googleAdsQuota.ts';
import { createGoogleAdsQuotaTestPool } from './helpers/googleAdsQuotaPool.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
    configureGoogleAdsQuotaGovernor(null);
    process.env = { ...ORIGINAL_ENV };
});

describe('Google Ads quota governor', () => {
    test('schema creates shared quota token buckets', async () => {
        let sql = '';
        const pool = {
            async query(query) {
                sql += String(query);
                return { rows: [] };
            }
        };

        await ensureGoogleAdsQuotaSchema(pool);

        expect(sql).toContain('CREATE TABLE IF NOT EXISTS google_ads_quota_buckets');
        expect(sql).toContain('bucket_key TEXT PRIMARY KEY');
        expect(sql).toContain('blocked_until');
        expect(sql).toContain('CREATE TABLE IF NOT EXISTS google_ads_api_operation_usage');
        expect(sql).toContain('CREATE TABLE IF NOT EXISTS google_ads_query_resource_usage_hourly');
    });

    test('keeps rolling rate buckets separate from Google API operation accounting', () => {
        process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'dev-token';
        const readRules = googleAdsQuotaBucketRules({
            path: 'customers/123/googleAds:searchStream',
            body: { query: 'SELECT campaign.id, segments.date, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS' },
            retryMode: 'read'
        });
        const mutateRules = googleAdsQuotaBucketRules({
            path: 'customers/123/adGroupCriteria:mutate',
            body: { operations: [{ create: {} }, { create: {} }, { remove: 'x' }] },
            retryMode: 'mutate'
        });

        expect(readRules.map(rule => rule.bucketKey).join('\n')).toContain('google_ads:developer:');
        expect(readRules.map(rule => rule.bucketKey).join('\n')).toContain('google_ads:customer:123:minute');
        expect(readRules.some(rule => rule.bucketKey.includes(':daily:'))).toBe(false);
        expect(mutateRules.map(rule => rule.bucketKey).join('\n')).toContain('google_ads:mutate:123:minute');
        expect(readRules.find(rule => rule.bucketKey.includes(':minute'))?.cost).toBe(1);
    });

    test('counts Google Ads API operations according to request semantics', () => {
        const search = {
            path: 'customers/123/googleAds:searchStream',
            body: { query: 'SELECT campaign.id, segments.date, metrics.clicks FROM campaign' },
            retryMode: 'read'
        };
        const mutate = {
            path: 'customers/123/adGroupCriteria:mutate',
            body: { operations: [{ create: {} }, { create: {} }, { remove: 'x' }] },
            retryMode: 'mutate'
        };
        const validateOnly = { ...mutate, body: { ...mutate.body, validateOnly: true }, retryMode: 'validate_only' };

        expect(googleAdsApiOperationCount(search)).toBe(1);
        expect(googleAdsApiOperationCount(mutate)).toBe(3);
        expect(googleAdsApiOperationCount(validateOnly)).toBe(3);
    });

    test('uses the access-level operation setting with a legacy deployment fallback', () => {
        delete process.env.GOOGLE_ADS_QUOTA_DEVELOPER_OPERATIONS_PER_24_HOURS;
        process.env.GOOGLE_ADS_QUOTA_DEVELOPER_UNITS_PER_DAY = '15000';
        expect(googleAdsOperationQuotaRule({ path: 'customers/123/googleAds:searchStream' })?.limit).toBe(15000);

        process.env.GOOGLE_ADS_QUOTA_DEVELOPER_OPERATIONS_PER_24_HOURS = '0';
        expect(googleAdsOperationQuotaRule({ path: 'customers/123/googleAds:searchStream' })).toBeNull();
    });

    test('adds a Keyword Planner 1 QPS customer bucket for limited planning methods', () => {
        const rules = googleAdsQuotaBucketRules({
            path: 'customers/123:generateKeywordIdeas',
            retryMode: 'read'
        });
        const keywordPlanBucket = rules.find(rule => rule.bucketKey === 'google_ads:keyword_plan:123:second');

        expect(keywordPlanBucket).toMatchObject({
            capacity: 1,
            refillPerSecond: 1,
            cost: 1
        });
    });

    test('waitForGoogleAdsQuota debits shared DB buckets and fails fast when max wait is exceeded', async () => {
        process.env.GOOGLE_ADS_QUOTA_CUSTOMER_REQUESTS_PER_MINUTE = '1';
        process.env.GOOGLE_ADS_QUOTA_MAX_WAIT_MS = '0';
        const pool = createGoogleAdsQuotaTestPool();
        configureGoogleAdsQuotaGovernor(pool);

        await waitForGoogleAdsQuota({ path: 'customers/123/customers:listAccessibleCustomers', method: 'GET', retryMode: 'read' });
        await expect(waitForGoogleAdsQuota({ path: 'customers/123/customers:listAccessibleCustomers', method: 'GET', retryMode: 'read' }))
            .rejects.toThrow(GoogleAdsQuotaError);

        const customerMinute = Array.from(pool.buckets.keys()).find(key => key === 'google_ads:customer:123:minute');
        expect(customerMinute).toBeTruthy();
        expect(Number(pool.buckets.get(customerMinute).tokens)).toBeLessThan(1);
    });

    test('enforces the developer-token operation limit over a rolling 24-hour window', async () => {
        process.env.GOOGLE_ADS_QUOTA_DEVELOPER_OPERATIONS_PER_24_HOURS = '2';
        process.env.GOOGLE_ADS_QUOTA_DEVELOPER_REQUESTS_PER_MINUTE = '100';
        process.env.GOOGLE_ADS_QUOTA_CUSTOMER_REQUESTS_PER_MINUTE = '100';
        process.env.GOOGLE_ADS_QUOTA_MAX_WAIT_MS = '0';
        const pool = createGoogleAdsQuotaTestPool();
        configureGoogleAdsQuotaGovernor(pool);
        const request = { path: 'customers/123/googleAds:searchStream', retryMode: 'read' };

        await waitForGoogleAdsQuota(request);
        await waitForGoogleAdsQuota(request);
        await expect(waitForGoogleAdsQuota(request)).rejects.toThrow(GoogleAdsQuotaError);

        expect(pool.operationUsage).toHaveLength(2);
        expect(pool.operationUsage.map(row => row.operation_count)).toEqual([1, 1]);
        expect(Array.from(pool.buckets.keys()).some(key => key.includes(':daily:'))).toBe(false);
    });

    test('debits each mutate operation from the rolling developer-token allowance', async () => {
        process.env.GOOGLE_ADS_QUOTA_DEVELOPER_OPERATIONS_PER_24_HOURS = '3';
        process.env.GOOGLE_ADS_QUOTA_MAX_WAIT_MS = '0';
        const pool = createGoogleAdsQuotaTestPool();
        configureGoogleAdsQuotaGovernor(pool);

        await waitForGoogleAdsQuota({
            path: 'customers/123/campaigns:mutate',
            body: { operations: [{ create: {} }, { update: {} }, { remove: 'x' }] },
            retryMode: 'mutate'
        });

        expect(pool.operationUsage).toHaveLength(1);
        expect(pool.operationUsage[0].operation_count).toBe(3);
        await expect(waitForGoogleAdsQuota({
            path: 'customers/123/googleAds:searchStream',
            retryMode: 'read'
        })).rejects.toThrow(GoogleAdsQuotaError);
    });

    test('expires operation usage after 24 hours instead of resetting at UTC midnight', async () => {
        process.env.GOOGLE_ADS_QUOTA_DEVELOPER_OPERATIONS_PER_24_HOURS = '1';
        process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'rolling-token';
        const pool = createGoogleAdsQuotaTestPool();
        configureGoogleAdsQuotaGovernor(pool);
        const request = { path: 'customers/123/googleAds:searchStream', retryMode: 'read' };

        await waitForGoogleAdsQuota(request);
        pool.operationUsage[0].occurred_at = new Date(Date.now() - 24 * 60 * 60 * 1000 - 1000);

        await waitForGoogleAdsQuota(request);

        expect(pool.operationUsage).toHaveLength(1);
        expect(new Date(pool.operationUsage[0].occurred_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    test('records query resource consumption separately without debiting API operations', async () => {
        process.env.GOOGLE_ADS_QUOTA_CUSTOMER_REQUESTS_PER_MINUTE = '100';
        process.env.GOOGLE_ADS_QUOTA_MAX_WAIT_MS = '0';
        const pool = createGoogleAdsQuotaTestPool();
        configureGoogleAdsQuotaGovernor(pool);
        const request = {
            path: 'customers/123/googleAds:searchStream',
            body: { query: 'SELECT campaign.id FROM campaign LIMIT 10' },
            retryMode: 'read'
        };

        expect(googleAdsQueryResourceConsumptionCost({ query_resource_consumption: '40' })).toBe(40);
        await waitForGoogleAdsQuota(request);
        const customerMinute = 'google_ads:customer:123:minute';
        const minuteBefore = Number(pool.buckets.get(customerMinute).tokens);
        const operationsBefore = pool.operationUsage.reduce((sum, row) => sum + row.operation_count, 0);

        await recordGoogleAdsQueryResourceConsumption(request, { queryResourceConsumption: '40' });

        const minuteAfter = Number(pool.buckets.get(customerMinute).tokens);
        const operationsAfter = pool.operationUsage.reduce((sum, row) => sum + row.operation_count, 0);
        const resource = Array.from(pool.resourceUsage.values())[0];
        expect(minuteAfter).toBe(minuteBefore);
        expect(operationsAfter).toBe(operationsBefore);
        expect(resource).toMatchObject({ resource_consumption: 40, sample_count: 1 });
    });

    test('resource-exhausted feedback blocks rolling buckets without adding API operations', async () => {
        const pool = createGoogleAdsQuotaTestPool();
        configureGoogleAdsQuotaGovernor(pool);
        const request = {
            path: 'customers/123/googleAds:searchStream',
            body: { query: 'SELECT campaign.id FROM campaign LIMIT 10' },
            retryMode: 'read'
        };

        await waitForGoogleAdsQuota(request);
        const customerMinute = 'google_ads:customer:123:minute';
        const operationsBefore = pool.operationUsage.length;

        await deferGoogleAdsQuota(request, 60000);

        expect(Number(pool.buckets.get(customerMinute).tokens)).toBe(0);
        expect(pool.operationUsage).toHaveLength(operationsBefore);
    });

    test('uses distinct correction delays for query resource exhaustion signals', () => {
        expect(googleAdsQuotaFeedbackDelayMs({ exhaustionSignal: 'short_term_query_resource' })).toBe(300000);
        expect(googleAdsQuotaFeedbackDelayMs({ exhaustionSignal: 'long_term_query_resource' })).toBe(1800000);
        expect(googleAdsQuotaFeedbackDelayMs({ retryAfterMs: 7000, exhaustionSignal: 'long_term_query_resource' })).toBe(7000);
    });
});
