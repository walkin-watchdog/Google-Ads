import { describe, expect, test } from 'bun:test';
import { recordLeadStatus } from '../lib/leads.ts';

describe('lead status optimistic concurrency', () => {
    test('rejects malformed versions and oversized keys before opening a transaction', async () => {
        let connectCalls = 0;
        const pool = {
            async query() { return { rows: [], rowCount: 0 }; },
            async connect() {
                connectCalls += 1;
                throw new Error('connect should not be called');
            }
        };

        await expect(recordLeadStatus(pool, {
            sessionKey: 'session:one',
            status: 'qualified',
            baseUpdatedAt: 'not-a-timestamp'
        })).rejects.toThrow('baseUpdatedAt must be a valid timestamp');
        await expect(recordLeadStatus(pool, {
            sessionKey: 's'.repeat(221),
            status: 'qualified'
        })).rejects.toThrow('220 characters or fewer');
        expect(connectCalls).toBe(0);
    });

    test('returns current server state without writing when the client version is stale', async () => {
        const queries = [];
        const currentUpdatedAt = new Date('2026-07-11T00:01:00.000Z');
        const client = {
            async query(sql) {
                const text = String(sql);
                queries.push(text);
                if (text.includes('FROM lead_sessions') && text.includes('FOR UPDATE')) {
                    return {
                        rows: [{
                            session_key: 'session:one',
                            session_key_type: 'session_id',
                            status: 'converted',
                            updated_at: currentUpdatedAt
                        }],
                        rowCount: 1
                    };
                }
                return { rows: [], rowCount: 0 };
            },
            release() {}
        };
        const pool = {
            async query() { return { rows: [], rowCount: 0 }; },
            async connect() { return client; }
        };

        const result = await recordLeadStatus(pool, {
            sessionKey: 'session:one',
            status: 'qualified',
            baseUpdatedAt: '2026-07-11T00:00:00.000Z'
        });

        expect(result.conflict).toEqual({
            serverStatus: 'converted',
            serverUpdatedAt: currentUpdatedAt.toISOString()
        });
        expect(queries).toContain('ROLLBACK');
        expect(queries.some(sql => sql.includes('INSERT INTO lead_events'))).toBe(false);
    });
});
