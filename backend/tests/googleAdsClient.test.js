import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { executeGaqlWithMetadata, googleAdsApiUrl, googleAdsHeaders, requestGoogleAdsJson } from '../lib/googleAdsClient.ts';
import { configureGoogleAdsQuotaGovernor } from '../lib/googleAdsQuota.ts';
import { createGoogleAdsQuotaTestPool } from './helpers/googleAdsQuotaPool.js';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
    process.env.GOOGLE_ADS_API_VERSION = 'v99';
    process.env.GOOGLE_ADS_MAX_RETRIES = '1';
    process.env.GOOGLE_ADS_RETRY_BASE_MS = '0';
    process.env.GOOGLE_ADS_RETRY_MAX_MS = '1';
});

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    configureGoogleAdsQuotaGovernor(null);
    process.env = { ...ORIGINAL_ENV };
});

describe('Google Ads centralized client', () => {
    test('builds configurable versioned URLs', () => {
        expect(googleAdsApiUrl('customers:listAccessibleCustomers')).toBe('https://googleads.googleapis.com/v99/customers:listAccessibleCustomers');
    });

    test('normalizes login customer ID headers to the REST hyphenless format', () => {
        process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'dev-token';
        process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = '123-456-7890';

        expect(googleAdsHeaders('tok')['login-customer-id']).toBe('1234567890');
    });

    test('retries read requests on retryable failures', async () => {
        const calls = [];
        globalThis.fetch = async url => {
            calls.push(String(url));
            if (calls.length === 1) {
                return new Response(JSON.stringify({ error: { status: 'UNAVAILABLE', message: 'try again' } }), { status: 503 });
            }
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'request-id': 'req2' } });
        };

        const result = await requestGoogleAdsJson({ token: 'tok', path: 'customers:listAccessibleCustomers', method: 'GET', retryMode: 'read' });
        expect(result.data).toEqual({ ok: true });
        expect(result.requestId).toBe('req2');
        expect(calls).toHaveLength(2);
    });

    test('does not retry live mutate execution', async () => {
        let calls = 0;
        globalThis.fetch = async () => {
            calls += 1;
            return new Response(JSON.stringify({ error: { status: 'UNAVAILABLE', message: 'mutate failed' } }), { status: 503 });
        };

        await expect(requestGoogleAdsJson({ token: 'tok', path: 'customers/1/campaigns:mutate', body: { operations: [] }, retryMode: 'mutate' })).rejects.toThrow(/Google Ads API request failed/);
        expect(calls).toBe(1);
    });

    test('retries validate-only mutation previews', async () => {
        let calls = 0;
        globalThis.fetch = async () => {
            calls += 1;
            if (calls === 1) return new Response(JSON.stringify({ error: { status: 'UNAVAILABLE' } }), { status: 503 });
            return new Response(JSON.stringify({ results: [] }), { status: 200 });
        };

        await requestGoogleAdsJson({ token: 'tok', path: 'customers/1/campaigns:mutate', body: { operations: [], validateOnly: true }, retryMode: 'validate_only' });
        expect(calls).toBe(2);
    });

    test('runs bounded GAQL through SearchStream instead of paged search', async () => {
        const urls = [];
        globalThis.fetch = async url => {
            urls.push(String(url));
            return new Response(JSON.stringify([
                { results: [{ campaign: { id: '1' }, metrics: { clicks: '2' } }] }
            ]), { status: 200, headers: { 'request-id': 'stream-req' } });
        };

        const result = await executeGaqlWithMetadata('tok', '123', 'SELECT campaign.id, metrics.clicks FROM campaign LIMIT 10', { maxRows: 5 });
        expect(urls[0]).toContain('googleAds:searchStream');
        expect(urls[0]).not.toContain('googleAds:search?');
        expect(result.requestId).toBe('stream-req');
        expect(result.rows).toEqual([{ 'campaign.id': '1', 'metrics.clicks': 2 }]);
    });

    test('preserves detailed GAQL errors returned in SearchStream array envelopes', async () => {
        globalThis.fetch = async () => new Response(JSON.stringify([{
            error: {
                code: 400,
                message: 'Request contains an invalid argument.',
                status: 'INVALID_ARGUMENT',
                details: [{
                    errors: [{
                        errorCode: { queryError: 'BAD_ENUM_CONSTANT' },
                        message: "Invalid enum value cannot be included in WHERE clause: 'EXTENDED_DEMOGRAPHIC'."
                    }]
                }]
            }
        }]), { status: 400, headers: { 'request-id': 'bad-enum-request' } });

        let caught;
        try {
            await executeGaqlWithMetadata('tok', '123', 'SELECT campaign.id FROM campaign_criterion LIMIT 10');
        } catch (err) {
            caught = err;
        }

        expect(caught).toMatchObject({
            status: 400,
            requestId: 'bad-enum-request',
            googleAdsErrors: [{ errorCode: { queryError: 'BAD_ENUM_CONSTANT' } }]
        });
        expect(caught.message).toContain('BAD_ENUM_CONSTANT');
        expect(caught.message).toContain('EXTENDED_DEMOGRAPHIC');
    });

    test('tracks SearchStream resource consumption separately from API operation usage', async () => {
        process.env.GOOGLE_ADS_QUOTA_CUSTOMER_REQUESTS_PER_MINUTE = '100';
        process.env.GOOGLE_ADS_QUOTA_MAX_WAIT_MS = '0';
        const pool = createGoogleAdsQuotaTestPool();
        configureGoogleAdsQuotaGovernor(pool);
        globalThis.fetch = async () => new Response(JSON.stringify([
            { results: [{ campaign: { id: '1' } }] },
            { queryResourceConsumption: '40', results: [] }
        ]), { status: 200 });

        await executeGaqlWithMetadata('tok', '123', 'SELECT campaign.id FROM campaign LIMIT 10', { maxRows: 5 });

        expect(Number(pool.buckets.get('google_ads:customer:123:minute').tokens)).toBe(99);
        expect(pool.operationUsage).toHaveLength(1);
        expect(pool.operationUsage[0].operation_count).toBe(1);
        expect(Array.from(pool.resourceUsage.values())[0]).toMatchObject({
            customer_id: '123',
            resource_consumption: 40,
            sample_count: 1
        });
    });

    test('keeps the timeout active while reading successful response bodies', async () => {
        process.env.GOOGLE_ADS_MAX_RETRIES = '0';
        globalThis.fetch = async (_url, init) => {
            const encoder = new TextEncoder();
            return new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode('{"still":"open"'));
                    init.signal.addEventListener('abort', () => {
                        const err = new Error('aborted');
                        err.name = 'AbortError';
                        controller.error(err);
                    });
                }
            }), { status: 200, headers: { 'request-id': 'body-timeout' } });
        };

        await expect(requestGoogleAdsJson({
            token: 'tok',
            path: 'customers:listAccessibleCustomers',
            method: 'GET',
            retryMode: 'read',
            timeoutMs: 10
        })).rejects.toThrow(/response body timed out/);
    });

    test('cancels SearchStream response bodies after maxRows truncation', async () => {
        let cancelled = false;
        globalThis.fetch = async () => {
            const encoder = new TextEncoder();
            return new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode(JSON.stringify([
                        { results: [{ campaign: { id: '1' } }, { campaign: { id: '2' } }] }
                    ])));
                },
                cancel() {
                    cancelled = true;
                }
            }), { status: 200, headers: { 'request-id': 'stream-cancelled' } });
        };

        const result = await executeGaqlWithMetadata('tok', '123', 'SELECT campaign.id FROM campaign LIMIT 10', { maxRows: 1 });

        expect(result.truncated).toBe(true);
        expect(result.rows).toEqual([{ 'campaign.id': '1' }]);
        expect(cancelled).toBe(true);
    });
});
