import { describe, expect, test } from 'bun:test';
import {
    getKeywordsOverviewWidget,
    getSearchTermsOverviewWidget,
    OverviewWidgetValidationError
} from '../lib/overviewWidgets.ts';

const filters = {
    customerId: '1234567890',
    startDate: '2026-07-01',
    endDate: '2026-07-02',
    campaignId: '111',
    adGroupId: '222'
};

class WidgetPool {
    calls = [];

    async query(sql, params = []) {
        const normalized = String(sql).replace(/\s+/g, ' ').trim();
        this.calls.push({ sql: normalized, params });
        if (normalized.includes('FROM google_ads_report_coverage')) {
            const reportNames = params[3] || [];
            return {
                rows: reportNames.flatMap(reportName => ['2026-07-01', '2026-07-02'].map(date => ({
                    report_name: reportName,
                    coverage_date: date,
                    status: 'covered',
                    row_count: 4,
                    fetched_at: '2026-07-03T00:00:00.000Z',
                    error: null
                })))
            };
        }
        if (normalized.includes('GROUP BY conversion_action_category, conversion_action_name')) {
            return { rows: [{ category: 'SUBMIT_LEAD_FORM', name: 'Contact Form Submit', conversions: '3' }] };
        }
        if (normalized.includes('FROM google_ads_configured_keywords k')) {
            return { rows: [{
                campaign_id: '111', campaign_name: 'Core', ad_group_id: '222', ad_group_name: 'Leads',
                criterion_id: '333', keyword_text: 'whatsapp crm', match_type: 'EXACT', status: 'ENABLED',
                primary_status: 'ELIGIBLE', cost_micros: '2500000', clicks: '5', impressions: '100',
                conversions: '2', ctr: '0.05', average_cpc_micros: '500000', conversion_rate: '0.4',
                cost_per_conversion_micros: '1250000', search_impression_share: '0.62', total_items: 11
            }] };
        }
        if (normalized.includes('WITH scoped AS')) {
            return { rows: [{
                label: 'whatsapp crm', cost_micros: '2500000', clicks: '5', impressions: '100',
                conversions: '2', already_added: false, already_excluded: false, total_items: 17,
                scopes: [{
                    campaignId: '111', campaignName: 'Core', adGroupId: '222', adGroupName: 'Leads',
                    costMicros: 2500000, clicks: 5, impressions: 100, conversions: 2,
                    matchedKeywords: [{ text: 'whatsapp software', matchType: 'PHRASE' }]
                }]
            }] };
        }
        throw new Error(`Unexpected query: ${normalized.slice(0, 180)}`);
    }
}

describe('bounded Overview widget queries', () => {
    test('returns a compact search page with scope-safe mutation context and conversion choices', async () => {
        const pool = new WidgetPool();
        const payload = await getSearchTermsOverviewWidget(pool, filters, {
            mode: 'searches', metric: 'conversions', conversionCategory: 'SUBMIT_LEAD_FORM', page: 2, pageSize: 10
        });

        expect(payload.rows).toHaveLength(1);
        expect(payload.rows[0]).toMatchObject({ label: 'whatsapp crm', clicks: 5, conversions: 2 });
        expect(payload.rows[0].scopes[0]).toMatchObject({ campaignId: '111', adGroupId: '222' });
        expect(payload.pagination).toEqual({ page: 2, pageSize: 10, totalItems: 17, totalPages: 2 });
        expect(payload.conversionOptions.categories[0].name).toBe('SUBMIT_LEAD_FORM');
        expect(payload.coverage.map(row => row.reportName)).toEqual([
            'search_term_performance', 'conversion_attribution_by_search_term'
        ]);
        expect(payload.coverage[0]).toMatchObject({ missingDates: [], failedDates: [] });
        const main = pool.calls.find(call => call.sql.includes('WITH scoped AS'));
        expect(main.sql).toContain('LIMIT $');
        expect(main.sql).toContain('OFFSET $');
        expect(main.params.at(-2)).toBe(10);
        expect(main.params.at(-1)).toBe(10);
        expect(main.sql).not.toContain('SELECT * FROM google_ads_search_term_daily');
        const coverageQuery = pool.calls.find(call => call.sql.includes('FROM google_ads_report_coverage'));
        expect(coverageQuery.sql).toContain('coverage_date::text AS coverage_date');
    });

    test('returns only the requested keyword page and supported metrics', async () => {
        const pool = new WidgetPool();
        const payload = await getKeywordsOverviewWidget(pool, filters, {
            sort: 'costPerConversion', direction: 'asc', page: 3, pageSize: 5
        });

        expect(payload.rows[0]).toMatchObject({ keywordText: 'whatsapp crm', costMicros: 2500000, conversions: 2 });
        expect(payload.pagination).toEqual({ page: 3, pageSize: 5, totalItems: 11, totalPages: 3 });
        expect(payload.allowedMetrics).toContain('searchImpressionShare');
        expect(payload.allowedMetrics).not.toContain('conversionValue');
        expect(payload.allowedMetrics).not.toContain('interactions');
        expect(payload.allowedMetrics).not.toContain('phoneCalls');
        const main = pool.calls.find(call => call.sql.includes('FROM google_ads_configured_keywords k'));
        expect(main.sql).toContain('ORDER BY cost_per_conversion_micros ASC');
        expect(main.params.at(-2)).toBe(5);
        expect(main.params.at(-1)).toBe(10);
    });

    test('allows a denser but still bounded server page for the words cloud', async () => {
        const pool = new WidgetPool();
        const payload = await getSearchTermsOverviewWidget(pool, filters, {
            mode: 'words', metric: 'clicks', page: 1, pageSize: 30
        });

        expect(payload.pagination.pageSize).toBe(30);
        const main = pool.calls.find(call => call.sql.includes('WITH scoped AS'));
        expect(main.params.at(-2)).toBe(30);
        await expect(getSearchTermsOverviewWidget(pool, filters, { mode: 'words', pageSize: 41 }))
            .rejects.toThrow(/pageSize/);
    });

    test('defaults searches to a larger but bounded 20-row server page', async () => {
        const pool = new WidgetPool();
        const payload = await getSearchTermsOverviewWidget(pool, filters, {
            mode: 'searches', metric: 'clicks', page: 1
        });

        expect(payload.pagination.pageSize).toBe(20);
        const main = pool.calls.find(call => call.sql.includes('WITH scoped AS'));
        expect(main.params.at(-2)).toBe(20);
    });

    test('rejects unsupported metrics and oversized pages before querying', async () => {
        const pool = new WidgetPool();
        await expect(getSearchTermsOverviewWidget(pool, filters, { metric: 'phoneCalls' }))
            .rejects.toBeInstanceOf(OverviewWidgetValidationError);
        await expect(getKeywordsOverviewWidget(pool, filters, { pageSize: 21 }))
            .rejects.toThrow(/pageSize/);
        expect(pool.calls).toHaveLength(0);
    });
});
