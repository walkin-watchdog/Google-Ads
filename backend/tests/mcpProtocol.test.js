import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { requireJsonRpcRequest } from '../lib/mcp/jsonRpc.ts';
import {
    isSupportedMcpProtocolVersion,
    MCP_MIN_PROTOCOL_VERSION,
    MCP_PROTOCOL_VERSION,
    MCP_SERVER_CAPABILITIES,
    MCP_SERVER_INFO,
    MCP_SERVER_INSTRUCTIONS,
    negotiateMcpProtocolVersion
} from '../lib/mcp/types.ts';
import { createMcpToolRegistry, mcpToolsPage } from '../lib/mcp/toolRegistry.ts';
import { initializeMcpSession, isMcpSessionId, markMcpSessionInitialized } from '../lib/mcp/session.ts';

const root = path.join(import.meta.dir, '..');

function registry() {
    return createMcpToolRegistry({
        pool: { query: async () => ({ rows: [] }) },
        getDashboardPayload: async () => ({}),
        startRefreshJob: () => ({ status: 'started' }),
        assertSemanticMemoryAvailable: () => undefined
    });
}

describe('MCP 2025 protocol surface', () => {
    test('accepts 2025-11-25 and newer protocol dates while blocking older clients', () => {
        const localMcp = fs.readFileSync(path.join(root, '..', 'MCP', 'mcp-server.js'), 'utf8');
        expect(MCP_PROTOCOL_VERSION).toBe('2025-11-25');
        expect(MCP_MIN_PROTOCOL_VERSION).toBe('2025-11-25');
        expect(isSupportedMcpProtocolVersion('2025-11-25')).toBe(true);
        expect(isSupportedMcpProtocolVersion('2026-01-01')).toBe(true);
        expect(isSupportedMcpProtocolVersion('2025-06-18')).toBe(false);
        expect(isSupportedMcpProtocolVersion('not-a-date')).toBe(false);
        expect(negotiateMcpProtocolVersion('2026-01-01')).toBe(MCP_PROTOCOL_VERSION);
        expect(localMcp).toContain("const MCP_PROTOCOL_VERSION = '2025-11-25'");
        expect(localMcp).toContain("const MCP_MIN_PROTOCOL_VERSION = '2025-11-25'");
        expect(localMcp).not.toContain('2024-11-05');
        expect(localMcp).toContain('notifications/initialized');
    });

    test('validates JSON-RPC requests', () => {
        expect(() => requireJsonRpcRequest({ method: 'tools/list' })).toThrow(/JSON-RPC version/);
        expect(requireJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toMatchObject({ id: 1, method: 'tools/list' });
    });

    test('initialize metadata advertises only implemented capabilities and skill-gate instructions', () => {
        expect(MCP_SERVER_CAPABILITIES).toEqual({ tools: { listChanged: false } });
        expect(MCP_SERVER_CAPABILITIES).not.toHaveProperty('logging');
        expect(MCP_SERVER_CAPABILITIES).not.toHaveProperty('resources');
        expect(MCP_SERVER_CAPABILITIES).not.toHaveProperty('prompts');
        expect(MCP_SERVER_CAPABILITIES).not.toHaveProperty('tasks');
        expect(MCP_SERVER_CAPABILITIES).not.toHaveProperty('completions');
        expect(MCP_SERVER_INFO).toMatchObject({
            name: 'google-ads-dashboard-mcp',
            title: 'Google Ads Analyst MCP',
            version: '2.0.0'
        });
        expect(MCP_SERVER_INFO.description).toContain('Google Ads warehouse');
        expect(MCP_SERVER_INSTRUCTIONS).toContain('First call confirm_google_ads_skill');
        expect(MCP_SERVER_INSTRUCTIONS).toContain('saas-google-ads-dashboard-analyst');
    });

    test('tools/list is paginated and exposes structured schemas', () => {
        const first = mcpToolsPage(registry(), null, 3);
        expect(first.tools).toHaveLength(3);
        expect(first.nextCursor).toBeTruthy();
        expect(first.tools[0]).toHaveProperty('inputSchema');
        expect(first.tools[0]).toHaveProperty('outputSchema');
        const second = mcpToolsPage(registry(), first.nextCursor, 3);
        expect(second.tools.map(tool => tool.name)).not.toEqual(first.tools.map(tool => tool.name));
    });

    test('high-risk MCP tools expose precise top-level output schemas', () => {
        const tools = registry();
        expect(tools.get('search_search').outputSchema.properties).toMatchObject({
            rows: { type: 'array' },
            rowCount: { type: 'number' },
            truncated: { type: 'boolean' },
            requestId: { type: ['string', 'null'] },
            apiVersion: { type: 'string' },
            warnings: { type: 'array' }
        });
        expect(tools.get('google_ads_preview_keyword_changes').outputSchema.required).toEqual([
            'mutationId',
            'confirmationToken',
            'expiresAt',
            'diff',
            'warnings',
            'operationsSummary'
        ]);
        expect(tools.get('google_ads_preview_audience_changes').outputSchema.required).toEqual([
            'mutationId',
            'confirmationToken',
            'expiresAt',
            'diff',
            'warnings',
            'operationsSummary'
        ]);
        expect(tools.get('google_ads_confirm_mutation').outputSchema.properties.refresh.type).toBe('object');
        expect(tools.get('trigger_refresh').outputSchema.required).toEqual(['status', 'message']);
        expect(tools.get('get_learning_summary').outputSchema.properties.learningPolicy.type).toBe('object');
    });

    test('registered tools carry the required private policy contract', () => {
        for (const tool of registry().values()) {
            expect(tool).toHaveProperty('inputSchema');
            expect(tool).toHaveProperty('outputSchema');
            expect(tool).toHaveProperty('requiredScopes');
            expect(tool).toHaveProperty('requiresSkillConfirmation');
            expect(tool).toHaveProperty('rateLimit');
            expect(tool).toHaveProperty('riskLevel');
            expect(tool).toHaveProperty('auditRedaction');
            expect(Array.isArray(tool.auditRedaction)).toBe(true);
        }
    });

    test('dashboard magic links require admin-scoped MCP keys', () => {
        const tool = registry().get('create_dashboard_magic_link');
        expect(tool.requiredScopes).toEqual(['mcp:admin']);
        expect(tool.rateLimit.map(rule => rule.scope)).toContain('key');
    });

    test('dashboard magic link tool returns a visible URL in text content', async () => {
        const originalPublicBaseUrl = process.env.PUBLIC_DASHBOARD_BASE_URL;
        process.env.PUBLIC_DASHBOARD_BASE_URL = 'https://dashboard.example.com';
        const pool = { query: async () => ({ rows: [] }) };
        const tool = createMcpToolRegistry({
            pool,
            getDashboardPayload: async () => ({}),
            startRefreshJob: () => ({ status: 'started' }),
            assertSemanticMemoryAvailable: () => undefined
        }).get('create_dashboard_magic_link');

        try {
            const output = await tool.handler({
                pool,
                session: { session_id: 's1' },
                apiKey: { name: 'admin-key', scopes: ['mcp:admin'] },
                arguments: {}
            });

            expect(output.structuredContent.url.startsWith('https://dashboard.example.com/auth/magic?token=')).toBe(true);
            expect(output.content?.[0]?.text).toContain(output.structuredContent.url);
            expect(output.content?.[0]?.text).toContain(output.structuredContent.expires_at);
            expect(output.resultSummary).toBe('Dashboard magic link created.');
            expect(output.resultSummary).not.toContain(output.structuredContent.url);
        } finally {
            if (originalPublicBaseUrl === undefined) {
                delete process.env.PUBLIC_DASHBOARD_BASE_URL;
            } else {
                process.env.PUBLIC_DASHBOARD_BASE_URL = originalPublicBaseUrl;
            }
        }
    });

    test('learning summary exposes only recommendation-eligible high-confidence priors', async () => {
        const queries = [];
        const pool = {
            query: async sql => {
                const text = String(sql);
                queries.push(text);
                if (text.includes('low_confidence_outcome_count')) {
                    return { rows: [{ low_confidence_outcome_count: '3', under_sampled_high_confidence_strategy_count: '2' }] };
                }
                if (text.includes('ORDER BY detected_at DESC')) return { rows: [] };
                return {
                    rows: [{
                        strategy_id: 'WASTED_SPEND_NEGATIVE',
                        wins: '5',
                        losses: '1',
                        sample_count: '6',
                        success_rate: '0.8333',
                        prior_confidence: 'medium',
                        last_evaluated_at: '2026-07-01T00:00:00.000Z'
                    }]
                };
            }
        };
        const tool = createMcpToolRegistry({
            pool,
            getDashboardPayload: async () => ({}),
            startRefreshJob: () => ({ status: 'started' }),
            assertSemanticMemoryAvailable: () => undefined
        }).get('get_learning_summary');

        const output = await tool.handler({
            pool,
            session: { session_id: 's1' },
            apiKey: { name: 'key', scopes: ['mcp:read'] },
            arguments: {}
        });

        expect(queries.join('\n')).not.toContain('strategy_success_rates');
        expect(output.structuredContent.priors).toHaveLength(1);
        expect(output.structuredContent.priors[0]).not.toHaveProperty('alpha');
        expect(output.structuredContent.priors[0]).not.toHaveProperty('beta');
        expect(output.structuredContent.learningPolicy).toMatchObject({
            priorsSource: 'impact_tracking_high_confidence_only',
            minHighConfidenceSamples: 5,
            lowConfidenceOutcomesExcluded: true,
            legacyAlphaBetaPriorsExposed: false
        });
        expect(output.structuredContent.learningPolicy.withheld).toEqual({
            lowConfidenceOutcomeCount: 3,
            underSampledHighConfidenceStrategyCount: 2
        });
    });

    test('legacy alpha/beta learning state is not created or updated', () => {
        const proposals = fs.readFileSync(path.join(root, 'lib', 'proposals.ts'), 'utf8');
        const evaluator = fs.readFileSync(path.join(root, 'scripts', 'impact_evaluator.ts'), 'utf8');
        expect(proposals).not.toContain('CREATE TABLE IF NOT EXISTS strategy_success_rates');
        expect(evaluator).not.toContain('strategy_success_rates');
        expect(evaluator).not.toContain('interim_vote_14');
        expect(evaluator).not.toContain('vote_column');
        expect(evaluator).not.toContain('vote_weight');
    });

    test('session initialization rejects malformed or missing sessions', async () => {
        expect(isMcpSessionId('00000000-0000-4000-8000-000000000001')).toBe(true);
        expect(isMcpSessionId('not-a-session-id')).toBe(false);

        const pool = { query: async () => ({ rows: [] }) };
        await expect(markMcpSessionInitialized(pool, '00000000-0000-4000-8000-000000000001', { name: 'key' }))
            .rejects.toThrow(/not initialized/);
    });

    test('reinitializing an existing session clears stale skill confirmation', async () => {
        let sql = '';
        const pool = {
            query: async (query, params) => {
                sql = String(query);
                return {
                    rows: [{
                        session_id: params[0],
                        api_key_name: params[1],
                        protocol_version: MCP_PROTOCOL_VERSION,
                        client_name: null,
                        initialized: false,
                        skill_name: null,
                        skill_confirmed_at: null,
                        expires_at: new Date(Date.now() + 3600000).toISOString()
                    }]
                };
            }
        };

        await initializeMcpSession(pool, {
            sessionId: '00000000-0000-4000-8000-000000000001',
            apiKey: { name: 'key', scopes: ['mcp:read'] }
        });

        expect(sql).toContain('skill_name = NULL');
        expect(sql).toContain('skill_confirmed_at = NULL');
    });
});
