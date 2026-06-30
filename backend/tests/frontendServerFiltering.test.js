import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const appJs = fs.readFileSync(path.join(import.meta.dir, '..', 'client', 'app.js'), 'utf8');
const serverTs = fs.readFileSync(path.join(import.meta.dir, '..', 'server.ts'), 'utf8');

function functionBody(source, name) {
    const match = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}`));
    if (!match) throw new Error(`Unable to find function ${name}`);
    return match[1];
}

describe('frontend server-filtering contract', () => {
    test('date and entity filters are rendered from the selected server payload only', () => {
        const body = functionBody(appJs, 'applyLocalFilter');
        expect(body).toContain('renderDashboardPayload();');
        expect(body).not.toContain('els.refreshBtn.click');
        expect(body).not.toContain('window.fullData.dailyTrend');
        expect(body).not.toContain('window.fullData.campaigns');
        expect(body).not.toContain('filterData(');
        expect(body).not.toContain('agg(');
        expect(appJs).not.toContain('function buildPeriodComparisonFromTrend');
    });

    test('lead status reload preserves the active dashboard query', () => {
        expect(appJs).toContain("const dashboard = await fetchDashboardView('overview');");
        expect(appJs).toContain('await ensureDashboardViewForTab(tabId, { render: false });');
        expect(appJs).not.toContain('dashboardFetch(`${API_BASE_GLOBAL}/api/dashboard`)');
    });

    test('manual refresh button bypasses cron cooldown explicitly', () => {
        expect(appJs).toContain('dashboardFetch(`${API_BASE}/api/trigger-refresh`, {');
        expect(appJs).toContain("headers: { 'Content-Type': 'application/json' }");
        expect(appJs).toContain('body: JSON.stringify({ force: true })');
    });

    test('custom comparison ranges are loaded from server slices', () => {
        expect(appJs).toContain("dashboardQueryString({ startDate: cpStartStr, endDate: cpEndStr, view: 'overview' })");
        expect(appJs).toContain("dashboardQueryString({ startDate: ppStartStr, endDate: ppEndStr, view: 'overview' })");
        expect(appJs).not.toContain('const currentData = dailyTrend.filter');
        expect(appJs).not.toContain('const previousData = dailyTrend.filter');
    });

    test('browser dashboard loads request payload views instead of the full dashboard', () => {
        expect(appJs).toContain("dashboardQueryString({ view: 'overview' })");
        expect(appJs).toContain("dashboardQueryString({ startDate: startD, endDate: endD, view: 'overview' })");
        expect(appJs).toContain('dashboardQueryString({ view })');
        expect(appJs).toContain('const TAB_DASHBOARD_VIEWS = {');
        expect(appJs).toContain('void ensureDashboardViewForTab(activeDashboardTab())');
    });

    test('stale partial view responses are not merged across selected server slices', () => {
        expect(appJs).toContain('let dashboardLoadGeneration = 0;');
        expect(appJs).toContain('function beginDashboardLoad(initialView = \'\')');
        expect(appJs).toContain('if (generation !== dashboardLoadGeneration) return data;');
        expect(appJs).toContain('if (generation === dashboardLoadGeneration && options.render !== false) renderActiveDashboardTab(tabId);');
    });

    test('general render path does not render hidden heavy tabs immediately', () => {
        const body = functionBody(appJs, 'renderDashboardPayload');
        expect(body).toContain('renderActiveDashboardTab();');
        expect(body).not.toContain('renderTables();');
        expect(body).not.toContain('renderKeywordPlannerExplorer();');
        expect(body).not.toContain('renderAttribution();');
        expect(body).not.toContain('renderRankDiagnostics();');
        expect(body).not.toContain('renderProposals();');
    });

    test('overview render path draws visible segment charts from the overview payload', () => {
        const body = functionBody(appJs, 'renderCharts');
        expect(body).toContain('if (dashboardData.devicePerformance) renderDeviceChart();');
        expect(body).toContain('renderTimePerformance();');
    });

    test('keyword tab renders its visible quality score distribution from the keywords view', () => {
        const start = appJs.indexOf('renderKeywordPlannerExplorer();');
        const end = appJs.indexOf("tabId === 'attribution'", start);
        const keywordBranch = appJs.slice(start, end);
        expect(keywordBranch).toContain('if (dashboardData.qualityScores) renderQsDoughnutChart();');
    });

    test('overview KPI grid uses the selected server-side summary', () => {
        const body = functionBody(appJs, 'renderGlobalKPIs');
        expect(body).toContain('const summary = dashboardData.summary || dashboardData.globalSummary || {};');
        expect(body).not.toContain('const summary = dashboardData.globalSummary;');
        expect(body).not.toContain('`Overall ${kpi.label}`');
    });

    test('exports full lead review rows from the server instead of dashboard allLeads', () => {
        expect(appJs).toContain('/api/leads/review.csv?${params.toString()}');
        expect(appJs).not.toContain('downloadTextFile(leadReviewCsvFilename(), leadReviewCsvText(leads));');
        expect(appJs).not.toContain('function leadReviewCsvText');
        expect(appJs).not.toContain('dashboardData.leadAttribution?.allLeads');
    });

    test('browser support routes do not build the full dashboard compatibility payload', () => {
        expect(serverTs).not.toContain('const dashboardData = await getDashboardPayload();');
        expect(serverTs).not.toContain('getDashboardPayload(req.query as Record<string, any>).catch');
        expect(serverTs).toContain('const filters = await resolveDashboardFilters(pool, req.query as Record<string, any>);');
        expect(serverTs).toContain('const filterOptions = await getAvailableDashboardFilters(pool, filters.customerId);');
    });
});
