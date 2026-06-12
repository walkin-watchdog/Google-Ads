import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';

const startSource = fs.readFileSync(path.join(import.meta.dir, '..', 'scripts', 'start.ts'), 'utf8');

describe('production startup sequencing', () => {
    test('starts the HTTP server before the optional refresh and defers the queue worker', () => {
        const serverSource = fs.readFileSync(path.join(import.meta.dir, '..', 'server.ts'), 'utf8');
        const serverSpawn = startSource.indexOf("child = Bun.spawn(['bun', 'run', 'server.ts']");
        expect(serverSpawn).toBeGreaterThan(-1);
        expect(startSource).toContain("DASHBOARD_ORCHESTRATED_STARTUP: 'true'");
        expect(startSource).not.toContain("scripts/refresh_google_ads_data.ts', '--startup'");
        const listening = serverSource.indexOf('console.log(`Server running on http://localhost:${PORT}`)');
        const backgroundLaunch = serverSource.indexOf('void startBackgroundRefreshAfterServerIsHealthy()');
        const startupRefresh = serverSource.indexOf("scripts/refresh_google_ads_data.ts', '--startup'");
        const queueWorkerStart = serverSource.indexOf('await refreshQueueWorker?.start()', startupRefresh);
        expect(listening).toBeGreaterThan(-1);
        expect(backgroundLaunch).toBeGreaterThan(listening);
        expect(startupRefresh).toBeGreaterThan(-1);
        expect(queueWorkerStart).toBeGreaterThan(startupRefresh);
        expect(serverSource).toContain("envSwitchEnabled('DASHBOARD_ORCHESTRATED_STARTUP', false)");
        expect(serverSource).toContain("startupRefreshChild?.kill('SIGKILL')");
        expect(serverSource).toContain("console.error('startup_refresh_timed_out'");
        expect(serverSource).toContain("process.env.NODE_ENV === 'production' ? 'Database unavailable.'");
    });

    test('forwards termination to the server child', () => {
        expect(startSource).toContain('child.kill(signal)');
        const serverSource = fs.readFileSync(path.join(import.meta.dir, '..', 'server.ts'), 'utf8');
        expect(serverSource).toContain('startupRefreshChild?.kill(signal)');
        expect(serverSource).toContain("process.once('SIGTERM'");
    });
});
