import crypto from 'crypto';
import { Pool, PoolClient } from 'pg';

export type WarehouseRefreshKind = 'backfill' | 'cron' | 'manual' | 'repair';
export type WarehouseRunStatus = 'running' | 'succeeded' | 'partial' | 'failed';
export type ReportStatus = 'ok' | 'empty' | 'failed' | 'skipped';
export type CoverageStatus = 'covered' | 'empty' | 'failed' | 'missing' | 'partial';

type Db = Pool | PoolClient;

export interface DashboardFilters {
    customerId: string;
    startDate: string;
    endDate: string;
    campaignId?: string | null;
    adGroupId?: string | null;
}

export interface CoverageEntry {
    reportName: string;
    status: CoverageStatus;
    coveredDates: number;
    missingDates: string[];
    failedDates: string[];
    emptyDates: string[];
    rowCount: number;
    lastFetchedAt: string | null;
    error: string | null;
}

export interface MetricFields {
    cost_micros?: number | string | null;
    clicks?: number | string | null;
    impressions?: number | string | null;
    conversions?: number | string | null;
    all_conversions?: number | string | null;
    conversions_value?: number | string | null;
    ctr?: number | string | null;
    average_cpc_micros?: number | string | null;
    cost_per_conversion_micros?: number | string | null;
}

export interface AccountDailyRow extends MetricFields {
    customer_id: string;
    date: string;
    currency_code?: string | null;
    raw_payload?: Record<string, any>;
}

export interface CampaignDailyRow extends MetricFields {
    customer_id: string;
    date: string;
    campaign_id: string;
    campaign_name?: string | null;
    campaign_status?: string | null;
    bidding_strategy_type?: string | null;
    campaign_budget_resource_name?: string | null;
    budget_amount_micros?: number | string | null;
    target_cpa_micros?: number | string | null;
    target_roas?: number | string | null;
    search_impression_share?: number | string | null;
    search_budget_lost_impression_share?: number | string | null;
    search_rank_lost_impression_share?: number | string | null;
    raw_payload?: Record<string, any>;
}

export interface AdGroupDailyRow extends MetricFields {
    customer_id: string;
    date: string;
    campaign_id: string;
    campaign_name?: string | null;
    ad_group_id: string;
    ad_group_name?: string | null;
    ad_group_status?: string | null;
    search_impression_share?: number | string | null;
    raw_payload?: Record<string, any>;
}

export interface KeywordDailyRow extends MetricFields {
    customer_id: string;
    date: string;
    campaign_id: string;
    campaign_name?: string | null;
    ad_group_id: string;
    ad_group_name?: string | null;
    criterion_id: string;
    criterion_resource_name?: string | null;
    keyword_text?: string | null;
    match_type?: string | null;
    criterion_status?: string | null;
    cpc_bid_micros?: number | string | null;
    bidding_strategy_type?: string | null;
    search_impression_share?: number | string | null;
    raw_payload?: Record<string, any>;
}

export interface SearchTermDailyRow extends MetricFields {
    customer_id: string;
    date: string;
    dimension_hash: string;
    campaign_id: string;
    campaign_name?: string | null;
    ad_group_id: string;
    ad_group_name?: string | null;
    search_term: string;
    search_term_status?: string | null;
    matched_keyword_text?: string | null;
    matched_keyword_match_type?: string | null;
    search_term_match_type?: string | null;
    search_term_match_source?: string | null;
    raw_payload?: Record<string, any>;
}

export interface DeviceDailyRow extends MetricFields {
    customer_id: string;
    date: string;
    campaign_id: string;
    campaign_name?: string | null;
    ad_group_id: string;
    ad_group_name?: string | null;
    device: string;
    conversions_value?: number | string | null;
    raw_payload?: Record<string, any>;
}

export interface DayOfWeekDailyRow extends MetricFields {
    customer_id: string;
    date: string;
    campaign_id: string;
    campaign_name?: string | null;
    ad_group_id: string;
    ad_group_name?: string | null;
    day_of_week: string;
    conversions_value?: number | string | null;
    raw_payload?: Record<string, any>;
}

export interface DayHourDailyRow extends MetricFields {
    customer_id: string;
    date: string;
    campaign_id: string;
    campaign_name?: string | null;
    ad_group_id: string;
    ad_group_name?: string | null;
    day_of_week: string;
    hour: number;
    raw_payload?: Record<string, any>;
}

export interface LandingPageDailyRow extends MetricFields {
    customer_id: string;
    date: string;
    url_hash: string;
    unexpanded_final_url?: string;
    expanded_final_url?: string;
    campaign_id: string;
    campaign_name?: string | null;
    ad_group_id: string;
    ad_group_name?: string | null;
    mobile_friendly_clicks_percentage?: number | string | null;
    valid_amp_clicks_percentage?: number | string | null;
    speed_score?: number | string | null;
    raw_payload?: Record<string, any>;
}

export interface ConversionActionDailyRow {
    customer_id: string;
    date: string;
    conversion_action_resource_name: string;
    conversion_action_name?: string | null;
    conversion_action_category?: string | null;
    conversion_action_status?: string | null;
    primary_for_goal?: boolean | null;
    conversions?: number | string | null;
    conversions_value?: number | string | null;
    all_conversions?: number | string | null;
    raw_payload?: Record<string, any>;
}

export interface ConversionScopedDailyRow {
    customer_id: string;
    date: string;
    dimension_hash: string;
    campaign_id: string;
    campaign_name?: string | null;
    ad_group_id: string;
    ad_group_name?: string | null;
    search_term?: string | null;
    conversion_action_name?: string | null;
    conversion_action_category?: string | null;
    conversions?: number | string | null;
    conversions_value?: number | string | null;
    raw_payload?: Record<string, any>;
}

export interface ClickEvidenceDailyRow {
    customer_id: string;
    date: string;
    dimension_hash: string;
    gclid?: string | null;
    campaign_id?: string | null;
    ad_group_id?: string | null;
    keyword_text?: string | null;
    keyword_match_type?: string | null;
    click_type?: string | null;
    device?: string | null;
    raw_payload?: Record<string, any>;
}

export interface CampaignSnapshotRow {
    customer_id: string;
    campaign_id: string;
    campaign_name?: string | null;
    campaign_status?: string | null;
    bidding_strategy_type?: string | null;
    campaign_budget_resource_name?: string | null;
    budget_amount_micros?: number | string | null;
    target_cpa_micros?: number | string | null;
    target_roas?: number | string | null;
    raw_payload?: Record<string, any>;
}

export interface AdGroupSnapshotRow {
    customer_id: string;
    campaign_id: string;
    campaign_name?: string | null;
    ad_group_id: string;
    ad_group_name?: string | null;
    ad_group_status?: string | null;
    raw_payload?: Record<string, any>;
}

export interface ConfiguredKeywordRow {
    customer_id: string;
    campaign_id: string;
    campaign_name?: string | null;
    ad_group_id: string;
    ad_group_name?: string | null;
    criterion_id: string;
    criterion_resource_name?: string | null;
    keyword_text: string;
    match_type?: string | null;
    status?: string | null;
    primary_status?: string | null;
    primary_status_reasons?: any[];
    final_urls?: any[];
    cpc_bid_micros?: number | string | null;
    raw_payload?: Record<string, any>;
}

export interface QualityScoreRow {
    customer_id: string;
    campaign_id: string;
    campaign_name?: string | null;
    ad_group_id: string;
    ad_group_name?: string | null;
    criterion_id: string;
    keyword_text?: string | null;
    match_type?: string | null;
    status?: string | null;
    quality_score?: number | string | null;
    creative_quality_score?: string | null;
    post_click_quality_score?: string | null;
    search_predicted_ctr?: string | null;
    raw_payload?: Record<string, any>;
}

export interface NegativeKeywordRow {
    customer_id: string;
    campaign_id?: string | null;
    campaign_name?: string | null;
    ad_group_id?: string | null;
    ad_group_name?: string | null;
    criterion_id: string;
    keyword_text: string;
    match_type?: string | null;
    status?: string | null;
    raw_payload?: Record<string, any>;
}

export interface AccountNegativeListRow {
    customer_id: string;
    customer_negative_criterion_id: string;
    resource_name?: string | null;
    shared_set_resource_name: string;
    raw_payload?: Record<string, any>;
}

export interface SharedNegativeSetRow {
    customer_id: string;
    shared_set_id: string;
    shared_set_resource_name: string;
    shared_set_name?: string | null;
    shared_set_type?: string | null;
    shared_set_status?: string | null;
    raw_payload?: Record<string, any>;
}

export interface SharedNegativeCriterionRow {
    customer_id: string;
    shared_set_resource_name: string;
    criterion_id: string;
    keyword_text: string;
    match_type?: string | null;
    raw_payload?: Record<string, any>;
}

export interface CampaignSharedSetRow {
    customer_id: string;
    campaign_id: string;
    campaign_name?: string | null;
    campaign_resource_name?: string | null;
    shared_set_resource_name: string;
    status?: string | null;
    raw_payload?: Record<string, any>;
}

export interface NegativeWarehouseRows {
    campaignNegatives: NegativeKeywordRow[];
    adGroupNegatives: NegativeKeywordRow[];
    accountNegativeLists: AccountNegativeListRow[];
    sharedNegativeSets: SharedNegativeSetRow[];
    sharedNegativeCriteria: SharedNegativeCriterionRow[];
    campaignSharedSets: CampaignSharedSetRow[];
}

export interface KeywordPlannerIdeaRow {
    customer_id: string;
    keyword_key: string;
    keyword: string;
    avg_monthly_searches?: number | string | null;
    competition?: string | null;
    competition_index?: number | string | null;
    low_bid_micros?: number | string | null;
    high_bid_micros?: number | string | null;
    seed_type?: string | null;
    seed_keywords?: any[];
    seed_url?: string | null;
    seed_site?: string | null;
    geo_target_constants?: any[];
    language?: string | null;
    keyword_plan_network?: string | null;
    monthly_search_volumes?: any[];
    raw_payload?: Record<string, any>;
}

export interface KeywordPlannerHistoricalRow {
    customer_id: string;
    keyword_key: string;
    keyword: string;
    close_variants?: any[];
    avg_monthly_searches?: number | string | null;
    competition?: string | null;
    competition_index?: number | string | null;
    low_bid_micros?: number | string | null;
    high_bid_micros?: number | string | null;
    geo_target_constants?: any[];
    language?: string | null;
    keyword_plan_network?: string | null;
    monthly_search_volumes?: any[];
    raw_payload?: Record<string, any>;
}

export interface AuctionInsightsRow {
    customer_id: string;
    dimension_hash: string;
    source_scope: string;
    entity_id?: string | null;
    entity_name?: string | null;
    campaign_id?: string | null;
    campaign_name?: string | null;
    ad_group_id?: string | null;
    ad_group_name?: string | null;
    auction_date?: string | null;
    domain: string;
    impression_share?: number | string | null;
    overlap_rate?: number | string | null;
    position_above_rate?: number | string | null;
    top_impression_percentage?: number | string | null;
    absolute_top_impression_percentage?: number | string | null;
    outranking_share?: number | string | null;
    raw_payload?: Record<string, any>;
}

export interface AuctionInsightsStatusRow {
    customer_id: string;
    entity_type: string;
    entity_id: string;
    entity_name?: string | null;
    status: string;
    sheet_name?: string | null;
    rows_fetched?: number | string | null;
    message?: string | null;
    spreadsheet_id?: string | null;
    spreadsheet_modified_time?: string | null;
}

export interface CandidateSignalRow {
    signal_id: string;
    customer_id: string;
    signal_type: string;
    severity: string;
    campaign_id?: string | null;
    ad_group_id?: string | null;
    evidence_start_date?: string | null;
    evidence_end_date?: string | null;
    payload: Record<string, any>;
}

export interface DashboardReportBundle {
    accountDaily: AccountDailyRow[];
    campaignDaily: CampaignDailyRow[];
    adGroupDaily: AdGroupDailyRow[];
    keywordDaily: KeywordDailyRow[];
    searchTermDaily: SearchTermDailyRow[];
    deviceDaily: DeviceDailyRow[];
    dayOfWeekDaily: DayOfWeekDailyRow[];
    dayHourDaily: DayHourDailyRow[];
    landingPageDaily: LandingPageDailyRow[];
    expandedLandingPageDaily: LandingPageDailyRow[];
    conversionActionDaily: ConversionActionDailyRow[];
    conversionAdGroupDaily: ConversionScopedDailyRow[];
    conversionSearchTermDaily: ConversionScopedDailyRow[];
    clickEvidenceDaily: ClickEvidenceDailyRow[];
    campaignSnapshot: CampaignSnapshotRow[];
    adGroupSnapshot: AdGroupSnapshotRow[];
    configuredKeywords: ConfiguredKeywordRow[];
    qualityScores: QualityScoreRow[];
    negatives: NegativeWarehouseRows;
    keywordPlannerIdeas: KeywordPlannerIdeaRow[];
    keywordPlannerHistorical: KeywordPlannerHistoricalRow[];
    auctionInsightsRows: AuctionInsightsRow[];
    auctionInsightsStatus: AuctionInsightsStatusRow[];
    candidateSignals: CandidateSignalRow[];
    coverage: CoverageEntry[];
}

export type DashboardReportBundleView = 'overview' | 'performance' | 'keywords' | 'attribution' | 'rank' | 'proposals';

type DashboardFilterOptions = {
    minDate: string | null;
    maxDate: string | null;
    campaigns: Array<{ id: string; name: string; status: string | null }>;
    adGroups: Array<{ id: string; name: string; status: string | null; campaignId: string; campaignName: string | null }>;
};

type RuntimeCacheEntry<T> = {
    value: T;
    expiresAt: number;
    lastAccessedAt: number;
    sizeBytes: number;
};

const DEFAULT_DASHBOARD_BASE_BUNDLE_CACHE_SECONDS = 60;
const DEFAULT_DASHBOARD_BASE_BUNDLE_CACHE_MAX_ENTRIES = 30;
const DEFAULT_DASHBOARD_BASE_BUNDLE_CACHE_MAX_BYTES = 10_000_000;
const DEFAULT_DASHBOARD_FILTER_OPTIONS_CACHE_SECONDS = 60;
const DEFAULT_DASHBOARD_FILTER_OPTIONS_CACHE_MAX_ENTRIES = 20;
const DEFAULT_DASHBOARD_FILTER_OPTIONS_CACHE_MAX_BYTES = 2_000_000;
const DEFAULT_DASHBOARD_WATERMARK_CACHE_SECONDS = 60;
const DEFAULT_DASHBOARD_WATERMARK_CACHE_MAX_ENTRIES = 100;
const DEFAULT_DASHBOARD_WATERMARK_CACHE_MAX_BYTES = 250_000;
const DEFAULT_DASHBOARD_KEYWORD_ROW_LIMIT = 1_500;
const DEFAULT_DASHBOARD_SEARCH_TERM_ROW_LIMIT = 2_000;
const DEFAULT_DASHBOARD_PLANNER_ROW_LIMIT = 1_000;
const DEFAULT_DASHBOARD_RANK_KEYWORD_ROW_LIMIT = 1_000;
const DEFAULT_DASHBOARD_RANK_SEARCH_TERM_ROW_LIMIT = 1_000;
const DEFAULT_DASHBOARD_LANDING_PAGE_ROW_LIMIT = 500;
const DEFAULT_DASHBOARD_AUCTION_INSIGHTS_ROW_LIMIT = 1_000;
const DEFAULT_DASHBOARD_CANDIDATE_SIGNAL_ROW_LIMIT = 250;
const dashboardBaseBundleCache = new Map<string, RuntimeCacheEntry<DashboardReportBundle>>();
const dashboardFilterOptionsCache = new Map<string, RuntimeCacheEntry<DashboardFilterOptions>>();
const warehouseWatermarkCache = new Map<string, RuntimeCacheEntry<string>>();
const warehouseWatermarkInflight = new Map<string, Promise<string>>();
let adsWarehouseRuntimeCacheGeneration = 0;

export function emptyDashboardReportBundle(overrides: Partial<DashboardReportBundle> = {}): DashboardReportBundle {
    return {
        accountDaily: [],
        campaignDaily: [],
        adGroupDaily: [],
        keywordDaily: [],
        searchTermDaily: [],
        deviceDaily: [],
        dayOfWeekDaily: [],
        dayHourDaily: [],
        landingPageDaily: [],
        expandedLandingPageDaily: [],
        conversionActionDaily: [],
        conversionAdGroupDaily: [],
        conversionSearchTermDaily: [],
        clickEvidenceDaily: [],
        campaignSnapshot: [],
        adGroupSnapshot: [],
        configuredKeywords: [],
        qualityScores: [],
        negatives: {
            campaignNegatives: [],
            adGroupNegatives: [],
            accountNegativeLists: [],
            sharedNegativeSets: [],
            sharedNegativeCriteria: [],
            campaignSharedSets: []
        },
        keywordPlannerIdeas: [],
        keywordPlannerHistorical: [],
        auctionInsightsRows: [],
        auctionInsightsStatus: [],
        candidateSignals: [],
        coverage: [],
        ...overrides
    };
}

function cloneJson<T>(value: T): T {
    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function runtimeCacheTtlMs(envName: string, fallbackSeconds: number): number {
    return positiveIntegerEnv(envName, fallbackSeconds) * 1000;
}

function pruneRuntimeCache<T>(
    cache: Map<string, RuntimeCacheEntry<T>>,
    maxEntries: number,
    now = Date.now()
): void {
    for (const [key, entry] of cache) {
        if (entry.expiresAt <= now) cache.delete(key);
    }
    if (maxEntries <= 0) {
        cache.clear();
        return;
    }
    while (cache.size > maxEntries) {
        const oldest = Array.from(cache.entries())
            .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt)[0];
        if (!oldest) break;
        cache.delete(oldest[0]);
    }
}

function getRuntimeCacheEntry<T>(cache: Map<string, RuntimeCacheEntry<T>>, key: string, ttlMs: number): T | null {
    if (ttlMs <= 0) return null;
    const entry = cache.get(key);
    if (!entry) return null;
    const now = Date.now();
    if (entry.expiresAt <= now) {
        cache.delete(key);
        return null;
    }
    entry.lastAccessedAt = now;
    return cloneJson(entry.value);
}

function setRuntimeCacheEntry<T>(
    cache: Map<string, RuntimeCacheEntry<T>>,
    key: string,
    value: T,
    ttlMs: number,
    maxEntries: number,
    maxBytes: number
): void {
    if (ttlMs <= 0 || maxEntries <= 0) return;
    const sizeBytes = jsonByteSize(value);
    if (maxBytes > 0 && sizeBytes > maxBytes) return;
    const now = Date.now();
    cache.set(key, {
        value: cloneJson(value),
        expiresAt: now + ttlMs,
        lastAccessedAt: now,
        sizeBytes
    });
    pruneRuntimeCache(cache, maxEntries, now);
}

function dashboardBaseBundleCacheTtlMs(): number {
    return runtimeCacheTtlMs('DASHBOARD_BASE_BUNDLE_CACHE_SECONDS', DEFAULT_DASHBOARD_BASE_BUNDLE_CACHE_SECONDS);
}

function dashboardBaseBundleCacheMaxEntries(): number {
    return positiveIntegerEnv('DASHBOARD_BASE_BUNDLE_CACHE_MAX_ENTRIES', DEFAULT_DASHBOARD_BASE_BUNDLE_CACHE_MAX_ENTRIES);
}

function dashboardBaseBundleCacheMaxBytes(): number {
    return positiveIntegerEnv('DASHBOARD_BASE_BUNDLE_CACHE_MAX_BYTES', DEFAULT_DASHBOARD_BASE_BUNDLE_CACHE_MAX_BYTES);
}

function dashboardFilterOptionsCacheTtlMs(): number {
    return runtimeCacheTtlMs('DASHBOARD_FILTER_OPTIONS_CACHE_SECONDS', DEFAULT_DASHBOARD_FILTER_OPTIONS_CACHE_SECONDS);
}

function dashboardFilterOptionsCacheMaxEntries(): number {
    return positiveIntegerEnv('DASHBOARD_FILTER_OPTIONS_CACHE_MAX_ENTRIES', DEFAULT_DASHBOARD_FILTER_OPTIONS_CACHE_MAX_ENTRIES);
}

function dashboardFilterOptionsCacheMaxBytes(): number {
    return positiveIntegerEnv('DASHBOARD_FILTER_OPTIONS_CACHE_MAX_BYTES', DEFAULT_DASHBOARD_FILTER_OPTIONS_CACHE_MAX_BYTES);
}

function dashboardWatermarkCacheTtlMs(): number {
    return runtimeCacheTtlMs('DASHBOARD_WATERMARK_CACHE_SECONDS', DEFAULT_DASHBOARD_WATERMARK_CACHE_SECONDS);
}

function dashboardWatermarkCacheMaxEntries(): number {
    return positiveIntegerEnv('DASHBOARD_WATERMARK_CACHE_MAX_ENTRIES', DEFAULT_DASHBOARD_WATERMARK_CACHE_MAX_ENTRIES);
}

function dashboardWatermarkCacheMaxBytes(): number {
    return positiveIntegerEnv('DASHBOARD_WATERMARK_CACHE_MAX_BYTES', DEFAULT_DASHBOARD_WATERMARK_CACHE_MAX_BYTES);
}

function dashboardKeywordRowLimit(): number {
    return positiveIntegerEnv('DASHBOARD_KEYWORD_ROW_LIMIT', DEFAULT_DASHBOARD_KEYWORD_ROW_LIMIT);
}

function dashboardSearchTermRowLimit(): number {
    return positiveIntegerEnv('DASHBOARD_SEARCH_TERM_ROW_LIMIT', DEFAULT_DASHBOARD_SEARCH_TERM_ROW_LIMIT);
}

function dashboardPlannerRowLimit(): number {
    return positiveIntegerEnv('DASHBOARD_PLANNER_ROW_LIMIT', DEFAULT_DASHBOARD_PLANNER_ROW_LIMIT);
}

function dashboardRankKeywordRowLimit(): number {
    return positiveIntegerEnv('DASHBOARD_RANK_KEYWORD_ROW_LIMIT', DEFAULT_DASHBOARD_RANK_KEYWORD_ROW_LIMIT);
}

function dashboardRankSearchTermRowLimit(): number {
    return positiveIntegerEnv('DASHBOARD_RANK_SEARCH_TERM_ROW_LIMIT', DEFAULT_DASHBOARD_RANK_SEARCH_TERM_ROW_LIMIT);
}

function dashboardLandingPageRowLimit(): number {
    return positiveIntegerEnv('DASHBOARD_LANDING_PAGE_ROW_LIMIT', DEFAULT_DASHBOARD_LANDING_PAGE_ROW_LIMIT);
}

function dashboardAuctionInsightsRowLimit(): number {
    return positiveIntegerEnv('DASHBOARD_AUCTION_INSIGHTS_ROW_LIMIT', DEFAULT_DASHBOARD_AUCTION_INSIGHTS_ROW_LIMIT);
}

function dashboardCandidateSignalRowLimit(): number {
    return positiveIntegerEnv('DASHBOARD_CANDIDATE_SIGNAL_ROW_LIMIT', DEFAULT_DASHBOARD_CANDIDATE_SIGNAL_ROW_LIMIT);
}

function invalidateAdsWarehouseRuntimeCaches(): void {
    adsWarehouseRuntimeCacheGeneration += 1;
    dashboardBaseBundleCache.clear();
    dashboardFilterOptionsCache.clear();
    warehouseWatermarkCache.clear();
    warehouseWatermarkInflight.clear();
}

export function clearAdsWarehouseRuntimeCaches(): void {
    invalidateAdsWarehouseRuntimeCaches();
}

export interface ImpactMetrics {
    spend: number;
    clicks: number;
    impressions: number;
    conversions: number;
    conversionValue: number;
    cpa: number;
    roas: number;
}

const WAREHOUSE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS google_ads_refresh_runs (
  id TEXT PRIMARY KEY,
  customer_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('backfill', 'cron', 'manual', 'repair')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  requested_start_date DATE,
  requested_end_date DATE,
  effective_start_date DATE,
  effective_end_date DATE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  source_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT
);
CREATE INDEX IF NOT EXISTS google_ads_refresh_runs_started_idx ON google_ads_refresh_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_refresh_runs_status_idx ON google_ads_refresh_runs(status, started_at DESC);

CREATE TABLE IF NOT EXISTS google_ads_report_fetches (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES google_ads_refresh_runs(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL,
  report_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'empty', 'failed', 'skipped')),
  start_date DATE,
  end_date DATE,
  rows_fetched INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  error TEXT
);
CREATE INDEX IF NOT EXISTS google_ads_report_fetches_report_idx ON google_ads_report_fetches(customer_id, report_name, started_at DESC);

CREATE TABLE IF NOT EXISTS google_ads_report_coverage (
  customer_id TEXT NOT NULL,
  report_name TEXT NOT NULL,
  coverage_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('covered', 'empty', 'failed', 'missing')),
  row_count INTEGER NOT NULL DEFAULT 0,
  run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  error TEXT,
  PRIMARY KEY (customer_id, report_name, coverage_date)
);
CREATE INDEX IF NOT EXISTS google_ads_report_coverage_window_idx ON google_ads_report_coverage(customer_id, report_name, coverage_date, status);

CREATE TABLE IF NOT EXISTS google_ads_account_daily (
  customer_id TEXT NOT NULL,
  date DATE NOT NULL,
  currency_code TEXT,
  cost_micros BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  impressions BIGINT NOT NULL DEFAULT 0,
  conversions NUMERIC(18,6) NOT NULL DEFAULT 0,
  all_conversions NUMERIC(18,6) NOT NULL DEFAULT 0,
  conversions_value NUMERIC(18,6) NOT NULL DEFAULT 0,
  ctr NUMERIC(18,8),
  average_cpc_micros BIGINT,
  cost_per_conversion_micros BIGINT,
  run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, date)
);

CREATE TABLE IF NOT EXISTS google_ads_campaign_daily (
  customer_id TEXT NOT NULL,
  date DATE NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  campaign_status TEXT,
  bidding_strategy_type TEXT,
  campaign_budget_resource_name TEXT,
  budget_amount_micros BIGINT,
  target_cpa_micros BIGINT,
  target_roas NUMERIC(18,6),
  cost_micros BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  impressions BIGINT NOT NULL DEFAULT 0,
  conversions NUMERIC(18,6) NOT NULL DEFAULT 0,
  all_conversions NUMERIC(18,6) NOT NULL DEFAULT 0,
  conversions_value NUMERIC(18,6) NOT NULL DEFAULT 0,
  ctr NUMERIC(18,8),
  average_cpc_micros BIGINT,
  cost_per_conversion_micros BIGINT,
  search_impression_share NUMERIC(18,8),
  search_budget_lost_impression_share NUMERIC(18,8),
  search_rank_lost_impression_share NUMERIC(18,8),
  run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, date, campaign_id)
);
CREATE INDEX IF NOT EXISTS google_ads_campaign_daily_campaign_window_idx ON google_ads_campaign_daily(customer_id, campaign_id, date);

CREATE TABLE IF NOT EXISTS google_ads_ad_group_daily (
  customer_id TEXT NOT NULL,
  date DATE NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  ad_group_id TEXT NOT NULL,
  ad_group_name TEXT,
  ad_group_status TEXT,
  cost_micros BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  impressions BIGINT NOT NULL DEFAULT 0,
  conversions NUMERIC(18,6) NOT NULL DEFAULT 0,
  all_conversions NUMERIC(18,6) NOT NULL DEFAULT 0,
  ctr NUMERIC(18,8),
  average_cpc_micros BIGINT,
  cost_per_conversion_micros BIGINT,
  search_impression_share NUMERIC(18,8),
  run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, date, campaign_id, ad_group_id)
);
CREATE INDEX IF NOT EXISTS google_ads_ad_group_daily_group_window_idx ON google_ads_ad_group_daily(customer_id, campaign_id, ad_group_id, date);

CREATE TABLE IF NOT EXISTS google_ads_keyword_daily (
  customer_id TEXT NOT NULL,
  date DATE NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  ad_group_id TEXT NOT NULL,
  ad_group_name TEXT,
  criterion_id TEXT NOT NULL,
  criterion_resource_name TEXT,
  keyword_text TEXT,
  match_type TEXT,
  criterion_status TEXT,
  cpc_bid_micros BIGINT,
  bidding_strategy_type TEXT,
  cost_micros BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  impressions BIGINT NOT NULL DEFAULT 0,
  conversions NUMERIC(18,6) NOT NULL DEFAULT 0,
  all_conversions NUMERIC(18,6) NOT NULL DEFAULT 0,
  ctr NUMERIC(18,8),
  average_cpc_micros BIGINT,
  cost_per_conversion_micros BIGINT,
  search_impression_share NUMERIC(18,8),
  run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, date, campaign_id, ad_group_id, criterion_id)
);
CREATE INDEX IF NOT EXISTS google_ads_keyword_daily_text_idx ON google_ads_keyword_daily(customer_id, lower(keyword_text), date);

CREATE TABLE IF NOT EXISTS google_ads_search_term_daily (
  customer_id TEXT NOT NULL,
  date DATE NOT NULL,
  dimension_hash TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  ad_group_id TEXT NOT NULL,
  ad_group_name TEXT,
  search_term TEXT NOT NULL,
  search_term_status TEXT,
  matched_keyword_text TEXT,
  matched_keyword_match_type TEXT,
  search_term_match_type TEXT,
  search_term_match_source TEXT,
  cost_micros BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  impressions BIGINT NOT NULL DEFAULT 0,
  conversions NUMERIC(18,6) NOT NULL DEFAULT 0,
  all_conversions NUMERIC(18,6) NOT NULL DEFAULT 0,
  ctr NUMERIC(18,8),
  average_cpc_micros BIGINT,
  cost_per_conversion_micros BIGINT,
  run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, date, dimension_hash)
);
CREATE INDEX IF NOT EXISTS google_ads_search_term_daily_scope_idx ON google_ads_search_term_daily(customer_id, campaign_id, ad_group_id, date);
CREATE INDEX IF NOT EXISTS google_ads_search_term_daily_term_idx ON google_ads_search_term_daily(customer_id, lower(search_term), date);

CREATE TABLE IF NOT EXISTS google_ads_device_daily (
  customer_id TEXT NOT NULL,
  date DATE NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  ad_group_id TEXT NOT NULL,
  ad_group_name TEXT,
  device TEXT NOT NULL,
  cost_micros BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  impressions BIGINT NOT NULL DEFAULT 0,
  conversions NUMERIC(18,6) NOT NULL DEFAULT 0,
  conversions_value NUMERIC(18,6) NOT NULL DEFAULT 0,
  ctr NUMERIC(18,8),
  average_cpc_micros BIGINT,
  cost_per_conversion_micros BIGINT,
  run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, date, campaign_id, ad_group_id, device)
);

CREATE TABLE IF NOT EXISTS google_ads_day_of_week_daily (
  customer_id TEXT NOT NULL,
  date DATE NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  ad_group_id TEXT NOT NULL,
  ad_group_name TEXT,
  day_of_week TEXT NOT NULL,
  cost_micros BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  impressions BIGINT NOT NULL DEFAULT 0,
  conversions NUMERIC(18,6) NOT NULL DEFAULT 0,
  conversions_value NUMERIC(18,6) NOT NULL DEFAULT 0,
  ctr NUMERIC(18,8),
  average_cpc_micros BIGINT,
  cost_per_conversion_micros BIGINT,
  run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, date, campaign_id, ad_group_id, day_of_week)
);

CREATE TABLE IF NOT EXISTS google_ads_day_hour_daily (
  customer_id TEXT NOT NULL,
  date DATE NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  ad_group_id TEXT NOT NULL,
  ad_group_name TEXT,
  day_of_week TEXT NOT NULL,
  hour INTEGER NOT NULL CHECK (hour >= 0 AND hour <= 23),
  cost_micros BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  impressions BIGINT NOT NULL DEFAULT 0,
  conversions NUMERIC(18,6) NOT NULL DEFAULT 0,
  ctr NUMERIC(18,8),
  average_cpc_micros BIGINT,
  cost_per_conversion_micros BIGINT,
  run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, date, campaign_id, ad_group_id, day_of_week, hour)
);

CREATE TABLE IF NOT EXISTS google_ads_landing_page_daily (
  customer_id TEXT NOT NULL,
  date DATE NOT NULL,
  url_hash TEXT NOT NULL,
  unexpanded_final_url TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  ad_group_id TEXT NOT NULL,
  ad_group_name TEXT,
  cost_micros BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  impressions BIGINT NOT NULL DEFAULT 0,
  conversions NUMERIC(18,6) NOT NULL DEFAULT 0,
  ctr NUMERIC(18,8),
  average_cpc_micros BIGINT,
  cost_per_conversion_micros BIGINT,
  mobile_friendly_clicks_percentage NUMERIC(18,8),
  valid_amp_clicks_percentage NUMERIC(18,8),
  speed_score NUMERIC(18,6),
  run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, date, campaign_id, ad_group_id, url_hash)
);

CREATE TABLE IF NOT EXISTS google_ads_expanded_landing_page_daily (
  customer_id TEXT NOT NULL,
  date DATE NOT NULL,
  url_hash TEXT NOT NULL,
  expanded_final_url TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  ad_group_id TEXT NOT NULL,
  ad_group_name TEXT,
  cost_micros BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  impressions BIGINT NOT NULL DEFAULT 0,
  conversions NUMERIC(18,6) NOT NULL DEFAULT 0,
  ctr NUMERIC(18,8),
  average_cpc_micros BIGINT,
  cost_per_conversion_micros BIGINT,
  mobile_friendly_clicks_percentage NUMERIC(18,8),
  valid_amp_clicks_percentage NUMERIC(18,8),
  speed_score NUMERIC(18,6),
  run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, date, campaign_id, ad_group_id, url_hash)
);

CREATE TABLE IF NOT EXISTS google_ads_conversion_action_daily (
  customer_id TEXT NOT NULL,
  date DATE NOT NULL,
  conversion_action_resource_name TEXT NOT NULL,
  conversion_action_name TEXT,
  conversion_action_category TEXT,
  conversion_action_status TEXT,
  primary_for_goal BOOLEAN,
  conversions NUMERIC(18,6) NOT NULL DEFAULT 0,
  conversions_value NUMERIC(18,6) NOT NULL DEFAULT 0,
  all_conversions NUMERIC(18,6) NOT NULL DEFAULT 0,
  run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, date, conversion_action_resource_name)
);

CREATE TABLE IF NOT EXISTS google_ads_conversion_ad_group_daily (
  customer_id TEXT NOT NULL,
  date DATE NOT NULL,
  dimension_hash TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  ad_group_id TEXT NOT NULL,
  ad_group_name TEXT,
  conversion_action_name TEXT,
  conversion_action_category TEXT,
  conversions NUMERIC(18,6) NOT NULL DEFAULT 0,
  conversions_value NUMERIC(18,6) NOT NULL DEFAULT 0,
  run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, date, dimension_hash)
);

CREATE TABLE IF NOT EXISTS google_ads_conversion_search_term_daily (
  customer_id TEXT NOT NULL,
  date DATE NOT NULL,
  dimension_hash TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  ad_group_id TEXT NOT NULL,
  ad_group_name TEXT,
  search_term TEXT NOT NULL,
  conversion_action_name TEXT,
  conversion_action_category TEXT,
  conversions NUMERIC(18,6) NOT NULL DEFAULT 0,
  conversions_value NUMERIC(18,6) NOT NULL DEFAULT 0,
  run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, date, dimension_hash)
);

CREATE TABLE IF NOT EXISTS google_ads_click_evidence_daily (
  customer_id TEXT NOT NULL,
  date DATE NOT NULL,
  dimension_hash TEXT NOT NULL,
  gclid TEXT,
  campaign_id TEXT,
  ad_group_id TEXT,
  keyword_text TEXT,
  keyword_match_type TEXT,
  click_type TEXT,
  device TEXT,
  run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, date, dimension_hash)
);

CREATE TABLE IF NOT EXISTS google_ads_campaign_snapshot (
  customer_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  campaign_status TEXT,
  bidding_strategy_type TEXT,
  campaign_budget_resource_name TEXT,
  budget_amount_micros BIGINT,
  target_cpa_micros BIGINT,
  target_roas NUMERIC(18,6),
  present_in_latest_snapshot BOOLEAN NOT NULL DEFAULT true,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  snapshot_run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, campaign_id)
);

CREATE TABLE IF NOT EXISTS google_ads_ad_group_snapshot (
  customer_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  ad_group_id TEXT NOT NULL,
  ad_group_name TEXT,
  ad_group_status TEXT,
  present_in_latest_snapshot BOOLEAN NOT NULL DEFAULT true,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  snapshot_run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, campaign_id, ad_group_id)
);

CREATE TABLE IF NOT EXISTS google_ads_configured_keywords (
  customer_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  ad_group_id TEXT NOT NULL,
  ad_group_name TEXT,
  criterion_id TEXT NOT NULL,
  criterion_resource_name TEXT,
  keyword_text TEXT NOT NULL,
  match_type TEXT,
  status TEXT,
  primary_status TEXT,
  primary_status_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  final_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  cpc_bid_micros BIGINT,
  present_in_latest_snapshot BOOLEAN NOT NULL DEFAULT true,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  snapshot_run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, campaign_id, ad_group_id, criterion_id)
);
CREATE INDEX IF NOT EXISTS google_ads_configured_keywords_text_idx ON google_ads_configured_keywords(customer_id, lower(keyword_text), present_in_latest_snapshot);

CREATE TABLE IF NOT EXISTS google_ads_quality_score_snapshot (
  customer_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  ad_group_id TEXT NOT NULL,
  ad_group_name TEXT,
  criterion_id TEXT NOT NULL,
  keyword_text TEXT,
  match_type TEXT,
  status TEXT,
  quality_score INTEGER,
  creative_quality_score TEXT,
  post_click_quality_score TEXT,
  search_predicted_ctr TEXT,
  present_in_latest_snapshot BOOLEAN NOT NULL DEFAULT true,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  snapshot_run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, campaign_id, ad_group_id, criterion_id)
);

CREATE TABLE IF NOT EXISTS google_ads_campaign_negatives (
  customer_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  criterion_id TEXT NOT NULL,
  keyword_text TEXT NOT NULL,
  match_type TEXT,
  status TEXT,
  present_in_latest_snapshot BOOLEAN NOT NULL DEFAULT true,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  snapshot_run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, campaign_id, criterion_id)
);

CREATE TABLE IF NOT EXISTS google_ads_ad_group_negatives (
  customer_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  ad_group_id TEXT NOT NULL,
  ad_group_name TEXT,
  criterion_id TEXT NOT NULL,
  keyword_text TEXT NOT NULL,
  match_type TEXT,
  status TEXT,
  present_in_latest_snapshot BOOLEAN NOT NULL DEFAULT true,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  snapshot_run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, campaign_id, ad_group_id, criterion_id)
);

CREATE TABLE IF NOT EXISTS google_ads_account_negative_lists (
  customer_id TEXT NOT NULL,
  customer_negative_criterion_id TEXT NOT NULL,
  resource_name TEXT,
  shared_set_resource_name TEXT NOT NULL,
  present_in_latest_snapshot BOOLEAN NOT NULL DEFAULT true,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  snapshot_run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, customer_negative_criterion_id)
);

CREATE TABLE IF NOT EXISTS google_ads_shared_negative_sets (
  customer_id TEXT NOT NULL,
  shared_set_id TEXT NOT NULL,
  shared_set_resource_name TEXT NOT NULL,
  shared_set_name TEXT,
  shared_set_type TEXT,
  shared_set_status TEXT,
  present_in_latest_snapshot BOOLEAN NOT NULL DEFAULT true,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  snapshot_run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, shared_set_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS google_ads_shared_negative_sets_resource_idx ON google_ads_shared_negative_sets(customer_id, shared_set_resource_name);

CREATE TABLE IF NOT EXISTS google_ads_shared_negative_criteria (
  customer_id TEXT NOT NULL,
  shared_set_resource_name TEXT NOT NULL,
  criterion_id TEXT NOT NULL,
  keyword_text TEXT NOT NULL,
  match_type TEXT,
  present_in_latest_snapshot BOOLEAN NOT NULL DEFAULT true,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  snapshot_run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, shared_set_resource_name, criterion_id)
);

CREATE TABLE IF NOT EXISTS google_ads_campaign_shared_sets (
  customer_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  campaign_resource_name TEXT,
  shared_set_resource_name TEXT NOT NULL,
  status TEXT,
  present_in_latest_snapshot BOOLEAN NOT NULL DEFAULT true,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  snapshot_run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, campaign_id, shared_set_resource_name)
);

CREATE TABLE IF NOT EXISTS google_ads_keyword_planner_ideas (
  customer_id TEXT NOT NULL,
  keyword_key TEXT NOT NULL,
  keyword TEXT NOT NULL,
  avg_monthly_searches BIGINT,
  competition TEXT,
  competition_index INTEGER,
  low_bid_micros BIGINT,
  high_bid_micros BIGINT,
  seed_type TEXT,
  seed_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  seed_url TEXT,
  seed_site TEXT,
  geo_target_constants JSONB NOT NULL DEFAULT '[]'::jsonb,
  language TEXT,
  keyword_plan_network TEXT,
  monthly_search_volumes JSONB NOT NULL DEFAULT '[]'::jsonb,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, keyword_key)
);

CREATE TABLE IF NOT EXISTS google_ads_keyword_planner_historical (
  customer_id TEXT NOT NULL,
  keyword_key TEXT NOT NULL,
  keyword TEXT NOT NULL,
  close_variants JSONB NOT NULL DEFAULT '[]'::jsonb,
  avg_monthly_searches BIGINT,
  competition TEXT,
  competition_index INTEGER,
  low_bid_micros BIGINT,
  high_bid_micros BIGINT,
  geo_target_constants JSONB NOT NULL DEFAULT '[]'::jsonb,
  language TEXT,
  keyword_plan_network TEXT,
  monthly_search_volumes JSONB NOT NULL DEFAULT '[]'::jsonb,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, keyword_key)
);

CREATE TABLE IF NOT EXISTS google_ads_auction_insights_rows (
  customer_id TEXT NOT NULL,
  dimension_hash TEXT NOT NULL,
  source_scope TEXT NOT NULL,
  entity_id TEXT,
  entity_name TEXT,
  campaign_id TEXT,
  campaign_name TEXT,
  ad_group_id TEXT,
  ad_group_name TEXT,
  auction_date DATE,
  domain TEXT NOT NULL,
  impression_share NUMERIC(18,8),
  overlap_rate NUMERIC(18,8),
  position_above_rate NUMERIC(18,8),
  top_impression_percentage NUMERIC(18,8),
  absolute_top_impression_percentage NUMERIC(18,8),
  outranking_share NUMERIC(18,8),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, dimension_hash)
);

CREATE TABLE IF NOT EXISTS google_ads_auction_insights_status (
  customer_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_name TEXT,
  status TEXT NOT NULL,
  sheet_name TEXT,
  rows_fetched INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  spreadsheet_id TEXT,
  spreadsheet_modified_time TIMESTAMPTZ,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS candidate_signals (
  signal_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  campaign_id TEXT,
  ad_group_id TEXT,
  evidence_start_date DATE,
  evidence_end_date DATE,
  payload JSONB NOT NULL,
  run_id TEXT REFERENCES google_ads_refresh_runs(id) ON DELETE SET NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS candidate_signals_scope_idx ON candidate_signals(customer_id, evidence_start_date, evidence_end_date, campaign_id, ad_group_id, signal_type);

CREATE TABLE IF NOT EXISTS google_ads_warehouse_slice_fingerprints (
  customer_id TEXT NOT NULL,
  source_table TEXT NOT NULL,
  scope_level TEXT NOT NULL CHECK (scope_level IN ('account', 'campaign', 'ad_group', 'account_parent', 'campaign_parent')),
  slice_date TEXT NOT NULL,
  campaign_id TEXT NOT NULL DEFAULT '*',
  ad_group_id TEXT NOT NULL DEFAULT '*',
  row_count INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, source_table, scope_level, slice_date, campaign_id, ad_group_id)
);
CREATE INDEX IF NOT EXISTS google_ads_warehouse_slice_fingerprints_lookup_idx
  ON google_ads_warehouse_slice_fingerprints(customer_id, slice_date, source_table, scope_level, campaign_id, ad_group_id);

CREATE INDEX IF NOT EXISTS google_ads_account_daily_watermark_idx ON google_ads_account_daily(customer_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_campaign_daily_watermark_idx ON google_ads_campaign_daily(customer_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_campaign_daily_scoped_watermark_idx ON google_ads_campaign_daily(customer_id, campaign_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_ad_group_daily_watermark_idx ON google_ads_ad_group_daily(customer_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_ad_group_daily_scoped_watermark_idx ON google_ads_ad_group_daily(customer_id, campaign_id, ad_group_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_keyword_daily_watermark_idx ON google_ads_keyword_daily(customer_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_keyword_daily_scoped_watermark_idx ON google_ads_keyword_daily(customer_id, campaign_id, ad_group_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_search_term_daily_watermark_idx ON google_ads_search_term_daily(customer_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_search_term_daily_scoped_watermark_idx ON google_ads_search_term_daily(customer_id, campaign_id, ad_group_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_device_daily_watermark_idx ON google_ads_device_daily(customer_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_device_daily_scoped_watermark_idx ON google_ads_device_daily(customer_id, campaign_id, ad_group_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_day_of_week_daily_watermark_idx ON google_ads_day_of_week_daily(customer_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_day_of_week_daily_scoped_watermark_idx ON google_ads_day_of_week_daily(customer_id, campaign_id, ad_group_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_day_hour_daily_watermark_idx ON google_ads_day_hour_daily(customer_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_day_hour_daily_scoped_watermark_idx ON google_ads_day_hour_daily(customer_id, campaign_id, ad_group_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_landing_page_daily_watermark_idx ON google_ads_landing_page_daily(customer_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_landing_page_daily_scoped_watermark_idx ON google_ads_landing_page_daily(customer_id, campaign_id, ad_group_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_expanded_landing_page_daily_watermark_idx ON google_ads_expanded_landing_page_daily(customer_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_expanded_landing_page_daily_scoped_watermark_idx ON google_ads_expanded_landing_page_daily(customer_id, campaign_id, ad_group_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_conversion_action_daily_watermark_idx ON google_ads_conversion_action_daily(customer_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_conversion_ad_group_daily_watermark_idx ON google_ads_conversion_ad_group_daily(customer_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_conversion_ad_group_daily_scoped_watermark_idx ON google_ads_conversion_ad_group_daily(customer_id, campaign_id, ad_group_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_conversion_search_term_daily_watermark_idx ON google_ads_conversion_search_term_daily(customer_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_conversion_search_term_daily_scoped_watermark_idx ON google_ads_conversion_search_term_daily(customer_id, campaign_id, ad_group_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_click_evidence_daily_watermark_idx ON google_ads_click_evidence_daily(customer_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_click_evidence_daily_scoped_watermark_idx ON google_ads_click_evidence_daily(customer_id, campaign_id, ad_group_id, date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_campaign_snapshot_watermark_idx ON google_ads_campaign_snapshot(customer_id, last_seen_at DESC) WHERE present_in_latest_snapshot = true;
CREATE INDEX IF NOT EXISTS google_ads_ad_group_snapshot_watermark_idx ON google_ads_ad_group_snapshot(customer_id, last_seen_at DESC) WHERE present_in_latest_snapshot = true;
CREATE INDEX IF NOT EXISTS google_ads_configured_keywords_watermark_idx ON google_ads_configured_keywords(customer_id, last_seen_at DESC) WHERE present_in_latest_snapshot = true;
CREATE INDEX IF NOT EXISTS google_ads_quality_score_snapshot_watermark_idx ON google_ads_quality_score_snapshot(customer_id, last_seen_at DESC) WHERE present_in_latest_snapshot = true;
CREATE INDEX IF NOT EXISTS google_ads_campaign_negatives_watermark_idx ON google_ads_campaign_negatives(customer_id, last_seen_at DESC) WHERE present_in_latest_snapshot = true;
CREATE INDEX IF NOT EXISTS google_ads_ad_group_negatives_watermark_idx ON google_ads_ad_group_negatives(customer_id, last_seen_at DESC) WHERE present_in_latest_snapshot = true;
CREATE INDEX IF NOT EXISTS google_ads_account_negative_lists_watermark_idx ON google_ads_account_negative_lists(customer_id, last_seen_at DESC) WHERE present_in_latest_snapshot = true;
CREATE INDEX IF NOT EXISTS google_ads_shared_negative_sets_watermark_idx ON google_ads_shared_negative_sets(customer_id, last_seen_at DESC) WHERE present_in_latest_snapshot = true;
CREATE INDEX IF NOT EXISTS google_ads_shared_negative_criteria_watermark_idx ON google_ads_shared_negative_criteria(customer_id, last_seen_at DESC) WHERE present_in_latest_snapshot = true;
CREATE INDEX IF NOT EXISTS google_ads_campaign_shared_sets_watermark_idx ON google_ads_campaign_shared_sets(customer_id, last_seen_at DESC) WHERE present_in_latest_snapshot = true;
CREATE INDEX IF NOT EXISTS google_ads_keyword_planner_ideas_watermark_idx ON google_ads_keyword_planner_ideas(customer_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_keyword_planner_historical_watermark_idx ON google_ads_keyword_planner_historical(customer_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_auction_insights_rows_watermark_idx ON google_ads_auction_insights_rows(customer_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_auction_insights_rows_scoped_watermark_idx ON google_ads_auction_insights_rows(customer_id, campaign_id, ad_group_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_auction_insights_status_watermark_idx ON google_ads_auction_insights_status(customer_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS google_ads_report_coverage_watermark_idx ON google_ads_report_coverage(customer_id, coverage_date, fetched_at DESC);
CREATE INDEX IF NOT EXISTS candidate_signals_watermark_idx ON candidate_signals(customer_id, evidence_start_date, evidence_end_date, campaign_id, ad_group_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS dashboard_payload_cache (
  cache_key TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  campaign_id TEXT,
  ad_group_id TEXT,
  warehouse_watermark TEXT NOT NULL,
  payload JSONB NOT NULL,
  payload_bytes INTEGER NOT NULL DEFAULT 0,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dashboard_payload_cache_lookup_idx ON dashboard_payload_cache(customer_id, start_date, end_date, campaign_id, ad_group_id);
`;

const FACT_REPORTS = [
    'account_summary',
    'campaign_performance',
    'ad_group_performance',
    'keyword_performance',
    'search_term_performance',
    'device_performance',
    'day_of_week_performance',
    'day_and_hour_performance',
    'landing_page_performance',
    'expanded_landing_page_performance',
    'conversion_action_performance',
    'conversion_action_metrics_by_ad_group',
    'conversion_attribution_by_search_term',
    'click_evidence_by_day'
] as const;

const WATERMARK_FACT_TABLES = [
    'google_ads_account_daily',
    'google_ads_campaign_daily',
    'google_ads_ad_group_daily',
    'google_ads_keyword_daily',
    'google_ads_search_term_daily',
    'google_ads_device_daily',
    'google_ads_day_of_week_daily',
    'google_ads_day_hour_daily',
    'google_ads_landing_page_daily',
    'google_ads_expanded_landing_page_daily',
    'google_ads_conversion_action_daily',
    'google_ads_conversion_ad_group_daily',
    'google_ads_conversion_search_term_daily',
    'google_ads_click_evidence_daily'
];

type WarehouseFingerprintScopeLevel = 'account' | 'campaign' | 'ad_group' | 'account_parent' | 'campaign_parent';
type WarehouseFingerprintDateMode = 'dated' | 'global' | 'candidate';

type WarehouseFingerprintSource = {
    table: string;
    dateMode: WarehouseFingerprintDateMode;
    parentAware?: boolean;
};

type WarehouseFingerprintRow = {
    customer_id: string;
    source_table: string;
    scope_level: WarehouseFingerprintScopeLevel;
    slice_date: string;
    campaign_id: string;
    ad_group_id: string;
    row_count: number;
    fingerprint: string;
};

const FINGERPRINT_GLOBAL_SLICE = '*';
const FINGERPRINT_ANY_ID = '*';

const SNAPSHOT_FINGERPRINT_TABLES = [
    'google_ads_campaign_snapshot',
    'google_ads_ad_group_snapshot',
    'google_ads_configured_keywords',
    'google_ads_quality_score_snapshot',
    'google_ads_campaign_negatives',
    'google_ads_ad_group_negatives',
    'google_ads_account_negative_lists',
    'google_ads_shared_negative_sets',
    'google_ads_shared_negative_criteria',
    'google_ads_campaign_shared_sets'
];

const WAREHOUSE_FINGERPRINT_SOURCES: WarehouseFingerprintSource[] = [
    ...WATERMARK_FACT_TABLES.map(table => ({ table, dateMode: 'dated' as const })),
    ...SNAPSHOT_FINGERPRINT_TABLES.map(table => ({ table, dateMode: 'global' as const, parentAware: true })),
    { table: 'candidate_signals', dateMode: 'candidate', parentAware: true },
    { table: 'google_ads_keyword_planner_ideas', dateMode: 'global' },
    { table: 'google_ads_keyword_planner_historical', dateMode: 'global' },
    { table: 'google_ads_auction_insights_rows', dateMode: 'global', parentAware: true },
    { table: 'google_ads_auction_insights_status', dateMode: 'global' },
    { table: 'google_ads_report_coverage', dateMode: 'dated' }
];

const WAREHOUSE_FINGERPRINT_SOURCE_BY_TABLE = new Map(
    WAREHOUSE_FINGERPRINT_SOURCES.map(source => [source.table, source])
);

const CAMPAIGN_SCOPED_TABLES = new Set([
    'google_ads_campaign_daily',
    'google_ads_ad_group_daily',
    'google_ads_keyword_daily',
    'google_ads_search_term_daily',
    'google_ads_device_daily',
    'google_ads_day_of_week_daily',
    'google_ads_day_hour_daily',
    'google_ads_landing_page_daily',
    'google_ads_expanded_landing_page_daily',
    'google_ads_conversion_ad_group_daily',
    'google_ads_conversion_search_term_daily',
    'google_ads_click_evidence_daily',
    'google_ads_campaign_snapshot',
    'google_ads_ad_group_snapshot',
    'google_ads_configured_keywords',
    'google_ads_quality_score_snapshot',
    'google_ads_campaign_negatives',
    'google_ads_ad_group_negatives',
    'google_ads_campaign_shared_sets',
    'candidate_signals',
    'google_ads_auction_insights_rows'
]);

const AD_GROUP_SCOPED_TABLES = new Set([
    'google_ads_ad_group_daily',
    'google_ads_keyword_daily',
    'google_ads_search_term_daily',
    'google_ads_device_daily',
    'google_ads_day_of_week_daily',
    'google_ads_day_hour_daily',
    'google_ads_landing_page_daily',
    'google_ads_expanded_landing_page_daily',
    'google_ads_conversion_ad_group_daily',
    'google_ads_conversion_search_term_daily',
    'google_ads_click_evidence_daily',
    'google_ads_ad_group_snapshot',
    'google_ads_configured_keywords',
    'google_ads_quality_score_snapshot',
    'google_ads_ad_group_negatives',
    'candidate_signals',
    'google_ads_auction_insights_rows'
]);

function isPool(db: Db): db is Pool {
    return typeof (db as Pool).connect === 'function';
}

async function withTransaction<T>(db: Db, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!isPool(db)) return fn(db);
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

function cleanText(value: any): string | null {
    const text = String(value ?? '').trim();
    return text || null;
}

function normalizeNullableId(value: any): string | null {
    const text = cleanText(value);
    return text && text !== 'ALL' ? text : null;
}

function assertDate(value: string, label: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must be YYYY-MM-DD.`);
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        throw new Error(`${label} is invalid: ${value}`);
    }
    return value;
}

function dateRange(startDate: string, endDate: string): string[] {
    assertDate(startDate, 'startDate');
    assertDate(endDate, 'endDate');
    if (startDate > endDate) throw new Error('startDate must be before or equal to endDate.');
    const out: string[] = [];
    const cursor = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T00:00:00.000Z`);
    while (cursor <= end) {
        out.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return out;
}

function isoDate(value: any): string | null {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    const text = String(value);
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : text;
}

function isoDateTime(value: any): string | null {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    return String(value);
}

function normalizeDbRow<T extends Record<string, any>>(row: T): T {
    const copy: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
        if (value instanceof Date) copy[key] = key === 'date' || key.endsWith('_date') ? isoDate(value) : value.toISOString();
        else copy[key] = value;
    }
    return copy as T;
}

function hashParts(parts: any[]): string {
    return crypto.createHash('sha256')
        .update(parts.map(part => String(part ?? '').trim().toLowerCase()).join('|'))
        .digest('hex');
}

export function dimensionHash(parts: any[]): string {
    return hashParts(parts);
}

function jsonValue(value: any): any {
    if (value === undefined || value === null) return null;
    if (Array.isArray(value) || (typeof value === 'object' && value.constructor === Object)) {
        return JSON.stringify(value);
    }
    return value;
}

function rowValue(row: Record<string, any>, column: string, runId?: string): any {
    if (column === 'run_id') return runId || row.run_id || null;
    if (column === 'fetched_at') return row.fetched_at || new Date();
    if (column === 'raw_payload') return row.raw_payload || {};
    return Object.prototype.hasOwnProperty.call(row, column) ? jsonValue(row[column]) : null;
}

async function insertRows(client: PoolClient, table: string, columns: string[], rows: Record<string, any>[], runId?: string): Promise<number> {
    if (rows.length === 0) return 0;
    let inserted = 0;
    const chunkSize = 200;
    for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const values: any[] = [];
        const tuples = chunk.map((row, rowIndex) => {
            const placeholders = columns.map((column, columnIndex) => {
                values.push(rowValue(row, column, runId));
                return `$${rowIndex * columns.length + columnIndex + 1}`;
            });
            return `(${placeholders.join(', ')})`;
        });
        await client.query(
            `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`,
            values
        );
        inserted += chunk.length;
    }
    return inserted;
}

async function upsertRows(
    client: PoolClient,
    table: string,
    columns: string[],
    conflictColumns: string[],
    rows: Record<string, any>[],
    runId?: string,
    preserveOnConflict: string[] = []
): Promise<number> {
    if (rows.length === 0) return 0;
    let upserted = 0;
    const preserved = new Set(preserveOnConflict);
    const updateColumns = columns.filter(column => !conflictColumns.includes(column) && !preserved.has(column));
    const updateSql = updateColumns.map(column => `${column} = EXCLUDED.${column}`).join(', ');
    const chunkSize = 100;
    for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const values: any[] = [];
        const tuples = chunk.map((row, rowIndex) => {
            const placeholders = columns.map((column, columnIndex) => {
                values.push(rowValue(row, column, runId));
                return `$${rowIndex * columns.length + columnIndex + 1}`;
            });
            return `(${placeholders.join(', ')})`;
        });
        await client.query(
            `INSERT INTO ${table} (${columns.join(', ')})
             VALUES ${tuples.join(', ')}
             ON CONFLICT (${conflictColumns.join(', ')}) DO UPDATE SET ${updateSql}`,
            values
        );
        upserted += chunk.length;
    }
    return upserted;
}

async function replaceDateWindow(
    db: Db,
    table: string,
    columns: string[],
    customerId: string,
    startDate: string,
    endDate: string,
    rows: Record<string, any>[],
    runId: string
): Promise<number> {
    assertDate(startDate, 'startDate');
    assertDate(endDate, 'endDate');
    if (startDate > endDate) throw new Error('startDate must be before or equal to endDate.');
    const replaced = await withTransaction(db, async client => {
        const previousRows = await selectFingerprintDateRows(client, table, customerId, startDate, endDate);
        await client.query(`DELETE FROM ${table} WHERE customer_id = $1 AND date BETWEEN $2::date AND $3::date`, [customerId, startDate, endDate]);
        const inserted = await insertRows(client, table, columns, rows, runId);
        await refreshDateWindowFingerprints(client, table, customerId, startDate, endDate, previousRows);
        return inserted;
    });
    invalidateAdsWarehouseRuntimeCaches();
    return replaced;
}

async function replaceSnapshot(
    db: Db,
    table: string,
    columns: string[],
    conflictColumns: string[],
    customerId: string,
    rows: Record<string, any>[],
    runId: string
): Promise<number> {
    const replaced = await withTransaction(db, async client => {
        const previousRows = await selectFingerprintCustomerRows(client, table, customerId, true);
        await client.query(`UPDATE ${table} SET present_in_latest_snapshot = false WHERE customer_id = $1`, [customerId]);
        const now = new Date();
        const enriched = rows.map(row => ({
            ...row,
            customer_id: row.customer_id || customerId,
            present_in_latest_snapshot: true,
            first_seen_at: row.first_seen_at || now,
            last_seen_at: now,
            snapshot_run_id: runId
        }));
        const upserted = await upsertRows(client, table, columns, conflictColumns, enriched, runId, [
            'first_seen_at'
        ]);
        await refreshCustomerFingerprints(client, table, customerId, previousRows, true);
        return upserted;
    });
    invalidateAdsWarehouseRuntimeCaches();
    return replaced;
}

async function replaceCustomerRows(
    db: Db,
    table: string,
    columns: string[],
    customerId: string,
    rows: Record<string, any>[]
): Promise<number> {
    const replaced = await withTransaction(db, async client => {
        const previousRows = await selectFingerprintCustomerRows(client, table, customerId);
        await client.query(`DELETE FROM ${table} WHERE customer_id = $1`, [customerId]);
        const inserted = await insertRows(client, table, columns, rows);
        await refreshCustomerFingerprints(client, table, customerId, previousRows);
        return inserted;
    });
    invalidateAdsWarehouseRuntimeCaches();
    return replaced;
}

const metricColumns = [
    'cost_micros',
    'clicks',
    'impressions',
    'conversions',
    'all_conversions',
    'conversions_value',
    'ctr',
    'average_cpc_micros',
    'cost_per_conversion_micros'
];

const accountDailyColumns = ['customer_id', 'date', 'currency_code', ...metricColumns, 'run_id', 'fetched_at', 'raw_payload'];
const campaignDailyColumns = [
    'customer_id', 'date', 'campaign_id', 'campaign_name', 'campaign_status', 'bidding_strategy_type',
    'campaign_budget_resource_name', 'budget_amount_micros', 'target_cpa_micros', 'target_roas',
    ...metricColumns, 'search_impression_share', 'search_budget_lost_impression_share',
    'search_rank_lost_impression_share', 'run_id', 'fetched_at', 'raw_payload'
];
const adGroupDailyColumns = [
    'customer_id', 'date', 'campaign_id', 'campaign_name', 'ad_group_id', 'ad_group_name', 'ad_group_status',
    'cost_micros', 'clicks', 'impressions', 'conversions', 'all_conversions', 'ctr', 'average_cpc_micros',
    'cost_per_conversion_micros', 'search_impression_share', 'run_id', 'fetched_at', 'raw_payload'
];
const keywordDailyColumns = [
    'customer_id', 'date', 'campaign_id', 'campaign_name', 'ad_group_id', 'ad_group_name', 'criterion_id',
    'criterion_resource_name', 'keyword_text', 'match_type', 'criterion_status', 'cpc_bid_micros',
    'bidding_strategy_type', 'cost_micros', 'clicks', 'impressions', 'conversions', 'all_conversions', 'ctr',
    'average_cpc_micros', 'cost_per_conversion_micros', 'search_impression_share', 'run_id', 'fetched_at', 'raw_payload'
];
const searchTermDailyColumns = [
    'customer_id', 'date', 'dimension_hash', 'campaign_id', 'campaign_name', 'ad_group_id', 'ad_group_name',
    'search_term', 'search_term_status', 'matched_keyword_text', 'matched_keyword_match_type',
    'search_term_match_type', 'search_term_match_source', 'cost_micros', 'clicks', 'impressions',
    'conversions', 'all_conversions', 'ctr', 'average_cpc_micros', 'cost_per_conversion_micros',
    'run_id', 'fetched_at', 'raw_payload'
];
const deviceDailyColumns = [
    'customer_id', 'date', 'campaign_id', 'campaign_name', 'ad_group_id', 'ad_group_name', 'device',
    'cost_micros', 'clicks', 'impressions', 'conversions', 'conversions_value', 'ctr', 'average_cpc_micros',
    'cost_per_conversion_micros', 'run_id', 'fetched_at', 'raw_payload'
];
const dayOfWeekDailyColumns = [
    'customer_id', 'date', 'campaign_id', 'campaign_name', 'ad_group_id', 'ad_group_name', 'day_of_week',
    'cost_micros', 'clicks', 'impressions', 'conversions', 'conversions_value', 'ctr', 'average_cpc_micros',
    'cost_per_conversion_micros', 'run_id', 'fetched_at', 'raw_payload'
];
const dayHourDailyColumns = [
    'customer_id', 'date', 'campaign_id', 'campaign_name', 'ad_group_id', 'ad_group_name', 'day_of_week',
    'hour', 'cost_micros', 'clicks', 'impressions', 'conversions', 'ctr', 'average_cpc_micros',
    'cost_per_conversion_micros', 'run_id', 'fetched_at', 'raw_payload'
];
const landingPageDailyColumns = [
    'customer_id', 'date', 'url_hash', 'unexpanded_final_url', 'campaign_id', 'campaign_name', 'ad_group_id',
    'ad_group_name', 'cost_micros', 'clicks', 'impressions', 'conversions', 'ctr', 'average_cpc_micros',
    'cost_per_conversion_micros', 'mobile_friendly_clicks_percentage', 'valid_amp_clicks_percentage',
    'speed_score', 'run_id', 'fetched_at', 'raw_payload'
];
const expandedLandingPageDailyColumns = landingPageDailyColumns.map(column => column === 'unexpanded_final_url' ? 'expanded_final_url' : column);
const conversionActionDailyColumns = [
    'customer_id', 'date', 'conversion_action_resource_name', 'conversion_action_name', 'conversion_action_category',
    'conversion_action_status', 'primary_for_goal', 'conversions', 'conversions_value', 'all_conversions',
    'run_id', 'fetched_at', 'raw_payload'
];
const conversionScopedDailyColumns = [
    'customer_id', 'date', 'dimension_hash', 'campaign_id', 'campaign_name', 'ad_group_id', 'ad_group_name',
    'conversion_action_name', 'conversion_action_category', 'conversions', 'conversions_value',
    'run_id', 'fetched_at', 'raw_payload'
];
const conversionSearchTermDailyColumns = [
    'customer_id', 'date', 'dimension_hash', 'campaign_id', 'campaign_name', 'ad_group_id', 'ad_group_name',
    'search_term', 'conversion_action_name', 'conversion_action_category', 'conversions', 'conversions_value',
    'run_id', 'fetched_at', 'raw_payload'
];
const clickEvidenceDailyColumns = [
    'customer_id', 'date', 'dimension_hash', 'gclid', 'campaign_id', 'ad_group_id', 'keyword_text',
    'keyword_match_type', 'click_type', 'device', 'run_id', 'fetched_at', 'raw_payload'
];

const campaignSnapshotColumns = [
    'customer_id', 'campaign_id', 'campaign_name', 'campaign_status', 'bidding_strategy_type',
    'campaign_budget_resource_name', 'budget_amount_micros', 'target_cpa_micros', 'target_roas',
    'present_in_latest_snapshot', 'first_seen_at', 'last_seen_at', 'snapshot_run_id', 'raw_payload'
];
const adGroupSnapshotColumns = [
    'customer_id', 'campaign_id', 'campaign_name', 'ad_group_id', 'ad_group_name', 'ad_group_status',
    'present_in_latest_snapshot', 'first_seen_at', 'last_seen_at', 'snapshot_run_id', 'raw_payload'
];
const configuredKeywordColumns = [
    'customer_id', 'campaign_id', 'campaign_name', 'ad_group_id', 'ad_group_name', 'criterion_id',
    'criterion_resource_name', 'keyword_text', 'match_type', 'status', 'primary_status', 'primary_status_reasons',
    'final_urls', 'cpc_bid_micros', 'present_in_latest_snapshot', 'first_seen_at', 'last_seen_at',
    'snapshot_run_id', 'raw_payload'
];
const qualityScoreColumns = [
    'customer_id', 'campaign_id', 'campaign_name', 'ad_group_id', 'ad_group_name', 'criterion_id', 'keyword_text',
    'match_type', 'status', 'quality_score', 'creative_quality_score', 'post_click_quality_score',
    'search_predicted_ctr', 'present_in_latest_snapshot', 'first_seen_at', 'last_seen_at', 'snapshot_run_id', 'raw_payload'
];
const campaignNegativeColumns = [
    'customer_id', 'campaign_id', 'campaign_name', 'criterion_id', 'keyword_text', 'match_type', 'status',
    'present_in_latest_snapshot', 'first_seen_at', 'last_seen_at', 'snapshot_run_id', 'raw_payload'
];
const adGroupNegativeColumns = [
    'customer_id', 'campaign_id', 'campaign_name', 'ad_group_id', 'ad_group_name', 'criterion_id', 'keyword_text',
    'match_type', 'status', 'present_in_latest_snapshot', 'first_seen_at', 'last_seen_at', 'snapshot_run_id', 'raw_payload'
];
const accountNegativeListColumns = [
    'customer_id', 'customer_negative_criterion_id', 'resource_name', 'shared_set_resource_name',
    'present_in_latest_snapshot', 'first_seen_at', 'last_seen_at', 'snapshot_run_id', 'raw_payload'
];
const sharedNegativeSetColumns = [
    'customer_id', 'shared_set_id', 'shared_set_resource_name', 'shared_set_name', 'shared_set_type',
    'shared_set_status', 'present_in_latest_snapshot', 'first_seen_at', 'last_seen_at', 'snapshot_run_id', 'raw_payload'
];
const sharedNegativeCriterionColumns = [
    'customer_id', 'shared_set_resource_name', 'criterion_id', 'keyword_text', 'match_type',
    'present_in_latest_snapshot', 'first_seen_at', 'last_seen_at', 'snapshot_run_id', 'raw_payload'
];
const campaignSharedSetColumns = [
    'customer_id', 'campaign_id', 'campaign_name', 'campaign_resource_name', 'shared_set_resource_name', 'status',
    'present_in_latest_snapshot', 'first_seen_at', 'last_seen_at', 'snapshot_run_id', 'raw_payload'
];

const plannerIdeaColumns = [
    'customer_id', 'keyword_key', 'keyword', 'avg_monthly_searches', 'competition', 'competition_index',
    'low_bid_micros', 'high_bid_micros', 'seed_type', 'seed_keywords', 'seed_url', 'seed_site',
    'geo_target_constants', 'language', 'keyword_plan_network', 'monthly_search_volumes', 'fetched_at', 'raw_payload'
];
const plannerHistoricalColumns = [
    'customer_id', 'keyword_key', 'keyword', 'close_variants', 'avg_monthly_searches', 'competition',
    'competition_index', 'low_bid_micros', 'high_bid_micros', 'geo_target_constants', 'language',
    'keyword_plan_network', 'monthly_search_volumes', 'fetched_at', 'raw_payload'
];
const auctionInsightColumns = [
    'customer_id', 'dimension_hash', 'source_scope', 'entity_id', 'entity_name', 'campaign_id', 'campaign_name',
    'ad_group_id', 'ad_group_name', 'auction_date', 'domain', 'impression_share', 'overlap_rate',
    'position_above_rate', 'top_impression_percentage', 'absolute_top_impression_percentage',
    'outranking_share', 'fetched_at', 'raw_payload'
];
const auctionInsightStatusColumns = [
    'customer_id', 'entity_type', 'entity_id', 'entity_name', 'status', 'sheet_name', 'rows_fetched',
    'message', 'spreadsheet_id', 'spreadsheet_modified_time', 'fetched_at'
];
const candidateSignalColumns = [
    'signal_id', 'customer_id', 'signal_type', 'severity', 'campaign_id', 'ad_group_id',
    'evidence_start_date', 'evidence_end_date', 'payload', 'run_id', 'generated_at'
];

const WAREHOUSE_FINGERPRINT_COLUMNS_BY_TABLE = new Map<string, string[]>([
    ['google_ads_account_daily', accountDailyColumns],
    ['google_ads_campaign_daily', campaignDailyColumns],
    ['google_ads_ad_group_daily', adGroupDailyColumns],
    ['google_ads_keyword_daily', keywordDailyColumns],
    ['google_ads_search_term_daily', searchTermDailyColumns],
    ['google_ads_device_daily', deviceDailyColumns],
    ['google_ads_day_of_week_daily', dayOfWeekDailyColumns],
    ['google_ads_day_hour_daily', dayHourDailyColumns],
    ['google_ads_landing_page_daily', landingPageDailyColumns],
    ['google_ads_expanded_landing_page_daily', expandedLandingPageDailyColumns],
    ['google_ads_conversion_action_daily', conversionActionDailyColumns],
    ['google_ads_conversion_ad_group_daily', conversionScopedDailyColumns],
    ['google_ads_conversion_search_term_daily', conversionSearchTermDailyColumns],
    ['google_ads_click_evidence_daily', clickEvidenceDailyColumns],
    ['google_ads_campaign_snapshot', campaignSnapshotColumns],
    ['google_ads_ad_group_snapshot', adGroupSnapshotColumns],
    ['google_ads_configured_keywords', configuredKeywordColumns],
    ['google_ads_quality_score_snapshot', qualityScoreColumns],
    ['google_ads_campaign_negatives', campaignNegativeColumns],
    ['google_ads_ad_group_negatives', adGroupNegativeColumns],
    ['google_ads_account_negative_lists', accountNegativeListColumns],
    ['google_ads_shared_negative_sets', sharedNegativeSetColumns],
    ['google_ads_shared_negative_criteria', sharedNegativeCriterionColumns],
    ['google_ads_campaign_shared_sets', campaignSharedSetColumns],
    ['google_ads_keyword_planner_ideas', plannerIdeaColumns],
    ['google_ads_keyword_planner_historical', plannerHistoricalColumns],
    ['google_ads_auction_insights_rows', auctionInsightColumns],
    ['google_ads_auction_insights_status', auctionInsightStatusColumns],
    ['candidate_signals', candidateSignalColumns],
    ['google_ads_report_coverage', ['customer_id', 'report_name', 'coverage_date', 'status', 'row_count', 'run_id', 'fetched_at', 'error']]
]);

const DEFAULT_FINGERPRINT_IGNORED_COLUMNS = new Set([
    'run_id',
    'snapshot_run_id',
    'fetched_at',
    'first_seen_at',
    'last_seen_at',
    'generated_at'
]);

const FINGERPRINT_INCLUDED_VOLATILE_COLUMNS_BY_TABLE = new Map<string, Set<string>>([
    ['google_ads_report_coverage', new Set(['fetched_at'])]
]);

function stableJson(value: any): string {
    if (value === undefined) return 'null';
    if (value === null) return 'null';
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (typeof value === 'object') {
        const entries = Object.entries(value)
            .filter(([, entryValue]) => entryValue !== undefined)
            .sort(([left], [right]) => left.localeCompare(right));
        return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function warehouseFingerprintColumns(table: string): string[] {
    const columns = WAREHOUSE_FINGERPRINT_COLUMNS_BY_TABLE.get(table) || [];
    const includedVolatile = FINGERPRINT_INCLUDED_VOLATILE_COLUMNS_BY_TABLE.get(table) || new Set<string>();
    return columns.filter(column => !DEFAULT_FINGERPRINT_IGNORED_COLUMNS.has(column) || includedVolatile.has(column));
}

function fingerprintId(value: any): string {
    return cleanText(value) || FINGERPRINT_ANY_ID;
}

function fingerprintSliceDate(value: any): string {
    return isoDate(value) || FINGERPRINT_GLOBAL_SLICE;
}

function fingerprintGroupKey(row: WarehouseFingerprintRow): string {
    return [
        row.customer_id,
        row.source_table,
        row.scope_level,
        row.slice_date,
        row.campaign_id,
        row.ad_group_id
    ].join('\u001f');
}

function emptyFingerprintRow(
    customerId: string,
    table: string,
    scopeLevel: WarehouseFingerprintScopeLevel,
    sliceDate: string,
    campaignId = FINGERPRINT_ANY_ID,
    adGroupId = FINGERPRINT_ANY_ID
): WarehouseFingerprintRow {
    return {
        customer_id: customerId,
        source_table: table,
        scope_level: scopeLevel,
        slice_date: sliceDate,
        campaign_id: campaignId,
        ad_group_id: adGroupId,
        row_count: 0,
        fingerprint: ''
    };
}

function rowContentFingerprint(table: string, row: Record<string, any>): string {
    const columns = warehouseFingerprintColumns(table);
    const payload = columns.map(column => [column, row[column] ?? null]);
    return crypto.createHash('sha256').update(stableJson(payload)).digest('hex');
}

function sliceContentFingerprint(group: WarehouseFingerprintRow, rows: Record<string, any>[]): string {
    const rowHashes = rows.map(row => rowContentFingerprint(group.source_table, row)).sort();
    return crypto.createHash('sha256')
        .update(stableJson([
            group.source_table,
            group.scope_level,
            group.slice_date,
            group.campaign_id,
            group.ad_group_id,
            rowHashes
        ]))
        .digest('hex');
}

function candidateFingerprintDates(row: Record<string, any>): string[] {
    const start = isoDate(row.evidence_start_date);
    const end = isoDate(row.evidence_end_date);
    if (!start || !end || start > end) return [];
    const windowStart = isoDate(row.__fingerprint_slice_start_date) || start;
    const windowEnd = isoDate(row.__fingerprint_slice_end_date) || end;
    const sliceStart = start > windowStart ? start : windowStart;
    const sliceEnd = end < windowEnd ? end : windowEnd;
    if (sliceStart > sliceEnd) return [];
    return dateRange(sliceStart, sliceEnd);
}

function rowFingerprintSliceDates(source: WarehouseFingerprintSource, row: Record<string, any>): string[] {
    if (source.dateMode === 'global') return [FINGERPRINT_GLOBAL_SLICE];
    if (source.dateMode === 'candidate') return candidateFingerprintDates(row);
    return [fingerprintSliceDate(row.coverage_date || row.date)];
}

function addFingerprintGroup(
    groups: Map<string, { row: WarehouseFingerprintRow; rows: Record<string, any>[] }>,
    customerId: string,
    source: WarehouseFingerprintSource,
    scopeLevel: WarehouseFingerprintScopeLevel,
    sliceDate: string,
    row: Record<string, any>,
    campaignId = FINGERPRINT_ANY_ID,
    adGroupId = FINGERPRINT_ANY_ID
): void {
    const group = emptyFingerprintRow(customerId, source.table, scopeLevel, sliceDate, campaignId, adGroupId);
    const key = fingerprintGroupKey(group);
    const existing = groups.get(key);
    if (existing) existing.rows.push(row);
    else groups.set(key, { row: group, rows: [row] });
}

function groupRowsForFingerprints(
    source: WarehouseFingerprintSource,
    rows: Record<string, any>[],
    customerIdFallback?: string
): Map<string, { row: WarehouseFingerprintRow; rows: Record<string, any>[] }> {
    const groups = new Map<string, { row: WarehouseFingerprintRow; rows: Record<string, any>[] }>();
    for (const row of rows) {
        const customerId = cleanText(row.customer_id) || customerIdFallback;
        if (!customerId) continue;
        const campaignId = fingerprintId(row.campaign_id);
        const adGroupId = fingerprintId(row.ad_group_id);
        for (const sliceDate of rowFingerprintSliceDates(source, row)) {
            addFingerprintGroup(groups, customerId, source, 'account', sliceDate, row);
            if (tableSupportsCampaign(source.table) && campaignId !== FINGERPRINT_ANY_ID) {
                addFingerprintGroup(groups, customerId, source, 'campaign', sliceDate, row, campaignId);
            }
            if (tableSupportsAdGroup(source.table) && adGroupId !== FINGERPRINT_ANY_ID) {
                addFingerprintGroup(groups, customerId, source, 'ad_group', sliceDate, row, campaignId, adGroupId);
            }
            if (source.parentAware && campaignId === FINGERPRINT_ANY_ID) {
                addFingerprintGroup(groups, customerId, source, 'account_parent', sliceDate, row);
            }
            if (source.parentAware && campaignId !== FINGERPRINT_ANY_ID && adGroupId === FINGERPRINT_ANY_ID) {
                addFingerprintGroup(groups, customerId, source, 'campaign_parent', sliceDate, row, campaignId);
            }
        }
    }
    return groups;
}

function buildSliceFingerprintRows(
    source: WarehouseFingerprintSource,
    previousRows: Record<string, any>[],
    currentRows: Record<string, any>[],
    customerId: string
): WarehouseFingerprintRow[] {
    const previousGroups = groupRowsForFingerprints(source, previousRows, customerId);
    const currentGroups = groupRowsForFingerprints(source, currentRows, customerId);
    const keys = new Set([...previousGroups.keys(), ...currentGroups.keys()]);
    return Array.from(keys).map(key => {
        const current = currentGroups.get(key);
        const base = current?.row || previousGroups.get(key)!.row;
        const rows = current?.rows || [];
        return {
            ...base,
            row_count: rows.length,
            fingerprint: sliceContentFingerprint(base, rows)
        };
    });
}

async function upsertWarehouseFingerprintRows(client: PoolClient, rows: WarehouseFingerprintRow[]): Promise<void> {
    if (!rows.length) return;
    const columns = ['customer_id', 'source_table', 'scope_level', 'slice_date', 'campaign_id', 'ad_group_id', 'row_count', 'fingerprint'];
    const chunkSize = 300;
    for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const values: any[] = [];
        const tuples = chunk.map((row, rowIndex) => {
            const rowValues = [
                row.customer_id,
                row.source_table,
                row.scope_level,
                row.slice_date,
                row.campaign_id,
                row.ad_group_id,
                row.row_count,
                row.fingerprint
            ];
            const placeholders = rowValues.map((value, columnIndex) => {
                values.push(value);
                return `$${rowIndex * columns.length + columnIndex + 1}`;
            });
            return `(${placeholders.join(', ')})`;
        });
        await client.query(
            `INSERT INTO google_ads_warehouse_slice_fingerprints (${columns.join(', ')})
             VALUES ${tuples.join(', ')}
             ON CONFLICT (customer_id, source_table, scope_level, slice_date, campaign_id, ad_group_id)
             DO UPDATE SET
                row_count = EXCLUDED.row_count,
                fingerprint = EXCLUDED.fingerprint,
                computed_at = now()`,
            values
        );
    }
}

async function selectFingerprintDateRows(
    client: PoolClient,
    table: string,
    customerId: string,
    startDate: string,
    endDate: string
): Promise<Record<string, any>[]> {
    const dateColumn = table === 'google_ads_report_coverage' ? 'coverage_date' : 'date';
    const { rows } = await client.query(
        `SELECT * FROM ${table} WHERE customer_id = $1 AND ${dateColumn} BETWEEN $2::date AND $3::date`,
        [customerId, startDate, endDate]
    );
    return rows.map(normalizeDbRow);
}

async function selectFingerprintCustomerRows(
    client: PoolClient,
    table: string,
    customerId: string,
    presentOnly = false
): Promise<Record<string, any>[]> {
    const presentSql = presentOnly ? ' AND present_in_latest_snapshot = true' : '';
    const { rows } = await client.query(
        `SELECT * FROM ${table} WHERE customer_id = $1${presentSql}`,
        [customerId]
    );
    return rows.map(normalizeDbRow);
}

async function selectFingerprintCandidateRows(
    client: PoolClient,
    customerId: string,
    startDate: string,
    endDate: string
): Promise<Record<string, any>[]> {
    const { rows } = await client.query(
        `SELECT * FROM candidate_signals
         WHERE customer_id = $1
           AND evidence_start_date <= $3::date
           AND evidence_end_date >= $2::date`,
        [customerId, startDate, endDate]
    );
    return rows.map(normalizeDbRow);
}

async function refreshDateWindowFingerprints(
    client: PoolClient,
    table: string,
    customerId: string,
    startDate: string,
    endDate: string,
    previousRows: Record<string, any>[]
): Promise<void> {
    const source = WAREHOUSE_FINGERPRINT_SOURCE_BY_TABLE.get(table);
    if (!source) return;
    const currentRows = await selectFingerprintDateRows(client, table, customerId, startDate, endDate);
    await upsertWarehouseFingerprintRows(client, buildSliceFingerprintRows(source, previousRows, currentRows, customerId));
}

async function refreshCustomerFingerprints(
    client: PoolClient,
    table: string,
    customerId: string,
    previousRows: Record<string, any>[],
    presentOnly = false
): Promise<void> {
    const source = WAREHOUSE_FINGERPRINT_SOURCE_BY_TABLE.get(table);
    if (!source) return;
    const currentRows = await selectFingerprintCustomerRows(client, table, customerId, presentOnly);
    await upsertWarehouseFingerprintRows(client, buildSliceFingerprintRows(source, previousRows, currentRows, customerId));
}

function candidateFingerprintWindow(filters: DashboardFilters, rows: Record<string, any>[]): { startDate: string; endDate: string } {
    let startDate = filters.startDate;
    let endDate = filters.endDate;
    for (const row of rows) {
        const rowStart = isoDate(row.evidence_start_date);
        const rowEnd = isoDate(row.evidence_end_date);
        if (rowStart && rowStart < startDate) startDate = rowStart;
        if (rowEnd && rowEnd > endDate) endDate = rowEnd;
    }
    return { startDate, endDate };
}

function candidateRowsForFingerprintWindow(rows: Record<string, any>[], startDate: string, endDate: string): Record<string, any>[] {
    return rows
        .map(row => ({
            ...row,
            __fingerprint_slice_start_date: startDate,
            __fingerprint_slice_end_date: endDate
        }))
        .filter(row => candidateFingerprintDates(row).length > 0);
}

async function refreshCandidateFingerprints(
    client: PoolClient,
    customerId: string,
    filters: DashboardFilters,
    previousRows: Record<string, any>[],
    insertedRows: Record<string, any>[]
): Promise<void> {
    const source = WAREHOUSE_FINGERPRINT_SOURCE_BY_TABLE.get('candidate_signals');
    if (!source) return;
    const window = candidateFingerprintWindow(filters, [...previousRows, ...insertedRows]);
    const currentRows = await selectFingerprintCandidateRows(client, customerId, window.startDate, window.endDate);
    await upsertWarehouseFingerprintRows(
        client,
        buildSliceFingerprintRows(
            source,
            candidateRowsForFingerprintWindow(previousRows, window.startDate, window.endDate),
            candidateRowsForFingerprintWindow(currentRows, window.startDate, window.endDate),
            customerId
        )
    );
}

export async function rebuildWarehouseSliceFingerprints(db: Db, customerId?: string): Promise<void> {
    await withTransaction(db, async client => {
        if (customerId) await client.query(`DELETE FROM google_ads_warehouse_slice_fingerprints WHERE customer_id = $1`, [customerId]);
        else await client.query(`DELETE FROM google_ads_warehouse_slice_fingerprints`);

        for (const source of WAREHOUSE_FINGERPRINT_SOURCES) {
            let rows: Record<string, any>[];
            if (source.dateMode === 'candidate') {
                const query = customerId
                    ? await client.query(`SELECT * FROM candidate_signals WHERE customer_id = $1`, [customerId])
                    : await client.query(`SELECT * FROM candidate_signals`);
                rows = query.rows.map(normalizeDbRow);
            } else if (SNAPSHOT_FINGERPRINT_TABLES.includes(source.table)) {
                const query = customerId
                    ? await client.query(`SELECT * FROM ${source.table} WHERE customer_id = $1 AND present_in_latest_snapshot = true`, [customerId])
                    : await client.query(`SELECT * FROM ${source.table} WHERE present_in_latest_snapshot = true`);
                rows = query.rows.map(normalizeDbRow);
            } else {
                const query = customerId
                    ? await client.query(`SELECT * FROM ${source.table} WHERE customer_id = $1`, [customerId])
                    : await client.query(`SELECT * FROM ${source.table}`);
                rows = query.rows.map(normalizeDbRow);
            }
            const groupedByCustomer = new Map<string, Record<string, any>[]>();
            for (const row of rows) {
                const rowCustomerId = cleanText(row.customer_id);
                if (!rowCustomerId) continue;
                const list = groupedByCustomer.get(rowCustomerId) || [];
                list.push(row);
                groupedByCustomer.set(rowCustomerId, list);
            }
            for (const [rowCustomerId, customerRows] of groupedByCustomer) {
                await upsertWarehouseFingerprintRows(client, buildSliceFingerprintRows(source, [], customerRows, rowCustomerId));
            }
        }
    });
    invalidateAdsWarehouseRuntimeCaches();
}

async function ensureWarehouseSliceFingerprintBackfill(pool: Pool): Promise<void> {
    const { rows } = await pool.query(
        `SELECT EXISTS (SELECT 1 FROM google_ads_warehouse_slice_fingerprints LIMIT 1) AS has_fingerprints`
    );
    if (!rows[0]?.has_fingerprints) await rebuildWarehouseSliceFingerprints(pool);
}

export async function ensureAdsWarehouseSchema(pool: Pool): Promise<void> {
    await pool.query(WAREHOUSE_SCHEMA_SQL);
    await pool.query(`ALTER TABLE dashboard_payload_cache ADD COLUMN IF NOT EXISTS payload_bytes INTEGER NOT NULL DEFAULT 0`);
    await ensureWarehouseSliceFingerprintBackfill(pool);
}

export async function startWarehouseRefreshRun(pool: Pool, input: {
    id: string;
    kind: WarehouseRefreshKind;
    customerId?: string | null;
    requestedStartDate?: string | null;
    requestedEndDate?: string | null;
}): Promise<void> {
    await pool.query(
        `INSERT INTO google_ads_refresh_runs
         (id, customer_id, kind, status, requested_start_date, requested_end_date)
         VALUES ($1, $2, $3, 'running', $4, $5)`,
        [
            input.id,
            input.customerId || null,
            input.kind,
            input.requestedStartDate || null,
            input.requestedEndDate || null
        ]
    );
}

export async function completeWarehouseRefreshRun(pool: Pool, id: string, input: {
    status: 'succeeded' | 'partial' | 'failed';
    customerId?: string | null;
    effectiveStartDate?: string | null;
    effectiveEndDate?: string | null;
    sourceSummary?: Record<string, any>;
    error?: string | null;
}): Promise<void> {
    await pool.query(
        `UPDATE google_ads_refresh_runs
         SET status = $2,
             customer_id = COALESCE($3, customer_id),
             effective_start_date = COALESCE($4, effective_start_date),
             effective_end_date = COALESCE($5, effective_end_date),
             source_summary = $6,
             error = $7,
             completed_at = now()
         WHERE id = $1`,
        [
            id,
            input.status,
            input.customerId || null,
            input.effectiveStartDate || null,
            input.effectiveEndDate || null,
            input.sourceSummary || {},
            input.error || null
        ]
    );
}

export async function recordReportFetch(db: Db, input: {
    runId: string;
    customerId: string;
    reportName: string;
    status: ReportStatus;
    startDate?: string | null;
    endDate?: string | null;
    rowsFetched: number;
    error?: string | null;
}): Promise<void> {
    await db.query(
        `INSERT INTO google_ads_report_fetches
         (run_id, customer_id, report_name, status, start_date, end_date, rows_fetched, completed_at, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)`,
        [
            input.runId,
            input.customerId,
            input.reportName,
            input.status,
            input.startDate || null,
            input.endDate || null,
            input.rowsFetched,
            input.error || null
        ]
    );
}

export async function markReportCoverage(db: Db, input: {
    runId: string;
    customerId: string;
    reportName: string;
    startDate: string;
    endDate: string;
    status: 'covered' | 'empty' | 'failed';
    rowCountByDate?: Map<string, number>;
    error?: string | null;
}): Promise<void> {
    const dates = dateRange(input.startDate, input.endDate);
    const fetchedAt = new Date();
    const rows = dates.map(date => {
        const rowCount = input.rowCountByDate?.get(date) || 0;
        const status = input.status === 'covered'
            ? (rowCount > 0 ? 'covered' : 'empty')
            : input.status;
        return {
            customer_id: input.customerId,
            report_name: input.reportName,
            coverage_date: date,
            status,
            row_count: rowCount,
            run_id: input.runId,
            fetched_at: fetchedAt,
            error: input.error || null
        };
    });
    await withTransaction(db, async client => {
        const previousRows = await selectFingerprintDateRows(
            client,
            'google_ads_report_coverage',
            input.customerId,
            input.startDate,
            input.endDate
        );
        await upsertRows(
            client,
            'google_ads_report_coverage',
            ['customer_id', 'report_name', 'coverage_date', 'status', 'row_count', 'run_id', 'fetched_at', 'error'],
            ['customer_id', 'report_name', 'coverage_date'],
            rows
        );
        await refreshDateWindowFingerprints(
            client,
            'google_ads_report_coverage',
            input.customerId,
            input.startDate,
            input.endDate,
            previousRows
        );
    });
    invalidateAdsWarehouseRuntimeCaches();
}

export const replaceAccountDailyWindow = (db: Db, customerId: string, startDate: string, endDate: string, rows: AccountDailyRow[], runId: string) =>
    replaceDateWindow(db, 'google_ads_account_daily', accountDailyColumns, customerId, startDate, endDate, rows, runId);
export const replaceCampaignDailyWindow = (db: Db, customerId: string, startDate: string, endDate: string, rows: CampaignDailyRow[], runId: string) =>
    replaceDateWindow(db, 'google_ads_campaign_daily', campaignDailyColumns, customerId, startDate, endDate, rows, runId);
export const replaceAdGroupDailyWindow = (db: Db, customerId: string, startDate: string, endDate: string, rows: AdGroupDailyRow[], runId: string) =>
    replaceDateWindow(db, 'google_ads_ad_group_daily', adGroupDailyColumns, customerId, startDate, endDate, rows, runId);
export const replaceKeywordDailyWindow = (db: Db, customerId: string, startDate: string, endDate: string, rows: KeywordDailyRow[], runId: string) =>
    replaceDateWindow(db, 'google_ads_keyword_daily', keywordDailyColumns, customerId, startDate, endDate, rows, runId);
export const replaceSearchTermDailyWindow = (db: Db, customerId: string, startDate: string, endDate: string, rows: SearchTermDailyRow[], runId: string) =>
    replaceDateWindow(db, 'google_ads_search_term_daily', searchTermDailyColumns, customerId, startDate, endDate, rows, runId);
export const replaceDeviceDailyWindow = (db: Db, customerId: string, startDate: string, endDate: string, rows: DeviceDailyRow[], runId: string) =>
    replaceDateWindow(db, 'google_ads_device_daily', deviceDailyColumns, customerId, startDate, endDate, rows, runId);
export const replaceDayOfWeekDailyWindow = (db: Db, customerId: string, startDate: string, endDate: string, rows: DayOfWeekDailyRow[], runId: string) =>
    replaceDateWindow(db, 'google_ads_day_of_week_daily', dayOfWeekDailyColumns, customerId, startDate, endDate, rows, runId);
export const replaceDayHourDailyWindow = (db: Db, customerId: string, startDate: string, endDate: string, rows: DayHourDailyRow[], runId: string) =>
    replaceDateWindow(db, 'google_ads_day_hour_daily', dayHourDailyColumns, customerId, startDate, endDate, rows, runId);
export const replaceLandingPageDailyWindow = (db: Db, customerId: string, startDate: string, endDate: string, rows: LandingPageDailyRow[], runId: string) =>
    replaceDateWindow(db, 'google_ads_landing_page_daily', landingPageDailyColumns, customerId, startDate, endDate, rows, runId);
export const replaceExpandedLandingPageDailyWindow = (db: Db, customerId: string, startDate: string, endDate: string, rows: LandingPageDailyRow[], runId: string) =>
    replaceDateWindow(db, 'google_ads_expanded_landing_page_daily', expandedLandingPageDailyColumns, customerId, startDate, endDate, rows, runId);
export const replaceConversionActionDailyWindow = (db: Db, customerId: string, startDate: string, endDate: string, rows: ConversionActionDailyRow[], runId: string) =>
    replaceDateWindow(db, 'google_ads_conversion_action_daily', conversionActionDailyColumns, customerId, startDate, endDate, rows, runId);
export const replaceConversionAdGroupDailyWindow = (db: Db, customerId: string, startDate: string, endDate: string, rows: ConversionScopedDailyRow[], runId: string) =>
    replaceDateWindow(db, 'google_ads_conversion_ad_group_daily', conversionScopedDailyColumns, customerId, startDate, endDate, rows, runId);
export const replaceConversionSearchTermDailyWindow = (db: Db, customerId: string, startDate: string, endDate: string, rows: ConversionScopedDailyRow[], runId: string) =>
    replaceDateWindow(db, 'google_ads_conversion_search_term_daily', conversionSearchTermDailyColumns, customerId, startDate, endDate, rows, runId);
export const replaceClickEvidenceDailyWindow = (db: Db, customerId: string, date: string, rows: ClickEvidenceDailyRow[], runId: string) =>
    replaceDateWindow(db, 'google_ads_click_evidence_daily', clickEvidenceDailyColumns, customerId, date, date, rows, runId);

export const replaceCampaignSnapshot = (db: Db, customerId: string, rows: CampaignSnapshotRow[], runId: string) =>
    replaceSnapshot(db, 'google_ads_campaign_snapshot', campaignSnapshotColumns, ['customer_id', 'campaign_id'], customerId, rows, runId);
export const replaceAdGroupSnapshot = (db: Db, customerId: string, rows: AdGroupSnapshotRow[], runId: string) =>
    replaceSnapshot(db, 'google_ads_ad_group_snapshot', adGroupSnapshotColumns, ['customer_id', 'campaign_id', 'ad_group_id'], customerId, rows, runId);
export const replaceConfiguredKeywordsSnapshot = (db: Db, customerId: string, rows: ConfiguredKeywordRow[], runId: string) =>
    replaceSnapshot(db, 'google_ads_configured_keywords', configuredKeywordColumns, ['customer_id', 'campaign_id', 'ad_group_id', 'criterion_id'], customerId, rows, runId);
export const replaceQualityScoreSnapshot = (db: Db, customerId: string, rows: QualityScoreRow[], runId: string) =>
    replaceSnapshot(db, 'google_ads_quality_score_snapshot', qualityScoreColumns, ['customer_id', 'campaign_id', 'ad_group_id', 'criterion_id'], customerId, rows, runId);
export const replaceCampaignNegativesSnapshot = (db: Db, customerId: string, rows: NegativeKeywordRow[], runId: string) =>
    replaceSnapshot(db, 'google_ads_campaign_negatives', campaignNegativeColumns, ['customer_id', 'campaign_id', 'criterion_id'], customerId, rows, runId);
export const replaceAdGroupNegativesSnapshot = (db: Db, customerId: string, rows: NegativeKeywordRow[], runId: string) =>
    replaceSnapshot(db, 'google_ads_ad_group_negatives', adGroupNegativeColumns, ['customer_id', 'campaign_id', 'ad_group_id', 'criterion_id'], customerId, rows, runId);
export const replaceAccountNegativeListsSnapshot = (db: Db, customerId: string, rows: AccountNegativeListRow[], runId: string) =>
    replaceSnapshot(db, 'google_ads_account_negative_lists', accountNegativeListColumns, ['customer_id', 'customer_negative_criterion_id'], customerId, rows, runId);
export const replaceSharedNegativeSetsSnapshot = (db: Db, customerId: string, rows: SharedNegativeSetRow[], runId: string) =>
    replaceSnapshot(db, 'google_ads_shared_negative_sets', sharedNegativeSetColumns, ['customer_id', 'shared_set_id'], customerId, rows, runId);
export const replaceSharedNegativeCriteriaSnapshot = (db: Db, customerId: string, rows: SharedNegativeCriterionRow[], runId: string) =>
    replaceSnapshot(db, 'google_ads_shared_negative_criteria', sharedNegativeCriterionColumns, ['customer_id', 'shared_set_resource_name', 'criterion_id'], customerId, rows, runId);
export const replaceCampaignSharedSetsSnapshot = (db: Db, customerId: string, rows: CampaignSharedSetRow[], runId: string) =>
    replaceSnapshot(db, 'google_ads_campaign_shared_sets', campaignSharedSetColumns, ['customer_id', 'campaign_id', 'shared_set_resource_name'], customerId, rows, runId);

export const replaceKeywordPlannerIdeas = (db: Db, customerId: string, rows: KeywordPlannerIdeaRow[]) =>
    replaceCustomerRows(db, 'google_ads_keyword_planner_ideas', plannerIdeaColumns, customerId, rows);
export const replaceKeywordPlannerHistorical = (db: Db, customerId: string, rows: KeywordPlannerHistoricalRow[]) =>
    replaceCustomerRows(db, 'google_ads_keyword_planner_historical', plannerHistoricalColumns, customerId, rows);
export const replaceAuctionInsightsRows = (db: Db, customerId: string, rows: AuctionInsightsRow[]) =>
    replaceCustomerRows(db, 'google_ads_auction_insights_rows', auctionInsightColumns, customerId, rows);
export const replaceAuctionInsightsStatus = (db: Db, customerId: string, rows: AuctionInsightsStatusRow[]) =>
    replaceCustomerRows(db, 'google_ads_auction_insights_status', auctionInsightStatusColumns, customerId, rows);

export async function replaceCandidateSignals(db: Db, customerId: string, filters: DashboardFilters, rows: CandidateSignalRow[], runId: string): Promise<number> {
    const replaced = await withTransaction(db, async client => {
        const params: any[] = [customerId, filters.startDate, filters.endDate];
        const clauses = ['customer_id = $1', 'evidence_start_date >= $2::date', 'evidence_end_date <= $3::date'];
        if (filters.campaignId) {
            params.push(filters.campaignId);
            clauses.push(`(campaign_id = $${params.length} OR campaign_id IS NULL)`);
        }
        if (filters.adGroupId) {
            params.push(filters.adGroupId);
            clauses.push(`(ad_group_id = $${params.length} OR ad_group_id IS NULL)`);
        }
        const previousResult = await client.query(`SELECT * FROM candidate_signals WHERE ${clauses.join(' AND ')}`, params);
        const previousRows = previousResult.rows.map(normalizeDbRow);
        await client.query(`DELETE FROM candidate_signals WHERE ${clauses.join(' AND ')}`, params);
        const enriched = rows.map(row => ({ ...row, customer_id: row.customer_id || customerId, run_id: runId, generated_at: new Date() }));
        const inserted = await insertRows(client, 'candidate_signals', candidateSignalColumns, enriched, runId);
        await refreshCandidateFingerprints(client, customerId, filters, previousRows, enriched);
        return inserted;
    });
    invalidateAdsWarehouseRuntimeCaches();
    return replaced;
}

function tableSupportsCampaign(table?: string): boolean {
    if (!table) return true;
    return CAMPAIGN_SCOPED_TABLES.has(table);
}

function tableSupportsAdGroup(table?: string): boolean {
    if (!table) return true;
    return AD_GROUP_SCOPED_TABLES.has(table);
}

function scopeClauses(filters: DashboardFilters, alias = '', table?: string): { clauses: string[]; params: any[] } {
    const prefix = alias ? `${alias}.` : '';
    const clauses = [`${prefix}customer_id = $1`, `${prefix}date BETWEEN $2::date AND $3::date`];
    const params: any[] = [filters.customerId, filters.startDate, filters.endDate];
    if (filters.campaignId && tableSupportsCampaign(table)) {
        params.push(filters.campaignId);
        clauses.push(`${prefix}campaign_id = $${params.length}`);
    }
    if (filters.adGroupId && tableSupportsAdGroup(table)) {
        params.push(filters.adGroupId);
        clauses.push(`${prefix}ad_group_id = $${params.length}`);
    }
    return { clauses, params };
}

async function selectRows<T extends Record<string, any>>(pool: Pool, table: string, filters: DashboardFilters, order = 'date ASC'): Promise<T[]> {
    const { clauses, params } = scopeClauses(filters, '', table);
    const { rows } = await pool.query(`SELECT * FROM ${table} WHERE ${clauses.join(' AND ')} ORDER BY ${order}`, params);
    return rows.map(normalizeDbRow) as T[];
}

async function selectGroupedRows<T extends Record<string, any>>(
    pool: Pool,
    table: string,
    filters: DashboardFilters,
    selectSql: string,
    groupBySql: string,
    orderSql: string,
    limit = 0
): Promise<T[]> {
    const { clauses, params } = scopeClauses(filters, 'src', table);
    const queryParams = [...params];
    const limitSql = limit > 0 ? ` LIMIT $${queryParams.push(limit)}` : '';
    const { rows } = await pool.query(
        `SELECT ${selectSql}
         FROM ${table} src
         WHERE ${clauses.join(' AND ')}
         GROUP BY ${groupBySql}
         ORDER BY ${orderSql}${limitSql}`,
        queryParams
    );
    return rows.map(normalizeDbRow) as T[];
}

const metricSelectWithAllConversions = `
    SUM(src.cost_micros)::bigint AS cost_micros,
    SUM(src.clicks)::bigint AS clicks,
    SUM(src.impressions)::bigint AS impressions,
    SUM(src.conversions) AS conversions,
    SUM(COALESCE(src.all_conversions, 0)) AS all_conversions,
    CASE WHEN SUM(src.impressions) > 0 THEN SUM(src.clicks)::numeric / NULLIF(SUM(src.impressions), 0) ELSE NULL END AS ctr,
    CASE WHEN SUM(src.clicks) > 0 THEN ROUND(SUM(src.cost_micros)::numeric / NULLIF(SUM(src.clicks), 0), 0)::bigint ELSE NULL END AS average_cpc_micros,
    CASE WHEN SUM(src.conversions) > 0 THEN ROUND(SUM(src.cost_micros)::numeric / NULLIF(SUM(src.conversions), 0), 0)::bigint ELSE NULL END AS cost_per_conversion_micros
`;

const metricSelectWithoutAllConversions = `
    SUM(src.cost_micros)::bigint AS cost_micros,
    SUM(src.clicks)::bigint AS clicks,
    SUM(src.impressions)::bigint AS impressions,
    SUM(src.conversions) AS conversions,
    0::numeric AS all_conversions,
    CASE WHEN SUM(src.impressions) > 0 THEN SUM(src.clicks)::numeric / NULLIF(SUM(src.impressions), 0) ELSE NULL END AS ctr,
    CASE WHEN SUM(src.clicks) > 0 THEN ROUND(SUM(src.cost_micros)::numeric / NULLIF(SUM(src.clicks), 0), 0)::bigint ELSE NULL END AS average_cpc_micros,
    CASE WHEN SUM(src.conversions) > 0 THEN ROUND(SUM(src.cost_micros)::numeric / NULLIF(SUM(src.conversions), 0), 0)::bigint ELSE NULL END AS cost_per_conversion_micros
`;

function weightedMetricSql(column: string): string {
    return `CASE WHEN SUM(src.impressions) > 0 THEN SUM(COALESCE(src.${column}, 0) * src.impressions) / NULLIF(SUM(CASE WHEN src.${column} IS NULL THEN 0 ELSE src.impressions END), 0) ELSE NULL END AS ${column}`;
}

function clickWeightedMetricSql(column: string): string {
    return `CASE WHEN SUM(src.clicks) > 0 THEN SUM(COALESCE(src.${column}, 0) * src.clicks) / NULLIF(SUM(CASE WHEN src.${column} IS NULL THEN 0 ELSE src.clicks END), 0) ELSE NULL END AS ${column}`;
}

async function selectKeywordSummaryRows(pool: Pool, filters: DashboardFilters, limit = 0): Promise<KeywordDailyRow[]> {
    return selectGroupedRows<KeywordDailyRow>(
        pool,
        'google_ads_keyword_daily',
        filters,
        `
            src.customer_id,
            MAX(src.date)::text AS date,
            src.campaign_id,
            MAX(src.campaign_name) AS campaign_name,
            src.ad_group_id,
            MAX(src.ad_group_name) AS ad_group_name,
            src.criterion_id,
            MAX(src.criterion_resource_name) AS criterion_resource_name,
            MAX(src.keyword_text) AS keyword_text,
            MAX(src.match_type) AS match_type,
            MAX(src.criterion_status) AS criterion_status,
            MAX(src.cpc_bid_micros) AS cpc_bid_micros,
            MAX(src.bidding_strategy_type) AS bidding_strategy_type,
            ${metricSelectWithAllConversions},
            ${weightedMetricSql('search_impression_share')}
        `,
        'src.customer_id, src.campaign_id, src.ad_group_id, src.criterion_id',
        'SUM(src.cost_micros) DESC, SUM(src.clicks) DESC, MAX(src.keyword_text) ASC',
        limit
    );
}

async function selectSearchTermSummaryRows(pool: Pool, filters: DashboardFilters, limit = 0): Promise<SearchTermDailyRow[]> {
    return selectGroupedRows<SearchTermDailyRow>(
        pool,
        'google_ads_search_term_daily',
        filters,
        `
            src.customer_id,
            MAX(src.date)::text AS date,
            MIN(src.dimension_hash) AS dimension_hash,
            src.campaign_id,
            MAX(src.campaign_name) AS campaign_name,
            src.ad_group_id,
            MAX(src.ad_group_name) AS ad_group_name,
            MAX(src.search_term) AS search_term,
            MAX(src.search_term_status) AS search_term_status,
            MAX(src.matched_keyword_text) AS matched_keyword_text,
            MAX(src.matched_keyword_match_type) AS matched_keyword_match_type,
            MAX(src.search_term_match_type) AS search_term_match_type,
            MAX(src.search_term_match_source) AS search_term_match_source,
            ${metricSelectWithAllConversions}
        `,
        'src.customer_id, src.campaign_id, src.ad_group_id, lower(src.search_term)',
        'SUM(src.cost_micros) DESC, SUM(src.clicks) DESC, MAX(src.search_term) ASC',
        limit
    );
}

async function selectDeviceSummaryRows(pool: Pool, filters: DashboardFilters): Promise<DeviceDailyRow[]> {
    return selectGroupedRows<DeviceDailyRow>(
        pool,
        'google_ads_device_daily',
        filters,
        `
            src.customer_id,
            MAX(src.date)::text AS date,
            MAX(src.campaign_id) AS campaign_id,
            MAX(src.campaign_name) AS campaign_name,
            MAX(src.ad_group_id) AS ad_group_id,
            MAX(src.ad_group_name) AS ad_group_name,
            src.device,
            ${metricSelectWithoutAllConversions},
            SUM(COALESCE(src.conversions_value, 0)) AS conversions_value
        `,
        'src.customer_id, src.device',
        'SUM(src.cost_micros) DESC, src.device ASC'
    );
}

async function selectDayOfWeekSummaryRows(pool: Pool, filters: DashboardFilters): Promise<DayOfWeekDailyRow[]> {
    return selectGroupedRows<DayOfWeekDailyRow>(
        pool,
        'google_ads_day_of_week_daily',
        filters,
        `
            src.customer_id,
            MAX(src.date)::text AS date,
            MAX(src.campaign_id) AS campaign_id,
            MAX(src.campaign_name) AS campaign_name,
            MAX(src.ad_group_id) AS ad_group_id,
            MAX(src.ad_group_name) AS ad_group_name,
            src.day_of_week,
            ${metricSelectWithoutAllConversions},
            SUM(COALESCE(src.conversions_value, 0)) AS conversions_value
        `,
        'src.customer_id, src.day_of_week',
        'SUM(src.cost_micros) DESC, src.day_of_week ASC'
    );
}

async function selectDayHourSummaryRows(pool: Pool, filters: DashboardFilters): Promise<DayHourDailyRow[]> {
    return selectGroupedRows<DayHourDailyRow>(
        pool,
        'google_ads_day_hour_daily',
        filters,
        `
            src.customer_id,
            MAX(src.date)::text AS date,
            MAX(src.campaign_id) AS campaign_id,
            MAX(src.campaign_name) AS campaign_name,
            MAX(src.ad_group_id) AS ad_group_id,
            MAX(src.ad_group_name) AS ad_group_name,
            src.day_of_week,
            src.hour,
            ${metricSelectWithoutAllConversions}
        `,
        'src.customer_id, src.day_of_week, src.hour',
        'SUM(src.cost_micros) DESC, src.day_of_week ASC, src.hour ASC'
    );
}

async function selectLandingPageSummaryRows(
    pool: Pool,
    table: 'google_ads_landing_page_daily' | 'google_ads_expanded_landing_page_daily',
    filters: DashboardFilters,
    limit = 0
): Promise<LandingPageDailyRow[]> {
    const urlColumn = table === 'google_ads_expanded_landing_page_daily' ? 'expanded_final_url' : 'unexpanded_final_url';
    return selectGroupedRows<LandingPageDailyRow>(
        pool,
        table,
        filters,
        `
            src.customer_id,
            MAX(src.date)::text AS date,
            src.url_hash,
            MAX(src.${urlColumn}) AS ${urlColumn},
            MAX(src.campaign_id) AS campaign_id,
            MAX(src.campaign_name) AS campaign_name,
            MAX(src.ad_group_id) AS ad_group_id,
            MAX(src.ad_group_name) AS ad_group_name,
            ${metricSelectWithoutAllConversions},
            ${clickWeightedMetricSql('mobile_friendly_clicks_percentage')},
            ${clickWeightedMetricSql('valid_amp_clicks_percentage')},
            ${clickWeightedMetricSql('speed_score')}
        `,
        `src.customer_id, src.url_hash, src.${urlColumn}`,
        `SUM(src.cost_micros) DESC, MAX(src.${urlColumn}) ASC`,
        limit
    );
}

async function selectSnapshotRows<T extends Record<string, any>>(pool: Pool, table: string, filters: DashboardFilters, order: string): Promise<T[]> {
    const clauses = ['customer_id = $1', 'present_in_latest_snapshot = true'];
    const params: any[] = [filters.customerId];
    if (filters.campaignId && tableSupportsCampaign(table)) {
        params.push(filters.campaignId);
        clauses.push(`(campaign_id = $${params.length} OR campaign_id IS NULL)`);
    }
    if (filters.adGroupId && tableSupportsAdGroup(table)) {
        params.push(filters.adGroupId);
        clauses.push(`(ad_group_id = $${params.length} OR ad_group_id IS NULL)`);
    }
    const { rows } = await pool.query(`SELECT * FROM ${table} WHERE ${clauses.join(' AND ')} ORDER BY ${order}`, params);
    return rows.map(normalizeDbRow) as T[];
}

export async function getCoverageForWindow(pool: Pool, filters: DashboardFilters, reportNames: readonly string[] = FACT_REPORTS): Promise<CoverageEntry[]> {
    const dates = dateRange(filters.startDate, filters.endDate);
    const { rows } = await pool.query(
        `SELECT report_name, coverage_date, status, row_count, fetched_at, error
         FROM google_ads_report_coverage
         WHERE customer_id = $1
           AND coverage_date BETWEEN $2::date AND $3::date
           AND report_name = ANY($4::text[])
         ORDER BY report_name ASC, coverage_date ASC`,
        [filters.customerId, filters.startDate, filters.endDate, reportNames]
    );
    const byReport = new Map<string, any[]>();
    for (const row of rows) {
        const list = byReport.get(row.report_name) || [];
        list.push(row);
        byReport.set(row.report_name, list);
    }
    return reportNames.map(reportName => {
        const entries = byReport.get(reportName) || [];
        const byDate = new Map(entries.map(row => [isoDate(row.coverage_date), row]));
        const missingDates = dates.filter(date => !byDate.has(date));
        const failedDates = entries.filter(row => row.status === 'failed').map(row => isoDate(row.coverage_date)).filter(Boolean) as string[];
        const emptyDates = entries.filter(row => row.status === 'empty').map(row => isoDate(row.coverage_date)).filter(Boolean) as string[];
        const coveredDates = entries.filter(row => row.status === 'covered' || row.status === 'empty').length;
        let status: CoverageStatus = 'covered';
        if (missingDates.length === dates.length) status = 'missing';
        else if (failedDates.length === dates.length) status = 'failed';
        else if (missingDates.length || failedDates.length) status = 'partial';
        else if (emptyDates.length === dates.length) status = 'empty';
        return {
            reportName,
            status,
            coveredDates,
            missingDates,
            failedDates,
            emptyDates,
            rowCount: entries.reduce((sum, row) => sum + Number(row.row_count || 0), 0),
            lastFetchedAt: entries.reduce<string | null>((latest, row) => {
                const value = isoDateTime(row.fetched_at);
                return !latest || (value && value > latest) ? value : latest;
            }, null),
            error: entries.find(row => row.error)?.error || null
        };
    });
}

export async function getDashboardReportBundle(pool: Pool, filters: DashboardFilters): Promise<DashboardReportBundle> {
    validateDashboardFilters(filters);
    const [
        accountDaily,
        campaignDaily,
        adGroupDaily,
        keywordDaily,
        searchTermDaily,
        deviceDaily,
        dayOfWeekDaily,
        dayHourDaily,
        landingPageDaily,
        expandedLandingPageDaily,
        conversionActionDaily,
        conversionAdGroupDaily,
        conversionSearchTermDaily,
        clickEvidenceDaily,
        campaignSnapshot,
        adGroupSnapshot,
        configuredKeywords,
        qualityScores,
        campaignNegatives,
        adGroupNegatives,
        accountNegativeLists,
        sharedNegativeSets,
        sharedNegativeCriteria,
        campaignSharedSets,
        keywordPlannerIdeas,
        keywordPlannerHistorical,
        auctionInsightsRows,
        auctionInsightsStatus,
        candidateSignals,
        coverage
    ] = await Promise.all([
        selectRows<AccountDailyRow>(pool, 'google_ads_account_daily', { ...filters, campaignId: null, adGroupId: null }),
        selectRows<CampaignDailyRow>(pool, 'google_ads_campaign_daily', filters),
        selectRows<AdGroupDailyRow>(pool, 'google_ads_ad_group_daily', filters),
        selectRows<KeywordDailyRow>(pool, 'google_ads_keyword_daily', filters),
        selectRows<SearchTermDailyRow>(pool, 'google_ads_search_term_daily', filters),
        selectRows<DeviceDailyRow>(pool, 'google_ads_device_daily', filters),
        selectRows<DayOfWeekDailyRow>(pool, 'google_ads_day_of_week_daily', filters),
        selectRows<DayHourDailyRow>(pool, 'google_ads_day_hour_daily', filters),
        selectRows<LandingPageDailyRow>(pool, 'google_ads_landing_page_daily', filters),
        selectRows<LandingPageDailyRow>(pool, 'google_ads_expanded_landing_page_daily', filters),
        selectRows<ConversionActionDailyRow>(pool, 'google_ads_conversion_action_daily', { ...filters, campaignId: null, adGroupId: null }),
        selectRows<ConversionScopedDailyRow>(pool, 'google_ads_conversion_ad_group_daily', filters),
        selectRows<ConversionScopedDailyRow>(pool, 'google_ads_conversion_search_term_daily', filters),
        selectRows<ClickEvidenceDailyRow>(pool, 'google_ads_click_evidence_daily', filters),
        selectSnapshotRows<CampaignSnapshotRow>(pool, 'google_ads_campaign_snapshot', filters, 'campaign_name ASC NULLS LAST, campaign_id ASC'),
        selectSnapshotRows<AdGroupSnapshotRow>(pool, 'google_ads_ad_group_snapshot', filters, 'campaign_name ASC NULLS LAST, ad_group_name ASC NULLS LAST'),
        selectSnapshotRows<ConfiguredKeywordRow>(pool, 'google_ads_configured_keywords', filters, 'keyword_text ASC'),
        selectSnapshotRows<QualityScoreRow>(pool, 'google_ads_quality_score_snapshot', filters, 'keyword_text ASC NULLS LAST'),
        selectSnapshotRows<NegativeKeywordRow>(pool, 'google_ads_campaign_negatives', filters, 'keyword_text ASC'),
        selectSnapshotRows<NegativeKeywordRow>(pool, 'google_ads_ad_group_negatives', filters, 'keyword_text ASC'),
        selectSnapshotRows<AccountNegativeListRow>(pool, 'google_ads_account_negative_lists', { ...filters, campaignId: null, adGroupId: null }, 'shared_set_resource_name ASC'),
        selectSnapshotRows<SharedNegativeSetRow>(pool, 'google_ads_shared_negative_sets', { ...filters, campaignId: null, adGroupId: null }, 'shared_set_name ASC NULLS LAST'),
        selectSnapshotRows<SharedNegativeCriterionRow>(pool, 'google_ads_shared_negative_criteria', { ...filters, campaignId: null, adGroupId: null }, 'keyword_text ASC'),
        selectSnapshotRows<CampaignSharedSetRow>(pool, 'google_ads_campaign_shared_sets', { ...filters, adGroupId: null }, 'campaign_name ASC NULLS LAST'),
        selectCustomerRows<KeywordPlannerIdeaRow>(pool, 'google_ads_keyword_planner_ideas', filters.customerId, 'avg_monthly_searches DESC NULLS LAST, keyword ASC'),
        selectCustomerRows<KeywordPlannerHistoricalRow>(pool, 'google_ads_keyword_planner_historical', filters.customerId, 'avg_monthly_searches DESC NULLS LAST, keyword ASC'),
        selectAuctionRows(pool, filters),
        selectCustomerRows<AuctionInsightsStatusRow>(pool, 'google_ads_auction_insights_status', filters.customerId, 'entity_type ASC, entity_name ASC NULLS LAST'),
        selectCandidateSignals(pool, filters),
        getCoverageForWindow(pool, filters)
    ]);
    return {
        accountDaily,
        campaignDaily,
        adGroupDaily,
        keywordDaily,
        searchTermDaily,
        deviceDaily,
        dayOfWeekDaily,
        dayHourDaily,
        landingPageDaily,
        expandedLandingPageDaily,
        conversionActionDaily,
        conversionAdGroupDaily,
        conversionSearchTermDaily,
        clickEvidenceDaily,
        campaignSnapshot,
        adGroupSnapshot,
        configuredKeywords,
        qualityScores,
        negatives: {
            campaignNegatives,
            adGroupNegatives,
            accountNegativeLists,
            sharedNegativeSets,
            sharedNegativeCriteria,
            campaignSharedSets
        },
        keywordPlannerIdeas,
        keywordPlannerHistorical,
        auctionInsightsRows,
        auctionInsightsStatus,
        candidateSignals,
        coverage
    };
}

export async function getDashboardOverviewReportBundle(pool: Pool, filters: DashboardFilters, warehouseWatermark?: string): Promise<DashboardReportBundle> {
    filters = validateDashboardFilters(filters);
    const cacheKey = warehouseWatermark
        ? `${dashboardCacheKey(filters)}:watermark=${warehouseWatermark}`
        : dashboardCacheKey(filters);
    const cached = getRuntimeCacheEntry(dashboardBaseBundleCache, cacheKey, dashboardBaseBundleCacheTtlMs());
    if (cached) return cached;
    const cacheGeneration = adsWarehouseRuntimeCacheGeneration;
    const [
        accountDaily,
        campaignDaily,
        adGroupDaily,
        deviceDaily,
        dayOfWeekDaily,
        dayHourDaily,
        campaignSnapshot,
        adGroupSnapshot,
        coverage
    ] = await Promise.all([
        selectRows<AccountDailyRow>(pool, 'google_ads_account_daily', { ...filters, campaignId: null, adGroupId: null }),
        selectRows<CampaignDailyRow>(pool, 'google_ads_campaign_daily', filters),
        selectRows<AdGroupDailyRow>(pool, 'google_ads_ad_group_daily', filters),
        selectDeviceSummaryRows(pool, filters),
        selectDayOfWeekSummaryRows(pool, filters),
        selectDayHourSummaryRows(pool, filters),
        selectSnapshotRows<CampaignSnapshotRow>(pool, 'google_ads_campaign_snapshot', filters, 'campaign_name ASC NULLS LAST, campaign_id ASC'),
        selectSnapshotRows<AdGroupSnapshotRow>(pool, 'google_ads_ad_group_snapshot', filters, 'campaign_name ASC NULLS LAST, ad_group_name ASC NULLS LAST'),
        getCoverageForWindow(pool, filters)
    ]);
    const bundle = emptyDashboardReportBundle({
        accountDaily,
        campaignDaily,
        adGroupDaily,
        deviceDaily,
        dayOfWeekDaily,
        dayHourDaily,
        campaignSnapshot,
        adGroupSnapshot,
        coverage
    });
    if (cacheGeneration !== adsWarehouseRuntimeCacheGeneration) return bundle;
    setRuntimeCacheEntry(
        dashboardBaseBundleCache,
        cacheKey,
        bundle,
        dashboardBaseBundleCacheTtlMs(),
        dashboardBaseBundleCacheMaxEntries(),
        dashboardBaseBundleCacheMaxBytes()
    );
    return bundle;
}

export async function getDashboardReportBundleForView(
    pool: Pool,
    filters: DashboardFilters,
    view: DashboardReportBundleView,
    warehouseWatermark?: string
): Promise<DashboardReportBundle> {
    validateDashboardFilters(filters);
    if (view === 'overview' || view === 'performance') return getDashboardOverviewReportBundle(pool, filters, warehouseWatermark);
    const baseBundlePromise = getDashboardOverviewReportBundle(pool, filters, warehouseWatermark);

    if (view === 'proposals') {
        const [
            baseBundle,
            candidateSignals
        ] = await Promise.all([
            baseBundlePromise,
            selectCandidateSignals(pool, filters)
        ]);
        return emptyDashboardReportBundle({ ...baseBundle, candidateSignals });
    }

    if (view === 'attribution') {
        const [
            baseBundle,
            conversionActionDaily,
            conversionAdGroupDaily,
            conversionSearchTermDaily,
            clickEvidenceDaily
        ] = await Promise.all([
            baseBundlePromise,
            selectRows<ConversionActionDailyRow>(pool, 'google_ads_conversion_action_daily', { ...filters, campaignId: null, adGroupId: null }),
            selectRows<ConversionScopedDailyRow>(pool, 'google_ads_conversion_ad_group_daily', filters),
            selectRows<ConversionScopedDailyRow>(pool, 'google_ads_conversion_search_term_daily', filters),
            selectRows<ClickEvidenceDailyRow>(pool, 'google_ads_click_evidence_daily', filters)
        ]);
        return emptyDashboardReportBundle({
            ...baseBundle,
            conversionActionDaily,
            conversionAdGroupDaily,
            conversionSearchTermDaily,
            clickEvidenceDaily
        });
    }

    if (view === 'keywords') {
        const [
            baseBundle,
            keywordDaily,
            searchTermDaily,
            configuredKeywords,
            qualityScores,
            campaignNegatives,
            adGroupNegatives,
            accountNegativeLists,
            sharedNegativeSets,
            sharedNegativeCriteria,
            campaignSharedSets,
            keywordPlannerIdeas,
            keywordPlannerHistorical,
            candidateSignals
        ] = await Promise.all([
            baseBundlePromise,
            selectKeywordSummaryRows(pool, filters, dashboardKeywordRowLimit()),
            selectSearchTermSummaryRows(pool, filters, dashboardSearchTermRowLimit()),
            selectSnapshotRows<ConfiguredKeywordRow>(pool, 'google_ads_configured_keywords', filters, 'keyword_text ASC'),
            selectSnapshotRows<QualityScoreRow>(pool, 'google_ads_quality_score_snapshot', filters, 'keyword_text ASC NULLS LAST'),
            selectSnapshotRows<NegativeKeywordRow>(pool, 'google_ads_campaign_negatives', filters, 'keyword_text ASC'),
            selectSnapshotRows<NegativeKeywordRow>(pool, 'google_ads_ad_group_negatives', filters, 'keyword_text ASC'),
            selectSnapshotRows<AccountNegativeListRow>(pool, 'google_ads_account_negative_lists', { ...filters, campaignId: null, adGroupId: null }, 'shared_set_resource_name ASC'),
            selectSnapshotRows<SharedNegativeSetRow>(pool, 'google_ads_shared_negative_sets', { ...filters, campaignId: null, adGroupId: null }, 'shared_set_name ASC NULLS LAST'),
            selectSnapshotRows<SharedNegativeCriterionRow>(pool, 'google_ads_shared_negative_criteria', { ...filters, campaignId: null, adGroupId: null }, 'keyword_text ASC'),
            selectSnapshotRows<CampaignSharedSetRow>(pool, 'google_ads_campaign_shared_sets', { ...filters, adGroupId: null }, 'campaign_name ASC NULLS LAST'),
            selectCustomerRows<KeywordPlannerIdeaRow>(pool, 'google_ads_keyword_planner_ideas', filters.customerId, 'avg_monthly_searches DESC NULLS LAST, keyword ASC', dashboardPlannerRowLimit()),
            selectCustomerRows<KeywordPlannerHistoricalRow>(pool, 'google_ads_keyword_planner_historical', filters.customerId, 'avg_monthly_searches DESC NULLS LAST, keyword ASC', dashboardPlannerRowLimit()),
            selectCandidateSignals(pool, filters, dashboardCandidateSignalRowLimit())
        ]);
        return emptyDashboardReportBundle({
            ...baseBundle,
            keywordDaily,
            searchTermDaily,
            configuredKeywords,
            qualityScores,
            negatives: {
                campaignNegatives,
                adGroupNegatives,
                accountNegativeLists,
                sharedNegativeSets,
                sharedNegativeCriteria,
                campaignSharedSets
            },
            keywordPlannerIdeas,
            keywordPlannerHistorical,
            candidateSignals
        });
    }

    const [
        baseBundle,
        keywordDaily,
        searchTermDaily,
        landingPageDaily,
        expandedLandingPageDaily,
        qualityScores,
        campaignNegatives,
        adGroupNegatives,
        accountNegativeLists,
        sharedNegativeSets,
        sharedNegativeCriteria,
        campaignSharedSets,
        auctionInsightsRows,
        auctionInsightsStatus,
        candidateSignals
    ] = await Promise.all([
        baseBundlePromise,
        selectKeywordSummaryRows(pool, filters, dashboardRankKeywordRowLimit()),
        selectSearchTermSummaryRows(pool, filters, dashboardRankSearchTermRowLimit()),
        selectLandingPageSummaryRows(pool, 'google_ads_landing_page_daily', filters, dashboardLandingPageRowLimit()),
        selectLandingPageSummaryRows(pool, 'google_ads_expanded_landing_page_daily', filters, dashboardLandingPageRowLimit()),
        selectSnapshotRows<QualityScoreRow>(pool, 'google_ads_quality_score_snapshot', filters, 'keyword_text ASC NULLS LAST'),
        selectSnapshotRows<NegativeKeywordRow>(pool, 'google_ads_campaign_negatives', filters, 'keyword_text ASC'),
        selectSnapshotRows<NegativeKeywordRow>(pool, 'google_ads_ad_group_negatives', filters, 'keyword_text ASC'),
        selectSnapshotRows<AccountNegativeListRow>(pool, 'google_ads_account_negative_lists', { ...filters, campaignId: null, adGroupId: null }, 'shared_set_resource_name ASC'),
        selectSnapshotRows<SharedNegativeSetRow>(pool, 'google_ads_shared_negative_sets', { ...filters, campaignId: null, adGroupId: null }, 'shared_set_name ASC NULLS LAST'),
        selectSnapshotRows<SharedNegativeCriterionRow>(pool, 'google_ads_shared_negative_criteria', { ...filters, campaignId: null, adGroupId: null }, 'keyword_text ASC'),
        selectSnapshotRows<CampaignSharedSetRow>(pool, 'google_ads_campaign_shared_sets', { ...filters, adGroupId: null }, 'campaign_name ASC NULLS LAST'),
        selectAuctionRows(pool, filters, dashboardAuctionInsightsRowLimit()),
        selectCustomerRows<AuctionInsightsStatusRow>(pool, 'google_ads_auction_insights_status', filters.customerId, 'entity_type ASC, entity_name ASC NULLS LAST'),
        selectCandidateSignals(pool, filters, dashboardCandidateSignalRowLimit())
    ]);
    return emptyDashboardReportBundle({
        ...baseBundle,
        keywordDaily,
        searchTermDaily,
        landingPageDaily,
        expandedLandingPageDaily,
        qualityScores,
        negatives: {
            campaignNegatives,
            adGroupNegatives,
            accountNegativeLists,
            sharedNegativeSets,
            sharedNegativeCriteria,
            campaignSharedSets
        },
        auctionInsightsRows,
        auctionInsightsStatus,
        candidateSignals
    });
}

async function selectCustomerRows<T extends Record<string, any>>(pool: Pool, table: string, customerId: string, order: string, limit = 0): Promise<T[]> {
    const params: any[] = [customerId];
    const limitSql = limit > 0 ? ` LIMIT $${params.push(limit)}` : '';
    const { rows } = await pool.query(`SELECT * FROM ${table} WHERE customer_id = $1 ORDER BY ${order}${limitSql}`, params);
    return rows.map(normalizeDbRow) as T[];
}

async function selectAuctionRows(pool: Pool, filters: DashboardFilters, limit = 0): Promise<AuctionInsightsRow[]> {
    const clauses = ['customer_id = $1'];
    const params: any[] = [filters.customerId];
    if (filters.campaignId) {
        params.push(filters.campaignId);
        clauses.push(`(campaign_id = $${params.length} OR campaign_id IS NULL)`);
    }
    if (filters.adGroupId) {
        params.push(filters.adGroupId);
        clauses.push(`(ad_group_id = $${params.length} OR ad_group_id IS NULL)`);
    }
    const limitSql = limit > 0 ? ` LIMIT $${params.push(limit)}` : '';
    const { rows } = await pool.query(
        `SELECT * FROM google_ads_auction_insights_rows WHERE ${clauses.join(' AND ')} ORDER BY domain ASC${limitSql}`,
        params
    );
    return rows.map(normalizeDbRow) as AuctionInsightsRow[];
}

export async function selectCandidateSignals(pool: Pool, filters: DashboardFilters, limit = 0): Promise<CandidateSignalRow[]> {
    const clauses = ['customer_id = $1', 'evidence_start_date <= $3::date', 'evidence_end_date >= $2::date'];
    const params: any[] = [filters.customerId, filters.startDate, filters.endDate];
    if (filters.campaignId) {
        params.push(filters.campaignId);
        clauses.push(`(campaign_id = $${params.length} OR campaign_id IS NULL)`);
    }
    if (filters.adGroupId) {
        params.push(filters.adGroupId);
        clauses.push(`(ad_group_id = $${params.length} OR ad_group_id IS NULL)`);
    }
    const limitSql = limit > 0 ? ` LIMIT $${params.push(limit)}` : '';
    const { rows } = await pool.query(
        `SELECT * FROM candidate_signals
         WHERE ${clauses.join(' AND ')}
         ORDER BY
            CASE severity
                WHEN 'critical' THEN 1
                WHEN 'high' THEN 2
                WHEN 'medium' THEN 3
                WHEN 'low' THEN 4
                WHEN 'watchlist' THEN 5
                ELSE 6
            END ASC,
            generated_at DESC${limitSql}`,
        params
    );
    return rows.map(normalizeDbRow) as CandidateSignalRow[];
}

export function validateDashboardFilters(filters: DashboardFilters): DashboardFilters {
    const customerId = cleanText(filters.customerId);
    if (!customerId) throw new Error('customerId is required.');
    assertDate(filters.startDate, 'startDate');
    assertDate(filters.endDate, 'endDate');
    if (filters.startDate > filters.endDate) throw new Error('startDate must be before or equal to endDate.');
    return {
        customerId,
        startDate: filters.startDate,
        endDate: filters.endDate,
        campaignId: normalizeNullableId(filters.campaignId),
        adGroupId: normalizeNullableId(filters.adGroupId)
    };
}

export async function getAvailableDashboardFilters(pool: Pool, customerId: string): Promise<DashboardFilterOptions> {
    const cacheKey = `customer=${customerId}`;
    const cached = getRuntimeCacheEntry(dashboardFilterOptionsCache, cacheKey, dashboardFilterOptionsCacheTtlMs());
    if (cached) return cached;
    const cacheGeneration = adsWarehouseRuntimeCacheGeneration;
    const [dateResult, campaignResult, adGroupResult] = await Promise.all([
        pool.query(
            `SELECT MIN(date)::text AS min_date, MAX(date)::text AS max_date
             FROM google_ads_campaign_daily
             WHERE customer_id = $1`,
            [customerId]
        ),
        pool.query(
            `WITH snapshot_campaigns AS (
                SELECT campaign_id, campaign_name, campaign_status
                FROM google_ads_campaign_snapshot
                WHERE customer_id = $1 AND present_in_latest_snapshot = true
             ),
             fact_campaigns AS (
                SELECT DISTINCT ON (campaign_id)
                       campaign_id, campaign_name, campaign_status
                FROM google_ads_campaign_daily
                WHERE customer_id = $1
                ORDER BY campaign_id, date DESC
             )
             SELECT
                COALESCE(snapshot_campaigns.campaign_id, fact_campaigns.campaign_id) AS campaign_id,
                COALESCE(snapshot_campaigns.campaign_name, fact_campaigns.campaign_name, snapshot_campaigns.campaign_id, fact_campaigns.campaign_id) AS campaign_name,
                COALESCE(snapshot_campaigns.campaign_status, fact_campaigns.campaign_status) AS campaign_status
             FROM snapshot_campaigns
             FULL OUTER JOIN fact_campaigns USING (campaign_id)
             ORDER BY 2 ASC NULLS LAST, 1 ASC`,
            [customerId]
        ),
        pool.query(
            `WITH snapshot_ad_groups AS (
                SELECT campaign_id, campaign_name, ad_group_id, ad_group_name, ad_group_status
                FROM google_ads_ad_group_snapshot
                WHERE customer_id = $1 AND present_in_latest_snapshot = true
             ),
             fact_ad_groups AS (
                SELECT DISTINCT ON (campaign_id, ad_group_id)
                       campaign_id, campaign_name, ad_group_id, ad_group_name, ad_group_status
                FROM google_ads_ad_group_daily
                WHERE customer_id = $1
                ORDER BY campaign_id, ad_group_id, date DESC
             )
             SELECT
                COALESCE(snapshot_ad_groups.campaign_id, fact_ad_groups.campaign_id) AS campaign_id,
                COALESCE(snapshot_ad_groups.campaign_name, fact_ad_groups.campaign_name) AS campaign_name,
                COALESCE(snapshot_ad_groups.ad_group_id, fact_ad_groups.ad_group_id) AS ad_group_id,
                COALESCE(snapshot_ad_groups.ad_group_name, fact_ad_groups.ad_group_name, snapshot_ad_groups.ad_group_id, fact_ad_groups.ad_group_id) AS ad_group_name,
                COALESCE(snapshot_ad_groups.ad_group_status, fact_ad_groups.ad_group_status) AS ad_group_status
             FROM snapshot_ad_groups
             FULL OUTER JOIN fact_ad_groups USING (campaign_id, ad_group_id)
             ORDER BY 2 ASC NULLS LAST, 4 ASC NULLS LAST`,
            [customerId]
        )
    ]);
    const filterOptions = {
        minDate: dateResult.rows[0]?.min_date || null,
        maxDate: dateResult.rows[0]?.max_date || null,
        campaigns: campaignResult.rows.map(row => ({
            id: String(row.campaign_id),
            name: row.campaign_name || String(row.campaign_id),
            status: row.campaign_status || null
        })),
        adGroups: adGroupResult.rows.map(row => ({
            id: String(row.ad_group_id),
            name: row.ad_group_name || String(row.ad_group_id),
            status: row.ad_group_status || null,
            campaignId: String(row.campaign_id),
            campaignName: row.campaign_name || null
        }))
    };
    if (cacheGeneration === adsWarehouseRuntimeCacheGeneration) {
        setRuntimeCacheEntry(
            dashboardFilterOptionsCache,
            cacheKey,
            filterOptions,
            dashboardFilterOptionsCacheTtlMs(),
            dashboardFilterOptionsCacheMaxEntries(),
            dashboardFilterOptionsCacheMaxBytes()
        );
    }
    return filterOptions;
}

export function dashboardCacheKey(rawFilters: DashboardFilters): string {
    const filters = validateDashboardFilters(rawFilters);
    return [
        'dashboard',
        'v1',
        `customer=${filters.customerId}`,
        `start=${filters.startDate}`,
        `end=${filters.endDate}`,
        `campaign=${filters.campaignId || 'ALL'}`,
        `adGroup=${filters.adGroupId || 'ALL'}`
    ].join(':');
}

function fingerprintRowMatchesStrictScope(row: any, source: WarehouseFingerprintSource, filters: DashboardFilters): boolean {
    if (filters.adGroupId && tableSupportsAdGroup(source.table)) {
        if (row.scope_level !== 'ad_group') return false;
        if (String(row.ad_group_id) !== filters.adGroupId) return false;
        return !filters.campaignId || String(row.campaign_id) === filters.campaignId;
    }
    if (filters.campaignId && tableSupportsCampaign(source.table)) {
        return row.scope_level === 'campaign' && String(row.campaign_id) === filters.campaignId;
    }
    return row.scope_level === 'account';
}

function fingerprintRowMatchesParentAwareScope(row: any, source: WarehouseFingerprintSource, filters: DashboardFilters): boolean {
    if (filters.adGroupId && tableSupportsAdGroup(source.table)) {
        if (row.scope_level === 'account_parent') return true;
        if (row.scope_level === 'campaign_parent') {
            return !filters.campaignId || String(row.campaign_id) === filters.campaignId;
        }
        if (row.scope_level !== 'ad_group') return false;
        if (String(row.ad_group_id) !== filters.adGroupId) return false;
        return !filters.campaignId || String(row.campaign_id) === filters.campaignId;
    }
    if (filters.campaignId && tableSupportsCampaign(source.table)) {
        return row.scope_level === 'account_parent'
            || (row.scope_level === 'campaign' && String(row.campaign_id) === filters.campaignId);
    }
    return row.scope_level === 'account';
}

function fingerprintRowMatchesFilters(row: any, filters: DashboardFilters): boolean {
    const source = WAREHOUSE_FINGERPRINT_SOURCE_BY_TABLE.get(String(row.source_table || ''));
    if (!source) return false;
    const sliceDate = String(row.slice_date || '');
    if (sliceDate !== FINGERPRINT_GLOBAL_SLICE && (sliceDate < filters.startDate || sliceDate > filters.endDate)) return false;
    return source.parentAware
        ? fingerprintRowMatchesParentAwareScope(row, source, filters)
        : fingerprintRowMatchesStrictScope(row, source, filters);
}

async function computeWarehouseWatermark(pool: Pool, filters: DashboardFilters): Promise<string> {
    const { rows } = await pool.query(
        `SELECT source_table, scope_level, slice_date, campaign_id, ad_group_id, row_count, fingerprint
         FROM google_ads_warehouse_slice_fingerprints
         WHERE customer_id = $1
           AND (slice_date = $2 OR (slice_date >= $3 AND slice_date <= $4))
         ORDER BY source_table ASC, scope_level ASC, slice_date ASC, campaign_id ASC, ad_group_id ASC`,
        [filters.customerId, FINGERPRINT_GLOBAL_SLICE, filters.startDate, filters.endDate]
    );
    const matchingRows = rows
        .map(normalizeDbRow)
        .filter(row => fingerprintRowMatchesFilters(row, filters))
        .map(row => ({
            sourceTable: row.source_table,
            scopeLevel: row.scope_level,
            sliceDate: row.slice_date,
            campaignId: row.campaign_id,
            adGroupId: row.ad_group_id,
            rowCount: Number(row.row_count || 0),
            fingerprint: row.fingerprint || ''
        }));
    return crypto.createHash('sha256')
        .update(stableJson({
            sources: WAREHOUSE_FINGERPRINT_SOURCES.map(source => source.table).sort(),
            rows: matchingRows
        }))
        .digest('hex');
}

const DEFAULT_DASHBOARD_DB_CACHE_MAX_BYTES = 2_000_000;

function positiveIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function dashboardDbCacheMaxBytes(): number {
    return positiveIntegerEnv('DASHBOARD_DB_CACHE_MAX_BYTES', DEFAULT_DASHBOARD_DB_CACHE_MAX_BYTES);
}

function jsonByteSize(value: any): number {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function snapshotWatermarkScope(table: string, filters: DashboardFilters): { clauses: string[]; params: any[] } {
    const clauses = ['customer_id = $1', 'present_in_latest_snapshot = true'];
    const params: any[] = [filters.customerId];
    if (filters.campaignId && tableSupportsCampaign(table)) {
        params.push(filters.campaignId);
        clauses.push(`campaign_id = $${params.length}`);
    }
    if (filters.adGroupId && tableSupportsAdGroup(table)) {
        params.push(filters.adGroupId);
        clauses.push(`ad_group_id = $${params.length}`);
    }
    return { clauses, params };
}

function optionalScopedWatermarkScope(table: string, filters: DashboardFilters): { clauses: string[]; params: any[] } {
    const clauses = ['customer_id = $1'];
    const params: any[] = [filters.customerId];
    if (filters.campaignId && tableSupportsCampaign(table)) {
        params.push(filters.campaignId);
        clauses.push(`(campaign_id = $${params.length} OR campaign_id IS NULL)`);
    }
    if (filters.adGroupId && tableSupportsAdGroup(table)) {
        params.push(filters.adGroupId);
        clauses.push(`(ad_group_id = $${params.length} OR ad_group_id IS NULL)`);
    }
    return { clauses, params };
}

function candidateSignalWatermarkScope(filters: DashboardFilters): { clauses: string[]; params: any[] } {
    const clauses = ['customer_id = $1', 'evidence_start_date <= $3::date', 'evidence_end_date >= $2::date'];
    const params: any[] = [filters.customerId, filters.startDate, filters.endDate];
    if (filters.campaignId) {
        params.push(filters.campaignId);
        clauses.push(`(campaign_id = $${params.length} OR campaign_id IS NULL)`);
    }
    if (filters.adGroupId) {
        params.push(filters.adGroupId);
        clauses.push(`(ad_group_id = $${params.length} OR ad_group_id IS NULL)`);
    }
    return { clauses, params };
}

export async function getWarehouseWatermark(pool: Pool, rawFilters: DashboardFilters): Promise<string> {
    const filters = validateDashboardFilters(rawFilters);
    const key = dashboardCacheKey(filters);
    const ttlMs = dashboardWatermarkCacheTtlMs();
    const cached = getRuntimeCacheEntry(warehouseWatermarkCache, key, ttlMs);
    if (cached) return cached;

    const existing = warehouseWatermarkInflight.get(key);
    if (existing) return existing;

    const promise = computeWarehouseWatermark(pool, filters);
    const cacheGeneration = adsWarehouseRuntimeCacheGeneration;
    warehouseWatermarkInflight.set(key, promise);
    try {
        const watermark = await promise;
        if (cacheGeneration === adsWarehouseRuntimeCacheGeneration && warehouseWatermarkInflight.get(key) === promise) {
            setRuntimeCacheEntry(
                warehouseWatermarkCache,
                key,
                watermark,
                ttlMs,
                dashboardWatermarkCacheMaxEntries(),
                dashboardWatermarkCacheMaxBytes()
            );
        }
        return watermark;
    } finally {
        if (warehouseWatermarkInflight.get(key) === promise) warehouseWatermarkInflight.delete(key);
    }
}

export async function getCachedDashboardPayload(pool: Pool, rawFilters: DashboardFilters, watermark: string): Promise<any | null> {
    const filters = validateDashboardFilters(rawFilters);
    const key = dashboardCacheKey(filters);
    const maxBytes = dashboardDbCacheMaxBytes();
    const { rows } = await pool.query(
        `SELECT
            CASE
                WHEN $3::integer = 0 THEN payload
                WHEN payload_bytes > 0 AND payload_bytes <= $3::integer THEN payload
                WHEN payload_bytes = 0 AND octet_length(payload::text) <= $3::integer THEN payload
                ELSE NULL
            END AS payload,
            CASE
                WHEN payload_bytes > 0 THEN payload_bytes
                ELSE octet_length(payload::text)
            END::integer AS payload_bytes
         FROM dashboard_payload_cache
         WHERE cache_key = $1 AND warehouse_watermark = $2`,
        [key, watermark, maxBytes]
    );
    const row = rows[0];
    if (!row) return null;
    if (row.payload) return row.payload;
    await pool.query(`DELETE FROM dashboard_payload_cache WHERE cache_key = $1`, [key]);
    console.warn(`Skipped oversized dashboard DB cache entry ${key}: ${row.payload_bytes} bytes exceeds DASHBOARD_DB_CACHE_MAX_BYTES=${maxBytes}.`);
    return null;
}

export async function setCachedDashboardPayload(pool: Pool, rawFilters: DashboardFilters, watermark: string, payload: any): Promise<void> {
    const filters = validateDashboardFilters(rawFilters);
    const key = dashboardCacheKey(filters);
    const payloadBytes = jsonByteSize(payload);
    const maxBytes = dashboardDbCacheMaxBytes();
    if (maxBytes > 0 && payloadBytes > maxBytes) {
        await pool.query(`DELETE FROM dashboard_payload_cache WHERE cache_key = $1`, [key]);
        console.warn(`Dashboard DB cache skipped for ${key}: ${payloadBytes} bytes exceeds DASHBOARD_DB_CACHE_MAX_BYTES=${maxBytes}.`);
        return;
    }
    await pool.query(
        `INSERT INTO dashboard_payload_cache
         (cache_key, customer_id, start_date, end_date, campaign_id, ad_group_id, warehouse_watermark, payload, payload_bytes, generated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         ON CONFLICT (cache_key) DO UPDATE SET
            warehouse_watermark = EXCLUDED.warehouse_watermark,
            payload = EXCLUDED.payload,
            payload_bytes = EXCLUDED.payload_bytes,
            generated_at = now()`,
        [
            key,
            filters.customerId,
            filters.startDate,
            filters.endDate,
            filters.campaignId || null,
            filters.adGroupId || null,
            watermark,
            payload,
            payloadBytes
        ]
    );
}

export async function hasWarehouseData(pool: Pool, customerId?: string | null): Promise<boolean> {
    const params: any[] = [];
    const clause = customerId ? 'WHERE customer_id = $1' : '';
    if (customerId) params.push(customerId);
    const { rows } = await pool.query(`SELECT 1 FROM google_ads_campaign_daily ${clause} LIMIT 1`, params);
    return rows.length > 0;
}

export async function getImpactMetricWindow(pool: Db, input: {
    customerId: string;
    startDate: string;
    endDate: string;
    scope: 'campaign' | 'keyword' | 'search_term';
    campaignId?: string | null;
    adGroupId?: string | null;
    criterionId?: string | null;
    keywordText?: string | null;
    matchType?: string | null;
    searchTerm?: string | null;
    mode?: 'target' | 'control';
}): Promise<ImpactMetrics> {
    assertDate(input.startDate, 'startDate');
    assertDate(input.endDate, 'endDate');
    const params: any[] = [input.customerId, input.startDate, input.endDate];
    const clauses = ['customer_id = $1', 'date >= $2::date', 'date < $3::date'];
    let table = 'google_ads_campaign_daily';
    if (input.scope === 'keyword') table = 'google_ads_keyword_daily';
    if (input.scope === 'search_term') table = 'google_ads_search_term_daily';
    const conversionValueSelect = table === 'google_ads_campaign_daily'
        ? 'COALESCE(SUM(conversions_value), 0)::float8 AS conversions_value'
        : '0::float8 AS conversions_value';
    if (input.campaignId) {
        params.push(input.campaignId);
        const operator = input.mode === 'control' && input.scope === 'campaign' ? '<>' : '=';
        clauses.push(`campaign_id ${operator} $${params.length}`);
    }
    if (input.adGroupId && input.scope !== 'campaign') {
        params.push(input.adGroupId);
        clauses.push(`ad_group_id = $${params.length}`);
    }
    if (input.scope === 'keyword') {
        if (input.criterionId) {
            params.push(input.criterionId);
            clauses.push(input.mode === 'control' ? `criterion_id <> $${params.length}` : `criterion_id = $${params.length}`);
        } else if (input.keywordText) {
            params.push(input.keywordText.trim().toLowerCase());
            const keywordParam = params.length;
            if (input.matchType) {
                params.push(input.matchType.trim().toUpperCase());
                const matchParam = params.length;
                clauses.push(input.mode === 'control'
                    ? `NOT (lower(keyword_text) = $${keywordParam} AND upper(match_type) = $${matchParam})`
                    : `(lower(keyword_text) = $${keywordParam} AND upper(match_type) = $${matchParam})`);
            } else {
                clauses.push(input.mode === 'control' ? `lower(keyword_text) <> $${keywordParam}` : `lower(keyword_text) = $${keywordParam}`);
            }
        }
    }
    if (input.searchTerm && input.scope === 'search_term') {
        params.push(input.searchTerm.trim().toLowerCase());
        clauses.push(input.mode === 'control' ? `lower(search_term) <> $${params.length}` : `lower(search_term) = $${params.length}`);
    }
    const { rows } = await pool.query(
        `SELECT
            COALESCE(SUM(cost_micros), 0)::float8 AS cost_micros,
            COALESCE(SUM(clicks), 0)::float8 AS clicks,
            COALESCE(SUM(impressions), 0)::float8 AS impressions,
            COALESCE(SUM(conversions), 0)::float8 AS conversions,
            ${conversionValueSelect}
         FROM ${table}
         WHERE ${clauses.join(' AND ')}`,
        params
    );
    const row = rows[0] || {};
    const spend = Number(row.cost_micros || 0) / 1_000_000;
    const conversions = Number(row.conversions || 0);
    const conversionValue = Number(row.conversions_value || 0);
    return {
        spend,
        clicks: Number(row.clicks || 0),
        impressions: Number(row.impressions || 0),
        conversions,
        conversionValue,
        cpa: conversions > 0 ? spend / conversions : 0,
        roas: spend > 0 ? conversionValue / spend : 0
    };
}
