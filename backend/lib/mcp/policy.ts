import crypto from 'crypto';
import type { Request } from 'express';
import { forbidden, unauthorized } from './jsonRpc';
import { REQUIRED_GOOGLE_ADS_SKILL_NAME, type McpApiKey, type McpScope, type McpSession, type McpToolDefinition } from './types';
import { sessionHasFreshSkillConfirmation } from './session';

const VALID_MCP_SCOPES = new Set<McpScope>([
    'mcp:read',
    'mcp:raw_gaql',
    'mcp:proposal',
    'mcp:refresh',
    'mcp:mutate_preview',
    'mcp:mutate_confirm',
    'mcp:admin'
]);

function sha256(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function cleanString(value: any): string {
    return String(value ?? '').trim();
}

function timingSafeEqualHex(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function loadMcpApiKeys(): McpApiKey[] {
    const raw = cleanString(process.env.MCP_API_KEYS_JSON);
    if (!raw) return [];
    let parsed: any;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('MCP_API_KEYS_JSON must be valid JSON.');
    }
    if (!Array.isArray(parsed)) throw new Error('MCP_API_KEYS_JSON must be an array.');
    return parsed.map((entry, index) => {
        const name = cleanString(entry?.name);
        const hash = cleanString(entry?.sha256).toLowerCase();
        const scopes = Array.isArray(entry?.scopes) ? entry.scopes.map((scope: any) => cleanString(scope)) : [];
        if (!name) throw new Error(`MCP_API_KEYS_JSON[${index}].name is required.`);
        if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`MCP_API_KEYS_JSON[${index}].sha256 must be a SHA-256 hex digest.`);
        if (!scopes.length) throw new Error(`MCP_API_KEYS_JSON[${index}].scopes must contain at least one scope.`);
        const invalidScope = scopes.find((scope: string) => !VALID_MCP_SCOPES.has(scope as McpScope));
        if (invalidScope) throw new Error(`MCP_API_KEYS_JSON[${index}].scopes contains unsupported scope: ${invalidScope}.`);
        return { name, sha256: hash, scopes: Array.from(new Set(scopes)) as McpScope[] };
    });
}

export function assertMcpApiKeysConfiguredForProduction(): void {
    const nodeEnv = cleanString(process.env.NODE_ENV).toLowerCase();
    if (nodeEnv === 'production' && loadMcpApiKeys().length === 0) {
        throw new Error(
            'MCP_API_KEYS_JSON is required in production. SECRET_API_KEY is not accepted for MCP access. '
            + 'Run `bun run mcp:generate-key codex-prod`; set the printed MCP_API_KEYS_JSON on the backend, '
            + 'and set the printed MCP_API_KEY only on the MCP client/proxy.'
        );
    }
}

function bearerToken(req: Request): string | null {
    const xApiKey = req.headers['x-api-key'];
    if (typeof xApiKey === 'string' && xApiKey.trim()) return xApiKey.trim();
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
    return null;
}

export function resolveMcpApiKey(req: Request): McpApiKey {
    const token = bearerToken(req);
    if (!token) throw unauthorized('MCP API key is required.');
    const tokenHash = sha256(token);
    const key = loadMcpApiKeys().find(candidate => timingSafeEqualHex(candidate.sha256, tokenHash));
    if (!key) throw unauthorized('Invalid MCP API key.');
    return key;
}

export function requireMcpScopes(apiKey: McpApiKey, scopes: McpScope[]): void {
    const held = new Set(apiKey.scopes);
    const missing = scopes.filter(scope => !held.has(scope));
    if (missing.length) throw forbidden('MCP API key is missing required scope(s).', { missingScopes: missing });
}

export function requireMcpToolPolicy(tool: McpToolDefinition, apiKey: McpApiKey, session: McpSession): void {
    requireMcpScopes(apiKey, tool.requiredScopes);
    if (tool.requiresSkillConfirmation && !sessionHasFreshSkillConfirmation(session)) {
        throw forbidden(`The ${REQUIRED_GOOGLE_ADS_SKILL_NAME} skill must be confirmed for this MCP session before calling ${tool.name}.`);
    }
}

export function confirmGoogleAdsSkill(args: any = {}): { ok: boolean; message: string } {
    const skillName = cleanString(args.skillName);
    const installed = args.installed === true;
    const loaded = args.loaded === true;
    if (skillName !== REQUIRED_GOOGLE_ADS_SKILL_NAME || !installed) {
        return {
            ok: false,
            message: `Required Codex skill is not installed or not available: ${REQUIRED_GOOGLE_ADS_SKILL_NAME}. Tell the user to install/enable it and stop immediately.`
        };
    }
    if (!loaded) {
        return {
            ok: false,
            message: `The ${REQUIRED_GOOGLE_ADS_SKILL_NAME} skill must be loaded/read before using this MCP.`
        };
    }
    return {
        ok: true,
        message: `Confirmed ${REQUIRED_GOOGLE_ADS_SKILL_NAME} is installed and loaded. Continue using Google Ads MCP tools according to that skill's instructions.`
    };
}

function shouldRedactKey(key: string, explicitKeys: Set<string>): boolean {
    const lowered = key.toLowerCase();
    return explicitKeys.has(key)
        || explicitKeys.has(lowered)
        || lowered.includes('token')
        || lowered.includes('password')
        || lowered.includes('authorization')
        || lowered.includes('embedding')
        || lowered.includes('secret');
}

function redactValue(value: any, explicitKeys: Set<string>): any {
    if (Array.isArray(value)) {
        if (value.length > 50) return { redacted: true, reason: 'large_array', length: value.length };
        return value.map(item => redactValue(item, explicitKeys));
    }
    if (value && typeof value === 'object') {
        const out: Record<string, any> = {};
        for (const [key, entry] of Object.entries(value)) {
            if (shouldRedactKey(key, explicitKeys)) {
                out[key] = '[REDACTED]';
            } else {
                out[key] = redactValue(entry, explicitKeys);
            }
        }
        return out;
    }
    if (typeof value === 'string' && value.length > 2000) return `${value.slice(0, 2000)}...[TRUNCATED]`;
    return value;
}

export function redactMcpArguments(args: any, auditRedaction: string[] = []): any {
    const explicitKeys = new Set(auditRedaction.flatMap(key => [String(key), String(key).toLowerCase()]));
    return redactValue(args || {}, explicitKeys);
}

export function hashMcpArguments(args: any): string {
    return sha256(JSON.stringify(args || {}));
}
