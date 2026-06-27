import dotenv from 'dotenv';
dotenv.config();

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import crypto from 'crypto';
import { Pool } from 'pg';
import { getAccessToken, getAccessibleCustomer, executeGaql } from '../lib/googleAds';
import { buildAuctionInsightsEntities, fetchAuctionInsightsFeed, writeJsonAtomic } from '../lib/auctionInsights';
import { ensureDatabaseSchema } from '../lib/proposals';
import { refreshKeywordPlannerFeed } from '../lib/googleKeywordPlanner';
import { archiveChangeHistoryRows } from '../lib/changeHistory';

const ROOT = path.resolve(__dirname, '..'); // Handle path correctly on Render and locally
const DATA_DIR = path.join(ROOT, 'data', 'latest');
const REPORTS_YML = path.join(ROOT, 'config', 'reports.yml');
const AUCTION_INSIGHTS_FILE = path.join(DATA_DIR, 'auction-insights-domains.json');
const AUCTION_INSIGHTS_STATUS_FILE = path.join(DATA_DIR, 'auction-insights-status.json');
const KEYWORD_PLANNER_IDEAS_FILE = path.join(DATA_DIR, 'keyword-planner-ideas.json');
const KEYWORD_PLANNER_HISTORICAL_FILE = path.join(DATA_DIR, 'keyword-planner-historical-metrics.json');
const KEYWORD_PLANNER_STATUS_FILE = path.join(DATA_DIR, 'keyword-planner-status.json');

const pool = process.env.DATABASE_URL ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
}) : null;

// Parse CLI arguments for dynamic date
let targetDate = new Date().toISOString().slice(0, 10);
let startDateStr = '';
let endDateStr = '';
let forceClear = false;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) targetDate = args[i + 1];
    if (args[i] === '--start-date' && args[i + 1]) startDateStr = args[i + 1];
    if (args[i] === '--end-date' && args[i + 1]) endDateStr = args[i + 1];
    if (args[i] === '--force-clear') forceClear = true;
}

if (!endDateStr) endDateStr = new Date().toISOString().slice(0, 10);
if (!startDateStr) {
    const today = new Date();
    // Default to last 90 days
    const ninetyDaysAgo = new Date(today.getTime() - 90 * 86400000);
    startDateStr = ninetyDaysAgo.toISOString().slice(0, 10);
}

const todayForChangeHistory = new Date();
const changeHistoryStartDate = new Date(todayForChangeHistory.getTime() - 28 * 86400000);
const changeHistoryStartStr = changeHistoryStartDate.toISOString().slice(0, 10);
const changeHistoryEndStr = todayForChangeHistory.toISOString().slice(0, 10);

console.log(`Using target date: ${targetDate} for daily reports.`);
console.log(`Using date range: ${startDateStr} to ${endDateStr} for standard reports.`);
console.log(`Using change history range: ${changeHistoryStartStr} to ${changeHistoryEndStr}.`);

fs.mkdirSync(DATA_DIR, { recursive: true });

function formatQuery(reportDef: any): string {
    const fields = reportDef.fields.join(', ');

    // Format dates in conditions
    let conditions: string[] = reportDef.conditions || [];
    conditions = conditions.map(c => c.replace(/<START_DATE>/g, startDateStr)
        .replace(/<END_DATE>/g, endDateStr)
        .replace(/<YYYY-MM-DD>/g, targetDate)
        .replace(/<CHANGE_START_DATE>/g, changeHistoryStartStr)
        .replace(/<CHANGE_END_DATE>/g, changeHistoryEndStr));

    const condStr = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const orderStr = reportDef.orderings ? ` ORDER BY ${reportDef.orderings.join(', ')}` : '';
    const limit = Number(reportDef.limit || 0);
    const limitStr = Number.isFinite(limit) && limit > 0 ? ` LIMIT ${Math.min(Math.floor(limit), 10000)}` : '';

    return `SELECT ${fields} FROM ${reportDef.resource}${condStr}${orderStr}${limitStr}`;
}

function readJsonArray(fileName: string): any[] {
    try {
        const filePath = path.join(DATA_DIR, fileName);
        if (!fs.existsSync(filePath)) return [];
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function readJsonFile(filePath: string): any {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function keywordPlannerCache(): { fresh: boolean; status: any; ageHours: number | null } {
    const intervalHours = Math.max(0, Number(process.env.KEYWORD_PLANNER_REFRESH_INTERVAL_HOURS || 24));
    if (intervalHours === 0) return { fresh: false, status: null, ageHours: null };
    if (!fs.existsSync(KEYWORD_PLANNER_IDEAS_FILE) || !fs.existsSync(KEYWORD_PLANNER_HISTORICAL_FILE) || !fs.existsSync(KEYWORD_PLANNER_STATUS_FILE)) {
        return { fresh: false, status: null, ageHours: null };
    }
    const status = readJsonFile(KEYWORD_PLANNER_STATUS_FILE);
    if (!status || status.status !== 'ok') return { fresh: false, status, ageHours: null };
    const ageHours = (Date.now() - fs.statSync(KEYWORD_PLANNER_STATUS_FILE).mtimeMs) / 3_600_000;
    return { fresh: ageHours < intervalHours, status, ageHours };
}

function auctionEntityPayload(customerId: string): any {
    const campaigns = readJsonArray('campaign-performance.json').map(row => ({
        id: row['campaign.id'],
        name: row['campaign.name'],
        status: row['campaign.status']
    }));
    const adGroups = readJsonArray('ad-group-performance.json').map(row => ({
        id: row['ad_group.id'],
        name: row['ad_group.name'],
        status: row['ad_group.status'],
        campaignId: row['campaign.id'],
        campaign: row['campaign.name']
    }));
    return {
        meta: { accountId: customerId },
        campaigns,
        adGroups
    };
}

/**
 * Runs a shell script asynchronously, piping stdout/stderr to the main process,
 * and resolves or rejects based on the exit code.
 */
function runScriptAsync(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'inherit' });

        child.on('error', (err) => {
            reject(new Error(`Failed to spawn process: ${err.message}`));
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Command '${command} ${args.join(' ')}' exited with code ${code}`));
            }
        });
    });
}

async function run() {
    const refreshRunId = `refresh_${crypto.randomUUID()}`;
    const sourceSummary: Record<string, any> = {};
    try {
        if (pool) {
            await ensureDatabaseSchema(pool);

            if (forceClear) {
                console.log('Force-clearing any stale running data refresh runs...');
                await pool.query(
                    `UPDATE data_refresh_runs 
                     SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error = 'Forced clear on startup' 
                     WHERE status = 'running'`
                );
            }

            // Atomically check if another refresh is running (started in the last 20 minutes)
            // and insert the new run record if it is safe to proceed.
            const result = await pool.query(
                `INSERT INTO data_refresh_runs (id, status, start_date, end_date, source_summary)
                 SELECT $1, 'running', $2, $3, '{}'::jsonb
                 WHERE NOT EXISTS (
                     SELECT 1 FROM data_refresh_runs
                     WHERE status = 'running'
                       AND started_at > CURRENT_TIMESTAMP - INTERVAL '20 minutes'
                 )
                 RETURNING id`,
                [refreshRunId, startDateStr, endDateStr]
            );

            const inserted = result.rowCount ? result.rowCount > 0 : false;
            if (!inserted) {
                console.log('Another refresh is already running. Exiting without side effects.');
                return;
            }
        }

        const token = await getAccessToken();
        const customerId = await getAccessibleCustomer(token);
        console.log(`Using customer ID: ${customerId}`);
        sourceSummary.customerId = customerId;

        const doc = yaml.load(fs.readFileSync(REPORTS_YML, 'utf8')) as any;
        const reports = doc.reports;

        const reportPromises = Object.entries(reports)
            .filter(([reportName, reportDef]: [string, any]) => reportName !== 'auction_insights_domains' && !reportDef.external)
            .map(async ([reportName, reportDef]) => {
            const fileName = reportName.replace(/_/g, '-') + '.json';
            const filePath = path.join(DATA_DIR, fileName);
            console.log(`Running report: ${reportName}...`);

            try {
                const query = formatQuery(reportDef);
                const data = await executeGaql(token, customerId, query);
                writeJsonAtomic(filePath, data);
                console.log(` -> Saved to ${fileName} (${data.length} rows)`);
                sourceSummary[reportName] = { status: 'ok', rows: data.length };
            } catch (err: any) {
                console.log(` -> Failed ${reportName}: ${err.message}`);
                sourceSummary[reportName] = { status: 'failed', error: err.message };
                if (!fs.existsSync(filePath)) {
                    writeJsonAtomic(filePath, []); // Write empty array on failure if no file exists
                } else {
                    console.log(` -> Preserved existing local file: ${fileName}`);
                }
            }
        });

        await Promise.all(reportPromises);
        if (pool) {
            const archivedChangeRows = await archiveChangeHistoryRows(pool, readJsonArray('change-history.json'));
            sourceSummary.change_history_archive = { status: 'ok', rows: archivedChangeRows };
            console.log(`Archived ${archivedChangeRows} Google Ads change-history rows.`);
        }

        const failedReports = Object.entries(sourceSummary)
            .filter(([name, result]: [string, any]) => name !== 'customerId' && result?.status === 'failed')
            .map(([name]) => name);

        console.log('Fetching Keyword Planner enrichment...');
        const plannerCache = keywordPlannerCache();
        if (plannerCache.fresh) {
            sourceSummary.keyword_planner = {
                status: 'cached',
                ideas: plannerCache.status?.ideas || 0,
                historicalMetrics: plannerCache.status?.historicalMetrics || 0,
                seeds: plannerCache.status?.seeds || null,
                message: `Using cached Keyword Planner data (${plannerCache.ageHours?.toFixed(1)} hours old).`
            };
            console.log(` -> ${sourceSummary.keyword_planner.message}`);
        } else {
            const plannerResult = await refreshKeywordPlannerFeed({
                token,
                customerId,
                keywordRows: readJsonArray('keyword-performance.json'),
                searchTermRows: readJsonArray('search-term-performance.json'),
                ideasOutputPath: KEYWORD_PLANNER_IDEAS_FILE,
                historicalOutputPath: KEYWORD_PLANNER_HISTORICAL_FILE,
                statusOutputPath: KEYWORD_PLANNER_STATUS_FILE
            });
            sourceSummary.keyword_planner = {
                status: plannerResult.status,
                ideas: plannerResult.ideas.length,
                historicalMetrics: plannerResult.historicalMetrics.length,
                seeds: plannerResult.seeds,
                message: plannerResult.message
            };
            console.log(` -> ${plannerResult.message}`);
        }

        console.log('Fetching Auction Insights external feed...');
        const auctionResult = await fetchAuctionInsightsFeed(AUCTION_INSIGHTS_FILE, {
            pool,
            entities: buildAuctionInsightsEntities(auctionEntityPayload(customerId)),
            statusOutputPath: AUCTION_INSIGHTS_STATUS_FILE
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
        console.log(` -> ${auctionResult.message}`);

        console.log('Running rule engines and checkers in parallel...');
        await Promise.all([
            runScriptAsync('bun', ['run', path.join(ROOT, 'scripts', 'deterministic_rules.ts')]),
            runScriptAsync('bun', ['run', path.join(ROOT, 'scripts', 'telemetry_checker.ts')]),
            runScriptAsync('bun', ['run', path.join(ROOT, 'scripts', 'impact_evaluator.ts')])
        ]);

        console.log('Rebuilding dashboard payload...');
        await runScriptAsync('bun', ['run', path.join(ROOT, 'scripts', 'build_dashboard_payload.ts'), '--start-date', startDateStr, '--end-date', endDateStr]);

        if (pool) {
            const finalStatus = failedReports.length > 0 ? 'partial' : 'succeeded';
            await pool.query(
                `UPDATE data_refresh_runs
                 SET status = $2, completed_at = CURRENT_TIMESTAMP, customer_id = $3, source_summary = $4
                 WHERE id = $1`,
                [refreshRunId, finalStatus, customerId, { ...sourceSummary, failedReports }]
            );
        }
        if (failedReports.length > 0) {
            console.log(`Pipeline completed with preserved/stale data for failed reports: ${failedReports.join(', ')}`);
        } else {
            console.log('Success! Pipeline execution completed cleanly.');
        }
    } catch (err: any) {
        console.error('\n❌ Pipeline Error: Data refresh halted gracefully.');
        console.error(err.message);
        if (pool) {
            await pool.query(
                `UPDATE data_refresh_runs
                 SET status = 'failed', completed_at = CURRENT_TIMESTAMP, source_summary = $2, error = $3
                 WHERE id = $1`,
                [refreshRunId, sourceSummary, err.message]
            ).catch(() => undefined);
        }
        // We exit with code 1 so the calling server knows it failed, but we do not throw a raw stack trace.
        process.exitCode = 1;
    } finally {
        if (pool) await pool.end();
    }
}

run();
