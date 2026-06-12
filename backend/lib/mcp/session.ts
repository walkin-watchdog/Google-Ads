import crypto from 'crypto';
import type { Pool } from 'pg';
import { MCP_PROTOCOL_VERSION, REQUIRED_GOOGLE_ADS_SKILL_NAME, type McpApiKey, type McpSession } from './types';
import { notInitialized } from './jsonRpc';

const DEFAULT_MCP_SESSION_TTL_HOURS = 8;

function ttlHours(): number {
    const value = Number(process.env.MCP_SESSION_TTL_HOURS || DEFAULT_MCP_SESSION_TTL_HOURS);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_MCP_SESSION_TTL_HOURS;
}

export function newMcpSessionId(): string {
    return crypto.randomUUID();
}

export function isMcpSessionId(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

export async function ensureMcpCoreSchema(pool: Pool): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS mcp_sessions (
            session_id UUID PRIMARY KEY,
            api_key_name TEXT NOT NULL,
            protocol_version TEXT NOT NULL,
            client_name TEXT,
            initialized BOOLEAN NOT NULL DEFAULT FALSE,
            skill_name TEXT,
            skill_confirmed_at TIMESTAMP WITH TIME ZONE,
            expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS mcp_sessions_key_idx ON mcp_sessions(api_key_name, expires_at);

        CREATE TABLE IF NOT EXISTS mcp_tool_audit (
            id BIGSERIAL PRIMARY KEY,
            session_id UUID,
            api_key_name TEXT,
            scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
            tool_name TEXT NOT NULL,
            risk_level TEXT NOT NULL,
            status TEXT NOT NULL,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            args_redacted JSONB NOT NULL DEFAULT '{}'::jsonb,
            args_hash TEXT NOT NULL,
            result_summary TEXT,
            error_message TEXT,
            google_request_id TEXT,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS mcp_tool_audit_session_idx ON mcp_tool_audit(session_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS mcp_tool_audit_tool_idx ON mcp_tool_audit(tool_name, created_at DESC);

        CREATE TABLE IF NOT EXISTS mcp_rate_limits (
            scope_key TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            window_start TIMESTAMP WITH TIME ZONE NOT NULL,
            window_seconds INTEGER NOT NULL,
            count INTEGER NOT NULL DEFAULT 0,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (scope_key, tool_name, window_start, window_seconds)
        );
        CREATE INDEX IF NOT EXISTS mcp_rate_limits_updated_idx ON mcp_rate_limits(updated_at);
    `);
}

export async function initializeMcpSession(pool: Pool, input: {
    sessionId: string;
    apiKey: McpApiKey;
    clientName?: string | null;
    protocolVersion?: string;
}): Promise<McpSession> {
    const protocolVersion = input.protocolVersion || MCP_PROTOCOL_VERSION;
    const { rows } = await pool.query(
        `INSERT INTO mcp_sessions (session_id, api_key_name, protocol_version, client_name, initialized, expires_at, updated_at)
         VALUES ($1, $2, $3, $4, FALSE, CURRENT_TIMESTAMP + ($5::text || ' hours')::interval, CURRENT_TIMESTAMP)
         ON CONFLICT (session_id) DO UPDATE SET
            api_key_name = EXCLUDED.api_key_name,
            protocol_version = EXCLUDED.protocol_version,
            client_name = EXCLUDED.client_name,
            initialized = FALSE,
            skill_name = NULL,
            skill_confirmed_at = NULL,
            expires_at = EXCLUDED.expires_at,
            updated_at = CURRENT_TIMESTAMP
         RETURNING session_id::text, api_key_name, protocol_version, client_name, initialized, skill_name, skill_confirmed_at::text, expires_at::text`,
        [input.sessionId, input.apiKey.name, protocolVersion, input.clientName || null, ttlHours()]
    );
    return rows[0];
}

export async function markMcpSessionInitialized(pool: Pool, sessionId: string, apiKey: McpApiKey): Promise<void> {
    const { rows } = await pool.query(
        `UPDATE mcp_sessions
         SET initialized = TRUE, api_key_name = $2, expires_at = CURRENT_TIMESTAMP + ($3::text || ' hours')::interval, updated_at = CURRENT_TIMESTAMP
         WHERE session_id = $1
           AND api_key_name = $2
           AND protocol_version = $4
           AND expires_at > CURRENT_TIMESTAMP
         RETURNING session_id`,
        [sessionId, apiKey.name, ttlHours(), MCP_PROTOCOL_VERSION]
    );
    if (!rows.length) throw notInitialized();
}

export async function loadInitializedMcpSession(pool: Pool, sessionId: string, apiKey: McpApiKey): Promise<McpSession> {
    const { rows } = await pool.query(
        `SELECT session_id::text, api_key_name, protocol_version, client_name, initialized, skill_name,
                skill_confirmed_at::text, expires_at::text
         FROM mcp_sessions
         WHERE session_id = $1
           AND api_key_name = $2
           AND expires_at > CURRENT_TIMESTAMP`,
        [sessionId, apiKey.name]
    );
    const session = rows[0];
    if (!session || session.initialized !== true) throw notInitialized();
    return session;
}

export async function markMcpSkillConfirmed(pool: Pool, sessionId: string, apiKey: McpApiKey): Promise<void> {
    await pool.query(
        `UPDATE mcp_sessions
         SET skill_name = $3,
             skill_confirmed_at = CURRENT_TIMESTAMP,
             expires_at = CURRENT_TIMESTAMP + ($4::text || ' hours')::interval,
             updated_at = CURRENT_TIMESTAMP
         WHERE session_id = $1 AND api_key_name = $2`,
        [sessionId, apiKey.name, REQUIRED_GOOGLE_ADS_SKILL_NAME, ttlHours()]
    );
}

export function sessionHasFreshSkillConfirmation(session: McpSession): boolean {
    if (session.skill_name !== REQUIRED_GOOGLE_ADS_SKILL_NAME || !session.skill_confirmed_at) return false;
    const confirmedAt = new Date(session.skill_confirmed_at).getTime();
    return Number.isFinite(confirmedAt) && Date.now() - confirmedAt < ttlHours() * 3_600_000;
}
