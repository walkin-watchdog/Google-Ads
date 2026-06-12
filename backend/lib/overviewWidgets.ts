import type { Pool } from 'pg';
import { getCoverageForWindow, type CoverageEntry, type DashboardFilters } from './adsWarehouse';

const SEARCH_MODES = new Set(['searches', 'words']);
const SEARCH_METRICS = new Set(['clicks', 'impressions', 'cost', 'conversions']);
const KEYWORD_METRICS = new Set([
    'cost', 'clicks', 'impressions', 'ctr', 'averageCpc', 'conversions',
    'conversionRate', 'costPerConversion', 'searchImpressionShare'
]);
const SORT_DIRECTIONS = new Set(['asc', 'desc']);
const SEARCH_PAGE_SIZE_MAX = 20;
const WORD_PAGE_SIZE_MAX = 40;
const KEYWORD_PAGE_SIZE_MAX = 20;

export class OverviewWidgetValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OverviewWidgetValidationError';
    }
}

function one(value: unknown): string {
    if (Array.isArray(value)) return String(value[0] ?? '').trim();
    return String(value ?? '').trim();
}

function enumValue(value: unknown, allowed: Set<string>, fallback: string, label: string): string {
    const clean = one(value) || fallback;
    if (!allowed.has(clean)) throw new OverviewWidgetValidationError(`${label} is invalid.`);
    return clean;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, label: string): number {
    if (value == null || one(value) === '') return fallback;
    const parsed = Number(one(value));
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        throw new OverviewWidgetValidationError(`${label} must be an integer between ${min} and ${max}.`);
    }
    return parsed;
}

function scopeSql(filters: DashboardFilters, alias: string, params: any[]): string[] {
    const clauses = [
        `${alias}.customer_id = $1`,
        `${alias}.date BETWEEN $2::date AND $3::date`
    ];
    if (filters.campaignId) {
        params.push(filters.campaignId);
        clauses.push(`${alias}.campaign_id = $${params.length}`);
    }
    if (filters.adGroupId) {
        params.push(filters.adGroupId);
        clauses.push(`${alias}.ad_group_id = $${params.length}`);
    }
    return clauses;
}

function compactCoverage(entries: CoverageEntry[]): any[] {
    return entries.map(entry => ({
        reportName: entry.reportName,
        status: entry.status,
        coveredDateCount: entry.coveredDates,
        missingDateCount: entry.missingDates.length,
        missingDates: entry.missingDates.slice(0, 7),
        failedDateCount: entry.failedDates.length,
        failedDates: entry.failedDates.slice(0, 7),
        emptyDateCount: entry.emptyDates.length,
        rowCount: entry.rowCount,
        lastFetchedAt: entry.lastFetchedAt,
        error: entry.error
    }));
}

function pagination(page: number, pageSize: number, totalItems: number) {
    return {
        page,
        pageSize,
        totalItems,
        totalPages: totalItems > 0 ? Math.ceil(totalItems / pageSize) : 0
    };
}

function widgetMeta(filters: DashboardFilters) {
    return {
        startDate: filters.startDate,
        endDate: filters.endDate,
        campaignId: filters.campaignId || null,
        adGroupId: filters.adGroupId || null,
        generatedAt: new Date().toISOString()
    };
}

function conversionSelector(raw: Record<string, any>): { type: 'all' | 'category' | 'action'; value: string | null } {
    const category = one(raw.conversionCategory);
    const action = one(raw.conversionAction);
    if (category && action) {
        throw new OverviewWidgetValidationError('Choose either a conversion category or a conversion action, not both.');
    }
    if (category) return { type: 'category', value: category };
    if (action) return { type: 'action', value: action };
    return { type: 'all', value: null };
}

function searchTermsCtes(filters: DashboardFilters, raw: Record<string, any>) {
    const params: any[] = [filters.customerId, filters.startDate, filters.endDate];
    const factWhere = scopeSql(filters, 'st', params);
    const conversionWhere = scopeSql(filters, 'cs', params);
    const selector = conversionSelector(raw);
    if (selector.type === 'category') {
        params.push(selector.value);
        conversionWhere.push(`cs.conversion_action_category = $${params.length}`);
    } else if (selector.type === 'action') {
        params.push(selector.value);
        conversionWhere.push(`cs.conversion_action_name = $${params.length}`);
    }

    const sql = `
        WITH scoped AS (
            SELECT
                lower(trim(st.search_term)) AS term_key,
                min(st.search_term) AS search_term,
                st.campaign_id,
                max(st.campaign_name) AS campaign_name,
                st.ad_group_id,
                max(st.ad_group_name) AS ad_group_name,
                sum(st.cost_micros)::numeric AS cost_micros,
                sum(st.clicks)::numeric AS clicks,
                sum(st.impressions)::numeric AS impressions,
                sum(st.conversions)::numeric AS conversions,
                bool_or(st.search_term_status = 'ADDED') AS already_added,
                bool_or(st.search_term_status = 'EXCLUDED') AS already_excluded,
                max(st.search_term_match_type) AS search_term_match_type,
                coalesce(
                    jsonb_agg(DISTINCT jsonb_build_object(
                        'text', st.matched_keyword_text,
                        'matchType', st.matched_keyword_match_type
                    )) FILTER (WHERE nullif(trim(st.matched_keyword_text), '') IS NOT NULL),
                    '[]'::jsonb
                ) AS matched_keywords
            FROM google_ads_search_term_daily st
            WHERE ${factWhere.join(' AND ')}
              AND nullif(trim(st.search_term), '') IS NOT NULL
            GROUP BY lower(trim(st.search_term)), st.campaign_id, st.ad_group_id
        ),
        conversion_scoped AS (
            SELECT
                lower(trim(cs.search_term)) AS term_key,
                cs.campaign_id,
                cs.ad_group_id,
                sum(cs.conversions)::numeric AS selected_conversions
            FROM google_ads_conversion_search_term_daily cs
            WHERE ${conversionWhere.join(' AND ')}
              AND nullif(trim(cs.search_term), '') IS NOT NULL
            GROUP BY lower(trim(cs.search_term)), cs.campaign_id, cs.ad_group_id
        ),
        terms AS (
            SELECT
                s.term_key,
                min(s.search_term) AS label,
                sum(s.cost_micros)::numeric AS cost_micros,
                sum(s.clicks)::numeric AS clicks,
                sum(s.impressions)::numeric AS impressions,
                ${selector.type === 'all'
                    ? 'sum(s.conversions)::numeric'
                    : 'sum(coalesce(c.selected_conversions, 0))::numeric'} AS conversions,
                bool_or(s.already_added) AS already_added,
                bool_or(s.already_excluded) AS already_excluded,
                count(*)::integer AS scope_count,
                jsonb_agg(jsonb_build_object(
                    'campaignId', s.campaign_id,
                    'campaignName', s.campaign_name,
                    'adGroupId', s.ad_group_id,
                    'adGroupName', s.ad_group_name,
                    'costMicros', s.cost_micros,
                    'clicks', s.clicks,
                    'impressions', s.impressions,
                    'conversions', ${selector.type === 'all' ? 's.conversions' : 'coalesce(c.selected_conversions, 0)'},
                    'alreadyAdded', s.already_added,
                    'alreadyExcluded', s.already_excluded,
                    'searchTermMatchType', s.search_term_match_type,
                    'matchedKeywords', s.matched_keywords
                ) ORDER BY s.clicks DESC, s.ad_group_name ASC) AS scopes
            FROM scoped s
            LEFT JOIN conversion_scoped c
              ON c.term_key = s.term_key
             AND c.campaign_id = s.campaign_id
             AND c.ad_group_id = s.ad_group_id
            GROUP BY s.term_key
        )`;
    return { sql, params, selector };
}

const SEARCH_ORDER: Record<string, string> = {
    clicks: 'clicks',
    impressions: 'impressions',
    cost: 'cost_micros',
    conversions: 'conversions'
};

function normalizeSearchRow(row: any, mode: string) {
    const base: any = {
        label: row.label,
        costMicros: Number(row.cost_micros || 0),
        clicks: Number(row.clicks || 0),
        impressions: Number(row.impressions || 0),
        conversions: Number(row.conversions || 0)
    };
    if (mode === 'searches') {
        base.alreadyAdded = row.already_added === true;
        base.alreadyExcluded = row.already_excluded === true;
        base.scopeCount = Number(row.scope_count || 0);
        base.scopes = (Array.isArray(row.scopes) ? row.scopes : []).slice(0, 20).map((scope: any) => ({
            ...scope,
            matchedKeywords: (Array.isArray(scope?.matchedKeywords) ? scope.matchedKeywords : []).slice(0, 10)
        }));
    } else {
        base.examples = Array.isArray(row.examples) ? row.examples : [];
    }
    return base;
}

async function conversionOptions(pool: Pool, filters: DashboardFilters) {
    const params: any[] = [filters.customerId, filters.startDate, filters.endDate];
    const where = scopeSql(filters, 'cs', params);
    const { rows } = await pool.query(`
        SELECT
            conversion_action_category AS category,
            conversion_action_name AS name,
            sum(conversions)::numeric AS conversions
        FROM google_ads_conversion_search_term_daily cs
        WHERE ${where.join(' AND ')}
          AND (nullif(trim(conversion_action_category), '') IS NOT NULL
               OR nullif(trim(conversion_action_name), '') IS NOT NULL)
        GROUP BY conversion_action_category, conversion_action_name
        ORDER BY sum(conversions) DESC, conversion_action_category ASC, conversion_action_name ASC
        LIMIT 200`, params);
    const categories = new Map<string, number>();
    const actions: Array<{ name: string; category: string | null; conversions: number }> = [];
    for (const row of rows) {
        const category = one(row.category);
        const name = one(row.name);
        const conversions = Number(row.conversions || 0);
        if (category) categories.set(category, (categories.get(category) || 0) + conversions);
        if (name) actions.push({ name, category: category || null, conversions });
    }
    return {
        categories: Array.from(categories, ([name, conversions]) => ({ name, conversions }))
            .sort((a, b) => b.conversions - a.conversions || a.name.localeCompare(b.name)),
        actions
    };
}

export async function getSearchTermsOverviewWidget(
    pool: Pool,
    filters: DashboardFilters,
    raw: Record<string, any> = {}
) {
    const mode = enumValue(raw.mode, SEARCH_MODES, 'searches', 'mode');
    const metric = enumValue(raw.metric, SEARCH_METRICS, 'clicks', 'metric');
    const page = boundedInteger(raw.page, 1, 1, 1_000_000, 'page');
    const pageSize = boundedInteger(
        raw.pageSize,
        mode === 'words' ? 30 : 20,
        1,
        mode === 'words' ? WORD_PAGE_SIZE_MAX : SEARCH_PAGE_SIZE_MAX,
        'pageSize'
    );
    const offset = (page - 1) * pageSize;
    const ctes = searchTermsCtes(filters, raw);
    ctes.params.push(pageSize, offset);
    const limitParam = `$${ctes.params.length - 1}`;
    const offsetParam = `$${ctes.params.length}`;
    const order = SEARCH_ORDER[metric];
    const rowsSql = mode === 'searches'
        ? `${ctes.sql}
           SELECT label, cost_micros, clicks, impressions, conversions, already_added, already_excluded, scope_count, scopes,
                  count(*) OVER()::integer AS total_items
           FROM terms
           ORDER BY ${order} DESC, label ASC
           LIMIT ${limitParam} OFFSET ${offsetParam}`
        : `${ctes.sql},
           word_rows AS (
               SELECT
                   word,
                   t.label AS example,
                   t.cost_micros,
                   t.clicks,
                   t.impressions,
                   t.conversions
               FROM terms t
               CROSS JOIN LATERAL regexp_split_to_table(lower(t.label), '[^[:alnum:]]+') AS word
               WHERE length(word) >= 3
                 AND word !~ '^[0-9]+$'
                 AND word <> ALL(ARRAY[
                     'the','and','for','with','from','that','this','your','you','are','how','what','where',
                     'near','best','top','get','can','use','using','online','official','www','com'
                 ]::text[])
           ),
           words AS (
               SELECT
                   word AS label,
                   sum(cost_micros)::numeric AS cost_micros,
                   sum(clicks)::numeric AS clicks,
                   sum(impressions)::numeric AS impressions,
                   sum(conversions)::numeric AS conversions,
                   (array_agg(example ORDER BY ${order} DESC, example ASC))[1:5] AS examples
               FROM word_rows
               GROUP BY word
           )
           SELECT label, cost_micros, clicks, impressions, conversions, examples,
                  count(*) OVER()::integer AS total_items
           FROM words
           ORDER BY ${order} DESC, label ASC
           LIMIT ${limitParam} OFFSET ${offsetParam}`;

    const coverageReports = ctes.selector.type === 'all'
        ? ['search_term_performance']
        : ['search_term_performance', 'conversion_attribution_by_search_term'];
    const [result, options, coverage] = await Promise.all([
        pool.query(rowsSql, ctes.params),
        conversionOptions(pool, filters),
        getCoverageForWindow(pool, filters, coverageReports)
    ]);
    const totalItems = Number(result.rows[0]?.total_items || 0);
    return {
        meta: widgetMeta(filters),
        mode,
        metric,
        conversionFilter: ctes.selector,
        rows: result.rows.map(row => normalizeSearchRow(row, mode)),
        pagination: pagination(page, pageSize, totalItems),
        conversionOptions: options,
        coverage: compactCoverage(coverage)
    };
}

const KEYWORD_ORDER: Record<string, string> = {
    cost: 'cost_micros',
    clicks: 'clicks',
    impressions: 'impressions',
    ctr: 'ctr',
    averageCpc: 'average_cpc_micros',
    conversions: 'conversions',
    conversionRate: 'conversion_rate',
    costPerConversion: 'cost_per_conversion_micros',
    searchImpressionShare: 'search_impression_share'
};

export async function getKeywordsOverviewWidget(
    pool: Pool,
    filters: DashboardFilters,
    raw: Record<string, any> = {}
) {
    const sort = enumValue(raw.sort, KEYWORD_METRICS, 'cost', 'sort');
    const direction = enumValue(raw.direction, SORT_DIRECTIONS, 'desc', 'direction');
    const page = boundedInteger(raw.page, 1, 1, 1_000_000, 'page');
    const pageSize = boundedInteger(raw.pageSize, 5, 1, KEYWORD_PAGE_SIZE_MAX, 'pageSize');
    const params: any[] = [filters.customerId, filters.startDate, filters.endDate];
    const configuredWhere = ['k.customer_id = $1', 'k.present_in_latest_snapshot = true', `coalesce(k.status, '') <> 'REMOVED'`];
    const performanceWhere = scopeSql(filters, 'd', params);
    if (filters.campaignId) configuredWhere.push(`k.campaign_id = $4`);
    if (filters.adGroupId) configuredWhere.push(`k.ad_group_id = $${filters.campaignId ? 5 : 4}`);
    params.push(pageSize, (page - 1) * pageSize);
    const limitParam = `$${params.length - 1}`;
    const offsetParam = `$${params.length}`;
    const order = KEYWORD_ORDER[sort];
    const { rows } = await pool.query(`
        WITH performance AS (
            SELECT
                d.campaign_id,
                d.ad_group_id,
                d.criterion_id,
                sum(d.cost_micros)::numeric AS cost_micros,
                sum(d.clicks)::numeric AS clicks,
                sum(d.impressions)::numeric AS impressions,
                sum(d.conversions)::numeric AS conversions,
                CASE WHEN sum(d.impressions) > 0 THEN sum(d.clicks)::numeric / sum(d.impressions) ELSE 0 END AS ctr,
                CASE WHEN sum(d.clicks) > 0 THEN sum(d.cost_micros)::numeric / sum(d.clicks) ELSE 0 END AS average_cpc_micros,
                CASE WHEN sum(d.clicks) > 0 THEN sum(d.conversions)::numeric / sum(d.clicks) ELSE 0 END AS conversion_rate,
                CASE WHEN sum(d.conversions) > 0 THEN sum(d.cost_micros)::numeric / sum(d.conversions) ELSE 0 END AS cost_per_conversion_micros,
                coalesce(
                    sum(d.search_impression_share * d.impressions) FILTER (WHERE d.search_impression_share IS NOT NULL)
                        / nullif(sum(d.impressions) FILTER (WHERE d.search_impression_share IS NOT NULL), 0),
                    avg(d.search_impression_share),
                    0
                ) AS search_impression_share
            FROM google_ads_keyword_daily d
            WHERE ${performanceWhere.join(' AND ')}
            GROUP BY d.campaign_id, d.ad_group_id, d.criterion_id
        ),
        keywords AS (
            SELECT
                k.campaign_id,
                k.campaign_name,
                k.ad_group_id,
                k.ad_group_name,
                k.criterion_id,
                k.keyword_text,
                k.match_type,
                k.status,
                k.primary_status,
                coalesce(p.cost_micros, 0) AS cost_micros,
                coalesce(p.clicks, 0) AS clicks,
                coalesce(p.impressions, 0) AS impressions,
                coalesce(p.conversions, 0) AS conversions,
                coalesce(p.ctr, 0) AS ctr,
                coalesce(p.average_cpc_micros, 0) AS average_cpc_micros,
                coalesce(p.conversion_rate, 0) AS conversion_rate,
                coalesce(p.cost_per_conversion_micros, 0) AS cost_per_conversion_micros,
                coalesce(p.search_impression_share, 0) AS search_impression_share
            FROM google_ads_configured_keywords k
            LEFT JOIN performance p
              ON p.campaign_id = k.campaign_id
             AND p.ad_group_id = k.ad_group_id
             AND p.criterion_id = k.criterion_id
            WHERE ${configuredWhere.join(' AND ')}
        )
        SELECT *, count(*) OVER()::integer AS total_items
        FROM keywords
        ORDER BY ${order} ${direction.toUpperCase()}, keyword_text ASC, criterion_id ASC
        LIMIT ${limitParam} OFFSET ${offsetParam}`, params);
    const coverage = await getCoverageForWindow(pool, filters, ['keyword_performance']);
    const totalItems = Number(rows[0]?.total_items || 0);
    return {
        meta: widgetMeta(filters),
        sort,
        direction,
        rows: rows.map(row => ({
            campaignId: row.campaign_id,
            campaignName: row.campaign_name,
            adGroupId: row.ad_group_id,
            adGroupName: row.ad_group_name,
            criterionId: row.criterion_id,
            keywordText: row.keyword_text,
            matchType: row.match_type,
            status: row.status,
            primaryStatus: row.primary_status,
            costMicros: Number(row.cost_micros || 0),
            clicks: Number(row.clicks || 0),
            impressions: Number(row.impressions || 0),
            ctr: Number(row.ctr || 0),
            averageCpcMicros: Number(row.average_cpc_micros || 0),
            conversions: Number(row.conversions || 0),
            conversionRate: Number(row.conversion_rate || 0),
            costPerConversionMicros: Number(row.cost_per_conversion_micros || 0),
            searchImpressionShare: Number(row.search_impression_share || 0)
        })),
        pagination: pagination(page, pageSize, totalItems),
        allowedMetrics: Array.from(KEYWORD_METRICS),
        coverage: compactCoverage(coverage)
    };
}
