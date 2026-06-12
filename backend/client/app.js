/**
 * Dashboard Logic - Fetches data and renders the UI
 */

const CURRENCY = '₹';
const DEFAULT_COMPETITOR_ROOTS = ['aisensy', 'wati', 'interakt', 'doubletick', 'gallabox', 'sendwo', 'whatsbox', 'alvo chat', 'rocketsend'];

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
    maybe: {
        label: 'Maybe - review needed',
        shortLabel: 'Maybe',
        description: 'The website qualification passed, but a person has not confirmed this lead yet.',
        color: '#0891b2'
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
const LEAD_STATUS_ORDER = ['new', 'useless', 'maybe', 'qualified', 'converted', 'qualified_lost'];
const LEAD_REVIEW_KANBAN_STATUS_ORDER = ['new', 'maybe', 'qualified', 'converted', 'qualified_lost', 'useless'];
const LEAD_REVIEW_VIEW_STORAGE_KEY = 'leadReviewViewMode';
const leadProgressDetailsBySession = new Map();
let leadReviewRowsForView = [];
let leadReviewViewMode = 'table';
let draggedLeadReviewSessionKey = '';

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
    if (!raw || raw === '(no action kind)') return 'No form submitted';
    const normalized = raw.toLowerCase().replace(/[_-]+/g, ' ');
    const labels = {
        demo: 'Demo / booking form',
        whatsapp: 'WhatsApp widget',
        trial: 'Trial signup',
        signup: 'Signup',
        contact: 'Contact form',
        request: 'Request form',
        form_submit: 'Form submitted',
        lead: 'Lead captured'
    };
    return labels[raw] || labels[normalized] || normalized.replace(/\b\w/g, c => c.toUpperCase());
}

function leadSourceLabel(value) {
    const raw = String(value || '').trim();
    const labels = {
        demo_page: 'Demo / booking form',
        whatsapp_widget: 'WhatsApp widget',
        trial_sign_up: 'Signup',
        contact_form: 'Contact form',
        request_page: 'Request form'
    };
    return labels[raw] || actionKindLabel(raw);
}

function formatActionPath(value) {
    const raw = String(value || '').trim();
    if (!raw || raw === '(no action kind)') return 'No form submitted';
    return raw.split(' -> ').map(actionKindLabel).join(' -> ');
}

function formatLeadActionSummary(actions, fallbackPath) {
    if (!Array.isArray(actions)) return formatActionPath(fallbackPath);
    if (!actions.length) return 'No form submitted';
    const counts = new Map();
    for (const action of actions) {
        const kind = String(action?.kind || '').trim();
        if (!kind) continue;
        counts.set(kind, (counts.get(kind) || 0) + 1);
    }
    if (!counts.size) return 'No form submitted';
    return Array.from(counts.entries())
        .map(([kind, count]) => `${actionKindLabel(kind)}${count > 1 ? ` ×${count}` : ''}`)
        .join(' → ');
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

const isoDateKeyParts = (value) => {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const parts = match.slice(1).map(Number);
    const date = new Date(parts[0], parts[1] - 1, parts[2]);
    return date.getFullYear() === parts[0] && date.getMonth() === parts[1] - 1 && date.getDate() === parts[2]
        ? parts
        : null;
};
const isIsoDateKey = (value) => Boolean(isoDateKeyParts(value));
const localDateFromIsoDateKey = (value) => {
    const parts = isoDateKeyParts(value);
    return parts ? new Date(parts[0], parts[1] - 1, parts[2]) : null;
};
const formatDateShort = (d) => {
    const date = localDateFromIsoDateKey(d) || new Date(d);
    return isNaN(date) ? d : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};
const localIsoDateKey = (date = new Date()) => {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const clampDateKey = (value, minDate, maxDate) => {
    let key = isIsoDateKey(value) ? value : '';
    if (!key) return '';
    if (minDate && key < minDate) key = minDate;
    if (maxDate && key > maxDate) key = maxDate;
    return key;
};
const formatIsoDateShort = (value) => {
    return formatDateShort(value);
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
let DASHBOARD_AUTH = null;
let pendingInstallPrompt = null;
let serviceWorkerReloading = false;
let serviceWorkerUpdateAccepted = false;
let waitingServiceWorker = null;
let dashboardServiceWorkerRegistration = null;
let serviceWorkerRegistrationPromise = null;
let serviceWorkerLifecycleBound = false;
const observedServiceWorkerRegistrations = new WeakSet();
let cachedPushConfig = null;
let pushConfigPromise = null;
let pushEnableInProgress = false;
let pendingLeadStatusConflict = null;
const BOOTSTRAP_REQUEST_TIMEOUT_MS = 12_000;
const DASHBOARD_REQUEST_TIMEOUT_MS = 20_000;
const OFFLINE_BOOTSTRAP_TIMEOUT_MS = 4_000;
const SERVICE_WORKER_REGISTRATION_TIMEOUT_MS = 10_000;
const GOOGLE_ADS_PREVIEW_BATCH_SIZE = 100;
const SHOW_REMOVED_AD_GROUP_KEYWORDS_KEY = 'zenseeo:keywords:show-removed-ad-groups';
const TAB_DASHBOARD_VIEWS = {
    overview: 'overview',
    campaigns: 'performance',
    'ad-groups': 'performance',
    keywords: 'keywords',
    audiences: 'audiences',
    attribution: 'attribution',
    rank: 'rank',
    proposals: 'proposals',
    'ad-schedule': '',
    'activity-history': ''
};
const loadedDashboardViews = new Set();
const dashboardViewPromises = new Map();
let dashboardLoadGeneration = 0;
let toastHideTimer = null;
let lastToastMessage = '';
let lastToastShownAt = 0;
let controlsState = null;
let pendingControlsPreview = null;
let pendingLocalChange = null;
let controlsPreviewRequestId = 0;
let audienceScope = 'campaign';
let audienceDimension = 'age';
let audienceChartTypes = { segments: 'line', demographics: 'bar' };
let audienceMetricSelections = { segments: ['clicks', 'impressions'], demographics: ['clicks', 'conversions'] };
let audienceCatalogMode = 'search';
let audienceEditorState = null;
let audienceDemographicEditorState = null;
let audienceResizeObserver = null;
let audienceResizeFrame = 0;
const selectedAudienceExclusions = new Set();
const keywordManagementRows = new Map();
const negativeManagementRows = new Map();
let showRemovedAdGroupKeywords = false;
let scheduleEditState = null;
let pendingScheduleConflict = null;
let dashboardRefreshPollTimer = null;
let cronRefreshStatusPollTimer = null;
let cronRefreshStatusCheckInProgress = false;
let cronRefreshWatcherInitialized = false;
let cronRefreshWatcherActive = false;
let cronRefreshWatcherStartedAtMs = 0;
let handledCronRefreshRunId = '';
const CRON_REFRESH_STATUS_POLL_INTERVAL_MS = 30_000;
const TODAY_REFRESH_AFTER_RELOAD_KEY = 'zenseeo:refresh-today-after-reload';
const OVERVIEW_KEYWORD_METRICS = {
    cost: { label: 'Cost', format: row => fmtCurr(Number(row.costMicros || 0) / 1_000_000) },
    clicks: { label: 'Clicks', format: row => fmtNum(row.clicks) },
    impressions: { label: 'Impressions', format: row => fmtNum(row.impressions) },
    ctr: { label: 'CTR', format: row => fmtPct(Number(row.ctr || 0) * 100) },
    averageCpc: { label: 'Avg. CPC', format: row => fmtCurr(Number(row.averageCpcMicros || 0) / 1_000_000) },
    conversions: { label: 'Conversions', format: row => fmtNum(row.conversions) },
    conversionRate: { label: 'Conv. rate', format: row => fmtPct(Number(row.conversionRate || 0) * 100) },
    costPerConversion: { label: 'Cost / conv.', format: row => fmtCurr(Number(row.costPerConversionMicros || 0) / 1_000_000) },
    searchImpressionShare: { label: 'Search impr. share', format: row => fmtPct(Number(row.searchImpressionShare || 0) * 100) }
};
const overviewSearchState = {
    mode: 'searches', metric: 'clicks', conversionType: 'all', conversionValue: '',
    page: 1, pageSize: 20, data: null, loadedKey: '', pendingKey: '', requestSequence: 0
};
const overviewKeywordState = {
    sort: 'cost', direction: 'desc', columns: ['cost', 'clicks', 'conversions'],
    page: 1, pageSize: 5, data: null, loadedKey: '', pendingKey: '', requestSequence: 0,
    columnWidths: null
};
const overviewSearchTermState = {
    metric: 'clicks',
    page: 1, pageSize: 8, data: null, loadedKey: '', pendingKey: '', requestSequence: 0
};
const OVERVIEW_KEYWORD_COLUMN_WIDTHS_KEY = 'overviewKeywordColumnWidths';

function finishAppBootstrap(message = '') {
    const bootstrap = document.getElementById('appBootstrap');
    if (message && bootstrap) {
        const text = bootstrap.querySelector('span');
        if (text) text.textContent = message;
    }
    document.body.classList.remove('app-booting');
    if (bootstrap && !message) bootstrap.hidden = true;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = BOOTSTRAP_REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
        if (err?.name === 'AbortError') {
            throw new TypeError(`Request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

function promiseWithTimeout(promise, timeoutMs, message) {
    let timeout;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        })
    ]).finally(() => clearTimeout(timeout));
}

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

function isUnsafeDashboardMethod(method) {
    return !['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());
}

function sameOriginPathname(url) {
    try {
        const parsed = new URL(url, window.location.origin);
        return parsed.origin === window.location.origin ? parsed.pathname : '';
    } catch {
        return '';
    }
}

function isOfflineLeadStatusPath(pathname) {
    return /^\/api\/leads\/[^/]+\/status$/.test(pathname || '');
}

function isOfflineSupportedDashboardGet(url) {
    try {
        const parsed = new URL(url, window.location.origin);
        if (parsed.origin !== window.location.origin) return false;
        if (parsed.pathname === '/api/dashboard/filters') return true;
        if (parsed.pathname !== '/api/dashboard') return false;
        return ['overview', 'performance', 'keywords', 'attribution', 'rank', 'proposals']
            .includes(parsed.searchParams.get('view') || 'overview');
    } catch {
        return false;
    }
}

function isSessionOffline() {
    return !API_KEY_GLOBAL && (DASHBOARD_AUTH?.offline || navigator.onLine === false);
}

function offlineMutationError() {
    const err = new Error('Reconnect to use this feature.');
    err.offlineBlocked = true;
    return err;
}

function dashboardFetch(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const pathname = sameOriginPathname(url);
    if (isUnsafeDashboardMethod(method) && isSessionOffline() && !isOfflineLeadStatusPath(pathname)) {
        return Promise.reject(offlineMutationError());
    }
    if (!isUnsafeDashboardMethod(method) && isSessionOffline() && !isOfflineSupportedDashboardGet(url)) {
        return Promise.reject(offlineMutationError());
    }
    let headers = authHeaders(options.headers || {});
    if (method !== 'GET' && method !== 'HEAD' && !API_KEY_GLOBAL && window.ZenseeoOffline) {
        headers = Object.fromEntries(window.ZenseeoOffline.csrfHeaders(headers).entries());
    }
    const requestOptions = {
        credentials: API_KEY_GLOBAL ? 'omit' : 'include',
        ...options,
        headers
    };
    const fetcher = timeoutSignal => {
        const signal = requestOptions.signal || timeoutSignal;
        if (signal) return fetch(url, { ...requestOptions, signal });
        return fetchWithTimeout(url, requestOptions, DASHBOARD_REQUEST_TIMEOUT_MS);
    };
    if (method === 'GET' && !API_KEY_GLOBAL && window.ZenseeoOffline) {
        return window.ZenseeoOffline.cachedDashboardFetch(url, fetcher);
    }
    return fetcher();
}

function markTodayRefreshAfterReload() {
    try {
        sessionStorage.setItem(TODAY_REFRESH_AFTER_RELOAD_KEY, String(Date.now()));
    } catch {
        // Navigation Timing still identifies the reload if session storage is unavailable.
    }
}

function shouldRefreshTodayAfterClientReload() {
    let explicitlyRequested = false;
    try {
        explicitlyRequested = Boolean(sessionStorage.getItem(TODAY_REFRESH_AFTER_RELOAD_KEY));
        sessionStorage.removeItem(TODAY_REFRESH_AFTER_RELOAD_KEY);
    } catch {
        // Fall through to the browser navigation type.
    }
    const navigation = window.performance?.getEntriesByType?.('navigation')?.[0];
    const browserReload = navigation?.type === 'reload' || window.performance?.navigation?.type === 1;
    return explicitlyRequested || browserReload;
}

async function requestTodayDataRefresh(apiBase, { force = true } = {}) {
    const now = new Date();
    const localToday = [
        String(now.getFullYear()).padStart(4, '0'),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0')
    ].join('-');
    const response = await dashboardFetch(`${apiBase}/api/trigger-refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            ...(force ? { force: true } : {}),
            refreshProfile: 'light_today',
            startDate: localToday,
            endDate: localToday
        })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || 'Failed to trigger today\'s refresh');
    return data;
}

async function requestFullDataRefresh(apiBase) {
    const response = await dashboardFetch(`${apiBase}/api/trigger-refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || 'Failed to trigger full data refresh');
    return data;
}

function stopCronRefreshCompletionWatcher() {
    if (cronRefreshStatusPollTimer) clearInterval(cronRefreshStatusPollTimer);
    cronRefreshStatusPollTimer = null;
    cronRefreshWatcherActive = false;
}

async function checkForCompletedCronRefresh() {
    if (!cronRefreshWatcherActive || cronRefreshStatusCheckInProgress || dashboardRefreshPollTimer) return;
    if (document.hidden || navigator.onLine === false || DASHBOARD_AUTH?.offline) return;
    cronRefreshStatusCheckInProgress = true;
    try {
        const response = await dashboardFetch(`${API_BASE_GLOBAL}/api/dashboard/cron-refresh-status`, {
            headers: { 'Accept': 'application/json' }
        });
        if (response.status === 401 || response.status === 403) {
            stopCronRefreshCompletionWatcher();
            return;
        }
        if (!response.ok) return;
        const data = await response.json().catch(() => ({}));
        const run = data?.refreshRun;
        if (!run?.id) {
            cronRefreshWatcherInitialized = true;
            return;
        }
        const runId = String(run.id);
        const status = String(run.status || '').toLowerCase();
        const terminal = ['succeeded', 'partial', 'failed'].includes(status);
        const completedAtMs = run.completedAt ? new Date(run.completedAt).getTime() : 0;
        if (!cronRefreshWatcherInitialized) {
            cronRefreshWatcherInitialized = true;
            if (terminal && (!completedAtMs || completedAtMs <= cronRefreshWatcherStartedAtMs)) {
                handledCronRefreshRunId = runId;
                return;
            }
        }
        if (!terminal || handledCronRefreshRunId === runId) return;
        if (dashboardRefreshPollTimer) return;
        handledCronRefreshRunId = runId;
        if (status === 'failed') {
            showToast('Scheduled data refresh failed. Existing dashboard data was kept.', true);
            return;
        }
        try {
            await loadDashboardForCurrentFilters('');
        } catch (err) {
            if (handledCronRefreshRunId === runId) handledCronRefreshRunId = '';
            throw err;
        }
        const light = run.refreshProfile === 'light_today';
        showToast(status === 'partial'
            ? `${light ? 'Today\'s scheduled data' : 'Scheduled full data'} refreshed with some source warnings.`
            : `${light ? 'Today\'s scheduled data' : 'Scheduled full data'} refreshed; dashboard updated.`, status === 'partial');
    } catch (err) {
        console.warn('Could not check scheduled refresh completion:', err);
    } finally {
        cronRefreshStatusCheckInProgress = false;
    }
}

function startCronRefreshCompletionWatcher() {
    if (cronRefreshStatusPollTimer) return;
    cronRefreshWatcherActive = true;
    cronRefreshWatcherStartedAtMs = Date.now();
    void checkForCompletedCronRefresh();
    cronRefreshStatusPollTimer = setInterval(() => {
        void checkForCompletedCronRefresh();
    }, CRON_REFRESH_STATUS_POLL_INTERVAL_MS);
    window.addEventListener('online', () => void checkForCompletedCronRefresh());
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) void checkForCompletedCronRefresh();
    });
}

function setHeaderRefreshBusy(button, busy, busyTitle = 'Refreshing today\'s data…') {
    if (!button) return;
    if (!button.dataset.idleTitle) button.dataset.idleTitle = button.title || '';
    button.disabled = Boolean(busy);
    if (busy) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
    button.title = busy ? busyTitle : button.dataset.idleTitle;
    const icon = button.querySelector('.refresh-icon');
    if (icon) icon.classList.toggle('spin', Boolean(busy));
}

function setPwaStatus(message, isError = false) {
    const el = document.getElementById('pwaStatusText');
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('settings-note--warn', Boolean(isError));
    el.classList.toggle('settings-note--ok', Boolean(message && !isError));
}

function updateOfflineBanner(message, show = true) {
    const banner = document.getElementById('offlineBanner');
    const text = document.getElementById('offlineBannerText');
    if (!banner || !text) return;
    text.textContent = message || 'Offline data is being shown.';
    banner.hidden = !show;
}

function showServiceWorkerUpdate(worker) {
    if (!worker) return;
    waitingServiceWorker = worker;
    const banner = document.getElementById('updateBanner');
    const button = document.getElementById('applyUpdateBtn');
    if (button) button.disabled = false;
    if (banner) banner.hidden = false;
}

async function bootstrapDashboardSession(apiBase) {
    if (API_KEY_GLOBAL) {
        await window.ZenseeoOffline?.detachPrivateContext?.().catch(() => undefined);
        return { mode: 'api_key', user: null };
    }
    const privateOfflineAccessBlocked = Boolean(window.ZenseeoOffline?.privateOfflineAccessBlocked?.());
    const pendingLogoutBlocked = Boolean(window.ZenseeoOffline?.pendingLogoutBlocked?.());
    if (privateOfflineAccessBlocked) {
        await window.ZenseeoOffline?.detachPrivateContext?.().catch(() => undefined);
        if (!pendingLogoutBlocked) {
            await window.ZenseeoOffline?.clearPendingLogoutMarkers?.().catch(() => undefined);
        }
    }
    try {
        if (pendingLogoutBlocked) {
            let pendingLogoutComplete;
            try {
                pendingLogoutComplete = await promiseWithTimeout(
                    Promise.resolve(window.ZenseeoOffline?.completePendingLogout?.(apiBase)),
                    BOOTSTRAP_REQUEST_TIMEOUT_MS,
                    'Pending logout completion timed out.'
                );
            } catch (err) {
                err.noOfflineFallback = true;
                err.pendingLogout = true;
                throw err;
            }
            if (pendingLogoutComplete === false) {
                const error = new Error('Pending logout could not be completed. Reconnect and retry.');
                error.noOfflineFallback = true;
                error.pendingLogout = true;
                throw error;
            }
        }
        const res = await fetchWithTimeout(`${apiBase}/api/auth/session`, {
            credentials: 'include',
            headers: { 'Accept': 'application/json' }
        });
        if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
                await window.ZenseeoOffline?.detachPrivateContext?.().catch(() => undefined);
                window.location.replace('/login');
                return null;
            }
            const error = new Error(`Session check failed with ${res.status}.`);
            error.noOfflineFallback = true;
            throw error;
        }
        const auth = await res.json();
        DASHBOARD_AUTH = auth;
        migrateLegacyOverviewTimeSeriesPreferences();
        overviewTimeSeriesCardMetrics = loadOverviewTimeSeriesMetrics();
        overviewTimeSeriesVisibleSlots = loadOverviewTimeSeriesVisibility();
        window.ZenseeoOffline?.setCsrfToken?.(auth.csrfToken || null);
        void syncUserPreferencesFromBackend(apiBase);
        cachedPushConfig = auth?.mode === 'user' && auth?.pushConfig ? auth.pushConfig : null;
        await promiseWithTimeout(
            Promise.resolve(window.ZenseeoOffline?.refreshSession?.(auth)),
            OFFLINE_BOOTSTRAP_TIMEOUT_MS,
            'Offline storage initialization timed out.'
        ).catch(err => {
            console.warn('Offline storage is unavailable; continuing online.', err);
        });
        updateAccountPanel(auth);
        updateOfflineBanner('', false);
        return auth;
    } catch (err) {
        if (err?.noOfflineFallback) throw err;
        if (privateOfflineAccessBlocked) throw err;
        const offlineSession = await promiseWithTimeout(
            Promise.resolve(window.ZenseeoOffline?.lastActiveValidSession?.()),
            OFFLINE_BOOTSTRAP_TIMEOUT_MS,
            'Offline session lookup timed out.'
        );
        if (offlineSession) {
            DASHBOARD_AUTH = { mode: 'user', user: { id: offlineSession.userId, email: offlineSession.email, name: offlineSession.name }, offline: true };
            migrateLegacyOverviewTimeSeriesPreferences();
            overviewTimeSeriesCardMetrics = loadOverviewTimeSeriesMetrics();
            overviewTimeSeriesVisibleSlots = loadOverviewTimeSeriesVisibility();
            updateOfflineBanner(`Offline mode · last online ${formatDateTime(offlineSession.lastOnlineAt)}`, true);
            updateAccountPanel(DASHBOARD_AUTH);
            return DASHBOARD_AUTH;
        }
        throw err;
    }
}

function isStandalonePwa() {
    return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIOSLike() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function updateAccountPanel(auth = DASHBOARD_AUTH) {
    const summary = document.getElementById('accountSummary');
    if (summary) {
        const user = auth?.user;
        summary.textContent = user ? `${user.name || user.email} · ${user.email}` : auth?.mode === 'magic' ? 'Magic-link dashboard session' : 'Dashboard session';
    }
    const enablePush = document.getElementById('enablePushBtn');
    const disablePush = document.getElementById('disablePushBtn');
    if (enablePush) enablePush.disabled = auth?.mode !== 'user' || auth?.offline === true || pushEnableInProgress;
    if (disablePush) disablePush.disabled = auth?.mode !== 'user' || auth?.offline === true;
}

function showPushEducationOnce(auth = DASHBOARD_AUTH) {
    if (auth?.mode !== 'user' || auth.offline || !auth.user?.id) return;
    const key = `zenseeo-push-education:${auth.user.id}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
    if (isIOSLike() && !isStandalonePwa()) {
        setPwaStatus('For iPhone push, add Zenseeo to the Home Screen, open it there, then tap Enable notifications.');
        return;
    }
    if ('Notification' in window && Notification.permission === 'default') {
        setPwaStatus('Tap Enable notifications to get alerts when new first-party leads arrive.');
    }
}

function bindServiceWorkerLifecycle() {
    if (serviceWorkerLifecycleBound) return;
    serviceWorkerLifecycleBound = true;
    let hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) {
            hadController = true;
            return;
        }
        if (!serviceWorkerUpdateAccepted || serviceWorkerReloading) return;
        serviceWorkerReloading = true;
        window.location.reload();
    });
}

function observeServiceWorkerRegistration(registration) {
    if (!registration || observedServiceWorkerRegistrations.has(registration)) return;
    observedServiceWorkerRegistrations.add(registration);
    if (registration.waiting && navigator.serviceWorker.controller) {
        showServiceWorkerUpdate(registration.waiting);
    }
    registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                showServiceWorkerUpdate(worker);
            }
        });
    });
}

async function registerServiceWorker() {
    if (!['http:', 'https:'].includes(window.location.protocol) || !('serviceWorker' in navigator)) return;
    if (serviceWorkerRegistrationPromise) return serviceWorkerRegistrationPromise;
    const request = (async () => {
        try {
            bindServiceWorkerLifecycle();
            const registration = await promiseWithTimeout(
                navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }),
                SERVICE_WORKER_REGISTRATION_TIMEOUT_MS,
                'Service worker registration timed out.'
            );
            dashboardServiceWorkerRegistration = registration;
            observeServiceWorkerRegistration(registration);
            registration.update().catch(() => undefined);
            return registration;
        } catch (err) {
            console.warn('Service worker registration failed:', err);
            return null;
        }
    })();
    serviceWorkerRegistrationPromise = request;
    try {
        return await request;
    } finally {
        if (serviceWorkerRegistrationPromise === request) serviceWorkerRegistrationPromise = null;
    }
}

function installWebManifest() {
    if (!['http:', 'https:'].includes(window.location.protocol)) return;
    if (document.querySelector('link[rel="manifest"]')) return;
    const manifest = document.createElement('link');
    manifest.rel = 'manifest';
    manifest.href = 'manifest.webmanifest';
    document.head.appendChild(manifest);
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
}

function pushSubscriptionUsesKey(subscription, publicKey) {
    const current = subscription?.options?.applicationServerKey;
    if (!current || !publicKey) return null;
    const actual = new Uint8Array(current);
    const expected = urlBase64ToUint8Array(publicKey);
    if (actual.length !== expected.length) return false;
    return actual.every((value, index) => value === expected[index]);
}

async function currentPushSubscription(timeoutMs = 10_000) {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
    const registration = await readyServiceWorkerRegistration(timeoutMs);
    return registration.pushManager.getSubscription();
}

function waitForActiveServiceWorker(registration, timeoutMs) {
    if (registration?.active) return Promise.resolve(registration);
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = activeRegistration => {
            if (settled || !activeRegistration?.active) return;
            settled = true;
            clearInterval(poll);
            clearTimeout(timeout);
            dashboardServiceWorkerRegistration = activeRegistration;
            resolve(activeRegistration);
        };
        const check = () => finish(registration);
        const poll = setInterval(check, 100);
        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            clearInterval(poll);
            reject(new Error('Zenseeo could not finish starting notifications on this device. Use Reload Zenseeo in the header, then try again.'));
        }, timeoutMs);
        navigator.serviceWorker.ready.then(finish).catch(() => undefined);
        check();
    });
}

async function readyServiceWorkerRegistration(timeoutMs = 12_000) {
    if (dashboardServiceWorkerRegistration?.active) return dashboardServiceWorkerRegistration;
    let registration = dashboardServiceWorkerRegistration || await registerServiceWorker();
    if (!registration) throw new Error('Zenseeo could not register notifications on this device. Reload Zenseeo and try again.');
    try {
        return await waitForActiveServiceWorker(registration, timeoutMs);
    } catch (firstError) {
        const latest = await navigator.serviceWorker.getRegistration('/').catch(() => null);
        if (latest) {
            registration = latest;
            dashboardServiceWorkerRegistration = latest;
            observeServiceWorkerRegistration(latest);
        }
        if (registration.active) return registration;
        await registration.update().catch(() => undefined);
        try {
            return await waitForActiveServiceWorker(registration, Math.min(timeoutMs, 8_000));
        } catch {
            throw firstError;
        }
    }
}

function requestNotificationPermissionFromGesture() {
    if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = permission => {
            if (settled) return;
            settled = true;
            clearInterval(poll);
            clearTimeout(timeout);
            resolve(permission);
        };
        const fail = error => {
            if (settled) return;
            settled = true;
            clearInterval(poll);
            clearTimeout(timeout);
            reject(error);
        };
        const poll = setInterval(() => {
            if (Notification.permission !== 'default') finish(Notification.permission);
        }, 250);
        const timeout = setTimeout(() => {
            if (Notification.permission !== 'default') finish(Notification.permission);
            else fail(new Error('Timed out waiting for notification permission.'));
        }, 30_000);
        try {
            const permissionPromise = Notification.requestPermission(finish);
            if (permissionPromise && typeof permissionPromise.then === 'function') {
                permissionPromise.then(finish, fail);
            }
        } catch (error) {
            fail(error);
        }
    });
}

function showPushControlState(enabled) {
    const disablePush = document.getElementById('disablePushBtn');
    const enablePush = document.getElementById('enablePushBtn');
    if (disablePush) {
        disablePush.hidden = !enabled;
        disablePush.toggleAttribute('hidden', !enabled);
    }
    if (enablePush) {
        enablePush.hidden = enabled;
        enablePush.toggleAttribute('hidden', enabled);
    }
}

function setPushControlsBusy(busy) {
    pushEnableInProgress = busy;
    const enablePush = document.getElementById('enablePushBtn');
    const disablePush = document.getElementById('disablePushBtn');
    if (enablePush) {
        enablePush.disabled = busy || DASHBOARD_AUTH?.mode !== 'user' || DASHBOARD_AUTH?.offline === true;
        enablePush.setAttribute('aria-busy', busy ? 'true' : 'false');
        enablePush.textContent = busy ? 'Enabling…' : 'Enable notifications';
    }
    if (disablePush) disablePush.disabled = busy || DASHBOARD_AUTH?.mode !== 'user' || DASHBOARD_AUTH?.offline === true;
}

async function loadPushConfig(force = false) {
    if (DASHBOARD_AUTH?.mode !== 'user' || DASHBOARD_AUTH.offline) return null;
    if (!force && cachedPushConfig) return cachedPushConfig;
    if (pushConfigPromise) return pushConfigPromise;
    const request = (async () => {
        const response = await dashboardFetch(`${API_BASE_GLOBAL}/api/push/config`);
        const config = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(config.error || 'Could not load notification configuration.');
        cachedPushConfig = config;
        return config;
    })();
    pushConfigPromise = request;
    try {
        return await request;
    } finally {
        if (pushConfigPromise === request) pushConfigPromise = null;
    }
}

async function reconcilePushSubscription({ quiet = true } = {}) {
    if (DASHBOARD_AUTH?.mode !== 'user') return;
    if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) {
        showPushControlState(false);
        if (!quiet) setPwaStatus('This browser does not support web push notifications.', true);
        return;
    }
    const permissionDenied = Notification.permission === 'denied';
    if (DASHBOARD_AUTH.offline) {
        setPwaStatus('Reconnect to verify notification status for this device.', true);
        return;
    }
    const configPromise = loadPushConfig(true).catch(() => null);
    let subscription;
    try {
        subscription = await currentPushSubscription();
    } catch (error) {
        if (!quiet) setPwaStatus(error.message || 'Notifications are not ready on this device.', true);
        return;
    }
    if (!subscription) {
        showPushControlState(false);
        if (permissionDenied) {
            setPwaStatus('Notification permission is blocked. Change it in browser or site settings to enable alerts.', true);
        } else if (Notification.permission === 'granted') {
            setPwaStatus('Notification permission is allowed, but this device is not subscribed yet. Tap Enable notifications to finish setup.', true);
        } else if (!quiet && Notification.permission === 'default') {
            showPushEducationOnce();
        }
        return;
    }
    const statusRes = await dashboardFetch(`${API_BASE_GLOBAL}/api/push/subscriptions/status?endpoint=${encodeURIComponent(subscription.endpoint)}`);
    const status = await statusRes.json().catch(() => ({}));
    const config = await configPromise;
    if (!statusRes.ok) {
        if (!quiet) setPwaStatus(status.error || 'Could not verify notification status.', true);
        return;
    }
    if (status.subscribed && status.belongsToCurrentUser) {
        showPushControlState(true);
        if (permissionDenied) {
            setPwaStatus('This device is still subscribed, but notification permission is blocked. Use Disable notifications to detach it, or allow notifications in system settings.', true);
            return;
        }
        if (config && !config.available) {
            setPwaStatus(config.reason || 'Push delivery is currently disabled by the administrator.', true);
            return;
        }
        if (config?.available && pushSubscriptionUsesKey(subscription, config.publicKey) === false) {
            showPushControlState(false);
            setPwaStatus('Notification security keys changed. Tap Enable notifications to reconnect this device.', true);
            return;
        }
        setPwaStatus('Notifications are enabled for this device.');
        return;
    }
    if (status.subscribed && !status.belongsToCurrentUser) {
        showPushControlState(false);
        setPwaStatus('This browser has notifications attached to another dashboard user. Tap Enable notifications to attach this device to this account.');
        return;
    }
    showPushControlState(false);
    showPushEducationOnce();
}

async function enablePushNotifications() {
    if (pushEnableInProgress) return;
    if (DASHBOARD_AUTH?.mode !== 'user') {
        setPwaStatus('Log in with a named account to enable notifications.', true);
        return;
    }
    if (isIOSLike() && !isStandalonePwa()) {
        setPwaStatus('On iPhone or iPad, add Zenseeo to the Home Screen first, then open it from there to enable notifications.', true);
        return;
    }
    if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) {
        setPwaStatus('This browser does not support web push notifications.', true);
        return;
    }
    const config = cachedPushConfig;
    if (!config) {
        setPwaStatus('Notification setup is still loading. Reopen More in a moment.', true);
        loadPushConfig(true)
            .then(loaded => setPwaStatus(
                loaded?.available && loaded?.publicKey
                    ? 'Notifications are ready.'
                    : loaded?.reason || 'Push notifications are not available.',
                !loaded?.available
            ))
            .catch(err => setPwaStatus(err.message || 'Push notifications are not available.', true));
        return;
    }
    if (!config.available || !config.publicKey) {
        setPwaStatus(config.reason || 'Push notifications are not available.', true);
        return;
    }
    try {
        setPushControlsBusy(true);
        setPwaStatus('Requesting notification permission…');
        // Start worker readiness without awaiting it, then invoke permission in
        // the original click task so iOS retains the required user activation.
        const registrationResult = readyServiceWorkerRegistration()
            .then(registration => ({ registration, error: null }))
            .catch(error => ({ registration: null, error }));
        const permission = await requestNotificationPermissionFromGesture();
        if (permission !== 'granted') {
            setPwaStatus('Notification permission is blocked. Change it in browser or site settings to enable alerts.', true);
            return;
        }
        setPwaStatus('Permission allowed. Finishing notification setup…');
        const ready = await registrationResult;
        if (!ready.registration) throw ready.error;
        const registration = ready.registration;
        const subscribeOptions = {
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(config.publicKey)
        };
        let replacedEndpoint = null;
        let subscription;
        try {
            subscription = await registration.pushManager.subscribe(subscribeOptions);
        } catch (err) {
            // Browsers reject subscribe() when an existing subscription uses an old
            // VAPID key. Replace it only after the explicit enable action.
            if (err?.name !== 'InvalidStateError') throw err;
            const existing = await registration.pushManager.getSubscription();
            if (!existing) throw err;
            replacedEndpoint = existing.endpoint;
            const unsubscribed = await existing.unsubscribe();
            if (!unsubscribed) throw err;
            subscription = await registration.pushManager.subscribe(subscribeOptions);
        }
        const payload = subscription.toJSON();
        const res = await dashboardFetch(`${API_BASE_GLOBAL}/api/push/subscriptions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            cachedPushConfig = null;
            throw new Error(data.error || 'Could not enable notifications.');
        }
        if (replacedEndpoint && replacedEndpoint !== subscription.endpoint) {
            dashboardFetch(`${API_BASE_GLOBAL}/api/push/subscriptions`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: replacedEndpoint })
            }).catch(() => undefined);
        }
        showPushControlState(true);
        setPwaStatus('Notifications are enabled for this device.');
        await reconcilePushSubscription({ quiet: true }).catch(() => undefined);
    } finally {
        setPushControlsBusy(false);
    }
}

async function disablePushNotifications({ bestEffort = false } = {}) {
    if (isSessionOffline() && !bestEffort) {
        setPwaStatus('Reconnect to change notification settings.', true);
        return false;
    }
    const subscription = await currentPushSubscription();
    if (!subscription) {
        setPwaStatus('Notifications are not enabled on this device.');
        return true;
    }
    const endpoint = subscription.endpoint;
    try {
        const response = await dashboardFetch(`${API_BASE_GLOBAL}/api/push/subscriptions`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Could not disable notifications.');
    } catch (err) {
        if (!bestEffort) throw err;
    }
    await subscription.unsubscribe().catch(() => undefined);
    showPushControlState(false);
    setPwaStatus('Notifications are disabled for this device.');
    await reconcilePushSubscription({ quiet: true }).catch(() => undefined);
    return true;
}

let offlineLeadSyncInProgress = false;
async function syncOfflineLeadChanges() {
    if (offlineLeadSyncInProgress || !window.ZenseeoOffline) return { synced: 0, conflicts: 0 };
    offlineLeadSyncInProgress = true;
    try {
        const result = await window.ZenseeoOffline.syncLeadQueue(API_BASE_GLOBAL);
        if (result.synced > 0 && dashboardData && !DASHBOARD_AUTH?.offline) {
            await loadDashboardForCurrentFilters('Refreshing synced lead changes...');
            window.ZenseeoOffline.warmDashboard(API_BASE_GLOBAL, dashboardQueryString).catch(() => undefined);
        }
        const [conflict] = await window.ZenseeoOffline.conflicts();
        if (conflict) showLeadStatusConflict(conflict.sessionKey, conflict.offlineStatus, conflict);
        return result;
    } finally {
        offlineLeadSyncInProgress = false;
    }
}

let reconnectRefreshInProgress = false;
async function revalidateAfterConnectivityChange() {
    if (reconnectRefreshInProgress) return;
    reconnectRefreshInProgress = true;
    const wasOffline = DASHBOARD_AUTH?.offline === true;
    try {
        const auth = await bootstrapDashboardSession(API_BASE_GLOBAL);
        if (!auth || auth.offline) return;
        const syncResult = await syncOfflineLeadChanges();
        if (wasOffline && dashboardData && syncResult.synced === 0) {
            await loadDashboardForCurrentFilters('Refreshing online data...');
        }
        reconcilePushSubscription({ quiet: true }).catch(() => undefined);
    } finally {
        reconnectRefreshInProgress = false;
    }
}

function showOfflineSignedOut() {
    document.body.className = '';
    document.body.innerHTML = `
        <main style="min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg-base);color:var(--text-primary)">
            <section style="width:min(440px,100%);padding:32px;border:1px solid var(--border-light);border-radius:16px;background:var(--bg-surface);text-align:center">
                <img src="/icons/icon-192.png" alt="" style="width:72px;height:72px">
                <h1 style="margin:18px 0 8px">Signed out on this device</h1>
                <p style="color:var(--text-secondary);line-height:1.55">Private offline data was removed. Reconnect to finish signing out on the server and log in again.</p>
                <button type="button" class="btn btn-primary" onclick="window.location.replace('/login')">Retry online</button>
            </section>
        </main>`;
    window.addEventListener('online', () => window.location.replace('/login'), { once: true });
}

function bindMobileDatePickerLifecycle(pickerElement) {
    if (!pickerElement?.length || pickerElement.data('mobile-picker-lifecycle-bound')) return;
    pickerElement.data('mobile-picker-lifecycle-bound', true);
    pickerElement
        .on('show.daterangepicker', (_event, picker) => {
            picker?.container?.addClass('mobile-date-picker-open');
            document.body.classList.add('date-picker-open');
        })
        .on('hide.daterangepicker', (_event, picker) => {
            picker?.container?.removeClass('mobile-date-picker-open');
            if (!document.querySelector('.daterangepicker.mobile-date-picker-open')) {
                document.body.classList.remove('date-picker-open');
            }
        });
}

function setupPwaControls() {
    const installBtn = document.getElementById('installAppBtn');
    const pageReloadBtn = document.getElementById('pageReloadBtn');
    if (isStandalonePwa() && installBtn) {
        installBtn.hidden = true;
        installBtn.setAttribute('hidden', 'hidden');
    }
    if (pageReloadBtn) {
        pageReloadBtn.hidden = false;
        pageReloadBtn.removeAttribute('hidden');
    }
    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        pendingInstallPrompt = event;
        setPwaStatus('Zenseeo can be installed on this device.');
    });
    window.addEventListener('zenseeo-offline-fallback', (event) => {
        const cachedAt = event.detail?.cachedAt ? formatDateTime(event.detail.cachedAt) : 'earlier';
        updateOfflineBanner(`Offline mode · showing data saved ${cachedAt}`, true);
    });
    window.addEventListener('zenseeo-offline-status', (event) => {
        if (event.detail?.message) setPwaStatus(event.detail.message);
    });
    window.addEventListener('online', () => {
        revalidateAfterConnectivityChange().catch(() => undefined);
    });
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            revalidateAfterConnectivityChange().catch(() => undefined);
        }
    });
    window.addEventListener('focus', () => {
        revalidateAfterConnectivityChange().catch(() => undefined);
    });
    document.getElementById('offlineRetryBtn')?.addEventListener('click', () => window.location.reload());
    pageReloadBtn?.addEventListener('click', () => {
        markTodayRefreshAfterReload();
        setHeaderRefreshBusy(pageReloadBtn, true, 'Reloading Zenseeo and refreshing today\'s data…');
        window.location.reload();
    });
    document.getElementById('applyUpdateBtn')?.addEventListener('click', event => {
        const button = event.currentTarget;
        if (!waitingServiceWorker) return;
        serviceWorkerUpdateAccepted = true;
        button.disabled = true;
        button.textContent = 'Updating…';
        waitingServiceWorker.postMessage({ type: 'SKIP_WAITING' });
    });
    document.getElementById('installAppBtn')?.addEventListener('click', async () => {
        if (isStandalonePwa()) {
            setPwaStatus('Zenseeo is already installed.');
            return;
        }
        if (pendingInstallPrompt) {
            pendingInstallPrompt.prompt();
            await pendingInstallPrompt.userChoice.catch(() => undefined);
            pendingInstallPrompt = null;
            return;
        }
        if (isIOSLike()) {
            setPwaStatus('On iPhone or iPad, open Safari Share and choose Add to Home Screen.');
            return;
        }
        setPwaStatus('Use your browser menu to install this app when available.');
    });
    document.getElementById('enablePushBtn')?.addEventListener('click', () => {
        enablePushNotifications().catch(err => {
            console.error(err);
            setPwaStatus(err.message || 'Could not enable notifications.', true);
        });
    });
    document.getElementById('disablePushBtn')?.addEventListener('click', () => {
        disablePushNotifications().catch(err => {
            console.error(err);
            setPwaStatus(err.message || 'Could not disable notifications.', true);
        });
    });
    document.getElementById('clearOfflineBtn')?.addEventListener('click', async () => {
        try {
            await window.ZenseeoOffline?.clearCurrentUser?.();
            setPwaStatus('Offline data cleared for this device.');
        } catch (err) {
            setPwaStatus(err.message || 'Could not clear offline data.', true);
        }
    });
    document.querySelectorAll('.logout-form').forEach(form => {
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (navigator.onLine === false) {
                await window.ZenseeoOffline?.markOfflineLogout?.().catch(() => undefined);
                await currentPushSubscription(2_000).then(sub => sub?.unsubscribe()).catch(() => undefined);
                showOfflineSignedOut();
                return;
            }
            await promiseWithTimeout(
                disablePushNotifications({ bestEffort: true }),
                2_000,
                'Push detachment timed out.'
            ).catch(() => undefined);
            try {
                const res = await dashboardFetch('/auth/logout', { method: 'POST' });
                if (!res.ok && res.status !== 401) throw new Error(`Logout failed with ${res.status}`);
                await window.ZenseeoOffline?.clearCurrentUser?.();
                if (res.status === 401) {
                    window.location.assign('/login');
                    return;
                }
                const html = await res.text();
                document.open();
                document.write(html);
                document.close();
            } catch {
                await window.ZenseeoOffline?.markOfflineLogout?.().catch(() => undefined);
                await currentPushSubscription(2_000).then(sub => sub?.unsubscribe()).catch(() => undefined);
                showOfflineSignedOut();
            }
        });
    });
}

function setupMobileNavigation() {
    const sheet = document.getElementById('moreSheet');
    const backdrop = document.getElementById('moreSheetBackdrop');
    const moreButton = document.querySelector('.mobile-bottom-item[data-mobile-tab="more"]');
    let returnFocus = null;
    const close = () => {
        if (sheet) sheet.hidden = true;
        if (backdrop) backdrop.hidden = true;
        moreButton?.setAttribute('aria-expanded', 'false');
        const target = returnFocus;
        returnFocus = null;
        target?.focus?.();
    };
    const open = () => {
        populateMoreSheetNav();
        reconcilePushSubscription({ quiet: false }).catch(error => {
            setPwaStatus(error.message || 'Could not verify notification status.', true);
        });
        returnFocus = document.activeElement;
        if (sheet) sheet.hidden = false;
        if (backdrop) backdrop.hidden = false;
        moreButton?.setAttribute('aria-expanded', 'true');
        requestAnimationFrame(() => document.getElementById('closeMoreSheetBtn')?.focus());
    };
    document.getElementById('closeMoreSheetBtn')?.addEventListener('click', close);
    backdrop?.addEventListener('click', close);
    sheet?.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            close();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = Array.from(sheet.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
            .filter(element => !element.hidden && element.getClientRects().length > 0);
        if (!focusable.length) {
            event.preventDefault();
            sheet.focus();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });
    moreButton?.setAttribute('aria-haspopup', 'dialog');
    moreButton?.setAttribute('aria-expanded', 'false');
    document.querySelectorAll('.mobile-bottom-item').forEach(button => {
        button.addEventListener('click', () => {
            const target = button.dataset.mobileTab;
            if (target === 'more') {
                open();
                return;
            }
            const tab = target === 'leads' ? 'attribution' : target;
            document.querySelector(`.nav-item[data-tab="${tab}"]`)?.click();
            if (target === 'leads') activateAttributionSubtab('review', false);
            close();
        });
    });
}

function syncMobileNavActive(tabId) {
    document.querySelectorAll('.mobile-bottom-item').forEach(button => {
        const target = button.dataset.mobileTab;
        const active = target === tabId || (target === 'leads' && tabId === 'attribution');
        button.classList.toggle('active', active);
    });
}

function populateMoreSheetNav() {
    const container = document.getElementById('moreNavItems');
    if (!container || container.hasAttribute('data-populated')) return;
    const primary = new Set(['overview', 'campaigns', 'attribution', 'proposals']);
    els.tabs.forEach(tab => {
        const tabId = tab.dataset.tab;
        if (!tabId || primary.has(tabId)) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'more-nav-item';
        button.textContent = tab.querySelector('span')?.textContent || tabId;
        button.addEventListener('click', () => {
            tab.click();
            document.getElementById('closeMoreSheetBtn')?.click();
        });
        container.appendChild(button);
    });
    container.setAttribute('data-populated', 'true');
}

async function fetchDashboardDateRangeBounds(apiBase) {
    try {
        const res = await dashboardFetch(`${apiBase}/api/dashboard/filters`);
        if (!res.ok) return {};
        const options = await res.json();
        return {
            accountStartDate: isIsoDateKey(options.accountStartDate) ? options.accountStartDate : '',
            minDate: isIsoDateKey(options.minDate) ? options.minDate : '',
            maxDate: isIsoDateKey(options.maxDate) ? options.maxDate : ''
        };
    } catch (err) {
        console.warn('Failed to load dashboard date bounds:', err);
        return {};
    }
}

function selectedDashboardFilters(overrides = {}) {
    const campaignId = overrides.campaignId !== undefined
        ? overrides.campaignId
        : document.getElementById('globalCampaignFilter')?.value || localStorage.getItem('globalCampaignId') || 'All';
    const adGroupId = overrides.adGroupId !== undefined
        ? overrides.adGroupId
        : document.getElementById('globalAdGroupFilter')?.value || localStorage.getItem('globalAdGroupId') || 'All';
    return {
        startDate: overrides.startDate || localStorage.getItem('globalStartDate') || '',
        endDate: overrides.endDate || localStorage.getItem('globalEndDate') || '',
        campaignId: campaignId && campaignId !== 'All' ? campaignId : '',
        adGroupId: adGroupId && adGroupId !== 'All' ? adGroupId : ''
    };
}

function dashboardQueryString(filters = {}) {
    const params = new URLSearchParams();
    const selected = selectedDashboardFilters(filters);
    if (selected.startDate) params.set('startDate', selected.startDate);
    if (selected.endDate) params.set('endDate', selected.endDate);
    if (selected.campaignId) params.set('campaignId', selected.campaignId);
    if (selected.adGroupId) params.set('adGroupId', selected.adGroupId);
    if (filters.view) params.set('view', filters.view);
    const query = params.toString();
    return query ? `?${query}` : '';
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
    toast: document.getElementById('toast'),
    dateRange: document.getElementById('dateRangeText'),
    accountId: document.getElementById('accountIdText'),
    lastUpdated: document.getElementById('lastUpdated'),
    refreshBtn: document.getElementById('refreshBtn'),
    filterBtns: document.querySelectorAll('.filter-btn'),
    activityHistoryReloadBtn: document.getElementById('activityHistoryReloadBtn'),
    controlsKeywords: document.getElementById('grid-controlsKeywords'),
    controlsNegatives: document.getElementById('grid-controlsNegatives'),
    controlsSchedules: document.getElementById('grid-controlsSchedules'),
    controlsMutationHistory: document.getElementById('grid-controlsMutationHistory'),
};

// Initialization
async function init() {
    const refreshTodayOnClientReload = shouldRefreshTodayAfterClientReload();
    const isFileMode = window.location.protocol === 'file:';
    const envApiBase = window.ENV && typeof window.ENV.API_BASE === 'string' ? window.ENV.API_BASE : null;
    const envApiKey = window.ENV && typeof window.ENV.API_KEY === 'string' ? window.ENV.API_KEY : null;
    const envHfToken = window.ENV && typeof window.ENV.HF_TOKEN === 'string' ? window.ENV.HF_TOKEN : null;
    // Hosted pages default to cookie auth unless an explicit local/loopback client
    // config supplies both API_BASE and API_KEY. Never revive a stale browser-stored
    // API key when the safe hosted config is empty or unavailable.
    const explicitHttpClientMode = !isFileMode && Boolean(envApiBase && envApiKey);
    const hostedCookieMode = !isFileMode && !explicitHttpClientMode;
    let API_BASE = hostedCookieMode ? '' : (envApiBase || localStorage.getItem('API_BASE') || '');
    let API_KEY = hostedCookieMode ? '' : (envApiKey || localStorage.getItem('API_KEY') || '');
    let HF_TOKEN = hostedCookieMode ? '' : (envHfToken || localStorage.getItem('HF_TOKEN') || '');

    if (isFileMode && (!API_BASE || !API_KEY)) {
        API_BASE = prompt('Enter the backend API Base URL (e.g. https://my-app.example.com or http://localhost:7860):', API_BASE || 'http://localhost:7860');
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
            finishAppBootstrap();
            return;
        }
    }
    API_BASE_GLOBAL = API_BASE;
    API_KEY_GLOBAL = API_KEY;
    HF_TOKEN_GLOBAL = HF_TOKEN;
    installWebManifest();
    // Service-worker startup is deliberately non-blocking. Some browsers can
    // leave register() pending while updating an existing PWA; session bootstrap
    // and the online/offline decision must still complete independently.
    void registerServiceWorker();
    setupPwaControls();
    document.body.classList.toggle('session-auth-mode', !API_KEY_GLOBAL);
    const bootstrappedAuth = await bootstrapDashboardSession(API_BASE);
    if (!bootstrappedAuth) return;
    const clientReloadRefreshPromise = refreshTodayOnClientReload && !DASHBOARD_AUTH?.offline
        ? requestTodayDataRefresh(API_BASE, { force: true })
            .then(result => ({ result, error: null }))
            .catch(error => ({ result: null, error }))
        : null;

    // 1. Bind static UI elements immediately so they work even if DB is empty
    setupKeywordDiscoveryTabs();
    setupAttributionTabs();
    setupLeadReviewViewControls();
    setupRankTabs();
    setupKeywordVisibilityControls();
    setupNav();
    setupMobileNavigation();
    setupSidebar();
    setupControls();
    setupOverviewWidgets();
    setupAudienceResponsiveLayout();
    finishAppBootstrap();
    reconcilePushSubscription({ quiet: true }).catch(() => undefined);

    // Initialize date picker
    const dateBounds = await fetchDashboardDateRangeBounds(API_BASE);
    const today = localIsoDateKey();
    const configuredStartDate = dateBounds.accountStartDate || dateBounds.minDate || '';
    const warehouseStartDate = configuredStartDate && configuredStartDate <= today ? configuredStartDate : '';
    const thirtyDaysAgo = localIsoDateKey(new Date(Date.now() - 30 * 86400000));
    let endD = clampDateKey(localStorage.getItem('globalEndDate'), warehouseStartDate, today) || today;
    let startD = clampDateKey(localStorage.getItem('globalStartDate'), warehouseStartDate, endD)
        || clampDateKey(thirtyDaysAgo, warehouseStartDate, endD)
        || warehouseStartDate
        || endD;
    if (warehouseStartDate) {
        localStorage.setItem('globalStartDate', startD);
        localStorage.setItem('globalEndDate', endD);
    }

    if ($('#dateRangePicker').length) {
        function cb(start, end) {
            $('#dateRangePicker span').html(start.format('YYYY-MM-DD') + ' to ' + end.format('YYYY-MM-DD'));
        }
        const minDate = warehouseStartDate ? moment(warehouseStartDate, 'YYYY-MM-DD') : false;
        const maxDate = moment(today, 'YYYY-MM-DD');

        $('#dateRangePicker').daterangepicker({
            startDate: moment(startD),
            endDate: moment(endD),
            minDate,
            maxDate,
            ranges: {
                ...(warehouseStartDate ? { 'All Time': [moment(warehouseStartDate, 'YYYY-MM-DD'), maxDate.clone()] } : {}),
                'Today': [maxDate.clone(), maxDate.clone()],
                'Yesterday': [maxDate.clone().subtract(1, 'days'), maxDate.clone().subtract(1, 'days')],
                'Last 7 Completed Days': [maxDate.clone().subtract(7, 'days'), maxDate.clone().subtract(1, 'days')],
                'Last 30 Days': [maxDate.clone().subtract(29, 'days'), maxDate.clone()],
                'This Month': [maxDate.clone().startOf('month'), maxDate.clone().endOf('month')],
                'Last Month': [maxDate.clone().subtract(1, 'month').startOf('month'), maxDate.clone().subtract(1, 'month').endOf('month')]
            },
            locale: { format: 'YYYY-MM-DD' }
        }, cb);

        cb(moment(startD), moment(endD));
        if (els.dateRangePicker) {
            const pickerElement = $(els.dateRangePicker);
            bindMobileDatePickerLifecycle(pickerElement);
            pickerElement
                .on('apply.daterangepicker', function (ev, picker) {
                    const s = picker.startDate.format('YYYY-MM-DD');
                    const e = picker.endDate.format('YYYY-MM-DD');
                    localStorage.setItem('globalStartDate', s);
                    localStorage.setItem('globalEndDate', e);
                    loadDashboardForCurrentFilters('Loading selected date range...')
                        .then(() => showToast('Dashboard range loaded.', false))
                        .catch(err => {
                            console.error(err);
                            showToast(`Dashboard load failed: ${err.message}`, true);
                        });
                });
        }
    }

    function pollForRefreshCompletion(apiBase, refreshResult, button = null, { todayOnly = false, automatic = false } = {}) {
        if (dashboardRefreshPollTimer) clearInterval(dashboardRefreshPollTimer);
        const runId = refreshResult?.runId ? String(refreshResult.runId) : '';
        const refreshLabel = todayOnly ? 'Today\'s refresh' : 'Full data refresh';
        let attempts = 0;
        const maxAttempts = 60; // 5 mins total at 5s interval
        const pollInterval = setInterval(async () => {
            attempts++;
            if (attempts > maxAttempts) {
                clearInterval(pollInterval);
                if (dashboardRefreshPollTimer === pollInterval) dashboardRefreshPollTimer = null;
                if (!automatic) showToast(`${refreshLabel} is still running. Check again shortly.`, true);
                setHeaderRefreshBusy(button, false);
                return;
            }
            try {
                const res = await dashboardFetch(`${apiBase}/api/dashboard${dashboardQueryString({ view: 'overview' })}`);
                if (res.ok) {
                    const data = await res.json();
                    const refreshRun = data?.sourceCoverage?.refreshRun;
                    if (runId && String(refreshRun?.id || '') !== runId) return;
                    const status = String(refreshRun?.status || '').toLowerCase();
                    if (!['succeeded', 'partial', 'failed'].includes(status)) return;

                    clearInterval(pollInterval);
                    if (dashboardRefreshPollTimer === pollInterval) dashboardRefreshPollTimer = null;
                    setHeaderRefreshBusy(button, false);
                    if (status === 'failed') {
                        if (automatic) {
                            console.warn(`${refreshLabel} failed: ${refreshRun?.error || 'unknown error'}`);
                        } else {
                            showToast(`${refreshLabel} failed: ${refreshRun?.error || 'unknown error'}`, true);
                        }
                        return;
                    }

                    beginDashboardLoad('overview');
                    dashboardData = data;
                    window.fullData = data;
                    populateGlobalFilters();
                    renderSidebar();
                    renderDashboardPayload();
                    setupComparisonControls();
                    if (!automatic) {
                        showToast(todayOnly
                            ? (status === 'partial'
                                ? 'Today\'s data refreshed with some source warnings.'
                                : 'Today\'s data refreshed successfully.')
                            : (status === 'partial'
                                ? 'Full data refreshed with some source warnings.'
                                : 'Full data refreshed successfully.'), status === 'partial');
                    }
                }
            } catch (e) {
                // Ignore network errors during polling
            }
        }, 5000);
        dashboardRefreshPollTimer = pollInterval;
    }

    function handleAcceptedRefresh(data, { button = null, automatic = false, todayOnly = false } = {}) {
        const refreshLabel = todayOnly ? 'Today\'s refresh' : 'Full data refresh';
        if (data?.status === 'skipped') {
            setHeaderRefreshBusy(button, false);
            if (!automatic) showToast(`${refreshLabel} was run recently.`, false);
            return;
        }
        if (!automatic) {
            showToast(data?.status === 'in_progress'
                ? `${refreshLabel} is already in progress…`
                : todayOnly ? 'Refreshing today\'s data…' : 'Refreshing full historical data…', false);
        }
        pollForRefreshCompletion(API_BASE, data, button, { todayOnly, automatic });
    }

    if (els.refreshBtn) {
        els.refreshBtn.addEventListener('click', () => {
            setHeaderRefreshBusy(els.refreshBtn, true, 'Refreshing full historical data…');
            showToast('Triggering full historical data refresh…', false);
            requestFullDataRefresh(API_BASE)
                .then(data => handleAcceptedRefresh(data, { button: els.refreshBtn }))
                .catch(err => {
                    console.error(err);
                    showToast(`Refresh failed: ${err.message}`, true);
                    setHeaderRefreshBusy(els.refreshBtn, false);
                });
        });
    }

    // 2. Now attempt to load data from the database
    try {
        const generation = beginDashboardLoad();
        const res = await dashboardFetch(`${API_BASE}/api/dashboard${dashboardQueryString({ startDate: startD, endDate: endD, view: 'overview' })}`);
        if (res.status === 401 || res.status === 403) {
            if (API_KEY_GLOBAL) localStorage.removeItem('API_KEY');
            throw new Error(API_KEY_GLOBAL ? 'Invalid API Key. Please refresh to try again.' : 'Dashboard access expired. Open a new magic link.');
        }
        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || errData.message || `Server not responding ${res.status}`);
        }
        const initialDashboard = await res.json();
        if (generation !== dashboardLoadGeneration) return;
        dashboardData = initialDashboard;
        window.fullData = dashboardData;
        resetLoadedDashboardViews('overview');

        initTheme();
        renderSidebar();
        populateGlobalFilters();
        renderDashboardPayload();
        await handleLeadDeepLink();
        setupFilters();
        makeTablesResponsiveAndSortable();
        setupComparisonControls();
        setupLeadExportControls();
        setupKeywordPlannerControls();
        loadAuctionSheetSettings();
        if (DASHBOARD_AUTH?.mode === 'user' && !DASHBOARD_AUTH.offline) {
            window.ZenseeoOffline?.warmDashboard?.(API_BASE, dashboardQueryString).catch(err => console.warn('Offline warm failed:', err));
            syncOfflineLeadChanges().catch(() => undefined);
        }
        setupOverviewTimeSeriesControls();
        const dhmSelect = document.getElementById('dayHourMetricSelect');
        if (dhmSelect) dhmSelect.addEventListener('change', () => renderTimePerformance());
        startCronRefreshCompletionWatcher();
        if (clientReloadRefreshPromise) {
            const { result, error } = await clientReloadRefreshPromise;
            if (error) {
                console.error('Client reload could not trigger today\'s refresh:', error);
            } else {
                handleAcceptedRefresh(result, { automatic: true, todayOnly: true });
            }
        }
    } catch (err) {
        console.error('Failed to load dashboard data:', err);
        els.kpiGrid.innerHTML = `<p style="color:var(--danger)">Error loading data: ${esc(err.message || String(err))}</p>`;
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
    if (controlsState && ['active', 'negatives'].includes(next)) renderControlsState();
    setTimeout(() => {
        Object.values(charts).forEach(chart => {
            if (chart && typeof chart.resize === 'function') chart.resize();
        });
        Object.entries(gridInstances).forEach(([id, api]) => {
            if (!api || typeof api.sizeColumnsToFit !== 'function') return;
            const element = document.getElementById(id);
            if (element && element.offsetWidth > 0 && element.offsetHeight > 0) {
                api.sizeColumnsToFit();
            }
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
    if (hash === 'attr-auth') return 'auth';
    return 'review';
}

function attributionSubtabHash(subtab) {
    if (subtab === 'quality') return 'attr-quality';
    if (subtab === 'journeys') return 'attr-journeys';
    if (subtab === 'gads') return 'attr-gads';
    if (subtab === 'auth') return 'attr-auth';
    return 'attribution';
}

function activateAttributionSubtab(subtab, updateHash = true) {
    const next = ['review', 'quality', 'journeys', 'gads', 'auth'].includes(subtab) ? subtab : 'review';
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
        } else if (next === 'auth') {
            loadOfflineConversionsAuthSettings();
        } else if (next === 'journeys') {
            if (dashboardData.leadAttribution) {
                const leadAttribution = dashboardData.leadAttribution || {};
                const leadTotals = leadAttribution.totals || { uniqueLeads: 0, eventCount: 0, new: 0, useless: 0, maybe: 0, qualified: 0, qualifiedLost: 0, converted: 0, inProgress: 0, terminal: 0, qualifiedPipeline: 0 };
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
        renderClickPathsGrid();
        modal.classList.add('show');
        setTimeout(() => {
            const api = gridInstances['grid-clickPaths'];
            if (api && typeof api.sizeColumnsToFit === 'function') {
                api.sizeColumnsToFit();
            }
        }, 150);
    }
};

function renderClickPathsGrid() {
    const clicks = dashboardData?.clickPaths || [];
    initGrid('grid-clickPaths', clicks, [
        { field: 'date', headerName: 'Date' },
        { field: 'campaign', headerName: 'Campaign' },
        { field: 'adGroup', headerName: 'Ad Group' },
        { field: 'keyword', headerName: 'Keyword', pinned: 'left' },
        { field: 'matchType', headerName: 'Match Type' },
        { field: 'slot', headerName: 'Slot' },
        { field: 'device', headerName: 'Device' },
        { field: 'clicks', headerName: 'Clicks', filter: 'agNumberColumnFilter' }
    ]);
}

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
            const auctionInsights = dashboardData.auctionInsights || {};
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
            if (['campaigns', 'ad-groups', 'keywords', 'ad-schedule', 'activity-history'].includes(tabId)) void loadControlsState();
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
            syncMobileNavActive(tabId);

            // Close mobile sidebar
            if (window.innerWidth <= 768) {
                document.querySelector('.sidebar').classList.remove('open');
            }

            if (window.fullData) {
                void ensureDashboardViewForTab(tabId).catch(err => {
                    handleDashboardSectionLoadError(tabId, err, { userInitiated: true });
                });
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
    const searchParams = new URLSearchParams(window.location.search);
    const requestedQueryTab = searchParams.get('tab') || '';
    const requestedHash = window.location.hash.replace('#', '') || requestedQueryTab || 'overview';
    const initialKeywordSubtab = keywordSubtabFromHash(requestedHash);
    const initialAttributionSubtab = attributionSubtabFromHash(requestedHash);
    const initialRankSubtab = rankSubtabFromHash(requestedHash);

    let initialTab = requestedHash;
    if (['keyword-negatives', 'search-terms', 'keyword-planner', 'keyword-insights'].includes(requestedHash)) {
        initialTab = 'keywords';
    } else if (['attr-quality', 'attr-journeys', 'attr-gads', 'attr-auth'].includes(requestedHash)) {
        initialTab = 'attribution';
    } else if (['rank-competitors', 'rank-auction', 'rank-landing'].includes(requestedHash)) {
        initialTab = 'rank';
    }

    const tabBtn = document.querySelector(`.nav-item[data-tab="${initialTab}"]`);
    if (tabBtn) tabBtn.click();
    if (initialTab === 'keywords') activateKeywordSubtab(initialKeywordSubtab);
    if (initialTab === 'attribution') activateAttributionSubtab(initialAttributionSubtab);
    if (initialTab === 'rank') activateRankSubtab(initialRankSubtab);
    syncMobileNavActive(initialTab);
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

function activeDashboardTab() {
    return document.querySelector('.nav-item.active')?.dataset?.tab || 'overview';
}

function dashboardViewForTab(tabId = activeDashboardTab()) {
    return Object.prototype.hasOwnProperty.call(TAB_DASHBOARD_VIEWS, tabId) ? TAB_DASHBOARD_VIEWS[tabId] : 'overview';
}

function resetLoadedDashboardViews(initialView = 'overview') {
    loadedDashboardViews.clear();
    dashboardViewPromises.clear();
    if (initialView) loadedDashboardViews.add(initialView);
}

function beginDashboardLoad(initialView = '') {
    dashboardLoadGeneration += 1;
    resetLoadedDashboardViews(initialView);
    resetOverviewWidgetRequests();
    return dashboardLoadGeneration;
}

function mergeDashboardPayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    dashboardData = {
        ...(dashboardData || {}),
        ...payload,
        meta: {
            ...(dashboardData?.meta || {}),
            ...(payload.meta || {})
        }
    };
    window.fullData = dashboardData;
}

async function fetchDashboardView(view) {
    const res = await dashboardFetch(`${API_BASE_GLOBAL}/api/dashboard${dashboardQueryString({ view })}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || `Dashboard ${view} load failed with ${res.status}`);
    return data;
}

async function ensureDashboardViewForTab(tabId = activeDashboardTab(), options = {}) {
    const view = dashboardViewForTab(tabId);
    if (!view || loadedDashboardViews.has(view)) {
        if (options.render) renderActiveDashboardTab(tabId);
        return dashboardData;
    }
    const generation = dashboardLoadGeneration;
    if (!dashboardViewPromises.has(view)) {
        dashboardViewPromises.set(view, fetchDashboardView(view)
            .then(data => {
                if (generation !== dashboardLoadGeneration) return data;
                mergeDashboardPayload(data);
                loadedDashboardViews.add(view);
                return data;
            })
            .finally(() => dashboardViewPromises.delete(view)));
    }
    const data = await dashboardViewPromises.get(view);
    if (generation === dashboardLoadGeneration && options.render !== false) renderActiveDashboardTab(tabId);
    return data;
}

function handleDashboardSectionLoadError(tabId, error, { userInitiated = false } = {}) {
    const detail = String(error?.message || error || 'Unknown error');
    console.error(`Dashboard ${tabId || 'section'} failed to load:`, error);
    if (tabId === 'audiences') {
        const segmentState = document.getElementById('audienceSegmentsState');
        const demographicState = document.getElementById('audienceDemographicsState');
        if (segmentState) {
            segmentState.hidden = false;
            segmentState.textContent = `Audience data could not be loaded. ${detail}`;
        }
        if (demographicState) {
            demographicState.hidden = false;
            demographicState.textContent = `Demographic data could not be loaded. ${detail}`;
        }
    }
    // Initial lazy loads run during every reload. Their error belongs in the
    // affected section, not in a persistent global toast. A deliberate tab
    // switch still gets a short, actionable notification.
    if (userInitiated) showToast(`Could not load ${tabId || 'this section'}: ${detail}`);
}

function renderDashboardPayload() {
    if (!window.fullData) return;
    dashboardData = window.fullData;
    renderGlobalKPIs();
    renderLeadFunnel();
    renderKPIs();
    renderCharts();
    renderInsights();
    renderActiveDashboardTab();
    animateKPIs();
    const range = dashboardData?.meta?.dateRange || {};
    if (els.dateRange && range.start && range.end) els.dateRange.textContent = formatDateRange(`${range.start} - ${range.end}`);
    void ensureDashboardViewForTab(activeDashboardTab()).catch(err => {
        handleDashboardSectionLoadError(activeDashboardTab(), err);
    });
}

function renderActiveDashboardTab(tabId = activeDashboardTab()) {
    if (!dashboardData) return;
    if (tabId === 'overview') {
        void ensureOverviewWidgets().catch(err => console.error('Overview widgets failed to load:', err));
    } else if (tabId === 'campaigns' || tabId === 'ad-groups') {
        renderTables();
        if (dashboardData.campaigns) renderCampaignBubbleChart();
    } else if (tabId === 'keywords') {
        renderTables();
        renderKeywordPlannerExplorer();
        renderKeywordDiscoveryContext();
        if (dashboardData.keywords) renderKeywordScatterChart();
        if (dashboardData.qualityScores) renderQsDoughnutChart();
    } else if (tabId === 'audiences') {
        renderAudiences();
    } else if (tabId === 'attribution') {
        renderAttribution();
        renderSankeyChart();
    } else if (tabId === 'rank') {
        renderRankDiagnostics();
        renderCompetitorWaste();
        if (dashboardData.devicePerformance) renderDeviceChart();
        renderTimePerformance();
        if (dashboardData.qualityScores) renderQsDoughnutChart();
        if (dashboardData.campaigns) renderImpressionShareChart();
        if (dashboardData.dailyCampaigns && dashboardData.dailyCampaigns.length > 0) renderImpressionShareOverTimeChart();
    } else if (tabId === 'proposals') {
        renderCandidateSignals();
        renderProposals();
    } else if (['campaigns', 'ad-groups', 'keywords', 'ad-schedule', 'activity-history'].includes(tabId)) {
        void loadControlsState();
    }
}

async function loadDashboardForCurrentFilters(message = 'Loading dashboard...') {
    if (message) showToast(message, false);
    const generation = beginDashboardLoad();
    const res = await dashboardFetch(`${API_BASE_GLOBAL}/api/dashboard${dashboardQueryString({ view: 'overview' })}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || `Dashboard load failed with ${res.status}`);
    if (generation !== dashboardLoadGeneration) return data;
    dashboardData = data;
    window.fullData = data;
    resetLoadedDashboardViews('overview');
    populateGlobalFilters();
    renderSidebar();
    renderDashboardPayload();
    setupComparisonControls();
    loadAuctionSheetSettings();
    if (DASHBOARD_AUTH?.mode === 'user' && !DASHBOARD_AUTH.offline) {
        window.ZenseeoOffline?.warmDashboard?.(API_BASE_GLOBAL, dashboardQueryString).catch(err => console.warn('Offline warm failed:', err));
    }
    return data;
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

function csvEscapeCell(value) {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadTextFile(filename, text, type = 'text/csv;charset=utf-8') {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function currentSelectedCampaignFilterValue() {
    return document.getElementById('globalCampaignFilter')?.value || 'All';
}

function currentSelectedAdGroupFilterValue() {
    return document.getElementById('globalAdGroupFilter')?.value || 'All';
}

function currentLeadReviewAttributionForExport() {
    const current = dashboardData?.leadAttribution || {};
    return {
        ...current,
        filteredLeads: Array.isArray(current.recentLeads) ? current.recentLeads : []
    };
}

function currentLeadReviewExportLeads() {
    const attribution = currentLeadReviewAttributionForExport();
    return Array.isArray(attribution.filteredLeads) ? attribution.filteredLeads : [];
}

function leadReviewCsvFilename() {
    const range = dashboardData?.meta?.dateRange || {};
    const start = range.start || 'all';
    const end = range.end || new Date().toISOString().slice(0, 10);
    const campaign = currentSelectedCampaignFilterValue();
    const adGroup = currentSelectedAdGroupFilterValue();
    const scope = [campaign !== 'All' ? campaign : '', adGroup !== 'All' ? adGroup : '']
        .filter(Boolean)
        .join('-')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
    return `lead-review-${start}-to-${end}${scope ? `-${scope}` : ''}.csv`;
}

function updateLeadReviewCsvButton(leads = currentLeadReviewExportLeads()) {
    const btn = document.getElementById('downloadLeadReviewCsvBtn');
    if (!btn) return;
    const count = leads.length;
    const label = btn.querySelector('.lead-export-label');
    const countEl = btn.querySelector('.lead-export-count');
    if (label) label.textContent = count > 0 ? 'Export Lead CSV' : 'No Leads to Export';
    if (countEl) countEl.textContent = fmtNum(count);
    btn.title = count > 0
        ? `Export all ${fmtNum(count)} lead review rows for the current date, campaign, and ad-group filters.`
        : 'No lead review rows match the current date, campaign, and ad-group filters.';
}

function setupLeadExportControls() {
    const offlineBtn = document.getElementById('downloadOfflineConversionsBtn');
    if (offlineBtn && !offlineBtn.hasAttribute('data-bound')) {
        offlineBtn.addEventListener('click', async () => {
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
            offlineBtn.disabled = true;
            const originalText = offlineBtn.textContent;
            offlineBtn.textContent = 'Exporting...';
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
                offlineBtn.disabled = false;
                offlineBtn.textContent = originalText;
            }
        });
        offlineBtn.setAttribute('data-bound', 'true');
    }

    const leadReviewBtn = document.getElementById('downloadLeadReviewCsvBtn');
    if (leadReviewBtn && !leadReviewBtn.hasAttribute('data-bound')) {
        leadReviewBtn.addEventListener('click', async () => {
            const originalHtml = leadReviewBtn.innerHTML;
            leadReviewBtn.disabled = true;
            leadReviewBtn.innerHTML = '<span class="lead-export-label">Exporting...</span>';
            try {
                const params = new URLSearchParams();
                const range = dashboardData?.meta?.dateRange || {};
                if (range.start) params.set('startDate', range.start);
                if (range.end) params.set('endDate', range.end);
                const campaignId = currentSelectedCampaignId();
                if (campaignId) params.set('campaignId', campaignId);
                const adGroupId = document.getElementById('globalAdGroupFilter')?.value || '';
                if (adGroupId && adGroupId !== 'All') params.set('adGroupId', adGroupId);
                const res = await dashboardFetch(`${API_BASE_GLOBAL}/api/leads/review.csv?${params.toString()}`);
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.error || `Lead review export failed with ${res.status}`);
                }
                const rows = Number(res.headers.get('X-Lead-Review-Rows') || '0');
                if (rows === 0) {
                    showToast('No lead review rows match the current date, campaign, and ad-group filters.', true);
                    return;
                }
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = leadReviewCsvFilename();
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
                showToast(`Exported ${fmtNum(rows)} lead review rows.`, false);
            } catch (err) {
                console.error(err);
                showToast(`Lead review export failed: ${err.message}`, true);
            } finally {
                leadReviewBtn.disabled = false;
                leadReviewBtn.innerHTML = originalHtml;
                updateLeadReviewCsvButton(currentLeadReviewExportLeads());
            }
        });
        leadReviewBtn.setAttribute('data-bound', 'true');
    }
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

function updateAuctionSettingsCardVisibility() {
    const card = document.getElementById('auctionSettingsCard');
    const shell = document.getElementById('auctionSettingsShell');
    const label = document.getElementById('editAuctionSettingsLabel');
    if (!card || !shell || !label) return;
    const statuses = Array.isArray(dashboardData?.auctionInsightsStatus)
        ? dashboardData.auctionInsightsStatus
        : [];
    const hasRefreshError = statuses.some(item => String(item?.status || '').toLowerCase() !== 'ok');
    const canCollapse = card.dataset.configurationComplete === 'true'
        && !hasRefreshError
        && !shell.classList.contains('is-editing');
    card.classList.toggle('is-collapsed', canCollapse);
    label.textContent = canCollapse ? 'Settings' : 'Edit Settings';
}

async function loadAuctionSheetSettings() {
    const form = document.getElementById('auctionSheetSettingsForm');
    const statusEl = document.getElementById('auctionSheetSettingsStatus');
    const saveBtn = document.getElementById('saveAuctionSettingsBtn');
    const editBtn = document.getElementById('editAuctionSettingsBtn');
    const cancelBtn = document.getElementById('cancelAuctionSettingsBtn');
    const shell = document.getElementById('auctionSettingsShell');
    const card = document.getElementById('auctionSettingsCard');
    if (!form || !statusEl || !saveBtn || !editBtn || !cancelBtn || !shell || !card) return;

    // Reset editing state UI
    shell.classList.remove('is-editing');
    editBtn.style.display = 'inline-flex';
    saveBtn.style.display = 'none';
    cancelBtn.style.display = 'none';

    try {
        const res = await dashboardFetch(`${API_BASE_GLOBAL}/api/auction-insights/settings`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load settings');
        const settings = new Map((data.settings || []).map(item => [settingKey(item), item]));
        const entities = data.entities || [];
        const allEntitiesConfigured = entities.length > 0 && entities.every(entity => {
            const saved = settings.get(settingKey(entity));
            return saved?.enabled !== false && Boolean(String(saved?.sheetName || '').trim());
        });
        card.dataset.configurationComplete = String(Boolean(data.sheetsRefreshTokenConfigured && allEntitiesConfigured));
        updateAuctionSettingsCardVisibility();
        statusEl.innerHTML = data.sheetsRefreshTokenConfigured
            ? `<div class="settings-note settings-note--ok">Google Sheets refresh token is configured.</div>`
            : `<div class="settings-note settings-note--warn">GOOGLE_SHEETS_REFRESH_TOKEN is missing. Auction Insights will stay empty until it is added.</div>`;

        if (entities.length === 0) {
            form.innerHTML = `<div class="auction-empty compact">No entities found to configure.</div>`;
            card.dataset.configurationComplete = 'false';
            updateAuctionSettingsCardVisibility();
            editBtn.style.display = 'none';
            return;
        }

        let tableHtml = `
            <table class="data-table settings-table">
                <thead>
                    <tr>
                        <th style="width: 140px;">Scope</th>
                        <th>Google Ads Entity</th>
                        <th>Google Sheet Name</th>
                    </tr>
                </thead>
                <tbody>
        `;

        tableHtml += entities.map(entity => {
            const saved = settings.get(settingKey(entity));
            const sheetName = saved?.sheetName || '';
            const badgeClass = entity.entityType === 'account'
                ? 'account'
                : entity.entityType === 'campaign'
                    ? 'campaign'
                    : 'ad-group';
            const label = entity.entityType === 'account'
                ? 'Account'
                : entity.entityType === 'campaign'
                    ? 'Campaign'
                    : 'Ad Group';

            const hasName = entity.entityName && entity.entityName !== entity.entityId;
            const displayName = hasName ? entity.entityName : entity.entityId;
            const displaySub = hasName ? `ID: ${entity.entityId}` : '';

            return `
                <tr>
                    <td>
                        <span class="settings-badge ${esc(badgeClass)}">${esc(label)}</span>
                    </td>
                    <td>
                        <div class="entity-details">
                            <span class="entity-name">${esc(displayName)}</span>
                            ${displaySub ? `<span class="entity-id">${esc(displaySub)}</span>` : ''}
                        </div>
                    </td>
                    <td>
                        <span class="sheet-name-text ${sheetName ? '' : 'empty'}">${esc(sheetName || 'Not Configured')}</span>
                        <input class="styled-select auction-setting-input"
                            data-entity-type="${esc(entity.entityType)}"
                            data-entity-id="${esc(entity.entityId)}"
                            data-entity-name="${esc(entity.entityName || '')}"
                            value="${esc(sheetName)}"
                            placeholder="e.g. Auction Insights ${esc(label)}">
                    </td>
                </tr>
            `;
        }).join('');

        tableHtml += `
                </tbody>
            </table>
        `;
        form.innerHTML = tableHtml;

        // Bind event listeners if not already bound
        if (!editBtn.hasAttribute('data-bound')) {
            editBtn.addEventListener('click', () => {
                shell.classList.add('is-editing');
                updateAuctionSettingsCardVisibility();
                editBtn.style.display = 'none';
                saveBtn.style.display = 'inline-flex';
                cancelBtn.style.display = 'inline-flex';
            });
            editBtn.setAttribute('data-bound', 'true');
        }

        if (!cancelBtn.hasAttribute('data-bound')) {
            cancelBtn.addEventListener('click', () => {
                loadAuctionSheetSettings();
            });
            cancelBtn.setAttribute('data-bound', 'true');
        }

        if (!saveBtn.hasAttribute('data-bound')) {
            saveBtn.addEventListener('click', saveAuctionSheetSettings);
            saveBtn.setAttribute('data-bound', 'true');
        }
    } catch (err) {
        console.error(err);
        card.dataset.configurationComplete = 'false';
        updateAuctionSettingsCardVisibility();
        editBtn.style.display = 'none';
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

        // Reload to switch back to read-only/display mode with updated values
        loadAuctionSheetSettings();
    } catch (err) {
        console.error(err);
        showToast(`Settings save failed: ${err.message}`, true);
    } finally {
        btn.disabled = false;
    }
}

function offlineAuthElements() {
    return {
        shell: document.getElementById('offlineAuthShell'),
        form: document.getElementById('offlineAuthForm'),
        statusEl: document.getElementById('offlineAuthStatus'),
        endpointInput: document.getElementById('offlineAuthEndpoint'),
        usernameInput: document.getElementById('offlineAuthUsername'),
        passwordInput: document.getElementById('offlineAuthPassword'),
        revealBtn: document.getElementById('revealOfflineAuthPasswordBtn'),
        editBtn: document.getElementById('editOfflineAuthBtn'),
        saveBtn: document.getElementById('saveOfflineAuthBtn'),
        cancelBtn: document.getElementById('cancelOfflineAuthBtn')
    };
}

function setOfflineAuthEditing(isEditing) {
    const { shell, usernameInput, passwordInput, revealBtn, editBtn, saveBtn, cancelBtn } = offlineAuthElements();
    if (!shell || !usernameInput || !passwordInput || !revealBtn || !editBtn || !saveBtn || !cancelBtn) return;
    const passwordConfigured = shell.dataset.passwordConfigured === 'true';
    const usernameConfigured = Boolean(usernameInput.value.trim());
    shell.classList.toggle('is-editing', isEditing);
    usernameInput.readOnly = !isEditing;
    passwordInput.readOnly = !isEditing;
    editBtn.style.display = isEditing ? 'none' : 'inline-flex';
    saveBtn.style.display = isEditing ? 'inline-flex' : 'none';
    cancelBtn.style.display = isEditing ? 'inline-flex' : 'none';
    revealBtn.style.display = !isEditing && passwordConfigured ? 'inline-flex' : 'none';
    revealBtn.classList.remove('is-revealed');
    shell.dataset.passwordRevealed = 'false';
    passwordInput.type = 'password';
    if (isEditing) {
        passwordInput.value = '';
        usernameInput.placeholder = 'Set username';
        passwordInput.placeholder = passwordConfigured ? 'Leave blank to keep current password' : 'Set password';
    } else {
        usernameInput.placeholder = usernameConfigured ? '' : 'Not configured';
        passwordInput.value = passwordConfigured ? '••••••••••••' : '';
        passwordInput.placeholder = passwordConfigured ? '' : 'Not configured';
    }
    if (isEditing) {
        setTimeout(() => usernameInput.focus(), 0);
    }
}

function renderOfflineAuthStatus(auth = {}, endpoint = '/api/analytics/offline-conversions.csv') {
    const { statusEl } = offlineAuthElements();
    if (!statusEl) return;
    if (auth.configured) {
        const updated = auth.updatedAt ? ` Updated ${formatDateTime(auth.updatedAt)}.` : '';
        statusEl.innerHTML = `<div class="settings-note settings-note--ok">Basic Auth is configured</strong>.${esc(updated)}</div>`;
    } else {
        statusEl.innerHTML = `<div class="settings-note settings-note--warn">Basic Auth is not configured for <strong>${esc(endpoint)}</strong>.</div>`;
    }
}

function bindOfflineAuthControls() {
    const { form, revealBtn, editBtn, saveBtn, cancelBtn } = offlineAuthElements();
    if (editBtn && !editBtn.hasAttribute('data-bound')) {
        editBtn.addEventListener('click', () => setOfflineAuthEditing(true));
        editBtn.setAttribute('data-bound', 'true');
    }
    if (saveBtn && !saveBtn.hasAttribute('data-bound')) {
        saveBtn.addEventListener('click', saveOfflineConversionsAuthSettings);
        saveBtn.setAttribute('data-bound', 'true');
    }
    if (cancelBtn && !cancelBtn.hasAttribute('data-bound')) {
        cancelBtn.addEventListener('click', loadOfflineConversionsAuthSettings);
        cancelBtn.setAttribute('data-bound', 'true');
    }
    if (form && !form.hasAttribute('data-bound')) {
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            saveOfflineConversionsAuthSettings();
        });
        form.setAttribute('data-bound', 'true');
    }
    if (revealBtn && !revealBtn.hasAttribute('data-bound')) {
        revealBtn.addEventListener('click', toggleOfflineAuthPasswordReveal);
        revealBtn.setAttribute('data-bound', 'true');
    }
}

async function loadOfflineConversionsAuthSettings() {
    const { shell, statusEl, endpointInput, usernameInput, passwordInput } = offlineAuthElements();
    if (!shell || !statusEl || !endpointInput || !usernameInput || !passwordInput) return;
    bindOfflineAuthControls();
    try {
        const res = await dashboardFetch(`${API_BASE_GLOBAL}/api/offline-conversions/auth`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not load offline conversion auth settings');
        const auth = data.auth || {};
        endpointInput.value = data.endpoint || '/api/analytics/offline-conversions.csv';
        usernameInput.value = auth.username || '';
        shell.dataset.passwordConfigured = auth.passwordConfigured ? 'true' : 'false';
        shell.dataset.passwordRevealAvailable = auth.passwordRevealAvailable ? 'true' : 'false';
        shell.dataset.passwordRevealed = 'false';
        renderOfflineAuthStatus(auth, endpointInput.value);
        setOfflineAuthEditing(false);
    } catch (err) {
        console.error(err);
        statusEl.innerHTML = `<div class="settings-note settings-note--warn">Could not load offline conversion auth settings: ${esc(err.message)}</div>`;
        setOfflineAuthEditing(false);
    }
}

async function toggleOfflineAuthPasswordReveal() {
    const { shell, passwordInput, revealBtn } = offlineAuthElements();
    if (!shell || !passwordInput || !revealBtn) return;
    if (shell.dataset.passwordRevealed === 'true') {
        shell.dataset.passwordRevealed = 'false';
        revealBtn.classList.remove('is-revealed');
        revealBtn.title = 'Show password';
        revealBtn.setAttribute('aria-label', 'Show password');
        passwordInput.type = 'password';
        passwordInput.value = '••••••••••••';
        return;
    }
    if (shell.dataset.passwordRevealAvailable !== 'true') {
        showToast('Password reveal is unavailable until the Basic Auth password is rotated.', true);
        return;
    }
    revealBtn.disabled = true;
    try {
        const res = await dashboardFetch(`${API_BASE_GLOBAL}/api/offline-conversions/auth/password`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not reveal offline conversion auth password');
        passwordInput.type = 'text';
        passwordInput.value = data.password || '';
        shell.dataset.passwordRevealed = 'true';
        revealBtn.classList.add('is-revealed');
        revealBtn.title = 'Hide password';
        revealBtn.setAttribute('aria-label', 'Hide password');
    } catch (err) {
        console.error(err);
        showToast(`Password reveal failed: ${err.message}`, true);
    } finally {
        revealBtn.disabled = false;
    }
}

async function saveOfflineConversionsAuthSettings() {
    const { usernameInput, passwordInput, saveBtn } = offlineAuthElements();
    if (!usernameInput || !passwordInput || !saveBtn) return;
    saveBtn.disabled = true;
    try {
        const body = { username: usernameInput.value.trim() };
        if (passwordInput.value) body.password = passwordInput.value;
        const res = await dashboardFetch(`${API_BASE_GLOBAL}/api/offline-conversions/auth`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not save offline conversion auth settings');
        showToast('Offline conversion auth saved.', false);
        await loadOfflineConversionsAuthSettings();
    } catch (err) {
        console.error(err);
        showToast(`Offline conversion auth save failed: ${err.message}`, true);
    } finally {
        saveBtn.disabled = false;
    }
}

// Sidebar / Meta
function renderSidebar() {
    const { meta } = dashboardData;
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
    bindMobileDatePickerLifecycle(cpPicker);
    bindMobileDatePickerLifecycle(ppPicker);

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

    async function applyComparison(showSuccessToast = true) {
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

        const safeDiv = (a, b) => b ? Number((a / b).toFixed(2)) : 0;
        const delta = (c, p) => p === 0 ? (c > 0 ? 100 : 0) : Number(((c - p) / p * 100).toFixed(1));

        const comparisonSummary = (payload, label) => {
            const summary = payload?.summary || {};
            const leadTotals = payload?.leadAttribution?.totals || {};
            const spend = Number(summary.spend || 0);
            const clicks = Number(summary.clicks || 0);
            const impressions = Number(summary.impressions || 0);
            const conversions = Number(summary.conversions || 0);
            return {
                label,
                spend,
                clicks,
                impressions,
                conversions,
                cpa: Number(summary.cpa ?? safeDiv(spend, conversions)),
                realConversions: Number(leadTotals.uniqueLeads || 0),
                realConverted: Number(leadTotals.converted || 0),
                realQualified: Number(leadTotals.qualified || 0)
            };
        };

        if (showSuccessToast) showToast('Loading comparison ranges...', false);
        const [currentRes, previousRes] = await Promise.all([
            dashboardFetch(`${API_BASE_GLOBAL}/api/dashboard${dashboardQueryString({ startDate: cpStartStr, endDate: cpEndStr, view: 'overview' })}`),
            dashboardFetch(`${API_BASE_GLOBAL}/api/dashboard${dashboardQueryString({ startDate: ppStartStr, endDate: ppEndStr, view: 'overview' })}`)
        ]);
        const [currentPayload, previousPayload] = await Promise.all([
            currentRes.json().catch(() => ({})),
            previousRes.json().catch(() => ({}))
        ]);
        if (!currentRes.ok) throw new Error(currentPayload.error || currentPayload.message || `Current comparison range failed with ${currentRes.status}`);
        if (!previousRes.ok) throw new Error(previousPayload.error || previousPayload.message || `Previous comparison range failed with ${previousRes.status}`);

        const curr = comparisonSummary(currentPayload, `${cpStartStr} - ${cpEndStr}`);
        const prev = comparisonSummary(previousPayload, `${ppStartStr} - ${ppEndStr}`);

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

    document.getElementById('applyComparisonBtn').addEventListener('click', () => {
        applyComparison(true).catch(err => {
            console.error(err);
            showToast(`Comparison load failed: ${err.message}`, true);
        });
    });
}

function populateGlobalFilters() {
    const campSelect = document.getElementById('globalCampaignFilter');
    const adgSelect = document.getElementById('globalAdGroupFilter');
    if (!campSelect || !adgSelect || !window.fullData) return;

    const currentCamp = dashboardData?.meta?.filters?.campaignId || localStorage.getItem('globalCampaignId') || campSelect.value;
    const currentAdG = dashboardData?.meta?.filters?.adGroupId || localStorage.getItem('globalAdGroupId') || adgSelect.value;
    const filterOptions = window.fullData.filterOptions || {};

    campSelect.innerHTML = '<option value="All">All Campaigns</option>';

    const campaigns = Array.isArray(filterOptions.campaigns) && filterOptions.campaigns.length
        ? filterOptions.campaigns
        : (window.fullData.campaigns || []).map(c => ({ id: String(c.id || c.campaignId || c.name), name: c.name || c.campaign || c.id }));
    campaigns.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))).forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name || c.id;
        campSelect.appendChild(opt);
    });
    if (campaigns.some(c => c.id === currentCamp)) campSelect.value = currentCamp;

    window.updateAdGroupDropdown = () => {
        const selectedCamp = campSelect.value;
        const selectedAdGroup = localStorage.getItem('globalAdGroupId') || adgSelect.value;
        adgSelect.innerHTML = '<option value="All">All Ad Groups</option>';

        const adGroups = Array.isArray(filterOptions.adGroups) && filterOptions.adGroups.length
            ? filterOptions.adGroups
            : (window.fullData.adGroups || []).map(a => ({ id: String(a.id || a.adGroupId || a.name), name: a.name || a.adGroup || a.id, campaignId: String(a.campaignId || '') }));
        const visibleAdGroups = adGroups
            .filter(a => selectedCamp === 'All' || a.campaignId === selectedCamp)
            .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        visibleAdGroups.forEach(a => {
            const opt = document.createElement('option');
            opt.value = a.id;
            opt.textContent = a.name || a.id;
            adgSelect.appendChild(opt);
        });

        if (visibleAdGroups.some(a => a.id === selectedAdGroup)) {
            adgSelect.value = selectedAdGroup;
        } else {
            adgSelect.value = 'All';
        }
    };

    // Populate initially
    window.updateAdGroupDropdown();

    // Use a flag to avoid double binding
    if (!campSelect.hasAttribute('data-bound')) {
        campSelect.addEventListener('change', () => {
            localStorage.setItem('globalCampaignId', campSelect.value);
            localStorage.setItem('globalAdGroupId', 'All');
            window.updateAdGroupDropdown();
            loadDashboardForCurrentFilters('Loading selected campaign...')
                .catch(err => {
                    console.error(err);
                    showToast(`Dashboard load failed: ${err.message}`, true);
                });
        });
        campSelect.setAttribute('data-bound', 'true');
    }

    if (!adgSelect.hasAttribute('data-bound')) {
        adgSelect.addEventListener('change', () => {
            localStorage.setItem('globalAdGroupId', adgSelect.value);
            loadDashboardForCurrentFilters('Loading selected ad group...')
                .catch(err => {
                    console.error(err);
                    showToast(`Dashboard load failed: ${err.message}`, true);
                });
        });
        adgSelect.setAttribute('data-bound', 'true');
    }
}

function applyLocalFilter(_startDate, _endDate) {
    if (!window.fullData) return;
    renderDashboardPayload();
}

function renderGlobalKPIs() {
    const summary = dashboardData.summary || dashboardData.globalSummary || {};
    const globalKpiGrid = document.getElementById('globalKpiGrid');
    if (!globalKpiGrid) return;

    const realConvVal = dashboardData.leadAttribution?.totals?.uniqueLeads || 0;
    const realConvWon = dashboardData.leadAttribution?.totals?.converted || 0;
    const realConvQual = dashboardData.leadAttribution?.totals?.qualified || 0;
    const realConvMaybe = dashboardData.leadAttribution?.totals?.maybe || 0;

    const todayKey = localIsoDateKey();
    const range = dashboardData.meta?.dateRange || {};
    const trendRows = dashboardData.dailyTrend || [];
    const dateRangeIncludesToday = (!range.start || range.start <= todayKey) && (!range.end || range.end >= todayKey);
    const clickMetricDate = dateRangeIncludesToday ? todayKey : (range.end || trendRows[trendRows.length - 1]?.date || todayKey);
    const clickMetrics = trendRows.find(row => row.date === clickMetricDate);
    const clicksTodayVal = Number(clickMetrics?.clicks || 0);
    const clicksKpiLabel = clickMetricDate === todayKey ? 'Clicks Today' : `Clicks on ${formatIsoDateShort(clickMetricDate)}`;

    // Mobile Leads Card rendering
    const mobileLeadsCard = document.getElementById('mobileLeadsCard');
    if (mobileLeadsCard) {
        if (dashboardData.leadAttribution) {
            const realConvSuccess = realConvWon + realConvQual;
            const isRealBad = summary.spend > 0 && realConvSuccess === 0;
            const bg = isRealBad ? 'background: rgba(239, 68, 68, 0.05) !important;' : '';
            const border = isRealBad ? 'border: 1px solid rgba(239, 68, 68, 0.2);' : '';
            const color = isRealBad ? 'color: var(--danger) !important;' : '';

            mobileLeadsCard.style.display = '';
            mobileLeadsCard.innerHTML = `
                <div class="card glass-card mobile-leads-card-inner" style="${bg} ${border}">
                    <div class="mobile-leads-card-header">
                        <span class="mobile-leads-card-title">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color: var(--accent, #3b82f6);">
                                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
                                <circle cx="9" cy="7" r="4"></circle>
                                <path d="M22 21v-2a4 4 0 0 3-3.87"></path>
                                <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                            </svg>
                            Leads
                        </span>
                        <span class="mobile-leads-card-value" style="${color}">${fmtNum(realConvVal)}</span>
                    </div>
                    <div class="mobile-leads-card-badges">
                        <span class="mobile-leads-badge mobile-leads-badge--maybe"><strong>${fmtNum(realConvMaybe)}</strong> maybe</span>
                        <span class="mobile-leads-badge mobile-leads-badge--qualified"><strong>${fmtNum(realConvQual)}</strong> qualified</span>
                        ${realConvWon > 0 ? `<span class="mobile-leads-badge mobile-leads-badge--won"><strong>${fmtNum(realConvWon)}</strong> won</span>` : ''}
                    </div>
                </div>
            `;
        } else {
            mobileLeadsCard.style.display = 'none';
            mobileLeadsCard.innerHTML = '';
        }
    }

    const kpis = overviewTimeSeriesCardMetrics.map((metricKey, chartSlot) => {
        const metric = OVERVIEW_TIME_SERIES_METRICS[metricKey];
        return {
            label: metric.label,
            value: formatOverviewTimeSeriesValue(metricKey, overviewTimeSeriesMetricValue(metricKey, summary)),
            metricKey,
            chartSlot,
            action: metricKey === 'clicks' ? 'clicks' : null
        };
    });
    kpis.push({ label: clicksKpiLabel, value: fmtNum(clicksTodayVal) });

    if (dashboardData.leadAttribution) {
        const realConvSuccess = realConvWon + realConvQual;
        const isRealBad = summary.spend > 0 && realConvSuccess === 0;
        kpis.push({
            label: 'Leads',
            value: fmtNum(realConvVal),
            desc: `<strong>${realConvMaybe}</strong> maybe, <strong>${realConvQual}</strong> qualified`,
            isBad: isRealBad,
            isLeads: true
        });
        const conversionsKpi = kpis.find(kpi => kpi.metricKey === 'conversions');
        if (conversionsKpi) conversionsKpi.isBad = summary.spend > 0 && (summary.conversions === 0 || realConvSuccess === 0);
    }

    globalKpiGrid.innerHTML = kpis.map(kpi => {
        const bg = kpi.isBad ? 'background: rgba(239, 68, 68, 0.05) !important;' : 'background: var(--bg-surface);';
        const border = kpi.isBad ? 'border: 1px solid rgba(239, 68, 68, 0.2);' : '';
        const color = kpi.isBad ? 'color: var(--danger) !important;' : '';
        const labelStyle = kpi.isBad ? 'color: var(--danger) !important;' : 'color: var(--text-main);';
        const descHtml = kpi.desc ? `<div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem; line-height: 1.25;">${kpi.desc}</div>` : '';

        const isClickDetails = kpi.action === 'clicks';
        const isChartMetric = Boolean(kpi.metricKey);
        const isChartVisible = isChartMetric ? overviewTimeSeriesVisibleSlots[kpi.chartSlot] : false;
        const chartMetricClass = isChartMetric ? ' overview-chart-metric' : '';
        const selectedClass = isChartMetric ? (isChartVisible ? ' is-chart-selected' : ' is-chart-hidden') : '';
        const clickDetailsClass = isClickDetails ? ' overall-clicks-card' : '';
        const leadsClass = kpi.isLeads ? ' kpi-card--leads' : '';
        const leadsAttribute = kpi.isLeads ? 'data-kpi-type="leads"' : '';
        const chartColor = isChartMetric ? OVERVIEW_TIME_SERIES_CARD_COLORS[kpi.chartSlot] : null;
        const chartStyle = chartColor
            ? `--chart-metric-color:var(${chartColor});`
            : '--chart-metric-color:var(--border-highlight);';
        const labelText = kpi.label;
        const labelHtml = isChartMetric ? `
            <div class="overview-chart-card-header">
                <span class="kpi-label" style="${labelStyle} font-weight: 500;">${esc(labelText)}</span>
                <button class="overview-chart-trigger" type="button" data-overview-chart-trigger="${kpi.chartSlot}"
                    aria-haspopup="dialog" aria-expanded="false" title="Change ${esc(kpi.label)} metric"
                    aria-label="Change ${esc(kpi.label)} metric">
                    <span class="overview-chart-trigger-chevron" aria-hidden="true"></span>
                </button>
            </div>
        ` : `<span class="kpi-label" style="${labelStyle} font-weight: 500;">${esc(labelText)}</span>`;
        const detailsButton = isClickDetails ? `
            <button class="kpi-detail-button" type="button" data-kpi-action="clicks" title="View click details" aria-label="View click details">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path d="M4 6h16"></path><path d="M4 12h16"></path><path d="M4 18h10"></path>
                </svg>
            </button>
        ` : '';
        const kpiCardClass = `card glass-card kpi-card${chartMetricClass}${selectedClass}${clickDetailsClass}${leadsClass}`;
        const chartCardAttributes = isChartMetric
            ? `data-overview-chart-card-slot="${kpi.chartSlot}" role="button" tabindex="0" aria-pressed="${isChartVisible}" title="${isChartVisible ? 'Remove' : 'Add'} ${esc(kpi.label)} ${isChartVisible ? 'from' : 'to'} chart"`
            : '';

        return `
            <div class="${kpiCardClass}" style="${bg} ${border} ${chartStyle}" ${chartCardAttributes} ${leadsAttribute}>
                ${labelHtml}
                <span class="kpi-value" style="${color}" data-val="${kpi.value}">${kpi.value}</span>
                ${descHtml}
                ${detailsButton}
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
            label: 'Leads',
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

const OVERVIEW_TIME_SERIES_METRICS = {
    conversions: { label: 'Conversions', group: 'Conversions', format: 'decimal' },
    cpa: { label: 'Cost / conv.', group: 'Conversions', format: 'currency' },
    cvr: { label: 'Conv. rate', group: 'Conversions', format: 'percent' },
    allConversions: { label: 'All conversions', group: 'Conversions', format: 'decimal' },
    spend: { label: 'Total Spend', optionLabel: 'Cost', group: 'Performance', format: 'currency' },
    impressions: { label: 'Impressions', group: 'Performance', format: 'number' },
    clicks: { label: 'Clicks', group: 'Performance', format: 'number' },
    ctr: { label: 'CTR', group: 'Performance', format: 'percent' },
    avgCpc: { label: 'Avg CPC', optionLabel: 'Avg. CPC', group: 'Performance', format: 'currency' },
    conversionsValue: { label: 'Conv. value', group: 'Conversion value', format: 'currency' },
    conversionValueCost: { label: 'Conv. value / cost', group: 'Conversion value', format: 'ratio' },
    actualRoas: { label: 'Actual ROAS', group: 'Conversion value', format: 'percent' },
    impressionShare: { label: 'Search impr. share', group: 'Competitive metrics', format: 'percent' },
    lostISBudget: { label: 'Lost IS (budget)', group: 'Competitive metrics', format: 'percent' },
    lostISRank: { label: 'Lost IS (rank)', group: 'Competitive metrics', format: 'percent' }
};
const OVERVIEW_TIME_SERIES_DEFAULT_METRICS = ['impressions', 'clicks', 'conversions', 'spend', 'ctr', 'avgCpc', 'cvr'];
const OVERVIEW_TIME_SERIES_STORAGE_KEY = 'zenseeo:overview-time-series-card-metrics:v2';
const OVERVIEW_TIME_SERIES_VISIBILITY_KEY = 'zenseeo:overview-time-series-card-visibility:v2';
const OVERVIEW_TIME_SERIES_CARD_COLORS = [
    '--success',
    '--info',
    '--warning',
    '--primary',
    '--danger',
    '--chart-accent-teal',
    '--chart-accent-violet'
];

function getOverviewTimeSeriesStorageKey(baseKey) {
    const userId = DASHBOARD_AUTH?.user?.id;
    return userId ? `zenseeo:user_${userId}:${baseKey}` : baseKey;
}

function isValidOverviewTimeSeriesMetrics(value) {
    return Array.isArray(value)
        && value.length === OVERVIEW_TIME_SERIES_DEFAULT_METRICS.length
        && new Set(value).size === value.length
        && value.every(key => OVERVIEW_TIME_SERIES_METRICS[key]);
}

function isValidOverviewTimeSeriesVisibility(value) {
    return Array.isArray(value)
        && value.length === OVERVIEW_TIME_SERIES_DEFAULT_METRICS.length
        && value.every(item => typeof item === 'boolean');
}

function overviewPreferenceStorageBaseKey(preferenceKey) {
    if (preferenceKey === 'overviewCardMetrics') return OVERVIEW_TIME_SERIES_STORAGE_KEY;
    if (preferenceKey === 'overviewCardVisibility') return OVERVIEW_TIME_SERIES_VISIBILITY_KEY;
    return '';
}

function overviewPreferencePendingKey(preferenceKey) {
    const baseKey = overviewPreferenceStorageBaseKey(preferenceKey);
    return baseKey ? `${getOverviewTimeSeriesStorageKey(baseKey)}:pending-sync` : '';
}

function currentOverviewPreferenceValue(preferenceKey) {
    if (preferenceKey === 'overviewCardMetrics') return [...overviewTimeSeriesCardMetrics];
    if (preferenceKey === 'overviewCardVisibility') return [...overviewTimeSeriesVisibleSlots];
    return null;
}

function storeOverviewPreference(preferenceKey, value) {
    const baseKey = overviewPreferenceStorageBaseKey(preferenceKey);
    if (!baseKey) return;
    try {
        localStorage.setItem(getOverviewTimeSeriesStorageKey(baseKey), JSON.stringify(value));
    } catch {
        // The in-memory preference still works when browser storage is unavailable.
    }
}

function overviewPreferenceHasPendingSync(preferenceKey) {
    const key = overviewPreferencePendingKey(preferenceKey);
    if (!key) return false;
    try {
        return localStorage.getItem(key) === '1';
    } catch {
        return false;
    }
}

function setOverviewPreferencePendingSync(preferenceKey, pending) {
    const key = overviewPreferencePendingKey(preferenceKey);
    if (!key) return;
    try {
        if (pending) localStorage.setItem(key, '1');
        else localStorage.removeItem(key);
    } catch {
        // Best-effort marker; the current page still retains the in-memory value.
    }
}

function migrateLegacyOverviewTimeSeriesPreferences() {
    if (!DASHBOARD_AUTH?.user?.id) return;
    const preferenceConfigs = [
        { baseKey: OVERVIEW_TIME_SERIES_STORAGE_KEY, validate: isValidOverviewTimeSeriesMetrics },
        { baseKey: OVERVIEW_TIME_SERIES_VISIBILITY_KEY, validate: isValidOverviewTimeSeriesVisibility }
    ];
    for (const { baseKey, validate } of preferenceConfigs) {
        try {
            const userKey = getOverviewTimeSeriesStorageKey(baseKey);
            const legacyRaw = localStorage.getItem(baseKey);
            if (localStorage.getItem(userKey) === null && legacyRaw !== null) {
                const legacyValue = JSON.parse(legacyRaw);
                if (validate(legacyValue)) localStorage.setItem(userKey, JSON.stringify(legacyValue));
            }
            // The unscoped key must not leak the first user's choices to another login.
            localStorage.removeItem(baseKey);
        } catch {
            // Ignore invalid or unavailable legacy browser state.
        }
    }
}

function loadOverviewTimeSeriesMetrics() {
    try {
        const savedRaw = localStorage.getItem(getOverviewTimeSeriesStorageKey(OVERVIEW_TIME_SERIES_STORAGE_KEY));
        const saved = JSON.parse(savedRaw || 'null');
        if (isValidOverviewTimeSeriesMetrics(saved)) return saved;
    } catch {
        // Ignore invalid browser state and use the dashboard defaults.
    }
    return [...OVERVIEW_TIME_SERIES_DEFAULT_METRICS];
}

let overviewTimeSeriesCardMetrics = loadOverviewTimeSeriesMetrics();

function loadOverviewTimeSeriesVisibility() {
    try {
        const savedRaw = localStorage.getItem(getOverviewTimeSeriesStorageKey(OVERVIEW_TIME_SERIES_VISIBILITY_KEY));
        const saved = JSON.parse(savedRaw || 'null');
        if (isValidOverviewTimeSeriesVisibility(saved)) return saved;
    } catch {
        // Ignore invalid browser state and show every configured metric.
    }
    return OVERVIEW_TIME_SERIES_DEFAULT_METRICS.map(() => true);
}

let overviewTimeSeriesVisibleSlots = loadOverviewTimeSeriesVisibility();

const overviewPreferenceRevisions = {
    overviewCardMetrics: 0,
    overviewCardVisibility: 0
};
let userPreferenceMutationChain = Promise.resolve();

function queueUserPreferencesSave(preferences, apiBase = API_BASE_GLOBAL) {
    const userId = DASHBOARD_AUTH?.user?.id;
    const entries = Object.entries(preferences || {})
        .filter(([key, value]) => overviewPreferenceStorageBaseKey(key) && value !== null)
        .map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]);
    if (!userId || entries.length === 0) return Promise.resolve(false);

    const snapshot = Object.fromEntries(entries);
    for (const [key] of entries) setOverviewPreferencePendingSync(key, true);

    if (DASHBOARD_AUTH?.offline || navigator.onLine === false) return Promise.resolve(false);

    const queuedMutation = userPreferenceMutationChain
        .catch(() => undefined)
        .then(async () => {
            if (DASHBOARD_AUTH?.user?.id !== userId || DASHBOARD_AUTH?.offline || navigator.onLine === false) {
                return false;
            }
            const url = `${apiBase || ''}/api/user/preferences`;
            const res = await dashboardFetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ preferences: snapshot })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `Preference save failed with ${res.status}.`);
            for (const [key, savedValue] of entries) {
                if (JSON.stringify(currentOverviewPreferenceValue(key)) === JSON.stringify(savedValue)) {
                    setOverviewPreferencePendingSync(key, false);
                }
            }
            return true;
        })
        .catch(err => {
            console.warn('Failed to save user preferences to backend', err);
            return false;
        });
    userPreferenceMutationChain = queuedMutation.then(() => undefined);
    return queuedMutation;
}

async function syncUserPreferencesFromBackend(apiBase = API_BASE_GLOBAL) {
    if (!DASHBOARD_AUTH?.user?.id || DASHBOARD_AUTH?.offline) return;
    const userId = DASHBOARD_AUTH.user.id;
    const revisionsAtStart = { ...overviewPreferenceRevisions };
    try {
        await userPreferenceMutationChain.catch(() => undefined);
        if (DASHBOARD_AUTH?.user?.id !== userId || DASHBOARD_AUTH?.offline) return;
        const url = `${apiBase || ''}/api/user/preferences`;
        const res = await dashboardFetch(url, { headers: { 'Accept': 'application/json' } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Preference sync failed with ${res.status}.`);
        if (DASHBOARD_AUTH?.user?.id !== userId || DASHBOARD_AUTH?.offline) return;
        const preferences = data.preferences || {};
        let updated = false;
        const preferencesToUpload = {};

        const metricsChangedLocally = overviewPreferenceRevisions.overviewCardMetrics !== revisionsAtStart.overviewCardMetrics;
        if (overviewPreferenceHasPendingSync('overviewCardMetrics') || metricsChangedLocally) {
            preferencesToUpload.overviewCardMetrics = currentOverviewPreferenceValue('overviewCardMetrics');
        } else if (isValidOverviewTimeSeriesMetrics(preferences.overviewCardMetrics)) {
            overviewTimeSeriesCardMetrics = [...preferences.overviewCardMetrics];
            storeOverviewPreference('overviewCardMetrics', overviewTimeSeriesCardMetrics);
            updated = true;
        } else {
            preferencesToUpload.overviewCardMetrics = currentOverviewPreferenceValue('overviewCardMetrics');
        }

        const visibilityChangedLocally = overviewPreferenceRevisions.overviewCardVisibility !== revisionsAtStart.overviewCardVisibility;
        if (overviewPreferenceHasPendingSync('overviewCardVisibility') || visibilityChangedLocally) {
            preferencesToUpload.overviewCardVisibility = currentOverviewPreferenceValue('overviewCardVisibility');
        } else if (isValidOverviewTimeSeriesVisibility(preferences.overviewCardVisibility)) {
            overviewTimeSeriesVisibleSlots = [...preferences.overviewCardVisibility];
            storeOverviewPreference('overviewCardVisibility', overviewTimeSeriesVisibleSlots);
            updated = true;
        } else {
            preferencesToUpload.overviewCardVisibility = currentOverviewPreferenceValue('overviewCardVisibility');
        }

        if (Object.keys(preferencesToUpload).length > 0) {
            await queueUserPreferencesSave(preferencesToUpload, apiBase);
        }

        if (updated && dashboardData) {
            renderGlobalKPIs();
            renderOverviewTimeSeries();
        }
    } catch (err) {
        console.warn('Failed to sync user preferences from backend', err);
    }
}

function saveOverviewTimeSeriesVisibilityPreference(apiBase = API_BASE_GLOBAL) {
    overviewPreferenceRevisions.overviewCardVisibility += 1;
    storeOverviewPreference('overviewCardVisibility', overviewTimeSeriesVisibleSlots);
    void queueUserPreferencesSave({
        overviewCardVisibility: currentOverviewPreferenceValue('overviewCardVisibility')
    }, apiBase);
}

function saveOverviewTimeSeriesMetricsPreference(apiBase = API_BASE_GLOBAL) {
    overviewPreferenceRevisions.overviewCardMetrics += 1;
    storeOverviewPreference('overviewCardMetrics', overviewTimeSeriesCardMetrics);
    void queueUserPreferencesSave({
        overviewCardMetrics: currentOverviewPreferenceValue('overviewCardMetrics')
    }, apiBase);
}

function renderCharts() {
    renderComparisonChart();
    renderOverviewTimeSeries();
    if (dashboardData.devicePerformance) renderDeviceChart();
    renderTimePerformance();
    renderSankeyChart();
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

function overviewTimeSeriesMetricValue(metricKey, row) {
    const source = row || {};
    if (metricKey === 'conversionValueCost') {
        return Number(source.spend || 0) > 0 ? Number(source.conversionsValue || 0) / Number(source.spend) : 0;
    }
    if (metricKey === 'actualRoas') {
        return Number(source.spend || 0) > 0 ? (Number(source.conversionsValue || 0) / Number(source.spend)) * 100 : 0;
    }
    return Number(row?.[metricKey] || 0);
}

function formatOverviewTimeSeriesValue(metricKey, value, precise = false) {
    const metric = OVERVIEW_TIME_SERIES_METRICS[metricKey];
    const number = Number(value || 0);
    if (metric?.format === 'currency') {
        return new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            notation: precise ? 'standard' : 'compact',
            maximumFractionDigits: precise ? 2 : 2
        }).format(number);
    }
    if (metric?.format === 'percent') return fmtPct(number);
    if (metric?.format === 'decimal') return number.toFixed(2);
    if (metric?.format === 'ratio') return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(number);
    return new Intl.NumberFormat('en-IN', {
        notation: precise ? 'standard' : 'compact',
        maximumFractionDigits: 2
    }).format(number);
}

function overviewTimeSeriesMetricMenuHtml(selectedKey) {
    const groups = new Map();
    Object.entries(OVERVIEW_TIME_SERIES_METRICS).forEach(([key, metric]) => {
        if (!groups.has(metric.group)) groups.set(metric.group, []);
        groups.get(metric.group).push({ key, label: metric.optionLabel || metric.label });
    });
    const metricGroups = [...groups.entries()].map(([group, metrics]) => `
        <section class="overview-metric-menu-group" aria-labelledby="overviewMetricGroup-${statusClass(group)}">
            <div class="overview-metric-menu-group-label" id="overviewMetricGroup-${statusClass(group)}">${esc(group)}</div>
            ${metrics.map(metric => `
                <button class="overview-metric-menu-option${metric.key === selectedKey ? ' is-current' : ''}" type="button"
                    data-overview-metric-key="${esc(metric.key)}" role="option" aria-selected="${metric.key === selectedKey}">
                    <span>${esc(metric.label)}</span>
                    <span class="overview-metric-menu-check" aria-hidden="true">&#10003;</span>
                </button>
            `).join('')}
        </section>
    `).join('');
    return metricGroups;
}

function overviewTimeSeriesCardColor(cardSlot) {
    const styles = getComputedStyle(document.documentElement);
    const colorVar = OVERVIEW_TIME_SERIES_CARD_COLORS[cardSlot];
    return colorVar ? styles.getPropertyValue(colorVar).trim() : styles.getPropertyValue('--text-muted').trim();
}

function normalizeOverviewTimeSeries(values) {
    const safeValues = values.map(value => Math.max(0, Number(value || 0)));
    const maxValue = Math.max(...safeValues, 0);
    if (maxValue === 0) return safeValues.map(() => 0);
    return safeValues.map(value => (value / maxValue) * 100);
}

const overviewTimeSeriesHoverLine = {
    id: 'overviewTimeSeriesHoverLine',
    beforeDatasetsDraw(chart) {
        const active = chart.tooltip?.getActiveElements?.() || [];
        if (!active.length) return;
        const x = active[0].element.x;
        const { ctx, chartArea } = chart;
        ctx.save();
        ctx.beginPath();
        ctx.setLineDash([2, 4]);
        ctx.strokeStyle = document.documentElement.classList.contains('dark')
            ? 'rgba(203, 213, 225, 0.65)'
            : 'rgba(71, 85, 105, 0.65)';
        ctx.lineWidth = 1;
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
        ctx.restore();
    }
};

function renderOverviewTimeSeries() {
    const canvas = document.getElementById('overviewTimeSeriesChart');
    const emptyState = document.getElementById('overviewTimeSeriesEmpty');
    if (!canvas || !emptyState || !dashboardData) return;

    const dailyTrend = Array.isArray(dashboardData.dailyTrend) ? dashboardData.dailyTrend : [];

    if (charts.overviewTimeSeries) {
        charts.overviewTimeSeries.destroy();
        charts.overviewTimeSeries = null;
    }

    const visibleMetricCount = overviewTimeSeriesVisibleSlots.filter(Boolean).length;
    const hasData = dailyTrend.length > 0 && visibleMetricCount > 0;
    const selectedMetricLabels = overviewTimeSeriesCardMetrics
        .filter((_metricKey, cardSlot) => overviewTimeSeriesVisibleSlots[cardSlot])
        .map(metricKey => OVERVIEW_TIME_SERIES_METRICS[metricKey].label.toLowerCase());
    canvas.setAttribute('aria-label', `${selectedMetricLabels.join(', ')} over the selected date range`);
    canvas.hidden = !hasData;
    emptyState.textContent = visibleMetricCount === 0
        ? 'Select at least one KPI card to show its metric in the chart.'
        : 'No performance data is available for this date range.';
    emptyState.hidden = hasData;
    if (!hasData) return;

    const isDark = document.documentElement.classList.contains('dark');
    const labels = dailyTrend.map(row => formatIsoDateShort(row.date));
    const datasets = overviewTimeSeriesCardMetrics
        .flatMap((metricKey, cardSlot) => {
            if (!overviewTimeSeriesVisibleSlots[cardSlot]) return [];
            const metric = OVERVIEW_TIME_SERIES_METRICS[metricKey];
            const color = overviewTimeSeriesCardColor(cardSlot);
            const rawValues = dailyTrend.map(row => overviewTimeSeriesMetricValue(metricKey, row));
            return [{
                label: metric.label,
                data: normalizeOverviewTimeSeries(rawValues),
                rawValues,
                metricKey,
                borderColor: color,
                backgroundColor: color,
                borderWidth: 2.5,
                pointRadius: dailyTrend.length === 1 ? 4 : 0,
                pointHoverRadius: 4,
                pointHitRadius: 14,
                pointBackgroundColor: color,
                pointBorderColor: color,
                tension: 0.15,
                fill: false
            }];
        });

    charts.overviewTimeSeries = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { labels, datasets },
        plugins: [overviewTimeSeriesHoverLine],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            animation: { duration: 250 },
            layout: { padding: { top: 8, right: 4, bottom: 0, left: 4 } },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: isDark ? '#111827' : '#ffffff',
                    borderColor: isDark ? '#374151' : '#d7dce1',
                    borderWidth: 1,
                    titleColor: isDark ? '#f9fafb' : '#202124',
                    bodyColor: isDark ? '#cbd5e1' : '#3c4043',
                    titleFont: { size: 13, weight: '600', family: "'Inter', sans-serif" },
                    bodyFont: { size: 12, family: "'Inter', sans-serif" },
                    padding: 12,
                    cornerRadius: 6,
                    displayColors: true,
                    boxWidth: 9,
                    boxHeight: 2,
                    usePointStyle: false,
                    callbacks: {
                        label(context) {
                            const rawValue = context.dataset.rawValues?.[context.dataIndex] || 0;
                            return `${context.dataset.label}: ${formatOverviewTimeSeriesValue(context.dataset.metricKey, rawValue, true)}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    border: { display: false },
                    grid: { display: false },
                    ticks: {
                        color: isDark ? '#94a3b8' : '#6b7280',
                        maxRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: window.matchMedia('(max-width: 768px)').matches ? 3 : 8,
                        font: { size: 11 }
                    }
                },
                y: {
                    beginAtZero: true,
                    suggestedMax: 100,
                    border: { display: false },
                    ticks: { display: false, stepSize: 50 },
                    grid: { color: isDark ? 'rgba(148, 163, 184, 0.14)' : 'rgba(60, 64, 67, 0.14)' }
                }
            }
        }
    });
}

function setupOverviewTimeSeriesControls() {
    const kpiGrid = document.getElementById('globalKpiGrid');
    const menu = document.getElementById('overviewMetricMenu');
    const menuOptions = document.getElementById('overviewMetricMenuOptions');
    const menuBackdrop = document.getElementById('overviewMetricMenuBackdrop');
    const menuClose = document.getElementById('overviewMetricMenuClose');
    if (!kpiGrid || !menu || !menuOptions || !menuBackdrop || !menuClose || kpiGrid.dataset.chartControlsBound === 'true') return;

    let activeCardSlot = null;
    let activeTrigger = null;

    const closeMenu = () => {
        if (activeTrigger) activeTrigger.setAttribute('aria-expanded', 'false');
        menu.hidden = true;
        menuBackdrop.hidden = true;
        menu.style.removeProperty('top');
        menu.style.removeProperty('left');
        menu.style.removeProperty('width');
        activeCardSlot = null;
        activeTrigger = null;
    };

    const positionMenu = trigger => {
        if (window.matchMedia('(max-width: 768px)').matches) return;
        const rect = trigger.closest('.kpi-card').getBoundingClientRect();
        const width = Math.min(320, window.innerWidth - 32);
        const left = Math.min(Math.max(16, rect.left), window.innerWidth - width - 16);
        const roomBelow = window.innerHeight - rect.bottom - 16;
        const top = roomBelow >= menu.offsetHeight
            ? rect.bottom + 8
            : Math.max(16, rect.top - menu.offsetHeight - 8);
        menu.style.width = `${width}px`;
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
    };

    const openMenu = trigger => {
        const cardSlot = Number(trigger.dataset.overviewChartTrigger);
        if (!Number.isInteger(cardSlot) || !overviewTimeSeriesCardMetrics[cardSlot]) return;
        if (activeTrigger && activeTrigger !== trigger) activeTrigger.setAttribute('aria-expanded', 'false');
        activeCardSlot = cardSlot;
        activeTrigger = trigger;
        trigger.setAttribute('aria-expanded', 'true');
        menuOptions.innerHTML = overviewTimeSeriesMetricMenuHtml(
            overviewTimeSeriesCardMetrics[cardSlot]
        );
        menu.hidden = false;
        menuBackdrop.hidden = false;
        positionMenu(trigger);
        menu.querySelector('.overview-metric-menu-option.is-current')?.focus();
    };

    const toggleChartCard = cardSlot => {
        if (!Number.isInteger(cardSlot) || overviewTimeSeriesVisibleSlots[cardSlot] === undefined) return;
        overviewTimeSeriesVisibleSlots[cardSlot] = !overviewTimeSeriesVisibleSlots[cardSlot];
        saveOverviewTimeSeriesVisibilityPreference();
        renderGlobalKPIs();
        renderOverviewTimeSeries();
    };

    kpiGrid.addEventListener('click', event => {
        const detailsButton = event.target.closest('[data-kpi-action="clicks"]');
        if (detailsButton) {
            openClicksModal();
            return;
        }
        const trigger = event.target.closest('[data-overview-chart-trigger]');
        if (trigger) {
            if (activeTrigger === trigger && !menu.hidden) closeMenu();
            else openMenu(trigger);
            return;
        }
        const chartCard = event.target.closest('[data-overview-chart-card-slot]');
        if (chartCard) toggleChartCard(Number(chartCard.dataset.overviewChartCardSlot));
    });
    kpiGrid.addEventListener('keydown', event => {
        if (event.target.closest('button') || !['Enter', ' '].includes(event.key)) return;
        const chartCard = event.target.closest('[data-overview-chart-card-slot]');
        if (!chartCard) return;
        event.preventDefault();
        toggleChartCard(Number(chartCard.dataset.overviewChartCardSlot));
    });
    menu.addEventListener('click', event => {
        const option = event.target.closest('[data-overview-metric-key]');
        if (!option || activeCardSlot === null) return;
        const nextMetricKey = option.dataset.overviewMetricKey;
        if (!OVERVIEW_TIME_SERIES_METRICS[nextMetricKey]) return;
        const previousMetricKey = overviewTimeSeriesCardMetrics[activeCardSlot];
        const existingSlot = overviewTimeSeriesCardMetrics.indexOf(nextMetricKey);
        if (existingSlot !== -1 && existingSlot !== activeCardSlot) {
            overviewTimeSeriesCardMetrics[existingSlot] = previousMetricKey;
        }
        overviewTimeSeriesCardMetrics[activeCardSlot] = nextMetricKey;
        saveOverviewTimeSeriesMetricsPreference();
        closeMenu();
        renderGlobalKPIs();
        renderOverviewTimeSeries();
    });
    menuClose.addEventListener('click', closeMenu);
    menuBackdrop.addEventListener('click', closeMenu);
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !menu.hidden) closeMenu();
    });
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', event => {
        if (menu.hidden || menu.contains(event.target)) return;
        closeMenu();
    }, true);
    kpiGrid.dataset.chartControlsBound = 'true';
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

function initGrid(id, rowData, columnDefs, extraOptions = {}) {
    const gridDiv = document.querySelector(`#${id}`);
    if (!gridDiv) return;

    if (id === 'grid-leadReview') {
        leadReviewRowsForView = Array.isArray(rowData) ? [...rowData] : [];
        renderLeadReviewKanban();
    }

    // Dynamically hide columns with no current entries across all tables
    columnDefs = columnDefs.map(col => {
        const { keepVisibleWhenEmpty, ...gridColumn } = col;
        if (Array.isArray(rowData) && rowData.length > 0 && gridColumn.field && !keepVisibleWhenEmpty) {
            const hasValue = rowData.some(row => {
                if (!row) return false;
                const val = row[gridColumn.field];
                return val !== null && val !== undefined && val !== '';
            });
            if (!hasValue) {
                return { ...gridColumn, hide: true };
            }
        }
        return gridColumn;
    });

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
    const cardHeader = gridDiv.closest('.card, .audience-card, .audience-table-panel, article')?.querySelector('.card-header, .audience-card__header, .audience-table-toolbar, .audience-card__footer--top');
    const gridControls = cardHeader ? (cardHeader.querySelector('.grid-controls, .audience-chart-controls, .audience-exclusion-controls, .audience-table-toolbar') || cardHeader) : null;
    let sortSelect, sortDirBtn;

    if (gridControls) {
        let sortWrapper = gridControls.querySelector('.mobile-sort-wrapper');
        if (!sortWrapper) {
            const sortSelectOptions = columnDefs.filter(c => c.headerName && c.field !== 'actions').map(c => `<option value="${c.field}">${c.headerName}</option>`).join('');
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
    const supportsRowSelection = Boolean(extraOptions.rowSelection);

    const renderCellValue = (col, data) => {
        let val = data[col.field];
        if (col.valueFormatter) {
            val = col.valueFormatter({ value: val, data: data });
        }
        if (col.cellRenderer) {
            return col.cellRenderer({ value: data[col.field], data: data }) ?? '-';
        }
        return esc(val !== undefined && val !== null ? val : '-');
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
            if (count >= 50) return; // Limit cards
            count++;
            const data = node.data;
            html += `<div class="mobile-card" style="animation-delay: ${count * 0.05}s">`;

            const titleField = columnDefs[0].field;
            let titleVal = renderCellValue(columnDefs[0], data);
            const mobileRowId = supportsRowSelection && typeof extraOptions.getRowId === 'function'
                ? extraOptions.getRowId({ data })
                : '';
            const mobileCheckbox = supportsRowSelection
                ? `<input class="mobile-keyword-row-select" type="checkbox" data-mobile-row-id="${esc(mobileRowId)}" ${node.isSelected() ? 'checked' : ''} ${node.selectable === false ? 'disabled' : ''} aria-label="Select row">`
                : '';
            html += `<div class="mobile-card-header">${mobileCheckbox}<div class="mobile-card-title">${titleVal}</div></div>`;
            html += `<div class="mobile-card-body">`;

            const dataCols = columnDefs.slice(1).filter(col => col.field !== 'actions');
            const actionsCol = columnDefs.find(col => col.field === 'actions');

            dataCols.forEach(col => {
                const val = renderCellValue(col, data);
                html += `<div class="mobile-card-stat">
                    <span class="mobile-card-label">${col.headerName}</span>
                    <span class="mobile-card-value">${val}</span>
                </div>`;
            });
            html += `</div>`;

            if (actionsCol) {
                const actionsVal = renderCellValue(actionsCol, data);
                if (actionsVal && actionsVal !== '-') {
                    html += `<div class="mobile-card-actions">${actionsVal}</div>`;
                }
            }

            html += `</div>`;
        });
        if (count === 0) html = '<p style="text-align:center; color:var(--text-muted);">No data available</p>';
        mobileList.innerHTML = html;
        if (supportsRowSelection) {
            mobileList.querySelectorAll('.mobile-keyword-row-select').forEach(checkbox => {
                checkbox.addEventListener('change', () => {
                    api.getRowNode(checkbox.dataset.mobileRowId)?.setSelected(Boolean(checkbox.checked));
                });
            });
        }
    }

    gridDiv.classList.add('ag-theme-alpine');

    const suppliedSelectionChanged = extraOptions.onSelectionChanged;
    const gridOptions = {
        columnDefs: columnDefs,
        rowData: rowData,
        pagination: true,
        paginationPageSize: 50,
        animateRows: true,
        theme: agGrid.themeAlpine,
        onModelUpdated: renderMobileCards,
        ...extraOptions,
        onSelectionChanged: params => {
            if (typeof suppliedSelectionChanged === 'function') suppliedSelectionChanged(params);
            renderMobileCards();
        },
        defaultColDef: {
            sortable: true,
            filter: true,
            resizable: true,
            flex: 1,
            minWidth: 100,
            ...(extraOptions.defaultColDef || {})
        }
    };

    const api = agGrid.createGrid(gridDiv, gridOptions);
    gridInstances[id] = api;

    // Trigger initial mobile render
    setTimeout(renderMobileCards, 100);

    // Bind search input
    const searchInput = document.querySelector(`.table-search[data-target="${id}"]`);
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
    return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function rowNegativeCoverage(row) {
    return row?.negativeCoverage || {
        isNegativeCovered: Boolean(row?.isNegativeCovered),
        negativeCoverageLevel: row?.negativeCoverageLevel || null,
        negativeCoverageSource: row?.negativeCoverageSource || null,
        negativeCoverageKeyword: row?.negativeCoverageKeyword || null,
        negativeCoverageMatchType: row?.negativeCoverageMatchType || null,
        negativeCoverageReason: row?.negativeCoverageReason || null
    };
}

function rowConfiguredCoverage(row) {
    return row?.configuredKeywordCoverage || {
        isConfiguredKeyword: Boolean(row?.isConfiguredKeyword || row?.inAccountKeyword),
        configuredKeywordText: row?.configuredKeywordText || null,
        configuredKeywordStatus: row?.configuredKeywordStatus || null,
        configuredKeywordMatchTypes: row?.configuredKeywordMatchTypes || [],
        configuredKeywordScope: row?.configuredKeywordScope || null,
        configuredKeywordReason: row?.configuredKeywordReason || null
    };
}

function leadQualityForTerm(term) {
    const key = keywordKey(term);
    return (dashboardData?.leadAttribution?.bySearchTerm || []).find(row => keywordKey(row.searchTerm || row.keyword) === key) || null;
}

function leadQualitySummary(row) {
    const lead = leadQualityForTerm(row.searchTerm || row.keyword) || row.leadQuality;
    if (!lead) return null;
    return {
        uniqueLeads: Number(lead.uniqueLeads || 0),
        eventCount: Number(lead.eventCount || 0),
        new: Number(lead.new || 0),
        useless: Number(lead.useless || 0),
        maybe: Number(lead.maybe || 0),
        qualifiedPipeline: Number(lead.qualifiedPipeline || 0),
        qualified: Number(lead.qualified || 0),
        qualifiedLost: Number(lead.qualifiedLost || 0),
        converted: Number(lead.converted || 0),
        qualifiedOrConverted: Number(lead.qualifiedOrConverted || 0)
    };
}

function aggregateLeadQuality(rows = []) {
    const summary = {
        source: 'leadAttribution',
        scope: 'aggregate',
        uniqueLeads: 0,
        eventCount: 0,
        new: 0,
        useless: 0,
        maybe: 0,
        qualified: 0,
        qualifiedLost: 0,
        converted: 0,
        qualifiedPipeline: 0,
        qualifiedOrConverted: 0,
        uselessRate: 0,
        tone: 'missing',
        reason: 'No first-party lead attribution matched this segment.'
    };
    rows.forEach(row => {
        const lead = leadQualitySummary(row);
        if (!lead) return;
        summary.uniqueLeads += Number(lead.uniqueLeads || 0);
        summary.eventCount += Number(lead.eventCount || 0);
        summary.new += Number(lead.new || 0);
        summary.useless += Number(lead.useless || 0);
        summary.maybe += Number(lead.maybe || 0);
        summary.qualified += Number(lead.qualified || 0);
        summary.qualifiedLost += Number(lead.qualifiedLost || 0);
        summary.converted += Number(lead.converted || 0);
    });
    summary.qualifiedPipeline = summary.qualified + summary.qualifiedLost + summary.converted;
    summary.qualifiedOrConverted = summary.qualified + summary.converted;
    summary.uselessRate = summary.uniqueLeads > 0 ? +(summary.useless / summary.uniqueLeads).toFixed(4) : 0;
    if (summary.uniqueLeads > 0 && summary.uselessRate >= 0.6 && summary.qualifiedPipeline === 0) {
        summary.tone = 'negative';
        summary.reason = `${summary.useless}/${summary.uniqueLeads} matched leads are useless with no qualified pipeline.`;
    } else if (summary.uniqueLeads > 0 && summary.qualifiedOrConverted > 0 && summary.uselessRate <= 0.5) {
        summary.tone = 'positive';
        summary.reason = `${summary.qualifiedOrConverted}/${summary.uniqueLeads} matched leads are qualified or converted.`;
    } else if (summary.uniqueLeads > 0) {
        summary.tone = 'mixed';
        summary.reason = `${summary.uniqueLeads} matched leads include mixed or inconclusive quality.`;
    }
    return summary.uniqueLeads > 0 ? summary : null;
}

function coverageLabel(row) {
    const negative = rowNegativeCoverage(row);
    if (negative.isNegativeCovered) return `Excluded: ${negative.negativeCoverageKeyword || 'negative'}`;
    const configured = rowConfiguredCoverage(row);
    if (configured.isConfiguredKeyword) return `Configured: ${configured.configuredKeywordStatus || 'keyword'}`;
    if (row.blockedByNegative) return 'Blocked by negative';
    return row.decisionClassification || row.plannerClassification || 'open';
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
    const lead = leadQualitySummary(row);
    const leadText = lead
        ? ` · ${fmtNum(lead.uniqueLeads)} leads, ${fmtNum(lead.qualifiedPipeline + lead.converted)} qualified/won, ${fmtNum(lead.useless)} junk`
        : '';
    const coverage = coverageLabel(row);
    return `
        <div class="keyword-action-row">
            <strong>${esc(term)}</strong>
            <span>${esc(outcome)} · ${esc(score)} · ${esc(coverage)}${esc(leadText)}</span>
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
    const configuredSet = new Set((dashboardData?.configuredKeywords || []).map(row => keywordKey(row.keyword || row.keywordText)));
    const hasScopedConfiguredCoverage = searchTerms.some(row =>
        row && (row.configuredKeywordCoverage || Object.prototype.hasOwnProperty.call(row, 'isConfiguredKeyword'))
    );
    const isConfiguredSearchTerm = (row) => rowConfiguredCoverage(row).isConfiguredKeyword
        || (!hasScopedConfiguredCoverage && configuredSet.has(keywordKey(row.searchTerm)));
    const coveredTerms = searchTerms.filter(isConfiguredSearchTerm);
    const excludedTerms = searchTerms.filter(row => rowNegativeCoverage(row).isNegativeCovered);
    const wasteRows = searchTerms
        .filter(row => Number(row.spend || 0) > 0 && Number(row.conversions || 0) === 0)
        .sort((a, b) => Number(b.spend || 0) - Number(a.spend || 0));
    const topWaste = wasteRows[0];

    renderMetricCards('searchTermSummary', [
        { label: 'Search terms', value: fmtNum(searchTerms.length), detail: `${fmtNum(searchTerms.reduce((sum, row) => sum + Number(row.clicks || 0), 0))} clicks` },
        { label: 'Terms with conversions', value: fmtNum(searchTerms.filter(row => Number(row.conversions || 0) > 0).length), detail: `${fmtNum(searchTerms.reduce((sum, row) => sum + Number(row.conversions || 0), 0))} total conversions` },
        { label: 'Already configured', value: fmtPct(searchTerms.length ? (coveredTerms.length / searchTerms.length) * 100 : 0), detail: `${fmtNum(coveredTerms.length)} configured keyword matches` },
        { label: 'Already excluded', value: fmtNum(excludedTerms.length), detail: 'Covered by fetched negatives' },
        { label: 'Top waste term', value: topWaste ? fmtCurr(topWaste.spend) : 'n/a', detail: topWaste ? topWaste.searchTerm : 'No zero-conversion spend' }
    ]);

    const alreadyConfiguredRows = searchTerms
        .filter(isConfiguredSearchTerm)
        .sort((a, b) => Number(b.conversions || 0) - Number(a.conversions || 0) || Number(b.spend || 0) - Number(a.spend || 0));
    const alreadyExcludedRows = searchTerms
        .filter(row => rowNegativeCoverage(row).isNegativeCovered)
        .sort((a, b) => Number(b.spend || 0) - Number(a.spend || 0));
    const negativeRows = wasteRows
        .filter(row => !rowNegativeCoverage(row).isNegativeCovered)
        .filter(row => !isConfiguredSearchTerm(row))
        .filter(row => {
            const lead = leadQualitySummary(row);
            const junkLeadSignal = lead && lead.uniqueLeads >= 2 && lead.useless >= Math.max(1, lead.uniqueLeads * 0.6) && lead.qualifiedPipeline === 0 && lead.converted === 0;
            return String(row.label || '').toLowerCase().includes('negative') || row.hasLowIntent || Number(row.clicks || 0) >= 2 || junkLeadSignal;
        })
        .sort((a, b) => Number(b.spend || 0) - Number(a.spend || 0));
    const negativeKeys = new Set(negativeRows.map(row => keywordKey(row.searchTerm)));
    const addRows = searchTerms
        .filter(row => !isConfiguredSearchTerm(row))
        .filter(row => !rowNegativeCoverage(row).isNegativeCovered)
        .filter(row => !negativeKeys.has(keywordKey(row.searchTerm)))
        .filter(row => {
            const lead = leadQualitySummary(row);
            const leadSupport = lead && (lead.qualifiedPipeline + lead.converted) >= 1 && lead.useless <= Math.max(lead.uniqueLeads * 0.5, 1);
            return Number(row.conversions || 0) > 0 || Number(row.plannerScore || 0) >= 65 || leadSupport;
        })
        .sort((a, b) => Number(b.conversions || 0) - Number(a.conversions || 0) || Number(b.plannerScore || 0) - Number(a.plannerScore || 0));
    const actionKeys = new Set([...addRows, ...negativeRows, ...alreadyConfiguredRows, ...alreadyExcludedRows].map(row => keywordKey(row.searchTerm)));
    const monitorRows = searchTerms
        .filter(row => !actionKeys.has(keywordKey(row.searchTerm)))
        .sort((a, b) => Number(b.spend || 0) - Number(a.spend || 0));

    const el = document.getElementById('searchTermActionGroups');
    if (el) {
        el.innerHTML = [
            renderActionGroup('Review candidates — Add as Keywords', addRows, 'No strong add candidates in this filter.', 'success'),
            renderActionGroup('Already configured', alreadyConfiguredRows, 'No configured terms in this filter.', 'neutral'),
            renderActionGroup('Review candidates — Add as Negatives', negativeRows, 'No strong negative candidates in this filter.', 'danger'),
            renderActionGroup('Already excluded', alreadyExcludedRows, 'No excluded terms in this filter.', 'neutral'),
            renderActionGroup('Review candidates — Monitoring', monitorRows, 'No remaining terms to monitor.', 'neutral')
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
                plannerScore: null,
                isNegativeCovered: false,
                isConfiguredKeyword: false,
                blockedByNegative: false,
                configuredKeywordStatus: null,
                negativeCoverageKeyword: null
            });
        }
        return map.get(key);
    };

    (dashboardData?.configuredKeywords || []).forEach(row => {
        const item = ensure(row.keyword || row.keywordText);
        if (!item) return;
        item.inKeywords = true;
        item.isConfiguredKeyword = true;
        item.configuredKeywordStatus = row.status || row.configuredKeywordStatus || item.configuredKeywordStatus;
        item.sources.push('Configured Keyword');
    });

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
        if (rowNegativeCoverage(row).isNegativeCovered) {
            item.isNegativeCovered = true;
            item.blockedByNegative = true;
            item.negativeCoverageKeyword = rowNegativeCoverage(row).negativeCoverageKeyword;
        }
        if (rowConfiguredCoverage(row).isConfiguredKeyword) {
            item.isConfiguredKeyword = true;
            item.configuredKeywordStatus = rowConfiguredCoverage(row).configuredKeywordStatus;
        }
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
        if (rowNegativeCoverage(row).isNegativeCovered) {
            item.isNegativeCovered = true;
            item.blockedByNegative = true;
            item.negativeCoverageKeyword = rowNegativeCoverage(row).negativeCoverageKeyword;
        }
        if (rowConfiguredCoverage(row).isConfiguredKeyword) {
            item.isConfiguredKeyword = true;
            item.configuredKeywordStatus = rowConfiguredCoverage(row).configuredKeywordStatus;
        }
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
        if (rowNegativeCoverage(row).isNegativeCovered || row.blockedByNegative) {
            item.isNegativeCovered = true;
            item.blockedByNegative = true;
            item.negativeCoverageKeyword = rowNegativeCoverage(row).negativeCoverageKeyword;
        }
        if (rowConfiguredCoverage(row).isConfiguredKeyword || row.inAccountKeyword) {
            item.isConfiguredKeyword = true;
            item.configuredKeywordStatus = rowConfiguredCoverage(row).configuredKeywordStatus;
        }
    });

    return Array.from(map.values()).map(row => ({
        ...row,
        sources: Array.from(new Set(row.sources)).join(', '),
        status: row.blockedByNegative
            ? 'blocked by negative'
            : row.isConfiguredKeyword || row.inKeywords
                ? 'configured keyword'
                : row.inSearchTerms
                    ? 'search-term gap'
                    : 'planner gap',
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
                    data: ideas.filter(row => !row.blockedByNegative && !row.inAccountKeyword && !row.inAccountSearchTerm && !rowConfiguredCoverage(row).isConfiguredKeyword).map(point),
                    backgroundColor: 'rgba(16, 185, 129, 0.65)'
                },
                {
                    label: 'Already seen/configured',
                    data: ideas.filter(row => !row.blockedByNegative && (row.inAccountKeyword || row.inAccountSearchTerm || rowConfiguredCoverage(row).isConfiguredKeyword)).map(point),
                    backgroundColor: 'rgba(59, 130, 246, 0.55)'
                },
                {
                    label: 'Blocked by negatives',
                    data: ideas.filter(row => row.blockedByNegative || rowNegativeCoverage(row).isNegativeCovered).map(point),
                    backgroundColor: 'rgba(239, 68, 68, 0.55)'
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
    const plannerGaps = rows.filter(row => row.inPlanner && !row.inKeywords && !row.inSearchTerms && !row.blockedByNegative).length;
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
    const plannerGaps = rows.filter(row => row.inPlanner && !row.inKeywords && !row.inSearchTerms && !row.blockedByNegative);
    const coveredSearchTerms = rows.filter(row => row.inSearchTerms && row.inKeywords);
    const blockedPlanner = rows.filter(row => row.inPlanner && row.blockedByNegative);
    renderMetricCards('keywordUniverseSummary', [
        { label: 'Universe terms', value: fmtNum(rows.length), detail: 'Deduped across all sources' },
        { label: 'Planner-only gaps', value: fmtNum(plannerGaps.length), detail: `${fmtNum(plannerGaps.filter(row => Number(row.plannerScore || 0) >= 65).length)} high-score gaps` },
        { label: 'Blocked ideas', value: fmtNum(blockedPlanner.length), detail: 'Planner rows covered by negatives' },
        { label: 'Search-term coverage', value: fmtPct((dashboardData?.searchTerms || []).length ? (coveredSearchTerms.length / dashboardData.searchTerms.length) * 100 : 0), detail: `${fmtNum(coveredSearchTerms.length)} search terms already keywords` },
        { label: 'Top gap', value: plannerGaps[0]?.term || 'n/a', detail: plannerGaps[0] ? `Score ${fmtNum(plannerGaps[0].plannerScore || 0)}` : 'No planner-only gaps' }
    ]);

    renderKeywordUniverseChart(rows);
    initGrid('grid-keywordUniverse', rows, [
        { field: 'term', headerName: 'Term', pinned: 'left', minWidth: 180 },
        { field: 'sources', headerName: 'Sources', cellRenderer: params => String(params.value || '').split(', ').map(source => `<span class="source-pill">${esc(source)}</span>`).join(' ') },
        { field: 'status', headerName: 'Coverage' },
        { field: 'configuredKeywordStatus', headerName: 'Configured Status' },
        { field: 'negativeCoverageKeyword', headerName: 'Negative Cover' },
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

function keywordManagementKey(row) {
    return `kw:${String(row.adGroupId || '')}:${String(row.criterionId || '')}`;
}

function negativeManagementKey(row) {
    const scope = negativeScopeFromRow(row) || 'unknown';
    const ownerId = scope === 'campaign'
        ? row.campaignId
        : scope === 'ad_group'
            ? row.adGroupId
            : row.sharedSetId || row.sharedSetResourceName;
    return `neg:${scope}:${String(ownerId || '')}:${String(row.criterionId || '')}`;
}

function keywordManagementRow(row) {
    const current = findKeywordControlRow(row) || {};
    return {
        ...row,
        campaignId: row.campaignId || current.campaignId,
        adGroupId: row.adGroupId || current.adGroupId,
        criterionId: row.criterionId || current.criterionId,
        resourceName: row.resourceName || current.resourceName,
        keywordText: row.keywordText || row.keyword || current.keywordText,
        keyword: row.keyword || row.keywordText || current.keywordText,
        matchType: row.matchType || current.matchType,
        status: row.status || current.status,
        finalUrl: row.finalUrl ?? current.finalUrl ?? ''
    };
}

function normalizedKeywordPrimaryStatusReason(value) {
    return String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function isKeywordFromRemovedAdGroup(row) {
    return (Array.isArray(row?.primaryStatusReasons) ? row.primaryStatusReasons : [])
        .some(reason => normalizedKeywordPrimaryStatusReason(reason) === 'AD_GROUP_REMOVED');
}

function setupKeywordVisibilityControls() {
    try {
        showRemovedAdGroupKeywords = localStorage.getItem(SHOW_REMOVED_AD_GROUP_KEYWORDS_KEY) === 'true';
    } catch {
        showRemovedAdGroupKeywords = false;
    }
    const checkbox = document.getElementById('showRemovedAdGroupKeywords');
    if (checkbox) checkbox.checked = showRemovedAdGroupKeywords;
}

function setShowRemovedAdGroupKeywords(checked) {
    showRemovedAdGroupKeywords = Boolean(checked);
    try {
        localStorage.setItem(SHOW_REMOVED_AD_GROUP_KEYWORDS_KEY, String(showRemovedAdGroupKeywords));
    } catch {
        // Filtering still works when browser storage is unavailable.
    }
    const checkbox = document.getElementById('showRemovedAdGroupKeywords');
    if (checkbox && checkbox.checked !== showRemovedAdGroupKeywords) checkbox.checked = showRemovedAdGroupKeywords;
    const grid = gridInstances['grid-allKeywords'];
    if (grid && typeof grid.onFilterChanged === 'function') grid.onFilterChanged();
}

function negativeManagementRow(row) {
    const current = findNegativeControlRow(row) || {};
    const scope = negativeScopeFromRow(row);
    const campaignId = row.campaignId || current.campaignId || current.campaign_id;
    const adGroupId = row.adGroupId || current.adGroupId || current.ad_group_id;
    const sharedSetId = row.sharedSetId || String(row.sharedSetResourceName || '').split('/').pop() || null;
    const criterionId = row.criterionId || current.criterionId || current.criterion_id;
    const ownerId = scope === 'campaign' ? campaignId : scope === 'ad_group' ? adGroupId : sharedSetId;
    const collection = scope === 'campaign' ? 'campaignCriteria' : scope === 'ad_group' ? 'adGroupCriteria' : 'sharedCriteria';
    const resourceName = row.resourceName || current.resourceName || (ownerId && criterionId && dashboardData?.meta?.accountId
        ? `customers/${String(dashboardData.meta.accountId).replace(/-/g, '')}/${collection}/${ownerId}~${criterionId}`
        : null);
    return {
        ...row,
        scope,
        campaignId,
        adGroupId,
        sharedSetId,
        criterionId,
        resourceName,
        keywordText: row.keywordText || row.keyword || current.keywordText || current.keyword_text,
        keyword: row.keyword || row.keywordText || current.keywordText || current.keyword_text,
        matchType: row.matchType || current.matchType || current.match_type,
        status: row.status || current.status || (scope === 'shared_list' || scope === 'account' ? 'ENABLED' : null)
    };
}

function managementEditButton(kind, mode, key, label) {
    return `<button class="keyword-editable-cell__button" type="button" title="${esc(label)}" aria-label="${esc(label)}"
        data-management-key="${esc(key)}" onclick="openKeywordInlineEditor(event, '${kind}', '${mode}', this.dataset.managementKey)">${iconSvg('pencil')}</button>`;
}

function renderKeywordDefinitionCell(row, kind = 'keyword') {
    const key = kind === 'keyword' ? keywordManagementKey(row) : negativeManagementKey(row);
    const text = row.keywordText || row.keyword || '';
    return `<div class="keyword-editable-cell">
        <span class="keyword-editable-cell__value" title="${esc(text)}">${esc(text)}</span>
        ${managementEditButton(kind, 'definition', key, `Edit ${kind === 'keyword' ? 'keyword' : 'negative keyword'}`)}
    </div>`;
}

function renderKeywordMatchCell(row, kind = 'keyword') {
    const key = kind === 'keyword' ? keywordManagementKey(row) : negativeManagementKey(row);
    return `<div class="keyword-editable-cell">
        <span class="keyword-editable-cell__value">${esc(formatMatchType(row.matchType))}</span>
        ${managementEditButton(kind, 'match', key, 'Change match type')}
    </div>`;
}

function renderKeywordFinalUrlCell(row) {
    const key = keywordManagementKey(row);
    const url = String(row.finalUrl || '');
    const value = url ? `<a href="${esc(url)}" target="_blank" rel="noopener" class="table-link">${esc(url)}</a>` : '<span class="keyword-editable-cell__value">Not set</span>';
    return `<div class="keyword-editable-cell">${value}${managementEditButton('keyword', 'url', key, 'Edit final URL')}</div>`;
}

function renderKeywordStatusCell(row) {
    const normalized = String(row.status || 'UNKNOWN').toUpperCase();
    if (normalized === 'REMOVED') return `<div class="keyword-status-cell"><i class="keyword-status-dot keyword-status-dot--removed"></i><span>Removed</span></div>`;
    const key = keywordManagementKey(row);
    return `<div class="keyword-status-cell">
        <i class="keyword-status-dot keyword-status-dot--${esc(normalized.toLowerCase())}"></i>
        <span>${esc(formatControlStatus(normalized))}</span>
        <button class="keyword-status-button" type="button" aria-label="Change keyword status" title="Change keyword status"
            data-management-key="${esc(key)}" onclick="openKeywordStatusMenu(event, this.dataset.managementKey)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
        </button>
    </div>`;
}

function keywordRowSelectable(row) {
    return Boolean(row?.adGroupId && row?.criterionId && String(row.status || '').toUpperCase() !== 'REMOVED');
}

function negativeRowSelectable(row) {
    const scope = negativeScopeFromRow(row);
    const hasOwner = scope === 'campaign' ? row?.campaignId : scope === 'ad_group' ? row?.adGroupId : row?.sharedSetId;
    return Boolean(scope && hasOwner && row?.criterionId && String(row.status || '').toUpperCase() !== 'REMOVED');
}

function keywordSelectionOptions(kind) {
    const negative = kind === 'negative';
    return {
        rowSelection: {
            mode: 'multiRow',
            checkboxes: params => negative ? negativeRowSelectable(params.data) : keywordRowSelectable(params.data),
            headerCheckbox: true,
            hideDisabledCheckboxes: true,
            enableClickSelection: false,
            selectAll: 'filtered',
            isRowSelectable: params => negative ? negativeRowSelectable(params.data) : keywordRowSelectable(params.data)
        },
        selectionColumnDef: { pinned: 'left', width: 48, minWidth: 48, maxWidth: 48, resizable: false, sortable: false },
        getRowId: params => negative ? negativeManagementKey(params.data) : keywordManagementKey(params.data),
        onSelectionChanged: () => updateKeywordBulkToolbar(negative ? 'negative' : 'keyword'),
        ...(negative ? {} : {
            isExternalFilterPresent: () => !showRemovedAdGroupKeywords,
            doesExternalFilterPass: node => showRemovedAdGroupKeywords || !isKeywordFromRemovedAdGroup(node?.data)
        })
    };
}

function renderTables() {
    const tabId = activeDashboardTab();
    const shouldRenderPerformance = tabId === 'campaigns' || tabId === 'ad-groups';
    const shouldRenderKeywords = tabId === 'keywords';

    // Ad Groups
    if (shouldRenderPerformance && dashboardData.adGroups) {
        initGrid('grid-adGroups', dashboardData.adGroups, [
            { field: 'name', headerName: 'Ad Group', pinned: 'left' },
            { field: 'campaign', headerName: 'Campaign' },
            { field: 'status', headerName: 'Status', minWidth: 170, cellRenderer: p => renderAdGroupStatusCell(p.data) },
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
    if (shouldRenderPerformance && dashboardData.campaigns) {
        initGrid('grid-campaigns', dashboardData.campaigns, [
            { field: 'name', headerName: 'Campaign', pinned: 'left' },
            { field: 'status', headerName: 'Status', minWidth: 170, cellRenderer: p => renderCampaignStatusCell(p.data) },
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
    }

    if (!shouldRenderKeywords) return;

    // Keywords (Configured)
    if (dashboardData.configuredKeywords) {
        keywordManagementRows.clear();
        const managementRows = dashboardData.configuredKeywords.map(keywordManagementRow);
        managementRows.forEach(row => keywordManagementRows.set(keywordManagementKey(row), row));
        initGrid('grid-allKeywords', managementRows, [
            {
                field: 'keyword',
                headerName: 'Keyword',
                pinned: 'left',
                minWidth: 180,
                cellRenderer: p => renderKeywordDefinitionCell(p.data || {})
            },
            { field: 'matchType', headerName: 'Match type', minWidth: 150, cellRenderer: p => renderKeywordMatchCell(p.data || {}) },
            { field: 'status', headerName: 'Status', minWidth: 135, cellRenderer: p => renderKeywordStatusCell(p.data || {}) },
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
            { field: 'configuredKeywordStatus', headerName: 'Coverage Status' },
            { field: 'finalUrl', headerName: 'Final URL', minWidth: 220, keepVisibleWhenEmpty: true, cellRenderer: p => renderKeywordFinalUrlCell(p.data || {}) },
            { field: 'impressions', headerName: 'Impressions', filter: 'agNumberColumnFilter' },
            { field: 'clicks', headerName: 'Clicks', filter: 'agNumberColumnFilter' },
            { field: 'ctr', headerName: 'CTR', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
            { field: 'spend', headerName: 'Cost', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
            { field: 'avgCpc', headerName: 'Cost per Click', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
            { field: 'conversions', headerName: 'Conversions', filter: 'agNumberColumnFilter' },
            { field: 'cvr', headerName: 'Conversion Rate', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
            { field: 'cpa', headerName: 'Cost per Conversion', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' }
        ], keywordSelectionOptions('keyword'));
    }

    // Keywords (Performance)
    if (dashboardData.keywords) {
        initGrid('grid-keywords', dashboardData.keywords, [
            { field: 'keyword', headerName: 'Keyword', pinned: 'left', minWidth: 150 },
            { field: 'status', headerName: 'Status', valueFormatter: p => p.value === 'ENABLED' ? '🟢' : p.value === 'PAUSED' ? '⏸️' : '❌' },
            { field: 'matchType', headerName: 'Match' },
            { field: 'campaign', headerName: 'Campaign' },
            { field: 'adGroup', headerName: 'Ad Group' },
            { field: 'configuredKeywordStatus', headerName: 'Configured Status' },
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
            { field: 'label', headerName: 'Suggestion' },
            { field: 'negativeCoverageKeyword', headerName: 'Negative Cover' }
        ]);
    }

    // Negative Keywords
    if (dashboardData.negatives) {
        negativeManagementRows.clear();
        const managementRows = dashboardData.negatives.map(negativeManagementRow);
        managementRows.forEach(row => negativeManagementRows.set(negativeManagementKey(row), row));
        initGrid('grid-negatives', managementRows, [
            {
                field: 'keyword',
                headerName: 'Negative keyword',
                pinned: 'left',
                minWidth: 180,
                cellRenderer: p => renderKeywordDefinitionCell(p.data || {}, 'negative')
            },
            { field: 'addedTo', headerName: 'Added to' },
            { field: 'level', headerName: 'Level' },
            { field: 'source', headerName: 'Source' },
            { field: 'status', headerName: 'Status' },
            { field: 'campaignName', headerName: 'Campaign' },
            { field: 'matchType', headerName: 'Match type', minWidth: 150, cellRenderer: p => renderKeywordMatchCell(p.data || {}, 'negative') },
            { field: 'sourceStatus', headerName: 'Source Status' },
            { field: 'adGroupName', headerName: 'Ad Group' },
            { field: 'sharedSetName', headerName: 'Shared List' },
            { field: 'activeAttachmentCount', headerName: 'Active Attachments' }
        ], keywordSelectionOptions('negative'));
    }

    // Search Terms
    if (dashboardData.searchTerms) initGrid('grid-searchTerms', dashboardData.searchTerms, [
        { field: 'searchTerm', headerName: 'Search Term', pinned: 'left', minWidth: 180, wrapText: true, autoHeight: true },
        {
            field: 'matchedKeyword',
            headerName: 'Matched Keyword',
            minWidth: 160,
            valueFormatter: p => p.value || 'n/a'
        },
        {
            field: 'keywordMatchType',
            headerName: 'Keyword Match',
            valueFormatter: p => p.value ? String(p.value).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : 'n/a'
        },
        {
            field: 'searchTermMatchType',
            headerName: 'Search Term Match',
            valueFormatter: p => p.value ? String(p.value).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : 'n/a'
        },
        {
            field: 'searchTermMatchSource',
            headerName: 'Match Source',
            headerTooltip: 'How Google matched this search term to your campaign. Examples: ADVERTISER_PROVIDED_KEYWORD, DYNAMIC_SEARCH_ADS, PERFORMANCE_MAX, AI_MAX_BROAD_MATCH, and AI_MAX_KEYWORDLESS. This is a read-only Google Ads field.',
            valueFormatter: p => p.value ? String(p.value).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : 'n/a'
        },
        { field: 'status', headerName: 'Status' },
        { field: 'campaign', headerName: 'Campaign' },
        { field: 'adGroup', headerName: 'Ad Group' },
        { field: 'decisionClassification', headerName: 'Decision' },
        { field: 'configuredKeywordStatus', headerName: 'Configured Status' },
        { field: 'negativeCoverageKeyword', headerName: 'Negative Cover' },
        { field: 'negativeCoverageSource', headerName: 'Negative Source' },
        { field: 'spend', headerName: 'Spend', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'impressions', headerName: 'Impr.', filter: 'agNumberColumnFilter' },
        { field: 'clicks', headerName: 'Clicks', filter: 'agNumberColumnFilter' },
        { field: 'ctr', headerName: 'CTR', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
        { field: 'avgCpc', headerName: 'Avg CPC', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'conversions', headerName: 'Conv.', filter: 'agNumberColumnFilter' },
        { field: 'cvr', headerName: 'CVR', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
        { field: 'cpa', headerName: 'CPA', valueFormatter: params => params.data.conversions > 0 ? fmtCurr(params.value) : 'n/a', filter: 'agNumberColumnFilter' },
        { field: 'avgMonthlySearches', headerName: 'AMS', valueFormatter: nullableNumberFormatter, filter: 'agNumberColumnFilter' },
        { field: 'competition', headerName: 'Competition', valueFormatter: plannerStatusFormatter },
        { field: 'lowBid', headerName: 'Low Bid', valueFormatter: nullableCurrencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'highBid', headerName: 'High Bid', valueFormatter: nullableCurrencyFormatter, filter: 'agNumberColumnFilter' },
        {
            field: 'plannerScore',
            headerName: 'Planner Score',
            headerTooltip: 'Calculated locally from search volume, competition, bid range, intent words, and account performance. Google Ads API does not return this score.',
            filter: 'agNumberColumnFilter',
            sort: 'desc'
        },
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
        const blockedIdeas = ideas.filter(row => row.blockedByNegative || rowNegativeCoverage(row).isNegativeCovered).length;
        const configuredIdeas = ideas.filter(row => row.inAccountKeyword || rowConfiguredCoverage(row).isConfiguredKeyword).length;
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
            { label: 'Already configured', value: fmtNum(configuredIdeas), detail: 'Filtered from fresh add candidates' },
            { label: 'Blocked by negatives', value: fmtNum(blockedIdeas), detail: 'Shown as context only' },
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
        { field: 'blockedByNegative', headerName: 'Blocked' },
        { field: 'plannerClassification', headerName: 'Classification', valueFormatter: plannerStatusFormatter },
        { field: 'configuredKeywordStatus', headerName: 'Configured Status' },
        { field: 'negativeCoverageKeyword', headerName: 'Negative Cover' },
        {
            field: 'source',
            headerName: 'Source',
            headerTooltip: 'Source means which Keyword Planner endpoint produced the row, not a Google Ads account action. "Keyword idea" = generate_ideas endpoint; "Historical metrics" = get_historical_metrics endpoint.',
            valueFormatter: plannerSourceFormatter
        },
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

function qualificationProgressFromLead(lead) {
    return objectValue(lead?.qualificationProgress || lead?.qualification_progress) || {};
}

function qualificationAnswersFromLead(lead) {
    const progress = qualificationProgressFromLead(lead);
    const raw = Array.isArray(lead?.qualificationAnswers)
        ? lead.qualificationAnswers
        : Array.isArray(progress.questionsAndAnswers)
            ? progress.questionsAndAnswers
            : Array.isArray(progress.questions_and_answers)
                ? progress.questions_and_answers
                : [];
    return raw
        .filter(item => item && typeof item === 'object')
        .map(item => ({
            questionId: String(item.questionId || item.question_id || ''),
            question: String(item.question || item.questionId || item.question_id || 'Question'),
            answerId: String(item.answerId || item.answer_id || ''),
            answer: String(item.answer || item.answerId || item.answer_id || 'Answer')
        }));
}

function readableQualificationValue(value) {
    const text = String(value || '').replace(/[_-]+/g, ' ').trim();
    return text ? text.replace(/\b\w/g, character => character.toUpperCase()) : 'Not recorded';
}

function formatQualificationDuration(value) {
    const milliseconds = Number(value || 0);
    return `${fmtNum(Number.isFinite(milliseconds) ? milliseconds : 0)} ms`;
}

function qualificationSafeguardsFromLead(lead) {
    const progress = qualificationProgressFromLead(lead);
    const value = lead && Object.prototype.hasOwnProperty.call(lead, 'qualificationSafeguards')
        ? lead.qualificationSafeguards
        : progress.safeguards;
    return objectValue(value) || {};
}

function safeguardReasonLabel(value) {
    const labels = {
        rushed_clickthrough: 'Rushed click-through',
        inconsistent_answers: 'Inconsistent answers',
        weak_business_detail: 'Weak business detail',
        high_abuse_path: 'High-abuse path',
        personal_use: 'Personal use'
    };
    return labels[String(value || '')] || reasonCodeLabel(value);
}

function challengeStatusLabel(value) {
    const labels = {
        not_required: 'Not required',
        pending: 'Pending',
        passed: 'Passed',
        failed: 'Failed'
    };
    return labels[String(value || '')] || 'Not recorded';
}

function progressStatusLabel(value) {
    const text = String(value || '').replace(/_/g, ' ').trim();
    return text ? text.replace(/\b\w/g, c => c.toUpperCase()) : 'No progress yet';
}

function progressTriggerLabel(value) {
    const labels = {
        identity: 'Contact captured',
        answer: 'Answer saved',
        resume: 'Resumed',
        idle: 'One-minute update',
        exit_attempt: 'Exit attempt',
        safeguard: 'Safeguard update',
        completed: 'Completed',
        final_submit: 'Final submit'
    };
    return labels[String(value || '')] || progressStatusLabel(value);
}

function qualificationDecisionLabel(value) {
    const labels = {
        qualified_now: 'Qualified now',
        qualified_future: 'Qualified for follow-up',
        nurture_only: 'Nurture only',
        rejected: 'Not a fit'
    };
    return labels[String(value || '')] || progressStatusLabel(value);
}

function reasonCodeLabel(value) {
    const text = String(value || '').replace(/_/g, ' ').trim();
    return text ? text.replace(/\b\w/g, c => c.toUpperCase()) : 'Not recorded';
}

function normalizedLeadViewRow(lead) {
    const attribution = lead.attribution || {};
    const contact = lead.contact || {};
    const campaign = lead.campaign || {};
    const status = normalizeLeadStatus(lead.status);
    const qualificationProgress = qualificationProgressFromLead(lead);
    const qualificationAnswers = qualificationAnswersFromLead(lead);
    const qualificationSafeguards = qualificationSafeguardsFromLead(lead);
    const safeguardReasonCodes = Array.isArray(qualificationSafeguards.reasonCodes)
        ? qualificationSafeguards.reasonCodes
        : [];
    const typedChallenge = objectValue(qualificationSafeguards.typedChallenge) || {};
    const typedChallengeReasonCodes = Array.isArray(typedChallenge.reasonCodes)
        ? typedChallenge.reasonCodes
        : [];
    const progressAnsweredCount = Number(lead.progressAnsweredCount ?? qualificationProgress.answeredCount ?? qualificationAnswers.length);
    const progressStatus = String(lead.progressStatus || qualificationProgress.status || '').trim();
    const progressTrigger = String(lead.progressTrigger || qualificationProgress.trigger || '').trim();
    const progressUpdatedAt = qualificationProgress.progressUpdatedAt || qualificationProgress.progress_updated_at || '';
    const leadActions = Array.isArray(lead.leadActions) ? lead.leadActions : null;
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
        utmCampaign: campaign.utmCampaign || attribution.utm_campaign || '',
        clickId: clickIdSummary(attribution),
        clickIdReady: Boolean(lead.hasClickId),
        offlineReadyLabel: lead.offlineConversionReady ? 'Ready for offline upload' : 'Not uploadable yet',
        leadSourceLabel: lead.leadSource || lead.leadSourceKind
            ? leadSourceLabel(lead.leadSource || lead.leadSourceKind)
            : 'Source unavailable',
        leadActions,
        actionPathLabel: formatLeadActionSummary(leadActions, lead.actionPath),
        qualificationProgress,
        qualificationAnswers,
        qualificationSafeguards,
        safeguardReasonCodes,
        typedChallengeStatus: typedChallenge.status || '',
        typedChallengeReasonCodes,
        safeguardSummary: [
            ...safeguardReasonCodes.map(safeguardReasonLabel),
            typedChallenge.status && typedChallenge.status !== 'not_required'
                ? `Challenge ${challengeStatusLabel(typedChallenge.status)}`
                : ''
        ].filter(Boolean).join(' · ') || 'None detected',
        progressStatus,
        progressTrigger,
        progressRevision: lead.progressRevision ?? qualificationProgress.revision ?? null,
        progressAnsweredCount,
        progressUpdatedAt,
        progressUpdatedAtLabel: formatDateTime(progressUpdatedAt),
        qualificationDecision: qualificationProgress.decision || '',
        qualificationReasonCode: qualificationProgress.reasonCode || qualificationProgress.reason_code || '',
        qualificationProgressSummary: progressStatus
            ? `${progressStatusLabel(progressStatus)} · ${progressAnsweredCount} answer${progressAnsweredCount === 1 ? '' : 's'}`
            : 'No qualification progress',
        lastSeenLabel: formatDateTime(lead.lastSeen),
        firstSeenLabel: formatDateTime(lead.firstSeen),
        firstSeenIst: lead.firstSeenIst || formatDateTimeIst(lead.firstSeen),
        pendingSync: lead.pendingSync === true,
        updatedAt: lead.updatedAt || null
    };
}

function leadViewRows(leadAttribution) {
    return (leadAttribution?.recentLeads || []).map(normalizedLeadViewRow);
}

function setupLeadReviewViewControls() {
    const buttons = document.querySelectorAll('[data-lead-review-view]');
    if (!buttons.length) return;

    const savedMode = localStorage.getItem(LEAD_REVIEW_VIEW_STORAGE_KEY);
    leadReviewViewMode = savedMode === 'kanban' ? 'kanban' : 'table';

    buttons.forEach(button => {
        button.addEventListener('click', () => {
            setLeadReviewViewMode(button.dataset.leadReviewView || 'table');
        });
    });

    const searchInput = document.querySelector('.table-search[data-target="grid-leadReview"]');
    searchInput?.addEventListener('input', () => renderLeadReviewKanban());

    let resizeFrame = null;
    window.addEventListener('resize', () => {
        if (resizeFrame) cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(() => {
            resizeFrame = null;
            setLeadReviewViewMode(leadReviewViewMode, { persist: false });
        });
    });

    setLeadReviewViewMode(leadReviewViewMode, { persist: false });
}

function setLeadReviewViewMode(mode, options = {}) {
    const normalizedMode = mode === 'kanban' ? 'kanban' : 'table';
    const isDesktop = window.matchMedia('(min-width: 769px)').matches;
    const showKanban = normalizedMode === 'kanban' && isDesktop;
    const tableView = document.getElementById('leadReviewTableView');
    const kanbanView = document.getElementById('leadReviewKanban');
    const card = tableView?.closest('.card') || kanbanView?.closest('.card');

    leadReviewViewMode = normalizedMode;
    if (options.persist !== false) {
        localStorage.setItem(LEAD_REVIEW_VIEW_STORAGE_KEY, normalizedMode);
    }

    if (tableView) tableView.hidden = showKanban;
    if (kanbanView) kanbanView.hidden = !showKanban;
    card?.classList.toggle('lead-review-card--kanban', showKanban);

    document.querySelectorAll('[data-lead-review-view]').forEach(button => {
        const active = button.dataset.leadReviewView === normalizedMode;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });

    if (showKanban) renderLeadReviewKanban();
}

function leadReviewSearchMatches(row, query) {
    const needle = String(query || '').trim().toLocaleLowerCase();
    if (!needle) return true;
    const haystack = [
        row.name,
        row.leadName,
        row.email,
        row.phone,
        row.leadId,
        row.sessionKey,
        row.campaignName,
        row.campaignId,
        row.utmCampaign,
        row.keyword,
        row.searchTerm,
        row.matchType,
        row.leadSourceLabel,
        row.actionPathLabel,
        row.qualificationProgressSummary,
        row.safeguardSummary,
        leadStatusLabel(row.status),
        leadStatusLabel(row.status, true)
    ].filter(Boolean).join(' ').toLocaleLowerCase();
    return haystack.includes(needle);
}

function leadReviewInitials(row) {
    const value = String(row.name || row.leadName || row.email || 'Lead').trim();
    const words = value.split(/\s+/).filter(Boolean);
    if (words.length > 1) return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
    return value.slice(0, 2).toUpperCase();
}

function renderLeadReviewKanbanCard(row) {
    const status = normalizeLeadStatus(row.status);
    const meta = leadStatusMeta(status);
    const displayName = row.name || row.leadName || 'Unnamed lead';
    const campaign = row.campaignName || row.utmCampaign || row.campaignId || 'Campaign unavailable';
    const keyword = row.keyword || row.searchTerm || 'Keyword unavailable';
    const action = row.actionPathLabel || 'No lead action recorded';
    const canDrag = Boolean(row.sessionKey) && !row.pendingSync;
    const safeguardCount = Array.isArray(row.safeguardReasonCodes) ? row.safeguardReasonCodes.length : 0;
    const hasQualification = Boolean(row.progressStatus || row.progressAnsweredCount || row.progressRevision);
    const qualificationButton = hasQualification
        ? `<button type="button" class="lead-kanban-detail-btn" onclick="event.stopPropagation(); showLeadProgress(${jsArg(row.sessionKey)})">
                ${esc(row.progressAnsweredCount || 0)} answer${Number(row.progressAnsweredCount || 0) === 1 ? '' : 's'}
           </button>`
        : '<span class="lead-kanban-muted">No qualification</span>';

    return `
        <article class="lead-kanban-card" data-lead-session-key="${esc(row.sessionKey || '')}"
            data-lead-status="${esc(status)}" draggable="${canDrag ? 'true' : 'false'}"
            style="--lead-kanban-accent:${esc(meta.color)}"
            aria-label="${esc(`${displayName}, ${meta.label}`)}">
            <div class="lead-kanban-card-accent"></div>
            <div class="lead-kanban-card-body">
                <div class="lead-kanban-card-header">
                    <span class="lead-kanban-avatar" aria-hidden="true">${esc(leadReviewInitials(row))}</span>
                    <div class="lead-kanban-card-identity">
                        <strong title="${esc(displayName)}">${esc(displayName)}</strong>
                        <span>${esc(row.firstSeenIst || row.firstSeenLabel || 'Time unavailable')}</span>
                    </div>
                    ${canDrag ? `
                        <span class="lead-kanban-drag-handle" title="Drag to another status" aria-hidden="true">
                            <i></i><i></i><i></i><i></i><i></i><i></i>
                        </span>
                    ` : ''}
                </div>

                <div class="lead-kanban-contact-list">
                    <span title="${esc(row.email || 'Email unavailable')}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                            <rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="m3 7 9 6 9-6"></path>
                        </svg>
                        ${esc(row.email || 'Email unavailable')}
                    </span>
                    <span title="${esc(row.phone || 'Phone unavailable')}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.78.62 2.63a2 2 0 0 1-.45 2.11L8 9.73a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.85.29 1.73.5 2.63.62A2 2 0 0 1 22 16.92z"></path>
                        </svg>
                        ${esc(row.phone || 'Phone unavailable')}
                    </span>
                </div>

                <div class="lead-kanban-source-block">
                    <span>Campaign</span>
                    <strong title="${esc(campaign)}">${esc(campaign)}</strong>
                    <span>Keyword${row.matchType ? ` · ${esc(row.matchType)}` : ''}</span>
                    <strong title="${esc(keyword)}">${esc(keyword)}</strong>
                </div>

                <div class="lead-kanban-action" title="${esc(action)}">
                    <span>Source</span>
                    <strong>${esc(row.leadSourceLabel || 'Source unavailable')}</strong>
                    <span>Activity</span>
                    <strong>${esc(action)}</strong>
                </div>

                <div class="lead-kanban-card-flags">
                    ${qualificationButton}
                    ${safeguardCount > 0 ? `<span class="lead-kanban-risk-badge">${fmtNum(safeguardCount)} safeguard${safeguardCount === 1 ? '' : 's'}</span>` : ''}
                    ${row.pendingSync ? '<span class="pending-sync-label">Pending sync</span>' : ''}
                </div>

                <div class="lead-kanban-card-footer">
                    <div class="lead-kanban-status-control">${renderLeadStatusCell(row)}</div>
                    <span class="lead-kanban-event-count" title="Captured form events">
                        ${fmtNum(row.eventCount || 0)} form event${Number(row.eventCount || 0) === 1 ? '' : 's'}
                    </span>
                </div>
            </div>
        </article>
    `;
}

function renderLeadReviewKanban() {
    const container = document.getElementById('leadReviewKanban');
    if (!container) return;
    const searchInput = document.querySelector('.table-search[data-target="grid-leadReview"]');
    const query = String(searchInput?.value || '');
    const rows = leadReviewRowsForView.filter(row => leadReviewSearchMatches(row, query));

    container.innerHTML = `
        <div class="lead-kanban-toolbar">
            <div>
                <strong>${fmtNum(rows.length)} lead${rows.length === 1 ? '' : 's'}</strong>
                <span>${query.trim() ? `matching “${esc(query.trim())}”` : 'grouped by current status'}</span>
            </div>
            <p>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path d="M8 9h8M8 15h8"></path><path d="m15 6 3 3-3 3"></path><path d="m9 12-3 3 3 3"></path>
                </svg>
                Drag a card to update its status
            </p>
        </div>
        <div class="lead-kanban-board">
            ${LEAD_REVIEW_KANBAN_STATUS_ORDER.map(status => {
        const meta = leadStatusMeta(status);
        const statusRows = rows.filter(row => normalizeLeadStatus(row.status) === status);
        const canDrop = status !== 'new';
        return `
                    <section class="lead-kanban-column ${canDrop ? '' : 'lead-kanban-column--review'}"
                        data-lead-drop-status="${esc(status)}" data-lead-drop-enabled="${String(canDrop)}"
                        style="--lead-kanban-accent:${esc(meta.color)}">
                        <header class="lead-kanban-column-header">
                            <span class="lead-kanban-column-dot" aria-hidden="true"></span>
                            <div>
                                <strong>${esc(meta.shortLabel)}</strong>
                                <span>${esc(meta.description)}</span>
                            </div>
                            <b>${fmtNum(statusRows.length)}</b>
                        </header>
                        <div class="lead-kanban-column-cards">
                            ${statusRows.map(renderLeadReviewKanbanCard).join('') || `
                                <div class="lead-kanban-empty">
                                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
                                        <rect x="4" y="3" width="16" height="18" rx="2"></rect><path d="M8 8h8M8 12h5"></path>
                                    </svg>
                                    <span>No leads here</span>
                                </div>
                            `}
                        </div>
                    </section>
                `;
    }).join('')}
        </div>
    `;

    bindLeadReviewKanbanInteractions(container);
}

function clearLeadReviewDropState(container) {
    container.querySelectorAll('.lead-kanban-column.is-drop-target').forEach(column => {
        column.classList.remove('is-drop-target');
    });
}

function bindLeadReviewKanbanInteractions(container) {
    container.querySelectorAll('.lead-kanban-card[draggable="true"]').forEach(card => {
        card.addEventListener('dragstart', event => {
            draggedLeadReviewSessionKey = card.dataset.leadSessionKey || '';
            if (!draggedLeadReviewSessionKey) {
                event.preventDefault();
                return;
            }
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', draggedLeadReviewSessionKey);
            requestAnimationFrame(() => card.classList.add('is-dragging'));
        });
        card.addEventListener('dragend', () => {
            draggedLeadReviewSessionKey = '';
            card.classList.remove('is-dragging');
            clearLeadReviewDropState(container);
        });
    });

    container.querySelectorAll('.lead-kanban-card select, .lead-kanban-card button').forEach(control => {
        control.setAttribute('draggable', 'false');
        control.addEventListener('dragstart', event => event.stopPropagation());
    });

    container.querySelectorAll('[data-lead-drop-status]').forEach(column => {
        const targetStatus = normalizeLeadStatus(column.dataset.leadDropStatus);
        const canDrop = column.dataset.leadDropEnabled === 'true';
        column.addEventListener('dragover', event => {
            if (!canDrop || !draggedLeadReviewSessionKey) return;
            const row = leadReviewRowsForView.find(item => String(item.sessionKey) === draggedLeadReviewSessionKey);
            if (!row || normalizeLeadStatus(row.status) === targetStatus) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            clearLeadReviewDropState(container);
            column.classList.add('is-drop-target');
        });
        column.addEventListener('dragleave', event => {
            if (!column.contains(event.relatedTarget)) column.classList.remove('is-drop-target');
        });
        column.addEventListener('drop', event => {
            event.preventDefault();
            const sessionKey = event.dataTransfer.getData('text/plain') || draggedLeadReviewSessionKey;
            draggedLeadReviewSessionKey = '';
            clearLeadReviewDropState(container);
            if (!canDrop || !sessionKey) return;
            void moveLeadReviewKanbanCard(sessionKey, targetStatus);
        });
    });
}

async function moveLeadReviewKanbanCard(sessionKey, status) {
    const row = leadReviewRowsForView.find(item => String(item.sessionKey) === String(sessionKey));
    if (!row || normalizeLeadStatus(row.status) === status) return;
    if (status === 'new') {
        showToast('Needs review is the initial status and cannot be set manually.', true);
        return;
    }
    const card = Array.from(document.querySelectorAll('.lead-kanban-card')).find(item => (
        item.dataset.leadSessionKey === String(sessionKey)
    ));
    card?.classList.add('is-updating');
    const result = await window.updateLeadStatus(sessionKey, status, row.updatedAt || null);
    if (!['updated', 'queued'].includes(result)) card?.classList.remove('is-updating');
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
    if (lead.utmCampaign && lead.utmCampaign !== lead.campaignId) rows.push(`UTM campaign: ${lead.utmCampaign}`);
    else if (lead.campaignName && lead.campaignId) rows.push(`Campaign ID: ${lead.campaignId}`);
    return `
        <div class="lead-source-cell">
            ${rows.map((row, index) => index === 0
        ? `<strong>${esc(row)}</strong>`
        : `<span>${esc(row)}</span>`).join('')}
        </div>
    `;
}

function renderLeadQualificationCell(lead) {
    const answers = qualificationAnswersFromLead(lead);
    const hasProgress = Boolean(lead?.progressStatus || answers.length || lead?.progressRevision);
    if (!hasProgress) return '<span class="lead-field-missing">No qualification progress</span>';
    const count = lead.progressAnsweredCount || answers.length || 0;
    const countText = count === 1 ? '1 answer' : `${count} answers`;
    const actionText = count > 0 ? `View ${countText}` : 'No answers yet';
    return `
        <div class="lead-progress-cell clickable-qualification-cell" onclick="showLeadProgress(${jsArg(lead.sessionKey)})">
            <strong>${esc(progressStatusLabel(lead.progressStatus))}</strong>
            <span class="lead-progress-action-link">${esc(actionText)}</span>
        </div>
    `;
}

function renderSafeguardBadge(value, kind = 'reason') {
    const label = kind === 'status' ? challengeStatusLabel(value) : safeguardReasonLabel(value);
    return `<span class="lead-safeguard-badge lead-safeguard-badge--${esc(String(value || 'none'))}">${esc(label)}</span>`;
}

function renderLeadSafeguardsCell(lead) {
    const reasons = Array.isArray(lead?.safeguardReasonCodes) ? lead.safeguardReasonCodes : [];
    const status = String(lead?.typedChallengeStatus || '');
    if (!reasons.length && (!status || status === 'not_required')) {
        return '<span class="lead-field-missing">None detected</span>';
    }
    return `
        <div class="lead-safeguard-cell">
            ${status && status !== 'not_required' ? renderSafeguardBadge(status, 'status') : ''}
            ${reasons.map(reason => renderSafeguardBadge(reason)).join('')}
        </div>
    `;
}

window.showLeadProgress = function (sessionKey) {
    const lead = leadProgressDetailsBySession.get(String(sessionKey || ''));
    if (!lead) {
        showToast('Qualification progress is not available for this lead.', true);
        return;
    }
    const answers = Array.isArray(lead.qualificationAnswers) ? lead.qualificationAnswers : [];
    const safeguards = qualificationSafeguardsFromLead(lead);
    const reasons = Array.isArray(safeguards.reasonCodes) ? safeguards.reasonCodes : [];
    const challenge = objectValue(safeguards.typedChallenge) || {};
    const challengeReasons = Array.isArray(challenge.reasonCodes) ? challenge.reasonCodes : [];
    const timing = objectValue(safeguards.timing) || {};
    const timingSamples = Array.isArray(timing.samples) ? timing.samples : [];
    const answerDetailsById = new Map(
        answers
            .filter(answer => answer.answerId)
            .map(answer => [String(answer.answerId), answer])
    );
    const leadActions = Array.isArray(lead.leadActions) ? lead.leadActions : [];
    const earlyClickCount = Number(timing.earlyClickAttemptCount || 0);
    const fastAnswerCount = Number(timing.fastAnswerCount || 0);
    const timedAnswerCount = Number(timing.timedAnswerCount || 0);
    const evaluatedAnswerCount = timing.evaluatedFlowAnswerCount == null
        ? null
        : Number(timing.evaluatedFlowAnswerCount);
    const evaluatedReadingTime = timing.evaluatedFlowReadingTimeMs == null
        ? null
        : Number(timing.evaluatedFlowReadingTimeMs);
    const evaluatedThreshold = timing.evaluatedFlowThresholdMs == null
        ? null
        : Number(timing.evaluatedFlowThresholdMs);
    const hasEvaluatedSpeed = evaluatedAnswerCount != null
        && evaluatedReadingTime != null
        && evaluatedThreshold != null;
    const rushed = reasons.includes('rushed_clickthrough');
    const rushedReasons = [];
    if (earlyClickCount >= 2) rushedReasons.push(`${fmtNum(earlyClickCount)} early clicks`);
    if (fastAnswerCount >= 4) rushedReasons.push(`${fmtNum(fastAnswerCount)} fast answers`);
    if (hasEvaluatedSpeed && evaluatedReadingTime < evaluatedThreshold) {
        rushedReasons.push(`${formatQualificationDuration(evaluatedReadingTime)} reading, below ${formatQualificationDuration(evaluatedThreshold)}`);
    }
    if (rushed && !rushedReasons.length) rushedReasons.push('rushing safeguard triggered');
    const firstSixReadingLabel = timing.firstSixReadingTimeMs == null
        ? `${fmtNum(Math.min(timedAnswerCount, 6))} of 6 recorded`
        : `${formatQualificationDuration(timing.firstSixReadingTimeMs)} across 6 answers`;
    const speedCheckLabel = hasEvaluatedSpeed
        ? `${formatQualificationDuration(evaluatedReadingTime)} across ${fmtNum(evaluatedAnswerCount)} answers; minimum ${formatQualificationDuration(evaluatedThreshold)} — ${evaluatedReadingTime < evaluatedThreshold ? 'rushed' : 'passed'}`
        : 'Pending qualification completion';
    const rushedResultLabel = rushed
        ? `Yes — ${rushedReasons.join('; ')}`
        : (hasEvaluatedSpeed ? 'No — no rushing threshold was triggered' : 'No rushed signal recorded');
    let modal = document.getElementById('leadProgressModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'leadProgressModal';
        modal.className = 'modal-overlay';
        document.body.appendChild(modal);
    }
    modal.innerHTML = `
        <div class="modal-content-card lead-progress-modal">
            <div class="modal-header">
                <h3>Lead Qualification Answers</h3>
                <button class="modal-close-btn" onclick="closeLeadProgressModal()" aria-label="Close modal">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            </div>
            <div class="modal-body lead-progress-modal-body">
                <div class="lead-progress-summary">
                    <div><span>Lead</span><strong>${esc(lead.leadName || lead.name || 'Unknown lead')}</strong></div>
                    <div><span>Lead status</span><strong>${esc(leadStatusLabel(lead.status, true))}</strong></div>
                    <div><span>Lead source</span><strong>${esc(lead.leadSourceLabel || 'Source unavailable')}</strong></div>
                    <div><span>Form activity</span><strong>${esc(lead.actionPathLabel || 'No form submitted')}</strong></div>
                    <div><span>Form progress</span><strong>${esc(progressStatusLabel(lead.progressStatus))}</strong></div>
                    <div><span>Last update</span><strong>${esc(lead.progressUpdatedAtLabel || 'Not recorded')}</strong></div>
                    <div><span>Decision</span><strong>${esc(qualificationDecisionLabel(lead.qualificationDecision))}</strong></div>
                    <div><span>Reason</span><strong>${esc(reasonCodeLabel(lead.qualificationReasonCode))}</strong></div>
                    <div><span>Answers</span><strong>${fmtNum(answers.length)}</strong></div>
                    <div><span>Typed challenge</span><strong>${esc(challengeStatusLabel(challenge.status))}</strong></div>
                    <div><span>Weak attempts</span><strong>${esc(String(challenge.failedAttempts ?? 0))}</strong></div>
                </div>
                <section class="lead-safeguard-section">
                    <h4>Captured form events</h4>
                    <div class="lead-form-event-list">
                        ${leadActions.map((action, index) => `
                            <div class="lead-form-event-row">
                                <span class="lead-timing-sample-number">${esc(String(index + 1))}</span>
                                <div>
                                    <strong>${esc(actionKindLabel(action.kind))}</strong>
                                    <span>${esc(formatDateTime(action.submittedAt || action.receivedAt))}</span>
                                </div>
                                <code title="${esc(String(action.eventId || 'Event ID unavailable'))}">${esc(action.eventId ? shortId(action.eventId) : 'ID unavailable')}</code>
                            </div>
                        `).join('') || '<div class="lead-progress-empty">No form submission event was captured.</div>'}
                    </div>
                </section>
                <section class="lead-safeguard-section">
                    <h4>Qualification safeguards</h4>
                    <div class="lead-safeguard-cell">
                        ${reasons.map(reason => renderSafeguardBadge(reason)).join('') || '<span class="lead-field-missing">No safeguard reasons recorded</span>'}
                    </div>
                    <div class="lead-safeguard-challenge-reasons">
                        <span>Challenge reasons</span>
                        <strong>${esc(challengeReasons.length ? challengeReasons.map(safeguardReasonLabel).join(', ') : 'None')}</strong>
                    </div>
                </section>
                <section class="lead-safeguard-section">
                    <h4>Timing summary</h4>
                    <div class="lead-progress-summary lead-safeguard-timing-summary">
                        <div><span>Early clicks</span><strong>${esc(fmtNum(earlyClickCount))}</strong></div>
                        <div><span>Fast answers</span><strong>${esc(fmtNum(fastAnswerCount))}</strong></div>
                        <div><span>Timed answers</span><strong>${esc(fmtNum(timedAnswerCount))}</strong></div>
                        <div><span>First 6 answers</span><strong>${esc(firstSixReadingLabel)}</strong></div>
                        <div class="lead-speed-check-card"><span>Flow speed check</span><strong>${esc(speedCheckLabel)}</strong></div>
                        <div><span>Rushed below</span><strong>${esc(rushedResultLabel)}</strong></div>
                        <div><span>Total reading</span><strong>${esc(formatQualificationDuration(timing.totalReadingTimeMs))}</strong></div>
                        <div><span>Excluded transitions</span><strong>${esc(formatQualificationDuration(timing.totalTransitionTimeMs))}</strong></div>
                    </div>
                    <div class="lead-timing-sample-list">
                        ${timingSamples.map((sample, index) => {
        const answerDetail = answerDetailsById.get(String(sample.answerId || ''));
        const questionLabel = answerDetail?.question || readableQualificationValue(sample.questionId);
        const answerLabelHtml = answerDetail?.answer
            ? esc(answerDetail.answer)
            : `${esc(`Answer: ${sample.answerId || ''}`)}`;
        return `
                            <div class="lead-timing-sample-row">
                                <div class="lead-timing-sample-copy">
                                    <span class="lead-timing-sample-number">${esc(String(sample.sequence ?? index + 1))}</span>
                                    <div>
                                        <strong>${esc(questionLabel)}</strong>
                                        <span>${answerLabelHtml}</span>
                                    </div>
                                </div>
                                <div class="lead-timing-sample-metrics">
                                    <div>
                                        <span>Reading</span>
                                        <strong>${esc(formatQualificationDuration(sample.readingTimeMs))}</strong>
                                    </div>
                                    <div>
                                        <span>Transition excluded</span>
                                        <strong>${esc(formatQualificationDuration(sample.transitionTimeMs))}</strong>
                                    </div>
                                    <div>
                                        <span>Early clicks</span>
                                        <strong>${esc(String(sample.earlyClickAttempts ?? 0))}</strong>
                                    </div>
                                </div>
                            </div>
                        `;
    }).join('') || '<div class="lead-progress-empty">No option timing samples recorded.</div>'}
                    </div>
                </section>
                <div class="lead-progress-answer-list">
                    ${answers.map((answer, index) => `
                        <div class="lead-progress-answer-row">
                            <span>${fmtNum(index + 1)}</span>
                            <div>
                                <small>Question</small>
                                <strong>${esc(answer.question)}</strong>
                                <small>Answer</small>
                                <p>${esc(answer.answer)}</p>
                            </div>
                        </div>
                    `).join('') || '<div class="lead-progress-empty">No answers have been captured for this lead yet.</div>'}
                </div>
            </div>
        </div>
    `;
    modal.classList.add('show');
};

window.closeLeadProgressModal = function () {
    const modal = document.getElementById('leadProgressModal');
    if (modal) modal.classList.remove('show');
};

function renderLeadStatusCell(lead) {
    const normalized = normalizeLeadStatus(lead?.status);
    const actions = [
        ['new', 'Needs review'],
        ['useless', 'Junk'],
        ['maybe', 'Maybe'],
        ['qualified', 'Qualified'],
        ['converted', 'Won'],
        ['qualified_lost', 'Lost']
    ];
    return `
        ${lead?.pendingSync ? '<div class="pending-sync-label">Pending sync</div>' : ''}
        <select
            class="lead-status-select lead-status-chip lead-status-chip--${statusClass(normalized)}"
            aria-label="Change lead status"
            data-current="${esc(normalized)}"
            data-base-updated-at="${esc(lead?.updatedAt || '')}"
            onchange="handleLeadStatusChange(this, ${jsArg(lead?.sessionKey)})">
            ${actions.map(([status, label]) => `
                <option value="${esc(status)}" ${normalized === status ? 'selected' : ''} ${status === 'new' ? 'disabled' : ''}>
                    ${esc(label)}
                </option>
            `).join('')}
        </select>
    `;
}

function renderCampaignStatusCell(row) {
    const status = String(row?.status || 'UNKNOWN').toUpperCase();
    const id = row?.id || row?.campaignId || '';
    const statusClass = status === 'ENABLED' ? 'enabled' : status === 'PAUSED' ? 'paused' : 'removed';
    return `<select
        class="ads-status-select ads-status-chip ads-status-chip--${statusClass}"
        aria-label="Change campaign status"
        data-current="${esc(status)}"
        data-entity-id="${esc(String(id))}"
        onchange="handleCampaignStatusChange(this)">
        <option value="ENABLED" ${status === 'ENABLED' ? 'selected' : ''}>\u25CF Enabled</option>
        <option value="PAUSED" ${status === 'PAUSED' ? 'selected' : ''}>\u23F8 Paused</option>
    </select>`;
}

function renderAdGroupStatusCell(row) {
    const campaignId = row?.campaignId || '';
    const parentCampaign = (dashboardData?.campaigns || []).find(c => String(c.id || c.campaignId) === String(campaignId));
    const isCampaignPaused = parentCampaign && String(parentCampaign.status).toUpperCase() === 'PAUSED';

    if (isCampaignPaused) {
        return `<span class="status-chip status-paused" style="width: auto; padding: 0 0.75rem;">Paused</span>`;
    }

    const status = String(row?.status || 'UNKNOWN').toUpperCase();
    const id = row?.id || row?.adGroupId || '';
    const statusClass = status === 'ENABLED' ? 'enabled' : status === 'PAUSED' ? 'paused' : 'removed';
    return `<select
        class="ads-status-select ads-status-chip ads-status-chip--${statusClass}"
        aria-label="Change ad group status"
        data-current="${esc(status)}"
        data-entity-id="${esc(String(id))}"
        onchange="handleAdGroupStatusChange(this)">
        <option value="ENABLED" ${status === 'ENABLED' ? 'selected' : ''}>\u25CF Enabled</option>
        <option value="PAUSED" ${status === 'PAUSED' ? 'selected' : ''}>\u23F8 Paused</option>
    </select>`;
}

window.handleCampaignStatusChange = function (select) {
    const targetStatus = select?.value;
    const previous = select?.dataset?.current || '';
    const entityId = select?.dataset?.entityId || '';
    if (!targetStatus || targetStatus === previous || !entityId) {
        if (select) select.value = previous;
        return;
    }
    select.disabled = true;
    const restore = () => { select.disabled = false; select.value = previous; };
    try {
        previewStatusControl('campaign', entityId, targetStatus);
    } catch (e) {
        restore();
    }
    restore();
};

window.handleAdGroupStatusChange = function (select) {
    const targetStatus = select?.value;
    const previous = select?.dataset?.current || '';
    const entityId = select?.dataset?.entityId || '';
    if (!targetStatus || targetStatus === previous || !entityId) {
        if (select) select.value = previous;
        return;
    }
    select.disabled = true;
    const restore = () => { select.disabled = false; select.value = previous; };
    try {
        previewStatusControl('ad_group', entityId, targetStatus);
    } catch (e) {
        restore();
    }
    restore();
};

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
    const leadAttribution = dashboardData.leadAttribution || {};
    const leadTotals = leadAttribution.totals || { uniqueLeads: 0, eventCount: 0, new: 0, useless: 0, maybe: 0, qualified: 0, qualifiedLost: 0, converted: 0, inProgress: 0, terminal: 0, qualifiedPipeline: 0 };
    const journey = leadAttribution.journeySummary || { totalSessions: 0, sessionsWithMultipleActions: 0, topActionOverlaps: [], topPaths: [], recentJourneys: [] };
    const reviewRows = leadViewRows(leadAttribution);
    leadProgressDetailsBySession.clear();
    reviewRows.forEach(row => {
        if (row.sessionKey) leadProgressDetailsBySession.set(String(row.sessionKey), row);
    });
    const needsReview = Number(leadTotals.new ?? Math.max(Number(leadTotals.uniqueLeads || 0) - Number(leadTotals.terminal || 0) - Number(leadTotals.inProgress || 0), 0));
    const offlineExport = leadAttribution.offlineExport || {};
    const safeguardTotals = leadAttribution.safeguards || {};
    const exportLeads = currentLeadReviewExportLeads();

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
    updateLeadReviewCsvButton(exportLeads);

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
            <div class="insight-item" style="border-color: var(--danger)">
                <h4>Qualification Safeguards</h4>
                <p>${fmtNum(Number(safeguardTotals.pending || 0) + Number(safeguardTotals.failed || 0))} blocked: ${fmtNum(safeguardTotals.rushedClickthrough || 0)} rushed, ${fmtNum(safeguardTotals.inconsistentAnswers || 0)} inconsistent, ${fmtNum(safeguardTotals.weakBusinessDetail || 0)} weak detail, ${fmtNum(safeguardTotals.highAbusePath || 0)} high-abuse. ${fmtNum(safeguardTotals.passed || 0)} passed.</p>
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
        { field: 'leadSourceLabel', headerName: 'Source', minWidth: 180 },
        { field: 'actionPathLabel', headerName: 'Form Activity', minWidth: 220 },
        { field: 'qualificationProgressSummary', headerName: 'Qualification', minWidth: 260, cellRenderer: p => renderLeadQualificationCell(p.data) },
        { field: 'safeguardSummary', headerName: 'Safeguards', minWidth: 300, filter: 'agTextColumnFilter', autoHeight: true, cellClass: 'lead-safeguards-grid-cell', cellRenderer: p => renderLeadSafeguardsCell(p.data) },
        { field: 'eventCount', headerName: 'Form Events', filter: 'agNumberColumnFilter', minWidth: 130 }
    ]);

    initGrid('grid-conversionActions', actions, [
        { field: 'date', headerName: 'Date' },
        { field: 'name', headerName: 'Action', pinned: 'left' },
        { field: 'category', headerName: 'Category' },
        { field: 'status', headerName: 'Status' },
        { field: 'primaryForGoal', headerName: 'Goal', valueFormatter: p => p.value ? '⭐ Primary' : 'Secondary' },
        { field: 'conversions', headerName: 'Conv.', filter: 'agNumberColumnFilter' }
    ]);

    renderClickPathsGrid();

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
        { field: 'eventCount', headerName: 'Form Events', filter: 'agNumberColumnFilter' }
    ]);

    initGrid('grid-leadActionOverlaps', journey.topActionOverlaps || [], [
        { field: 'from', headerName: 'First Action', pinned: 'left', valueFormatter: p => actionKindLabel(p.value) },
        { field: 'to', headerName: 'Repeated Action', valueFormatter: p => actionKindLabel(p.value) },
        { field: 'sessions', headerName: 'Sessions', filter: 'agNumberColumnFilter' },
        { field: 'percentOfFrom', headerName: '% of First Action', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
        { field: 'percentOfAll', headerName: '% of Leads', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' }
    ]);

}

async function handleLeadDeepLink() {
    const params = new URLSearchParams(window.location.search);
    const lead = params.get('lead');
    if (!lead) return;
    try {
        const res = await dashboardFetch(`${API_BASE_GLOBAL}/api/leads/session/${encodeURIComponent(lead)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Lead lookup failed with ${res.status}`);
        // Load and merge the selected attribution slice before inserting the exact
        // deep-linked lead. Otherwise the lazy attribution response can arrive
        // afterward and overwrite a lead that sits outside the current top rows.
        await ensureDashboardViewForTab('attribution', { render: false }).catch(err => {
            console.warn('Could not load the full attribution slice before opening the notification lead.', err);
        });
        dashboardData.leadAttribution = dashboardData.leadAttribution || {};
        const rows = Array.isArray(dashboardData.leadAttribution.recentLeads) ? dashboardData.leadAttribution.recentLeads : [];
        if (!rows.some(row => row.sessionKey === data.lead.sessionKey)) {
            dashboardData.leadAttribution.recentLeads = [data.lead, ...rows].slice(0, 100);
        }
        document.querySelector('.nav-item[data-tab="attribution"]')?.click();
        activateAttributionSubtab('review', false);
        renderAttribution();
        showToast('Opened the lead from the notification.', false);
    } catch (err) {
        console.error(err);
        showToast(`Could not open notification lead: ${err.message}`, true);
    } finally {
        params.delete('lead');
        params.delete('tab');
        const query = params.toString();
        window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
    }
}

window.handleLeadStatusChange = function (select, sessionKey) {
    const status = select?.value;
    const previous = select?.dataset?.current || '';
    if (!status || status === 'new' || status === previous) {
        if (select) select.value = previous;
        return;
    }
    select.disabled = true;
    updateLeadStatus(sessionKey, status, select.dataset.baseUpdatedAt || null).finally(() => {
        select.disabled = false;
        select.value = previous;
    });
};

window.updateLeadStatus = async function (sessionKey, status, baseUpdatedAt = null) {
    const normalized = normalizeLeadStatus(status);
    const label = leadStatusLabel(normalized, true);
    let networkFailed = false;
    try {
        showToast(`Marking lead as ${label}...`, false);
        let res;
        try {
            if (isSessionOffline() && window.ZenseeoOffline) {
                networkFailed = true;
                throw offlineMutationError();
            }
            res = await dashboardFetch(`${API_BASE_GLOBAL}/api/leads/${encodeURIComponent(sessionKey)}/status`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ status: normalized, baseUpdatedAt })
            });
        } catch (err) {
            networkFailed = true;
            throw err;
        }
        const data = await res.json().catch(() => ({}));
        if (res.status === 409) {
            showLeadStatusConflict(sessionKey, normalized, data.conflict || {});
            return 'conflict';
        }
        if (!res.ok) throw new Error(data.error || `Lead update failed with ${res.status}`);

        const generation = beginDashboardLoad();
        const dashboard = await fetchDashboardView('overview');
        if (generation !== dashboardLoadGeneration) return;
        dashboardData = dashboard;
        window.fullData = dashboard;
        resetLoadedDashboardViews('overview');
        const tabId = activeDashboardTab();
        if (dashboardViewForTab(tabId) !== 'overview') {
            await ensureDashboardViewForTab(tabId, { render: false });
        }
        populateGlobalFilters();
        renderDashboardPayload();
        showToast(`Lead marked as ${label}.`, false);
        return 'updated';
    } catch (err) {
        console.error(err);
        if (networkFailed && window.ZenseeoOffline) {
            await window.ZenseeoOffline.queueLeadStatus({ sessionKey, status: normalized, label, baseUpdatedAt });
            applyPendingLeadStatus(sessionKey, normalized);
            showToast(`Lead marked as ${label} offline. It will sync when reconnected.`, false);
            return 'queued';
        }
        showToast(`Lead update failed: ${err.message}`, true);
        return 'failed';
    }
};

function applyPendingLeadStatus(sessionKey, status) {
    const rows = dashboardData?.leadAttribution?.recentLeads || [];
    rows.forEach(row => {
        if (row.sessionKey === sessionKey) {
            row.status = status;
            row.pendingSync = true;
        }
    });
    renderAttribution();
}

function showLeadStatusConflict(sessionKey, offlineStatus, conflict) {
    document.getElementById('leadStatusConflictModal')?.remove();
    const serverStatus = normalizeLeadStatus(conflict.serverStatus);
    const offlineLabel = leadStatusLabel(offlineStatus, true);
    const serverLabel = leadStatusLabel(serverStatus, true);
    pendingLeadStatusConflict = {
        sessionKey,
        offlineStatus,
        serverUpdatedAt: conflict.serverUpdatedAt || null
    };
    const modal = document.createElement('div');
    modal.id = 'leadStatusConflictModal';
    modal.className = 'modal-overlay show';
    modal.innerHTML = `
        <section class="modal-content-card controls-modal schedule-conflict-modal" role="dialog" aria-modal="true"
            aria-labelledby="leadConflictTitle" aria-describedby="leadConflictDescription">
            <div class="modal-header">
                <h3 id="leadConflictTitle">Lead status changed</h3>
                <button type="button" class="modal-close-btn" data-conflict-action="close" aria-label="Close conflict without changing either status">×</button>
            </div>
            <div class="modal-body schedule-conflict-body">
                <p id="leadConflictDescription" class="schedule-conflict-copy">This lead changed on the server after your saved copy. Nothing will be overwritten until you choose.</p>
                <div class="schedule-conflict-item">
                    <div class="schedule-conflict-main"><strong>Server label</strong><span>${esc(serverLabel)}</span></div>
                    <div class="schedule-conflict-main"><strong>Your label</strong><span>${esc(offlineLabel)}</span></div>
                </div>
                <div class="control-actions-row schedule-conflict-actions">
                    <button type="button" class="btn btn-secondary btn-sm" data-conflict-action="keep">Keep server label</button>
                    <button type="button" class="btn btn-primary btn-sm btn-danger-action" data-conflict-action="apply">Apply my label anyway</button>
                </div>
            </div>
        </section>`;
    const close = () => {
        modal.remove();
        pendingLeadStatusConflict = null;
    };
    const resolve = action => {
        const pending = pendingLeadStatusConflict;
        if (!pending) return;
        close();
        if (action === 'apply') {
            updateLeadStatus(pending.sessionKey, pending.offlineStatus, pending.serverUpdatedAt).then(outcome => {
                if (outcome === 'updated' || outcome === 'queued') {
                    window.ZenseeoOffline?.removeConflict?.(pending.sessionKey)
                        .then(() => syncOfflineLeadChanges())
                        .catch(() => undefined);
                }
            });
            return;
        }
        if (action === 'keep') {
            window.ZenseeoOffline?.removeConflict?.(pending.sessionKey)
                .then(() => syncOfflineLeadChanges())
                .catch(() => undefined);
            loadDashboardForCurrentFilters('Refreshing lead status...').catch(err => showToast(err.message, true));
        }
    };
    modal.querySelectorAll('[data-conflict-action]').forEach(button => {
        button.addEventListener('click', () => resolve(button.dataset.conflictAction));
    });
    modal.addEventListener('click', event => {
        if (event.target === modal) close();
    });
    modal.addEventListener('keydown', event => {
        if (event.key === 'Escape') close();
    });
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.querySelector('[data-conflict-action="keep"]')?.focus());
}

function auctionMetricMarkup(row, key) {
    const display = row?.display?.[key] || '—';
    const change = row?.change?.[key];
    const changeMarkup = Number.isFinite(change)
        ? `<small class="auction-change ${change > 0 ? 'is-up' : change < 0 ? 'is-down' : ''}">${change > 0 ? '+' : ''}${fmtNum(change)} pp</small>`
        : '';
    return `<span class="auction-value">${esc(display)}</span>${changeMarkup}`;
}

function auctionHighlightMarkup(rows, key) {
    if (!rows.length) return '<div class="auction-empty compact">No advertisers in this range.</div>';
    return rows.map(row => `
        <div class="auction-highlight-row">
            <span>${esc(row.domain)}</span>
            <div class="auction-highlight-bar"><i style="width:${Math.min(Math.max(Number(row[key] || 0), 0), 100)}%"></i></div>
            <strong>${esc(row.display?.[key] || '—')}</strong>
        </div>
    `).join('');
}

function renderAuctionInsights(auctionInsights) {
    const metaEl = document.getElementById('auctionInsightsMeta');
    const metaTextEl = document.getElementById('auctionInsightsMetaText');
    const metaPopoverEl = document.getElementById('auctionInsightsMetaPopover');
    const accuracyEl = document.getElementById('auctionInsightsAccuracy');
    const tableBody = document.getElementById('auctionInsightsTableBody');
    const absoluteTopEl = document.getElementById('auctionAbsoluteTopList');
    const overlapEl = document.getElementById('auctionOverlapList');
    const movementEl = document.getElementById('auctionMovementList');
    const trendEl = document.getElementById('auctionInsightsTrendChart');
    if (!metaEl || !metaTextEl || !metaPopoverEl || !accuracyEl || !tableBody || !absoluteTopEl || !overlapEl || !movementEl || !trendEl) return;

    const report = auctionInsights && !Array.isArray(auctionInsights) ? auctionInsights : {};
    const rows = Array.isArray(report.rows) ? report.rows : [];
    const meta = report.meta || {};
    const trend = report.trend || { dates: [], series: [] };
    const highlights = report.highlights || { absoluteTop: [], overlap: [], entered: [], exited: [] };
    const statuses = Array.isArray(dashboardData.auctionInsightsStatus) ? dashboardData.auctionInsightsStatus : [];
    const scopeLabel = String(meta.scope?.type || 'selected').replace('_', ' ');
    const observed = meta.observedRange?.start
        ? `${formatDateShort(meta.observedRange.start)}–${formatDateShort(meta.observedRange.end)}`
        : 'no observed dates';
    const requestedRange = meta.requestedRange?.start && meta.requestedRange?.end
        ? `${formatDateShort(meta.requestedRange.start)}–${formatDateShort(meta.requestedRange.end)}`
        : 'the selected dates';
    const observedRange = meta.observedRange?.start && meta.observedRange?.end
        ? `${formatDateShort(meta.observedRange.start)}–${formatDateShort(meta.observedRange.end)}`
        : 'no imported source dates';
    const scopeName = scopeLabel.replace(/\b\w/g, character => character.toUpperCase());
    const scopeId = String(meta.scope?.id || '').trim();
    metaTextEl.textContent = `${scopeLabel} · ${observed} · ${fmtNum(meta.domainCount || 0)} domains`;
    metaPopoverEl.innerHTML = `
        <strong>${esc(scopeName)} scope${scopeId ? ` · ${esc(scopeId)}` : ''}</strong>
        <dl>
            <div><dt>Requested dates</dt><dd>${esc(requestedRange)}</dd></div>
            <div><dt>Available dates</dt><dd>${esc(observedRange)}</dd></div>
        </dl>`;
    accuracyEl.innerHTML = rows.length
        ? `<details class="auction-accuracy-details">
               <summary>Why values can still differ slightly from Google’s unsegmented report</summary>
               <div class="auction-accuracy-explanation">
                   <p>Google calculates its unsegmented date-range report directly from the underlying auctions. This dashboard receives one already-calculated percentage row per day from Google Sheets, then combines those daily rows for the selected range.</p>
                   <ul>
                       <li><strong>Some denominators are unavailable:</strong> the daily export does not include every competitor’s impressions or eligible-auction count. The dashboard uses your selected scope’s daily impressions and inferred auction volume as the best available weights instead of taking a simple average.</li>
                       <li><strong>Google censors small shares:</strong> a value such as &lt;10% only identifies a range, not the exact value. Its midpoint is used internally when a rollup needs an estimate; the UI keeps &lt;10% or adds ≈ and does not show an invented exact change.</li>
                       <li><strong>Source timing and coverage can differ:</strong> this selection requested ${esc(requestedRange)}, while imported Auction Insights rows were observed from ${esc(observedRange)}. Missing source dates are not treated as zero, and Google Ads may contain data newer than the latest Sheet refresh.</li>
                   </ul>
               </div>
           </details>`
        : '';

    if (!rows.length) {
        const message = statuses.find(status => status.status !== 'ok')?.message
            || 'No Auction Insights rows exist for the selected scope and date range.';
        tableBody.innerHTML = `<tr><td colspan="7"><div class="auction-empty"><h4>No Auction Insights loaded</h4><p>${esc(message)}</p></div></td></tr>`;
        absoluteTopEl.innerHTML = overlapEl.innerHTML = movementEl.innerHTML = '<div class="auction-empty compact">No data for this selection.</div>';
        if (charts.auctionInsightsTrend) charts.auctionInsightsTrend.destroy();
        return;
    }

    const metricKeys = ['impressionShare', 'overlapRate', 'positionAboveRate', 'topImpressionRate', 'absoluteTopImpressionRate', 'outrankingShare'];
    tableBody.innerHTML = rows.map(row => `
        <tr class="${row.isYou ? 'is-you' : ''}">
            <th scope="row">${esc(row.domain)}</th>
            ${metricKeys.map(key => `<td>${auctionMetricMarkup(row, key)}</td>`).join('')}
        </tr>
    `).join('');

    absoluteTopEl.innerHTML = auctionHighlightMarkup(highlights.absoluteTop || [], 'absoluteTopImpressionRate');
    overlapEl.innerHTML = auctionHighlightMarkup(highlights.overlap || [], 'overlapRate');
    const entered = (highlights.entered || []).map(domain => `<div class="auction-movement-row"><span>${esc(domain)}</span><strong class="is-entered">Entered</strong></div>`).join('');
    const exited = (highlights.exited || []).map(domain => `<div class="auction-movement-row"><span>${esc(domain)}</span><strong class="is-exited">Exited</strong></div>`).join('');
    movementEl.innerHTML = meta.comparisonAvailable
        ? (entered + exited || '<div class="auction-empty compact">No entrants or exits.</div>')
        : '<div class="auction-empty compact">Comparison is available for ranges of 31 days or less when the previous period has data.</div>';

    if (charts.auctionInsightsTrend) charts.auctionInsightsTrend.destroy();
    const trendColors = ['#f25e36', '#3b82f6', '#22c55e', '#f59e0b', '#ef4444'];
    charts.auctionInsightsTrend = new Chart(trendEl.getContext('2d'), {
        type: 'line',
        data: {
            labels: (trend.dates || []).map(formatDateShort),
            datasets: (trend.series || []).map((item, index) => ({
                label: item.domain,
                data: item.values,
                borderColor: trendColors[index % trendColors.length],
                backgroundColor: trendColors[index % trendColors.length],
                borderWidth: item.isYou ? 3 : 2,
                pointRadius: 2,
                pointHoverRadius: 5,
                tension: 0.25,
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
    const auctionInsights = dashboardData.auctionInsights || {};
    const auctionRows = Array.isArray(auctionInsights.rows) ? auctionInsights.rows : [];
    const auctionStatuses = dashboardData.auctionInsightsStatus || [];
    updateAuctionSettingsCardVisibility();
    const decisionSignals = Array.isArray(dashboardData.candidateSignals) ? dashboardData.candidateSignals : [];
    const signalCount = type => decisionSignals.filter(signal => signal.type === type).length;
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
            <div class="insight-item" style="border-color: ${auctionRows.length ? 'var(--success)' : 'var(--info)'}">
                <h4>Auction Insights</h4>
                <p>${auctionRows.length ? `${fmtNum(auctionRows.length)} advertiser domains summarized from ${fmtNum(auctionInsights.meta?.sourceRows || 0)} daily rows for the exact selected scope and dates.` : (auctionStatuses[0]?.message || 'Auction Insights sheet settings have not produced rows for this selection yet.')}</p>
            </div>
            <div class="insight-item" style="border-color: var(--info)">
                <h4>Decision Signals</h4>
                <p>${fmtNum(signalCount('QUALITY_SCORE_RISK'))} QS risks, ${fmtNum(signalCount('LANDING_PAGE_TECH_RISK') + signalCount('LANDING_PAGE_LEAK'))} landing-page risks, ${fmtNum(signalCount('DEVICE_SEGMENT_RISK'))} device risks, and ${fmtNum(signalCount('DAYPART_SEGMENT_RISK'))} daypart risks in the current data.</p>
            </div>
        `;
    }

    initGrid('grid-competitors', competitors, [
        { field: 'competitor', headerName: 'Competitor', pinned: 'left' },
        { field: 'impressions', headerName: 'Impr.', filter: 'agNumberColumnFilter' },
        { field: 'clicks', headerName: 'Clicks', filter: 'agNumberColumnFilter' },
        { field: 'spend', headerName: 'Spend', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'negativeCoveredSpend', headerName: 'Covered Spend', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'negativeUncoveredSpend', headerName: 'Uncovered Spend', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'conversions', headerName: 'Conv.', filter: 'agNumberColumnFilter' },
        { field: 'realLeadCount', headerName: 'Leads', filter: 'agNumberColumnFilter' },
        { field: 'qualifiedOrConvertedLeads', headerName: 'Qualified/Won', filter: 'agNumberColumnFilter' },
        { field: 'uselessLeads', headerName: 'Useless Leads', filter: 'agNumberColumnFilter' },
        { field: 'leadQualityStatus', headerName: 'Lead Quality' },
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

    // ── Landing Pages section ────────────────────────────────────────────────
    const expandedLandingPages = dashboardData.expandedLandingPages || [];

    // Summary cards for landing pages
    const lpSummaryEl = document.getElementById('landingPageSummary');
    if (lpSummaryEl) {
        const totalUrls = landingPages.length;
        const totalClicks = landingPages.reduce((s, r) => s + (r.clicks || 0), 0);
        const totalConv = landingPages.reduce((s, r) => s + (r.conversions || 0), 0);
        const avgCvr = totalClicks > 0 ? (totalConv / totalClicks) * 100 : 0;

        // Click-weighted averages for pct metrics (null if no data)
        let mfW = 0, mfV = 0, ampW = 0, ampV = 0, spW = 0, spV = 0;
        landingPages.forEach(r => {
            const w = r.clicks || 0;
            if (r.mobileFriendlyClicksPct !== null && r.mobileFriendlyClicksPct !== undefined) { mfW += w; mfV += r.mobileFriendlyClicksPct * w; }
            if (r.validAmpClicksPct !== null && r.validAmpClicksPct !== undefined) { ampW += w; ampV += r.validAmpClicksPct * w; }
            if (r.speedScore !== null && r.speedScore !== undefined) { spW += w; spV += r.speedScore * w; }
        });
        const avgMf = mfW > 0 ? (mfV / mfW).toFixed(1) : null;
        const avgAmp = ampW > 0 ? (ampV / ampW).toFixed(1) : null;
        const avgSpeed = spW > 0 ? (spV / spW).toFixed(1) : null;

        const cards = [
            { label: 'Total URLs', value: fmtNum(totalUrls), detail: 'Unexpanded final URLs' },
            { label: 'Clicks', value: fmtNum(totalClicks), detail: '' },
            { label: 'Conversions', value: fmtNum(totalConv), detail: '' },
            { label: 'Avg CVR', value: fmtPct(avgCvr), detail: '' },
            { label: 'Mobile-friendly %', value: avgMf !== null ? `${avgMf}%` : 'n/a', detail: 'Click-weighted avg' },
            { label: 'Valid AMP %', value: avgAmp !== null ? `${avgAmp}%` : 'n/a', detail: 'Click-weighted avg' },
            { label: 'Avg Speed Score', value: avgSpeed !== null ? avgSpeed : 'n/a', detail: 'Click-weighted avg' }
        ];
        lpSummaryEl.innerHTML = cards.map(c => `
            <div class="keyword-metric">
                <span>${esc(c.label)}</span>
                <strong>${esc(String(c.value))}</strong>
                ${c.detail ? `<small>${esc(c.detail)}</small>` : ''}
            </div>
        `).join('');
    }

    // Subtab toggle state (persisted on the element itself)
    const lpPanel = document.getElementById('landingPagesPanel');
    if (lpPanel && !lpPanel._lpTabsInitialised) {
        lpPanel._lpTabsInitialised = true;
        const tabBar = lpPanel.querySelector('.lp-subtab-bar');
        if (tabBar) {
            tabBar.querySelectorAll('.lp-subtab').forEach(btn => {
                btn.addEventListener('click', () => {
                    tabBar.querySelectorAll('.lp-subtab').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    const target = btn.dataset.target;
                    lpPanel.querySelectorAll('.lp-tab-content').forEach(el => {
                        el.style.display = el.id === target ? '' : 'none';
                    });
                });
            });
        }
    }

    // URL cell renderer — safe external link + diagnostic helpers
    const urlCellRenderer = (field, urlLabel) => p => {
        if (!p.value) return '<span style="color:var(--text-muted);">—</span>';
        const url = esc(p.value);
        const rawUrl = p.value;
        let diagnostics = '';
        try {
            const encoded = encodeURIComponent(rawUrl);
            diagnostics = `
                <span style="margin-left:0.4rem; white-space:nowrap;">
                    <a href="https://pagespeed.web.dev/report?url=${encoded}" target="_blank" rel="noopener noreferrer"
                       title="PageSpeed Insights" style="color:var(--text-muted); font-size:0.75rem; text-decoration:none;">PSI↗</a>
                </span>`;
        } catch (_) { }
        return `<span class="table-link-wrap"><a href="${url}" target="_blank" rel="noopener noreferrer" style="color:var(--info); word-break:break-all;">${url}</a>${diagnostics}</span>`;
    };

    const lpCols = [
        { field: 'finalUrl', headerName: 'Final URL', pinned: 'left', minWidth: 220, wrapText: true, autoHeight: true, cellRenderer: urlCellRenderer('finalUrl', 'Final URL') },
        { field: 'campaign', headerName: 'Campaign' },
        { field: 'adGroup', headerName: 'Ad Group' },
        { field: 'spend', headerName: 'Spend', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'impressions', headerName: 'Impr.', filter: 'agNumberColumnFilter' },
        { field: 'clicks', headerName: 'Clicks', filter: 'agNumberColumnFilter' },
        { field: 'ctr', headerName: 'CTR', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
        { field: 'avgCpc', headerName: 'Avg CPC', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'conversions', headerName: 'Conv.', filter: 'agNumberColumnFilter' },
        { field: 'cvr', headerName: 'CVR', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
        { field: 'cpa', headerName: 'CPA', valueFormatter: params => params.data.conversions > 0 ? fmtCurr(params.value) : 'n/a', filter: 'agNumberColumnFilter' },
        { field: 'mobileFriendlyClicksPct', headerName: 'Mobile-friendly %', valueFormatter: p => p.value !== null && p.value !== undefined ? `${fmtNum(p.value)}%` : 'n/a', filter: 'agNumberColumnFilter' },
        { field: 'validAmpClicksPct', headerName: 'Valid AMP %', valueFormatter: p => p.value !== null && p.value !== undefined ? `${fmtNum(p.value)}%` : 'n/a', filter: 'agNumberColumnFilter' },
        { field: 'speedScore', headerName: 'Speed Score', valueFormatter: p => p.value !== null && p.value !== undefined ? fmtNum(p.value) : 'n/a', filter: 'agNumberColumnFilter' }
    ];

    const expLpCols = [
        { field: 'expandedFinalUrl', headerName: 'Expanded Final URL', pinned: 'left', minWidth: 240, wrapText: true, autoHeight: true, cellRenderer: urlCellRenderer('expandedFinalUrl', 'Expanded URL') },
        { field: 'campaign', headerName: 'Campaign' },
        { field: 'adGroup', headerName: 'Ad Group' },
        { field: 'spend', headerName: 'Spend', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'impressions', headerName: 'Impr.', filter: 'agNumberColumnFilter' },
        { field: 'clicks', headerName: 'Clicks', filter: 'agNumberColumnFilter' },
        { field: 'ctr', headerName: 'CTR', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
        { field: 'avgCpc', headerName: 'Avg CPC', valueFormatter: currencyFormatter, filter: 'agNumberColumnFilter' },
        { field: 'conversions', headerName: 'Conv.', filter: 'agNumberColumnFilter' },
        { field: 'cvr', headerName: 'CVR', valueFormatter: pctFormatter, filter: 'agNumberColumnFilter' },
        { field: 'cpa', headerName: 'CPA', valueFormatter: params => params.data.conversions > 0 ? fmtCurr(params.value) : 'n/a', filter: 'agNumberColumnFilter' },
        { field: 'mobileFriendlyClicksPct', headerName: 'Mobile-friendly %', valueFormatter: p => p.value !== null && p.value !== undefined ? `${fmtNum(p.value)}%` : 'n/a', filter: 'agNumberColumnFilter' },
        { field: 'validAmpClicksPct', headerName: 'Valid AMP %', valueFormatter: p => p.value !== null && p.value !== undefined ? `${fmtNum(p.value)}%` : 'n/a', filter: 'agNumberColumnFilter' },
        { field: 'speedScore', headerName: 'Speed Score', valueFormatter: p => p.value !== null && p.value !== undefined ? fmtNum(p.value) : 'n/a', filter: 'agNumberColumnFilter' }
    ];

    initGrid('grid-landingPages', landingPages, lpCols);
    initGrid('grid-expandedLandingPages', expandedLandingPages, expLpCols);


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
        const context = signal.decisionContext || signal.decision_context || {};
        const negative = context.negativeCoverage || {};
        const configured = context.configuredKeywordCoverage || {};
        const missing = Array.isArray(signal.missing_data) ? signal.missing_data.filter(Boolean) : [];
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
                ${(negative.isNegativeCovered || configured.isConfiguredKeyword || missing.length) ? `
                    <div class="candidate-signal-meta" style="margin-top:0.5rem;">
                        ${negative.isNegativeCovered ? `<span class="source-pill">Excluded: ${esc(negative.negativeCoverageKeyword || 'negative')}</span>` : ''}
                        ${configured.isConfiguredKeyword ? `<span class="source-pill">Configured: ${esc(configured.configuredKeywordStatus || 'keyword')}</span>` : ''}
                        ${missing.length ? `<span class="source-pill">Missing: ${esc(missing.join(', '))}</span>` : ''}
                    </div>
                ` : ''}
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

function resetOverviewWidgetRequests() {
    overviewSearchState.requestSequence += 1;
    overviewSearchState.page = 1;
    overviewSearchState.data = null;
    overviewSearchState.loadedKey = '';
    overviewSearchState.pendingKey = '';
    overviewKeywordState.requestSequence += 1;
    overviewKeywordState.page = 1;
    overviewKeywordState.data = null;
    overviewKeywordState.loadedKey = '';
    overviewKeywordState.pendingKey = '';
    overviewSearchTermState.requestSequence += 1;
    overviewSearchTermState.page = 1;
    overviewSearchTermState.data = null;
    overviewSearchTermState.loadedKey = '';
    overviewSearchTermState.pendingKey = '';
    closeOverviewPopover();
}

function overviewWidgetFilterParams() {
    const selected = selectedDashboardFilters();
    const params = new URLSearchParams();
    if (selected.startDate) params.set('startDate', selected.startDate);
    if (selected.endDate) params.set('endDate', selected.endDate);
    if (selected.campaignId) params.set('campaignId', selected.campaignId);
    if (selected.adGroupId) params.set('adGroupId', selected.adGroupId);
    return params;
}

function overviewSearchRequestKey() {
    const selected = selectedDashboardFilters();
    return JSON.stringify({
        ...selected,
        mode: overviewSearchState.mode,
        metric: overviewSearchState.metric,
        conversionType: overviewSearchState.metric === 'conversions' ? overviewSearchState.conversionType : 'all',
        conversionValue: overviewSearchState.metric === 'conversions' ? overviewSearchState.conversionValue : '',
        page: overviewSearchState.page,
        pageSize: overviewSearchState.pageSize
    });
}

function overviewKeywordRequestKey() {
    return JSON.stringify({
        ...selectedDashboardFilters(),
        sort: overviewKeywordState.sort,
        direction: overviewKeywordState.direction,
        page: overviewKeywordState.page,
        pageSize: overviewKeywordState.pageSize
    });
}

function setOverviewWidgetStatus(id, message, isError = false) {
    const element = document.getElementById(id);
    if (!element) return;
    element.hidden = !message;
    element.textContent = message || '';
    element.classList.toggle('is-error', isError);
}

function overviewCoverageMessage(coverage, searchTerms = false) {
    const rows = Array.isArray(coverage) ? coverage : [];
    const problem = rows.find(row => ['missing', 'failed', 'partial'].includes(String(row.status || '')));
    const caveat = searchTerms ? 'Google may withhold some low-volume searches.' : '';
    if (!problem) return { text: caveat, warning: false };
    const pieces = [];
    const missingDates = Array.isArray(problem.missingDates) ? problem.missingDates.map(formatIsoDateShort) : [];
    const failedDates = Array.isArray(problem.failedDates) ? problem.failedDates.map(formatIsoDateShort) : [];
    if (problem.missingDateCount) {
        pieces.push(`${problem.missingDateCount} missing day${problem.missingDateCount === 1 ? '' : 's'}${missingDates.length ? `: ${missingDates.join(', ')}` : ''}`);
    }
    if (problem.failedDateCount) {
        pieces.push(`${problem.failedDateCount} failed day${problem.failedDateCount === 1 ? '' : 's'}${failedDates.length ? `: ${failedDates.join(', ')}` : ''}`);
    }
    const report = String(problem.reportName || 'source').replace(/_/g, ' ');
    return {
        text: `Partial ${report} data${pieces.length ? ` (${pieces.join(', ')})` : ''}.${caveat ? ` ${caveat}` : ''}`,
        warning: true
    };
}

function renderOverviewCoverage(id, coverage, searchTerms = false) {
    const element = document.getElementById(id);
    if (!element) return;
    const message = overviewCoverageMessage(coverage, searchTerms);
    element.textContent = message.text;
    element.classList.toggle('is-warning', message.warning);
}

function populateOverviewConversionFilter(data) {
    const select = document.getElementById('overviewSearchConversionFilter');
    if (!select) return;
    select.hidden = overviewSearchState.metric !== 'conversions';
    select.innerHTML = '';
    const all = document.createElement('option');
    all.value = 'all';
    all.textContent = 'All conversions';
    select.appendChild(all);
    const categories = data?.conversionOptions?.categories || [];
    if (categories.length) {
        const group = document.createElement('optgroup');
        group.label = 'Conversion categories';
        categories.forEach(row => {
            const option = document.createElement('option');
            option.value = `category:${row.name}`;
            option.textContent = String(row.name || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, letter => letter.toUpperCase());
            group.appendChild(option);
        });
        select.appendChild(group);
    }
    const actions = data?.conversionOptions?.actions || [];
    if (actions.length) {
        const group = document.createElement('optgroup');
        group.label = 'Conversion actions';
        actions.forEach(row => {
            const option = document.createElement('option');
            option.value = `action:${row.name}`;
            option.textContent = row.name;
            group.appendChild(option);
        });
        select.appendChild(group);
    }
    const selectedValue = overviewSearchState.conversionType === 'all'
        ? 'all'
        : `${overviewSearchState.conversionType}:${overviewSearchState.conversionValue}`;
    if (Array.from(select.options).some(option => option.value === selectedValue)) {
        select.value = selectedValue;
    } else {
        select.value = 'all';
        overviewSearchState.conversionType = 'all';
        overviewSearchState.conversionValue = '';
    }
}

function overviewSearchMetricTitle(row) {
    if (overviewSearchState.metric === 'cost') return fmtCurr(Number(row.costMicros || 0) / 1_000_000);
    if (overviewSearchState.metric === 'impressions') return `${fmtNum(row.impressions)} impressions`;
    if (overviewSearchState.metric === 'conversions') return `${fmtNum(row.conversions)} conversions`;
    return `${fmtNum(row.clicks)} clicks`;
}

function renderOverviewSearchWidget() {
    const data = overviewSearchState.data;
    if (!data) return;
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const chips = document.getElementById('overviewSearchChips');
    if (chips) {
        chips.setAttribute('aria-label', overviewSearchState.mode === 'words' ? 'Top words' : 'Top searches');
        chips.innerHTML = rows.map((row, index) => {
            const strength = Math.max(36, 96 - index * 6);
            return `<button type="button" class="overview-search-chip" data-search-row="${index}"
                style="--chip-strength:${strength}%" aria-expanded="false"
                title="${esc(`${row.label}: ${overviewSearchMetricTitle(row)}`)}">${esc(row.label)}</button>`;
        }).join('');
    }
    setOverviewWidgetStatus(
        'overviewSearchWidgetStatus',
        rows.length ? '' : 'No reported searches were found for these filters.'
    );
    const page = data.pagination?.page || overviewSearchState.page;
    const totalPages = data.pagination?.totalPages || 0;
    const pageLabel = document.getElementById('overviewSearchPage');
    if (pageLabel) pageLabel.textContent = totalPages ? `${page} / ${totalPages}` : '0 / 0';
    const prev = document.getElementById('overviewSearchPrev');
    const next = document.getElementById('overviewSearchNext');
    if (prev) prev.disabled = page <= 1;
    if (next) next.disabled = !totalPages || page >= totalPages;
    document.querySelectorAll('.overview-search-tab').forEach(button => {
        const active = button.dataset.searchMode === overviewSearchState.mode;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    const metric = document.getElementById('overviewSearchMetric');
    if (metric) metric.value = overviewSearchState.metric;
    populateOverviewConversionFilter(data);
    renderOverviewCoverage('overviewSearchCoverage', data.coverage, true);
}

function renderOverviewKeywordMetricSelectors() {
    const options = Object.entries(OVERVIEW_KEYWORD_METRICS)
        .map(([value, meta]) => `<option value="${esc(value)}">${esc(meta.label)}</option>`).join('');
    document.querySelectorAll('.overview-keyword-metric').forEach((select, index) => {
        select.innerHTML = options;
        select.value = overviewKeywordState.columns[index];
        select.title = `${OVERVIEW_KEYWORD_METRICS[overviewKeywordState.columns[index]]?.label || 'Metric'}; selecting a metric sorts the card by it`;
    });
}

function overviewKeywordColumnElements() {
    return Array.from(document.querySelectorAll('.overview-keyword-table col[data-overview-keyword-col]'));
}

function currentOverviewKeywordColumnWidths() {
    const table = document.querySelector('.overview-keyword-table');
    if (!table) return [];
    return Array.from(table.querySelectorAll('thead th')).map(cell => Math.round(cell.getBoundingClientRect().width));
}

function savedOverviewKeywordColumnWidths() {
    if (Array.isArray(overviewKeywordState.columnWidths)) return overviewKeywordState.columnWidths;
    try {
        const parsed = JSON.parse(localStorage.getItem(OVERVIEW_KEYWORD_COLUMN_WIDTHS_KEY) || 'null');
        if (Array.isArray(parsed) && parsed.length === 4 && parsed.every(value =>
            Number.isFinite(Number(value)) && Number(value) >= 0.08 && Number(value) <= 0.75
        ) && Math.abs(parsed.reduce((sum, value) => sum + Number(value), 0) - 1) < 0.02) {
            overviewKeywordState.columnWidths = parsed.map(Number);
            return overviewKeywordState.columnWidths;
        }
    } catch {
        // Ignore malformed local preferences and use the themed defaults.
    }
    overviewKeywordState.columnWidths = null;
    return null;
}

function applyOverviewKeywordColumnWidths(widths = savedOverviewKeywordColumnWidths()) {
    if (!Array.isArray(widths) || widths.length !== 4) return;
    const columns = overviewKeywordColumnElements();
    const table = document.querySelector('.overview-keyword-table');
    if (columns.length !== 4 || !table) return;
    const total = widths.reduce((sum, value) => sum + Number(value || 0), 0);
    if (!(total > 0)) return;
    const normalized = widths.map(value => Number(value) / total);
    columns.forEach((column, index) => { column.style.width = `${normalized[index] * 100}%`; });
    table.style.width = '100%';
    document.querySelectorAll('.overview-column-resizer').forEach((handle, index) => {
        handle.setAttribute('aria-valuenow', String(Math.round(normalized[index] * 100)));
        handle.setAttribute('aria-valuemin', '8');
        handle.setAttribute('aria-valuemax', '75');
    });
}

function persistOverviewKeywordColumnWidths(widths) {
    const total = widths.reduce((sum, value) => sum + Number(value || 0), 0);
    if (!(total > 0)) return;
    overviewKeywordState.columnWidths = widths.map(value => Number((Number(value) / total).toFixed(4)));
    localStorage.setItem(OVERVIEW_KEYWORD_COLUMN_WIDTHS_KEY, JSON.stringify(overviewKeywordState.columnWidths));
    applyOverviewKeywordColumnWidths(overviewKeywordState.columnWidths);
}

function resizeOverviewKeywordColumn(index, delta, startingWidths = currentOverviewKeywordColumnWidths()) {
    if (startingWidths.length !== 4) return startingWidths;
    const adjacentIndex = index === 3 ? 2 : index + 1;
    const compact = startingWidths.reduce((sum, value) => sum + value, 0) < 520;
    const minimum = columnIndex => columnIndex === 0 ? (compact ? 100 : 160) : (compact ? 58 : 88);
    const minCurrent = minimum(index);
    const minAdjacent = minimum(adjacentIndex);
    const boundedDelta = Math.max(
        minCurrent - startingWidths[index],
        Math.min(Number(delta || 0), startingWidths[adjacentIndex] - minAdjacent)
    );
    const widths = [...startingWidths];
    widths[index] = startingWidths[index] + boundedDelta;
    widths[adjacentIndex] = startingWidths[adjacentIndex] - boundedDelta;
    applyOverviewKeywordColumnWidths(widths);
    return widths;
}

function resetOverviewKeywordColumnWidths() {
    overviewKeywordState.columnWidths = null;
    localStorage.removeItem(OVERVIEW_KEYWORD_COLUMN_WIDTHS_KEY);
    overviewKeywordColumnElements().forEach(column => { column.style.width = ''; });
    const table = document.querySelector('.overview-keyword-table');
    if (table) table.style.width = '';
}

function setupOverviewKeywordColumnResizing() {
    document.querySelectorAll('.overview-column-resizer').forEach(handle => {
        if (handle.hasAttribute('data-bound')) return;
        const index = Number(handle.dataset.resizeColumn);
        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            const startX = event.clientX;
            const startingWidths = currentOverviewKeywordColumnWidths();
            let pendingWidths = startingWidths;
            handle.classList.add('is-active');
            document.body.classList.add('is-resizing-overview-columns');
            const move = moveEvent => {
                pendingWidths = resizeOverviewKeywordColumn(index, moveEvent.clientX - startX, startingWidths);
            };
            const finish = () => {
                document.removeEventListener('pointermove', move);
                document.removeEventListener('pointerup', finish);
                document.removeEventListener('pointercancel', finish);
                handle.classList.remove('is-active');
                document.body.classList.remove('is-resizing-overview-columns');
                if (pendingWidths.length === 4) persistOverviewKeywordColumnWidths(pendingWidths);
            };
            document.addEventListener('pointermove', move);
            document.addEventListener('pointerup', finish, { once: true });
            document.addEventListener('pointercancel', finish, { once: true });
        });
        handle.addEventListener('keydown', event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const widths = resizeOverviewKeywordColumn(index, event.key === 'ArrowRight' ? 16 : -16);
            if (widths.length === 4) persistOverviewKeywordColumnWidths(widths);
        });
        handle.addEventListener('dblclick', event => {
            event.preventDefault();
            event.stopPropagation();
            resetOverviewKeywordColumnWidths();
        });
        handle.setAttribute('data-bound', 'true');
    });
    requestAnimationFrame(() => applyOverviewKeywordColumnWidths());
}

// ─── Search Terms column resizing ────────────────────────────────────────────

const OVERVIEW_ST_COLUMN_WIDTHS_KEY = 'overviewSearchTermColumnWidths';
const OVERVIEW_ST_COL_COUNT = 5;
let overviewStColumnWidths = null;

function overviewStColumnElements() {
    return [...document.querySelectorAll('.overview-search-term-table [data-overview-st-col]')]
        .sort((a, b) => Number(a.dataset.overviewStCol) - Number(b.dataset.overviewStCol));
}

function currentOverviewStColumnWidths() {
    const columns = overviewStColumnElements();
    if (columns.length !== OVERVIEW_ST_COL_COUNT) return [];
    return columns.map(col => col.offsetWidth || 0);
}

function savedOverviewStColumnWidths() {
    if (Array.isArray(overviewStColumnWidths)) return overviewStColumnWidths;
    try {
        const parsed = JSON.parse(localStorage.getItem(OVERVIEW_ST_COLUMN_WIDTHS_KEY) || 'null');
        if (Array.isArray(parsed) && parsed.length === OVERVIEW_ST_COL_COUNT &&
            parsed.every(v => Number.isFinite(Number(v)) && Number(v) >= 0.06 && Number(v) <= 0.75) &&
            Math.abs(parsed.reduce((s, v) => s + Number(v), 0) - 1) < 0.02) {
            overviewStColumnWidths = parsed.map(Number);
            return overviewStColumnWidths;
        }
    } catch { /* ignore */ }
    overviewStColumnWidths = null;
    return null;
}

function applyOverviewStColumnWidths(widths = savedOverviewStColumnWidths()) {
    if (!Array.isArray(widths) || widths.length !== OVERVIEW_ST_COL_COUNT) return;
    const columns = overviewStColumnElements();
    const table = document.querySelector('.overview-search-term-table');
    if (columns.length !== OVERVIEW_ST_COL_COUNT || !table) return;
    const total = widths.reduce((s, v) => s + Number(v || 0), 0);
    if (!(total > 0)) return;
    const normalized = widths.map(v => Number(v) / total);
    columns.forEach((col, i) => { col.style.width = `${normalized[i] * 100}%`; });
    table.style.width = '100%';
}

function persistOverviewStColumnWidths(widths) {
    const total = widths.reduce((s, v) => s + Number(v || 0), 0);
    if (!(total > 0)) return;
    overviewStColumnWidths = widths.map(v => Number((Number(v) / total).toFixed(4)));
    localStorage.setItem(OVERVIEW_ST_COLUMN_WIDTHS_KEY, JSON.stringify(overviewStColumnWidths));
    applyOverviewStColumnWidths(overviewStColumnWidths);
}

function resizeOverviewStColumn(index, delta, startingWidths = currentOverviewStColumnWidths()) {
    if (startingWidths.length !== OVERVIEW_ST_COL_COUNT) return startingWidths;
    const adjacentIndex = index === OVERVIEW_ST_COL_COUNT - 1 ? index - 1 : index + 1;
    const compact = startingWidths.reduce((s, v) => s + v, 0) < 520;
    const minimum = i => i === 0 ? (compact ? 100 : 140) : (compact ? 48 : 68);
    const bounded = Math.max(
        minimum(index) - startingWidths[index],
        Math.min(Number(delta || 0), startingWidths[adjacentIndex] - minimum(adjacentIndex))
    );
    const widths = [...startingWidths];
    widths[index] = startingWidths[index] + bounded;
    widths[adjacentIndex] = startingWidths[adjacentIndex] - bounded;
    applyOverviewStColumnWidths(widths);
    return widths;
}

function resetOverviewStColumnWidths() {
    overviewStColumnWidths = null;
    localStorage.removeItem(OVERVIEW_ST_COLUMN_WIDTHS_KEY);
    overviewStColumnElements().forEach(col => { col.style.width = ''; });
    const table = document.querySelector('.overview-search-term-table');
    if (table) table.style.width = '';
}

function setupOverviewSearchTermColumnResizing() {
    document.querySelectorAll('.overview-st-resizer').forEach(handle => {
        if (handle.hasAttribute('data-bound')) return;
        const index = Number(handle.dataset.stResizeColumn);
        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            const startX = event.clientX;
            const startingWidths = currentOverviewStColumnWidths();
            let pendingWidths = startingWidths;
            handle.classList.add('is-active');
            document.body.classList.add('is-resizing-overview-columns');
            const move = e => { pendingWidths = resizeOverviewStColumn(index, e.clientX - startX, startingWidths); };
            const finish = () => {
                document.removeEventListener('pointermove', move);
                document.removeEventListener('pointerup', finish);
                document.removeEventListener('pointercancel', finish);
                handle.classList.remove('is-active');
                document.body.classList.remove('is-resizing-overview-columns');
                if (pendingWidths.length === OVERVIEW_ST_COL_COUNT) persistOverviewStColumnWidths(pendingWidths);
            };
            document.addEventListener('pointermove', move);
            document.addEventListener('pointerup', finish, { once: true });
            document.addEventListener('pointercancel', finish, { once: true });
        });
        handle.addEventListener('keydown', event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const widths = resizeOverviewStColumn(index, event.key === 'ArrowRight' ? 16 : -16);
            if (widths.length === OVERVIEW_ST_COL_COUNT) persistOverviewStColumnWidths(widths);
        });
        handle.addEventListener('dblclick', event => {
            event.preventDefault();
            event.stopPropagation();
            resetOverviewStColumnWidths();
        });
        handle.setAttribute('data-bound', 'true');
    });
    requestAnimationFrame(() => applyOverviewStColumnWidths());
}

function overviewKeywordStatusClass(row) {
    const status = String(row.status || '').toUpperCase();
    const primary = String(row.primaryStatus || '').toUpperCase();
    if (status === 'REMOVED') return 'is-removed';
    if (status === 'PAUSED') return 'is-paused';
    if (primary && !['ELIGIBLE', 'UNKNOWN'].includes(primary)) return 'is-limited';
    return '';
}

function renderOverviewKeywordWidget() {
    const data = overviewKeywordState.data;
    if (!data) return;
    renderOverviewKeywordMetricSelectors();
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const tbody = document.getElementById('overviewKeywordRows');
    if (tbody) {
        tbody.innerHTML = rows.length ? rows.map((row, index) => `
            <tr data-keyword-row="${index}" tabindex="0" aria-label="Details for ${esc(row.keywordText)}">
                <td><div class="overview-keyword-cell">
                    <span class="overview-keyword-dot ${overviewKeywordStatusClass(row)}" aria-hidden="true"></span>
                    <span class="overview-keyword-text">${esc(row.keywordText)}</span>
                </div></td>
                ${overviewKeywordState.columns.map(metric => `<td>${esc(OVERVIEW_KEYWORD_METRICS[metric]?.format(row) || '')}</td>`).join('')}
            </tr>`).join('') : '<tr><td colspan="4">No configured keywords were found for these filters.</td></tr>';
    }
    setOverviewWidgetStatus('overviewKeywordWidgetStatus', rows.length ? '' : 'No configured keywords were found for these filters.');
    const page = data.pagination?.page || overviewKeywordState.page;
    const totalPages = data.pagination?.totalPages || 0;
    const pageLabel = document.getElementById('overviewKeywordPage');
    if (pageLabel) pageLabel.textContent = totalPages ? `${page} / ${totalPages}` : '0 / 0';
    const prev = document.getElementById('overviewKeywordPrev');
    const next = document.getElementById('overviewKeywordNext');
    if (prev) prev.disabled = page <= 1;
    if (next) next.disabled = !totalPages || page >= totalPages;
    const direction = document.getElementById('overviewKeywordDirection');
    if (direction) {
        const descending = overviewKeywordState.direction === 'desc';
        direction.textContent = descending ? '↓' : '↑';
        direction.title = descending ? 'Sort high to low' : 'Sort low to high';
        direction.setAttribute('aria-label', direction.title);
    }
    renderOverviewCoverage('overviewKeywordCoverage', data.coverage, false);
    requestAnimationFrame(() => applyOverviewKeywordColumnWidths());
}

async function loadOverviewSearchWidget(force = false) {
    const key = overviewSearchRequestKey();
    if (!force && overviewSearchState.loadedKey === key && overviewSearchState.data) {
        renderOverviewSearchWidget();
        return overviewSearchState.data;
    }
    if (!force && overviewSearchState.pendingKey === key) return null;
    const sequence = ++overviewSearchState.requestSequence;
    const generation = dashboardLoadGeneration;
    overviewSearchState.pendingKey = key;
    setOverviewWidgetStatus('overviewSearchWidgetStatus', 'Loading searches…');
    try {
        const params = overviewWidgetFilterParams();
        params.set('mode', overviewSearchState.mode);
        params.set('metric', overviewSearchState.metric);
        params.set('page', String(overviewSearchState.page));
        params.set('pageSize', String(overviewSearchState.pageSize));
        if (overviewSearchState.metric === 'conversions' && overviewSearchState.conversionType !== 'all' && overviewSearchState.conversionValue) {
            params.set(overviewSearchState.conversionType === 'category' ? 'conversionCategory' : 'conversionAction', overviewSearchState.conversionValue);
        }
        const response = await dashboardFetch(`${API_BASE_GLOBAL}/api/dashboard/widgets/searches?${params}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `Search widget failed with ${response.status}`);
        if (sequence !== overviewSearchState.requestSequence || generation !== dashboardLoadGeneration) return data;
        const totalPages = Number(data.pagination?.totalPages || 0);
        if (totalPages && overviewSearchState.page > totalPages) {
            overviewSearchState.page = totalPages;
            overviewSearchState.pendingKey = '';
            return loadOverviewSearchWidget(true);
        }
        overviewSearchState.data = data;
        overviewSearchState.loadedKey = key;
        renderOverviewSearchWidget();
        return data;
    } catch (err) {
        if (sequence === overviewSearchState.requestSequence && generation === dashboardLoadGeneration) {
            overviewSearchState.data = null;
            document.getElementById('overviewSearchChips')?.replaceChildren();
            setOverviewWidgetStatus('overviewSearchWidgetStatus', err.message || 'Searches could not be loaded.', true);
        }
        return null;
    } finally {
        if (sequence === overviewSearchState.requestSequence) overviewSearchState.pendingKey = '';
    }
}

async function loadOverviewKeywordWidget(force = false) {
    const key = overviewKeywordRequestKey();
    if (!force && overviewKeywordState.loadedKey === key && overviewKeywordState.data) {
        renderOverviewKeywordWidget();
        return overviewKeywordState.data;
    }
    if (!force && overviewKeywordState.pendingKey === key) return null;
    const sequence = ++overviewKeywordState.requestSequence;
    const generation = dashboardLoadGeneration;
    overviewKeywordState.pendingKey = key;
    setOverviewWidgetStatus('overviewKeywordWidgetStatus', 'Loading keywords…');
    try {
        const params = overviewWidgetFilterParams();
        params.set('sort', overviewKeywordState.sort);
        params.set('direction', overviewKeywordState.direction);
        params.set('page', String(overviewKeywordState.page));
        params.set('pageSize', String(overviewKeywordState.pageSize));
        const response = await dashboardFetch(`${API_BASE_GLOBAL}/api/dashboard/widgets/keywords?${params}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `Keyword widget failed with ${response.status}`);
        if (sequence !== overviewKeywordState.requestSequence || generation !== dashboardLoadGeneration) return data;
        const totalPages = Number(data.pagination?.totalPages || 0);
        if (totalPages && overviewKeywordState.page > totalPages) {
            overviewKeywordState.page = totalPages;
            overviewKeywordState.pendingKey = '';
            return loadOverviewKeywordWidget(true);
        }
        overviewKeywordState.data = data;
        overviewKeywordState.loadedKey = key;
        renderOverviewKeywordWidget();
        return data;
    } catch (err) {
        if (sequence === overviewKeywordState.requestSequence && generation === dashboardLoadGeneration) {
            overviewKeywordState.data = null;
            const tbody = document.getElementById('overviewKeywordRows');
            if (tbody) tbody.innerHTML = '';
            setOverviewWidgetStatus('overviewKeywordWidgetStatus', err.message || 'Keywords could not be loaded.', true);
        }
        return null;
    } finally {
        if (sequence === overviewKeywordState.requestSequence) overviewKeywordState.pendingKey = '';
    }
}

async function ensureOverviewWidgets(force = false) {
    if (!document.getElementById('overviewSearchWidget') || activeDashboardTab() !== 'overview') return;
    if (DASHBOARD_AUTH?.offline) {
        setOverviewWidgetStatus('overviewSearchWidgetStatus', 'Search details are unavailable while offline.');
        setOverviewWidgetStatus('overviewKeywordWidgetStatus', 'Keyword details are unavailable while offline.');
        setOverviewWidgetStatus('overviewSearchTermWidgetStatus', 'Search term details are unavailable while offline.');
        return;
    }
    await Promise.all([loadOverviewSearchWidget(force), loadOverviewKeywordWidget(force), loadOverviewSearchTermWidget(force)]);
}

// ─── Search Terms widget ──────────────────────────────────────────────────────

function overviewSearchTermRequestKey() {
    return JSON.stringify({
        metric: overviewSearchTermState.metric,
        direction: overviewSearchTermState.direction,
        page: overviewSearchTermState.page,
        pageSize: overviewSearchTermState.pageSize
    });
}

function renderOverviewSearchTermWidget() {
    const data = overviewSearchTermState.data;
    if (!data) return;
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const tbody = document.getElementById('overviewSearchTermRows');
    if (tbody) {
        tbody.innerHTML = rows.length ? rows.map((row, index) => `
            <tr data-search-term-row="${index}" tabindex="0" aria-label="Details for ${esc(row.label)}" aria-expanded="false">
                <td><div class="overview-search-term-cell">
                    <span class="overview-keyword-text">${esc(row.label)}</span>
                </div></td>
                <td>${esc(fmtNum(row.impressions))}</td>
                <td>${esc(fmtNum(row.clicks))}</td>
                <td>${esc(fmtCurr(Number(row.costMicros || 0) / 1_000_000))}</td>
                <td>${esc(fmtNum(row.conversions))}</td>
            </tr>`).join('') : '<tr><td colspan="5">No search terms were found for these filters.</td></tr>';
    }
    setOverviewWidgetStatus('overviewSearchTermWidgetStatus', rows.length ? '' : 'No search terms were found for these filters.');
    const page = data.pagination?.page || overviewSearchTermState.page;
    const totalPages = data.pagination?.totalPages || 0;
    const pageLabel = document.getElementById('overviewSearchTermPage');
    if (pageLabel) pageLabel.textContent = totalPages ? `${page} / ${totalPages}` : '0 / 0';
    const prev = document.getElementById('overviewSearchTermPrev');
    const next = document.getElementById('overviewSearchTermNext');
    if (prev) prev.disabled = page <= 1;
    if (next) next.disabled = !totalPages || page >= totalPages;
    const metric = document.getElementById('overviewSearchTermMetric');
    if (metric) metric.value = overviewSearchTermState.metric;
    renderOverviewCoverage('overviewSearchTermCoverage', data.coverage, true);
}

async function loadOverviewSearchTermWidget(force = false) {
    const key = overviewSearchTermRequestKey();
    if (!force && overviewSearchTermState.loadedKey === key && overviewSearchTermState.data) {
        renderOverviewSearchTermWidget();
        return overviewSearchTermState.data;
    }
    if (!force && overviewSearchTermState.pendingKey === key) return null;
    const sequence = ++overviewSearchTermState.requestSequence;
    const generation = dashboardLoadGeneration;
    overviewSearchTermState.pendingKey = key;
    setOverviewWidgetStatus('overviewSearchTermWidgetStatus', 'Loading search terms…');
    try {
        const params = overviewWidgetFilterParams();
        params.set('mode', 'searches');
        params.set('metric', overviewSearchTermState.metric);
        params.set('page', String(overviewSearchTermState.page));
        params.set('pageSize', String(overviewSearchTermState.pageSize));
        const response = await dashboardFetch(`${API_BASE_GLOBAL}/api/dashboard/widgets/searches?${params}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `Search terms widget failed with ${response.status}`);
        if (sequence !== overviewSearchTermState.requestSequence || generation !== dashboardLoadGeneration) return data;
        const totalPages = Number(data.pagination?.totalPages || 0);
        if (totalPages && overviewSearchTermState.page > totalPages) {
            overviewSearchTermState.page = totalPages;
            overviewSearchTermState.pendingKey = '';
            return loadOverviewSearchTermWidget(true);
        }
        overviewSearchTermState.data = data;
        overviewSearchTermState.loadedKey = key;
        renderOverviewSearchTermWidget();
        return data;
    } catch (err) {
        if (sequence === overviewSearchTermState.requestSequence && generation === dashboardLoadGeneration) {
            overviewSearchTermState.data = null;
            const tbody = document.getElementById('overviewSearchTermRows');
            if (tbody) tbody.innerHTML = '';
            setOverviewWidgetStatus('overviewSearchTermWidgetStatus', err.message || 'Search terms could not be loaded.', true);
        }
        return null;
    } finally {
        if (sequence === overviewSearchTermState.requestSequence) overviewSearchTermState.pendingKey = '';
    }
}

function setupOverviewSearchTermWidget() {
    const termMetric = document.getElementById('overviewSearchTermMetric');
    if (!termMetric || termMetric.hasAttribute('data-bound')) return;
    termMetric.addEventListener('change', () => {
        overviewSearchTermState.metric = termMetric.value;
        overviewSearchTermState.page = 1;
        void loadOverviewSearchTermWidget(true);
    });
    const termRows = document.getElementById('overviewSearchTermRows');
    const openSearchTermRow = target => {
        const rowElement = target.closest('[data-search-term-row]');
        if (!rowElement) return;
        if (rowElement.getAttribute('aria-expanded') === 'true') {
            closeOverviewPopover();
            return;
        }
        const row = overviewSearchTermState.data?.rows?.[Number(rowElement.dataset.searchTermRow)];
        if (row) openOverviewSearchPopover(rowElement, row);
    };
    termRows?.addEventListener('click', event => openSearchTermRow(event.target));
    termRows?.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openSearchTermRow(event.target);
    });
    document.getElementById('overviewSearchTermPrev')?.addEventListener('click', () => {
        if (overviewSearchTermState.page <= 1) return;
        overviewSearchTermState.page -= 1;
        closeOverviewPopover();
        void loadOverviewSearchTermWidget(true);
    });
    document.getElementById('overviewSearchTermNext')?.addEventListener('click', () => {
        const totalPages = overviewSearchTermState.data?.pagination?.totalPages || 0;
        if (!totalPages || overviewSearchTermState.page >= totalPages) return;
        overviewSearchTermState.page += 1;
        closeOverviewPopover();
        void loadOverviewSearchTermWidget(true);
    });
    document.getElementById('overviewAllSearchTermsBtn')?.addEventListener('click', () => navigateOverviewToKeywords('search-terms'));
    termMetric.setAttribute('data-bound', 'true');
    setupOverviewSearchTermColumnResizing();
}

function overviewCampaignRows() {
    const rows = [
        ...(controlsState?.campaigns || []),
        ...(dashboardData?.filterOptions?.campaigns || []),
        ...(dashboardData?.campaigns || [])
    ];
    const byId = new Map();
    rows.forEach(row => {
        const id = String(row.campaignId || row.id || '');
        if (!id || byId.has(id)) return;
        byId.set(id, { campaignId: id, campaignName: row.campaignName || row.name || row.campaign || id });
    });
    return Array.from(byId.values()).sort((a, b) => a.campaignName.localeCompare(b.campaignName));
}

function overviewAdGroupRows() {
    const rows = [
        ...(controlsState?.adGroups || []),
        ...(dashboardData?.filterOptions?.adGroups || []),
        ...(dashboardData?.adGroups || [])
    ];
    const campaignNames = new Map(overviewCampaignRows().map(row => [row.campaignId, row.campaignName]));
    const byId = new Map();
    rows.forEach(row => {
        const id = String(row.adGroupId || row.id || '');
        if (!id || byId.has(id)) return;
        const campaignId = String(row.campaignId || '');
        byId.set(id, {
            adGroupId: id,
            adGroupName: row.adGroupName || row.name || row.adGroup || id,
            campaignId,
            campaignName: row.campaignName || campaignNames.get(campaignId) || campaignId
        });
    });
    return Array.from(byId.values()).sort((a, b) => `${a.campaignName} ${a.adGroupName}`.localeCompare(`${b.campaignName} ${b.adGroupName}`));
}

function overviewAvailableAdGroups() {
    const filters = selectedDashboardFilters();
    return overviewAdGroupRows().filter(row => !filters.campaignId || row.campaignId === filters.campaignId);
}

function overviewTargetOptions(rows, type, selectedId = '') {
    const placeholder = `<option value="">${type === 'campaign' ? 'Choose a campaign' : 'Choose an ad group'}</option>`;
    return placeholder + rows.map(row => {
        const id = type === 'campaign' ? row.campaignId : row.adGroupId;
        const label = type === 'campaign' ? row.campaignName : `${row.campaignName || row.campaignId} / ${row.adGroupName}`;
        return `<option value="${esc(id)}"${String(id) === String(selectedId) ? ' selected' : ''}>${esc(label)}</option>`;
    }).join('');
}

function positionOverviewPopover(popover, anchor) {
    if (!popover || popover.id !== 'overviewFloatingPopover') return;
    popover.style.visibility = 'hidden';
    popover.style.left = '12px';
    popover.style.top = '12px';
    requestAnimationFrame(() => {
        if (!popover.isConnected) return;
        const box = popover.getBoundingClientRect();
        const anchorBox = anchor?.getBoundingClientRect?.() || { left: 12, right: 12, top: 12, bottom: 12 };
        const gap = 8;
        let left = Math.min(anchorBox.left, window.innerWidth - box.width - 12);
        left = Math.max(12, left);
        let top = anchorBox.bottom + gap;
        if (top + box.height > window.innerHeight - 12 && anchorBox.top - box.height - gap >= 12) {
            top = anchorBox.top - box.height - gap;
        }
        top = Math.max(12, Math.min(top, window.innerHeight - box.height - 12));
        popover.style.left = `${left}px`;
        popover.style.top = `${top}px`;
        popover.style.visibility = 'visible';
    });
}

function createOverviewPopover(anchor, label) {
    closeOverviewPopover();
    const popover = document.createElement('section');
    popover.id = 'overviewFloatingPopover';
    popover.className = 'overview-floating-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', label);
    document.body.appendChild(popover);
    if (anchor) anchor.setAttribute('aria-expanded', 'true');
    popover.dataset.anchorId = anchor?.id || '';
    positionOverviewPopover(popover, anchor);
    return popover;
}

function createOverviewInlineDetail(anchor, label, isTable = false) {
    closeOverviewPopover();
    const container = document.createElement(isTable ? 'tr' : 'div');
    container.className = isTable ? 'overview-inline-detail-row' : 'overview-inline-detail-wrapper';

    let contentElement;
    if (isTable) {
        const td = document.createElement('td');
        td.colSpan = 4;
        container.appendChild(td);
        contentElement = document.createElement('div');
        contentElement.className = 'overview-inline-detail';
        td.appendChild(contentElement);
    } else {
        contentElement = document.createElement('div');
        contentElement.className = 'overview-inline-detail';
        container.appendChild(contentElement);
    }

    anchor.after(container);
    if (anchor) anchor.setAttribute('aria-expanded', 'true');
    container.dataset.anchorId = anchor?.id || '';
    return contentElement;
}

function getOverviewDetailHost(anchor, label, isTable = false) {
    const isMobile = window.innerWidth <= 768;
    if (isMobile && anchor) {
        return createOverviewInlineDetail(anchor, label, isTable);
    } else {
        return createOverviewPopover(anchor, label);
    }
}

function closeOverviewPopover() {
    document.querySelectorAll('.overview-search-chip[aria-expanded="true"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
    document.querySelectorAll('[data-keyword-row][aria-expanded="true"]').forEach(tr => tr.setAttribute('aria-expanded', 'false'));
    document.querySelectorAll('[data-search-term-row][aria-expanded="true"]').forEach(tr => tr.setAttribute('aria-expanded', 'false'));
    document.querySelectorAll('#overviewAddKeywordBtn[aria-expanded="true"]').forEach(btn => btn.setAttribute('aria-expanded', 'false'));
    document.getElementById('overviewFloatingPopover')?.remove();
    document.querySelectorAll('.overview-inline-detail-wrapper, .overview-inline-detail-row').forEach(el => el.remove());
}

function overviewPopoverHeader(label) {
    return `<button type="button" class="overview-popover-close" aria-label="Close ${esc(label)} details">×</button>`;
}

function overviewMetricsHtml(row) {
    return `<div class="overview-popover-metrics">
        <div class="overview-popover-metric"><span>Impressions</span><strong>${esc(fmtNum(row.impressions))}</strong></div>
        <div class="overview-popover-metric"><span>Clicks</span><strong>${esc(fmtNum(row.clicks))}</strong></div>
        <div class="overview-popover-metric"><span>Cost</span><strong>${esc(fmtCurr(Number(row.costMicros || 0) / 1_000_000))}</strong></div>
        <div class="overview-popover-metric"><span>Conversions</span><strong>${esc(fmtNum(row.conversions))}</strong></div>
    </div>`;
}

function prepareOverviewActionHost(popover) {
    if (window.innerWidth <= 768 && popover.classList.contains('overview-inline-detail')) {
        const content = popover.querySelector('.overview-popover-content');
        if (content) content.innerHTML = '<div class="overview-action-host"></div>';
    }
    return popover.querySelector('.overview-action-host');
}

function overviewKeywordTargetName(change) {
    if (change.scope === 'campaign') return lookupCampaignName(change.campaignId);
    return lookupAdGroupName(change.adGroupId);
}

function overviewDuplicateToast(mutationType, change) {
    const negative = mutationType === 'negative_keyword_changes';
    const scope = negative && change.scope === 'campaign' ? 'campaign' : 'ad group';
    const kind = negative ? 'negative keyword' : 'keyword';
    return `“${change.keywordText}” is already present as a ${formatMatchType(change.matchType)} ${kind} in ${scope} “${overviewKeywordTargetName(change)}”.`;
}

function overviewOppositeConflictToast(change, conflicts) {
    const first = conflicts[0];
    const kind = first.kind === 'negative_keyword' ? 'negative keyword' : 'keyword';
    const scope = first.scope === 'campaign' ? 'campaign' : first.scope === 'ad_group' ? 'ad group' : first.scope === 'account' ? 'account-level negative list' : 'shared negative list';
    const ownerName = first.scope === 'campaign'
        ? lookupCampaignName(first.campaignId)
        : first.scope === 'ad_group'
            ? lookupAdGroupName(first.adGroupId)
            : (controlsState?.sharedNegativeSets || []).find(row => String(row.sharedSetId) === String(first.sharedSetId))?.sharedSetName || first.sharedSetId || 'Google Ads account';
    const more = conflicts.length > 1 ? ` and ${conflicts.length - 1} other conflicting entr${conflicts.length === 2 ? 'y' : 'ies'}` : '';
    return `Warning: “${change.keywordText}” is already a ${formatMatchType(first.matchType)} ${kind} in ${scope} “${ownerName}”${more}. This change is still allowed.`;
}

async function reviewOverviewKeywordMutation(popover, mutationType, change, reason) {
    const form = popover.querySelector('.overview-action-panel');
    const error = form?.querySelector('.overview-action-error');
    const submit = form?.querySelector('.overview-action-submit');
    const originalLabel = submit?.textContent || '';
    if (error) error.textContent = '';
    if (submit) {
        submit.disabled = true;
        submit.textContent = 'Checking Google Ads…';
    }
    try {
        const response = await dashboardFetch(`${API_BASE_GLOBAL}/api/account-controls/mutations/keyword-preflight`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                customerId: dashboardData?.meta?.accountId,
                mutationType,
                change
            })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || 'Keyword check failed.');
        if (result.duplicate) {
            showToast(overviewDuplicateToast(mutationType, change), false);
            return;
        }
        const conflicts = Array.isArray(result.oppositeConflicts) ? result.oppositeConflicts : [];
        const warnings = conflicts.length ? [overviewOppositeConflictToast(change, conflicts)] : [];
        closeOverviewPopover();
        previewControlsMutation(mutationType, [change], reason, warnings);
    } catch (err) {
        if (error?.isConnected) error.textContent = err.message || 'Could not check the current Google Ads keywords.';
        else showToast(err.message || 'Could not check the current Google Ads keywords.', true);
    } finally {
        if (submit?.isConnected) {
            submit.disabled = false;
            submit.textContent = originalLabel;
        }
    }
}

function mountOverviewKeywordForm(popover, keywordText = '', sourceType = '') {
    const host = prepareOverviewActionHost(popover);
    if (!host) return;
    const filters = selectedDashboardFilters();
    const adGroups = overviewAvailableAdGroups();
    const selectedAdGroup = filters.adGroupId && adGroups.some(row => row.adGroupId === filters.adGroupId) ? filters.adGroupId : '';
    const sourceLabel = sourceType === 'word' ? 'word' : 'search';
    const heading = keywordText ? `Add this ${sourceLabel} as a keyword` : 'Add keyword';
    const explanation = keywordText
        ? (sourceType === 'word'
            ? 'Only this word will be added. The example searches shown above will not be added.'
            : 'This complete search phrase will be added as the keyword.')
        : '';
    host.innerHTML = `<form class="overview-action-panel" id="overviewKeywordActionForm">
        <h4>${heading}</h4>
        <div class="overview-action-grid">
            <div class="overview-action-field" style="grid-column:1/-1"><label for="overviewActionKeywordText">Keyword</label><input id="overviewActionKeywordText" value="${esc(keywordText)}" maxlength="80" required autocomplete="off"></div>
            ${explanation ? `<p class="overview-action-explanation">${explanation}</p>` : ''}
            <div class="overview-action-field"><label for="overviewActionAdGroup">Ad group</label><select id="overviewActionAdGroup" required>${overviewTargetOptions(adGroups, 'ad_group', selectedAdGroup)}</select></div>
            <div class="overview-action-field"><label for="overviewActionMatchType">Match type</label><select id="overviewActionMatchType"><option value="BROAD">Broad match</option><option value="PHRASE">Phrase match</option><option value="EXACT">Exact match</option></select></div>
            ${keywordText ? '' : `<div class="overview-action-field" style="grid-column:1/-1"><label for="overviewActionFinalUrl">Final URL (optional)</label><input id="overviewActionFinalUrl" type="url" maxlength="2048" placeholder="https://example.com/landing-page" autocomplete="url"></div>`}
        </div>
        <div class="overview-action-error" aria-live="polite"></div>
        <button class="btn btn-primary overview-action-submit" type="submit">Review keyword change</button>
    </form>`;
    const textInput = host.querySelector('#overviewActionKeywordText');
    if (textInput) textInput.focus();
    host.querySelector('form')?.addEventListener('submit', async event => {
        event.preventDefault();
        const error = host.querySelector('.overview-action-error');
        const adGroupId = host.querySelector('#overviewActionAdGroup')?.value || '';
        const adGroup = adGroups.find(row => row.adGroupId === adGroupId);
        const text = String(textInput?.value || '').trim();
        if (!text) {
            if (error) error.textContent = 'Enter a keyword.';
            return;
        }
        if (!adGroup) {
            if (error) error.textContent = 'Choose the ad group that should own this keyword.';
            return;
        }
        const matchType = host.querySelector('#overviewActionMatchType')?.value || 'BROAD';
        const finalUrl = String(host.querySelector('#overviewActionFinalUrl')?.value || '').trim();
        await reviewOverviewKeywordMutation(popover, 'keyword_changes', {
            action: 'add', campaignId: adGroup.campaignId, adGroupId, keywordText: text, matchType,
            ...(finalUrl ? { finalUrl } : {})
        }, keywordText ? 'overview search term keyword add' : 'overview keyword add');
    });
    positionOverviewPopover(
        popover,
        document.querySelector('.overview-search-chip[aria-expanded="true"]') || document.getElementById('overviewAddKeywordBtn')
    );
}

function mountOverviewNegativeForm(popover, keywordText, sourceType = 'search') {
    const host = prepareOverviewActionHost(popover);
    if (!host) return;
    const filters = selectedDashboardFilters();
    const campaigns = overviewCampaignRows();
    const adGroups = overviewAvailableAdGroups();
    const initialScope = filters.adGroupId ? 'ad_group' : (filters.campaignId ? 'campaign' : '');
    const sourceLabel = sourceType === 'word' ? 'word' : 'search';
    const explanation = sourceType === 'word'
        ? 'Only this word will be added as a negative keyword. The example searches shown above will not be added.'
        : 'This complete search phrase will be added as the negative keyword.';
    host.innerHTML = `<form class="overview-action-panel" id="overviewNegativeActionForm">
        <h4>Add this ${sourceLabel} as a negative keyword</h4>
        <div class="overview-action-grid">
            <div class="overview-action-field" style="grid-column:1/-1"><label for="overviewNegativeKeywordText">Negative keyword</label><input id="overviewNegativeKeywordText" value="${esc(keywordText)}" maxlength="80" required autocomplete="off"></div>
            <p class="overview-action-explanation">${explanation}</p>
            <div class="overview-action-field"><label for="overviewNegativeScope">Scope</label><select id="overviewNegativeScope" required>
                <option value="">Choose a scope</option><option value="campaign"${initialScope === 'campaign' ? ' selected' : ''}>Campaign</option><option value="ad_group"${initialScope === 'ad_group' ? ' selected' : ''}>Ad group</option>
            </select></div>
            <div class="overview-action-field"><label for="overviewNegativeMatchType">Match type</label><select id="overviewNegativeMatchType"><option value="BROAD">Broad match</option><option value="PHRASE">Phrase match</option><option value="EXACT">Exact match</option></select></div>
            <div class="overview-action-field" style="grid-column:1/-1"><label for="overviewNegativeOwner">Campaign or ad group</label><select id="overviewNegativeOwner" required></select></div>
        </div>
        <div class="overview-action-error" aria-live="polite"></div>
        <button class="btn btn-primary overview-action-submit" type="submit">Review negative keyword change</button>
    </form>`;
    const scopeSelect = host.querySelector('#overviewNegativeScope');
    const ownerSelect = host.querySelector('#overviewNegativeOwner');
    const refreshOwners = () => {
        const scope = scopeSelect?.value || '';
        if (!ownerSelect) return;
        if (scope === 'campaign') ownerSelect.innerHTML = overviewTargetOptions(campaigns, 'campaign', filters.campaignId || '');
        else if (scope === 'ad_group') ownerSelect.innerHTML = overviewTargetOptions(adGroups, 'ad_group', filters.adGroupId || '');
        else ownerSelect.innerHTML = '<option value="">Choose a scope first</option>';
    };
    refreshOwners();
    scopeSelect?.addEventListener('change', refreshOwners);
    host.querySelector('form')?.addEventListener('submit', async event => {
        event.preventDefault();
        const error = host.querySelector('.overview-action-error');
        const scope = scopeSelect?.value || '';
        const ownerId = ownerSelect?.value || '';
        const text = String(host.querySelector('#overviewNegativeKeywordText')?.value || '').trim();
        if (!text) {
            if (error) error.textContent = 'Enter a negative keyword.';
            return;
        }
        if (!scope || !ownerId) {
            if (error) error.textContent = 'Choose a campaign or ad group for this negative keyword.';
            return;
        }
        const adGroup = scope === 'ad_group' ? adGroups.find(row => row.adGroupId === ownerId) : null;
        const matchType = host.querySelector('#overviewNegativeMatchType')?.value || 'BROAD';
        await reviewOverviewKeywordMutation(popover, 'negative_keyword_changes', {
            action: 'add',
            scope,
            campaignId: scope === 'campaign' ? ownerId : adGroup?.campaignId,
            adGroupId: scope === 'ad_group' ? ownerId : undefined,
            keywordText: text,
            matchType
        }, 'overview search term negative keyword add');
    });
    positionOverviewPopover(popover, document.querySelector('.overview-search-chip[aria-expanded="true"]'));
}

function openOverviewSearchPopover(anchor, row) {
    const popover = getOverviewDetailHost(anchor, `Search details for ${row.label}`, false);
    if (overviewSearchState.mode === 'words') {
        const examples = Array.isArray(row.examples) ? row.examples : [];
        popover.innerHTML = `${overviewPopoverHeader(row.label)}<div class="overview-popover-content">
            <p class="overview-popover-note">This word appears in the searches below.</p>
            ${overviewMetricsHtml(row)}
            <ul class="overview-keyword-detail-list">${examples.map(example => `<li><span>Search</span><strong>${esc(example)}</strong></li>`).join('') || '<li>No examples available</li>'}</ul>
            <div class="overview-popover-actions">
                <button type="button" class="btn btn-primary" data-overview-action="keyword">Add as keyword</button>
                <button type="button" class="btn btn-secondary" data-overview-action="negative">Add as negative keyword</button>
            </div>
            <div class="overview-action-host"></div>
        </div>`;
        popover.querySelector('[data-overview-action="keyword"]')?.addEventListener('click', () => mountOverviewKeywordForm(popover, row.label, 'word'));
        popover.querySelector('[data-overview-action="negative"]')?.addEventListener('click', () => mountOverviewNegativeForm(popover, row.label, 'word'));
    } else {
        const scopes = Array.isArray(row.scopes) ? row.scopes : [];
        const keywordMap = new Map();
        scopes.flatMap(scope => Array.isArray(scope.matchedKeywords) ? scope.matchedKeywords : []).forEach(keyword => {
            const text = String(keyword?.text || '').trim();
            if (text) keywordMap.set(`${text}|${keyword.matchType || ''}`, keyword);
        });
        const keywords = Array.from(keywordMap.values());
        const trigger = keywords.length
            ? `Triggered by your keyword: <strong>${esc(keywords[0].text)}</strong>${keywords.length > 1 ? ` +${keywords.length - 1} more` : ''}`
            : 'Matched keyword was not reported by Google for this search.';
        const scopeCount = Number(row.scopeCount || scopes.length);
        const scopeText = scopeCount === 1
            ? `${scopes[0].campaignName || scopes[0].campaignId} › ${scopes[0].adGroupName || scopes[0].adGroupId}`
            : `${scopeCount} contributing ad groups`;
        popover.innerHTML = `${overviewPopoverHeader(row.label)}<div class="overview-popover-content">
            <p class="overview-popover-trigger">${trigger}</p>
            <p class="overview-popover-scope">Scope: <strong>${esc(scopeText)}</strong></p>
            ${overviewMetricsHtml(row)}
            <div class="overview-popover-actions">
                <button type="button" class="btn btn-primary" data-overview-action="keyword">Add as keyword</button>
                <button type="button" class="btn btn-secondary" data-overview-action="negative">Add as negative keyword</button>
            </div>
            <div class="overview-action-host"></div>
        </div>`;
        popover.querySelector('[data-overview-action="keyword"]')?.addEventListener('click', () => mountOverviewKeywordForm(popover, row.label, 'search'));
        popover.querySelector('[data-overview-action="negative"]')?.addEventListener('click', () => mountOverviewNegativeForm(popover, row.label, 'search'));
    }
    popover.querySelector('.overview-popover-close')?.addEventListener('click', closeOverviewPopover);
    positionOverviewPopover(popover, anchor);
}

function openOverviewKeywordDetail(anchor, row) {
    const popover = getOverviewDetailHost(anchor, `Keyword details for ${row.keywordText}`, true);
    popover.innerHTML = `${overviewPopoverHeader(row.keywordText)}<div class="overview-popover-content">
        <p class="overview-popover-scope"><strong>${esc(row.campaignName || row.campaignId)}</strong> › <strong>${esc(row.adGroupName || row.adGroupId)}</strong> › ${esc(row.keywordText)}</p>
        ${overviewMetricsHtml(row)}
        <ul class="overview-keyword-detail-list">
            <li><span>Match type</span><strong>${esc(formatMatchType(row.matchType))}</strong></li>
            <li><span>Status</span><strong>${esc(formatControlStatus(row.status))}</strong></li>
            <li><span>Eligibility</span><strong>${esc(formatControlStatus(row.primaryStatus))}</strong></li>
            <li><span>Triggered Google searches</span><strong>Open Search terms</strong></li>
        </ul>
    </div>`;
    popover.querySelector('.overview-popover-close')?.addEventListener('click', closeOverviewPopover);
    positionOverviewPopover(popover, anchor);
}

function openOverviewAddKeyword(anchor) {
    const popover = getOverviewDetailHost(anchor, 'Add keyword', false);
    popover.innerHTML = `${overviewPopoverHeader('Add keyword')}<div class="overview-popover-content">
        <p class="overview-popover-note">Choose the ad group that should own the keyword. You will review the exact change before anything is sent to Google Ads.</p>
        <div class="overview-action-host"></div>
    </div>`;
    popover.querySelector('.overview-popover-close')?.addEventListener('click', closeOverviewPopover);
    mountOverviewKeywordForm(popover, '');
    positionOverviewPopover(popover, anchor);
}

function navigateOverviewToKeywords(subtab) {
    const tab = document.querySelector('.nav-item[data-tab="keywords"]');
    if (tab) tab.click();
    activateKeywordSubtab(subtab);
}

function setupOverviewWidgets() {
    const searchMetric = document.getElementById('overviewSearchMetric');
    if (!searchMetric || searchMetric.hasAttribute('data-bound')) return;
    searchMetric.addEventListener('change', () => {
        overviewSearchState.metric = searchMetric.value;
        overviewSearchState.page = 1;
        populateOverviewConversionFilter(overviewSearchState.data);
        void loadOverviewSearchWidget(true);
    });
    document.getElementById('overviewSearchConversionFilter')?.addEventListener('change', event => {
        const value = event.currentTarget.value;
        const separator = value.indexOf(':');
        overviewSearchState.conversionType = separator > 0 ? value.slice(0, separator) : 'all';
        overviewSearchState.conversionValue = separator > 0 ? value.slice(separator + 1) : '';
        overviewSearchState.page = 1;
        void loadOverviewSearchWidget(true);
    });
    document.querySelectorAll('.overview-search-tab').forEach(button => button.addEventListener('click', () => {
        overviewSearchState.mode = button.dataset.searchMode || 'searches';
        overviewSearchState.pageSize = overviewSearchState.mode === 'words' ? 30 : 20;
        overviewSearchState.page = 1;
        closeOverviewPopover();
        void loadOverviewSearchWidget(true);
    }));
    document.getElementById('overviewSearchChips')?.addEventListener('click', event => {
        const button = event.target.closest('[data-search-row]');
        if (!button) return;
        if (button.getAttribute('aria-expanded') === 'true') {
            closeOverviewPopover();
            return;
        }
        const row = overviewSearchState.data?.rows?.[Number(button.dataset.searchRow)];
        if (row) openOverviewSearchPopover(button, row);
    });
    document.getElementById('overviewSearchPrev')?.addEventListener('click', () => {
        if (overviewSearchState.page <= 1) return;
        overviewSearchState.page -= 1;
        closeOverviewPopover();
        void loadOverviewSearchWidget(true);
    });
    document.getElementById('overviewSearchNext')?.addEventListener('click', () => {
        const totalPages = overviewSearchState.data?.pagination?.totalPages || 0;
        if (!totalPages || overviewSearchState.page >= totalPages) return;
        overviewSearchState.page += 1;
        closeOverviewPopover();
        void loadOverviewSearchWidget(true);
    });
    document.getElementById('overviewAllSearchesBtn')?.addEventListener('click', () => navigateOverviewToKeywords('search-terms'));
    document.getElementById('overviewAddKeywordBtn')?.addEventListener('click', event => {
        const btn = event.currentTarget;
        if (btn.getAttribute('aria-expanded') === 'true') {
            closeOverviewPopover();
            return;
        }
        openOverviewAddKeyword(btn);
    });
    document.getElementById('overviewAllKeywordsBtn')?.addEventListener('click', () => navigateOverviewToKeywords('active'));
    document.getElementById('overviewNegativeKeywordsBtn')?.addEventListener('click', () => navigateOverviewToKeywords('negatives'));
    document.querySelectorAll('.overview-keyword-metric').forEach((select, index) => select.addEventListener('change', () => {
        const previous = overviewKeywordState.columns[index];
        const duplicateIndex = overviewKeywordState.columns.findIndex((value, candidate) => candidate !== index && value === select.value);
        if (duplicateIndex >= 0) overviewKeywordState.columns[duplicateIndex] = previous;
        overviewKeywordState.columns[index] = select.value;
        overviewKeywordState.sort = select.value;
        overviewKeywordState.page = 1;
        void loadOverviewKeywordWidget(true);
    }));
    document.getElementById('overviewKeywordDirection')?.addEventListener('click', () => {
        overviewKeywordState.direction = overviewKeywordState.direction === 'desc' ? 'asc' : 'desc';
        overviewKeywordState.page = 1;
        void loadOverviewKeywordWidget(true);
    });
    const keywordRows = document.getElementById('overviewKeywordRows');
    const openKeywordRow = target => {
        const rowElement = target.closest('[data-keyword-row]');
        if (!rowElement) return;
        if (rowElement.getAttribute('aria-expanded') === 'true') {
            closeOverviewPopover();
            return;
        }
        const row = overviewKeywordState.data?.rows?.[Number(rowElement.dataset.keywordRow)];
        if (row) openOverviewKeywordDetail(rowElement, row);
    };
    keywordRows?.addEventListener('click', event => openKeywordRow(event.target));
    keywordRows?.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openKeywordRow(event.target);
    });
    document.getElementById('overviewKeywordPrev')?.addEventListener('click', () => {
        if (overviewKeywordState.page <= 1) return;
        overviewKeywordState.page -= 1;
        closeOverviewPopover();
        void loadOverviewKeywordWidget(true);
    });
    document.getElementById('overviewKeywordNext')?.addEventListener('click', () => {
        const totalPages = overviewKeywordState.data?.pagination?.totalPages || 0;
        if (!totalPages || overviewKeywordState.page >= totalPages) return;
        overviewKeywordState.page += 1;
        closeOverviewPopover();
        void loadOverviewKeywordWidget(true);
    });
    document.addEventListener('click', event => {
        const popover = document.getElementById('overviewFloatingPopover');
        if (!popover || popover.contains(event.target)) return;
        if (event.target.closest('.overview-search-chip, #overviewAddKeywordBtn, [data-keyword-row], [data-search-term-row]')) return;
        closeOverviewPopover();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeOverviewPopover();
    });
    window.addEventListener('resize', closeOverviewPopover);
    searchMetric.setAttribute('data-bound', 'true');
    renderOverviewKeywordMetricSelectors();
    setupOverviewKeywordColumnResizing();
    setupOverviewSearchTermWidget();
}

function closeKeywordAddModal() {
    document.getElementById('keywordAddModal')?.remove();
}

function updateKeywordAddDraftSummary(kind) {
    const negative = kind === 'negative';
    const input = document.getElementById(negative ? 'negativeTextInput' : 'keywordTextInput');
    const output = document.getElementById(negative ? 'negativeAddDraftCount' : 'keywordAddDraftCount');
    if (!input || !output) return;
    const count = String(input.value || '').split(/[\n,]+/).map(value => value.trim()).filter(Boolean).length;
    output.textContent = negative
        ? `${count} negative${count === 1 ? '' : 's'} ready`
        : `${count} keyword${count === 1 ? '' : 's'} ready`;
}

function submitKeywordAddForm(event) {
    event.preventDefault();
    const adGroupId = document.getElementById('keywordAdGroupSelect')?.value || '';
    const adGroup = (controlsState?.adGroups || []).find(row => row.adGroupId === adGroupId) || {};
    if (!adGroupId || !adGroup.campaignId) {
        showToast('Choose an ad group before reviewing keywords.', true);
        return;
    }
    const finalUrl = String(document.getElementById('keywordFinalUrlInput')?.value || '').trim();
    const entries = parseBulkKeywordEntries(
        document.getElementById('keywordTextInput')?.value,
        document.getElementById('keywordMatchTypeSelect')?.value
    );
    if (entries === null) return;
    if (!entries.length) {
        showToast('Enter at least one keyword to review.', true);
        return;
    }
    const changes = entries.map(entry => ({
        action: 'add',
        campaignId: adGroup.campaignId,
        adGroupId,
        keywordText: entry.keywordText,
        matchType: entry.matchType,
        ...(finalUrl ? { finalUrl } : {})
    }));
    previewControlsMutation('keyword_changes', changes, 'dashboard keyword bulk add');
}

function submitNegativeAddForm(event) {
    event.preventDefault();
    const scope = document.getElementById('negativeScopeSelect')?.value || 'campaign';
    const ownerId = document.getElementById('negativeOwnerSelect')?.value || '';
    if (!ownerId) {
        showToast(`Choose a ${scope === 'campaign' ? 'campaign' : scope === 'ad_group' ? 'ad group' : 'negative keyword list'} before reviewing negatives.`, true);
        return;
    }
    const owner = scope === 'campaign'
        ? (controlsState?.campaigns || []).find(row => row.campaignId === ownerId) || {}
        : scope === 'ad_group'
            ? (controlsState?.adGroups || []).find(row => row.adGroupId === ownerId) || {}
            : (controlsState?.sharedNegativeSets || []).find(row => row.sharedSetId === ownerId) || {};
    const entries = parseBulkKeywordEntries(
        document.getElementById('negativeTextInput')?.value,
        document.getElementById('negativeMatchTypeSelect')?.value
    );
    if (entries === null) return;
    if (!entries.length) {
        showToast('Enter at least one negative keyword to review.', true);
        return;
    }
    const changes = entries.map(entry => ({
        action: 'add',
        scope,
        campaignId: scope === 'campaign' ? ownerId : owner.campaignId,
        adGroupId: scope === 'ad_group' ? ownerId : undefined,
        sharedSetId: scope === 'shared_list' ? ownerId : undefined,
        sharedSetResourceName: scope === 'shared_list' ? owner.sharedSetResourceName : undefined,
        keywordText: entry.keywordText,
        matchType: entry.matchType
    }));
    previewControlsMutation('negative_keyword_changes', changes, 'dashboard negative keyword bulk add');
}

async function openKeywordAddModal(kind) {
    const negative = kind === 'negative';
    if (!controlsState) await loadControlsState();
    if (!controlsState) {
        showToast('Google Ads settings are unavailable right now. Refresh and try again.', true);
        return;
    }
    closeKeywordAddModal();
    const template = document.getElementById(negative ? 'negativeAddModalTemplate' : 'keywordAddModalTemplate');
    if (!template) return;
    const modal = document.createElement('div');
    modal.id = 'keywordAddModal';
    modal.className = 'modal-overlay show';
    const title = negative ? 'Add negative keywords' : 'Add keywords';
    const subtitle = negative
        ? 'Block unwanted searches at exactly the scope you choose.'
        : 'Add keywords to one ad group, then review every validated change before applying.';
    modal.innerHTML = `<div class="modal-content-card keyword-add-modal" role="dialog" aria-modal="true" aria-labelledby="keywordAddModalTitle">
        <div class="modal-header keyword-add-modal__header"><div><span class="keyword-add-modal__eyebrow">Google Ads</span><h3 id="keywordAddModalTitle">${esc(title)}</h3><p>${esc(subtitle)}</p></div><button class="modal-close-btn" type="button" data-close-keyword-add aria-label="Close">×</button></div>
        <div class="keyword-add-modal__body">${template.innerHTML}</div>
    </div>`;
    document.body.appendChild(modal);
    renderControlsSelects();
    const form = modal.querySelector(negative ? '#negativeControlForm' : '#keywordControlForm');
    form?.addEventListener('submit', negative ? submitNegativeAddForm : submitKeywordAddForm);
    modal.querySelectorAll('[data-close-keyword-add]').forEach(button => button.addEventListener('click', closeKeywordAddModal));
    modal.addEventListener('click', event => {
        if (event.target === modal) closeKeywordAddModal();
    });
    const textInput = modal.querySelector(negative ? '#negativeTextInput' : '#keywordTextInput');
    textInput?.addEventListener('input', () => updateKeywordAddDraftSummary(kind));
    if (negative) modal.querySelector('#negativeScopeSelect')?.addEventListener('change', refreshNegativeOwnerOptions);
    updateKeywordAddDraftSummary(kind);
    textInput?.focus();
}

function setupControls() {
    if (els.activityHistoryReloadBtn) els.activityHistoryReloadBtn.addEventListener('click', () => loadControlsState(true));
    setupScheduleDayPicker();
    document.getElementById('openKeywordAddModalBtn')?.addEventListener('click', () => void openKeywordAddModal('keyword'));
    document.getElementById('openNegativeAddModalBtn')?.addEventListener('click', () => void openKeywordAddModal('negative'));
    document.getElementById('scheduleControlForm')?.addEventListener('submit', event => {
        event.preventDefault();
        const selectedDays = selectedScheduleDays();
        if (!selectedDays.length) {
            showToast('Choose at least one schedule day.', true);
            return;
        }
        const campaignId = document.getElementById('scheduleCampaignSelect')?.value;
        const startHour = document.getElementById('scheduleStartHourInput')?.value;
        const startMinute = document.getElementById('scheduleStartMinuteSelect')?.value;
        const endHour = document.getElementById('scheduleEndHourInput')?.value;
        const endMinute = document.getElementById('scheduleEndMinuteSelect')?.value;
        const addChanges = selectedDays.map(dayOfWeek => ({
            action: 'add',
            campaignId,
            dayOfWeek,
            startHour,
            startMinute,
            endHour,
            endMinute
        }));
        previewScheduleAddOrEdit(addChanges);
    });
    document.getElementById('scheduleCancelEditBtn')?.addEventListener('click', clearScheduleEditMode);
    document.querySelectorAll('[data-keyword-bulk-action]').forEach(button => {
        button.addEventListener('click', event => handleKeywordBulkAction(event, button.dataset.keywordBulkAction));
    });
    document.querySelectorAll('[data-negative-bulk-action]').forEach(button => {
        button.addEventListener('click', event => handleNegativeBulkAction(event, button.dataset.negativeBulkAction));
    });
    document.querySelectorAll('[data-keyword-bulk-clear]').forEach(button => {
        button.addEventListener('click', () => clearKeywordSelection(button.dataset.keywordBulkClear));
    });
    document.addEventListener('click', event => {
        const popover = document.getElementById('keywordInlinePopover');
        if (!popover || popover.contains(event.target) || event.target.closest('.keyword-editable-cell__button, .keyword-status-button, .keyword-bulk-btn')) return;
        closeKeywordInlinePopover();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            closeKeywordInlinePopover();
            closeKeywordAddModal();
        }
    });
}

function parseBulkKeywordEntries(rawValue, fallbackMatchType) {
    const fallback = String(fallbackMatchType || 'BROAD').toUpperCase();
    const parts = String(rawValue || '').split(/[\n,]+/);
    const seen = new Set();
    const entries = [];
    for (const part of parts) {
        let keywordText = String(part || '').trim().replace(/\s+/g, ' ');
        if (!keywordText) continue;
        let matchType = fallback;
        if (keywordText.startsWith('[') && keywordText.endsWith(']')) {
            keywordText = keywordText.slice(1, -1).trim();
            matchType = 'EXACT';
        } else if ((keywordText.startsWith('"') && keywordText.endsWith('"')) || (keywordText.startsWith('“') && keywordText.endsWith('”'))) {
            keywordText = keywordText.slice(1, -1).trim();
            matchType = 'PHRASE';
        }
        if (!keywordText) continue;
        if (keywordText.length > 80 || keywordText.split(/\s+/).length > 10) {
            showToast(`“${keywordText}” exceeds Google’s 80-character or 10-word keyword limit.`, true);
            return null;
        }
        const key = `${keywordText.toLowerCase()}|${matchType}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ keywordText, matchType });
    }
    return entries;
}

function keywordMutationBase(row) {
    return {
        campaignId: row.campaignId,
        adGroupId: row.adGroupId,
        criterionId: row.criterionId,
        resourceName: row.resourceName,
        keywordText: row.keywordText || row.keyword,
        matchType: row.matchType,
        currentStatus: row.status,
        currentFinalUrl: row.finalUrl || ''
    };
}

function negativeMutationBase(row) {
    return {
        scope: row.scope || negativeScopeFromRow(row),
        campaignId: row.campaignId,
        adGroupId: row.adGroupId,
        sharedSetId: row.sharedSetId,
        sharedSetResourceName: row.sharedSetResourceName,
        criterionId: row.criterionId,
        resourceName: row.resourceName,
        keywordText: row.keywordText || row.keyword,
        matchType: row.matchType,
        currentStatus: row.status || 'ENABLED'
    };
}

function selectedKeywordManagementRows(kind) {
    const gridId = kind === 'negative' ? 'grid-negatives' : 'grid-allKeywords';
    return gridInstances[gridId]?.getSelectedRows?.() || [];
}

function updateKeywordBulkToolbar(kind) {
    const negative = kind === 'negative';
    const rows = selectedKeywordManagementRows(kind);
    const toolbar = document.getElementById(negative ? 'negativeBulkToolbar' : 'keywordBulkToolbar');
    const count = document.getElementById(negative ? 'negativeBulkCount' : 'keywordBulkCount');
    if (!toolbar || !count) return;
    toolbar.hidden = rows.length === 0;
    count.textContent = `${rows.length} selected`;
}

function clearKeywordSelection(kind) {
    const gridId = kind === 'negatives' || kind === 'negative' ? 'grid-negatives' : 'grid-allKeywords';
    gridInstances[gridId]?.deselectAll?.();
    updateKeywordBulkToolbar(gridId === 'grid-negatives' ? 'negative' : 'keyword');
}

function ensureBulkSelection(rows) {
    if (!rows.length) {
        showToast('Select at least one row first.', true);
        return false;
    }
    return true;
}

function handleKeywordBulkAction(event, action) {
    event?.stopPropagation?.();
    const rows = selectedKeywordManagementRows('keyword');
    if (!ensureBulkSelection(rows)) return;
    if (action === 'match' || action === 'url') {
        openKeywordBulkEditor(event.currentTarget, 'keyword', action, rows);
        return;
    }
    const changes = rows.map(row => ({
        ...keywordMutationBase(row),
        ...(action === 'remove'
            ? { action: 'remove' }
            : { action: 'set_status', targetStatus: action === 'enable' ? 'ENABLED' : 'PAUSED' })
    }));
    previewControlsMutation('keyword_changes', changes, `dashboard keyword bulk ${action}`);
}

function handleNegativeBulkAction(event, action) {
    event?.stopPropagation?.();
    const rows = selectedKeywordManagementRows('negative');
    if (!ensureBulkSelection(rows)) return;
    if (action === 'match') {
        openKeywordBulkEditor(event.currentTarget, 'negative', action, rows);
        return;
    }
    previewControlsMutation('negative_keyword_changes', rows.map(row => ({
        ...negativeMutationBase(row),
        action: 'remove'
    })), 'dashboard negative keyword bulk remove');
}

function closeKeywordInlinePopover() {
    document.getElementById('keywordInlinePopover')?.remove();
}

function positionKeywordInlinePopover(popover, anchor) {
    if (window.innerWidth <= 768 || !anchor?.getBoundingClientRect) return;
    const rect = anchor.getBoundingClientRect();
    const width = popover.offsetWidth || 390;
    const height = popover.offsetHeight || 240;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const below = rect.bottom + 8;
    const top = below + height <= window.innerHeight - 12 ? below : Math.max(12, rect.top - height - 8);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
}

function mountKeywordInlinePopover(anchor, html) {
    closeKeywordInlinePopover();
    const popover = document.createElement('div');
    popover.id = 'keywordInlinePopover';
    popover.className = 'keyword-inline-popover';
    popover.innerHTML = html;
    document.body.appendChild(popover);
    positionKeywordInlinePopover(popover, anchor);
    return popover;
}

function scopeLabelForNegative(row) {
    const scope = row.scope || negativeScopeFromRow(row);
    if (scope === 'campaign') return `Campaign · ${row.campaignName || lookupCampaignName(row.campaignId)}`;
    if (scope === 'ad_group') return `Ad group · ${row.adGroupName || lookupAdGroupName(row.adGroupId)}`;
    return `Negative list · ${row.sharedSetName || row.addedTo || row.sharedSetId}`;
}

function matchTypeOptions(selected) {
    return ['BROAD', 'PHRASE', 'EXACT']
        .map(value => `<option value="${value}"${String(selected).toUpperCase() === value ? ' selected' : ''}>${esc(formatMatchType(value))}</option>`)
        .join('');
}

function openKeywordBulkEditor(anchor, kind, action, rows) {
    const negative = kind === 'negative';
    const title = action === 'match' ? 'Change match type' : 'Change final URLs';
    const field = action === 'match'
        ? `<label>New match type<select id="keywordBulkEditorValue">${matchTypeOptions(rows[0]?.matchType)}</select></label>`
        : `<label>Final URL<input id="keywordBulkEditorValue" type="url" placeholder="Leave blank to clear the final URL"></label>`;
    const popover = mountKeywordInlinePopover(anchor, `
        <div class="keyword-inline-popover__head"><div><strong>${esc(title)}</strong><span>${rows.length} selected ${negative ? 'negative keyword' : 'keyword'}${rows.length === 1 ? '' : 's'}</span></div><button class="keyword-inline-popover__close" type="button" aria-label="Close">×</button></div>
        <form id="keywordBulkEditorForm">
            <div class="keyword-inline-popover__fields keyword-inline-popover__fields--single">${field}</div>
            <div class="keyword-inline-popover__actions"><button class="btn btn-secondary btn-sm" type="button" data-popover-cancel>Cancel</button><button class="btn btn-primary btn-sm" type="submit">Review change</button></div>
        </form>`);
    popover.querySelector('.keyword-inline-popover__close').onclick = closeKeywordInlinePopover;
    popover.querySelector('[data-popover-cancel]').onclick = closeKeywordInlinePopover;
    popover.querySelector('form').onsubmit = event => {
        event.preventDefault();
        const value = String(popover.querySelector('#keywordBulkEditorValue')?.value || '').trim();
        let changes;
        if (action === 'match') {
            changes = rows.map(row => ({
                ...(negative ? negativeMutationBase(row) : keywordMutationBase(row)),
                action: 'replace',
                newKeywordText: row.keywordText || row.keyword,
                newMatchType: value
            }));
        } else {
            changes = rows.map(row => ({ ...keywordMutationBase(row), action: 'set_final_url', finalUrl: value }));
        }
        closeKeywordInlinePopover();
        previewControlsMutation(negative ? 'negative_keyword_changes' : 'keyword_changes', changes, `dashboard ${kind} bulk ${action}`);
    };
}

function openKeywordInlineEditor(event, kind, mode, key) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const negative = kind === 'negative';
    const row = (negative ? negativeManagementRows : keywordManagementRows).get(key);
    if (!row) {
        showToast('This row is no longer current. Refresh and try again.', true);
        return;
    }
    const title = mode === 'url' ? 'Edit final URL' : negative ? 'Edit negative keyword' : 'Edit keyword';
    const subtitle = negative ? scopeLabelForNegative(row) : `${row.campaign || lookupCampaignName(row.campaignId)} · ${row.adGroup || lookupAdGroupName(row.adGroupId)}`;
    const fields = mode === 'url'
        ? `<div class="keyword-inline-popover__fields keyword-inline-popover__fields--single"><label>Final URL<input id="keywordInlineUrl" type="url" value="${esc(row.finalUrl || '')}" placeholder="https://example.com/landing-page"></label></div>`
        : `<div class="keyword-inline-popover__fields">
            <label>Keyword<input id="keywordInlineText" maxlength="80" value="${esc(row.keywordText || row.keyword || '')}" ${mode === 'match' ? 'readonly' : ''}></label>
            <label>Match type<select id="keywordInlineMatch">${matchTypeOptions(row.matchType)}</select></label>
        </div>`;
    const popover = mountKeywordInlinePopover(event.currentTarget, `
        <div class="keyword-inline-popover__head"><div><strong>${esc(title)}</strong><span>${esc(subtitle)}</span></div><button class="keyword-inline-popover__close" type="button" aria-label="Close">×</button></div>
        <form id="keywordInlineForm">${fields}<div class="keyword-inline-popover__actions"><button class="btn btn-secondary btn-sm" type="button" data-popover-cancel>Cancel</button><button class="btn btn-primary btn-sm" type="submit">Review change</button></div></form>`);
    popover.querySelector('.keyword-inline-popover__close').onclick = closeKeywordInlinePopover;
    popover.querySelector('[data-popover-cancel]').onclick = closeKeywordInlinePopover;
    popover.querySelector('form').onsubmit = submitEvent => {
        submitEvent.preventDefault();
        const base = negative ? negativeMutationBase(row) : keywordMutationBase(row);
        const change = mode === 'url'
            ? { ...base, action: 'set_final_url', finalUrl: String(popover.querySelector('#keywordInlineUrl')?.value || '').trim() }
            : {
                ...base,
                action: 'replace',
                newKeywordText: String(popover.querySelector('#keywordInlineText')?.value || '').trim(),
                newMatchType: popover.querySelector('#keywordInlineMatch')?.value
            };
        closeKeywordInlinePopover();
        previewControlsMutation(negative ? 'negative_keyword_changes' : 'keyword_changes', [change], `dashboard ${kind} inline ${mode}`);
    };
    const focusTarget = popover.querySelector(mode === 'url' ? '#keywordInlineUrl' : mode === 'match' ? '#keywordInlineMatch' : '#keywordInlineText');
    focusTarget?.focus();
    if (focusTarget?.select && mode !== 'match') focusTarget.select();
}

function openKeywordStatusMenu(event, key) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const row = keywordManagementRows.get(key);
    if (!row) {
        showToast('This keyword is no longer current. Refresh and try again.', true);
        return;
    }
    const current = String(row.status || '').toUpperCase();
    const popover = mountKeywordInlinePopover(event.currentTarget, `
        <div class="keyword-inline-popover__head"><div><strong>Change keyword status</strong><span>${esc(row.keywordText || row.keyword)} · ${esc(row.adGroup || lookupAdGroupName(row.adGroupId))}</span></div><button class="keyword-inline-popover__close" type="button" aria-label="Close">×</button></div>
        <div class="keyword-inline-popover__fields keyword-inline-popover__fields--single">
            <button class="keyword-bulk-btn" type="button" data-status-action="enable" ${current === 'ENABLED' ? 'disabled' : ''}>Enable</button>
            <button class="keyword-bulk-btn" type="button" data-status-action="pause" ${current === 'PAUSED' ? 'disabled' : ''}>Pause</button>
            <button class="keyword-bulk-btn keyword-bulk-btn--danger" type="button" data-status-action="remove">Remove</button>
        </div>`);
    popover.querySelector('.keyword-inline-popover__close').onclick = closeKeywordInlinePopover;
    popover.querySelectorAll('[data-status-action]').forEach(button => {
        button.onclick = () => {
            const action = button.dataset.statusAction;
            const change = {
                ...keywordMutationBase(row),
                ...(action === 'remove' ? { action: 'remove' } : { action: 'set_status', targetStatus: action === 'enable' ? 'ENABLED' : 'PAUSED' })
            };
            closeKeywordInlinePopover();
            previewControlsMutation('keyword_changes', [change], `dashboard keyword inline ${action}`);
        };
    });
}

function setupScheduleDayPicker() {
    const picker = document.getElementById('scheduleDayPicker');
    if (!picker) return;
    picker.querySelectorAll('.schedule-day-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            btn.classList.toggle('active');
            syncSchedulePresetState();
        });
    });
    picker.querySelectorAll('.schedule-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const days = String(btn.dataset.days || '').split(',').filter(Boolean);
            setScheduleDays(days);
        });
    });
    syncSchedulePresetState();
}

function selectedScheduleDays() {
    return Array.from(document.querySelectorAll('#scheduleDayPicker .schedule-day-btn.active'))
        .map(btn => btn.dataset.day)
        .filter(Boolean);
}

function setScheduleDays(days) {
    const selected = new Set(days);
    document.querySelectorAll('#scheduleDayPicker .schedule-day-btn').forEach(btn => {
        btn.classList.toggle('active', selected.has(btn.dataset.day));
    });
    syncSchedulePresetState();
}

function syncSchedulePresetState() {
    const selected = selectedScheduleDays().join(',');
    document.querySelectorAll('#scheduleDayPicker .schedule-preset-btn').forEach(btn => {
        btn.classList.toggle('active', selected === String(btn.dataset.days || ''));
    });
}

function setScheduleEditMode(schedule) {
    scheduleEditState = schedule;
    const campaignSelect = document.getElementById('scheduleCampaignSelect');
    if (campaignSelect) campaignSelect.value = schedule.campaignId || '';
    setScheduleDays([schedule.dayOfWeek].filter(Boolean));
    const startHour = document.getElementById('scheduleStartHourInput');
    const startMinute = document.getElementById('scheduleStartMinuteSelect');
    const endHour = document.getElementById('scheduleEndHourInput');
    const endMinute = document.getElementById('scheduleEndMinuteSelect');
    if (startHour) startHour.value = schedule.startHour ?? '';
    if (startMinute) startMinute.value = schedule.startMinute || 'ZERO';
    if (endHour) endHour.value = schedule.endHour ?? '';
    if (endMinute) endMinute.value = schedule.endMinute || 'ZERO';
    const submit = document.getElementById('scheduleSubmitBtn');
    if (submit) submit.textContent = 'Edit';
    const cancel = document.getElementById('scheduleCancelEditBtn');
    if (cancel) cancel.style.display = '';
    document.getElementById('scheduleControlForm')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function clearScheduleEditMode() {
    scheduleEditState = null;
    const submit = document.getElementById('scheduleSubmitBtn');
    if (submit) submit.textContent = 'Apply';
    const cancel = document.getElementById('scheduleCancelEditBtn');
    if (cancel) cancel.style.display = 'none';
}

function scheduleEditRemoveChange() {
    if (!scheduleEditState) return null;
    return {
        action: 'remove',
        campaignId: scheduleEditState.campaignId,
        criterionId: scheduleEditState.criterionId,
        resourceName: scheduleEditState.resourceName,
        campaignName: scheduleEditState.campaignName,
        dayOfWeek: scheduleEditState.dayOfWeek,
        startHour: scheduleEditState.startHour,
        startMinute: scheduleEditState.startMinute,
        endHour: scheduleEditState.endHour,
        endMinute: scheduleEditState.endMinute
    };
}

function scheduleMinuteNumber(minute) {
    const normalized = String(minute || 'ZERO').toUpperCase();
    const minuteMap = { ZERO: 0, FIFTEEN: 15, THIRTY: 30, FORTY_FIVE: 45 };
    if (minuteMap[normalized] !== undefined) return minuteMap[normalized];
    const parsed = Number(String(minute || '').replace(':', ''));
    return Number.isFinite(parsed) ? parsed : 0;
}

function scheduleStartTotal(change) {
    return Number(change.startHour) * 60 + scheduleMinuteNumber(change.startMinute);
}

function scheduleEndTotal(change) {
    return Number(change.endHour) * 60 + scheduleMinuteNumber(change.endMinute);
}

function normalizeScheduleRow(row) {
    return {
        campaignId: row.campaignId ?? row['campaign.id'],
        campaignName: row.campaignName ?? row['campaign.name'],
        criterionId: row.criterionId ?? row['campaign_criterion.criterion_id'],
        resourceName: row.resourceName ?? row['campaign_criterion.resource_name'],
        status: row.status ?? row['campaign_criterion.status'],
        dayOfWeek: row.dayOfWeek ?? row['campaign_criterion.ad_schedule.day_of_week'],
        startHour: row.startHour ?? row['campaign_criterion.ad_schedule.start_hour'],
        startMinute: row.startMinute ?? row['campaign_criterion.ad_schedule.start_minute'],
        endHour: row.endHour ?? row['campaign_criterion.ad_schedule.end_hour'],
        endMinute: row.endMinute ?? row['campaign_criterion.ad_schedule.end_minute']
    };
}

function sameScheduleIdentity(a, b) {
    if (!a || !b) return false;
    if (a.resourceName && b.resourceName && String(a.resourceName) === String(b.resourceName)) return true;
    return a.criterionId && b.criterionId && String(a.criterionId) === String(b.criterionId);
}

function scheduleIntervalsOverlap(a, b) {
    if (String(a.campaignId) !== String(b.campaignId)) return false;
    if (String(a.dayOfWeek) !== String(b.dayOfWeek)) return false;
    return scheduleStartTotal(a) < scheduleEndTotal(b) && scheduleStartTotal(b) < scheduleEndTotal(a);
}

function findScheduleConflicts(addChanges) {
    const editRemove = scheduleEditRemoveChange();
    const existingSchedules = (controlsState?.adSchedules || [])
        .map(normalizeScheduleRow)
        .filter(schedule => String(schedule.status || '').toUpperCase() !== 'REMOVED')
        .filter(schedule => !sameScheduleIdentity(schedule, editRemove));
    return addChanges.flatMap(proposed => existingSchedules
        .filter(existing => scheduleIntervalsOverlap(proposed, existing))
        .map(existing => ({ proposed, existing })));
}

function dedupeScheduleRemoves(removeChanges) {
    const seen = new Set();
    return removeChanges.filter(change => {
        const key = change.resourceName
            ? `resource:${change.resourceName}`
            : `criterion:${change.campaignId}:${change.criterionId}:${change.dayOfWeek}:${change.startHour}:${change.startMinute}:${change.endHour}:${change.endMinute}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function conflictRemoveChanges(conflicts) {
    return dedupeScheduleRemoves(conflicts.map(({ existing }) => ({
        action: 'remove',
        campaignId: existing.campaignId,
        criterionId: existing.criterionId,
        resourceName: existing.resourceName,
        campaignName: existing.campaignName,
        dayOfWeek: existing.dayOfWeek,
        startHour: existing.startHour,
        startMinute: existing.startMinute,
        endHour: existing.endHour,
        endMinute: existing.endMinute
    })));
}

function scheduleBaseRemoveChanges() {
    return [scheduleEditRemoveChange()].filter(Boolean);
}

function schedulePreviewReason() {
    return scheduleEditState ? 'dashboard ad schedule edit' : 'dashboard ad schedule add';
}

function previewScheduleAddOrEdit(addChanges) {
    const conflicts = findScheduleConflicts(addChanges);
    if (conflicts.length) {
        openScheduleConflictModal(addChanges, conflicts);
        return;
    }
    previewControlsMutation('ad_schedule_changes', [...scheduleBaseRemoveChanges(), ...addChanges], schedulePreviewReason());
}

function scheduleConflictSummary(conflict) {
    const proposedTime = formatScheduleTimeRange(
        conflict.proposed.startHour,
        conflict.proposed.startMinute,
        conflict.proposed.endHour,
        conflict.proposed.endMinute
    );
    const existingTime = formatScheduleTimeRange(
        conflict.existing.startHour,
        conflict.existing.startMinute,
        conflict.existing.endHour,
        conflict.existing.endMinute
    );
    return {
        day: formatScheduleDay(conflict.proposed.dayOfWeek),
        proposedTime,
        existingTime,
        campaign: conflict.existing.campaignName || lookupCampaignName(conflict.existing.campaignId) || conflict.existing.campaignId
    };
}

function openScheduleConflictModal(addChanges, conflicts) {
    closeScheduleConflictModal();
    closeControlsPreviewModal();
    pendingScheduleConflict = { addChanges, conflicts };
    const modal = document.createElement('div');
    modal.id = 'scheduleConflictModal';
    modal.className = 'modal-overlay show';
    const shown = conflicts.slice(0, 5).map(conflict => {
        const summary = scheduleConflictSummary(conflict);
        return `<li class="schedule-conflict-item">
            <div class="schedule-conflict-main">
                <strong>${esc(summary.day)}</strong>
                <span>${esc(summary.proposedTime)} overlaps ${esc(summary.existingTime)}</span>
            </div>
            <div class="schedule-conflict-meta">${esc(summary.campaign)}</div>
        </li>`;
    }).join('');
    const remainingCount = conflicts.length - 5;
    const remaining = remainingCount > 0
        ? `<div class="schedule-conflict-more">+${remainingCount} more overlapping schedule${remainingCount === 1 ? '' : 's'}</div>`
        : '';
    modal.innerHTML = `
        <div class="modal-content-card controls-modal schedule-conflict-modal">
            <div class="modal-header">
                <h3>Resolve Overlap</h3>
                <button class="modal-close-btn" onclick="closeScheduleConflictModal()" aria-label="Close modal">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                        stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            </div>
            <div class="modal-body schedule-conflict-body">
                <p class="schedule-conflict-copy">The selected schedule overlaps existing campaign schedules. Choose how to handle the conflicting days before previewing the Google Ads change.</p>
                <ul class="schedule-conflict-list">${shown}</ul>
                ${remaining}
                <div class="control-actions-row schedule-conflict-actions">
                    <button class="btn btn-secondary btn-sm" onclick="closeScheduleConflictModal()">Cancel</button>
                    <button class="btn btn-secondary btn-sm" onclick="resolveScheduleConflict('skip')">Keep Existing</button>
                    <button class="btn btn-primary btn-sm btn-danger-action" onclick="resolveScheduleConflict('replace')">Replace Existing</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(modal);
}

function closeScheduleConflictModal() {
    document.getElementById('scheduleConflictModal')?.remove();
    pendingScheduleConflict = null;
}

function resolveScheduleConflict(mode) {
    if (!pendingScheduleConflict) return;
    const { addChanges, conflicts } = pendingScheduleConflict;
    const baseRemoves = scheduleBaseRemoveChanges();
    if (mode === 'replace') {
        const removes = dedupeScheduleRemoves([...baseRemoves, ...conflictRemoveChanges(conflicts)]);
        closeScheduleConflictModal();
        previewControlsMutation('ad_schedule_changes', [...removes, ...addChanges], schedulePreviewReason());
        return;
    }
    const conflictingAdds = new Set(conflicts.map(conflict => conflict.proposed));
    const safeAdds = addChanges.filter(change => !conflictingAdds.has(change));
    if (!safeAdds.length) {
        showToast('Every selected day overlaps an existing schedule. Replace existing schedules or adjust the time.', true);
        return;
    }
    closeScheduleConflictModal();
    previewControlsMutation('ad_schedule_changes', [...baseRemoves, ...safeAdds], schedulePreviewReason());
}

async function loadControlsState(force = false) {
    if (!force && controlsState) {
        renderControlsState();
        return;
    }
    try {
        const [stateRes, historyRes] = await Promise.all([
            dashboardFetch(`${API_BASE_GLOBAL}/api/account-controls/state`),
            dashboardFetch(`${API_BASE_GLOBAL}/api/account-controls/mutations/recent?limit=10`)
        ]);
        const state = await stateRes.json();
        const history = await historyRes.json();
        if (!stateRes.ok) throw new Error(state.error || 'Failed to load controls state');
        controlsState = { ...state, mutationHistory: history.mutations || [] };
        renderControlsState();
    } catch (err) {
        showToast(`Controls load failed: ${err.message}`, true);
    }
}

function controlsStatusChip(status) {
    const normalized = String(status || 'UNKNOWN').toUpperCase();
    const className = normalized.toLowerCase().replace(/_/g, '-');
    return `<span class="status-chip status-${esc(className)}">${esc(formatControlStatus(normalized))}</span>`;
}

function controlsTextCell(params) {
    return esc(params?.value || '');
}

function iconSvg(name) {
    if (name === 'pencil') {
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 20h9"></path>
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
        </svg>`;
    }
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 6h18"></path>
        <path d="M8 6V4h8v2"></path>
        <path d="M19 6l-1 14H6L5 6"></path>
        <path d="M10 11v5"></path>
        <path d="M14 11v5"></path>
    </svg>`;
}

function renderScheduleActionButtons(row) {
    const args = [
        row['campaign.id'],
        row['campaign_criterion.criterion_id'],
        row['campaign_criterion.resource_name'],
        row['campaign.name'] || '',
        row['campaign_criterion.ad_schedule.day_of_week'],
        row['campaign_criterion.ad_schedule.start_hour'],
        row['campaign_criterion.ad_schedule.start_minute'],
        row['campaign_criterion.ad_schedule.end_hour'],
        row['campaign_criterion.ad_schedule.end_minute']
    ].map(value => jsArg(value)).join(',');
    return `<div class="control-row-actions">
        <button class="control-icon-btn control-icon-btn--edit" type="button" title="Edit schedule" aria-label="Edit schedule" onclick="editSchedule(${args})">${iconSvg('pencil')}</button>
        <button class="control-icon-btn control-icon-btn--danger" type="button" title="Remove schedule" aria-label="Remove schedule" onclick="previewScheduleRemove(${args})">${iconSvg('trash')}</button>
    </div>`;
}

function renderRemoveActionButton(label, handler, args) {
    return `<div class="control-row-actions">
        <button class="control-icon-btn control-icon-btn--danger" type="button" title="${esc(label)}" aria-label="${esc(label)}" onclick="${handler}(${args.map(value => jsArg(value)).join(',')})">${iconSvg('trash')}</button>
    </div>`;
}

function normalizeControlKeyPart(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizeMatchType(value) {
    return String(value || '').trim().toUpperCase();
}

function findKeywordControlRow(row) {
    const keywordText = normalizeControlKeyPart(row.keywordText || row.keyword);
    const matchType = normalizeMatchType(row.matchType);
    const adGroupId = normalizeControlKeyPart(row.adGroupId);
    const adGroupName = normalizeControlKeyPart(row.adGroup);
    const campaignId = normalizeControlKeyPart(row.campaignId);
    const campaignName = normalizeControlKeyPart(row.campaign);
    return (controlsState?.keywords || []).find(item => {
        if (normalizeControlKeyPart(item.keywordText) !== keywordText) return false;
        if (normalizeMatchType(item.matchType) !== matchType) return false;
        const itemAdGroupId = normalizeControlKeyPart(item.adGroupId);
        const itemCampaignId = normalizeControlKeyPart(item.campaignId);
        const itemAdGroupName = normalizeControlKeyPart(item.adGroupName);
        const itemCampaignName = normalizeControlKeyPart(item.campaignName);
        if (adGroupId && itemAdGroupId === adGroupId) return true;
        return (!adGroupName || itemAdGroupName === adGroupName)
            && (!campaignId || itemCampaignId === campaignId)
            && (!campaignName || itemCampaignName === campaignName);
    });
}

function renderKeywordRowAction(row) {
    if (String(row.status || '').toUpperCase() === 'REMOVED') return '';
    const match = findKeywordControlRow(row) || {};
    const adGroupId = row.adGroupId || match.adGroupId;
    const criterionId = row.criterionId || match.criterionId;
    const keywordText = row.keywordText || row.keyword || match.keywordText;
    const matchType = row.matchType || match.matchType;
    if (!adGroupId || !criterionId || !keywordText) return '';
    return renderRemoveActionButton('Remove keyword', 'previewKeywordRemove', [adGroupId, criterionId, keywordText, matchType]);
}

function negativeScopeFromRow(row) {
    const source = normalizeControlKeyPart(row.source || row.level || row.scope);
    if (source.includes('ad_group') || source.includes('ad group')) return 'ad_group';
    if (source.includes('campaign')) return 'campaign';
    if (source.includes('shared') || source.includes('account') || row.sharedSetId || row.sharedSetResourceName) return 'shared_list';
    return '';
}

function findNegativeControlRow(row) {
    const scope = negativeScopeFromRow(row);
    if (!scope) return null;
    const keywordText = normalizeControlKeyPart(row.keywordText || row.keyword);
    const matchType = normalizeMatchType(row.matchType);
    const campaignId = normalizeControlKeyPart(row.campaignId);
    const campaignName = normalizeControlKeyPart(row.campaignName || row.campaign);
    const adGroupId = normalizeControlKeyPart(row.adGroupId);
    const adGroupName = normalizeControlKeyPart(row.adGroupName || row.adGroup);
    if (scope === 'shared_list') return null;
    const rows = scope === 'campaign' ? controlsState?.negatives?.campaign || [] : controlsState?.negatives?.adGroup || [];
    return rows.find(item => {
        if (normalizeControlKeyPart(item.keyword_text || item.keywordText) !== keywordText) return false;
        if (normalizeMatchType(item.match_type || item.matchType) !== matchType) return false;
        const itemCampaignId = normalizeControlKeyPart(item.campaign_id || item.campaignId);
        const itemCampaignName = normalizeControlKeyPart(item.campaign_name || item.campaignName);
        const itemAdGroupId = normalizeControlKeyPart(item.ad_group_id || item.adGroupId);
        const itemAdGroupName = normalizeControlKeyPart(item.ad_group_name || item.adGroupName);
        if (scope === 'campaign') {
            return campaignId ? itemCampaignId === campaignId : itemCampaignName === campaignName;
        }
        if (adGroupId && itemAdGroupId === adGroupId) return true;
        return (!adGroupName || itemAdGroupName === adGroupName)
            && (!campaignId || itemCampaignId === campaignId)
            && (!campaignName || itemCampaignName === campaignName);
    });
}

function renderNegativeRowAction(row) {
    if (String(row.status || '').toUpperCase() === 'REMOVED') return '';
    const scope = negativeScopeFromRow(row);
    if (!scope) return '';
    const match = findNegativeControlRow(row) || {};
    const campaignId = row.campaignId || match.campaign_id || match.campaignId;
    const adGroupId = row.adGroupId || match.ad_group_id || match.adGroupId || '';
    const criterionId = row.criterionId || row.criterion_id || match.criterion_id || match.criterionId;
    const keywordText = row.keywordText || row.keyword || match.keyword_text || match.keywordText;
    const matchType = row.matchType || match.match_type || match.matchType;
    if (!campaignId || !criterionId || !keywordText) return '';
    return renderRemoveActionButton('Remove negative keyword', 'previewNegativeRemove', [scope, campaignId, adGroupId, criterionId, keywordText, matchType]);
}

function formatControlStatus(status) {
    return String(status || 'Unknown')
        .toLowerCase()
        .replace(/_/g, ' ')
        .replace(/\b\w/g, char => char.toUpperCase());
}

function formatScheduleDay(day) {
    return formatControlStatus(day);
}

function formatScheduleMinute(minute) {
    const values = { ZERO: '00', FIFTEEN: '15', THIRTY: '30', FORTY_FIVE: '45' };
    const normalized = String(minute || '').toUpperCase();
    return values[normalized] || String(minute || '').padStart(2, '0');
}

function formatScheduleTime(hour, minute) {
    if (hour === undefined || hour === null || hour === '') return '';
    const hourNumber = Number(hour);
    if (!Number.isFinite(hourNumber)) return '';
    const displayHour = hourNumber % 12 || 12;
    const suffix = hourNumber >= 12 && hourNumber < 24 ? 'PM' : 'AM';
    return `${displayHour}:${formatScheduleMinute(minute)} ${suffix}`;
}

function formatScheduleTimeRange(startHour, startMinute, endHour, endMinute) {
    const start = formatScheduleTime(startHour, startMinute);
    const end = formatScheduleTime(endHour, endMinute);
    if (!start && !end) return '';
    return `${start || '?'} to ${end || '?'}`;
}

function renderControlsState() {
    if (!controlsState) return;
    renderControlsSelects();
    if (activeDashboardTab() === 'keywords') {
        renderTables();
    }
    if (isControlSurfaceActive(els.controlsSchedules)) {
        const rows = (controlsState.adSchedules || []).map(row => ({
            campaign: row['campaign.name'] || row['campaign.id'] || '',
            campaignId: row['campaign.id'] || '',
            day: formatScheduleDay(row['campaign_criterion.ad_schedule.day_of_week']),
            start: formatScheduleTime(row['campaign_criterion.ad_schedule.start_hour'], row['campaign_criterion.ad_schedule.start_minute']),
            end: formatScheduleTime(row['campaign_criterion.ad_schedule.end_hour'], row['campaign_criterion.ad_schedule.end_minute']),
            status: row['campaign_criterion.status'],
            actionHtml: renderScheduleActionButtons(row)
        }));
        initGrid('grid-controlsSchedules', rows, [
            {
                field: 'campaign',
                headerName: 'Campaign',
                pinned: 'left',
                minWidth: 260,
                cellRenderer: p => {
                    const campaign = p.value || '';
                    const actionHtml = p.data?.actionHtml || '';
                    if (!actionHtml) return `<span>${esc(campaign)}</span>`;
                    return `<div class="keyword-cell-inline">
                        <span class="keyword-cell-text" title="${esc(campaign)}">${esc(campaign)}</span>
                        <div class="keyword-cell-action">${actionHtml}</div>
                    </div>`;
                }
            },
            { field: 'day', headerName: 'Day', minWidth: 130, cellRenderer: controlsTextCell },
            { field: 'start', headerName: 'Start', minWidth: 110, cellRenderer: controlsTextCell },
            { field: 'end', headerName: 'End', minWidth: 110, cellRenderer: controlsTextCell },
            { field: 'status', headerName: 'Status', minWidth: 130, cellRenderer: p => controlsStatusChip(p.value) }
        ]);
    }
    if (isControlSurfaceActive(els.controlsMutationHistory)) {
        const rows = (controlsState.mutationHistory || []).map(row => ({
            createdAt: formatDateTimeIst(row.created_at),
            changeSummary: formatMutationHistoryChange(row),
            source: formatMutationSource(row.source),
            status: row.status
        }));
        initGrid('grid-controlsMutationHistory', rows, [
            { field: 'createdAt', headerName: 'Created', pinned: 'left', minWidth: 180, cellRenderer: controlsTextCell },
            { field: 'changeSummary', headerName: 'Change', minWidth: 420, wrapText: true, autoHeight: true, cellRenderer: controlsTextCell },
            { field: 'source', headerName: 'Origin', minWidth: 110, maxWidth: 140, cellRenderer: controlsTextCell },
            { field: 'status', headerName: 'Status', minWidth: 120, maxWidth: 150, cellRenderer: p => controlsStatusChip(p.value) }
        ]);
    }
}

function formatMutationSource(source) {
    const normalized = String(source || '').toLowerCase();
    if (normalized === 'ui') return 'Dashboard';
    if (normalized === 'mcp') return 'MCP';
    return formatControlStatus(source || 'Unknown');
}

function isControlSurfaceActive(gridEl) {
    if (!gridEl) return false;
    const tab = gridEl.closest('.tab-content');
    if (tab && !tab.classList.contains('active')) return false;
    const keywordPanel = gridEl.closest('.keyword-subpanel');
    if (keywordPanel && !keywordPanel.classList.contains('active')) return false;
    return true;
}

function formatMutationHistoryChange(row) {
    const payload = row?.preview_payload || {};
    const diff = Array.isArray(payload.diff) ? payload.diff : [];
    if (!diff.length) return formatControlStatus(row?.mutation_type);
    const groups = groupedMutationDiffs(diff);
    const summaries = groups.slice(0, 3).map(group => formatMutationDiffGroup(group, row?.mutation_type)).filter(Boolean);
    const remaining = groups.slice(3).reduce((total, group) => total + group.length, 0);
    const suffix = remaining ? ` + ${remaining} more` : '';
    return `${summaries.join('; ')}${suffix}` || formatControlStatus(row?.mutation_type);
}

function groupedMutationDiffs(diff) {
    const groups = [];
    const byKey = new Map();
    diff.forEach((change, index) => {
        const key = mutationDiffGroupKey(change, index);
        let group = byKey.get(key);
        if (!group) {
            group = [];
            byKey.set(key, group);
            groups.push(group);
        }
        group.push(change);
    });
    return groups;
}

function mutationDiffGroupKey(change, index) {
    const action = String(change?.action || '').toLowerCase();
    if (action === 'set_campaign_status') return `${action}|${String(change.targetStatus || '').toUpperCase()}`;
    if (action === 'set_ad_group_status') return `${action}|${String(change.targetStatus || '').toUpperCase()}`;
    if (['add_keyword', 'remove_keyword', 'replace_keyword', 'set_keyword_status', 'set_keyword_final_url'].includes(action)) {
        return `${action}|${change.adGroupId || ''}|${String(change.matchType || '').toUpperCase()}`;
    }
    if (['add_negative_keyword', 'remove_negative_keyword', 'replace_negative_keyword'].includes(action)) {
        const scope = String(change.scope || '').toLowerCase();
        const ownerId = change.ownerId || change.adGroupId || change.campaignId || '';
        return `${action}|${scope}|${ownerId}|${String(change.matchType || '').toUpperCase()}`;
    }
    if (action === 'add_ad_schedule' || action === 'remove_ad_schedule') {
        const schedule = change.schedule || change;
        return [
            action,
            change.campaignId || '',
            schedule.startHour ?? schedule.start_hour ?? '',
            schedule.startMinute ?? schedule.start_minute ?? '',
            schedule.endHour ?? schedule.end_hour ?? '',
            schedule.endMinute ?? schedule.end_minute ?? ''
        ].join('|');
    }
    return `${action || 'unknown'}|${index}`;
}

function formatMutationDiffGroup(group, mutationType) {
    if (!group.length) return '';
    if (group.length === 1) return formatMutationDiff(group[0], mutationType);
    const first = group[0];
    const action = String(first?.action || '').toLowerCase();

    if (action === 'set_campaign_status') {
        return `Campaigns ${formatStatusVerb(first.targetStatus)}: ${formatNameList(group.map(change => lookupCampaignName(change.campaignId)))}`;
    }
    if (action === 'set_ad_group_status') {
        return `Ad groups ${formatStatusVerb(first.targetStatus)}: ${formatNameList(group.map(change => lookupAdGroupName(change.adGroupId)))}`;
    }
    if (action === 'add_keyword' || action === 'remove_keyword') {
        const verb = action === 'add_keyword' ? 'added to' : 'removed from';
        return `Keywords ${verb} ad group ${lookupAdGroupName(first.adGroupId)} (${formatMatchType(first.matchType)}): ${formatNameList(group.map(change => quoteInline(change.keywordText)))}`;
    }
    if (action === 'replace_keyword') {
        return `Keywords changed in ad group ${lookupAdGroupName(first.adGroupId)}: ${formatNameList(group.map(change => `${quoteInline(change.keywordText)} → ${quoteInline(change.newKeywordText)}`))}`;
    }
    if (action === 'set_keyword_status') {
        return `Keywords ${formatStatusVerb(first.targetStatus)} in ad group ${lookupAdGroupName(first.adGroupId)}: ${formatNameList(group.map(change => quoteInline(change.keywordText)))}`;
    }
    if (action === 'set_keyword_final_url') {
        return `Final URLs changed in ad group ${lookupAdGroupName(first.adGroupId)}: ${formatNameList(group.map(change => quoteInline(change.keywordText)))}`;
    }
    if (action === 'add_negative_keyword' || action === 'remove_negative_keyword') {
        const scope = String(first.scope || '').toLowerCase();
        const ownerName = scope === 'ad_group' ? lookupAdGroupName(first.ownerId || first.adGroupId) : scope === 'campaign' ? lookupCampaignName(first.ownerId || first.campaignId) : `negative list ${first.ownerId}`;
        const ownerType = scope === 'ad_group' ? 'ad group' : scope === 'campaign' ? 'campaign' : 'negative list';
        const verb = action === 'add_negative_keyword' ? 'added to' : 'removed from';
        return `Negative keywords ${verb} ${ownerType} ${ownerName} (${formatMatchType(first.matchType)}): ${formatNameList(group.map(change => quoteInline(change.keywordText)))}`;
    }
    if (action === 'replace_negative_keyword') {
        const scope = String(first.scope || '').toLowerCase();
        const ownerName = scope === 'ad_group' ? lookupAdGroupName(first.ownerId || first.adGroupId) : scope === 'campaign' ? lookupCampaignName(first.ownerId || first.campaignId) : `negative list ${first.ownerId}`;
        return `Negative keywords changed in ${ownerName}: ${formatNameList(group.map(change => `${quoteInline(change.keywordText)} → ${quoteInline(change.newKeywordText)}`))}`;
    }
    if (action === 'add_ad_schedule' || action === 'remove_ad_schedule') {
        const firstSchedule = first.schedule || first;
        const days = group
            .map(change => {
                const schedule = change.schedule || change;
                return formatScheduleDay(schedule.dayOfWeek || schedule.day_of_week);
            })
            .filter(Boolean);
        const time = formatScheduleTimeRange(firstSchedule.startHour ?? firstSchedule.start_hour, firstSchedule.startMinute ?? firstSchedule.start_minute, firstSchedule.endHour ?? firstSchedule.end_hour, firstSchedule.endMinute ?? firstSchedule.end_minute);
        const verb = action === 'add_ad_schedule' ? 'added' : 'removed';
        return `Ad schedule ${time ? `${time} on ` : ''}${formatDayList(days)} for campaign ${lookupCampaignName(first.campaignId)} ${verb}`;
    }

    return `${group.length} ${formatControlStatus(mutationType).toLowerCase()} changes`;
}

function formatMutationDiff(change, mutationType) {
    const action = String(change?.action || '').toLowerCase();
    if (action === 'set_campaign_status') {
        const campaignName = lookupCampaignName(change.campaignId);
        return `Campaign ${campaignName} ${formatStatusVerb(change.targetStatus)}`;
    }
    if (action === 'set_ad_group_status') {
        const adGroupName = lookupAdGroupName(change.adGroupId);
        return `Ad group ${adGroupName} ${formatStatusVerb(change.targetStatus)}`;
    }
    if (action === 'add_keyword' || action === 'remove_keyword') {
        const adGroupName = lookupAdGroupName(change.adGroupId);
        const verb = action === 'add_keyword' ? 'added to' : 'removed from';
        return `Keyword ${quoteInline(change.keywordText)} (${formatMatchType(change.matchType)}) ${verb} ad group ${adGroupName}`;
    }
    if (action === 'replace_keyword') {
        return `Keyword ${quoteInline(change.keywordText)} changed to ${quoteInline(change.newKeywordText)} (${formatMatchType(change.matchType)} → ${formatMatchType(change.newMatchType)}) in ad group ${lookupAdGroupName(change.adGroupId)}`;
    }
    if (action === 'set_keyword_status') {
        return `Keyword ${quoteInline(change.keywordText)} ${formatStatusVerb(change.targetStatus)} in ad group ${lookupAdGroupName(change.adGroupId)}`;
    }
    if (action === 'set_keyword_final_url') {
        return `Final URL for keyword ${quoteInline(change.keywordText)} changed in ad group ${lookupAdGroupName(change.adGroupId)}`;
    }
    if (action === 'add_negative_keyword' || action === 'remove_negative_keyword') {
        const scope = String(change.scope || '').toLowerCase();
        const ownerName = scope === 'ad_group' ? lookupAdGroupName(change.ownerId || change.adGroupId) : scope === 'campaign' ? lookupCampaignName(change.ownerId || change.campaignId) : `negative list ${change.ownerId}`;
        const ownerType = scope === 'ad_group' ? 'ad group' : scope === 'campaign' ? 'campaign' : 'negative list';
        const verb = action === 'add_negative_keyword' ? 'added to' : 'removed from';
        return `Negative keyword ${quoteInline(change.keywordText)} (${formatMatchType(change.matchType)}) ${verb} ${ownerType} ${ownerName}`;
    }
    if (action === 'replace_negative_keyword') {
        const scope = String(change.scope || '').toLowerCase();
        const ownerName = scope === 'ad_group' ? lookupAdGroupName(change.ownerId || change.adGroupId) : scope === 'campaign' ? lookupCampaignName(change.ownerId || change.campaignId) : `negative list ${change.ownerId}`;
        return `Negative keyword ${quoteInline(change.keywordText)} changed to ${quoteInline(change.newKeywordText)} (${formatMatchType(change.matchType)} → ${formatMatchType(change.newMatchType)}) in ${ownerName}`;
    }
    if (action === 'add_ad_schedule' || action === 'remove_ad_schedule') {
        const campaignName = lookupCampaignName(change.campaignId);
        const schedule = change.schedule || change;
        const day = formatScheduleDay(schedule.dayOfWeek || schedule.day_of_week);
        const time = formatScheduleTimeRange(schedule.startHour ?? schedule.start_hour, schedule.startMinute ?? schedule.start_minute, schedule.endHour ?? schedule.end_hour, schedule.endMinute ?? schedule.end_minute);
        const verb = action === 'add_ad_schedule' ? 'added' : 'removed';
        return `Ad schedule ${time ? `${time} on ` : ''}${day || 'selected day'} for campaign ${campaignName} ${verb}`;
    }
    return formatControlStatus(mutationType);
}

function quoteInline(value) {
    return value ? `"${String(value)}"` : '""';
}

function formatNameList(values, limit = 5) {
    const cleanValues = values.map(value => String(value || '').trim()).filter(Boolean);
    const visible = cleanValues.slice(0, limit);
    const suffix = cleanValues.length > visible.length ? ` + ${cleanValues.length - visible.length} more` : '';
    return `${visible.join(', ')}${suffix}`;
}

function formatStatusVerb(status) {
    const normalized = String(status || '').toUpperCase();
    if (normalized === 'ENABLED') return 'enabled';
    if (normalized === 'PAUSED') return 'paused';
    return `set to ${formatControlStatus(status)}`;
}

function lookupCampaignName(campaignId) {
    const row = overviewCampaignRows().find(item => String(item.campaignId || item.id) === String(campaignId));
    return row?.campaignName || row?.name || campaignId || 'unknown campaign';
}

function lookupAdGroupName(adGroupId) {
    const row = overviewAdGroupRows().find(item => String(item.adGroupId || item.id) === String(adGroupId));
    return row?.adGroupName || row?.name || adGroupId || 'unknown ad group';
}

function renderControlsSelects() {
    const adGroupSelect = document.getElementById('keywordAdGroupSelect');
    if (adGroupSelect) adGroupSelect.innerHTML = (controlsState.adGroups || []).map(row => `<option value="${esc(row.adGroupId)}">${esc(row.campaignName || row.campaignId)} / ${esc(row.adGroupName)}</option>`).join('');
    const scheduleSelect = document.getElementById('scheduleCampaignSelect');
    if (scheduleSelect) scheduleSelect.innerHTML = (controlsState.campaigns || []).map(row => `<option value="${esc(row.campaignId)}">${esc(row.campaignName)}</option>`).join('');
    refreshNegativeOwnerOptions();
}

function refreshNegativeOwnerOptions() {
    const scope = document.getElementById('negativeScopeSelect')?.value || 'campaign';
    const ownerSelect = document.getElementById('negativeOwnerSelect');
    if (!ownerSelect || !controlsState) return;
    const labelEl = document.getElementById('negativeOwnerLabel');
    if (labelEl) {
        labelEl.textContent = scope === 'campaign' ? 'Campaign' : scope === 'ad_group' ? 'Ad group' : 'Negative keyword list';
    }
    const rows = scope === 'campaign'
        ? controlsState.campaigns || []
        : scope === 'ad_group'
            ? controlsState.adGroups || []
            : controlsState.sharedNegativeSets || [];
    ownerSelect.innerHTML = rows.map(row => {
        const id = scope === 'campaign' ? row.campaignId : scope === 'ad_group' ? row.adGroupId : row.sharedSetId;
        const label = scope === 'campaign'
            ? row.campaignName
            : scope === 'ad_group'
                ? `${row.campaignName || row.campaignId} / ${row.adGroupName}`
                : `${row.sharedSetName}${row.sharedSetType === 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS' ? ' · Account level' : ''}`;
        return `<option value="${esc(id)}">${esc(label)}</option>`;
    }).join('');
}

function splitControlsChangesIntoBatches(mutationType, changes) {
    if (changes.length <= GOOGLE_ADS_PREVIEW_BATCH_SIZE) return [changes];
    if (!['keyword_changes', 'negative_keyword_changes', 'audience_changes'].includes(mutationType)) return null;
    if (mutationType === 'audience_changes' && changes.some(change => String(change.action || '').toLowerCase() === 'create_custom_audience')) return null;
    const batches = [];
    for (let index = 0; index < changes.length; index += GOOGLE_ADS_PREVIEW_BATCH_SIZE) {
        batches.push(changes.slice(index, index + GOOGLE_ADS_PREVIEW_BATCH_SIZE));
    }
    return batches;
}

function dedupeControlsDestinationsBeforeBatching(mutationType, changes) {
    if (!['keyword_changes', 'negative_keyword_changes'].includes(mutationType)) return { changes, warnings: [] };
    const seen = new Set();
    const filtered = [];
    const warnings = [];
    for (const change of changes) {
        const action = String(change.action || change.operation || '').toLowerCase();
        if (!['add', 'create', 'replace', 'edit'].includes(action)) {
            filtered.push(change);
            continue;
        }
        const replacing = ['replace', 'edit'].includes(action);
        const keywordText = String(replacing ? change.newKeywordText : change.keywordText || change.keyword || '').trim().replace(/\s+/g, ' ');
        const matchType = String(replacing ? change.newMatchType : change.matchType || '').toUpperCase();
        const scope = mutationType === 'keyword_changes' ? 'ad_group' : String(change.scope || (change.adGroupId ? 'ad_group' : change.sharedSetId ? 'shared_list' : 'campaign')).toLowerCase();
        const ownerId = scope === 'campaign' ? change.campaignId : scope === 'ad_group' ? change.adGroupId : change.sharedSetId || change.ownerId;
        const key = [mutationType, scope, ownerId, keywordText.toLowerCase(), matchType].join('|');
        if (seen.has(key)) {
            warnings.push(`${replacing ? 'Keyword edit' : 'Keyword addition'} skipped because another selected change has the same destination: ${keywordText} (${formatMatchType(matchType)}).`);
            continue;
        }
        seen.add(key);
        filtered.push(change);
    }
    return { changes: filtered, warnings: Array.from(new Set(warnings)) };
}

function controlsPreviewBatches(preview) {
    if (Array.isArray(preview?.batches) && preview.batches.length) return preview.batches;
    return preview ? [preview] : [];
}

function controlsPreviewChangeCount(preview) {
    if (Array.isArray(preview?.diff) && preview.diff.length) return preview.diff.length;
    if (Array.isArray(preview?.changes)) return preview.changes.length;
    return 0;
}

async function previewControlsMutation(mutationType, changes, reason, warnings = []) {
    if (!Array.isArray(changes) || !changes.length) {
        showToast('There are no changes to review.', true);
        return;
    }
    const prepared = dedupeControlsDestinationsBeforeBatching(mutationType, changes);
    const preparedChanges = prepared.changes;
    const combinedWarnings = [...warnings, ...prepared.warnings];
    if (!preparedChanges.length) {
        showToast(prepared.warnings[0] || 'There are no unique changes to review.', true);
        return;
    }
    const batches = splitControlsChangesIntoBatches(mutationType, preparedChanges);
    if (!batches) {
        showToast(`Review up to ${GOOGLE_ADS_PREVIEW_BATCH_SIZE} changes at a time for this action.`, true);
        return;
    }
    const requestId = ++controlsPreviewRequestId;
    pendingLocalChange = { mutationType, changes: preparedChanges, reason, warnings: combinedWarnings, batchCount: batches.length };
    pendingControlsPreview = null;
    openControlsPreviewLoadingModal(preparedChanges.length, batches.length);
    try {
        const previews = [];
        let validatedChangeCount = 0;
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
            if (requestId !== controlsPreviewRequestId) return;
            const batchChanges = batches[batchIndex];
            updateControlsPreviewLoadingModal(batchIndex + 1, batches.length, validatedChangeCount, preparedChanges.length);
            const response = await dashboardFetch(`${API_BASE_GLOBAL}/api/account-controls/mutations/preview`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    customerId: dashboardData?.meta?.accountId,
                    mutationType,
                    changes: batchChanges,
                    reason: batches.length > 1 ? `${reason} (batch ${batchIndex + 1} of ${batches.length})` : reason
                })
            });
            const preview = await response.json().catch(() => ({}));
            if (requestId !== controlsPreviewRequestId) return;
            if (!response.ok) {
                const prefix = batches.length > 1 ? `Batch ${batchIndex + 1} of ${batches.length} could not be validated. ` : '';
                throw new Error(`${prefix}${preview.error || 'Google Ads preview failed.'}`);
            }
            previews.push({ ...preview, mutationType, changes: batchChanges, reason, batchIndex });
            validatedChangeCount += batchChanges.length;
            updateControlsPreviewLoadingModal(batchIndex + 1, batches.length, validatedChangeCount, preparedChanges.length);
        }
        const aggregatePreview = {
            mutationType,
            changes: preparedChanges,
            reason,
            batches: previews,
            diff: previews.flatMap(preview => Array.isArray(preview.diff) ? preview.diff : []),
            warnings: previews.flatMap(preview => Array.isArray(preview.warnings) ? preview.warnings : [])
        };
        pendingControlsPreview = aggregatePreview;
        openControlsPreviewModalLocally(
            mutationType,
            preparedChanges,
            [...combinedWarnings, ...aggregatePreview.warnings],
            aggregatePreview
        );
    } catch (err) {
        if (requestId !== controlsPreviewRequestId) return;
        removeControlsPreviewModal();
        pendingLocalChange = null;
        pendingControlsPreview = null;
        showToast(err.message || 'Could not validate the Google Ads change.', true);
    }
}

function formatMatchType(type) {
    const normalized = String(type || '').toUpperCase();
    if (normalized === 'EXACT') return 'Exact Match';
    if (normalized === 'PHRASE') return 'Phrase Match';
    if (normalized === 'BROAD') return 'Broad Match';
    return formatControlStatus(type);
}

function removeControlsPreviewModal() {
    document.getElementById('controlsPreviewModal')?.remove();
}

function controlsMutationSubject(mutationType = pendingLocalChange?.mutationType) {
    if (mutationType === 'audience_changes') return 'audience targeting, scope and Google Ads rules';
    if (mutationType === 'ad_schedule_changes') return 'campaign schedules, overlaps and Google Ads rules';
    if (mutationType === 'entity_status_changes') return 'current statuses, scope and Google Ads rules';
    return 'current keywords, duplicates, scope and Google Ads rules';
}

function openControlsPreviewLoadingModal(changeCount, batchCount = 1) {
    removeControlsPreviewModal();
    const modal = document.createElement('div');
    modal.id = 'controlsPreviewModal';
    modal.className = 'modal-overlay show';
    modal.innerHTML = `<div class="modal-content-card controls-modal controls-modal--keyword">
        <div class="modal-header"><h3>Checking Google Ads</h3><button class="modal-close-btn" onclick="closeControlsPreviewModal()" aria-label="Cancel preview">×</button></div>
        <div class="modal-body"><div class="controls-batch-progress"><div class="loading-spinner"></div><div class="controls-batch-progress__copy"><strong id="controlsPreviewProgressTitle">Validating ${esc(changeCount)} change${changeCount === 1 ? '' : 's'}</strong><span id="controlsPreviewProgressDetail">Checking ${esc(controlsMutationSubject())}…</span></div><div class="controls-batch-progress__track"><span id="controlsPreviewProgressBar"></span></div><span id="controlsPreviewProgressMeta">${batchCount > 1 ? `Preparing ${esc(batchCount)} safe batches` : 'Preparing preview'}</span></div></div>
    </div>`;
    document.body.appendChild(modal);
}

function updateControlsPreviewLoadingModal(batchNumber, batchCount, validatedCount, totalCount) {
    const title = document.getElementById('controlsPreviewProgressTitle');
    const detail = document.getElementById('controlsPreviewProgressDetail');
    const bar = document.getElementById('controlsPreviewProgressBar');
    const meta = document.getElementById('controlsPreviewProgressMeta');
    if (title) title.textContent = batchCount > 1 ? `Checking batch ${batchNumber} of ${batchCount}` : `Checking ${totalCount} change${totalCount === 1 ? '' : 's'}`;
    if (detail) detail.textContent = `Checking ${controlsMutationSubject()}…`;
    if (bar) bar.style.width = `${totalCount ? Math.round((validatedCount / totalCount) * 100) : 0}%`;
    if (meta) meta.textContent = `${validatedCount} of ${totalCount} changes validated`;
}

function previewItemFromDiff(change) {
    const action = String(change?.action || '').toLowerCase();
    const keywordText = change.keywordText || '';
    const adGroupName = change.adGroupId ? lookupAdGroupName(change.adGroupId) : '';
    const rawScope = String(change.scope || '').toLowerCase();
    const ownerName = rawScope === 'campaign'
        ? lookupCampaignName(change.ownerId || change.campaignId)
        : rawScope === 'ad_group'
            ? lookupAdGroupName(change.ownerId || change.adGroupId)
            : `Negative keyword list ${(controlsState?.sharedNegativeSets || []).find(row => String(row.sharedSetId) === String(change.ownerId))?.sharedSetName || change.ownerId || ''}`;
    if (action === 'add_keyword') return { icon: '+', title: `Add “${keywordText}”`, detail: `${formatMatchType(change.matchType)} · Ad group ${adGroupName}` };
    if (action === 'remove_keyword') return { icon: '−', title: `Remove “${keywordText}”`, detail: `Ad group ${adGroupName}` };
    if (action === 'replace_keyword') return { icon: '→', title: `Change “${keywordText}” to “${change.newKeywordText}”`, detail: `${formatMatchType(change.matchType)} → ${formatMatchType(change.newMatchType)} · Ad group ${adGroupName}` };
    if (action === 'set_keyword_status') return { icon: '●', title: `${change.targetStatus === 'ENABLED' ? 'Enable' : 'Pause'} “${keywordText}”`, detail: `Ad group ${adGroupName}` };
    if (action === 'set_keyword_final_url') return { icon: '↗', title: `Change final URL for “${keywordText}”`, detail: change.finalUrl ? change.finalUrl : 'Clear the keyword-level final URL' };
    if (action === 'add_negative_keyword') return { icon: '+', title: `Add negative “${keywordText}”`, detail: `${formatMatchType(change.matchType)} · ${ownerName}` };
    if (action === 'remove_negative_keyword') return { icon: '−', title: `Remove negative “${keywordText}”`, detail: ownerName };
    if (action === 'replace_negative_keyword') return { icon: '→', title: `Change negative “${keywordText}” to “${change.newKeywordText}”`, detail: `${formatMatchType(change.matchType)} → ${formatMatchType(change.newMatchType)} · ${ownerName}` };
    if (action === 'add_segment') {
        const segment = audienceCatalogEntry(change.audienceResourceName);
        return { icon: '+', title: `${change.negative ? 'Exclude' : 'Add'} “${segment?.name || change.audienceResourceName}”`, detail: `${audienceTypeLabel(change.criterionType)} · ${audienceOwnerLabel(change.scope, change.ownerId)}` };
    }
    if (action === 'remove_segment') {
        const segment = audienceCatalogEntry(change.audienceResourceName);
        return { icon: '−', title: `Remove ${change.negative ? 'exclusion' : 'segment'} “${segment?.name || change.audienceResourceName}”`, detail: `${audienceTypeLabel(change.criterionType)} · ${audienceOwnerLabel(change.scope, change.ownerId)}` };
    }
    if (action === 'set_bid_modifier') {
        const segment = audienceCatalogEntry(change.audienceResourceName);
        return { icon: '%', title: `Change bid adjustment for “${segment?.name || change.audienceResourceName}”`, detail: `${formatAudienceBidModifier(change.from)} → ${formatAudienceBidModifier(change.to)} · ${audienceOwnerLabel(change.scope, change.ownerId)}` };
    }
    if (action === 'set_targeting_mode') return { icon: '◎', title: `Use ${String(change.mode || '').toLowerCase()} mode`, detail: audienceOwnerLabel(change.scope, change.ownerId) };
    if (action === 'set_demographics') return { icon: '✓', title: `Update ${audienceDimensionLabel(change.dimension)}`, detail: `${change.includedValues?.length || 0} included · ${audienceOwnerLabel(change.scope, change.ownerId)}` };
    if (action === 'create_custom_audience') return { icon: '+', title: `Create custom segment “${change.name}”`, detail: `${audienceTypeLabel(change.type)} · ${change.memberCount || 0} member${change.memberCount === 1 ? '' : 's'}` };
    return { icon: '✓', title: formatMutationDiff(change, pendingLocalChange?.mutationType), detail: '' };
}

function openControlsPreviewModalLocally(mutationType, changes, warnings = [], preview = null) {
    closeKeywordAddModal();
    removeControlsPreviewModal();
    const modal = document.createElement('div');
    modal.id = 'controlsPreviewModal';
    modal.className = 'modal-overlay show';

    const diffs = Array.isArray(preview?.diff) && preview.diff.length ? preview.diff : [];
    const descriptionHtml = diffs.length
        ? `<div class="controls-preview-list">${diffs.map(change => {
            const item = previewItemFromDiff(change);
            return `<div class="controls-preview-item"><span class="controls-preview-item__icon">${esc(item.icon)}</span><div><strong>${esc(item.title)}</strong>${item.detail ? `<span>${esc(item.detail)}</span>` : ''}</div></div>`;
        }).join('')}</div>`
        : getConfirmationTextLocally(mutationType, Array.isArray(changes) ? changes : [changes]);
    const uniqueWarnings = Array.from(new Set(warnings.filter(Boolean)));
    const warningHtml = uniqueWarnings.length
        ? `<div class="controls-preview-warning">${uniqueWarnings.map(warning => `<p>${esc(warning)}</p>`).join('')}</div>`
        : '';
    const title = mutationType === 'keyword_changes' ? 'Confirm keyword changes' : mutationType === 'negative_keyword_changes' ? 'Confirm negative keyword changes' : mutationType === 'audience_changes' ? 'Confirm audience changes' : 'Confirm changes';
    const count = diffs.length || changes.length;
    const batchCount = controlsPreviewBatches(preview).length;
    const batchNoticeHtml = batchCount > 1
        ? `<div class="controls-batch-notice"><strong>Protected large-batch review</strong><span>These changes were validated in ${batchCount} batches of up to ${GOOGLE_ADS_PREVIEW_BATCH_SIZE}. Apply processes them in order and stops before later batches if one fails.</span></div>`
        : '';
    const applyLabel = batchCount > 1
        ? `Apply ${count} changes in ${batchCount} batches`
        : `Apply ${count} change${count === 1 ? '' : 's'}`;

    modal.innerHTML = `
        <div class="modal-content-card controls-modal ${mutationType.includes('keyword') ? 'controls-modal--keyword' : ''}">
            <div class="modal-header">
                <h3>${esc(title)}</h3>
                <button class="modal-close-btn" onclick="closeControlsPreviewModal()" aria-label="Close modal">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                        stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>
            </div>
            <div class="modal-body" style="padding: 1.5rem;">
                <div class="confirm-error-alert" style="display: none; align-items: flex-start; gap: 0.75rem; padding: 0.85rem 1rem; background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 8px; margin-bottom: 1rem; color: var(--danger); font-size: 0.88rem;"></div>
                ${warningHtml}
                ${batchNoticeHtml}
                <div class="controls-preview-summary"><div><strong>${count} validated change${count === 1 ? '' : 's'}</strong><span>Nothing is applied until you confirm below.</span></div><span>${batchCount > 1 ? `${batchCount} protected previews` : 'Preview expires in 10 minutes'}</span></div>
                <div style="margin-top: 0.25rem; margin-bottom: 1.25rem;">
                    <div class="confirm-change-text">${descriptionHtml}</div>
                </div>
                
                <div class="control-actions-row" style="padding: 1rem 0 0; margin-top: 0.5rem; border-top: 1px solid var(--border-light); margin-bottom: 0;">
                    <button class="btn btn-secondary btn-sm" onclick="closeControlsPreviewModal()">Cancel</button>
                    <button class="btn btn-primary btn-sm" onclick="applyPendingControlsChange()">${esc(applyLabel)}</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(modal);
}

function closeControlsPreviewModal() {
    controlsPreviewRequestId += 1;
    removeControlsPreviewModal();
    pendingLocalChange = null;
    pendingControlsPreview = null;
}

function scheduleChangeCampaignName(change) {
    const campaign = overviewCampaignRows()
        .find(c => String(c.campaignId || c.id) === String(change.campaignId));
    return campaign ? campaign.campaignName || campaign.name : change.campaignName || change.campaignId;
}

function scheduleChangeLine(change) {
    const day = change.dayOfWeek ? formatScheduleDay(change.dayOfWeek) : 'Selected day';
    const time = formatScheduleTimeRange(change.startHour, change.startMinute, change.endHour, change.endMinute) || 'selected time';
    return `${day}, ${time}, ${scheduleChangeCampaignName(change)}`;
}

function scheduleChangeListHtml(title, changes) {
    if (!changes.length) return '';
    return `
        <div class="confirm-change-list">
            <strong>${esc(title)}</strong>
            <ul>
                ${changes.map(change => `<li>${esc(scheduleChangeLine(change))}</li>`).join('')}
            </ul>
        </div>`;
}

function getConfirmationTextLocally(mutationType, changes) {
    const change = Array.isArray(changes) ? changes[0] : changes;
    if (mutationType === 'entity_status_changes') {
        const isEnable = change.targetStatus === 'ENABLED';
        const isCampaign = change.entityType === 'campaign';
        if (isCampaign) {
            const campaign = overviewCampaignRows().find(c => String(c.campaignId || c.id) === String(change.campaignId));
            const campaignName = campaign ? campaign.campaignName || campaign.name : change.campaignId;
            return `Are you sure you want to ${isEnable ? 'enable' : 'pause'} campaign <strong>${esc(campaignName)}</strong>?`;
        } else {
            const adGroup = overviewAdGroupRows().find(g => String(g.adGroupId || g.id) === String(change.adGroupId));
            const adGroupName = adGroup ? adGroup.adGroupName || adGroup.name : change.adGroupId;
            return `Are you sure you want to ${isEnable ? 'enable' : 'pause'} ad group <strong>${esc(adGroupName)}</strong>?`;
        }
    }
    else if (mutationType === 'keyword_changes') {
        const adGroup = overviewAdGroupRows().find(g => String(g.adGroupId || g.id) === String(change.adGroupId));
        const adGroupName = adGroup ? adGroup.adGroupName || adGroup.name : change.adGroupId;
        if (change.action === 'remove') {
            return `Are you sure you want to remove the keyword <strong>${esc(change.keywordText)}</strong> from ad group <strong>${esc(adGroupName)}</strong>?`;
        } else {
            const finalUrl = change.finalUrl ? ` with final URL <strong>${esc(change.finalUrl)}</strong>` : '';
            return `Are you sure you want to add the keyword <strong>${esc(change.keywordText)}</strong> (${esc(formatMatchType(change.matchType))}) to ad group <strong>${esc(adGroupName)}</strong>${finalUrl}?`;
        }
    }
    else if (mutationType === 'negative_keyword_changes') {
        const isCampaign = change.scope === 'campaign';
        const ownerId = isCampaign ? change.campaignId : change.adGroupId;
        const owner = isCampaign
            ? overviewCampaignRows().find(c => String(c.campaignId || c.id) === String(ownerId))
            : overviewAdGroupRows().find(g => String(g.adGroupId || g.id) === String(ownerId));
        const ownerName = owner ? owner.campaignName || owner.name || owner.adGroupName : ownerId;
        if (change.action === 'remove') {
            return `Are you sure you want to remove the negative keyword <strong>${esc(change.keywordText)}</strong> from ${isCampaign ? 'campaign' : 'ad group'} <strong>${esc(ownerName)}</strong>?`;
        } else {
            return `Are you sure you want to add the negative keyword <strong>${esc(change.keywordText)}</strong> (${esc(formatMatchType(change.matchType))}) to ${isCampaign ? 'campaign' : 'ad group'} <strong>${esc(ownerName)}</strong>?`;
        }
    }
    else if (mutationType === 'ad_schedule_changes') {
        const campaign = overviewCampaignRows().find(c => String(c.campaignId || c.id) === String(change.campaignId));
        const campaignName = campaign ? campaign.campaignName || campaign.name : change.campaignId;
        const list = Array.isArray(changes) ? changes : [change];
        const editRemoves = list.filter(item => item.action === 'remove');
        const editAdds = list.filter(item => item.action !== 'remove');
        if (editRemoves.length && editAdds.length) {
            return `
                <p>Apply this ad schedule replacement?</p>
                ${scheduleChangeListHtml('This will remove:', editRemoves)}
                ${scheduleChangeListHtml('This will add:', editAdds)}
            `;
        }
        if (change.action === 'remove') {
            const timeStr = formatScheduleTimeRange(change.startHour, change.startMinute, change.endHour, change.endMinute);
            const dayStr = change.dayOfWeek ? formatScheduleDay(change.dayOfWeek) : '';
            const scheduleText = timeStr || dayStr
                ? ` <strong>${esc(timeStr || 'Selected time')}</strong>${dayStr ? ` on <strong>${esc(dayStr)}</strong>` : ''}`
                : '';
            return `Are you sure you want to remove the ad schedule${scheduleText} from campaign <strong>${esc(campaignName)}</strong>?`;
        } else {
            const dayList = list
                .map(item => item.dayOfWeek ? formatScheduleDay(item.dayOfWeek) : '')
                .filter(Boolean);
            const timeStr = formatScheduleTimeRange(change.startHour, change.startMinute, change.endHour, change.endMinute);
            const dayStr = formatDayList(dayList);
            return `Are you sure you want to add an ad schedule for campaign <strong>${esc(campaignName)}</strong> on <strong>${esc(dayStr)}</strong> from ${esc(timeStr)}?`;
        }
    }
    return `Are you sure you want to perform this Google Ads change?`;
}

function formatDayList(days) {
    const unique = Array.from(new Set(days.filter(Boolean)));
    if (!unique.length) return 'selected days';
    const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
    const weekend = ['Saturday', 'Sunday'];
    const everyDay = [...weekdays, ...weekend];
    const same = expected => unique.length === expected.length && expected.every(day => unique.includes(day));
    if (same(weekdays)) return 'Weekdays (Monday - Friday)';
    if (same(weekend)) return 'Weekend (Saturday - Sunday)';
    if (same(everyDay)) return 'Every day';
    if (unique.length === 1) return unique[0];
    return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
}

function renderControlsApplyProgress(modalBody, batchNumber, batchCount, appliedCount, totalCount) {
    const percent = totalCount ? Math.round((appliedCount / totalCount) * 100) : 0;
    modalBody.innerHTML = `
        <div class="controls-batch-progress">
            <div class="loading-spinner"></div>
            <div class="controls-batch-progress__copy"><strong>Applying batch ${batchNumber} of ${batchCount}</strong><span>Google Ads is processing the validated request. Later batches wait until this one succeeds.</span></div>
            <div class="controls-batch-progress__track"><span style="width:${percent}%"></span></div>
            <span>${appliedCount} of ${totalCount} validated changes applied</span>
        </div>`;
}

async function refreshDashboardAfterControlsMutation(appliedMutationType) {
    controlsState = null;
    if (appliedMutationType === 'ad_schedule_changes') clearScheduleEditMode();
    if (appliedMutationType === 'audience_changes') selectedAudienceExclusions.clear();
    try {
        const generation = beginDashboardLoad();
        const dashboard = await fetchDashboardView('overview');
        if (generation === dashboardLoadGeneration) {
            dashboardData = dashboard;
            window.fullData = dashboard;
            resetLoadedDashboardViews('overview');
            const tabId = activeDashboardTab();
            if (dashboardViewForTab(tabId) !== 'overview') {
                await ensureDashboardViewForTab(tabId, { render: false });
            }
            populateGlobalFilters();
            renderDashboardPayload();
        }
    } catch (err) {
        console.error('Failed to reload dashboard after change', err);
    }
    try {
        await loadControlsState(true);
    } catch (err) {
        console.error('Failed to reload Google Ads controls after change', err);
    }
    clearKeywordSelection('keywords');
    clearKeywordSelection('negatives');
}

async function applyPendingControlsChange() {
    if (!pendingControlsPreview || !pendingLocalChange) return;
    const modal = document.getElementById('controlsPreviewModal');
    if (!modal) return;
    const applyBtn = modal.querySelector('.btn-primary');
    const cancelBtn = modal.querySelector('.btn-secondary');
    const modalBody = modal.querySelector('.modal-body');
    if (!modalBody) return;

    if (applyBtn) applyBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;

    const aggregatePreview = pendingControlsPreview;
    const previews = controlsPreviewBatches(aggregatePreview);
    const appliedMutationType = pendingLocalChange.mutationType;
    const totalCount = previews.reduce((sum, preview) => sum + controlsPreviewChangeCount(preview), 0);
    let appliedCount = 0;
    let failedBatchNumber = 0;

    try {
        for (let batchIndex = 0; batchIndex < previews.length; batchIndex += 1) {
            const preview = previews[batchIndex];
            failedBatchNumber = batchIndex + 1;
            renderControlsApplyProgress(modalBody, failedBatchNumber, previews.length, appliedCount, totalCount);
            const res = await dashboardFetch(`${API_BASE_GLOBAL}/api/account-controls/mutations/${preview.mutationId}/confirm`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirmationToken: preview.confirmationToken || '' })
            });
            const result = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(result.partialFailure?.message || result.error || `Batch ${failedBatchNumber} failed.`);
            }
            appliedCount += controlsPreviewChangeCount(preview);
        }

        removeControlsPreviewModal();
        controlsPreviewRequestId += 1;
        pendingLocalChange = null;
        pendingControlsPreview = null;
        await refreshDashboardAfterControlsMutation(appliedMutationType);
        showToast(`${appliedCount} Google Ads change${appliedCount === 1 ? '' : 's'} applied successfully.`, false);
    } catch (err) {
        const laterCount = previews
            .slice(failedBatchNumber)
            .reduce((sum, preview) => sum + controlsPreviewChangeCount(preview), 0);
        controlsPreviewRequestId += 1;
        pendingLocalChange = null;
        pendingControlsPreview = null;
        modalBody.innerHTML = `
            <div class="controls-batch-failure" role="alert">
                <span class="controls-batch-failure__icon">!</span>
                <div><strong>${appliedCount ? `${appliedCount} change${appliedCount === 1 ? '' : 's'} applied before the process stopped` : 'The changes could not be fully applied'}</strong>
                    <p>Batch ${failedBatchNumber || 1} of ${previews.length} failed: ${esc(err.message || 'Google Ads rejected the request.')}</p>
                    <p>${laterCount ? `${laterCount} later change${laterCount === 1 ? ' was' : 's were'} not sent. ` : ''}The failed batch may have been partially processed if it covered more than one Google Ads scope. Current data is being refreshed; review it before trying again.</p>
                </div>
            </div>
            <div class="control-actions-row" style="padding:1rem 0 0;margin-top:1rem;border-top:1px solid var(--border-light);margin-bottom:0"><button class="btn btn-secondary btn-sm" onclick="closeControlsPreviewModal()">Close</button></div>`;
        await refreshDashboardAfterControlsMutation(appliedMutationType);
        showToast(`Batch ${failedBatchNumber || 1} failed. Current Google Ads data was refreshed.`, true);
    }
}

async function confirmControlsMutation() {
    return applyPendingControlsChange();
}

function previewStatusControl(entityType, entityId, targetStatus) {
    const row = entityType === 'campaign'
        ? (controlsState?.campaigns || []).find(item => item.campaignId === entityId)
        : (controlsState?.adGroups || []).find(item => item.adGroupId === entityId);
    previewControlsMutation('entity_status_changes', [{
        entityType,
        campaignId: row?.campaignId || entityId,
        adGroupId: entityType === 'ad_group' ? entityId : undefined,
        entityId,
        currentStatus: row?.status,
        targetStatus
    }], `dashboard ${entityType} status`);
}

function previewKeywordRemove(adGroupId, criterionId, keywordText, matchType) {
    previewControlsMutation('keyword_changes', [{
        action: 'remove',
        adGroupId,
        criterionId,
        keywordText,
        matchType
    }], 'dashboard keyword remove');
}

function previewNegativeRemove(scope, campaignId, adGroupId, criterionId, keywordText, matchType) {
    previewControlsMutation('negative_keyword_changes', [{
        action: 'remove',
        scope,
        campaignId,
        adGroupId: scope === 'ad_group' ? adGroupId : undefined,
        criterionId,
        keywordText,
        matchType
    }], 'dashboard negative keyword remove');
}

function previewScheduleRemove(campaignId, criterionId, resourceName, campaignName, dayOfWeek, startHour, startMinute, endHour, endMinute) {
    previewControlsMutation('ad_schedule_changes', [{
        action: 'remove',
        campaignId,
        criterionId,
        resourceName,
        campaignName,
        dayOfWeek,
        startHour,
        startMinute,
        endHour,
        endMinute
    }], 'dashboard ad schedule remove');
}

window.editSchedule = function (campaignId, criterionId, resourceName, campaignName, dayOfWeek, startHour, startMinute, endHour, endMinute) {
    setScheduleEditMode({
        campaignId,
        criterionId,
        resourceName,
        campaignName,
        dayOfWeek,
        startHour,
        startMinute,
        endHour,
        endMinute
    });
};

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
    const message = String(msg || '');
    const now = Date.now();
    if (message === lastToastMessage && now - lastToastShownAt < 1500) return;
    lastToastMessage = message;
    lastToastShownAt = now;
    if (toastHideTimer) {
        clearTimeout(toastHideTimer);
        toastHideTimer = null;
    }
    els.toast.textContent = message;
    els.toast.classList.add('show');
    if (!persist) {
        toastHideTimer = setTimeout(() => {
            els.toast.classList.remove('show');
            toastHideTimer = null;
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
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
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

    const competitorBreakdown = dashboardData.competitorBreakdown || [];
    const competitorRows = (dashboardData.keywords || []).filter(k => k.isCompetitor);
    const keywordSpend = competitorBreakdown.length
        ? competitorBreakdown.reduce((acc, row) => acc + (row.spend || 0), 0)
        : competitorRows.reduce((acc, row) => acc + (row.spend || 0), 0);
    const keywordConv = competitorBreakdown.length
        ? competitorBreakdown.reduce((acc, row) => acc + (row.conversions || 0), 0)
        : competitorRows.reduce((acc, row) => acc + (row.conversions || 0), 0);
    const coverageKnown = competitorBreakdown.some(row => row.negativeCoverageKnown);
    const coveredSpend = competitorBreakdown.reduce((acc, row) => acc + Number(row.negativeCoveredSpend || 0), 0);
    const uncoveredSpend = coverageKnown
        ? competitorBreakdown.reduce((acc, row) => acc + Number(row.negativeUncoveredSpend || 0), 0)
        : null;
    const searchTermSpend = competitorBreakdown.reduce((acc, row) => acc + Number(row.searchTermSpend || 0), 0);
    const searchTermConv = competitorBreakdown.reduce((acc, row) => acc + Number(row.searchTermConversions || 0), 0);
    const displaySpend = coverageKnown ? searchTermSpend : keywordSpend;
    const displayConv = coverageKnown ? searchTermConv : keywordConv;
    const unclassifiedSpend = coverageKnown ? Math.max(keywordSpend - searchTermSpend, 0) : keywordSpend;
    const totalSpend = dashboardData.summary?.spend || 0;
    const share = totalSpend > 0 ? (displaySpend / totalSpend) * 100 : 0;
    const uncoveredShare = totalSpend > 0 && uncoveredSpend !== null ? (uncoveredSpend / totalSpend) * 100 : 0;
    const keywordSpendNote = coverageKnown && Math.abs(keywordSpend - searchTermSpend) >= 1
        ? ` Keyword-level competitor spend is ${fmtCurr(keywordSpend)}; it can differ because search terms can match non-competitor keywords and Google can hide some terms.`
        : '';

    // First-party webhook lead integration (deduped sessions from lead_sessions table)
    const leadRows = dashboardData.leadAttribution?.recentLeads || [];
    const webhookLeads = leadRows.filter(lead => {
        const term = String(lead.attribution?.keyword || lead.attribution?.utm_term || '').toLowerCase();
        const competitorRoots = (Array.isArray(dashboardData.competitorRoots) && dashboardData.competitorRoots.length)
            ? dashboardData.competitorRoots
            : DEFAULT_COMPETITOR_ROOTS;
        return competitorRoots.some(c => term.includes(c));
    });
    const webhookLeadsCount = webhookLeads.length;
    const webhookWonCount = webhookLeads.filter(l => normalizeLeadStatus(l.status) === 'converted').length;
    const webhookQualifiedCount = webhookLeads.filter(l => normalizeLeadStatus(l.status) === 'qualified').length;
    const normalizedLeadCount = competitorBreakdown.reduce((acc, row) => acc + Number(row.realLeadCount || row.leadQuality?.uniqueLeads || 0), 0);
    const normalizedQualifiedOrWon = competitorBreakdown.reduce((acc, row) => acc + Number(row.qualifiedOrConvertedLeads || row.leadQuality?.qualifiedOrConverted || 0), 0);
    const normalizedUseless = competitorBreakdown.reduce((acc, row) => acc + Number(row.uselessLeads || row.leadQuality?.useless || 0), 0);
    const displayLeadCount = normalizedLeadCount || webhookLeadsCount;
    const displayQualifiedOrWon = normalizedQualifiedOrWon || (webhookWonCount + webhookQualifiedCount);
    const displayUseless = normalizedUseless;

    const isRealConvZero = dashboardData.leadAttribution && displayQualifiedOrWon === 0;

    const kpis = [
        {
            label: coverageKnown ? 'Visible Competitor Spend' : 'Competitor Keyword Spend',
            value: fmtCurr(displaySpend),
            desc: coverageKnown
                ? `Visible search-term spend containing competitor names. Covered + uncovered spend should add up to this number.${keywordSpendNote}`
                : 'Keyword-level spend on keywords containing competitor names; visible search-term coverage is unavailable.',
            isBad: displaySpend > 0
        },
        {
            label: 'Uncovered Spend',
            value: uncoveredSpend === null ? 'n/a' : fmtCurr(uncoveredSpend),
            desc: coverageKnown
                ? 'Competitor search-term spend not covered by fetched negatives.'
                : 'No matching competitor search-term rows are available for negative coverage classification.',
            isBad: coverageKnown && uncoveredSpend > 0
        },
        {
            label: 'Already Covered',
            value: fmtCurr(coveredSpend),
            desc: 'Competitor search-term spend already matched by negative coverage.',
            isBad: coverageKnown && coveredSpend > 0 && uncoveredSpend === 0
        },
        {
            label: 'Unclassified Spend',
            value: fmtCurr(unclassifiedSpend),
            desc: 'Competitor keyword spend that cannot be classified from visible search-term coverage.',
            isBad: !coverageKnown && keywordSpend > 0
        },
        {
            label: 'Budget Bleed',
            value: fmtPct(share),
            desc: coverageKnown
                ? 'Percentage of budget from visible competitor search terms.'
                : 'Percentage of budget from competitor-named keywords.',
            isBad: share > 5
        },
        {
            label: 'Google Ads Conversions',
            value: fmtNum(displayConv),
            desc: coverageKnown
                ? 'Conversions on visible competitor search-term rows.'
                : 'Conversions on competitor-named keyword rows.',
            isBad: displaySpend > 0 && (displayConv === 0 || isRealConvZero)
        }
    ];

    if (dashboardData.leadAttribution) {
        kpis.push({
            label: 'Leads',
            value: fmtNum(displayLeadCount),
            desc: `<strong>${fmtNum(displayQualifiedOrWon)}</strong> qualified/won, <strong>${fmtNum(displayUseless)}</strong> useless.`,
            isBad: displaySpend > 0 && isRealConvZero
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
        if (coverageKnown && (uncoveredShare > 5 || (uncoveredSpend > 0 && share > 5))) {
            recommendationHtml = `
                <div style="padding: 1rem; border-radius: 8px; border: 1px solid rgba(239, 68, 68, 0.2); background: rgba(239, 68, 68, 0.02); font-size: 0.9rem;">
                    <div style="font-weight: 600; color: var(--danger); margin-bottom: 0.25rem; display: flex; align-items: center; gap: 0.5rem;">
                        <span>⚠️</span> Action Required: Uncovered Competitor Spend (${fmtPct(uncoveredShare)})
                    </div>
                    <div style="color: var(--text-muted); line-height: 1.45;">
                        Competitor spend is high-risk, but only the uncovered portion should become fresh negative-keyword work. Covered spend should be checked for reporting lag, scope, or match-type mismatch before adding duplicate negatives.
                    </div>
                </div>
            `;
        } else if (coverageKnown && coveredSpend > 0 && uncoveredSpend === 0) {
            recommendationHtml = `
                <div style="padding: 1rem; border-radius: 8px; border: 1px solid rgba(59, 130, 246, 0.2); background: rgba(59, 130, 246, 0.02); font-size: 0.9rem;">
                    <div style="font-weight: 600; color: var(--info); margin-bottom: 0.25rem; display: flex; align-items: center; gap: 0.5rem;">
                        <span>ℹ️</span> Competitor Spend Already Covered
                    </div>
                    <div style="color: var(--text-muted); line-height: 1.45;">
                        Fetched negatives already cover the competitor search-term spend in this filter. Do not add duplicate negatives; inspect scope, match type, and date lag if spend continues.
                    </div>
                </div>
            `;
        } else if (!coverageKnown && keywordSpend > 0) {
            recommendationHtml = `
                <div style="padding: 1rem; border-radius: 8px; border: 1px solid rgba(245, 158, 11, 0.2); background: rgba(245, 158, 11, 0.02); font-size: 0.9rem;">
                    <div style="font-weight: 600; color: var(--warning); margin-bottom: 0.25rem; display: flex; align-items: center; gap: 0.5rem;">
                        <span>⚠️</span> Competitor Coverage Unknown
                    </div>
                    <div style="color: var(--text-muted); line-height: 1.45;">
                        Competitor keyword spend is present, but matching visible search-term rows are not available in this filter. Do not treat uncovered spend as zero; inspect source coverage or refresh search-term data before deciding on negatives.
                    </div>
                </div>
            `;
        } else if (displaySpend > 0) {
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
        document.documentElement.dataset.agThemeMode = 'dark';
        Chart.defaults.color = '#94a3b8';
        Chart.defaults.borderColor = 'rgba(255, 255, 255, 0.05)';
    } else {
        document.documentElement.classList.remove('dark');
        document.documentElement.dataset.agThemeMode = 'light';
        Chart.defaults.color = '#475569';
        Chart.defaults.borderColor = 'rgba(0, 0, 0, 0.05)';
    }

    if (reRender) {
        renderCharts();
    }
}

function renderTimePerformance() {
    const metric = document.getElementById('dayHourMetricSelect')?.value || 'clicks';
    const dayData = dashboardData.dayOfWeekPerformance || [];
    const hourData = dashboardData.dayAndHourPerformance || [];
    const primaryColor = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#f25e36';

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
                    backgroundColor: primaryColor
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
                    backgroundColor: primaryColor
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

                const dayName = day.charAt(0) + day.slice(1).toLowerCase();
                const hStart = hour.toString().padStart(2, '0');
                const hEnd = (hour + 1).toString().padStart(2, '0');

                let formatVal = fmtNum(val);
                if (['ctr', 'cvr'].includes(metric)) formatVal = fmtPct(val);
                if (['spend', 'cpa', 'avgCpc'].includes(metric)) formatVal = '$' + fmtNum(val);

                const percentage = val > 0 ? Math.round(Math.max(opacity, 0.1) * 100) : 0;
                const cellBg = val > 0 ? `color-mix(in srgb, var(--primary) ${percentage}%, transparent)` : 'transparent';

                html += `<div class="heatmap-cell" data-day="${dayName}, ${hStart} - ${hEnd}" data-metric="${metric.charAt(0).toUpperCase() + metric.slice(1)}" data-val="${formatVal}" style="background-color: ${cellBg}; height: 24px; border-radius: 2px; cursor: pointer;"></div>`;
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
            tooltip.style.backgroundColor = 'var(--bg-surface)';
            tooltip.style.border = '1px solid var(--border-highlight)';
            tooltip.style.boxShadow = '0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)';
            tooltip.style.padding = '12px 16px';
            tooltip.style.borderRadius = 'var(--radius-md)';
            tooltip.style.zIndex = '1000';
            tooltip.style.pointerEvents = 'none';
            tooltip.style.minWidth = '140px';
            tooltip.style.color = 'var(--text-primary)';
            document.body.appendChild(tooltip);
        }

        document.querySelectorAll('.heatmap-cell').forEach(cell => {
            cell.addEventListener('mouseenter', (e) => {
                tooltip.style.display = 'block';
                const d = e.target.dataset;
                tooltip.innerHTML = `
                    <div style="font-size: 14px; margin-bottom: 12px; color: var(--text-primary);">${d.day}</div>
                    <div style="font-size: 13px; color: var(--text-muted); margin-bottom: 8px;">${d.metric}</div>
                    <div style="font-size: 20px; font-weight: 400; display: flex; align-items: center; gap: 8px; color: var(--text-primary);">
                        <span style="display:inline-block; width:16px; height:12px; background-color:var(--primary);"></span>
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

// Audience reporting and controls
const AUDIENCE_METRICS = {
    clicks: { label: 'Clicks', group: 'Performance', format: 'number' },
    spend: { label: 'Cost', group: 'Performance', format: 'currency' },
    impressions: { label: 'Impressions', group: 'Performance', format: 'number' },
    ctr: { label: 'CTR', group: 'Performance', format: 'percent' },
    interactions: { label: 'Interactions', group: 'Performance', format: 'number' },
    interactionRate: { label: 'Interaction rate', group: 'Performance', format: 'percent' },
    engagements: { label: 'Engagements', group: 'Performance', format: 'number' },
    engagementRate: { label: 'Engagement rate', group: 'Performance', format: 'percent' },
    avgCpc: { label: 'Avg. CPC', group: 'Performance', format: 'currency' },
    averageCost: { label: 'Avg. cost', group: 'Performance', format: 'currency' },
    averageCpe: { label: 'Avg. CPE', group: 'Performance', format: 'currency' },
    conversions: { label: 'Conversions', group: 'Conversions', format: 'number' },
    cpa: { label: 'Cost / conv.', group: 'Conversions', format: 'currency' },
    conversionRate: { label: 'Conv. rate', group: 'Conversions', format: 'percent' },
    conversionValue: { label: 'Conv. value', group: 'Conversions', format: 'number' },
    allConversions: { label: 'All conv.', group: 'Conversions', format: 'number' },
    costPerAllConversion: { label: 'Cost / all conv.', group: 'Conversions', format: 'currency' },
    allConversionRate: { label: 'All conv. rate', group: 'Conversions', format: 'percent' },
    activeViewImpressions: { label: 'Viewable impr.', group: 'Viewability', format: 'number' },
    activeViewNonViewableImpressions: { label: 'Non-viewable impr.', group: 'Viewability', format: 'number' },
    activeViewMeasurableImpressions: { label: 'Measurable impr.', group: 'Viewability', format: 'number' },
    activeViewNonMeasurableImpressions: { label: 'Non-measurable impr.', group: 'Viewability', format: 'number' },
    activeViewMeasurableCost: { label: 'Measurable cost', group: 'Viewability', format: 'currency' },
    activeViewMeasurableRate: { label: 'Measurable rate', group: 'Viewability', format: 'percent' },
    activeViewAverageViewableCpm: { label: 'Avg. viewable CPM', group: 'Viewability', format: 'currency' },
    activeViewViewableCtr: { label: 'Viewable CTR', group: 'Viewability', format: 'percent' },
    activeViewImpressionDistribution: { label: 'Viewable impr. distrib.', group: 'Viewability', format: 'percent' },
    activeViewViewability: { label: 'Viewable rate', group: 'Viewability', format: 'percent' }
};

const AUDIENCE_DIMENSIONS = {
    age: {
        label: 'Age', criterionType: 'AGE_RANGE',
        values: ['AGE_RANGE_18_24', 'AGE_RANGE_25_34', 'AGE_RANGE_35_44', 'AGE_RANGE_45_54', 'AGE_RANGE_55_64', 'AGE_RANGE_65_UP', 'AGE_RANGE_UNDETERMINED']
    },
    gender: {
        label: 'Gender', criterionType: 'GENDER', values: ['FEMALE', 'MALE', 'UNDETERMINED']
    },
    income: {
        label: 'Household income', criterionType: 'INCOME_RANGE',
        values: ['INCOME_RANGE_90_UP', 'INCOME_RANGE_80_90', 'INCOME_RANGE_70_80', 'INCOME_RANGE_60_70', 'INCOME_RANGE_50_60', 'INCOME_RANGE_0_50', 'INCOME_RANGE_UNDETERMINED']
    },
    parentalStatus: {
        label: 'Parental status', criterionType: 'PARENTAL_STATUS', values: ['PARENT', 'NOT_A_PARENT', 'UNDETERMINED']
    }
};

const AUDIENCE_CRITERION_TYPES = new Set(['AUDIENCE', 'USER_INTEREST', 'USER_LIST', 'CUSTOM_AUDIENCE', 'COMBINED_AUDIENCE', 'LIFE_EVENT', 'EXTENDED_DEMOGRAPHIC']);
const AUDIENCE_NEGATIVE_TYPES = new Set(['USER_INTEREST', 'USER_LIST', 'LIFE_EVENT', 'EXTENDED_DEMOGRAPHIC']);
const AUDIENCE_CAMPAIGN_TYPES = new Set(['USER_INTEREST', 'USER_LIST', 'CUSTOM_AUDIENCE', 'COMBINED_AUDIENCE', 'LIFE_EVENT', 'EXTENDED_DEMOGRAPHIC']);
const AUDIENCE_AD_GROUP_TYPES = new Set(['AUDIENCE', 'USER_INTEREST', 'USER_LIST', 'CUSTOM_AUDIENCE', 'COMBINED_AUDIENCE']);

function currentAudienceData() {
    return dashboardData?.audiences || null;
}

function audienceTypeLabel(value) {
    const normalized = String(value || '').toUpperCase();
    return ({
        AUDIENCE: 'Audience', USER_INTEREST: 'Interest segment', USER_LIST: 'Your data', CUSTOM_AUDIENCE: 'Custom segment',
        COMBINED_AUDIENCE: 'Combined segment', LIFE_EVENT: 'Life event', EXTENDED_DEMOGRAPHIC: 'Detailed demographic',
        AGE_RANGE: 'Age', GENDER: 'Gender', INCOME_RANGE: 'Household income', PARENTAL_STATUS: 'Parental status',
        AUTO: 'Auto', SEARCH: 'People who searched'
    })[normalized] || formatControlStatus(value);
}

function audienceDimensionLabel(value) {
    const normalized = String(value || '').toUpperCase();
    return ({ AGE_RANGE: 'age groups', GENDER: 'gender groups', INCOME_RANGE: 'household income groups', PARENTAL_STATUS: 'parental-status groups' })[normalized]
        || AUDIENCE_DIMENSIONS[value]?.label
        || formatControlStatus(value);
}

function audienceDemographicValueLabel(value) {
    const normalized = String(value || '').toUpperCase();
    return ({
        AGE_RANGE_18_24: '18 – 24', AGE_RANGE_25_34: '25 – 34', AGE_RANGE_35_44: '35 – 44', AGE_RANGE_45_54: '45 – 54',
        AGE_RANGE_55_64: '55 – 64', AGE_RANGE_65_UP: '65+', AGE_RANGE_UNDETERMINED: 'Unknown',
        FEMALE: 'Female', MALE: 'Male', UNDETERMINED: 'Unknown',
        INCOME_RANGE_90_UP: 'Top 10%', INCOME_RANGE_80_90: '11 – 20%', INCOME_RANGE_70_80: '21 – 30%',
        INCOME_RANGE_60_70: '31 – 40%', INCOME_RANGE_50_60: '41 – 50%', INCOME_RANGE_0_50: 'Lower 50%', INCOME_RANGE_UNDETERMINED: 'Unknown',
        PARENT: 'Parent', NOT_A_PARENT: 'Not a parent'
    })[normalized] || formatControlStatus(value);
}

function audienceCatalogEntry(resourceName) {
    return (currentAudienceData()?.catalog || []).find(row => row.resourceName === resourceName) || null;
}

function audienceOwnerLabel(scope, ownerId) {
    const audiences = currentAudienceData();
    if (scope === 'ad_group') {
        const row = (audiences?.targetingSettings?.adGroups || []).find(item => String(item.adGroupId) === String(ownerId));
        return row ? `Ad group ${row.campaign} / ${row.adGroup}` : `Ad group ${ownerId || ''}`;
    }
    const row = (audiences?.targetingSettings?.campaigns || []).find(item => String(item.campaignId) === String(ownerId));
    return row ? `Campaign ${row.campaign}` : `Campaign ${ownerId || ''}`;
}

function audienceOwnerDetails(scope, ownerId) {
    const audiences = currentAudienceData();
    if (scope === 'ad_group') {
        const row = (audiences?.targetingSettings?.adGroups || []).find(item => String(item.adGroupId) === String(ownerId));
        return row ? { campaignId: row.campaignId, campaign: row.campaign, adGroupId: row.adGroupId, adGroup: row.adGroup } : null;
    }
    const row = (audiences?.targetingSettings?.campaigns || []).find(item => String(item.campaignId) === String(ownerId));
    return row ? { campaignId: row.campaignId, campaign: row.campaign, adGroupId: null, adGroup: null } : null;
}

function audienceMetricOptionsHtml(selected) {
    const allowed = new Set(currentAudienceData()?.capabilities?.metricKeys || Object.keys(AUDIENCE_METRICS));
    const groups = new Map();
    for (const [key, meta] of Object.entries(AUDIENCE_METRICS)) {
        if (!allowed.has(key)) continue;
        if (!groups.has(meta.group)) groups.set(meta.group, []);
        groups.get(meta.group).push({ key, label: meta.label });
    }
    return [...groups.entries()].map(([group, rows]) => `<optgroup label="${esc(group)}">${rows.map(row => `<option value="${esc(row.key)}"${row.key === selected ? ' selected' : ''}>${esc(row.label)}</option>`).join('')}</optgroup>`).join('');
}

function formatAudienceMetric(key, value) {
    const format = AUDIENCE_METRICS[key]?.format;
    if (format === 'currency') return fmtCurr(value);
    if (format === 'percent') return fmtPct(value);
    return fmtNum(value);
}

function emptyAudienceAggregate() {
    return {
        spend: 0, clicks: 0, impressions: 0, conversions: 0, allConversions: 0, conversionValue: 0,
        interactions: 0, engagements: 0, activeViewImpressions: 0, activeViewMeasurableImpressions: 0,
        activeViewMeasurableCost: 0
    };
}

function addAudienceMetricRow(target, row) {
    for (const key of Object.keys(target)) target[key] += Number(row?.[key] || 0);
    return target;
}

function finalizeAudienceAggregate(row) {
    const result = { ...row };
    result.ctr = row.impressions ? (row.clicks / row.impressions) * 100 : 0;
    result.avgCpc = row.clicks ? row.spend / row.clicks : 0;
    result.cpa = row.conversions ? row.spend / row.conversions : 0;
    result.conversionRate = row.interactions ? (row.conversions / row.interactions) * 100 : 0;
    result.costPerAllConversion = row.allConversions ? row.spend / row.allConversions : 0;
    result.allConversionRate = row.interactions ? (row.allConversions / row.interactions) * 100 : 0;
    result.interactionRate = row.impressions ? (row.interactions / row.impressions) * 100 : 0;
    result.averageCost = row.interactions ? row.spend / row.interactions : 0;
    result.engagementRate = row.impressions ? (row.engagements / row.impressions) * 100 : 0;
    result.averageCpe = row.engagements ? row.spend / row.engagements : 0;
    result.activeViewNonViewableImpressions = Math.max(0, row.activeViewMeasurableImpressions - row.activeViewImpressions);
    result.activeViewNonMeasurableImpressions = Math.max(0, row.impressions - row.activeViewMeasurableImpressions);
    result.activeViewMeasurableRate = row.impressions ? (row.activeViewMeasurableImpressions / row.impressions) * 100 : 0;
    result.activeViewAverageViewableCpm = row.activeViewImpressions ? (row.activeViewMeasurableCost / row.activeViewImpressions) * 1000 : 0;
    result.activeViewViewableCtr = row.activeViewImpressions ? (row.clicks / row.activeViewImpressions) * 100 : 0;
    result.activeViewImpressionDistribution = row.impressions ? (row.activeViewImpressions / row.impressions) * 100 : 0;
    result.activeViewViewability = row.activeViewMeasurableImpressions ? (row.activeViewImpressions / row.activeViewMeasurableImpressions) * 100 : 0;
    return result;
}

function groupAudienceMetrics(rows, keyFn) {
    const grouped = new Map();
    for (const row of rows || []) {
        const key = keyFn(row);
        if (!grouped.has(key)) grouped.set(key, emptyAudienceAggregate());
        addAudienceMetricRow(grouped.get(key), row);
    }
    return new Map([...grouped].map(([key, value]) => [key, finalizeAudienceAggregate(value)]));
}

function audienceTargetingMode(scope, ownerId) {
    const audiences = currentAudienceData();
    const own = scope === 'campaign'
        ? (audiences?.targetingSettings?.campaigns || []).find(row => String(row.campaignId) === String(ownerId))
        : (audiences?.targetingSettings?.adGroups || []).find(row => String(row.adGroupId) === String(ownerId));
    const audienceRestriction = own?.restrictions?.find(row => row.dimension === 'AUDIENCE');
    if (audienceRestriction) return { mode: audienceRestriction.bidOnly ? 'OBSERVATION' : 'TARGETING', inherited: false };
    if (scope === 'ad_group' && own?.campaignId) {
        const campaign = (audiences?.targetingSettings?.campaigns || []).find(row => String(row.campaignId) === String(own.campaignId));
        const inherited = campaign?.restrictions?.find(row => row.dimension === 'AUDIENCE');
        if (inherited) return { mode: inherited.bidOnly ? 'OBSERVATION' : 'TARGETING', inherited: true };
    }
    return { mode: 'TARGETING', inherited: false, implicit: true };
}

function formatAudienceBidModifier(value) {
    const modifier = Number(value);
    if (!Number.isFinite(modifier)) return 'No adjustment';
    const adjustment = Math.round((modifier - 1) * 100);
    return adjustment === 0 ? 'No adjustment' : `${adjustment > 0 ? '+' : ''}${adjustment}%`;
}

function setAudienceMetric(section, index, value) {
    if (!AUDIENCE_METRICS[value]) return;
    audienceMetricSelections[section][index] = value;
    renderAudienceCharts();
}

function setAudienceScope(value) {
    audienceScope = value === 'ad_group' ? 'ad_group' : 'campaign';
    renderAudienceCharts();
    renderAudienceTables();
}

function setAudienceDimension(value) {
    if (!AUDIENCE_DIMENSIONS[value]) return;
    audienceDimension = value;
    document.querySelectorAll('[data-audience-dimension]').forEach(button => {
        const active = button.dataset.audienceDimension === value;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
    });
    renderAudienceCharts();
    renderAudienceTables();
}

function audienceChartTypeIcon(type) {
    if (type === 'bar') {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"></path><path d="M18 17V9"></path><path d="M13 17V5"></path><path d="M8 17v-3"></path></svg>';
    }
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"></path><path d="m7 16 4-5 4 3 4-6"></path></svg>';
}

function syncAudienceChartTypeButton(section) {
    const button = document.getElementById(section === 'segments' ? 'audienceChartTypeBtn' : 'demographicChartTypeBtn');
    if (!button) return;
    const nextType = audienceChartTypes[section] === 'bar' ? 'line' : 'bar';
    const context = section === 'segments' ? 'audience performance' : 'demographic performance';
    button.innerHTML = audienceChartTypeIcon(nextType);
    button.title = `Switch to ${nextType} chart`;
    button.setAttribute('aria-label', `Switch ${context} to ${nextType} chart`);
}

function toggleAudienceChartType(section) {
    audienceChartTypes[section] = audienceChartTypes[section] === 'bar' ? 'line' : 'bar';
    syncAudienceChartTypeButton(section);
    renderAudienceCharts();
}

function toggleAudienceTable(section, button) {
    const panel = document.getElementById(section === 'segments' ? 'audienceSegmentsTablePanel' : section === 'demographics' ? 'audienceDemographicsTablePanel' : 'audienceExclusionsTablePanel');
    if (!panel) return;
    const opening = panel.hidden;
    panel.hidden = !opening;
    button.setAttribute('aria-expanded', String(opening));
    const chevronSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
    button.innerHTML = `${chevronSvg} ${opening ? 'Hide' : 'Show'} table`;
    if (opening) setTimeout(() => renderAudienceTables(), 50);
}

function audienceChartDataset(metric, data, index, type) {
    const colors = index === 0 ? ['#2563eb', 'rgba(37, 99, 235, 0.12)'] : ['#f05a32', 'rgba(240, 90, 50, 0.12)'];
    return {
        label: AUDIENCE_METRICS[metric]?.label || metric,
        data,
        borderColor: colors[0],
        backgroundColor: type === 'bar' ? colors[0] : colors[1],
        borderWidth: 2,
        tension: 0.28,
        pointRadius: data.length > 20 ? 0 : 3,
        fill: false,
        yAxisID: index === 0 ? 'y' : 'y1'
    };
}

function renderAudienceSegmentsChart() {
    const audiences = currentAudienceData();
    const canvas = document.getElementById('audienceSegmentsChart');
    const state = document.getElementById('audienceSegmentsState');
    if (!canvas || !state || !audiences) return;
    const rows = (audiences.performance?.[audienceScope === 'ad_group' ? 'adGroup' : 'campaign'] || []).filter(row => !row.negative);
    const grouped = groupAudienceMetrics(rows, row => row.date);
    const labels = [...grouped.keys()].filter(Boolean).sort();
    if (charts.audienceSegments) charts.audienceSegments.destroy();
    if (!labels.length) {
        state.hidden = false;
        state.textContent = 'No included audience-segment performance is available for this view and date range.';
        return;
    }
    state.hidden = true;
    const [primary, secondary] = audienceMetricSelections.segments;
    const type = audienceChartTypes.segments;
    charts.audienceSegments = new Chart(canvas.getContext('2d'), {
        type,
        data: {
            labels: labels.map(formatDateShort),
            datasets: [audienceChartDataset(primary, labels.map(key => grouped.get(key)?.[primary] || 0), 0, type), audienceChartDataset(secondary, labels.map(key => grouped.get(key)?.[secondary] || 0), 1, type)]
        },
        options: {
            responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
            plugins: { tooltip: { callbacks: { label: context => `${context.dataset.label}: ${formatAudienceMetric(context.datasetIndex ? secondary : primary, context.parsed.y)}` } } },
            scales: { y: { beginAtZero: true, grid: { color: 'rgba(148,163,184,.15)' } }, y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false } }, x: { grid: { display: false } } }
        }
    });
}

function renderAudienceDemographicsChart() {
    const audiences = currentAudienceData();
    const canvas = document.getElementById('audienceDemographicsChart');
    const state = document.getElementById('audienceDemographicsState');
    if (!canvas || !state || !audiences) return;
    const config = AUDIENCE_DIMENSIONS[audienceDimension];
    const rows = audiences.demographics?.[audienceDimension] || [];
    const grouped = groupAudienceMetrics(rows, row => row.value);
    const values = config.values;
    if (charts.audienceDemographics) charts.audienceDemographics.destroy();
    if (!rows.length) {
        state.hidden = false;
        state.textContent = `No ${config.label.toLowerCase()} performance is available for this view and date range.`;
        return;
    }
    state.hidden = true;
    const [primary, secondary] = audienceMetricSelections.demographics;
    const type = audienceChartTypes.demographics;
    charts.audienceDemographics = new Chart(canvas.getContext('2d'), {
        type,
        data: {
            labels: values.map(audienceDemographicValueLabel),
            datasets: [audienceChartDataset(primary, values.map(key => grouped.get(key)?.[primary] || 0), 0, type), audienceChartDataset(secondary, values.map(key => grouped.get(key)?.[secondary] || 0), 1, type)]
        },
        options: {
            responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
            plugins: { tooltip: { callbacks: { label: context => `${context.dataset.label}: ${formatAudienceMetric(context.datasetIndex ? secondary : primary, context.parsed.y)}` } } },
            scales: { y: { beginAtZero: true, grid: { color: 'rgba(148,163,184,.15)' } }, y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false } }, x: { grid: { display: false } } }
        }
    });
}

function renderAudienceCharts() {
    if (!currentAudienceData()) return;
    renderAudienceSegmentsChart();
    renderAudienceDemographicsChart();
}

function audienceCriterionMetrics() {
    const audiences = currentAudienceData();
    const rows = [...(audiences?.performance?.campaign || []), ...(audiences?.performance?.adGroup || [])];
    return groupAudienceMetrics(rows, row => row.resourceName || `${row.scope}|${row.campaignId}|${row.adGroupId || ''}|${row.criterionId}`);
}

function audienceExclusionOwnerLabel(row) {
    return row.adGroup ? `${row.campaign} / ${row.adGroup}` : row.campaign || 'Unknown campaign';
}

function audienceActionIcon(name) {
    if (name === 'gavel') {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 13-8.381 8.38a1 1 0 0 1-3.001-3l8.384-8.381"></path><path d="m16 16 6-6"></path><path d="m21.5 10.5-8-8"></path><path d="m8 8 6-6"></path><path d="m8.5 7.5 8 8"></path></svg>';
    }
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
}

function audienceCriterionSubtitle(row) {
    const category = String(row?.category || '').trim();
    return category && !/^\d+$/.test(category) ? category : '';
}

function audienceCriterionSubtitleHtml(row) {
    const subtitle = audienceCriterionSubtitle(row);
    return subtitle ? `<span>${esc(subtitle)}</span>` : '';
}

function audienceStatusDotHtml(value) {
    const normalized = String(value || 'ENABLED').trim().toUpperCase();
    const dotClass = normalized === 'ENABLED' ? 'enabled' : normalized === 'PAUSED' ? 'paused' : 'disabled';
    const label = formatControlStatus(normalized);
    return `<i class="audience-status-dot audience-status-dot--${dotClass}" title="${esc(label)}" aria-hidden="true"></i><span class="sr-only">${esc(label)}. </span>`;
}

function audienceExclusionDesktopRow(row) {
    const checked = selectedAudienceExclusions.has(row.resourceName);
    return `<tr>
        <td><input type="checkbox" aria-label="Select ${esc(row.name)}" ${checked ? 'checked' : ''} onchange="toggleAudienceExclusion(${jsArg(row.resourceName)}, this.checked)"></td>
        <td><div class="audience-table__name"><strong class="audience-identity-name">${audienceStatusDotHtml(row.status)}${esc(row.name)}</strong>${audienceCriterionSubtitleHtml(row)}</div></td>
        <td><span class="audience-type-label">${esc(audienceTypeLabel(row.criterionType))}</span></td>
        <td><div class="audience-exclusion-owner"><strong>${esc(audienceExclusionOwnerLabel(row))}</strong><span>${row.scope === 'campaign' ? 'Campaign-wide exclusion' : 'Ad-group exclusion'}</span></div></td>
        <td><span class="audience-badge">${row.scope === 'campaign' ? 'Campaign' : 'Ad group'}</span></td>
        <td><div class="audience-row-actions"><button class="audience-action-icon audience-action-icon--danger" type="button" onclick="reviewAudienceRemovalByResource(${jsArg(row.resourceName)})" title="Remove ${esc(row.name)}" aria-label="Remove ${esc(row.name)}">${audienceActionIcon('trash2')}</button></div></td>
    </tr>`;
}

function audienceExclusionMobileCard(row) {
    const checked = selectedAudienceExclusions.has(row.resourceName);
    return `<article class="audience-exclusion-card">
        <header class="audience-exclusion-card__header">
            <label class="audience-exclusion-card__select"><input type="checkbox" aria-label="Select ${esc(row.name)}" ${checked ? 'checked' : ''} onchange="toggleAudienceExclusion(${jsArg(row.resourceName)}, this.checked)"><span class="sr-only">Select exclusion</span></label>
            <div class="audience-exclusion-card__identity"><strong class="audience-identity-name">${audienceStatusDotHtml(row.status)}${esc(row.name)}</strong>${audienceCriterionSubtitleHtml(row)}</div>
            <span class="audience-badge">${row.scope === 'campaign' ? 'Campaign' : 'Ad group'}</span>
        </header>
        <div class="audience-exclusion-card__meta"><span class="audience-type-label">${esc(audienceTypeLabel(row.criterionType))}</span></div>
        <dl><div><dt>Excluded from</dt><dd>${esc(audienceExclusionOwnerLabel(row))}</dd></div><div><dt>Scope</dt><dd>${row.scope === 'campaign' ? 'Entire campaign' : 'This ad group only'}</dd></div></dl>
        <footer><button class="audience-action-icon audience-action-icon--danger" type="button" onclick="reviewAudienceRemovalByResource(${jsArg(row.resourceName)})" title="Remove ${esc(row.name)}" aria-label="Remove ${esc(row.name)}">${audienceActionIcon('trash2')}</button></footer>
    </article>`;
}

function audienceSegmentMobileCard({ row, metrics, mode }) {
    const owner = row.adGroup ? `${row.campaign} / ${row.adGroup}` : row.campaign || 'Unknown campaign';
    const modeLabel = mode.inherited ? `Inherited ${mode.mode.toLowerCase()}` : mode.mode.toLowerCase();
    return `<article class="audience-result-card">
        <header class="audience-result-card__header">
            <div class="audience-result-card__identity"><strong>${esc(row.name)}</strong>${audienceCriterionSubtitleHtml(row)}</div>
            <span class="audience-badge">${row.scope === 'campaign' ? 'Campaign' : 'Ad group'}</span>
        </header>
        <div class="audience-result-card__meta"><span class="audience-type-label">${esc(audienceTypeLabel(row.criterionType))}</span><span class="audience-badge ${mode.mode === 'TARGETING' ? 'audience-badge--warning' : 'audience-badge--positive'}">${esc(modeLabel)}</span></div>
        <dl>
            <div><dt>Campaign / ad group</dt><dd>${esc(owner)}</dd></div>
            <div><dt>Bid adjustment</dt><dd>${esc(formatAudienceBidModifier(row.bidModifier))}</dd></div>
        </dl>
        <div class="audience-result-card__metrics"><div><span>Clicks</span><strong>${fmtNum(metrics.clicks)}</strong></div><div><span>Cost</span><strong>${fmtCurr(metrics.spend)}</strong></div><div><span>Conversions</span><strong>${fmtNum(metrics.conversions)}</strong></div></div>
        <footer><button class="audience-action-icon" type="button" onclick="openAudienceBidModal(${jsArg(row.resourceName)})" title="Adjust bid for ${esc(row.name)}" aria-label="Adjust bid for ${esc(row.name)}">${audienceActionIcon('gavel')}</button><button class="audience-action-icon audience-action-icon--danger" type="button" onclick="reviewAudienceRemovalByResource(${jsArg(row.resourceName)})" title="Remove ${esc(row.name)}" aria-label="Remove ${esc(row.name)}">${audienceActionIcon('trash2')}</button></footer>
    </article>`;
}

function audienceDemographicMobileCard({ row, metrics }) {
    const owner = row.adGroup ? `${row.campaign} / ${row.adGroup}` : row.campaign || 'Unknown campaign';
    return `<article class="audience-result-card">
        <header class="audience-result-card__header">
            <div class="audience-result-card__identity"><strong>${esc(audienceDemographicValueLabel(row.value))}</strong><span>${esc(AUDIENCE_DIMENSIONS[audienceDimension]?.label || 'Demographic')}</span></div>
            <span class="audience-badge ${row.negative ? 'audience-badge--danger' : 'audience-badge--positive'}">${row.negative ? 'Excluded' : 'Included'}</span>
        </header>
        <div class="audience-result-card__meta"><span><i class="audience-status-dot" aria-hidden="true"></i>${esc(formatControlStatus(row.status || 'ENABLED'))}</span></div>
        <dl><div><dt>Campaign / ad group</dt><dd>${esc(owner)}</dd></div></dl>
        <div class="audience-result-card__metrics"><div><span>Clicks</span><strong>${fmtNum(metrics.clicks)}</strong></div><div><span>Impressions</span><strong>${fmtNum(metrics.impressions)}</strong></div><div><span>Cost</span><strong>${fmtCurr(metrics.spend)}</strong></div><div><span>Conversions</span><strong>${fmtNum(metrics.conversions)}</strong></div></div>
    </article>`;
}

function renderAudienceTables() {
    const audiences = currentAudienceData();
    if (!audiences) return;
    const availableExclusionResources = new Set((audiences.criteria || [])
        .filter(row => row.negative && AUDIENCE_CRITERION_TYPES.has(row.criterionType))
        .map(row => row.resourceName)
        .filter(Boolean));
    for (const resourceName of selectedAudienceExclusions) {
        if (!availableExclusionResources.has(resourceName)) selectedAudienceExclusions.delete(resourceName);
    }
    const metricByCriterion = audienceCriterionMetrics();
    const search = String(document.getElementById('audienceSegmentsSearch')?.value || '').trim().toLowerCase();
    const segments = (audiences.criteria || []).filter(row => row.scope === audienceScope && !row.negative && AUDIENCE_CRITERION_TYPES.has(row.criterionType)).filter(row => !search || [row.name, row.campaign, row.adGroup, row.category, row.audienceType].some(value => String(value || '').toLowerCase().includes(search)));

    const segmentRowData = segments.map(row => {
        const metrics = metricByCriterion.get(row.resourceName) || finalizeAudienceAggregate(emptyAudienceAggregate());
        const mode = audienceTargetingMode(row.scope, row.scope === 'campaign' ? row.campaignId : row.adGroupId);
        return {
            resourceName: row.resourceName,
            name: row.name || 'Segment',
            criterionType: audienceTypeLabel(row.criterionType),
            scope: row.scope === 'campaign' ? 'Campaign' : 'Ad group',
            ownerName: row.adGroup ? `${row.campaign} / ${row.adGroup}` : row.campaign,
            modeLabel: mode.inherited ? `Inherited ${mode.mode.toLowerCase()}` : mode.mode.toLowerCase(),
            modeValue: mode.mode,
            bidModifier: row.bidModifier,
            bidModifierLabel: formatAudienceBidModifier(row.bidModifier),
            clicks: metrics.clicks,
            spend: metrics.spend,
            conversions: metrics.conversions,
            rawRow: row
        };
    });

    const segmentColDefs = [
        { field: 'name', headerName: 'Segment', minWidth: 220, flex: 1.4, cellRenderer: p => `<div class="audience-table__name"><strong>${esc(p.value)}</strong>${audienceCriterionSubtitleHtml(p.data.rawRow)}</div>` },
        { field: 'criterionType', headerName: 'Type', minWidth: 140 },
        { field: 'scope', headerName: 'Level', minWidth: 110, cellRenderer: p => `<span class="audience-badge">${esc(p.value)}</span>` },
        { field: 'ownerName', headerName: 'Campaign / ad group', minWidth: 200, flex: 1.2 },
        { field: 'modeLabel', headerName: 'Mode', minWidth: 160, cellRenderer: p => `<span class="audience-badge ${p.data.modeValue === 'TARGETING' ? 'audience-badge--warning' : 'audience-badge--positive'}">${esc(p.value)}</span>` },
        { field: 'bidModifierLabel', headerName: 'Bid adjustment', minWidth: 130 },
        { field: 'clicks', headerName: 'Clicks', minWidth: 100, valueFormatter: p => fmtNum(p.value) },
        { field: 'spend', headerName: 'Cost', minWidth: 110, valueFormatter: p => fmtCurr(p.value) },
        { field: 'conversions', headerName: 'Conversions', minWidth: 110, valueFormatter: p => fmtNum(p.value) },
        { field: 'actions', headerName: 'Actions', minWidth: 100, sortable: false, filter: false, cellRenderer: p => `<div class="audience-row-actions"><button class="audience-action-icon" type="button" onclick="openAudienceBidModal(${jsArg(p.data.resourceName)})" title="Adjust bid for ${esc(p.data.name)}" aria-label="Adjust bid for ${esc(p.data.name)}">${audienceActionIcon('gavel')}</button><button class="audience-action-icon audience-action-icon--danger" type="button" onclick="reviewAudienceRemovalByResource(${jsArg(p.data.resourceName)})" title="Remove ${esc(p.data.name)}" aria-label="Remove ${esc(p.data.name)}">${audienceActionIcon('trash2')}</button></div>` }
    ];

    initGrid('grid-audienceSegments', segmentRowData, segmentColDefs);

    const count = document.getElementById('audienceSegmentsCount');
    if (count) count.textContent = `${segments.length} segment${segments.length === 1 ? '' : 's'}`;

    const demographicRows = audiences.demographics?.[audienceDimension] || [];
    const demographicGrouped = new Map();
    for (const row of demographicRows) {
        const key = `${row.value}|${row.campaignId}|${row.adGroupId}`;
        if (!demographicGrouped.has(key)) demographicGrouped.set(key, { row, metrics: emptyAudienceAggregate() });
        addAudienceMetricRow(demographicGrouped.get(key).metrics, row);
    }
    const demographicRowData = [...demographicGrouped.values()].map(({ row, metrics }) => {
        const final = finalizeAudienceAggregate(metrics);
        return {
            group: audienceDemographicValueLabel(row.value),
            ownerName: `${row.campaign} / ${row.adGroup}`,
            status: formatControlStatus(row.status || 'ENABLED'),
            inclusion: row.negative ? 'Excluded' : 'Included',
            isNegative: row.negative,
            clicks: final.clicks,
            impressions: final.impressions,
            spend: final.spend,
            conversions: final.conversions
        };
    });

    const demographicColDefs = [
        { field: 'group', headerName: 'Group', minWidth: 160, cellRenderer: p => `<strong>${esc(p.value)}</strong>` },
        { field: 'ownerName', headerName: 'Campaign / ad group', minWidth: 220, flex: 1.2 },
        { field: 'status', headerName: 'Status', minWidth: 120 },
        { field: 'inclusion', headerName: 'Included', minWidth: 110, cellRenderer: p => `<span class="audience-badge ${p.data.isNegative ? 'audience-badge--danger' : 'audience-badge--positive'}">${esc(p.value)}</span>` },
        { field: 'clicks', headerName: 'Clicks', minWidth: 100, valueFormatter: p => fmtNum(p.value) },
        { field: 'impressions', headerName: 'Impressions', minWidth: 110, valueFormatter: p => fmtNum(p.value) },
        { field: 'spend', headerName: 'Cost', minWidth: 110, valueFormatter: p => fmtCurr(p.value) },
        { field: 'conversions', headerName: 'Conversions', minWidth: 110, valueFormatter: p => fmtNum(p.value) }
    ];

    initGrid('grid-audienceDemographics', demographicRowData, demographicColDefs);

    const exclusions = visibleAudienceExclusions();
    const exclusionRowData = exclusions.map(row => ({
        resourceName: row.resourceName,
        name: row.name,
        criterionType: audienceTypeLabel(row.criterionType),
        ownerName: row.ownerName,
        scope: row.scope === 'campaign' ? 'Campaign' : 'Ad group',
        rawRow: row
    }));

    const exclusionColDefs = [
        { field: 'name', headerName: 'Excluded segment', minWidth: 220, flex: 1.5, cellRenderer: p => `<strong>${esc(p.value)}</strong>` },
        { field: 'criterionType', headerName: 'Type', minWidth: 140 },
        { field: 'ownerName', headerName: 'Excluded from', minWidth: 220, flex: 1.2 },
        { field: 'scope', headerName: 'Level', minWidth: 110, cellRenderer: p => `<span class="audience-badge">${esc(p.value)}</span>` },
        { field: 'actions', headerName: 'Actions', minWidth: 90, sortable: false, filter: false, cellRenderer: p => `<button class="audience-action-icon audience-action-icon--danger" type="button" onclick="reviewAudienceExclusionRemoval(${jsArg(p.data.rawRow.scope)}, ${jsArg(p.data.rawRow.scope === 'campaign' ? p.data.rawRow.campaignId : p.data.rawRow.adGroupId)}, ${jsArg(p.data.rawRow.criterionId)}, ${jsArg(p.data.name)})" title="Remove exclusion" aria-label="Remove exclusion">${audienceActionIcon('trash2')}</button>` }
    ];

    initGrid('grid-audienceExclusions', exclusionRowData, exclusionColDefs, {
        rowSelection: 'multiple',
        onSelectionChanged: params => {
            const selectedNodes = params.api.getSelectedNodes();
            selectedAudienceExclusions.clear();
            selectedNodes.forEach(node => {
                if (node.data?.resourceName) selectedAudienceExclusions.add(node.data.resourceName);
            });
            updateAudienceExclusionSelectionBar();
        }
    });

    const exclusionCount = document.getElementById('audienceExclusionsCount');
    if (exclusionCount) exclusionCount.textContent = `${exclusions.length} exclusion${exclusions.length === 1 ? '' : 's'}`;
    updateAudienceExclusionSelectionBar();
}

function renderAudiences() {
    const audiences = currentAudienceData();
    const segmentState = document.getElementById('audienceSegmentsState');
    const demographicState = document.getElementById('audienceDemographicsState');
    if (!audiences) {
        if (segmentState) { segmentState.hidden = false; segmentState.textContent = 'Audience data is loading…'; }
        if (demographicState) { demographicState.hidden = false; demographicState.textContent = 'Demographic data is loading…'; }
        return;
    }
    const scopeSelect = document.getElementById('audienceScopeSelect');
    if (scopeSelect) scopeSelect.value = audienceScope;
    const metricSelects = [
        ['audienceMetricPrimary', audienceMetricSelections.segments[0]], ['audienceMetricSecondary', audienceMetricSelections.segments[1]],
        ['demographicMetricPrimary', audienceMetricSelections.demographics[0]], ['demographicMetricSecondary', audienceMetricSelections.demographics[1]]
    ];
    for (const [id, selected] of metricSelects) {
        const select = document.getElementById(id);
        if (select) select.innerHTML = audienceMetricOptionsHtml(selected);
    }
    syncAudienceChartTypeButton('segments');
    syncAudienceChartTypeButton('demographics');
    renderAudienceCharts();
    renderAudienceTables();
    scheduleAudienceVisualResize();
}

function toggleAudienceExclusion(resourceName, checked) {
    if (checked) selectedAudienceExclusions.add(resourceName);
    else selectedAudienceExclusions.delete(resourceName);
    renderAudienceTables();
}

function visibleAudienceExclusions() {
    const audiences = currentAudienceData();
    const scope = document.getElementById('audienceExclusionScope')?.value || 'all';
    const search = String(document.getElementById('audienceExclusionSearch')?.value || '').trim().toLowerCase();
    return (audiences?.criteria || []).filter(row => row.negative && AUDIENCE_CRITERION_TYPES.has(row.criterionType))
        .filter(row => scope === 'all' || row.scope === scope)
        .filter(row => !search || [row.name, row.campaign, row.adGroup, row.category, row.audienceType].some(value => String(value || '').toLowerCase().includes(search)));
}

function scheduleAudienceVisualResize() {
    if (audienceResizeFrame) cancelAnimationFrame(audienceResizeFrame);
    audienceResizeFrame = requestAnimationFrame(() => {
        audienceResizeFrame = 0;
        for (const key of ['audienceSegments', 'audienceDemographics']) {
            const chart = charts[key];
            if (chart && typeof chart.resize === 'function') chart.resize();
        }
    });
}

function setupAudienceResponsiveLayout() {
    const page = document.querySelector('.audience-page');
    if (!page) return;
    audienceResizeObserver?.disconnect();
    if (typeof ResizeObserver === 'function') {
        audienceResizeObserver = new ResizeObserver(() => scheduleAudienceVisualResize());
        audienceResizeObserver.observe(page);
    }
    window.addEventListener('resize', scheduleAudienceVisualResize, { passive: true });
}

function toggleAllAudienceExclusions(checked) {
    for (const row of visibleAudienceExclusions()) {
        if (checked) selectedAudienceExclusions.add(row.resourceName);
        else selectedAudienceExclusions.delete(row.resourceName);
    }
    renderAudienceTables();
}

function updateAudienceExclusionSelectionBar() {
    const bar = document.getElementById('audienceExclusionSelection');
    const count = document.getElementById('audienceExclusionSelectedCount');
    if (bar) bar.hidden = selectedAudienceExclusions.size === 0;
    if (count) count.textContent = String(selectedAudienceExclusions.size);
}

function audienceRemovalChange(row) {
    return {
        action: 'remove_segment', scope: row.scope, campaignId: row.campaignId, adGroupId: row.adGroupId,
        criterionType: row.criterionType, audienceResourceName: row.audienceResourceName,
        criterionResourceName: row.resourceName, negative: Boolean(row.negative)
    };
}

function reviewAudienceRemovalByResource(resourceName) {
    const row = (currentAudienceData()?.criteria || []).find(item => item.resourceName === resourceName);
    if (!row) return showToast('That audience criterion is no longer in the current dashboard data. Refresh and try again.', true);
    previewControlsMutation('audience_changes', [audienceRemovalChange(row)], 'dashboard audience criterion removal');
}

function reviewSelectedAudienceExclusionRemovals() {
    const rows = (currentAudienceData()?.criteria || []).filter(row => selectedAudienceExclusions.has(row.resourceName) && row.negative && AUDIENCE_CRITERION_TYPES.has(row.criterionType));
    if (!rows.length) return showToast('Select at least one current exclusion.', true);
    previewControlsMutation('audience_changes', rows.map(audienceRemovalChange), 'dashboard audience exclusion bulk removal');
}

function closeAudienceModal() {
    document.getElementById('audienceManagementModal')?.remove();
    audienceEditorState = null;
    audienceDemographicEditorState = null;
}

function audienceOwnerOptions(scope) {
    const settings = currentAudienceData()?.targetingSettings;
    return scope === 'ad_group' ? settings?.adGroups || [] : settings?.campaigns || [];
}

function audienceOwnerIdFromRow(scope, row) {
    return scope === 'ad_group' ? row.adGroupId : row.campaignId;
}

function audienceCatalogType(row) {
    const supplied = String(row?.audienceType || '').toUpperCase().replace(/[\s-]+/g, '_');
    if (AUDIENCE_CRITERION_TYPES.has(supplied)) return supplied;
    const resource = String(row?.resourceName || '');
    if (resource.includes('/userInterests/')) return 'USER_INTEREST';
    if (resource.includes('/userLists/')) return 'USER_LIST';
    if (resource.includes('/customAudiences/')) return 'CUSTOM_AUDIENCE';
    if (resource.includes('/combinedAudiences/')) return 'COMBINED_AUDIENCE';
    if (resource.includes('/lifeEvents/')) return 'LIFE_EVENT';
    if (resource.includes('/detailedDemographics/')) return 'EXTENDED_DEMOGRAPHIC';
    if (resource.includes('/audiences/')) return 'AUDIENCE';
    return supplied;
}

function audienceCatalogAllowed(row, state = audienceEditorState) {
    if (!state || !row?.resourceName || String(row.status || '').toUpperCase() === 'REMOVED') return false;
    const type = audienceCatalogType(row);
    if (state.negative && !AUDIENCE_NEGATIVE_TYPES.has(type)) return false;
    return state.scope === 'campaign' ? AUDIENCE_CAMPAIGN_TYPES.has(type) : AUDIENCE_AD_GROUP_TYPES.has(type);
}

function audienceCriteriaForEditor(state = audienceEditorState) {
    if (!state) return [];
    return (currentAudienceData()?.criteria || []).filter(row => row.scope === state.scope
        && String(state.scope === 'campaign' ? row.campaignId : row.adGroupId) === String(state.ownerId)
        && Boolean(row.negative) === Boolean(state.negative)
        && AUDIENCE_CRITERION_TYPES.has(row.criterionType));
}

function initializeAudienceEditorOwner(ownerId) {
    if (!audienceEditorState) return;
    const options = audienceOwnerOptions(audienceEditorState.scope);
    const requested = options.find(row => String(audienceOwnerIdFromRow(audienceEditorState.scope, row)) === String(ownerId));
    const selected = requested || options[0] || null;
    audienceEditorState.ownerId = selected ? String(audienceOwnerIdFromRow(audienceEditorState.scope, selected)) : '';
    const criteria = audienceCriteriaForEditor(audienceEditorState);
    audienceEditorState.current = new Map(criteria.filter(row => row.audienceResourceName).map(row => [row.audienceResourceName, row]));
    audienceEditorState.selected = new Set(audienceEditorState.current.keys());
    const mode = audienceTargetingMode(audienceEditorState.scope, audienceEditorState.ownerId);
    audienceEditorState.currentMode = mode;
    audienceEditorState.mode = mode.mode;
}

function openAudienceEditor(negative = false, options = {}) {
    const audiences = currentAudienceData();
    if (!audiences) return showToast('Audience data is still loading. Try again in a moment.', true);
    const preferredScope = options.scope === 'ad_group' || options.scope === 'campaign'
        ? options.scope
        : negative ? 'campaign' : audienceScope;
    audienceEditorState = {
        negative: Boolean(negative), scope: preferredScope, ownerId: '', current: new Map(), selected: new Set(),
        mode: 'OBSERVATION', currentMode: null, query: '', catalogMode: 'search'
    };
    initializeAudienceEditorOwner(options.ownerId);
    renderAudienceEditorModal();
}

function audienceEditorOwnerOptionsHtml() {
    const state = audienceEditorState;
    return audienceOwnerOptions(state.scope).map(row => {
        const id = audienceOwnerIdFromRow(state.scope, row);
        const label = state.scope === 'ad_group' ? `${row.campaign} / ${row.adGroup}` : row.campaign;
        return `<option value="${esc(id)}"${String(id) === String(state.ownerId) ? ' selected' : ''}>${esc(label)}</option>`;
    }).join('');
}

function renderAudienceEditorModal() {
    const state = audienceEditorState;
    if (!state) return;
    document.getElementById('audienceManagementModal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'audienceManagementModal';
    modal.className = 'modal-overlay show';
    const mode = state.currentMode || audienceTargetingMode(state.scope, state.ownerId);
    const noOwners = audienceOwnerOptions(state.scope).length === 0;
    const inheritedNotice = !state.negative && mode.inherited
        ? `<div class="audience-warning">Audience mode is inherited from the campaign. Segment membership can still be reviewed here, but the mode must be changed at campaign level.</div>` : '';
    const targetingWarning = !state.negative && state.mode === 'TARGETING'
        ? `<div class="audience-warning" id="audienceTargetingWarning">Targeting narrows delivery to the selected segments. Review this carefully because it can substantially reduce reach.</div>` : '';
    modal.innerHTML = `<div class="modal-content-card audience-modal">
        <div class="modal-header"><h3>${state.negative ? 'Exclude audience segments' : 'Edit audience segments'}</h3><button class="modal-close-btn" type="button" onclick="closeAudienceModal()" aria-label="Close audience editor">×</button></div>
        <div class="modal-body">
            <div class="audience-modal__intro"><strong>${state.negative ? 'Choose segments that should not see your ads' : 'Choose the audience segments to use'}</strong><p>${state.negative ? 'Campaign and ad-group exclusions stay separate. Only segment types supported by Google Ads at the selected level are shown.' : 'Search or browse the account catalog. Recent and website-based ideas are intentionally omitted.'}</p>
                <div class="audience-modal__selectors"><label>Level<select id="audienceEditorScope" onchange="setAudienceEditorScope(this.value)"><option value="campaign"${state.scope === 'campaign' ? ' selected' : ''}>Campaign</option><option value="ad_group"${state.scope === 'ad_group' ? ' selected' : ''}>Ad group</option></select></label><label>${state.scope === 'campaign' ? 'Campaign' : 'Campaign / ad group'}<select id="audienceEditorOwner" onchange="setAudienceEditorOwner(this.value)"${noOwners ? ' disabled' : ''}>${audienceEditorOwnerOptionsHtml()}</select></label></div>
            </div>
            ${!state.negative ? `<div class="audience-mode-options" aria-label="Audience targeting mode"><label class="audience-mode-option"><input type="radio" name="audienceMode" value="TARGETING" ${state.mode === 'TARGETING' ? 'checked' : ''} ${mode.inherited ? 'disabled' : ''} onchange="setAudienceEditorMode(this.value)"><span><strong>Targeting</strong><span>Only people in the selected segments can see the ads.</span></span></label><label class="audience-mode-option"><input type="radio" name="audienceMode" value="OBSERVATION" ${state.mode === 'OBSERVATION' ? 'checked' : ''} ${mode.inherited ? 'disabled' : ''} onchange="setAudienceEditorMode(this.value)"><span><strong>Observation (recommended)</strong><span>Measure these segments without narrowing who can see the ads.</span></span></label></div>${inheritedNotice}${targetingWarning}` : ''}
            ${noOwners ? '<div class="audience-empty">No eligible campaign or ad group is available in the current account view.</div>' : `<div class="audience-picker"><section class="audience-picker__catalog"><div class="audience-picker__tabs" role="tablist"><button type="button" class="${state.catalogMode === 'search' ? 'active' : ''}" onclick="setAudienceCatalogMode('search')">Search</button><button type="button" class="${state.catalogMode === 'browse' ? 'active' : ''}" onclick="setAudienceCatalogMode('browse')">Browse</button></div><div class="audience-picker__search"><input id="audienceCatalogSearch" type="search" value="${esc(state.query)}" placeholder="Search audience segments" oninput="filterAudienceCatalog(this.value)"></div><div class="audience-picker__list" id="audienceCatalogList"></div></section><aside><div class="audience-picker__selected-header"><span id="audienceSelectedCount">${state.selected.size}</span> selected</div><div class="audience-picker__selected" id="audienceSelectedList"></div></aside></div>`}
        </div>
        <div class="audience-modal__footer"><p>Review validates current Google Ads state, duplicates, compatibility and exact scope before anything can be applied.</p><div class="audience-modal__footer-actions"><button class="btn btn-secondary btn-sm" type="button" onclick="closeAudienceModal()">Cancel</button><button class="btn btn-primary btn-sm" type="button" onclick="reviewAudienceEditorChanges()"${noOwners ? ' disabled' : ''}>Review changes</button></div></div>
    </div>`;
    document.body.appendChild(modal);
    renderAudiencePickerContents();
}

function setAudienceEditorScope(value) {
    if (!audienceEditorState) return;
    audienceEditorState.scope = value === 'ad_group' ? 'ad_group' : 'campaign';
    initializeAudienceEditorOwner('');
    renderAudienceEditorModal();
}

function setAudienceEditorOwner(value) {
    if (!audienceEditorState) return;
    initializeAudienceEditorOwner(value);
    renderAudienceEditorModal();
}

function setAudienceEditorMode(value) {
    if (!audienceEditorState || !['TARGETING', 'OBSERVATION'].includes(value)) return;
    audienceEditorState.mode = value;
    const warning = document.getElementById('audienceTargetingWarning');
    if (value === 'TARGETING' && !warning) renderAudienceEditorModal();
    else if (value === 'OBSERVATION' && warning) renderAudienceEditorModal();
}

function setAudienceCatalogMode(value) {
    if (!audienceEditorState) return;
    audienceEditorState.catalogMode = value === 'browse' ? 'browse' : 'search';
    renderAudienceEditorModal();
}

function filterAudienceCatalog(value) {
    if (!audienceEditorState) return;
    audienceEditorState.query = String(value || '').trim();
    renderAudiencePickerContents();
}

function audienceEditorCatalogRows() {
    const state = audienceEditorState;
    if (!state) return [];
    const catalog = [...(currentAudienceData()?.catalog || [])];
    for (const row of state.current.values()) {
        if (!catalog.some(item => item.resourceName === row.audienceResourceName)) {
            catalog.push({ resourceName: row.audienceResourceName, name: row.name, audienceType: row.criterionType, category: row.category });
        }
    }
    const query = state.query.toLowerCase();
    return catalog.filter(row => audienceCatalogAllowed(row, state)).filter(row => !query || [row.name, row.category, row.description, audienceTypeLabel(audienceCatalogType(row))].some(value => String(value || '').toLowerCase().includes(query)))
        .sort((a, b) => `${audienceTypeLabel(audienceCatalogType(a))}|${a.category || ''}|${a.name}`.localeCompare(`${audienceTypeLabel(audienceCatalogType(b))}|${b.category || ''}|${b.name}`));
}

function renderAudiencePickerContents() {
    const state = audienceEditorState;
    const list = document.getElementById('audienceCatalogList');
    const selected = document.getElementById('audienceSelectedList');
    if (!state || !list || !selected) return;
    const rows = audienceEditorCatalogRows();
    const grouped = new Map();
    for (const row of rows) {
        const type = audienceCatalogType(row);
        const group = state.catalogMode === 'browse' ? `${audienceTypeLabel(type)}${row.category ? ` · ${row.category}` : ''}` : audienceTypeLabel(type);
        if (!grouped.has(group)) grouped.set(group, []);
        grouped.get(group).push(row);
    }
    const chevronIcon = `<svg class="audience-picker__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
    list.innerHTML = grouped.size ? [...grouped.entries()].map(([group, items]) => `<details class="audience-picker__group" open><summary class="audience-picker__group-title">${chevronIcon}<span class="audience-picker__group-name">${esc(group)}</span><span class="audience-picker__group-count">${items.length}</span></summary><div class="audience-picker__group-items">${items.map(row => `<label class="audience-picker__row"><input type="checkbox" ${state.selected.has(row.resourceName) ? 'checked' : ''} onchange="toggleAudienceCatalogResource(${jsArg(row.resourceName)}, this.checked)"><span><strong>${esc(row.name || row.id || row.resourceName)}</strong><span>${esc(row.category || row.description || audienceTypeLabel(audienceCatalogType(row)))}</span></span></label>`).join('')}</div></details>`).join('') : `<div class="audience-empty">${state.query ? 'No supported segments match this search.' : 'No supported segments are available at this level.'}</div>`;
    const selectedRows = [...state.selected].map(resourceName => {
        const catalog = (currentAudienceData()?.catalog || []).find(row => row.resourceName === resourceName);
        const current = state.current.get(resourceName);
        return catalog || (current ? { resourceName, name: current.name, audienceType: current.criterionType, category: current.category } : { resourceName, name: resourceName, audienceType: '' });
    });
    selected.innerHTML = selectedRows.length ? selectedRows.map(row => `<div class="audience-picker__selected-row"><div><strong>${esc(row.name || row.resourceName)}</strong><span>${esc(audienceTypeLabel(audienceCatalogType(row)))}</span></div><button type="button" onclick="toggleAudienceCatalogResource(${jsArg(row.resourceName)}, false)" aria-label="Remove ${esc(row.name || 'segment')}">×</button></div>`).join('') : '<div class="audience-empty">No segments selected.</div>';
    const count = document.getElementById('audienceSelectedCount');
    if (count) count.textContent = String(state.selected.size);
}

function toggleAudienceCatalogResource(resourceName, checked) {
    if (!audienceEditorState) return;
    if (checked) audienceEditorState.selected.add(resourceName);
    else audienceEditorState.selected.delete(resourceName);
    renderAudiencePickerContents();
}

function reviewAudienceEditorChanges() {
    const state = audienceEditorState;
    if (!state || !state.ownerId) return showToast('Choose a campaign or ad group first.', true);
    const owner = audienceOwnerDetails(state.scope, state.ownerId);
    if (!owner) return showToast('The selected owner is no longer available. Refresh and try again.', true);
    const changes = [];
    for (const resourceName of state.selected) {
        if (state.current.has(resourceName)) continue;
        const catalog = (currentAudienceData()?.catalog || []).find(row => row.resourceName === resourceName);
        if (!catalog) return showToast('A selected segment is no longer in the account catalog. Refresh and try again.', true);
        changes.push({ action: 'add_segment', scope: state.scope, campaignId: owner.campaignId, adGroupId: owner.adGroupId, criterionType: audienceCatalogType(catalog), audienceResourceName: resourceName, negative: state.negative });
    }
    for (const [resourceName, row] of state.current) {
        if (!state.selected.has(resourceName)) changes.push(audienceRemovalChange(row));
    }
    if (!state.negative && !state.currentMode?.inherited) {
        const modeChanged = state.currentMode?.mode !== state.mode;
        const shouldMakeImplicitModeExplicit = state.currentMode?.implicit && changes.some(change => change.action === 'add_segment');
        if (modeChanged || shouldMakeImplicitModeExplicit) {
            changes.unshift({ action: 'set_targeting_mode', scope: state.scope, campaignId: owner.campaignId, adGroupId: owner.adGroupId, mode: state.mode });
        }
    }
    if (!changes.length) return showToast('There are no audience changes to review.', true);
    const warnings = !state.negative && state.mode === 'TARGETING' ? ['Targeting mode narrows ad delivery to the selected audience segments.'] : [];
    closeAudienceModal();
    previewControlsMutation('audience_changes', changes, state.negative ? 'dashboard audience exclusion edit' : 'dashboard audience segment edit', warnings);
}

function demographicCriteriaForOwner(state = audienceDemographicEditorState) {
    if (!state) return [];
    return (currentAudienceData()?.criteria || []).filter(row => row.scope === state.scope
        && String(state.scope === 'campaign' ? row.campaignId : row.adGroupId) === String(state.ownerId)
        && row.negative && Object.values(AUDIENCE_DIMENSIONS).some(dimension => dimension.criterionType === row.criterionType));
}

function initializeDemographicEditorOwner(ownerId) {
    if (!audienceDemographicEditorState) return;
    const state = audienceDemographicEditorState;
    const options = audienceOwnerOptions(state.scope);
    const requested = options.find(row => String(audienceOwnerIdFromRow(state.scope, row)) === String(ownerId));
    const selected = requested || options[0] || null;
    state.ownerId = selected ? String(audienceOwnerIdFromRow(state.scope, selected)) : '';
    const negatives = demographicCriteriaForOwner(state);
    state.included = {};
    state.originalIncluded = {};
    for (const [key, dimension] of Object.entries(AUDIENCE_DIMENSIONS)) {
        const excluded = new Set(negatives.filter(row => row.criterionType === dimension.criterionType).map(row => row.demographicValue));
        const included = dimension.values.filter(value => !excluded.has(value));
        state.included[key] = new Set(included);
        state.originalIncluded[key] = [...included];
    }
}

function openDemographicsModal(options = {}) {
    if (!currentAudienceData()) return showToast('Audience data is still loading. Try again in a moment.', true);
    const preferredScope = options.scope === 'campaign' || options.scope === 'ad_group'
        ? options.scope
        : (audienceOwnerOptions('ad_group').length ? 'ad_group' : 'campaign');
    audienceDemographicEditorState = { scope: preferredScope, ownerId: '', included: {}, originalIncluded: {} };
    initializeDemographicEditorOwner(options.ownerId);
    renderDemographicsModal();
}

function demographicOwnerOptionsHtml() {
    const state = audienceDemographicEditorState;
    return audienceOwnerOptions(state.scope).map(row => {
        const id = audienceOwnerIdFromRow(state.scope, row);
        const label = state.scope === 'ad_group' ? `${row.campaign} / ${row.adGroup}` : row.campaign;
        return `<option value="${esc(id)}"${String(id) === String(state.ownerId) ? ' selected' : ''}>${esc(label)}</option>`;
    }).join('');
}

function renderDemographicsModal() {
    const state = audienceDemographicEditorState;
    if (!state) return;
    document.getElementById('audienceManagementModal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'audienceManagementModal';
    modal.className = 'modal-overlay show';
    const noOwners = audienceOwnerOptions(state.scope).length === 0;
    const columns = Object.entries(AUDIENCE_DIMENSIONS).map(([key, dimension]) => `<section class="audience-demographic-column"><h4>${esc(dimension.label)}</h4>${dimension.values.map(value => `<label><input type="checkbox" ${state.included[key]?.has(value) ? 'checked' : ''} onchange="toggleDemographicValue(${jsArg(key)}, ${jsArg(value)}, this.checked)"><span>${esc(audienceDemographicValueLabel(value))}</span></label>`).join('')}</section>`).join('');
    modal.innerHTML = `<div class="modal-content-card audience-modal">
        <div class="modal-header"><h3>Edit demographics</h3><button class="modal-close-btn" type="button" onclick="closeAudienceModal()" aria-label="Close demographic editor">×</button></div>
        <div class="modal-body"><div class="audience-modal__intro"><strong>Choose who can see ads at this exact level</strong><p>Unchecked groups become explicit exclusions. “Unknown” is kept visible because excluding it can remove a large amount of otherwise eligible traffic.</p><div class="audience-modal__selectors"><label>Level<select onchange="setDemographicEditorScope(this.value)"><option value="campaign"${state.scope === 'campaign' ? ' selected' : ''}>Campaign</option><option value="ad_group"${state.scope === 'ad_group' ? ' selected' : ''}>Ad group</option></select></label><label>${state.scope === 'campaign' ? 'Campaign' : 'Campaign / ad group'}<select onchange="setDemographicEditorOwner(this.value)"${noOwners ? ' disabled' : ''}>${demographicOwnerOptionsHtml()}</select></label></div></div>
        ${noOwners ? '<div class="audience-empty">No eligible owner is available in this account view.</div>' : `<div class="audience-demographic-grid">${columns}</div><div class="audience-warning">Household income targeting is available only in countries supported by Google Ads. The preview will reject unsupported changes before anything is applied.</div>`}</div>
        <div class="audience-modal__footer"><p>Review compares these choices with the latest Google Ads criteria and skips unchanged dimensions.</p><div class="audience-modal__footer-actions"><button class="btn btn-secondary btn-sm" type="button" onclick="closeAudienceModal()">Cancel</button><button class="btn btn-primary btn-sm" type="button" onclick="reviewDemographicChanges()"${noOwners ? ' disabled' : ''}>Review demographics</button></div></div>
    </div>`;
    document.body.appendChild(modal);
}

function setDemographicEditorScope(value) {
    if (!audienceDemographicEditorState) return;
    audienceDemographicEditorState.scope = value === 'campaign' ? 'campaign' : 'ad_group';
    initializeDemographicEditorOwner('');
    renderDemographicsModal();
}

function setDemographicEditorOwner(value) {
    initializeDemographicEditorOwner(value);
    renderDemographicsModal();
}

function toggleDemographicValue(dimension, value, checked) {
    const set = audienceDemographicEditorState?.included?.[dimension];
    if (!set) return;
    if (checked) set.add(value);
    else set.delete(value);
}

function sameStringSet(left, right) {
    const a = [...left].sort();
    const b = [...right].sort();
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

function reviewDemographicChanges() {
    const state = audienceDemographicEditorState;
    if (!state?.ownerId) return showToast('Choose a campaign or ad group first.', true);
    const owner = audienceOwnerDetails(state.scope, state.ownerId);
    if (!owner) return showToast('The selected owner is no longer available. Refresh and try again.', true);
    const changes = [];
    const warnings = [];
    for (const [key, dimension] of Object.entries(AUDIENCE_DIMENSIONS)) {
        const included = [...state.included[key]];
        if (sameStringSet(included, state.originalIncluded[key])) continue;
        if (!included.length) warnings.push(`All ${dimension.label.toLowerCase()} groups will be excluded.`);
        changes.push({ action: 'set_demographics', scope: state.scope, campaignId: owner.campaignId, adGroupId: owner.adGroupId, dimension: dimension.criterionType, includedValues: included });
    }
    if (!changes.length) return showToast('There are no demographic changes to review.', true);
    closeAudienceModal();
    previewControlsMutation('audience_changes', changes, 'dashboard demographic edit', warnings);
}

function openAudienceBidModal(resourceName) {
    const row = (currentAudienceData()?.criteria || []).find(item => item.resourceName === resourceName && !item.negative);
    if (!row) return showToast('That audience segment is no longer available. Refresh and try again.', true);
    document.getElementById('audienceManagementModal')?.remove();
    const modifier = Number.isFinite(Number(row.bidModifier)) ? Number(row.bidModifier) : 1;
    const adjustment = Math.round((modifier - 1) * 100);
    const modal = document.createElement('div');
    modal.id = 'audienceManagementModal';
    modal.className = 'modal-overlay show';
    modal.innerHTML = `<div class="modal-content-card audience-modal" style="max-width:560px"><div class="modal-header"><h3>Change bid adjustment</h3><button class="modal-close-btn" type="button" onclick="closeAudienceModal()" aria-label="Close bid editor">×</button></div><form onsubmit="reviewAudienceBidChange(event, ${jsArg(resourceName)})"><div class="modal-body"><div class="audience-modal__intro"><strong>${esc(row.name)}</strong><p>${esc(audienceOwnerLabel(row.scope, row.scope === 'campaign' ? row.campaignId : row.adGroupId))} · Current: ${esc(formatAudienceBidModifier(row.bidModifier))}</p></div><div class="audience-custom-grid"><label class="audience-custom-field audience-custom-field--wide">Bid adjustment (%)<input id="audienceBidAdjustment" type="number" min="-90" max="900" step="1" value="${esc(adjustment)}" required><span class="audience-custom-hint">Enter -90 to +900. This changes the audience criterion bid multiplier; it does not change the campaign budget.</span></label></div></div><div class="audience-modal__footer"><p>The latest criterion is rechecked during preview and again before Apply.</p><div class="audience-modal__footer-actions"><button class="btn btn-secondary btn-sm" type="button" onclick="closeAudienceModal()">Cancel</button><button class="btn btn-primary btn-sm" type="submit">Review bid change</button></div></div></form></div>`;
    document.body.appendChild(modal);
}

function reviewAudienceBidChange(event, resourceName) {
    event.preventDefault();
    const row = (currentAudienceData()?.criteria || []).find(item => item.resourceName === resourceName && !item.negative);
    const adjustment = Number(document.getElementById('audienceBidAdjustment')?.value);
    if (!row) return showToast('That audience segment is no longer available. Refresh and try again.', true);
    if (!Number.isFinite(adjustment) || adjustment < -90 || adjustment > 900) return showToast('Bid adjustment must be between -90% and +900%.', true);
    const bidModifier = +(1 + adjustment / 100).toFixed(2);
    const change = {
        action: 'set_bid_modifier', scope: row.scope, campaignId: row.campaignId, adGroupId: row.adGroupId,
        criterionType: row.criterionType, audienceResourceName: row.audienceResourceName,
        criterionResourceName: row.resourceName, bidModifier, negative: false
    };
    closeAudienceModal();
    previewControlsMutation('audience_changes', [change], 'dashboard audience bid adjustment');
}

function openCustomAudienceModal() {
    if (!currentAudienceData()) return showToast('Audience data is still loading. Try again in a moment.', true);
    document.getElementById('audienceManagementModal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'audienceManagementModal';
    modal.className = 'modal-overlay show';
    modal.innerHTML = `<div class="modal-content-card audience-modal"><div class="modal-header"><h3>New custom segment</h3><button class="modal-close-btn" type="button" onclick="closeAudienceModal()" aria-label="Close custom segment editor">×</button></div><form onsubmit="reviewCustomAudienceCreation(event)"><div class="modal-body"><div class="audience-modal__intro"><strong>Create a reusable account-level segment</strong><p>Google Ads requires custom segment creation and campaign/ad-group attachment to be separate operations. After creation, refresh and attach it through Edit audience segments.</p></div><div class="audience-custom-grid">
        <label class="audience-custom-field">Name<input id="customAudienceName" maxlength="255" required placeholder="High-intent SaaS buyers"></label>
        <label class="audience-custom-field">Type<select id="customAudienceType"><option value="AUTO">Auto</option><option value="SEARCH">People who searched for these terms</option></select></label>
        <label class="audience-custom-field audience-custom-field--wide">Description<textarea id="customAudienceDescription" maxlength="10000" placeholder="Optional internal description"></textarea></label>
        <label class="audience-custom-field audience-custom-field--wide">Search interests or keywords<textarea id="customAudienceKeywords" placeholder="One keyword or phrase per line"></textarea><span class="audience-custom-hint">Each keyword can contain up to 10 words and 80 characters.</span></label>
        <label class="audience-custom-field">Websites<textarea id="customAudienceUrls" placeholder="https://example.com\nhttps://another.example"></textarea></label>
        <label class="audience-custom-field">Apps<textarea id="customAudienceApps" placeholder="One app identifier per line"></textarea></label>
        <label class="audience-custom-field audience-custom-field--wide">Place category IDs<textarea id="customAudiencePlaces" placeholder="Optional numeric Google Ads place category IDs, one per line"></textarea></label>
        </div></div><div class="audience-modal__footer"><p>At least one keyword, URL, app or place category is required. Duplicates are removed before preview.</p><div class="audience-modal__footer-actions"><button class="btn btn-secondary btn-sm" type="button" onclick="closeAudienceModal()">Cancel</button><button class="btn btn-primary btn-sm" type="submit">Review custom segment</button></div></div></form></div>`;
    document.body.appendChild(modal);
}

function customAudienceLines(id) {
    return String(document.getElementById(id)?.value || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
}

function reviewCustomAudienceCreation(event) {
    event.preventDefault();
    const name = String(document.getElementById('customAudienceName')?.value || '').trim();
    const description = String(document.getElementById('customAudienceDescription')?.value || '').trim();
    const customAudienceType = document.getElementById('customAudienceType')?.value || 'AUTO';
    const members = [
        ...customAudienceLines('customAudienceKeywords').map(keyword => ({ memberType: 'KEYWORD', keyword })),
        ...customAudienceLines('customAudienceUrls').map(url => ({ memberType: 'URL', url })),
        ...customAudienceLines('customAudienceApps').map(app => ({ memberType: 'APP', app })),
        ...customAudienceLines('customAudiencePlaces').map(placeCategory => ({ memberType: 'PLACE_CATEGORY', placeCategory }))
    ];
    if (!name) return showToast('Enter a custom segment name.', true);
    if (!members.length) return showToast('Add at least one keyword, website, app or place category.', true);
    closeAudienceModal();
    previewControlsMutation('audience_changes', [{ action: 'create_custom_audience', name, description, customAudienceType, members }], 'dashboard custom audience creation');
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
    init().catch(err => {
        console.error('Dashboard boot failed:', err);
        if (err?.pendingLogout) {
            showOfflineSignedOut();
            return;
        }
        finishAppBootstrap('Could not open the dashboard. Check your connection and try again.');
        if (els?.kpiGrid) {
            els.kpiGrid.innerHTML = `<p style="color:var(--danger)">Error loading dashboard: ${esc(err.message || String(err))}</p>`;
        }
    });
});
