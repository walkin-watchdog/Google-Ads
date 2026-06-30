import { describe, expect, test } from 'bun:test';
import {
    clearAdsWarehouseRuntimeCaches
} from '../lib/adsWarehouse.ts';
import {
    attachLiveDashboardData,
    attachLeadPeriodComparisonMetrics,
    buildDashboardPayloadForView,
    buildDashboardPayloadFromBundle,
    clearDashboardViewPayloadCache,
    dashboardKnownSections,
    dashboardSectionRoute,
    projectDashboardPayload,
    resolveDashboardFilters
} from '../lib/dashboardPayload.ts';

function emptyBundle(overrides = {}) {
    return {
        accountDaily: [],
        campaignDaily: [],
        adGroupDaily: [],
        keywordDaily: [],
        searchTermDaily: [],
        deviceDaily: [],
        dayOfWeekDaily: [],
        dayHourDaily: [],
        landingPageDaily: [],
        expandedLandingPageDaily: [],
        conversionActionDaily: [],
        conversionAdGroupDaily: [],
        conversionSearchTermDaily: [],
        clickEvidenceDaily: [],
        campaignSnapshot: [],
        adGroupSnapshot: [],
        configuredKeywords: [],
        qualityScores: [],
        negatives: {
            campaignNegatives: [],
            adGroupNegatives: [],
            accountNegativeLists: [],
            sharedNegativeSets: [],
            sharedNegativeCriteria: [],
            campaignSharedSets: []
        },
        keywordPlannerIdeas: [],
        keywordPlannerHistorical: [],
        auctionInsightsRows: [],
        auctionInsightsStatus: [],
        candidateSignals: [],
        coverage: [],
        ...overrides
    };
}

class RecordingPool {
    constructor() {
        this.queries = [];
    }

    async query(sql) {
        const compact = String(sql).replace(/\s+/g, ' ').trim();
        this.queries.push(compact);
        if (compact.includes('SELECT 1') && compact.includes('FROM google_ads_campaign_daily')) {
            return { rows: [{ exists: 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    }
}

describe('dashboard payload warehouse slices', () => {
    test('resolveDashboardFilters uses a cheap warehouse existence check for all-account views', async () => {
        const pool = new RecordingPool();

        const filters = await resolveDashboardFilters(pool, {
            customerId: '1234567890',
            startDate: '2026-01-01',
            endDate: '2026-01-31'
        });

        expect(filters).toEqual({
            customerId: '1234567890',
            startDate: '2026-01-01',
            endDate: '2026-01-31',
            campaignId: null,
            adGroupId: null
        });
        expect(pool.queries.some(query => query.includes('FROM google_ads_campaign_daily') && query.includes('LIMIT 1'))).toBe(true);
        expect(pool.queries.some(query => query.includes('FROM google_ads_campaign_snapshot'))).toBe(false);
        expect(pool.queries.some(query => query.includes('FROM google_ads_ad_group_snapshot'))).toBe(false);
    });

    test('resolveDashboardFilters infers campaign when only adGroupId is provided', async () => {
        const pool = {
            async query(sql) {
                if (sql.includes('MIN(date)')) {
                    return { rows: [{ min_date: '2026-01-01', max_date: '2026-01-31' }] };
                }
                if (sql.includes('FROM google_ads_campaign_snapshot')) {
                    return { rows: [{ campaign_id: '111', campaign_name: 'Campaign 111', campaign_status: 'ENABLED' }] };
                }
                if (sql.includes('FROM google_ads_ad_group_snapshot')) {
                    return { rows: [{ campaign_id: '111', campaign_name: 'Campaign 111', ad_group_id: '222', ad_group_name: 'Ad group 222', ad_group_status: 'ENABLED' }] };
                }
                throw new Error(`Unexpected SQL: ${sql}`);
            }
        };

        const filters = await resolveDashboardFilters(pool, {
            customerId: '1234567890',
            startDate: '2026-01-01',
            endDate: '2026-01-31',
            adGroupId: '222'
        });

        expect(filters).toEqual({
            customerId: '1234567890',
            startDate: '2026-01-01',
            endDate: '2026-01-31',
            campaignId: '111',
            adGroupId: '222'
        });
    });

    test('summary uses selected campaign or ad-group facts while globalSummary stays account-level', async () => {
        const baseFilters = {
            customerId: '1234567890',
            startDate: '2026-01-01',
            endDate: '2026-01-01'
        };
        const bundle = emptyBundle({
            accountDaily: [{
                customer_id: baseFilters.customerId,
                date: '2026-01-01',
                currency_code: 'INR',
                cost_micros: 100_000_000,
                clicks: 100,
                impressions: 1000,
                conversions: 10,
                conversions_value: 1000
            }],
            campaignDaily: [{
                customer_id: baseFilters.customerId,
                date: '2026-01-01',
                campaign_id: '111',
                campaign_name: 'Campaign 111',
                cost_micros: 40_000_000,
                clicks: 40,
                impressions: 400,
                conversions: 4,
                conversions_value: 400,
                search_impression_share: 0.8
            }],
            adGroupDaily: [{
                customer_id: baseFilters.customerId,
                date: '2026-01-01',
                campaign_id: '111',
                campaign_name: 'Campaign 111',
                ad_group_id: '222',
                ad_group_name: 'Ad group 222',
                cost_micros: 5_000_000,
                clicks: 5,
                impressions: 50,
                conversions: 1,
                conversions_value: 100,
                search_impression_share: 0.5
            }]
        });

        const campaignPayload = await buildDashboardPayloadFromBundle(
            bundle,
            { ...baseFilters, campaignId: '111' },
            { campaigns: [], adGroups: [] }
        );
        expect(campaignPayload.summary.spend).toBe(40);
        expect(campaignPayload.summary.clicks).toBe(40);
        expect(campaignPayload.globalSummary.spend).toBe(100);

        const adGroupPayload = await buildDashboardPayloadFromBundle(
            bundle,
            { ...baseFilters, campaignId: '111', adGroupId: '222' },
            { campaigns: [], adGroups: [] }
        );
        expect(adGroupPayload.summary.spend).toBe(5);
        expect(adGroupPayload.summary.clicks).toBe(5);
        expect(adGroupPayload.globalSummary.spend).toBe(100);
        expect(adGroupPayload.dailyRankShare[0].spend).toBe(5);
        expect(adGroupPayload.dailyRankShare[0].impressionShare).toBe(50);
    });

    test('dashboard payload does not expose raw warehouse audit payloads', async () => {
        const payload = await buildDashboardPayloadFromBundle(
            emptyBundle({
                keywordPlannerIdeas: [{
                    customer_id: '1234567890',
                    keyword_key: 'whatsapp-crm',
                    keyword: 'whatsapp crm',
                    avg_monthly_searches: 1000,
                    competition: 'HIGH',
                    competition_index: 90,
                    low_bid_micros: 1000000,
                    high_bid_micros: 4000000,
                    seed_type: 'keyword',
                    seed_keywords: ['crm'],
                    seed_url: null,
                    seed_site: null,
                    geo_target_constants: ['geoTargetConstants/2356'],
                    language: 'languageConstants/1000',
                    keyword_plan_network: 'GOOGLE_SEARCH',
                    monthly_search_volumes: [{ year: 2026, month: 'JANUARY', monthlySearches: 1000 }],
                    raw_payload: { source: 'idea', should_not_ship: true, arbitrary_raw_field: 'audit-only' }
                }],
                auctionInsightsRows: [{
                    customer_id: '1234567890',
                    dimension_hash: 'auction-row-1',
                    source_scope: 'campaign',
                    entity_id: '111',
                    entity_name: 'Campaign 111',
                    campaign_id: '111',
                    campaign_name: 'Campaign 111',
                    auction_date: '2026-01-01',
                    domain: 'competitor.example',
                    impression_share: 0.42,
                    overlap_rate: 0.3,
                    position_above_rate: 0.1,
                    top_impression_percentage: 0.7,
                    absolute_top_impression_percentage: 0.2,
                    outranking_share: 0.05,
                    raw_payload: { large: 'audit-only', nested: { should_not_ship: true } }
                }]
            }),
            {
                customerId: '1234567890',
                startDate: '2026-01-01',
                endDate: '2026-01-31'
            },
            { campaigns: [], adGroups: [] }
        );

        expect(payload.auctionInsights[0].domain).toBe('competitor.example');
        expect(payload.auctionInsights[0]).not.toHaveProperty('rawValues');
        expect(payload.keywordPlanner.ideas[0].keyword).toBe('whatsapp crm');
        expect(payload.keywordPlanner.ideas[0].source).toBe('idea');
        expect(payload.keywordPlanner.ideas[0]).not.toHaveProperty('monthlySearchVolumes');
        expect(payload.keywordPlanner.ideas[0]).not.toHaveProperty('seedKeywords');
        expect(payload.keywordPlanner.ideas[0]).not.toHaveProperty('geoTargetConstants');
        expect(payload.keywordPlanner.ideas[0]).not.toHaveProperty('arbitrary_raw_field');
        expect(JSON.stringify(payload)).not.toContain('should_not_ship');
    });

    test('rank view payload build skips keyword discovery planner and configured-keyword work', async () => {
        const payload = await buildDashboardPayloadFromBundle(
            emptyBundle({
                keywordDaily: [
                    {
                        customer_id: '1234567890',
                        date: '2026-01-01',
                        campaign_id: '111',
                        campaign_name: 'Competitor Campaign',
                        ad_group_id: '222',
                        ad_group_name: 'Competitor Ad Group',
                        criterion_id: '333',
                        keyword_text: 'wati crm',
                        match_type: 'EXACT',
                        criterion_status: 'ENABLED',
                        cost_micros: 10_000_000,
                        clicks: 10,
                        impressions: 100,
                        conversions: 1
                    },
                    {
                        customer_id: '1234567890',
                        date: '2026-01-01',
                        campaign_id: '111',
                        campaign_name: 'Generic Campaign',
                        ad_group_id: '223',
                        ad_group_name: 'Generic Ad Group',
                        criterion_id: '334',
                        keyword_text: 'whatsapp crm',
                        match_type: 'EXACT',
                        criterion_status: 'ENABLED',
                        cost_micros: 20_000_000,
                        clicks: 20,
                        impressions: 200,
                        conversions: 2
                    }
                ],
                configuredKeywords: [{
                    customer_id: '1234567890',
                    campaign_id: '111',
                    ad_group_id: '222',
                    criterion_id: '333',
                    keyword_text: 'wati crm',
                    match_type: 'EXACT',
                    status: 'ENABLED'
                }],
                keywordPlannerIdeas: [{
                    customer_id: '1234567890',
                    keyword_key: 'wati-crm',
                    keyword: 'wati crm',
                    avg_monthly_searches: 1000,
                    competition: 'HIGH',
                    low_bid_micros: 1000000,
                    high_bid_micros: 2000000
                }]
            }),
            {
                customerId: '1234567890',
                startDate: '2026-01-01',
                endDate: '2026-01-31'
            },
            { campaigns: [], adGroups: [] },
            { view: 'rank' }
        );

        expect(payload.keywords).toHaveLength(1);
        expect(payload.keywords[0].keyword).toBe('wati crm');
        expect(payload.keywords[0]).not.toHaveProperty('plannerScore');
        expect(payload.configuredKeywords).toHaveLength(0);
        expect(payload.keywordPlanner.ideas).toHaveLength(0);
    });

    test('lead-aware period comparison is attached server-side after live lead attribution', () => {
        const payload = {
            periodComparison: {
                previousPeriod: { label: '2026-01-01 - 2026-01-15', spend: 15, conversions: 1, cpa: 15 },
                currentPeriod: { label: '2026-01-16 - 2026-01-30', spend: 30, conversions: 2, cpa: 15 },
                deltas: { spend: 100, clicks: 0, impressions: 0, conversions: 100 }
            },
            leadAttribution: {
                allLeads: [
                    { status: 'qualified', firstSeen: '2026-01-02T10:00:00.000Z', eventCount: 2 },
                    { status: 'converted', firstSeen: '2026-01-12T10:00:00.000Z', eventCount: 1 },
                    { status: 'qualified', firstSeen: '2026-01-20T10:00:00.000Z', eventCount: 3 },
                    { status: 'useless', firstSeen: '2026-01-21T10:00:00.000Z', eventCount: 1 },
                    { status: 'converted', firstSeen: '2026-01-29T10:00:00.000Z', eventCount: 4 }
                ]
            }
        };

        attachLeadPeriodComparisonMetrics(payload);

        expect(payload.periodComparison.previousPeriod.realConversions).toBe(2);
        expect(payload.periodComparison.previousPeriod.realQualified).toBe(1);
        expect(payload.periodComparison.previousPeriod.realConverted).toBe(1);
        expect(payload.periodComparison.currentPeriod.realConversions).toBe(3);
        expect(payload.periodComparison.currentPeriod.realQualified).toBe(1);
        expect(payload.periodComparison.currentPeriod.realConverted).toBe(1);
        expect(payload.periodComparison.currentPeriod.realUseless).toBe(1);
        expect(payload.periodComparison.deltas.realConversions).toBe(50);
    });

    test('overview projection excludes hidden-tab dashboard payloads', () => {
        const fullPayload = {
            meta: { accountId: '1234567890' },
            filterOptions: { campaigns: [] },
            summary: { spend: 100 },
            dailyTrend: [{ date: '2026-01-01', spend: 100 }],
            campaigns: [{ id: '111', spend: 100 }],
            adGroups: [{ id: '222', spend: 50 }],
            devicePerformance: [{ device: 'MOBILE', spend: 40 }],
            dayOfWeekPerformance: [{ day: 'MONDAY', clicks: 10 }],
            dayAndHourPerformance: [{ day: 'MONDAY', hour: 9, clicks: 5 }],
            leadAttribution: { totals: { uniqueLeads: 2 } },
            keywordPlanner: { ideas: [{ keyword: 'hidden planner row' }] },
            searchTerms: [{ searchTerm: 'hidden search term' }],
            keywords: [{ keyword: 'hidden keyword' }],
            auctionInsights: [{ domain: 'hidden.example' }],
            qualityScores: [{ keyword: 'hidden qs' }],
            proposals: [{ proposal_id: 'hidden-proposal' }],
            candidateSignals: [{ signal_id: 'hidden-signal' }]
        };

        const overview = projectDashboardPayload(fullPayload, 'overview');

        expect(overview.meta.payloadView).toBe('overview');
        expect(overview.summary.spend).toBe(100);
        expect(overview.campaigns).toHaveLength(1);
        expect(overview.devicePerformance).toHaveLength(1);
        expect(overview.dayOfWeekPerformance).toHaveLength(1);
        expect(overview.dayAndHourPerformance).toHaveLength(1);
        expect(overview.leadAttribution.totals.uniqueLeads).toBe(2);
        expect(overview).not.toHaveProperty('keywordPlanner');
        expect(overview).not.toHaveProperty('searchTerms');
        expect(overview).not.toHaveProperty('keywords');
        expect(overview).not.toHaveProperty('auctionInsights');
        expect(overview).not.toHaveProperty('qualityScores');
        expect(overview).not.toHaveProperty('proposals');
        expect(overview).not.toHaveProperty('candidateSignals');
    });

    test('keywords projection includes quality score data for the visible distribution card', () => {
        const fullPayload = {
            meta: { accountId: '1234567890' },
            filterOptions: { campaigns: [] },
            sourceCoverage: [],
            decisionContext: {},
            summary: { spend: 100 },
            keywords: [{ keyword: 'crm', qualityScore: 8 }],
            configuredKeywords: [],
            qualityScores: [{ keyword: 'crm', qualityScore: 8 }],
            negatives: [],
            searchTerms: [],
            keywordPlanner: { ideas: [] },
            competitorRoots: [],
            candidateSignals: [],
            decisionInputEnrichment: {},
            leadAttribution: {},
            landingPages: [{ url: 'https://example.com' }],
            auctionInsights: [{ domain: 'hidden.example' }],
            devicePerformance: [{ device: 'MOBILE' }]
        };

        const keywords = projectDashboardPayload(fullPayload, 'keywords');

        expect(keywords.meta.payloadView).toBe('keywords');
        expect(keywords.qualityScores).toHaveLength(1);
        expect(keywords.qualityScores[0].qualityScore).toBe(8);
        expect(keywords).not.toHaveProperty('landingPages');
        expect(keywords).not.toHaveProperty('auctionInsights');
        expect(keywords).not.toHaveProperty('devicePerformance');
    });

    test('dashboard section routes keep MCP section requests on bounded views or direct paths', () => {
        expect(dashboardSectionRoute('adGroups')).toEqual({ section: 'adGroups', mode: 'overview' });
        expect(dashboardSectionRoute('search_terms')).toEqual({ section: 'searchTerms', mode: 'keywords' });
        expect(dashboardSectionRoute('leadAttribution')).toEqual({ section: 'leadAttribution', mode: 'attribution' });
        expect(dashboardSectionRoute('auction-insights-status')).toEqual({ section: 'auctionInsightsStatus', mode: 'rank' });
        expect(dashboardSectionRoute('candidateSignals')).toEqual({ section: 'candidateSignals', mode: 'candidate_signals' });
        expect(dashboardSectionRoute('decisionContext')).toEqual({ section: 'decisionContext', mode: 'decision_context' });
        expect(dashboardSectionRoute('proposalContext')).toEqual({ section: 'proposalContext', mode: 'proposal_context' });
        expect(dashboardSectionRoute('full')).toEqual({ section: null, mode: 'full' });
        expect(dashboardKnownSections()).toContain('searchTerms');
        expect(dashboardKnownSections()).toContain('proposalContext');
        expect(dashboardKnownSections()).toContain('full');
    });

    test('partial view payload cache skips repeat warehouse and live SQL for the same selected slice', async () => {
        clearDashboardViewPayloadCache();
        clearAdsWarehouseRuntimeCaches();
        const pool = new RecordingPool();
        const filters = {
            customerId: '1234567890',
            startDate: '2026-01-01',
            endDate: '2026-01-31',
            campaignId: null,
            adGroupId: null
        };

        const first = await buildDashboardPayloadForView(pool, filters, 'overview', { filtersResolved: true });
        expect(first.meta.payloadView).toBe('overview');
        expect(first.meta.cacheStatus).toBe('memory_miss');
        expect(pool.queries.length).toBeGreaterThan(0);

        pool.queries = [];
        const second = await buildDashboardPayloadForView(pool, filters, 'overview', { filtersResolved: true });

        expect(second.meta.payloadView).toBe('overview');
        expect(second.meta.cacheStatus).toBe('memory_hit');
        expect(pool.queries).toHaveLength(0);
        expect(pool.queries.some(query => query.includes('GROUP BY'))).toBe(false);
        expect(pool.queries.some(query => query.includes('SELECT payload FROM proposals'))).toBe(false);
        clearDashboardViewPayloadCache();
        clearAdsWarehouseRuntimeCaches();
    });

    test('partial view builder accepts a precomputed watermark and skips watermark SQL', async () => {
        clearDashboardViewPayloadCache();
        clearAdsWarehouseRuntimeCaches();
        const pool = new RecordingPool();

        await buildDashboardPayloadForView(pool, {
            customerId: '1234567890',
            startDate: '2026-01-01',
            endDate: '2026-01-31',
            campaignId: null,
            adGroupId: null
        }, 'overview', { filtersResolved: true, warehouseWatermark: 'precomputed-watermark' });

        expect(pool.queries.some(query => query.includes('AS max_ts'))).toBe(false);
        expect(pool.queries.some(query => query.includes('FROM google_ads_campaign_daily'))).toBe(true);
        clearDashboardViewPayloadCache();
        clearAdsWarehouseRuntimeCaches();
    });

    test('partial view inflight cache keeps distinct precomputed watermarks separate', async () => {
        clearDashboardViewPayloadCache();
        clearAdsWarehouseRuntimeCaches();
        const pool = new RecordingPool();
        const originalQuery = pool.query.bind(pool);
        pool.query = async (sql) => {
            await new Promise(resolve => setTimeout(resolve, 5));
            return originalQuery(sql);
        };
        const filters = {
            customerId: '1234567890',
            startDate: '2026-01-01',
            endDate: '2026-01-31',
            campaignId: null,
            adGroupId: null
        };

        await Promise.all([
            buildDashboardPayloadForView(pool, filters, 'overview', { filtersResolved: true, warehouseWatermark: 'watermark-one' }),
            buildDashboardPayloadForView(pool, filters, 'overview', { filtersResolved: true, warehouseWatermark: 'watermark-two' })
        ]);

        const campaignBundleReads = pool.queries
            .filter(query => query.startsWith('SELECT * FROM google_ads_campaign_daily'))
            .length;
        expect(campaignBundleReads).toBe(2);
        clearDashboardViewPayloadCache();
        clearAdsWarehouseRuntimeCaches();
    });

    test('live proposal attachment excludes proposals scoped to other selected campaigns or ad groups', async () => {
        const queries = [];
        const pool = {
            async query(sql, params = []) {
                const compact = String(sql).replace(/\s+/g, ' ').trim();
                queries.push({ sql: compact, params });
                if (compact.includes('FROM proposals')) {
                    return {
                        rows: [
                            { payload: { proposal_id: 'account_level', options: [] } },
                            { payload: { proposal_id: 'matching_campaign', campaign_id: '111', options: [] } },
                            { payload: { proposal_id: 'wrong_campaign', campaign_id: '222', options: [] } },
                            {
                                payload: {
                                    proposal_id: 'wrong_ad_group',
                                    campaign_id: '111',
                                    options: [{ verification_spec: { entity: { campaign_id: '111', ad_group_id: 'A2' } } }]
                                }
                            },
                            {
                                payload: {
                                    proposal_id: 'matching_ad_group',
                                    campaign_id: '111',
                                    options: [{ verification_spec: { entity: { campaign_id: '111', ad_group_id: 'A1' } } }]
                                }
                            }
                        ]
                    };
                }
                return { rows: [] };
            }
        };

        const result = await attachLiveDashboardData(
            pool,
            {
                meta: { accountId: '1234567890', dateRange: { start: '2026-01-01', end: '2026-01-31' } },
                sourceCoverage: {},
                decisionContext: {},
                periodComparison: {}
            },
            {
                customerId: '1234567890',
                startDate: '2026-01-01',
                endDate: '2026-01-31',
                campaignId: '111',
                adGroupId: 'A1'
            },
            { leadMode: 'none', includeProposals: true, includeDiagnoses: false }
        );

        expect(queries.find(query => query.sql.includes('FROM proposals'))?.params).toEqual([]);
        expect(result.proposals.map(proposal => proposal.proposal_id)).toEqual([
            'account_level',
            'matching_campaign',
            'matching_ad_group'
        ]);
    });
});
