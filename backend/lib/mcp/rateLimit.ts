import type { Pool } from 'pg';
import { rateLimited } from './jsonRpc';
import type { McpApiKey, McpRateLimitRule, McpSession, McpToolDefinition } from './types';

function windowStart(seconds: number): Date {
    const now = Date.now();
    return new Date(Math.floor(now / (seconds * 1000)) * seconds * 1000);
}

export async function checkMcpRateLimits(pool: Pool, tool: McpToolDefinition, session: McpSession, apiKey: McpApiKey): Promise<void> {
    for (const rule of tool.rateLimit) {
        await checkRule(pool, tool.name, rule, session, apiKey);
    }
}

async function checkRule(pool: Pool, toolName: string, rule: McpRateLimitRule, session: McpSession, apiKey: McpApiKey): Promise<void> {
    const scopeKey = rule.scope === 'session'
        ? `session:${session.session_id}`
        : `key:${apiKey.name}`;
    const start = windowStart(rule.windowSeconds);
    const { rows } = await pool.query(
        `INSERT INTO mcp_rate_limits (scope_key, tool_name, window_start, window_seconds, count, updated_at)
         VALUES ($1, $2, $3, $4, 1, CURRENT_TIMESTAMP)
         ON CONFLICT (scope_key, tool_name, window_start, window_seconds)
         DO UPDATE SET count = mcp_rate_limits.count + 1, updated_at = CURRENT_TIMESTAMP
         RETURNING count`,
        [scopeKey, toolName, start.toISOString(), rule.windowSeconds]
    );
    const count = Number(rows[0]?.count || 0);
    if (count > rule.max) {
        const retryAfterSeconds = Math.max(1, Math.ceil((start.getTime() + rule.windowSeconds * 1000 - Date.now()) / 1000));
        throw rateLimited(`Rate limit exceeded for ${toolName}.`, {
            scope: rule.scope,
            limit: rule.max,
            windowSeconds: rule.windowSeconds,
            retryAfterSeconds
        });
    }
}
