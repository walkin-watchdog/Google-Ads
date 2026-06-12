import { describe, expect, test } from 'bun:test';
import {
    buildProposalContextFromPayloads,
    getCandidateSignalsPayload,
    getProposalContext
} from '../lib/mcpDashboardContext.ts';

class CandidateSignalPool {
    queries = [];

    async query(sql, params = []) {
        const compact = String(sql).replace(/\s+/g, ' ').trim();
        this.queries.push({ sql: compact, params });
        if (compact.includes('FROM google_ads_campaign_daily')) return { rows: [{ exists: 1 }] };
        if (compact.includes('FROM candidate_signals')) return { rows: [] };
        return { rows: [] };
    }
}

class DirectProposalPool {
    queries = [];

    async query(sql, params = []) {
        const compact = String(sql).replace(/\s+/g, ' ').trim();
        this.queries.push({ sql: compact, params });

        if (compact.includes('FROM google_ads_campaign_daily WHERE customer_id = $1 LIMIT 1')) {
            return { rows: [{ exists: 1 }] };
        }
        if (compact.includes('SELECT MIN(date)::text AS min_date, MAX(date)::text AS max_date')) {
            return { rows: [{ min_date: '2026-01-01', max_date: '2026-01-31' }] };
        }
        if (compact.includes('FROM google_ads_refresh_runs')) {
            return {
                rows: [{
                    id: 'run1',
                    status: 'failed',
                    source_summary: {
                        failedReports: ['auction_insights_domains'],
                        search_term_performance: { status: 'missing' }
                    }
                }]
            };
        }
        if (compact.includes('WITH snapshot_campaigns AS')) {
            return { rows: [{ campaign_id: 'C1', campaign_name: 'Core', campaign_status: 'ENABLED' }] };
        }
        if (compact.includes('WITH snapshot_ad_groups AS')) {
            return {
                rows: [{
                    campaign_id: 'C1',
                    campaign_name: 'Core',
                    ad_group_id: 'A1',
                    ad_group_name: 'Core Exact',
                    ad_group_status: null
                }]
            };
        }
        if (compact.includes('FROM google_ads_account_daily src')) {
            return {
                rows: [{
                    cost_micros: 100_000_000,
                    clicks: 10,
                    impressions: 100,
                    conversions: 1,
                    all_conversions: 1,
                    conversions_value: 0,
                    currency_code: 'INR'
                }]
            };
        }
        if (compact.includes('FROM google_ads_ad_group_daily src') && !compact.includes('FROM google_ads_ad_group_snapshot s')) {
            return {
                rows: [{
                    cost_micros: 100_000_000,
                    clicks: 10,
                    impressions: 100,
                    conversions: 1,
                    all_conversions: 1,
                    conversions_value: 0,
                    currency_code: 'USD'
                }]
            };
        }
        if (compact.includes('FROM google_ads_campaign_daily src') && compact.includes('FROM google_ads_campaign_snapshot s')) {
            return {
                rows: [{
                    campaign_id: 'C1',
                    campaign_name: 'Core',
                    campaign_status: 'ENABLED',
                    cost_micros: 100_000_000,
                    clicks: 10,
                    impressions: 100,
                    conversions: 1,
                    all_conversions: 1
                }]
            };
        }
        if (compact.includes('FROM google_ads_ad_group_snapshot s')) {
            return {
                rows: [{
                    enabled_count: 1,
                    campaign_id: 'C1',
                    campaign_name: 'Core',
                    ad_group_id: 'A1',
                    ad_group_name: 'Core Exact',
                    ad_group_status: null,
                    cost_micros: 100_000_000,
                    clicks: 10,
                    impressions: 100,
                    conversions: 1,
                    all_conversions: 1
                }]
            };
        }
        if (compact.includes('FROM google_ads_configured_keywords')) {
            return {
                rows: [{
                    campaign_id: 'C1',
                    campaign_name: 'Core',
                    ad_group_id: 'A1',
                    ad_group_name: 'Core Exact',
                    criterion_id: 'K1',
                    keyword_text: 'whatsapp crm',
                    match_type: 'EXACT',
                    status: 'ENABLED',
                    primary_status: 'ELIGIBLE',
                    raw_payload: {}
                }]
            };
        }
        if (compact.includes('FROM google_ads_quality_score_snapshot')) {
            return {
                rows: [{
                    campaign_id: 'C1',
                    campaign_name: 'Core',
                    ad_group_id: 'A1',
                    ad_group_name: 'Core Exact',
                    criterion_id: 'K1',
                    keyword_text: 'whatsapp crm',
                    match_type: 'EXACT',
                    status: 'ENABLED',
                    quality_score: 8
                }]
            };
        }
        if (compact.includes('FROM google_ads_campaign_negatives')) {
            return {
                rows: [{
                    campaign_id: 'C1',
                    campaign_name: 'Core',
                    keyword_text: 'free',
                    match_type: 'BROAD',
                    status: 'ENABLED',
                    raw_payload: {}
                }]
            };
        }
        if (compact.includes('FROM google_ads_ad_group_negatives')
            || compact.includes('FROM google_ads_account_negative_lists')
            || compact.includes('FROM google_ads_shared_negative_sets')
            || compact.includes('FROM google_ads_shared_negative_criteria')
            || compact.includes('FROM google_ads_campaign_shared_sets')) {
            return { rows: [] };
        }
        if (compact.includes('FROM google_ads_keyword_planner_ideas')) {
            return {
                rows: [{
                    keyword: 'whatsapp crm',
                    avg_monthly_searches: 1000,
                    competition: 'LOW',
                    competition_index: 20,
                    low_bid_micros: 1_000_000,
                    high_bid_micros: 2_000_000,
                    seed_type: 'keyword',
                    seed_keywords: [],
                    monthly_search_volumes: [],
                    raw_payload: {}
                }]
            };
        }
        if (compact.includes('FROM google_ads_keyword_planner_historical')) {
            return {
                rows: [{
                    keyword: 'bulk whatsapp sender',
                    close_variants: ['bulk whatsapp sender'],
                    avg_monthly_searches: 500,
                    competition: 'MEDIUM',
                    low_bid_micros: 1_500_000,
                    high_bid_micros: 3_000_000,
                    monthly_search_volumes: [],
                    raw_payload: {}
                }]
            };
        }
        if (compact.includes('FROM google_ads_search_term_daily src')) {
            return {
                rows: [
                    {
                        campaign_id: 'C1',
                        campaign_name: 'Core',
                        ad_group_id: 'A1',
                        ad_group_name: 'Core Exact',
                        search_term: 'whatsapp crm',
                        cost_micros: 80_000_000,
                        clicks: 8,
                        impressions: 80,
                        conversions: 1,
                        all_conversions: 1,
                        total_visible: 2,
                        total_cost_micros: 100_000_000
                    },
                    {
                        campaign_id: 'C1',
                        campaign_name: 'Core',
                        ad_group_id: 'A1',
                        ad_group_name: 'Core Exact',
                        search_term: 'free whatsapp crm',
                        cost_micros: 20_000_000,
                        clicks: 2,
                        impressions: 20,
                        conversions: 0,
                        all_conversions: 0,
                        total_visible: 2,
                        total_cost_micros: 100_000_000
                    }
                ]
            };
        }
        if (compact.includes('FROM google_ads_landing_page_daily src')) return { rows: [] };
        if (compact.includes('FROM google_ads_auction_insights_status')) return { rows: [] };
        if (compact.includes('FROM google_ads_auction_insights_rows')) return { rows: [{ rows: 7 }] };
        if (compact.includes('FROM google_ads_device_daily src')) {
            return { rows: [{ device: 'MOBILE', cost_micros: 100_000_000, clicks: 10, impressions: 100, conversions: 1, conversions_value: 0 }] };
        }
        if (compact.includes('FROM google_ads_day_of_week_daily src')) {
            return { rows: [{ day_of_week: 'MONDAY', cost_micros: 100_000_000, clicks: 10, impressions: 100, conversions: 1, conversions_value: 0 }] };
        }
        if (compact.includes('FROM google_ads_day_hour_daily src')) {
            return { rows: [{ day_of_week: 'MONDAY', hour: 10, cost_micros: 100_000_000, clicks: 10, impressions: 100, conversions: 1 }] };
        }
        if (compact.includes('FROM candidate_signals')) return { rows: [] };
        if (compact.includes('FROM lead_sessions')) return { rows: [] };
        return { rows: [] };
    }
}

describe('MCP dashboard context helpers', () => {
    test('candidate signal payloads default to a bounded warehouse query', async () => {
        const pool = new CandidateSignalPool();

        await getCandidateSignalsPayload(pool, {
            customerId: '1234567890',
            startDate: '2026-01-01',
            endDate: '2026-01-31'
        });

        const signalQuery = pool.queries.find(query => query.sql.includes('FROM candidate_signals'));
        expect(signalQuery?.sql).toContain('LIMIT $4');
        expect(signalQuery?.params).toEqual(['1234567890', '2026-01-01', '2026-01-31', 250]);
    });

    test('proposal context stays inside selected campaign and campaign-scoped lead terms', () => {
        const filters = {
            customerId: '1234567890',
            startDate: '2026-01-01',
            endDate: '2026-01-31',
            campaignId: '111',
            adGroupId: null
        };
        const overview = {
            meta: { accountId: '1234567890', dateRange: { start: '2026-01-01', end: '2026-01-31' } },
            summary: { spend: 100 },
            sourceCoverage: {
                sources: [],
                missingSources: ['lead-attribution'],
                staleSources: ['auction-insights-status'],
                failedSources: ['search-term-performance'],
                refreshRun: { status: 'failed' }
            },
            decisionContext: {},
            filterOptions: {
                adGroups: [
                    { id: 'A1', name: 'Core Exact', status: 'ENABLED', campaignId: '111', campaignName: 'Core' },
                    { id: 'B1', name: 'Other Exact', status: 'ENABLED', campaignId: '222', campaignName: 'Other' }
                ]
            },
            adGroups: [
                { id: 'A1', adGroupId: 'A1', name: 'Core Exact', adGroup: 'Core Exact', status: 'ENABLED', campaignId: '111', campaign: 'Core', spend: 100 }
            ],
            leadAttribution: {
                byCampaign: [
                    { campaignId: '111', campaignName: 'Core', uniqueLeads: 2 },
                    { campaignId: '222', campaignName: 'Other', uniqueLeads: 5 }
                ],
                bySearchTerm: [
                    { campaignId: '222', campaignName: 'Other', searchTerm: 'shared term', uniqueLeads: 5, useless: 5 },
                    { campaignId: '111', campaignName: 'Core', searchTerm: 'shared term', uniqueLeads: 2, qualified: 2 }
                ]
            }
        };
        const keywords = {
            sourceCoverage: { sources: [] },
            decisionContext: {},
            searchTerms: [
                { campaignId: '111', campaign: 'Renamed Core', adGroupId: 'A1', adGroup: 'Core Exact', searchTerm: 'shared term', spend: 10, clicks: 2 },
                { campaignId: '222', campaign: 'Other', adGroupId: 'B1', adGroup: 'Other Exact', searchTerm: 'shared term', spend: 90, clicks: 9 }
            ],
            configuredKeywords: [],
            negatives: [],
            keywordPlanner: { status: { status: 'empty' } }
        };
        const rank = {
            sourceCoverage: { sources: [] },
            decisionContext: {},
            qualityScores: [],
            landingPages: [],
            expandedLandingPages: [],
            auctionInsightsStatus: []
        };

        const context = buildProposalContextFromPayloads(filters, {}, overview, keywords, rank, [
            { signal_id: 'matching_campaign', campaign_id: '111', severity: 'high' },
            { signal_id: 'wrong_campaign', campaign_id: '222', severity: 'critical' }
        ]);

        expect(context.meta.enabledAdGroups).toBe(1);
        expect(context.adGroups).toHaveLength(1);
        expect(context.adGroups[0].adGroup).toMatchObject({ campaignId: '111', adGroupId: 'A1' });
        expect(context.adGroups[0].searchTerms.totalVisible).toBe(1);
        expect(context.adGroups[0].leadQuality.byCampaign).toHaveLength(1);
        expect(context.adGroups[0].leadQuality.bySearchTerm).toHaveLength(1);
        expect(context.adGroups[0].leadQuality.bySearchTerm[0].campaignId).toBe('111');
        expect(context.adGroups[0].signalIds).toEqual(['matching_campaign']);
        expect(context.sourceCoverage.missingSources).toContain('lead-attribution');
        expect(context.sourceCoverage.staleSources).toContain('auction-insights-status');
        expect(context.sourceCoverage.failedSources).toContain('search-term-performance');
        expect(context.sourceCoverage.refreshRun.status).toBe('failed');
    });

    test('direct proposal context keeps planner, search-term, segment, and auction evidence', async () => {
        const pool = new DirectProposalPool();

        const context = await getProposalContext(pool, {
            customerId: '1234567890',
            startDate: '2026-01-01',
            endDate: '2026-01-31'
        });

        const searchTermQuery = pool.queries.find(query => query.sql.includes('FROM google_ads_search_term_daily src'));
        expect(searchTermQuery?.sql).toContain('WHERE rn <= $5');
        expect(searchTermQuery?.sql).toContain('LIMIT $6');
        expect(searchTermQuery?.params.slice(-2)).toEqual([8, 2000]);
        const adGroupQuery = pool.queries.find(query => query.sql.includes('FROM google_ads_ad_group_snapshot s'));
        expect(adGroupQuery?.sql).toContain('FULL OUTER JOIN perf');
        expect(adGroupQuery?.sql).toContain("UPPER(COALESCE(s.ad_group_status, p.ad_group_status, 'ENABLED')) = 'ENABLED'");
        const auctionStatusQuery = pool.queries.find(query => query.sql.includes('FROM google_ads_auction_insights_status'));
        expect(auctionStatusQuery?.sql).not.toMatch(/\bcampaign_id\b/);
        expect(auctionStatusQuery?.sql).not.toMatch(/\bad_group_id\b/);
        const sourceNames = context.sourceCoverage.sources.map(source => source.name);
        expect(sourceNames).toContain('account-negatives');
        expect(sourceNames).toContain('shared-negative-criteria');
        expect(sourceNames).toContain('campaign-shared-sets');
        expect(sourceNames).toContain('auction-insights-domains');
        expect(context.sourceCoverage.failedSources).toContain('auction-insights-domains');
        expect(context.sourceCoverage.refreshRun.status).toBe('failed');
        expect(context.meta.searchTermContextLimit).toBe(2000);
        expect(context.meta.historicalCpaBenchmarks.generic).toBe(100);
        expect(context.keywordPlanner.status.status).toBe('ok');
        expect(context.decisionContext.sourceCoverage.refreshRunStatus).toBe('failed');
        expect(context.decisionContext.keywordPlanner.ideas).toBe(1);
        expect(context.decisionContext.keywordPlanner.historicalMetrics).toBe(1);
        expect(context.decisionContext.decisionInputs.keywordPlannerStatus).toBe('ok');
        expect(context.decisionContext.decisionInputs.auctionInsightsRows).toBe(7);
        expect(context.decisionContext.decisionInputs.deviceRows).toBe(1);
        expect(context.decisionContext.decisionInputs.dayOfWeekRows).toBe(1);
        expect(context.decisionContext.decisionInputs.dayAndHourRows).toBe(1);
        expect(context.decisionContext.searchTerms.total).toBe(2);
        expect(context.adGroups[0].searchTerms.top[0].avgMonthlySearches).toBe(1000);
        expect(context.adGroups[0].searchTerms.negativeCoveredSpend).toBe(20);
    });

    test('direct proposal context keeps ad-group filters SQL-valid and parameter aligned', async () => {
        const pool = new DirectProposalPool();

        const context = await getProposalContext(pool, {
            customerId: 'proposal_context_filtered',
            startDate: '2026-01-01',
            endDate: '2026-01-31',
            campaignId: 'C1',
            adGroupId: 'A1'
        });

        const summaryQuery = pool.queries.find(query =>
            query.sql.includes('FROM google_ads_ad_group_daily src')
            && !query.sql.includes('FROM google_ads_ad_group_snapshot s')
        );
        expect(summaryQuery?.sql).toContain('0::numeric AS conversions_value');
        expect(summaryQuery?.sql).not.toContain('src.conversions_value');
        expect(summaryQuery?.sql).toContain('FROM google_ads_account_daily acct');
        expect(context.summary.currency).toBe('USD');

        const campaignQuery = pool.queries.find(query =>
            query.sql.includes('FROM google_ads_campaign_daily src')
            && query.sql.includes('FROM google_ads_campaign_snapshot s')
        );
        expect(campaignQuery?.params).toEqual(['proposal_context_filtered', '2026-01-01', '2026-01-31', 'C1']);
        expect(campaignQuery?.sql).not.toContain('$5');
        expect(campaignQuery?.sql).toContain('FULL OUTER JOIN perf');

        const auctionStatusQuery = pool.queries.find(query => query.sql.includes('FROM google_ads_auction_insights_status'));
        expect(auctionStatusQuery?.sql).not.toMatch(/\bcampaign_id\b/);
        expect(auctionStatusQuery?.sql).not.toMatch(/\bad_group_id\b/);
        expect(auctionStatusQuery?.params).toEqual(['proposal_context_filtered', 'C1', 'A1']);
        expect(context.meta.returnedAdGroups).toBe(1);
    });
});
