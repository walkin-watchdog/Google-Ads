import crypto from 'crypto';
import type { Pool } from 'pg';

export type RefreshQueueJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export type RefreshQueueJob = {
    id: string;
    status: RefreshQueueJobStatus;
    requestedStartDate: string | null;
    requestedEndDate: string | null;
    force: boolean;
    source: string | null;
    attempts: number;
    maxAttempts: number;
    lockedBy: string | null;
    heartbeatAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    lastError: string | null;
    createdAt: string | null;
    updatedAt: string | null;
};

export type RefreshQueueRecoveredJob = RefreshQueueJob & {
    recoveryAction: 'requeued' | 'succeeded' | 'failed';
};

export type EnqueueRefreshJobInput = {
    id: string;
    requestedStartDate?: string | null;
    requestedEndDate?: string | null;
    force?: boolean;
    source?: string | null;
    maxAttempts?: number;
};

export type RefreshQueueWorkerCallbacks = {
    runJob: (job: RefreshQueueJob) => Promise<void>;
    onJobSuccess?: (job: RefreshQueueJob) => Promise<void> | void;
    onJobFailure?: (job: RefreshQueueJob, error: Error) => Promise<void> | void;
};

export type RefreshQueueWorkerOptions = RefreshQueueWorkerCallbacks & {
    pool: Pool;
    workerId?: string;
    pollIntervalMs?: number;
    heartbeatIntervalMs?: number;
    staleAfterMs?: number;
    logger?: Pick<Console, 'log' | 'warn' | 'error'>;
};

const DEFAULT_REFRESH_QUEUE_POLL_INTERVAL_MS = 30_000;
const DEFAULT_REFRESH_QUEUE_HEARTBEAT_MS = 15_000;
const DEFAULT_REFRESH_QUEUE_STALE_AFTER_MS = 20 * 60_000;
const DEFAULT_REFRESH_QUEUE_MAX_ATTEMPTS = 2;

function positiveIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name] || fallback);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function timestamp(value: any): string | null {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : String(value);
}

function dateOnly(value: any): string | null {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    const text = String(value);
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : text;
}

function rowToRefreshJob(row: any): RefreshQueueJob {
    return {
        id: String(row.id),
        status: row.status as RefreshQueueJobStatus,
        requestedStartDate: dateOnly(row.requested_start_date),
        requestedEndDate: dateOnly(row.requested_end_date),
        force: row.force === true,
        source: row.source || null,
        attempts: Number(row.attempts || 0),
        maxAttempts: Number(row.max_attempts || DEFAULT_REFRESH_QUEUE_MAX_ATTEMPTS),
        lockedBy: row.locked_by || null,
        heartbeatAt: timestamp(row.heartbeat_at),
        startedAt: timestamp(row.started_at),
        completedAt: timestamp(row.completed_at),
        lastError: row.last_error || null,
        createdAt: timestamp(row.created_at),
        updatedAt: timestamp(row.updated_at)
    };
}

export async function ensureRefreshQueueSchema(pool: Pool): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS google_ads_refresh_jobs (
            id TEXT PRIMARY KEY REFERENCES google_ads_refresh_runs(id) ON DELETE CASCADE,
            status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
            requested_start_date DATE,
            requested_end_date DATE,
            force BOOLEAN NOT NULL DEFAULT false,
            source TEXT,
            attempts INTEGER NOT NULL DEFAULT 0,
            max_attempts INTEGER NOT NULL DEFAULT ${DEFAULT_REFRESH_QUEUE_MAX_ATTEMPTS},
            locked_by TEXT,
            heartbeat_at TIMESTAMP WITH TIME ZONE,
            started_at TIMESTAMP WITH TIME ZONE,
            completed_at TIMESTAMP WITH TIME ZONE,
            last_error TEXT,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS google_ads_refresh_jobs_status_created_idx
            ON google_ads_refresh_jobs(status, created_at ASC);
        CREATE INDEX IF NOT EXISTS google_ads_refresh_jobs_running_heartbeat_idx
            ON google_ads_refresh_jobs(heartbeat_at)
            WHERE status = 'running';
        CREATE INDEX IF NOT EXISTS google_ads_refresh_jobs_source_created_idx
            ON google_ads_refresh_jobs(source, created_at DESC);
    `);
}

export async function enqueueRefreshJob(pool: Pool, input: EnqueueRefreshJobInput): Promise<RefreshQueueJob> {
    const maxAttempts = Number.isFinite(Number(input.maxAttempts)) && Number(input.maxAttempts) > 0
        ? Math.floor(Number(input.maxAttempts))
        : DEFAULT_REFRESH_QUEUE_MAX_ATTEMPTS;
    const { rows } = await pool.query(
        `INSERT INTO google_ads_refresh_jobs
         (id, status, requested_start_date, requested_end_date, force, source, max_attempts)
         VALUES ($1, 'queued', $2, $3, $4, $5, $6)
         RETURNING *`,
        [
            input.id,
            input.requestedStartDate || null,
            input.requestedEndDate || null,
            input.force === true,
            input.source || null,
            maxAttempts
        ]
    );
    return rowToRefreshJob(rows[0]);
}

export async function claimNextRefreshJob(pool: Pool, workerId: string): Promise<RefreshQueueJob | null> {
    const { rows } = await pool.query(
        `WITH next_job AS (
             SELECT id
             FROM google_ads_refresh_jobs
             WHERE status = 'queued'
             ORDER BY created_at ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED
         )
         UPDATE google_ads_refresh_jobs AS job
         SET status = 'running',
             attempts = job.attempts + 1,
             locked_by = $1,
             heartbeat_at = CURRENT_TIMESTAMP,
             started_at = COALESCE(job.started_at, CURRENT_TIMESTAMP),
             completed_at = NULL,
             last_error = NULL,
             updated_at = CURRENT_TIMESTAMP
         FROM next_job
         WHERE job.id = next_job.id
         RETURNING job.*`,
        [workerId]
    );
    return rows[0] ? rowToRefreshJob(rows[0]) : null;
}

export async function heartbeatRefreshJob(pool: Pool, jobId: string, workerId: string): Promise<boolean> {
    const { rowCount } = await pool.query(
        `UPDATE google_ads_refresh_jobs
         SET heartbeat_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
           AND status = 'running'
           AND locked_by = $2`,
        [jobId, workerId]
    );
    return Number(rowCount || 0) > 0;
}

export async function completeRefreshJob(pool: Pool, jobId: string, workerId: string): Promise<boolean> {
    const { rowCount } = await pool.query(
        `UPDATE google_ads_refresh_jobs
         SET status = 'succeeded',
             locked_by = NULL,
             heartbeat_at = NULL,
             completed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
           AND status = 'running'
           AND locked_by = $2`,
        [jobId, workerId]
    );
    return Number(rowCount || 0) > 0;
}

export async function failRefreshJob(pool: Pool, jobId: string, workerId: string, error: Error): Promise<boolean> {
    const { rowCount } = await pool.query(
        `UPDATE google_ads_refresh_jobs
         SET status = 'failed',
             locked_by = NULL,
             heartbeat_at = NULL,
             completed_at = CURRENT_TIMESTAMP,
             last_error = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
           AND status = 'running'
           AND locked_by = $2`,
        [jobId, workerId, error.message]
    );
    return Number(rowCount || 0) > 0;
}

export async function recoverStaleRefreshJobs(pool: Pool, staleAfterMs: number): Promise<RefreshQueueRecoveredJob[]> {
    const { rows } = await pool.query(
        `WITH stale AS (
             SELECT job.id,
                    job.attempts,
                    job.max_attempts,
                    run.status AS run_status,
                    CASE
                        WHEN run.status IN ('succeeded', 'partial') THEN 'succeeded'
                        WHEN job.attempts >= job.max_attempts THEN 'failed'
                        ELSE 'queued'
                    END AS next_status
             FROM google_ads_refresh_jobs AS job
             LEFT JOIN google_ads_refresh_runs AS run ON run.id = job.id
             WHERE job.status = 'running'
               AND job.heartbeat_at < CURRENT_TIMESTAMP - ($1::bigint * INTERVAL '1 millisecond')
             ORDER BY job.heartbeat_at ASC
             FOR UPDATE OF job SKIP LOCKED
         ),
         recovered AS (
             UPDATE google_ads_refresh_jobs AS job
             SET status = stale.next_status,
                 locked_by = NULL,
                 heartbeat_at = NULL,
                 completed_at = CASE WHEN stale.next_status IN ('succeeded', 'failed') THEN CURRENT_TIMESTAMP ELSE NULL END,
                 last_error = CASE
                     WHEN stale.next_status = 'failed'
                         THEN 'Refresh worker heartbeat expired and max attempts were exhausted.'
                     WHEN stale.next_status = 'queued'
                         THEN 'Refresh worker heartbeat expired; job requeued.'
                     ELSE job.last_error
                 END,
                 updated_at = CURRENT_TIMESTAMP
             FROM stale
             WHERE job.id = stale.id
               AND job.status = 'running'
             RETURNING job.*, stale.next_status
         ),
         rerun AS (
             UPDATE google_ads_refresh_runs AS run
             SET status = 'running',
                 effective_start_date = NULL,
                 effective_end_date = NULL,
                 completed_at = NULL,
                 source_summary = '{}'::jsonb,
                 error = NULL
             FROM recovered
             WHERE run.id = recovered.id
               AND recovered.next_status = 'queued'
             RETURNING run.id
         )
         SELECT recovered.* FROM recovered
         LEFT JOIN rerun ON rerun.id = recovered.id`,
        [Math.max(1, Math.floor(staleAfterMs))]
    );
    return rows.map(row => ({
        ...rowToRefreshJob(row),
        recoveryAction: row.next_status === 'failed'
            ? 'failed'
            : row.next_status === 'succeeded'
                ? 'succeeded'
                : 'requeued'
    }));
}

export class PostgresRefreshQueueWorker {
    private readonly pool: Pool;
    private readonly workerId: string;
    private readonly pollIntervalMs: number;
    private readonly heartbeatIntervalMs: number;
    private readonly staleAfterMs: number;
    private readonly runJob: (job: RefreshQueueJob) => Promise<void>;
    private readonly onJobSuccess?: (job: RefreshQueueJob) => Promise<void> | void;
    private readonly onJobFailure?: (job: RefreshQueueJob, error: Error) => Promise<void> | void;
    private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
    private started = false;
    private draining = false;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(options: RefreshQueueWorkerOptions) {
        this.pool = options.pool;
        this.workerId = options.workerId || `refresh-worker-${process.pid}-${crypto.randomUUID()}`;
        this.pollIntervalMs = options.pollIntervalMs || positiveIntegerEnv('REFRESH_QUEUE_POLL_INTERVAL_MS', DEFAULT_REFRESH_QUEUE_POLL_INTERVAL_MS);
        this.heartbeatIntervalMs = options.heartbeatIntervalMs || positiveIntegerEnv('REFRESH_QUEUE_HEARTBEAT_MS', DEFAULT_REFRESH_QUEUE_HEARTBEAT_MS);
        this.staleAfterMs = options.staleAfterMs || positiveIntegerEnv('REFRESH_QUEUE_STALE_AFTER_MS', DEFAULT_REFRESH_QUEUE_STALE_AFTER_MS);
        this.runJob = options.runJob;
        this.onJobSuccess = options.onJobSuccess;
        this.onJobFailure = options.onJobFailure;
        this.logger = options.logger || console;
    }

    async start(): Promise<void> {
        if (this.started) return;
        await ensureRefreshQueueSchema(this.pool);
        this.started = true;
        this.poke();
    }

    stop(): void {
        this.started = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    poke(): void {
        if (!this.started) return;
        this.schedule(0, true);
    }

    private schedule(delayMs: number, force = false): void {
        if (!this.started) return;
        if (this.timer) {
            if (!force) return;
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.drain();
        }, Math.max(0, delayMs));
        const maybeUnref = this.timer as any;
        if (typeof maybeUnref.unref === 'function') maybeUnref.unref();
    }

    private async drain(): Promise<void> {
        if (this.draining) return;
        this.draining = true;
        try {
            await this.recoverStaleJobs();
            while (this.started) {
                const job = await claimNextRefreshJob(this.pool, this.workerId);
                if (!job) break;
                await this.runClaimedJob(job);
            }
        } catch (err: any) {
            this.logger.error('Refresh queue worker error:', err?.message || err);
        } finally {
            this.draining = false;
            if (this.started) this.schedule(this.pollIntervalMs);
        }
    }

    private async recoverStaleJobs(): Promise<void> {
        const recovered = await recoverStaleRefreshJobs(this.pool, this.staleAfterMs);
        for (const job of recovered) {
            if (job.recoveryAction === 'requeued') {
                this.logger.warn(`Refresh job ${job.id} heartbeat expired; requeued.`);
                continue;
            }
            if (job.recoveryAction === 'succeeded') {
                this.logger.warn(`Refresh job ${job.id} heartbeat expired after the warehouse run completed; marked queue job succeeded.`);
                await this.notifyJobSuccess(job);
                continue;
            }
            const error = new Error(job.lastError || 'Refresh worker heartbeat expired and max attempts were exhausted.');
            await this.notifyJobFailure(job, error);
        }
    }

    private async notifyJobSuccess(job: RefreshQueueJob): Promise<void> {
        try {
            await this.onJobSuccess?.(job);
        } catch (err: any) {
            this.logger.warn(`Refresh queue job ${job.id} success callback failed: ${err?.message || err}`);
        }
    }

    private async notifyJobFailure(job: RefreshQueueJob, error: Error): Promise<void> {
        try {
            await this.onJobFailure?.(job, error);
        } catch (err: any) {
            this.logger.error(`Refresh queue job ${job.id} failure callback failed: ${err?.message || err}`);
        }
    }

    private async runClaimedJob(job: RefreshQueueJob): Promise<void> {
        this.logger.log(`Refresh queue job ${job.id} started.`);
        const heartbeat = setInterval(() => {
            heartbeatRefreshJob(this.pool, job.id, this.workerId)
                .catch(err => this.logger.warn(`Refresh job ${job.id} heartbeat failed: ${err?.message || err}`));
        }, this.heartbeatIntervalMs);
        const maybeUnref = heartbeat as any;
        if (typeof maybeUnref.unref === 'function') maybeUnref.unref();

        try {
            await this.runJob(job);
            const completed = await completeRefreshJob(this.pool, job.id, this.workerId);
            if (!completed) {
                this.logger.warn(`Refresh queue job ${job.id} finished after its worker lease was lost; leaving current queue state unchanged.`);
                return;
            }
            await this.notifyJobSuccess(job);
            this.logger.log(`Refresh queue job ${job.id} completed.`);
        } catch (err: any) {
            const error = err instanceof Error ? err : new Error(String(err));
            let failed = false;
            try {
                failed = await failRefreshJob(this.pool, job.id, this.workerId, error);
            } catch (updateErr: any) {
                this.logger.error(`Refresh job ${job.id} failure update failed: ${updateErr?.message || updateErr}`);
            }
            if (!failed) {
                this.logger.warn(`Refresh queue job ${job.id} failed after its worker lease was lost; leaving current queue state unchanged.`);
                return;
            }
            await this.notifyJobFailure(job, error);
            this.logger.error(`Refresh queue job ${job.id} failed: ${error.message}`);
        } finally {
            clearInterval(heartbeat);
        }
    }
}
