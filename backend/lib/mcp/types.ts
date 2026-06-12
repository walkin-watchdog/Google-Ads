import type { Pool } from 'pg';

export const MCP_PROTOCOL_VERSION = '2025-11-25';
export const MCP_MIN_PROTOCOL_VERSION = '2025-11-25';
export const REQUIRED_GOOGLE_ADS_SKILL_NAME = 'saas-google-ads-dashboard-analyst';
export const MCP_SERVER_CAPABILITIES = { tools: { listChanged: false } } as const;
export const MCP_SERVER_INFO = {
    name: 'google-ads-dashboard-mcp',
    title: 'Google Ads Analyst MCP',
    version: '2.0.0',
    description: 'Single-tenant Google Ads warehouse, dashboard, proposal, mutation preview/confirm, and impact tracking tools.'
} as const;
export const MCP_SERVER_INSTRUCTIONS =
    `First call confirm_google_ads_skill with skillName="${REQUIRED_GOOGLE_ADS_SKILL_NAME}", installed=true, and loaded=true. `
    + 'Use the remaining tools only after that confirmation succeeds, and follow the Google Ads analyst skill policy for analysis, proposals, and mutation workflows.';

export type JsonSchema = Record<string, any>;

export type McpScope =
    | 'mcp:read'
    | 'mcp:raw_gaql'
    | 'mcp:proposal'
    | 'mcp:refresh'
    | 'mcp:mutate_preview'
    | 'mcp:mutate_confirm'
    | 'mcp:admin';

export type McpRiskLevel =
    | 'read'
    | 'expensive_read'
    | 'raw_external_query'
    | 'write_proposal'
    | 'refresh'
    | 'mutation_preview'
    | 'mutation_confirm'
    | 'admin_destructive';

export interface McpApiKey {
    name: string;
    sha256: string;
    scopes: McpScope[];
}

export interface McpSession {
    session_id: string;
    api_key_name: string;
    protocol_version: string;
    client_name: string | null;
    initialized: boolean;
    skill_name: string | null;
    skill_confirmed_at: string | null;
    expires_at: string;
}

export interface McpRateLimitRule {
    scope: 'session' | 'key';
    windowSeconds: number;
    max: number;
}

export interface McpToolContext {
    pool: Pool;
    session: McpSession;
    apiKey: McpApiKey;
    arguments: Record<string, any>;
    request?: any;
}

export interface McpToolHandlerResult {
    structuredContent: any;
    content?: Array<{ type: 'text'; text: string }>;
    resultSummary?: string;
    googleRequestId?: string | null;
}

export interface McpToolDefinition {
    name: string;
    title: string;
    description: string;
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    annotations: Record<string, any>;
    requiredScopes: McpScope[];
    requiresSkillConfirmation: boolean;
    rateLimit: McpRateLimitRule[];
    riskLevel: McpRiskLevel;
    auditRedaction: string[];
    handler: (context: McpToolContext) => Promise<McpToolHandlerResult>;
}

export interface McpToolListPage {
    tools: Array<Omit<McpToolDefinition, 'handler' | 'requiredScopes' | 'requiresSkillConfirmation' | 'rateLimit' | 'riskLevel' | 'auditRedaction'>>;
    nextCursor?: string;
}

export function normalizeMcpProtocolVersion(value: any): string | null {
    const text = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const [year, month, day] = text.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
        parsed.getUTCFullYear() !== year
        || parsed.getUTCMonth() !== month - 1
        || parsed.getUTCDate() !== day
    ) {
        return null;
    }
    return text;
}

export function isSupportedMcpProtocolVersion(value: any): boolean {
    const version = normalizeMcpProtocolVersion(value);
    return Boolean(version && version >= MCP_MIN_PROTOCOL_VERSION);
}

export function negotiateMcpProtocolVersion(value: any): string | null {
    return isSupportedMcpProtocolVersion(value) ? MCP_PROTOCOL_VERSION : null;
}

export function unsupportedMcpProtocolMessage(value: any): string {
    const requested = normalizeMcpProtocolVersion(value) || String(value || 'missing').trim() || 'missing';
    return `Unsupported MCP protocol version ${requested}. This server requires ${MCP_MIN_PROTOCOL_VERSION} or newer and currently negotiates ${MCP_PROTOCOL_VERSION}.`;
}
