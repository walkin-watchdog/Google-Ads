import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { executeGaqlStreamRows } from '../lib/googleAdsClient.ts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };
const root = path.join(import.meta.dir, '..');

beforeEach(() => {
    process.env.GOOGLE_ADS_API_VERSION = 'v24';
    process.env.GOOGLE_ADS_MAX_RETRIES = '0';
});

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    process.env = { ...ORIGINAL_ENV };
});

describe('Google Ads SearchStream refresh path', () => {
    function streamFromChunks(chunks) {
        const encoder = new TextEncoder();
        return new ReadableStream({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
                controller.close();
            }
        });
    }

    test('executeGaqlStreamRows reads SearchStream chunks and flattens rows', async () => {
        globalThis.fetch = async url => {
            expect(String(url)).toContain('googleAds:searchStream');
            return new Response(JSON.stringify([
                { results: [{ campaign: { id: '1', name: 'Core' }, metrics: { clicks: '3' } }] },
                { results: [{ campaign: { id: '2', name: 'Brand' }, metrics: { clicks: '5' } }] }
            ]), { status: 200 });
        };

        const rows = [];
        for await (const row of executeGaqlStreamRows({ token: 'tok', customerId: '123', query: 'SELECT campaign.id FROM campaign' })) {
            rows.push(row);
        }
        expect(rows).toEqual([
            { 'campaign.id': '1', 'campaign.name': 'Core', 'metrics.clicks': 3 },
            { 'campaign.id': '2', 'campaign.name': 'Brand', 'metrics.clicks': 5 }
        ]);
    });

    test('executeGaqlStreamRows handles JSON objects split across network chunks', async () => {
        const payload = JSON.stringify([
            { results: [{ campaign: { id: '1', name: 'Core {A}' }, metrics: { clicks: '3' } }] },
            { results: [{ campaign: { id: '2', name: 'Brand' }, metrics: { clicks: '5' } }] }
        ]);
        globalThis.fetch = async () => new Response(streamFromChunks([
            payload.slice(0, 17),
            payload.slice(17, 48),
            payload.slice(48, 93),
            payload.slice(93)
        ]), { status: 200 });

        const rows = [];
        for await (const row of executeGaqlStreamRows({ token: 'tok', customerId: '123', query: 'SELECT campaign.id FROM campaign' })) {
            rows.push(row);
        }

        expect(rows).toEqual([
            { 'campaign.id': '1', 'campaign.name': 'Core {A}', 'metrics.clicks': 3 },
            { 'campaign.id': '2', 'campaign.name': 'Brand', 'metrics.clicks': 5 }
        ]);
    });

    test('refresh pipeline uses SearchStream and streaming warehouse primitives, not paged executeGaql', () => {
        const refresh = fs.readFileSync(path.join(root, 'scripts/refresh_google_ads_data.ts'), 'utf8');
        const server = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');
        expect(refresh).toContain('executeGaqlStreamRows');
        expect(refresh).toContain('prepareMappedReportReplacement');
        expect(refresh).toContain('appendMappedReportRows');
        expect(refresh).toContain('finalizeMappedReportReplacement');
        expect(refresh).toContain('abortMappedReportReplacement');
        expect(refresh).toContain('appendMappedReportRows(pool!, mapped, warehouseRunId, replacement!)');
        expect(refresh).toContain('--run-id');
        expect(server).toContain('upsertWarehouseRefreshRunStarted');
        expect(server).toContain('enqueueRefreshJob');
        expect(server).toContain('PostgresRefreshQueueWorker');
        expect(server).toContain('refreshQueueWorker?.poke()');
        expect(server).toContain('assertQueuedWarehouseRunCompleted');
        expect(server).toContain("status === 'succeeded' || status === 'partial'");
        expect(server).not.toContain('let refreshJob');
        expect(server).not.toContain('lastRefreshStartedAtMs');
        expect(refresh).toContain('acquireWarehouseRefreshLock');
        expect(refresh).not.toContain('executeGaql(token');
    });

    test('warehouse refresh run retries clear stale terminal state before marking running', () => {
        const warehouse = fs.readFileSync(path.join(root, 'lib', 'adsWarehouse.ts'), 'utf8');
        expect(warehouse).toContain("status = 'running'");
        expect(warehouse).toContain('completed_at = NULL');
        expect(warehouse).toContain("source_summary = '{}'::jsonb");
        expect(warehouse).toContain('error = NULL');
    });

    test('an explicit one-day queued window wins over empty-warehouse backfill detection', () => {
        const refresh = fs.readFileSync(path.join(root, 'scripts/refresh_google_ads_data.ts'), 'utf8');
        const explicitWindow = refresh.indexOf('if (explicitRepair)');
        const emptyWarehouseCheck = refresh.indexOf('const warehouseEmpty = !(await hasWarehouseData(db))');
        expect(explicitWindow).toBeGreaterThan(-1);
        expect(emptyWarehouseCheck).toBeGreaterThan(explicitWindow);
        expect(refresh).toContain("kind: queuedKind || 'repair'");
        expect(refresh).toContain('loadQueuedRefreshKind');
    });

    test('App/browser and cooldown cron use light analysis while Data and eligible cron stay full', () => {
        const refresh = fs.readFileSync(path.join(root, 'scripts/refresh_google_ads_data.ts'), 'utf8');
        const server = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');
        const app = fs.readFileSync(path.join(root, 'client', 'app.js'), 'utf8');
        expect(app).toContain("refreshProfile: 'light_today'");
        expect(app).not.toContain('clientRefresh: true');
        expect(app).toContain('requestFullDataRefresh(API_BASE)');
        expect(app).toContain('requestTodayDataRefresh(API_BASE, { force: true })');
        expect(server).toContain("const CLIENT_TODAY_REFRESH_SOURCE = 'dashboard_client_today'");
        expect(server).toContain("const CRON_COOLDOWN_TODAY_REFRESH_SOURCE = 'cron_cooldown_today'");
        expect(server).toContain('LIGHT_TODAY_REFRESH_SOURCES.includes(job.source)');
        expect(server).toContain('job.source <> ALL($1::text[])');
        expect(server).toContain('resolveTriggerRefreshRequest(req.body, { force })');
        expect(server).toContain('startDate: refreshRequest.startDate');
        expect(server).toContain('shouldRunCronCooldownLightRefresh(refreshRequest, result)');
        expect(server).toContain('source: CRON_COOLDOWN_TODAY_REFRESH_SOURCE');
        expect(refresh).toContain("if (args[i] === '--light-client-refresh') lightClientRefresh = true");
        expect(refresh).toContain('Skipping Auction Insights external feed for light client refresh.');
        expect(refresh).toContain('Skipping candidate signal generation for light client refresh.');
        expect(refresh).toContain('full Data-button and full scheduled cron refreshes update this source.');
        expect(refresh).toContain('full Data-button and full scheduled cron refreshes regenerate them.');
    });
});
