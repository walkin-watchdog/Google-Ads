import { afterEach, describe, expect, test } from 'bun:test';
import {
    clearLeadAttributionSummaryCache,
    exportOfflineConversionsCsv,
    getLeadAttributionSummary,
    getLeadQualityMetricsForWindow
} from '../lib/leads.ts';

class FakeLeadPool {
    constructor() {
        this.queries = [];
    }

    async query(sql, params = []) {
        const compact = sql.replace(/\s+/g, ' ').trim();
        this.queries.push(compact);
        if (compact.includes('CREATE TABLE IF NOT EXISTS lead_events')) return { rows: [] };
        if (compact.includes('FROM lead_events')) throw new Error(`Overview should not query lead_events: ${compact}`);
        if (compact.includes('COUNT(*) FILTER')) {
            return { rows: [{ needs_review: 1, qualified_or_converted: 2, ready_rows: 1 }] };
        }
        if (compact.includes('SELECT session_key, session_key_type')) {
            return {
                rows: [{
                    session_key: 'session_id:abc',
                    session_key_type: 'session_id',
                    status: 'qualified',
                    status_rank: 1,
                    event_count: 2,
                    lead_ids: ['lead-1'],
                    attribution: {
                        utm_campaign: '111',
                        utm_term: 'whatsapp crm',
                        keyword: 'whatsapp crm',
                        match_type: 'EXACT',
                        gclid: 'gclid-1'
                    },
                    contact: { name: 'Lead One', email: 'lead@example.com' },
                    first_seen: '2026-01-10T00:00:00.000Z',
                    last_seen: '2026-01-11T00:00:00.000Z'
                }]
            };
        }
        if (compact.includes('GROUP BY campaign_id, status')) {
            return {
                rows: [
                    { campaign_id: '111', status: 'qualified', unique_leads: 1, event_count: 2 },
                    { campaign_id: '222', status: 'useless', unique_leads: 1, event_count: 1 }
                ]
            };
        }
        if (compact.includes('GROUP BY campaign_id, search_term, keyword, match_type, status')) {
            return {
                rows: [
                    { campaign_id: '111', search_term: 'whatsapp crm', keyword: 'whatsapp crm', match_type: 'EXACT', status: 'qualified', unique_leads: 1, event_count: 2 }
                ]
            };
        }
        if (compact.includes('GROUP BY status')) {
            return {
                rows: [
                    { status: 'qualified', unique_leads: 1, event_count: 2 },
                    { status: 'useless', unique_leads: 1, event_count: 1 },
                    { status: 'new', unique_leads: 1, event_count: 1 }
                ]
            };
        }
        return { rows: [] };
    }
}

class FakeOfflineExportPool {
    constructor() {
        this.queries = [];
    }

    async query(sql, params = []) {
        const compact = sql.replace(/\s+/g, ' ').trim();
        this.queries.push({ sql: compact, params });
        if (compact.includes('CREATE TABLE IF NOT EXISTS lead_events')) return { rows: [] };
        if (!compact.includes('FROM lead_sessions ls')) return { rows: [] };
        const campaignValues = params.find(param => Array.isArray(param) && param.includes('Core Campaign')) || [];
        const rows = [
            {
                session_key: 'session_id:name-match',
                status: 'qualified',
                lead_ids: ['lead-name-match'],
                attribution: { utm_campaign: 'Core Campaign', gclid: 'gclid-name' },
                last_seen: '2026-01-12T00:00:00.000Z',
                updated_at: '2026-01-12T00:00:00.000Z'
            },
            {
                session_key: 'session_id:other',
                status: 'qualified',
                lead_ids: ['lead-other'],
                attribution: { utm_campaign: 'Other Campaign', gclid: 'gclid-other' },
                last_seen: '2026-01-12T00:00:00.000Z',
                updated_at: '2026-01-12T00:00:00.000Z'
            }
        ];
        return {
            rows: rows.filter(row => !campaignValues.length || campaignValues.includes(row.attribution.utm_campaign))
        };
    }
}

class FakeLeadQualityWindowPool {
    constructor() {
        this.queries = [];
    }

    async query(sql, params = []) {
        const compact = sql.replace(/\s+/g, ' ').trim();
        this.queries.push({ sql: compact, params });
        if (compact.includes('CREATE TABLE IF NOT EXISTS lead_events')) return { rows: [] };
        if (!compact.includes('FROM lead_sessions')) return { rows: [] };
        const campaignValues = params.find(param => Array.isArray(param)) || [];
        return {
            rows: campaignValues.includes('Core Campaign')
                ? [{ status: 'qualified', event_count: 1 }]
                : []
        };
    }
}

class FakeAmbiguousCampaignLeadPool {
    async query(sql) {
        const compact = sql.replace(/\s+/g, ' ').trim();
        if (compact.includes('CREATE TABLE IF NOT EXISTS lead_events')) return { rows: [] };
        if (compact.includes('FROM lead_events')) throw new Error(`Overview should not query lead_events: ${compact}`);
        if (compact.includes('COUNT(*) FILTER')) {
            return { rows: [{ needs_review: 0, qualified_or_converted: 1, ready_rows: 0 }] };
        }
        if (compact.includes('SELECT session_key, session_key_type')) return { rows: [] };
        if (compact.includes('GROUP BY campaign_id, status')) {
            return { rows: [{ campaign_id: 'Shared Campaign', status: 'qualified', unique_leads: 1, event_count: 1 }] };
        }
        if (compact.includes('GROUP BY campaign_id, search_term, keyword, match_type, status')) {
            return {
                rows: [{
                    campaign_id: 'Shared Campaign',
                    search_term: 'crm',
                    keyword: 'crm',
                    match_type: 'EXACT',
                    status: 'qualified',
                    unique_leads: 1,
                    event_count: 1
                }]
            };
        }
        if (compact.includes('GROUP BY status')) {
            return { rows: [{ status: 'qualified', unique_leads: 1, event_count: 1 }] };
        }
        return { rows: [] };
    }
}

const dashboardData = {
    meta: {
        accountId: '1234567890',
        dateRange: { start: '2026-01-01', end: '2026-01-31' },
        filters: { campaignId: null, adGroupId: null }
    },
    periodComparison: {
        previousPeriod: { label: '2026-01-01 - 2026-01-15' },
        currentPeriod: { label: '2026-01-16 - 2026-01-31' }
    },
    campaigns: [
        { id: '111', name: 'Core', spend: 100 },
        { id: '222', name: 'Expansion', spend: 50 }
    ]
};

afterEach(() => {
    clearLeadAttributionSummaryCache();
    delete process.env.LEAD_ATTRIBUTION_OVERVIEW_CACHE_SECONDS;
});

describe('lead attribution overview summary', () => {
    test('uses lead_sessions aggregates without loading lead_events', async () => {
        process.env.LEAD_ATTRIBUTION_OVERVIEW_CACHE_SECONDS = '0';
        const pool = new FakeLeadPool();

        const summary = await getLeadAttributionSummary(pool, dashboardData, { mode: 'overview' });

        expect(summary.mode).toBe('overview');
        expect(summary.totals.uniqueLeads).toBe(3);
        expect(summary.totals.qualified).toBe(1);
        expect(summary.byCampaign[0].campaignId).toBe('111');
        expect(summary.bySearchTerm[0].searchTerm).toBe('whatsapp crm');
        expect(summary.recentLeads).toHaveLength(1);
        expect(summary.periodComparison.currentPeriod.realConversions).toBe(3);
        expect(pool.queries.some(query => query.includes('FROM lead_events'))).toBe(false);
    });

    test('caches repeated overview summaries for the same selected slice', async () => {
        process.env.LEAD_ATTRIBUTION_OVERVIEW_CACHE_SECONDS = '60';
        const pool = new FakeLeadPool();

        await getLeadAttributionSummary(pool, dashboardData, { mode: 'overview' });
        const firstQueryCount = pool.queries.length;
        await getLeadAttributionSummary(pool, dashboardData, { mode: 'overview' });

        expect(pool.queries.length).toBe(firstQueryCount);
    });

    test('applies selected campaign and ad-group scope to lead session aggregates', async () => {
        process.env.LEAD_ATTRIBUTION_OVERVIEW_CACHE_SECONDS = '0';
        const pool = new FakeLeadPool();

        const summary = await getLeadAttributionSummary(pool, {
            ...dashboardData,
            adGroups: [{ id: 'A1', name: 'Core Exact', campaignId: '111' }],
            meta: {
                ...dashboardData.meta,
                filters: { campaignId: '111', adGroupId: 'A1' }
            }
        }, { mode: 'overview' });

        expect(summary.scope).toEqual({
            campaignId: '111',
            campaignNames: ['Core'],
            adGroupId: 'A1',
            adGroupNames: ['Core Exact'],
            level: 'ad_group',
            adGroupField: 'attribution.ad_group_id'
        });
        expect(pool.queries.some(query => query.includes("attribution->>'utm_campaign' = ANY"))).toBe(true);
        expect(pool.queries.some(query => query.includes("attribution->>'ad_group_id' = ANY"))).toBe(true);
    });

    test('does not resolve duplicate campaign-name UTMs to an arbitrary campaign id', async () => {
        process.env.LEAD_ATTRIBUTION_OVERVIEW_CACHE_SECONDS = '0';
        const summary = await getLeadAttributionSummary(new FakeAmbiguousCampaignLeadPool(), {
            ...dashboardData,
            campaigns: [
                { id: '111', name: 'Shared Campaign', spend: 100 },
                { id: '222', name: 'Shared Campaign', spend: 200 }
            ]
        }, { mode: 'overview' });

        expect(summary.byCampaign[0].campaignId).toBe('Shared Campaign');
        expect(summary.byCampaign[0].campaignName).toBeNull();
        expect(summary.bySearchTerm[0].campaignId).toBe('Shared Campaign');
    });
});

describe('offline conversion export', () => {
    test('matches selected campaign by id or known campaign name', async () => {
        const pool = new FakeOfflineExportPool();

        const result = await exportOfflineConversionsCsv(pool, {
            statuses: 'qualified,converted',
            startDate: '2026-01-01',
            endDate: '2026-01-31',
            campaignId: '111',
            campaignName: 'Core Campaign'
        });

        expect(result.rowCount).toBe(1);
        expect(result.csv).toContain('gclid-name');
        expect(result.csv).not.toContain('gclid-other');
        expect(pool.queries.some(query => query.sql.includes("ls.attribution->>'utm_campaign' = ANY"))).toBe(true);
        expect(pool.queries.some(query => query.params.some(param => Array.isArray(param) && param.includes('111') && param.includes('Core Campaign')))).toBe(true);
    });
});

describe('lead quality impact windows', () => {
    test('matches selected campaign by id or known campaign name', async () => {
        const pool = new FakeLeadQualityWindowPool();

        const metrics = await getLeadQualityMetricsForWindow(pool, {
            start: new Date('2026-01-01T00:00:00.000Z'),
            end: new Date('2026-02-01T00:00:00.000Z'),
            campaignId: '111',
            campaignName: 'Core Campaign'
        });

        expect(metrics.uniqueLeads).toBe(1);
        expect(metrics.qualified).toBe(1);
        expect(pool.queries.some(query => query.sql.includes("attribution->>'utm_campaign' = ANY"))).toBe(true);
        expect(pool.queries.some(query => query.params.some(param => Array.isArray(param) && param.includes('111') && param.includes('Core Campaign')))).toBe(true);
    });
});
