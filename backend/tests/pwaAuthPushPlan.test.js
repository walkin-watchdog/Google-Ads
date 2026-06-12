import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { createMcpToolRegistry } from '../lib/mcp/toolRegistry.ts';
import { migrationIds } from '../lib/migrations.ts';

const root = path.join(import.meta.dir, '..');

describe('dashboard PWA/auth/push plan coverage', () => {
    test('adds ledgered named-user and push-outbox migrations after existing auth', () => {
        const ids = migrationIds();
        expect(ids).toContain('202607100001_dashboard_named_users');
        expect(ids).toContain('202607100002_dashboard_push_outbox');
        expect(ids).toContain('202607100003_dashboard_pwa_hardening');
        expect(ids.indexOf('202607100001_dashboard_named_users')).toBeGreaterThan(ids.indexOf('202607050004_dashboard_auth'));
        expect(ids.indexOf('202607100002_dashboard_push_outbox')).toBeGreaterThan(ids.indexOf('202607100001_dashboard_named_users'));
        expect(ids.indexOf('202607100003_dashboard_pwa_hardening')).toBeGreaterThan(ids.indexOf('202607100002_dashboard_push_outbox'));
    });

    test('registers named-user MCP admin tools without changing magic-link tool', () => {
        const registry = createMcpToolRegistry({
            pool: {},
            getDashboardPayload: async () => ({}),
            startRefreshJob: async () => ({}),
            assertSemanticMemoryAvailable: () => undefined
        });
        for (const name of [
            'create_dashboard_magic_link',
            'create_dashboard_user',
            'list_dashboard_users',
            'resend_dashboard_user_invitation',
            'disable_dashboard_user',
            'enable_dashboard_user',
            'revoke_dashboard_user_sessions'
        ]) {
            expect(registry.has(name)).toBe(true);
        }
        expect(registry.get('create_dashboard_user').requiredScopes).toEqual(['mcp:admin']);
        expect(registry.get('disable_dashboard_user').requiredScopes).toEqual(['mcp:admin']);
    });

    test('dashboard shell uses local assets and declares PWA metadata', () => {
        const html = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');
        const app = fs.readFileSync(path.join(root, 'client', 'app.js'), 'utf8');
        expect(html).not.toContain('rel="manifest"');
        expect(app).toContain("manifest.href = 'manifest.webmanifest'");
        expect(app).toContain('const hostedCookieMode = !isFileMode && !explicitHttpClientMode;');
        expect(html).toContain('src="vendor/chart.umd.min.js"');
        expect(html).toContain('href="fonts/fonts.css"');
        expect(html).toContain('src="offline.js?v=1"');
        expect(html).toContain('class="app-booting"');
        expect(html).toContain('id="appBootstrap"');
        const setupControlsIndex = app.indexOf('    setupControls();', app.indexOf('async function init()'));
        const finishBootstrapIndex = app.indexOf('    finishAppBootstrap();', setupControlsIndex);
        expect(setupControlsIndex).toBeGreaterThan(-1);
        expect(finishBootstrapIndex).toBeGreaterThan(setupControlsIndex);
        expect(html).not.toMatch(/(?:src|href)="\/(?:app\.js|config\.js|offline\.js|styles\.css|manifest\.webmanifest|vendor\/|fonts\/|icons\/)/);
        expect(html).not.toContain('cdn.jsdelivr.net');
        expect(html).not.toContain('fonts.googleapis.com');
        expect(html).not.toContain('fonts.gstatic.com');
    });

    test('file-opened dashboard shell resolves every local asset beside index.html', () => {
        const clientRoot = path.join(root, 'client');
        const html = fs.readFileSync(path.join(clientRoot, 'index.html'), 'utf8');
        const assetReferences = [...html.matchAll(/(?:src|href)="([^"#?]+)"/g)]
            .map(match => match[1])
            .filter(reference => !reference.includes('://') && !reference.startsWith('data:'));

        expect(assetReferences.length).toBeGreaterThan(0);
        for (const reference of assetReferences) {
            expect(fs.existsSync(path.resolve(clientRoot, reference))).toBe(true);
        }

        const fonts = fs.readFileSync(path.join(clientRoot, 'fonts', 'fonts.css'), 'utf8');
        expect(fonts).toContain("url('./");
        expect(fonts).not.toContain("url('/fonts/");
    });

    test('service worker caches public shell assets and bypasses private endpoints', () => {
        const sw = fs.readFileSync(path.join(root, 'client', 'sw.js'), 'utf8');
        const app = fs.readFileSync(path.join(root, 'client', 'app.js'), 'utf8');
        const html = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');
        expect(sw).toContain("url.pathname.startsWith('/api/')");
        expect(sw).toContain("url.pathname.startsWith('/auth/')");
        expect(sw).toContain("url.pathname === '/login'");
        expect(sw).toContain("url.pathname === '/forgot-password'");
        expect(sw).toContain("url.searchParams.has('token')");
        expect(sw).toContain("if (url.pathname === '/' && response.ok");
        expect(sw).toContain('parsed.origin !== self.location.origin');
        expect(sw).toContain("self.registration.showNotification");
        expect(sw).toContain("notificationclick");
        expect(sw).toContain('SKIP_WAITING');
        expect(sw).not.toContain('await self.skipWaiting()');
        expect(sw).toContain('function precacheShellAssets');
        expect(sw).toContain('await Promise.all(urls.map(async url =>');
        expect(sw).not.toContain('cache.addAll(SHELL_URLS)');
        expect(sw).not.toContain("'/config.js'");
        expect(sw.indexOf('const response = await fetch(request)')).toBeLessThan(sw.indexOf('await caches.match(request)'));
        expect(app).toContain("updateViaCache: 'none'");
        const initSource = app.slice(app.indexOf('async function init()'), app.indexOf('\nfunction setupKeywordDiscoveryTabs'));
        expect(app).toContain('void registerServiceWorker();');
        expect(initSource).not.toContain('await registerServiceWorker();');
        expect(app).toContain('SERVICE_WORKER_REGISTRATION_TIMEOUT_MS');
        expect(app).toContain('DASHBOARD_REQUEST_TIMEOUT_MS');
        expect(app).toContain('OFFLINE_BOOTSTRAP_TIMEOUT_MS');
        expect(app).toContain('if (pendingLogoutBlocked)');
        expect(app).toContain("'Offline storage initialization timed out.'");
        expect(app).toContain('fetchWithTimeout(`${apiBase}/api/auth/session`');
        expect(app).toContain("'Push detachment timed out.'");
        expect(app).toContain("await ensureDashboardViewForTab('attribution', { render: false }).catch");
        expect(app).toContain('showServiceWorkerUpdate(registration.waiting)');
        expect(app).toContain("waitingServiceWorker.postMessage({ type: 'SKIP_WAITING' })");
        const server = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');
        expect(server).toContain('const publicAssetFiles = {');
        expect(server).not.toContain("app.use('/vendor', express.static");
        expect(server).toContain("worker-src 'self'; manifest-src 'self'; object-src 'none'");
        expect(html).toContain('id="updateBanner"');
        expect(html).toContain('id="applyUpdateBtn"');
    });

    test('host-only PWA features stay disabled for direct file access', () => {
        const app = fs.readFileSync(path.join(root, 'client', 'app.js'), 'utf8');
        expect(app).toContain("!['http:', 'https:'].includes(window.location.protocol)");
        expect(app).toContain('function installWebManifest()');
    });

    test('hidden UI remains hidden and generated scripts do not request absent source maps', () => {
        const styles = fs.readFileSync(path.join(root, 'client', 'styles.css'), 'utf8');
        expect(styles).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s);
        for (const name of fs.readdirSync(path.join(root, 'client', 'vendor')).filter(name => name.endsWith('.js'))) {
            expect(fs.readFileSync(path.join(root, 'client', 'vendor', name), 'utf8')).not.toMatch(/sourceMappingURL=/);
        }
    });

    test('mobile shell gives sticky controls a surface and uses a compact date modal', () => {
        const styles = fs.readFileSync(path.join(root, 'client', 'styles.css'), 'utf8');
        const app = fs.readFileSync(path.join(root, 'client', 'app.js'), 'utf8');
        const html = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');
        expect(styles).toContain('body.date-picker-open::before');
        expect(styles).toContain('.daterangepicker.mobile-date-picker-open');
        expect(styles).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
        expect(styles).toContain('background: var(--bg-surface)');
        expect(app).toContain('function bindMobileDatePickerLifecycle');
        expect(app).toContain("picker?.container?.addClass('mobile-date-picker-open')");
        expect(app).toContain("picker?.container?.removeClass('mobile-date-picker-open')");
        expect(app).toContain('bindMobileDatePickerLifecycle(cpPicker)');
        expect(app).toContain('bindMobileDatePickerLifecycle(ppPicker)');
        expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="moreSheetTitle"');
        expect(app).toContain("if (event.key === 'Escape')");
        expect(app).toContain("moreButton?.setAttribute('aria-expanded', 'true')");
    });

    test('keeps the authenticated logout control inside the fixed-height sidebar', () => {
        const styles = fs.readFileSync(path.join(root, 'client', 'styles.css'), 'utf8');

        expect(styles).toMatch(/\.nav-menu\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s);
        expect(styles).toMatch(/\.nav-item\s*\{[^}]*flex:\s*0 0 auto;/s);
        expect(styles).toMatch(/\.sidebar-bottom\s*\{[^}]*flex:\s*0 0 auto;/s);
    });

    test('keyword subtab resizing skips hidden AG Grid instances', () => {
        const app = fs.readFileSync(path.join(root, 'client', 'app.js'), 'utf8');
        const keywordSubtabBody = app.slice(
            app.indexOf('function activateKeywordSubtab('),
            app.indexOf('function setupKeywordDiscoveryTabs(')
        );
        expect(keywordSubtabBody).toContain('Object.entries(gridInstances)');
        expect(keywordSubtabBody).toContain('element.offsetWidth > 0 && element.offsetHeight > 0');
        expect(keywordSubtabBody).not.toContain('Object.values(gridInstances)');
    });

    test('client reconciles push subscriptions and blocks sensitive offline mutations', () => {
        const app = fs.readFileSync(path.join(root, 'client', 'app.js'), 'utf8');
        expect(app).toContain('function reconcilePushSubscription');
        expect(app).toContain('/api/push/subscriptions/status?endpoint=');
        expect(app).toContain('This browser has notifications attached to another dashboard user');
        expect(app).toContain('function requestNotificationPermissionFromGesture');
        expect(app).toContain("cachedPushConfig = auth?.mode === 'user' && auth?.pushConfig ? auth.pushConfig : null");
        expect(app).not.toContain('Tap Enable notifications again when ready.');
        expect(app).toContain('Notification.requestPermission(finish)');
        expect(app).toContain('Permission allowed. Finishing notification setup');
        expect(app).toContain('this device is not subscribed yet');
        expect(app).toContain('This device is still subscribed, but notification permission is blocked.');
        expect(app).toContain("auth?.offline === true || pushEnableInProgress");
        expect(app).toContain("DASHBOARD_AUTH?.offline === true");
        expect(app).toContain('function waitForActiveServiceWorker');
        expect(app).not.toContain('The service worker is not ready. Reload and try again.');
        expect(app).toContain('function pushSubscriptionUsesKey');
        expect(app).toContain('Notification security keys changed. Tap Enable notifications');
        const enableStart = app.indexOf('async function enablePushNotifications');
        const disableStart = app.indexOf('async function disablePushNotifications');
        const enable = app.slice(enableStart, disableStart);
        expect(enable).not.toContain("await dashboardFetch(`${API_BASE_GLOBAL}/api/push/config`)");
        expect(app).toContain('function offlineMutationError');
        expect(app).toContain('Reconnect to use this feature.');
        expect(app).toContain('isOfflineLeadStatusPath');
        expect(app).toContain('detachPrivateContext');
        expect(app).toContain('privateOfflineAccessBlocked');
        expect(app).toContain('clearPendingLogoutMarkers');
        expect(app).toContain('syncOfflineLeadChanges');
        expect(app).toContain('Apply my label anyway');
        expect(app).toContain('Keep server label');
        expect(app).toContain('Nothing will be overwritten until you choose.');
        expect(app).not.toContain('const applyMine = confirm(');
        expect(app).not.toContain('if (offlineSession) {\n                DASHBOARD_AUTH');
    });

    test('Data stays full while desktop, installed-app, and browser reloads request today-only light refresh', () => {
        const app = fs.readFileSync(path.join(root, 'client', 'app.js'), 'utf8');
        const html = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');
        const styles = fs.readFileSync(path.join(root, 'client', 'styles.css'), 'utf8');
        expect(html).toContain('class="header-refresh-actions"');
        expect(html).toContain('class="refresh-header-btn data-refresh-btn"');
        expect(html).toContain('aria-label="Refresh backend data"');
        expect(html).toContain('class="refresh-button-label">Data</span>');
        expect(html).toContain('id="pageReloadBtn"');
        expect(html).toContain('aria-label="Reload app and refresh today\'s data"');
        expect(html).toContain('class="refresh-button-label">App</span>');
        expect(app).not.toContain("if (!API_KEY_GLOBAL && els.refreshBtn)");
        expect(app).toContain("pageReloadBtn?.addEventListener('click'");
        expect(app).toContain('markTodayRefreshAfterReload();');
        expect(app).toContain("navigation?.type === 'reload'");
        expect(app).toContain('requestFullDataRefresh(API_BASE)');
        expect(app).toContain('requestTodayDataRefresh(API_BASE, { force: true })');
        expect(app).toContain('startCronRefreshCompletionWatcher();');
        expect(app).toContain('/api/dashboard/cron-refresh-status');
        expect(app).toContain('window.location.reload()');
        const pollStart = app.indexOf('function pollForRefreshCompletion');
        const acceptedStart = app.indexOf('function handleAcceptedRefresh', pollStart);
        const refreshButtonStart = app.indexOf('if (els.refreshBtn)', acceptedStart);
        const automaticReloadStart = app.indexOf('if (clientReloadRefreshPromise)', refreshButtonStart);
        const initCatchStart = app.indexOf('    } catch (err) {', automaticReloadStart);
        const pollSource = app.slice(pollStart, acceptedStart);
        const acceptedSource = app.slice(acceptedStart, refreshButtonStart);
        const automaticReloadSource = app.slice(automaticReloadStart, initCatchStart);
        expect(pollSource).toContain('automatic = false');
        expect(pollSource).toContain('if (!automatic) showToast(`${refreshLabel} is still running. Check again shortly.`');
        expect(acceptedSource).toContain('if (!automatic) {');
        expect(acceptedSource).toContain('pollForRefreshCompletion(API_BASE, data, button, { todayOnly, automatic })');
        expect(automaticReloadSource).not.toContain('showToast(');
        expect(styles).toContain('.page-reload-btn:not([hidden])');
        expect(styles).toContain('grid-column: 2;');
        expect(styles).toContain('.header-refresh-actions {');
        expect(styles).toContain('.data-refresh-btn {');
        expect(styles).toContain('.header-refresh-actions .refresh-button-label');
        expect(styles).toContain('width: 36px;');
        expect(styles).toContain('border-radius: 999px;');
    });

    test('browser account controls use blocker-neutral routes while legacy routes remain compatible', () => {
        const app = fs.readFileSync(path.join(root, 'client', 'app.js'), 'utf8');
        const server = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');
        expect(app).toContain('/api/account-controls/mutations/preview');
        expect(app).not.toContain('/api/google-ads/mutations/preview');
        expect(server).toContain("'/api/account-controls/mutations/preview'");
        expect(server).toContain("'/api/google-ads/mutations/preview'");
        expect(server).toContain('dashboard_public_hostname_content_blocker_risk');
    });

    test('cookie-authenticated unsafe browser routes use the scoped CSRF middleware', () => {
        const server = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');
        expect(server).toContain("app.get('/', (_req: Request, res: Response)");
        expect(server).not.toContain("app.get('*'");
        expect(server).toContain("app.post('/auth/logout', ...authenticateDashboardMutation");
        expect(server).toContain("app.post('/api/keyword-planner/ideas', ...authenticateDashboardMutation");
        expect(server).toContain("app.post('/api/keyword-planner/historical-metrics', ...authenticateDashboardMutation");
        expect(server).toContain("app.post('/api/webhooks/leads', authenticateLeadWebhook");
        expect(server).toContain("app.post('/api/mcp', async");
    });

    test('login throttling counts failed logins only after password verification', () => {
        const users = fs.readFileSync(path.join(root, 'lib', 'dashboardUsers.ts'), 'utf8');
        const authStart = users.indexOf('export async function authenticateDashboardUser');
        const resetStart = users.indexOf('export async function requestDashboardPasswordReset');
        const auth = users.slice(authStart, resetStart);
        expect(users).toContain('async function assertRateLimitAvailable');
        expect(auth).toContain('assertRateLimitAvailable');
        expect(auth.indexOf('verifyPassword')).toBeLessThan(auth.indexOf('await incrementRateLimit(pool, limit)'));
    });

    test('rejects invalid reset tokens before running expensive Argon2 hashing', () => {
        const users = fs.readFileSync(path.join(root, 'lib', 'dashboardUsers.ts'), 'utf8');
        const consumeStart = users.indexOf('export async function consumeDashboardPasswordToken');
        const consume = users.slice(consumeStart);
        expect(consume.indexOf('const preflight = await pool.query')).toBeLessThan(consume.indexOf('const passwordHash = await hashPassword(password)'));
        expect(consume.indexOf("if (!preflight.rows[0])")).toBeLessThan(consume.indexOf('const passwordHash = await hashPassword(password)'));
    });

    test('lead notification payload stores the persisted notification id', () => {
        const push = fs.readFileSync(path.join(root, 'lib', 'dashboardPush.ts'), 'utf8');
        expect(push).toContain('const payload = { ...parts.payload, notificationId }');
        expect(push).toContain('UPDATE lead_notifications');
        expect(push).toContain('notificationId: delivery.notificationId');
        expect(push).toContain('DEFAULT_PUSH_MAX_ATTEMPTS = 5');
        expect(push).toContain('subscription.user_id <> delivery.user_id');
        expect(push).toContain("delivery.status IN ('queued','running')");
        expect(push).toContain('cleanupDashboardPushRows(this.pool)');
        expect(push).toContain('if (!pushAvailability().available) return');
    });
});
