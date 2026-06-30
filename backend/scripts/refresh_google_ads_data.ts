import dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import crypto from 'crypto';
import { Pool } from 'pg';
import { getAccessToken, getAccessibleCustomer, executeGaql } from '../lib/googleAds';
import { buildAuctionInsightsEntities, fetchAuctionInsightsFeed } from '../lib/auctionInsights';
import { ensureDatabaseSchema } from '../lib/proposals';
import { refreshKeywordPlannerFeed } from '../lib/googleKeywordPlanner';
import { archiveChangeHistoryRows } from '../lib/changeHistory';
import { generateCandidateSignals } from './deterministic_rules';
import {
    mapAuctionInsightRows,
    mapAuctionInsightStatus,
    mapKeywordPlannerHistorical,
    mapKeywordPlannerIdeas,
    mapReportRows,
    type MappedReportRows
} from '../lib/adsReportMappers';
import {
    completeWarehouseRefreshRun,
    ensureAdsWarehouseSchema,
    hasWarehouseData,
    markReportCoverage,
    recordReportFetch,
    replaceAccountDailyWindow,
    replaceAccountNegativeListsSnapshot,
    replaceAdGroupDailyWindow,
    replaceAdGroupNegativesSnapshot,
    replaceAdGroupSnapshot,
    replaceAuctionInsightsRows,
    replaceAuctionInsightsStatus,
    replaceCampaignDailyWindow,
    replaceCampaignNegativesSnapshot,
    replaceCampaignSharedSetsSnapshot,
    replaceCampaignSnapshot,
    replaceClickEvidenceDailyWindow,
    replaceConfiguredKeywordsSnapshot,
    replaceConversionActionDailyWindow,
    replaceConversionAdGroupDailyWindow,
    replaceConversionSearchTermDailyWindow,
    replaceDayHourDailyWindow,
    replaceDayOfWeekDailyWindow,
    replaceDeviceDailyWindow,
    replaceExpandedLandingPageDailyWindow,
    replaceKeywordDailyWindow,
    replaceKeywordPlannerHistorical,
    replaceKeywordPlannerIdeas,
    replaceLandingPageDailyWindow,
    replaceQualityScoreSnapshot,
    replaceSearchTermDailyWindow,
    replaceSharedNegativeCriteriaSnapshot,
    replaceSharedNegativeSetsSnapshot,
    startWarehouseRefreshRun,
    type WarehouseRefreshKind
} from '../lib/adsWarehouse';

const ROOT = path.resolve(__dirname, '..');
const REPORTS_YML = path.join(ROOT, 'config', 'reports.yml');
const DEFAULT_LOOKBACK_DAYS = 90;
const DEFAULT_STARTUP_LOOKBACK_DAYS = 14;
const BACKFILL_CHUNK_DAYS = 30;
const DEFAULT_FETCH_CONCURRENCY = 2;
const WAREHOUSE_SKIPPED_REPORTS = new Set(['auction_insights_domains', 'daily_trend']);

const pool = process.env.DATABASE_URL ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
}) : null;

let targetDate = new Date().toISOString().slice(0, 10);
let startDateStr = '';
let endDateStr = '';
let backfillStartDate = '';
let forceClear = false;
let backfill = false;
let startup = false;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) targetDate = args[i + 1];
    if (args[i] === '--start-date' && args[i + 1]) startDateStr = args[i + 1];
    if (args[i] === '--end-date' && args[i + 1]) endDateStr = args[i + 1];
    if (args[i] === '--backfill-start-date' && args[i + 1]) backfillStartDate = args[i + 1];
    if (args[i] === '--force-clear') forceClear = true;
    if (args[i] === '--backfill') backfill = true;
    if (args[i] === '--startup') startup = true;
}

if (!endDateStr) endDateStr = new Date().toISOString().slice(0, 10);
if (!targetDate) targetDate = endDateStr;

function assertDate(value: string, label: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must be YYYY-MM-DD.`);
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
        throw new Error(`${label} is not a valid calendar date.`);
    }
}

function isoDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
    const [year, month, day] = date.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day + days));
    return isoDate(parsed);
}

function daysBetween(start: string, end: string): string[] {
    const dates: string[] = [];
    for (let date = start; date <= end; date = addDays(date, 1)) dates.push(date);
    return dates;
}

function dateChunks(start: string, end: string, chunkDays = BACKFILL_CHUNK_DAYS): Array<{ startDate: string; endDate: string }> {
    const chunks: Array<{ startDate: string; endDate: string }> = [];
    for (let cursor = start; cursor <= end;) {
        const chunkEnd = addDays(cursor, chunkDays - 1);
        const boundedEnd = chunkEnd > end ? end : chunkEnd;
        chunks.push({ startDate: cursor, endDate: boundedEnd });
        cursor = addDays(boundedEnd, 1);
    }
    return chunks;
}

function positiveIntEnv(name: string, fallback: number): number {
    const value = Number(process.env[name] || fallback);
    return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

const FETCH_CONCURRENCY = positiveIntEnv('GOOGLE_ADS_REFRESH_FETCH_CONCURRENCY', DEFAULT_FETCH_CONCURRENCY);

function lookbackStart(endDate: string, days: number): string {
    return addDays(endDate, -(days - 1));
}

function changeHistoryWindow(): { startDate: string; endDate: string } {
    const today = new Date();
    return {
        startDate: isoDate(new Date(today.getTime() - 28 * 86400000)),
        endDate: isoDate(today)
    };
}

async function determineRefreshWindow(db: Pool): Promise<{ startDate: string; endDate: string; kind: WarehouseRefreshKind }> {
    assertDate(endDateStr, 'endDate');
    const explicitRepair = Boolean(startDateStr);
    const warehouseEmpty = !(await hasWarehouseData(db));

    if (backfill || warehouseEmpty) {
        const configuredStart = backfillStartDate || startDateStr || process.env.GOOGLE_ADS_WAREHOUSE_START_DATE || '';
        if (!configuredStart) {
            throw new Error('No warehouse data found. Run with --backfill-start-date or set GOOGLE_ADS_WAREHOUSE_START_DATE.');
        }
        assertDate(configuredStart, 'backfillStartDate');
        return { startDate: configuredStart, endDate: endDateStr, kind: 'backfill' };
    }

    if (explicitRepair) {
        assertDate(startDateStr, 'startDate');
        return { startDate: startDateStr, endDate: endDateStr, kind: 'repair' };
    }

    const lookbackDays = startup
        ? positiveIntEnv('GOOGLE_ADS_STARTUP_LOOKBACK_DAYS', DEFAULT_STARTUP_LOOKBACK_DAYS)
        : positiveIntEnv('GOOGLE_ADS_MUTABLE_LOOKBACK_DAYS', DEFAULT_LOOKBACK_DAYS);

    return {
        startDate: lookbackStart(endDateStr, lookbackDays),
        endDate: endDateStr,
        kind: process.env.GOOGLE_ADS_REFRESH_KIND === 'cron' ? 'cron' : 'manual'
    };
}

function formatQuery(reportDef: any, window: { startDate: string; endDate: string; targetDate: string; changeStartDate: string; changeEndDate: string }): string {
    const fields = reportDef.fields.join(', ');
    const conditions = (reportDef.conditions || []).map((condition: string) => condition
        .replace(/<START_DATE>/g, window.startDate)
        .replace(/<END_DATE>/g, window.endDate)
        .replace(/<YYYY-MM-DD>/g, window.targetDate)
        .replace(/<CHANGE_START_DATE>/g, window.changeStartDate)
        .replace(/<CHANGE_END_DATE>/g, window.changeEndDate));
    const condStr = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const orderStr = reportDef.orderings ? ` ORDER BY ${reportDef.orderings.join(', ')}` : '';
    const limit = Number(reportDef.limit || 0);
    const limitStr = Number.isFinite(limit) && limit > 0 ? ` LIMIT ${Math.min(Math.floor(limit), 10000)}` : '';
    return `SELECT ${fields} FROM ${reportDef.resource}${condStr}${orderStr}${limitStr}`;
}

function reportUses(reportDef: any, token: string): boolean {
    return (reportDef.conditions || []).some((condition: string) => String(condition).includes(token));
}

interface ReportJob {
    reportName: string;
    reportDef: any;
    startDate: string | null;
    endDate: string | null;
    targetDate: string;
    coverageStartDate: string | null;
    coverageEndDate: string | null;
}

function buildReportJobs(reports: Record<string, any>, startDate: string, endDate: string): ReportJob[] {
    const jobs: ReportJob[] = [];
    const today = isoDate(new Date());
    for (const [reportName, reportDef] of Object.entries(reports)) {
        if (reportDef.external || WAREHOUSE_SKIPPED_REPORTS.has(reportName)) continue;
        if (reportName === 'change_history') {
            jobs.push({ reportName, reportDef, startDate: null, endDate: null, targetDate, coverageStartDate: null, coverageEndDate: null });
            continue;
        }
        if (reportUses(reportDef, '<YYYY-MM-DD>')) {
            const maxLookbackDays = Math.floor(Number(reportDef.max_lookback_days || 0));
            const minDate = maxLookbackDays > 0 ? lookbackStart(today, maxLookbackDays) : startDate;
            const dayStart = startDate < minDate ? minDate : startDate;
            const dayEnd = reportDef.no_future_dates === true && endDate > today ? today : endDate;
            if (dayStart > dayEnd) continue;
            for (const date of daysBetween(dayStart, dayEnd)) {
                jobs.push({ reportName, reportDef, startDate: date, endDate: date, targetDate: date, coverageStartDate: date, coverageEndDate: date });
            }
            continue;
        }
        if (reportUses(reportDef, '<START_DATE>') || reportUses(reportDef, '<END_DATE>')) {
            for (const chunk of dateChunks(startDate, endDate)) {
                jobs.push({
                    reportName,
                    reportDef,
                    startDate: chunk.startDate,
                    endDate: chunk.endDate,
                    targetDate: chunk.endDate,
                    coverageStartDate: chunk.startDate,
                    coverageEndDate: chunk.endDate
                });
            }
            continue;
        }
        jobs.push({ reportName, reportDef, startDate: null, endDate: null, targetDate, coverageStartDate: null, coverageEndDate: null });
    }
    return jobs;
}

async function runLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const item = items[cursor++];
            await worker(item);
        }
    });
    await Promise.all(workers);
}

function rowCountByDate(rows: any[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const row of rows) {
        const date = String(row?.['segments.date'] || '').slice(0, 10);
        if (!date) continue;
        counts.set(date, (counts.get(date) || 0) + 1);
    }
    return counts;
}

function aggregateSummary(sourceSummary: Record<string, any>, reportName: string, update: { status: string; rows?: number; error?: string | null; startDate?: string | null; endDate?: string | null }): void {
    const current = sourceSummary[reportName] || { status: 'ok', rows: 0, windows: 0, failedWindows: 0, errors: [] };
    current.rows += Number(update.rows || 0);
    current.windows += 1;
    if (update.status === 'failed') {
        current.status = 'failed';
        current.failedWindows += 1;
        if (update.error) current.errors.push(update.error);
    } else if (current.status !== 'failed' && update.status === 'empty' && current.rows === 0) {
        current.status = 'empty';
    } else if (current.status !== 'failed') {
        current.status = 'ok';
    }
    current.lastWindow = { startDate: update.startDate || null, endDate: update.endDate || null };
    sourceSummary[reportName] = current;
}

async function persistMappedRows(db: Pool, customerId: string, mapped: MappedReportRows, startDate: string | null, endDate: string | null, runId: string): Promise<void> {
    if (mapped.accountDaily) await replaceAccountDailyWindow(db, customerId, startDate!, endDate!, mapped.accountDaily, runId);
    if (mapped.campaignDaily) await replaceCampaignDailyWindow(db, customerId, startDate!, endDate!, mapped.campaignDaily, runId);
    if (mapped.adGroupDaily) await replaceAdGroupDailyWindow(db, customerId, startDate!, endDate!, mapped.adGroupDaily, runId);
    if (mapped.keywordDaily) await replaceKeywordDailyWindow(db, customerId, startDate!, endDate!, mapped.keywordDaily, runId);
    if (mapped.searchTermDaily) await replaceSearchTermDailyWindow(db, customerId, startDate!, endDate!, mapped.searchTermDaily, runId);
    if (mapped.deviceDaily) await replaceDeviceDailyWindow(db, customerId, startDate!, endDate!, mapped.deviceDaily, runId);
    if (mapped.dayOfWeekDaily) await replaceDayOfWeekDailyWindow(db, customerId, startDate!, endDate!, mapped.dayOfWeekDaily, runId);
    if (mapped.dayHourDaily) await replaceDayHourDailyWindow(db, customerId, startDate!, endDate!, mapped.dayHourDaily, runId);
    if (mapped.landingPageDaily) await replaceLandingPageDailyWindow(db, customerId, startDate!, endDate!, mapped.landingPageDaily, runId);
    if (mapped.expandedLandingPageDaily) await replaceExpandedLandingPageDailyWindow(db, customerId, startDate!, endDate!, mapped.expandedLandingPageDaily, runId);
    if (mapped.conversionActionDaily) await replaceConversionActionDailyWindow(db, customerId, startDate!, endDate!, mapped.conversionActionDaily, runId);
    if (mapped.conversionAdGroupDaily) await replaceConversionAdGroupDailyWindow(db, customerId, startDate!, endDate!, mapped.conversionAdGroupDaily, runId);
    if (mapped.conversionSearchTermDaily) await replaceConversionSearchTermDailyWindow(db, customerId, startDate!, endDate!, mapped.conversionSearchTermDaily, runId);
    if (mapped.clickEvidenceDaily) await replaceClickEvidenceDailyWindow(db, customerId, startDate!, mapped.clickEvidenceDaily, runId);
    if (mapped.campaignSnapshot) await replaceCampaignSnapshot(db, customerId, mapped.campaignSnapshot, runId);
    if (mapped.adGroupSnapshot) await replaceAdGroupSnapshot(db, customerId, mapped.adGroupSnapshot, runId);
    if (mapped.configuredKeywords) await replaceConfiguredKeywordsSnapshot(db, customerId, mapped.configuredKeywords, runId);
    if (mapped.qualityScores) await replaceQualityScoreSnapshot(db, customerId, mapped.qualityScores, runId);
    if (mapped.campaignNegatives) await replaceCampaignNegativesSnapshot(db, customerId, mapped.campaignNegatives, runId);
    if (mapped.adGroupNegatives) await replaceAdGroupNegativesSnapshot(db, customerId, mapped.adGroupNegatives, runId);
    if (mapped.accountNegativeLists) await replaceAccountNegativeListsSnapshot(db, customerId, mapped.accountNegativeLists, runId);
    if (mapped.sharedNegativeSets) await replaceSharedNegativeSetsSnapshot(db, customerId, mapped.sharedNegativeSets, runId);
    if (mapped.sharedNegativeCriteria) await replaceSharedNegativeCriteriaSnapshot(db, customerId, mapped.sharedNegativeCriteria, runId);
    if (mapped.campaignSharedSets) await replaceCampaignSharedSetsSnapshot(db, customerId, mapped.campaignSharedSets, runId);
}

async function plannerCacheStatus(db: Pool, customerId: string): Promise<{ fresh: boolean; ideas: number; historicalMetrics: number; ageHours: number | null }> {
    const intervalHours = Math.max(0, Number(process.env.KEYWORD_PLANNER_REFRESH_INTERVAL_HOURS || 24));
    if (intervalHours === 0) return { fresh: false, ideas: 0, historicalMetrics: 0, ageHours: null };
    const [ideas, historical] = await Promise.all([
        db.query(`SELECT COUNT(*)::int AS rows, MAX(fetched_at) AS fetched_at FROM google_ads_keyword_planner_ideas WHERE customer_id = $1`, [customerId]),
        db.query(`SELECT COUNT(*)::int AS rows, MAX(fetched_at) AS fetched_at FROM google_ads_keyword_planner_historical WHERE customer_id = $1`, [customerId])
    ]);
    const maxFetched = [ideas.rows[0]?.fetched_at, historical.rows[0]?.fetched_at]
        .filter(Boolean)
        .map(value => new Date(value).getTime())
        .sort((a, b) => b - a)[0];
    if (!maxFetched) return { fresh: false, ideas: 0, historicalMetrics: 0, ageHours: null };
    const ageHours = (Date.now() - maxFetched) / 3_600_000;
    return {
        fresh: ageHours < intervalHours,
        ideas: Number(ideas.rows[0]?.rows || 0),
        historicalMetrics: Number(historical.rows[0]?.rows || 0),
        ageHours
    };
}

function auctionEntityPayload(customerId: string, reportRows: Map<string, any[]>): any {
    const campaignRows = reportRows.get('campaign_config') || reportRows.get('campaign_performance') || [];
    const adGroupRows = reportRows.get('ad_group_config') || reportRows.get('ad_group_performance') || [];
    return {
        meta: { accountId: customerId },
        campaigns: campaignRows.map(row => ({
            id: row['campaign.id'],
            name: row['campaign.name'],
            status: row['campaign.status']
        })),
        adGroups: adGroupRows.map(row => ({
            id: row['ad_group.id'],
            name: row['ad_group.name'],
            status: row['ad_group.status'],
            campaignId: row['campaign.id'],
            campaign: row['campaign.name']
        }))
    };
}

async function run() {
    if (!pool) throw new Error('DATABASE_URL is required for the DB-backed Google Ads warehouse refresh.');

    const refreshRunId = `refresh_${crypto.randomUUID()}`;
    const warehouseRunId = `warehouse_${crypto.randomUUID()}`;
    const sourceSummary: Record<string, any> = {};
    let legacyRunInserted = false;
    let warehouseRunInserted = false;
    let effectiveStartDate = '';
    let effectiveEndDate = '';
    let customerId: string | null = null;

    try {
        await ensureDatabaseSchema(pool);
        await ensureAdsWarehouseSchema(pool);

        if (forceClear) {
            await pool.query(
                `UPDATE data_refresh_runs
                 SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error = 'Forced clear by refresh script'
                 WHERE status = 'running'`
            );
            await pool.query(
                `UPDATE google_ads_refresh_runs
                 SET status = 'failed', completed_at = now(), error = 'Forced clear by refresh script'
                 WHERE status = 'running'`
            );
        }

        const window = await determineRefreshWindow(pool);
        effectiveStartDate = window.startDate;
        effectiveEndDate = window.endDate;
        if (effectiveStartDate > effectiveEndDate) throw new Error('startDate must be before or equal to endDate.');
        const startupLabel = startup && window.kind === 'manual' ? ' startup' : '';
        console.log(`Using ${window.kind}${startupLabel} warehouse refresh window: ${effectiveStartDate} to ${effectiveEndDate}`);

        const legacyInsert = await pool.query(
            `INSERT INTO data_refresh_runs (id, status, start_date, end_date, source_summary)
             SELECT $1, 'running', $2, $3, '{}'::jsonb
             WHERE NOT EXISTS (
                 SELECT 1 FROM data_refresh_runs
                 WHERE status = 'running'
                   AND started_at > CURRENT_TIMESTAMP - INTERVAL '20 minutes'
             )
             RETURNING id`,
            [refreshRunId, effectiveStartDate, effectiveEndDate]
        );
        legacyRunInserted = Boolean(legacyInsert.rowCount);
        if (!legacyRunInserted) {
            console.log('Another refresh is already running. Exiting without side effects.');
            return;
        }

        await startWarehouseRefreshRun(pool, {
            id: warehouseRunId,
            kind: window.kind,
            requestedStartDate: startDateStr || backfillStartDate || null,
            requestedEndDate: endDateStr || null
        });
        warehouseRunInserted = true;

        const token = await getAccessToken();
        customerId = await getAccessibleCustomer(token);
        sourceSummary.customerId = customerId;
        console.log(`Using customer ID: ${customerId}`);

        const changeWindow = changeHistoryWindow();
        const reportDoc = yaml.load(fs.readFileSync(REPORTS_YML, 'utf8')) as any;
        const reportRows = new Map<string, any[]>();
        const jobs = buildReportJobs(reportDoc.reports, effectiveStartDate, effectiveEndDate);

        await runLimited(jobs, FETCH_CONCURRENCY, async job => {
            const windowForQuery = {
                startDate: job.startDate || effectiveStartDate,
                endDate: job.endDate || effectiveEndDate,
                targetDate: job.targetDate,
                changeStartDate: changeWindow.startDate,
                changeEndDate: changeWindow.endDate
            };
            console.log(`Running report: ${job.reportName}${job.startDate ? ` (${job.startDate} to ${job.endDate})` : ''}...`);
            try {
                const query = formatQuery(job.reportDef, windowForQuery);
                const rows = await executeGaql(token, customerId!, query);
                const existing = reportRows.get(job.reportName) || [];
                existing.push(...rows);
                reportRows.set(job.reportName, existing);

                if (job.reportName === 'change_history') {
                    const archived = await archiveChangeHistoryRows(pool, rows);
                    sourceSummary.change_history_archive = { status: 'ok', rows: archived };
                } else {
                    const mapped = mapReportRows(job.reportName, customerId!, rows);
                    await persistMappedRows(pool, customerId!, mapped, job.startDate, job.endDate, warehouseRunId);
                }

                await recordReportFetch(pool, {
                    runId: warehouseRunId,
                    customerId: customerId!,
                    reportName: job.reportName,
                    status: rows.length ? 'ok' : 'empty',
                    startDate: job.startDate,
                    endDate: job.endDate,
                    rowsFetched: rows.length
                });
                if (job.coverageStartDate && job.coverageEndDate) {
                    await markReportCoverage(pool, {
                        runId: warehouseRunId,
                        customerId: customerId!,
                        reportName: job.reportName,
                        startDate: job.coverageStartDate,
                        endDate: job.coverageEndDate,
                        status: rows.length ? 'covered' : 'empty',
                        rowCountByDate: rowCountByDate(rows)
                    });
                }
                aggregateSummary(sourceSummary, job.reportName, {
                    status: rows.length ? 'ok' : 'empty',
                    rows: rows.length,
                    startDate: job.startDate,
                    endDate: job.endDate
                });
                console.log(` -> Stored ${rows.length} ${job.reportName} rows in warehouse`);
            } catch (err: any) {
                const message = err?.message || String(err);
                console.log(` -> Failed ${job.reportName}: ${message}`);
                await recordReportFetch(pool, {
                    runId: warehouseRunId,
                    customerId: customerId!,
                    reportName: job.reportName,
                    status: 'failed',
                    startDate: job.startDate,
                    endDate: job.endDate,
                    rowsFetched: 0,
                    error: message
                });
                if (job.coverageStartDate && job.coverageEndDate) {
                    await markReportCoverage(pool, {
                        runId: warehouseRunId,
                        customerId: customerId!,
                        reportName: job.reportName,
                        startDate: job.coverageStartDate,
                        endDate: job.coverageEndDate,
                        status: 'failed',
                        error: message
                    });
                }
                aggregateSummary(sourceSummary, job.reportName, {
                    status: 'failed',
                    rows: 0,
                    error: message,
                    startDate: job.startDate,
                    endDate: job.endDate
                });
            }
        });

        console.log('Fetching Keyword Planner enrichment...');
        const plannerCache = await plannerCacheStatus(pool, customerId);
        if (plannerCache.fresh) {
            sourceSummary.keyword_planner = {
                status: 'cached',
                ideas: plannerCache.ideas,
                historicalMetrics: plannerCache.historicalMetrics,
                message: `Using cached Keyword Planner data (${plannerCache.ageHours?.toFixed(1)} hours old).`
            };
        } else {
            const plannerResult = await refreshKeywordPlannerFeed({
                token,
                customerId,
                keywordRows: reportRows.get('keyword_performance') || [],
                searchTermRows: reportRows.get('search_term_performance') || []
            });
            if (plannerResult.status === 'ok' || plannerResult.status === 'empty') {
                await replaceKeywordPlannerIdeas(pool, customerId, mapKeywordPlannerIdeas(customerId, plannerResult.ideas));
                await replaceKeywordPlannerHistorical(pool, customerId, mapKeywordPlannerHistorical(customerId, plannerResult.historicalMetrics));
            }
            await recordReportFetch(pool, {
                runId: warehouseRunId,
                customerId,
                reportName: 'keyword_planner',
                status: plannerResult.status === 'failed' ? 'failed' : plannerResult.ideas.length || plannerResult.historicalMetrics.length ? 'ok' : 'empty',
                rowsFetched: plannerResult.ideas.length + plannerResult.historicalMetrics.length,
                error: plannerResult.status === 'failed' ? plannerResult.message : null
            });
            sourceSummary.keyword_planner = {
                status: plannerResult.status,
                ideas: plannerResult.ideas.length,
                historicalMetrics: plannerResult.historicalMetrics.length,
                seeds: plannerResult.seeds,
                message: plannerResult.message
            };
        }

        console.log('Fetching Auction Insights external feed...');
        const auctionResult = await fetchAuctionInsightsFeed(null, {
            pool,
            entities: buildAuctionInsightsEntities(auctionEntityPayload(customerId, reportRows)),
            statusOutputPath: null
        });
        await replaceAuctionInsightsRows(pool, customerId, mapAuctionInsightRows(customerId, auctionResult.rows));
        await replaceAuctionInsightsStatus(pool, customerId, mapAuctionInsightStatus(customerId, auctionResult.statuses));
        await recordReportFetch(pool, {
            runId: warehouseRunId,
            customerId,
            reportName: 'auction_insights_domains',
            status: auctionResult.rows.length ? 'ok' : auctionResult.source === 'none' ? 'empty' : 'ok',
            rowsFetched: auctionResult.rows.length
        });
        sourceSummary.auction_insights_domains = {
            status: auctionResult.source === 'none' ? 'missing' : 'ok',
            source: auctionResult.source,
            rows: auctionResult.rows.length,
            entities: auctionResult.statuses.map(status => ({
                entityType: status.entityType,
                entityId: status.entityId,
                entityName: status.entityName,
                status: status.status,
                rows: status.rows,
                sheetName: status.sheetName
            })),
            message: auctionResult.message
        };

        console.log('Generating DB-backed deterministic candidate signals...');
        const signalResult = await generateCandidateSignals(pool, {
            runId: warehouseRunId,
            useExistingRun: true,
            ensureSchemas: false
        });
        sourceSummary.candidate_signals = {
            status: 'ok',
            rows: signalResult.signals.length,
            message: 'Generated from DB warehouse in-process.'
        };

        const failedReports = Object.entries(sourceSummary)
            .filter(([name, result]: [string, any]) => name !== 'customerId' && result?.status === 'failed')
            .map(([name]) => name);
        const finalStatus = failedReports.length ? 'partial' : 'succeeded';
        await completeWarehouseRefreshRun(pool, warehouseRunId, {
            status: finalStatus,
            customerId,
            effectiveStartDate,
            effectiveEndDate,
            sourceSummary: { ...sourceSummary, failedReports }
        });
        await pool.query(
            `UPDATE data_refresh_runs
             SET status = $2, completed_at = CURRENT_TIMESTAMP, customer_id = $3, source_summary = $4
             WHERE id = $1`,
            [refreshRunId, finalStatus, customerId, { ...sourceSummary, failedReports, warehouseRunId }]
        );
        console.log(failedReports.length
            ? `Warehouse refresh completed partially. Failed reports: ${failedReports.join(', ')}`
            : 'Warehouse refresh completed cleanly.');
    } catch (err: any) {
        const message = err?.message || String(err);
        console.error('\nPipeline Error: warehouse refresh halted gracefully.');
        console.error(message);
        if (warehouseRunInserted) {
            await completeWarehouseRefreshRun(pool, warehouseRunId, {
                status: 'failed',
                customerId,
                effectiveStartDate: effectiveStartDate || null,
                effectiveEndDate: effectiveEndDate || null,
                sourceSummary,
                error: message
            }).catch(() => undefined);
        }
        if (legacyRunInserted) {
            await pool.query(
                `UPDATE data_refresh_runs
                 SET status = 'failed', completed_at = CURRENT_TIMESTAMP, source_summary = $2, error = $3
                 WHERE id = $1`,
                [refreshRunId, sourceSummary, message]
            ).catch(() => undefined);
        }
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

run();
