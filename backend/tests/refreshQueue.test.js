import { describe, expect, test } from 'bun:test';
import {
    claimNextRefreshJob,
    enqueueRefreshJob,
    ensureRefreshQueueSchema,
    PostgresRefreshQueueWorker,
    recoverStaleRefreshJobs
} from '../lib/refreshQueue.ts';

function row(overrides = {}) {
    return {
        id: 'warehouse_test',
        status: 'queued',
        requested_start_date: '2026-01-01',
        requested_end_date: new Date('2026-01-31T00:00:00.000Z'),
        force: true,
        source: 'api',
        attempts: 0,
        max_attempts: 2,
        locked_by: null,
        heartbeat_at: null,
        started_at: null,
        completed_at: null,
        last_error: null,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-01T00:00:00.000Z'),
        ...overrides
    };
}

describe('Postgres refresh queue', () => {
    test('schema creates durable refresh job state keyed to warehouse refresh runs', async () => {
        let sql = '';
        const pool = {
            async query(query) {
                sql += String(query);
                return { rows: [] };
            }
        };

        await ensureRefreshQueueSchema(pool);

        expect(sql).toContain('CREATE TABLE IF NOT EXISTS google_ads_refresh_jobs');
        expect(sql).toContain("status IN ('queued', 'running', 'succeeded', 'failed')");
        expect(sql).toContain('REFERENCES google_ads_refresh_runs(id)');
        expect(sql).toContain('google_ads_refresh_jobs_running_heartbeat_idx');
        expect(sql).toContain('google_ads_refresh_jobs_source_created_idx');
    });

    test('enqueue persists dates, force flag, source, and max attempts', async () => {
        const queries = [];
        const pool = {
            async query(sql, params) {
                queries.push({ sql: String(sql), params });
                return { rows: [row({ id: params[0], requested_start_date: params[1], requested_end_date: params[2], force: params[3], source: params[4], max_attempts: params[5] })] };
            }
        };

        const job = await enqueueRefreshJob(pool, {
            id: 'warehouse_1',
            requestedStartDate: '2026-01-01',
            requestedEndDate: '2026-01-31',
            force: true,
            source: 'mcp',
            maxAttempts: 3
        });

        expect(queries[0].sql).toContain('INSERT INTO google_ads_refresh_jobs');
        expect(queries[0].params).toEqual(['warehouse_1', '2026-01-01', '2026-01-31', true, 'mcp', 3]);
        expect(job).toMatchObject({
            id: 'warehouse_1',
            requestedStartDate: '2026-01-01',
            requestedEndDate: '2026-01-31',
            force: true,
            source: 'mcp',
            maxAttempts: 3
        });
    });

    test('claim uses row locking and marks the job running for one worker', async () => {
        const queries = [];
        const pool = {
            async query(sql, params) {
                queries.push({ sql: String(sql), params });
                return { rows: [row({ status: 'running', attempts: 1, locked_by: params[0], heartbeat_at: new Date('2026-01-01T00:00:00.000Z') })] };
            }
        };

        const job = await claimNextRefreshJob(pool, 'worker-1');

        expect(queries[0].sql).toContain('FOR UPDATE SKIP LOCKED');
        expect(queries[0].sql).toContain("SET status = 'running'");
        expect(queries[0].sql).toContain('attempts = job.attempts + 1');
        expect(job).toMatchObject({ status: 'running', attempts: 1, lockedBy: 'worker-1' });
    });

    test('stale recovery locks rows, requeues retryable jobs, marks completed jobs, and fails exhausted jobs', async () => {
        const pool = {
            async query(sql, params) {
                const text = String(sql);
                expect(text).toContain('job.heartbeat_at < CURRENT_TIMESTAMP');
                expect(text).toContain('LEFT JOIN google_ads_refresh_runs');
                expect(text).toContain("run.status IN ('succeeded', 'partial')");
                expect(text).toContain('FOR UPDATE OF job SKIP LOCKED');
                expect(params).toEqual([60000]);
                return {
                    rows: [
                        { ...row({ id: 'warehouse_retry', status: 'queued', next_status: 'queued', last_error: 'heartbeat expired' }) },
                        { ...row({ id: 'warehouse_done', status: 'succeeded', next_status: 'succeeded', attempts: 1, last_error: null }) },
                        { ...row({ id: 'warehouse_failed', status: 'failed', next_status: 'failed', attempts: 2, last_error: 'max attempts exhausted' }) }
                    ]
                };
            }
        };

        const recovered = await recoverStaleRefreshJobs(pool, 60000);

        expect(recovered.map(item => [item.id, item.recoveryAction])).toEqual([
            ['warehouse_retry', 'requeued'],
            ['warehouse_done', 'succeeded'],
            ['warehouse_failed', 'failed']
        ]);
    });

    test('worker starts immediately after start/poke and uses polling only as backup', async () => {
        let claimCount = 0;
        let ran = false;
        const pool = {
            async query(sql) {
                const text = String(sql);
                if (text.includes('CREATE TABLE IF NOT EXISTS google_ads_refresh_jobs')) return { rows: [] };
                if (text.includes('WITH stale AS')) return { rows: [] };
                if (text.includes('WITH next_job')) {
                    claimCount++;
                    return claimCount === 1
                        ? { rows: [row({ status: 'running', attempts: 1, locked_by: 'worker-test' })] }
                        : { rows: [] };
                }
                if (text.includes("SET status = 'succeeded'")) return { rowCount: 1, rows: [] };
                throw new Error(`Unexpected query: ${text}`);
            }
        };
        const worker = new PostgresRefreshQueueWorker({
            pool,
            workerId: 'worker-test',
            pollIntervalMs: 60_000,
            heartbeatIntervalMs: 60_000,
            staleAfterMs: 60_000,
            logger: { log() {}, warn() {}, error() {} },
            runJob: async () => {
                ran = true;
            }
        });

        await worker.start();
        await new Promise(resolve => setTimeout(resolve, 25));
        worker.stop();

        expect(ran).toBe(true);
        expect(claimCount).toBeGreaterThanOrEqual(2);
    });

    test('worker skips success callback when completion loses the queue lease', async () => {
        let claimCount = 0;
        let successCalled = false;
        const warnings = [];
        const pool = {
            async query(sql) {
                const text = String(sql);
                if (text.includes('CREATE TABLE IF NOT EXISTS google_ads_refresh_jobs')) return { rows: [] };
                if (text.includes('WITH stale AS')) return { rows: [] };
                if (text.includes('WITH next_job')) {
                    claimCount++;
                    return claimCount === 1
                        ? { rows: [row({ status: 'running', attempts: 1, locked_by: 'worker-test' })] }
                        : { rows: [] };
                }
                if (text.includes("SET status = 'succeeded'")) return { rowCount: 0, rows: [] };
                throw new Error(`Unexpected query: ${text}`);
            }
        };
        const worker = new PostgresRefreshQueueWorker({
            pool,
            workerId: 'worker-test',
            pollIntervalMs: 60_000,
            heartbeatIntervalMs: 60_000,
            staleAfterMs: 60_000,
            logger: { log() {}, warn(message) { warnings.push(String(message)); }, error() {} },
            runJob: async () => {},
            onJobSuccess: () => {
                successCalled = true;
            }
        });

        await worker.start();
        await new Promise(resolve => setTimeout(resolve, 25));
        worker.stop();

        expect(successCalled).toBe(false);
        expect(warnings.some(message => message.includes('worker lease was lost'))).toBe(true);
    });

    test('worker skips failure callback when failure update loses the queue lease', async () => {
        let claimCount = 0;
        let failureCalled = false;
        const warnings = [];
        const pool = {
            async query(sql) {
                const text = String(sql);
                if (text.includes('CREATE TABLE IF NOT EXISTS google_ads_refresh_jobs')) return { rows: [] };
                if (text.includes('WITH stale AS')) return { rows: [] };
                if (text.includes('WITH next_job')) {
                    claimCount++;
                    return claimCount === 1
                        ? { rows: [row({ status: 'running', attempts: 1, locked_by: 'worker-test' })] }
                        : { rows: [] };
                }
                if (text.includes("SET status = 'failed'")) return { rowCount: 0, rows: [] };
                throw new Error(`Unexpected query: ${text}`);
            }
        };
        const worker = new PostgresRefreshQueueWorker({
            pool,
            workerId: 'worker-test',
            pollIntervalMs: 60_000,
            heartbeatIntervalMs: 60_000,
            staleAfterMs: 60_000,
            logger: { log() {}, warn(message) { warnings.push(String(message)); }, error() {} },
            runJob: async () => {
                throw new Error('refresh failed');
            },
            onJobFailure: () => {
                failureCalled = true;
            }
        });

        await worker.start();
        await new Promise(resolve => setTimeout(resolve, 25));
        worker.stop();

        expect(failureCalled).toBe(false);
        expect(warnings.some(message => message.includes('worker lease was lost'))).toBe(true);
    });

    test('worker isolates success callback errors and continues draining queued jobs', async () => {
        let claimCount = 0;
        const ran = [];
        const warnings = [];
        const pool = {
            async query(sql) {
                const text = String(sql);
                if (text.includes('CREATE TABLE IF NOT EXISTS google_ads_refresh_jobs')) return { rows: [] };
                if (text.includes('WITH stale AS')) return { rows: [] };
                if (text.includes('WITH next_job')) {
                    claimCount++;
                    if (claimCount === 1) return { rows: [row({ id: 'warehouse_1', status: 'running', attempts: 1, locked_by: 'worker-test' })] };
                    if (claimCount === 2) return { rows: [row({ id: 'warehouse_2', status: 'running', attempts: 1, locked_by: 'worker-test' })] };
                    return { rows: [] };
                }
                if (text.includes("SET status = 'succeeded'")) return { rowCount: 1, rows: [] };
                throw new Error(`Unexpected query: ${text}`);
            }
        };
        const worker = new PostgresRefreshQueueWorker({
            pool,
            workerId: 'worker-test',
            pollIntervalMs: 60_000,
            heartbeatIntervalMs: 60_000,
            staleAfterMs: 60_000,
            logger: { log() {}, warn(message) { warnings.push(String(message)); }, error() {} },
            runJob: async job => {
                ran.push(job.id);
            },
            onJobSuccess: () => {
                throw new Error('cache clear failed');
            }
        });

        await worker.start();
        await new Promise(resolve => setTimeout(resolve, 25));
        worker.stop();

        expect(ran).toEqual(['warehouse_1', 'warehouse_2']);
        expect(warnings.filter(message => message.includes('success callback failed')).length).toBe(2);
    });

    test('worker isolates failure callback errors and continues draining queued jobs', async () => {
        let claimCount = 0;
        const ran = [];
        const errors = [];
        const pool = {
            async query(sql) {
                const text = String(sql);
                if (text.includes('CREATE TABLE IF NOT EXISTS google_ads_refresh_jobs')) return { rows: [] };
                if (text.includes('WITH stale AS')) return { rows: [] };
                if (text.includes('WITH next_job')) {
                    claimCount++;
                    if (claimCount === 1) return { rows: [row({ id: 'warehouse_1', status: 'running', attempts: 1, locked_by: 'worker-test' })] };
                    if (claimCount === 2) return { rows: [row({ id: 'warehouse_2', status: 'running', attempts: 1, locked_by: 'worker-test' })] };
                    return { rows: [] };
                }
                if (text.includes("SET status = 'failed'")) return { rowCount: 1, rows: [] };
                if (text.includes("SET status = 'succeeded'")) return { rowCount: 1, rows: [] };
                throw new Error(`Unexpected query: ${text}`);
            }
        };
        const worker = new PostgresRefreshQueueWorker({
            pool,
            workerId: 'worker-test',
            pollIntervalMs: 60_000,
            heartbeatIntervalMs: 60_000,
            staleAfterMs: 60_000,
            logger: { log() {}, warn() {}, error(message) { errors.push(String(message)); } },
            runJob: async job => {
                ran.push(job.id);
                if (job.id === 'warehouse_1') throw new Error('refresh failed');
            },
            onJobFailure: () => {
                throw new Error('failure marker failed');
            }
        });

        await worker.start();
        await new Promise(resolve => setTimeout(resolve, 25));
        worker.stop();

        expect(ran).toEqual(['warehouse_1', 'warehouse_2']);
        expect(errors.some(message => message.includes('failure callback failed'))).toBe(true);
    });
});
