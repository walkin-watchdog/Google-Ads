/**
 * Dashboard Logic - Fetches data and renders the UI
 */

const CURRENCY = '₹';

// Formatters
const fmtNum = (n) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(Number(n || 0));
const fmtCurr = (n) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(n || 0));
const fmtPct = (n) => n === null || n === undefined ? 'n/a' : `${Number(n).toFixed(2)}%`;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
}[char]));
const shortId = (value) => {
    const text = String(value || '');
    return text.length > 18 ? `${text.slice(0, 10)}…${text.slice(-6)}` : text;
};

const formatDateShort = (d) => {
    const date = new Date(d);
    return isNaN(date) ? d : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
const formatDateRange = (label) => {
    if (!label) return '';
    return label.split(' - ').map(formatDateShort).join(' - ');
};

let dashboardData = null;
let charts = {};

// DOM Elements
const els = {
    tabs: document.querySelectorAll('.nav-item'),
    tabContents: document.querySelectorAll('.tab-content'),
    mainContent: document.querySelector('.main-content'),
    kpiGrid: document.getElementById('kpiGrid'),
    insightsGrid: document.getElementById('insightsGrid'),
    campaignsTbody: document.querySelector('#campaignsTable tbody'),
    keywordsTbody: document.querySelector('#keywordsTable tbody'),
    searchTermsTbody: document.querySelector('#searchTermsTable tbody'),
    conversionActionsTbody: document.querySelector('#conversionActionsTable tbody'),
    conversionAttributionTbody: document.querySelector('#conversionAttributionTable tbody'),
    clickPathsTbody: document.querySelector('#clickPathsTable tbody'),
    attributionSummary: document.getElementById('attributionSummary'),
    attributionBadge: document.getElementById('attributionBadge'),
    rankSummary: document.getElementById('rankSummary'),
    dateRangePicker: document.getElementById('dateRangePicker'),
    competitorTbody: document.querySelector('#competitorTable tbody'),
    qualityScoreTbody: document.querySelector('#qualityScoreTable tbody'),
    landingPagesTbody: document.querySelector('#landingPagesTable tbody'),
    proposalsGrid: document.getElementById('proposalsGrid'),
    proposalCount: document.getElementById('proposalCountBadge'),
    trendSelect: document.getElementById('trendMetricSelect'),
    toast: document.getElementById('toast'),
    dateRange: document.getElementById('dateRangeText'),
    accountId: document.getElementById('accountIdText'),
    lastUpdated: document.getElementById('lastUpdated'),
    refreshBtn: document.getElementById('refreshBtn'),
    filterBtns: document.querySelectorAll('.filter-btn'),
};

// Initialization
async function init() {
    let API_BASE = (window.ENV && window.ENV.API_BASE) || localStorage.getItem('API_BASE');
    let API_KEY = (window.ENV && window.ENV.API_KEY) || localStorage.getItem('API_KEY');

    if (!API_BASE || !API_KEY) {
        API_BASE = prompt('Enter the backend API Base URL (e.g. https://my-app.onrender.com or http://localhost:8080):', API_BASE || 'http://localhost:8080');
        API_KEY = prompt('Enter your Secret API Key:', API_KEY || '');
        if (API_BASE && API_KEY) {
            localStorage.setItem('API_BASE', API_BASE);
            localStorage.setItem('API_KEY', API_KEY);
        } else {
            els.kpiGrid.innerHTML = `<p style="color:var(--danger)">API credentials required to load dashboard.</p>`;
            return;
        }
    }

    // 1. Bind static UI elements immediately so they work even if DB is empty
    setupNav();
    setupSidebar();

    // Initialize date picker
    const today = new Date().toISOString().slice(0, 10);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    let startD = localStorage.getItem('globalStartDate') || thirtyDaysAgo;
    let endD = localStorage.getItem('globalEndDate') || today;

    if ($('#dateRangePicker').length) {
        function cb(start, end) {
            $('#dateRangePicker span').html(start.format('YYYY-MM-DD') + ' to ' + end.format('YYYY-MM-DD'));
        }

        $('#dateRangePicker').daterangepicker({
            startDate: moment(startD),
            endDate: moment(endD),
            maxDate: moment(),
            ranges: {
                'Today': [moment(), moment()],
                'Yesterday': [moment().subtract(1, 'days'), moment().subtract(1, 'days')],
                'Last 7 Days': [moment().subtract(6, 'days'), moment()],
                'Last 30 Days': [moment().subtract(29, 'days'), moment()],
                'This Month': [moment().startOf('month'), moment().endOf('month')],
                'Last Month': [moment().subtract(1, 'month').startOf('month'), moment().subtract(1, 'month').endOf('month')]
            },
            locale: { format: 'YYYY-MM-DD' }
        }, cb);

        cb(moment(startD), moment(endD));
        if (els.dateRangePicker) {
            $(els.dateRangePicker).on('apply.daterangepicker', function (ev, picker) {
                const s = picker.startDate.format('YYYY-MM-DD');
                const e = picker.endDate.format('YYYY-MM-DD');
                localStorage.setItem('globalStartDate', s);
                localStorage.setItem('globalEndDate', e);

                if (window.fullData && window.fullData.meta.dateRange.start <= s && window.fullData.meta.dateRange.end >= e) {
                    applyLocalFilter(s, e);
                    showToast('Filtered locally.', false);
                    return;
                }

                showToast('Fetching latest data... This may take a minute.', false);
                const payload = { startDate: s, endDate: e };
                fetch(`${API_BASE}/api/trigger-refresh`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
                    body: JSON.stringify(payload)
                }).then(res => res.json().then(data => ({ res, data })))
                    .then(({ res, data }) => {
                        if (!res.ok) throw new Error(data.error || data.message || 'Server error');
                        if (res.status === 202 && data.message === 'Refresh already in progress.') {
                            showToast('Refresh already in progress...', false);
                        } else {
                            showToast('Refreshing ...', false);
                        }
                        pollForRefreshCompletion(API_BASE, API_KEY);
                    }).catch(err => {
                        console.error(err);
                        showToast(`Refresh failed: ${err.message}`, true);
                    });
            });
        }
    }

    if (els.refreshBtn) {
        els.refreshBtn.addEventListener('click', () => {
            showToast('Triggering background refresh...', false);
            els.refreshBtn.disabled = true;
            els.refreshBtn.innerText = 'Refreshing...';
            fetch(`${API_BASE}/api/trigger-refresh`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${API_KEY}` }
            }).then(async res => {
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || data.message || 'Failed to trigger refresh');

                if (res.status === 202 && data.message === 'Refresh already in progress.') {
                    showToast('Refresh already in progress...', false);
                } else {
                    showToast('Refreshing ...', false);
                }
                pollForRefreshCompletion(API_BASE, API_KEY);
            }).catch(err => {
                console.error(err);
                showToast(`Refresh failed: ${err.message}`, true);
                els.refreshBtn.disabled = false;
                els.refreshBtn.innerText = 'Refresh Dashboard';
            });
        });
    }

    function pollForRefreshCompletion(apiBase, apiKey) {
        const initialGeneratedAt = dashboardData?.meta?.generatedAt;
        let attempts = 0;
        const maxAttempts = 60; // 5 mins total at 5s interval
        const pollInterval = setInterval(async () => {
            attempts++;
            if (attempts > maxAttempts) {
                clearInterval(pollInterval);
                showToast('Refresh timed out. Please try again later.', true);
                if (els.refreshBtn) {
                    els.refreshBtn.disabled = false;
                    els.refreshBtn.innerText = 'Refresh Dashboard';
                }
                return;
            }
            try {
                const res = await fetch(`${apiBase}/api/dashboard`, { headers: { 'Authorization': `Bearer ${apiKey}` } });
                if (res.ok) {
                    const data = await res.json();
                    if (data.meta && data.meta.generatedAt !== initialGeneratedAt) {
                        clearInterval(pollInterval);
                        showToast('Refresh successful! Reloading...', false);
                        setTimeout(() => window.location.reload(), 1000);
                    }
                }
            } catch (e) {
                // Ignore network errors during polling
            }
        }, 5000);
    }

    // 2. Now attempt to load data from the database
    try {
        const res = await fetch(`${API_BASE}/api/dashboard`, {
            headers: { 'Authorization': `Bearer ${API_KEY}` }
        });
        if (res.status === 401 || res.status === 403) {
            localStorage.removeItem('API_KEY');
            throw new Error('Invalid API Key. Please refresh to try again.');
        }
        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || errData.message || `Server not responding ${res.status}`);
        }
        dashboardData = await res.json();
        window.fullData = dashboardData;

        initTheme();
        renderSidebar();
        populateGlobalFilters();
        applyLocalFilter(startD, endD);
        setupFilters();
        makeTablesResponsiveAndSortable();
        setupSearchFilters();
        setupComparisonControls();
        els.trendSelect.addEventListener('change', () => renderTrendChart());
        const dhmSelect = document.getElementById('dayHourMetricSelect');
        if (dhmSelect) dhmSelect.addEventListener('change', () => renderTimePerformance());
    } catch (err) {
        console.error('Failed to load dashboard data:', err);
        els.kpiGrid.innerHTML = `<p style="color:var(--danger)">Error loading data: ${err.stack}</p>`;
    }
}

// Navigation
function setupNav() {
    els.tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            els.tabs.forEach(t => t.classList.remove('active'));
            els.tabContents.forEach(c => c.classList.remove('active'));

            tab.classList.add('active');
            const tabId = tab.dataset.tab;
            document.getElementById(`tab-${tabId}`).classList.add('active');

            // Reset scroll position on tab switch
            if (els.mainContent) {
                els.mainContent.scrollTop = 0;
            }

            // Hash Routing
            window.location.hash = tabId;

            // Close mobile sidebar
            if (window.innerWidth <= 768) {
                document.querySelector('.sidebar').classList.remove('open');
            }

            // Resize charts if they became visible
            Object.values(charts).forEach(chart => {
                if (chart && typeof chart.resize === 'function') chart.resize();
            });
        });
    });

    // Time tabs
    document.querySelectorAll('.time-tab').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.time-tab').forEach(b => {
                b.classList.remove('active');
                b.style.borderBottomColor = 'transparent';
                b.style.color = 'var(--text-muted)';
            });
            document.querySelectorAll('.time-tab-content').forEach(c => {
                c.style.display = 'none';
                c.classList.remove('active');
            });

            const target = e.currentTarget;
            target.classList.add('active');
            target.style.borderBottomColor = 'var(--primary)';
            target.style.color = 'var(--primary)';

            const content = document.getElementById(target.dataset.target);
            if (content) {
                content.style.display = 'block';
                content.classList.add('active');
            }
        });
    });

    const toggle = document.getElementById('mobileNavToggle');
    if (toggle) {
        toggle.addEventListener('click', () => {
            document.querySelector('.sidebar').classList.toggle('open');
        });
    }

    // Read initial hash
    const initialTab = window.location.hash.replace('#', '') || 'overview';
    const tabBtn = document.querySelector(`.nav-item[data-tab="${initialTab}"]`);
    if (tabBtn) tabBtn.click();
}

function setupSidebar() {
    const sidebar = document.getElementById('sidebar');
    const pinBtn = document.getElementById('pinSidebarBtn');

    if (!sidebar || !pinBtn) return;

    // Read state from localStorage, default to true (pinned)
    let isPinned = localStorage.getItem('sidebar_pinned') !== 'false';
    let isHovered = false;

    function updateSidebarState() {
        const isCollapsed = !isPinned && !isHovered;
        if (isCollapsed) {
            sidebar.classList.add('collapsed');
        } else {
            sidebar.classList.remove('collapsed');
        }

        if (isPinned) {
            pinBtn.classList.add('pinned');
            pinBtn.title = "Unpin Sidebar";
        } else {
            pinBtn.classList.remove('pinned');
            pinBtn.title = "Pin Sidebar";
        }
    }

    // Hover listeners
    sidebar.addEventListener('mouseenter', () => {
        isHovered = true;
        updateSidebarState();
    });

    sidebar.addEventListener('mouseleave', () => {
        isHovered = false;
        updateSidebarState();
    });

    // Pin click listener
    pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        isPinned = !isPinned;
        localStorage.setItem('sidebar_pinned', isPinned);
        updateSidebarState();
    });

    // Initial render
    updateSidebarState();
}

function setupFilters() {
    els.filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            els.filterBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderProposals(btn.dataset.filter);
        });
    });
}

// Sidebar / Meta
function renderSidebar() {
    const { meta } = dashboardData;
    els.dateRange.textContent = `Date: ${meta.dateRange.start} to ${meta.dateRange.end}`;
    els.accountId.textContent = `Account ID: ${meta.accountId}`;
    const date = new Date(meta.generatedAt);
    els.lastUpdated.textContent = `Last updated: ${date.toLocaleString()}`;
}

function setupComparisonControls() {
    const { dailyTrend } = dashboardData;
    if (!dailyTrend || dailyTrend.length === 0) return;

    const minDateStr = dailyTrend[0].date;
    const maxDateStr = dailyTrend[dailyTrend.length - 1].date;

    const minDate = moment(minDateStr);
    const maxDate = moment(maxDateStr);

    const cpPicker = $('#currentPeriodPicker');
    const ppPicker = $('#previousPeriodPicker');

    // Parse existing labels if any
    const curLabel = dashboardData.periodComparison?.currentPeriod?.label || '';
    const prevLabel = dashboardData.periodComparison?.previousPeriod?.label || '';

    let cpStart = minDate, cpEnd = maxDate;
    if (curLabel.includes(' – ')) {
        const parts = curLabel.split(' – ');
        cpStart = moment(parts[0]);
        cpEnd = moment(parts[1]);
    }
    let ppStart = minDate, ppEnd = maxDate;
    if (prevLabel.includes(' – ')) {
        const parts = prevLabel.split(' – ');
        ppStart = moment(parts[0]);
        ppEnd = moment(parts[1]);
    }

    const pickerOptions = {
        minDate,
        maxDate,
        locale: { format: 'YYYY-MM-DD' }
    };

    cpPicker.daterangepicker({ ...pickerOptions, startDate: cpStart, endDate: cpEnd });
    ppPicker.daterangepicker({ ...pickerOptions, startDate: ppStart, endDate: ppEnd });

    function syncPPRange() {
        const cp = cpPicker.data('daterangepicker');
        const pp = ppPicker.data('daterangepicker');
        if (!cp || !pp) return;

        const cpDays = cp.endDate.diff(cp.startDate, 'days');
        let newStartDate = moment(pp.startDate).startOf('day');
        let newEndDate = moment(newStartDate).add(cpDays, 'days');

        const cpStartDay = moment(cp.startDate).startOf('day');
        const cpEndDay = moment(cp.endDate).startOf('day');

        if (newEndDate.isAfter(maxDate)) {
            newStartDate = moment(maxDate).startOf('day').subtract(cpDays, 'days');
            newEndDate = moment(maxDate).startOf('day');
        }
        if (newStartDate.isBefore(minDate)) {
            newStartDate = moment(minDate).startOf('day');
            newEndDate = moment(minDate).startOf('day').add(cpDays, 'days');
        }

        // Overlap check
        if (moment.max(newStartDate, cpStartDay).isSameOrBefore(moment.min(newEndDate, cpEndDay))) {
            let tryBeforeStart = moment(cpStartDay).subtract(cpDays + 1, 'days');
            let tryBeforeEnd = moment(cpStartDay).subtract(1, 'days');

            if (tryBeforeStart.isSameOrAfter(moment(minDate).startOf('day'))) {
                newStartDate = tryBeforeStart;
                newEndDate = tryBeforeEnd;
            } else {
                let tryAfterStart = moment(cpEndDay).add(1, 'days');
                let tryAfterEnd = moment(cpEndDay).add(cpDays + 1, 'days');
                if (tryAfterEnd.isSameOrBefore(moment(maxDate).startOf('day'))) {
                    newStartDate = tryAfterStart;
                    newEndDate = tryAfterEnd;
                } else {
                    showToast("Not enough data to find a non-overlapping period of this size.", true);
                }
            }
        }

        pp.setStartDate(newStartDate);
        pp.setEndDate(newEndDate);

        // Ensure inputs reflect the true values visually.
        cpPicker.val(cpStartDay.format('YYYY-MM-DD') + ' - ' + cpEndDay.format('YYYY-MM-DD'));
        ppPicker.val(newStartDate.format('YYYY-MM-DD') + ' - ' + newEndDate.format('YYYY-MM-DD'));
    }

    cpPicker.on('apply.daterangepicker', syncPPRange);
    ppPicker.on('apply.daterangepicker', syncPPRange);

    // Initial sync
    syncPPRange();

    function applyComparison(showSuccessToast = true) {
        const cp = cpPicker.data('daterangepicker');
        const pp = ppPicker.data('daterangepicker');

        const cpDays = cp.endDate.diff(cp.startDate, 'days') + 1;
        const ppDays = pp.endDate.diff(pp.startDate, 'days') + 1;

        if (cpDays !== ppDays) {
            if (showSuccessToast) showToast(`Comparison ranges must be equal in size (${cpDays} days vs ${ppDays} days)`, true);
            return;
        }

        const cpStartDay = moment(cp.startDate).startOf('day');
        const cpEndDay = moment(cp.endDate).startOf('day');
        const ppStartDay = moment(pp.startDate).startOf('day');
        const ppEndDay = moment(pp.endDate).startOf('day');

        if (moment.max(cpStartDay, ppStartDay).isSameOrBefore(moment.min(cpEndDay, ppEndDay))) {
            if (showSuccessToast) showToast('Comparison ranges cannot overlap.', true);
            return;
        }

        const cpStartStr = cp.startDate.format('YYYY-MM-DD');
        const cpEndStr = cp.endDate.format('YYYY-MM-DD');
        const ppStartStr = pp.startDate.format('YYYY-MM-DD');
        const ppEndStr = pp.endDate.format('YYYY-MM-DD');

        // Filter daily trend
        const currentData = dailyTrend.filter(d => d.date >= cpStartStr && d.date <= cpEndStr);
        const previousData = dailyTrend.filter(d => d.date >= ppStartStr && d.date <= ppEndStr);

        const sumPeriod = (arr) => ({
            spend: Number(arr.reduce((s, d) => s + d.spend, 0).toFixed(2)),
            clicks: arr.reduce((s, d) => s + d.clicks, 0),
            impressions: arr.reduce((s, d) => s + d.impressions, 0),
            conversions: arr.reduce((s, d) => s + d.conversions, 0),
        });

        const safeDiv = (a, b) => b ? Number((a / b).toFixed(2)) : 0;
        const delta = (c, p) => p === 0 ? (c > 0 ? 100 : 0) : Number(((c - p) / p * 100).toFixed(1));

        const curr = sumPeriod(currentData);
        const prev = sumPeriod(previousData);

        curr.cpa = safeDiv(curr.spend, curr.conversions);
        prev.cpa = safeDiv(prev.spend, prev.conversions);

        // update summary
        dashboardData.summary.spend = curr.spend;
        dashboardData.summary.clicks = curr.clicks;
        dashboardData.summary.impressions = curr.impressions;
        dashboardData.summary.conversions = curr.conversions;
        dashboardData.summary.cpa = curr.cpa;
        dashboardData.summary.ctr = curr.impressions ? Number((curr.clicks / curr.impressions * 100).toFixed(2)) : 0;
        dashboardData.summary.cvr = curr.clicks ? Number((curr.conversions / curr.clicks * 100).toFixed(2)) : 0;
        dashboardData.summary.avgCpc = curr.clicks ? Number((curr.spend / curr.clicks).toFixed(2)) : 0;

        dashboardData.periodComparison = {
            previousPeriod: { label: `${ppStartStr} - ${ppEndStr}`, ...prev },
            currentPeriod: { label: `${cpStartStr} - ${cpEndStr}`, ...curr },
            deltas: {
                spend: delta(curr.spend, prev.spend),
                clicks: delta(curr.clicks, prev.clicks),
                impressions: delta(curr.impressions, prev.impressions),
                conversions: delta(curr.conversions, prev.conversions),
            }
        };

        renderKPIs();
        renderComparisonChart();
        if (showSuccessToast) {
            animateKPIs();
            showToast('Comparison applied successfully!', false);
        }
    }

    document.getElementById('applyComparisonBtn').addEventListener('click', () => applyComparison(true));
    applyComparison(false);
}

function populateGlobalFilters() {
    const campSelect = document.getElementById('globalCampaignFilter');
    const adgSelect = document.getElementById('globalAdGroupFilter');
    if (!campSelect || !adgSelect || !window.fullData) return;

    // Preserve existing selection
    const currentCamp = campSelect.value;
    
    campSelect.innerHTML = '<option value="All">All Campaigns</option>';

    const campaigns = new Set();
    (window.fullData.campaigns || []).forEach(c => {
        if (c.campaign || c.name) campaigns.add(c.campaign || c.name);
    });
    Array.from(campaigns).sort().forEach(c => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        campSelect.appendChild(opt);
    });
    if (campaigns.has(currentCamp)) campSelect.value = currentCamp;

    window.updateAdGroupDropdown = () => {
        const selectedCamp = campSelect.value;
        const currentAdG = adgSelect.value;
        adgSelect.innerHTML = '<option value="All">All Ad Groups</option>';

        const adGroups = new Set();
        (window.fullData.adGroups || []).forEach(a => {
            if (selectedCamp !== 'All' && a.campaign !== selectedCamp) return;
            if (a.adGroup || a.name) adGroups.add(a.adGroup || a.name);
        });
        Array.from(adGroups).sort().forEach(a => {
            const opt = document.createElement('option');
            opt.value = a;
            opt.textContent = a;
            adgSelect.appendChild(opt);
        });
        
        if (adGroups.has(currentAdG)) {
            adgSelect.value = currentAdG;
        } else {
            adgSelect.value = 'All';
        }
    };

    // Populate initially
    window.updateAdGroupDropdown();

    // Use a flag to avoid double binding
    if (!campSelect.hasAttribute('data-bound')) {
        campSelect.addEventListener('change', () => {
            window.updateAdGroupDropdown();
            const startD = localStorage.getItem('globalStartDate');
            const endD = localStorage.getItem('globalEndDate');
            if (startD && endD) applyLocalFilter(startD, endD);
        });
        campSelect.setAttribute('data-bound', 'true');
    }

    if (!adgSelect.hasAttribute('data-bound')) {
        adgSelect.addEventListener('change', () => {
            const startD = localStorage.getItem('globalStartDate');
            const endD = localStorage.getItem('globalEndDate');
            if (startD && endD) applyLocalFilter(startD, endD);
        });
        adgSelect.setAttribute('data-bound', 'true');
    }
}

function applyLocalFilter(startDate, endDate) {
    if (!window.fullData) return;

    if (startDate < window.fullData.meta.dateRange.start || endDate > window.fullData.meta.dateRange.end) {
        if (els.refreshBtn) els.refreshBtn.click();
        return;
    }

    const selCamp = document.getElementById('globalCampaignFilter')?.value || 'All';
    const selAdGroup = document.getElementById('globalAdGroupFilter')?.value || 'All';

    const filterData = (arr) => arr ? arr.filter(item => {
        if (item.date && (item.date < startDate || item.date > endDate)) return false;
        if (selCamp !== 'All' && item.campaign && item.campaign !== selCamp) return false;
        if (selAdGroup !== 'All' && item.adGroup && item.adGroup !== selAdGroup) return false;
        return true;
    }) : [];

    const agg = (filtered, type) => {
        const agged = new Map();
        filtered.forEach(item => {
            let key;
            if (type === 'campaign') key = item.id || item.campaign || item.name;
            else if (type === 'adGroup') key = item.id || (item.campaign + '|' + item.name);
            else if (type === 'keyword') key = item.campaign + '|' + item.adGroup + '|' + item.keyword + '|' + item.matchType;
            else if (type === 'searchTerm') key = item.campaign + '|' + item.adGroup + '|' + item.searchTerm;
            else if (type === 'landingPage') key = item.finalUrl;
            else if (type === 'date') key = item.date;
            else key = item.name || item.device || item.day || item.id;

            if (!agged.has(key)) {
                agged.set(key, { ...item, spend: 0, clicks: 0, impressions: 0, conversions: 0, conversionsValue: 0, _rawIS: 0, _rawLostBudget: 0, _rawLostRank: 0, _rawQS: 0 });
            }
            const curr = agged.get(key);
            curr.spend += item.spend || 0;
            curr.clicks += item.clicks || 0;
            curr.impressions += item.impressions || 0;
            curr.conversions += item.conversions || 0;
            if (item.conversionsValue) curr.conversionsValue += item.conversionsValue;

            // Weighted logic for percentages
            if (item.impressionShare !== undefined && item.impressionShare !== null) curr._rawIS += (item.impressionShare * (item.impressions || 0));
            if (item.lostISBudget !== undefined && item.lostISBudget !== null) curr._rawLostBudget += (item.lostISBudget * (item.impressions || 0));
            if (item.lostISRank !== undefined && item.lostISRank !== null) curr._rawLostRank += (item.lostISRank * (item.impressions || 0));
            if (item.qualityScore !== undefined && item.qualityScore !== null) curr._rawQS += (item.qualityScore * (item.impressions || 0));
        });

        return Array.from(agged.values()).map(item => {
            item.ctr = item.impressions ? (item.clicks / item.impressions) * 100 : 0;
            item.avgCpc = item.clicks ? item.spend / item.clicks : 0;
            item.cpa = item.conversions ? item.spend / item.conversions : 0;
            item.cvr = item.clicks ? (item.conversions / item.clicks) * 100 : 0;

            if (item._rawIS > 0) item.impressionShare = item.impressions ? item._rawIS / item.impressions : 0;
            if (item._rawLostBudget > 0) item.lostISBudget = item.impressions ? item._rawLostBudget / item.impressions : 0;
            if (item._rawLostRank > 0) item.lostISRank = item.impressions ? item._rawLostRank / item.impressions : 0;
            if (item._rawQS > 0) item.qualityScore = item.impressions ? item._rawQS / item.impressions : 0;

            delete item._rawIS;
            delete item._rawLostBudget;
            delete item._rawLostRank;
            delete item._rawQS;

            return item;
        });
    };

    const trendData = agg(filterData(window.fullData.dailyTrend), 'date').sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const campaigns = agg(filterData(window.fullData.campaigns), 'campaign');
    const dailyCampaigns = agg(filterData(window.fullData.campaigns), 'date').sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const adGroups = agg(filterData(window.fullData.adGroups), 'adGroup');
    const keywords = agg(filterData(window.fullData.keywords), 'keyword');
    const searchTerms = agg(filterData(window.fullData.searchTerms), 'searchTerm');
    const devicePerformance = agg(filterData(window.fullData.devicePerformance), 'device');
    const dayOfWeekPerformance = agg(filterData(window.fullData.dayOfWeekPerformance), 'day');
    const landingPages = agg(filterData(window.fullData.landingPages), 'landingPage');

    const dhFiltered = filterData(window.fullData.dayAndHourPerformance);
    const dhAgg = new Map();
    if (dhFiltered.length) {
        dhFiltered.forEach(item => {
            const key = item.day + '|' + item.hour;
            if (!dhAgg.has(key)) dhAgg.set(key, { ...item, spend: 0, clicks: 0, impressions: 0, conversions: 0 });
            const curr = dhAgg.get(key);
            curr.spend += item.spend || 0;
            curr.clicks += item.clicks || 0;
            curr.impressions += item.impressions || 0;
            curr.conversions += item.conversions || 0;
        });
    }
    const dhAggregated = Array.from(dhAgg.values()).map(item => {
        item.ctr = item.impressions ? (item.clicks / item.impressions) * 100 : 0;
        item.avgCpc = item.clicks ? item.spend / item.clicks : 0;
        item.cpa = item.conversions ? item.spend / item.conversions : 0;
        return item;
    });

    const summary = { spend: 0, clicks: 0, impressions: 0, conversions: 0 };
    trendData.forEach(d => {
        summary.spend += d.spend || 0;
        summary.clicks += d.clicks || 0;
        summary.impressions += d.impressions || 0;
        summary.conversions += d.conversions || 0;
    });
    summary.ctr = summary.impressions ? (summary.clicks / summary.impressions) * 100 : 0;
    summary.avgCpc = summary.clicks ? summary.spend / summary.clicks : 0;
    summary.cpa = summary.conversions ? summary.spend / summary.conversions : 0;
    summary.cvr = summary.clicks ? (summary.conversions / summary.clicks) * 100 : 0;

    dashboardData = {
        ...window.fullData,
        summary,
        globalSummary: JSON.parse(JSON.stringify(summary)),
        dailyTrend: trendData,
        campaigns,
        dailyCampaigns,
        adGroups,
        keywords,
        searchTerms,
        devicePerformance,
        dayOfWeekPerformance,
        dayAndHourPerformance: dhAggregated,
        landingPages,
        conversionActions: agg(filterData(window.fullData.conversionActions), 'name'),
        conversionAttribution: filterData(window.fullData.conversionAttribution),
        clickPaths: filterData(window.fullData.clickPaths),
    };

    if (dashboardData.meta) {
        dashboardData.meta.dateRange = { start: startDate, end: endDate };
    }

    renderGlobalKPIs();
    renderKPIs();
    renderCharts();
    renderInsights();
    renderTables();
    renderAttribution();
    renderRankDiagnostics();
    renderCompetitorWaste();
    renderProposals('all');
    animateKPIs();

    if (els.dateRange) els.dateRange.textContent = formatDateRange(startDate + ' - ' + endDate);
}

// Render Global KPIs
function renderGlobalKPIs() {
    const summary = dashboardData.globalSummary;
    const globalKpiGrid = document.getElementById('globalKpiGrid');
    if (!globalKpiGrid) return;

    const kpis = [
        { label: 'Total Spend', value: fmtCurr(summary.spend) },
        { label: 'Conversions', value: fmtNum(summary.conversions) },
        { label: 'CPA', value: fmtCurr(summary.cpa) },
        { label: 'Clicks', value: fmtNum(summary.clicks) },
        { label: 'Impressions', value: fmtNum(summary.impressions) },
        { label: 'CTR', value: fmtPct(summary.ctr) },
        { label: 'Avg CPC', value: fmtCurr(summary.avgCpc) },
        { label: 'Conv. Rate', value: fmtPct(summary.cvr) },
    ];

    globalKpiGrid.innerHTML = kpis.map(kpi => `
        <div class="card glass-card kpi-card" style="background: rgba(30, 41, 59, 0.4);">
            <span class="kpi-label" style="color: var(--text-main); font-weight: 500;">Overall ${kpi.label}</span>
            <span class="kpi-value" data-val="${kpi.value}">${kpi.value}</span>
        </div>
    `).join('');
}

// Render Comparison KPIs
function renderKPIs() {
    const { summary, periodComparison: pc } = dashboardData;
    const d = pc.deltas;

    const kpis = [
        { label: 'Total Spend', value: fmtCurr(summary.spend), delta: d.spend, goodUp: false },
        { label: 'Conversions', value: fmtNum(summary.conversions), delta: d.conversions, goodUp: true },
        { label: 'CPA', value: fmtCurr(summary.cpa), delta: pc.currentPeriod.cpa === 0 ? 0 : ((pc.currentPeriod.cpa - pc.previousPeriod.cpa) / pc.previousPeriod.cpa * 100), goodUp: false },
        { label: 'Clicks', value: fmtNum(summary.clicks), delta: d.clicks, goodUp: true },
        { label: 'Impressions', value: fmtNum(summary.impressions), delta: d.impressions, goodUp: true },
        { label: 'CTR', value: fmtPct(summary.ctr), delta: 0, goodUp: true },
        { label: 'Avg CPC', value: fmtCurr(summary.avgCpc), delta: 0, goodUp: false },
        { label: 'Conv. Rate', value: fmtPct(summary.cvr), delta: 0, goodUp: true },
    ];

    els.kpiGrid.innerHTML = kpis.map((kpi, i) => {
        let trendHtml = '';
        if (kpi.delta !== 0) {
            const isUp = kpi.delta > 0;
            const isGood = kpi.goodUp ? isUp : !isUp;
            const colorClass = isGood ? 'good' : 'bad';
            const arrow = isUp ? '▲' : '▼';
            trendHtml = `<span class="kpi-trend trend-${isUp ? 'up' : 'down'} ${colorClass}">
                ${arrow} ${Math.abs(kpi.delta).toFixed(1)}% vs prev period
            </span>`;
        }
        // Save the raw value so we can animate it
        const rawValue = kpi.label.includes('Rate') || kpi.label === 'CTR' ? summary.cvr : (kpi.label === 'Total Spend' ? summary.spend : (kpi.label === 'Conversions' ? summary.conversions : (kpi.label === 'CPA' ? summary.cpa : (kpi.label === 'Clicks' ? summary.clicks : (kpi.label === 'Impressions' ? summary.impressions : summary.avgCpc)))));

        return `
            <div class="card glass-card kpi-card">
                <span class="kpi-label">${kpi.label}</span>
                <span class="kpi-value" data-val="${kpi.value}">${kpi.value}</span>
                ${trendHtml}
            </div>
        `;
    }).join('');
}

function animateKPIs() {
    document.querySelectorAll('.kpi-value').forEach(el => {
        const finalStr = el.dataset.val;
        const isCurr = finalStr.includes(CURRENCY);
        const isPct = finalStr.includes('%');
        // A very simple fade-up animation for now to make it feel dynamic
        el.style.opacity = '0';
        el.style.transform = 'translateY(10px)';
        el.style.transition = 'opacity 0.6s ease-out, transform 0.6s ease-out';
        setTimeout(() => {
            el.style.opacity = '1';
            el.style.transform = 'translateY(0)';
        }, 100);
    });
}

// Charts
Chart.defaults.color = '#475569';
Chart.defaults.font.family = "'Inter', sans-serif";
Chart.defaults.borderColor = 'rgba(0, 0, 0, 0.05)';

function renderCharts() {
    renderComparisonChart();
    renderTrendChart();
    renderSankeyChart();
    if (dashboardData.devicePerformance) renderDeviceChart();
    renderTimePerformance();
    if (dashboardData.campaigns) renderCampaignBubbleChart();
    if (dashboardData.keywords) renderKeywordScatterChart();
    if (dashboardData.qualityScores) renderQsDoughnutChart();
    if (dashboardData.campaigns) renderImpressionShareChart();
    if (dashboardData.dailyCampaigns && dashboardData.dailyCampaigns.length > 0) renderImpressionShareOverTimeChart();
}

function renderComparisonChart() {
    const ctx = document.getElementById('comparisonChart').getContext('2d');
    const { periodComparison: pc } = dashboardData;

    if (charts.comp) charts.comp.destroy();

    charts.comp = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['Spend', 'Conversions', 'CPA', 'Clicks'],
            datasets: [
                {
                    label: 'Previous Period',
                    data: [pc.previousPeriod.spend, pc.previousPeriod.conversions, pc.previousPeriod.cpa, pc.previousPeriod.clicks],
                    backgroundColor: 'rgba(71, 85, 105, 0.2)',
                    borderRadius: 4
                },
                {
                    label: 'Current Period',
                    data: [pc.currentPeriod.spend, pc.currentPeriod.conversions, pc.currentPeriod.cpa, pc.currentPeriod.clicks],
                    backgroundColor: '#f25e36',
                    borderRadius: 4
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'top' } },
            scales: {
                y: { beginAtZero: true, grid: { display: false } },
                x: { grid: { display: false } }
            }
        }
    });
}

function renderTrendChart() {
    const ctx = document.getElementById('trendChart').getContext('2d');
    const metric = els.trendSelect.value;
    const { dailyTrend } = dashboardData;

    const labels = dailyTrend.map(d => d.date.split('-').slice(1).join('/')); // MM/DD

    const gradientPrimary = ctx.createLinearGradient(0, 0, 0, 400);
    gradientPrimary.addColorStop(0, 'rgba(242, 94, 54, 0.2)');
    gradientPrimary.addColorStop(1, 'rgba(242, 94, 54, 0.0)');

    const gradientWarning = ctx.createLinearGradient(0, 0, 0, 400);
    gradientWarning.addColorStop(0, 'rgba(16, 185, 129, 0.2)');
    gradientWarning.addColorStop(1, 'rgba(16, 185, 129, 0.0)');

    let datasets = [];
    if (metric === 'spend') {
        datasets = [
            {
                label: 'Spend',
                data: dailyTrend.map(d => d.spend),
                borderColor: '#f25e36',
                backgroundColor: gradientPrimary,
                fill: true,
                tension: 0.4,
                yAxisID: 'y'
            },
            {
                label: 'Conversions',
                data: dailyTrend.map(d => d.conversions),
                borderColor: '#10b981',
                borderDash: [5, 5],
                tension: 0.4,
                yAxisID: 'y1'
            }
        ];
    } else if (metric === 'cpa') {
        datasets = [{
            label: 'CPA (₹)',
            data: dailyTrend.map(d => d.cpa),
            borderColor: '#f59e0b',
            backgroundColor: gradientWarning,
            fill: true,
            tension: 0.4
        }];

    } else {
        datasets = [{
            label: 'Clicks',
            data: dailyTrend.map(d => d.clicks),
            borderColor: '#3b82f6',
            tension: 0.4
        }];
    }

    if (charts.trend) charts.trend.destroy();

    charts.trend = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                tooltip: {
                    backgroundColor: 'rgba(15, 23, 42, 0.9)',
                    titleFont: { size: 14, family: "'Inter', sans-serif" },
                    bodyFont: { size: 13, family: "'Inter', sans-serif" },
                    padding: 12,
                    cornerRadius: 8,
                    displayColors: true
                }
            },
            scales: {
                x: { grid: { display: false } },
                y: { type: 'linear', display: true, position: 'left' },
                y1: metric === 'spend' ? { type: 'linear', display: true, position: 'right', grid: { drawOnChartArea: false } } : undefined
            }
        }
    });
}

function renderSankeyChart() {
    const canvas = document.getElementById('sankeyChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const attr = dashboardData.conversionAttribution || [];

    if (attr.length === 0) {
        return; // No attribution data
    }

    // Build flow: SearchTerm -> Keyword -> Action
    const data = [];
    const colors = {};
    const labels = {};

    attr.forEach(a => {
        const termNode = `T: ${a.searchTerm}`;
        const keyNode = `K: ${a.keyword}`;
        const actNode = `A: ${a.conversionAction}`;

        data.push({ from: termNode, to: keyNode, flow: a.conversions });
        data.push({ from: keyNode, to: actNode, flow: a.conversions });

        colors[termNode] = '#3b82f6'; // Blue
        colors[keyNode] = '#8b5cf6';  // Purple
        colors[actNode] = '#10b981';  // Green

        labels[termNode] = a.searchTerm;
        labels[keyNode] = a.keyword;
        labels[actNode] = a.conversionAction;
    });

    if (charts.sankey) charts.sankey.destroy();

    charts.sankey = new Chart(ctx, {
        type: 'sankey',
        data: {
            datasets: [{
                label: 'Attribution Path',
                data: data,
                colorFrom: (c) => colors[c.dataset.data[c.dataIndex].from] || '#94a3b8',
                colorTo: (c) => colors[c.dataset.data[c.dataIndex].to] || '#94a3b8',
                colorMode: 'gradient',
                size: 'max',
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                tooltip: {
                    callbacks: {
                        title: () => 'Flow',
                        label: (c) => {
                            const d = c.raw;
                            return `${labels[d.from] || d.from} -> ${labels[d.to] || d.to}: ${d.flow} Conversions`;
                        }
                    }
                }
            }
        }
    });
}

// Insights
function renderInsights() {
    const { anomalies, aiDiagnoses } = dashboardData;

    let html = '';

    if (anomalies && anomalies.length > 0) {
        html += `
            <div class="insight-item" style="border-color: var(--danger)">
                <h4>⚠️ Anomalies Detected</h4>
                <ul>
                    ${anomalies.map(a => `<li style="color:var(--text-secondary);font-size:0.875rem;margin-bottom:0.25rem">${esc(a.message)} on ${esc(a.date)}</li>`).join('')}
                </ul>
            </div>
        `;
    }

    if (aiDiagnoses && aiDiagnoses.length > 0) {
        html += aiDiagnoses.map(d => `
            <div class="insight-item" style="border-color: var(--${d.severity || 'primary'})">
                <h4>${esc(d.title)}</h4>
                <p>${esc(d.description)}</p>
            </div>
        `).join('');
    }

    els.insightsGrid.innerHTML = html;
}

// AG Grid Instances
const gridInstances = {};

function initGrid(id, rowData, columnDefs) {
    const gridDiv = document.querySelector(`#${id}`);
    if (!gridDiv) return;
    gridDiv.innerHTML = ''; // clear old instances if any

    const gridOptions = {
        columnDefs: columnDefs,
        rowData: rowData,
        defaultColDef: {
            sortable: true,
            filter: true,
            resizable: true,
            flex: 1,
            minWidth: 100
        },
        pagination: true,
        paginationPageSize: 50,
        animateRows: true,
        theme: document.documentElement.classList.contains('dark') ? "ag-theme-alpine-dark" : "ag-theme-alpine",
    };

    const api = agGrid.createGrid(gridDiv, gridOptions);
    gridInstances[id] = api;

    // Bind search input
    const searchInput = document.querySelector(`.table-search[data-target="${id.replace('grid-', '')}Table"]`);
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            api.setGridOption('quickFilterText', e.target.value);
        });
    }
}

window.saveView = function (gridId) {
    const api = gridInstances[`grid-${gridId}`];
    if (!api) return;
    const filterState = api.getFilterModel();
    const sortState = api.getColumnState();
    localStorage.setItem(`gridState_${gridId}`, JSON.stringify({ filterState, sortState }));
    showToast(`View saved for ${gridId}!`);
};

window.loadView = function (gridId) {
    const api = gridInstances[`grid-${gridId}`];
    if (!api) return;
    const stateStr = localStorage.getItem(`gridState_${gridId}`);
    if (stateStr) {
        const state = JSON.parse(stateStr);
        if (state.filterState) api.setFilterModel(state.filterState);
        if (state.sortState) api.applyColumnState({ state: state.sortState, applyOrder: true });
        showToast(`View loaded for ${gridId}!`);
    } else {
        showToast(`No saved view found for ${gridId}.`);
    }
};

const currencyFormatter = params => params.value != null ? fmtCurr(params.value) : '';
const pctFormatter = params => params.value != null ? fmtPct(params.value) : '';

function renderTables() {
    // Ad Groups
    if (dashboardData.adGroups) {
        initGrid('grid-adGroups', dashboardData.adGroups, [
            { field: 'name', headerName: 'Ad Group', pinned: 'left' },
            { field: 'campaign', headerName: 'Campaign' },
            { field: 'status', headerName: 'Status' },
            { field: 'spend', headerName: 'Spend', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
            { field: 'impressions', headerName: 'Impr.', filter: 'agNumberColumnFilter' },
            { field: 'clicks', headerName: 'Clicks', filter: 'agNumberColumnFilter' },
            { field: 'ctr', headerName: 'CTR', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
            { field: 'avgCpc', headerName: 'Avg CPC', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
            { field: 'conversions', headerName: 'Conv.', filter: 'agNumberColumnFilter' },
            { field: 'cpa', headerName: 'CPA', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
            { field: 'cvr', headerName: 'CVR', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
        ]);
    }

    // Campaigns
    initGrid('grid-campaigns', dashboardData.campaigns, [
        { field: 'name', headerName: 'Campaign', pinned: 'left' },
        { field: 'status', headerName: 'Status' },
        { field: 'spend', headerName: 'Spend', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'impressions', headerName: 'Impr.', filter: 'agNumberColumnFilter' },
        { field: 'clicks', headerName: 'Clicks', filter: 'agNumberColumnFilter' },
        { field: 'ctr', headerName: 'CTR', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
        { field: 'avgCpc', headerName: 'Avg CPC', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'conversions', headerName: 'Conv.', filter: 'agNumberColumnFilter' },
        { field: 'cpa', headerName: 'CPA', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'cvr', headerName: 'CVR', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
        { field: 'lostISBudget', headerName: 'Lost IS (Budget)', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
        { field: 'lostISRank', headerName: 'Lost IS (Rank)', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' }
    ]);

    // Keywords
    initGrid('grid-keywords', dashboardData.keywords, [
        { field: 'keyword', headerName: 'Keyword', pinned: 'left', minWidth: 150 },
        { field: 'status', headerName: 'Status', valueFormatter: p => p.value === 'ENABLED' ? '🟢' : p.value === 'PAUSED' ? '⏸️' : '❌' },
        { field: 'matchType', headerName: 'Match' },
        { field: 'campaign', headerName: 'Campaign' },
        { field: 'adGroup', headerName: 'Ad Group' },
        { field: 'spend', headerName: 'Spend', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'impressions', headerName: 'Impr.', filter: 'agNumberColumnFilter' },
        { field: 'clicks', headerName: 'Clicks', filter: 'agNumberColumnFilter' },
        { field: 'ctr', headerName: 'CTR', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
        { field: 'avgCpc', headerName: 'Avg CPC', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'conversions', headerName: 'Conv.', filter: 'agNumberColumnFilter' },
        { field: 'cpa', headerName: 'CPA', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'cvr', headerName: 'CVR', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
        { field: 'impressionShare', headerName: 'Impr. Share', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
        { field: 'label', headerName: 'Suggestion' }
    ]);

    // Search Terms
    initGrid('grid-searchTerms', dashboardData.searchTerms, [
        { field: 'searchTerm', headerName: 'Search Term', pinned: 'left', minWidth: 150 },
        { field: 'status', headerName: 'Status' },
        { field: 'campaign', headerName: 'Campaign' },
        { field: 'adGroup', headerName: 'Ad Group' },
        { field: 'spend', headerName: 'Spend', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'impressions', headerName: 'Impr.', filter: 'agNumberColumnFilter' },
        { field: 'clicks', headerName: 'Clicks', filter: 'agNumberColumnFilter' },
        { field: 'ctr', headerName: 'CTR', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
        { field: 'avgCpc', headerName: 'Avg CPC', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'conversions', headerName: 'Conv.', filter: 'agNumberColumnFilter' },
        { field: 'cpa', headerName: 'CPA', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'cvr', headerName: 'CVR', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
        { field: 'label', headerName: 'Suggestion' }
    ]);
}

function renderAttribution() {
    const actions = dashboardData.conversionActions || [];
    const attribution = dashboardData.conversionAttribution || [];
    const clicks = dashboardData.clickPaths || [];
    const capability = dashboardData.attributionCapability || {};

    if (els.attributionBadge) {
        els.attributionBadge.textContent = `${attribution.length} rows`;
    }

    if (els.attributionSummary) {
        els.attributionSummary.innerHTML = `
            <div class="insight-item" style="border-color: var(--success)">
                <h4>Conversion Actions Loaded</h4>
                <p>${fmtNum(actions.reduce((s, a) => s + (a.conversions || 0), 0))} conversions across ${fmtNum(actions.length)} action rows.</p>
            </div>
            <div class="insight-item" style="border-color: ${capability.canReadClickIds ? 'var(--success)' : 'var(--warning)'}">
                <h4>Session Proof</h4>
                <p>${capability.canReadClickIds ? 'Click IDs loaded from Google Ads click_view. Exact website session proof still requires Zenseeo to persist click IDs on form/trial/demo events.' : 'Google Ads attribution loaded, but no click_view/GCLID file is present yet.'}</p>
            </div>
        `;
    }

    initGrid('grid-conversionActions', actions, [
        { field: 'date', headerName: 'Date' },
        { field: 'name', headerName: 'Action', pinned: 'left' },
        { field: 'category', headerName: 'Category' },
        { field: 'status', headerName: 'Status' },
        { field: 'primaryForGoal', headerName: 'Goal', valueFormatter: p => p.value ? '⭐ Primary' : 'Secondary' },
        { field: 'conversions', headerName: 'Conv.', filter: 'agNumberColumnFilter' }
    ]);

    initGrid('grid-clickPaths', clicks, [
        { field: 'date', headerName: 'Date' },
        { field: 'gclid', headerName: 'GCLID', valueFormatter: p => shortId(p.value) },
        { field: 'keyword', headerName: 'Keyword', pinned: 'left' },
        { field: 'device', headerName: 'Device' },
        { field: 'slot', headerName: 'Slot' },
        { field: 'clicks', headerName: 'Clicks', filter: 'agNumberColumnFilter' }
    ]);

    initGrid('grid-conversionAttribution', attribution, [
        { field: 'date', headerName: 'Date' },
        { field: 'searchTerm', headerName: 'Search Term', pinned: 'left' },
        { field: 'keyword', headerName: 'Keyword' },
        { field: 'matchType', headerName: 'Match' },
        { field: 'conversionAction', headerName: 'Conversion Action' },
        { field: 'conversionCategory', headerName: 'Category' },
        { field: 'conversions', headerName: 'Conv.', filter: 'agNumberColumnFilter' }
    ]);
}

function renderRankDiagnostics() {
    const constraints = dashboardData.insights?.constraints || [];
    const competitors = dashboardData.competitorBreakdown || [];
    const quality = dashboardData.qualityScores || [];
    const landingPages = dashboardData.landingPages || [];
    const auctionInsights = dashboardData.auctionInsights || [];

    if (els.rankSummary) {
        const c = constraints[0] || {};
        const constraintText = c.lostISBudget !== null && c.lostISBudget !== undefined
            ? `Campaign "${esc(c.campaign)}" has ${fmtPct(c.impressionShare)} impression share, ${fmtPct(c.lostISBudget)} lost to budget, ${fmtPct(c.lostISRank)} lost to rank.`
            : 'Campaign impression-share constraints not loaded.';
        els.rankSummary.innerHTML = `
            <div class="insight-item" style="border-color: var(--warning)">
                <h4>Budget Constraint</h4>
                <p>${constraintText}</p>
            </div>
            <div class="insight-item" style="border-color: var(--danger)">
                <h4>Rank Constraint</h4>
                <p>${fmtNum(quality.filter(q => q.qualityScore > 0 && q.qualityScore <= 3).length)} low-QS keywords loaded. Rebuild ad groups and competitor landing pages first.</p>
            </div>
            <div class="insight-item" style="border-color: ${auctionInsights.length ? 'var(--success)' : 'var(--info)'}">
                <h4>Auction Insights</h4>
                <p>${auctionInsights.length ? `${fmtNum(auctionInsights.length)} rival-domain rows loaded.` : 'Rival domain overlap/outranking unavailable from current API token; use Ads UI export or API access upgrade.'}</p>
            </div>
        `;
    }

    initGrid('grid-competitors', competitors, [
        { field: 'competitor', headerName: 'Competitor', pinned: 'left' },
        { field: 'impressions', headerName: 'Impr.', filter: 'agNumberColumnFilter' },
        { field: 'clicks', headerName: 'Clicks', filter: 'agNumberColumnFilter' },
        { field: 'spend', headerName: 'Spend', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'conversions', headerName: 'Conv.', filter: 'agNumberColumnFilter' },
        { field: 'impressionShare', headerName: 'Share', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
        { field: 'qualityScore', headerName: 'QS', filter: 'agNumberColumnFilter' }
    ]);

    initGrid('grid-qualityScore', quality, [
        { field: 'keyword', headerName: 'Keyword', pinned: 'left' },
        { field: 'matchType', headerName: 'Match' },
        { field: 'qualityScore', headerName: 'QS', filter: 'agNumberColumnFilter', cellStyle: params => params.value > 0 && params.value <= 3 ? { color: '#ef4444' } : null },
        { field: 'adRelevance', headerName: 'Ad Relevance' },
        { field: 'landingPageExperience', headerName: 'Landing Page' },
        { field: 'expectedCtr', headerName: 'Expected CTR' }
    ]);

    initGrid('grid-landingPages', landingPages, [
        { field: 'finalUrl', headerName: 'Final URL', pinned: 'left', minWidth: 200 },
        { field: 'spend', headerName: 'Spend', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'clicks', headerName: 'Clicks', filter: 'agNumberColumnFilter' },
        { field: 'conversions', headerName: 'Conv.', filter: 'agNumberColumnFilter' },
        { field: 'cvr', headerName: 'CVR', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
        { field: 'cpa', headerName: 'CPA', valueFormatter: params => params.data.conversions > 0 ? fmtCurr(params.value) : 'n/a', filter: 'agNumberColumnFilter' }
    ]);

    if (auctionInsights) {
        initGrid('grid-auctionInsights', auctionInsights, [
            { field: 'domain', headerName: 'Domain', pinned: 'left', minWidth: 200 },
            { field: 'impressionShare', headerName: 'Impr. Share', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
            { field: 'overlapRate', headerName: 'Overlap Rate', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
            { field: 'positionAboveRate', headerName: 'Position Above', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
            { field: 'outrankingShare', headerName: 'Outranking Share', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' }
        ]);
    }
}

// Proposals
function renderProposals(filter) {
    const props = dashboardData.proposals || [];
    const activeProps = props.filter(p => p.status !== 'accepted' && p.status !== 'rejected');
    els.proposalCount.textContent = activeProps.length;

    let filtered = activeProps;
    if (filter !== 'all') {
        filtered = activeProps.filter(p => p.priority.toLowerCase() === filter);
    }

    if (filtered.length === 0) {
        els.proposalsGrid.innerHTML = `<div style="color:var(--text-muted); padding:2rem;">No proposals found for this filter.</div>`;
        return;
    }

    els.proposalsGrid.innerHTML = filtered.sort((a, b) => {
        const p = { critical: 4, high: 3, medium: 2, low: 1 };
        return p[b.priority] - p[a.priority];
    }).map(p => `
        <div class="card glass-card proposal-card" id="prop-${esc(p.proposal_id)}">
            <div class="card-header" style="border:none; padding-bottom:0.5rem">
                <div style="display:flex; flex-direction:column;">
                    <span class="proposal-type">${esc(p.type.replace(/_/g, ' '))}</span>
                    <h3 class="proposal-summary">${esc(p.summary)}</h3>
                </div>
            </div>
            <div style="padding: 0 1.5rem">
                <div class="proposal-badges" style="margin-bottom:1rem">
                    <span class="prop-badge badge-${esc(p.priority)}">Pri: ${esc(p.priority)}</span>
                    <span class="prop-badge badge-${p.risk_level === 'high' ? 'high' : 'medium'}">Risk: ${esc(p.risk_level)}</span>
                </div>
                
                <div class="proposal-evidence">
                    <strong>Evidence:</strong> ${esc(p.reasoning_summary)}
                </div>
            </div>
            
            <div style="flex-grow:1"></div>
            
            <div class="proposal-actions">
                <button class="btn-action btn-accept" onclick="handleProposal('${esc(p.proposal_id)}', 'accept')">Accept</button>
                <button class="btn-action btn-reject" onclick="handleProposal('${esc(p.proposal_id)}', 'reject')">Reject</button>
            </div>
        </div>
    `).join('');
}

window.handleProposal = function (id, action) {
    const card = document.getElementById(`prop-${id}`);
    if (!card) return;
    card.style.opacity = '0.5';
    card.style.pointerEvents = 'none';

    const API_BASE = localStorage.getItem('API_BASE') || 'http://localhost:8080';
    const API_KEY = localStorage.getItem('API_KEY');

    let status = 'pending_review';
    if (action === 'accept') status = 'accepted';
    else if (action === 'reject') status = 'rejected';

    fetch(`${API_BASE}/api/proposals/${id}/status`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({ status })
    })
        .then(async res => {
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Failed to update proposal status');

            showToast(`Proposal ${action}ed successfully.`);

            // Update local memory
            if (dashboardData && dashboardData.proposals) {
                const prop = dashboardData.proposals.find(p => p.proposal_id === id);
                if (prop) prop.status = status;
            }

            // Fading out transition
            card.style.transition = 'all 0.5s ease';
            card.style.transform = 'scale(0.9)';
            card.style.opacity = '0';
            setTimeout(() => {
                const activeFilterBtn = document.querySelector('.filter-btn.active');
                const currentFilter = activeFilterBtn ? activeFilterBtn.dataset.filter : 'all';
                renderProposals(currentFilter);
            }, 500);
        })
        .catch(err => {
            console.error(err);
            showToast(`Error: ${err.message}`, true);
            card.style.opacity = '1';
            card.style.pointerEvents = 'auto';
        });
};

function showToast(msg, persist = false) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    if (!persist) {
        setTimeout(() => {
            els.toast.classList.remove('show');
        }, 3000);
    }
}

// Interaction Enhancements
function makeTablesResponsiveAndSortable() {
    document.querySelectorAll('.data-table').forEach(table => {
        const headers = Array.from(table.querySelectorAll('th'));

        // 1. Inject data-label for mobile CSS cards
        table.querySelectorAll('tbody tr').forEach(row => {
            Array.from(row.children).forEach((cell, i) => {
                if (headers[i]) {
                    cell.setAttribute('data-label', headers[i].textContent.replace(/↑|↓/g, '').trim());
                }
            });
        });

        // 2. Setup sortable headers
        headers.forEach((th, i) => {
            th.style.cursor = 'pointer';
            th.title = 'Click to sort';
            // Clone to remove old listeners if re-rendering
            const newTh = th.cloneNode(true);
            th.parentNode.replaceChild(newTh, th);
            newTh.addEventListener('click', () => sortTable(table, i));
        });
    });
}

function sortTable(table, colIndex) {
    const tbody = table.querySelector('tbody');
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const isAsc = table.dataset.sortCol == colIndex && table.dataset.sortDir === 'asc';

    table.dataset.sortCol = colIndex;
    table.dataset.sortDir = isAsc ? 'desc' : 'asc';

    table.querySelectorAll('th').forEach((th, i) => {
        th.textContent = th.textContent.replace(' ↑', '').replace(' ↓', '');
        if (i === colIndex) th.textContent += isAsc ? ' ↓' : ' ↑';
    });

    rows.sort((a, b) => {
        const aVal = a.children[colIndex].textContent.trim().replace(/₹|,|%|n\/a/g, '');
        const bVal = b.children[colIndex].textContent.trim().replace(/₹|,|%|n\/a/g, '');
        const aNum = parseFloat(aVal);
        const bNum = parseFloat(bVal);

        if (!isNaN(aNum) && !isNaN(bNum)) {
            return isAsc ? aNum - bNum : bNum - aNum;
        }
        return isAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    });

    tbody.innerHTML = '';
    rows.forEach(r => tbody.appendChild(r));
}

function setupSearchFilters() {
    document.querySelectorAll('.table-search').forEach(input => {
        input.addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            const targetId = e.target.dataset.target;
            const tbody = document.querySelector(`#${targetId} tbody`);
            if (!tbody) return;

            Array.from(tbody.querySelectorAll('tr')).forEach(row => {
                const text = row.textContent.toLowerCase();
                row.style.display = text.includes(term) ? '' : 'none';
            });
        });
    });
}

function renderDeviceChart() {
    const el = document.getElementById('deviceChart');
    if (!el) return;
    if (charts.device) charts.device.destroy();

    charts.device = new Chart(el.getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: dashboardData.devicePerformance ? dashboardData.devicePerformance.map(d => d.device) : [],
            datasets: [{
                data: dashboardData.devicePerformance ? dashboardData.devicePerformance.map(d => d.spend) : [],
                backgroundColor: ['#f25e36', '#3b82f6', '#10b981', '#f59e0b'],
                borderWidth: 0
            }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } }
    });
}


function renderCampaignBubbleChart() {
    const el = document.getElementById('campaignBubbleChart');
    if (!el) return;
    if (charts.campaignBubble) charts.campaignBubble.destroy();

    charts.campaignBubble = new Chart(el.getContext('2d'), {
        type: 'bubble',
        data: {
            datasets: [{
                label: 'Campaigns',
                data: dashboardData.campaigns ? dashboardData.campaigns.map(c => ({
                    x: c.spend,
                    y: c.cpa,
                    r: Math.min(Math.max((c.conversions || 0) * 2, 5), 30),
                    conv: c.conversions,
                    name: c.name || c.campaign || 'Unknown'
                })) : [],
                backgroundColor: 'rgba(59, 130, 246, 0.6)',
                borderColor: '#3b82f6'
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { tooltip: { callbacks: { label: (ctx) => `${ctx.raw.name}: Spend ${fmtCurr(ctx.raw.x)}, CPA ${fmtCurr(ctx.raw.y)}, Conv: ${fmtNum(ctx.raw.conv)}` } } },
            scales: { x: { title: { display: true, text: 'Spend (₹)' } }, y: { title: { display: true, text: 'CPA (₹)' } } }
        }
    });
}

function renderKeywordScatterChart() {
    const el = document.getElementById('keywordScatterChart');
    if (!el) return;
    if (charts.keywordScatter) charts.keywordScatter.destroy();

    charts.keywordScatter = new Chart(el.getContext('2d'), {
        type: 'scatter',
        data: {
            datasets: [{
                label: 'Keywords',
                data: dashboardData.keywords ? dashboardData.keywords.map(k => ({
                    x: k.avgCpc,
                    y: parseFloat(k.cvr) || 0,
                    name: k.keyword
                })) : [],
                backgroundColor: '#10b981'
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { tooltip: { callbacks: { label: (ctx) => `${ctx.raw.name}: CPC ${fmtCurr(ctx.raw.x)}, CVR ${fmtPct(ctx.raw.y)}` } } },
            scales: { x: { title: { display: true, text: 'Avg CPC (₹)' } }, y: { title: { display: true, text: 'Conversion Rate (%)' } } }
        }
    });
}

function renderQsDoughnutChart() {
    const el = document.getElementById('qsDoughnutChart');
    if (!el) return;
    if (charts.qsDoughnut) charts.qsDoughnut.destroy();

    let high = 0, med = 0, low = 0;
    if (dashboardData.qualityScores) {
        dashboardData.qualityScores.forEach(q => {
            if (q.qualityScore >= 8) high++;
            else if (q.qualityScore >= 5) med++;
            else if (q.qualityScore > 0) low++;
        });
    }

    charts.qsDoughnut = new Chart(el.getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: ['High (8-10)', 'Medium (5-7)', 'Low (1-4)'],
            datasets: [{
                data: [high, med, low],
                backgroundColor: ['#10b981', '#f59e0b', '#ef4444'],
                borderWidth: 0
            }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } }
    });
}

function renderImpressionShareChart() {
    const el = document.getElementById('impressionShareChart');
    if (!el) return;
    if (charts.impressionShare) charts.impressionShare.destroy();

    const constraints = dashboardData.campaigns ? dashboardData.campaigns.slice(0, 10) : []; // Top 10

    charts.impressionShare = new Chart(el.getContext('2d'), {
        type: 'bar',
        data: {
            labels: constraints.map(c => c.name),
            datasets: [
                { label: 'IS Won', data: constraints.map(c => parseFloat(c.impressionShare) || 0), backgroundColor: '#10b981' },
                { label: 'Lost to Budget', data: constraints.map(c => parseFloat(c.lostISBudget) || 0), backgroundColor: '#f59e0b' },
                { label: 'Lost to Rank', data: constraints.map(c => parseFloat(c.lostISRank) || 0), backgroundColor: '#ef4444' }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: { x: { stacked: true }, y: { stacked: true, max: 100 } }
        }
    });
}

function renderImpressionShareOverTimeChart() {
    const el = document.getElementById('impressionShareTimeChart');
    if (!el) return;
    if (charts.impressionShareTime) charts.impressionShareTime.destroy();

    const data = dashboardData.dailyCampaigns || [];

    charts.impressionShareTime = new Chart(el.getContext('2d'), {
        type: 'bar',
        data: {
            labels: data.map(d => formatDateShort(d.date)),
            datasets: [
                { label: 'IS Won', data: data.map(d => parseFloat(d.impressionShare) || 0), backgroundColor: '#10b981' },
                { label: 'Lost to Budget', data: data.map(d => parseFloat(d.lostISBudget) || 0), backgroundColor: '#f59e0b' },
                { label: 'Lost to Rank', data: data.map(d => parseFloat(d.lostISRank) || 0), backgroundColor: '#ef4444' }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: { x: { stacked: true }, y: { stacked: true, max: 100 } }
        }
    });
}

function renderCompetitorWaste() {
    const grid = document.getElementById('competitorWasteGrid');
    if (!grid) return;
    
    const competitorRows = (dashboardData.keywords || []).filter(k => k.isCompetitor);
    const spend = competitorRows.reduce((acc, row) => acc + (row.spend || 0), 0);
    const conv = competitorRows.reduce((acc, row) => acc + (row.conversions || 0), 0);
    const totalSpend = dashboardData.summary?.spend || 0;
    const share = totalSpend > 0 ? (spend / totalSpend) * 100 : 0;

    const kpis = [
        { label: 'Wasted Spend', value: fmtCurr(spend), isBad: spend > 0 },
        { label: 'Accidental Conversions', value: fmtNum(conv), isBad: false },
        { label: 'Budget Bleed', value: fmtPct(share), isBad: share > 5 }
    ];

    grid.innerHTML = kpis.map(kpi => `
        <div style="padding: 1.25rem; border-radius: 8px; border: 1px solid ${kpi.isBad ? 'rgba(239, 68, 68, 0.2)' : 'rgba(255,255,255,0.05)'}; background: ${kpi.isBad ? 'rgba(239, 68, 68, 0.05)' : 'rgba(30, 41, 59, 0.4)'};">
            <div style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 0.5px;">${kpi.label}</div>
            <div style="font-size: 1.75rem; font-weight: 600; color: ${kpi.isBad ? 'var(--danger)' : 'var(--text-main)'};">${kpi.value}</div>
        </div>
    `).join('');
}

function initTheme() {
    const savedTheme = localStorage.getItem('dashboard-theme') || 'system';
    setTheme(savedTheme, false);

    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const theme = e.currentTarget.dataset.theme;
            setTheme(theme, true);
        });
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
        if (localStorage.getItem('dashboard-theme') === 'system') {
            setTheme('system', false);
        }
    });
}

function setTheme(theme, reRender = true) {
    localStorage.setItem('dashboard-theme', theme);

    document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
    const activeBtn = document.querySelector(`.theme-btn[data-theme="${theme}"]`);
    if (activeBtn) activeBtn.classList.add('active');

    const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

    if (isDark) {
        document.documentElement.classList.add('dark');
        Chart.defaults.color = '#94a3b8';
        Chart.defaults.borderColor = 'rgba(255, 255, 255, 0.05)';
    } else {
        document.documentElement.classList.remove('dark');
        Chart.defaults.color = '#475569';
        Chart.defaults.borderColor = 'rgba(0, 0, 0, 0.05)';
    }

    if (reRender) {
        renderCharts();

        document.querySelectorAll('[class*="ag-theme-alpine"]').forEach(grid => {
            if (isDark) {
                grid.classList.remove('ag-theme-alpine');
                grid.classList.add('ag-theme-alpine-dark');
            } else {
                grid.classList.remove('ag-theme-alpine-dark');
                grid.classList.add('ag-theme-alpine');
            }
        });
    }
}

function renderTimePerformance() {
    const metric = document.getElementById('dayHourMetricSelect')?.value || 'clicks';
    const dayData = dashboardData.dayOfWeekPerformance || [];
    const hourData = dashboardData.dayAndHourPerformance || [];

    // 1. Day Horizontal Bar Chart
    const dayCtx = document.getElementById('dayHorizontalChart')?.getContext('2d');
    if (dayCtx) {
        if (charts.dayHorizontal) charts.dayHorizontal.destroy();
        const days = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
        const daySorted = days.map(day => dayData.find(d => d.day === day) || {});
        charts.dayHorizontal = new Chart(dayCtx, {
            type: 'bar',
            data: {
                labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
                datasets: [{
                    label: metric.toUpperCase(),
                    data: daySorted.map(d => d[metric] || 0),
                    backgroundColor: '#3b82f6'
                }]
            },
            options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
        });
    }

    // 2. Hour Vertical Bar Chart
    const hourCtx = document.getElementById('hourVerticalChart')?.getContext('2d');
    if (hourCtx) {
        if (charts.hourVertical) charts.hourVertical.destroy();
        const hours = Array.from({ length: 24 }, (_, i) => i);
        const aggHours = hours.map(h => {
            const matches = hourData.filter(d => parseInt(d.hour) === h);
            return matches.reduce((sum, item) => sum + (item[metric] || 0), 0);
        });
        charts.hourVertical = new Chart(hourCtx, {
            type: 'bar',
            data: {
                labels: hours.map(h => h + ':00'),
                datasets: [{
                    label: metric.toUpperCase(),
                    data: aggHours,
                    backgroundColor: '#3b82f6'
                }]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
        });
    }

    // 3. Day & Hour Heatmap
    const heatmapEl = document.getElementById('dayHourHeatmap');
    if (heatmapEl) {
        const days = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
        const hours = Array.from({ length: 24 }, (_, i) => i);

        let maxVal = 0.0001;
        hourData.forEach(d => { if ((d[metric] || 0) > maxVal) maxVal = d[metric]; });

        let html = `<div style="display: grid; grid-template-columns: 40px repeat(24, 1fr); gap: 2px;">`;
        html += `<div></div>`;
        hours.forEach(h => html += `<div style="font-size: 10px; color: var(--text-muted); text-align: center;">${h}</div>`);

        days.forEach(day => {
            html += `<div style="font-size: 10px; color: var(--text-muted); display: flex; align-items: center;">${day.substring(0, 3)}</div>`;
            hours.forEach(hour => {
                const item = hourData.find(d => d.day === day && parseInt(d.hour) === hour);
                const val = item ? (item[metric] || 0) : 0;
                const opacity = Math.min(val / maxVal, 1);
                const alpha = val > 0 ? Math.max(opacity, 0.1) : 0;

                const dayName = day.charAt(0) + day.slice(1).toLowerCase();
                const hStart = hour.toString().padStart(2, '0');
                const hEnd = (hour + 1).toString().padStart(2, '0');

                let formatVal = fmtNum(val);
                if (['ctr', 'cvr'].includes(metric)) formatVal = fmtPct(val);
                if (['spend', 'cpa', 'avgCpc'].includes(metric)) formatVal = '$' + fmtNum(val);

                html += `<div class="heatmap-cell" data-day="${dayName}, ${hStart} - ${hEnd}" data-metric="${metric.charAt(0).toUpperCase() + metric.slice(1)}" data-val="${formatVal}" style="background-color: rgba(59, 130, 246, ${alpha}); height: 24px; border-radius: 2px; cursor: pointer;"></div>`;
            });
        });
        html += `</div>`;
        heatmapEl.innerHTML = html;

        // Custom Tooltip Logic
        let tooltip = document.getElementById('heatmapTooltip');
        if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.id = 'heatmapTooltip';
            tooltip.style.position = 'absolute';
            tooltip.style.display = 'none';
            tooltip.style.backgroundColor = 'var(--bg-card)';
            tooltip.style.border = '1px solid var(--border-color)';
            tooltip.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)';
            tooltip.style.padding = '12px 16px';
            tooltip.style.borderRadius = '4px';
            tooltip.style.zIndex = '1000';
            tooltip.style.pointerEvents = 'none';
            tooltip.style.minWidth = '140px';
            tooltip.style.color = 'var(--text-color)';
            document.body.appendChild(tooltip);
        }

        document.querySelectorAll('.heatmap-cell').forEach(cell => {
            cell.addEventListener('mouseenter', (e) => {
                tooltip.style.display = 'block';
                const d = e.target.dataset;
                tooltip.innerHTML = `
                    <div style="font-size: 14px; margin-bottom: 12px; color: var(--text-color);">${d.day}</div>
                    <div style="font-size: 13px; color: var(--text-muted); margin-bottom: 8px;">${d.metric}</div>
                    <div style="font-size: 20px; font-weight: 400; display: flex; align-items: center; gap: 8px; color: var(--text-color);">
                        <span style="display:inline-block; width:16px; height:12px; background-color:#3b82f6;"></span>
                        ${d.val}
                    </div>
                `;
            });
            cell.addEventListener('mousemove', (e) => {
                // Keep it near the cursor
                tooltip.style.left = (e.pageX + 15) + 'px';
                tooltip.style.top = (e.pageY + 15) + 'px';
            });
            cell.addEventListener('mouseleave', () => {
                tooltip.style.display = 'none';
            });
        });
    }
}

// Boot
document.addEventListener('DOMContentLoaded', init);
