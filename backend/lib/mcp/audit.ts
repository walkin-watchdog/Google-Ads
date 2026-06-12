import type { Pool } from 'pg';
import { hashMcpArguments, redactMcpArguments } from './policy';
import type { McpApiKey, McpSession, McpToolDefinition } from './types';

export async function recordMcpToolAudit(pool: Pool, input: {
    session: McpSession | null;
    apiKey: McpApiKey | null;
    tool: Pick<McpToolDefinition, 'name' | 'riskLevel'> & { auditRedaction?: string[] };
    args: any;
    status: 'success' | 'error';
    durationMs: number;
    resultSummary?: string | null;
    errorMessage?: string | null;
    googleRequestId?: string | null;
}): Promise<void> {
    await pool.query(
        `INSERT INTO mcp_tool_audit
         (session_id, api_key_name, scopes, tool_name, risk_level, status, duration_ms, args_redacted, args_hash, result_summary, error_message, google_request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
            input.session?.session_id || null,
            input.apiKey?.name || null,
            JSON.stringify(input.apiKey?.scopes || []),
            input.tool.name,
            input.tool.riskLevel,
            input.status,
            Math.max(0, Math.round(input.durationMs)),
            redactMcpArguments(input.args, input.tool.auditRedaction || []),
            hashMcpArguments(input.args),
            input.resultSummary || null,
            input.errorMessage || null,
            input.googleRequestId || null
        ]
    );
}
