import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const appJs = fs.readFileSync(path.join(import.meta.dir, '..', 'client', 'app.js'), 'utf8');
const serverTs = fs.readFileSync(path.join(import.meta.dir, '..', 'server.ts'), 'utf8');
const indexHtml = fs.readFileSync(path.join(import.meta.dir, '..', 'client', 'index.html'), 'utf8');
const stylesCss = fs.readFileSync(path.join(import.meta.dir, '..', 'client', 'styles.css'), 'utf8');
const widgetQueries = fs.readFileSync(path.join(import.meta.dir, '..', 'lib', 'overviewWidgets.ts'), 'utf8');

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

    test('Data keeps the full refresh while App/browser reloads request today-only light refresh', () => {
        expect(appJs).toContain('async function requestFullDataRefresh');
        expect(appJs).toContain('async function requestTodayDataRefresh');
        expect(appJs).toContain('dashboardFetch(`${apiBase}/api/trigger-refresh`, {');
        expect(appJs).toContain("headers: { 'Content-Type': 'application/json' }");
        expect(appJs).toContain('body: JSON.stringify({ force: true })');
        expect(appJs).toContain('String(now.getMonth() + 1)');
        expect(appJs).toContain("refreshProfile: 'light_today'");
        expect(appJs).toContain('startDate: localToday');
        expect(appJs).toContain('endDate: localToday');
        expect(appJs).toContain('requestFullDataRefresh(API_BASE)');
        expect(appJs).toContain('requestTodayDataRefresh(API_BASE, { force: true })');
        const dataHandlerStart = appJs.indexOf('    if (els.refreshBtn) {');
        const dataHandlerEnd = appJs.indexOf('    // 2. Now attempt to load data from the database', dataHandlerStart);
        const dataHandler = appJs.slice(dataHandlerStart, dataHandlerEnd);
        expect(dataHandler).toContain('requestFullDataRefresh(API_BASE)');
        expect(dataHandler).not.toContain('requestTodayDataRefresh');
        expect(dataHandler).not.toContain("refreshProfile: 'light_today'");
        expect(appJs).not.toContain("if (!API_KEY_GLOBAL && els.refreshBtn)");
        expect(serverTs).toContain('resolveTriggerRefreshRequest(req.body, { force })');
        expect(serverTs).toContain('startDate: refreshRequest.startDate');
        expect(serverTs).toContain("kind: refreshRequest.lightClientRefresh ? 'manual' : refreshRequest.scheduledCronRefresh ? 'cron' : undefined");
        expect(serverTs).toContain('const authenticateRefreshMutation = [authenticateDashboardOrAdminAccess({ pool }), requireDashboardCsrf]');
        expect(serverTs).toContain("app.post('/api/trigger-refresh', ...authenticateRefreshMutation");
    });

    test('completed cron refreshes replace the browser store and re-render without reloading the page', () => {
        expect(serverTs).toContain("app.get('/api/dashboard/cron-refresh-status', authenticateDashboard");
        expect(serverTs).toContain("const status = run?.queue_status === 'succeeded' ? run.warehouse_status : run?.queue_status;");
        expect(serverTs).toContain("refreshProfile: run.source === CRON_COOLDOWN_TODAY_REFRESH_SOURCE ? 'light_today' : 'full'");
        expect(appJs).toContain('function startCronRefreshCompletionWatcher()');
        expect(appJs).toContain('function checkForCompletedCronRefresh()');
        expect(appJs).toContain('CRON_REFRESH_STATUS_POLL_INTERVAL_MS = 30_000');
        expect(appJs).toContain('dashboardFetch(`${API_BASE_GLOBAL}/api/dashboard/cron-refresh-status`');
        expect(appJs).toContain("await loadDashboardForCurrentFilters('');");
        expect(appJs).toContain('startCronRefreshCompletionWatcher();');
        expect(appJs).toContain("'Scheduled full data'} refreshed; dashboard updated.");
    });

    test('header date picker uses the configured warehouse start date as account start', () => {
        expect(appJs).toContain('async function fetchDashboardDateRangeBounds(apiBase)');
        expect(appJs).toContain('dashboardFetch(`${apiBase}/api/dashboard/filters`)');
        expect(appJs).toContain('const dateBounds = await fetchDashboardDateRangeBounds(API_BASE);');
        expect(appJs).toContain('const warehouseStartDate = configuredStartDate && configuredStartDate <= today ? configuredStartDate : \'\';');
        expect(appJs).toContain('const minDate = warehouseStartDate ? moment(warehouseStartDate, \'YYYY-MM-DD\') : false;');
        expect(appJs).toContain("...(warehouseStartDate ? { 'All Time': [moment(warehouseStartDate, 'YYYY-MM-DD'), maxDate.clone()] } : {})");
        expect(serverTs).toContain('return { ...options, accountStartDate: dashboardAccountStartDate() };');
        expect(serverTs).toContain('window.ENV = { API_BASE: "", API_KEY: "" };');
    });

    test('Auction Insights renders a selected-range summary instead of a raw daily grid', () => {
        expect(indexHtml).toContain('id="auctionInsightsTableBody"');
        expect(indexHtml).toContain('id="auctionSettingsCard"');
        expect(indexHtml).toContain('id="editAuctionSettingsLabel"');
        expect(indexHtml).toContain('id="auctionInsightsMetaHelp"');
        expect(indexHtml).toContain('id="auctionInsightsMetaPopover"');
        expect(indexHtml).toContain('id="auctionAbsoluteTopList"');
        expect(indexHtml).toContain('id="auctionOverlapList"');
        expect(indexHtml).toContain('id="auctionMovementList"');
        expect(indexHtml).not.toContain('id="grid-auctionInsights"');
        expect(indexHtml.indexOf('id="auctionInsightsTrendChart"')).toBeLessThan(indexHtml.indexOf('id="auctionInsightsTableBody"'));
        expect(appJs).not.toContain("initGrid('grid-auctionInsights'");
        expect(appJs).not.toContain('function metricAverage');
        expect(appJs).toContain("'Last 7 Completed Days': [maxDate.clone().subtract(7, 'days'), maxDate.clone().subtract(1, 'days')]");
        expect(appJs).toContain('<details class="auction-accuracy-details">');
        expect(appJs).toContain('Google calculates its unsegmented date-range report directly from the underlying auctions.');
        expect(appJs).toContain('<strong>Some denominators are unavailable:</strong>');
        expect(appJs).toContain('<strong>Google censors small shares:</strong>');
        expect(appJs).toContain('<strong>Source timing and coverage can differ:</strong>');
        expect(stylesCss).toContain('.auction-accuracy-details summary:focus-visible');
        expect(stylesCss).toContain('.auction-accuracy-details:not([open]):hover .auction-accuracy-explanation');
        expect(stylesCss).toContain('.auction-meta-help:hover .auction-meta-popover');
        expect(stylesCss).toContain('.auction-meta-help:focus-within .auction-meta-popover');
        expect(appJs).toContain('function updateAuctionSettingsCardVisibility()');
        expect(appJs).toContain("card.dataset.configurationComplete === 'true'");
        expect(appJs).toContain("String(item?.status || '').toLowerCase() !== 'ok'");
        expect(appJs).toContain("entities.length > 0 && entities.every(entity =>");
        expect(stylesCss).toContain('.auction-settings-card.is-collapsed .auction-settings-shell');
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
        expect(body).toContain('dateRangeIncludesToday');
        expect(body).toContain('const clicksKpiLabel = clickMetricDate === todayKey ?');
        expect(body).toContain("action: metricKey === 'clicks' ? 'clicks' : null");
        expect(body).not.toContain('const summary = dashboardData.globalSummary;');
        expect(body).not.toContain('`Overall ${kpi.label}`');
        expect(body).not.toContain("kpi.label === 'Clicks Today'");
    });

    test('click detail modal exposes scope for duplicate keyword rows', () => {
        const body = functionBody(appJs, 'renderClickPathsGrid');
        expect(body).toContain("{ field: 'campaign', headerName: 'Campaign' }");
        expect(body).toContain("{ field: 'adGroup', headerName: 'Ad Group' }");
    });

    test('exports full lead review rows from the server instead of dashboard allLeads', () => {
        expect(appJs).toContain('/api/leads/review.csv?${params.toString()}');
        expect(appJs).not.toContain('downloadTextFile(leadReviewCsvFilename(), leadReviewCsvText(leads));');
        expect(appJs).not.toContain('function leadReviewCsvText');
        expect(appJs).not.toContain('dashboardData.leadAttribution?.allLeads');
    });

    test('browser support routes do not build the full dashboard payload', () => {
        expect(serverTs).not.toContain('const dashboardData = await getDashboardPayload();');
        expect(serverTs).not.toContain('getDashboardPayload(req.query as Record<string, any>).catch');
        expect(serverTs).toContain('const filters = await resolveDashboardFilters(pool, req.query as Record<string, any>);');
        expect(serverTs).toContain('const filterOptions = await getAvailableDashboardFilters(pool, filters.customerId);');
    });

    test('overview search and keyword cards use separate bounded endpoints and the existing preview-confirm flow', () => {
        expect(indexHtml).toContain('id="overviewSearchWidget"');
        expect(indexHtml).toContain('id="overviewKeywordWidget"');
        expect(serverTs).toContain("app.get('/api/dashboard/widgets/searches', authenticateDashboard");
        expect(serverTs).toContain("app.get('/api/dashboard/widgets/keywords', authenticateDashboard");
        expect(serverTs).toContain("'/api/account-controls/mutations/keyword-preflight'");
        expect(appJs).toContain('/api/dashboard/widgets/searches?${params}');
        expect(appJs).toContain('/api/dashboard/widgets/keywords?${params}');
        expect(appJs).toContain('/api/account-controls/mutations/keyword-preflight');
        expect(appJs).toContain("previewControlsMutation('keyword_changes'");
        expect(appJs).toContain("previewControlsMutation('negative_keyword_changes'");
        expect(appJs).toContain('if (result.duplicate)');
        expect(appJs).toContain('result.oppositeConflicts');
        expect(appJs).toContain('This change is still allowed.');
        expect(appJs).toContain('setupOverviewKeywordColumnResizing()');
        expect(appJs).toContain('OVERVIEW_KEYWORD_COLUMN_WIDTHS_KEY');
        expect(appJs).toContain("overviewSearchState.mode === 'words' ? 30 : 20");
        expect(appJs).toContain("function prepareOverviewActionHost(popover)");
        expect(appJs).toContain("This word appears in the searches below.");
        expect(appJs).toContain('Only this word will be added. The example searches shown above will not be added.');
        expect(appJs).toContain('This complete search phrase will be added as the keyword.');
        expect(appJs).toContain('id="overviewNegativeKeywordText"');
        expect(appJs).toContain("mountOverviewKeywordForm(popover, row.label, 'word')");
        expect(appJs).toContain("mountOverviewKeywordForm(popover, row.label, 'search')");
        expect(appJs).not.toContain('Open a full search to add it as a keyword or negative keyword.');
        expect(appJs).not.toContain('overview-popover-mark');
        expect(appJs).toContain("table.style.width = '100%'");
        expect(indexHtml).toContain('data-resize-column="0"');
        expect(stylesCss).toContain('.overview-keyword-table-wrap');
        expect(stylesCss).toContain('overflow: hidden');
        expect(stylesCss).toContain('overflow-wrap: anywhere');
        expect(appJs).toContain("popover.classList.contains('overview-inline-detail')");
        expect(stylesCss).toContain('width: 28px');
        expect(widgetQueries).toContain('const SEARCH_PAGE_SIZE_MAX = 20');
        expect(widgetQueries).toContain('const WORD_PAGE_SIZE_MAX = 40');
        expect(widgetQueries).toContain('const KEYWORD_PAGE_SIZE_MAX = 20');
        expect(widgetQueries).toContain('LIMIT ${limitParam} OFFSET ${offsetParam}');
    });

    test('overview keyword card excludes deferred metrics and conversion-action columns', () => {
        const start = appJs.indexOf('const OVERVIEW_KEYWORD_METRICS = {');
        const end = appJs.indexOf('const overviewSearchState', start);
        const metrics = appJs.slice(start, end);
        expect(metrics).not.toContain('conversionValue');
        expect(metrics).not.toContain('interactions');
        expect(metrics).not.toContain('phoneCalls');
        expect(indexHtml).not.toContain('overviewKeywordConversionAction');
    });
});
