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
const jsArg = (value) => esc(JSON.stringify(String(value ?? '')));
const shortId = (value) => {
    const text = String(value || '');
    return text.length > 18 ? `${text.slice(0, 10)}…${text.slice(-6)}` : text;
};
const statusClass = (value) => String(value || 'pending').toLowerCase().replace(/[^a-z0-9_]+/g, '_');
const statusLabel = (value) => String(value || 'pending_review').replace(/_/g, ' ');
const impactLabelText = (value) => ({
    success_high_confidence: 'success, high confidence',
    success_low_confidence: 'success, low confidence',
    failure_high_confidence: 'failure, high confidence',
    failure_low_confidence: 'failure, low confidence',
    neutral_insufficient_data: 'not enough data',
    neutral_confounded: 'unclear: other changes',
    neutral_mixed: 'mixed result'
}[String(value || '')] || statusLabel(value));

function objectValue(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
            return null;
        }
    }
    return null;
}

function latestImpactDetails(proposal) {
    const latest = objectValue(proposal?.latest_impact);
    const fromLatest = objectValue(latest?.outcome_details_30) || objectValue(latest?.outcome_details_14);
    if (fromLatest) return fromLatest;
    const rows = Array.isArray(proposal?.impact_tracking) ? proposal.impact_tracking : [];
    for (const row of rows) {
        const details = objectValue(row?.outcome_details_30) || objectValue(row?.outcome_details_14);
        if (details) return details;
    }
    return null;
}
const LEAD_STATUS_META = {
    new: {
        label: 'Needs review',
        shortLabel: 'Needs review',
        description: 'No one has labelled this lead yet.',
        color: '#94a3b8'
    },
    qualified: {
        label: 'Qualified - follow up',
        shortLabel: 'Qualified',
        description: 'A real sales opportunity that should be followed up.',
        color: '#3b82f6'
    },
    converted: {
        label: 'Won customer',
        shortLabel: 'Won',
        description: 'This lead became a customer.',
        color: '#10b981'
    },
    qualified_lost: {
        label: 'Qualified but lost',
        shortLabel: 'Lost',
        description: 'Real opportunity, but it did not close.',
        color: '#f59e0b'
    },
    useless: {
        label: 'Junk / not a fit',
        shortLabel: 'Junk',
        description: 'Spam, irrelevant, duplicate, or not worth sales time.',
        color: '#ef4444'
    }
};
const LEAD_STATUS_ORDER = ['new', 'qualified', 'converted', 'qualified_lost', 'useless'];

function normalizeLeadStatus(value) {
    const normalized = String(value || 'new').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (['junk', 'spam', 'invalid', 'bad_fit', 'bad'].includes(normalized)) return 'useless';
    if (['lost', 'closed_lost', 'qualified_lost_lead'].includes(normalized)) return 'qualified_lost';
    if (['customer', 'won', 'paid'].includes(normalized)) return 'converted';
    return LEAD_STATUS_META[normalized] ? normalized : 'new';
}

function leadStatusMeta(value) {
    return LEAD_STATUS_META[normalizeLeadStatus(value)] || LEAD_STATUS_META.new;
}

function leadStatusLabel(value, short = false) {
    const meta = leadStatusMeta(value);
    return short ? meta.shortLabel : meta.label;
}

function leadStatusDescription(value) {
    return leadStatusMeta(value).description;
}

function actionKindLabel(value) {
    const raw = String(value || '').trim();
    if (!raw || raw === '(no action kind)') return 'Lead captured';
    const normalized = raw.toLowerCase().replace(/[_-]+/g, ' ');
    const labels = {
        demo: 'Demo request',
        whatsapp: 'WhatsApp click',
        trial: 'Trial signup',
        signup: 'Signup',
        contact: 'Contact form',
        form_submit: 'Form submitted',
        lead: 'Lead captured'
    };
    return labels[raw] || labels[normalized] || normalized.replace(/\b\w/g, c => c.toUpperCase());
}

function formatActionPath(value) {
    const raw = String(value || '').trim();
    if (!raw || raw === '(no action kind)') return 'Lead captured; action label was not sent';
    return raw.split(' -> ').map(actionKindLabel).join(' -> ');
}

function formatDateTime(value) {
    if (!value) return 'Not recorded';
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? String(value)
        : date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatDateTimeIst(value) {
    if (!value) return 'Not recorded';
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? String(value)
        : date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
}

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
let API_BASE_GLOBAL = '';
let API_KEY_GLOBAL = '';
let HF_TOKEN_GLOBAL = '';

function authHeaders(extra = {}) {
    const headers = { ...extra };
    if (HF_TOKEN_GLOBAL) {
        headers['Authorization'] = `Bearer ${HF_TOKEN_GLOBAL}`;
        if (API_KEY_GLOBAL) {
            headers['X-API-Key'] = API_KEY_GLOBAL;
        }
    } else if (API_KEY_GLOBAL) {
        headers['Authorization'] = `Bearer ${API_KEY_GLOBAL}`;
    }
    return headers;
}

function dashboardFetch(url, options = {}) {
    return fetch(url, {
        credentials: API_KEY_GLOBAL ? 'omit' : 'include',
        ...options,
        headers: authHeaders(options.headers || {})
    });
}

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
    leadAttributionSummary: document.getElementById('leadAttributionSummary'),
    leadAttributionBadge: document.getElementById('leadAttributionBadge'),
    leadJourneySummary: document.getElementById('leadJourneySummary'),
    leadJourneyMapDetails: document.getElementById('leadJourneyMapDetails'),
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
    const isFileMode = window.location.protocol === 'file:';
    const envApiBase = window.ENV && typeof window.ENV.API_BASE === 'string' ? window.ENV.API_BASE : null;
    const envApiKey = window.ENV && typeof window.ENV.API_KEY === 'string' ? window.ENV.API_KEY : null;
    const envHfToken = window.ENV && typeof window.ENV.HF_TOKEN === 'string' ? window.ENV.HF_TOKEN : null;
    const hostedCookieMode = !isFileMode && envApiBase === '' && envApiKey === '';
    let API_BASE = hostedCookieMode ? '' : (envApiBase || localStorage.getItem('API_BASE') || '');
    let API_KEY = hostedCookieMode ? '' : (envApiKey || localStorage.getItem('API_KEY') || '');
    let HF_TOKEN = hostedCookieMode ? '' : (envHfToken || localStorage.getItem('HF_TOKEN') || '');

    if (isFileMode && (!API_BASE || !API_KEY)) {
        API_BASE = prompt('Enter the backend API Base URL (e.g. https://my-app.onrender.com or http://localhost:7860):', API_BASE || 'http://localhost:7860');
        API_KEY = prompt('Enter your Secret API Key:', API_KEY || '');
        if (API_BASE && API_BASE.includes('.hf.space') && !HF_TOKEN) {
            HF_TOKEN = prompt('Enter your Hugging Face Access Token (for Private Space access):', HF_TOKEN || '');
        }
        if (API_BASE && API_KEY) {
            localStorage.setItem('API_BASE', API_BASE);
            localStorage.setItem('API_KEY', API_KEY);
            if (HF_TOKEN) {
                localStorage.setItem('HF_TOKEN', HF_TOKEN);
            }
        } else {
            els.kpiGrid.innerHTML = `<p style="color:var(--danger)">API credentials required to load dashboard.</p>`;
            return;
        }
    }
    API_BASE_GLOBAL = API_BASE;
    API_KEY_GLOBAL = API_KEY;
    HF_TOKEN_GLOBAL = HF_TOKEN;
    document.body.classList.toggle('session-auth-mode', !API_KEY_GLOBAL);
    if (!API_KEY_GLOBAL && els.refreshBtn) {
        els.refreshBtn.hidden = true;
        els.refreshBtn.disabled = true;
        els.refreshBtn.title = 'Refresh data through MCP/admin access';
    }

    // 1. Bind static UI elements immediately so they work even if DB is empty
    setupKeywordDiscoveryTabs();
    setupAttributionTabs();
    setupRankTabs();
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
                if (!API_KEY_GLOBAL) {
                    showToast('This date range requires a backend refresh. Ask the MCP agent to refresh data, then reload the dashboard.', true);
                    return;
                }
                const payload = { startDate: s, endDate: e };
                dashboardFetch(`${API_BASE}/api/trigger-refresh`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
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
            const icon = els.refreshBtn.querySelector('.refresh-icon');
            if (icon) icon.classList.add('spin');
            dashboardFetch(`${API_BASE}/api/trigger-refresh`, {
                method: 'POST'
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
                const icon = els.refreshBtn.querySelector('.refresh-icon');
                if (icon) icon.classList.remove('spin');
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
                    const icon = els.refreshBtn.querySelector('.refresh-icon');
                    if (icon) icon.classList.remove('spin');
                }
                return;
            }
            try {
                const res = await dashboardFetch(`${apiBase}/api/dashboard`);
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
        const res = await dashboardFetch(`${API_BASE}/api/dashboard`);
        if (res.status === 401 || res.status === 403) {
            if (API_KEY_GLOBAL) localStorage.removeItem('API_KEY');
            throw new Error(API_KEY_GLOBAL ? 'Invalid API Key. Please refresh to try again.' : 'Dashboard access expired. Open a new magic link.');
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
        setupLeadExportControls();
        setupKeywordPlannerControls();
        loadAuctionSheetSettings();
        els.trendSelect.addEventListener('change', () => renderTrendChart());
        const dhmSelect = document.getElementById('dayHourMetricSelect');
        if (dhmSelect) dhmSelect.addEventListener('change', () => renderTimePerformance());
    } catch (err) {
        console.error('Failed to load dashboard data:', err);
        els.kpiGrid.innerHTML = `<p style="color:var(--danger)">Error loading data: ${err.stack}</p>`;
    }
}

// Navigation
function keywordSubtabFromHash(hash) {
    if (hash === 'keyword-negatives') return 'negatives';
    if (hash === 'search-terms') return 'search-terms';
    if (hash === 'keyword-planner') return 'discovery';
    if (hash === 'keyword-insights') return 'insights';
    return 'active';
}

function keywordSubtabHash(subtab) {
    if (subtab === 'negatives') return 'keyword-negatives';
    if (subtab === 'search-terms') return 'search-terms';
    if (subtab === 'discovery') return 'keyword-planner';
    if (subtab === 'insights') return 'keyword-insights';
    return 'keywords';
}

function activateKeywordSubtab(subtab, updateHash = true) {
    const next = ['active', 'negatives', 'search-terms', 'discovery', 'insights'].includes(subtab) ? subtab : 'active';
    document.querySelectorAll('.keyword-subtab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.keywordSubtab === next);
    });
    document.querySelectorAll('.keyword-subpanel').forEach(panel => {
        panel.classList.toggle('active', panel.id === `keyword-subtab-${next}`);
    });
    if (updateHash) window.location.hash = keywordSubtabHash(next);
    setTimeout(() => {
        Object.values(charts).forEach(chart => {
            if (chart && typeof chart.resize === 'function') chart.resize();
        });
        Object.values(gridInstances).forEach(api => {
            if (api && typeof api.sizeColumnsToFit === 'function') api.sizeColumnsToFit();
        });
    }, 0);
}

function setupKeywordDiscoveryTabs() {
    document.querySelectorAll('.keyword-subtab').forEach(btn => {
        if (btn.hasAttribute('data-bound')) return;
        btn.addEventListener('click', () => activateKeywordSubtab(btn.dataset.keywordSubtab || 'active'));
        btn.setAttribute('data-bound', 'true');
    });
}

function attributionSubtabFromHash(hash) {
    if (hash === 'attr-quality') return 'quality';
    if (hash === 'attr-journeys') return 'journeys';
    if (hash === 'attr-gads') return 'gads';
    return 'review';
}

function attributionSubtabHash(subtab) {
    if (subtab === 'quality') return 'attr-quality';
    if (subtab === 'journeys') return 'attr-journeys';
    if (subtab === 'gads') return 'attr-gads';
    return 'attribution';
}

function activateAttributionSubtab(subtab, updateHash = true) {
    const next = ['review', 'quality', 'journeys', 'gads'].includes(subtab) ? subtab : 'review';
    document.querySelectorAll('.attribution-subtab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.attributionSubtab === next);
    });
    document.querySelectorAll('.attribution-subpanel').forEach(panel => {
        panel.classList.toggle('active', panel.id === `attr-subtab-${next}`);
    });
    if (updateHash) window.location.hash = attributionSubtabHash(next);

    setTimeout(() => {
        // Size visible grids to fit
        Object.keys(gridInstances).forEach(id => {
            const api = gridInstances[id];
            if (api && typeof api.sizeColumnsToFit === 'function') {
                const element = document.getElementById(id);
                if (element && element.offsetWidth > 0 && element.offsetHeight > 0) {
                    api.sizeColumnsToFit();
                }
            }
        });

        if (!dashboardData) return;

        // Trigger chart rendering or resizing
        if (next === 'gads') {
            renderSankeyChart();
        } else if (next === 'journeys') {
            if (dashboardData.leadAttribution) {
                const leadAttribution = dashboardData.leadAttribution || {};
                const leadTotals = leadAttribution.totals || { uniqueLeads: 0, eventCount: 0, new: 0, useless: 0, qualified: 0, qualifiedLost: 0, converted: 0, inProgress: 0, terminal: 0, qualifiedPipeline: 0 };
                const journey = leadAttribution.journeySummary || { totalSessions: 0, sessionsWithMultipleActions: 0, topActionOverlaps: [], topPaths: [], recentJourneys: [] };
                renderLeadJourneyMap(journey, leadTotals);
            }
        }

        // Resize any other Chart.js charts
        Object.values(charts).forEach(chart => {
            if (chart && typeof chart.resize === 'function') chart.resize();
        });
    }, 0);
}

window.openClicksModal = function () {
    const modal = document.getElementById('clicksModal');
    if (modal) {
        modal.classList.add('show');
        setTimeout(() => {
            const api = gridInstances['grid-clickPaths'];
            if (api && typeof api.sizeColumnsToFit === 'function') {
                api.sizeColumnsToFit();
            }
        }, 150);
    }
};

window.closeClicksModal = function () {
    const modal = document.getElementById('clicksModal');
    if (modal) {
        modal.classList.remove('show');
    }
};

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeClicksModal();
    }
});

function setupAttributionTabs() {
    document.querySelectorAll('.attribution-subtab').forEach(btn => {
        if (btn.hasAttribute('data-bound')) return;
        btn.addEventListener('click', () => activateAttributionSubtab(btn.dataset.attributionSubtab || 'review'));
        btn.setAttribute('data-bound', 'true');
    });

    const clicksModal = document.getElementById('clicksModal');
    if (clicksModal) {
        clicksModal.addEventListener('click', (e) => {
            if (e.target.id === 'clicksModal') {
                closeClicksModal();
            }
        });
    }
}

function rankSubtabFromHash(hash) {
    if (hash === 'rank-competitors') return 'competitors';
    if (hash === 'rank-auction') return 'auction';
    if (hash === 'rank-landing') return 'landing';
    return 'share';
}

function rankSubtabHash(subtab) {
    if (subtab === 'competitors') return 'rank-competitors';
    if (subtab === 'auction') return 'rank-auction';
    if (subtab === 'landing') return 'rank-landing';
    return 'rank';
}

function activateRankSubtab(subtab, updateHash = true) {
    const next = ['share', 'competitors', 'auction', 'landing'].includes(subtab) ? subtab : 'share';
    document.querySelectorAll('.rank-subtab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.rankSubtab === next);
    });
    document.querySelectorAll('.rank-subpanel').forEach(panel => {
        panel.classList.toggle('active', panel.id === `rank-subtab-${next}`);
    });
    if (updateHash) window.location.hash = rankSubtabHash(next);

    setTimeout(() => {
        // Size visible grids to fit
        Object.keys(gridInstances).forEach(id => {
            const api = gridInstances[id];
            if (api && typeof api.sizeColumnsToFit === 'function') {
                const element = document.getElementById(id);
                if (element && element.offsetWidth > 0 && element.offsetHeight > 0) {
                    api.sizeColumnsToFit();
                }
            }
        });

        if (!dashboardData) return;

        // Trigger chart rendering or resizing
        if (next === 'share') {
            if (dashboardData.campaigns) renderImpressionShareChart();
            if (dashboardData.dailyCampaigns && dashboardData.dailyCampaigns.length > 0) renderImpressionShareOverTimeChart();
        } else if (next === 'auction') {
            const auctionInsights = dashboardData.auctionInsights || [];
            renderAuctionInsights(auctionInsights);
        } else if (next === 'competitors') {
            renderCompetitorWaste();
        }

        // Resize any other Chart.js charts
        Object.values(charts).forEach(chart => {
            if (chart && typeof chart.resize === 'function') chart.resize();
        });
    }, 0);
}

function setupRankTabs() {
    document.querySelectorAll('.rank-subtab').forEach(btn => {
        if (btn.hasAttribute('data-bound')) return;
        btn.addEventListener('click', () => activateRankSubtab(btn.dataset.rankSubtab || 'share'));
        btn.setAttribute('data-bound', 'true');
    });
}

function setupNav() {
    els.tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            els.tabs.forEach(t => t.classList.remove('active'));
            els.tabContents.forEach(c => c.classList.remove('active'));

            tab.classList.add('active');
            const tabId = tab.dataset.tab;
            const content = document.getElementById(`tab-${tabId}`);
            if (content) content.classList.add('active');
            if (tabId === 'keywords') activateKeywordSubtab('active', false);
            if (tabId === 'attribution') activateAttributionSubtab('review', false);
            if (tabId === 'rank') activateRankSubtab('share', false);
            const pageTitle = document.getElementById('pageTitle');
            if (pageTitle) {
                const label = tab.querySelector('span')?.textContent || tabId;
                pageTitle.textContent = label;
            }

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
    const requestedHash = window.location.hash.replace('#', '') || 'overview';
    const initialKeywordSubtab = keywordSubtabFromHash(requestedHash);
    const initialAttributionSubtab = attributionSubtabFromHash(requestedHash);
    const initialRankSubtab = rankSubtabFromHash(requestedHash);

    let initialTab = requestedHash;
    if (['search-terms', 'keyword-planner', 'keyword-insights'].includes(requestedHash)) {
        initialTab = 'keywords';
    } else if (['attr-quality', 'attr-journeys', 'attr-gads'].includes(requestedHash)) {
        initialTab = 'attribution';
    } else if (['rank-competitors', 'rank-auction', 'rank-landing'].includes(requestedHash)) {
        initialTab = 'rank';
    }

    const tabBtn = document.querySelector(`.nav-item[data-tab="${initialTab}"]`);
    if (tabBtn) tabBtn.click();
    if (initialTab === 'keywords') activateKeywordSubtab(initialKeywordSubtab);
    if (initialTab === 'attribution') activateAttributionSubtab(initialAttributionSubtab);
    if (initialTab === 'rank') activateRankSubtab(initialRankSubtab);
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
    // Filter buttons were removed from the UI.
}

function currentSelectedCampaignId() {
    const selected = document.getElementById('globalCampaignFilter')?.value || 'All';
    if (!selected || selected === 'All') return '';
    const rows = [
        ...(dashboardData?.campaigns || []),
        ...(window.fullData?.campaigns || [])
    ];
    const found = rows.find(row => [row.id, row.campaignId, row.name, row.campaignName, row.campaign].filter(Boolean).map(String).includes(selected));
    return found?.id || found?.campaignId || (/^\d+$/.test(selected) ? selected : '');
}

function setupLeadExportControls() {
    const btn = document.getElementById('downloadOfflineConversionsBtn');
    if (!btn || btn.hasAttribute('data-bound')) return;
    btn.addEventListener('click', async () => {
        const readiness = dashboardData?.leadAttribution?.offlineExport || {};
        if (Number(readiness.readyRows || 0) === 0) {
            const qualified = Number(readiness.qualifiedOrConverted || 0);
            const skipped = Number(readiness.skippedMissingClickId || 0);
            const review = Number(readiness.needsReview || 0);
            const reason = qualified === 0
                ? `${fmtNum(review)} leads require review. Mark real leads as Qualified or Won first.`
                : `${fmtNum(skipped)} qualified/won leads are missing GCLID, GBRAID, or WBRAID from the webhook. Google Ads cannot upload them until the click ID is captured.`;
            showToast(`No uploadable offline conversion rows yet. ${reason}`, true);
            return;
        }
        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = 'Exporting...';
        try {
            const params = new URLSearchParams({ statuses: 'qualified,converted' });
            const range = dashboardData?.meta?.dateRange || {};
            if (range.start) params.set('startDate', range.start);
            if (range.end) params.set('endDate', range.end);
            const campaignId = currentSelectedCampaignId();
            if (campaignId) params.set('campaignId', campaignId);
            const res = await dashboardFetch(`${API_BASE_GLOBAL}/api/leads/offline-conversions.csv?${params.toString()}`);
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `Export failed with ${res.status}`);
            }
            const rows = Number(res.headers.get('X-Offline-Conversion-Rows') || '0');
            const skipped = Number(res.headers.get('X-Offline-Conversion-Skipped-Missing-Click-Id') || '0');
            if (rows === 0) {
                showToast(`No uploadable rows. ${fmtNum(skipped)} qualified/won leads were skipped because they do not have GCLID, GBRAID, or WBRAID.`, true);
                return;
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `offline-conversions-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            showToast(`Exported ${fmtNum(rows)} offline conversion rows. Skipped ${fmtNum(skipped)} without click IDs.`, false);
        } catch (err) {
            console.error(err);
            showToast(`Offline export failed: ${err.message}`, true);
        } finally {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    });
    btn.setAttribute('data-bound', 'true');
}

function parseKeywordPlannerSeeds(value) {
    return Array.from(new Set(String(value || '')
        .split(/[\n,]+/)
        .map(item => item.trim())
        .filter(Boolean)));
}

function isLikelyPlannerUrl(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    const withProtocol = /^https?:\/\//i.test(text) ? text : `https://${text}`;
    try {
        return Boolean(new URL(withProtocol).hostname);
    } catch {
        return false;
    }
}

function getKeywordPlannerMode() {
    return document.querySelector('.planner-mode-tab.active')?.dataset?.plannerMode || 'keywords';
}

function setupKeywordPlannerControls() {
    const btn = document.getElementById('runKeywordPlannerBtn');
    const seedsInput = document.getElementById('keywordPlannerSeedInput');
    const filterUrlInput = document.getElementById('keywordPlannerFilterUrlInput');
    const websiteUrlInput = document.getElementById('keywordPlannerWebsiteUrlInput');
    const languageSelect = document.getElementById('keywordPlannerLanguageSelect');
    const locationSelect = document.getElementById('keywordPlannerLocationSelect');
    const validationEl = document.getElementById('keywordPlannerValidation');
    const modeTabs = Array.from(document.querySelectorAll('.planner-mode-tab[data-planner-mode]'));
    const modePanels = Array.from(document.querySelectorAll('[data-planner-panel]'));
    const helpPanels = Array.from(document.querySelectorAll('[data-planner-help]'));
    if (!btn || btn.hasAttribute('data-bound')) return;

    let isGenerating = false;

    const setMode = (mode) => {
        const nextMode = mode === 'website' ? 'website' : 'keywords';
        modeTabs.forEach(tab => {
            const active = tab.dataset.plannerMode === nextMode;
            tab.classList.toggle('active', active);
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        modePanels.forEach(panel => {
            const active = panel.dataset.plannerPanel === nextMode;
            panel.classList.toggle('active', active);
            panel.hidden = !active;
        });
        helpPanels.forEach(panel => {
            const active = panel.dataset.plannerHelp === nextMode;
            panel.classList.toggle('active', active);
            panel.hidden = !active;
        });
        updateState();
    };

    const selectedWebsiteScope = () =>
        document.querySelector('input[name="keywordPlannerWebsiteScope"]:checked')?.value || 'site';

    const targetingPayload = () => ({
        language: languageSelect?.value || undefined,
        geoTargetConstants: locationSelect?.value ? [locationSelect.value] : undefined,
        keywordPlanNetwork: 'GOOGLE_SEARCH'
    });

    const buildPayload = () => {
        const mode = getKeywordPlannerMode();
        const payload = targetingPayload();
        if (mode === 'website') {
            const url = String(websiteUrlInput?.value || '').trim();
            if (selectedWebsiteScope() === 'site') {
                payload.site = url;
                payload.url = '';
            } else {
                payload.url = url;
            }
            payload.keywords = [];
            return payload;
        }

        payload.keywords = parseKeywordPlannerSeeds(seedsInput?.value);
        payload.url = String(filterUrlInput?.value || '').trim();
        return payload;
    };

    const validationMessage = () => {
        const mode = getKeywordPlannerMode();
        if (mode === 'website') {
            const url = String(websiteUrlInput?.value || '').trim();
            if (!url) return 'Enter a website URL to continue.';
            return isLikelyPlannerUrl(url) ? '' : 'Enter a valid website URL.';
        }
        const filterUrl = String(filterUrlInput?.value || '').trim();
        if (!parseKeywordPlannerSeeds(seedsInput?.value).length) return 'Enter at least one keyword to continue.';
        return filterUrl && !isLikelyPlannerUrl(filterUrl) ? 'Enter a valid filter website URL.' : '';
    };

    function updateState() {
        const message = validationMessage();
        btn.disabled = isGenerating || Boolean(message);
        if (validationEl) validationEl.textContent = isGenerating ? 'Fetching keyword ideas...' : message;
    }

    modeTabs.forEach(tab => {
        tab.addEventListener('click', () => setMode(tab.dataset.plannerMode));
    });

    [seedsInput, filterUrlInput, websiteUrlInput, languageSelect, locationSelect].forEach(el => {
        if (!el) return;
        el.addEventListener('input', updateState);
        el.addEventListener('change', updateState);
    });

    document.querySelectorAll('input[name="keywordPlannerWebsiteScope"]').forEach(radio => {
        radio.addEventListener('change', updateState);
    });

    btn.addEventListener('click', async () => {
        const originalText = btn.textContent;
        const payload = buildPayload();
        if (validationMessage()) {
            updateState();
            return;
        }
        isGenerating = true;
        btn.disabled = true;
        btn.textContent = 'Getting results...';
        updateState();
        try {
            const res = await dashboardFetch(`${API_BASE_GLOBAL}/api/keyword-planner/ideas`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `Keyword Planner failed with ${res.status}`);
            const ideas = Array.isArray(data.ideas) ? data.ideas : [];
            const mode = getKeywordPlannerMode();
            const seedSummary = {
                keywords: payload.keywords || [],
                url: payload.url || null,
                site: payload.site || null,
                language: payload.language,
                geoTargetConstants: payload.geoTargetConstants || [],
                keywordPlanNetwork: payload.keywordPlanNetwork,
                seedMode: mode,
                websiteScope: mode === 'website' ? selectedWebsiteScope() : null
            };
            const nextPlanner = {
                ...(dashboardData?.keywordPlanner || {}),
                status: { status: 'ok', message: `Generated ${ideas.length} live keyword ideas.`, seeds: seedSummary },
                ideas
            };
            if (dashboardData) dashboardData.keywordPlanner = nextPlanner;
            if (window.fullData) window.fullData.keywordPlanner = nextPlanner;
            renderKeywordPlannerExplorer();
            renderKeywordDiscoveryContext();
            showToast(`Generated ${ideas.length} keyword ideas.`, false);
        } catch (err) {
            console.error(err);
            showToast(`Keyword Planner failed: ${err.message}`, true);
        } finally {
            isGenerating = false;
            btn.disabled = false;
            btn.textContent = originalText;
            updateState();
        }
    });
    updateState();
    btn.setAttribute('data-bound', 'true');
}

function settingKey(item) {
    return `${item.entityType}:${item.entityId}`;
}

async function loadAuctionSheetSettings() {
    const form = document.getElementById('auctionSheetSettingsForm');
    const statusEl = document.getElementById('auctionSheetSettingsStatus');
    const saveBtn = document.getElementById('saveAuctionSettingsBtn');
    if (!form || !statusEl || !saveBtn) return;

    try {
        const res = await dashboardFetch(`${API_BASE_GLOBAL}/api/auction-insights/settings`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load settings');
        const settings = new Map((data.settings || []).map(item => [settingKey(item), item]));
        const entities = data.entities || [];
        statusEl.innerHTML = data.sheetsRefreshTokenConfigured
            ? `<div class="settings-note settings-note--ok">Google Sheets refresh token is configured.</div>`
            : `<div class="settings-note settings-note--warn">GOOGLE_SHEETS_REFRESH_TOKEN is missing. Auction Insights will stay empty until it is added.</div>`;
        form.innerHTML = entities.map(entity => {
            const saved = settings.get(settingKey(entity));
            const sheetName = saved?.sheetName || '';
            const label = entity.entityType === 'account'
                ? 'Account'
                : entity.entityType === 'campaign'
                    ? 'Campaign'
                    : 'Ad group';
            return `
                <label class="auction-setting-row">
                    <span>
                        <b>${esc(label)}</b>
                        <small>${esc(entity.entityName || entity.entityId)}</small>
                    </span>
                    <input class="styled-select auction-setting-input"
                        data-entity-type="${esc(entity.entityType)}"
                        data-entity-id="${esc(entity.entityId)}"
                        data-entity-name="${esc(entity.entityName || '')}"
                        value="${esc(sheetName)}"
                        placeholder="Google Sheet name">
                </label>
            `;
        }).join('');

        if (!saveBtn.hasAttribute('data-bound')) {
            saveBtn.addEventListener('click', saveAuctionSheetSettings);
            saveBtn.setAttribute('data-bound', 'true');
        }
    } catch (err) {
        console.error(err);
        statusEl.innerHTML = `<div class="settings-note settings-note--warn">Could not load Auction Insights settings: ${esc(err.message)}</div>`;
    }
}

async function saveAuctionSheetSettings() {
    const btn = document.getElementById('saveAuctionSettingsBtn');
    const inputs = Array.from(document.querySelectorAll('.auction-setting-input'));
    if (!btn || inputs.length === 0) return;
    btn.disabled = true;
    try {
        const settings = inputs.map(input => ({
            entityType: input.dataset.entityType,
            entityId: input.dataset.entityId,
            entityName: input.dataset.entityName,
            sheetName: input.value.trim(),
            enabled: true
        }));
        const res = await dashboardFetch(`${API_BASE_GLOBAL}/api/auction-insights/settings`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ settings })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not save settings');
        showToast('Auction Insights settings saved. Refresh to fetch the latest matching Sheets.', false);
    } catch (err) {
        console.error(err);
        showToast(`Settings save failed: ${err.message}`, true);
    } finally {
        btn.disabled = false;
    }
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
                    // Silently fail to auto-sync non-overlapping period, will be caught on Apply
                    newStartDate = tryAfterStart;
                    newEndDate = tryAfterEnd;
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
        const sumLeads = (start, end) => {
            const bucket = leadMetricBucket();
            const leads = dashboardData.leadAttribution?.filteredLeads || [];
            for (const lead of leads) {
                const leadDate = dateKey(lead.firstSeen || lead.first_seen || lead.lastSeen || lead.last_seen);
                if (leadDate && leadDate >= start && leadDate <= end) {
                    bumpLeadMetricBucket(bucket, lead);
                }
            }
            return {
                realConversions: bucket.uniqueLeads,
                realConverted: bucket.converted,
                realQualified: bucket.qualified
            };
        };

        const safeDiv = (a, b) => b ? Number((a / b).toFixed(2)) : 0;
        const delta = (c, p) => p === 0 ? (c > 0 ? 100 : 0) : Number(((c - p) / p * 100).toFixed(1));

        const curr = { ...sumPeriod(currentData), ...sumLeads(cpStartStr, cpEndStr) };
        const prev = { ...sumPeriod(previousData), ...sumLeads(ppStartStr, ppEndStr) };

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
                realConversions: delta(curr.realConversions, prev.realConversions)
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

function buildPeriodComparisonFromTrend(trendData = [], leadAttribution = {}) {
    const rows = Array.isArray(trendData) ? trendData.slice().sort((a, b) => (a.date || '').localeCompare(b.date || '')) : [];
    const midpoint = Math.floor(rows.length / 2);
    const previousRows = rows.slice(0, midpoint);
    const currentRows = rows.slice(midpoint);

    const currentStartDate = currentRows[0]?.date || '';
    const filteredLeads = leadAttribution.filteredLeads || [];

    const previousLeads = currentStartDate
        ? filteredLeads.filter(l => {
            const d = dateKey(l.firstSeen || l.first_seen || l.lastSeen || l.last_seen);
            return d && d < currentStartDate;
        })
        : [];

    const currentLeads = currentStartDate
        ? filteredLeads.filter(l => {
            const d = dateKey(l.firstSeen || l.first_seen || l.lastSeen || l.last_seen);
            return d && d >= currentStartDate;
        })
        : filteredLeads;

    const sumPeriod = (arr, leads = []) => {
        const spend = Number(arr.reduce((sum, row) => sum + Number(row.spend || 0), 0).toFixed(2));
        const clicks = arr.reduce((sum, row) => sum + Number(row.clicks || 0), 0);
        const impressions = arr.reduce((sum, row) => sum + Number(row.impressions || 0), 0);
        const conversions = arr.reduce((sum, row) => sum + Number(row.conversions || 0), 0);

        const leadTotals = leadMetricBucket();
        for (const lead of leads) {
            bumpLeadMetricBucket(leadTotals, lead);
        }

        return {
            spend,
            clicks,
            impressions,
            conversions,
            cpa: conversions ? spend / conversions : 0,
            realConversions: leadTotals.uniqueLeads,
            realConverted: leadTotals.converted,
            realQualified: leadTotals.qualified
        };
    };

    const labelFor = arr => arr.length
        ? `${arr[0].date || '?'} - ${arr[arr.length - 1].date || '?'}`
        : 'No data';

    const delta = (current, previous) => previous === 0 ? (current > 0 ? 100 : 0) : Number(((current - previous) / previous * 100).toFixed(1));

    const previous = sumPeriod(previousRows, previousLeads);
    const current = sumPeriod(currentRows, currentLeads);

    return {
        previousPeriod: { label: labelFor(previousRows), ...previous },
        currentPeriod: { label: labelFor(currentRows), ...current },
        deltas: {
            spend: delta(current.spend, previous.spend),
            clicks: delta(current.clicks, previous.clicks),
            impressions: delta(current.impressions, previous.impressions),
            conversions: delta(current.conversions, previous.conversions),
            realConversions: delta(current.realConversions, previous.realConversions)
        }
    };
}

function filterAnomaliesForRange(anomalies = [], startDate, endDate) {
    return (Array.isArray(anomalies) ? anomalies : []).filter(anomaly => {
        const anomalyDate = dateKey(anomaly.date);
        return !anomalyDate || (anomalyDate >= startDate && anomalyDate <= endDate);
    });
}

function filterCandidateSignalsForRange(signals = [], startDate, endDate) {
    return (Array.isArray(signals) ? signals : []).filter(signal => {
        const window = signal.evidence_window || {};
        const signalStart = dateKey(window.start);
        const signalEnd = dateKey(window.end);
        if (!signalStart && !signalEnd) return true;
        return (!signalEnd || signalEnd >= startDate) && (!signalStart || signalStart <= endDate);
    });
}

function applyLocalFilter(startDate, endDate) {
    if (!window.fullData) return;

    if (startDate < window.fullData.meta.dateRange.start || endDate > window.fullData.meta.dateRange.end) {
        if (els.refreshBtn) els.refreshBtn.click();
        return;
    }

    const selCamp = document.getElementById('globalCampaignFilter')?.value || 'All';
    const selAdGroup = document.getElementById('globalAdGroupFilter')?.value || 'All';

    const filterData = (arr, options = {}) => arr ? arr.filter(item => {
        if (item.date && (item.date < startDate || item.date > endDate)) return false;
        if (options.ignoreCampaignAdGroup) return true;

        const itemCampaign = item.campaign ?? item.name ?? null;
        const itemAdGroup = item.adGroup ?? (item.campaign && item.name ? item.name : null);
        if (selCamp !== 'All' && !options.ignoreCampaign && itemCampaign !== selCamp) return false;
        if (selAdGroup !== 'All' && !options.ignoreAdGroup && itemAdGroup !== selAdGroup) return false;
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
    const campaignRows = filterData(window.fullData.campaigns, { ignoreAdGroup: true });
    const campaigns = agg(campaignRows, 'campaign');
    const dailyCampaigns = agg(campaignRows, 'date').sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const adGroups = agg(filterData(window.fullData.adGroups), 'adGroup');
    const rankShareEntities = selAdGroup !== 'All' ? adGroups : campaigns;
    const rankShareDaily = agg(selAdGroup !== 'All' ? filterData(window.fullData.adGroups) : campaignRows, 'date').sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const keywords = agg(filterData(window.fullData.keywords), 'keyword');
    const configuredKeywords = filterData(window.fullData.configuredKeywords);
    const negatives = filterData(window.fullData.negatives);
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

    // Filter quality scores by campaign/adGroup (no date field — QS is a point-in-time snapshot)
    const qualityScores = filterData(window.fullData.qualityScores);

    const auctionInsights = filterData(window.fullData.auctionInsights);
    const auctionInsightsStatus = (window.fullData.auctionInsightsStatus || []).filter(status => {
        if (selCamp === 'All' && selAdGroup === 'All') return true;
        if (selAdGroup !== 'All') return status.entityType === 'ad_group' && status.adGroupName === selAdGroup;
        if (selCamp !== 'All') {
            return (status.entityType === 'campaign' && status.campaignName === selCamp)
                || (status.entityType === 'ad_group' && status.campaignName === selCamp);
        }
        return true;
    });

    // Recompute competitor breakdown from the already-filtered keywords
    const competitorNames = ['aisensy', 'interakt', 'wati', 'gallabox', 'doubletick'];
    const filteredCompetitorBreakdown = competitorNames.map(name => {
        const rows = keywords.filter(k => (k.keyword || '').toLowerCase().includes(name));
        const impressions = rows.reduce((s, r) => s + (r.impressions || 0), 0);
        const clicks = rows.reduce((s, r) => s + (r.clicks || 0), 0);
        const spend = +rows.reduce((s, r) => s + (r.spend || 0), 0).toFixed(2);
        const conversions = +rows.reduce((s, r) => s + (r.conversions || 0), 0).toFixed(2);
        const isRows = rows.filter(r => r.impressionShare != null);
        const impressionShare = isRows.length
            ? +(isRows.reduce((s, r) => s + (r.impressionShare || 0), 0) / isRows.length).toFixed(2)
            : null;
        return {
            competitor: name, spend, clicks, impressions, conversions,
            cpa: conversions > 0 ? +(spend / conversions).toFixed(2) : 0,
            ctr: impressions > 0 ? +(clicks / impressions * 100).toFixed(2) : 0,
            impressionShare,
            qualityScore: (qualityScores || []).find(q =>
                (q.keyword || '').toLowerCase().includes(name))?.qualityScore || null
        };
    });

    // Recompute insights.constraints from filtered campaigns
    const filteredInsights = {
        ...(window.fullData.insights || {}),
        constraints: campaigns.map(c => ({
            campaign: c.name,
            impressionShare: c.impressionShare,
            lostISBudget: c.lostISBudget,
            lostISRank: c.lostISRank,
        }))
    };
    const leadAttribution = filterLeadAttributionForRange(
        window.fullData.leadAttribution || {},
        startDate,
        endDate,
        campaigns,
        selCamp,
        selAdGroup
    );
    const periodComparison = buildPeriodComparisonFromTrend(trendData, leadAttribution);
    const anomalies = filterAnomaliesForRange(window.fullData.anomalies || [], startDate, endDate);
    const candidateSignals = filterCandidateSignalsForRange(window.fullData.candidateSignals || [], startDate, endDate);

    dashboardData = {
        ...window.fullData,
        summary,
        periodComparison,
        anomalies,
        globalSummary: JSON.parse(JSON.stringify(summary)),
        dailyTrend: trendData,
        campaigns,
        dailyCampaigns,
        adGroups,
        keywords,
        configuredKeywords,
        negatives,
        searchTerms,
        devicePerformance,
        dayOfWeekPerformance,
        dayAndHourPerformance: dhAggregated,
        landingPages,
        rankShareEntities,
        dailyRankShare: rankShareDaily,
        conversionActions: agg(filterData(window.fullData.conversionActions), 'name'),
        conversionAttribution: filterData(window.fullData.conversionAttribution),
        clickPaths: filterData(window.fullData.clickPaths),
        qualityScores,
        auctionInsights,
        auctionInsightsStatus,
        keywordPlanner: window.fullData.keywordPlanner || { ideas: [], historicalMetrics: [], status: { status: 'empty', message: 'Keyword Planner has not run yet.' } },
        competitorBreakdown: filteredCompetitorBreakdown,
        insights: filteredInsights,
        leadAttribution,
        candidateSignals,
    };

    if (dashboardData.meta) {
        dashboardData.meta.dateRange = { start: startDate, end: endDate };
    }

    renderGlobalKPIs();
    renderLeadFunnel();
    renderKPIs();
    renderCharts();
    renderInsights();
    renderTables();
    renderKeywordPlannerExplorer();
    renderKeywordDiscoveryContext();
    renderAttribution();
    renderRankDiagnostics();
    renderCompetitorWaste();
    renderCandidateSignals();
    renderProposals();
    animateKPIs();

    if (els.dateRange) els.dateRange.textContent = formatDateRange(startDate + ' - ' + endDate);
}

function renderGlobalKPIs() {
    const summary = dashboardData.globalSummary;
    const globalKpiGrid = document.getElementById('globalKpiGrid');
    if (!globalKpiGrid) return;

    const realConvVal = dashboardData.leadAttribution?.totals?.uniqueLeads || 0;
    const realConvWon = dashboardData.leadAttribution?.totals?.converted || 0;
    const realConvQual = dashboardData.leadAttribution?.totals?.qualified || 0;

    const clicksTodayVal = (dashboardData.clickPaths || []).reduce((sum, c) => sum + (c.clicks || 0), 0);

    const kpis = [
        { label: 'Total Spend', value: fmtCurr(summary.spend) },
        { label: 'Conversions', value: fmtNum(summary.conversions) },
        { label: 'CPA', value: fmtCurr(summary.cpa) },
        { label: 'Clicks', value: fmtNum(summary.clicks) },
        { label: 'Clicks Today', value: fmtNum(clicksTodayVal) },
        { label: 'Impressions', value: fmtNum(summary.impressions) },
        { label: 'CTR', value: fmtPct(summary.ctr) },
        { label: 'Avg CPC', value: fmtCurr(summary.avgCpc) },
        { label: 'Conv. Rate', value: fmtPct(summary.cvr) },
    ];

    if (dashboardData.leadAttribution) {
        const realConvSuccess = realConvWon + realConvQual;
        const isRealBad = summary.spend > 0 && realConvSuccess === 0;
        kpis.splice(2, 0, {
            label: 'Real Conversions',
            value: fmtNum(realConvVal),
            desc: `<strong>${realConvWon}</strong> won, <strong>${realConvQual}</strong> qualified`,
            isBad: isRealBad
        });
        kpis[1].isBad = summary.spend > 0 && (summary.conversions === 0 || realConvSuccess === 0);
    }

    globalKpiGrid.innerHTML = kpis.map(kpi => {
        const bg = kpi.isBad ? 'background: rgba(239, 68, 68, 0.05) !important;' : 'background: rgba(30, 41, 59, 0.4);';
        const border = kpi.isBad ? 'border: 1px solid rgba(239, 68, 68, 0.2);' : '';
        const color = kpi.isBad ? 'color: var(--danger) !important;' : '';
        const labelStyle = kpi.isBad ? 'color: var(--danger) !important;' : 'color: var(--text-main);';
        const descHtml = kpi.desc ? `<div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem; line-height: 1.25;">${kpi.desc}</div>` : '';

        const isClicksToday = kpi.label === 'Clicks Today';
        const kpiCardClass = isClicksToday ? 'card glass-card kpi-card overall-clicks-card' : 'card glass-card kpi-card';
        const onclickAttr = isClicksToday ? 'onclick="openClicksModal()"' : '';
        const labelText = isClicksToday ? 'Clicks Today' : `Overall ${kpi.label}`;

        return `
            <div class="${kpiCardClass}" style="${bg} ${border}" ${onclickAttr}>
                <span class="kpi-label" style="${labelStyle} font-weight: 500;">${labelText}</span>
                <span class="kpi-value" style="${color}" data-val="${kpi.value}">${kpi.value}</span>
                ${descHtml}
            </div>
        `;
    }).join('');
}

function renderLeadFunnel() {
    const el = document.getElementById('leadFunnel');
    if (!el || !dashboardData) return;

    const summary = dashboardData.summary || {};
    const leadTotals = dashboardData.leadAttribution?.totals || {};
    const stages = [
        {
            label: 'Clicks',
            value: Number(summary.clicks || 0),
            color: '#3b82f6'
        },
        {
            label: 'Leads (Conversions)',
            value: Number(summary.conversions || 0),
            color: '#2563eb'
        },
        {
            label: 'Qualified',
            value: Number(leadTotals.qualifiedPipeline || 0),
            color: '#10b981'
        },
        {
            label: 'Sales',
            value: Number(leadTotals.converted || 0),
            color: '#f25e36'
        }
    ];
    const maxValue = Math.max(...stages.map(stage => stage.value), 1);

    el.innerHTML = `
        <div class="lead-funnel-title">Total conversions through your entire lead funnel</div>
        <div class="lead-funnel-visual" style="--stage-count:${stages.length}">
            ${stages.map((stage, index) => {
        const height = Math.max(4, (stage.value / maxValue) * 100);
        const previous = index > 0 ? stages[index - 1].value : null;
        const rate = previous && previous > 0 ? (stage.value / previous) * 100 : null;
        return `
                    <div class="lead-funnel-stage" style="--bar-color:${stage.color}">
                        <div class="lead-funnel-bar-wrap">
                            <div class="lead-funnel-bar" style="--bar-height:${height}%"></div>
                        </div>
                        <div class="lead-funnel-value">${fmtNum(stage.value)}</div>
                        <div class="lead-funnel-label">${esc(stage.label)}</div>
                        <div class="lead-funnel-rate">${rate === null ? '&nbsp;' : fmtPct(rate)}</div>
                    </div>
                `;
    }).join('')}
        </div>
    `;
}

// Render Comparison KPIs
function renderKPIs() {
    const { summary, periodComparison: pc } = dashboardData;
    const d = pc.deltas;
    const cpaDelta = pc.previousPeriod.cpa === 0
        ? (pc.currentPeriod.cpa > 0 ? 100 : 0)
        : ((pc.currentPeriod.cpa - pc.previousPeriod.cpa) / pc.previousPeriod.cpa * 100);

    const kpis = [
        { label: 'Total Spend', value: fmtCurr(summary.spend), delta: d.spend, goodUp: false },
        { label: 'Conversions', value: fmtNum(summary.conversions), delta: d.conversions, goodUp: true },
        { label: 'CPA', value: fmtCurr(summary.cpa), delta: cpaDelta, goodUp: false },
        { label: 'Clicks', value: fmtNum(summary.clicks), delta: d.clicks, goodUp: true },
        { label: 'Impressions', value: fmtNum(summary.impressions), delta: d.impressions, goodUp: true },
        { label: 'CTR', value: fmtPct(summary.ctr), delta: 0, goodUp: true },
        { label: 'Avg CPC', value: fmtCurr(summary.avgCpc), delta: 0, goodUp: false },
        { label: 'Conv. Rate', value: fmtPct(summary.cvr), delta: 0, goodUp: true },
    ];

    if (dashboardData.leadAttribution) {
        const totals = dashboardData.leadAttribution?.totals || {};
        const currentRealConversions = pc.currentPeriod.realConversions ?? totals.uniqueLeads ?? 0;
        const currentWon = pc.currentPeriod.realConverted ?? totals.converted ?? 0;
        const currentQual = pc.currentPeriod.realQualified ?? totals.qualified ?? 0;
        const currentSuccess = currentWon + currentQual;

        const isRealBad = pc.currentPeriod.spend > 0 && currentSuccess === 0;

        kpis.splice(2, 0, {
            label: 'Real Conversions',
            value: fmtNum(currentRealConversions),
            delta: d.realConversions || 0,
            goodUp: true,
            desc: `<strong>${currentWon}</strong> won, <strong>${currentQual}</strong> qualified`,
            isBad: isRealBad
        });
        kpis[1].isBad = pc.currentPeriod.spend > 0 && (pc.currentPeriod.conversions === 0 || currentSuccess === 0);
    }

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

        const bg = kpi.isBad ? 'background: rgba(239, 68, 68, 0.05) !important;' : '';
        const border = kpi.isBad ? 'border: 1px solid rgba(239, 68, 68, 0.2);' : '';
        const color = kpi.isBad ? 'color: var(--danger) !important;' : '';
        const descHtml = kpi.desc ? `<div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem; line-height: 1.25;">${kpi.desc}</div>` : '';

        return `
            <div class="card glass-card kpi-card" style="${bg} ${border}">
                <span class="kpi-label" style="${color}">${kpi.label}</span>
                <span class="kpi-value" style="${color}" data-val="${kpi.value}">${kpi.value}</span>
                ${descHtml}
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
    renderSankeyMobilePaths(attr);

    if (attr.length === 0) {
        if (charts.sankey) charts.sankey.destroy();
        return; // No attribution data
    }

    // Build aggregated flow: SearchTerm -> Keyword -> Action.
    // Google Ads returns daily rows, so the same edge can appear multiple times.
    // Chart.js Sankey sizes duplicates together visually, but tooltips read one raw row.
    // Aggregating here keeps link thickness and tooltip values aligned.
    const links = new Map();
    const colors = {};
    const labels = {};

    const cleanNodeValue = (value, fallback) => {
        const text = String(value ?? '').trim();
        return text || fallback;
    };

    const addLink = (from, to, flow) => {
        if (!Number.isFinite(flow) || flow <= 0) return;
        const key = JSON.stringify([from, to]);
        const existing = links.get(key);
        if (existing) {
            existing.flow += flow;
        } else {
            links.set(key, { from, to, flow });
        }
    };

    attr.forEach(a => {
        const searchTerm = cleanNodeValue(a.searchTerm, '(no search term)');
        const keyword = cleanNodeValue(a.keyword, '(no keyword)');
        const conversionAction = cleanNodeValue(a.conversionAction, '(no action)');
        const flow = Number(a.conversions || 0);

        const termNode = `T: ${searchTerm}`;
        const keyNode = `K: ${keyword}`;
        const actNode = `A: ${conversionAction}`;

        addLink(termNode, keyNode, flow);
        addLink(keyNode, actNode, flow);

        colors[termNode] = '#3b82f6'; // Blue
        colors[keyNode] = '#8b5cf6';  // Purple
        colors[actNode] = '#10b981';  // Green

        labels[termNode] = searchTerm;
        labels[keyNode] = keyword;
        labels[actNode] = conversionAction;
    });

    const data = Array.from(links.values());
    if (data.length === 0) {
        if (charts.sankey) charts.sankey.destroy();
        return;
    }

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

function renderSankeyMobilePaths(attr = []) {
    const el = document.getElementById('sankeyMobilePaths');
    if (!el) return;
    const rows = Array.isArray(attr) ? attr : [];
    if (rows.length === 0) {
        el.innerHTML = `<div class="sankey-path-empty">No conversion paths in this filter.</div>`;
        return;
    }

    const clean = (value, fallback) => {
        const text = String(value ?? '').trim();
        return text || fallback;
    };
    const grouped = new Map();
    rows.forEach(row => {
        const item = {
            searchTerm: clean(row.searchTerm, '(no search term)'),
            keyword: clean(row.keyword, '(no keyword)'),
            conversionAction: clean(row.conversionAction, '(no action)')
        };
        const key = JSON.stringify(item);
        const existing = grouped.get(key) || { ...item, conversions: 0 };
        existing.conversions += Number(row.conversions || 0);
        grouped.set(key, existing);
    });

    const paths = Array.from(grouped.values())
        .filter(row => row.conversions > 0)
        .sort((a, b) => b.conversions - a.conversions)
        .slice(0, 8);
    const maxConversions = Math.max(...paths.map(row => row.conversions), 1);

    el.innerHTML = paths.map((path, index) => `
        <div class="sankey-path-card">
            <div class="sankey-path-head">
                <span>Path ${index + 1}</span>
                <strong>${fmtNum(path.conversions)} conv.</strong>
            </div>
            <div class="sankey-path-meter">
                <i style="width:${Math.max(6, (path.conversions / maxConversions) * 100)}%"></i>
            </div>
            <div class="sankey-path-steps">
                <div class="sankey-path-step sankey-path-step--term">
                    <span>Search term</span>
                    <strong>${esc(path.searchTerm)}</strong>
                </div>
                <div class="sankey-path-arrow">↓</div>
                <div class="sankey-path-step sankey-path-step--keyword">
                    <span>Keyword</span>
                    <strong>${esc(path.keyword)}</strong>
                </div>
                <div class="sankey-path-arrow">↓</div>
                <div class="sankey-path-step sankey-path-step--action">
                    <span>Conversion action</span>
                    <strong>${esc(path.conversionAction)}</strong>
                </div>
            </div>
        </div>
    `).join('') || `<div class="sankey-path-empty">No conversion paths in this filter.</div>`;
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
    if (gridInstances[id] && typeof gridInstances[id].destroy === 'function') {
        gridInstances[id].destroy();
    }
    gridDiv.innerHTML = ''; // clear old instances if any

    // Inject mobile container if it doesn't exist
    const responsiveWrapper = gridDiv.closest('.table-responsive');
    let mobileContainer = responsiveWrapper.nextElementSibling;
    if (!mobileContainer || !mobileContainer.classList.contains('mobile-card-container')) {
        mobileContainer = document.createElement('div');
        mobileContainer.className = 'mobile-card-container';
        mobileContainer.innerHTML = `<div class="mobile-card-list"></div>`;
        responsiveWrapper.parentNode.insertBefore(mobileContainer, responsiveWrapper.nextSibling);
    }

    // Inject sort controls into grid-controls if not exist
    const cardHeader = gridDiv.closest('.card').querySelector('.card-header');
    const gridControls = cardHeader ? cardHeader.querySelector('.grid-controls') : null;
    let sortSelect, sortDirBtn;

    if (gridControls) {
        let sortWrapper = gridControls.querySelector('.mobile-sort-wrapper');
        if (!sortWrapper) {
            const sortSelectOptions = columnDefs.map(c => `<option value="${c.field}">${c.headerName}</option>`).join('');
            sortWrapper = document.createElement('div');
            sortWrapper.className = 'mobile-sort-wrapper';
            sortWrapper.innerHTML = `
                <select class="styled-select mobile-sort-select">
                    <option value="">Sort by...</option>
                    ${sortSelectOptions}
                </select>
                <button class="btn btn-secondary mobile-sort-dir">↓ Desc</button>
            `;
            gridControls.appendChild(sortWrapper);
        }
        sortSelect = sortWrapper.querySelector('.mobile-sort-select');
        sortDirBtn = sortWrapper.querySelector('.mobile-sort-dir');
    }

    const mobileList = mobileContainer.querySelector('.mobile-card-list');

    const renderCellValue = (col, data) => {
        let val = data[col.field];
        if (col.valueFormatter) {
            val = col.valueFormatter({ value: val, data: data });
        }
        if (col.cellRenderer) {
            val = col.cellRenderer({ value: data[col.field], data: data });
        }
        return val !== undefined && val !== null ? val : '-';
    };

    let sortDesc = true;
    if (sortDirBtn) {
        sortDirBtn.onclick = () => {
            sortDesc = !sortDesc;
            sortDirBtn.innerText = sortDesc ? '↓ Desc' : '↑ Asc';
            triggerSort();
        };
    }
    if (sortSelect) {
        sortSelect.onchange = () => triggerSort();
    }

    function triggerSort() {
        if (!sortSelect.value || !api) return;
        api.applyColumnState({
            state: [{ colId: sortSelect.value, sort: sortDesc ? 'desc' : 'asc' }],
            defaultState: { sort: null }
        });
    }

    function renderMobileCards() {
        if (window.innerWidth > 768) return; // Optimization
        let html = '';
        let count = 0;
        api.forEachNodeAfterFilterAndSort(node => {
            if (count > 50) return; // Limit cards
            count++;
            const data = node.data;
            html += `<div class="mobile-card" style="animation-delay: ${count * 0.05}s">`;

            const titleField = columnDefs[0].field;
            let titleVal = renderCellValue(columnDefs[0], data);
            html += `<div class="mobile-card-header"><div class="mobile-card-title">${titleVal}</div></div>`;
            html += `<div class="mobile-card-body">`;

            columnDefs.slice(1).forEach(col => {
                const val = renderCellValue(col, data);
                html += `<div class="mobile-card-stat">
                    <span class="mobile-card-label">${col.headerName}</span>
                    <span class="mobile-card-value">${val}</span>
                </div>`;
            });
            html += `</div></div>`;
        });
        if (count === 0) html = '<p style="text-align:center; color:var(--text-muted);">No data available</p>';
        mobileList.innerHTML = html;
    }

    if (document.documentElement.classList.contains('dark')) {
        gridDiv.classList.add('ag-theme-alpine-dark');
        gridDiv.classList.remove('ag-theme-alpine');
    } else {
        gridDiv.classList.add('ag-theme-alpine');
        gridDiv.classList.remove('ag-theme-alpine-dark');
    }

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
        theme: 'legacy',
        onModelUpdated: renderMobileCards
    };

    const api = agGrid.createGrid(gridDiv, gridOptions);
    gridInstances[id] = api;

    // Trigger initial mobile render
    setTimeout(renderMobileCards, 100);

    // Bind search input
    const legacyTarget = `${id.replace('grid-', '')}Table`;
    const searchInput = document.querySelector(`.table-search[data-target="${legacyTarget}"], .table-search[data-target="${id}"]`);
    if (searchInput) {
        searchInput.oninput = (e) => {
            api.setGridOption('quickFilterText', e.target.value);
        };
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
const nullableNumberFormatter = params => params.value != null ? fmtNum(params.value) : '';
const nullableCurrencyFormatter = params => params.value != null ? fmtCurr(params.value) : '';
const plannerStatusFormatter = params => params.value ? String(params.value).replace(/_/g, ' ') : '';
const plannerSourceFormatter = params => ({
    idea: 'Keyword idea',
    historical: 'Historical metrics'
}[String(params.value || '')] || plannerStatusFormatter(params));

function keywordKey(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function avg(rows, field) {
    const valid = rows.map(row => Number(row[field] || 0)).filter(value => value > 0);
    return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
}

function renderMetricCards(targetId, cards) {
    const el = document.getElementById(targetId);
    if (!el) return;
    el.innerHTML = cards.map(card => `
        <div class="keyword-metric">
            <span>${esc(card.label)}</span>
            <strong>${esc(card.value)}</strong>
            <small>${esc(card.detail || '')}</small>
        </div>
    `).join('');
}

function renderKeywordSummary() {
    const keywords = dashboardData?.keywords || [];
    const quality = dashboardData?.qualityScores || [];
    const enabled = keywords.filter(row => row.status === 'ENABLED').length;
    const paused = keywords.filter(row => row.status === 'PAUSED').length;
    renderMetricCards('keywordSummary', [
        { label: 'Total keywords', value: fmtNum(keywords.length), detail: `${fmtNum(enabled)} enabled, ${fmtNum(paused)} paused` },
        { label: 'Avg quality score', value: avg(quality, 'qualityScore').toFixed(1), detail: `${fmtNum(quality.length)} QS rows loaded` },
        { label: 'Weighted avg CPC', value: fmtCurr(avg(keywords.filter(row => row.clicks > 0), 'avgCpc')), detail: `${fmtNum(keywords.reduce((sum, row) => sum + Number(row.clicks || 0), 0))} clicks` },
        { label: 'Conversions', value: fmtNum(keywords.reduce((sum, row) => sum + Number(row.conversions || 0), 0)), detail: 'From active keyword rows in current filter' }
    ]);
}

function actionTermRow(row) {
    const term = row.searchTerm || row.keyword || '';
    const score = row.plannerScore != null ? `Score ${fmtNum(row.plannerScore)}` : 'No planner score';
    const outcome = Number(row.conversions || 0) > 0
        ? `${fmtNum(row.conversions)} conv.`
        : `${fmtCurr(row.spend || 0)} spend`;
    return `
        <div class="keyword-action-row">
            <strong>${esc(term)}</strong>
            <span>${esc(outcome)} · ${esc(score)}</span>
        </div>
    `;
}

function renderActionGroup(title, rows, emptyText, tone) {
    return `
        <div class="keyword-action-card keyword-action-card--${esc(tone)}">
            <div class="keyword-action-head">
                <h4>${esc(title)}</h4>
                <span>${fmtNum(rows.length)}</span>
            </div>
            <div class="keyword-action-list">
                ${rows.length ? rows.slice(0, 6).map(actionTermRow).join('') : `<p>${esc(emptyText)}</p>`}
            </div>
        </div>
    `;
}

function renderSearchTermContext() {
    const searchTerms = dashboardData?.searchTerms || [];
    const keywordSet = new Set((dashboardData?.keywords || []).map(row => keywordKey(row.keyword)));
    const coveredTerms = searchTerms.filter(row => keywordSet.has(keywordKey(row.searchTerm)));
    const wasteRows = searchTerms
        .filter(row => Number(row.spend || 0) > 0 && Number(row.conversions || 0) === 0)
        .sort((a, b) => Number(b.spend || 0) - Number(a.spend || 0));
    const topWaste = wasteRows[0];

    renderMetricCards('searchTermSummary', [
        { label: 'Search terms', value: fmtNum(searchTerms.length), detail: `${fmtNum(searchTerms.reduce((sum, row) => sum + Number(row.clicks || 0), 0))} clicks` },
        { label: 'Terms with conversions', value: fmtNum(searchTerms.filter(row => Number(row.conversions || 0) > 0).length), detail: `${fmtNum(searchTerms.reduce((sum, row) => sum + Number(row.conversions || 0), 0))} total conversions` },
        { label: 'Already keywords', value: fmtPct(searchTerms.length ? (coveredTerms.length / searchTerms.length) * 100 : 0), detail: `${fmtNum(coveredTerms.length)} exact term matches` },
        { label: 'Top waste term', value: topWaste ? fmtCurr(topWaste.spend) : 'n/a', detail: topWaste ? topWaste.searchTerm : 'No zero-conversion spend' }
    ]);

    const negativeKeys = new Set(wasteRows
        .filter(row => String(row.label || '').toLowerCase().includes('negative') || row.hasLowIntent || Number(row.clicks || 0) >= 2)
        .map(row => keywordKey(row.searchTerm)));
    const addRows = searchTerms
        .filter(row => !keywordSet.has(keywordKey(row.searchTerm)))
        .filter(row => !negativeKeys.has(keywordKey(row.searchTerm)))
        .filter(row => Number(row.conversions || 0) > 0 || Number(row.plannerScore || 0) >= 65)
        .sort((a, b) => Number(b.conversions || 0) - Number(a.conversions || 0) || Number(b.plannerScore || 0) - Number(a.plannerScore || 0));
    const negativeRows = searchTerms
        .filter(row => negativeKeys.has(keywordKey(row.searchTerm)))
        .sort((a, b) => Number(b.spend || 0) - Number(a.spend || 0));
    const actionKeys = new Set([...addRows, ...negativeRows].map(row => keywordKey(row.searchTerm)));
    const monitorRows = searchTerms
        .filter(row => !actionKeys.has(keywordKey(row.searchTerm)))
        .sort((a, b) => Number(b.spend || 0) - Number(a.spend || 0));

    const el = document.getElementById('searchTermActionGroups');
    if (el) {
        el.innerHTML = [
            renderActionGroup('Add as Keywords', addRows, 'No strong add candidates in this filter.', 'success'),
            renderActionGroup('Negative Candidates', negativeRows, 'No strong negative candidates in this filter.', 'danger'),
            renderActionGroup('Monitoring', monitorRows, 'No remaining terms to monitor.', 'neutral')
        ].join('');
    }
}

function buildKeywordUniverseRows() {
    const map = new Map();
    const ensure = (term) => {
        const key = keywordKey(term);
        if (!key) return null;
        if (!map.has(key)) {
            map.set(key, {
                term,
                sources: [],
                inKeywords: false,
                inSearchTerms: false,
                inPlanner: false,
                spend: 0,
                clicks: 0,
                conversions: 0,
                avgMonthlySearches: null,
                competition: null,
                lowBid: null,
                highBid: null,
                plannerScore: null
            });
        }
        return map.get(key);
    };

    (dashboardData?.keywords || []).forEach(row => {
        const item = ensure(row.keyword);
        if (!item) return;
        item.inKeywords = true;
        item.sources.push('Keyword');
        item.spend += Number(row.spend || 0);
        item.clicks += Number(row.clicks || 0);
        item.conversions += Number(row.conversions || 0);
        Object.assign(item, {
            avgMonthlySearches: row.avgMonthlySearches ?? item.avgMonthlySearches,
            competition: row.competition ?? item.competition,
            lowBid: row.lowBid ?? item.lowBid,
            highBid: row.highBid ?? item.highBid,
            plannerScore: row.plannerScore ?? item.plannerScore
        });
    });

    (dashboardData?.searchTerms || []).forEach(row => {
        const item = ensure(row.searchTerm);
        if (!item) return;
        item.inSearchTerms = true;
        item.sources.push('Search Term');
        item.spend += Number(row.spend || 0);
        item.clicks += Number(row.clicks || 0);
        item.conversions += Number(row.conversions || 0);
        Object.assign(item, {
            avgMonthlySearches: row.avgMonthlySearches ?? item.avgMonthlySearches,
            competition: row.competition ?? item.competition,
            lowBid: row.lowBid ?? item.lowBid,
            highBid: row.highBid ?? item.highBid,
            plannerScore: row.plannerScore ?? item.plannerScore
        });
    });

    ((dashboardData?.keywordPlanner || {}).ideas || []).forEach(row => {
        const item = ensure(row.keyword);
        if (!item) return;
        item.inPlanner = true;
        item.sources.push('Planner');
        Object.assign(item, {
            avgMonthlySearches: row.avgMonthlySearches ?? item.avgMonthlySearches,
            competition: row.competition ?? item.competition,
            lowBid: row.lowBid ?? item.lowBid,
            highBid: row.highBid ?? item.highBid,
            plannerScore: row.plannerScore ?? item.plannerScore
        });
    });

    return Array.from(map.values()).map(row => ({
        ...row,
        sources: Array.from(new Set(row.sources)).join(', '),
        status: row.inKeywords ? 'covered keyword' : row.inSearchTerms ? 'search-term gap' : 'planner gap',
        spend: +row.spend.toFixed(2),
        cpa: row.conversions > 0 ? +(row.spend / row.conversions).toFixed(2) : null
    })).sort((a, b) => Number(b.plannerScore || 0) - Number(a.plannerScore || 0) || Number(b.spend || 0) - Number(a.spend || 0));
}

function renderPlannerOpportunityChart() {
    const el = document.getElementById('plannerOpportunityChart');
    if (!el) return;
    const ideas = ((dashboardData?.keywordPlanner || {}).ideas || [])
        .filter(row => row.avgMonthlySearches != null);
    if (charts.plannerOpportunity) charts.plannerOpportunity.destroy();

    const point = row => ({
        x: Number(row.avgMonthlySearches || 0),
        y: Number(row.lowBid ?? row.highBid ?? 0),
        r: Math.max(4, Math.min(16, Number(row.competitionIndex || 20) / 8)),
        keyword: row.keyword,
        competition: row.competition || 'unknown'
    });

    charts.plannerOpportunity = new Chart(el.getContext('2d'), {
        type: 'bubble',
        data: {
            datasets: [
                {
                    label: 'New opportunities',
                    data: ideas.filter(row => !row.inAccountKeyword && !row.inAccountSearchTerm).map(point),
                    backgroundColor: 'rgba(16, 185, 129, 0.65)'
                },
                {
                    label: 'Already seen',
                    data: ideas.filter(row => row.inAccountKeyword || row.inAccountSearchTerm).map(point),
                    backgroundColor: 'rgba(59, 130, 246, 0.55)'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                tooltip: {
                    callbacks: {
                        label: ctx => `${ctx.raw.keyword}: AMS ${fmtNum(ctx.raw.x)}, low bid ${fmtCurr(ctx.raw.y)}, ${ctx.raw.competition}`
                    }
                }
            },
            scales: {
                x: { title: { display: true, text: 'Average Monthly Searches' } },
                y: { title: { display: true, text: 'Low Top-of-Page Bid' } }
            }
        }
    });
}

function renderKeywordUniverseChart(rows) {
    const el = document.getElementById('keywordUniverseChart');
    if (!el) return;
    if (charts.keywordUniverse) charts.keywordUniverse.destroy();
    const keywords = (dashboardData?.keywords || []).length;
    const searchTerms = (dashboardData?.searchTerms || []).length;
    const plannerIdeas = ((dashboardData?.keywordPlanner || {}).ideas || []).length;
    const plannerGaps = rows.filter(row => row.inPlanner && !row.inKeywords && !row.inSearchTerms).length;
    const coveredSearchTerms = rows.filter(row => row.inSearchTerms && row.inKeywords).length;

    charts.keywordUniverse = new Chart(el.getContext('2d'), {
        type: 'bar',
        data: {
            labels: ['Keywords', 'Search Terms', 'Planner Ideas', 'Planner Gaps', 'Covered Search Terms'],
            datasets: [{
                label: 'Terms',
                data: [keywords, searchTerms, plannerIdeas, plannerGaps, coveredSearchTerms],
                backgroundColor: ['#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#06b6d4']
            }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
}

function renderKeywordUniverseInsights() {
    const rows = buildKeywordUniverseRows();
    const plannerGaps = rows.filter(row => row.inPlanner && !row.inKeywords && !row.inSearchTerms);
    const coveredSearchTerms = rows.filter(row => row.inSearchTerms && row.inKeywords);
    renderMetricCards('keywordUniverseSummary', [
        { label: 'Universe terms', value: fmtNum(rows.length), detail: 'Deduped across all sources' },
        { label: 'Planner-only gaps', value: fmtNum(plannerGaps.length), detail: `${fmtNum(plannerGaps.filter(row => Number(row.plannerScore || 0) >= 65).length)} high-score gaps` },
        { label: 'Search-term coverage', value: fmtPct((dashboardData?.searchTerms || []).length ? (coveredSearchTerms.length / dashboardData.searchTerms.length) * 100 : 0), detail: `${fmtNum(coveredSearchTerms.length)} search terms already keywords` },
        { label: 'Top gap', value: plannerGaps[0]?.term || 'n/a', detail: plannerGaps[0] ? `Score ${fmtNum(plannerGaps[0].plannerScore || 0)}` : 'No planner-only gaps' }
    ]);

    renderKeywordUniverseChart(rows);
    initGrid('grid-keywordUniverse', rows, [
        { field: 'term', headerName: 'Term', pinned: 'left', minWidth: 180 },
        { field: 'sources', headerName: 'Sources', cellRenderer: params => String(params.value || '').split(', ').map(source => `<span class="source-pill">${esc(source)}</span>`).join(' ') },
        { field: 'status', headerName: 'Coverage' },
        { field: 'spend', headerName: 'Spend', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'clicks', headerName: 'Clicks', filter: 'agNumberColumnFilter' },
        { field: 'conversions', headerName: 'Conv.', filter: 'agNumberColumnFilter' },
        { field: 'cpa', headerName: 'CPA', valueFormatter: nullableCurrencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'avgMonthlySearches', headerName: 'AMS', valueFormatter: nullableNumberFormatter, filter: 'agNumberColumnFilter' },
        { field: 'competition', headerName: 'Competition', valueFormatter: plannerStatusFormatter },
        { field: 'lowBid', headerName: 'Low Bid', valueFormatter: nullableCurrencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'highBid', headerName: 'High Bid', valueFormatter: nullableCurrencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'plannerScore', headerName: 'Planner Score', filter: 'agNumberColumnFilter', sort: 'desc' }
    ]);
}

function renderKeywordDiscoveryContext() {
    renderKeywordSummary();
    renderSearchTermContext();
    renderKeywordUniverseInsights();
}

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

    // Keywords (Configured)
    if (dashboardData.configuredKeywords) {
        initGrid('grid-allKeywords', dashboardData.configuredKeywords, [
            { field: 'keyword', headerName: 'Keyword', pinned: 'left', minWidth: 150 },
            { field: 'status', headerName: 'Status', valueFormatter: p => p.value === 'ENABLED' ? '🟢 Enabled' : p.value === 'PAUSED' ? '⏸️ Paused' : p.value === 'REMOVED' ? '❌ Removed' : p.value },
            {
                field: 'primaryStatus',
                headerName: 'Eligibility',
                minWidth: 200,
                wrapText: true,
                autoHeight: true,
                cellRenderer: p => {
                    const status = p.data.primaryStatus || '';
                    const reasons = p.data.primaryStatusReasons || [];

                    const formatStatus = str => {
                        if (!str) return '-';
                        return str.replace(/_/g, ' ')
                            .toLowerCase()
                            .split(' ')
                            .map(w => w.charAt(0).toUpperCase() + w.slice(1))
                            .join(' ');
                    };

                    const formatReason = str => {
                        if (!str) return '';
                        // Remove common criterion resource prefixes
                        let clean = str.replace(/^(AD_GROUP_CRITERION_|CRITERION_)/, '');
                        return clean.replace(/_/g, ' ')
                            .toLowerCase()
                            .split(' ')
                            .map(w => w.charAt(0).toUpperCase() + w.slice(1))
                            .join(' ');
                    };

                    if (reasons.includes('AD_GROUP_CRITERION_LOW_QUALITY')) {
                        return `<div style="line-height: 1.3; padding: 4px 0; color: #ef4444; font-weight: 500;">
                            Eligible (Limited)<br>
                            <span style="color: #ef4444; font-size: 0.85em; font-weight: normal; text-decoration: underline dotted;">Rarely shown (low Quality Score)</span>
                        </div>`;
                    }
                    if (reasons.includes('AD_GROUP_CRITERION_LOW_SEARCH_VOLUME')) {
                        return `<div style="line-height: 1.3; padding: 4px 0; color: #f59e0b; font-weight: 500;">
                            Eligible (Limited)<br>
                            <span style="color: #64748b; font-size: 0.85em; font-weight: normal;">Rarely shown (low search volume)</span>
                        </div>`;
                    }

                    const displayStatus = formatStatus(status);

                    if (status === 'ELIGIBLE') {
                        return `<span style="color: #10b981; font-weight: 500;">${displayStatus}</span>`;
                    }
                    if (status === 'PAUSED' || status === 'CAMPAIGN_PAUSED' || status === 'AD_GROUP_PAUSED') {
                        return `<span style="color: #64748b;">${displayStatus}</span>`;
                    }
                    if (status === 'REMOVED' || status === 'NOT_ELIGIBLE') {
                        const color = '#ef4444';
                        if (reasons.length > 0) {
                            const formattedReasons = reasons.map(formatReason).join(', ');
                            return `<div style="line-height: 1.3; padding: 4px 0; color: ${color};">
                                <span style="font-weight: 500;">${displayStatus}</span><br>
                                <span style="color: #64748b; font-size: 0.85em; font-weight: normal;">${formattedReasons}</span>
                            </div>`;
                        }
                        return `<span style="color: ${color}; font-weight: 500;">${displayStatus}</span>`;
                    }

                    if (reasons.length > 0) {
                        const formattedReasons = reasons.map(formatReason).join(', ');
                        return `<div style="line-height: 1.3; padding: 4px 0;">
                            <span style="font-weight: 500;">${displayStatus}</span><br>
                            <span style="color: #64748b; font-size: 0.85em;">${formattedReasons}</span>
                        </div>`;
                    }

                    return displayStatus;
                }
            },
            { field: 'campaign', headerName: 'Campaign' },
            { field: 'adGroup', headerName: 'Ad Group' },
            { field: 'finalUrl', headerName: 'Final URL', cellRenderer: p => p.value ? `<a href="${p.value}" target="_blank" class="table-link">${p.value}</a>` : '-' },
            { field: 'impressions', headerName: 'Impressions', filter: 'agNumberColumnFilter' },
            { field: 'clicks', headerName: 'Clicks', filter: 'agNumberColumnFilter' },
            { field: 'ctr', headerName: 'CTR', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
            { field: 'spend', headerName: 'Cost', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
            { field: 'avgCpc', headerName: 'Cost per Click', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
            { field: 'conversions', headerName: 'Conversions', filter: 'agNumberColumnFilter' },
            { field: 'cvr', headerName: 'Conversion Rate', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
            { field: 'cpa', headerName: 'Cost per Conversion', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' }
        ]);
    }

    // Keywords (Performance)
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
        { field: 'avgMonthlySearches', headerName: 'AMS', valueFormatter: nullableNumberFormatter, filter: 'agNumberColumnFilter' },
        { field: 'competition', headerName: 'Competition', valueFormatter: plannerStatusFormatter },
        { field: 'lowBid', headerName: 'Low Bid', valueFormatter: nullableCurrencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'highBid', headerName: 'High Bid', valueFormatter: nullableCurrencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'plannerScore', headerName: 'Planner Score', filter: 'agNumberColumnFilter', sort: 'desc' },
        { field: 'label', headerName: 'Suggestion' }
    ]);

    // Negative Keywords
    if (dashboardData.negatives) {
        initGrid('grid-negatives', dashboardData.negatives, [
            { field: 'keyword', headerName: 'Negative keyword', pinned: 'left', minWidth: 150 },
            { field: 'addedTo', headerName: 'Added to' },
            { field: 'level', headerName: 'Level' },
            { field: 'matchType', headerName: 'Match type' }
        ]);
    }

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
        { field: 'avgMonthlySearches', headerName: 'AMS', valueFormatter: nullableNumberFormatter, filter: 'agNumberColumnFilter' },
        { field: 'competition', headerName: 'Competition', valueFormatter: plannerStatusFormatter },
        { field: 'lowBid', headerName: 'Low Bid', valueFormatter: nullableCurrencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'highBid', headerName: 'High Bid', valueFormatter: nullableCurrencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'plannerScore', headerName: 'Planner Score', filter: 'agNumberColumnFilter', sort: 'desc' },
        { field: 'label', headerName: 'Suggestion' }
    ]);
}

function renderKeywordPlannerExplorer() {
    const planner = dashboardData?.keywordPlanner || {};
    const ideas = Array.isArray(planner.ideas) ? planner.ideas : [];
    const historicalMetrics = Array.isArray(planner.historicalMetrics) ? planner.historicalMetrics : [];
    const status = planner.status || {};
    const seeds = status.seeds || {};
    const summaryEl = document.getElementById('keywordPlannerSummary');
    const badgeEl = document.getElementById('keywordPlannerStatusBadge');

    if (badgeEl) {
        badgeEl.textContent = status.status ? String(status.status).replace(/_/g, ' ') : 'empty';
        badgeEl.className = `badge keyword-planner-badge keyword-planner-badge--${statusClass(status.status || 'empty')}`;
    }

    if (summaryEl) {
        const bestIdea = ideas.slice().sort((a, b) => Number(b.plannerScore || 0) - Number(a.plannerScore || 0))[0];
        const seedCount = Array.isArray(seeds.keywords) ? seeds.keywords.length : 0;
        const seedTarget = seeds.site || seeds.url || '';
        const seedLabel = seedCount
            ? `${fmtNum(seedCount)} terms`
            : seeds.site
                ? 'Site seed'
                : seeds.url
                    ? 'URL seed'
                    : 'No seed';
        const summaryCards = [
            { label: 'Status', value: status.status || 'empty', detail: status.message || 'Run a refresh or generate live ideas.' },
            { label: 'Ideas', value: fmtNum(ideas.length), detail: bestIdea ? `Top: ${bestIdea.keyword}` : 'No ideas loaded' },
            { label: 'Enriched terms', value: fmtNum(historicalMetrics.length), detail: 'Current keywords/search terms with AMS and bid data' },
            { label: 'Seed source', value: seedLabel, detail: seedTarget || 'Keyword-only request' }
        ];

        summaryEl.innerHTML = summaryCards.map(card => `
            <div class="planner-metric">
                <span>${esc(card.label)}</span>
                <strong>${esc(card.value)}</strong>
                <small>${esc(card.detail)}</small>
            </div>
        `).join('');
    }

    initGrid('grid-keywordPlannerIdeas', ideas, [
        { field: 'keyword', headerName: 'Keyword', pinned: 'left', minWidth: 180 },
        { field: 'plannerScore', headerName: 'Planner Score', filter: 'agNumberColumnFilter', sort: 'desc' },
        { field: 'avgMonthlySearches', headerName: 'AMS', valueFormatter: nullableNumberFormatter, filter: 'agNumberColumnFilter' },
        { field: 'competition', headerName: 'Competition', valueFormatter: plannerStatusFormatter },
        { field: 'competitionIndex', headerName: 'Competition Index', valueFormatter: nullableNumberFormatter, filter: 'agNumberColumnFilter' },
        { field: 'lowBid', headerName: 'Low Bid', valueFormatter: nullableCurrencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'highBid', headerName: 'High Bid', valueFormatter: nullableCurrencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'inAccountKeyword', headerName: 'In Keywords' },
        { field: 'inAccountSearchTerm', headerName: 'In Search Terms' },
        { field: 'source', headerName: 'Source', valueFormatter: plannerSourceFormatter },
        { field: 'seedType', headerName: 'Seed Type', valueFormatter: plannerStatusFormatter },
        { field: 'fetchedAt', headerName: 'Fetched At' }
    ]);
    renderPlannerOpportunityChart();
}

function journeyNodeColor(node) {
    const text = String(node || '').toLowerCase();
    if (text.includes('session start')) return '#64748b';
    if (text.includes('converted')) return '#10b981';
    if (text.includes('qualified lost')) return '#f59e0b';
    if (text.includes('useless') || text.includes('junk')) return '#ef4444';
    if (text.includes('qualified')) return '#3b82f6';
    if (text.includes('new')) return '#94a3b8';
    const palette = ['#f25e36', '#8b5cf6', '#06b6d4', '#14b8a6', '#eab308', '#ec4899'];
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash) + text.charCodeAt(i);
    return palette[Math.abs(hash) % palette.length];
}

function displayJourneyNode(node) {
    const raw = String(node || '');
    if (/^Outcome:\s*/i.test(raw)) {
        return leadStatusLabel(raw.replace(/^Outcome:\s*/i, ''), true);
    }
    if (/^Session start$/i.test(raw)) return 'Lead session started';
    return actionKindLabel(raw);
}

function normalizeJourneyFlowEdges(journey) {
    const direct = Array.isArray(journey.flowEdges) ? journey.flowEdges : [];
    if (direct.length) {
        return direct
            .filter(edge => edge.from && edge.to && Number(edge.sessions || 0) > 0)
            .map(edge => ({ from: edge.from, to: edge.to, flow: Number(edge.sessions || 0), percentOfAll: edge.percentOfAll || 0 }));
    }

    const map = new Map();
    for (const row of Array.isArray(journey.recentJourneys) ? journey.recentJourneys : []) {
        const actions = String(row.actionPath || '')
            .split(' -> ')
            .map(part => part.trim())
            .filter(part => part && part !== '(no action kind)');
        const nodes = ['Session start', ...actions, `Outcome: ${String(row.status || 'new').replace(/_/g, ' ')}`];
        for (let i = 0; i < nodes.length - 1; i++) {
            const key = `${nodes[i]} -> ${nodes[i + 1]}`;
            const current = map.get(key) || { from: nodes[i], to: nodes[i + 1], flow: 0 };
            current.flow += 1;
            map.set(key, current);
        }
    }
    const total = Math.max(Number(journey.totalSessions || 0), 1);
    return Array.from(map.values())
        .map(edge => ({ ...edge, percentOfAll: Number(((edge.flow / total) * 100).toFixed(2)) }))
        .sort((a, b) => b.flow - a.flow);
}

function clickIdSummary(attribution = {}) {
    const gclid = attribution.gclid || '';
    const gbraid = attribution.gbraid || '';
    const wbraid = attribution.wbraid || '';
    if (gclid) return `GCLID ${shortId(gclid)}`;
    if (gbraid) return `GBRAID ${shortId(gbraid)}`;
    if (wbraid) return `WBRAID ${shortId(wbraid)}`;
    return 'Missing click ID';
}

function leadDisplayName(lead) {
    const contact = lead.contact || {};
    return contact.name || contact.email || contact.phone || lead.leadId || shortId(lead.sessionKey) || 'Unknown lead';
}

function leadViewRows(leadAttribution) {
    return (leadAttribution?.recentLeads || []).map(lead => {
        const attribution = lead.attribution || {};
        const contact = lead.contact || {};
        const campaign = lead.campaign || {};
        const status = normalizeLeadStatus(lead.status);
        return {
            ...lead,
            status,
            leadName: leadDisplayName(lead),
            name: contact.name || '',
            email: contact.email || '',
            phone: contact.phone || '',
            searchTerm: attribution.utm_term || '',
            keyword: attribution.keyword || attribution.utm_term || '',
            matchType: attribution.match_type || '',
            campaignName: campaign.campaignName || '',
            campaignId: campaign.campaignId || attribution.utm_campaign || '',
            clickId: clickIdSummary(attribution),
            clickIdReady: Boolean(lead.hasClickId),
            offlineReadyLabel: lead.offlineConversionReady ? 'Ready for offline upload' : 'Not uploadable yet',
            actionPathLabel: formatActionPath(lead.actionPath),
            lastSeenLabel: formatDateTime(lead.lastSeen),
            firstSeenLabel: formatDateTime(lead.firstSeen),
            firstSeenIst: lead.firstSeenIst || formatDateTimeIst(lead.firstSeen)
        };
    });
}

function renderLeadContactCell(lead) {
    const rows = [
        `Name: ${lead.name || 'Name unavailable'}`,
        `Email: ${lead.email || 'Email unavailable'}`,
        `Phone: ${lead.phone || 'Phone unavailable'}`,
        lead.leadId ? `Lead ID: ${lead.leadId}` : `Session: ${shortId(lead.sessionKey)}`
    ];
    return `
        <div class="lead-contact-cell">
            <strong>${esc(lead.name || lead.leadName || 'Lead details')}</strong>
            ${rows.map(row => `<span>${esc(row)}</span>`).join('')}
        </div>
    `;
}

function leadFieldCell(value, missingLabel) {
    const text = String(value || '').trim() || missingLabel;
    return `<span class="${value ? 'lead-field-value' : 'lead-field-missing'}">${esc(text)}</span>`;
}

function renderLeadNameCell(lead) {
    return leadFieldCell(lead.name, 'Name unavailable');
}

function renderLeadKeywordCell(lead) {
    const rows = [
        lead.keyword
            ? `Keyword: ${lead.keyword}`
            : 'Keyword unavailable',
        lead.matchType
            ? `Match type: ${lead.matchType}`
            : 'Match type unavailable'
    ];
    return `
        <div class="lead-source-cell">
            ${rows.map((row, index) => index === 0
        ? `<strong>${esc(row)}</strong>`
        : `<span>${esc(row)}</span>`).join('')}
        </div>
    `;
}

function renderLeadCampaignCell(lead) {
    const rows = [
        lead.campaignName || lead.campaignId
            ? `Campaign: ${lead.campaignName || lead.campaignId}`
            : 'Campaign unavailable'
    ];
    if (lead.campaignName && lead.campaignId) rows.push(`UTM campaign: ${lead.campaignId}`);
    return `
        <div class="lead-source-cell">
            ${rows.map((row, index) => index === 0
        ? `<strong>${esc(row)}</strong>`
        : `<span>${esc(row)}</span>`).join('')}
        </div>
    `;
}

function renderLeadStatusCell(lead) {
    const normalized = normalizeLeadStatus(lead?.status);
    const actions = [
        ['new', 'Needs review'],
        ['useless', 'Junk'],
        ['qualified', 'Qualified'],
        ['converted', 'Won'],
        ['qualified_lost', 'Lost']
    ];
    return `
        <select
            class="lead-status-select lead-status-chip lead-status-chip--${statusClass(normalized)}"
            aria-label="Change lead status"
            data-current="${esc(normalized)}"
            onchange="handleLeadStatusChange(this, ${jsArg(lead?.sessionKey)})">
            ${actions.map(([status, label]) => `
                <option value="${esc(status)}" ${normalized === status ? 'selected' : ''} ${status === 'new' ? 'disabled' : ''}>
                    ${esc(label)}
                </option>
            `).join('')}
        </select>
    `;
}

function leadMetricBucket(extra = {}) {
    return {
        uniqueLeads: 0,
        eventCount: 0,
        new: 0,
        useless: 0,
        qualified: 0,
        qualifiedLost: 0,
        converted: 0,
        inProgress: 0,
        terminal: 0,
        qualifiedPipeline: 0,
        qualifiedOrConverted: 0,
        ...extra
    };
}

function bumpLeadMetricBucket(bucket, lead) {
    const status = normalizeLeadStatus(lead.status);
    bucket.uniqueLeads += 1;
    bucket.eventCount += Number(lead.eventCount ?? lead.event_count ?? 0);
    if (status === 'new') bucket.new += 1;
    if (status === 'useless') bucket.useless += 1;
    if (status === 'qualified') bucket.qualified += 1;
    if (status === 'qualified_lost') bucket.qualifiedLost += 1;
    if (status === 'converted') bucket.converted += 1;
    if (status === 'qualified') bucket.inProgress += 1;
    if (['converted', 'qualified_lost', 'useless'].includes(status)) bucket.terminal += 1;
    if (['qualified', 'converted', 'qualified_lost'].includes(status)) bucket.qualifiedPipeline += 1;
    if (['qualified', 'converted'].includes(status)) bucket.qualifiedOrConverted += 1;
}

function dateKey(value) {
    if (!value) return '';
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function campaignLookupFromRows(rows = []) {
    const out = new Map();
    for (const row of rows || []) {
        const campaignId = String(row.id || row.campaignId || '').trim();
        if (!campaignId) continue;
        const current = out.get(campaignId) || {
            campaignId,
            campaignName: row.name || row.campaignName || row.campaign || null,
            spend: 0
        };
        current.spend += Number(row.spend || 0);
        if (!current.campaignName && (row.name || row.campaignName || row.campaign)) {
            current.campaignName = row.name || row.campaignName || row.campaign;
        }
        out.set(campaignId, current);
    }
    return out;
}

function leadCampaignInfo(lead, campaignLookup) {
    const attribution = lead.attribution || {};
    const existing = lead.campaign || {};
    const campaignId = existing.campaignId || attribution.utm_campaign || '';
    const matched = campaignId ? campaignLookup.get(campaignId) : null;
    return {
        campaignId,
        campaignName: existing.campaignName || matched?.campaignName || null,
        spend: matched?.spend || 0
    };
}

function leadMatchesSelectedCampaign(lead, campaignInfo, selectedCampaign) {
    if (!selectedCampaign || selectedCampaign === 'All') return true;
    return campaignInfo.campaignName === selectedCampaign
        || campaignInfo.campaignId === selectedCampaign
        || lead.attribution?.utm_campaign === selectedCampaign;
}

function normalizedAdGroupCandidate(value) {
    if (value && typeof value === 'object') {
        return normalizedAdGroupCandidate(value.name || value.adGroup || value.adGroupName || value.ad_group || value.ad_group_name);
    }
    const text = String(value || '').trim().toLowerCase();
    return text || null;
}

function leadAdGroupCandidates(lead) {
    const attribution = lead.attribution || {};
    return [
        attribution.ad_group,
        attribution.adGroup,
        attribution.ad_group_name,
        attribution.adGroupName,
        attribution.google_ad_group,
        attribution.googleAdGroup,
        lead.adGroup,
        lead.ad_group,
        lead.adGroupName,
        lead.ad_group_name,
        lead.campaign?.adGroup,
        lead.campaign?.adGroupName
    ].map(normalizedAdGroupCandidate).filter(Boolean);
}

function leadMatchesSelectedAdGroup(lead, selectedAdGroup) {
    if (!selectedAdGroup || selectedAdGroup === 'All') return true;

    const candidates = leadAdGroupCandidates(lead);
    if (candidates.length === 0) return true;
    return candidates.includes(selectedAdGroup.toLowerCase());
}


function buildLeadJourneySummaryFromRows(leads) {
    const actionTotals = new Map();
    const pairTotals = new Map();
    const pathTotals = new Map();
    const flowEdgeTotals = new Map();
    const pathStatusTotals = new Map();
    const journeyRows = [];

    for (const lead of leads) {
        const rawPath = String(lead.actionPath || '').trim();
        const actions = rawPath && rawPath !== '(no action kind)'
            ? rawPath.split(' -> ').map(action => action.trim()).filter(Boolean)
            : [];
        const uniqueActions = Array.from(new Set(actions));
        for (const action of uniqueActions) actionTotals.set(action, (actionTotals.get(action) || 0) + 1);
        for (let i = 0; i < uniqueActions.length; i++) {
            for (let j = i + 1; j < uniqueActions.length; j++) {
                const from = uniqueActions[i];
                const to = uniqueActions[j];
                const key = `${from} -> ${to}`;
                const bucket = pairTotals.get(key) || { from, to, sessions: 0 };
                bucket.sessions += 1;
                pairTotals.set(key, bucket);
            }
        }
        const path = actions.length ? actions.join(' -> ') : '(no action kind)';
        pathTotals.set(path, (pathTotals.get(path) || 0) + 1);
        const status = normalizeLeadStatus(lead.status);
        const flowNodes = ['Session start', ...actions, `Outcome: ${status.replace(/_/g, ' ')}`];
        for (let i = 0; i < flowNodes.length - 1; i++) {
            const from = flowNodes[i];
            const to = flowNodes[i + 1];
            const key = `${from} -> ${to}`;
            const bucket = flowEdgeTotals.get(key) || { from, to, sessions: 0 };
            bucket.sessions += 1;
            flowEdgeTotals.set(key, bucket);
        }
        const pathStatusKey = `${path}|${status}`;
        const pathStatusBucket = pathStatusTotals.get(pathStatusKey) || { path, status, sessions: 0 };
        pathStatusBucket.sessions += 1;
        pathStatusTotals.set(pathStatusKey, pathStatusBucket);
        journeyRows.push({
            sessionKey: lead.sessionKey,
            status,
            actionCount: actions.length,
            uniqueActionCount: uniqueActions.length,
            actionPath: path,
            firstSeen: lead.firstSeen,
            lastSeen: lead.lastSeen
        });
    }

    const totalSessions = leads.length || 1;
    return {
        totalSessions: leads.length,
        sessionsWithMultipleActions: journeyRows.filter(row => row.uniqueActionCount > 1).length,
        topActionOverlaps: Array.from(pairTotals.values())
            .map(pair => ({
                ...pair,
                percentOfFrom: Number(((pair.sessions / Math.max(actionTotals.get(pair.from) || 0, 1)) * 100).toFixed(2)),
                percentOfAll: Number(((pair.sessions / totalSessions) * 100).toFixed(2))
            }))
            .sort((a, b) => b.sessions - a.sessions || b.percentOfFrom - a.percentOfFrom)
            .slice(0, 50),
        topPaths: Array.from(pathTotals.entries())
            .map(([path, sessions]) => ({
                path,
                sessions,
                percentOfAll: Number(((sessions / totalSessions) * 100).toFixed(2))
            }))
            .sort((a, b) => b.sessions - a.sessions)
            .slice(0, 50),
        flowEdges: Array.from(flowEdgeTotals.values())
            .map(edge => ({
                ...edge,
                percentOfAll: Number(((edge.sessions / totalSessions) * 100).toFixed(2))
            }))
            .sort((a, b) => b.sessions - a.sessions)
            .slice(0, 120),
        pathOutcomes: Array.from(pathStatusTotals.values())
            .map(row => ({
                ...row,
                percentOfAll: Number(((row.sessions / totalSessions) * 100).toFixed(2))
            }))
            .sort((a, b) => b.sessions - a.sessions)
            .slice(0, 100),
        recentJourneys: journeyRows.slice(0, 50)
    };
}

function buildOfflineExportReadinessFromRows(leads) {
    let readyRows = 0;
    let skippedMissingClickId = 0;
    let qualifiedOrConverted = 0;
    let needsReview = 0;
    for (const lead of leads) {
        const status = normalizeLeadStatus(lead.status);
        if (status === 'new') needsReview += 1;
        if (!['qualified', 'converted'].includes(status)) continue;
        qualifiedOrConverted += 1;
        if (lead.hasClickId) readyRows += 1;
        else skippedMissingClickId += 1;
    }
    return {
        statuses: ['qualified', 'converted'],
        readyRows,
        skippedMissingClickId,
        qualifiedOrConverted,
        needsReview
    };
}

function filterLeadAttributionForRange(source = {}, startDate, endDate, campaignRows = [], selectedCampaign = 'All', selectedAdGroup = 'All') {
    const allLeads = Array.isArray(source.allLeads)
        ? source.allLeads
        : (Array.isArray(source.recentLeads) ? source.recentLeads : []);
    const campaignLookup = campaignLookupFromRows(campaignRows);
    const filteredLeads = allLeads
        .filter(lead => {
            const leadDate = dateKey(lead.firstSeen || lead.first_seen || lead.lastSeen || lead.last_seen);
            if (!leadDate || leadDate < startDate || leadDate > endDate) return false;
            const campaignInfo = leadCampaignInfo(lead, campaignLookup);
            if (!leadMatchesSelectedCampaign(lead, campaignInfo, selectedCampaign)) return false;
            return leadMatchesSelectedAdGroup(lead, selectedAdGroup);
        })
        .map(lead => {
            const campaignInfo = leadCampaignInfo(lead, campaignLookup);
            return {
                ...lead,
                status: normalizeLeadStatus(lead.status),
                campaign: campaignInfo.campaignId ? {
                    campaignId: campaignInfo.campaignId,
                    campaignName: campaignInfo.campaignName
                } : null
            };
        });

    const totals = leadMetricBucket();
    const byCampaign = new Map();
    const bySearchTerm = new Map();
    for (const lead of filteredLeads) {
        bumpLeadMetricBucket(totals, lead);
        const attribution = lead.attribution || {};
        const campaignInfo = leadCampaignInfo(lead, campaignLookup);
        const campaignId = campaignInfo.campaignId || '(none)';
        const campaignBucket = byCampaign.get(campaignId) || leadMetricBucket({
            campaignId,
            campaignName: campaignInfo.campaignName,
            spend: campaignInfo.spend,
            trueCpa: 0,
            qualifiedCpa: 0,
            convertedCpa: 0,
            customerCpa: 0
        });
        bumpLeadMetricBucket(campaignBucket, lead);
        byCampaign.set(campaignId, campaignBucket);

        const term = attribution.utm_term || attribution.keyword || '(none)';
        const termBucket = bySearchTerm.get(term) || leadMetricBucket({
            searchTerm: term,
            keyword: attribution.keyword || '',
            matchType: attribution.match_type || ''
        });
        if (!termBucket.keyword && attribution.keyword) termBucket.keyword = attribution.keyword;
        if (!termBucket.matchType && attribution.match_type) termBucket.matchType = attribution.match_type;
        bumpLeadMetricBucket(termBucket, lead);
        bySearchTerm.set(term, termBucket);
    }

    const campaignBuckets = Array.from(byCampaign.values())
        .map(bucket => ({
            ...bucket,
            trueCpa: bucket.uniqueLeads > 0 ? bucket.spend / bucket.uniqueLeads : 0,
            qualifiedCpa: bucket.qualifiedPipeline > 0 ? bucket.spend / bucket.qualifiedPipeline : 0,
            convertedCpa: bucket.converted > 0 ? bucket.spend / bucket.converted : 0,
            customerCpa: bucket.converted > 0 ? bucket.spend / bucket.converted : 0
        }))
        .sort((a, b) => b.spend - a.spend || b.uniqueLeads - a.uniqueLeads);

    return {
        ...source,
        dateRange: { start: startDate, end: endDate },
        totals,
        byCampaign: campaignBuckets,
        bySearchTerm: Array.from(bySearchTerm.values()).sort((a, b) => b.uniqueLeads - a.uniqueLeads).slice(0, 100),
        journeySummary: buildLeadJourneySummaryFromRows(filteredLeads),
        allLeads,
        recentLeads: filteredLeads.slice(0, 50),
        filteredLeads: filteredLeads,
        offlineExport: buildOfflineExportReadinessFromRows(filteredLeads)
    };
}

function exportReadinessMessage(readiness = {}) {
    const ready = Number(readiness.readyRows || 0);
    const qualified = Number(readiness.qualifiedOrConverted || 0);
    const skipped = Number(readiness.skippedMissingClickId || 0);
    const review = Number(readiness.needsReview || 0);
    if (ready > 0) {
        return `${fmtNum(ready)} leads are ready to upload. ${fmtNum(skipped)} are missing click IDs.`;
    }
    if (qualified > 0) {
        return `${fmtNum(qualified)} leads are marked Qualified/Won, but they are missing click IDs.`;
    }
    return `CSV can only be created for leads marked as converted.`;
}

function renderLeadJourneyMap(journey, leadTotals) {
    const canvas = document.getElementById('leadJourneyMapChart');
    const details = els.leadJourneyMapDetails;
    if (!canvas || !details) return;

    const edges = normalizeJourneyFlowEdges(journey);
    if (charts.leadJourneyMap) charts.leadJourneyMap.destroy();

    if (!edges.length) {
        details.innerHTML = `
            <div class="journey-detail-empty">
                <strong>No journey map yet</strong>
                <span>No data available.</span>
            </div>
        `;
        return;
    }

    const topEdges = edges.slice(0, 48);
    const ctx = canvas.getContext('2d');
    charts.leadJourneyMap = new Chart(ctx, {
        type: 'sankey',
        data: {
            datasets: [{
                label: 'Lead journey',
                data: topEdges,
                colorFrom: c => journeyNodeColor(c.dataset.data[c.dataIndex].from),
                colorTo: c => journeyNodeColor(c.dataset.data[c.dataIndex].to),
                colorMode: 'gradient',
                size: 'max',
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: () => 'Lead journey flow',
                        label: c => {
                            const edge = c.raw;
                            return `${displayJourneyNode(edge.from)} -> ${displayJourneyNode(edge.to)}: ${fmtNum(edge.flow)} sessions`;
                        }
                    }
                }
            }
        }
    });

    const newCount = Number(leadTotals.new ?? Math.max(Number(leadTotals.uniqueLeads || 0) - Number(leadTotals.terminal || 0) - Number(leadTotals.inProgress || 0), 0));
    const outcomeRows = LEAD_STATUS_ORDER
        .map(status => ({
            status,
            label: leadStatusLabel(status, true),
            description: leadStatusDescription(status),
            count: status === 'new' ? newCount : Number(leadTotals[status === 'qualified_lost' ? 'qualifiedLost' : status] || 0)
        }))
        .filter(row => row.count > 0);
    const totalOutcomeFlow = outcomeRows.reduce((sum, row) => sum + row.count, 0) || Number(leadTotals.uniqueLeads || 0) || 1;
    const topPaths = Array.isArray(journey.topPaths) ? journey.topPaths.slice(0, 5) : [];
    const pathOutcomes = Array.isArray(journey.pathOutcomes) ? journey.pathOutcomes.slice(0, 5) : [];

    details.innerHTML = `
        <div class="journey-detail-block">
            <h4>Current Lead Status</h4>
            <div class="journey-outcome-list">
                ${outcomeRows.map(row => {
        const pct = (row.count / totalOutcomeFlow) * 100;
        return `
                        <div class="journey-outcome-row">
                            <span>
                                <i style="background:${leadStatusMeta(row.status).color}"></i>
                                <strong>${esc(row.label)}</strong>
                                <small>${esc(row.description)}</small>
                            </span>
                            <b>${fmtNum(row.count)}</b>
                            <em style="width:${Math.min(Math.max(pct, 3), 100)}%"></em>
                        </div>
                    `;
    }).join('') || '<div class="journey-detail-empty compact">No leads captured yet.</div>'}
            </div>
        </div>
        <div class="journey-detail-block">
            <h4>Most Common Lead Actions</h4>
            <div class="journey-path-list">
                ${topPaths.map(path => `
                    <div class="journey-path-row">
                        <strong>${esc(formatActionPath(path.path))}</strong>
                        <span>${fmtNum(path.sessions)} sessions · ${fmtPct(path.percentOfAll)}</span>
                    </div>
                `).join('') || '<div class="journey-detail-empty compact">No repeated lead action yet.</div>'}
            </div>
        </div>
        <div class="journey-detail-block">
            <h4>Actions by Lead Status</h4>
            <div class="journey-path-list">
                ${pathOutcomes.map(row => `
                    <div class="journey-path-row">
                        <strong>${esc(formatActionPath(row.path))}</strong>
                        <span>${esc(leadStatusLabel(row.status))} · ${fmtNum(row.sessions)} sessions</span>
                    </div>
                `).join('') || '<div class="journey-detail-empty compact">No status split yet.</div>'}
            </div>
        </div>
    `;
}

function renderAttribution() {
    const actions = dashboardData.conversionActions || [];
    const attribution = dashboardData.conversionAttribution || [];
    const clicks = dashboardData.clickPaths || [];
    const capability = dashboardData.attributionCapability || {};
    const leadAttribution = dashboardData.leadAttribution || {};
    const leadTotals = leadAttribution.totals || { uniqueLeads: 0, eventCount: 0, new: 0, useless: 0, qualified: 0, qualifiedLost: 0, converted: 0, inProgress: 0, terminal: 0, qualifiedPipeline: 0 };
    const journey = leadAttribution.journeySummary || { totalSessions: 0, sessionsWithMultipleActions: 0, topActionOverlaps: [], topPaths: [], recentJourneys: [] };
    const reviewRows = leadViewRows(leadAttribution);
    const needsReview = Number(leadTotals.new ?? Math.max(Number(leadTotals.uniqueLeads || 0) - Number(leadTotals.terminal || 0) - Number(leadTotals.inProgress || 0), 0));
    const offlineExport = leadAttribution.offlineExport || {};

    if (els.attributionBadge) {
        els.attributionBadge.textContent = `${attribution.length} rows`;
    }
    if (els.leadAttributionBadge) {
        els.leadAttributionBadge.textContent = `${fmtNum(leadTotals.uniqueLeads)} leads`;
        els.leadAttributionBadge.title = `${fmtNum(needsReview)} need review`;
    }

    const exportBtn = document.getElementById('downloadOfflineConversionsBtn');
    if (exportBtn) {
        const readyRows = Number(offlineExport.readyRows || 0);
        exportBtn.textContent = readyRows > 0
            ? `Download Offline CSV (${fmtNum(readyRows)} ready)`
            : 'Offline CSV not ready';
        exportBtn.title = exportReadinessMessage(offlineExport);
    }

    if (els.attributionSummary) {
        els.attributionSummary.innerHTML = `
            <div class="insight-item" style="border-color: var(--success)">
                <h4>Conversions</h4>
                <p>${fmtNum(actions.reduce((s, a) => s + (a.conversions || 0), 0))} conversions across ${fmtNum(actions.length)} conversion action.</p>
            </div>
        `;
    }

    if (els.leadAttributionSummary) {
        const qualifiedRate = leadTotals.uniqueLeads > 0 ? (leadTotals.qualifiedPipeline / leadTotals.uniqueLeads) * 100 : 0;
        const convertedRate = leadTotals.uniqueLeads > 0 ? (leadTotals.converted / leadTotals.uniqueLeads) * 100 : 0;
        els.leadAttributionSummary.innerHTML = `
            <div class="insight-item" style="border-color: var(--primary)">
                <h4>Leads Waiting for Review</h4>
                <p>${fmtNum(needsReview)} of ${fmtNum(leadTotals.uniqueLeads)} leads require review.</p>
            </div>
            <div class="insight-item" style="border-color: var(--success)">
                <h4>Qualified Sales Leads</h4>
                <p>${fmtNum(leadTotals.qualifiedPipeline)} leads are qualiified (${fmtPct(qualifiedRate)}): ${fmtNum(leadTotals.inProgress)} still open, ${fmtNum(leadTotals.qualifiedLost)} lost, ${fmtNum(leadTotals.converted)} won (${fmtPct(convertedRate)}).</p>
            </div>
            <div class="insight-item" style="border-color: var(--warning)">
                <h4>Offline Upload Readiness</h4>
                <p>${esc(exportReadinessMessage(offlineExport))}</p>
            </div>
        `;
    }

    if (els.leadJourneySummary) {
        const multiRate = journey.totalSessions > 0 ? (journey.sessionsWithMultipleActions / journey.totalSessions) * 100 : 0;
        const topOverlap = journey.topActionOverlaps?.[0];
        const topPath = journey.topPaths?.[0];
        els.leadJourneySummary.innerHTML = `
            <div class="insight-item" style="border-color: var(--info)">
                <h4>What to Look At First</h4>
                <p>${needsReview > 0 ? `You have ${fmtNum(needsReview)} new leads to check. Quality charts will update once you label them.` : 'All leads have been checked. Your lead quality charts are up to date!'}</p>
            </div>
            <div class="insight-item" style="border-color: var(--primary)">
                <h4>Most Common Action</h4>
                <p>${topPath ? `The path "${esc(formatActionPath(topPath.path))}" was completed by ${fmtNum(topPath.sessions)} leads.` : 'No actions captured yet.'}</p>
            </div>
            <div class="insight-item" style="border-color: var(--success)">
                <h4>Repeated Actions</h4>
                <p>${topOverlap ? `${fmtPct(topOverlap.percentOfFrom)} of users who did "${esc(actionKindLabel(topOverlap.from))}" also did "${esc(actionKindLabel(topOverlap.to))}".` : `${fmtNum(journey.sessionsWithMultipleActions)} leads did more than one action (${fmtPct(multiRate)}).`}</p>
            </div>
        `;
    }
    renderLeadJourneyMap(journey, leadTotals);

    initGrid('grid-leadReview', reviewRows, [
        { field: 'name', headerName: 'Name', pinned: 'left', minWidth: 180, cellRenderer: p => renderLeadNameCell(p.data) },
        { field: 'email', headerName: 'Email', minWidth: 230, cellRenderer: p => leadFieldCell(p.value, 'Email unavailable') },
        { field: 'phone', headerName: 'Phone', minWidth: 170, cellRenderer: p => leadFieldCell(p.value, 'Phone unavailable') },
        { field: 'firstSeenIst', headerName: 'IST Time', minWidth: 180 },
        { field: 'campaignName', headerName: 'Campaign', minWidth: 240, cellRenderer: p => renderLeadCampaignCell(p.data) },
        { field: 'status', headerName: 'Status', minWidth: 160, cellRenderer: p => renderLeadStatusCell(p.data) },
        { field: 'keyword', headerName: 'Keyword / Match Type', minWidth: 280, cellRenderer: p => renderLeadKeywordCell(p.data) },
        { field: 'actionPathLabel', headerName: 'Lead Action', minWidth: 220 },
        { field: 'eventCount', headerName: 'Events', filter: 'agNumberColumnFilter', minWidth: 110 }
    ]);

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
        { field: 'keyword', headerName: 'Keyword', pinned: 'left' },
        { field: 'matchType', headerName: 'Match Type' },
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

    initGrid('grid-leadCampaigns', leadAttribution.byCampaign || [], [
        { field: 'campaignName', headerName: 'Campaign', pinned: 'left', valueFormatter: p => p.value || p.data?.campaignId || '(none)' },
        { field: 'campaignId', headerName: 'UTM Campaign' },
        { field: 'spend', headerName: 'Spend', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'uniqueLeads', headerName: 'Leads', filter: 'agNumberColumnFilter' },
        { field: 'new', headerName: 'Needs Review', filter: 'agNumberColumnFilter' },
        { field: 'qualified', headerName: 'Qualified Open', filter: 'agNumberColumnFilter' },
        { field: 'qualifiedLost', headerName: 'Qualified Lost', filter: 'agNumberColumnFilter' },
        { field: 'converted', headerName: 'Converted Customers', filter: 'agNumberColumnFilter' },
        { field: 'useless', headerName: 'Useless', filter: 'agNumberColumnFilter' },
        { field: 'trueCpa', headerName: 'True CPA', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'qualifiedCpa', headerName: 'Qualified CPA', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'customerCpa', headerName: 'Customer CPA', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' }
    ]);

    initGrid('grid-leadSearchTerms', leadAttribution.bySearchTerm || [], [
        { field: 'searchTerm', headerName: 'Search Term / Keyword', pinned: 'left' },
        { field: 'keyword', headerName: 'Keyword' },
        { field: 'matchType', headerName: 'Match Type' },
        { field: 'uniqueLeads', headerName: 'Leads', filter: 'agNumberColumnFilter' },
        { field: 'new', headerName: 'Needs Review', filter: 'agNumberColumnFilter' },
        { field: 'qualified', headerName: 'Qualified Open', filter: 'agNumberColumnFilter' },
        { field: 'qualifiedLost', headerName: 'Qualified Lost', filter: 'agNumberColumnFilter' },
        { field: 'converted', headerName: 'Converted Customers', filter: 'agNumberColumnFilter' },
        { field: 'useless', headerName: 'Useless', filter: 'agNumberColumnFilter' },
        { field: 'eventCount', headerName: 'Events', filter: 'agNumberColumnFilter' }
    ]);

    initGrid('grid-leadActionOverlaps', journey.topActionOverlaps || [], [
        { field: 'from', headerName: 'First Action', pinned: 'left', valueFormatter: p => actionKindLabel(p.value) },
        { field: 'to', headerName: 'Repeated Action', valueFormatter: p => actionKindLabel(p.value) },
        { field: 'sessions', headerName: 'Sessions', filter: 'agNumberColumnFilter' },
        { field: 'percentOfFrom', headerName: '% of First Action', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
        { field: 'percentOfAll', headerName: '% of Leads', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' }
    ]);

}

window.handleLeadStatusChange = function (select, sessionKey) {
    const status = select?.value;
    const previous = select?.dataset?.current || '';
    if (!status || status === 'new' || status === previous) {
        if (select) select.value = previous;
        return;
    }
    select.disabled = true;
    updateLeadStatus(sessionKey, status).finally(() => {
        select.disabled = false;
        select.value = previous;
    });
};

window.updateLeadStatus = async function (sessionKey, status) {
    const normalized = normalizeLeadStatus(status);
    const label = leadStatusLabel(normalized, true);
    try {
        showToast(`Marking lead as ${label}...`, false);
        const res = await dashboardFetch(`${API_BASE_GLOBAL}/api/leads/${encodeURIComponent(sessionKey)}/status`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ status: normalized })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Lead update failed with ${res.status}`);

        const dashboardRes = await dashboardFetch(`${API_BASE_GLOBAL}/api/dashboard`);
        const dashboard = await dashboardRes.json().catch(() => ({}));
        if (!dashboardRes.ok) throw new Error(dashboard.error || `Dashboard reload failed with ${dashboardRes.status}`);
        if (dashboardData) dashboardData.leadAttribution = dashboard.leadAttribution || {};
        if (window.fullData) window.fullData.leadAttribution = dashboard.leadAttribution || {};
        const startD = localStorage.getItem('globalStartDate') || dashboardData?.meta?.dateRange?.start;
        const endD = localStorage.getItem('globalEndDate') || dashboardData?.meta?.dateRange?.end;
        if (startD && endD && window.fullData) applyLocalFilter(startD, endD);
        else renderAttribution();
        showToast(`Lead marked as ${label}.`, false);
    } catch (err) {
        console.error(err);
        showToast(`Lead update failed: ${err.message}`, true);
    }
};

function metricAverage(rows, key) {
    const values = rows.map(row => row[key]).filter(value => Number.isFinite(value));
    return values.length ? +(values.reduce((acc, value) => acc + value, 0) / values.length).toFixed(2) : null;
}

function dateCoverage(rows) {
    const dates = rows.map(row => row.date).filter(Boolean).sort();
    if (dates.length === 0) return 'n/a';
    const first = dates[0];
    const last = dates[dates.length - 1];
    return first === last ? formatDateShort(first) : `${formatDateShort(first)} - ${formatDateShort(last)}`;
}

function aggregateAuctionDomains(rows) {
    const groups = new Map();
    rows.filter(row => row.domain && !row.isYou && String(row.domain).toLowerCase() !== 'you').forEach(row => {
        const domain = String(row.domain).toLowerCase();
        if (!groups.has(domain)) groups.set(domain, { domain, rows: [] });
        groups.get(domain).rows.push(row);
    });

    return Array.from(groups.values()).map(group => ({
        domain: group.domain,
        rows: group.rows.length,
        coverage: dateCoverage(group.rows),
        impressionShare: metricAverage(group.rows, 'impressionShare'),
        overlapRate: metricAverage(group.rows, 'overlapRate'),
        positionAboveRate: metricAverage(group.rows, 'positionAboveRate'),
        topImpressionRate: metricAverage(group.rows, 'topImpressionRate'),
        absoluteTopImpressionRate: metricAverage(group.rows, 'absoluteTopImpressionRate'),
        outrankingShare: metricAverage(group.rows, 'outrankingShare'),
        pressureScore: metricAverage(group.rows, 'pressureScore')
    }));
}

function buildAuctionTrend(rows, domains) {
    const dates = Array.from(new Set(rows.map(row => row.date).filter(Boolean))).sort();
    const domainKeys = domains.map(domain => domain.domain);
    const hasOwnRows = rows.some(row => row.isYou || String(row.domain || '').toLowerCase() === 'you');
    const seriesKeys = hasOwnRows ? ['you', ...domainKeys] : domainKeys;

    return {
        dates,
        series: seriesKeys.map(domain => {
            const domainRows = rows.filter(row => {
                const key = String(row.domain || '').toLowerCase();
                return domain === 'you' ? key === 'you' : key === domain;
            });
            return {
                domain: domain === 'you' ? 'You' : domain,
                values: dates.map(date => metricAverage(domainRows.filter(row => row.date === date), 'impressionShare'))
            };
        }).filter(item => item.values.some(value => value !== null))
    };
}

function renderAuctionInsights(auctionInsights) {
    const summaryEl = document.getElementById('auctionInsightsSummary');
    const listEl = document.getElementById('auctionPressureList');
    const chartEl = document.getElementById('auctionInsightsChart');
    const trendEl = document.getElementById('auctionInsightsTrendChart');
    if (!summaryEl || !listEl || !chartEl || !trendEl) return;

    const rows = Array.isArray(auctionInsights) ? auctionInsights : [];
    const statuses = Array.isArray(dashboardData.auctionInsightsStatus) ? dashboardData.auctionInsightsStatus : [];
    const rivals = rows.filter(row => row.domain && !row.isYou && String(row.domain).toLowerCase() !== 'you');
    const ownRows = rows.filter(row => row.isYou || String(row.domain || '').toLowerCase() === 'you');
    const domains = aggregateAuctionDomains(rows);
    const topByPressure = domains.slice().sort((a, b) => (b.pressureScore || -1) - (a.pressureScore || -1)).slice(0, 8);
    const topShare = domains.slice().sort((a, b) => (b.impressionShare || -1) - (a.impressionShare || -1))[0];
    const topAbove = domains.slice().sort((a, b) => (b.positionAboveRate || -1) - (a.positionAboveRate || -1))[0];
    const avgOverlap = metricAverage(rivals, 'overlapRate');
    const ownShare = metricAverage(ownRows, 'impressionShare');

    if (rows.length === 0) {
        const statusRows = statuses.slice(0, 12).map(status => `
            <div class="auction-status-row auction-status-row--${esc(status.status || 'empty')}">
                <strong>${esc(status.entityName || status.entityId || 'Auction scope')}</strong>
                <span>${esc(status.message || 'No rows available.')}</span>
            </div>
        `).join('');
        summaryEl.innerHTML = `
            <div class="auction-empty">
                <h4>No Auction Insights loaded</h4>
                <p>Refresh after Google Sheet names are saved and the Sheets token is configured.</p>
                ${statusRows ? `<div class="auction-status-list">${statusRows}</div>` : ''}
            </div>
        `;
        listEl.innerHTML = `<div class="auction-empty compact">No rival domains to rank.</div>`;
        if (charts.auctionInsights) charts.auctionInsights.destroy();
        if (charts.auctionInsightsTrend) charts.auctionInsightsTrend.destroy();
        return;
    }

    const summaryCards = [
        { label: 'Rival domains', value: fmtNum(new Set(rivals.map(row => String(row.domain).toLowerCase())).size), detail: `${fmtNum(rivals.length)} rival rows` },
        { label: 'Your impression share', value: fmtPct(ownShare), detail: `${fmtNum(ownRows.length)} own rows` },
        { label: 'Top rival share', value: topShare ? fmtPct(topShare.impressionShare) : 'n/a', detail: topShare ? topShare.domain : 'n/a' },
        { label: 'Highest above you', value: topAbove ? fmtPct(topAbove.positionAboveRate) : 'n/a', detail: topAbove ? topAbove.domain : 'n/a' },
        { label: 'Avg rival overlap', value: fmtPct(avgOverlap), detail: 'Observed auctions' },
        { label: 'Sheet scopes OK', value: fmtNum(statuses.filter(status => status.status === 'ok').length), detail: `${fmtNum(statuses.length)} configured scopes` }
    ];

    summaryEl.innerHTML = summaryCards.map(card => `
        <div class="auction-metric">
            <span>${esc(card.label)}</span>
            <strong>${esc(card.value)}</strong>
            <small>${esc(card.detail)}</small>
        </div>
    `).join('');

    listEl.innerHTML = topByPressure.length ? topByPressure.map(domain => {
        const bars = [
            ['Share', domain.impressionShare],
            ['Overlap', domain.overlapRate],
            ['Above', domain.positionAboveRate],
            ['Top', domain.topImpressionRate]
        ];
        return `
            <div class="auction-pressure-row">
                <div class="auction-pressure-head">
                    <div>
                        <strong>${esc(domain.domain)}</strong>
                        <span>${esc(domain.coverage)} · ${fmtNum(domain.rows)} rows</span>
                    </div>
                    <b>${fmtPct(domain.pressureScore)}</b>
                </div>
                <div class="auction-bars">
                    ${bars.map(([label, value]) => `
                        <div class="auction-bar-line">
                            <span>${esc(label)}</span>
                            <div class="auction-bar-track"><i style="width:${Math.min(Math.max(Number(value || 0), 0), 100)}%"></i></div>
                            <em>${fmtPct(value)}</em>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }).join('') : `<div class="auction-empty compact">No rival domains to rank.</div>`;

    if (charts.auctionInsights) charts.auctionInsights.destroy();
    charts.auctionInsights = new Chart(chartEl.getContext('2d'), {
        type: 'bar',
        data: {
            labels: topByPressure.slice(0, 6).map(domain => domain.domain),
            datasets: [
                { label: 'Impression share', data: topByPressure.slice(0, 6).map(domain => domain.impressionShare || 0), backgroundColor: '#10b981' },
                { label: 'Overlap', data: topByPressure.slice(0, 6).map(domain => domain.overlapRate || 0), backgroundColor: '#3b82f6' },
                { label: 'Position above', data: topByPressure.slice(0, 6).map(domain => domain.positionAboveRate || 0), backgroundColor: '#f59e0b' },
                { label: 'Top page', data: topByPressure.slice(0, 6).map(domain => domain.topImpressionRate || 0), backgroundColor: '#ef4444' }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            plugins: {
                legend: { position: 'bottom' },
                tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${fmtPct(ctx.raw)}` } }
            },
            scales: {
                x: { min: 0, max: 100, ticks: { callback: value => `${value}%` } },
                y: { ticks: { autoSkip: false } }
            }
        }
    });

    if (charts.auctionInsightsTrend) charts.auctionInsightsTrend.destroy();
    const trend = buildAuctionTrend(rows, topByPressure.slice(0, 5));
    const trendColors = ['#10b981', '#f25e36', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6'];
    charts.auctionInsightsTrend = new Chart(trendEl.getContext('2d'), {
        type: 'line',
        data: {
            labels: trend.dates.map(formatDateShort),
            datasets: trend.series.map((item, index) => ({
                label: item.domain,
                data: item.values,
                borderColor: trendColors[index % trendColors.length],
                backgroundColor: trendColors[index % trendColors.length],
                borderWidth: item.domain === 'You' ? 3 : 2,
                pointRadius: 3,
                pointHoverRadius: 5,
                tension: 0.3,
                spanGaps: true
            }))
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom' },
                tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${fmtPct(ctx.raw)}` } }
            },
            scales: {
                y: { min: 0, max: 100, ticks: { callback: value => `${value}%` } },
                x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } }
            }
        }
    });
}

function renderRankDiagnostics() {
    const constraints = (dashboardData.rankShareEntities || dashboardData.insights?.constraints || []).map(row => ({
        campaign: row.name || row.adGroup || row.campaign || 'Selected scope',
        impressionShare: row.impressionShare,
        lostISBudget: row.lostISBudget,
        lostISRank: row.lostISRank
    }));
    const competitors = dashboardData.competitorBreakdown || [];
    const quality = dashboardData.qualityScores || [];
    const landingPages = dashboardData.landingPages || [];
    const auctionInsights = dashboardData.auctionInsights || [];
    const auctionStatuses = dashboardData.auctionInsightsStatus || [];
    renderAuctionInsights(auctionInsights);

    if (els.rankSummary) {
        const c = constraints[0] || {};
        const selectedAdGroup = document.getElementById('globalAdGroupFilter')?.value || 'All';

        let budgetHtml = '';
        if (c.lostISBudget !== null && c.lostISBudget !== undefined) {
            budgetHtml = `Your ads appeared for <strong>${fmtPct(c.impressionShare)}</strong> of searches. You missed <strong>${fmtPct(c.lostISBudget)}</strong> of potential traffic because your daily budget ran out, and <strong>${fmtPct(c.lostISRank)}</strong> due to low ad rank (bids/ad quality).`;
        } else if (selectedAdGroup !== 'All' && c.impressionShare !== null && c.impressionShare !== undefined) {
            budgetHtml = `Ad group "${esc(selectedAdGroup)}" has <strong>${fmtPct(c.impressionShare)}</strong> impression share. <em>Note: Google Ads does not expose budget/rank loss metrics at the ad group level.</em>`;
        } else {
            budgetHtml = 'Campaign impression share constraints not loaded.';
        }

        const lowQsCount = quality.filter(q => q.qualityScore > 0 && q.qualityScore <= 3).length;
        const rankHtml = lowQsCount > 0
            ? `<strong>${fmtNum(lowQsCount)} keywords</strong> have critical Quality Scores (3/10 or below). <strong>Action:</strong> Group them into tightly-themed ad groups, and create dedicated landing/comparison pages to improve relevance.`
            : `All keywords have healthy Quality Scores (4/10 or above). Ad relevance and landing page experiences are on track.`;

        els.rankSummary.innerHTML = `
            <div class="insight-item" style="border-color: var(--warning)">
                <h4>Budget Constraint</h4>
                <p>${budgetHtml}</p>
            </div>
            <div class="insight-item" style="border-color: var(--danger)">
                <h4>Rank Constraint</h4>
                <p>${rankHtml}</p>
            </div>
            <div class="insight-item" style="border-color: ${auctionInsights.length ? 'var(--success)' : 'var(--info)'}">
                <h4>Auction Insights</h4>
                <p>${auctionInsights.length ? `${fmtNum(auctionInsights.length)} rival-domain rows loaded from ${fmtNum(auctionStatuses.filter(s => s.status === 'ok').length)} Google Sheet scopes.` : (auctionStatuses[0]?.message || 'Auction Insights sheet settings have not produced rows yet.')}</p>
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
        { field: 'finalUrl', headerName: 'Final URL', pinned: 'left', minWidth: 200, cellRenderer: p => p.value ? `<span class="table-link-wrap">${esc(p.value)}</span>` : '-' },
        { field: 'spend', headerName: 'Spend', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'clicks', headerName: 'Clicks', filter: 'agNumberColumnFilter' },
        { field: 'conversions', headerName: 'Conv.', filter: 'agNumberColumnFilter' },
        { field: 'cvr', headerName: 'CVR', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
        { field: 'cpa', headerName: 'CPA', valueFormatter: params => params.data.conversions > 0 ? fmtCurr(params.value) : 'n/a', filter: 'agNumberColumnFilter' }
    ]);

    if (auctionInsights) {
        initGrid('grid-auctionInsights', auctionInsights, [
            { field: 'domain', headerName: 'Domain', pinned: 'left', minWidth: 200, cellStyle: params => params.data?.isYou ? { fontWeight: 700, color: '#10b981' } : null },
            { field: 'date', headerName: 'Day', filter: 'agDateColumnFilter' },
            { field: 'week', headerName: 'Week' },
            { field: 'dayOfWeek', headerName: 'Day Name' },
            { field: 'month', headerName: 'Month' },
            { field: 'quarter', headerName: 'Quarter' },
            { field: 'campaign', headerName: 'Campaign', minWidth: 180 },
            { field: 'adGroup', headerName: 'Ad Group', minWidth: 160 },
            { field: 'pressureScore', headerName: 'Pressure', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter', sort: 'desc' },
            { field: 'impressionShare', headerName: 'Impr. Share', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
            { field: 'overlapRate', headerName: 'Overlap Rate', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
            { field: 'positionAboveRate', headerName: 'Position Above', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
            { field: 'topImpressionRate', headerName: 'Top Page', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
            { field: 'absoluteTopImpressionRate', headerName: 'Abs. Top', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
            { field: 'outrankingShare', headerName: 'Outranking Share', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
            { field: 'sourceScope', headerName: 'Scope' }
        ]);
    }
}

function renderCandidateSignals() {
    const grid = document.getElementById('candidateSignalsGrid');
    if (!grid) return;
    const signals = Array.isArray(dashboardData.candidateSignals) ? dashboardData.candidateSignals : [];
    if (signals.length === 0) {
        grid.innerHTML = `<div style="color:var(--text-muted);">No opportunities or suggestions available for this update.</div>`;
        return;
    }

    const severityOrder = { critical: 5, high: 4, medium: 3, low: 2, watchlist: 1 };
    const topSignals = signals
        .slice()
        .sort((a, b) => (severityOrder[b.severity] || 0) - (severityOrder[a.severity] || 0))
        .slice(0, 12);

    grid.innerHTML = topSignals.map(signal => {
        const entityName = signal.entity?.name || signal.entity?.keyword_text || signal.entity?.search_term || signal.entity?.url || signal.campaign_id || 'Account';
        const windowText = signal.evidence_window
            ? `${signal.evidence_window.start || '?'} to ${signal.evidence_window.end || '?'}`
            : 'not recorded';
        const firstEvidence = Array.isArray(signal.evidence) && signal.evidence.length ? signal.evidence[0] : 'No evidence line recorded.';
        return `
            <div class="candidate-signal-card">
                <div class="candidate-signal-head">
                    <div>
                        <div class="candidate-signal-title">${esc(String(signal.type || '').replace(/_/g, ' '))}</div>
                        <div class="candidate-signal-meta">${esc(entityName)}</div>
                    </div>
                    <span class="status-pill ${statusClass(signal.severity)}">${esc(signal.severity || 'signal')}</span>
                </div>
                <div class="candidate-signal-meta">Date range: ${esc(windowText)}</div>
                <div style="color:var(--text-secondary); font-size:0.85rem; line-height:1.45;">${esc(firstEvidence)}</div>
            </div>
        `;
    }).join('');
}

// Proposals
function renderProposals() {
    const props = dashboardData.proposals || [];
    const activeProps = props.filter(p => !p.status || p.status === 'pending_review');
    const lifecycleProps = props.filter(p => p.status && p.status !== 'pending_review');
    if (els.proposalCount) els.proposalCount.textContent = activeProps.length;

    const checklist = activeProps.filter(p => (p.confidence || 0) >= 0.95);
    const debate = activeProps.filter(p => (p.confidence || 0) < 0.95);
    const renderEvidenceList = (items, emptyText) => {
        const safeItems = Array.isArray(items) ? items.filter(Boolean) : [];
        if (safeItems.length === 0) return `<div style="font-size:0.85rem; color:var(--text-muted);">${esc(emptyText)}</div>`;
        return `<ul style="margin:0.5rem 0 0; padding-left:1.1rem; color:var(--text-secondary); font-size:0.85rem;">${safeItems.map(item => `<li>${esc(item)}</li>`).join('')}</ul>`;
    };
    const evidenceWindowText = (p) => p.evidence_window
        ? `Date range: ${esc(p.evidence_window.start || '?')} to ${esc(p.evidence_window.end || '?')}`
        : 'Date range: not recorded';
    const memoryContextForDisplay = (value) => {
        const raw = Array.isArray(value) ? { memories: value } : objectValue(value);
        if (!raw) return null;
        const summary = String(raw.summary || '').trim();
        const memories = (Array.isArray(raw.memories) ? raw.memories : [])
            .filter(item => item && typeof item === 'object' && (item.content || item.reason || item.memory_id))
            .slice(0, 6);
        const caveats = (Array.isArray(raw.caveats) ? raw.caveats : [])
            .map(item => String(item || '').trim())
            .filter(Boolean)
            .slice(0, 4);
        if (!summary && memories.length === 0 && caveats.length === 0) return null;
        return { summary, memories, caveats };
    };
    const memoryLabel = (memory) => [memory.category, memory.scope_type, memory.authority]
        .map(item => String(item || '').replace(/_/g, ' ').trim())
        .filter(Boolean)
        .join(' · ');
    const renderMemoryContext = (value) => {
        const context = memoryContextForDisplay(value);
        if (!context) return '';
        const memoryItems = context.memories.map(memory => `
            <div class="proposal-memory-item">
                <div class="proposal-memory-meta">
                    ${memoryLabel(memory) ? `<span>${esc(memoryLabel(memory))}</span>` : ''}
                    ${memory.verification_status ? `<span>${esc(String(memory.verification_status).replace(/_/g, ' '))}</span>` : ''}
                    ${memory.influence ? `<span>${esc(String(memory.influence).replace(/_/g, ' '))}</span>` : ''}
                </div>
                ${memory.content ? `<div class="proposal-memory-content">${esc(memory.content)}</div>` : ''}
                ${memory.reason ? `<div class="proposal-memory-reason"><strong>Why it mattered:</strong> ${esc(memory.reason)}</div>` : ''}
                ${memory.source_ref || memory.valid_until ? `
                    <div class="proposal-memory-foot">
                        ${memory.source_ref ? `<span>Source: ${esc(memory.source_ref)}</span>` : ''}
                        ${memory.valid_until ? `<span>Valid until: ${esc(memory.valid_until)}</span>` : ''}
                    </div>
                ` : ''}
            </div>
        `).join('');
        const caveatItems = context.caveats.map(item => `<li>${esc(item)}</li>`).join('');
        return `
            <div class="proposal-memory-context">
                <div class="proposal-memory-head">
                    <span class="proposal-memory-kicker">Memory used</span>
                    <span class="proposal-memory-subtitle">Prior human context that changed this recommendation.</span>
                </div>
                ${context.summary ? `<div class="proposal-memory-summary">${esc(context.summary)}</div>` : ''}
                ${memoryItems ? `<div class="proposal-memory-list">${memoryItems}</div>` : ''}
                ${caveatItems ? `
                    <div class="proposal-memory-caveats">
                        <div class="proposal-option-label warning">Check before trusting</div>
                        <ul>${caveatItems}</ul>
                    </div>
                ` : ''}
            </div>
        `;
    };
    const feedbackStatusText = (status) => ({
        raw: 'Saved as feedback',
        reviewed: 'Reviewed by AI',
        converted_to_memory: 'Saved as memory',
        ignored: 'Not reusable'
    }[String(status || 'raw')] || statusLabel(status));
    const feedbackStatusClass = (status) => `proposal-feedback-status ${statusClass(status || 'raw')}`;
    const renderProposalFeedback = (p) => {
        const feedback = Array.isArray(p.feedback) ? p.feedback.slice(0, 4) : [];
        const feedbackItems = feedback.map(item => `
            <div class="proposal-feedback-item">
                <div class="proposal-feedback-meta">
                    <span>${esc(String(item.feedback_type || 'context').replace(/_/g, ' '))}</span>
                    <span class="${esc(feedbackStatusClass(item.status))}">${esc(feedbackStatusText(item.status))}</span>
                    ${item.related_memory_id ? `<span>memory ${esc(shortId(item.related_memory_id))}</span>` : ''}
                    ${item.created_at ? `<span>${esc(formatDateTime(item.created_at))}</span>` : ''}
                </div>
                <div class="proposal-feedback-comment">${esc(item.comment || '')}</div>
                ${item.reviewer_note ? `<div class="proposal-feedback-note">Review note: ${esc(item.reviewer_note)}</div>` : ''}
            </div>
        `).join('');
        return `
            <div class="proposal-feedback-box">
                <div class="proposal-feedback-head">
                    <div>
                        <div class="proposal-feedback-eyebrow">Learning input</div>
                        <div class="proposal-feedback-title">Feedback for Agent</div>
                        <div class="proposal-feedback-subtitle">Saved as raw proposal feedback. It becomes memory only after review.</div>
                    </div>
                    ${feedback.length ? `<span class="${esc(feedbackStatusClass(feedback[0].status))}">${esc(feedbackStatusText(feedback[0].status))}</span>` : ''}
                </div>
                ${feedbackItems ? `<div class="proposal-feedback-list">${feedbackItems}</div>` : ''}
                <div class="proposal-feedback-form" data-proposal-id="${esc(p.proposal_id)}">
                    <label class="proposal-feedback-field proposal-feedback-kind">
                        <span>Type</span>
                        <select class="proposal-feedback-type" aria-label="Feedback type">
                            <option value="context">Context</option>
                            <option value="preference">Preference</option>
                            <option value="correction">Correction</option>
                            <option value="disagree">Disagree</option>
                            <option value="agree">Agree</option>
                            <option value="other">Other</option>
                        </select>
                    </label>
                    <label class="proposal-feedback-field">
                        <span>Comment</span>
                        <textarea class="proposal-feedback-text" rows="3" maxlength="4000" placeholder="Tell the agent what to remember about this recommendation."></textarea>
                    </label>
                    <button class="prop-action-btn proposal-feedback-submit" onclick="submitProposalFeedback(${jsArg(p.proposal_id)})">Save feedback</button>
                </div>
            </div>
        `;
    };
    const renderOption = (p, opt) => `
        <div class="proposal-option-card">
            <div class="proposal-option-head">
                <div>
                    <div class="proposal-option-type">${esc(opt.strategy_type)}</div>
                    <div class="proposal-option-hypothesis">${esc(opt.hypothesis || opt.description || opt.recommendation || '')}</div>
                </div>
                ${opt.win_probability != null ? `<span class="proposal-option-prob">${fmtPct(Number(opt.win_probability) * 100)}</span>` : ''}
            </div>
            <div class="proposal-option-recommendation">${esc(opt.recommendation || opt.description || '')}</div>
            ${renderMemoryContext(opt.memory_context)}
            <div class="proposal-option-grid">
                <div>
                    <div class="proposal-option-label success">Evidence</div>
                    ${renderEvidenceList(opt.evidence, 'No explicit evidence supplied.')}
                </div>
                <div>
                    <div class="proposal-option-label warning">Counter-evidence / risk</div>
                    ${renderEvidenceList([...(opt.counter_evidence || []), ...(opt.risks || [])], 'No counter-evidence supplied.')}
                </div>
            </div>
            ${(opt.manual_steps || []).length ? `
                <div class="proposal-manual-steps">
                    <div class="proposal-option-label">Manual steps</div>
                    ${renderEvidenceList(opt.manual_steps, '')}
                </div>
            ` : ''}
            ${opt.expected_outcome ? `<div class="proposal-expected">Expected: ${esc(opt.expected_outcome)}</div>` : ''}
            <div class="proposal-option-actions">
                <button class="prop-action-btn prop-action-accept" onclick="handleProposal(${jsArg(p.proposal_id)}, 'accept', ${jsArg(opt.option_id)})">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    Choose
                </button>
                <button class="prop-action-btn prop-action-implemented" onclick="handleProposal(${jsArg(p.proposal_id)}, 'implemented', ${jsArg(opt.option_id)})">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                    Implemented
                </button>
            </div>
        </div>
    `;

    const renderProposalActions = (p) => `
        <div class="proposal-actions-bar proposal-actions-secondary">
            <button class="prop-action-btn prop-action-reject" onclick="handleProposal(${jsArg(p.proposal_id)}, 'reject')">Reject proposal</button>
            <button class="prop-action-btn prop-action-ignore" onclick="handleProposal(${jsArg(p.proposal_id)}, 'ignore')">Ignore</button>
        </div>
    `;

    const selectedOptionFor = (p) => {
        if (!Array.isArray(p.options) || p.options.length === 0) return null;
        if (p.selected_option_id) return p.options.find(opt => opt.option_id === p.selected_option_id) || null;
        return p.options.length === 1 ? p.options[0] : null;
    };

    const renderImpactDetails = (p) => {
        const details = latestImpactDetails(p);
        if (!details) return '';
        const reasons = Array.isArray(details.reasons) ? details.reasons.filter(Boolean).slice(0, 4) : [];
        const caveats = Array.isArray(details.caveats) ? details.caveats.filter(Boolean).slice(0, 4) : [];
        const reasonItems = reasons.map(item => `<li>${esc(item)}</li>`).join('');
        const caveatItems = caveats.map(item => `<li>${esc(item)}</li>`).join('');
        return `
            <div class="impact-explanation-card">
                <div class="impact-explanation-head">
                    <div>
                        <div class="impact-explanation-title">Impact score</div>
                        <div class="impact-explanation-subtitle">This is an observed outcome, not proof of causation.</div>
                    </div>
                    <span class="status-pill ${statusClass(details.label)}">${esc(impactLabelText(details.label))}</span>
                </div>
                <div class="impact-explanation-summary">${esc(details.plain_english_summary || '')}</div>
                ${reasonItems ? `
                    <div class="impact-explanation-section">
                        <div class="proposal-option-label success">Why this label</div>
                        <ul>${reasonItems}</ul>
                    </div>
                ` : ''}
                ${caveatItems ? `
                    <div class="impact-explanation-section">
                        <div class="proposal-option-label warning">What lowered confidence</div>
                        <ul>${caveatItems}</ul>
                    </div>
                ` : ''}
            </div>
        `;
    };

    const renderLifecycle = (p) => {
        const selected = selectedOptionFor(p);
        const selectedText = selected
            ? `${selected.strategy_type || selected.option_id}: ${selected.recommendation || selected.description || selected.hypothesis || ''}`
            : 'No option selected.';
        return `
            <div class="proposal-lifecycle-card" id="prop-history-${esc(p.proposal_id)}">
                <div class="proposal-lifecycle-head">
                    <div>
                        <div class="proposal-lifecycle-title">${esc(p.summary || p.proposal_id)}</div>
                        <div class="proposal-lifecycle-meta">${esc((p.type || '').replace(/_/g, ' '))}</div>
                    </div>
                    <span class="status-pill ${statusClass(p.status)}">${esc(statusLabel(p.status))}</span>
                </div>
                <div class="proposal-window">${evidenceWindowText(p)}</div>
                <div style="margin-top:0.75rem; color:var(--text-secondary); font-size:0.86rem; line-height:1.45;">${esc(selectedText)}</div>
                ${renderMemoryContext(p.memory_context)}
                ${renderImpactDetails(p)}
                ${renderProposalFeedback(p)}
            </div>
        `;
    };

    const checklistGrid = document.getElementById('checklistGrid');
    if (checklistGrid) {
        if (checklist.length === 0) {
            checklistGrid.innerHTML = `<div style="color:var(--text-muted);">No immediate actions required.</div>`;
        } else {
            checklistGrid.innerHTML = checklist.map(p => `
                <div class="proposal-card-unified" id="prop-${esc(p.proposal_id)}">
                    <div class="proposal-card-body">
                        <div style="font-weight:600;">${esc(p.summary)}</div>
                        <div style="font-size:0.85rem; color:var(--text-muted);">${esc(p.options && p.options.length > 0 ? (p.options[0].recommendation || p.options[0].description || '') : '')}</div>
                        <div style="font-size:0.8rem; color:var(--success); margin-top:0.25rem;">Historical confidence: ${fmtPct((p.confidence || 0) * 100)}</div>
                        <div class="proposal-window">${evidenceWindowText(p)}</div>
                        ${renderMemoryContext(p.memory_context)}
                        ${p.options && p.options[0] ? `<div style="margin-top:0.75rem;">${renderOption(p, p.options[0])}</div>` : ''}
                        ${renderProposalFeedback(p)}
                    </div>
                    ${renderProposalActions(p)}
                </div>
            `).join('');
        }
    }

    if (els.proposalsGrid) {
        if (debate.length === 0) {
            els.proposalsGrid.innerHTML = `<div style="color:var(--text-muted);">No recommendations requiring review at this time.</div>`;
        } else {
            els.proposalsGrid.innerHTML = debate.map(p => `
                <div class="card glass-card proposal-card-unified" id="prop-${esc(p.proposal_id)}">
                    <div class="proposal-card-body" style="padding:1.25rem 1.5rem;">
                        <span class="proposal-type">${esc((p.type || '').replace(/_/g, ' '))}</span>
                        <h3 class="proposal-summary">${esc(p.summary)}</h3>
                        <div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.25rem;">
                            Confidence: ${fmtPct((p.confidence || 0) * 100)}
                        </div>
                        <div class="proposal-window">${evidenceWindowText(p)}</div>
                        ${renderMemoryContext(p.memory_context)}
                        <div style="display:flex; flex-direction:column; gap:1rem; margin-top:1rem;">
                            ${(p.options || []).map(opt => renderOption(p, opt)).join('')}
                        </div>
                        ${renderProposalFeedback(p)}
                    </div>
                    ${renderProposalActions(p)}
                </div>
            `).join('');
        }
    }

    const lifecycleGrid = document.getElementById('proposalLifecycleGrid');
    if (lifecycleGrid) {
        if (lifecycleProps.length === 0) {
            lifecycleGrid.innerHTML = `<div style="color:var(--text-muted);">No past decisions recorded yet.</div>`;
        } else {
            const statusRank = {
                accepted: 6,
                user_marked_implemented: 5,
                monitoring_14: 4,
                monitoring_30: 3,
                detected_implemented: 3,
                completed: 2,
                rejected: 1,
                ignored: 1,
                expired: 1,
                superseded: 1
            };
            lifecycleGrid.innerHTML = lifecycleProps
                .slice()
                .sort((a, b) => (statusRank[b.status] || 0) - (statusRank[a.status] || 0))
                .map(renderLifecycle)
                .join('');
        }
    }
}

window.handleProposal = function (id, action, selectedOptionId = null) {
    const card = document.getElementById(`prop-${id}`);
    if (!card) return;
    card.style.opacity = '0.5';
    card.style.pointerEvents = 'none';

    dashboardFetch(`${API_BASE_GLOBAL}/api/proposals/${id}/status`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ action, selected_option_id: selectedOptionId })
    })
        .then(async res => {
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Failed to update proposal status');

            showToast(`Proposal ${action} recorded.`);

            // Update local memory
            if (dashboardData && dashboardData.proposals) {
                const prop = dashboardData.proposals.find(p => p.proposal_id === id);
                if (prop && data.proposal) {
                    Object.assign(prop, data.proposal);
                } else if (prop) {
                    prop.status = action === 'accept' ? 'accepted' : action === 'implemented' ? 'user_marked_implemented' : action === 'reject' ? 'rejected' : 'ignored';
                    if (selectedOptionId) prop.selected_option_id = selectedOptionId;
                }
            }

            // Fading out transition
            card.style.transition = 'all 0.5s ease';
            card.style.transform = 'scale(0.9)';
            card.style.opacity = '0';
            setTimeout(() => {
                renderProposals();
            }, 500);
        })
        .catch(err => {
            console.error(err);
            showToast(`Error: ${err.message}`, true);
            card.style.opacity = '1';
            card.style.pointerEvents = 'auto';
        });
};

window.submitProposalFeedback = function (id) {
    const form = Array.from(document.querySelectorAll('.proposal-feedback-form'))
        .find(el => el.dataset.proposalId === String(id));
    if (!form) return;
    const textarea = form.querySelector('.proposal-feedback-text');
    const typeSelect = form.querySelector('.proposal-feedback-type');
    const button = form.querySelector('.proposal-feedback-submit');
    const comment = String(textarea?.value || '').trim();
    if (!comment) {
        showToast('Add a comment before saving feedback.', true);
        return;
    }

    if (button) {
        button.disabled = true;
        button.textContent = 'Saving...';
    }

    dashboardFetch(`${API_BASE_GLOBAL}/api/proposals/${id}/feedback`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            comment,
            feedback_type: typeSelect?.value || 'context',
            customer_id: dashboardData?.meta?.accountId || null
        })
    })
        .then(async res => {
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Failed to save feedback');
            if (dashboardData && Array.isArray(dashboardData.proposals)) {
                const prop = dashboardData.proposals.find(p => p.proposal_id === id);
                if (prop && data.feedback) {
                    prop.feedback = Array.isArray(prop.feedback) ? prop.feedback : [];
                    prop.feedback.unshift(data.feedback);
                }
            }
            showToast('Feedback saved for AI review.');
            renderProposals();
        })
        .catch(err => {
            console.error(err);
            showToast(`Feedback failed: ${err.message}`, true);
            if (button) {
                button.disabled = false;
                button.textContent = 'Save feedback';
            }
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

    const constraints = (dashboardData.rankShareEntities || dashboardData.campaigns || []).slice(0, 10);

    const hasLostBudget = constraints.some(c => c.lostISBudget !== null && c.lostISBudget !== undefined);
    const hasLostRank = constraints.some(c => c.lostISRank !== null && c.lostISRank !== undefined);
    const datasets = [
        { label: 'IS Won', data: constraints.map(c => parseFloat(c.impressionShare) || 0), backgroundColor: '#10b981' }
    ];
    if (hasLostBudget) datasets.push({ label: 'Lost to Budget', data: constraints.map(c => parseFloat(c.lostISBudget) || 0), backgroundColor: '#f59e0b' });
    if (hasLostRank) datasets.push({ label: 'Lost to Rank', data: constraints.map(c => parseFloat(c.lostISRank) || 0), backgroundColor: '#ef4444' });

    charts.impressionShare = new Chart(el.getContext('2d'), {
        type: 'bar',
        data: {
            labels: constraints.map(c => c.name || c.adGroup || c.campaign || 'Unknown'),
            datasets
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

    const data = dashboardData.dailyRankShare || dashboardData.dailyCampaigns || [];
    const hasLostBudget = data.some(d => d.lostISBudget !== null && d.lostISBudget !== undefined);
    const hasLostRank = data.some(d => d.lostISRank !== null && d.lostISRank !== undefined);
    const datasets = [
        { label: 'IS Won', data: data.map(d => parseFloat(d.impressionShare) || 0), backgroundColor: '#10b981' }
    ];
    if (hasLostBudget) datasets.push({ label: 'Lost to Budget', data: data.map(d => parseFloat(d.lostISBudget) || 0), backgroundColor: '#f59e0b' });
    if (hasLostRank) datasets.push({ label: 'Lost to Rank', data: data.map(d => parseFloat(d.lostISRank) || 0), backgroundColor: '#ef4444' });

    charts.impressionShareTime = new Chart(el.getContext('2d'), {
        type: 'bar',
        data: {
            labels: data.map(d => formatDateShort(d.date)),
            datasets
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

    // First-party webhook lead integration (deduped sessions from lead_sessions table)
    const COMPETITORS = ['aisensy', 'wati', 'interakt', 'doubletick', 'gallabox', 'sendwo', 'whatsbox', 'alvo chat', 'rocketsend io'];
    const leadRows = dashboardData.leadAttribution?.filteredLeads || dashboardData.leadAttribution?.allLeads || [];
    const webhookLeads = leadRows.filter(lead => {
        const term = String(lead.attribution?.keyword || lead.attribution?.utm_term || '').toLowerCase();
        return COMPETITORS.some(c => term.includes(c));
    });
    const webhookLeadsCount = webhookLeads.length;
    const webhookWonCount = webhookLeads.filter(l => normalizeLeadStatus(l.status) === 'converted').length;
    const webhookQualifiedCount = webhookLeads.filter(l => normalizeLeadStatus(l.status) === 'qualified').length;

    const isRealConvZero = dashboardData.leadAttribution && (webhookWonCount + webhookQualifiedCount) === 0;

    const kpis = [
        {
            label: 'Competitor Spend',
            value: fmtCurr(spend),
            desc: 'Total ad budget spent on keywords containing competitor names.',
            isBad: spend > 0
        },
        {
            label: 'Budget Bleed',
            value: fmtPct(share),
            desc: 'Percentage of your total ad budget allocated to competitor terms.',
            isBad: share > 5
        },
        {
            label: 'Google Ads Conversions',
            value: fmtNum(conv),
            desc: 'Conversions tracked and reported back by Google Ads.',
            isBad: spend > 0 && (conv === 0 || isRealConvZero)
        }
    ];

    if (dashboardData.leadAttribution) {
        kpis.push({
            label: 'Real Conversions',
            value: fmtNum(webhookLeadsCount),
            desc: `<strong>${webhookWonCount}</strong> closed-won, <strong>${webhookQualifiedCount}</strong> qualified.`,
            isBad: spend > 0 && isRealConvZero
        });
    }

    grid.innerHTML = kpis.map(kpi => `
        <div style="padding: 1.25rem; border-radius: 8px; border: 1px solid ${kpi.isBad ? 'rgba(239, 68, 68, 0.2)' : 'rgba(255,255,255,0.05)'}; background: ${kpi.isBad ? 'rgba(239, 68, 68, 0.05)' : 'rgba(30, 41, 59, 0.4)'}; display: flex; flex-direction: column; justify-content: space-between; gap: 0.5rem;">
            <div>
                <div style="font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;">${kpi.label}</div>
                <div style="font-size: 1.75rem; font-weight: 600; color: ${kpi.isBad ? 'var(--danger)' : 'var(--text-main)'}; margin-top: 0.25rem;">${kpi.value}</div>
            </div>
            <div style="font-size: 0.75rem; color: var(--text-muted); line-height: 1.35; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 0.5rem; margin-top: 0.25rem;">
                ${kpi.desc}
            </div>
        </div>
    `).join('');

    const recommendationEl = document.getElementById('competitorWasteRecommendation');
    if (recommendationEl) {
        let recommendationHtml = '';
        if (share > 5) {
            recommendationHtml = `
                <div style="padding: 1rem; border-radius: 8px; border: 1px solid rgba(239, 68, 68, 0.2); background: rgba(239, 68, 68, 0.02); font-size: 0.9rem;">
                    <div style="font-weight: 600; color: var(--danger); margin-bottom: 0.25rem; display: flex; align-items: center; gap: 0.5rem;">
                        <span>⚠️</span> Action Required: High Budget Bleed (${fmtPct(share)})
                    </div>
                    <div style="color: var(--text-muted); line-height: 1.45;">
                        Your ad campaign is spending a significant share of budget on searches looking for other brands. Since these users specifically intended to find your competitors, this spend is high-risk. We suggest adding competitor names as <strong>Negative Keywords</strong> to save money, or building a dedicated <strong>competitor comparison landing page</strong> to win them over.
                    </div>
                </div>
            `;
        } else if (spend > 0) {
            recommendationHtml = `
                <div style="padding: 1rem; border-radius: 8px; border: 1px solid rgba(16, 185, 129, 0.2); background: rgba(16, 185, 129, 0.02); font-size: 0.9rem;">
                    <div style="font-weight: 600; color: var(--success); margin-bottom: 0.25rem; display: flex; align-items: center; gap: 0.5rem;">
                        <span>✅</span> Competitor Spend is Under Control (${fmtPct(share)})
                    </div>
                    <div style="color: var(--text-muted); line-height: 1.45;">
                        Competitor queries account for a minor portion of your total ad budget. This level of brand exposure is healthy. Monitor conversion costs on these terms regularly to ensure they remain profitable.
                    </div>
                </div>
            `;
        } else {
            recommendationHtml = `
                <div style="padding: 1rem; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.05); background: rgba(30, 41, 59, 0.2); font-size: 0.9rem;">
                    <div style="font-weight: 600; color: var(--text-main); margin-bottom: 0.25rem; display: flex; align-items: center; gap: 0.5rem;">
                        <span>🎯</span> No Competitor Spend
                    </div>
                    <div style="color: var(--text-muted); line-height: 1.45;">
                        No ad budget is currently being spent on competitor-branded keywords. This is optimal if you want to focus budget entirely on active, non-branded search terms.
                    </div>
                </div>
            `;
        }
        recommendationEl.innerHTML = recommendationHtml;
    }
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
