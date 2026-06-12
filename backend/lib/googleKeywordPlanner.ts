import { writeJsonAtomic } from './auctionInsights';

export const DEFAULT_KEYWORD_PLANNER_LANGUAGE = 'languageConstants/1000';
export const DEFAULT_KEYWORD_PLANNER_GEO_TARGETS = ['geoTargetConstants/2356'];
export const DEFAULT_KEYWORD_PLANNER_NETWORK = 'GOOGLE_SEARCH';
export const DEFAULT_KEYWORD_PLANNER_URL = 'https://zenseeo.com';

const API_VERSION = 'v24';
const MAX_IDEA_SEED_KEYWORDS = 20;
const MAX_IDEA_PAGE_SIZE = 1000;
const HISTORICAL_METRICS_CHUNK_SIZE = 500;
const DEFAULT_GOOGLE_ADS_FETCH_TIMEOUT_MS = 25_000;

export interface KeywordPlannerMetric {
    keyword: string;
    avgMonthlySearches: number | null;
    competition: string | null;
    competitionIndex: number | null;
    lowBidMicros: number | null;
    highBidMicros: number | null;
    lowBid: number | null;
    highBid: number | null;
    monthlySearchVolumes: Array<{ month: string; year: string | number; monthlySearches: number | null }>;
}

export interface KeywordPlannerIdea extends KeywordPlannerMetric {
    source: 'idea';
    seedType: 'keyword' | 'keyword_and_url' | 'url' | 'site';
    seedKeywords: string[];
    seedUrl: string | null;
    seedSite: string | null;
    geoTargetConstants: string[];
    language: string;
    keywordPlanNetwork: string;
    fetchedAt: string;
}

export interface KeywordPlannerHistoricalMetric extends KeywordPlannerMetric {
    source: 'historical';
    closeVariants: string[];
    geoTargetConstants: string[];
    language: string;
    keywordPlanNetwork: string;
    fetchedAt: string;
}

export interface KeywordPlannerOptions {
    keywords?: string[];
    url?: string | null;
    site?: string | null;
    language?: string | null;
    geoTargetConstants?: string[];
    keywordPlanNetwork?: string | null;
    includeAdultKeywords?: boolean;
    pageSize?: number;
}

export interface KeywordPlannerRefreshResult {
    ideas: KeywordPlannerIdea[];
    historicalMetrics: KeywordPlannerHistoricalMetric[];
    status: 'ok' | 'empty' | 'failed';
    message: string;
    seeds: {
        keywords: string[];
        url: string | null;
        site: string | null;
        language: string;
        geoTargetConstants: string[];
        keywordPlanNetwork: string;
    };
}

function refreshStatusPayload(result: KeywordPlannerRefreshResult): Record<string, any> {
    return {
        status: result.status,
        message: result.message,
        ideas: result.ideas.length,
        historicalMetrics: result.historicalMetrics.length,
        seeds: result.seeds,
        fetchedAt: new Date().toISOString()
    };
}

export class KeywordPlannerValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'KeywordPlannerValidationError';
    }
}

function cleanText(value: any): string {
    return String(value ?? '').trim();
}

function normalizeKeyword(value: any): string {
    return cleanText(value).replace(/\s+/g, ' ').toLowerCase();
}

export function uniqueKeywords(values: any[], limit?: number): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        const text = cleanText(value).replace(/\s+/g, ' ');
        const key = normalizeKeyword(text);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(text);
        if (limit && out.length >= limit) break;
    }
    return out;
}

function normalizeResourceList(values: any[] | undefined, fallback: string[], prefix: string): string[] {
    const raw = Array.isArray(values) ? values : [];
    const normalized = raw
        .map(value => cleanText(value))
        .filter(Boolean)
        .map(value => value.includes('/') ? value : `${prefix}/${value}`);
    return normalized.length ? Array.from(new Set(normalized)) : fallback;
}

function normalizeLanguage(value?: string | null): string {
    const text = cleanText(value);
    if (!text) return DEFAULT_KEYWORD_PLANNER_LANGUAGE;
    return text.includes('/') ? text : `languageConstants/${text}`;
}

function normalizeNetwork(value?: string | null): string {
    const text = cleanText(value || process.env.KEYWORD_PLANNER_NETWORK || DEFAULT_KEYWORD_PLANNER_NETWORK).toUpperCase();
    if (text === 'GOOGLE_SEARCH_AND_PARTNERS') return text;
    return DEFAULT_KEYWORD_PLANNER_NETWORK;
}

function normalizeUrl(value?: string | null): string | null {
    const text = cleanText(value);
    if (!text) return null;
    if (/^https?:\/\//i.test(text)) return text;
    return `https://${text}`;
}

function defaultKeywordPlannerUrl(): string {
    return cleanText(process.env.KEYWORD_PLANNER_URL) || DEFAULT_KEYWORD_PLANNER_URL;
}

function normalizeSite(value?: string | null): string | null {
    const text = cleanText(value);
    if (!text) return null;
    const withProtocol = /^https?:\/\//i.test(text) ? text : `https://${text}`;
    try {
        const parsed = new URL(withProtocol);
        return parsed.hostname || null;
    } catch {
        return text.replace(/^https?:\/\//i, '').split('/')[0].trim() || null;
    }
}

function numberOrNull(value: any): number | null {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function microsToCurrency(value: any): number | null {
    const micros = numberOrNull(value);
    return micros === null ? null : +(micros / 1_000_000).toFixed(2);
}

function normalizeMetric(keyword: string, rawMetric: any): KeywordPlannerMetric {
    const metric = rawMetric || {};
    return {
        keyword,
        avgMonthlySearches: numberOrNull(metric.avgMonthlySearches),
        competition: metric.competition ? String(metric.competition) : null,
        competitionIndex: numberOrNull(metric.competitionIndex),
        lowBidMicros: numberOrNull(metric.lowTopOfPageBidMicros),
        highBidMicros: numberOrNull(metric.highTopOfPageBidMicros),
        lowBid: microsToCurrency(metric.lowTopOfPageBidMicros),
        highBid: microsToCurrency(metric.highTopOfPageBidMicros),
        monthlySearchVolumes: Array.isArray(metric.monthlySearchVolumes)
            ? metric.monthlySearchVolumes.map((row: any) => ({
                month: String(row.month || ''),
                year: row.year ?? '',
                monthlySearches: numberOrNull(row.monthlySearches)
            }))
            : []
    };
}

function googleAdsHeaders(token: string): Record<string, string> {
    const devToken = process.env.GOOGLE_DEVELOPER_TOKEN || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '';
    const loginCustomerId = process.env.GOOGLE_LOGIN_CUSTOMER_ID || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
    const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'developer-token': devToken,
        'Content-Type': 'application/json'
    };
    if (loginCustomerId) headers['login-customer-id'] = loginCustomerId;
    return headers;
}

function googleAdsFetchTimeoutMs(): number {
    const configured = Number(process.env.GOOGLE_ADS_FETCH_TIMEOUT_MS || DEFAULT_GOOGLE_ADS_FETCH_TIMEOUT_MS);
    return Number.isFinite(configured) && configured >= 1_000 ? configured : DEFAULT_GOOGLE_ADS_FETCH_TIMEOUT_MS;
}

async function fetchGoogleAds(url: string, init: RequestInit = {}): Promise<Response> {
    const timeoutMs = googleAdsFetchTimeoutMs();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch (err: any) {
        if (err?.name === 'AbortError') {
            throw new Error(`Google Ads API request timed out after ${timeoutMs}ms. Use fewer seed keywords, narrow the request, or retry later.`);
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

async function postKeywordPlanner<T>(token: string, customerId: string, method: 'generateKeywordIdeas' | 'generateKeywordHistoricalMetrics', body: Record<string, any>): Promise<T> {
    const res = await fetchGoogleAds(`https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}:${method}`, {
        method: 'POST',
        headers: googleAdsHeaders(token),
        body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => null) as any;
    if (!res.ok || data?.error) {
        throw new Error(`Keyword Planner ${method} failed: ${JSON.stringify(data?.error || data || { status: res.status })}`);
    }
    return data as T;
}

function normalizedOptions(input: KeywordPlannerOptions = {}) {
    const keywords = uniqueKeywords(input.keywords || []);
    const site = normalizeSite(input.site);
    const rawUrl = input.url !== undefined
        ? input.url
        : site
            ? ''
            : keywords.length
                ? ''
                : defaultKeywordPlannerUrl();
    return {
        keywords,
        url: normalizeUrl(rawUrl),
        site,
        language: normalizeLanguage(input.language || process.env.KEYWORD_PLANNER_LANGUAGE),
        geoTargetConstants: normalizeResourceList(
            input.geoTargetConstants || cleanText(process.env.KEYWORD_PLANNER_GEO_TARGETS).split(','),
            DEFAULT_KEYWORD_PLANNER_GEO_TARGETS,
            'geoTargetConstants'
        ),
        keywordPlanNetwork: normalizeNetwork(input.keywordPlanNetwork),
        includeAdultKeywords: input.includeAdultKeywords === true,
        pageSize: Math.max(1, Math.min(Number(input.pageSize || process.env.KEYWORD_PLANNER_PAGE_SIZE || 100), MAX_IDEA_PAGE_SIZE))
    };
}

export function buildKeywordIdeaRequest(input: KeywordPlannerOptions = {}): Record<string, any> {
    const options = normalizedOptions(input);
    const seedKeywords = uniqueKeywords(options.keywords, MAX_IDEA_SEED_KEYWORDS);
    if (options.site && (seedKeywords.length || options.url)) {
        throw new KeywordPlannerValidationError('Keyword Planner site seeds must be used without keyword or page URL seeds.');
    }
    const body: Record<string, any> = {
        language: options.language,
        geoTargetConstants: options.geoTargetConstants,
        includeAdultKeywords: options.includeAdultKeywords,
        keywordPlanNetwork: options.keywordPlanNetwork,
        pageSize: options.pageSize
    };
    if (seedKeywords.length && options.url) {
        body.keywordAndUrlSeed = { keywords: seedKeywords, url: options.url };
    } else if (seedKeywords.length) {
        body.keywordSeed = { keywords: seedKeywords };
    } else if (options.site) {
        body.siteSeed = { site: options.site };
    } else if (options.url) {
        body.urlSeed = { url: options.url };
    } else {
        throw new KeywordPlannerValidationError('Keyword Planner ideas require at least one keyword or URL seed.');
    }
    return body;
}

export function buildHistoricalMetricsRequest(input: KeywordPlannerOptions = {}): Record<string, any> {
    const options = normalizedOptions(input);
    if (options.keywords.length === 0) {
        throw new KeywordPlannerValidationError('Keyword Planner historical metrics require at least one keyword.');
    }
    return {
        keywords: options.keywords,
        language: options.language,
        geoTargetConstants: options.geoTargetConstants,
        includeAdultKeywords: options.includeAdultKeywords,
        keywordPlanNetwork: options.keywordPlanNetwork,
        historicalMetricsOptions: { includeAverageCpc: true }
    };
}

export async function generateKeywordIdeas(token: string, customerId: string, input: KeywordPlannerOptions = {}): Promise<KeywordPlannerIdea[]> {
    const options = normalizedOptions(input);
    const seedKeywords = uniqueKeywords(options.keywords, MAX_IDEA_SEED_KEYWORDS);
    const seedType: KeywordPlannerIdea['seedType'] = seedKeywords.length && options.url
        ? 'keyword_and_url'
        : seedKeywords.length
            ? 'keyword'
            : options.site
                ? 'site'
                : 'url';
    const response = await postKeywordPlanner<{ results?: any[] }>(token, customerId, 'generateKeywordIdeas', buildKeywordIdeaRequest({ ...options, keywords: seedKeywords }));
    const fetchedAt = new Date().toISOString();
    return (response.results || []).map(row => ({
        ...normalizeMetric(String(row.text || ''), row.keywordIdeaMetrics),
        source: 'idea' as const,
        seedType,
        seedKeywords,
        seedUrl: options.url,
        seedSite: options.site,
        geoTargetConstants: options.geoTargetConstants,
        language: options.language,
        keywordPlanNetwork: options.keywordPlanNetwork,
        fetchedAt
    })).filter(row => row.keyword);
}

function chunks<T>(rows: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
    return out;
}

export async function generateKeywordHistoricalMetrics(token: string, customerId: string, input: KeywordPlannerOptions = {}): Promise<KeywordPlannerHistoricalMetric[]> {
    const options = normalizedOptions(input);
    const keywords = uniqueKeywords(options.keywords || []);
    if (keywords.length === 0) return [];
    const fetchedAt = new Date().toISOString();
    const rows: KeywordPlannerHistoricalMetric[] = [];
    for (const keywordChunk of chunks(keywords, HISTORICAL_METRICS_CHUNK_SIZE)) {
        const response = await postKeywordPlanner<{ results?: any[] }>(
            token,
            customerId,
            'generateKeywordHistoricalMetrics',
            buildHistoricalMetricsRequest({ ...options, keywords: keywordChunk })
        );
        rows.push(...(response.results || []).map(row => ({
            ...normalizeMetric(String(row.text || ''), row.keywordMetrics),
            source: 'historical' as const,
            closeVariants: Array.isArray(row.closeVariants) ? row.closeVariants.map(String) : [],
            geoTargetConstants: options.geoTargetConstants,
            language: options.language,
            keywordPlanNetwork: options.keywordPlanNetwork,
            fetchedAt
        })).filter(row => row.keyword));
    }
    return rows;
}

export function collectPlannerSeeds(input: { keywordRows?: any[]; searchTermRows?: any[]; maxSeeds?: number }): string[] {
    const maxSeeds = Math.max(1, Number(input.maxSeeds || process.env.KEYWORD_PLANNER_MAX_SEEDS || 250));
    const keywordTexts = (input.keywordRows || []).map(row => row['ad_group_criterion.keyword.text']);
    const searchTerms = (input.searchTermRows || []).map(row => row['search_term_view.search_term']);
    return uniqueKeywords([...keywordTexts, ...searchTerms], maxSeeds);
}

export async function refreshKeywordPlannerFeed(input: {
    token: string;
    customerId: string;
    keywordRows: any[];
    searchTermRows: any[];
    ideasOutputPath: string;
    historicalOutputPath: string;
    statusOutputPath: string;
}): Promise<KeywordPlannerRefreshResult> {
    const seeds = collectPlannerSeeds({ keywordRows: input.keywordRows, searchTermRows: input.searchTermRows });
    const options = normalizedOptions({ keywords: seeds, url: defaultKeywordPlannerUrl() });
    const seedSummary = {
        keywords: seeds,
        url: options.url,
        site: options.site,
        language: options.language,
        geoTargetConstants: options.geoTargetConstants,
        keywordPlanNetwork: options.keywordPlanNetwork
    };
    if (seeds.length === 0 && !options.url) {
        const empty: KeywordPlannerRefreshResult = {
            ideas: [],
            historicalMetrics: [],
            status: 'empty',
            message: 'No keyword or URL seeds available for Keyword Planner.',
            seeds: seedSummary
        };
        writeJsonAtomic(input.ideasOutputPath, []);
        writeJsonAtomic(input.historicalOutputPath, []);
        writeJsonAtomic(input.statusOutputPath, refreshStatusPayload(empty));
        return empty;
    }
    try {
        const [ideas, historicalMetrics] = await Promise.all([
            generateKeywordIdeas(input.token, input.customerId, options),
            seeds.length ? generateKeywordHistoricalMetrics(input.token, input.customerId, options) : Promise.resolve([])
        ]);
        const result: KeywordPlannerRefreshResult = {
            ideas,
            historicalMetrics,
            status: 'ok',
            message: `Fetched ${ideas.length} keyword ideas and ${historicalMetrics.length} historical metric rows from Keyword Planner.`,
            seeds: seedSummary
        };
        writeJsonAtomic(input.ideasOutputPath, ideas);
        writeJsonAtomic(input.historicalOutputPath, historicalMetrics);
        writeJsonAtomic(input.statusOutputPath, refreshStatusPayload(result));
        return result;
    } catch (err: any) {
        const result: KeywordPlannerRefreshResult = {
            ideas: [],
            historicalMetrics: [],
            status: 'failed',
            message: err?.message || String(err),
            seeds: seedSummary
        };
        writeJsonAtomic(input.ideasOutputPath, []);
        writeJsonAtomic(input.historicalOutputPath, []);
        writeJsonAtomic(input.statusOutputPath, refreshStatusPayload(result));
        return result;
    }
}
