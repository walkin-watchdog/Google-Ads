import crypto from 'crypto';
import type { Pool, PoolClient } from 'pg';
import webPush from 'web-push';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export type PushAvailability = {
    enabled: boolean;
    available: boolean;
    publicKey: string | null;
    reason: string | null;
};

export type DashboardPushConfig = PushAvailability & {
    eligible: boolean;
};

export type PushSubscriptionInput = {
    endpoint: unknown;
    keys: unknown;
    userAgent?: string | null;
};

export type PushDeliveryStatus = 'queued' | 'running' | 'sent' | 'failed' | 'stale';

export type PushDelivery = {
    id: string;
    notificationId: string;
    subscriptionId: string;
    endpoint: string;
    keys: Record<string, string>;
    title: string;
    body: string;
    url: string;
    payload: any;
    attempts: number;
    maxAttempts: number;
};

export type PushSender = (subscription: webPush.PushSubscription, payload: string, options: webPush.RequestOptions) => Promise<any>;

export class DashboardPushValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DashboardPushValidationError';
    }
}

// One initial delivery plus the four Plan.md retry delays (30s, 2m, 5m, 15m).
const DEFAULT_PUSH_MAX_ATTEMPTS = 5;
const DEFAULT_PUSH_POLL_MS = 30_000;
const DEFAULT_PUSH_STALE_MS = 5 * 60_000;
const DEFAULT_PUSH_DELIVERY_TIMEOUT_MS = 20_000;
const PUSH_RETRY_MS = [30_000, 2 * 60_000, 5 * 60_000, 15 * 60_000];
const DEFAULT_CLEANUP_DAYS = 30;
const PUSH_CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;

function envEnabled(): boolean {
    return String(process.env.WEB_PUSH_ENABLED || 'false').trim().toLowerCase() === 'true';
}

function boundedText(value: unknown, max: number): string {
    return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeLeadNotificationText(value: unknown, max: number): string {
    return boundedText(value, max)
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]')
        .replace(/(?:\+?\d[\d\s().-]{6,}\d)/g, '[redacted]');
}

function positiveEnv(name: string, fallback: number): number {
    const value = Number(process.env[name] || fallback);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nowIso(clock: () => Date): string {
    return clock().toISOString();
}

function sanitizeError(err: any): string {
    return boundedText(err?.body || err?.message || String(err || 'Push delivery failed'), 500);
}

function retryAfterMs(err: any, clock: () => Date): number | null {
    const header = err?.headers?.['retry-after'] || err?.headers?.['Retry-After'];
    if (!header) return null;
    const numeric = Number(header);
    if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric * 1000);
    const parsed = new Date(String(header)).getTime();
    if (Number.isFinite(parsed)) return Math.max(0, parsed - clock().getTime());
    return null;
}

export function pushAvailability(): PushAvailability {
    if (!envEnabled()) {
        return { enabled: false, available: false, publicKey: null, reason: 'Push is disabled.' };
    }
    const publicKey = String(process.env.VAPID_PUBLIC_KEY || '').trim();
    const privateKey = String(process.env.VAPID_PRIVATE_KEY || '').trim();
    const subject = String(process.env.VAPID_SUBJECT || '').trim();
    if (!publicKey || !privateKey || !subject) {
        return { enabled: true, available: false, publicKey: null, reason: 'VAPID configuration is incomplete.' };
    }
    try {
        webPush.setVapidDetails(subject, publicKey, privateKey);
    } catch (err: any) {
        return { enabled: true, available: false, publicKey: null, reason: err?.message || 'VAPID configuration is invalid.' };
    }
    return { enabled: true, available: true, publicKey, reason: null };
}

export function dashboardPushConfig(eligible: boolean): DashboardPushConfig {
    const availability = pushAvailability();
    return {
        eligible,
        enabled: availability.enabled,
        available: eligible && availability.available,
        publicKey: eligible ? availability.publicKey : null,
        reason: eligible ? availability.reason : 'Named user login is required for push notifications.'
    };
}

export async function ensureDashboardPushSchema(pool: Pool): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS dashboard_push_subscriptions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES dashboard_users(id) ON DELETE CASCADE,
            endpoint TEXT NOT NULL UNIQUE,
            keys JSONB NOT NULL,
            user_agent TEXT,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_seen_at TIMESTAMP WITH TIME ZONE,
            last_success_at TIMESTAMP WITH TIME ZONE,
            revoked_at TIMESTAMP WITH TIME ZONE
        );
        CREATE INDEX IF NOT EXISTS dashboard_push_subscriptions_user_idx ON dashboard_push_subscriptions(user_id);
        CREATE INDEX IF NOT EXISTS dashboard_push_subscriptions_active_idx
            ON dashboard_push_subscriptions(user_id, updated_at DESC)
            WHERE revoked_at IS NULL;

        CREATE TABLE IF NOT EXISTS lead_notifications (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            session_key VARCHAR(220) NOT NULL UNIQUE,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            url TEXT NOT NULL,
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS lead_notification_deliveries (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            notification_id UUID NOT NULL REFERENCES lead_notifications(id) ON DELETE CASCADE,
            subscription_id UUID NOT NULL REFERENCES dashboard_push_subscriptions(id) ON DELETE CASCADE,
            user_id UUID NOT NULL REFERENCES dashboard_users(id) ON DELETE CASCADE,
            status TEXT NOT NULL CHECK (status IN ('queued','running','sent','failed','stale')),
            attempts INTEGER NOT NULL DEFAULT 0,
            max_attempts INTEGER NOT NULL DEFAULT ${DEFAULT_PUSH_MAX_ATTEMPTS},
            next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            locked_by TEXT,
            locked_at TIMESTAMP WITH TIME ZONE,
            sent_at TIMESTAMP WITH TIME ZONE,
            last_error TEXT,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(notification_id, subscription_id)
        );
        CREATE INDEX IF NOT EXISTS lead_notification_deliveries_due_idx
            ON lead_notification_deliveries(status, next_attempt_at ASC);
        CREATE INDEX IF NOT EXISTS lead_notification_deliveries_running_idx
            ON lead_notification_deliveries(locked_at)
            WHERE status = 'running';
        CREATE INDEX IF NOT EXISTS lead_notification_deliveries_user_idx
            ON lead_notification_deliveries(user_id, created_at DESC);

        ALTER TABLE lead_notification_deliveries
            ALTER COLUMN max_attempts SET DEFAULT ${DEFAULT_PUSH_MAX_ATTEMPTS};
        UPDATE lead_notification_deliveries
        SET max_attempts = ${DEFAULT_PUSH_MAX_ATTEMPTS}
        WHERE max_attempts = 4 AND status IN ('queued','running');
    `);
}

export async function cleanupDashboardPushRows(pool: Pool, retentionDays = DEFAULT_CLEANUP_DAYS): Promise<void> {
    await pool.query(
        `DELETE FROM lead_notification_deliveries
         WHERE status IN ('sent','failed','stale')
           AND updated_at < now() - ($1::int * INTERVAL '1 day')`,
        [retentionDays]
    );
    await pool.query(
        `DELETE FROM dashboard_push_subscriptions
         WHERE revoked_at IS NOT NULL
           AND revoked_at < now() - (($1::int * 2) * INTERVAL '1 day')
           AND NOT EXISTS (
               SELECT 1 FROM lead_notification_deliveries d
               WHERE d.subscription_id = dashboard_push_subscriptions.id
           )`,
        [retentionDays]
    );
}

function validateSubscription(input: PushSubscriptionInput): { endpoint: string; keys: { p256dh: string; auth: string }; userAgent: string | null } {
    const endpoint = validateEndpoint(input.endpoint);
    const keys = input.keys && typeof input.keys === 'object' ? input.keys as Record<string, any> : {};
    const p256dh = String(keys.p256dh || '').trim();
    const auth = String(keys.auth || '').trim();
    if (p256dh.length < 20 || p256dh.length > 500 || auth.length < 10 || auth.length > 200) {
        throw new DashboardPushValidationError('Push subscription keys are invalid.');
    }
    return {
        endpoint,
        keys: { p256dh, auth },
        userAgent: input.userAgent ? boundedText(input.userAgent, 500) : null
    };
}

function validateEndpoint(value: unknown): string {
    const endpoint = String(value || '').trim();
    if (endpoint.length < 20 || endpoint.length > 2048) throw new DashboardPushValidationError('Push endpoint is invalid.');
    let url: URL;
    try {
        url = new URL(endpoint);
    } catch {
        throw new DashboardPushValidationError('Push endpoint is invalid.');
    }
    const isLocalHttp = url.protocol === 'http:' && url.hostname === 'localhost';
    if (url.protocol !== 'https:' && !isLocalHttp) throw new DashboardPushValidationError('Push endpoint must be HTTPS.');
    if (url.username || url.password || url.hash) throw new DashboardPushValidationError('Push endpoint is invalid.');
    return endpoint;
}

export async function pushSubscriptionStatus(pool: Pool, userId: string, endpoint: unknown): Promise<{ subscribed: boolean; belongsToCurrentUser: boolean }> {
    if (!String(endpoint || '').trim()) return { subscribed: false, belongsToCurrentUser: false };
    const text = validateEndpoint(endpoint);
    const { rows } = await pool.query(
        `SELECT user_id, revoked_at FROM dashboard_push_subscriptions WHERE endpoint = $1`,
        [text]
    );
    const row = rows[0];
    if (!row || row.revoked_at) return { subscribed: false, belongsToCurrentUser: false };
    return { subscribed: true, belongsToCurrentUser: String(row.user_id) === userId };
}

export async function upsertPushSubscription(pool: Pool, userId: string, input: PushSubscriptionInput): Promise<{ id: string; enabled: boolean }> {
    const normalized = validateSubscription(input);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `INSERT INTO dashboard_push_subscriptions (user_id, endpoint, keys, user_agent, last_seen_at)
             VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (endpoint) DO UPDATE SET
                 user_id = EXCLUDED.user_id,
                 keys = EXCLUDED.keys,
                 user_agent = EXCLUDED.user_agent,
                 last_seen_at = now(),
                 updated_at = now(),
                 revoked_at = NULL
             RETURNING id`,
            [userId, normalized.endpoint, normalized.keys, normalized.userAgent]
        );
        await client.query(
            `UPDATE lead_notification_deliveries
             SET status = 'stale',
                 locked_by = NULL,
                 locked_at = NULL,
                 last_error = 'Push subscription moved to another dashboard user.',
                 updated_at = now()
             WHERE subscription_id = $1
               AND user_id <> $2
               AND status IN ('queued','running')`,
            [rows[0].id, userId]
        );
        await client.query('COMMIT');
        console.log('dashboard_push_subscription_enabled', { userId, subscriptionId: rows[0].id });
        return { id: rows[0].id, enabled: true };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
}

export async function revokePushSubscription(pool: Pool, userId: string, endpoint: unknown): Promise<{ revoked: boolean }> {
    const text = String(endpoint || '').trim();
    if (!text || text.length > 2048) return { revoked: false };
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rowCount } = await client.query(
            `UPDATE dashboard_push_subscriptions
             SET revoked_at = COALESCE(revoked_at, now()), updated_at = now()
             WHERE user_id = $1 AND endpoint = $2 AND revoked_at IS NULL`,
            [userId, text]
        );
        if (Number(rowCount || 0) > 0) {
            await client.query(
                `UPDATE lead_notification_deliveries delivery
                 SET status = 'stale',
                     locked_by = NULL,
                     locked_at = NULL,
                     last_error = 'Push subscription was revoked.',
                     updated_at = now()
                 FROM dashboard_push_subscriptions subscription
                 WHERE delivery.subscription_id = subscription.id
                   AND subscription.user_id = $1
                   AND subscription.endpoint = $2
                   AND delivery.status IN ('queued','running')`,
                [userId, text]
            );
        }
        await client.query('COMMIT');
        const revoked = Number(rowCount || 0) > 0;
        console.log('dashboard_push_subscription_revoked', { userId, revoked });
        return { revoked };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
}

export function safeNotificationParts(event: { session_key: string; utm_campaign?: string | null; kind?: string | null }): {
    title: string;
    body: string;
    url: string;
    payload: any;
} {
    const campaign = safeLeadNotificationText(event.utm_campaign, 80) || 'Unknown campaign';
    const action = safeLeadNotificationText(event.kind, 80) || 'Lead captured';
    const title = 'New lead received';
    const body = boundedText(`${campaign} · ${action}`, 160);
    const url = `/?tab=attribution&lead=${encodeURIComponent(event.session_key)}`;
    const tag = `lead:${crypto.createHash('sha256').update(event.session_key).digest('hex').slice(0, 24)}`;
    return { title, body, url, payload: { title, body, tag, url } };
}

export async function enqueueLeadNotificationForSession(client: Queryable, event: { session_key: string; utm_campaign?: string | null; kind?: string | null }): Promise<{ notificationId: string | null; deliveryCount: number }> {
    const parts = safeNotificationParts(event);
    const notificationResult = await client.query(
        `INSERT INTO lead_notifications (session_key, title, body, url, payload)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (session_key) DO NOTHING
         RETURNING id`,
        [event.session_key, parts.title, parts.body, parts.url, parts.payload]
    );
    const notificationId = notificationResult.rows[0]?.id || null;
    if (!notificationId) return { notificationId: null, deliveryCount: 0 };
    const payload = { ...parts.payload, notificationId };
    await client.query(
        `UPDATE lead_notifications
         SET payload = $2
         WHERE id = $1`,
        [notificationId, payload]
    );
    const availability = pushAvailability();
    if (!availability.available) {
        console.warn('lead_notification_created_without_push_delivery', { notificationId, reason: availability.reason });
        return { notificationId, deliveryCount: 0 };
    }
    const deliveryResult = await client.query(
        `INSERT INTO lead_notification_deliveries (notification_id, subscription_id, user_id, status)
         SELECT $1, sub.id, sub.user_id, 'queued'
         FROM dashboard_push_subscriptions sub
         JOIN dashboard_users user_row ON user_row.id = sub.user_id
         WHERE sub.revoked_at IS NULL
           AND user_row.status = 'active'
         ON CONFLICT (notification_id, subscription_id) DO NOTHING`,
        [notificationId]
    );
    console.log('lead_notification_enqueued', { notificationId, deliveryCount: Number(deliveryResult.rowCount || 0) });
    return { notificationId, deliveryCount: Number(deliveryResult.rowCount || 0) };
}

async function claimDelivery(pool: Pool, workerId: string): Promise<PushDelivery | null> {
    const { rows } = await pool.query(
        `WITH due AS (
             SELECT d.id
             FROM lead_notification_deliveries d
             JOIN dashboard_push_subscriptions sub ON sub.id = d.subscription_id
             JOIN dashboard_users user_row ON user_row.id = d.user_id
             WHERE d.status = 'queued'
               AND d.next_attempt_at <= now()
               AND sub.revoked_at IS NULL
               AND sub.user_id = d.user_id
               AND user_row.status = 'active'
             ORDER BY d.next_attempt_at ASC, d.created_at ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED
         )
         UPDATE lead_notification_deliveries d
         SET status = 'running',
             attempts = d.attempts + 1,
             locked_by = $1,
             locked_at = now(),
             updated_at = now()
         FROM due
         WHERE d.id = due.id
         RETURNING d.*`,
        [workerId]
    );
    const row = rows[0];
    if (!row) return null;
    const detail = await pool.query(
        `SELECT d.*, n.title, n.body, n.url, n.payload, sub.endpoint, sub.keys
         FROM lead_notification_deliveries d
         JOIN lead_notifications n ON n.id = d.notification_id
         JOIN dashboard_push_subscriptions sub ON sub.id = d.subscription_id
         WHERE d.id = $1`,
        [row.id]
    );
    const full = detail.rows[0];
    if (!full) return null;
    return {
        id: String(full.id),
        notificationId: String(full.notification_id),
        subscriptionId: String(full.subscription_id),
        endpoint: String(full.endpoint),
        keys: full.keys || {},
        title: String(full.title),
        body: String(full.body),
        url: String(full.url),
        payload: full.payload || {},
        attempts: Number(full.attempts || 0),
        maxAttempts: Number(full.max_attempts || DEFAULT_PUSH_MAX_ATTEMPTS)
    };
}

async function markDeliverySent(pool: Pool, delivery: PushDelivery, workerId: string): Promise<boolean> {
    const update = await pool.query(
        `UPDATE lead_notification_deliveries
         SET status = 'sent',
             locked_by = NULL,
             locked_at = NULL,
             sent_at = now(),
             last_error = NULL,
             updated_at = now()
         WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
        [delivery.id, workerId]
    );
    if (Number(update.rowCount || 0) === 0) return false;
    await pool.query(
        `UPDATE dashboard_push_subscriptions
         SET last_success_at = now(), updated_at = now()
         WHERE id = $1`,
        [delivery.subscriptionId]
    );
    return true;
}

async function markDeliveryStale(pool: Pool, delivery: PushDelivery, workerId: string, error: string): Promise<void> {
    await pool.query(
        `UPDATE dashboard_push_subscriptions
         SET revoked_at = COALESCE(revoked_at, now()), updated_at = now()
         WHERE id = $1`,
        [delivery.subscriptionId]
    );
    await pool.query(
        `UPDATE lead_notification_deliveries
         SET status = 'stale',
             locked_by = NULL,
             locked_at = NULL,
             last_error = $3,
             updated_at = now()
         WHERE id = $1 AND locked_by = $2`,
        [delivery.id, workerId, error]
    );
}

async function markDeliveryFailedOrRetry(pool: Pool, delivery: PushDelivery, workerId: string, err: any, clock: () => Date): Promise<void> {
    const statusCode = Number(err?.statusCode || err?.status || 0);
    const message = sanitizeError(err);
    const transient = statusCode === 408 || statusCode === 429 || statusCode >= 500 || !statusCode;
    const exhausted = delivery.attempts >= delivery.maxAttempts;
    if (!transient || exhausted) {
        await pool.query(
            `UPDATE lead_notification_deliveries
             SET status = 'failed',
                 locked_by = NULL,
                 locked_at = NULL,
                 last_error = $3,
                 updated_at = now()
             WHERE id = $1 AND locked_by = $2`,
            [delivery.id, workerId, message]
        );
        return;
    }
    const baseDelay = PUSH_RETRY_MS[Math.min(Math.max(delivery.attempts - 1, 0), PUSH_RETRY_MS.length - 1)];
    const delayMs = Math.max(baseDelay, retryAfterMs(err, clock) || 0);
    await pool.query(
        `UPDATE lead_notification_deliveries
         SET status = 'queued',
             locked_by = NULL,
             locked_at = NULL,
             next_attempt_at = $3,
             last_error = $4,
             updated_at = now()
         WHERE id = $1 AND locked_by = $2`,
        [delivery.id, workerId, new Date(clock().getTime() + delayMs).toISOString(), message]
    );
}

export async function recoverStalePushDeliveries(pool: Pool, staleMs: number): Promise<number> {
    const { rowCount } = await pool.query(
        `UPDATE lead_notification_deliveries
         SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
             locked_by = NULL,
             locked_at = NULL,
             next_attempt_at = CASE WHEN attempts >= max_attempts THEN next_attempt_at ELSE now() END,
             last_error = COALESCE(last_error, 'Push worker lock expired.'),
             updated_at = now()
         WHERE status = 'running'
           AND locked_at < now() - ($1::bigint * INTERVAL '1 millisecond')`,
        [Math.max(1, Math.floor(staleMs))]
    );
    return Number(rowCount || 0);
}

export async function expireUndeliverablePushDeliveries(pool: Pool): Promise<number> {
    const { rowCount } = await pool.query(
        `UPDATE lead_notification_deliveries delivery
         SET status = 'stale',
             locked_by = NULL,
             locked_at = NULL,
             last_error = 'Push subscription or dashboard user is no longer active.',
             updated_at = now()
         FROM dashboard_push_subscriptions subscription, dashboard_users user_row
         WHERE delivery.subscription_id = subscription.id
           AND delivery.user_id = user_row.id
           AND delivery.status IN ('queued','running')
           AND (
             subscription.revoked_at IS NOT NULL
             OR subscription.user_id <> delivery.user_id
             OR user_row.status <> 'active'
           )`
    );
    return Number(rowCount || 0);
}

async function deliveryIsStillActive(pool: Pool, delivery: PushDelivery, workerId: string): Promise<boolean> {
    const { rows } = await pool.query(
        `SELECT 1
         FROM lead_notification_deliveries delivery
         JOIN dashboard_push_subscriptions subscription ON subscription.id = delivery.subscription_id
         JOIN dashboard_users user_row ON user_row.id = delivery.user_id
         WHERE delivery.id = $1
           AND delivery.status = 'running'
           AND delivery.locked_by = $2
           AND subscription.revoked_at IS NULL
           AND subscription.user_id = delivery.user_id
           AND user_row.status = 'active'`,
        [delivery.id, workerId]
    );
    return rows.length > 0;
}

export class PostgresPushDeliveryWorker {
    private readonly pool: Pool;
    private readonly workerId: string;
    private readonly pollIntervalMs: number;
    private readonly staleAfterMs: number;
    private readonly sender: PushSender;
    private readonly clock: () => Date;
    private started = false;
    private draining = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private lastCleanupAt = Number.NEGATIVE_INFINITY;

    constructor(options: {
        pool: Pool;
        workerId?: string;
        pollIntervalMs?: number;
        staleAfterMs?: number;
        sender?: PushSender;
        clock?: () => Date;
    }) {
        this.pool = options.pool;
        this.workerId = options.workerId || `push-worker-${process.pid}-${crypto.randomUUID()}`;
        this.pollIntervalMs = options.pollIntervalMs || positiveEnv('PUSH_QUEUE_POLL_INTERVAL_MS', DEFAULT_PUSH_POLL_MS);
        this.staleAfterMs = options.staleAfterMs || positiveEnv('PUSH_QUEUE_STALE_AFTER_MS', DEFAULT_PUSH_STALE_MS);
        this.sender = options.sender || ((subscription, payload, requestOptions) => webPush.sendNotification(subscription, payload, requestOptions));
        this.clock = options.clock || (() => new Date());
    }

    async start(): Promise<void> {
        if (this.started) return;
        await ensureDashboardPushSchema(this.pool);
        this.started = true;
        this.poke();
    }

    stop(): void {
        this.started = false;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
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
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.drain();
        }, Math.max(0, delayMs));
        const maybeUnref = this.timer as any;
        if (typeof maybeUnref.unref === 'function') maybeUnref.unref();
    }

    private async drain(): Promise<void> {
        if (!this.started || this.draining) return;
        this.draining = true;
        try {
            await expireUndeliverablePushDeliveries(this.pool);
            const now = this.clock().getTime();
            if (now - this.lastCleanupAt >= PUSH_CLEANUP_INTERVAL_MS) {
                await cleanupDashboardPushRows(this.pool);
                this.lastCleanupAt = now;
            }
            await recoverStalePushDeliveries(this.pool, this.staleAfterMs).catch(err => {
                console.warn('push_worker_recover_failed', { error: err?.message || String(err) });
            });
            if (!pushAvailability().available) return;
            while (this.started) {
                const delivery = await claimDelivery(this.pool, this.workerId);
                if (!delivery) break;
                await this.process(delivery);
            }
        } catch (err: any) {
            console.error('push_worker_failed', { error: err?.message || String(err) });
        } finally {
            this.draining = false;
            this.schedule(this.pollIntervalMs);
        }
    }

    private async process(delivery: PushDelivery): Promise<void> {
        const payload = JSON.stringify({
            title: delivery.title,
            body: delivery.body,
            tag: delivery.payload?.tag || `lead:${delivery.notificationId}`,
            url: delivery.url,
            notificationId: delivery.notificationId
        });
        try {
            if (!await deliveryIsStillActive(this.pool, delivery, this.workerId)) return;
            await this.sender(
                { endpoint: delivery.endpoint, keys: delivery.keys as any },
                payload,
                { TTL: 300, timeout: positiveEnv('PUSH_DELIVERY_TIMEOUT_MS', DEFAULT_PUSH_DELIVERY_TIMEOUT_MS) }
            );
            const markedSent = await markDeliverySent(this.pool, delivery, this.workerId);
            if (markedSent) {
                console.log('push_delivery_sent', { deliveryId: delivery.id, notificationId: delivery.notificationId, at: nowIso(this.clock) });
            } else {
                console.warn('push_delivery_lease_lost_after_send', { deliveryId: delivery.id, notificationId: delivery.notificationId });
            }
        } catch (err: any) {
            const statusCode = Number(err?.statusCode || err?.status || 0);
            if (statusCode === 404 || statusCode === 410) {
                await markDeliveryStale(this.pool, delivery, this.workerId, sanitizeError(err));
                console.warn('push_delivery_stale', { deliveryId: delivery.id, statusCode });
                return;
            }
            await markDeliveryFailedOrRetry(this.pool, delivery, this.workerId, err, this.clock);
            console.warn('push_delivery_retry_or_failed', { deliveryId: delivery.id, statusCode, attempts: delivery.attempts });
        }
    }
}
