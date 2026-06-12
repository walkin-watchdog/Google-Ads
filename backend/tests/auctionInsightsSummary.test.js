import { describe, expect, test } from 'bun:test';
import { buildAuctionInsightsSummary } from '../lib/auctionInsightsSummary.ts';

const filters = {
    customerId: '1234567890',
    startDate: '2026-01-08',
    endDate: '2026-01-09',
    campaignId: null,
    adGroupId: null
};

function row(date, domain, metrics = {}, rawValues = {}) {
    return {
        customer_id: filters.customerId,
        dimension_hash: `${date}-${domain}`,
        source_scope: 'account',
        entity_id: filters.customerId,
        auction_date: date,
        domain,
        impression_share: metrics.impressionShare ?? null,
        overlap_rate: metrics.overlapRate ?? null,
        position_above_rate: metrics.positionAboveRate ?? null,
        top_impression_percentage: metrics.topImpressionRate ?? null,
        absolute_top_impression_percentage: metrics.absoluteTopImpressionRate ?? null,
        outranking_share: metrics.outrankingShare ?? null,
        raw_payload: { 'auction_insights.raw_values': rawValues }
    };
}

describe('Auction Insights summary', () => {
    test('uses metric-specific auction-volume weights instead of arithmetic averages', () => {
        const rows = [
            row('2026-01-08', 'You', { impressionShare: 0.2, topImpressionRate: 0.4, absoluteTopImpressionRate: 0.1 }),
            row('2026-01-09', 'You', { impressionShare: 0.3, topImpressionRate: 0.5, absoluteTopImpressionRate: 0.2 }),
            row('2026-01-08', 'rival.example', { impressionShare: 0.4, overlapRate: 0.2, positionAboveRate: 0.5, topImpressionRate: 0.8, absoluteTopImpressionRate: 0.3, outrankingShare: 0.1 }),
            row('2026-01-09', 'rival.example', { impressionShare: 0.4, overlapRate: 0.6, positionAboveRate: 0.25, topImpressionRate: 0.5, absoluteTopImpressionRate: 0.15, outrankingShare: 0.2 })
        ];

        const summary = buildAuctionInsightsSummary({
            rows,
            accountDaily: [
                { date: '2026-01-08', impressions: 100 },
                { date: '2026-01-09', impressions: 300 }
            ],
            filters
        });

        const you = summary.rows.find(item => item.isYou);
        const rival = summary.rows.find(item => item.domain === 'rival.example');
        expect(you.impressionShare).toBe(26.67);
        expect(rival.overlapRate).toBe(50);
        expect(rival.positionAboveRate).toBe(27.5);
        expect(rival.topImpressionRate).toBe(60);
        expect(rival.absoluteTopImpressionRate).toBe(20);
        expect(summary.meta.requestedRange).toEqual({ start: '2026-01-08', end: '2026-01-09' });
        expect(summary.meta.sourceRows).toBe(4);
    });

    test('preserves Google suppression and computes entrants and exits from the prior period', () => {
        const suppressedRaw = { 'impression share': '< 10%' };
        const currentRows = [
            row('2026-01-08', 'You', { impressionShare: 0.2 }),
            row('2026-01-08', 'steady.example', { impressionShare: 0.3, overlapRate: 0.2 }),
            row('2026-01-08', 'new.example', { impressionShare: 0.0999, overlapRate: 0.1 }, suppressedRaw)
        ];
        const previousRows = [
            row('2026-01-06', 'You', { impressionShare: 0.18 }),
            row('2026-01-06', 'steady.example', { impressionShare: 0.25, overlapRate: 0.15 }),
            row('2026-01-06', 'old.example', { impressionShare: 0.12, overlapRate: 0.1 })
        ];

        const summary = buildAuctionInsightsSummary({
            rows: currentRows,
            previousRows,
            accountDaily: [{ date: '2026-01-08', impressions: 100 }],
            previousPerformanceRows: [{ date: '2026-01-06', impressions: 80 }],
            filters
        });

        expect(summary.rows.find(item => item.domain === 'new.example').display.impressionShare).toBe('<10%');
        expect(summary.rows.find(item => item.domain === 'steady.example').change.impressionShare).toBe(5);
        expect(summary.highlights.entered).toEqual(['new.example']);
        expect(summary.highlights.exited).toEqual(['old.example']);
        expect(summary.meta.comparisonAvailable).toBe(true);
        expect(summary.meta.suppressionPreserved).toBe(true);
        expect(summary.trend.dates).toEqual(['2026-01-06', '2026-01-08']);
    });

    test('marks mixed exact and suppressed aggregates as estimates', () => {
        const summary = buildAuctionInsightsSummary({
            rows: [
                row('2026-01-08', 'You', { impressionShare: 0.2 }),
                row('2026-01-08', 'mixed.example', { impressionShare: 0.18 }),
                row('2026-01-09', 'You', { impressionShare: 0.2 }),
                row('2026-01-09', 'mixed.example', { impressionShare: 0.0999 }, { 'impression share': '< 10%' })
            ],
            accountDaily: [
                { date: '2026-01-08', impressions: 100 },
                { date: '2026-01-09', impressions: 100 }
            ],
            filters
        });

        expect(summary.rows.find(item => item.domain === 'mixed.example').display.impressionShare).toBe('≈11.50%');
    });

    test('uses only the selected campaign performance denominator', () => {
        const summary = buildAuctionInsightsSummary({
            rows: [
                { ...row('2026-01-08', 'You', { impressionShare: 0.2 }), source_scope: 'campaign', entity_id: 'C1', campaign_id: 'C1' },
                { ...row('2026-01-09', 'You', { impressionShare: 0.4 }), source_scope: 'campaign', entity_id: 'C1', campaign_id: 'C1' }
            ],
            campaignDaily: [
                { date: '2026-01-08', campaign_id: 'C1', impressions: 100 },
                { date: '2026-01-09', campaign_id: 'C1', impressions: 100 },
                { date: '2026-01-08', campaign_id: 'C2', impressions: 900 },
                { date: '2026-01-09', campaign_id: 'C2', impressions: 10 }
            ],
            filters: { ...filters, campaignId: 'C1' }
        });

        expect(summary.meta.scope).toEqual({ type: 'campaign', id: 'C1' });
        expect(summary.rows[0].impressionShare).toBe(26.67);
    });
});
