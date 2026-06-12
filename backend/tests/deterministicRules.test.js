import { describe, expect, test } from 'bun:test';
import { __deterministicRulesTestHooks } from '../scripts/deterministic_rules.ts';

class FakeLeadQualityPool {
    constructor(rows) {
        this.rows = rows;
        this.queries = [];
    }

    async query(sql) {
        const compact = String(sql).replace(/\s+/g, ' ').trim();
        this.queries.push(compact);
        if (compact.includes('CREATE TABLE') || compact.includes('CREATE INDEX')) return { rows: [] };
        if (compact.includes('FROM lead_sessions')) return { rows: this.rows };
        return { rows: [] };
    }
}

describe('deterministic candidate signal lead quality mapping', () => {
    test('reads customer id from flattened warehouse account raw payloads', () => {
        const customerId = __deterministicRulesTestHooks.resolveDecisionCustomerId([{
            'customer.id': 'warehouse_customer'
        }], {
            customerId: 'filtered_customer',
            startDate: '2026-01-01',
            endDate: '2026-01-31'
        });

        expect(customerId).toBe('warehouse_customer');
    });

    test('uses selected dashboard customer id when account summary rows are empty', () => {
        const previousCustomerId = process.env.GOOGLE_ADS_CUSTOMER_ID;
        process.env.GOOGLE_ADS_CUSTOMER_ID = 'env_customer';

        try {
            const customerId = __deterministicRulesTestHooks.resolveDecisionCustomerId([], {
                customerId: 'filtered_customer',
                startDate: '2026-01-01',
                endDate: '2026-01-31'
            });

            expect(customerId).toBe('filtered_customer');
        } finally {
            if (previousCustomerId === undefined) delete process.env.GOOGLE_ADS_CUSTOMER_ID;
            else process.env.GOOGLE_ADS_CUSTOMER_ID = previousCustomerId;
        }
    });

    test('matches lead UTM campaign names to warehouse campaign ids without cross-campaign term leakage', async () => {
        const previousDatabaseUrl = process.env.DATABASE_URL;
        process.env.DATABASE_URL = 'postgres://unit-test';
        const pool = new FakeLeadQualityPool([
            {
                status: 'useless',
                event_count: 1,
                attribution: { utm_campaign: 'Core Campaign', utm_term: 'free crm' }
            },
            {
                status: 'useless',
                event_count: 1,
                attribution: { utm_campaign: 'Core Campaign', utm_term: 'free crm' }
            }
        ]);

        try {
            const maps = await __deterministicRulesTestHooks.buildLeadQualityMaps(pool, [
                { campaign: { id: '111', name: 'Core Campaign' } },
                { campaign: { id: '222', name: 'Expansion Campaign' } }
            ]);

            const core = __deterministicRulesTestHooks.searchTermLeadQuality(maps, '111', 'free crm');
            const expansion = __deterministicRulesTestHooks.searchTermLeadQuality(maps, '222', 'free crm');

            expect(core?.uniqueLeads).toBe(2);
            expect(core?.useless).toBe(2);
            expect(expansion).toBeNull();
        } finally {
            if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
            else process.env.DATABASE_URL = previousDatabaseUrl;
        }
    });
});
