import type { Pool } from 'pg';
import { getAccessToken, getAccessibleCustomer, listAccessibleCustomers, getResourceMetadata, executeGaqlDetailed } from '../googleAds';
import { createDashboardMagicLink } from '../dashboardAuth';
import {
    createDashboardUser,
    disableDashboardUser,
    enableDashboardUser,
    listDashboardUsers,
    resendDashboardUserInvitation,
    revokeDashboardUserSessions
} from '../dashboardUsers';
import { dashboardKnownSections, dashboardSectionRoute } from '../dashboardPayload';
import { getCandidateSignalsPayload, getCompactDecisionContext, getProposalContext } from '../mcpDashboardContext';
import { generateKeywordHistoricalMetrics, generateKeywordIdeas, KeywordPlannerValidationError, type KeywordPlannerOptions, uniqueKeywords } from '../googleKeywordPlanner';
import {
    createProposalFeedback,
    listProposalFeedback,
    recordProposalDecision,
    updateProposalFeedbackStatus,
    upsertProposal
} from '../proposals';
import {
    confirmGoogleAdsMutation,
    listRecentGoogleAdsMutations,
    previewGoogleAdsMutation
} from '../googleAdsMutations';
import { getOfflineConversionsBasicAuthStatus } from '../offlineConversionsAuth';
import {
    createMemory,
    deactivateMemory,
    linkMemoryException,
    searchMemories,
    SEMANTIC_MEMORY_MCP_TOOLS,
    storeMemoryEmbedding
} from '../semanticMemory';
import { googleAdsApiVersion } from '../googleAdsClient';
import { invalidParams } from './jsonRpc';
import { confirmGoogleAdsSkill } from './policy';
import { markMcpSkillConfirmed } from './session';
import {
    MCP_PROTOCOL_VERSION,
    type JsonSchema,
    type McpRateLimitRule,
    type McpRiskLevel,
    type McpScope,
    type McpToolContext,
    type McpToolDefinition,
    type McpToolHandlerResult,
    type McpToolListPage
} from './types';

const EMPTY_OBJECT_INPUT: JsonSchema = { type: 'object', properties: {} };
const ANY_OBJECT: JsonSchema = { type: 'object', additionalProperties: true };
const ANY_ARRAY: JsonSchema = { type: 'array', items: ANY_OBJECT };
const STRING_SCHEMA: JsonSchema = { type: 'string' };
const NUMBER_SCHEMA: JsonSchema = { type: 'number' };
const BOOLEAN_SCHEMA: JsonSchema = { type: 'boolean' };
const NULLABLE_STRING_SCHEMA: JsonSchema = { type: ['string', 'null'] };
const TEXT_ARRAY_SCHEMA: JsonSchema = { type: 'array', items: STRING_SCHEMA };

function outputObjectSchema(properties: Record<string, any>, required: string[] = Object.keys(properties), additionalProperties = false): JsonSchema {
    return { type: 'object', properties, required, additionalProperties };
}

function outputArraySchema(items: JsonSchema = ANY_OBJECT): JsonSchema {
    return { type: 'array', items };
}

function wrappedOutputSchema(name: string, schema: JsonSchema): JsonSchema {
    return outputObjectSchema({ [name]: schema }, [name]);
}

const MESSAGE_OUTPUT = outputObjectSchema({ message: STRING_SCHEMA }, ['message']);
const CONFIRM_SKILL_OUTPUT = outputObjectSchema({
    ok: BOOLEAN_SCHEMA,
    message: STRING_SCHEMA,
    protocolVersion: STRING_SCHEMA
});
const RAW_GAQL_OUTPUT = outputObjectSchema({
    rows: ANY_ARRAY,
    rowCount: NUMBER_SCHEMA,
    truncated: BOOLEAN_SCHEMA,
    requestId: NULLABLE_STRING_SCHEMA,
    apiVersion: STRING_SCHEMA,
    warnings: TEXT_ARRAY_SCHEMA
});
const ACCESSIBLE_CUSTOMERS_OUTPUT = outputObjectSchema({
    resourceNames: { type: 'array', items: STRING_SCHEMA }
}, ['resourceNames'], true);
const METADATA_OUTPUT = outputObjectSchema({
    metadata: ANY_ARRAY,
    apiVersion: STRING_SCHEMA
});
const DASHBOARD_DATA_OUTPUT = {
    type: 'object',
    properties: {
        decisionContext: ANY_OBJECT,
        candidateSignals: outputArraySchema(ANY_OBJECT),
        proposalContext: ANY_OBJECT
    },
    additionalProperties: true
} as JsonSchema;
const DECISION_CONTEXT_OUTPUT = outputObjectSchema({
    meta: ANY_OBJECT,
    summary: ANY_OBJECT,
    periodComparison: { anyOf: [ANY_OBJECT, { type: 'null' }] },
    decisionContext: ANY_OBJECT,
    sourceCoverage: ANY_OBJECT,
    campaigns: ANY_ARRAY,
    adGroups: ANY_ARRAY,
    leadAttribution: { anyOf: [ANY_OBJECT, { type: 'null' }] },
    keywordPlanner: { anyOf: [ANY_OBJECT, { type: 'null' }] },
    rankSupport: ANY_OBJECT,
    auctionInsightsStatus: ANY_ARRAY,
    candidateSignals: ANY_ARRAY,
    sections: TEXT_ARRAY_SCHEMA
});
const PROPOSAL_CONTEXT_OUTPUT = outputObjectSchema({
    meta: ANY_OBJECT,
    summary: ANY_OBJECT,
    sourceCoverage: ANY_OBJECT,
    leadAttribution: { anyOf: [ANY_OBJECT, { type: 'null' }] },
    keywordPlanner: { anyOf: [ANY_OBJECT, { type: 'null' }] },
    decisionContext: ANY_OBJECT,
    adGroups: ANY_ARRAY
});
const MAGIC_LINK_OUTPUT = outputObjectSchema({
    url: STRING_SCHEMA,
    expires_at: STRING_SCHEMA
});
const DASHBOARD_USER_OUTPUT = outputObjectSchema({
    id: STRING_SCHEMA,
    email: STRING_SCHEMA,
    emailNormalized: STRING_SCHEMA,
    name: STRING_SCHEMA,
    status: STRING_SCHEMA,
    invitedAt: { type: ['string', 'null'] },
    activatedAt: { type: ['string', 'null'] },
    lastLoginAt: { type: ['string', 'null'] },
    createdAt: STRING_SCHEMA,
    updatedAt: STRING_SCHEMA
});
const DASHBOARD_USER_WRAPPED_OUTPUT = wrappedOutputSchema('user', DASHBOARD_USER_OUTPUT);
const MUTATION_PREVIEW_OUTPUT = outputObjectSchema({
    mutationId: STRING_SCHEMA,
    confirmationToken: STRING_SCHEMA,
    expiresAt: STRING_SCHEMA,
    diff: ANY_ARRAY,
    warnings: TEXT_ARRAY_SCHEMA,
    operationsSummary: ANY_OBJECT
});
const MUTATION_CONFIRM_OUTPUT = outputObjectSchema({
    mutationId: STRING_SCHEMA,
    status: STRING_SCHEMA,
    googleRequestId: NULLABLE_STRING_SCHEMA,
    results: ANY_ARRAY,
    preview: ANY_OBJECT,
    refresh: ANY_OBJECT
});
const OFFLINE_CONVERSIONS_STATUS_OUTPUT = outputObjectSchema({
    endpoint: STRING_SCHEMA,
    basicAuthConfigured: BOOLEAN_SCHEMA,
    credentialSource: STRING_SCHEMA,
    username: { type: ['string', 'null'] },
    updatedAt: { type: ['string', 'null'] },
    passwordRevealAvailable: BOOLEAN_SCHEMA,
    passwordDisplayed: BOOLEAN_SCHEMA
});
const LEARNING_SUMMARY_OUTPUT = outputObjectSchema({
    priors: ANY_ARRAY,
    learningPolicy: outputObjectSchema({
        priorsSource: STRING_SCHEMA,
        minHighConfidenceSamples: NUMBER_SCHEMA,
        lowConfidenceOutcomesExcluded: BOOLEAN_SCHEMA,
        legacyAlphaBetaPriorsExposed: BOOLEAN_SCHEMA,
        withheld: ANY_OBJECT
    }),
    impactTracking: ANY_ARRAY
});
const REFRESH_OUTPUT = outputObjectSchema({
    status: STRING_SCHEMA,
    message: STRING_SCHEMA,
    runId: { type: ['string', 'null'] },
    skipped: { type: ['boolean', 'null'] },
    nextAllowedAt: { type: ['string', 'null'] },
    cooldownRemainingMs: { type: ['number', 'null'] }
}, ['status', 'message']);

const RATE = {
    read: [{ scope: 'session', windowSeconds: 60, max: 120 }] as McpRateLimitRule[],
    proposalContext: [{ scope: 'session', windowSeconds: 60, max: 20 }] as McpRateLimitRule[],
    rawGaql: [
        { scope: 'session', windowSeconds: 60, max: 10 },
        { scope: 'key', windowSeconds: 3600, max: 100 }
    ] as McpRateLimitRule[],
    refresh: [{ scope: 'key', windowSeconds: 3600, max: 3 }] as McpRateLimitRule[],
    mutationPreview: [{ scope: 'key', windowSeconds: 3600, max: 20 }] as McpRateLimitRule[],
    mutationConfirm: [{ scope: 'key', windowSeconds: 3600, max: 10 }] as McpRateLimitRule[],
    admin: [{ scope: 'key', windowSeconds: 3600, max: 5 }] as McpRateLimitRule[]
};

export interface McpToolDependencies {
    pool: Pool;
    getDashboardPayload: (rawFilters?: Record<string, any>) => Promise<any>;
    startRefreshJob: (options?: { startDate?: any; endDate?: any; force?: boolean; source?: string }) => any;
    assertSemanticMemoryAvailable: () => void;
}

function result(structuredContent: any, summary?: string, googleRequestId?: string | null): McpToolHandlerResult {
    return {
        structuredContent,
        content: summary ? [{ type: 'text', text: summary }] : [],
        resultSummary: summary || summarize(structuredContent),
        googleRequestId: googleRequestId || null
    };
}

function summarize(value: any): string {
    if (Array.isArray(value)) return `${value.length} row(s)`;
    if (value && typeof value === 'object') {
        const keys = Object.keys(value);
        return keys.length ? `object:${keys.slice(0, 6).join(',')}` : 'empty object';
    }
    return String(value ?? '');
}

function tool(input: Omit<McpToolDefinition, 'outputSchema' | 'annotations' | 'auditRedaction'> & {
    outputSchema?: JsonSchema;
    annotations?: Record<string, any>;
    auditRedaction?: string[];
}): McpToolDefinition {
    return {
        ...input,
        auditRedaction: input.auditRedaction || [],
        outputSchema: input.outputSchema || ANY_OBJECT,
        annotations: input.annotations || {
            readOnlyHint: ['read', 'expensive_read', 'raw_external_query'].includes(input.riskLevel),
            destructiveHint: ['mutation_confirm', 'admin_destructive'].includes(input.riskLevel),
            openWorldHint: input.riskLevel === 'raw_external_query'
        }
    };
}

function objectSchema(properties: Record<string, any>, required: string[] = []): JsonSchema {
    return { type: 'object', properties, required };
}

function plannerOptionsFromBody(body: any): KeywordPlannerOptions {
    const keywords = Array.isArray(body?.keywords)
        ? uniqueKeywords(body.keywords)
        : typeof body?.keywords === 'string'
            ? uniqueKeywords(body.keywords.split('\n').flatMap((line: string) => line.split(',')))
            : [];
    const geoTargetConstants = Array.isArray(body?.geoTargetConstants)
        ? body.geoTargetConstants.map((item: any) => String(item)).filter(Boolean)
        : typeof body?.geoTargetConstants === 'string'
            ? body.geoTargetConstants.split(',').map((item: string) => item.trim()).filter(Boolean)
            : undefined;
    return {
        keywords,
        url: typeof body?.url === 'string' ? body.url : undefined,
        site: typeof body?.site === 'string' ? body.site : undefined,
        language: typeof body?.language === 'string' ? body.language : undefined,
        geoTargetConstants,
        keywordPlanNetwork: typeof body?.keywordPlanNetwork === 'string' ? body.keywordPlanNetwork : undefined,
        includeAdultKeywords: body?.includeAdultKeywords === true,
        pageSize: body?.pageSize == null ? undefined : Number(body.pageSize)
    };
}

function normalizeMetadataResource(value: any): string | null {
    if (value === undefined || value === null || value === '') return null;
    const text = String(value).trim();
    if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(text)) {
        throw invalidParams('Invalid resource format. Use a Google Ads resource or field path such as campaign or campaign.id.');
    }
    if (text.length > 120) throw invalidParams('Invalid resource format. Resource must be 120 characters or fewer.');
    return text;
}

export function normalizeRawGaql(args: any): { query: string; maxRows: number; warnings: string[] } {
    const query = String(args?.query || '').replace(/\s+/g, ' ').trim();
    if (!query) throw invalidParams('query is required.');
    if (!/^SELECT\s/i.test(query)) throw invalidParams('Only SELECT GAQL queries are allowed.');
    if (/\bSELECT\s+\*/i.test(query)) throw invalidParams('SELECT * is not allowed. Select only required fields.');
    if (!/\bLIMIT\s+\d+\b/i.test(query)) throw invalidParams('Raw GAQL requires an explicit LIMIT.');
    const rawMaxRows = args?.maxRows === undefined || args?.maxRows === null || args?.maxRows === '' ? 1000 : Number(args.maxRows);
    if (!Number.isFinite(rawMaxRows) || rawMaxRows <= 0) throw invalidParams('maxRows must be a positive number.');
    const maxRows = Math.max(1, Math.min(Math.floor(rawMaxRows), 10000));
    const limitMatch = query.match(/\bLIMIT\s+(\d+)\b/i);
    const limit = limitMatch ? Number(limitMatch[1]) : maxRows;
    if (!Number.isSafeInteger(limit) || limit <= 0) throw invalidParams('Raw GAQL LIMIT must be a positive safe integer.');
    const warnings: string[] = [];
    let normalized = query;
    if (limit > maxRows) {
        normalized = query.replace(/\bLIMIT\s+\d+\b/i, `LIMIT ${maxRows}`);
        warnings.push(`LIMIT reduced from ${limit} to maxRows ${maxRows}.`);
    }
    const hasMetrics = /\bmetrics\./i.test(query);
    const hasDateFilter = /\bsegments\.date\s*(?:BETWEEN|DURING|>=|>|<=|<|=)\s+/i.test(query);
    if (hasMetrics && !hasDateFilter) throw invalidParams('Metric GAQL queries require an explicit segments.date filter.');
    const segmentCount = (query.match(/\bsegments\./gi) || []).length;
    const hasNarrowScope = /\b(?:campaign\.id|ad_group\.id|ad_group_criterion\.criterion_id)\s*=/i.test(query);
    if (segmentCount > 4 && !hasNarrowScope) {
        throw invalidParams('Raw GAQL query has too many segments without a campaign/ad group/criterion scope.');
    }
    return { query: normalized, maxRows, warnings };
}

function validateRequired(inputSchema: JsonSchema, args: Record<string, any>): void {
    const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
    for (const field of required) {
        if (args[field] === undefined || args[field] === null || args[field] === '') {
            throw invalidParams(`${field} is required.`);
        }
    }
}

function baseTool(input: {
    name: string;
    title?: string;
    description: string;
    inputSchema?: JsonSchema;
    requiredScopes?: McpScope[];
    requiresSkillConfirmation?: boolean;
    rateLimit?: McpRateLimitRule[];
    riskLevel?: McpRiskLevel;
    auditRedaction?: string[];
    outputSchema?: JsonSchema;
    handler: (context: McpToolContext) => Promise<McpToolHandlerResult>;
}): McpToolDefinition {
    const riskLevel = input.riskLevel || 'read';
    const defaultRate = riskLevel === 'expensive_read' ? RATE.proposalContext : RATE.read;
    return tool({
        name: input.name,
        title: input.title || input.name,
        description: input.description,
        inputSchema: input.inputSchema || EMPTY_OBJECT_INPUT,
        requiredScopes: input.requiredScopes || ['mcp:read'],
        requiresSkillConfirmation: input.requiresSkillConfirmation !== false,
        rateLimit: input.rateLimit || defaultRate,
        riskLevel,
        auditRedaction: input.auditRedaction || [],
        outputSchema: input.outputSchema,
        handler: input.handler
    });
}

export function createMcpToolRegistry(deps: McpToolDependencies): Map<string, McpToolDefinition> {
    const tools: McpToolDefinition[] = [
        baseTool({
            name: 'confirm_google_ads_skill',
            title: 'Confirm Google Ads Skill',
            description: 'Mandatory first call for LLM agents. Confirms that the saas-google-ads-dashboard-analyst skill is installed and loaded for this MCP session.',
            inputSchema: objectSchema({
                skillName: { type: 'string' },
                installed: { type: 'boolean' },
                loaded: { type: 'boolean' }
            }, ['skillName', 'installed', 'loaded']),
            requiresSkillConfirmation: false,
            outputSchema: CONFIRM_SKILL_OUTPUT,
            handler: async context => {
                const confirmation = confirmGoogleAdsSkill(context.arguments);
                if (confirmation.ok) await markMcpSkillConfirmed(context.pool, context.session.session_id, context.apiKey);
                return result({ ...confirmation, protocolVersion: MCP_PROTOCOL_VERSION }, confirmation.message);
            }
        }),
        baseTool({
            name: 'search_search',
            title: 'Run Bounded GAQL',
            description: 'Executes a bounded raw GAQL query against the Google Ads API.',
            inputSchema: objectSchema({
                query: { type: 'string' },
                maxRows: { type: 'number' }
            }, ['query']),
            requiredScopes: ['mcp:raw_gaql'],
            rateLimit: RATE.rawGaql,
            riskLevel: 'raw_external_query',
            outputSchema: RAW_GAQL_OUTPUT,
            handler: async context => {
                const normalized = normalizeRawGaql(context.arguments);
                const token = await getAccessToken();
                const customerId = await getAccessibleCustomer(token);
                const data = await executeGaqlDetailed(token, customerId, normalized.query, { maxRows: normalized.maxRows });
                return result({
                    rows: data.rows,
                    rowCount: data.rowCount,
                    truncated: data.truncated,
                    requestId: data.requestId,
                    apiVersion: data.apiVersion,
                    warnings: normalized.warnings
                }, `Returned ${data.rowCount} GAQL row(s).`, data.requestId);
            }
        }),
        baseTool({
            name: 'customers_list_accessible_customers',
            description: 'Lists accessible Google Ads customers for access debugging.',
            outputSchema: ACCESSIBLE_CUSTOMERS_OUTPUT,
            handler: async () => {
                const token = await getAccessToken();
                return result(await listAccessibleCustomers(token));
            }
        }),
        baseTool({
            name: 'metadata_get_resource_metadata',
            description: 'Describes Google Ads resource schemas for building bounded GAQL queries.',
            inputSchema: objectSchema({ resource: { type: 'string' } }),
            outputSchema: METADATA_OUTPUT,
            handler: async context => {
                const token = await getAccessToken();
                const resource = normalizeMetadataResource(context.arguments?.resource);
                let query = 'SELECT name, category, selectable, filterable, sortable, selectable_with, data_type, is_repeated, enum_values';
                query += resource ? ` WHERE name = '${resource}' OR name LIKE '${resource}.%'` : ' LIMIT 100';
                return result({ metadata: await getResourceMetadata(token, query), apiVersion: googleAdsApiVersion() });
            }
        }),
        baseTool({
            name: 'get_dashboard_data',
            description: 'Returns compact decision context by default, or one bounded dashboard section/view when requested.',
            inputSchema: objectSchema({
                section: { type: 'string' },
                view: { type: 'string' },
                customerId: { type: 'string' },
                dateRangePreset: { type: 'string' },
                startDate: { type: 'string' },
                endDate: { type: 'string' },
                campaignId: { type: 'string' },
                adGroupId: { type: 'string' },
                limit: { type: 'number' },
                topSearchTerms: { type: 'number' },
                topSignals: { type: 'number' },
                maxAdGroups: { type: 'number' }
            }),
            riskLevel: 'expensive_read',
            outputSchema: DASHBOARD_DATA_OUTPUT,
            handler: async context => {
                const section = String(context.arguments?.section || '').trim();
                if (section) {
                    const route = dashboardSectionRoute(section);
                    if (!route) throw invalidParams(`Unknown dashboard section: ${section}`, { availableSections: dashboardKnownSections() });
                    if (route.mode === 'decision_context') return result({ decisionContext: await getCompactDecisionContext(context.pool, context.arguments) });
                    if (route.mode === 'candidate_signals') return result({ candidateSignals: await getCandidateSignalsPayload(context.pool, context.arguments) });
                    if (route.mode === 'proposal_context') return result({ proposalContext: await getProposalContext(context.pool, context.arguments) });
                    const dashboardData = await deps.getDashboardPayload({ ...context.arguments, view: route.mode });
                    if (!route.section) return result(dashboardData);
                    if (!Object.prototype.hasOwnProperty.call(dashboardData, route.section)) {
                        throw invalidParams(`Dashboard section ${route.section} was not returned by ${route.mode} view.`);
                    }
                    return result({ [route.section]: dashboardData[route.section] });
                }
                if (String(context.arguments?.view || '').trim()) return result(await deps.getDashboardPayload(context.arguments));
                return result(await getCompactDecisionContext(context.pool, context.arguments));
            }
        }),
        baseTool({
            name: 'get_decision_context',
            description: 'Returns compact decision-ready context for selected dashboard filters.',
            inputSchema: objectSchema({ dateRangePreset: { type: 'string' }, startDate: { type: 'string' }, endDate: { type: 'string' }, campaignId: { type: 'string' }, adGroupId: { type: 'string' } }),
            riskLevel: 'expensive_read',
            outputSchema: DECISION_CONTEXT_OUTPUT,
            handler: async context => result(await getCompactDecisionContext(context.pool, context.arguments))
        }),
        baseTool({
            name: 'get_proposal_context',
            description: 'Returns bounded enabled-ad-group proposal evidence without loading the full dashboard payload.',
            inputSchema: objectSchema({ dateRangePreset: { type: 'string' }, startDate: { type: 'string' }, endDate: { type: 'string' }, campaignId: { type: 'string' }, adGroupId: { type: 'string' }, topSearchTerms: { type: 'number' }, topSignals: { type: 'number' }, maxAdGroups: { type: 'number' } }),
            riskLevel: 'expensive_read',
            rateLimit: RATE.proposalContext,
            outputSchema: PROPOSAL_CONTEXT_OUTPUT,
            handler: async context => result(await getProposalContext(context.pool, context.arguments))
        }),
        baseTool({
            name: 'create_dashboard_magic_link',
            description: 'Creates a dashboard-only magic link when explicitly requested.',
            inputSchema: objectSchema({ ttl_minutes: { type: 'number' }, session_minutes: { type: 'number' }, reason: { type: 'string' }, redirect_path: { type: 'string' } }),
            requiredScopes: ['mcp:admin'],
            rateLimit: RATE.admin,
            outputSchema: MAGIC_LINK_OUTPUT,
            handler: async context => {
                const magicLink = await createDashboardMagicLink(context.pool, { ...context.arguments, created_by: context.arguments?.created_by || 'mcp' }, context.request);
                return {
                    structuredContent: magicLink,
                    content: [{ type: 'text', text: `Dashboard magic link: ${magicLink.url}\nExpires at: ${magicLink.expires_at}` }],
                    resultSummary: 'Dashboard magic link created.',
                    googleRequestId: null
                };
            }
        }),
        baseTool({
            name: 'create_dashboard_user',
            description: 'Creates an invited named dashboard admin and sends a setup email.',
            inputSchema: objectSchema({ email: { type: 'string' }, name: { type: 'string' } }, ['email', 'name']),
            requiredScopes: ['mcp:admin'],
            rateLimit: RATE.admin,
            riskLevel: 'admin_destructive',
            outputSchema: DASHBOARD_USER_WRAPPED_OUTPUT,
            handler: async context => {
                const created = await createDashboardUser(context.pool, {
                    email: context.arguments?.email,
                    name: context.arguments?.name,
                    createdBy: context.apiKey.name
                });
                return result({ user: created.user }, 'Dashboard user invitation sent.');
            }
        }),
        baseTool({
            name: 'list_dashboard_users',
            description: 'Lists named dashboard admins without exposing password hashes or tokens.',
            inputSchema: objectSchema({ status: { type: 'string' } }),
            requiredScopes: ['mcp:admin'],
            rateLimit: RATE.admin,
            riskLevel: 'expensive_read',
            outputSchema: wrappedOutputSchema('users', outputArraySchema(DASHBOARD_USER_OUTPUT)),
            handler: async context => result({
                users: await listDashboardUsers(context.pool, { status: context.arguments?.status })
            })
        }),
        baseTool({
            name: 'resend_dashboard_user_invitation',
            description: 'Invalidates unused prior invite tokens and sends a fresh dashboard invitation.',
            inputSchema: objectSchema({ user_id: { type: 'string' } }, ['user_id']),
            requiredScopes: ['mcp:admin'],
            rateLimit: RATE.admin,
            riskLevel: 'admin_destructive',
            outputSchema: DASHBOARD_USER_WRAPPED_OUTPUT,
            handler: async context => {
                const resent = await resendDashboardUserInvitation(context.pool, {
                    userId: context.arguments?.user_id,
                    createdBy: context.apiKey.name
                });
                return result({ user: resent.user }, 'Dashboard user invitation resent.');
            }
        }),
        baseTool({
            name: 'disable_dashboard_user',
            description: 'Disables a named dashboard admin and revokes active sessions and push subscriptions.',
            inputSchema: objectSchema({ user_id: { type: 'string' } }, ['user_id']),
            requiredScopes: ['mcp:admin'],
            rateLimit: RATE.admin,
            riskLevel: 'admin_destructive',
            outputSchema: DASHBOARD_USER_WRAPPED_OUTPUT,
            handler: async context => result({
                user: await disableDashboardUser(context.pool, { userId: context.arguments?.user_id })
            }, 'Dashboard user disabled.')
        }),
        baseTool({
            name: 'enable_dashboard_user',
            description: 'Enables a named dashboard admin. Users without a password return to invited status.',
            inputSchema: objectSchema({ user_id: { type: 'string' } }, ['user_id']),
            requiredScopes: ['mcp:admin'],
            rateLimit: RATE.admin,
            riskLevel: 'admin_destructive',
            outputSchema: DASHBOARD_USER_WRAPPED_OUTPUT,
            handler: async context => result({
                user: await enableDashboardUser(context.pool, { userId: context.arguments?.user_id })
            }, 'Dashboard user enabled.')
        }),
        baseTool({
            name: 'revoke_dashboard_user_sessions',
            description: 'Revokes active dashboard sessions for a named dashboard admin without disabling the user.',
            inputSchema: objectSchema({ user_id: { type: 'string' } }, ['user_id']),
            requiredScopes: ['mcp:admin'],
            rateLimit: RATE.admin,
            riskLevel: 'admin_destructive',
            outputSchema: outputObjectSchema({ user: DASHBOARD_USER_OUTPUT, revokedSessions: NUMBER_SCHEMA }),
            handler: async context => result(
                await revokeDashboardUserSessions(context.pool, { userId: context.arguments?.user_id }),
                'Dashboard user sessions revoked.'
            )
        }),
        baseTool({
            name: 'keyword_planner_generate_ideas',
            description: 'Generates read-only Keyword Planner ideas from seed keywords, URL, or site.',
            inputSchema: objectSchema({ keywords: { type: 'array', items: { type: 'string' } }, url: { type: 'string' }, site: { type: 'string' }, language: { type: 'string' }, geoTargetConstants: { type: 'array', items: { type: 'string' } }, keywordPlanNetwork: { type: 'string' } }),
            riskLevel: 'expensive_read',
            outputSchema: wrappedOutputSchema('ideas', ANY_ARRAY),
            handler: async context => {
                const token = await getAccessToken();
                const customerId = await getAccessibleCustomer(token);
                return result({ ideas: await generateKeywordIdeas(token, customerId, plannerOptionsFromBody(context.arguments)) });
            }
        }),
        baseTool({
            name: 'keyword_planner_historical_metrics',
            description: 'Fetches Keyword Planner historical metrics for explicit keywords.',
            inputSchema: objectSchema({ keywords: { type: 'array', items: { type: 'string' } }, language: { type: 'string' }, geoTargetConstants: { type: 'array', items: { type: 'string' } }, keywordPlanNetwork: { type: 'string' } }, ['keywords']),
            riskLevel: 'expensive_read',
            outputSchema: wrappedOutputSchema('historicalMetrics', ANY_ARRAY),
            handler: async context => {
                const options = plannerOptionsFromBody(context.arguments);
                if (!options.keywords?.length) throw new KeywordPlannerValidationError('keywords must include at least one keyword for historical metrics.');
                const token = await getAccessToken();
                const customerId = await getAccessibleCustomer(token);
                return result({ historicalMetrics: await generateKeywordHistoricalMetrics(token, customerId, options) });
            }
        }),
        baseTool({
            name: 'google_ads_preview_keyword_changes',
            description: 'Previews Google Ads keyword or negative keyword mutations; does not execute changes.',
            inputSchema: objectSchema({ customerId: { type: 'string' }, negative: { type: 'boolean' }, reason: { type: 'string' }, changes: { type: 'array', items: { type: 'object' } } }, ['changes']),
            requiredScopes: ['mcp:mutate_preview'],
            rateLimit: RATE.mutationPreview,
            riskLevel: 'mutation_preview',
            outputSchema: MUTATION_PREVIEW_OUTPUT,
            handler: async context => result(await previewGoogleAdsMutation(context.pool, {
                mutationType: context.arguments?.negative ? 'negative_keyword_changes' : 'keyword_changes',
                customerId: context.arguments?.customerId,
                changes: context.arguments?.changes,
                reason: context.arguments?.reason,
                requestedBy: 'mcp',
                source: 'mcp'
            }), 'Mutation preview created.')
        }),
        baseTool({
            name: 'google_ads_preview_ad_schedule_changes',
            description: 'Previews campaign ad schedule create/remove/replace mutations; does not execute changes.',
            inputSchema: objectSchema({ customerId: { type: 'string' }, reason: { type: 'string' }, changes: { type: 'array', items: { type: 'object' } } }, ['changes']),
            requiredScopes: ['mcp:mutate_preview'],
            rateLimit: RATE.mutationPreview,
            riskLevel: 'mutation_preview',
            outputSchema: MUTATION_PREVIEW_OUTPUT,
            handler: async context => result(await previewGoogleAdsMutation(context.pool, {
                mutationType: 'ad_schedule_changes',
                customerId: context.arguments?.customerId,
                changes: context.arguments?.changes,
                reason: context.arguments?.reason,
                requestedBy: 'mcp',
                source: 'mcp'
            }), 'Mutation preview created.')
        }),
        baseTool({
            name: 'google_ads_preview_audience_changes',
            description: 'Previews Google Ads audience segment, exclusion, targeting mode, bid modifier, demographic, or custom audience changes; does not execute changes.',
            inputSchema: objectSchema({ customerId: { type: 'string' }, reason: { type: 'string' }, changes: { type: 'array', items: { type: 'object' } } }, ['changes']),
            requiredScopes: ['mcp:mutate_preview'],
            rateLimit: RATE.mutationPreview,
            riskLevel: 'mutation_preview',
            outputSchema: MUTATION_PREVIEW_OUTPUT,
            handler: async context => result(await previewGoogleAdsMutation(context.pool, {
                mutationType: 'audience_changes',
                customerId: context.arguments?.customerId,
                changes: context.arguments?.changes,
                reason: context.arguments?.reason,
                requestedBy: 'mcp',
                source: 'mcp'
            }), 'Audience mutation preview created.')
        }),
        baseTool({
            name: 'google_ads_preview_entity_status_changes',
            description: 'Previews campaign or ad-group pause/resume mutations; does not execute changes.',
            inputSchema: objectSchema({ customerId: { type: 'string' }, reason: { type: 'string' }, changes: { type: 'array', items: { type: 'object' } } }, ['changes']),
            requiredScopes: ['mcp:mutate_preview'],
            rateLimit: RATE.mutationPreview,
            riskLevel: 'mutation_preview',
            outputSchema: MUTATION_PREVIEW_OUTPUT,
            handler: async context => result(await previewGoogleAdsMutation(context.pool, {
                mutationType: 'entity_status_changes',
                customerId: context.arguments?.customerId,
                changes: context.arguments?.changes,
                reason: context.arguments?.reason,
                requestedBy: 'mcp',
                source: 'mcp'
            }), 'Mutation preview created.')
        }),
        baseTool({
            name: 'google_ads_confirm_mutation',
            description: 'Executes a previously previewed Google Ads mutation with its confirmation token.',
            inputSchema: objectSchema({ mutationId: { type: 'string' }, confirmationToken: { type: 'string' } }, ['mutationId', 'confirmationToken']),
            requiredScopes: ['mcp:mutate_confirm'],
            rateLimit: RATE.mutationConfirm,
            riskLevel: 'mutation_confirm',
            auditRedaction: ['confirmationToken'],
            outputSchema: MUTATION_CONFIRM_OUTPUT,
            handler: async context => result({
                ...(await confirmGoogleAdsMutation(context.pool, {
                    mutationId: context.arguments?.mutationId,
                    confirmationToken: context.arguments?.confirmationToken
                })),
                refresh: await deps.startRefreshJob({ force: true, source: 'google_ads_mutation_confirm_mcp' })
            }, 'Mutation executed.')
        }),
        baseTool({
            name: 'google_ads_get_mutation_history',
            description: 'Returns recent executed Google Ads mutation audit rows.',
            inputSchema: objectSchema({ customerId: { type: 'string' }, limit: { type: 'number' } }),
            outputSchema: wrappedOutputSchema('mutations', ANY_ARRAY),
            handler: async context => result({ mutations: await listRecentGoogleAdsMutations(context.pool, { customerId: context.arguments?.customerId, limit: context.arguments?.limit }) })
        }),
        baseTool({
            name: 'offline_conversions_endpoint_status',
            description: 'Reports whether the Basic Auth offline conversion pull endpoint is configured without revealing the password.',
            outputSchema: OFFLINE_CONVERSIONS_STATUS_OUTPUT,
            handler: async context => {
                const auth = await getOfflineConversionsBasicAuthStatus(context.pool);
                return result({
                    endpoint: '/api/analytics/offline-conversions.csv',
                    basicAuthConfigured: auth.configured,
                    credentialSource: 'database',
                    username: auth.username,
                    updatedAt: auth.updatedAt,
                    passwordRevealAvailable: auth.passwordRevealAvailable,
                    passwordDisplayed: false
                });
            }
        }),
        baseTool({
            name: 'create_proposal',
            description: 'Creates or updates a debated proposal card with observable verification specs.',
            inputSchema: objectSchema({ proposal: { type: 'object' } }, ['proposal']),
            requiredScopes: ['mcp:proposal'],
            riskLevel: 'write_proposal',
            outputSchema: outputObjectSchema({ message: STRING_SCHEMA, proposal: ANY_OBJECT }),
            handler: async context => result({ message: 'Proposal created successfully.', proposal: await upsertProposal(context.pool, context.arguments?.proposal) }, 'Proposal created.')
        }),
        baseTool({
            name: 'record_proposal_decision',
            description: 'Records a user decision for a proposal without mutating Google Ads.',
            inputSchema: objectSchema({ proposal_id: { type: 'string' }, action: { type: 'string' }, selected_option_id: { type: ['string', 'null'] } }, ['proposal_id', 'action']),
            requiredScopes: ['mcp:proposal'],
            riskLevel: 'write_proposal',
            outputSchema: outputObjectSchema({
                proposal_id: STRING_SCHEMA,
                status: STRING_SCHEMA,
                selected_option_id: { type: ['string', 'null'] },
                options: ANY_ARRAY
            }, ['proposal_id', 'status', 'options'], true),
            handler: async context => result(await recordProposalDecision(context.pool, {
                proposalId: context.arguments?.proposal_id,
                action: context.arguments?.action,
                selectedOptionId: context.arguments?.selected_option_id
            }), 'Proposal decision recorded.')
        }),
        baseTool({
            name: 'create_proposal_feedback',
            description: 'Stores raw user feedback/comment on a proposal.',
            inputSchema: objectSchema({ proposal_id: { type: 'string' }, option_id: { type: ['string', 'null'] }, feedback_type: { type: 'string' }, comment: { type: 'string' }, customer_id: { type: ['string', 'null'] }, created_by: { type: ['string', 'null'] } }, ['proposal_id', 'comment']),
            requiredScopes: ['mcp:proposal'],
            riskLevel: 'write_proposal',
            outputSchema: wrappedOutputSchema('feedback', ANY_OBJECT),
            handler: async context => result({
                feedback: await createProposalFeedback(context.pool, {
                    proposalId: context.arguments?.proposal_id,
                    optionId: context.arguments?.option_id,
                    feedbackType: context.arguments?.feedback_type,
                    comment: context.arguments?.comment,
                    customerId: context.arguments?.customer_id,
                    createdBy: context.arguments?.created_by
                })
            }, 'Proposal feedback stored.')
        }),
        baseTool({
            name: 'list_proposal_feedback',
            description: 'Lists raw/reviewed proposal feedback.',
            inputSchema: objectSchema({ proposal_id: { type: ['string', 'null'] }, customer_id: { type: ['string', 'null'] }, status: { type: ['string', 'null'] }, limit: { type: ['number', 'null'] } }),
            outputSchema: wrappedOutputSchema('feedback', ANY_ARRAY),
            handler: async context => result({ feedback: await listProposalFeedback(context.pool, context.arguments) })
        }),
        baseTool({
            name: 'update_proposal_feedback_status',
            description: 'Marks proposal feedback reviewed, ignored, or converted_to_memory.',
            inputSchema: objectSchema({ feedback_id: { type: 'string' }, status: { type: 'string' }, related_memory_id: { type: ['string', 'null'] }, reviewed_by: { type: ['string', 'null'] }, reviewer_note: { type: ['string', 'null'] } }, ['feedback_id', 'status']),
            requiredScopes: ['mcp:proposal'],
            riskLevel: 'write_proposal',
            outputSchema: wrappedOutputSchema('feedback', ANY_OBJECT),
            handler: async context => result({
                feedback: await updateProposalFeedbackStatus(context.pool, {
                    feedbackId: context.arguments?.feedback_id,
                    status: context.arguments?.status,
                    relatedMemoryId: context.arguments?.related_memory_id,
                    reviewedBy: context.arguments?.reviewed_by,
                    reviewerNote: context.arguments?.reviewer_note
                })
            }, 'Proposal feedback updated.')
        }),
        baseTool({
            name: 'get_candidate_signals',
            description: 'Returns deterministic candidate signals from the DB warehouse for selected filters.',
            inputSchema: objectSchema({ dateRangePreset: { type: 'string' }, startDate: { type: 'string' }, endDate: { type: 'string' }, campaignId: { type: 'string' }, adGroupId: { type: 'string' }, limit: { type: 'number' } }),
            riskLevel: 'expensive_read',
            outputSchema: wrappedOutputSchema('candidateSignals', ANY_ARRAY),
            handler: async context => result({ candidateSignals: await getCandidateSignalsPayload(context.pool, context.arguments) })
        }),
        baseTool({
            name: 'get_learning_summary',
            description: 'Returns recommendation-eligible high-confidence strategy priors and active impact tracking rows.',
            outputSchema: LEARNING_SUMMARY_OUTPUT,
            handler: async context => {
                const [priors, withheld, impact] = await Promise.all([
                    context.pool.query(`
                        WITH resolved_outcomes AS (
                            SELECT strategy_id,
                                   COALESCE(outcome_30, outcome_14) AS outcome,
                                   COALESCE(outcome_details_30, outcome_details_14) AS outcome_details,
                                   detected_at
                            FROM impact_tracking
                            WHERE strategy_id IS NOT NULL
                              AND COALESCE(outcome_30, outcome_14) IN ('success_high_confidence', 'failure_high_confidence')
                        ),
                        high_confidence_counts AS (
                            SELECT strategy_id,
                                   COUNT(*) FILTER (WHERE outcome = 'success_high_confidence') AS wins,
                                   COUNT(*) FILTER (WHERE outcome = 'failure_high_confidence') AS losses,
                                   COUNT(*) AS sample_count,
                                   MAX(detected_at) AS last_evaluated_at
                            FROM resolved_outcomes
                            GROUP BY strategy_id
                        )
                        SELECT strategy_id,
                               wins,
                               losses,
                               sample_count,
                               ROUND((wins::numeric / NULLIF(sample_count, 0)), 4) AS success_rate,
                               CASE WHEN sample_count >= 20 THEN 'high' ELSE 'medium' END AS prior_confidence,
                               last_evaluated_at
                        FROM high_confidence_counts
                        WHERE sample_count >= 5
                        ORDER BY sample_count DESC, last_evaluated_at DESC
                        LIMIT 100
                    `),
                    context.pool.query(`
                        WITH resolved_outcomes AS (
                            SELECT strategy_id,
                                   COALESCE(outcome_30, outcome_14) AS outcome
                            FROM impact_tracking
                            WHERE strategy_id IS NOT NULL
                              AND COALESCE(outcome_30, outcome_14) IS NOT NULL
                        ),
                        high_confidence_counts AS (
                            SELECT strategy_id, COUNT(*) AS sample_count
                            FROM resolved_outcomes
                            WHERE outcome IN ('success_high_confidence', 'failure_high_confidence')
                            GROUP BY strategy_id
                        )
                        SELECT
                            COUNT(*) FILTER (WHERE outcome IN ('success_low_confidence', 'failure_low_confidence')) AS low_confidence_outcome_count,
                            (SELECT COUNT(*) FROM high_confidence_counts WHERE sample_count < 5) AS under_sampled_high_confidence_strategy_count
                        FROM resolved_outcomes
                    `),
                    context.pool.query(`SELECT proposal_id, option_id, strategy_id, tracking_status, detected_at, outcome_14, outcome_30, lead_outcome_14, lead_outcome_30, outcome_details_14, outcome_details_30 FROM impact_tracking ORDER BY detected_at DESC LIMIT 100`)
                ]);
                const withheldRow = withheld.rows[0] || {};
                return result({
                    priors: priors.rows,
                    learningPolicy: {
                        priorsSource: 'impact_tracking_high_confidence_only',
                        minHighConfidenceSamples: 5,
                        lowConfidenceOutcomesExcluded: true,
                        legacyAlphaBetaPriorsExposed: false,
                        withheld: {
                            lowConfidenceOutcomeCount: Number(withheldRow.low_confidence_outcome_count || 0),
                            underSampledHighConfidenceStrategyCount: Number(withheldRow.under_sampled_high_confidence_strategy_count || 0)
                        }
                    },
                    impactTracking: impact.rows
                });
            }
        }),
        ...semanticMemoryTools(deps),
        baseTool({
            name: 'create_diagnosis',
            description: 'Creates or updates an AI diagnosis card on the dashboard.',
            inputSchema: objectSchema({ diagnosis: { type: 'object' } }, ['diagnosis']),
            requiredScopes: ['mcp:proposal'],
            riskLevel: 'write_proposal',
            outputSchema: outputObjectSchema({ message: STRING_SCHEMA, diagnosis: ANY_OBJECT }),
            handler: async context => {
                const diagnosis = context.arguments?.diagnosis;
                if (!diagnosis?.id) throw invalidParams('Missing diagnosis.id');
                await context.pool.query(
                    `INSERT INTO ai_diagnoses (diagnosis_id, payload) VALUES ($1, $2)
                     ON CONFLICT (diagnosis_id) DO UPDATE SET payload = EXCLUDED.payload`,
                    [diagnosis.id, diagnosis]
                );
                return result({ message: 'Diagnosis created successfully.', diagnosis }, 'Diagnosis created.');
            }
        }),
        baseTool({
            name: 'clear_proposals',
            description: 'Clears all existing proposals from the dashboard.',
            requiredScopes: ['mcp:admin'],
            rateLimit: RATE.admin,
            riskLevel: 'admin_destructive',
            outputSchema: MESSAGE_OUTPUT,
            handler: async context => {
                await context.pool.query(`TRUNCATE TABLE proposals CASCADE`);
                return result({ message: 'All proposals cleared successfully.' }, 'All proposals cleared.');
            }
        }),
        baseTool({
            name: 'clear_diagnoses',
            description: 'Clears all existing AI diagnoses from the dashboard.',
            requiredScopes: ['mcp:admin'],
            rateLimit: RATE.admin,
            riskLevel: 'admin_destructive',
            outputSchema: MESSAGE_OUTPUT,
            handler: async context => {
                await context.pool.query(`TRUNCATE TABLE ai_diagnoses`);
                return result({ message: 'All AI diagnoses cleared successfully.' }, 'All diagnoses cleared.');
            }
        }),
        baseTool({
            name: 'trigger_refresh',
            description: 'Triggers an asynchronous background refresh/backfill of stored Google Ads warehouse data.',
            inputSchema: objectSchema({ startDate: { type: 'string' }, endDate: { type: 'string' }, force: { type: 'boolean' } }),
            requiredScopes: ['mcp:refresh'],
            rateLimit: RATE.refresh,
            riskLevel: 'refresh',
            outputSchema: REFRESH_OUTPUT,
            handler: async context => result(await deps.startRefreshJob({
                startDate: context.arguments?.startDate,
                endDate: context.arguments?.endDate,
                force: context.arguments?.force !== false,
                source: 'mcp'
            }), 'Refresh request accepted.')
        })
    ];
    return new Map(tools.map(item => [item.name, item]));
}

function semanticMemoryTools(deps: McpToolDependencies): McpToolDefinition[] {
    return SEMANTIC_MEMORY_MCP_TOOLS.map((definition: any) => baseTool({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
        requiredScopes: definition.name === 'search_memories' ? ['mcp:read'] : ['mcp:proposal'],
        riskLevel: definition.name === 'search_memories' ? 'expensive_read' : 'write_proposal',
        outputSchema: semanticMemoryOutputSchema(definition.name),
        handler: async context => {
            deps.assertSemanticMemoryAvailable();
            if (definition.name === 'create_memory') return result({ memory: await createMemory(context.pool, context.arguments) }, 'Memory created.');
            if (definition.name === 'store_memory_embedding') return result({ embedding: await storeMemoryEmbedding(context.pool, context.arguments) }, 'Memory embedding stored.');
            if (definition.name === 'search_memories') return result(await searchMemories(context.pool, context.arguments));
            if (definition.name === 'deactivate_memory') return result({ memory: await deactivateMemory(context.pool, context.arguments) }, 'Memory deactivated.');
            if (definition.name === 'link_memory_exception') return result({ memory: await linkMemoryException(context.pool, context.arguments) }, 'Memory exception linked.');
            throw invalidParams(`Unsupported semantic memory tool: ${definition.name}`);
        }
    }));
}

function semanticMemoryOutputSchema(name: string): JsonSchema {
    if (name === 'search_memories') {
        return outputObjectSchema({
            memories: ANY_ARRAY,
            query: { type: ['string', 'null'] },
            scopes: ANY_OBJECT,
            limit: NUMBER_SCHEMA
        }, ['memories'], true);
    }
    if (name === 'store_memory_embedding') return wrappedOutputSchema('embedding', ANY_OBJECT);
    return wrappedOutputSchema('memory', ANY_OBJECT);
}

export function mcpToolsPage(registry: Map<string, McpToolDefinition>, cursor?: string | null, pageSize = 50): McpToolListPage {
    let offset = 0;
    if (cursor) {
        try {
            const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
            offset = Math.max(0, Math.floor(Number(parsed.offset || 0)));
        } catch {
            throw invalidParams('Invalid tools/list cursor.');
        }
    }
    const definitions = Array.from(registry.values()).sort((a, b) => a.name.localeCompare(b.name));
    const page = definitions.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return {
        tools: page.map(({ handler, requiredScopes, requiresSkillConfirmation, rateLimit, riskLevel, auditRedaction, ...publicDef }) => publicDef),
        nextCursor: nextOffset < definitions.length
            ? Buffer.from(JSON.stringify({ offset: nextOffset }), 'utf8').toString('base64url')
            : undefined
    };
}

export function validateToolArguments(tool: McpToolDefinition, args: Record<string, any>): void {
    validateRequired(tool.inputSchema, args || {});
}
