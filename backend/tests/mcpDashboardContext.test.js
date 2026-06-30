import { describe, expect, test } from 'bun:test';
import {
    buildProposalContextFromPayloads,
    getCandidateSignalsPayload
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
});
