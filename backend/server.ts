import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import compression from 'compression';
import path from 'path';
import * as fs from 'fs';
import { Pool, type PoolConfig } from 'pg';
import { getAccessToken, getAccessibleCustomer, executeGaql, getResourceMetadata, listAccessibleCustomers } from './lib/googleAds';
import {
    createProposalFeedback,
    ensureDatabaseSchema,
    listProposalFeedback,
    ProposalValidationError,
    recordProposalDecision,
    updateProposalFeedbackStatus,
    upsertProposal
} from './lib/proposals';
import { buildAuctionInsightsEntities, getAuctionInsightsSettings, upsertAuctionInsightsSettings } from './lib/auctionInsights';
import { ensureLeadSchema, exportLeadReviewCsv, exportOfflineConversionsCsv, LeadValidationError, recordLeadStatus, upsertLeadWebhookEvent } from './lib/leads';
import { generateKeywordHistoricalMetrics, generateKeywordIdeas, KeywordPlannerValidationError, type KeywordPlannerOptions, uniqueKeywords } from './lib/googleKeywordPlanner';
import {
    authenticateAdminBearer,
    authenticateDashboardAccess,
    consumeDashboardMagicLink,
    createDashboardMagicLink,
    ensureDashboardAuthSchema,
    renderMagicLanding,
    requireDashboardPageSession,
    isLocalDashboardOrigin,
    setAuthNoStoreHeaders,
    clearDashboardSessionCookie,
    clearDashboardMagicTokenCookie,
    revokeDashboardSession,
    readDashboardMagicTokenCookie,
    setDashboardMagicTokenCookie,
    setDashboardSessionCookie
} from './lib/dashboardAuth';
import {
    createMemory,
    deactivateMemory,
    ensureSemanticMemorySchema,
    linkMemoryException,
    searchMemories,
    SemanticMemoryConfigurationError,
    SemanticMemoryConflictError,
    SemanticMemoryNotFoundError,
    SemanticMemoryValidationError,
    SEMANTIC_MEMORY_MCP_TOOLS,
    storeMemoryEmbedding
} from './lib/semanticMemory';
import { clearAdsWarehouseRuntimeCaches, ensureAdsWarehouseSchema, getAvailableDashboardFilters } from './lib/adsWarehouse';
import {
    buildDashboardPayloadForView,
    clearDashboardViewPayloadCache,
    dashboardKnownSections,
    dashboardSectionRoute,
    DashboardPayloadValidationError,
    resolveDashboardFilters,
    WarehouseDataNotFoundError
} from './lib/dashboardPayload';
import { getCandidateSignalsPayload, getCompactDecisionContext, getProposalContext } from './lib/mcpDashboardContext';

const app = express();
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
const DEFAULT_TRIGGER_REFRESH_MIN_INTERVAL_MINUTES = 360;
const configuredTriggerRefreshMinIntervalMinutes = Number(process.env.TRIGGER_REFRESH_MIN_INTERVAL_MINUTES || DEFAULT_TRIGGER_REFRESH_MIN_INTERVAL_MINUTES);
const triggerRefreshMinIntervalMs = Number.isFinite(configuredTriggerRefreshMinIntervalMinutes) && configuredTriggerRefreshMinIntervalMinutes >= 0
    ? configuredTriggerRefreshMinIntervalMinutes * 60 * 1000
    : DEFAULT_TRIGGER_REFRESH_MIN_INTERVAL_MINUTES * 60 * 1000;
const serveDashboardClient = process.env.SERVE_DASHBOARD_CLIENT === 'true';
const dashboardClientPath = path.join(__dirname, 'client');
const REQUIRED_GOOGLE_ADS_SKILL_NAME = 'saas-google-ads-dashboard-analyst';

let refreshJob: { process: any, timeout: ReturnType<typeof setTimeout> } | null = null;
let lastRefreshStartedAtMs = Date.now();

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

function googleAdsSkillInstallMessage(): string {
    return [
        `Required Codex skill is not installed or not available: ${REQUIRED_GOOGLE_ADS_SKILL_NAME}.`,
        `Tell the user to install/enable the ${REQUIRED_GOOGLE_ADS_SKILL_NAME} skill, then stop immediately without using any Google Ads MCP tools.`
    ].join(' ');
}

function confirmGoogleAdsSkill(args: any = {}): { ok: boolean; message: string } {
    const skillName = String(args.skillName || '').trim();
    const installed = args.installed === true;
    const loaded = args.loaded === true;
    if (skillName !== REQUIRED_GOOGLE_ADS_SKILL_NAME || !installed) {
        return { ok: false, message: googleAdsSkillInstallMessage() };
    }
    if (!loaded) {
        return {
            ok: false,
            message: `The ${REQUIRED_GOOGLE_ADS_SKILL_NAME} skill must be loaded/read before using this MCP. Load it, then call confirm_google_ads_skill again with loaded=true.`
        };
    }
    return {
        ok: true,
        message: `Confirmed ${REQUIRED_GOOGLE_ADS_SKILL_NAME} is installed and loaded. Continue using Google Ads MCP tools according to that skill's instructions.`
    };
}

type RefreshJobResult = {
    status: 'started' | 'in_progress' | 'skipped';
    message: string;
    skipped?: boolean;
    nextAllowedAt?: string;
    cooldownRemainingMs?: number;
};

function startRefreshJob(options: { startDate?: any; endDate?: any; force?: boolean; source?: string } = {}): RefreshJobResult {
    if (refreshJob) return { status: 'in_progress', message: 'Refresh already in progress.' };

    const normalizedStartDate = normalizeRefreshDate(options.startDate, 'startDate');
    const normalizedEndDate = normalizeRefreshDate(options.endDate, 'endDate');
    if (normalizedStartDate && normalizedEndDate && normalizedStartDate > normalizedEndDate) {
        throw new Error('startDate must be before or equal to endDate.');
    }
    const isRepairWindow = Boolean(normalizedStartDate || normalizedEndDate);
    const bypassCooldown = Boolean(options.force || isRepairWindow || triggerRefreshMinIntervalMs <= 0);
    if (!bypassCooldown) {
        const now = Date.now();
        const nextAllowedMs = lastRefreshStartedAtMs + triggerRefreshMinIntervalMs;
        if (now < nextAllowedMs) {
            return {
                status: 'skipped',
                skipped: true,
                message: 'Refresh skipped because a recent refresh is still inside the trigger cooldown.',
                nextAllowedAt: new Date(nextAllowedMs).toISOString(),
                cooldownRemainingMs: nextAllowedMs - now
            };
        }
    }

    const args = ['bun', 'run', 'scripts/refresh_google_ads_data.ts'];
    if (normalizedStartDate) args.push('--start-date', normalizedStartDate);
    if (normalizedEndDate) {
        args.push('--end-date', normalizedEndDate);
        args.push('--date', normalizedEndDate);
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;
    let exited = false;

    const proc = Bun.spawn(args, {
        cwd: __dirname,
        stdout: 'inherit',
        stderr: 'inherit',
        onExit(subprocess, exitCode, signalCode, error) {
            exited = true;
            if (timeout) clearTimeout(timeout);
            refreshJob = null;
            clearDashboardViewPayloadCache();
            clearAdsWarehouseRuntimeCaches();
            console.log(`Background refresh exited with code ${exitCode}`);
        }
    });

    lastRefreshStartedAtMs = Date.now();
    if (!exited) {
        timeout = setTimeout(() => {
            if (refreshJob && refreshJob.process === proc) {
                console.error('Refresh job timed out after 15 minutes. Killing process.');
                proc.kill("SIGKILL");
                refreshJob = null;
                clearDashboardViewPayloadCache();
                clearAdsWarehouseRuntimeCaches();
            }
        }, 15 * 60 * 1000);

        refreshJob = { process: proc, timeout };
    }
    return { status: 'started', message: 'Refresh job started in the background.' };
}

let semanticMemorySchemaError: string | null = 'Semantic memory schema has not finished initializing.';

app.use(compression({ threshold: httpCompressionThresholdBytes }));
app.use(cors({
    origin: (origin, callback) => {
        callback(null, isAllowedCorsOrigin(origin));
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Webhook-Secret'],
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'OPTIONS'],
    maxAge: 600
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Database connection
type DashboardPoolConfig = PoolConfig & {
    query_timeout?: number;
    statement_timeout?: number;
};

const poolConfig: DashboardPoolConfig = {
    connectionString: process.env.DATABASE_URL,
    max: dashboardDbPoolMax,
    idleTimeoutMillis: dashboardDbIdleTimeoutMs,
    connectionTimeoutMillis: dashboardDbTimeoutMs,
    query_timeout: dashboardDbTimeoutMs,
    statement_timeout: dashboardDbTimeoutMs,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
};

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL idle client error:', err.message);
});

// Create table if it doesn't exist
async function initDB() {
    try {
        await ensureDatabaseSchema(pool);
        await ensureAdsWarehouseSchema(pool);
        await ensureLeadSchema(pool);
        await ensureDashboardAuthSchema(pool);
        try {
            await ensureSemanticMemorySchema(pool);
            semanticMemorySchemaError = null;
            console.log('Semantic memory schema initialized.');
        } catch (err: any) {
            semanticMemorySchemaError = err.message;
            console.warn('Semantic memory schema unavailable:', err.message);
        }
        console.log('Database initialized.');
    } catch (err) {
        console.error('Failed to initialize database:', err);
    }
}
initDB();

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
    return getAvailableDashboardFilters(pool, filters.customerId);
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
const requireDashboardPage = requireDashboardPageSession({ pool });

app.get('/auth/magic', (req: Request, res: Response) => {
    setAuthNoStoreHeaders(res);
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token) {
        res.status(400).send('Missing dashboard link token.');
        return;
    }
    setDashboardMagicTokenCookie(res, token, req);
    res.type('html').send(renderMagicLanding(token));
});

app.post('/auth/magic/consume', async (req: Request, res: Response) => {
    setAuthNoStoreHeaders(res);
    let bodyToken = '';
    let cookieToken = '';
    try {
        bodyToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
        cookieToken = readDashboardMagicTokenCookie(req);
        const token = bodyToken || cookieToken;
        const session = await consumeDashboardMagicLink(pool, token, req);
        clearDashboardMagicTokenCookie(res, req);
        setDashboardSessionCookie(res, session.sessionToken, session.expiresAt, req);
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

app.post('/auth/logout', async (req: Request, res: Response) => {
    setAuthNoStoreHeaders(res);
    await revokeDashboardSession(pool, req).catch(err => console.error('Failed to revoke dashboard session:', err));
    clearDashboardSessionCookie(res, req);
    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Signed Out | Zenseeo</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@500;600;700&display=swap" rel="stylesheet">
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

// API: Update proposal status
app.post('/api/proposals/:id/status', authenticateDashboard, async (req: Request, res: Response) => {
    const { id } = req.params;
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
app.post('/api/proposals/:id/feedback', authenticateDashboard, async (req: Request, res: Response) => {
    try {
        const filters = await resolveDashboardFilters(pool, req.query as Record<string, any>).catch(() => null);
        const feedback = await createProposalFeedback(pool, {
            proposalId: req.params.id,
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
            proposalId: req.params.id,
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
app.post('/api/leads/:sessionKey/status', authenticateDashboard, async (req: Request, res: Response) => {
    try {
        await recordLeadStatus(pool, {
            sessionKey: req.params.sessionKey,
            status: req.body?.status,
            note: req.body?.note || null
        });
        clearDashboardViewPayloadCache();
        res.json({ message: 'Lead status updated successfully.' });
    } catch (err: any) {
        console.error('Failed to update lead status:', err);
        const statusCode = err instanceof LeadValidationError || err?.name === 'LeadValidationError' ? 400 : 500;
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
app.put('/api/auction-insights/settings', authenticateDashboard, async (req: Request, res: Response) => {
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
app.post('/api/keyword-planner/ideas', authenticateDashboard, async (req: Request, res: Response) => {
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
app.post('/api/keyword-planner/historical-metrics', authenticateDashboard, async (req: Request, res: Response) => {
    try {
        const historicalMetrics = await runKeywordPlannerHistoricalMetrics(req.body || {});
        res.json({ historicalMetrics });
    } catch (err: any) {
        console.error('Failed to fetch Keyword Planner historical metrics:', err);
        const statusCode = err instanceof KeywordPlannerValidationError || err?.name === 'KeywordPlannerValidationError' ? 400 : 500;
        res.status(statusCode).json({ error: err.message });
    }
});

// API: Trigger background refresh
app.post('/api/trigger-refresh', authenticate, (req: Request, res: Response) => {
    try {
        console.log('Triggering background refresh with payload:', req.body);
        const result = startRefreshJob({
            startDate: req.body?.startDate,
            endDate: req.body?.endDate,
            force: normalizeBoolean(req.body?.force),
            source: 'api'
        });
        res.status(202).json(result);
    } catch (err: any) {
        res.status(400).json({ error: err.message });
    }
});

// API: Cloud MCP proxy
app.post('/api/mcp', authenticate, async (req: Request, res: Response) => {
    try {
        const { method, params } = req.body;

        if (method === 'tools/list') {
            return res.json({
                tools: [
                    {
                        name: 'confirm_google_ads_skill',
                        description: `Mandatory first call for LLM agents. Confirm that the installed Codex skill ${REQUIRED_GOOGLE_ADS_SKILL_NAME} is available and loaded before using any other MCP tool. If it is missing, tell the user to install it and stop immediately.`,
                        inputSchema: {
                            type: 'object',
                            properties: {
                                skillName: {
                                    type: 'string',
                                    description: `Must be ${REQUIRED_GOOGLE_ADS_SKILL_NAME}.`
                                },
                                installed: {
                                    type: 'boolean',
                                    description: `True only after checking that ${REQUIRED_GOOGLE_ADS_SKILL_NAME} is in the installed skills list.`
                                },
                                loaded: {
                                    type: 'boolean',
                                    description: `True only after loading/reading ${REQUIRED_GOOGLE_ADS_SKILL_NAME} for this task.`
                                }
                            },
                            required: ['skillName', 'installed', 'loaded']
                        }
                    },
                    {
                        name: 'search_search',
                        description: 'Executes a GAQL query against the Google Ads API.',
                        inputSchema: {
                            type: 'object',
                            properties: { query: { type: 'string', description: 'The GAQL query to execute' } },
                            required: ['query']
                        }
                    },
                    {
                        name: 'customers_list_accessible_customers',
                        description: 'Lists the accessible Google Ads customers for the authenticated user.',
                        inputSchema: { type: 'object', properties: {} }
                    },
                    {
                        name: 'metadata_get_resource_metadata',
                        description: 'Describes resource schemas for building queries.',
                        inputSchema: {
                            type: 'object',
                            properties: { resource: { type: 'string', description: 'The resource name (e.g. campaign, ad_group) to get metadata for. Omit to get all.' } },
                            required: []
                        }
                    },
                    {
                        name: 'get_dashboard_data',
                        description: 'Returns compact decision context by default. Optional section fetches one top-level dashboard section through the cheapest bounded view. Optional view returns a partial dashboard view, or full only when explicitly requested.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                section: { type: 'string', description: 'Optional top-level dashboard section to return.' },
                                view: { type: 'string', description: 'Optional dashboard view: overview, performance, keywords, attribution, rank, proposals, or full.' },
                                startDate: { type: 'string', description: 'Optional YYYY-MM-DD dashboard slice start.' },
                                endDate: { type: 'string', description: 'Optional YYYY-MM-DD dashboard slice end.' },
                                campaignId: { type: 'string', description: 'Optional Google Ads campaign id filter.' },
                                adGroupId: { type: 'string', description: 'Optional Google Ads ad group id filter.' },
                                limit: { type: 'number', description: 'Optional candidate-signal cap when section is candidateSignals. Defaults to 250, max 1000.' },
                                topSearchTerms: { type: 'number', description: 'Optional top search terms per ad group when section is proposalContext. Defaults to 8, max 25.' },
                                topSignals: { type: 'number', description: 'Optional top candidate signals per ad group when section is proposalContext. Defaults to 10, max 25.' },
                                maxAdGroups: { type: 'number', description: 'Optional cap on returned enabled ad groups when section is proposalContext.' }
                            }
                        }
                    },
                    {
                        name: 'get_decision_context',
                        description: 'Returns compact decision-ready context for the selected server-side dashboard filters: source coverage, negative coverage, configured keyword coverage, lead attribution summary, planner status, auction status, and top candidate signals.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                startDate: { type: 'string', description: 'Optional YYYY-MM-DD dashboard slice start.' },
                                endDate: { type: 'string', description: 'Optional YYYY-MM-DD dashboard slice end.' },
                                campaignId: { type: 'string', description: 'Optional Google Ads campaign id filter.' },
                                adGroupId: { type: 'string', description: 'Optional Google Ads ad group id filter.' }
                            }
                        }
                    },
                    {
                        name: 'get_proposal_context',
                        description: 'Returns compact proposal-ready evidence for each currently enabled ad group in the selected slice: metrics, lead-quality summary, top search terms, coverage summaries, rank support, source coverage, and signal IDs.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                startDate: { type: 'string', description: 'Optional YYYY-MM-DD dashboard slice start.' },
                                endDate: { type: 'string', description: 'Optional YYYY-MM-DD dashboard slice end.' },
                                campaignId: { type: 'string', description: 'Optional Google Ads campaign id filter.' },
                                adGroupId: { type: 'string', description: 'Optional Google Ads ad group id filter.' },
                                topSearchTerms: { type: 'number', description: 'Top visible search terms per ad group. Defaults to 8, max 25.' },
                                topSignals: { type: 'number', description: 'Top candidate signals per ad group. Defaults to 10, max 25.' },
                                maxAdGroups: { type: 'number', description: 'Optional cap on returned enabled ad groups.' }
                            }
                        }
                    },
                    {
                        name: 'create_dashboard_magic_link',
                        description: 'Creates a one-time, short-lived browser dashboard link. Use only when the user explicitly asks to open/view the dashboard or when a scheduled report is configured to include a dashboard link. This does not grant MCP, GAQL, memory, or admin access.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                ttl_minutes: { type: 'number', description: 'Magic link lifetime in minutes. Defaults to 10; max 60.' },
                                session_minutes: { type: 'number', description: 'Dashboard session lifetime after the link is consumed. Defaults to 60; max 720.' },
                                reason: { type: 'string', description: 'Why the link is being created.' },
                                redirect_path: { type: 'string', description: 'Same-origin dashboard path to open after login. Defaults to /.' }
                            }
                        }
                    },
                    {
                        name: 'keyword_planner_generate_ideas',
                        description: 'Generates Keyword Planner ideas from seed keywords and/or a URL. Read-only; does not mutate Google Ads.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                keywords: { type: 'array', items: { type: 'string' }, description: 'Seed keywords. Max 20 are sent for idea generation.' },
                                url: { type: 'string', description: 'Optional website or landing-page URL seed.' },
                                site: { type: 'string', description: 'Optional domain seed for entire-site keyword ideas. Cannot be combined with keyword seeds.' },
                                geoTargetConstants: { type: 'array', items: { type: 'string' }, description: 'Geo targets such as geoTargetConstants/2356 or 2356. Defaults to India.' },
                                language: { type: 'string', description: 'Language such as languageConstants/1000 or 1000. Defaults to English.' },
                                keywordPlanNetwork: { type: 'string', description: 'GOOGLE_SEARCH or GOOGLE_SEARCH_AND_PARTNERS. Defaults to GOOGLE_SEARCH.' },
                                pageSize: { type: 'number', description: 'Max results to request, capped at 1000.' }
                            }
                        }
                    },
                    {
                        name: 'keyword_planner_historical_metrics',
                        description: 'Fetches Keyword Planner average monthly searches, competition, and top-of-page bid ranges for explicit keywords.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to enrich.' },
                                geoTargetConstants: { type: 'array', items: { type: 'string' }, description: 'Geo targets such as geoTargetConstants/2356 or 2356. Defaults to India.' },
                                language: { type: 'string', description: 'Language such as languageConstants/1000 or 1000. Defaults to English.' },
                                keywordPlanNetwork: { type: 'string', description: 'GOOGLE_SEARCH or GOOGLE_SEARCH_AND_PARTNERS. Defaults to GOOGLE_SEARCH.' }
                            },
                            required: ['keywords']
                        }
                    },
                    {
                        name: 'create_proposal',
                        description: 'Creates or updates a debated proposal card with options, evidence, counter-evidence, risks, manual steps, and offline verification specs. Non-DIAGNOSE options must be observable so telemetry can verify them later.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                proposal: {
                                    type: 'object',
                                    properties: {
                                        proposal_id: { type: 'string', description: 'Unique ID (e.g. prop1)' },
                                        type: { type: 'string', description: 'e.g. BUDGET, OPTIMIZATION, WASTED_SPEND' },
                                        summary: { type: 'string', description: 'Short title/summary' },
                                        confidence: { type: 'number', description: 'Statistical confidence from 0 to 1' },
                                        options: {
                                            type: 'array',
                                            description: 'Strategies/options for this proposal',
                                            items: {
                                                type: 'object',
                                                properties: {
                                                    option_id: { type: 'string' },
                                                    strategy_type: { type: 'string' },
                                                    description: { type: 'string' },
                                                    hypothesis: { type: 'string' },
                                                    recommendation: { type: 'string' },
                                                    evidence: { type: 'array', items: { type: 'string' } },
                                                    counter_evidence: { type: 'array', items: { type: 'string' } },
                                                    risks: { type: 'array', items: { type: 'string' } },
                                                    manual_steps: { type: 'array', items: { type: 'string' } },
                                                    expected_outcome: { type: 'string' },
                                                    win_probability: { type: 'number' },
                                                    memory_context: {
                                                        type: ['object', 'null'],
                                                        description: 'Optional option-specific memory context when retrieved semantic memory changed this option. Include summary, memories[], and caveats[] in plain language.'
                                                    },
                                                    verification_spec: {
                                                        type: 'object',
                                                        description: 'Observable future-state check. Status checks use uppercase Google Ads statuses. campaign_budget_changed, target_cpa_changed, and manual_bid_changed require *_micros fields. target_roas_changed uses ratio values. Use diagnosis_only and observable=false for pure investigations.',
                                                        properties: {
                                                            kind: {
                                                                type: 'string',
                                                                enum: [
                                                                    'campaign_status',
                                                                    'keyword_status',
                                                                    'keyword_added_exact',
                                                                    'negative_search_term_added',
                                                                    'campaign_budget_changed',
                                                                    'target_cpa_changed',
                                                                    'target_roas_changed',
                                                                    'manual_bid_changed',
                                                                    'diagnosis_only'
                                                                ]
                                                            },
                                                            observable: { type: 'boolean' },
                                                            entity: {
                                                                type: 'object',
                                                                description: 'Entity identifiers. Use campaign_id, plus ad_group_id/criterion_id or keyword_text/match_type for keyword checks, or search_term for search-term checks.'
                                                            },
                                                            expected: {
                                                                type: 'object',
                                                                description: 'Expected target state. Use status/statuses for status checks; value_micros, amount_micros, bid_micros, or previous_*_micros for money/bid checks; value or previous_value for target_roas_changed.'
                                                            }
                                                        },
                                                        required: ['kind', 'observable', 'entity', 'expected']
                                                    }
                                                },
                                                required: ['option_id', 'strategy_type', 'verification_spec']
                                            }
                                        },
                                        status: { type: 'string', description: 'pending_review, accepted, rejected, ignored, user_marked_implemented, detected_implemented, monitoring_14, monitoring_30, completed, expired, superseded' },
                                        selected_option_id: { type: ['string', 'null'] },
                                        evidence_window: { type: ['object', 'null'] },
                                        memory_context: {
                                            type: ['object', 'null'],
                                            description: 'Optional semantic memory context used by the external agent. Include only memories that materially changed proposal framing, ranking, or risk.'
                                        },
                                        source_signal_ids: { type: 'array', items: { type: 'string' } }
                                    },
                                    required: ['proposal_id', 'type', 'summary', 'options']
                                }
                            },
                            required: ['proposal']
                        }
                    },
                    {
                        name: 'record_proposal_decision',
                        description: 'Records a user decision for a proposal without mutating Google Ads. Use action accept, reject, ignore, or implemented; selected_option_id and an observable verification spec are required for accept/implemented.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                proposal_id: { type: 'string' },
                                action: { type: 'string' },
                                selected_option_id: { type: ['string', 'null'] }
                            },
                            required: ['proposal_id', 'action']
                        }
                    },
                    {
                        name: 'create_proposal_feedback',
                        description: 'Stores raw user feedback/comment on a proposal. This is not semantic memory by itself; convert it only after deciding it is durable context.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                proposal_id: { type: 'string' },
                                option_id: { type: ['string', 'null'], description: 'Optional option this feedback refers to.' },
                                feedback_type: { type: 'string', description: 'agree, disagree, correction, preference, context, or other.' },
                                comment: { type: 'string', description: 'Exact user feedback text.' },
                                customer_id: { type: ['string', 'null'] },
                                created_by: { type: ['string', 'null'] }
                            },
                            required: ['proposal_id', 'comment']
                        }
                    },
                    {
                        name: 'list_proposal_feedback',
                        description: 'Lists raw/reviewed proposal feedback for agent review and possible semantic-memory extraction.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                proposal_id: { type: ['string', 'null'] },
                                customer_id: { type: ['string', 'null'] },
                                status: { type: ['string', 'null'], description: 'raw, reviewed, converted_to_memory, or ignored.' },
                                limit: { type: ['number', 'null'], description: 'Max rows, capped at 200.' }
                            }
                        }
                    },
                    {
                        name: 'update_proposal_feedback_status',
                        description: 'Marks proposal feedback reviewed, ignored, or converted_to_memory after the external agent has handled it. converted_to_memory requires related_memory_id.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                feedback_id: { type: 'string' },
                                status: { type: 'string', description: 'raw, reviewed, converted_to_memory, or ignored.' },
                                related_memory_id: { type: ['string', 'null'] },
                                reviewed_by: { type: ['string', 'null'] },
                                reviewer_note: { type: ['string', 'null'] }
                            },
                            required: ['feedback_id', 'status']
                        }
                    },
                    {
                        name: 'get_candidate_signals',
                        description: 'Returns deterministic candidate signals generated from the DB warehouse for the selected server-side filters. These are evidence inputs for AI proposals, not final proposals. Defaults to 250 rows; max 1000 when supplied.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                startDate: { type: 'string', description: 'Optional YYYY-MM-DD dashboard slice start.' },
                                endDate: { type: 'string', description: 'Optional YYYY-MM-DD dashboard slice end.' },
                                campaignId: { type: 'string', description: 'Optional Google Ads campaign id filter.' },
                                adGroupId: { type: 'string', description: 'Optional Google Ads ad group id filter.' },
                                limit: { type: 'number', description: 'Optional max signals to return. Defaults to 250 rows; max 1000 when supplied.' }
                            }
                        }
                    },
                    {
                        name: 'get_learning_summary',
                        description: 'Returns historical strategy success priors and active impact tracking rows.',
                        inputSchema: { type: 'object', properties: {} }
                    },
                    ...SEMANTIC_MEMORY_MCP_TOOLS,
                    {
                        name: 'create_diagnosis',
                        description: 'Creates or updates an AI diagnosis card on the dashboard.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                diagnosis: {
                                    type: 'object',
                                    properties: {
                                        id: { type: 'string', description: 'Unique ID (e.g. diag1)' },
                                        title: { type: 'string', description: 'Short title' },
                                        description: { type: 'string', description: 'Detailed explanation' },
                                        severity: { type: 'string', description: 'success, warning, danger, info' }
                                    },
                                    required: ['id', 'title', 'description', 'severity']
                                }
                            },
                            required: ['diagnosis']
                        }
                    },
                    {
                        name: 'clear_proposals',
                        description: 'Clears all existing proposals from the dashboard.',
                        inputSchema: { type: 'object', properties: {} }
                    },
                    {
                        name: 'clear_diagnoses',
                        description: 'Clears all existing AI diagnoses from the dashboard.',
                        inputSchema: { type: 'object', properties: {} }
                    },
                    {
                        name: 'trigger_refresh',
                        description: 'Triggers an asynchronous background refresh/backfill of stored Google Ads warehouse data. Do not use this to view a date range; call get_dashboard_data or get_decision_context with filters for that. Optional startDate/endDate mean repair/backfill that warehouse window.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                startDate: { type: 'string', description: 'Optional. YYYY-MM-DD' },
                                endDate: { type: 'string', description: 'Optional. YYYY-MM-DD' },
                                force: { type: 'boolean', description: 'Optional. Defaults to true for MCP/manual calls; set false to honor the refresh cooldown.' }
                            }
                        }
                    }
                ]
            });
        }

        if (method === 'tools/call' && params) {
            if (params.name === 'confirm_google_ads_skill') {
                const confirmation = confirmGoogleAdsSkill(params.arguments || {});
                return res.json({
                    content: [{ type: 'text', text: confirmation.message }],
                    isError: !confirmation.ok
                });
            } else if (params.name === 'search_search') {
                const query = params.arguments?.query;
                if (!query) return res.status(400).json({ error: 'Missing query argument' });

                const token = await getAccessToken();
                const customerId = await getAccessibleCustomer(token);
                const data = await executeGaql(token, customerId, query);

                return res.json({
                    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
                });
            } else if (params.name === 'customers_list_accessible_customers') {
                const token = await getAccessToken();
                const data = await listAccessibleCustomers(token);
                return res.json({
                    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
                });
            } else if (params.name === 'metadata_get_resource_metadata') {
                let resource: string | null;
                try {
                    resource = normalizeMetadataResource(params.arguments?.resource);
                } catch (err: any) {
                    return res.status(400).json({ error: err.message });
                }
                const token = await getAccessToken();

                let query = `SELECT name, category, selectable, filterable, sortable, selectable_with, data_type, is_repeated, enum_values`;
                if (resource) {
                    query += ` WHERE name = '${resource}' OR name LIKE '${resource}.%'`;
                } else {
                    query += ` LIMIT 100`;
                }

                const data = await getResourceMetadata(token, query);
                return res.json({
                    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
                });
            } else if (params.name === 'get_dashboard_data') {
                const section = String(params.arguments?.section || '').trim();
                if (section) {
                    const route = dashboardSectionRoute(section);
                    if (!route) {
                        return res.status(400).json({
                            error: `Unknown dashboard section: ${section}`,
                            availableSections: dashboardKnownSections()
                        });
                    }
                    if (route.mode === 'decision_context') {
                        const context = await getCompactDecisionContext(pool, params.arguments || {});
                        return res.json({ content: [{ type: 'text', text: JSON.stringify({ decisionContext: context }, null, 2) }] });
                    }
                    if (route.mode === 'candidate_signals') {
                        const signals = await getCandidateSignalsPayload(pool, params.arguments || {});
                        return res.json({ content: [{ type: 'text', text: JSON.stringify({ candidateSignals: signals }, null, 2) }] });
                    }
                    if (route.mode === 'proposal_context') {
                        const context = await getProposalContext(pool, params.arguments || {});
                        return res.json({ content: [{ type: 'text', text: JSON.stringify({ proposalContext: context }, null, 2) }] });
                    }
                    const dashboardData = await getDashboardPayload({ ...(params.arguments || {}), view: route.mode });
                    if (!route.section) {
                        return res.json({ content: [{ type: 'text', text: JSON.stringify(dashboardData, null, 2) }] });
                    }
                    if (!Object.prototype.hasOwnProperty.call(dashboardData, route.section)) {
                        return res.status(400).json({
                            error: `Dashboard section ${route.section} was not returned by ${route.mode} view.`,
                            availableSections: Object.keys(dashboardData || {}).sort()
                        });
                    }
                    return res.json({ content: [{ type: 'text', text: JSON.stringify({ [route.section]: dashboardData[route.section] }, null, 2) }] });
                }
                const view = String(params.arguments?.view || '').trim();
                if (view) {
                    const dashboardData = await getDashboardPayload(params.arguments || {});
                    return res.json({ content: [{ type: 'text', text: JSON.stringify(dashboardData, null, 2) }] });
                }
                const context = await getCompactDecisionContext(pool, params.arguments || {});
                return res.json({ content: [{ type: 'text', text: JSON.stringify(context, null, 2) }] });
            } else if (params.name === 'get_decision_context') {
                const context = await getCompactDecisionContext(pool, params.arguments || {});
                return res.json({ content: [{ type: 'text', text: JSON.stringify(context, null, 2) }] });
            } else if (params.name === 'get_proposal_context') {
                const context = await getProposalContext(pool, params.arguments || {});
                return res.json({ content: [{ type: 'text', text: JSON.stringify(context, null, 2) }] });
            } else if (params.name === 'create_dashboard_magic_link') {
                const link = await createDashboardMagicLink(pool, {
                    ...(params.arguments || {}),
                    created_by: params.arguments?.created_by || 'mcp'
                }, req);
                return res.json({ content: [{ type: 'text', text: JSON.stringify(link, null, 2) }] });
            } else if (params.name === 'keyword_planner_generate_ideas') {
                const ideas = await runKeywordPlannerIdeas(params.arguments || {});
                return res.json({ content: [{ type: 'text', text: JSON.stringify({ ideas }, null, 2) }] });
            } else if (params.name === 'keyword_planner_historical_metrics') {
                const historicalMetrics = await runKeywordPlannerHistoricalMetrics(params.arguments || {});
                return res.json({ content: [{ type: 'text', text: JSON.stringify({ historicalMetrics }, null, 2) }] });
            } else if (params.name === 'create_proposal') {
                const proposal = params.arguments?.proposal;
                if (!proposal || !proposal.proposal_id) return res.status(400).json({ error: 'Missing or invalid proposal argument (proposal_id required)' });
                const saved = await upsertProposal(pool, proposal);
                clearDashboardViewPayloadCache();

                return res.json({ content: [{ type: 'text', text: JSON.stringify({ message: 'Proposal created successfully.', proposal: saved }, null, 2) }] });
            } else if (params.name === 'record_proposal_decision') {
                const proposalId = params.arguments?.proposal_id;
                const action = params.arguments?.action;
                if (!proposalId || !action) return res.status(400).json({ error: 'proposal_id and action are required' });
                const proposal = await recordProposalDecision(pool, {
                    proposalId,
                    action,
                    selectedOptionId: params.arguments?.selected_option_id || null
                });
                clearDashboardViewPayloadCache();
                return res.json({ content: [{ type: 'text', text: JSON.stringify(proposal, null, 2) }] });
            } else if (params.name === 'create_proposal_feedback') {
                const proposalId = params.arguments?.proposal_id;
                const comment = params.arguments?.comment;
                if (!proposalId || !comment) return res.status(400).json({ error: 'proposal_id and comment are required' });
                const feedback = await createProposalFeedback(pool, {
                    proposalId,
                    comment,
                    optionId: params.arguments?.option_id || null,
                    feedbackType: params.arguments?.feedback_type || null,
                    customerId: params.arguments?.customer_id || null,
                    createdBy: params.arguments?.created_by || 'agent'
                });
                clearDashboardViewPayloadCache();
                return res.json({ content: [{ type: 'text', text: JSON.stringify({ message: 'Proposal feedback saved successfully.', feedback }, null, 2) }] });
            } else if (params.name === 'list_proposal_feedback') {
                const feedback = await listProposalFeedback(pool, {
                    proposalId: params.arguments?.proposal_id || null,
                    customerId: params.arguments?.customer_id || null,
                    status: params.arguments?.status || null,
                    limit: params.arguments?.limit || null
                });
                return res.json({ content: [{ type: 'text', text: JSON.stringify({ feedback }, null, 2) }] });
            } else if (params.name === 'update_proposal_feedback_status') {
                const feedbackId = params.arguments?.feedback_id;
                const status = params.arguments?.status;
                if (!feedbackId || !status) return res.status(400).json({ error: 'feedback_id and status are required' });
                const feedback = await updateProposalFeedbackStatus(pool, {
                    feedbackId,
                    status,
                    relatedMemoryId: params.arguments?.related_memory_id || null,
                    reviewedBy: params.arguments?.reviewed_by || 'agent',
                    reviewerNote: params.arguments?.reviewer_note || null
                });
                clearDashboardViewPayloadCache();
                return res.json({ content: [{ type: 'text', text: JSON.stringify({ message: 'Proposal feedback status updated successfully.', feedback }, null, 2) }] });
            } else if (params.name === 'get_candidate_signals') {
                const signals = await getCandidateSignalsPayload(pool, params.arguments || {});
                return res.json({ content: [{ type: 'text', text: JSON.stringify(signals, null, 2) }] });
            } else if (params.name === 'get_learning_summary') {
                const rates = await pool.query(`SELECT strategy_id, alpha, beta, sample_count, last_updated FROM strategy_success_rates ORDER BY strategy_id ASC`);
                const tracking = await pool.query(`SELECT option_uid, option_id, proposal_id, selected_option_id, campaign_id, strategy_id, verification_spec, tracking_status, detected_at, outcome_14, outcome_30, lead_outcome_14, lead_outcome_30, lead_metrics_14, lead_metrics_30, outcome_details_14, outcome_details_30 FROM impact_tracking ORDER BY detected_at DESC LIMIT 100`);
                const strategySuccessRates = rates.rows.map((row: any) => {
                    const alpha = Number(row.alpha || 0);
                    const beta = Number(row.beta || 0);
                    const sampleCount = Number(row.sample_count || 0);
                    const total = alpha + beta;
                    const successRate = total > 0 ? alpha / total : null;
                    const priorConfidence = sampleCount >= 20
                        ? 'high'
                        : sampleCount >= 5
                            ? 'medium'
                            : sampleCount > 0
                                ? 'low'
                                : 'none';
                    return {
                        ...row,
                        alpha,
                        beta,
                        sample_count: sampleCount,
                        success_rate: successRate,
                        prior_confidence: priorConfidence
                    };
                });
                return res.json({
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            learning_guidance: {
                                interpretation: 'success_rate is alpha / (alpha + beta). These are historical outcome priors, not ML predictions.',
                                usage: 'Use priors to rank otherwise similar proposal options. Current evidence and lead quality should override weak or conflicting priors.',
                                confidence_thresholds: {
                                    none: 'sample_count = 0',
                                    low: 'sample_count 1-4; directional only',
                                    medium: 'sample_count 5-19; useful tie-breaker',
                                    high: 'sample_count >= 20; stronger tie-breaker'
                                }
                            },
                            strategy_success_rates: strategySuccessRates,
                            impact_tracking: tracking.rows
                        }, null, 2)
                    }]
                });
            } else if (params.name === 'create_memory') {
                assertSemanticMemoryAvailable();
                const memory = await createMemory(pool, params.arguments || {});
                return res.json({ content: [{ type: 'text', text: JSON.stringify({ message: 'Memory created successfully.', memory }, null, 2) }] });
            } else if (params.name === 'store_memory_embedding') {
                assertSemanticMemoryAvailable();
                const embedding = await storeMemoryEmbedding(pool, params.arguments || {});
                return res.json({ content: [{ type: 'text', text: JSON.stringify({ message: 'Memory embedding stored successfully.', embedding }, null, 2) }] });
            } else if (params.name === 'search_memories') {
                assertSemanticMemoryAvailable();
                const result = await searchMemories(pool, params.arguments || {});
                return res.json({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
            } else if (params.name === 'deactivate_memory') {
                assertSemanticMemoryAvailable();
                const result = await deactivateMemory(pool, params.arguments || {});
                return res.json({ content: [{ type: 'text', text: JSON.stringify({ message: 'Memory deactivated successfully.', ...result }, null, 2) }] });
            } else if (params.name === 'link_memory_exception') {
                assertSemanticMemoryAvailable();
                const memory = await linkMemoryException(pool, params.arguments || {});
                return res.json({ content: [{ type: 'text', text: JSON.stringify({ message: 'Memory exception linked successfully.', memory }, null, 2) }] });
            } else if (params.name === 'create_diagnosis') {
                const diagnosis = params.arguments?.diagnosis;
                if (!diagnosis || !diagnosis.id) return res.status(400).json({ error: 'Missing or invalid diagnosis argument (id required)' });

                await pool.query(
                    `INSERT INTO ai_diagnoses (diagnosis_id, payload) VALUES ($1, $2)
                     ON CONFLICT (diagnosis_id) DO UPDATE SET payload = EXCLUDED.payload`,
                    [diagnosis.id, diagnosis]
                );
                clearDashboardViewPayloadCache();
                return res.json({ content: [{ type: 'text', text: 'Diagnosis created successfully.' }] });
            } else if (params.name === 'clear_proposals') {
                await pool.query(`TRUNCATE TABLE proposals CASCADE`);
                clearDashboardViewPayloadCache();
                return res.json({ content: [{ type: 'text', text: 'All proposals cleared successfully.' }] });
            } else if (params.name === 'clear_diagnoses') {
                await pool.query(`TRUNCATE TABLE ai_diagnoses`);
                clearDashboardViewPayloadCache();
                return res.json({ content: [{ type: 'text', text: 'All AI diagnoses cleared successfully.' }] });
            } else if (params.name === 'trigger_refresh') {
                try {
                    const result = startRefreshJob({
                        startDate: params.arguments?.startDate,
                        endDate: params.arguments?.endDate,
                        force: params.arguments?.force !== false,
                        source: 'mcp'
                    });
                    const suffix = result.nextAllowedAt ? ` Next allowed at ${result.nextAllowedAt}.` : '';
                    return res.json({ content: [{ type: 'text', text: `${result.message}${suffix}` }] });
                } catch (err: any) {
                    return res.json({ content: [{ type: 'text', text: `Refresh failed: ${err.message}` }], isError: true });
                }
            }
        }

        res.status(404).json({ error: 'Method or tool not found' });
    } catch (err: any) {
        console.error('MCP proxy error:', err);
        const statusCode = err instanceof SemanticMemoryValidationError
            || err?.name === 'SemanticMemoryValidationError'
            || err instanceof SemanticMemoryConflictError
            || err?.name === 'SemanticMemoryConflictError'
            || err instanceof SemanticMemoryNotFoundError
            || err?.name === 'SemanticMemoryNotFoundError'
            || err instanceof SemanticMemoryConfigurationError
            || err?.name === 'SemanticMemoryConfigurationError'
            ? semanticMemoryStatusCode(err)
            : err instanceof DashboardPayloadValidationError || err?.name === 'DashboardPayloadValidationError' || err instanceof WarehouseDataNotFoundError || err?.name === 'WarehouseDataNotFoundError'
                ? dashboardErrorStatus(err)
                : err instanceof ProposalValidationError || err?.name === 'ProposalValidationError' || err instanceof KeywordPlannerValidationError || err?.name === 'KeywordPlannerValidationError'
                    ? 400
                    : String(err?.message || '').startsWith('Proposal not found:') || String(err?.message || '').startsWith('Proposal feedback not found:')
                        ? 404
                        : 500;
        res.status(statusCode).json({ error: err.message, isError: true });
    }
});

if (serveDashboardClient) {
    app.get('/logo.png', (_req: Request, res: Response) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.sendFile(path.join(dashboardClientPath, 'logo.png'));
    });

    app.use(requireDashboardPage, express.static(dashboardClientPath, {
        index: false,
        setHeaders(res) {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Referrer-Policy', 'no-referrer');
            res.setHeader('X-Frame-Options', 'DENY');
        }
    }));

    // Fallback to index.html for SPA routing (if any)
    app.get('*', requireDashboardPage, (req: Request, res: Response) => {
        const indexPath = path.join(dashboardClientPath, 'index.html');
        if (fs.existsSync(indexPath)) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            res.setHeader('Referrer-Policy', 'no-referrer');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.sendFile(indexPath);
        } else {
            res.status(404).send('Dashboard client build not found.');
        }
    });
}

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
