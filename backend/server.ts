import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import compression from 'compression';
import crypto from 'crypto';
import path from 'path';
import * as fs from 'fs';
import { Pool } from 'pg';
import { createPoolConfig, type DashboardPoolConfig } from './lib/dbConfig';
import { getAccessToken, getAccessibleCustomer, executeGaql, getResourceMetadata, listAccessibleCustomers } from './lib/googleAds';
import {
    createProposalFeedback,
    listProposalFeedback,
    ProposalValidationError,
    recordProposalDecision,
    updateProposalFeedbackStatus,
    upsertProposal
} from './lib/proposals';
import { buildAuctionInsightsEntities, getAuctionInsightsSettings, upsertAuctionInsightsSettings } from './lib/auctionInsights';
import { exportLeadReviewCsv, exportOfflineConversionsCsv, getLeadSessionByKey, LeadValidationError, recordLeadStatus, upsertLeadWebhookEvent } from './lib/leads';
import { getOfflineConversionsBasicAuthStatus, revealOfflineConversionsBasicAuthPassword, upsertOfflineConversionsBasicAuth, verifyOfflineConversionsBasicAuth } from './lib/offlineConversionsAuth';
import { generateKeywordHistoricalMetrics, generateKeywordIdeas, KeywordPlannerValidationError, type KeywordPlannerOptions, uniqueKeywords } from './lib/googleKeywordPlanner';
import {
    authenticateAdminBearer,
    authenticateDashboardAccess,
    authenticateDashboardOrAdminAccess,
    consumeDashboardMagicLink,
    createDashboardMagicLink,
    renderMagicLanding,
    requireDashboardPageSession,
    isLocalDashboardOrigin,
    setAuthNoStoreHeaders,
    clearDashboardSessionCookie,
    clearDashboardCsrfCookie,
    clearDashboardOfflineBlockCookie,
    clearDashboardLogoutPendingCookie,
    clearDashboardMagicTokenCookie,
    createNamedDashboardSession,
    authenticateDashboardSession,
    dashboardAuthContext,
    requireDashboardCsrf,
    isSameOriginDashboardRequest,
    revokeDashboardSession,
    readDashboardMagicTokenCookie,
    setDashboardCsrfResponseCookie,
    setDashboardOfflineBlockCookie,
    setDashboardMagicTokenCookie,
    setDashboardSessionCookie
} from './lib/dashboardAuth';
import {
    authenticateDashboardUser,
    consumeDashboardPasswordToken,
    DashboardAuthRateLimitError,
    DashboardUserValidationError,
    inspectDashboardPasswordToken,
    requestDashboardPasswordReset
} from './lib/dashboardUsers';
import {
    DashboardPushValidationError,
    PostgresPushDeliveryWorker,
    dashboardPushConfig,
    pushAvailability,
    pushSubscriptionStatus,
    revokePushSubscription,
    upsertPushSubscription
} from './lib/dashboardPush';
import {
    getUserPreferences,
    setUserPreference,
    setUserPreferences,
    UserPreferenceValidationError
} from './lib/userPreferences';
import {
    createMemory,
    deactivateMemory,
    linkMemoryException,
    searchMemories,
    SemanticMemoryConfigurationError,
    SemanticMemoryConflictError,
    SemanticMemoryNotFoundError,
    SemanticMemoryValidationError,
    SEMANTIC_MEMORY_MCP_TOOLS,
    storeMemoryEmbedding
} from './lib/semanticMemory';
import {
    clearAdsWarehouseRuntimeCaches,
    completeWarehouseRefreshRun,
    getAvailableDashboardFilters,
    upsertWarehouseRefreshRunStarted,
    type WarehouseRefreshKind
} from './lib/adsWarehouse';
import {
    buildDashboardPayloadForView,
    clearDashboardViewPayloadCache,
    dashboardAccountStartDate,
    dashboardKnownSections,
    dashboardSectionRoute,
    DashboardPayloadValidationError,
    resolveDashboardFilters,
    WarehouseDataNotFoundError
} from './lib/dashboardPayload';
import {
    getKeywordsOverviewWidget,
    getSearchTermsOverviewWidget,
    OverviewWidgetValidationError
} from './lib/overviewWidgets';
import { getCandidateSignalsPayload, getCompactDecisionContext, getProposalContext } from './lib/mcpDashboardContext';
import {
    confirmGoogleAdsMutation,
    getAccountControlsState,
    GoogleAdsMutationValidationError,
    listRecentGoogleAdsMutations,
    preflightGoogleAdsKeywordMutation,
    previewGoogleAdsMutation
} from './lib/googleAdsMutations';
import { configureGoogleAdsQuotaGovernor } from './lib/googleAdsQuota';
import { recordMcpToolAudit } from './lib/mcp/audit';
import { invalidParams, jsonRpcError, jsonRpcSuccess, methodNotFound, notInitialized, requireJsonRpcRequest } from './lib/mcp/jsonRpc';
import { assertMcpApiKeysConfiguredForProduction, requireMcpToolPolicy, resolveMcpApiKey } from './lib/mcp/policy';
import { checkMcpRateLimits } from './lib/mcp/rateLimit';
import { ensureMcpCoreSchema, initializeMcpSession, isMcpSessionId, loadInitializedMcpSession, markMcpSessionInitialized, newMcpSessionId } from './lib/mcp/session';
import { createMcpToolRegistry, mcpToolsPage, validateToolArguments } from './lib/mcp/toolRegistry';
import {
    MCP_SERVER_CAPABILITIES,
    MCP_SERVER_INFO,
    MCP_SERVER_INSTRUCTIONS,
    negotiateMcpProtocolVersion,
    unsupportedMcpProtocolMessage
} from './lib/mcp/types';
import { runSchemaMigrations } from './lib/migrations';
import {
    enqueueRefreshJob,
    PostgresRefreshQueueWorker,
    type RefreshQueueJob
} from './lib/refreshQueue';
import { resolveTriggerRefreshRequest, shouldRunCronCooldownLightRefresh } from './lib/triggerRefresh';

const app = express();
assertMcpApiKeysConfiguredForProduction();

function dashboardTrustProxySetting(): boolean | number | string {
    const raw = String(process.env.DASHBOARD_TRUST_PROXY || '').trim();
    if (!raw || raw.toLowerCase() === 'false') return false;
    if (raw.toLowerCase() === 'true') return true;
    if (/^\d+$/.test(raw)) return Number(raw);
    return raw;
}

app.set('trust proxy', dashboardTrustProxySetting());
const PORT = process.env.PORT || 7860;
const DEFAULT_DASHBOARD_DB_TIMEOUT_MS = 15000;
const configuredDashboardDbTimeoutMs = Number(process.env.DASHBOARD_DB_TIMEOUT_MS || DEFAULT_DASHBOARD_DB_TIMEOUT_MS);
const dashboardDbTimeoutMs = Number.isFinite(configuredDashboardDbTimeoutMs) && configuredDashboardDbTimeoutMs > 0
    ? configuredDashboardDbTimeoutMs
    : DEFAULT_DASHBOARD_DB_TIMEOUT_MS;
const DEFAULT_DASHBOARD_DB_POOL_MAX = 4;
const configuredDashboardDbPoolMax = Number(process.env.DASHBOARD_DB_POOL_MAX || DEFAULT_DASHBOARD_DB_POOL_MAX);
const dashboardDbPoolMax = Number.isFinite(configuredDashboardDbPoolMax) && configuredDashboardDbPoolMax > 0
    ? Math.floor(configuredDashboardDbPoolMax)
    : DEFAULT_DASHBOARD_DB_POOL_MAX;
const DEFAULT_DASHBOARD_DB_IDLE_TIMEOUT_MS = 10000;
const configuredDashboardDbIdleTimeoutMs = Number(process.env.DASHBOARD_DB_IDLE_TIMEOUT_MS || DEFAULT_DASHBOARD_DB_IDLE_TIMEOUT_MS);
const dashboardDbIdleTimeoutMs = Number.isFinite(configuredDashboardDbIdleTimeoutMs) && configuredDashboardDbIdleTimeoutMs >= 0
    ? Math.floor(configuredDashboardDbIdleTimeoutMs)
    : DEFAULT_DASHBOARD_DB_IDLE_TIMEOUT_MS;
const DEFAULT_HTTP_COMPRESSION_THRESHOLD_BYTES = 1024;
const configuredHttpCompressionThresholdBytes = Number(process.env.HTTP_COMPRESSION_THRESHOLD_BYTES || DEFAULT_HTTP_COMPRESSION_THRESHOLD_BYTES);
const httpCompressionThresholdBytes = Number.isFinite(configuredHttpCompressionThresholdBytes) && configuredHttpCompressionThresholdBytes >= 0
    ? configuredHttpCompressionThresholdBytes
    : DEFAULT_HTTP_COMPRESSION_THRESHOLD_BYTES;
const httpBodyLimit = process.env.HTTP_BODY_LIMIT || '1mb';
const DEFAULT_TRIGGER_REFRESH_MIN_INTERVAL_MINUTES = 360;
const configuredTriggerRefreshMinIntervalMinutes = Number(process.env.TRIGGER_REFRESH_MIN_INTERVAL_MINUTES || DEFAULT_TRIGGER_REFRESH_MIN_INTERVAL_MINUTES);
const triggerRefreshMinIntervalMs = Number.isFinite(configuredTriggerRefreshMinIntervalMinutes) && configuredTriggerRefreshMinIntervalMinutes >= 0
    ? configuredTriggerRefreshMinIntervalMinutes * 60 * 1000
    : DEFAULT_TRIGGER_REFRESH_MIN_INTERVAL_MINUTES * 60 * 1000;
const DEFAULT_REFRESH_JOB_TIMEOUT_MS = 15 * 60 * 1000;
const CLIENT_TODAY_REFRESH_SOURCE = 'dashboard_client_today';
const CRON_REFRESH_SOURCE = 'cron';
const CRON_COOLDOWN_TODAY_REFRESH_SOURCE = 'cron_cooldown_today';
const LIGHT_TODAY_REFRESH_SOURCES = [CLIENT_TODAY_REFRESH_SOURCE, CRON_COOLDOWN_TODAY_REFRESH_SOURCE];
const configuredRefreshJobTimeoutMs = Number(process.env.REFRESH_JOB_TIMEOUT_MS || DEFAULT_REFRESH_JOB_TIMEOUT_MS);
const refreshJobTimeoutMs = Number.isFinite(configuredRefreshJobTimeoutMs) && configuredRefreshJobTimeoutMs > 0
    ? Math.floor(configuredRefreshJobTimeoutMs)
    : DEFAULT_REFRESH_JOB_TIMEOUT_MS;
const serveDashboardClient = process.env.SERVE_DASHBOARD_CLIENT === 'true';
const dashboardClientPath = path.join(__dirname, 'client');

function warnForContentBlockerProneDashboardHost(): void {
    const configured = String(process.env.PUBLIC_DASHBOARD_BASE_URL || '').trim();
    if (!configured) return;
    try {
        const hostname = new URL(configured).hostname.toLowerCase();
        const firstLabel = hostname.split('.')[0];
        if (!['ad', 'ads', 'analytics', 'tracking', 'tracker'].includes(firstLabel)) return;
        console.warn('dashboard_public_hostname_content_blocker_risk', {
            hostname,
            recommendation: 'Use a neutral hostname such as dashboard.example.com before PWA rollout.'
        });
    } catch {
        // Existing public URL validation reports malformed values when the URL is used.
    }
}

warnForContentBlockerProneDashboardHost();

function configuredCorsOrigins(): Set<string> {
    const origins = new Set<string>();
    const publicBase = process.env.PUBLIC_DASHBOARD_BASE_URL;
    if (publicBase) {
        try {
            origins.add(new URL(publicBase).origin);
        } catch {
            // createDashboardMagicLink validates this value when it is used.
        }
    }
    for (const raw of String(process.env.DASHBOARD_CORS_ORIGINS || '').split(',')) {
        const origin = raw.trim().replace(/\/+$/, '');
        if (origin) origins.add(origin);
    }
    return origins;
}

function isAllowedCorsOrigin(origin: string | undefined): boolean {
    if (!origin) return true;
    if (isLocalDashboardOrigin(origin)) return true;
    return configuredCorsOrigins().has(origin.replace(/\/+$/, ''));
}

function normalizeRefreshDate(value: any, field: 'startDate' | 'endDate'): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const text = String(value).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`Invalid ${field} format: ${text}`);
    const [year, month, day] = text.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        throw new Error(`Invalid ${field}: ${text}`);
    }
    return text;
}

function normalizeBoolean(value: any): boolean {
    if (value === true) return true;
    if (value === false || value === undefined || value === null || value === '') return false;
    const text = String(value).trim().toLowerCase();
    return ['1', 'true', 'yes', 'y', 'force'].includes(text);
}

function normalizeMetadataResource(value: any): string | null {
    if (value === undefined || value === null || value === '') return null;
    const text = String(value).trim();
    if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(text)) {
        throw new Error('Invalid resource format. Use a Google Ads resource or field path such as campaign or campaign.id.');
    }
    if (text.length > 120) throw new Error('Invalid resource format. Resource must be 120 characters or fewer.');
    return text;
}

type RefreshJobResult = {
    status: 'started' | 'in_progress' | 'skipped';
    message: string;
    runId?: string;
    skipped?: boolean;
    nextAllowedAt?: string;
    cooldownRemainingMs?: number;
};

let refreshQueueWorker: PostgresRefreshQueueWorker | null = null;
let pushDeliveryWorker: PostgresPushDeliveryWorker | null = null;
let startupRefreshChild: ReturnType<typeof Bun.spawn> | null = null;
let httpServer: ReturnType<typeof app.listen> | null = null;
let shuttingDown = false;

function envSwitchEnabled(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    return !['0', 'false', 'no', 'off', 'skip'].includes(String(raw).trim().toLowerCase());
}

type RefreshProcessError = Error & {
    exitCode?: number | null;
    timeout?: boolean;
    spawnFailed?: boolean;
    warehouseStatus?: string | null;
};

function clearRefreshRuntimeState(): void {
    clearDashboardViewPayloadCache();
    clearAdsWarehouseRuntimeCaches();
}

function refreshFailureSourceSummary(job: RefreshQueueJob, error: RefreshProcessError): Record<string, any> {
    return {
        source: job.source || 'queue',
        queue: 'postgres',
        attempts: job.attempts,
        timeout: error.timeout === true || undefined,
        spawnFailed: error.spawnFailed === true || undefined,
        exitCode: error.exitCode ?? undefined,
        warehouseStatus: error.warehouseStatus ?? undefined
    };
}

async function assertQueuedWarehouseRunCompleted(job: RefreshQueueJob): Promise<void> {
    const { rows } = await pool.query(
        `SELECT status, error
         FROM google_ads_refresh_runs
         WHERE id = $1`,
        [job.id]
    );
    const run = rows[0];
    const status = run?.status ? String(run.status) : null;
    if (status === 'succeeded' || status === 'partial') return;
    const message = status === 'failed'
        ? `Background refresh completed with failed warehouse status${run?.error ? `: ${run.error}` : '.'}`
        : `Background refresh exited before completing warehouse run ${job.id}.`;
    throw Object.assign(new Error(message), { warehouseStatus: status });
}

async function markQueuedRefreshFailed(job: RefreshQueueJob, error: Error): Promise<void> {
    clearRefreshRuntimeState();
    const processError = error as RefreshProcessError;
    await completeWarehouseRefreshRun(pool, job.id, {
        status: 'failed',
        sourceSummary: refreshFailureSourceSummary(job, processError),
        error: error.message
    }).catch(err => console.error('Failed to mark queued refresh run failed:', err?.message || err));
}

async function runQueuedWarehouseRefresh(job: RefreshQueueJob): Promise<void> {
    const args = ['bun', 'run', 'scripts/refresh_google_ads_data.ts', '--run-id', job.id];
    if (job.source && LIGHT_TODAY_REFRESH_SOURCES.includes(job.source)) args.push('--light-client-refresh');
    if (job.requestedStartDate) args.push('--start-date', job.requestedStartDate);
    if (job.requestedEndDate) {
        args.push('--end-date', job.requestedEndDate);
        args.push('--date', job.requestedEndDate);
    }

    await new Promise<void>((resolve, reject) => {
        let settled = false;
        let proc: ReturnType<typeof Bun.spawn> | null = null;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const finish = (err?: RefreshProcessError) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            clearRefreshRuntimeState();
            if (err) reject(err);
            else resolve();
        };
        timeout = setTimeout(() => {
            const err = Object.assign(new Error(`Refresh job timed out after ${Math.round(refreshJobTimeoutMs / 60000)} minutes.`), {
                timeout: true
            });
            console.error(`Refresh job ${job.id} timed out after ${refreshJobTimeoutMs}ms. Killing process.`);
            try {
                proc?.kill('SIGKILL');
            } catch {
                // Process may already be gone.
            }
            finish(err);
        }, refreshJobTimeoutMs);

        try {
            proc = Bun.spawn(args, {
                cwd: __dirname,
                stdout: 'inherit',
                stderr: 'inherit'
            });
            proc.exited.then(exitCode => {
                if (exitCode === 0) {
                    assertQueuedWarehouseRunCompleted(job)
                        .then(() => finish())
                        .catch(err => finish(err instanceof Error ? err as RefreshProcessError : new Error(String(err))));
                    return;
                }
                finish(Object.assign(new Error(`Background refresh exited with code ${exitCode}`), { exitCode }));
            }).catch(err => {
                finish(Object.assign(new Error(err?.message || String(err)), { spawnFailed: true }));
            });
        } catch (err: any) {
            finish(Object.assign(new Error(err?.message || String(err)), { spawnFailed: true }));
        }
    });
}

async function startRefreshJob(options: {
    startDate?: any;
    endDate?: any;
    force?: boolean;
    source?: string;
    kind?: WarehouseRefreshKind;
} = {}): Promise<RefreshJobResult> {
    const normalizedStartDate = normalizeRefreshDate(options.startDate, 'startDate');
    const normalizedEndDate = normalizeRefreshDate(options.endDate, 'endDate');
    if (normalizedStartDate && normalizedEndDate && normalizedStartDate > normalizedEndDate) {
        throw new Error('startDate must be before or equal to endDate.');
    }
    const isRepairWindow = options.kind
        ? options.kind === 'repair'
        : Boolean(normalizedStartDate || normalizedEndDate);
    const refreshKind = options.kind || (isRepairWindow ? 'repair' : 'manual');
    const running = await pool.query(
        `SELECT id, started_at
         FROM google_ads_refresh_runs
         WHERE status = 'running'
           AND started_at > now() - INTERVAL '2 hours'
         ORDER BY started_at DESC
         LIMIT 1`
    );
    if (running.rows[0]) {
        return {
            status: 'in_progress',
            runId: running.rows[0].id,
            message: 'Refresh already in progress according to the database.'
        };
    }

    const bypassCooldown = Boolean(options.force || isRepairWindow || triggerRefreshMinIntervalMs <= 0);
    if (!bypassCooldown) {
        const now = Date.now();
        const latest = options.source === CRON_REFRESH_SOURCE
            ? await pool.query(
                `SELECT run.id, run.started_at
                 FROM google_ads_refresh_runs AS run
                 LEFT JOIN google_ads_refresh_jobs AS job ON job.id = run.id
                 WHERE run.started_at IS NOT NULL
                   AND (job.source IS NULL OR job.source <> ALL($1::text[]))
                 ORDER BY run.started_at DESC
                 LIMIT 1`,
                [LIGHT_TODAY_REFRESH_SOURCES]
            )
            : await pool.query(
                `SELECT id, started_at
                 FROM google_ads_refresh_runs
                 WHERE started_at IS NOT NULL
                 ORDER BY started_at DESC
                 LIMIT 1`
            );
        const latestStartedAtMs = latest.rows[0]?.started_at ? new Date(latest.rows[0].started_at).getTime() : 0;
        const nextAllowedMs = latestStartedAtMs + triggerRefreshMinIntervalMs;
        if (latestStartedAtMs && now < nextAllowedMs) {
            return {
                status: 'skipped',
                runId: latest.rows[0].id,
                skipped: true,
                message: 'Refresh skipped because a recent refresh is still inside the trigger cooldown.',
                nextAllowedAt: new Date(nextAllowedMs).toISOString(),
                cooldownRemainingMs: nextAllowedMs - now
            };
        }
    }

    const runId = `warehouse_${crypto.randomUUID()}`;
    await upsertWarehouseRefreshRunStarted(pool, {
        id: runId,
        kind: refreshKind,
        requestedStartDate: normalizedStartDate || null,
        requestedEndDate: normalizedEndDate || null
    });

    try {
        await enqueueRefreshJob(pool, {
            id: runId,
            requestedStartDate: normalizedStartDate || null,
            requestedEndDate: normalizedEndDate || null,
            force: Boolean(options.force),
            source: options.source || 'api'
        });
        refreshQueueWorker?.poke();
    } catch (err: any) {
        await completeWarehouseRefreshRun(pool, runId, {
            status: 'failed',
            sourceSummary: { source: options.source || 'api', queue: 'postgres', enqueueFailed: true },
            error: err?.message || String(err)
        }).catch(() => undefined);
        throw err;
    }
    return { status: 'started', runId, message: 'Refresh job started in the background.' };
}

let semanticMemorySchemaError: string | null = 'Semantic memory schema has not finished initializing.';

app.use(compression({ threshold: httpCompressionThresholdBytes }));
app.use(cors({
    origin: (origin, callback) => {
        callback(null, isAllowedCorsOrigin(origin));
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Webhook-Secret', 'X-CSRF-Token'],
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 600
}));
app.use(express.json({ limit: httpBodyLimit }));
app.use(express.urlencoded({ extended: false, limit: httpBodyLimit }));

const poolConfig: DashboardPoolConfig = createPoolConfig({
    max: dashboardDbPoolMax,
    idleTimeoutMillis: dashboardDbIdleTimeoutMs,
    connectionTimeoutMillis: dashboardDbTimeoutMs,
    query_timeout: dashboardDbTimeoutMs,
    statement_timeout: dashboardDbTimeoutMs
});

const pool = new Pool(poolConfig);
configureGoogleAdsQuotaGovernor(pool);

async function shutdownServer(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
    if (shuttingDown) {
        process.exit(1);
        return;
    }
    shuttingDown = true;
    console.log('server_shutdown_started', { signal });
    startupRefreshChild?.kill(signal);
    refreshQueueWorker?.stop();
    pushDeliveryWorker?.stop();
    const closeHttp = new Promise<void>(resolve => {
        if (!httpServer) {
            resolve();
            return;
        }
        httpServer.close(() => resolve());
    });
    const timeout = new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 10_000);
        if (typeof (timer as any).unref === 'function') (timer as any).unref();
    });
    await Promise.race([closeHttp, timeout]);
    await pool.end().catch(() => undefined);
    process.exit(0);
}

process.once('SIGINT', () => void shutdownServer('SIGINT'));
process.once('SIGTERM', () => void shutdownServer('SIGTERM'));

pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL idle client error:', err.message);
});

refreshQueueWorker = new PostgresRefreshQueueWorker({
    pool,
    runJob: runQueuedWarehouseRefresh,
    onJobSuccess: () => clearRefreshRuntimeState(),
    onJobFailure: markQueuedRefreshFailed
});
pushDeliveryWorker = new PostgresPushDeliveryWorker({ pool });

app.get('/healthz', async (_req: Request, res: Response) => {
    try {
        await pool.query('SELECT 1');
        res.json({
            ok: true,
            deploymentMode: process.env.DEPLOYMENT_MODE || process.env.HOSTING_MODE || 'hf',
            database: 'reachable'
        });
    } catch (err: any) {
        res.status(503).json({
            ok: false,
            deploymentMode: process.env.DEPLOYMENT_MODE || process.env.HOSTING_MODE || 'hf',
            database: 'unreachable',
            error: process.env.NODE_ENV === 'production' ? 'Database unavailable.' : err?.message || String(err)
        });
    }
});

// Create table if it doesn't exist
async function initDB() {
    try {
        const migrationResult = await runSchemaMigrations(pool);
        const semanticMemoryFailure = migrationResult.optionalFailures.find(failure => failure.id === '202607050008_semantic_memory');
        semanticMemorySchemaError = semanticMemoryFailure?.error || null;
        await pushDeliveryWorker?.start();
        console.log('Schema migrations applied.');
        if (semanticMemoryFailure) console.warn('Semantic memory schema unavailable:', semanticMemoryFailure.error);
        console.log('Push delivery worker started.');
        console.log('Database initialized.');
    } catch (err) {
        console.error('Failed to initialize database:', err);
        semanticMemorySchemaError = err instanceof Error ? err.message : String(err);
        throw err;
    }
}

async function startBackgroundRefreshAfterServerIsHealthy(): Promise<void> {
    const orchestratedStartup = envSwitchEnabled('DASHBOARD_ORCHESTRATED_STARTUP', false);
    if (orchestratedStartup && envSwitchEnabled('STARTUP_REFRESH', true)) {
        console.log('[startup] startup refresh after server health');
        try {
            // Keep the direct startup refresh isolated from the PostgreSQL queue
            // worker. The worker starts only after this child exits, preventing two
            // refresh executors from competing while HTTP health stays available.
            startupRefreshChild = Bun.spawn(['bun', 'run', 'scripts/refresh_google_ads_data.ts', '--startup'], {
                cwd: __dirname,
                stdout: 'inherit',
                stderr: 'inherit'
            });
            let timedOut = false;
            let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
            const timeout = setTimeout(() => {
                timedOut = true;
                startupRefreshChild?.kill('SIGTERM');
                forceKillTimer = setTimeout(() => startupRefreshChild?.kill('SIGKILL'), 5_000);
            }, refreshJobTimeoutMs);
            const exitCode = await startupRefreshChild.exited;
            clearTimeout(timeout);
            if (forceKillTimer) clearTimeout(forceKillTimer);
            if (timedOut) {
                console.error('startup_refresh_timed_out', { timeoutMs: refreshJobTimeoutMs, exitCode });
            } else if (exitCode !== 0) {
                console.error('startup_refresh_failed', { exitCode });
            }
        } catch (err: any) {
            console.error('startup_refresh_failed', { error: err?.message || String(err) });
        } finally {
            startupRefreshChild = null;
        }
    } else if (orchestratedStartup) {
        console.log('[startup] STARTUP_REFRESH is disabled; skipping Google Ads refresh.');
    }

    if (shuttingDown) return;
    try {
        await refreshQueueWorker?.start();
        console.log('Refresh queue worker started.');
    } catch (err: any) {
        console.error('refresh_queue_worker_start_failed', { error: err?.message || String(err) });
    }
}

type DashboardTimingMetric = { name: string; durationMs: number };

function addDashboardTiming(timings: DashboardTimingMetric[] | undefined, name: string, durationMs: number): void {
    timings?.push({ name, durationMs });
}

async function timedDashboardPhase<T>(
    timings: DashboardTimingMetric[] | undefined,
    name: string,
    fn: () => Promise<T>
): Promise<T> {
    const start = Date.now();
    try {
        return await fn();
    } finally {
        addDashboardTiming(timings, name, Date.now() - start);
    }
}

function dashboardServerTimingHeader(timings: DashboardTimingMetric[]): string {
    return timings
        .map(metric => `${metric.name.replace(/[^a-zA-Z0-9_-]/g, '_')};dur=${Math.max(0, Math.round(metric.durationMs * 10) / 10)}`)
        .join(', ');
}

async function getDashboardPayload(rawFilters: Record<string, any> = {}, timings?: DashboardTimingMetric[]) {
    const filters = await timedDashboardPhase(timings, 'filters', () => resolveDashboardFilters(pool, rawFilters));
    return timedDashboardPhase(timings, 'dashboard_build', () =>
        buildDashboardPayloadForView(pool, filters, rawFilters.view, {
            filtersResolved: true,
            timings: (name, durationMs) => addDashboardTiming(timings, name, durationMs)
        })
    );
}

async function getDashboardFilterOptions(rawFilters: Record<string, any> = {}) {
    const filters = await resolveDashboardFilters(pool, rawFilters);
    const options = await getAvailableDashboardFilters(pool, filters.customerId);
    return { ...options, accountStartDate: dashboardAccountStartDate() };
}

function dashboardErrorStatus(err: any): number {
    if (err instanceof DashboardPayloadValidationError || err?.name === 'DashboardPayloadValidationError') return 400;
    if (err instanceof WarehouseDataNotFoundError || err?.name === 'WarehouseDataNotFoundError') return 404;
    return 500;
}

function dashboardErrorMessage(err: any): string {
    if (err instanceof WarehouseDataNotFoundError || err?.name === 'WarehouseDataNotFoundError') {
        return 'No warehouse data found. Run a backfill first.';
    }
    return err?.message || 'Database error';
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

async function runKeywordPlannerIdeas(body: any) {
    const options = plannerOptionsFromBody(body);
    const token = await getAccessToken();
    const customerId = await getAccessibleCustomer(token);
    return generateKeywordIdeas(token, customerId, options);
}

async function runKeywordPlannerHistoricalMetrics(body: any) {
    const options = plannerOptionsFromBody(body);
    if (!options.keywords || options.keywords.length === 0) {
        throw new KeywordPlannerValidationError('keywords must include at least one keyword for historical metrics.');
    }
    const token = await getAccessToken();
    const customerId = await getAccessibleCustomer(token);
    return generateKeywordHistoricalMetrics(token, customerId, options);
}

const authenticate = authenticateAdminBearer;
const authenticateDashboard = authenticateDashboardAccess({ pool });
const authenticateDashboardMutation = [authenticateDashboard, requireDashboardCsrf];
const authenticateRefreshMutation = [authenticateDashboardOrAdminAccess({ pool }), requireDashboardCsrf];
const requireDashboardPage = requireDashboardPageSession({ pool });

function clientIp(req: Request): string {
    return String(req.ip || req.socket?.remoteAddress || '').trim();
}

function routeParam(value: string | string[] | undefined): string {
    return Array.isArray(value) ? value[0] || '' : value || '';
}

function publicAuthToken(value: unknown): string {
    if (typeof value !== 'string') return '';
    const token = value.trim();
    return token.length >= 20 && token.length <= 200 ? token : '';
}

function authErrorStatus(err: any): number {
    if (err instanceof DashboardAuthRateLimitError || err?.name === 'DashboardAuthRateLimitError') return 429;
    if (err instanceof DashboardUserValidationError || err?.name === 'DashboardUserValidationError') return err.statusCode || 400;
    return 500;
}

function sendAuthError(res: Response, err: any): void {
    if (err instanceof DashboardAuthRateLimitError || err?.name === 'DashboardAuthRateLimitError') {
        res.setHeader('Retry-After', String(err.retryAfterSeconds || 60));
        res.status(429).json({ error: 'Too many attempts. Try again later.' });
        return;
    }
    const status = authErrorStatus(err);
    const message = status === 401 ? 'Invalid email or password.' : err?.message || 'Authentication failed.';
    res.status(status).json({ error: message });
}

function requirePublicAuthOrigin(req: Request, res: Response, next: NextFunction): void {
    if (!isSameOriginDashboardRequest(req)) {
        setAuthNoStoreHeaders(res);
        res.status(403).json({ error: 'Invalid request origin.' });
        return;
    }
    next();
}

function authPageHtml(input: { title: string; body: string; script?: string }): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="referrer" content="no-referrer">
  <title>${input.title} | Zenseeo</title>
  <style>
    :root { color-scheme: light dark; --primary:#f25e36; --bg:#f4f7f6; --surface:#fff; --text:#0f172a; --muted:#64748b; --border:#e2e8f0; --danger:#dc2626; --danger-bg:#fef2f2; --success:#059669; --success-bg:#ecfdf5; --warning:#d97706; }
    @media (prefers-color-scheme: dark) { :root { --bg:#0a0e17; --surface:#111827; --text:#f9fafb; --muted:#94a3b8; --border:#1f2937; --primary:#ff6f47; --danger:#f87171; --danger-bg:#2b1518; --success:#34d399; --success-bg:#0d2821; --warning:#fbbf24; } }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px; background:var(--bg); color:var(--text); font-family:Inter,system-ui,-apple-system,sans-serif; }
    main { width:min(460px,100%); background:var(--surface); border:1px solid var(--border); border-radius:16px; padding:32px; box-shadow:0 20px 40px rgba(15,23,42,.08); }
    .logo { display:flex; justify-content:center; margin-bottom:22px; }
    .logo img { width:72px; height:72px; object-fit:contain; }
    h1 { margin:0 0 8px; font:700 1.5rem/1.2 Outfit,Inter,system-ui,sans-serif; text-align:center; }
    p { color:var(--muted); line-height:1.55; text-align:center; margin:0 0 22px; }
    label { display:block; font-size:.85rem; font-weight:700; margin:14px 0 6px; }
    input { width:100%; height:44px; border:1px solid var(--border); border-radius:10px; padding:0 12px; background:var(--surface); color:var(--text); font:inherit; outline:none; transition:border-color .15s,box-shadow .15s; }
    input:focus { border-color:var(--primary); box-shadow:0 0 0 3px color-mix(in srgb,var(--primary) 18%,transparent); }
    input[aria-invalid="true"] { border-color:var(--danger); }
    button { width:100%; height:46px; border:0; border-radius:10px; margin-top:18px; background:var(--primary); color:white; font-weight:800; cursor:pointer; }
    button:disabled { opacity:.55; cursor:not-allowed; }
    .link-row { display:flex; justify-content:center; gap:12px; margin-top:18px; font-size:.9rem; }
    a { color:var(--primary); text-decoration:none; font-weight:700; }
    .status { min-height:22px; margin-top:14px; color:var(--muted); text-align:center; font-size:.9rem; }
    .error { color:var(--danger); }
    .ok { color:var(--success); }
    .field-message { min-height:18px; margin-top:6px; color:var(--muted); font-size:.78rem; line-height:1.4; }
    .field-message.error,.field-message.ok { text-align:left; }
    .password-field { position:relative; }
    .password-field input { padding-right:64px; }
    .password-toggle { position:absolute; top:6px; right:6px; width:auto; height:32px; margin:0; padding:0 9px; border:1px solid var(--border); background:var(--surface); color:var(--muted); font-size:.75rem; }
    .password-guide { margin-top:10px; padding:12px; border:1px solid var(--border); border-radius:10px; background:color-mix(in srgb,var(--bg) 72%,var(--surface)); }
    .password-guide-title { margin:0 0 8px; color:var(--text); text-align:left; font-size:.78rem; font-weight:800; }
    .strength-row { display:flex; align-items:center; gap:10px; margin-bottom:9px; }
    .strength-track { flex:1; height:6px; overflow:hidden; border-radius:999px; background:var(--border); }
    .strength-bar { width:0; height:100%; border-radius:inherit; background:var(--danger); transition:width .2s,background .2s; }
    .strength-label { min-width:48px; color:var(--muted); font-size:.72rem; font-weight:800; text-align:right; }
    .requirement-list { display:grid; gap:5px; margin:0; padding:0; list-style:none; }
    .requirement { color:var(--muted); font-size:.76rem; }
    .requirement::before { content:'○'; display:inline-block; width:18px; color:var(--muted); font-weight:900; }
    .requirement.met { color:var(--success); }
    .requirement.met::before { content:'✓'; color:var(--success); }
    .notice { margin:0 0 18px; padding:12px 14px; border:1px solid var(--border); border-radius:10px; color:var(--muted); background:color-mix(in srgb,var(--bg) 72%,var(--surface)); font-size:.86rem; line-height:1.5; text-align:left; }
    .notice.ok { border-color:color-mix(in srgb,var(--success) 35%,var(--border)); background:var(--success-bg); color:var(--success); }
    [hidden] { display:none !important; }
  </style>
</head>
<body>
  <main>
    <div class="logo"><img src="/logo.png" alt="Zenseeo"></div>
    ${input.body}
  </main>
  <script>
  function zenseeoWithTimeout(promise, timeoutMs, message) {
    let timeout;
    return Promise.race([
      Promise.resolve(promise),
      new Promise(function(_, reject) { timeout = setTimeout(function() { reject(new Error(message)); }, timeoutMs); })
    ]).finally(function() { clearTimeout(timeout); });
  }
  async function zenseeoAuthFetch(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(function() { controller.abort(); }, 15000);
    try {
      return await fetch(url, Object.assign({}, options || {}, { signal: controller.signal }));
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error('The request timed out. Check your connection and try again.');
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
  </script>
  <script src="/vendor/idb.umd.js"></script>
  <script src="/offline.js"></script>
  ${input.script ? `<script>${input.script}</script>` : ''}
</body>
</html>`;
}

function renderLoginPage(): string {
    return authPageHtml({
        title: 'Log In',
        body: `<h1>Log in to Zenseeo</h1>
<p>Use your dashboard account, or open a valid magic link if you were given one.</p>
<form id="loginForm" autocomplete="on">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="username" required>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Log in</button>
  <div id="status" class="status" role="status"></div>
</form>
<div class="link-row"><a href="/forgot-password">Forgot password?</a></div>`,
        script: `
const form = document.getElementById('loginForm');
const statusEl = document.getElementById('status');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  statusEl.className = 'status';
  statusEl.textContent = 'Signing in...';
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    if (window.ZenseeoOffline?.pendingLogoutBlocked?.()) {
      const pendingLogoutComplete = await zenseeoWithTimeout(
        window.ZenseeoOffline.completePendingLogout(''),
        13000,
        'Timed out finishing the previous logout. Check your connection and try again.'
      );
      if (pendingLogoutComplete === false) throw new Error('Reconnect to finish the previous logout before signing in.');
    }
    const res = await zenseeoAuthFetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: form.email.value, password: form.password.value })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Login failed.');
    window.location.assign('/');
  } catch (err) {
    statusEl.className = 'status error';
    statusEl.textContent = err.message || 'Login failed.';
  } finally {
    button.disabled = false;
  }
});`
    });
}

function renderForgotPasswordPage(): string {
    return authPageHtml({
        title: 'Forgot Password',
        body: `<h1>Reset your password</h1>
<p>Enter your dashboard email and we will send a secure reset link.</p>
<form id="forgotForm" autocomplete="on" novalidate>
  <label for="email">Email address</label>
  <input id="email" name="email" type="email" autocomplete="email" required aria-describedby="emailFeedback">
  <div id="emailFeedback" class="field-message" aria-live="polite">Use the email address associated with your dashboard account.</div>
  <button id="forgotSubmit" type="submit">Send reset instructions</button>
  <div id="status" class="status" role="status" aria-live="polite"></div>
</form>
<div id="forgotSuccess" class="notice ok" role="status" hidden>If an account exists for that email, reset instructions have been sent. Check your inbox and spam folder.</div>
<div class="link-row"><a href="/login">Back to login</a></div>`,
        script: `
const form = document.getElementById('forgotForm');
const emailInput = document.getElementById('email');
const emailFeedback = document.getElementById('emailFeedback');
const statusEl = document.getElementById('status');
const successEl = document.getElementById('forgotSuccess');
function updateEmailFeedback() {
  if (!emailInput.value) {
    emailInput.removeAttribute('aria-invalid');
    emailFeedback.className = 'field-message';
    emailFeedback.textContent = 'Use the email address associated with your dashboard account.';
    return;
  }
  const valid = emailInput.validity.valid;
  emailInput.setAttribute('aria-invalid', valid ? 'false' : 'true');
  emailFeedback.className = 'field-message ' + (valid ? 'ok' : 'error');
  emailFeedback.textContent = valid ? 'Email address looks valid.' : 'Enter a valid email address.';
}
emailInput.addEventListener('input', updateEmailFeedback);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  updateEmailFeedback();
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  const button = document.getElementById('forgotSubmit');
  button.disabled = true;
  statusEl.className = 'status';
  statusEl.textContent = 'Sending reset instructions...';
  try {
    const res = await zenseeoAuthFetch('/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: emailInput.value })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Reset instructions could not be sent.');
    form.hidden = true;
    successEl.hidden = false;
  } catch (err) {
    statusEl.className = 'status error';
    statusEl.textContent = err.message || 'Reset instructions could not be sent.';
    button.disabled = false;
  }
});`
    });
}

function renderResetPage(token: string, valid: boolean): string {
    const escaped = token.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
    return authPageHtml({
        title: 'Set Password',
        body: `<h1>Set your password</h1>
<p>${valid ? 'Choose a strong password to activate or recover your dashboard account.' : 'This link is invalid or expired.'}</p>
<form id="resetForm" autocomplete="off" ${valid ? '' : 'hidden'}>
  <input id="token" name="token" type="hidden" value="${escaped}">
  <label for="password">New password</label>
  <div class="password-field">
    <input id="password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="200" required aria-describedby="passwordFeedback passwordRequirements">
    <button id="passwordToggle" class="password-toggle" type="button" aria-controls="password" aria-pressed="false">Show</button>
  </div>
  <div id="passwordFeedback" class="field-message" aria-live="polite">Enter a new password.</div>
  <div class="password-guide">
    <div class="password-guide-title">Password requirements</div>
    <div class="strength-row">
      <div id="strengthTrack" class="strength-track" role="progressbar" aria-label="Password strength" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="strengthBar" class="strength-bar"></div></div>
      <span id="strengthLabel" class="strength-label">Not set</span>
    </div>
    <ul id="passwordRequirements" class="requirement-list">
      <li id="passwordLength" class="requirement">12–200 characters</li>
      <li id="passwordLetter" class="requirement">At least one letter</li>
      <li id="passwordNumber" class="requirement">At least one number</li>
    </ul>
  </div>
  <label for="confirmPassword">Confirm password</label>
  <div class="password-field">
    <input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" maxlength="200" required aria-describedby="confirmFeedback">
    <button id="confirmToggle" class="password-toggle" type="button" aria-controls="confirmPassword" aria-pressed="false">Show</button>
  </div>
  <div id="confirmFeedback" class="field-message" aria-live="polite">Re-enter the same password.</div>
  <button id="savePasswordBtn" type="submit" disabled>Save password</button>
  <div id="status" class="status" role="status" aria-live="polite"></div>
</form>
<div id="resetSuccess" class="notice ok" role="status" hidden>Your password has been saved. You can now log in with your new password.</div>
<div class="link-row">${valid ? '' : '<a href="/forgot-password">Request a new link</a>'}<a href="/login">Back to login</a></div>`,
        script: `
if (window.history && window.history.replaceState) window.history.replaceState(null, '', '/auth/reset');
const form = document.getElementById('resetForm');
const statusEl = document.getElementById('status');
const passwordInput = document.getElementById('password');
const confirmInput = document.getElementById('confirmPassword');
const passwordFeedback = document.getElementById('passwordFeedback');
const confirmFeedback = document.getElementById('confirmFeedback');
const saveButton = document.getElementById('savePasswordBtn');
const successEl = document.getElementById('resetSuccess');
const passwordRules = [
  { id: 'passwordLength', test: function(value) { return value.length >= 12 && value.length <= 200; } },
  { id: 'passwordLetter', test: function(value) { return /[a-z]/i.test(value); } },
  { id: 'passwordNumber', test: function(value) { return /[0-9]/.test(value); } }
];
function passwordValidation(value) {
  const met = passwordRules.map(function(rule) { return rule.test(value); });
  return { met: met, valid: met.every(Boolean) && Boolean(value.trim()) };
}
function updatePasswordUi() {
  if (!form) return;
  const value = passwordInput.value;
  const validation = passwordValidation(value);
  passwordRules.forEach(function(rule, index) {
    document.getElementById(rule.id).classList.toggle('met', validation.met[index]);
  });
  const hasMixedCase = /[a-z]/.test(value) && /[A-Z]/.test(value);
  const hasSymbol = /[^A-Za-z0-9]/.test(value);
  const strong = validation.valid && value.length >= 16 && (hasMixedCase || hasSymbol);
  const percent = !value ? 0 : !validation.valid ? Math.max(20, validation.met.filter(Boolean).length * 25) : strong ? 100 : 72;
  const label = !value ? 'Not set' : !validation.valid ? 'Weak' : strong ? 'Strong' : 'Good';
  document.getElementById('strengthBar').style.width = percent + '%';
  document.getElementById('strengthBar').style.background = !validation.valid ? 'var(--danger)' : strong ? 'var(--success)' : 'var(--warning)';
  document.getElementById('strengthLabel').textContent = label;
  document.getElementById('strengthTrack').setAttribute('aria-valuenow', String(percent));
  passwordInput.setAttribute('aria-invalid', value && !validation.valid ? 'true' : 'false');
  passwordFeedback.className = 'field-message' + (value ? validation.valid ? ' ok' : ' error' : '');
  passwordFeedback.textContent = !value ? 'Enter a new password.' : validation.valid ? 'Password meets all required rules.' : 'Complete the requirements shown below.';
  const confirmValue = confirmInput.value;
  const matches = Boolean(confirmValue) && confirmValue === value;
  confirmInput.setAttribute('aria-invalid', confirmValue && !matches ? 'true' : 'false');
  confirmFeedback.className = 'field-message' + (confirmValue ? matches ? ' ok' : ' error' : '');
  confirmFeedback.textContent = !confirmValue ? 'Re-enter the same password.' : matches ? 'Passwords match.' : 'Passwords do not match.';
  saveButton.disabled = !(validation.valid && matches);
}
function bindPasswordToggle(buttonId, input) {
  document.getElementById(buttonId).addEventListener('click', function(event) {
    const revealed = input.type === 'password';
    input.type = revealed ? 'text' : 'password';
    event.currentTarget.textContent = revealed ? 'Hide' : 'Show';
    event.currentTarget.setAttribute('aria-pressed', revealed ? 'true' : 'false');
  });
}
if (form) {
  passwordInput.addEventListener('input', updatePasswordUi);
  confirmInput.addEventListener('input', updatePasswordUi);
  bindPasswordToggle('passwordToggle', passwordInput);
  bindPasswordToggle('confirmToggle', confirmInput);
  updatePasswordUi();
}
if (form) form.addEventListener('submit', async (event) => {
  event.preventDefault();
  updatePasswordUi();
  if (saveButton.disabled) return;
  saveButton.disabled = true;
  statusEl.className = 'status';
  statusEl.textContent = 'Saving password...';
  try {
    const res = await zenseeoAuthFetch('/auth/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token: form.token.value, password: form.password.value })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Password could not be saved.');
    form.reset();
    form.hidden = true;
    successEl.hidden = false;
  } catch (err) {
    statusEl.className = 'status error';
    statusEl.textContent = err.message || 'Password could not be saved.';
  } finally {
    updatePasswordUi();
  }
});`
    });
}

app.get('/login', (_req: Request, res: Response) => {
    setAuthNoStoreHeaders(res);
    res.type('html').send(renderLoginPage());
});

app.get('/forgot-password', (_req: Request, res: Response) => {
    setAuthNoStoreHeaders(res);
    res.type('html').send(renderForgotPasswordPage());
});

app.post('/auth/login', requirePublicAuthOrigin, async (req: Request, res: Response) => {
    setAuthNoStoreHeaders(res);
    try {
        const login = await authenticateDashboardUser(pool, {
            email: req.body?.email,
            password: req.body?.password,
            ip: clientIp(req)
        });
        const session = await createNamedDashboardSession(pool, login.user.id, req);
        setDashboardSessionCookie(res, session.sessionToken, session.expiresAt, req);
        setDashboardCsrfResponseCookie(res, session.csrfToken, req);
        clearDashboardOfflineBlockCookie(res, req);
        clearDashboardLogoutPendingCookie(res, req);
        res.json({
            ok: true,
            user: {
                id: login.user.id,
                email: login.user.email,
                name: login.user.name
            }
        });
    } catch (err: any) {
        sendAuthError(res, err);
    }
});

app.post('/auth/forgot-password', requirePublicAuthOrigin, async (req: Request, res: Response) => {
    setAuthNoStoreHeaders(res);
    try {
        await requestDashboardPasswordReset(pool, { email: req.body?.email, ip: clientIp(req) });
    } catch (err: any) {
        if (err instanceof DashboardAuthRateLimitError || err?.name === 'DashboardAuthRateLimitError') {
            sendAuthError(res, err);
            return;
        }
        console.error('dashboard_forgot_password_failed', { errorName: err?.name || 'Error' });
    }
    res.json({ ok: true, message: 'If the account exists, reset instructions have been sent.' });
});

app.get('/auth/reset', async (req: Request, res: Response) => {
    setAuthNoStoreHeaders(res);
    const token = publicAuthToken(req.query.token);
    const inspection = await inspectDashboardPasswordToken(pool, token).catch(() => ({ valid: false }));
    const valid = Boolean(inspection.valid);
    res.type('html').send(renderResetPage(valid ? token : '', valid));
});

app.post('/auth/reset', requirePublicAuthOrigin, async (req: Request, res: Response) => {
    setAuthNoStoreHeaders(res);
    try {
        const user = await consumeDashboardPasswordToken(pool, {
            token: req.body?.token,
            password: req.body?.password
        });
        res.json({
            ok: true,
            user: {
                id: user.id,
                email: user.email,
                name: user.name
            }
        });
    } catch (err: any) {
        sendAuthError(res, err);
    }
});

app.get('/api/auth/session', authenticateDashboardSession({ pool, pushConfig: dashboardPushConfig }));

app.get('/auth/magic', (req: Request, res: Response) => {
    setAuthNoStoreHeaders(res);
    const token = publicAuthToken(req.query.token);
    if (!token) {
        res.status(400).send('Invalid or missing dashboard link token.');
        return;
    }
    setDashboardMagicTokenCookie(res, token, req);
    res.type('html').send(renderMagicLanding(token));
});

app.post('/auth/magic/consume', requirePublicAuthOrigin, async (req: Request, res: Response) => {
    setAuthNoStoreHeaders(res);
    let bodyToken = '';
    let cookieToken = '';
    try {
        bodyToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
        cookieToken = readDashboardMagicTokenCookie(req);
        const bodyBuffer = Buffer.from(bodyToken);
        const cookieBuffer = Buffer.from(cookieToken);
        const tokensMatch = bodyBuffer.length > 0
            && bodyBuffer.length === cookieBuffer.length
            && crypto.timingSafeEqual(bodyBuffer, cookieBuffer);
        if (!tokensMatch) throw new Error('Invalid or expired dashboard link.');
        const session = await consumeDashboardMagicLink(pool, bodyToken, req);
        clearDashboardMagicTokenCookie(res, req);
        setDashboardSessionCookie(res, session.sessionToken, session.expiresAt, req);
        setDashboardOfflineBlockCookie(res, req);
        clearDashboardLogoutPendingCookie(res, req);
        res.redirect(session.redirectPath);
    } catch (err: any) {
        console.warn('Dashboard magic link consume failed:', {
            hasBodyToken: Boolean(bodyToken),
            hasCookieToken: Boolean(cookieToken),
            origin: req.headers.origin || null,
            referer: req.headers.referer || null,
            error: err?.message || 'unknown'
        });
        clearDashboardMagicTokenCookie(res, req);
        res.status(400).send(err.message || 'Invalid or expired dashboard link.');
    }
});

app.post('/auth/logout', ...authenticateDashboardMutation, async (req: Request, res: Response) => {
    setAuthNoStoreHeaders(res);
    await revokeDashboardSession(pool, req).catch(err => console.error('Failed to revoke dashboard session:', err));
    clearDashboardSessionCookie(res, req);
    clearDashboardCsrfCookie(res, req);
    clearDashboardOfflineBlockCookie(res, req);
    clearDashboardLogoutPendingCookie(res, req);
    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Signed Out | Zenseeo</title>
  <style>
    :root {
      --bg-base: #f4f7f6;
      --bg-surface: #ffffff;
      --border-light: #e2e8f0;
      --text-primary: #0f172a;
      --text-secondary: #475569;
      --text-muted: #64748b;
      --primary: #f25e36;
      --primary-hover: #e04d27;
      --primary-glow: rgba(242, 94, 54, 0.12);
      --success: #10b981;
      --shadow: 0 20px 40px rgba(15, 23, 42, 0.05), 0 1px 3px rgba(15, 23, 42, 0.02);
      --radius-lg: 16px;
      --radius-md: 10px;
      --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
      --font-heading: 'Outfit', system-ui, -apple-system, sans-serif;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg-base: #0a0e17;
        --bg-surface: #111827;
        --border-light: #1f2937;
        --text-primary: #f9fafb;
        --text-secondary: #cbd5e1;
        --text-muted: #64748b;
        --primary: #ff6f47;
        --primary-hover: #ff8361;
        --primary-glow: rgba(255, 111, 71, 0.15);
        --success: #34d399;
        --shadow: 0 20px 40px rgba(0, 0, 0, 0.25), 0 1px 3px rgba(0, 0, 0, 0.05);
      }
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      background-color: var(--bg-base);
      color: var(--text-primary);
      font-family: var(--font-sans);
      position: relative;
      overflow: hidden;
    }

    .blob {
      position: absolute;
      width: 320px;
      height: 320px;
      border-radius: 50%;
      filter: blur(90px);
      opacity: 0.12;
      z-index: 0;
      pointer-events: none;
      animation: pulse 12s infinite alternate;
    }

    .blob-1 {
      background: var(--primary);
      top: 10%;
      left: 15%;
    }

    .blob-2 {
      background: #3b82f6;
      bottom: 10%;
      right: 15%;
      animation-delay: -6s;
    }

    @keyframes pulse {
      0% { transform: scale(1) translate(0, 0); }
      100% { transform: scale(1.2) translate(15px, -30px); }
    }

    main {
      width: min(440px, calc(100vw - 32px));
      background: var(--bg-surface);
      border: 1px solid var(--border-light);
      border-radius: var(--radius-lg);
      padding: 36px;
      box-shadow: var(--shadow);
      z-index: 1;
      position: relative;
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      animation: fadeInUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) both;
    }

    @keyframes fadeInUp {
      from {
        opacity: 0;
        transform: translateY(20px) scale(0.98);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    .logo-container {
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 24px;
    }

    .brand-logo-img {
      height: 64px;
      width: auto;
      object-fit: contain;
      transition: filter 0.3s ease;
    }

    @media (prefers-color-scheme: dark) {
      .brand-logo-img {
        filter: invert(0.9) brightness(1.2) hue-rotate(180deg);
      }
    }

    h1 {
      font-family: var(--font-heading);
      font-size: 1.5rem;
      font-weight: 600;
      text-align: center;
      margin-bottom: 10px;
      letter-spacing: -0.02em;
    }

    p {
      color: var(--text-secondary);
      font-size: 0.9rem;
      line-height: 1.6;
      text-align: center;
      margin-bottom: 28px;
    }

    .success-icon-container {
      display: flex;
      justify-content: center;
      margin-bottom: 20px;
    }

    .success-checkmark {
      width: 64px;
      height: 64px;
    }

    .check-icon {
      stroke: var(--success);
      stroke-width: 3;
      stroke-linecap: round;
      stroke-linejoin: round;
      fill: none;
      stroke-dasharray: 48;
      stroke-dashoffset: 48;
      animation: stroke 0.4s cubic-bezier(0.65, 0, 0.45, 1) 0.3s forwards;
    }

    .check-circle {
      stroke: var(--success);
      stroke-width: 3;
      stroke-dasharray: 166;
      stroke-dashoffset: 166;
      stroke-miterlimit: 10;
      fill: none;
      animation: stroke 0.6s cubic-bezier(0.65, 0, 0.45, 1) forwards;
    }

    @keyframes stroke {
      100% {
        stroke-dashoffset: 0;
      }
    }

    a.btn-link {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      text-decoration: none;
      border-radius: var(--radius-md);
      background: linear-gradient(135deg, var(--primary) 0%, #ff7c5c 100%);
      color: white;
      font-family: var(--font-heading);
      font-size: 0.95rem;
      font-weight: 600;
      padding: 14px 20px;
      box-shadow: 0 4px 12px var(--primary-glow);
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }

    a.btn-link:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 20px var(--primary-glow);
      filter: brightness(1.05);
    }

    a.btn-link:active {
      transform: translateY(0);
    }

    a.btn-link svg {
      transition: transform 0.2s ease;
      margin-left: 8px;
    }

    a.btn-link:hover svg {
      transform: translateX(4px);
    }

    .footer {
      text-align: center;
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 28px;
    }
  </style>
</head>
<body>
  <div class="blob blob-1"></div>
  <div class="blob blob-2"></div>
  <main>
    <div class="logo-container">
      <img src="/logo.png" alt="Zenseeo Logo" class="brand-logo-img">
    </div>

    <div class="success-icon-container">
      <svg class="success-checkmark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52">
        <circle class="check-circle" cx="26" cy="26" r="25" fill="none"/>
        <path class="check-icon" d="M14.1 27.2l7.1 7.2 16.7-16.8"/>
      </svg>
    </div>

    <h1>Signed Out</h1>
    <p>You have been safely and successfully signed out of the Google Ads Dashboard.</p>

    <div class="footer">
      Secured by Zenseeo
    </div>
  </main>
</body>
</html>`);
});

if (serveDashboardClient) {
    app.get('/config.js', (_req: Request, res: Response) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.type('application/javascript').send(`window.ENV = { API_BASE: "", API_KEY: "" };`);
    });
}

const authenticateLeadWebhook = (req: Request, res: Response, next: NextFunction): void => {
    const expected = process.env.LEAD_WEBHOOK_SECRET || process.env.SECRET_API_KEY;
    if (!expected) {
        res.status(503).json({ error: 'Lead webhook secret is not configured' });
        return;
    }
    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const headerSecret = String(req.headers['x-webhook-secret'] || '');
    const querySecret = typeof req.query.secret === 'string' ? req.query.secret : '';
    if (![bearer, headerSecret, querySecret].includes(expected)) {
        res.status(403).json({ error: 'Forbidden: Invalid webhook secret' });
        return;
    }
    next();
};

const authenticateOfflineConversionsBasic = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const status = await getOfflineConversionsBasicAuthStatus(pool);
        if (!status.configured) {
            res.status(503).json({ error: 'Offline conversions Basic Auth is not configured' });
            return;
        }
    } catch (err) {
        console.error('Offline conversions Basic Auth status check failed:', err);
        res.status(500).json({ error: 'Offline conversions Basic Auth check failed' });
        return;
    }
    const authHeader = String(req.headers.authorization || '');
    if (!authHeader.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="offline-conversions"');
        res.status(401).json({ error: 'Basic Auth required' });
        return;
    }
    let user = '';
    let password = '';
    try {
        const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        user = separator >= 0 ? decoded.slice(0, separator) : decoded;
        password = separator >= 0 ? decoded.slice(separator + 1) : '';
    } catch {
        res.status(403).json({ error: 'Forbidden: Invalid Basic Auth' });
        return;
    }
    try {
        const verification = await verifyOfflineConversionsBasicAuth(pool, user, password);
        if (!verification.configured) {
            res.status(503).json({ error: 'Offline conversions Basic Auth is not configured' });
            return;
        }
        if (!verification.ok) {
            res.status(403).json({ error: 'Forbidden: Invalid Basic Auth' });
            return;
        }
        next();
    } catch (err) {
        console.error('Offline conversions Basic Auth check failed:', err);
        res.status(500).json({ error: 'Offline conversions Basic Auth check failed' });
    }
};

function googleAdsMutationStatusCode(err: any): number {
    if (Number.isInteger(err?.statusCode)) return err.statusCode;
    if (err instanceof GoogleAdsMutationValidationError || err?.name === 'GoogleAdsMutationValidationError') return 400;
    return 500;
}

function sendGoogleAdsMutationError(res: Response, err: any): void {
    const payload: any = { error: err?.message || 'Google Ads change error' };
    if (err?.errors) payload.errors = err.errors;
    if (err?.partialFailure) payload.partialFailure = err.partialFailure;
    if (err?.partialResults) payload.partialResults = err.partialResults;
    res.status(googleAdsMutationStatusCode(err)).json(payload);
}

function semanticMemoryStatusCode(err: any): number {
    if (err instanceof SemanticMemoryValidationError || err?.name === 'SemanticMemoryValidationError') return 400;
    if (err instanceof SemanticMemoryConflictError || err?.name === 'SemanticMemoryConflictError') return 409;
    if (err instanceof SemanticMemoryNotFoundError || err?.name === 'SemanticMemoryNotFoundError') return 404;
    if (err instanceof SemanticMemoryConfigurationError || err?.name === 'SemanticMemoryConfigurationError') return 503;
    return 500;
}

function sendSemanticMemoryError(res: Response, err: any): void {
    console.error('Semantic memory error:', err);
    res.status(semanticMemoryStatusCode(err)).json({ error: err.message });
}

function assertSemanticMemoryAvailable(): void {
    if (semanticMemorySchemaError) {
        throw new SemanticMemoryConfigurationError(`Semantic memory schema is unavailable. ${semanticMemorySchemaError}`);
    }
}

// API: Get DB-backed dashboard data for selected server-side filters
app.get('/api/dashboard', authenticateDashboard, async (req: Request, res: Response) => {
    const timings: DashboardTimingMetric[] = [];
    try {
        const dashboardData = await getDashboardPayload(req.query as Record<string, any>, timings);
        res.setHeader('Server-Timing', dashboardServerTimingHeader(timings));
        res.setHeader('X-Dashboard-View', String((req.query as Record<string, any>).view || 'full'));
        res.json(dashboardData);
    } catch (err: any) {
        if (timings.length) res.setHeader('Server-Timing', dashboardServerTimingHeader(timings));
        console.error(err);
        res.status(dashboardErrorStatus(err)).json({ error: dashboardErrorMessage(err) });
    }
});

app.get('/api/dashboard/filters', authenticateDashboard, async (req: Request, res: Response) => {
    try {
        res.json(await getDashboardFilterOptions(req.query as Record<string, any>));
    } catch (err: any) {
        console.error(err);
        res.status(dashboardErrorStatus(err)).json({ error: dashboardErrorMessage(err) });
    }
});

app.get('/api/dashboard/cron-refresh-status', authenticateDashboard, async (_req: Request, res: Response) => {
    try {
        const { rows } = await pool.query(
            `SELECT run.id, run.kind, run.status AS warehouse_status,
                    job.status AS queue_status, run.started_at, run.completed_at, job.source
             FROM google_ads_refresh_jobs AS job
             INNER JOIN google_ads_refresh_runs AS run ON run.id = job.id
             WHERE job.source IN ($1, $2)
             ORDER BY job.created_at DESC
             LIMIT 1`,
            [CRON_REFRESH_SOURCE, CRON_COOLDOWN_TODAY_REFRESH_SOURCE]
        );
        const run = rows[0];
        const status = run?.queue_status === 'succeeded' ? run.warehouse_status : run?.queue_status;
        res.setHeader('Cache-Control', 'private, no-store');
        res.json({
            refreshRun: run ? {
                id: run.id,
                kind: run.kind,
                status,
                source: run.source,
                refreshProfile: run.source === CRON_COOLDOWN_TODAY_REFRESH_SOURCE ? 'light_today' : 'full',
                startedAt: run.started_at,
                completedAt: run.completed_at
            } : null
        });
    } catch (err: any) {
        console.error('Failed to load cron refresh status:', err);
        res.status(500).json({ error: 'Failed to load cron refresh status.' });
    }
});

app.get('/api/dashboard/widgets/searches', authenticateDashboard, async (req: Request, res: Response) => {
    try {
        const raw = req.query as Record<string, any>;
        const filters = await resolveDashboardFilters(pool, raw);
        res.setHeader('Cache-Control', 'private, no-store');
        res.json(await getSearchTermsOverviewWidget(pool, filters, raw));
    } catch (err: any) {
        console.error(err);
        const status = err instanceof OverviewWidgetValidationError || err?.name === 'OverviewWidgetValidationError'
            ? 400
            : dashboardErrorStatus(err);
        res.status(status).json({ error: dashboardErrorMessage(err) });
    }
});

app.get('/api/dashboard/widgets/keywords', authenticateDashboard, async (req: Request, res: Response) => {
    try {
        const raw = req.query as Record<string, any>;
        const filters = await resolveDashboardFilters(pool, raw);
        res.setHeader('Cache-Control', 'private, no-store');
        res.json(await getKeywordsOverviewWidget(pool, filters, raw));
    } catch (err: any) {
        console.error(err);
        const status = err instanceof OverviewWidgetValidationError || err?.name === 'OverviewWidgetValidationError'
            ? 400
            : dashboardErrorStatus(err);
        res.status(status).json({ error: dashboardErrorMessage(err) });
    }
});

app.get('/api/push/config', authenticateDashboard, async (_req: Request, res: Response) => {
    const auth = dashboardAuthContext(res);
    res.setHeader('Cache-Control', 'no-store');
    res.json(dashboardPushConfig(auth?.mode === 'user'));
});

app.get('/api/push/subscriptions/status', authenticateDashboard, async (req: Request, res: Response) => {
    const auth = dashboardAuthContext(res);
    if (auth?.mode !== 'user' || !auth.user) {
        res.status(403).json({ error: 'Named user login is required for push notifications.' });
        return;
    }
    try {
        res.json(await pushSubscriptionStatus(pool, auth.user.id, req.query.endpoint));
    } catch (err: any) {
        const status = err instanceof DashboardPushValidationError || err?.name === 'DashboardPushValidationError' ? 400 : 500;
        if (status === 500) console.error('dashboard_push_subscription_status_failed', { userId: auth.user.id, errorName: err?.name || 'Error' });
        res.status(status).json({ error: status === 400 ? err.message : 'Could not load push subscription status.' });
    }
});

app.post('/api/push/subscriptions', ...authenticateDashboardMutation, async (req: Request, res: Response) => {
    const auth = dashboardAuthContext(res);
    if (auth?.mode !== 'user' || !auth.user) {
        res.status(403).json({ error: 'Named user login is required for push notifications.' });
        return;
    }
    if (!pushAvailability().available) {
        res.status(503).json({ error: 'Push notifications are not available.' });
        return;
    }
    try {
        const result = await upsertPushSubscription(pool, auth.user.id, {
            endpoint: req.body?.endpoint,
            keys: req.body?.keys,
            userAgent: String(req.headers['user-agent'] || '')
        });
        res.status(201).json(result);
    } catch (err: any) {
        const status = err instanceof DashboardPushValidationError || err?.name === 'DashboardPushValidationError' ? 400 : 500;
        if (status === 500) console.error('dashboard_push_subscription_save_failed', { userId: auth.user.id, errorName: err?.name || 'Error' });
        res.status(status).json({ error: status === 400 ? err.message : 'Could not save push subscription.' });
    }
});

app.delete('/api/push/subscriptions', ...authenticateDashboardMutation, async (req: Request, res: Response) => {
    const auth = dashboardAuthContext(res);
    if (auth?.mode !== 'user' || !auth.user) {
        res.status(403).json({ error: 'Named user login is required for push notifications.' });
        return;
    }
    try {
        const result = await revokePushSubscription(pool, auth.user.id, req.body?.endpoint);
        res.json(result);
    } catch (err: any) {
        console.error('dashboard_push_subscription_revoke_failed', { userId: auth.user.id, errorName: err?.name || 'Error' });
        res.status(500).json({ error: 'Could not revoke push subscription.' });
    }
});

// API: Get user preferences
app.get('/api/user/preferences', authenticateDashboard, async (req: Request, res: Response) => {
    const auth = dashboardAuthContext(res);
    if (!auth || !auth.user?.id) {
        res.json({ preferences: {} });
        return;
    }
    try {
        const preferences = await getUserPreferences(pool, auth.user.id);
        res.json({ preferences });
    } catch (err: any) {
        const statusCode = err instanceof UserPreferenceValidationError || err?.name === 'UserPreferenceValidationError' ? 400 : 500;
        res.status(statusCode).json({ error: err?.message || 'Failed to fetch user preferences' });
    }
});

// API: Update user preference(s)
app.put('/api/user/preferences', ...authenticateDashboardMutation, async (req: Request, res: Response) => {
    const auth = dashboardAuthContext(res);
    if (!auth || !auth.user?.id) {
        res.status(403).json({ error: 'Named user login is required to save preferences.' });
        return;
    }
    try {
        const body = req.body || {};
        if (body.key !== undefined) {
            const updatedValue = await setUserPreference(pool, auth.user.id, body.key, body.value);
            const preferences = await getUserPreferences(pool, auth.user.id);
            res.json({ success: true, key: body.key, value: updatedValue, preferences });
            return;
        }
        if (body.preferences && typeof body.preferences === 'object' && !Array.isArray(body.preferences)) {
            const preferences = await setUserPreferences(pool, auth.user.id, body.preferences);
            res.json({ success: true, preferences });
            return;
        }
        res.status(400).json({ error: 'Request body must contain either a "key" and "value" or a "preferences" object.' });
    } catch (err: any) {
        const statusCode = err instanceof UserPreferenceValidationError || err?.name === 'UserPreferenceValidationError' ? 400 : 500;
        res.status(statusCode).json({ error: err?.message || 'Failed to update user preferences' });
    }
});

// API: Update proposal status
app.post('/api/proposals/:id/status', ...authenticateDashboardMutation, async (req: Request, res: Response) => {
    const id = routeParam(req.params.id);
    const { status, action, selected_option_id } = req.body;
    const requestedAction = action || status;
    if (!requestedAction) {
        return res.status(400).json({ error: 'Missing status/action in request body' });
    }
    try {
        const proposal = await recordProposalDecision(pool, {
            proposalId: id,
            action: requestedAction,
            selectedOptionId: selected_option_id || null
        });
        clearDashboardViewPayloadCache();
        res.json({ message: 'Proposal status updated successfully.', proposal });
    } catch (err: any) {
        console.error('Failed to update proposal status:', err);
        const statusCode = err instanceof ProposalValidationError || err?.name === 'ProposalValidationError'
            ? 400
            : String(err?.message || '').startsWith('Proposal not found:')
                ? 404
                : 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// API: Capture raw user feedback on a proposal. This does not create semantic memory automatically.
app.post('/api/proposals/:id/feedback', ...authenticateDashboardMutation, async (req: Request, res: Response) => {
    try {
        const filters = await resolveDashboardFilters(pool, req.query as Record<string, any>).catch(() => null);
        const feedback = await createProposalFeedback(pool, {
            proposalId: routeParam(req.params.id),
            optionId: req.body?.option_id || null,
            feedbackType: req.body?.feedback_type || null,
            comment: req.body?.comment,
            customerId: req.body?.customer_id || filters?.customerId || null,
            createdBy: req.body?.created_by || 'user'
        });
        clearDashboardViewPayloadCache();
        res.status(201).json({ message: 'Proposal feedback saved successfully.', feedback });
    } catch (err: any) {
        console.error('Failed to save proposal feedback:', err);
        const statusCode = err instanceof ProposalValidationError || err?.name === 'ProposalValidationError'
            ? 400
            : String(err?.message || '').startsWith('Proposal not found:')
                ? 404
                : 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// API: Read proposal feedback history for one proposal.
app.get('/api/proposals/:id/feedback', authenticateDashboard, async (req: Request, res: Response) => {
    try {
        const feedback = await listProposalFeedback(pool, {
            proposalId: routeParam(req.params.id),
            status: typeof req.query.status === 'string' ? req.query.status : null,
            limit: typeof req.query.limit === 'string' ? req.query.limit : null
        });
        res.json({ feedback });
    } catch (err: any) {
        console.error('Failed to list proposal feedback:', err);
        const statusCode = err instanceof ProposalValidationError || err?.name === 'ProposalValidationError' ? 400 : 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// API: First-party website lead webhook ingestion
app.post('/api/webhooks/leads', authenticateLeadWebhook, async (req: Request, res: Response) => {
    try {
        const event = await upsertLeadWebhookEvent(pool, req.body);
        clearDashboardViewPayloadCache();
        pushDeliveryWorker?.poke();
        res.status(202).json({
            message: 'Lead event accepted.',
            event_id: event.event_id,
            session_key: event.session_key,
            status: event.status
        });
    } catch (err: any) {
        console.error('Failed to ingest lead webhook:', err);
        const statusCode = err instanceof LeadValidationError || err?.name === 'LeadValidationError' ? 400 : 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// API: Dashboard-managed Basic Auth credentials for Google Ads Data Manager offline conversion pulls
app.get('/api/offline-conversions/auth', authenticateDashboard, async (_req: Request, res: Response) => {
    try {
        const auth = await getOfflineConversionsBasicAuthStatus(pool);
        res.json({
            endpoint: '/api/analytics/offline-conversions.csv',
            auth
        });
    } catch (err: any) {
        console.error('Failed to load offline conversions auth settings:', err);
        res.status(500).json({ error: err.message || 'Failed to load offline conversions auth settings' });
    }
});

app.put('/api/offline-conversions/auth', ...authenticateDashboardMutation, async (req: Request, res: Response) => {
    try {
        const auth = await upsertOfflineConversionsBasicAuth(pool, {
            username: req.body?.username,
            password: req.body?.password
        });
        res.json({
            message: 'Offline conversions Basic Auth settings saved successfully.',
            endpoint: '/api/analytics/offline-conversions.csv',
            auth
        });
    } catch (err: any) {
        console.error('Failed to save offline conversions auth settings:', err);
        res.status(400).json({ error: err.message || 'Failed to save offline conversions auth settings' });
    }
});

app.get('/api/offline-conversions/auth/password', authenticateDashboard, async (_req: Request, res: Response) => {
    try {
        const revealed = await revealOfflineConversionsBasicAuthPassword(pool);
        res.json({
            username: revealed.username,
            password: revealed.password,
            updatedAt: revealed.updatedAt
        });
    } catch (err: any) {
        console.error('Failed to reveal offline conversions auth password:', err);
        res.status(409).json({ error: err.message || 'Failed to reveal offline conversions auth password' });
    }
});

// API: Basic Auth pull endpoint for Google Ads Data Manager offline conversion CSV imports
app.get('/api/analytics/offline-conversions.csv', authenticateOfflineConversionsBasic, async (req: Request, res: Response) => {
    try {
        const windowHours = Number(req.query.windowHours || 0);
        let startDate = req.query.startDate;
        let endDate = req.query.endDate;
        if (!startDate && Number.isFinite(windowHours) && windowHours > 0) {
            startDate = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString().slice(0, 10);
            endDate = new Date().toISOString().slice(0, 10);
        }
        const result = await exportOfflineConversionsCsv(pool, {
            statuses: req.query.statuses || req.query.status,
            startDate,
            endDate,
            campaignId: req.query.campaignId || req.query.campaign,
            currency: typeof req.query.currency === 'string' ? req.query.currency : undefined,
            qualifiedName: typeof req.query.conversionNameQualified === 'string' ? req.query.conversionNameQualified : undefined,
            convertedName: typeof req.query.conversionNameConverted === 'string' ? req.query.conversionNameConverted : undefined,
            qualifiedValue: req.query.qualifiedValue,
            convertedValue: req.query.convertedValue,
            defaultValue: req.query.defaultValue
        });
        const stamp = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="offline-conversions-${stamp}.csv"`);
        res.setHeader('X-Offline-Conversion-Rows', String(result.rowCount));
        res.setHeader('X-Offline-Conversion-Skipped-Missing-Click-Id', String(result.skippedMissingClickId));
        res.send(result.csv);
    } catch (err: any) {
        console.error('Failed to export Basic Auth offline conversions:', err);
        const statusCode = err instanceof LeadValidationError || err?.name === 'LeadValidationError' ? 400 : 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// API: Export Google Ads offline conversion upload CSV from first-party lead statuses
app.get('/api/leads/offline-conversions.csv', authenticateDashboard, async (req: Request, res: Response) => {
    try {
        const campaignFilter = req.query.campaignId || req.query.campaign;
        let campaignName = typeof req.query.campaignName === 'string' ? req.query.campaignName : undefined;
        if (campaignFilter && !campaignName) {
            const filters = await resolveDashboardFilters(pool, req.query as Record<string, any>);
            const filterOptions = await getAvailableDashboardFilters(pool, filters.customerId);
            const selectedCampaign = filters.campaignId
                ? filterOptions.campaigns.find(campaign => campaign.id === filters.campaignId)
                : null;
            campaignName = selectedCampaign?.name || undefined;
        }
        const result = await exportOfflineConversionsCsv(pool, {
            statuses: req.query.statuses || req.query.status,
            startDate: req.query.startDate,
            endDate: req.query.endDate,
            campaignId: campaignFilter,
            campaignName,
            currency: typeof req.query.currency === 'string' ? req.query.currency : undefined,
            qualifiedName: typeof req.query.qualifiedName === 'string' ? req.query.qualifiedName : undefined,
            convertedName: typeof req.query.convertedName === 'string' ? req.query.convertedName : undefined,
            qualifiedValue: req.query.qualifiedValue,
            convertedValue: req.query.convertedValue,
            defaultValue: req.query.defaultValue
        });
        const stamp = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="offline-conversions-${stamp}.csv"`);
        res.setHeader('X-Offline-Conversion-Rows', String(result.rowCount));
        res.setHeader('X-Offline-Conversion-Skipped-Missing-Click-Id', String(result.skippedMissingClickId));
        res.send(result.csv);
    } catch (err: any) {
        console.error('Failed to export offline conversions:', err);
        const statusCode = err instanceof LeadValidationError || err?.name === 'LeadValidationError' ? 400 : 500;
        res.status(statusCode).json({ error: err.message });
    }
});

app.get(['/api/account-controls/state', '/api/google-ads/account-controls/state'], authenticateDashboard, async (req: Request, res: Response) => {
    try {
        res.json(await getAccountControlsState(pool, { customerId: req.query.customerId }));
    } catch (err: any) {
        sendGoogleAdsMutationError(res, err);
    }
});

app.get(['/api/account-controls/mutations/recent', '/api/google-ads/mutations/recent'], authenticateDashboard, async (req: Request, res: Response) => {
    try {
        res.json({ mutations: await listRecentGoogleAdsMutations(pool, { customerId: req.query.customerId, limit: req.query.limit }) });
    } catch (err: any) {
        sendGoogleAdsMutationError(res, err);
    }
});

app.post(['/api/account-controls/mutations/preview', '/api/google-ads/mutations/preview'], ...authenticateDashboardMutation, async (req: Request, res: Response) => {
    try {
        const preview = await previewGoogleAdsMutation(pool, {
            mutationType: req.body?.mutationType,
            customerId: req.body?.customerId,
            changes: req.body?.changes,
            reason: req.body?.reason,
            requestedBy: 'dashboard',
            source: 'ui'
        });
        res.json(preview);
    } catch (err: any) {
        sendGoogleAdsMutationError(res, err);
    }
});

app.post(['/api/account-controls/mutations/keyword-preflight', '/api/google-ads/mutations/keyword-preflight'], ...authenticateDashboardMutation, async (req: Request, res: Response) => {
    try {
        res.json(await preflightGoogleAdsKeywordMutation(pool, {
            customerId: req.body?.customerId,
            mutationType: req.body?.mutationType,
            change: req.body?.change
        }));
    } catch (err: any) {
        sendGoogleAdsMutationError(res, err);
    }
});

app.post(['/api/account-controls/mutations/:id/confirm', '/api/google-ads/mutations/:id/confirm'], ...authenticateDashboardMutation, async (req: Request, res: Response) => {
    try {
        const result = await confirmGoogleAdsMutation(pool, {
            mutationId: routeParam(req.params.id),
            confirmationToken: req.body?.confirmationToken
        });
        clearDashboardViewPayloadCache();
        clearAdsWarehouseRuntimeCaches();
        const touched = result?.preview?.touched || {};
        const campaignId = Array.isArray(touched.campaignIds) && touched.campaignIds.length === 1 ? touched.campaignIds[0] : undefined;
        const refresh = await startRefreshJob({ force: true, source: 'google_ads_mutation_confirm' });
        res.json({ ...result, refresh, targetedRepair: { campaignId: campaignId || null } });
    } catch (err: any) {
        sendGoogleAdsMutationError(res, err);
    }
});

// API: Export first-party lead review CSV for the selected dashboard range
app.get('/api/leads/review.csv', authenticateDashboard, async (req: Request, res: Response) => {
    try {
        const filters = await resolveDashboardFilters(pool, req.query as Record<string, any>);
        const filterOptions = await getAvailableDashboardFilters(pool, filters.customerId);
        const selectedCampaign = filters.campaignId
            ? filterOptions.campaigns.find(campaign => campaign.id === filters.campaignId)
            : null;
        const selectedAdGroup = filters.adGroupId
            ? filterOptions.adGroups.find(adGroup => adGroup.id === filters.adGroupId)
            : null;
        const result = await exportLeadReviewCsv(pool, {
            startDate: filters.startDate,
            endDate: filters.endDate,
            campaignId: filters.campaignId,
            campaignName: selectedCampaign?.name || selectedAdGroup?.campaignName,
            adGroupId: filters.adGroupId,
            adGroupName: selectedAdGroup?.name
        });
        const stamp = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="lead-review-${stamp}.csv"`);
        res.setHeader('X-Lead-Review-Rows', String(result.rowCount));
        res.send(result.csv);
    } catch (err: any) {
        console.error('Failed to export lead review CSV:', err);
        const statusCode = err instanceof LeadValidationError || err?.name === 'LeadValidationError' ? 400 : 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// API: Manually update deduped lead quality status
app.get('/api/leads/session/:sessionKey', authenticateDashboard, async (req: Request, res: Response) => {
    try {
        const lead = await getLeadSessionByKey(pool, routeParam(req.params.sessionKey));
        if (!lead) {
            res.status(404).json({ error: 'Lead session not found.' });
            return;
        }
        res.json({ lead });
    } catch (err: any) {
        const statusCode = err instanceof LeadValidationError || err?.name === 'LeadValidationError' ? 400 : 500;
        res.status(statusCode).json({ error: err.message || 'Failed to load lead.' });
    }
});

app.post('/api/leads/:sessionKey/status', ...authenticateDashboardMutation, async (req: Request, res: Response) => {
    try {
        const result = await recordLeadStatus(pool, {
            sessionKey: routeParam(req.params.sessionKey),
            status: req.body?.status,
            note: req.body?.note || null,
            baseUpdatedAt: req.body?.baseUpdatedAt || null
        });
        if (result.conflict) {
            res.status(409).json({
                error: 'Lead status changed on the server.',
                conflict: result.conflict
            });
            return;
        }
        clearDashboardViewPayloadCache();
        res.json({ message: 'Lead status updated successfully.', status: result.status, updatedAt: result.updatedAt });
    } catch (err: any) {
        console.error('Failed to update lead status:', err);
        const statusCode = err instanceof LeadValidationError || err?.name === 'LeadValidationError'
            ? String(err.message || '').startsWith('Lead session not found:')
                ? 404
                : 400
            : 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// API: Create a deterministic semantic memory row. Embeddings are stored separately.
app.post('/api/memories', authenticate, async (req: Request, res: Response) => {
    try {
        assertSemanticMemoryAvailable();
        const memory = await createMemory(pool, req.body || {});
        res.status(201).json({ message: 'Memory created successfully.', memory });
    } catch (err: any) {
        sendSemanticMemoryError(res, err);
    }
});

// API: Store an externally generated embedding for an active memory.
app.post('/api/memories/:id/embedding', authenticate, async (req: Request, res: Response) => {
    try {
        assertSemanticMemoryAvailable();
        const embedding = await storeMemoryEmbedding(pool, {
            ...(req.body || {}),
            memory_id: req.params.id
        });
        res.json({ message: 'Memory embedding stored successfully.', embedding });
    } catch (err: any) {
        sendSemanticMemoryError(res, err);
    }
});

// API: Batched, tenant-scoped semantic memory retrieval for external agents.
app.post('/api/memories/search', authenticate, async (req: Request, res: Response) => {
    try {
        assertSemanticMemoryAvailable();
        const result = await searchMemories(pool, req.body || {});
        res.json(result);
    } catch (err: any) {
        sendSemanticMemoryError(res, err);
    }
});

// API: Deactivate an outdated or superseded memory and remove its embeddings.
app.post('/api/memories/:id/deactivate', authenticate, async (req: Request, res: Response) => {
    try {
        assertSemanticMemoryAvailable();
        const result = await deactivateMemory(pool, {
            ...(req.body || {}),
            memory_id: req.params.id
        });
        res.json({ message: 'Memory deactivated successfully.', ...result });
    } catch (err: any) {
        sendSemanticMemoryError(res, err);
    }
});

// API: Link a narrower memory as an exception to a broader active memory.
app.post('/api/memories/link-exception', authenticate, async (req: Request, res: Response) => {
    try {
        assertSemanticMemoryAvailable();
        const memory = await linkMemoryException(pool, req.body || {});
        res.json({ message: 'Memory exception linked successfully.', memory });
    } catch (err: any) {
        sendSemanticMemoryError(res, err);
    }
});

// API: Read Auction Insights Google Sheet settings and currently known account/campaign/ad-group entities
app.get('/api/auction-insights/settings', authenticateDashboard, async (req: Request, res: Response) => {
    try {
        const filters = await resolveDashboardFilters(pool, req.query as Record<string, any>);
        const filterOptions = await getAvailableDashboardFilters(pool, filters.customerId);
        const dashboardData = {
            meta: { accountId: filters.customerId },
            campaigns: filterOptions.campaigns,
            adGroups: filterOptions.adGroups
        };
        const entities = buildAuctionInsightsEntities(dashboardData || {});
        const settings = await getAuctionInsightsSettings(pool);
        res.json({
            sheetsRefreshTokenConfigured: Boolean(process.env.GOOGLE_SHEETS_REFRESH_TOKEN),
            entities,
            settings
        });
    } catch (err: any) {
        console.error('Failed to load Auction Insights settings:', err);
        res.status(500).json({ error: err.message });
    }
});

// API: Save Auction Insights Google Sheet settings
app.put('/api/auction-insights/settings', ...authenticateDashboardMutation, async (req: Request, res: Response) => {
    try {
        const settings = Array.isArray(req.body?.settings) ? req.body.settings : null;
        if (!settings) return res.status(400).json({ error: 'Request body must include settings array.' });
        const saved = await upsertAuctionInsightsSettings(pool, settings);
        res.json({ message: 'Auction Insights settings saved.', settings: saved });
    } catch (err: any) {
        console.error('Failed to save Auction Insights settings:', err);
        res.status(400).json({ error: err.message });
    }
});

// API: Generate Keyword Planner ideas from seed keywords and/or a URL.
app.post('/api/keyword-planner/ideas', ...authenticateDashboardMutation, async (req: Request, res: Response) => {
    try {
        const ideas = await runKeywordPlannerIdeas(req.body || {});
        res.json({ ideas });
    } catch (err: any) {
        console.error('Failed to fetch Keyword Planner ideas:', err);
        const statusCode = err instanceof KeywordPlannerValidationError || err?.name === 'KeywordPlannerValidationError' ? 400 : 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// API: Fetch Keyword Planner historical metrics for explicit keywords.
app.post('/api/keyword-planner/historical-metrics', ...authenticateDashboardMutation, async (req: Request, res: Response) => {
    try {
        const historicalMetrics = await runKeywordPlannerHistoricalMetrics(req.body || {});
        res.json({ historicalMetrics });
    } catch (err: any) {
        console.error('Failed to fetch Keyword Planner historical metrics:', err);
        const statusCode = err instanceof KeywordPlannerValidationError || err?.name === 'KeywordPlannerValidationError' ? 400 : 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// API: Trigger a background refresh. Only marked App/browser reloads default to
// today; Data-button, cron, and direct requests retain the rolling/backfill window.
// Dashboard sessions use CSRF while cron/direct clients use admin bearer auth.
app.post('/api/trigger-refresh', ...authenticateRefreshMutation, async (req: Request, res: Response) => {
    try {
        console.log('Triggering background refresh with payload:', req.body);
        const force = normalizeBoolean(req.body?.force);
        const refreshRequest = resolveTriggerRefreshRequest(req.body, { force });
        const result = await startRefreshJob({
            startDate: refreshRequest.startDate,
            endDate: refreshRequest.endDate,
            force,
            source: refreshRequest.lightClientRefresh
                ? CLIENT_TODAY_REFRESH_SOURCE
                : refreshRequest.scheduledCronRefresh ? CRON_REFRESH_SOURCE : 'api',
            kind: refreshRequest.lightClientRefresh ? 'manual' : refreshRequest.scheduledCronRefresh ? 'cron' : undefined
        });
        if (shouldRunCronCooldownLightRefresh(refreshRequest, result)) {
            const lightRequest = resolveTriggerRefreshRequest({ refreshProfile: 'light_today' }, { force: true });
            const lightResult = await startRefreshJob({
                startDate: lightRequest.startDate,
                endDate: lightRequest.endDate,
                force: true,
                source: CRON_COOLDOWN_TODAY_REFRESH_SOURCE,
                kind: 'cron'
            });
            res.status(202).json({
                ...lightResult,
                refreshProfile: lightResult.status === 'started' ? 'light_today' : undefined,
                message: lightResult.status === 'started'
                    ? 'Full cron refresh is inside its cooldown; today-only light refresh started.'
                    : lightResult.message,
                fullRefreshCooldown: {
                    active: true,
                    nextAllowedAt: result.nextAllowedAt,
                    cooldownRemainingMs: result.cooldownRemainingMs
                }
            });
            return;
        }
        res.status(202).json(result);
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

// API: Cloud MCP endpoint. All tools are registered in backend/lib/mcp/toolRegistry.ts.
const mcpToolRegistry = createMcpToolRegistry({
    pool,
    getDashboardPayload,
    startRefreshJob,
    assertSemanticMemoryAvailable
});

function mcpSessionIdFromHeader(req: Request): string | null {
    const raw = req.headers['x-mcp-session-id'];
    const sessionId = typeof raw === 'string' ? raw.trim() : '';
    if (!sessionId) return null;
    if (!isMcpSessionId(sessionId)) throw invalidParams('X-MCP-Session-Id must be a UUID.');
    return sessionId;
}

function mcpEndpointErrorStatus(err: any): number {
    if (Number.isInteger(err?.statusCode)) return err.statusCode;
    if (err instanceof SemanticMemoryValidationError
        || err?.name === 'SemanticMemoryValidationError'
        || err instanceof SemanticMemoryConflictError
        || err?.name === 'SemanticMemoryConflictError'
        || err instanceof SemanticMemoryNotFoundError
        || err?.name === 'SemanticMemoryNotFoundError'
        || err instanceof SemanticMemoryConfigurationError
        || err?.name === 'SemanticMemoryConfigurationError') {
        return semanticMemoryStatusCode(err);
    }
    if (err instanceof GoogleAdsMutationValidationError || err?.name === 'GoogleAdsMutationValidationError') return googleAdsMutationStatusCode(err);
    if (err instanceof DashboardPayloadValidationError || err?.name === 'DashboardPayloadValidationError' || err instanceof WarehouseDataNotFoundError || err?.name === 'WarehouseDataNotFoundError') return dashboardErrorStatus(err);
    if (err instanceof ProposalValidationError || err?.name === 'ProposalValidationError' || err instanceof KeywordPlannerValidationError || err?.name === 'KeywordPlannerValidationError') return 400;
    if (String(err?.message || '').startsWith('Proposal not found:') || String(err?.message || '').startsWith('Proposal feedback not found:')) return 404;
    return 500;
}

app.post('/api/mcp', async (req: Request, res: Response) => {
    let rpc: { id: any; method: string; params: Record<string, any> } | null = null;
    let apiKey: ReturnType<typeof resolveMcpApiKey> | null = null;
    try {
        rpc = requireJsonRpcRequest(req.body);
        apiKey = resolveMcpApiKey(req);
        await ensureMcpCoreSchema(pool);

        if (rpc.method === 'initialize') {
            const negotiatedProtocolVersion = negotiateMcpProtocolVersion(rpc.params?.protocolVersion);
            if (!negotiatedProtocolVersion) {
                const err = invalidParams(unsupportedMcpProtocolMessage(rpc.params?.protocolVersion));
                return res.status(err.statusCode).json(jsonRpcError(rpc.id, err));
            }
            const sessionId = mcpSessionIdFromHeader(req) || newMcpSessionId();
            const clientName = typeof rpc.params?.clientInfo?.name === 'string' ? rpc.params.clientInfo.name : null;
            await initializeMcpSession(pool, { sessionId, apiKey, clientName, protocolVersion: negotiatedProtocolVersion });
            res.setHeader('X-MCP-Session-Id', sessionId);
            return res.json(jsonRpcSuccess(rpc.id, {
                protocolVersion: negotiatedProtocolVersion,
                capabilities: MCP_SERVER_CAPABILITIES,
                serverInfo: MCP_SERVER_INFO,
                instructions: MCP_SERVER_INSTRUCTIONS
            }));
        }

        const sessionId = mcpSessionIdFromHeader(req);
        if (!sessionId) throw notInitialized();

        if (rpc.method === 'notifications/initialized') {
            await markMcpSessionInitialized(pool, sessionId, apiKey);
            return res.status(204).send();
        }

        const session = await loadInitializedMcpSession(pool, sessionId, apiKey);

        if (rpc.method === 'tools/list') {
            return res.json(jsonRpcSuccess(rpc.id, mcpToolsPage(mcpToolRegistry, rpc.params?.cursor)));
        }

        if (rpc.method === 'tools/call') {
            const name = String(rpc.params?.name || '').trim();
            const args = rpc.params?.arguments && typeof rpc.params.arguments === 'object' ? rpc.params.arguments : {};
            const tool = mcpToolRegistry.get(name);
            if (!tool) throw methodNotFound(name || 'tools/call:<missing tool name>');
            const started = Date.now();
            try {
                validateToolArguments(tool, args);
                requireMcpToolPolicy(tool, apiKey, session);
                await checkMcpRateLimits(pool, tool, session, apiKey);
                const output = await tool.handler({ pool, session, apiKey, arguments: args, request: req });
                await recordMcpToolAudit(pool, {
                    session,
                    apiKey,
                    tool,
                    args,
                    status: 'success',
                    durationMs: Date.now() - started,
                    resultSummary: output.resultSummary,
                    googleRequestId: output.googleRequestId || null
                });
                return res.json(jsonRpcSuccess(rpc.id, {
                    content: output.content || [],
                    structuredContent: output.structuredContent,
                    isError: false
                }));
            } catch (err: any) {
                await recordMcpToolAudit(pool, {
                    session,
                    apiKey,
                    tool,
                    args,
                    status: 'error',
                    durationMs: Date.now() - started,
                    errorMessage: err?.message || String(err)
                }).catch(() => undefined);
                throw err;
            }
        }

        throw methodNotFound(rpc.method);
    } catch (err: any) {
        console.error('MCP endpoint error:', err?.message || err);
        const id = rpc?.id ?? req.body?.id ?? null;
        const status = mcpEndpointErrorStatus(err);
        return res.status(status).json(jsonRpcError(id, err));
    }
});

if (serveDashboardClient) {
    const sendClientFile = (res: Response, relativePath: string, cacheControl = 'public, max-age=3600') => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cache-Control', cacheControl);
        res.sendFile(path.join(dashboardClientPath, relativePath));
    };

    app.get('/logo.png', (_req: Request, res: Response) => {
        sendClientFile(res, 'logo.png', 'public, max-age=0, must-revalidate');
    });
    app.get('/manifest.webmanifest', (_req: Request, res: Response) => {
        res.type('application/manifest+json');
        sendClientFile(res, 'manifest.webmanifest', 'no-cache');
    });
    app.get('/sw.js', (_req: Request, res: Response) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Service-Worker-Allowed', '/');
        res.setHeader('Cache-Control', 'no-cache');
        res.type('application/javascript').sendFile(path.join(dashboardClientPath, 'sw.js'));
    });
    app.get(['/styles.css', '/app.js', '/offline.js'], (req: Request, res: Response) => {
        sendClientFile(res, req.path.replace(/^\//, ''), 'no-cache');
    });
    const publicAssetFiles = {
        vendor: new Set([
            'ag-grid-community.min.js',
            'chart.umd.min.js',
            'chartjs-chart-sankey.min.js',
            'daterangepicker.css',
            'daterangepicker.js',
            'idb.umd.js',
            'jquery.min.js',
            'moment.min.js'
        ]),
        fonts: new Set([
            'fonts.css',
            'inter-latin-300-normal.woff2',
            'inter-latin-400-normal.woff2',
            'inter-latin-500-normal.woff2',
            'inter-latin-600-normal.woff2',
            'inter-latin-700-normal.woff2',
            'outfit-latin-400-normal.woff2',
            'outfit-latin-500-normal.woff2',
            'outfit-latin-600-normal.woff2',
            'outfit-latin-700-normal.woff2'
        ]),
        icons: new Set([
            'apple-touch-icon.png',
            'badge-72.png',
            'icon-192-maskable.png',
            'icon-192.png',
            'icon-512-maskable.png',
            'icon-512.png'
        ])
    };
    for (const [directory, allowlist] of Object.entries(publicAssetFiles)) {
        app.get(`/${directory}/:file`, (req: Request, res: Response) => {
            const file = routeParam(req.params.file);
            if (!allowlist.has(file)) {
                res.status(404).send('Public asset not found.');
                return;
            }
            // Filenames are stable rather than content-hashed. Revalidate them so a
            // dependency upgrade cannot strand an installed PWA on old JavaScript.
            sendClientFile(res, `${directory}/${file}`, 'public, max-age=0, must-revalidate');
        });
    }

    // The dashboard uses hash/query navigation, so only the root app shell is public.
    app.get('/', (_req: Request, res: Response) => {
        const indexPath = path.join(dashboardClientPath, 'index.html');
        if (fs.existsSync(indexPath)) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.setHeader('Referrer-Policy', 'no-referrer');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader(
                'Content-Security-Policy',
                "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self'; manifest-src 'self'; object-src 'none'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'"
            );
            res.sendFile(indexPath);
        } else {
            res.status(404).send('Dashboard client build not found.');
        }
    });
}

initDB()
    .then(() => {
        httpServer = app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
            void startBackgroundRefreshAfterServerIsHealthy();
        });
    })
    .catch(async () => {
        startupRefreshChild?.kill('SIGTERM');
        refreshQueueWorker?.stop();
        pushDeliveryWorker?.stop();
        await pool.end().catch(() => undefined);
        process.exitCode = 1;
    });
