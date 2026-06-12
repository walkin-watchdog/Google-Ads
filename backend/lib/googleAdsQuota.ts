import crypto from 'crypto';
import type { Pool, PoolClient } from 'pg';

export type GoogleAdsQuotaMode = 'read' | 'validate_only' | 'mutate';
export type GoogleAdsQuotaExhaustionSignal = 'resource_exhausted' | 'short_term_query_resource' | 'long_term_query_resource';

export interface GoogleAdsQuotaRequest {
    path: string;
    method?: string;
    body?: any;
    retryMode?: GoogleAdsQuotaMode;
    customerId?: string | null;
}

export interface GoogleAdsQuotaBucketRule {
    bucketKey: string;
    capacity: number;
    refillPerSecond: number;
    cost: number;
}

export interface GoogleAdsOperationQuotaRule {
    developerKey: string;
    limit: number;
    cost: number;
}

export class GoogleAdsQuotaError extends Error {
    retryAfterMs: number;

    constructor(message: string, retryAfterMs: number) {
        super(message);
        this.name = 'GoogleAdsQuotaError';
        this.retryAfterMs = retryAfterMs;
    }
}

const DEFAULT_DEVELOPER_REQUESTS_PER_MINUTE = 600;
const DEFAULT_CUSTOMER_REQUESTS_PER_MINUTE = 300;
const DEFAULT_MUTATE_REQUESTS_PER_MINUTE = 60;
const DEFAULT_KEYWORD_PLAN_REQUESTS_PER_SECOND = 1;
const DEFAULT_DEVELOPER_OPERATIONS_PER_24_HOURS = 15_000;
const DEFAULT_QUOTA_MAX_WAIT_MS = 120_000;
const DEFAULT_RESOURCE_EXHAUSTED_PAUSE_MS = 60_000;
const DEFAULT_SHORT_TERM_RESOURCE_EXHAUSTED_PAUSE_MS = 5 * 60_000;
const DEFAULT_LONG_TERM_RESOURCE_EXHAUSTED_PAUSE_MS = 30 * 60_000;
const OPERATION_WINDOW_MS = 24 * 60 * 60_000;

let quotaPool: Pool | null = null;
let schemaEnsuredForPool: Pool | null = null;
let schemaEnsurePromise: Promise<void> | null = null;

export function configureGoogleAdsQuotaGovernor(pool: Pool | null): void {
    quotaPool = pool;
    schemaEnsuredForPool = null;
    schemaEnsurePromise = null;
}

export async function ensureGoogleAdsQuotaSchema(pool: Pool): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS google_ads_quota_buckets (
            bucket_key TEXT PRIMARY KEY,
            capacity NUMERIC NOT NULL,
            tokens NUMERIC NOT NULL,
            refill_per_second NUMERIC NOT NULL,
            blocked_until TIMESTAMP WITH TIME ZONE,
            last_refill_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS google_ads_quota_buckets_updated_idx
            ON google_ads_quota_buckets(updated_at);

        CREATE TABLE IF NOT EXISTS google_ads_api_operation_usage (
            id BIGSERIAL PRIMARY KEY,
            developer_key TEXT NOT NULL,
            operation_count INTEGER NOT NULL CHECK (operation_count > 0),
            occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            source_key TEXT UNIQUE
        );
        CREATE INDEX IF NOT EXISTS google_ads_api_operation_usage_window_idx
            ON google_ads_api_operation_usage(developer_key, occurred_at);

        CREATE TABLE IF NOT EXISTS google_ads_query_resource_usage_hourly (
            developer_key TEXT NOT NULL,
            customer_id TEXT NOT NULL,
            path TEXT NOT NULL,
            observed_hour TIMESTAMP WITH TIME ZONE NOT NULL,
            resource_consumption BIGINT NOT NULL,
            sample_count INTEGER NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (developer_key, customer_id, path, observed_hour)
        );
    `);
}

export async function migrateGoogleAdsQuotaAccounting(pool: Pool): Promise<void> {
    await ensureGoogleAdsQuotaSchema(pool);
    await pool.query(`
        INSERT INTO google_ads_api_operation_usage
            (developer_key, operation_count, occurred_at, source_key)
        SELECT
            regexp_replace(bucket_key, ':daily:[0-9]{4}-[0-9]{2}-[0-9]{2}$', ''),
            GREATEST(1, CEIL(LEAST(capacity, capacity - tokens)))::integer,
            CURRENT_TIMESTAMP,
            'legacy:' || bucket_key
        FROM google_ads_quota_buckets
        WHERE bucket_key ~ '^google_ads:developer:[^:]+:daily:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          AND capacity > tokens
          AND bucket_key LIKE '%:daily:' || TO_CHAR(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD')
        ON CONFLICT (source_key) DO NOTHING;

        DELETE FROM google_ads_quota_buckets
        WHERE bucket_key ~ '^google_ads:(developer|customer|mutate):.*:daily:[0-9]{4}-[0-9]{2}-[0-9]{2}$';
    `);
}

async function ensureConfiguredQuotaSchema(pool: Pool): Promise<void> {
    if (schemaEnsuredForPool === pool) return;
    if (!schemaEnsurePromise) {
        schemaEnsurePromise = ensureGoogleAdsQuotaSchema(pool)
            .then(() => {
                schemaEnsuredForPool = pool;
            })
            .finally(() => {
                schemaEnsurePromise = null;
            });
    }
    await schemaEnsurePromise;
}

function envFlag(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return fallback;
    return !['0', 'false', 'no', 'off', 'disabled'].includes(String(raw).trim().toLowerCase());
}

function positiveNumberEnv(name: string, fallback: number, minimum = 0): number {
    const value = Number(process.env[name] ?? fallback);
    return Number.isFinite(value) && value > minimum ? value : fallback;
}

function developerOperationsPer24Hours(): number {
    const raw = process.env.GOOGLE_ADS_QUOTA_DEVELOPER_OPERATIONS_PER_24_HOURS
        ?? process.env.GOOGLE_ADS_QUOTA_DEVELOPER_UNITS_PER_DAY
        ?? DEFAULT_DEVELOPER_OPERATIONS_PER_24_HOURS;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : DEFAULT_DEVELOPER_OPERATIONS_PER_24_HOURS;
}

function sha256(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function developerTokenHash(): string {
    const token = process.env.GOOGLE_DEVELOPER_TOKEN || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || 'unset';
    return sha256(token);
}

function customerIdFromPath(path: string): string | null {
    const match = String(path || '').match(/(?:^|\/)customers\/([^/:]+)/);
    return match?.[1]?.replace(/-/g, '') || null;
}

function quotaMode(input: GoogleAdsQuotaRequest): GoogleAdsQuotaMode {
    if (input.retryMode) return input.retryMode;
    const path = String(input.path || '');
    if (path.includes(':mutate')) return input.body?.validateOnly === true ? 'validate_only' : 'mutate';
    return 'read';
}

function isKeywordPlanningOneQpsMethod(path: string): boolean {
    return path.includes('generateKeywordIdeas')
        || path.includes('generateKeywordHistoricalMetrics')
        || path.includes('generateKeywordForecastMetrics');
}

function operationCount(body: any): number {
    return Array.isArray(body?.operations) ? Math.max(1, body.operations.length) : 1;
}

export function googleAdsApiOperationCount(input: GoogleAdsQuotaRequest): number {
    const mode = quotaMode(input);
    if (mode === 'mutate' || mode === 'validate_only') return operationCount(input.body);
    return 1;
}

/** @deprecated Use googleAdsApiOperationCount. */
export const googleAdsQuotaRequestCost = googleAdsApiOperationCount;

function googleAdsQuotaRequestRateCost(input: GoogleAdsQuotaRequest): number {
    const mode = quotaMode(input);
    if (mode === 'mutate') return Math.max(1, Math.ceil(operationCount(input.body) / 50));
    return 1;
}

function numericCost(value: any): number | null {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return Math.ceil(numeric);
}

function queryResourceConsumptionUnits(payload: any): number | null {
    if (payload === null || payload === undefined || payload === '') return null;
    if (typeof payload === 'number' || typeof payload === 'string') return numericCost(payload);
    if (typeof payload !== 'object') return null;

    const candidates = [
        payload.queryResourceConsumption,
        payload.query_resource_consumption,
        payload.responseMetadata?.queryResourceConsumption,
        payload.response_metadata?.query_resource_consumption
    ];
    for (const candidate of candidates) {
        const units = queryResourceConsumptionUnits(candidate);
        if (units !== null) return units;
    }
    return null;
}

export function googleAdsQueryResourceConsumptionCost(payload: any): number | null {
    return queryResourceConsumptionUnits(payload);
}

function requestsPerMinute(name: string, fallback: number): { capacity: number; refillPerSecond: number } {
    const perMinute = positiveNumberEnv(name, fallback, 0);
    return {
        capacity: perMinute,
        refillPerSecond: perMinute / 60
    };
}

export function googleAdsQuotaBucketRules(input: GoogleAdsQuotaRequest): GoogleAdsQuotaBucketRule[] {
    const requestRateCost = googleAdsQuotaRequestRateCost(input);
    const developer = requestsPerMinute('GOOGLE_ADS_QUOTA_DEVELOPER_REQUESTS_PER_MINUTE', DEFAULT_DEVELOPER_REQUESTS_PER_MINUTE);
    const customer = requestsPerMinute('GOOGLE_ADS_QUOTA_CUSTOMER_REQUESTS_PER_MINUTE', DEFAULT_CUSTOMER_REQUESTS_PER_MINUTE);
    const mutate = requestsPerMinute('GOOGLE_ADS_QUOTA_MUTATE_REQUESTS_PER_MINUTE', DEFAULT_MUTATE_REQUESTS_PER_MINUTE);
    const path = String(input.path || '');
    const customerId = input.customerId || customerIdFromPath(path);
    const tokenHash = developerTokenHash();
    const rules: GoogleAdsQuotaBucketRule[] = [{
        bucketKey: `google_ads:developer:${tokenHash}:minute`,
        capacity: Math.max(developer.capacity, requestRateCost),
        refillPerSecond: developer.refillPerSecond,
        cost: requestRateCost
    }];
    if (customerId) {
        rules.push({
            bucketKey: `google_ads:customer:${customerId}:minute`,
            capacity: Math.max(customer.capacity, requestRateCost),
            refillPerSecond: customer.refillPerSecond,
            cost: requestRateCost
        });
        if (isKeywordPlanningOneQpsMethod(path)) {
            const keywordPlanQps = positiveNumberEnv('GOOGLE_ADS_QUOTA_KEYWORD_PLAN_REQUESTS_PER_SECOND', DEFAULT_KEYWORD_PLAN_REQUESTS_PER_SECOND, 0);
            rules.push({
                bucketKey: `google_ads:keyword_plan:${customerId}:second`,
                capacity: Math.max(1, keywordPlanQps),
                refillPerSecond: keywordPlanQps,
                cost: 1
            });
        }
    }
    if (quotaMode(input) === 'mutate') {
        rules.push({
            bucketKey: `google_ads:mutate:${customerId || 'unknown'}:minute`,
            capacity: Math.max(mutate.capacity, requestRateCost),
            refillPerSecond: mutate.refillPerSecond,
            cost: requestRateCost
        });
    }
    return rules;
}

export function googleAdsOperationQuotaRule(input: GoogleAdsQuotaRequest): GoogleAdsOperationQuotaRule | null {
    const limit = developerOperationsPer24Hours();
    if (limit === 0) return null;
    return {
        developerKey: `google_ads:developer:${developerTokenHash()}`,
        limit,
        cost: googleAdsApiOperationCount(input)
    };
}

function quotaGovernorEnabled(): boolean {
    return Boolean(quotaPool && envFlag('GOOGLE_ADS_QUOTA_GOVERNOR_ENABLED', true));
}

async function insertMissingBuckets(pool: Pool, rules: GoogleAdsQuotaBucketRule[]): Promise<void> {
    for (const rule of rules) {
        await pool.query(
            `INSERT INTO google_ads_quota_buckets
             (bucket_key, capacity, tokens, refill_per_second, last_refill_at, updated_at)
             VALUES ($1, $2, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT (bucket_key) DO NOTHING`,
            [rule.bucketKey, rule.capacity, rule.refillPerSecond]
        );
    }
}

function rowTimeMs(value: any, fallback: number): number {
    if (!value) return fallback;
    const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : fallback;
}

function rollingOperationDelayMs(rows: any[], rule: GoogleAdsOperationQuotaRule, nowMs: number): number {
    if (rule.cost > rule.limit) {
        throw new GoogleAdsQuotaError(
            `Google Ads request requires ${rule.cost} API operations, exceeding the configured rolling 24-hour limit of ${rule.limit}.`,
            OPERATION_WINDOW_MS
        );
    }
    const used = rows.reduce((total, row) => total + Math.max(0, Number(row.operation_count) || 0), 0);
    if (used + rule.cost <= rule.limit) return 0;

    const mustExpire = used + rule.cost - rule.limit;
    let expiringOperations = 0;
    for (const row of rows) {
        expiringOperations += Math.max(0, Number(row.operation_count) || 0);
        if (expiringOperations >= mustExpire) {
            return Math.max(1, rowTimeMs(row.occurred_at, nowMs) + OPERATION_WINDOW_MS - nowMs + 1);
        }
    }
    return OPERATION_WINDOW_MS;
}

async function tryAcquireQuota(
    client: PoolClient,
    rules: GoogleAdsQuotaBucketRule[],
    operationRule: GoogleAdsOperationQuotaRule | null
): Promise<number> {
    const keys = rules.map(rule => rule.bucketKey).sort();
    const nowMs = Date.now();
    const { rows } = await client.query(
        `SELECT bucket_key, capacity, tokens, refill_per_second, blocked_until, last_refill_at
         FROM google_ads_quota_buckets
         WHERE bucket_key = ANY($1::text[])
         ORDER BY bucket_key
         FOR UPDATE`,
        [keys]
    );
    const rowsByKey = new Map(rows.map((row: any) => [String(row.bucket_key), row]));
    const projected = rules.map(rule => {
        const row = rowsByKey.get(rule.bucketKey);
        const lastRefillMs = rowTimeMs(row?.last_refill_at, nowMs);
        const elapsedSeconds = Math.max(0, (nowMs - lastRefillMs) / 1000);
        const capacity = Math.max(rule.capacity, rule.cost);
        const refillPerSecond = Math.max(0, rule.refillPerSecond);
        const storedTokens = Number(row?.tokens ?? capacity);
        const refillBase = Number.isFinite(storedTokens) ? Math.max(0, storedTokens) : capacity;
        const tokens = Math.min(capacity, refillBase + elapsedSeconds * refillPerSecond);
        const blockedUntilMs = rowTimeMs(row?.blocked_until, 0);
        const blockedDelayMs = blockedUntilMs > nowMs ? blockedUntilMs - nowMs : 0;
        const tokenDelayMs = tokens >= rule.cost
            ? 0
            : refillPerSecond > 0
                ? Math.ceil(((rule.cost - tokens) / refillPerSecond) * 1000)
                : OPERATION_WINDOW_MS;
        return {
            rule,
            capacity,
            refillPerSecond,
            tokens,
            delayMs: Math.max(blockedDelayMs, tokenDelayMs)
        };
    });

    let operationDelayMs = 0;
    if (operationRule) {
        await client.query(
            `DELETE FROM google_ads_api_operation_usage
             WHERE developer_key = $1
               AND occurred_at <= CURRENT_TIMESTAMP - INTERVAL '24 hours'`,
            [operationRule.developerKey]
        );
        const usage = await client.query(
            `SELECT operation_count, occurred_at
             FROM google_ads_api_operation_usage
             WHERE developer_key = $1
               AND occurred_at > CURRENT_TIMESTAMP - INTERVAL '24 hours'
             ORDER BY occurred_at, id`,
            [operationRule.developerKey]
        );
        operationDelayMs = rollingOperationDelayMs(usage.rows, operationRule, nowMs);
    }

    const delayMs = Math.max(operationDelayMs, 0, ...projected.map(item => item.delayMs));
    for (const item of projected) {
        await client.query(
            `UPDATE google_ads_quota_buckets
             SET capacity = $2,
                 tokens = $3,
                 refill_per_second = $4,
                 last_refill_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE bucket_key = $1`,
            [
                item.rule.bucketKey,
                item.capacity,
                delayMs > 0 ? item.tokens : item.tokens - item.rule.cost,
                item.refillPerSecond
            ]
        );
    }
    if (delayMs === 0 && operationRule) {
        await client.query(
            `INSERT INTO google_ads_api_operation_usage
                (developer_key, operation_count, occurred_at)
             VALUES ($1, $2, CURRENT_TIMESTAMP)`,
            [operationRule.developerKey, operationRule.cost]
        );
    }
    return delayMs;
}

async function acquireQuota(
    pool: Pool,
    rules: GoogleAdsQuotaBucketRule[],
    operationRule: GoogleAdsOperationQuotaRule | null
): Promise<number> {
    await insertMissingBuckets(pool, rules);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const delayMs = await tryAcquireQuota(client, rules, operationRule);
        await client.query('COMMIT');
        return delayMs;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

export async function waitForGoogleAdsQuota(input: GoogleAdsQuotaRequest): Promise<void> {
    if (!quotaGovernorEnabled() || !quotaPool) return;
    const rules = googleAdsQuotaBucketRules(input);
    const operationRule = googleAdsOperationQuotaRule(input);
    if (!rules.length && !operationRule) return;
    await ensureConfiguredQuotaSchema(quotaPool);
    const maxWaitMs = positiveNumberEnv('GOOGLE_ADS_QUOTA_MAX_WAIT_MS', DEFAULT_QUOTA_MAX_WAIT_MS, -1);
    const startedAt = Date.now();
    while (true) {
        const delayMs = await acquireQuota(quotaPool, rules, operationRule);
        if (delayMs <= 0) return;
        const elapsedMs = Date.now() - startedAt;
        if (maxWaitMs >= 0 && elapsedMs + delayMs > maxWaitMs) {
            throw new GoogleAdsQuotaError(`Google Ads quota governor wait exceeded ${maxWaitMs}ms.`, delayMs);
        }
        await sleep(delayMs);
    }
}

export async function deferGoogleAdsQuota(input: GoogleAdsQuotaRequest, delayMs: number): Promise<void> {
    if (!quotaGovernorEnabled() || !quotaPool || !Number.isFinite(delayMs) || delayMs <= 0) return;
    const rules = googleAdsQuotaBucketRules(input).filter(rule => rule.refillPerSecond > 0);
    if (!rules.length) return;
    await ensureConfiguredQuotaSchema(quotaPool);
    await insertMissingBuckets(quotaPool, rules);
    await quotaPool.query(
        `UPDATE google_ads_quota_buckets
         SET tokens = 0,
             blocked_until = GREATEST(
                 COALESCE(blocked_until, CURRENT_TIMESTAMP),
                 CURRENT_TIMESTAMP + ($2::bigint * INTERVAL '1 millisecond')
             ),
             updated_at = CURRENT_TIMESTAMP
         WHERE bucket_key = ANY($1::text[])`,
        [rules.map(rule => rule.bucketKey), Math.ceil(delayMs)]
    );
}

export async function recordGoogleAdsQueryResourceConsumption(input: GoogleAdsQuotaRequest, payload: any): Promise<void> {
    if (!quotaGovernorEnabled() || !quotaPool) return;
    const resourceConsumption = googleAdsQueryResourceConsumptionCost(payload);
    if (resourceConsumption === null) return;
    await ensureConfiguredQuotaSchema(quotaPool);
    await quotaPool.query(
        `INSERT INTO google_ads_query_resource_usage_hourly
            (developer_key, customer_id, path, observed_hour, resource_consumption, sample_count, updated_at)
         VALUES ($1, $2, $3, DATE_TRUNC('hour', CURRENT_TIMESTAMP), $4, 1, CURRENT_TIMESTAMP)
         ON CONFLICT (developer_key, customer_id, path, observed_hour)
         DO UPDATE SET
            resource_consumption = google_ads_query_resource_usage_hourly.resource_consumption + EXCLUDED.resource_consumption,
            sample_count = google_ads_query_resource_usage_hourly.sample_count + 1,
            updated_at = CURRENT_TIMESTAMP`,
        [
            `google_ads:developer:${developerTokenHash()}`,
            input.customerId || customerIdFromPath(input.path) || 'unknown',
            String(input.path || ''),
            resourceConsumption
        ]
    );
}

export function googleAdsQuotaFeedbackDelayMs(input: {
    retryAfterMs?: number | null;
    resourceExhausted?: boolean;
    exhaustionSignal?: GoogleAdsQuotaExhaustionSignal | null;
}): number | null {
    if (input.retryAfterMs !== null && input.retryAfterMs !== undefined && input.retryAfterMs >= 0) return input.retryAfterMs;
    if (input.exhaustionSignal === 'short_term_query_resource') {
        return positiveNumberEnv(
            'GOOGLE_ADS_QUOTA_SHORT_TERM_RESOURCE_EXHAUSTED_PAUSE_MS',
            DEFAULT_SHORT_TERM_RESOURCE_EXHAUSTED_PAUSE_MS,
            0
        );
    }
    if (input.exhaustionSignal === 'long_term_query_resource') {
        return positiveNumberEnv(
            'GOOGLE_ADS_QUOTA_LONG_TERM_RESOURCE_EXHAUSTED_PAUSE_MS',
            DEFAULT_LONG_TERM_RESOURCE_EXHAUSTED_PAUSE_MS,
            0
        );
    }
    if (input.resourceExhausted) {
        return positiveNumberEnv('GOOGLE_ADS_QUOTA_RESOURCE_EXHAUSTED_PAUSE_MS', DEFAULT_RESOURCE_EXHAUSTED_PAUSE_MS, 0);
    }
    return null;
}
