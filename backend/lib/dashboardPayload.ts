import { Pool } from 'pg';
import { cpaBenchmarkForAccount } from './accountBenchmarks';
import { buildAuctionInsightsSummary } from './auctionInsightsSummary';
import { COMPETITOR_ROOTS } from './competitors';
import {
    buildDecisionContextSummary,
    configuredKeywordRuleFromReportRow,
    decisionContextForTerm,
    flattenDecisionContext,
    normalizeNegativeRulesFromReports,
    type ConfiguredKeywordRule,
    type NegativeRule,
    type SourceCoverageEntry,
    type SourceCoverageSummary,
    type TermScope
} from './decisionContext';
import { enrichDashboardDecisionRows } from './leadDecisionEnrichment';
import { getLeadAttributionSummary } from './leads';
import { plannerFields } from './plannerScoring';
import { proposalFeedbackByProposalIds } from './proposals';
import {
    dashboardCacheKey,
    getAvailableDashboardFilters,
    getCachedDashboardPayload,
    getDashboardOverviewReportBundle,
    getDashboardReportBundle,
    getDashboardReportBundleForView,
    getWarehouseWatermark,
    setCachedDashboardPayload,
    validateDashboardFilters,
    type CoverageEntry,
    type DashboardFilters,
    type DashboardReportBundle,
    type MetricFields
} from './adsWarehouse';

export class DashboardPayloadValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DashboardPayloadValidationError';
    }
}

export class WarehouseDataNotFoundError extends Error {
    constructor(message = 'No warehouse data found. Run a backfill first.') {
        super(message);
        this.name = 'WarehouseDataNotFoundError';
    }
}

type AdsPayloadMemoryEntry = {
    payload: any;
    expiresAt: number;
    sizeBytes: number;
    lastAccessedAt: number;
};

type DashboardViewPayloadMemoryEntry = {
    payload: any;
    expiresAt: number;
    sizeBytes: number;
    lastAccessedAt: number;
};

const DEFAULT_DASHBOARD_MEMORY_CACHE_SECONDS = 600;
const DEFAULT_DASHBOARD_MEMORY_CACHE_MAX_ENTRIES = 10;
const DEFAULT_DASHBOARD_MEMORY_CACHE_MAX_BYTES = 25_000_000;
const DEFAULT_DASHBOARD_VIEW_CACHE_SECONDS = 60;
const DEFAULT_DASHBOARD_VIEW_CACHE_MAX_ENTRIES = 40;
const DEFAULT_DASHBOARD_VIEW_CACHE_MAX_BYTES = 10_000_000;
const adsPayloadMemoryCache = new Map<string, AdsPayloadMemoryEntry>();
const dashboardViewPayloadMemoryCache = new Map<string, DashboardViewPayloadMemoryEntry>();
const dashboardPayloadInflight = new Map<string, Promise<any>>();

function positiveIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function adsPayloadMemoryCacheTtlMs(): number {
    return positiveIntegerEnv('DASHBOARD_MEMORY_CACHE_SECONDS', DEFAULT_DASHBOARD_MEMORY_CACHE_SECONDS) * 1000;
}

function adsPayloadMemoryCacheMaxEntries(): number {
    return positiveIntegerEnv('DASHBOARD_MEMORY_CACHE_MAX_ENTRIES', DEFAULT_DASHBOARD_MEMORY_CACHE_MAX_ENTRIES);
}

function adsPayloadMemoryCacheMaxBytes(): number {
    return positiveIntegerEnv('DASHBOARD_MEMORY_CACHE_MAX_BYTES', DEFAULT_DASHBOARD_MEMORY_CACHE_MAX_BYTES);
}

function dashboardViewCacheTtlMs(): number {
    return positiveIntegerEnv('DASHBOARD_VIEW_CACHE_SECONDS', DEFAULT_DASHBOARD_VIEW_CACHE_SECONDS) * 1000;
}

function dashboardViewCacheMaxEntries(): number {
    return positiveIntegerEnv('DASHBOARD_VIEW_CACHE_MAX_ENTRIES', DEFAULT_DASHBOARD_VIEW_CACHE_MAX_ENTRIES);
}

function dashboardViewCacheMaxBytes(): number {
    return positiveIntegerEnv('DASHBOARD_VIEW_CACHE_MAX_BYTES', DEFAULT_DASHBOARD_VIEW_CACHE_MAX_BYTES);
}

function jsonByteSize(value: any): number {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function clonePayload<T>(value: T): T {
    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function adsPayloadMemoryKey(filters: DashboardFilters, watermark: string): string {
    return `${dashboardCacheKey(filters)}:watermark=${watermark}`;
}

function dashboardViewPayloadMemoryKey(view: DashboardPayloadView, filters: DashboardFilters, watermark: string, liveAttachVariant = 'default'): string {
    return `${dashboardCacheKey(filters)}:view=${view}:watermark=${watermark}:live=${liveAttachVariant}`;
}

function pruneAdsPayloadMemoryCache(now = Date.now()): void {
    for (const [key, entry] of adsPayloadMemoryCache) {
        if (entry.expiresAt <= now) adsPayloadMemoryCache.delete(key);
    }
    const maxEntries = adsPayloadMemoryCacheMaxEntries();
    if (maxEntries <= 0) {
        adsPayloadMemoryCache.clear();
        return;
    }
    while (adsPayloadMemoryCache.size > maxEntries) {
        const oldest = Array.from(adsPayloadMemoryCache.entries())
            .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt)[0];
        if (!oldest) break;
        adsPayloadMemoryCache.delete(oldest[0]);
    }
}

function getMemoryCachedAdsPayload(filters: DashboardFilters, watermark: string): any | null {
    const ttlMs = adsPayloadMemoryCacheTtlMs();
    if (ttlMs <= 0) return null;
    const key = adsPayloadMemoryKey(filters, watermark);
    const entry = adsPayloadMemoryCache.get(key);
    if (!entry) return null;
    const now = Date.now();
    if (entry.expiresAt <= now) {
        adsPayloadMemoryCache.delete(key);
        return null;
    }
    entry.lastAccessedAt = now;
    return clonePayload(entry.payload);
}

function pruneDashboardViewPayloadMemoryCache(now = Date.now()): void {
    for (const [key, entry] of dashboardViewPayloadMemoryCache) {
        if (entry.expiresAt <= now) dashboardViewPayloadMemoryCache.delete(key);
    }
    const maxEntries = dashboardViewCacheMaxEntries();
    if (maxEntries <= 0) {
        dashboardViewPayloadMemoryCache.clear();
        return;
    }
    while (dashboardViewPayloadMemoryCache.size > maxEntries) {
        const oldest = Array.from(dashboardViewPayloadMemoryCache.entries())
            .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt)[0];
        if (!oldest) break;
        dashboardViewPayloadMemoryCache.delete(oldest[0]);
    }
}

function getMemoryCachedDashboardViewPayload(view: DashboardPayloadView, filters: DashboardFilters, watermark: string, liveAttachVariant = 'default'): any | null {
    const ttlMs = dashboardViewCacheTtlMs();
    if (ttlMs <= 0) return null;
    const key = dashboardViewPayloadMemoryKey(view, filters, watermark, liveAttachVariant);
    const entry = dashboardViewPayloadMemoryCache.get(key);
    if (!entry) return null;
    const now = Date.now();
    if (entry.expiresAt <= now) {
        dashboardViewPayloadMemoryCache.delete(key);
        return null;
    }
    entry.lastAccessedAt = now;
    return clonePayload(entry.payload);
}

function setMemoryCachedDashboardViewPayload(view: DashboardPayloadView, filters: DashboardFilters, watermark: string, payload: any, liveAttachVariant = 'default'): void {
    const ttlMs = dashboardViewCacheTtlMs();
    if (ttlMs <= 0) return;
    const sizeBytes = jsonByteSize(payload);
    const maxBytes = dashboardViewCacheMaxBytes();
    if (maxBytes > 0 && sizeBytes > maxBytes) return;
    const now = Date.now();
    dashboardViewPayloadMemoryCache.set(dashboardViewPayloadMemoryKey(view, filters, watermark, liveAttachVariant), {
        payload: clonePayload(payload),
        expiresAt: now + ttlMs,
        sizeBytes,
        lastAccessedAt: now
    });
    pruneDashboardViewPayloadMemoryCache(now);
}

export function clearDashboardViewPayloadCache(): void {
    dashboardViewPayloadMemoryCache.clear();
    dashboardPayloadInflight.clear();
}

function setMemoryCachedAdsPayload(filters: DashboardFilters, watermark: string, payload: any): void {
    const ttlMs = adsPayloadMemoryCacheTtlMs();
    const maxEntries = adsPayloadMemoryCacheMaxEntries();
    if (ttlMs <= 0 || maxEntries <= 0) return;
    const sizeBytes = jsonByteSize(payload);
    const maxBytes = adsPayloadMemoryCacheMaxBytes();
    if (maxBytes > 0 && sizeBytes > maxBytes) return;
    const now = Date.now();
    adsPayloadMemoryCache.set(adsPayloadMemoryKey(filters, watermark), {
        payload: clonePayload(payload),
        expiresAt: now + ttlMs,
        sizeBytes,
        lastAccessedAt: now
    });
    pruneAdsPayloadMemoryCache(now);
}

function today(): string {
    return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
    const [year, month, day] = date.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function isoDateKeyOrNull(value: any): string | null {
    const text = clean(value);
    if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const [year, month, day] = text.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
        ? text
        : null;
}

export function dashboardAccountStartDate(): string | null {
    return isoDateKeyOrNull(process.env.GOOGLE_ADS_WAREHOUSE_START_DATE);
}

function isAllTimeDateRangePreset(raw: Record<string, any> = {}): boolean {
    const value = one(raw.dateRangePreset || raw.preset);
    return ['all_time', 'all-time', 'alltime'].includes(String(value || '').trim().toLowerCase());
}

function clean(value: any): string | null {
    const text = String(value ?? '').trim();
    return text || null;
}

function one(value: any): string | null {
    if (Array.isArray(value)) return clean(value[0]);
    return clean(value);
}

export type DashboardPayloadView = 'full' | 'overview' | 'performance' | 'keywords' | 'attribution' | 'rank' | 'proposals' | 'audiences';
export type DashboardSectionRouteMode = DashboardPayloadView | 'candidate_signals' | 'decision_context' | 'proposal_context';
export type DashboardSectionRoute = {
    section: string | null;
    mode: DashboardSectionRouteMode;
};

const DASHBOARD_PAYLOAD_VIEWS = new Set<DashboardPayloadView>([
    'full',
    'overview',
    'performance',
    'keywords',
    'attribution',
    'rank',
    'proposals',
    'audiences'
]);

const DASHBOARD_VIEW_FIELDS: Record<Exclude<DashboardPayloadView, 'full'>, readonly string[]> = {
    overview: [
        'meta',
        'filterOptions',
        'sourceCoverage',
        'decisionContext',
        'summary',
        'globalSummary',
        'periodComparison',
        'anomalies',
        'insights',
        'dailyTrend',
        'campaigns',
        'dailyCampaigns',
        'adGroups',
        'rankShareEntities',
        'dailyRankShare',
        'clickPaths',
        'devicePerformance',
        'dayOfWeekPerformance',
        'dayAndHourPerformance',
        'leadAttribution',
        'aiDiagnoses',
        'attributionCapability'
    ],
    performance: [
        'meta',
        'filterOptions',
        'sourceCoverage',
        'decisionContext',
        'summary',
        'globalSummary',
        'campaigns',
        'dailyCampaigns',
        'adGroups',
        'rankShareEntities',
        'dailyRankShare'
    ],
    keywords: [
        'meta',
        'filterOptions',
        'sourceCoverage',
        'decisionContext',
        'summary',
        'keywords',
        'configuredKeywords',
        'qualityScores',
        'negatives',
        'searchTerms',
        'keywordPlanner',
        'competitorRoots',
        'candidateSignals',
        'decisionInputEnrichment',
        'leadAttribution'
    ],
    attribution: [
        'meta',
        'filterOptions',
        'summary',
        'conversionActions',
        'conversionAttribution',
        'clickPaths',
        'leadAttribution',
        'attributionCapability'
    ],
    rank: [
        'meta',
        'filterOptions',
        'sourceCoverage',
        'decisionContext',
        'summary',
        'campaigns',
        'dailyCampaigns',
        'rankShareEntities',
        'dailyRankShare',
        'insights',
        'competitorBreakdown',
        'competitorSpend',
        'competitorConv',
        'competitorSpendShare',
        'qualityScores',
        'landingPages',
        'expandedLandingPages',
        'auctionInsights',
        'auctionInsightsStatus',
        'candidateSignals',
        'devicePerformance',
        'dayOfWeekPerformance',
        'dayAndHourPerformance',
        'attributionCapability'
    ],
    proposals: [
        'meta',
        'filterOptions',
        'sourceCoverage',
        'decisionContext',
        'summary',
        'candidateSignals',
        'proposals',
        'decisionInputEnrichment',
        'leadAttribution',
        'aiDiagnoses'
    ],
    audiences: [
        'meta',
        'filterOptions',
        'sourceCoverage',
        'summary',
        'audiences'
    ]
};

const DASHBOARD_SECTION_ROUTES = new Map<string, DashboardSectionRoute>();

function sectionKey(value: string): string {
    return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function addSectionRoutes(mode: DashboardSectionRouteMode, sections: readonly string[]): void {
    for (const section of sections) {
        DASHBOARD_SECTION_ROUTES.set(sectionKey(section), { section, mode });
    }
}

for (const view of DASHBOARD_PAYLOAD_VIEWS) {
    DASHBOARD_SECTION_ROUTES.set(sectionKey(view), { section: null, mode: view });
}

addSectionRoutes('overview', [
    'meta',
    'filterOptions',
    'sourceCoverage',
    'summary',
    'globalSummary',
    'periodComparison',
    'anomalies',
    'insights',
    'dailyTrend',
    'campaigns',
    'dailyCampaigns',
    'adGroups',
    'rankShareEntities',
    'dailyRankShare',
    'clickPaths',
    'devicePerformance',
    'dayOfWeekPerformance',
    'dayAndHourPerformance',
    'attributionCapability'
]);

addSectionRoutes('keywords', [
    'keywords',
    'configuredKeywords',
    'qualityScores',
    'negatives',
    'searchTerms',
    'keywordPlanner',
    'competitorRoots',
    'decisionInputEnrichment'
]);

addSectionRoutes('attribution', [
    'conversionActions',
    'conversionAttribution',
    'clickPaths',
    'leadAttribution'
]);

addSectionRoutes('rank', [
    'landingPages',
    'expandedLandingPages',
    'auctionInsights',
    'auctionInsightsStatus',
    'competitorBreakdown',
    'competitorSpend',
    'competitorConv',
    'competitorSpendShare'
]);

addSectionRoutes('proposals', [
    'proposals',
    'aiDiagnoses'
]);

DASHBOARD_SECTION_ROUTES.set(sectionKey('decisionContext'), { section: 'decisionContext', mode: 'decision_context' });
DASHBOARD_SECTION_ROUTES.set(sectionKey('candidateSignals'), { section: 'candidateSignals', mode: 'candidate_signals' });
DASHBOARD_SECTION_ROUTES.set(sectionKey('proposalContext'), { section: 'proposalContext', mode: 'proposal_context' });
DASHBOARD_SECTION_ROUTES.set(sectionKey('diagnoses'), { section: 'aiDiagnoses', mode: 'proposals' });

export function dashboardSectionRoute(rawSection: any): DashboardSectionRoute | null {
    const section = one(rawSection);
    if (!section) return null;
    return DASHBOARD_SECTION_ROUTES.get(sectionKey(section)) || null;
}

export function dashboardKnownSections(): string[] {
    const routedSections = Array.from(DASHBOARD_SECTION_ROUTES.values())
        .map(route => route.section)
        .filter((section): section is string => Boolean(section));
    return Array.from(new Set([...Array.from(DASHBOARD_PAYLOAD_VIEWS), ...routedSections])).sort();
}

export function normalizeDashboardPayloadView(value: any): DashboardPayloadView {
    const normalized = (one(value) || 'full').trim().toLowerCase().replace(/_/g, '-') as DashboardPayloadView;
    if (DASHBOARD_PAYLOAD_VIEWS.has(normalized)) return normalized;
    throw new DashboardPayloadValidationError(`Unknown dashboard payload view: ${one(value)}`);
}

export function projectDashboardPayload(payload: any, rawView: any): any {
    const view = normalizeDashboardPayloadView(rawView);
    if (view === 'full') return payload;
    const projected: Record<string, any> = {};
    for (const field of DASHBOARD_VIEW_FIELDS[view]) {
        if (Object.prototype.hasOwnProperty.call(payload, field)) projected[field] = payload[field];
    }
    projected.meta = {
        ...(payload.meta || {}),
        payloadView: view
    };
    return projected;
}

function assertDate(value: string, label: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new DashboardPayloadValidationError(`Invalid ${label} format: ${value}`);
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
        throw new DashboardPayloadValidationError(`Invalid ${label}: ${value}`);
    }
}

function num(value: any): number {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? n : 0;
}

function maybeNum(value: any): number | null {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function micros(value: any): number {
    return +(num(value) / 1_000_000).toFixed(2);
}

function microsNullable(value: any): number | null {
    const n = maybeNum(value);
    return n === null ? null : +(n / 1_000_000).toFixed(2);
}

function pctFraction(value: any): number | null {
    const n = maybeNum(value);
    return n === null ? null : +(n * 100).toFixed(2);
}

function safeDiv(a: number, b: number): number {
    return b ? +(a / b).toFixed(2) : 0;
}

function normKey(value: any): string {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function rawRows<T extends { raw_payload?: Record<string, any> }>(rows: T[]): any[] {
    return rows.map(row => row.raw_payload || row).filter(Boolean);
}

function dateKey(value: any): string {
    if (!value) return '';
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function normalizeLeadStatus(value: any): string {
    const normalized = String(value || 'new').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (['junk', 'spam', 'invalid', 'bad_fit', 'bad'].includes(normalized)) return 'useless';
    if (['lost', 'closed_lost', 'qualified_lost_lead'].includes(normalized)) return 'qualified_lost';
    if (['customer', 'won', 'paid'].includes(normalized)) return 'converted';
    return ['new', 'maybe', 'qualified', 'converted', 'qualified_lost', 'useless'].includes(normalized) ? normalized : 'new';
}

function emptyLeadMetrics(): Record<string, number> {
    return {
        realConversions: 0,
        realMaybe: 0,
        realConverted: 0,
        realQualified: 0,
        realQualifiedLost: 0,
        realUseless: 0,
        realNew: 0,
        realEventCount: 0
    };
}

function addLeadMetric(bucket: Record<string, number>, lead: any): void {
    const status = normalizeLeadStatus(lead?.status);
    bucket.realConversions += 1;
    bucket.realEventCount += num(lead?.eventCount ?? lead?.event_count);
    if (status === 'new') bucket.realNew += 1;
    if (status === 'useless') bucket.realUseless += 1;
    if (status === 'maybe') bucket.realMaybe += 1;
    if (status === 'qualified') bucket.realQualified += 1;
    if (status === 'qualified_lost') bucket.realQualifiedLost += 1;
    if (status === 'converted') bucket.realConverted += 1;
}

function periodRange(label: any): { start: string; end: string } | null {
    const text = String(label || '');
    const match = text.match(/(\d{4}-\d{2}-\d{2})\s*[-–]\s*(\d{4}-\d{2}-\d{2})/);
    return match ? { start: match[1], end: match[2] } : null;
}

function leadMetricsForRange(leads: any[], range: { start: string; end: string } | null): Record<string, number> {
    const bucket = emptyLeadMetrics();
    if (!range) return bucket;
    for (const lead of leads) {
        const leadDate = dateKey(lead?.firstSeen || lead?.first_seen || lead?.lastSeen || lead?.last_seen);
        if (!leadDate || leadDate < range.start || leadDate > range.end) continue;
        addLeadMetric(bucket, lead);
    }
    return bucket;
}

export function attachLeadPeriodComparisonMetrics(payload: any): void {
    const periodComparison = payload?.periodComparison;
    if (!periodComparison?.previousPeriod || !periodComparison?.currentPeriod) return;
    const aggregateComparison = payload?.leadAttribution?.periodComparison;
    const delta = (currentValue: number, previousValue: number) => previousValue === 0
        ? (currentValue > 0 ? 100 : 0)
        : +(((currentValue - previousValue) / previousValue) * 100).toFixed(1);
    if (aggregateComparison?.previousPeriod && aggregateComparison?.currentPeriod) {
        const previous = aggregateComparison.previousPeriod;
        const current = aggregateComparison.currentPeriod;
        periodComparison.previousPeriod = { ...periodComparison.previousPeriod, ...previous };
        periodComparison.currentPeriod = { ...periodComparison.currentPeriod, ...current };
        periodComparison.deltas = {
            ...(periodComparison.deltas || {}),
            realConversions: delta(Number(current.realConversions || 0), Number(previous.realConversions || 0))
        };
        return;
    }
    const leads = Array.isArray(payload?.leadAttribution?.filteredLeads)
        ? payload.leadAttribution.filteredLeads
        : Array.isArray(payload?.leadAttribution?.allLeads)
            ? payload.leadAttribution.allLeads
            : [];
    if (!leads.length) return;

    const previous = leadMetricsForRange(leads, periodRange(periodComparison.previousPeriod.label));
    const current = leadMetricsForRange(leads, periodRange(periodComparison.currentPeriod.label));

    periodComparison.previousPeriod = { ...periodComparison.previousPeriod, ...previous };
    periodComparison.currentPeriod = { ...periodComparison.currentPeriod, ...current };
    periodComparison.deltas = {
        ...(periodComparison.deltas || {}),
        realConversions: delta(current.realConversions, previous.realConversions)
    };
}

function trimLeadAttributionForResponse(leadAttribution: any): any {
    if (!leadAttribution || typeof leadAttribution !== 'object') return leadAttribution;
    const { allLeads: _allLeads, filteredLeads: _filteredLeads, recentSessions: _recentSessions, ...rest } = leadAttribution;
    return rest;
}

async function defaultCustomerId(pool: Pool): Promise<string> {
    const configured = clean(process.env.GOOGLE_ADS_CUSTOMER_ID || process.env.GOOGLE_ADS_CUSTOMER);
    if (configured) return configured;
    const { rows } = await pool.query(
        `SELECT customer_id
         FROM google_ads_refresh_runs
         WHERE customer_id IS NOT NULL
         ORDER BY started_at DESC
         LIMIT 1`
    );
    const fromRun = clean(rows[0]?.customer_id);
    if (fromRun) return fromRun;
    const fact = await pool.query(`SELECT customer_id FROM google_ads_campaign_daily LIMIT 1`);
    const fromFact = clean(fact.rows[0]?.customer_id);
    if (fromFact) return fromFact;
    throw new WarehouseDataNotFoundError();
}

export async function resolveDashboardFilters(pool: Pool, raw: Record<string, any> = {}): Promise<DashboardFilters> {
    const customerId = one(raw.customerId) || await defaultCustomerId(pool);
    const allTime = isAllTimeDateRangePreset(raw);
    const endDate = allTime ? today() : (one(raw.endDate) || today());
    let startDate = allTime ? dashboardAccountStartDate() : one(raw.startDate);
    if (allTime && !startDate) {
        const options = await getAvailableDashboardFilters(pool, customerId);
        startDate = options.minDate;
    }
    startDate = startDate || addDays(endDate, -29);
    assertDate(startDate, 'startDate');
    assertDate(endDate, 'endDate');
    if (startDate > endDate) throw new DashboardPayloadValidationError('startDate must be before or equal to endDate.');
    const filters = validateDashboardFilters({
        customerId,
        startDate,
        endDate,
        campaignId: one(raw.campaignId || raw.campaign) || null,
        adGroupId: one(raw.adGroupId || raw.adGroup) || null
    });
    return assertKnownFilterSelection(pool, filters);
}

async function assertKnownFilterSelection(pool: Pool, filters: DashboardFilters): Promise<DashboardFilters> {
    if (!filters.campaignId && !filters.adGroupId) {
        const { rows } = await pool.query(
            `SELECT 1
             FROM google_ads_campaign_daily
             WHERE customer_id = $1
             LIMIT 1`,
            [filters.customerId]
        );
        if (!rows.length) throw new WarehouseDataNotFoundError();
        return validateDashboardFilters(filters);
    }
    const options = await getAvailableDashboardFilters(pool, filters.customerId);
    if (!options.minDate || !options.maxDate) throw new WarehouseDataNotFoundError();
    if (filters.campaignId && !options.campaigns.some(campaign => campaign.id === filters.campaignId)) {
        throw new DashboardPayloadValidationError(`Unknown campaignId: ${filters.campaignId}`);
    }
    let campaignId = filters.campaignId || null;
    if (filters.adGroupId) {
        const adGroup = options.adGroups.find(row => row.id === filters.adGroupId);
        if (!adGroup) throw new DashboardPayloadValidationError(`Unknown adGroupId: ${filters.adGroupId}`);
        if (campaignId && adGroup.campaignId !== campaignId) {
            throw new DashboardPayloadValidationError(`adGroupId ${filters.adGroupId} is not in campaignId ${campaignId}`);
        }
        campaignId = campaignId || adGroup.campaignId;
    }
    return validateDashboardFilters({ ...filters, campaignId });
}

interface Agg {
    spend: number;
    clicks: number;
    impressions: number;
    conversions: number;
    conversionsValue: number;
    allConversions: number;
    ctr: number;
    avgCpc: number;
    cpa: number;
    cvr: number;
    _isWeight: number;
    _isValue: number;
    _lostBudgetValue: number;
    _lostRankValue: number;
    _mobileWeight: number;
    _mobileValue: number;
    _ampWeight: number;
    _ampValue: number;
    _speedWeight: number;
    _speedValue: number;
}

function emptyAgg(): Agg {
    return {
        spend: 0,
        clicks: 0,
        impressions: 0,
        conversions: 0,
        conversionsValue: 0,
        allConversions: 0,
        ctr: 0,
        avgCpc: 0,
        cpa: 0,
        cvr: 0,
        _isWeight: 0,
        _isValue: 0,
        _lostBudgetValue: 0,
        _lostRankValue: 0,
        _mobileWeight: 0,
        _mobileValue: 0,
        _ampWeight: 0,
        _ampValue: 0,
        _speedWeight: 0,
        _speedValue: 0
    };
}

function addMetric(target: Agg, row: MetricFields & Record<string, any>): void {
    const spend = micros(row.cost_micros);
    const clicks = num(row.clicks);
    const impressions = num(row.impressions);
    const conversions = num(row.conversions);
    target.spend += spend;
    target.clicks += clicks;
    target.impressions += impressions;
    target.conversions += conversions;
    target.allConversions += num(row.all_conversions);
    target.conversionsValue += num(row.conversions_value);
    const impressionShare = maybeNum(row.search_impression_share);
    const lostBudget = maybeNum(row.search_budget_lost_impression_share);
    const lostRank = maybeNum(row.search_rank_lost_impression_share);
    if (impressionShare !== null) {
        target._isWeight += impressions;
        target._isValue += impressionShare * impressions;
    }
    if (lostBudget !== null) target._lostBudgetValue += lostBudget * impressions;
    if (lostRank !== null) target._lostRankValue += lostRank * impressions;
    const mobile = maybeNum(row.mobile_friendly_clicks_percentage);
    const amp = maybeNum(row.valid_amp_clicks_percentage);
    const speed = maybeNum(row.speed_score);
    if (mobile !== null) {
        target._mobileWeight += clicks;
        target._mobileValue += mobile * clicks;
    }
    if (amp !== null) {
        target._ampWeight += clicks;
        target._ampValue += amp * clicks;
    }
    if (speed !== null) {
        target._speedWeight += clicks;
        target._speedValue += speed * clicks;
    }
}

function finalizeAgg<T extends Record<string, any>>(row: T & Agg): T {
    const out = row as Record<string, any>;
    out.spend = +row.spend.toFixed(2);
    out.conversions = +row.conversions.toFixed(2);
    out.conversionsValue = +row.conversionsValue.toFixed(2);
    out.ctr = row.impressions ? +((row.clicks / row.impressions) * 100).toFixed(2) : 0;
    out.avgCpc = row.clicks ? +(row.spend / row.clicks).toFixed(2) : 0;
    out.cpa = row.conversions ? +(row.spend / row.conversions).toFixed(2) : 0;
    out.cvr = row.clicks ? +((row.conversions / row.clicks) * 100).toFixed(2) : 0;
    if (row._isWeight > 0) out.impressionShare = +((row._isValue / row._isWeight) * 100).toFixed(2);
    if (row.impressions > 0 && row._lostBudgetValue > 0) out.lostISBudget = +((row._lostBudgetValue / row.impressions) * 100).toFixed(2);
    if (row.impressions > 0 && row._lostRankValue > 0) out.lostISRank = +((row._lostRankValue / row.impressions) * 100).toFixed(2);
    out.mobileFriendlyClicksPct = row._mobileWeight > 0 ? +((row._mobileValue / row._mobileWeight) * 100).toFixed(2) : null;
    out.validAmpClicksPct = row._ampWeight > 0 ? +((row._ampValue / row._ampWeight) * 100).toFixed(2) : null;
    out.speedScore = row._speedWeight > 0 ? +(row._speedValue / row._speedWeight).toFixed(2) : null;
    for (const key of Object.keys(out)) {
        if (key.startsWith('_')) delete out[key];
    }
    return row;
}

function aggregateBy<T extends MetricFields & Record<string, any>>(rows: T[], keyFn: (row: T) => string, baseFn: (row: T) => Record<string, any>): any[] {
    const map = new Map<string, any>();
    for (const row of rows) {
        const key = keyFn(row);
        if (!key) continue;
        if (!map.has(key)) map.set(key, { ...emptyAgg(), ...baseFn(row) });
        addMetric(map.get(key), row);
    }
    return Array.from(map.values()).map(finalizeAgg);
}

function plannerMap(rows: any[]): Map<string, any> {
    const map = new Map<string, any>();
    for (const row of rows) {
        const key = normKey(row.keyword);
        if (!key) continue;
        const existing = map.get(key);
        if (!existing || num(row.avgMonthlySearches || row.avg_monthly_searches) > num(existing.avgMonthlySearches || existing.avg_monthly_searches)) {
            map.set(key, row);
        }
        for (const variant of Array.isArray(row.closeVariants || row.close_variants) ? (row.closeVariants || row.close_variants) : []) {
            const variantKey = normKey(variant);
            if (variantKey && !map.has(variantKey)) map.set(variantKey, row);
        }
    }
    return map;
}

function plannerMetric(row: any): any {
    const raw = row.raw_payload || row;
    const monthlySearchVolumes = raw.monthlySearchVolumes ?? row.monthly_search_volumes ?? [];
    return {
        keyword: row.keyword || raw.keyword,
        text: row.keyword || raw.keyword,
        source: raw.source || (row.seed_type !== undefined ? 'idea' : 'historical'),
        seedType: raw.seedType ?? row.seed_type ?? null,
        seedKeywords: raw.seedKeywords ?? row.seed_keywords ?? [],
        seedUrl: raw.seedUrl ?? row.seed_url ?? null,
        seedSite: raw.seedSite ?? row.seed_site ?? null,
        closeVariants: raw.closeVariants ?? row.close_variants ?? [],
        avgMonthlySearches: raw.avgMonthlySearches ?? row.avg_monthly_searches,
        competition: raw.competition ?? row.competition,
        competitionIndex: raw.competitionIndex ?? row.competition_index,
        lowBidMicros: raw.lowBidMicros ?? row.low_bid_micros,
        highBidMicros: raw.highBidMicros ?? row.high_bid_micros,
        lowBid: raw.lowBid ?? microsNullable(row.low_bid_micros),
        highBid: raw.highBid ?? microsNullable(row.high_bid_micros),
        geoTargetConstants: raw.geoTargetConstants ?? row.geo_target_constants ?? [],
        language: raw.language ?? row.language ?? null,
        keywordPlanNetwork: raw.keywordPlanNetwork ?? row.keyword_plan_network ?? null,
        monthlySearchVolumes: Array.isArray(monthlySearchVolumes) ? monthlySearchVolumes : []
    };
}

function plannerDisplayFields(text: string, metric: any, perf: any, referenceCpa: number): any {
    const { monthlySearchVolumes: _monthlySearchVolumes, ...fields } = plannerFields(text, metric, perf, referenceCpa);
    return fields;
}

function compactPlannerMetric(metric: any): any {
    return {
        keyword: metric.keyword,
        text: metric.text,
        source: metric.source,
        seedType: metric.seedType,
        avgMonthlySearches: metric.avgMonthlySearches,
        competition: metric.competition,
        competitionIndex: metric.competitionIndex,
        lowBid: metric.lowBid,
        highBid: metric.highBid
    };
}

function sourceName(reportName: string): string {
    return reportName.replace(/_/g, '-');
}

function coverageSource(entry: CoverageEntry): SourceCoverageEntry {
    const status = entry.status === 'covered' ? 'ok' : entry.status === 'partial' ? 'failed' : entry.status;
    return {
        name: sourceName(entry.reportName),
        status,
        rows: entry.rowCount,
        generatedAt: entry.lastFetchedAt,
        ageHours: null,
        error: entry.error,
        message: entry.status === 'partial'
            ? `Partial coverage. Missing ${entry.missingDates.length}, failed ${entry.failedDates.length}.`
            : entry.error
    };
}

function buildSourceCoverage(bundle: DashboardReportBundle): SourceCoverageSummary {
    const coverageNames = new Set(bundle.coverage.map(entry => sourceName(entry.reportName)));
    const sources: SourceCoverageEntry[] = bundle.coverage.map(coverageSource);
    const addSnapshot = (name: string, rows: any[]) => {
        if (coverageNames.has(name)) return;
        sources.push({
            name,
            status: rows.length ? 'ok' : 'empty',
            rows: rows.length,
            generatedAt: null,
            ageHours: null
        });
    };
    addSnapshot('configured-keywords', bundle.configuredKeywords);
    addSnapshot('campaign-negatives', bundle.negatives.campaignNegatives);
    addSnapshot('ad-group-negatives', bundle.negatives.adGroupNegatives);
    addSnapshot('account-negatives', bundle.negatives.accountNegativeLists);
    addSnapshot('shared-negative-sets', bundle.negatives.sharedNegativeSets);
    addSnapshot('shared-negative-criteria', bundle.negatives.sharedNegativeCriteria);
    addSnapshot('campaign-shared-sets', bundle.negatives.campaignSharedSets);
    addSnapshot('keyword-planner-ideas', bundle.keywordPlannerIdeas);
    addSnapshot('keyword-planner-historical-metrics', bundle.keywordPlannerHistorical);
    addSnapshot('auction-insights-domains', bundle.auctionInsightsRows);
    addSnapshot('auction-insights-status', bundle.auctionInsightsStatus);
    addSnapshot('quality-score', bundle.qualityScores);
    return {
        generatedAt: new Date().toISOString(),
        sources,
        missingSources: sources.filter(entry => entry.status === 'missing').map(entry => entry.name),
        staleSources: sources.filter(entry => entry.status === 'stale').map(entry => entry.name),
        failedSources: sources.filter(entry => entry.status === 'failed').map(entry => entry.name)
    };
}

function configuredRules(bundle: DashboardReportBundle): ConfiguredKeywordRule[] {
    return rawRows(bundle.configuredKeywords)
        .map(configuredKeywordRuleFromReportRow)
        .filter((row): row is ConfiguredKeywordRule => Boolean(row));
}

function negativeRules(bundle: DashboardReportBundle, customerId: string): NegativeRule[] {
    return normalizeNegativeRulesFromReports({
        customerId,
        accountNegatives: rawRows(bundle.negatives.accountNegativeLists),
        campaignNegatives: rawRows(bundle.negatives.campaignNegatives),
        adGroupNegatives: rawRows(bundle.negatives.adGroupNegatives),
        sharedNegativeSets: rawRows(bundle.negatives.sharedNegativeSets),
        sharedNegativeCriteria: rawRows(bundle.negatives.sharedNegativeCriteria),
        campaignSharedSets: rawRows(bundle.negatives.campaignSharedSets)
    });
}

function termScope(filters: DashboardFilters, campaignId: any, campaignName: any, adGroupId?: any, adGroupName?: any): TermScope {
    return {
        customerId: filters.customerId,
        campaignId: clean(campaignId),
        campaignName: clean(campaignName),
        adGroupId: clean(adGroupId),
        adGroupName: clean(adGroupName)
    };
}

function decisionFields(term: string, scope: TermScope, negatives: NegativeRule[], configured: ConfiguredKeywordRule[], allowAnyScope = false): Record<string, any> {
    return flattenDecisionContext(decisionContextForTerm(term, scope, negatives, configured, { allowAnyScope }));
}

function getCampaignCategory(name: string) {
    const lower = String(name || '').toLowerCase();
    return lower.includes('comp') || lower.includes('competitor') ? 'competitor' : 'generic';
}

function signalPayload(row: any): any {
    const payload = row.payload || {};
    return {
        ...payload,
        signal_id: payload.signal_id || row.signal_id,
        type: payload.type || row.signal_type,
        severity: payload.severity || row.severity,
        campaign_id: payload.campaign_id || row.campaign_id,
        ad_group_id: payload.ad_group_id || row.ad_group_id,
        evidence_window: payload.evidence_window || {
            start: row.evidence_start_date,
            end: row.evidence_end_date
        }
    };
}

function metricSummary(rows: MetricFields[]): any {
    const aggregate = emptyAgg();
    rows.forEach(row => addMetric(aggregate, row));
    return finalizeAgg(aggregate as any);
}

function audienceMetricPayload(row: Record<string, any>): Record<string, number | null> {
    const spend = micros(row.cost_micros);
    const clicks = num(row.clicks);
    const impressions = num(row.impressions);
    const conversions = num(row.conversions);
    const allConversions = num(row.all_conversions);
    const interactions = num(row.interactions);
    const engagements = num(row.engagements);
    const activeViewImpressions = num(row.active_view_impressions);
    const activeViewMeasurableImpressions = num(row.active_view_measurable_impressions);
    const activeViewMeasurableCost = micros(row.active_view_measurable_cost_micros);
    const rate = (value: any) => {
        const parsed = maybeNum(value);
        return parsed === null ? null : +(parsed * 100).toFixed(2);
    };
    return {
        spend,
        clicks,
        impressions,
        conversions,
        allConversions,
        conversionValue: num(row.conversions_value),
        ctr: row.ctr == null ? (impressions ? +((clicks / impressions) * 100).toFixed(2) : 0) : rate(row.ctr),
        avgCpc: microsNullable(row.average_cpc_micros),
        cpa: row.cost_per_conversion_micros == null ? (conversions ? safeDiv(spend, conversions) : 0) : microsNullable(row.cost_per_conversion_micros),
        conversionRate: interactions ? +((conversions / interactions) * 100).toFixed(2) : 0,
        costPerAllConversion: allConversions ? +safeDiv(spend, allConversions).toFixed(2) : 0,
        allConversionRate: interactions ? +((allConversions / interactions) * 100).toFixed(2) : 0,
        interactions,
        interactionRate: rate(row.interaction_rate),
        averageCost: interactions ? +safeDiv(spend, interactions).toFixed(2) : 0,
        engagements,
        engagementRate: rate(row.engagement_rate),
        averageCpe: engagements ? +safeDiv(spend, engagements).toFixed(2) : 0,
        activeViewImpressions,
        activeViewMeasurableImpressions,
        activeViewNonViewableImpressions: Math.max(0, activeViewMeasurableImpressions - activeViewImpressions),
        activeViewNonMeasurableImpressions: Math.max(0, impressions - activeViewMeasurableImpressions),
        activeViewMeasurableCost,
        activeViewMeasurableRate: impressions ? +((activeViewMeasurableImpressions / impressions) * 100).toFixed(2) : 0,
        activeViewAverageViewableCpm: activeViewImpressions ? +((activeViewMeasurableCost / activeViewImpressions) * 1000).toFixed(2) : 0,
        activeViewViewableCtr: activeViewImpressions ? +((clicks / activeViewImpressions) * 100).toFixed(2) : 0,
        activeViewImpressionDistribution: impressions ? +((activeViewImpressions / impressions) * 100).toFixed(2) : 0,
        activeViewViewability: rate(row.active_view_viewability),
    };
}

function normalizedTargetRestrictions(value: any): Array<{ dimension: string; bidOnly: boolean }> {
    if (!Array.isArray(value)) return [];
    return value.map(entry => ({
        dimension: String(entry?.targetingDimension ?? entry?.targeting_dimension ?? '').trim().toUpperCase(),
        bidOnly: Boolean(entry?.bidOnly ?? entry?.bid_only)
    })).filter(entry => entry.dimension);
}

function buildAudiencePayload(bundle: DashboardReportBundle): any {
    const audienceCatalog = bundle.audienceCatalog || [];
    const campaignAudienceCriteria = bundle.campaignAudienceCriteria || [];
    const adGroupAudienceCriteria = bundle.adGroupAudienceCriteria || [];
    const campaignAudienceDaily = bundle.campaignAudienceDaily || [];
    const adGroupAudienceDaily = bundle.adGroupAudienceDaily || [];
    const ageRangeDaily = bundle.ageRangeDaily || [];
    const genderDaily = bundle.genderDaily || [];
    const incomeRangeDaily = bundle.incomeRangeDaily || [];
    const parentalStatusDaily = bundle.parentalStatusDaily || [];
    const campaignSnapshot = bundle.campaignSnapshot || [];
    const adGroupSnapshot = bundle.adGroupSnapshot || [];
    const catalogByResource = new Map(audienceCatalog.map(row => [row.resource_name, row]));
    const criteria = [
        ...campaignAudienceCriteria.map(row => ({ ...row, scope: 'campaign' as const })),
        ...adGroupAudienceCriteria.map(row => ({ ...row, scope: 'ad_group' as const }))
    ].map(row => {
        const catalog = row.audience_resource_name ? catalogByResource.get(row.audience_resource_name) : null;
        return {
            scope: row.scope,
            campaignId: row.campaign_id,
            campaign: row.campaign_name || row.campaign_id,
            adGroupId: row.ad_group_id || null,
            adGroup: row.ad_group_name || null,
            criterionId: row.criterion_id,
            resourceName: row.criterion_resource_name || null,
            criterionType: row.criterion_type,
            status: row.status || null,
            negative: Boolean(row.negative),
            bidModifier: maybeNum(row.bid_modifier),
            audienceResourceName: row.audience_resource_name || null,
            audienceId: row.audience_id || null,
            demographicValue: row.demographic_value || null,
            name: catalog?.name || row.demographic_value || row.audience_id || row.criterion_id,
            audienceType: catalog?.audience_type || row.criterion_type,
            category: catalog?.category || null
        };
    });
    const criteriaByKey = new Map(criteria.map(row => [
        `${row.scope}|${row.campaignId}|${row.adGroupId || ''}|${row.criterionId}`,
        row
    ]));
    const performance = (scope: 'campaign' | 'ad_group', rows: typeof bundle.campaignAudienceDaily) => rows.map(row => {
        const criterion = criteriaByKey.get(`${scope}|${row.campaign_id}|${row.ad_group_id || ''}|${row.criterion_id}`);
        return {
            date: row.date,
            scope,
            campaignId: row.campaign_id,
            campaign: row.campaign_name || row.campaign_id,
            adGroupId: row.ad_group_id || null,
            adGroup: row.ad_group_name || null,
            criterionId: row.criterion_id,
            resourceName: row.criterion_resource_name || null,
            criterionType: row.criterion_type || criterion?.criterionType || null,
            negative: Boolean(row.negative),
            status: row.status || criterion?.status || null,
            bidModifier: maybeNum(row.bid_modifier),
            audienceResourceName: criterion?.audienceResourceName || null,
            name: criterion?.name || row.criterion_id,
            audienceType: criterion?.audienceType || row.criterion_type || 'AUDIENCE',
            category: criterion?.category || null,
            ...audienceMetricPayload(row)
        };
    });
    const demographics = (dimension: string, rows: typeof bundle.ageRangeDaily) => rows.map(row => ({
        date: row.date,
        dimension,
        campaignId: row.campaign_id,
        campaign: row.campaign_name || row.campaign_id,
        adGroupId: row.ad_group_id,
        adGroup: row.ad_group_name || row.ad_group_id,
        criterionId: row.criterion_id,
        resourceName: row.criterion_resource_name || null,
        value: row.demographic_value,
        negative: Boolean(row.negative),
        status: row.status || null,
        bidModifier: maybeNum(row.bid_modifier),
        ...audienceMetricPayload(row)
    }));
    return {
        performance: {
            campaign: performance('campaign', campaignAudienceDaily),
            adGroup: performance('ad_group', adGroupAudienceDaily)
        },
        criteria,
        catalog: audienceCatalog.map(row => ({
            resourceName: row.resource_name,
            id: row.audience_id,
            name: row.name,
            audienceType: row.audience_type,
            category: row.category || null,
            parentResourceName: row.parent_resource_name || null,
            description: row.description || null,
            status: row.status || null,
            eligibleForSearch: row.eligible_for_search,
            eligibleForDisplay: row.eligible_for_display,
            sizeForSearch: maybeNum(row.size_for_search),
            sizeForDisplay: maybeNum(row.size_for_display),
            membershipLifeSpan: maybeNum(row.membership_life_span),
            readOnly: row.read_only,
            members: Array.isArray(row.members) ? row.members : []
        })),
        demographics: {
            age: demographics('age', ageRangeDaily),
            gender: demographics('gender', genderDaily),
            income: demographics('income', incomeRangeDaily),
            parentalStatus: demographics('parental_status', parentalStatusDaily)
        },
        targetingSettings: {
            campaigns: campaignSnapshot.map(row => ({
                campaignId: row.campaign_id,
                campaign: row.campaign_name || row.campaign_id,
                status: row.campaign_status || null,
                channelType: row.advertising_channel_type || null,
                channelSubType: row.advertising_channel_sub_type || null,
                restrictions: normalizedTargetRestrictions(row.targeting_restrictions)
            })),
            adGroups: adGroupSnapshot.map(row => ({
                campaignId: row.campaign_id,
                campaign: row.campaign_name || row.campaign_id,
                adGroupId: row.ad_group_id,
                adGroup: row.ad_group_name || row.ad_group_id,
                status: row.ad_group_status || null,
                restrictions: normalizedTargetRestrictions(row.targeting_restrictions)
            }))
        },
        capabilities: {
            publicCatalogSearch: true,
            publicCatalogBrowse: true,
            recentAndWebsiteIdeas: false,
            campaignTargeting: true,
            adGroupTargeting: true,
            exclusions: true,
            demographicEditing: true,
            customAudienceCreation: true,
            metricKeys: [
                'clicks', 'spend', 'impressions', 'ctr', 'interactions', 'interactionRate', 'engagements',
                'engagementRate', 'avgCpc', 'averageCost', 'averageCpe', 'cpa', 'conversionRate',
                'conversions', 'allConversions', 'costPerAllConversion', 'allConversionRate', 'conversionValue',
                'activeViewImpressions', 'activeViewNonViewableImpressions', 'activeViewMeasurableImpressions',
                'activeViewNonMeasurableImpressions', 'activeViewMeasurableCost', 'activeViewMeasurableRate',
                'activeViewAverageViewableCpm', 'activeViewViewableCtr', 'activeViewImpressionDistribution',
                'activeViewViewability'
            ],
            unsupportedMetricKeys: ['impressionShare', 'lostImpressionShareRank']
        }
    };
}

type BuildDashboardPayloadOptions = {
    view?: DashboardPayloadView;
};

function buildPayloadFromBundleSync(
    bundle: DashboardReportBundle,
    filters: DashboardFilters,
    filterOptions: any,
    options: BuildDashboardPayloadOptions = {}
): any {
    const view = options.view || 'full';
    const needsKeywordDiscovery = view === 'full' || view === 'keywords';
    const needsRankDiagnostics = view === 'full' || view === 'rank';
    const summaryRows = filters.adGroupId
        ? bundle.adGroupDaily
        : filters.campaignId
            ? bundle.campaignDaily
            : bundle.accountDaily;
    const globalSummary = metricSummary(bundle.accountDaily);
    const acct = metricSummary(summaryRows);
    const currency = clean(bundle.accountDaily.find(row => row.currency_code)?.currency_code) || 'INR';
    const fallbackCpaBenchmark = cpaBenchmarkForAccount(acct.cpa, currency);

    const campaignSnapshots = new Map(bundle.campaignSnapshot.map(row => [row.campaign_id, row]));
    const adGroupSnapshots = new Map(bundle.adGroupSnapshot.map(row => [`${row.campaign_id}|${row.ad_group_id}`, row]));
    const plannerRows = needsKeywordDiscovery
        ? [...bundle.keywordPlannerHistorical.map(plannerMetric), ...bundle.keywordPlannerIdeas.map(plannerMetric)]
        : [];
    const plannerByKeyword = plannerRows.length ? plannerMap(plannerRows) : new Map<string, any>();
    const qualityByCriterion = new Map(bundle.qualityScores.map(row => [`${row.campaign_id}|${row.ad_group_id}|${row.criterion_id}`, row]));
    const negatives = needsKeywordDiscovery || needsRankDiagnostics ? negativeRules(bundle, filters.customerId) : [];
    const configured = needsKeywordDiscovery ? configuredRules(bundle) : [];

    const campaignDaily = bundle.campaignDaily.map(row => ({
        ...row,
        name: row.campaign_name || row.campaign_id,
        id: row.campaign_id,
        status: row.campaign_status || campaignSnapshots.get(row.campaign_id)?.campaign_status || null,
        campaign: row.campaign_name || row.campaign_id,
        campaignId: row.campaign_id
    }));
    const campaigns = aggregateBy(campaignDaily, row => row.campaign_id, row => {
        const snap = campaignSnapshots.get(row.campaign_id);
        return {
            date: row.date,
            name: snap?.campaign_name || row.campaign_name || row.campaign_id,
            id: row.campaign_id,
            campaignId: row.campaign_id,
            status: snap?.campaign_status || row.campaign_status || null,
            biddingStrategy: snap?.bidding_strategy_type || row.bidding_strategy_type || null,
            targetCpa: microsNullable(snap?.target_cpa_micros ?? row.target_cpa_micros),
            targetRoas: maybeNum(snap?.target_roas ?? row.target_roas),
            budget: microsNullable(snap?.budget_amount_micros ?? row.budget_amount_micros),
            budgetResourceName: snap?.campaign_budget_resource_name || row.campaign_budget_resource_name || null,
            label: ''
        };
    });
    const dailyCampaigns = aggregateBy(campaignDaily, row => row.date, row => ({ date: row.date }));

    const adGroupDaily = bundle.adGroupDaily.map(row => ({
        ...row,
        name: row.ad_group_name || row.ad_group_id,
        id: row.ad_group_id,
        campaign: row.campaign_name || row.campaign_id,
        campaignId: row.campaign_id,
        adGroup: row.ad_group_name || row.ad_group_id,
        adGroupId: row.ad_group_id,
        status: row.ad_group_status || adGroupSnapshots.get(`${row.campaign_id}|${row.ad_group_id}`)?.ad_group_status || null
    }));
    const adGroups = aggregateBy(adGroupDaily, row => `${row.campaign_id}|${row.ad_group_id}`, row => {
        const snap = adGroupSnapshots.get(`${row.campaign_id}|${row.ad_group_id}`);
        return {
            date: row.date,
            name: snap?.ad_group_name || row.ad_group_name || row.ad_group_id,
            id: row.ad_group_id,
            status: snap?.ad_group_status || row.ad_group_status || null,
            campaignId: row.campaign_id,
            campaign: snap?.campaign_name || row.campaign_name || row.campaign_id,
            adGroupId: row.ad_group_id,
            adGroup: snap?.ad_group_name || row.ad_group_name || row.ad_group_id
        };
    });
    const dailyAdGroups = aggregateBy(adGroupDaily, row => row.date, row => ({ date: row.date }));
    const dailyTrendSource: Array<MetricFields & { date: string }> = bundle.adGroupDaily.length
        ? bundle.adGroupDaily
        : bundle.campaignDaily;
    const dailyTrend = aggregateBy(dailyTrendSource, row => row.date, row => ({ date: row.date }))
        .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    const catStats = { competitor: { spend: 0, conv: 0 }, generic: { spend: 0, conv: 0 } };
    for (const campaign of campaigns) {
        const cat = getCampaignCategory(campaign.name);
        catStats[cat as keyof typeof catStats].spend += campaign.spend || 0;
        catStats[cat as keyof typeof catStats].conv += campaign.conversions || 0;
    }
    const historicalCpaBenchmarks = {
        competitor: catStats.competitor.conv > 0 ? safeDiv(catStats.competitor.spend, catStats.competitor.conv) : fallbackCpaBenchmark,
        generic: catStats.generic.conv > 0 ? safeDiv(catStats.generic.spend, catStats.generic.conv) : fallbackCpaBenchmark
    };

    const aggregatedKeywordRows = aggregateBy(bundle.keywordDaily, row => `${row.campaign_id}|${row.ad_group_id}|${row.criterion_id}`, row => {
        const text = row.keyword_text || '';
        const quality = qualityByCriterion.get(`${row.campaign_id}|${row.ad_group_id}|${row.criterion_id}`);
        return {
            date: row.date,
            campaignId: row.campaign_id,
            adGroupId: row.ad_group_id,
            criterionId: row.criterion_id,
            resourceName: row.criterion_resource_name || null,
            cpcBidMicros: row.cpc_bid_micros || null,
            keyword: text,
            matchType: row.match_type,
            status: row.criterion_status,
            campaign: row.campaign_name || row.campaign_id,
            biddingStrategy: row.bidding_strategy_type || null,
            adGroup: row.ad_group_name || row.ad_group_id,
            qualityScore: quality?.quality_score || null,
            isCompetitor: COMPETITOR_ROOTS.some(root => normKey(text).includes(root)),
            label: ''
        };
    });
    const keywordRows = (needsKeywordDiscovery
        ? aggregatedKeywordRows
        : needsRankDiagnostics
            ? aggregatedKeywordRows.filter(row => row.isCompetitor)
            : aggregatedKeywordRows
    ).map(row => {
        if (!needsKeywordDiscovery) return row;
        return {
            ...row,
            ...plannerDisplayFields(row.keyword, plannerByKeyword.get(normKey(row.keyword)), row, fallbackCpaBenchmark),
            ...decisionFields(row.keyword, termScope(filters, row.campaignId, row.campaign, row.adGroupId, row.adGroup), negatives, configured)
        };
    });

    const keywordPerf = needsKeywordDiscovery
        ? new Map(keywordRows.map(row => [`${row.campaignId}|${row.adGroupId}|${normKey(row.keyword)}|${row.matchType}`, row]))
        : new Map<string, any>();
    const configuredKeywords = needsKeywordDiscovery ? bundle.configuredKeywords.map(row => {
        const text = row.keyword_text || '';
        const key = `${row.campaign_id}|${row.ad_group_id}|${normKey(text)}|${row.match_type}`;
        const perf = keywordPerf.get(key) || {};
        const finalUrls = Array.isArray(row.final_urls) ? row.final_urls : [];
        const out = {
            campaignId: row.campaign_id,
            adGroupId: row.ad_group_id,
            criterionId: row.criterion_id,
            resourceName: row.criterion_resource_name || null,
            keywordText: text,
            keyword: text,
            matchType: row.match_type || null,
            status: row.status || null,
            campaign: row.campaign_name || row.campaign_id,
            adGroup: row.ad_group_name || row.ad_group_id,
            spend: perf.spend || 0,
            clicks: perf.clicks || 0,
            impressions: perf.impressions || 0,
            ctr: perf.ctr || 0,
            avgCpc: perf.avgCpc || 0,
            conversions: perf.conversions || 0,
            cvr: perf.cvr || 0,
            cpa: perf.cpa || 0,
            finalUrl: finalUrls[0] || '',
            primaryStatus: row.primary_status || '',
            primaryStatusReasons: row.primary_status_reasons || []
        };
        return {
            ...out,
            ...decisionFields(text, termScope(filters, row.campaign_id, row.campaign_name, row.ad_group_id, row.ad_group_name), negatives, configured)
        };
    }) : [];

    const aggregatedSearchTerms = aggregateBy(bundle.searchTermDaily, row => `${row.campaign_id}|${row.ad_group_id}|${normKey(row.search_term)}`, row => ({
        date: row.date,
        campaignId: row.campaign_id,
        adGroupId: row.ad_group_id,
        searchTerm: row.search_term,
        status: row.search_term_status,
        campaign: row.campaign_name || row.campaign_id,
        adGroup: row.ad_group_name || row.ad_group_id,
        matchedKeyword: row.matched_keyword_text || null,
        keywordMatchType: row.matched_keyword_match_type || null,
        searchTermMatchType: row.search_term_match_type || null,
        searchTermMatchSource: row.search_term_match_source || null,
        isCompetitor: COMPETITOR_ROOTS.some(root => normKey(row.search_term).includes(root)),
        hasLowIntent: /\b(free|job|login|support|tutorial|template|meaning|download|salary|career|internship)\b/.test(normKey(row.search_term))
    }));
    const searchTermsForView = needsKeywordDiscovery
        ? aggregatedSearchTerms
        : needsRankDiagnostics
            ? aggregatedSearchTerms.filter(row => row.isCompetitor)
            : aggregatedSearchTerms;
    const searchTerms = searchTermsForView.map(row => {
        const coverage = decisionFields(row.searchTerm, termScope(filters, row.campaignId, row.campaign, row.adGroupId, row.adGroup), negatives, configured);
        if (!needsKeywordDiscovery) {
            return {
                ...row,
                ...coverage
            };
        }
        const label = coverage.isNegativeCovered
            ? 'Already excluded'
            : coverage.isConfiguredKeyword
                ? 'Already configured'
                : row.conversions > 0
                    ? 'Promote candidate'
                    : row.hasLowIntent || row.clicks >= 2
                        ? 'Negative candidate'
                        : 'Watch';
        return {
            ...row,
            ...plannerDisplayFields(row.searchTerm, plannerByKeyword.get(normKey(row.searchTerm)), row, fallbackCpaBenchmark),
            label,
            decisionClassification: coverage.isNegativeCovered
                ? 'already_excluded'
                : coverage.isConfiguredKeyword
                    ? 'already_configured'
                    : label.toLowerCase().includes('negative')
                        ? 'negative_candidate'
                        : label.toLowerCase().includes('promote')
                            ? 'add_keyword_candidate'
                            : 'monitor',
            ...coverage
        };
    });

    const existingKeywordSet = needsKeywordDiscovery ? new Set(configuredKeywords.map(row => normKey(row.keyword))) : new Set<string>();
    const existingSearchTermSet = needsKeywordDiscovery ? new Set(searchTerms.map(row => normKey(row.searchTerm))) : new Set<string>();
    const plannerIdeas = needsKeywordDiscovery ? bundle.keywordPlannerIdeas.map(row => {
        const metric = plannerMetric(row);
        const coverage = decisionFields(metric.keyword, { customerId: filters.customerId }, negatives, configured, true);
        return {
            ...compactPlannerMetric(metric),
            ...plannerDisplayFields(metric.keyword, metric, {}, fallbackCpaBenchmark),
            inAccountKeyword: coverage.isConfiguredKeyword || existingKeywordSet.has(normKey(metric.keyword)),
            inAccountSearchTerm: existingSearchTermSet.has(normKey(metric.keyword)),
            blockedByNegative: coverage.isNegativeCovered,
            plannerClassification: coverage.isNegativeCovered
                ? 'blocked_by_negative'
                : coverage.isConfiguredKeyword || existingKeywordSet.has(normKey(metric.keyword))
                    ? 'already_configured'
                    : existingSearchTermSet.has(normKey(metric.keyword))
                        ? 'already_seen'
                        : 'new_opportunity',
            ...coverage
        };
    }).sort((a, b) => num(b.plannerScore) - num(a.plannerScore) || num(b.avgMonthlySearches) - num(a.avgMonthlySearches)) : [];
    const plannerHistoricalMetrics = needsKeywordDiscovery
        ? bundle.keywordPlannerHistorical.map(row => compactPlannerMetric(plannerMetric(row)))
        : [];

    const qualityScores = bundle.qualityScores.map(row => ({
        campaignId: row.campaign_id,
        campaign: row.campaign_name || row.campaign_id,
        adGroupId: row.ad_group_id,
        adGroup: row.ad_group_name || row.ad_group_id,
        criterionId: row.criterion_id,
        keyword: row.keyword_text,
        matchType: row.match_type,
        status: row.status,
        qualityScore: row.quality_score || 0,
        adRelevance: row.creative_quality_score || 'UNSPECIFIED',
        landingPageExperience: row.post_click_quality_score || 'UNSPECIFIED',
        expectedCtr: row.search_predicted_ctr || 'UNSPECIFIED'
    }));

    const negativesData = negatives;
    const conversionActions = aggregateBy(bundle.conversionActionDaily as any[], row => row.conversion_action_resource_name, row => ({
        date: row.date,
        sourceScope: 'account',
        campaign: null,
        adGroup: null,
        campaignId: null,
        adGroupId: null,
        id: row.conversion_action_resource_name,
        name: row.conversion_action_name,
        category: row.conversion_action_category,
        status: row.conversion_action_status,
        primaryForGoal: Boolean(row.primary_for_goal),
        conversionsValue: num(row.conversions_value)
    }));
    const conversionAttribution = bundle.conversionSearchTermDaily.map(row => ({
        date: row.date,
        campaign: row.campaign_name || row.campaign_id,
        adGroup: row.ad_group_name || row.ad_group_id,
        searchTerm: row.search_term,
        conversionAction: row.conversion_action_name,
        conversionCategory: row.conversion_action_category,
        conversions: num(row.conversions),
        allConversions: num(row.conversions)
    }));
    const clickPaths = bundle.keywordClickDaily.map(row => ({
        date: row.date,
        campaign: row.campaign_name || row.campaign_id,
        campaignId: row.campaign_id,
        adGroup: row.ad_group_name || row.ad_group_id,
        adGroupId: row.ad_group_id,
        keyword: row.keyword_text,
        matchType: row.match_type,
        slot: row.slot || 'UNSPECIFIED',
        device: row.device || 'UNSPECIFIED',
        clicks: num(row.clicks)
    }));

    const landingPages = aggregateBy(bundle.landingPageDaily, row => row.unexpanded_final_url || row.url_hash, row => ({
        date: row.date,
        campaignId: row.campaign_id,
        campaign: row.campaign_name || row.campaign_id,
        adGroupId: row.ad_group_id,
        adGroup: row.ad_group_name || row.ad_group_id,
        finalUrl: row.unexpanded_final_url
    }));
    const expandedLandingPages = aggregateBy(bundle.expandedLandingPageDaily, row => row.expanded_final_url || row.url_hash, row => ({
        date: row.date,
        campaignId: row.campaign_id,
        campaign: row.campaign_name || row.campaign_id,
        adGroupId: row.ad_group_id,
        adGroup: row.ad_group_name || row.ad_group_id,
        expandedFinalUrl: row.expanded_final_url
    }));
    const devicePerformance = aggregateBy(bundle.deviceDaily, row => row.device, row => ({
        date: row.date,
        campaign: row.campaign_name || row.campaign_id,
        campaignId: row.campaign_id,
        adGroup: row.ad_group_name || row.ad_group_id,
        adGroupId: row.ad_group_id,
        device: row.device
    }));
    const dayOfWeekPerformance = aggregateBy(bundle.dayOfWeekDaily, row => row.day_of_week, row => ({
        date: row.date,
        campaign: row.campaign_name || row.campaign_id,
        campaignId: row.campaign_id,
        adGroup: row.ad_group_name || row.ad_group_id,
        adGroupId: row.ad_group_id,
        day: row.day_of_week
    }));
    const dayAndHourPerformance = aggregateBy(bundle.dayHourDaily, row => `${row.day_of_week}|${row.hour}`, row => ({
        date: row.date,
        campaign: row.campaign_name || row.campaign_id,
        campaignId: row.campaign_id,
        adGroup: row.ad_group_name || row.ad_group_id,
        adGroupId: row.ad_group_id,
        day: row.day_of_week,
        hour: row.hour
    }));

    const auctionInsights = buildAuctionInsightsSummary({
        rows: bundle.auctionInsightsRows,
        previousRows: bundle.auctionInsightsPreviousRows,
        accountDaily: bundle.accountDaily,
        campaignDaily: bundle.campaignDaily,
        adGroupDaily: bundle.adGroupDaily,
        previousPerformanceRows: bundle.auctionInsightsPreviousPerformance,
        filters
    });
    const auctionInsightsStatus = bundle.auctionInsightsStatus.map(row => ({
        entityType: row.entity_type,
        entityId: row.entity_id,
        entityName: row.entity_name,
        status: row.status,
        sheetName: row.sheet_name,
        rows: num(row.rows_fetched),
        message: row.message,
        spreadsheetId: row.spreadsheet_id,
        spreadsheetModifiedTime: row.spreadsheet_modified_time
    }));
    const candidateSignals = bundle.candidateSignals.map(signalPayload);
    const sourceCoverage = buildSourceCoverage(bundle);
    const audiences = buildAudiencePayload(bundle);

    const competitorBreakdown = COMPETITOR_ROOTS.map(name => {
        const kwRows = keywordRows.filter(row => normKey(row.keyword).includes(name));
        const stRows = searchTerms.filter(row => normKey(row.searchTerm).includes(name));
        const spend = +kwRows.reduce((sum, row) => sum + num(row.spend), 0).toFixed(2);
        const conversions = +kwRows.reduce((sum, row) => sum + num(row.conversions), 0).toFixed(2);
        const clicks = kwRows.reduce((sum, row) => sum + num(row.clicks), 0);
        const impressions = kwRows.reduce((sum, row) => sum + num(row.impressions), 0);
        const searchSpend = +stRows.reduce((sum, row) => sum + num(row.spend), 0).toFixed(2);
        const negativeCoveredSpend = +stRows.filter(row => row.isNegativeCovered).reduce((sum, row) => sum + num(row.spend), 0).toFixed(2);
        return {
            competitor: name,
            spend,
            clicks,
            impressions,
            conversions,
            cpa: conversions ? safeDiv(spend, conversions) : 0,
            ctr: impressions ? +((clicks / impressions) * 100).toFixed(2) : 0,
            impressionShare: kwRows.find(row => row.impressionShare != null)?.impressionShare ?? null,
            qualityScore: qualityScores.find(row => normKey(row.keyword).includes(name))?.qualityScore || null,
            searchTermSpend: searchSpend,
            searchTermConversions: +stRows.reduce((sum, row) => sum + num(row.conversions), 0).toFixed(2),
            negativeCoverageKnown: stRows.length > 0,
            negativeCoveredSpend,
            negativeUncoveredSpend: stRows.length ? +Math.max(searchSpend - negativeCoveredSpend, 0).toFixed(2) : null,
            negativeCoverageSources: Array.from(new Set(stRows.filter(row => row.isNegativeCovered).map(row => row.negativeCoverageSource).filter(Boolean)))
        };
    });

    const competitorSpend = +competitorBreakdown.reduce((sum, row) => sum + num(row.spend), 0).toFixed(2);
    const competitorConv = +competitorBreakdown.reduce((sum, row) => sum + num(row.conversions), 0).toFixed(2);
    const conversionActionTotals = Object.values(conversionActions.reduce((acc: any, row: any) => {
        const key = row.name || 'Unknown';
        acc[key] ||= { name: key, category: row.category, status: row.status, conversions: 0, primaryForGoal: row.primaryForGoal };
        acc[key].conversions += num(row.conversions);
        return acc;
    }, {})).sort((a: any, b: any) => b.conversions - a.conversions);
    const insights = {
        conversionActionTotals,
        constraints: campaigns.map(row => ({
            campaign: row.name,
            impressionShare: row.impressionShare,
            lostISBudget: row.lostISBudget,
            lostISRank: row.lostISRank
        }))
    };
    const periodComparison = (() => {
        const midpoint = Math.floor(dailyTrend.length / 2);
        const prevRows = dailyTrend.slice(0, midpoint);
        const currRows = dailyTrend.slice(midpoint);
        const sumRows = (rows: any[]) => {
            const spend = +rows.reduce((sum, row) => sum + num(row.spend), 0).toFixed(2);
            const clicks = rows.reduce((sum, row) => sum + num(row.clicks), 0);
            const impressions = rows.reduce((sum, row) => sum + num(row.impressions), 0);
            const conversions = rows.reduce((sum, row) => sum + num(row.conversions), 0);
            return { spend, clicks, impressions, conversions, cpa: conversions ? safeDiv(spend, conversions) : 0 };
        };
        const delta = (current: number, previous: number) => previous === 0 ? (current > 0 ? 100 : 0) : +(((current - previous) / previous) * 100).toFixed(1);
        const prev = sumRows(prevRows);
        const curr = sumRows(currRows);
        return {
            previousPeriod: { label: prevRows.length ? `${prevRows[0].date} - ${prevRows[prevRows.length - 1].date}` : 'No data', ...prev },
            currentPeriod: { label: currRows.length ? `${currRows[0].date} - ${currRows[currRows.length - 1].date}` : 'No data', ...curr },
            deltas: {
                spend: delta(curr.spend, prev.spend),
                clicks: delta(curr.clicks, prev.clicks),
                impressions: delta(curr.impressions, prev.impressions),
                conversions: delta(curr.conversions, prev.conversions)
            }
        };
    })();
    const anomalies = dailyTrend.length >= 7
        ? dailyTrend.filter(row => row.spend > acct.spend / Math.max(dailyTrend.length, 1) * 1.8)
            .map(row => ({ date: row.date, metric: 'spend', value: row.spend, message: `Spend spike: ${row.spend}` }))
        : [];

    const keywordPlanner = {
        status: {
            status: plannerIdeas.length || plannerHistoricalMetrics.length ? 'ok' : 'empty',
            ideas: plannerIdeas.length,
            historicalMetrics: plannerHistoricalMetrics.length,
            message: plannerIdeas.length || plannerHistoricalMetrics.length ? 'Keyword Planner data loaded from warehouse.' : 'Keyword Planner has not run yet.'
        },
        ideas: plannerIdeas,
        historicalMetrics: plannerHistoricalMetrics
    };
    const accountStartDate = dashboardAccountStartDate();

    const payload: any = {
        meta: {
            generatedAt: new Date().toISOString(),
            accountId: filters.customerId,
            currency,
            accountStartDate,
            dateRange: { start: filters.startDate, end: filters.endDate },
            filters: {
                campaignId: filters.campaignId || null,
                adGroupId: filters.adGroupId || null
            },
            historicalCpaBenchmarks
        },
        filterOptions: { ...(filterOptions || {}), accountStartDate },
        sourceCoverage,
        decisionContext: null,
        summary: acct,
        globalSummary,
        periodComparison,
        anomalies,
        insights,
        dailyTrend,
        campaigns,
        dailyCampaigns,
        adGroups,
        rankShareEntities: filters.adGroupId ? adGroups : campaigns,
        dailyRankShare: filters.adGroupId ? dailyAdGroups : dailyCampaigns,
        keywords: keywordRows,
        configuredKeywords,
        negatives: negativesData,
        searchTerms,
        keywordPlanner,
        conversionActions,
        conversionAttribution,
        clickPaths,
        qualityScores,
        landingPages,
        expandedLandingPages,
        auctionInsights,
        auctionInsightsStatus,
        competitorRoots: COMPETITOR_ROOTS,
        competitorBreakdown,
        competitorSpend,
        competitorConv,
        competitorSpendShare: acct.spend ? safeDiv(competitorSpend, acct.spend) : 0,
        devicePerformance,
        dayOfWeekPerformance,
        dayAndHourPerformance,
        audiences,
        attributionCapability: {
            canReadConversionActions: conversionActions.length > 0,
            canAttributeActionsToSearchTerms: conversionAttribution.length > 0,
            canReadClickIds: false,
            canReadKeywordClickDetails: clickPaths.length > 0,
            canReadAuctionInsightDomains: auctionInsights.rows.length > 0,
            exactSessionProofRequiresSiteCapture: true,
            requiredSiteFields: ['gclid', 'gbraid', 'wbraid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'session_id', 'lead_id']
        },
        candidateSignals,
        proposals: []
    };
    payload.decisionContext = buildDecisionContextSummary({
        negativeRules: negatives,
        configuredKeywords: configured,
        searchTerms,
        plannerIdeas,
        plannerHistoricalMetrics,
        candidateSignals,
        sourceCoverage,
        decisionInputs: {
            keywordPlannerStatus: keywordPlanner.status.status,
            auctionInsightsRows: auctionInsights.meta.sourceRows,
            auctionInsightsStatusRows: auctionInsightsStatus.length,
            qualityScoreRows: qualityScores.length,
            landingPageRows: landingPages.length,
            expandedLandingPageRows: expandedLandingPages.length,
            deviceRows: devicePerformance.length,
            dayOfWeekRows: dayOfWeekPerformance.length,
            dayAndHourRows: dayAndHourPerformance.length
        }
    });
    return payload;
}

export async function buildDashboardPayloadFromBundle(
    bundle: DashboardReportBundle,
    filters: DashboardFilters,
    filterOptions: any,
    options: BuildDashboardPayloadOptions = {}
): Promise<any> {
    return buildPayloadFromBundleSync(bundle, filters, filterOptions, options);
}

type AttachLiveDashboardOptions = {
    leadMode?: 'full' | 'overview' | 'none';
    includeProposals?: boolean;
    includeDiagnoses?: boolean;
};

export type DashboardTimingSink = (name: string, durationMs: number) => void;

type DashboardPayloadForViewOptions = {
    filtersResolved?: boolean;
    timings?: DashboardTimingSink;
    bypassViewCache?: boolean;
    warehouseWatermark?: string;
    liveAttach?: Partial<AttachLiveDashboardOptions>;
};

function defaultLiveAttachOptions(view: DashboardPayloadView): AttachLiveDashboardOptions {
    return {
        includeProposals: view === 'proposals',
        includeDiagnoses: view === 'proposals',
        leadMode: ['overview', 'attribution', 'keywords', 'rank', 'proposals'].includes(view) ? 'overview' : 'none'
    };
}

function resolveLiveAttachOptions(view: DashboardPayloadView, override?: Partial<AttachLiveDashboardOptions>): AttachLiveDashboardOptions {
    return {
        ...defaultLiveAttachOptions(view),
        ...(override || {})
    };
}

function liveAttachCacheVariant(options: AttachLiveDashboardOptions): string {
    return [
        `lead:${options.leadMode || 'full'}`,
        `proposals:${options.includeProposals !== false ? '1' : '0'}`,
        `diagnoses:${options.includeDiagnoses !== false ? '1' : '0'}`
    ].join('|');
}

async function timed<T>(sink: DashboardTimingSink | undefined, name: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
        return await fn();
    } finally {
        sink?.(name, Date.now() - start);
    }
}

async function attachRefreshRunMetadata(pool: Pool, payload: any): Promise<void> {
    const { rows } = await pool.query(
        `SELECT id, kind, status, customer_id, requested_start_date, requested_end_date,
                effective_start_date, effective_end_date, started_at, completed_at, source_summary, error
         FROM google_ads_refresh_runs
         WHERE customer_id = $1 OR customer_id IS NULL
         ORDER BY started_at DESC
         LIMIT 1`,
        [payload.meta.accountId]
    );
    const refreshRun = rows[0] || null;
    if (!refreshRun) return;
    const sourceSummary = refreshRun.source_summary || {};
    const failedReports = Array.from(new Set([
        ...(Array.isArray(sourceSummary.failedReports) ? sourceSummary.failedReports : []),
        ...Object.entries(sourceSummary)
            .filter(([, value]: [string, any]) => value?.status === 'failed')
            .map(([name]) => name)
    ].map(value => sourceName(String(value)))));
    const missingReports = Array.from(new Set(Object.entries(sourceSummary)
        .filter(([, value]: [string, any]) => value?.status === 'missing')
        .map(([name]) => sourceName(String(name)))));
    payload.sourceCoverage = {
        ...(payload.sourceCoverage || {}),
        failedSources: Array.from(new Set([...(payload.sourceCoverage?.failedSources || []), ...failedReports])),
        missingSources: Array.from(new Set([...(payload.sourceCoverage?.missingSources || []), ...missingReports])),
        refreshRun
    };
    payload.decisionContext = {
        ...(payload.decisionContext || {}),
        sourceCoverage: {
            ...(payload.decisionContext?.sourceCoverage || {}),
            failedSources: payload.sourceCoverage.failedSources,
            missingSources: payload.sourceCoverage.missingSources,
            refreshRunStatus: refreshRun.status,
            failedReports,
            sourceSummary
        }
    };
}

function addCleanValue(target: Set<string>, value: any): void {
    const text = clean(value);
    if (text) target.add(text);
}

function proposalScopedIds(proposal: any, field: 'campaign_id' | 'ad_group_id'): Set<string> {
    const ids = new Set<string>();
    const camelField = field === 'campaign_id' ? 'campaignId' : 'adGroupId';
    addCleanValue(ids, proposal?.[field]);
    addCleanValue(ids, proposal?.[camelField]);
    for (const option of Array.isArray(proposal?.options) ? proposal.options : []) {
        const spec = option?.verification_spec || option?.verificationSpec || {};
        const entity = spec.entity || {};
        const expected = spec.expected || {};
        addCleanValue(ids, entity[field]);
        addCleanValue(ids, entity[camelField]);
        addCleanValue(ids, expected[field]);
        addCleanValue(ids, expected[camelField]);
        addCleanValue(ids, option?.baseline_metrics?.entity?.[field]);
        addCleanValue(ids, option?.baseline_metrics?.[field]);
    }
    return ids;
}

function proposalMatchesFilters(proposal: any, filters: DashboardFilters): boolean {
    if (filters.campaignId) {
        const campaignIds = proposalScopedIds(proposal, 'campaign_id');
        if (campaignIds.size > 0 && !campaignIds.has(filters.campaignId)) return false;
    }
    if (filters.adGroupId) {
        const adGroupIds = proposalScopedIds(proposal, 'ad_group_id');
        if (adGroupIds.size > 0 && !adGroupIds.has(filters.adGroupId)) return false;
    }
    return true;
}

export async function attachLiveDashboardData(
    pool: Pool,
    payload: any,
    filters: DashboardFilters,
    options: AttachLiveDashboardOptions = {}
): Promise<any> {
    const includeProposals = options.includeProposals !== false;
    const includeDiagnoses = options.includeDiagnoses !== false;
    const [proposalsResult, impactResult, diagnosesResult, leadAttribution] = await Promise.all([
        includeProposals ? pool.query(`
            SELECT payload
            FROM proposals
            ORDER BY
                CASE status
                    WHEN 'pending_review' THEN 1
                    WHEN 'accepted' THEN 2
                    WHEN 'user_marked_implemented' THEN 3
                    WHEN 'monitoring_14' THEN 4
                    WHEN 'monitoring_30' THEN 5
                    WHEN 'completed' THEN 6
                    ELSE 7
                END,
                updated_at DESC NULLS LAST,
                created_at DESC
        `) : Promise.resolve({ rows: [] }),
        includeProposals ? pool.query(`
            SELECT option_uid, option_id, proposal_id, selected_option_id, campaign_id, strategy_id,
                   tracking_status, detected_at, outcome_14, outcome_30,
                   lead_outcome_14, lead_outcome_30, outcome_details_14, outcome_details_30
            FROM impact_tracking
            ORDER BY detected_at DESC
        `) : Promise.resolve({ rows: [] }),
        includeDiagnoses ? pool.query(`SELECT payload FROM ai_diagnoses`) : Promise.resolve({ rows: [] }),
        options.leadMode === 'none'
            ? Promise.resolve(null)
            : getLeadAttributionSummary(pool, payload, { mode: options.leadMode || 'full' })
    ]);
    const impactsByProposal = new Map<string, any[]>();
    for (const row of impactResult.rows) {
        if (!row.proposal_id) continue;
        const list = impactsByProposal.get(row.proposal_id) || [];
        list.push(row);
        impactsByProposal.set(row.proposal_id, list);
    }
    if (includeProposals) {
        const proposalRows = proposalsResult.rows
            .map((row: any) => ({ ...row, payload: row.payload || {} }))
            .filter((row: any) => proposalMatchesFilters(row.payload, filters));
        const proposalIds = proposalRows.map((row: any) => row.payload?.proposal_id).filter(Boolean);
        const feedbackByProposal = await proposalFeedbackByProposalIds(pool, proposalIds);
        payload.proposals = proposalRows.map((row: any) => {
            const proposal = row.payload || {};
            const impactTracking = impactsByProposal.get(proposal.proposal_id) || [];
            const feedback = feedbackByProposal.get(proposal.proposal_id) || [];
            const latestImpact = impactTracking.find(item => item.outcome_details_30)
                || impactTracking.find(item => item.outcome_details_14)
                || impactTracking[0]
                || null;
            return { ...proposal, feedback, impact_tracking: impactTracking, latest_impact: latestImpact };
        });
    } else {
        payload.proposals = payload.proposals || [];
    }
    payload.aiDiagnoses = diagnosesResult.rows.map((row: any) => row.payload);
    if (leadAttribution) payload.leadAttribution = leadAttribution;
    attachLeadPeriodComparisonMetrics(payload);
    await attachRefreshRunMetadata(pool, payload);
    enrichDashboardDecisionRows(payload, payload.leadAttribution);
    if (payload.leadAttribution) payload.leadAttribution = trimLeadAttributionForResponse(payload.leadAttribution);
    const accountStartDate = dashboardAccountStartDate();
    payload.meta = {
        ...(payload.meta || {}),
        accountStartDate,
        filters: {
            campaignId: filters.campaignId || null,
            adGroupId: filters.adGroupId || null
        }
    };
    payload.filterOptions = {
        ...(payload.filterOptions || {}),
        accountStartDate
    };
    return payload;
}

async function buildDashboardPayloadForResolvedFilters(pool: Pool, filters: DashboardFilters): Promise<any> {
    filters = validateDashboardFilters(filters);
    const watermark = await getWarehouseWatermark(pool, filters);
    const memoryCached = getMemoryCachedAdsPayload(filters, watermark);
    if (memoryCached) return attachLiveDashboardData(pool, memoryCached, filters);

    const cached = await getCachedDashboardPayload(pool, filters, watermark);
    if (cached) {
        setMemoryCachedAdsPayload(filters, watermark, cached);
        return attachLiveDashboardData(pool, clonePayload(cached), filters);
    }

    const [bundle, filterOptions] = await Promise.all([
        getDashboardReportBundle(pool, filters),
        getAvailableDashboardFilters(pool, filters.customerId)
    ]);
    const payload = await buildDashboardPayloadFromBundle(bundle, filters, filterOptions);
    setMemoryCachedAdsPayload(filters, watermark, payload);
    await setCachedDashboardPayload(pool, filters, watermark, payload);
    return attachLiveDashboardData(pool, clonePayload(payload), filters);
}

export async function buildDashboardPayload(pool: Pool, rawFilters: DashboardFilters): Promise<any> {
    const filters = await assertKnownFilterSelection(pool, validateDashboardFilters(rawFilters));
    return buildDashboardPayloadForResolvedFilters(pool, filters);
}

async function buildDashboardOverviewPayloadForResolvedFilters(pool: Pool, filters: DashboardFilters): Promise<any> {
    filters = validateDashboardFilters(filters);
    const watermark = await getWarehouseWatermark(pool, filters);
    const [bundle, filterOptions] = await Promise.all([
        getDashboardOverviewReportBundle(pool, filters, watermark),
        getAvailableDashboardFilters(pool, filters.customerId)
    ]);
    const payload = await buildDashboardPayloadFromBundle(bundle, filters, filterOptions);
    const livePayload = await attachLiveDashboardData(pool, clonePayload(payload), filters, {
        leadMode: 'overview',
        includeProposals: false
    });
    return projectDashboardPayload(livePayload, 'overview');
}

export async function buildDashboardOverviewPayload(pool: Pool, rawFilters: DashboardFilters): Promise<any> {
    const filters = await assertKnownFilterSelection(pool, validateDashboardFilters(rawFilters));
    return buildDashboardOverviewPayloadForResolvedFilters(pool, filters);
}

export async function buildDashboardPayloadForView(
    pool: Pool,
    rawFilters: DashboardFilters,
    rawView: any = 'full',
    options: DashboardPayloadForViewOptions = {}
): Promise<any> {
    const view = normalizeDashboardPayloadView(rawView);
    const filters = options.filtersResolved
        ? validateDashboardFilters(rawFilters)
        : await assertKnownFilterSelection(pool, validateDashboardFilters(rawFilters));
    const inflightWatermark = options.warehouseWatermark ?? 'AUTO';
    const liveAttachVariant = liveAttachCacheVariant(resolveLiveAttachOptions(view, options.liveAttach));
    const inflightKey = `${dashboardCacheKey(filters)}:view=${view}:watermark=${inflightWatermark}:live=${liveAttachVariant}:bypass=${options.bypassViewCache ? '1' : '0'}`;
    if (!options.bypassViewCache) {
        const existing = dashboardPayloadInflight.get(inflightKey);
        if (existing) return clonePayload(await existing);
    }

    const promise = buildDashboardPayloadForResolvedView(pool, filters, view, options);
    if (!options.bypassViewCache) dashboardPayloadInflight.set(inflightKey, promise);
    try {
        return clonePayload(await promise);
    } finally {
        if (dashboardPayloadInflight.get(inflightKey) === promise) dashboardPayloadInflight.delete(inflightKey);
    }
}

async function buildDashboardPayloadForResolvedView(
    pool: Pool,
    filters: DashboardFilters,
    view: DashboardPayloadView,
    options: DashboardPayloadForViewOptions = {}
): Promise<any> {
    if (view === 'full') return buildDashboardPayloadForResolvedFilters(pool, filters);
    const watermark = options.warehouseWatermark
        || await timed(options.timings, 'view_watermark', () => getWarehouseWatermark(pool, filters));
    const liveAttachVariant = liveAttachCacheVariant(resolveLiveAttachOptions(view, options.liveAttach));
    const cachedPayload = options.bypassViewCache
        ? null
        : await timed(options.timings, 'view_cache', async () => getMemoryCachedDashboardViewPayload(view, filters, watermark, liveAttachVariant));
    if (cachedPayload) {
        cachedPayload.meta = {
            ...(cachedPayload.meta || {}),
            cacheStatus: 'memory_hit'
        };
        return cachedPayload;
    }

    const [bundle, filterOptions] = await Promise.all([
        timed(options.timings, 'bundle', () => view === 'overview'
            ? getDashboardOverviewReportBundle(pool, filters, watermark)
            : getDashboardReportBundleForView(pool, filters, view, watermark)),
        timed(options.timings, 'filter_options', () => getAvailableDashboardFilters(pool, filters.customerId))
    ]);
    const payload = await timed(options.timings, 'payload_build', () => buildDashboardPayloadFromBundle(bundle, filters, filterOptions, { view }));
    const liveOptions = resolveLiveAttachOptions(view, options.liveAttach);
    const livePayload = await timed(options.timings, 'live_attach', () => attachLiveDashboardData(pool, clonePayload(payload), filters, liveOptions));
    const projected = projectDashboardPayload(livePayload, view);
    projected.meta = {
        ...(projected.meta || {}),
        cacheStatus: 'memory_miss'
    };
    setMemoryCachedDashboardViewPayload(view, filters, watermark, projected, liveAttachVariant);
    return projected;
}
