import { beforeEach, describe, expect, test } from 'bun:test';
import {
    clearAdsWarehouseRuntimeCaches,
    getAvailableDashboardFilters,
    getDashboardOverviewReportBundle,
    getDashboardReportBundleForView,
    getWarehouseWatermark
} from '../lib/adsWarehouse.ts';

class RecordingPool {
    constructor() {
        this.queries = [];
    }

    async query(sql) {
        this.queries.push(sql.replace(/\s+/g, ' ').trim());
        return { rows: [] };
    }

    queried(table) {
        return this.queries.some(query => query.includes(`FROM ${table}`));
    }

    queryFor(table) {
        return this.queries.find(query => query.includes(`FROM ${table}`)) || '';
    }
}

const filters = {
    customerId: '1234567890',
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    campaignId: null,
    adGroupId: null
};

describe('dashboard view warehouse bundles', () => {
    beforeEach(() => {
        clearAdsWarehouseRuntimeCaches();
    });

    test('overview view reads small segment summaries for visible overview charts only', async () => {
        const pool = new RecordingPool();

        await getDashboardOverviewReportBundle(pool, filters);

        expect(pool.queried('google_ads_device_daily')).toBe(true);
        expect(pool.queried('google_ads_day_of_week_daily')).toBe(true);
        expect(pool.queried('google_ads_day_hour_daily')).toBe(true);
        expect(pool.queryFor('google_ads_device_daily')).toContain('GROUP BY');
        expect(pool.queryFor('google_ads_day_of_week_daily')).toContain('GROUP BY');
        expect(pool.queryFor('google_ads_day_hour_daily')).toContain('GROUP BY');
        expect(pool.queried('google_ads_landing_page_daily')).toBe(false);
        expect(pool.queried('google_ads_auction_insights_rows')).toBe(false);
        expect(pool.queried('google_ads_keyword_planner_ideas')).toBe(false);
    });

    test('keywords view skips rank-only and attribution tables while reusing overview segment summaries', async () => {
        const pool = new RecordingPool();

        await getDashboardReportBundleForView(pool, filters, 'keywords');

        expect(pool.queried('google_ads_keyword_daily')).toBe(true);
        expect(pool.queried('google_ads_search_term_daily')).toBe(true);
        expect(pool.queried('google_ads_keyword_planner_ideas')).toBe(true);
        expect(pool.queried('google_ads_quality_score_snapshot')).toBe(true);
        expect(pool.queried('google_ads_device_daily')).toBe(true);
        expect(pool.queried('google_ads_day_of_week_daily')).toBe(true);
        expect(pool.queried('google_ads_day_hour_daily')).toBe(true);
        expect(pool.queried('google_ads_landing_page_daily')).toBe(false);
        expect(pool.queried('google_ads_conversion_action_daily')).toBe(false);
        expect(pool.queried('google_ads_click_evidence_daily')).toBe(false);
        expect(pool.queried('google_ads_auction_insights_rows')).toBe(false);
    });

    test('rank view skips planner and attribution tables', async () => {
        const pool = new RecordingPool();

        await getDashboardReportBundleForView(pool, filters, 'rank');

        expect(pool.queried('google_ads_keyword_daily')).toBe(true);
        expect(pool.queried('google_ads_search_term_daily')).toBe(true);
        expect(pool.queried('google_ads_landing_page_daily')).toBe(true);
        expect(pool.queried('google_ads_device_daily')).toBe(true);
        expect(pool.queried('google_ads_auction_insights_rows')).toBe(true);
        expect(pool.queried('google_ads_keyword_planner_ideas')).toBe(false);
        expect(pool.queried('google_ads_conversion_action_daily')).toBe(false);
        expect(pool.queried('google_ads_click_evidence_daily')).toBe(false);
    });

    test('keyword discovery view reads grouped bounded discovery rows', async () => {
        const pool = new RecordingPool();

        await getDashboardReportBundleForView(pool, filters, 'keywords');

        const keywordSql = pool.queryFor('google_ads_keyword_daily');
        const searchTermSql = pool.queryFor('google_ads_search_term_daily');
        const plannerSql = pool.queryFor('google_ads_keyword_planner_ideas');

        expect(keywordSql.startsWith('SELECT *')).toBe(false);
        expect(keywordSql).toContain('GROUP BY');
        expect(keywordSql).toContain('LIMIT');
        expect(searchTermSql.startsWith('SELECT *')).toBe(false);
        expect(searchTermSql).toContain('GROUP BY');
        expect(searchTermSql).toContain('LIMIT');
        expect(plannerSql).toContain('LIMIT');
    });

    test('rank view reads grouped bounded rank-support rows without configured keywords', async () => {
        const pool = new RecordingPool();

        await getDashboardReportBundleForView(pool, filters, 'rank');

        for (const table of [
            'google_ads_keyword_daily',
            'google_ads_search_term_daily',
            'google_ads_device_daily',
            'google_ads_day_of_week_daily',
            'google_ads_day_hour_daily',
            'google_ads_landing_page_daily'
        ]) {
            const sql = pool.queryFor(table);
            expect(sql.startsWith('SELECT *')).toBe(false);
            expect(sql).toContain('GROUP BY');
        }
        expect(pool.queried('google_ads_configured_keywords')).toBe(false);
        expect(pool.queryFor('google_ads_auction_insights_rows')).toContain('LIMIT');
        expect(pool.queryFor('candidate_signals')).toContain('LIMIT');
    });

    test('attribution view skips keyword, planner, rank, and proposal tables', async () => {
        const pool = new RecordingPool();

        await getDashboardReportBundleForView(pool, filters, 'attribution');

        expect(pool.queried('google_ads_conversion_action_daily')).toBe(true);
        expect(pool.queried('google_ads_conversion_search_term_daily')).toBe(true);
        expect(pool.queried('google_ads_click_evidence_daily')).toBe(true);
        expect(pool.queried('google_ads_keyword_daily')).toBe(false);
        expect(pool.queried('google_ads_search_term_daily')).toBe(false);
        expect(pool.queried('google_ads_keyword_planner_ideas')).toBe(false);
        expect(pool.queried('google_ads_landing_page_daily')).toBe(false);
        expect(pool.queried('candidate_signals')).toBe(false);
    });

    test('proposals view reads only summary, snapshots, coverage, and candidate signals', async () => {
        const pool = new RecordingPool();

        await getDashboardReportBundleForView(pool, filters, 'proposals');

        expect(pool.queried('candidate_signals')).toBe(true);
        expect(pool.queryFor('candidate_signals')).toContain("WHEN 'critical' THEN 1");
        expect(pool.queryFor('candidate_signals')).toContain('generated_at DESC');
        expect(pool.queried('google_ads_campaign_daily')).toBe(true);
        expect(pool.queried('google_ads_ad_group_daily')).toBe(true);
        expect(pool.queried('google_ads_keyword_daily')).toBe(false);
        expect(pool.queried('google_ads_search_term_daily')).toBe(false);
        expect(pool.queried('google_ads_keyword_planner_ideas')).toBe(false);
        expect(pool.queried('google_ads_landing_page_daily')).toBe(false);
        expect(pool.queried('google_ads_conversion_action_daily')).toBe(false);
        expect(pool.queried('google_ads_auction_insights_rows')).toBe(false);
    });

    test('filtered proposal signals retain parent-scope account and campaign signals', async () => {
        const pool = new RecordingPool();

        await getDashboardReportBundleForView(pool, {
            ...filters,
            campaignId: '111',
            adGroupId: '222'
        }, 'proposals');

        const signalSql = pool.queryFor('candidate_signals');
        expect(signalSql).toContain('(campaign_id = $4 OR campaign_id IS NULL)');
        expect(signalSql).toContain('(ad_group_id = $5 OR ad_group_id IS NULL)');
    });

    test('warehouse watermarks read maintained slice fingerprints for filtered views', async () => {
        const pool = new RecordingPool();

        await getWarehouseWatermark(pool, {
            ...filters,
            campaignId: '111',
            adGroupId: '222'
        });

        const watermarkSql = pool.queryFor('google_ads_warehouse_slice_fingerprints');
        expect(watermarkSql).toContain('FROM google_ads_warehouse_slice_fingerprints');
        expect(watermarkSql).not.toContain('candidate_signals');
        expect(watermarkSql).not.toContain('MAX(');
    });

    test('warehouse watermarks avoid per-source timestamp scans', async () => {
        const pool = new RecordingPool();

        await getWarehouseWatermark(pool, filters);

        expect(pool.queryFor('google_ads_warehouse_slice_fingerprints')).toContain('source_table');
        expect(pool.queried('google_ads_auction_insights_status')).toBe(false);
        expect(pool.queries.some(query => query.includes('MAX('))).toBe(false);
    });

    test('warehouse watermarks are cached for repeated selected slices', async () => {
        const pool = new RecordingPool();

        await getWarehouseWatermark(pool, filters);
        expect(pool.queries.some(query => query.includes('FROM google_ads_warehouse_slice_fingerprints'))).toBe(true);
        expect(pool.queries.some(query => query.includes('MAX('))).toBe(false);

        pool.queries = [];
        await getWarehouseWatermark(pool, filters);

        expect(pool.queries).toHaveLength(0);
    });

    test('tab views reuse warm base bundle rows instead of rereading summary and snapshots', async () => {
        const pool = new RecordingPool();

        await getDashboardOverviewReportBundle(pool, filters);
        expect(pool.queried('google_ads_campaign_daily')).toBe(true);
        expect(pool.queried('google_ads_campaign_snapshot')).toBe(true);

        pool.queries = [];
        await getDashboardReportBundleForView(pool, filters, 'proposals');

        expect(pool.queried('candidate_signals')).toBe(true);
        expect(pool.queried('google_ads_campaign_daily')).toBe(false);
        expect(pool.queried('google_ads_ad_group_daily')).toBe(false);
        expect(pool.queried('google_ads_campaign_snapshot')).toBe(false);
        expect(pool.queried('google_ads_ad_group_snapshot')).toBe(false);
    });

    test('rank view reuses warm overview segment summaries instead of rereading them', async () => {
        const pool = new RecordingPool();

        await getDashboardOverviewReportBundle(pool, filters);

        pool.queries = [];
        await getDashboardReportBundleForView(pool, filters, 'rank');

        expect(pool.queried('google_ads_device_daily')).toBe(false);
        expect(pool.queried('google_ads_day_of_week_daily')).toBe(false);
        expect(pool.queried('google_ads_day_hour_daily')).toBe(false);
        expect(pool.queried('google_ads_landing_page_daily')).toBe(true);
    });

    test('available filter options are cached for repeated view loads', async () => {
        const pool = new RecordingPool();

        await getAvailableDashboardFilters(pool, filters.customerId);
        expect(pool.queries).toHaveLength(3);
        expect(pool.queries.some(query => query.includes('FULL OUTER JOIN fact_campaigns'))).toBe(true);
        expect(pool.queries.some(query => query.includes('FULL OUTER JOIN fact_ad_groups'))).toBe(true);

        pool.queries = [];
        await getAvailableDashboardFilters(pool, filters.customerId);

        expect(pool.queries).toHaveLength(0);
    });
});
