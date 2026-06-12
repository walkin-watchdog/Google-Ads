import { describe, expect, test } from 'bun:test';
import { createMcpToolRegistry, normalizeRawGaql } from '../lib/mcp/toolRegistry.ts';

function rawTool() {
    const registry = createMcpToolRegistry({
        pool: { query: async () => ({ rows: [] }) },
        getDashboardPayload: async () => ({}),
        startRefreshJob: () => ({ status: 'started' }),
        assertSemanticMemoryAvailable: () => undefined
    });
    return registry.get('search_search');
}

function context(args) {
    return {
        pool: { query: async () => ({ rows: [] }) },
        session: { session_id: 's1' },
        apiKey: { name: 'key', scopes: ['mcp:raw_gaql'] },
        arguments: args
    };
}

describe('raw GAQL MCP controls', () => {
    test('rejects metric queries without explicit date filter', async () => {
        await expect(rawTool().handler(context({
            query: 'SELECT campaign.id, metrics.clicks FROM campaign LIMIT 10'
        }))).rejects.toThrow(/segments.date filter/);
    });

    test('rejects queries without LIMIT', async () => {
        await expect(rawTool().handler(context({
            query: 'SELECT campaign.id FROM campaign'
        }))).rejects.toThrow(/explicit LIMIT/);
    });

    test('accepts symbolic segments.date filters on metric queries', () => {
        for (const operator of ['=', '>=', '>', '<=', '<']) {
            expect(normalizeRawGaql({
                query: `SELECT campaign.id, metrics.clicks FROM campaign WHERE segments.date ${operator} '2026-01-01' LIMIT 10`
            }).query).toContain(`segments.date ${operator}`);
        }
    });

    test('rejects invalid maxRows instead of disabling the row cap', async () => {
        await expect(rawTool().handler(context({
            query: 'SELECT campaign.id FROM campaign LIMIT 50000',
            maxRows: 'not-a-number'
        }))).rejects.toThrow(/maxRows must be a positive number/);
    });

    test('rejects non-positive query limits', async () => {
        await expect(rawTool().handler(context({
            query: 'SELECT campaign.id FROM campaign LIMIT 0'
        }))).rejects.toThrow(/LIMIT must be a positive safe integer/);
    });

    test('rejects obvious broad segment explosions', async () => {
        await expect(rawTool().handler(context({
            query: 'SELECT segments.date, segments.device, segments.slot, segments.day_of_week, segments.hour, metrics.clicks FROM ad_group WHERE segments.date DURING LAST_30_DAYS LIMIT 100'
        }))).rejects.toThrow(/too many segments/);
    });
});
