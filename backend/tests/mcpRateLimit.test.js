import { describe, expect, test } from 'bun:test';
import { checkMcpRateLimits } from '../lib/mcp/rateLimit.ts';

function poolCounter() {
    const counts = new Map();
    return {
        async query(_sql, params) {
            const key = params.join('|');
            const next = (counts.get(key) || 0) + 1;
            counts.set(key, next);
            return { rows: [{ count: next }] };
        }
    };
}

describe('MCP DB-backed rate limits', () => {
    test('rate limits increment by shared key across callers', async () => {
        const pool = poolCounter();
        const tool = {
            name: 'raw',
            rateLimit: [{ scope: 'key', windowSeconds: 60, max: 2 }]
        };
        const apiKey = { name: 'shared-key', scopes: ['mcp:raw_gaql'] };
        await checkMcpRateLimits(pool, tool, { session_id: 's1' }, apiKey);
        await checkMcpRateLimits(pool, tool, { session_id: 's2' }, apiKey);
        await expect(checkMcpRateLimits(pool, tool, { session_id: 's3' }, apiKey)).rejects.toThrow(/Rate limit exceeded/);
    });

    test('session-scoped limits are isolated by session id', async () => {
        const pool = poolCounter();
        const tool = {
            name: 'read',
            rateLimit: [{ scope: 'session', windowSeconds: 60, max: 1 }]
        };
        const apiKey = { name: 'key', scopes: ['mcp:read'] };
        await checkMcpRateLimits(pool, tool, { session_id: 's1' }, apiKey);
        await checkMcpRateLimits(pool, tool, { session_id: 's2' }, apiKey);
        await expect(checkMcpRateLimits(pool, tool, { session_id: 's1' }, apiKey)).rejects.toThrow(/Rate limit exceeded/);
    });
});
