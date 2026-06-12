import { describe, expect, test } from 'bun:test';
import { recordMcpToolAudit } from '../lib/mcp/audit.ts';

describe('MCP audit logging', () => {
    test('writes redacted arguments and metadata for tool calls', async () => {
        const calls = [];
        const pool = {
            async query(sql, params) {
                calls.push({ sql, params });
                return { rows: [] };
            }
        };

        await recordMcpToolAudit(pool, {
            session: { session_id: '00000000-0000-0000-0000-000000000001' },
            apiKey: { name: 'key', scopes: ['mcp:read'] },
            tool: { name: 'search_memories', riskLevel: 'expensive_read', auditRedaction: ['externalAccountId'] },
            args: {
                query: 'context',
                confirmationToken: 'secret-token',
                embedding: [1, 2, 3],
                externalAccountId: 'acct_123'
            },
            status: 'success',
            durationMs: 12,
            resultSummary: 'ok',
            googleRequestId: 'req1'
        });

        expect(calls).toHaveLength(1);
        const params = calls[0].params;
        expect(params[1]).toBe('key');
        expect(params[3]).toBe('search_memories');
        expect(params[7].confirmationToken).toBe('[REDACTED]');
        expect(params[7].embedding).toBe('[REDACTED]');
        expect(params[7].externalAccountId).toBe('[REDACTED]');
        expect(params[11]).toBe('req1');
    });
});
