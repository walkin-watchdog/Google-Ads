import { afterEach, describe, expect, test } from 'bun:test';
import crypto from 'crypto';
import {
    assertMcpApiKeysConfiguredForProduction,
    confirmGoogleAdsSkill,
    requireMcpToolPolicy,
    resolveMcpApiKey
} from '../lib/mcp/policy.ts';

const ORIGINAL_KEYS = process.env.MCP_API_KEYS_JSON;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function req(token) {
    return { headers: { 'x-api-key': token } };
}

afterEach(() => {
    if (ORIGINAL_KEYS === undefined) delete process.env.MCP_API_KEYS_JSON;
    else process.env.MCP_API_KEYS_JSON = ORIGINAL_KEYS;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe('MCP scoped policy', () => {
    test('production requires scoped MCP keys instead of SECRET_API_KEY fallback', () => {
        process.env.NODE_ENV = 'production';
        delete process.env.MCP_API_KEYS_JSON;
        process.env.SECRET_API_KEY = 'legacy';
        expect(() => assertMcpApiKeysConfiguredForProduction()).toThrow(/MCP_API_KEYS_JSON is required/);
    });

    test('resolves scoped API keys by SHA-256 hash', () => {
        process.env.MCP_API_KEYS_JSON = JSON.stringify([{ name: 'test', sha256: sha256('secret'), scopes: ['mcp:read'] }]);
        expect(resolveMcpApiKey(req('secret'))).toMatchObject({ name: 'test', scopes: ['mcp:read'] });
        expect(() => resolveMcpApiKey(req('wrong'))).toThrow(/Invalid MCP API key/);
    });

    test('rejects unsupported configured MCP scopes', () => {
        process.env.MCP_API_KEYS_JSON = JSON.stringify([{ name: 'bad', sha256: sha256('secret'), scopes: ['mcp:read', 'mcp:unknown'] }]);
        expect(() => resolveMcpApiKey(req('secret'))).toThrow(/unsupported scope/);
    });

    test('requires fresh skill confirmation for workflow tools', () => {
        const tool = {
            name: 'get_dashboard_data',
            requiredScopes: ['mcp:read'],
            auditRedaction: [],
            requiresSkillConfirmation: true
        };
        const apiKey = { name: 'test', sha256: sha256('secret'), scopes: ['mcp:read'] };
        const session = {
            session_id: crypto.randomUUID(),
            api_key_name: 'test',
            protocol_version: '2025-11-25',
            client_name: 'client',
            initialized: true,
            skill_name: null,
            skill_confirmed_at: null,
            expires_at: new Date(Date.now() + 3600000).toISOString()
        };
        expect(() => requireMcpToolPolicy(tool, apiKey, session)).toThrow(/skill must be confirmed/);
        session.skill_name = 'saas-google-ads-dashboard-analyst';
        session.skill_confirmed_at = new Date().toISOString();
        expect(() => requireMcpToolPolicy(tool, apiKey, session)).not.toThrow();
    });

    test('validates skill confirmation arguments', () => {
        expect(confirmGoogleAdsSkill({ skillName: 'saas-google-ads-dashboard-analyst', installed: true, loaded: true }).ok).toBe(true);
        expect(confirmGoogleAdsSkill({ skillName: 'wrong', installed: true, loaded: true }).ok).toBe(false);
    });
});
