import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { buildDashboardPayloadFromBundle } from '../lib/dashboardPayload.ts';
import {
    clearAdsWarehouseRuntimeCaches,
    dashboardCacheKey,
    ensureAdsWarehouseSchema,
    getCachedDashboardPayload,
    getCoverageForWindow,
    getDashboardReportBundle,
    getImpactMetricWindow,
    getWarehouseWatermark,
    markReportCoverage,
    replaceCandidateSignals,
    replaceAdGroupDailyWindow,
    replaceCampaignDailyWindow,
    replaceKeywordDailyWindow,
    replaceSearchTermDailyWindow,
    setCachedDashboardPayload
} from '../lib/adsWarehouse.ts';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const testWithDb = TEST_DATABASE_URL ? test : test.skip;

function dates(start, days) {
    const [year, month, day] = start.split('-').map(Number);
    return Array.from({ length: days }, (_item, index) =>
        new Date(Date.UTC(year, month - 1, day + index)).toISOString().slice(0, 10)
    );
}

class FakeWarehouseDb {
    constructor() {
        this.queries = [];
        this.tables = {
            google_ads_campaign_daily: [],
            google_ads_ad_group_daily: [],
            google_ads_keyword_daily: [],
            google_ads_search_term_daily: [],
            google_ads_report_coverage: [],
            candidate_signals: [],
            google_ads_warehouse_slice_fingerprints: []
        };
    }

    async query(sql, params = []) {
        const compact = sql.replace(/\s+/g, ' ').trim();
        this.queries.push(compact);
        if (compact === 'DELETE FROM google_ads_warehouse_slice_fingerprints') {
            this.tables.google_ads_warehouse_slice_fingerprints = [];
            return { rows: [], rowCount: 0 };
        }
        if (compact === 'DELETE FROM google_ads_warehouse_slice_fingerprints WHERE customer_id = $1') {
            const before = this.tables.google_ads_warehouse_slice_fingerprints.length;
            this.tables.google_ads_warehouse_slice_fingerprints = this.tables.google_ads_warehouse_slice_fingerprints
                .filter(row => row.customer_id !== params[0]);
            return { rows: [], rowCount: before - this.tables.google_ads_warehouse_slice_fingerprints.length };
        }
        const deleteMatch = compact.match(/^DELETE FROM ([a-z_]+) WHERE customer_id = \$1 AND date BETWEEN \$2::date AND \$3::date/);
        if (deleteMatch) {
            const table = deleteMatch[1];
            const [customerId, startDate, endDate] = params;
            this.tables[table] = this.tables[table] || [];
            const before = this.tables[table].length;
            this.tables[table] = this.tables[table].filter(row =>
                row.customer_id !== customerId || row.date < startDate || row.date > endDate
            );
            return { rows: [], rowCount: before - this.tables[table].length };
        }

        const deleteCustomerMatch = compact.match(/^DELETE FROM ([a-z_]+) WHERE customer_id = \$1$/);
        if (deleteCustomerMatch) {
            const table = deleteCustomerMatch[1];
            const before = (this.tables[table] || []).length;
            this.tables[table] = (this.tables[table] || []).filter(row => row.customer_id !== params[0]);
            return { rows: [], rowCount: before - this.tables[table].length };
        }

        if (compact.startsWith('DELETE FROM candidate_signals WHERE')) {
            const before = this.tables.candidate_signals.length;
            this.tables.candidate_signals = this.tables.candidate_signals.filter(row => {
                if (row.customer_id !== params[0]) return true;
                if (row.evidence_start_date < params[1] || row.evidence_end_date > params[2]) return true;
                if (compact.includes('(campaign_id = $4 OR campaign_id IS NULL)')) {
                    const matchesCampaign = String(row.campaign_id || '') === String(params[3]) || !row.campaign_id;
                    if (!matchesCampaign) return true;
                }
                if (compact.includes('(ad_group_id = $5 OR ad_group_id IS NULL)')) {
                    const matchesAdGroup = String(row.ad_group_id || '') === String(params[4]) || !row.ad_group_id;
                    if (!matchesAdGroup) return true;
                }
                return false;
            });
            return { rows: [], rowCount: before - this.tables.candidate_signals.length };
        }

        const insert = compact.match(/^INSERT INTO ([a-z_]+) \(([^)]+)\)/);
        if (insert) {
            const table = insert[1];
            const columns = insert[2].split(',').map(column => column.trim());
            this.tables[table] = this.tables[table] || [];
            for (let index = 0; index < params.length; index += columns.length) {
                const row = {};
                columns.forEach((column, columnIndex) => {
                    row[column] = params[index + columnIndex];
                });
                if (table === 'google_ads_warehouse_slice_fingerprints') {
                    const key = existing => [
                        existing.customer_id,
                        existing.source_table,
                        existing.scope_level,
                        existing.slice_date,
                        existing.campaign_id,
                        existing.ad_group_id
                    ].join('|');
                    const rowKey = key(row);
                    const existingIndex = this.tables[table].findIndex(existing => key(existing) === rowKey);
                    if (existingIndex >= 0) this.tables[table][existingIndex] = row;
                    else this.tables[table].push(row);
                } else {
                    this.tables[table].push(row);
                }
            }
            return { rows: [], rowCount: params.length / columns.length };
        }

        const select = compact.match(/^SELECT .+ FROM ([a-z_]+)/);
        if (select) {
            return { rows: this.selectRows(select[1], compact, params) };
        }

        if (compact.includes('FROM google_ads_report_coverage')) return { rows: [] };
        return { rows: [] };
    }

    selectRows(table, sql, params) {
        const rows = [...(this.tables[table] || [])];
        return rows
            .filter(row => {
                if (sql.includes('customer_id = $1') && row.customer_id !== params[0]) return false;
                if (sql.includes('date BETWEEN $2::date AND $3::date') && (row.date < params[1] || row.date > params[2])) return false;
                if (sql.includes('coverage_date BETWEEN $2::date AND $3::date') && (row.coverage_date < params[1] || row.coverage_date > params[2])) return false;
                if (sql.includes('evidence_start_date >= $2::date') && row.evidence_start_date < params[1]) return false;
                if (sql.includes('evidence_end_date <= $3::date') && row.evidence_end_date > params[2]) return false;
                if (sql.includes('evidence_start_date <= $3::date') && row.evidence_start_date > params[2]) return false;
                if (sql.includes('evidence_end_date >= $2::date') && row.evidence_end_date < params[1]) return false;
                if (sql.includes('slice_date = $2 OR (slice_date >= $3 AND slice_date <= $4)')) {
                    if (row.slice_date !== params[1] && (row.slice_date < params[2] || row.slice_date > params[3])) return false;
                }
                if (sql.includes('campaign_id = $4') && String(row.campaign_id) !== String(params[3])) return false;
                if (sql.includes('ad_group_id = $5') && String(row.ad_group_id) !== String(params[4])) return false;
                if (sql.includes('present_in_latest_snapshot = true') && row.present_in_latest_snapshot !== true) return false;
                return true;
            })
            .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    }
}

function fixturePath(fileName) {
    return path.join(import.meta.dir, 'fixtures', 'warehouse', fileName);
}

function loadFixture(fileName) {
    return JSON.parse(fs.readFileSync(fixturePath(fileName), 'utf8'));
}

function windowDates(window) {
    const out = [];
    for (let date = window.startDate; date <= window.endDate; date = dates(date, 2)[1]) out.push(date);
    return out;
}

function campaignById(fixture, id) {
    return fixture.campaigns.find(campaign => campaign.id === id);
}

function adGroupRowsFromFixture(fixture, datesInWindow) {
    return fixture.adGroups.flatMap(adGroup => {
        const campaign = campaignById(fixture, adGroup.campaignId);
        return datesInWindow.map(date => ({
            customer_id: fixture.customerId,
            date,
            campaign_id: campaign.id,
            campaign_name: campaign.name,
            ad_group_id: adGroup.id,
            ad_group_name: adGroup.name,
            ad_group_status: adGroup.status,
            cost_micros: campaign.costMicrosPerDay,
            clicks: campaign.clicksPerDay,
            impressions: campaign.impressionsPerDay,
            conversions: campaign.conversionsPerDay,
            all_conversions: campaign.conversionsPerDay,
            raw_payload: {
                'customer.id': fixture.customerId,
                'segments.date': date,
                'campaign.id': campaign.id,
                'campaign.name': campaign.name,
                'ad_group.id': adGroup.id,
                'ad_group.name': adGroup.name
            }
        }));
    });
}

function campaignRowsFromFixture(fixture, datesInWindow) {
    return fixture.campaigns.flatMap(campaign => datesInWindow.map(date => ({
        customer_id: fixture.customerId,
        date,
        campaign_id: campaign.id,
        campaign_name: campaign.name,
        campaign_status: campaign.status,
        cost_micros: campaign.costMicrosPerDay,
        clicks: campaign.clicksPerDay,
        impressions: campaign.impressionsPerDay,
        conversions: campaign.conversionsPerDay,
        all_conversions: campaign.conversionsPerDay,
        conversions_value: campaign.conversionValuePerDay,
        raw_payload: {
            'customer.id': fixture.customerId,
            'segments.date': date,
            'campaign.id': campaign.id,
            'campaign.name': campaign.name,
            'campaign.status': campaign.status,
            'metrics.cost_micros': campaign.costMicrosPerDay,
            'metrics.clicks': campaign.clicksPerDay,
            'metrics.impressions': campaign.impressionsPerDay,
            'metrics.conversions': campaign.conversionsPerDay,
            'metrics.conversions_value': campaign.conversionValuePerDay
        }
    })));
}

function keywordRowsFromFixture(fixture, datesInWindow) {
    return fixture.configuredKeywords.flatMap(keyword => {
        const campaign = campaignById(fixture, keyword.campaignId);
        const adGroup = fixture.adGroups.find(row => row.id === keyword.adGroupId);
        return datesInWindow.map(date => ({
            customer_id: fixture.customerId,
            date,
            campaign_id: campaign.id,
            campaign_name: campaign.name,
            ad_group_id: adGroup.id,
            ad_group_name: adGroup.name,
            criterion_id: keyword.id,
            criterion_resource_name: `customers/${fixture.customerId}/adGroupCriteria/${adGroup.id}~${keyword.id}`,
            keyword_text: keyword.text,
            match_type: keyword.matchType,
            criterion_status: keyword.status,
            cost_micros: campaign.costMicrosPerDay,
            clicks: campaign.clicksPerDay,
            impressions: campaign.impressionsPerDay,
            conversions: campaign.conversionsPerDay,
            all_conversions: campaign.conversionsPerDay,
            raw_payload: {
                'customer.id': fixture.customerId,
                'segments.date': date,
                'campaign.id': campaign.id,
                'ad_group.id': adGroup.id,
                'ad_group_criterion.criterion_id': keyword.id,
                'ad_group_criterion.keyword.text': keyword.text
            }
        }));
    });
}

function searchTermRowsFromFixture(fixture, datesInWindow) {
    return fixture.searchTerms.flatMap(term => {
        const campaign = campaignById(fixture, term.campaignId);
        const adGroup = fixture.adGroups.find(row => row.id === term.adGroupId);
        const omitted = new Set(term.omitDates || []);
        return datesInWindow
            .filter(date => !omitted.has(date))
            .map(date => ({
                customer_id: fixture.customerId,
                date,
                dimension_hash: `${campaign.id}|${adGroup.id}|${term.term}|${date}`,
                campaign_id: campaign.id,
                campaign_name: campaign.name,
                ad_group_id: adGroup.id,
                ad_group_name: adGroup.name,
                search_term: term.term,
                matched_keyword_text: term.term,
                matched_keyword_match_type: 'EXACT',
                cost_micros: campaign.costMicrosPerDay,
                clicks: campaign.clicksPerDay,
                impressions: campaign.impressionsPerDay,
                conversions: campaign.conversionsPerDay,
                all_conversions: campaign.conversionsPerDay,
                raw_payload: {
                    'customer.id': fixture.customerId,
                    'segments.date': date,
                    'campaign.id': campaign.id,
                    'ad_group.id': adGroup.id,
                    'search_term_view.search_term': term.term
                }
            }));
    });
}

async function loadWarehouseFixture(db, fixture, window, runId) {
    const datesInWindow = windowDates(window);
    await replaceCampaignDailyWindow(db, fixture.customerId, window.startDate, window.endDate, campaignRowsFromFixture(fixture, datesInWindow), runId);
    await replaceAdGroupDailyWindow(db, fixture.customerId, window.startDate, window.endDate, adGroupRowsFromFixture(fixture, datesInWindow), runId);
    await replaceKeywordDailyWindow(db, fixture.customerId, window.startDate, window.endDate, keywordRowsFromFixture(fixture, datesInWindow), runId);
    await replaceSearchTermDailyWindow(db, fixture.customerId, window.startDate, window.endDate, searchTermRowsFromFixture(fixture, datesInWindow), runId);
}

function duplicatePkCount(rows, keyFn) {
    const keys = new Set();
    let duplicates = 0;
    for (const row of rows) {
        const key = keyFn(row);
        if (keys.has(key)) duplicates += 1;
        keys.add(key);
    }
    return duplicates;
}

async function deleteCustomerRows(pool, customerId) {
    for (const table of [
        'dashboard_payload_cache',
        'google_ads_warehouse_slice_fingerprints',
        'google_ads_report_coverage',
        'google_ads_campaign_daily'
    ]) {
        await pool.query(`DELETE FROM ${table} WHERE customer_id = $1`, [customerId]);
    }
}

describe('ads warehouse repository', () => {
    test('warehouse schema includes maintained fingerprint storage for dashboard watermarks', async () => {
        const queries = [];
        const pool = {
            async query(sql) {
                queries.push(String(sql).replace(/\s+/g, ' ').trim());
                return { rows: [] };
            }
        };

        await ensureAdsWarehouseSchema(pool);

        const schemaSql = queries.join(' ');
        expect(schemaSql).toContain('google_ads_warehouse_slice_fingerprints');
        expect(schemaSql).toContain('google_ads_warehouse_slice_fingerprints_lookup_idx');
        expect(schemaSql).toContain('google_ads_search_term_daily_watermark_idx');
        expect(schemaSql).toContain('google_ads_expanded_landing_page_daily_watermark_idx');
        expect(schemaSql).toContain('google_ads_configured_keywords_watermark_idx');
        expect(schemaSql).toContain('google_ads_keyword_planner_ideas_watermark_idx');
        expect(schemaSql).toContain('google_ads_auction_insights_status_watermark_idx');
        expect(schemaSql).toContain('candidate_signals_watermark_idx');
    });

    test('warehouse writes invalidate cached dashboard watermarks', async () => {
        clearAdsWarehouseRuntimeCaches();
        const db = new FakeWarehouseDb();
        const filters = {
            customerId: 'fixture_customer',
            startDate: '2026-01-01',
            endDate: '2026-01-01'
        };

        const firstWatermark = await getWarehouseWatermark(db, filters);
        expect(db.queries.some(query => query.includes('FROM google_ads_warehouse_slice_fingerprints'))).toBe(true);
        expect(db.queries.some(query => query.includes('MAX('))).toBe(false);

        db.queries = [];
        await getWarehouseWatermark(db, filters);
        expect(db.queries).toHaveLength(0);

        await replaceCampaignDailyWindow(db, 'fixture_customer', '2026-01-01', '2026-01-01', [{
            customer_id: 'fixture_customer',
            date: '2026-01-01',
            campaign_id: '111',
            campaign_name: 'Campaign 111',
            cost_micros: 1_000_000,
            clicks: 1,
            impressions: 100,
            conversions: 0,
            conversions_value: 0,
            raw_payload: { 'segments.date': '2026-01-01', 'campaign.id': '111' }
        }], 'run_after_watermark');

        db.queries = [];
        const secondWatermark = await getWarehouseWatermark(db, filters);
        expect(secondWatermark).not.toBe(firstWatermark);
        expect(db.queries.some(query => query.includes('FROM google_ads_warehouse_slice_fingerprints'))).toBe(true);
        expect(db.queries.some(query => query.includes('MAX('))).toBe(false);
        clearAdsWarehouseRuntimeCaches();
    });

    test('campaign slice watermarks ignore unrelated campaign-only fingerprint changes', async () => {
        clearAdsWarehouseRuntimeCaches();
        const db = new FakeWarehouseDb();
        const customerId = 'fixture_customer';
        const campaign111 = {
            customer_id: customerId,
            date: '2026-01-01',
            campaign_id: '111',
            campaign_name: 'Campaign 111',
            cost_micros: 1_000_000,
            clicks: 1,
            impressions: 100,
            conversions: 0,
            conversions_value: 0,
            raw_payload: { 'segments.date': '2026-01-01', 'campaign.id': '111' }
        };
        const campaign222 = {
            customer_id: customerId,
            date: '2026-01-01',
            campaign_id: '222',
            campaign_name: 'Campaign 222',
            cost_micros: 2_000_000,
            clicks: 2,
            impressions: 200,
            conversions: 0,
            conversions_value: 0,
            raw_payload: { 'segments.date': '2026-01-01', 'campaign.id': '222' }
        };

        await replaceCampaignDailyWindow(db, customerId, '2026-01-01', '2026-01-01', [campaign111, campaign222], 'run_1');
        const campaign111Watermark = await getWarehouseWatermark(db, {
            customerId,
            startDate: '2026-01-01',
            endDate: '2026-01-01',
            campaignId: '111'
        });
        const accountWatermark = await getWarehouseWatermark(db, {
            customerId,
            startDate: '2026-01-01',
            endDate: '2026-01-01'
        });

        await replaceCampaignDailyWindow(db, customerId, '2026-01-01', '2026-01-01', [
            campaign111,
            {
                ...campaign222,
                cost_micros: 3_000_000,
                raw_payload: { 'segments.date': '2026-01-01', 'campaign.id': '222', changed: true }
            }
        ], 'run_2');

        const nextCampaign111Watermark = await getWarehouseWatermark(db, {
            customerId,
            startDate: '2026-01-01',
            endDate: '2026-01-01',
            campaignId: '111'
        });
        const nextAccountWatermark = await getWarehouseWatermark(db, {
            customerId,
            startDate: '2026-01-01',
            endDate: '2026-01-01'
        });

        expect(nextCampaign111Watermark).toBe(campaign111Watermark);
        expect(nextAccountWatermark).not.toBe(accountWatermark);
        clearAdsWarehouseRuntimeCaches();
    });

    test('deleted slices keep tombstone fingerprints that invalidate stale watermarks', async () => {
        clearAdsWarehouseRuntimeCaches();
        const db = new FakeWarehouseDb();
        const customerId = 'fixture_customer';
        const filters = {
            customerId,
            startDate: '2026-01-01',
            endDate: '2026-01-01',
            campaignId: '111'
        };

        await replaceCampaignDailyWindow(db, customerId, '2026-01-01', '2026-01-01', [{
            customer_id: customerId,
            date: '2026-01-01',
            campaign_id: '111',
            campaign_name: 'Campaign 111',
            cost_micros: 1_000_000,
            clicks: 1,
            impressions: 100,
            conversions: 0,
            conversions_value: 0,
            raw_payload: { 'segments.date': '2026-01-01', 'campaign.id': '111' }
        }], 'run_with_rows');
        const withRows = await getWarehouseWatermark(db, filters);

        await replaceCampaignDailyWindow(db, customerId, '2026-01-01', '2026-01-01', [], 'run_delete_rows');
        const afterDelete = await getWarehouseWatermark(db, filters);
        const tombstone = db.tables.google_ads_warehouse_slice_fingerprints.find(row =>
            row.source_table === 'google_ads_campaign_daily'
            && row.scope_level === 'campaign'
            && row.campaign_id === '111'
            && row.slice_date === '2026-01-01'
        );

        expect(afterDelete).not.toBe(withRows);
        expect(tombstone.row_count).toBe(0);
        clearAdsWarehouseRuntimeCaches();
    });

    test('keyword impact windows do not select missing conversion value columns', async () => {
        const queries = [];
        const pool = {
            async query(sql) {
                const compact = String(sql).replace(/\s+/g, ' ').trim();
                queries.push(compact);
                return {
                    rows: [{
                        cost_micros: 1_000_000,
                        clicks: 2,
                        impressions: 20,
                        conversions: 1,
                        conversions_value: 0
                    }]
                };
            }
        };

        const metrics = await getImpactMetricWindow(pool, {
            customerId: '1234567890',
            startDate: '2026-01-01',
            endDate: '2026-01-31',
            scope: 'keyword',
            campaignId: '111',
            adGroupId: '222',
            criterionId: '333'
        });

        expect(metrics.conversionValue).toBe(0);
        expect(queries[0]).toContain('FROM google_ads_keyword_daily');
        expect(queries[0]).toContain('0::float8 AS conversions_value');
        expect(queries[0]).not.toContain('SUM(conversions_value)');
    });

    test('default warehouse coverage excludes derived daily trend no-op report', async () => {
        let coverageParams = null;
        const db = {
            async query(_sql, params = []) {
                coverageParams = params;
                return { rows: [] };
            }
        };

        await getCoverageForWindow(db, {
            customerId: '1234567890',
            startDate: '2026-01-01',
            endDate: '2026-01-31'
        });

        expect(coverageParams[3]).not.toContain('daily_trend');
    });

    test('successful chunk coverage marks dates without rows as empty', async () => {
        const db = new FakeWarehouseDb();

        await markReportCoverage(db, {
            runId: 'partial_window_run',
            customerId: '1234567890',
            reportName: 'search_term_performance',
            startDate: '2026-01-01',
            endDate: '2026-01-03',
            status: 'covered',
            rowCountByDate: new Map([
                ['2026-01-01', 2],
                ['2026-01-03', 1]
            ])
        });

        expect(db.tables.google_ads_report_coverage.map(row => ({
            date: row.coverage_date,
            status: row.status,
            rowCount: row.row_count
        }))).toEqual([
            { date: '2026-01-01', status: 'covered', rowCount: 2 },
            { date: '2026-01-02', status: 'empty', rowCount: 0 },
            { date: '2026-01-03', status: 'covered', rowCount: 1 }
        ]);
    });

    test('candidate signal replacement clears parent-scope rows for filtered repairs', async () => {
        const queries = [];
        const db = {
            async query(sql, params = []) {
                queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
                return { rows: [] };
            }
        };

        await replaceCandidateSignals(db, '1234567890', {
            customerId: '1234567890',
            startDate: '2026-01-01',
            endDate: '2026-01-31',
            campaignId: '111',
            adGroupId: '222'
        }, [], 'run_1');

        const deleteQuery = queries.find(query => query.sql.startsWith('DELETE FROM candidate_signals'));
        expect(deleteQuery.sql).toContain('(campaign_id = $4 OR campaign_id IS NULL)');
        expect(deleteQuery.sql).toContain('(ad_group_id = $5 OR ad_group_id IS NULL)');
        expect(deleteQuery.params).toEqual(['1234567890', '2026-01-01', '2026-01-31', '111', '222']);
    });

    test('parent-scope candidate fingerprints invalidate selected child watermarks', async () => {
        clearAdsWarehouseRuntimeCaches();
        const db = new FakeWarehouseDb();
        const customerId = '1234567890';
        const accountFilters = {
            customerId,
            startDate: '2026-01-01',
            endDate: '2026-01-31'
        };
        const childFilters = {
            ...accountFilters,
            campaignId: '111',
            adGroupId: '222'
        };

        const before = await getWarehouseWatermark(db, childFilters);
        await replaceCandidateSignals(db, customerId, accountFilters, [{
            signal_id: 'account-risk',
            customer_id: customerId,
            signal_type: 'DATA_COVERAGE_RISK',
            severity: 'high',
            campaign_id: null,
            ad_group_id: null,
            evidence_start_date: '2026-01-01',
            evidence_end_date: '2026-01-31',
            payload: { signal_id: 'account-risk', version: 1 }
        }], 'signal_run_1');
        const afterParentSignal = await getWarehouseWatermark(db, childFilters);

        await replaceCandidateSignals(db, customerId, accountFilters, [{
            signal_id: 'account-risk',
            customer_id: customerId,
            signal_type: 'DATA_COVERAGE_RISK',
            severity: 'high',
            campaign_id: null,
            ad_group_id: null,
            evidence_start_date: '2026-01-01',
            evidence_end_date: '2026-01-31',
            payload: { signal_id: 'account-risk', version: 2 }
        }], 'signal_run_2');
        const afterParentSignalChange = await getWarehouseWatermark(db, childFilters);

        expect(afterParentSignal).not.toBe(before);
        expect(afterParentSignalChange).not.toBe(afterParentSignal);
        clearAdsWarehouseRuntimeCaches();
    });

    test('candidate fingerprint refresh does not rewrite dates outside the affected window', async () => {
        clearAdsWarehouseRuntimeCaches();
        const db = new FakeWarehouseDb();
        const customerId = '1234567890';
        const decemberFilters = {
            customerId,
            startDate: '2025-12-20',
            endDate: '2025-12-25'
        };
        const januaryFilters = {
            customerId,
            startDate: '2026-01-01',
            endDate: '2026-01-31'
        };

        await replaceCandidateSignals(db, customerId, {
            customerId,
            startDate: '2025-12-20',
            endDate: '2026-01-15'
        }, [
            {
                signal_id: 'spanning-signal',
                customer_id: customerId,
                signal_type: 'DATA_COVERAGE_RISK',
                severity: 'high',
                campaign_id: null,
                ad_group_id: null,
                evidence_start_date: '2025-12-20',
                evidence_end_date: '2026-01-15',
                payload: { signal_id: 'spanning-signal' }
            },
            {
                signal_id: 'december-only-signal',
                customer_id: customerId,
                signal_type: 'DATA_COVERAGE_RISK',
                severity: 'medium',
                campaign_id: null,
                ad_group_id: null,
                evidence_start_date: '2025-12-20',
                evidence_end_date: '2025-12-25',
                payload: { signal_id: 'december-only-signal' }
            }
        ], 'signal_seed');

        const beforeDecemberRepair = await getWarehouseWatermark(db, decemberFilters);
        const beforeJanuaryRepair = await getWarehouseWatermark(db, januaryFilters);

        await replaceCandidateSignals(db, customerId, januaryFilters, [], 'signal_january_repair');

        expect(await getWarehouseWatermark(db, decemberFilters)).toBe(beforeDecemberRepair);
        expect(await getWarehouseWatermark(db, januaryFilters)).toBe(beforeJanuaryRepair);
        clearAdsWarehouseRuntimeCaches();
    });

    test('skips DB dashboard cache writes when payload exceeds configured byte limit', async () => {
        const previousLimit = process.env.DASHBOARD_DB_CACHE_MAX_BYTES;
        process.env.DASHBOARD_DB_CACHE_MAX_BYTES = '64';
        const queries = [];
        const db = {
            async query(sql, params = []) {
                queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
                return { rows: [] };
            }
        };

        try {
            await setCachedDashboardPayload(db, {
                customerId: 'fixture_customer',
                startDate: '2026-01-01',
                endDate: '2026-01-31'
            }, 'watermark', { rows: ['x'.repeat(200)] });

            expect(queries.some(query => query.sql.startsWith('DELETE FROM dashboard_payload_cache'))).toBe(true);
            expect(queries.some(query => query.sql.startsWith('INSERT INTO dashboard_payload_cache'))).toBe(false);
        } finally {
            if (previousLimit === undefined) delete process.env.DASHBOARD_DB_CACHE_MAX_BYTES;
            else process.env.DASHBOARD_DB_CACHE_MAX_BYTES = previousLimit;
        }
    });

    test('deletes oversized legacy DB dashboard cache rows instead of returning them', async () => {
        const previousLimit = process.env.DASHBOARD_DB_CACHE_MAX_BYTES;
        process.env.DASHBOARD_DB_CACHE_MAX_BYTES = '64';
        const queries = [];
        const db = {
            async query(sql, params = []) {
                const compact = sql.replace(/\s+/g, ' ').trim();
                queries.push({ sql: compact, params });
                if (compact.startsWith('SELECT CASE') || compact.includes('FROM dashboard_payload_cache')) {
                    return { rows: [{ payload: null, payload_bytes: 1024 }] };
                }
                return { rows: [] };
            }
        };

        try {
            const cached = await getCachedDashboardPayload(db, {
                customerId: 'fixture_customer',
                startDate: '2026-01-01',
                endDate: '2026-01-31'
            }, 'watermark');

            expect(cached).toBeNull();
            expect(queries.some(query => query.sql.startsWith('DELETE FROM dashboard_payload_cache'))).toBe(true);
        } finally {
            if (previousLimit === undefined) delete process.env.DASHBOARD_DB_CACHE_MAX_BYTES;
            else process.env.DASHBOARD_DB_CACHE_MAX_BYTES = previousLimit;
        }
    });

    test('all-time backfill then last-7-days replacement preserves older rows and filtered queries still work', async () => {
        const db = new FakeWarehouseDb();
        const customerId = 'fixture_customer';
        const allDates = dates('2026-01-01', 10);
        const allRows = allDates.map(date => ({
            customer_id: customerId,
            date,
            campaign_id: '111',
            campaign_name: 'Warehouse Fixture Campaign',
            campaign_status: 'ENABLED',
            cost_micros: 1_000_000,
            clicks: 1,
            impressions: 100,
            conversions: 0,
            conversions_value: 0,
            raw_payload: { 'segments.date': date, 'campaign.id': '111' }
        }));
        const lastSevenRows = allDates.slice(3).map(date => ({
            ...allRows.find(row => row.date === date),
            cost_micros: 2_000_000,
            clicks: 2,
            raw_payload: { 'segments.date': date, 'campaign.id': '111', refreshed: true }
        }));

        await replaceCampaignDailyWindow(db, customerId, '2026-01-01', '2026-01-10', allRows, 'all_time_backfill');
        await replaceCampaignDailyWindow(db, customerId, '2026-01-04', '2026-01-10', lastSevenRows, 'last_7_refresh');

        expect(db.tables.google_ads_campaign_daily).toHaveLength(10);
        const byDate = new Map(db.tables.google_ads_campaign_daily.map(row => [row.date, row]));
        expect(byDate.get('2026-01-03').cost_micros).toBe(1_000_000);
        expect(byDate.get('2026-01-03').run_id).toBe('all_time_backfill');
        expect(byDate.get('2026-01-04').cost_micros).toBe(2_000_000);
        expect(byDate.get('2026-01-04').run_id).toBe('last_7_refresh');

        const lastSevenFilters = {
            customerId,
            startDate: '2026-01-04',
            endDate: '2026-01-10'
        };
        const lastSeven = await getDashboardReportBundle(db, lastSevenFilters);
        expect(lastSeven.campaignDaily.map(row => row.date)).toEqual(allDates.slice(3));
        expect(lastSeven.campaignDaily.every(row => Number(row.cost_micros) === 2_000_000)).toBe(true);
        expect(dashboardCacheKey(lastSevenFilters)).toBe(
            'dashboard:v1:customer=fixture_customer:start=2026-01-04:end=2026-01-10:campaign=ALL:adGroup=ALL'
        );

        const allTime = await getDashboardReportBundle(db, {
            customerId,
            startDate: '2026-01-01',
            endDate: '2026-01-10'
        });
        expect(allTime.campaignDaily.map(row => row.date)).toEqual(allDates);
        expect(allTime.campaignDaily.find(row => row.date === '2026-01-03').cost_micros).toBe(1_000_000);
    });

    test('ad group filters are skipped for warehouse tables without ad_group_id columns', async () => {
        const db = new FakeWarehouseDb();
        const customerId = 'fixture_customer';
        await replaceCampaignDailyWindow(db, customerId, '2026-01-01', '2026-01-01', [{
            customer_id: customerId,
            date: '2026-01-01',
            campaign_id: '111',
            campaign_name: 'Campaign 111',
            cost_micros: 1_000_000,
            clicks: 1,
            impressions: 100,
            conversions: 0,
            conversions_value: 0,
            raw_payload: { 'segments.date': '2026-01-01', 'campaign.id': '111' }
        }], 'campaign_only');

        db.queries = [];
        await getDashboardReportBundle(db, {
            customerId,
            startDate: '2026-01-01',
            endDate: '2026-01-01',
            campaignId: '111',
            adGroupId: '222'
        });

        const accountQuery = db.queries.find(query => query.startsWith('SELECT * FROM google_ads_account_daily'));
        const campaignQuery = db.queries.find(query => query.startsWith('SELECT * FROM google_ads_campaign_daily'));
        const campaignSnapshotQuery = db.queries.find(query => query.startsWith('SELECT * FROM google_ads_campaign_snapshot'));

        expect(accountQuery).not.toContain('campaign_id');
        expect(accountQuery).not.toContain('ad_group_id');
        expect(campaignQuery).toContain('campaign_id = $4');
        expect(campaignQuery).not.toContain('ad_group_id');
        expect(campaignSnapshotQuery).toContain('campaign_id = $2');
        expect(campaignSnapshotQuery).not.toContain('ad_group_id');
    });

    test('Plan.md Jan 2026 fixture keeps all-time facts after last-7 replacement and removes disappeared search terms', async () => {
        const db = new FakeWarehouseDb();
        const backfill = loadFixture('warehouse-backfill-jan-2026.json');
        const refresh = loadFixture('warehouse-refresh-jan-last7.json');

        await loadWarehouseFixture(db, backfill, backfill.dateWindow, 'fixture_backfill');

        const backfillBundle = await getDashboardReportBundle(db, {
            customerId: backfill.customerId,
            startDate: '2026-01-01',
            endDate: '2026-01-30',
            campaignId: 'C1'
        });
        const backfillPayload = await buildDashboardPayloadFromBundle(backfillBundle, {
            customerId: backfill.customerId,
            startDate: '2026-01-01',
            endDate: '2026-01-30',
            campaignId: 'C1'
        }, { campaigns: [], adGroups: [] });
        expect(backfillPayload.summary.spend).toBe(30);

        await loadWarehouseFixture(db, refresh, refresh.replacementWindow, 'fixture_last7_refresh');

        const lastSevenBundle = await getDashboardReportBundle(db, {
            customerId: backfill.customerId,
            startDate: '2026-01-24',
            endDate: '2026-01-30',
            campaignId: 'C1'
        });
        const lastSevenPayload = await buildDashboardPayloadFromBundle(lastSevenBundle, {
            customerId: backfill.customerId,
            startDate: '2026-01-24',
            endDate: '2026-01-30',
            campaignId: 'C1'
        }, { campaigns: [], adGroups: [] });
        expect(lastSevenPayload.summary.spend).toBe(14);

        const allTimeBundle = await getDashboardReportBundle(db, {
            customerId: backfill.customerId,
            startDate: '2026-01-01',
            endDate: '2026-01-30',
            campaignId: 'C1'
        });
        const allTimePayload = await buildDashboardPayloadFromBundle(allTimeBundle, {
            customerId: backfill.customerId,
            startDate: '2026-01-01',
            endDate: '2026-01-30',
            campaignId: 'C1'
        }, { campaigns: [], adGroups: [] });
        expect(allTimePayload.summary.spend).toBe(37);

        expect(db.tables.google_ads_campaign_daily.some(row =>
            row.customer_id === backfill.customerId && row.campaign_id === 'C1' && row.date === '2026-01-10'
        )).toBe(true);
        expect(db.tables.google_ads_search_term_daily.some(row =>
            row.customer_id === backfill.customerId &&
            row.campaign_id === 'C1' &&
            row.ad_group_id === 'A1' &&
            row.search_term === 'whatsapp crm' &&
            row.date === '2026-01-26'
        )).toBe(false);
        expect(duplicatePkCount(db.tables.google_ads_campaign_daily, row => `${row.customer_id}|${row.date}|${row.campaign_id}`)).toBe(0);
        expect(duplicatePkCount(db.tables.google_ads_search_term_daily, row => `${row.customer_id}|${row.date}|${row.dimension_hash}`)).toBe(0);
    });

    testWithDb('keeps all-time backfill rows when a later last-7-days dashboard slice is queried', async () => {
        const pool = new Pool({
            connectionString: TEST_DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
        });
        const customerId = `test_${Date.now()}`;
        const allDates = dates('2026-01-01', 10);
        try {
            await ensureAdsWarehouseSchema(pool);
            await deleteCustomerRows(pool, customerId);

            const rows = allDates.map((date, index) => ({
                customer_id: customerId,
                date,
                campaign_id: '111',
                campaign_name: 'Warehouse Fixture Campaign',
                campaign_status: 'ENABLED',
                bidding_strategy_type: 'MAXIMIZE_CONVERSIONS',
                cost_micros: (index + 1) * 1_000_000,
                clicks: index + 1,
                impressions: 100 + index,
                conversions: index % 2,
                conversions_value: (index % 2) * 200,
                raw_payload: {
                    'customer.id': customerId,
                    'segments.date': date,
                    'campaign.id': '111',
                    'campaign.name': 'Warehouse Fixture Campaign',
                    'metrics.cost_micros': (index + 1) * 1_000_000,
                    'metrics.clicks': index + 1,
                    'metrics.impressions': 100 + index,
                    'metrics.conversions': index % 2,
                    'metrics.conversions_value': (index % 2) * 200
                }
            }));

            await replaceCampaignDailyWindow(pool, customerId, '2026-01-01', '2026-01-10', rows, 'test_all_time_backfill');
            await markReportCoverage(pool, {
                runId: 'test_all_time_backfill',
                customerId,
                reportName: 'campaign_performance',
                startDate: '2026-01-01',
                endDate: '2026-01-10',
                status: 'covered',
                rowCountByDate: new Map(allDates.map(date => [date, 1]))
            });

            const allTime = await getDashboardReportBundle(pool, {
                customerId,
                startDate: '2026-01-01',
                endDate: '2026-01-10'
            });
            expect(allTime.campaignDaily.map(row => row.date)).toEqual(allDates);

            const lastSevenFilters = {
                customerId,
                startDate: '2026-01-04',
                endDate: '2026-01-10'
            };
            const lastSeven = await getDashboardReportBundle(pool, lastSevenFilters);
            expect(lastSeven.campaignDaily.map(row => row.date)).toEqual(allDates.slice(3));
            expect(dashboardCacheKey(lastSevenFilters)).toBe(
                `dashboard:v1:customer=${customerId}:start=2026-01-04:end=2026-01-10:campaign=ALL:adGroup=ALL`
            );

            const coverage = await getCoverageForWindow(pool, lastSevenFilters, ['campaign_performance']);
            expect(coverage[0]).toMatchObject({
                reportName: 'campaign_performance',
                status: 'covered',
                coveredDates: 7,
                rowCount: 7
            });

            const stored = await pool.query(
                `SELECT COUNT(*)::int AS count
                 FROM google_ads_campaign_daily
                 WHERE customer_id = $1`,
                [customerId]
            );
            expect(stored.rows[0].count).toBe(10);
        } finally {
            await deleteCustomerRows(pool, customerId).catch(() => {});
            await pool.end();
        }
    });
});
