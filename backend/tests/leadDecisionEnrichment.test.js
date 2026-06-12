import { describe, expect, test } from 'bun:test';
import { enrichDashboardDecisionRows } from '../lib/leadDecisionEnrichment.ts';

describe('enrichDashboardDecisionRows', () => {
    const leadAttribution = {
        generatedAt: '2026-06-30T00:00:00.000Z',
        totals: { uniqueLeads: 3 },
        bySearchTerm: [],
        allLeads: [
            { status: 'useless', eventCount: 1, attribution: { utm_campaign: '100', utm_term: 'free whatsapp crm', keyword: 'free whatsapp crm' } },
            { status: 'useless', eventCount: 1, attribution: { utm_campaign: '100', utm_term: 'free whatsapp crm', keyword: 'free whatsapp crm' } },
            { status: 'qualified', eventCount: 1, attribution: { utm_campaign: '200', utm_term: 'wati alternative', keyword: 'wati alternative' } }
        ]
    };

    test('adds scoped lead quality and source freshness to search terms', () => {
        const payload = enrichDashboardDecisionRows({
            sourceCoverage: {
                sources: [
                    { name: 'search_term_performance', status: 'ok', rows: 2, ageHours: 1 },
                    { name: 'configured_keywords', status: 'stale', rows: 10, ageHours: 72 }
                ]
            },
            searchTerms: [
                { campaignId: '100', searchTerm: 'free whatsapp crm', spend: 100 },
                { campaignId: '999', searchTerm: 'free whatsapp crm', spend: 100 }
            ]
        }, leadAttribution);

        expect(payload.searchTerms[0].leadQuality.tone).toBe('negative');
        expect(payload.searchTerms[0].leadQuality.useless).toBe(2);
        expect(payload.searchTerms[0].sourceFreshness.searchTerms.status).toBe('ok');
        expect(payload.searchTerms[0].sourceFreshness.configuredKeywords.status).toBe('stale');
        expect(payload.searchTerms[1].leadQuality.scope).toBe('term');
    });

    test('adds planner counter-evidence and related search-term evidence', () => {
        const payload = enrichDashboardDecisionRows({
            searchTerms: [{ campaignId: '100', searchTerm: 'free whatsapp crm', spend: 100, clicks: 3, conversions: 0 }],
            keywordPlanner: {
                ideas: [{ keyword: 'free whatsapp crm' }],
                historicalMetrics: []
            }
        }, leadAttribution);

        expect(payload.keywordPlanner.ideas[0].leadQuality.tone).toBe('negative');
        expect(payload.keywordPlanner.ideas[0].leadQualityCounterEvidence).toContain('useless');
        expect(payload.keywordPlanner.ideas[0].relatedSearchTermEvidence[0].spend).toBe(100);
    });

    test('normalizes competitor lead quality onto competitor rows', () => {
        const payload = enrichDashboardDecisionRows({
            competitorBreakdown: [{ competitor: 'wati', spend: 500 }]
        }, leadAttribution);

        expect(payload.competitorBreakdown[0].leadQuality.tone).toBe('positive');
        expect(payload.competitorBreakdown[0].realLeadCount).toBe(1);
        expect(payload.competitorBreakdown[0].qualifiedOrConvertedLeads).toBe(1);
    });
});
