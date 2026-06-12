import { describe, expect, test } from 'bun:test';
import {
    ensureDashboardPushSchema,
    expireUndeliverablePushDeliveries,
    pushSubscriptionStatus,
    safeNotificationParts,
    upsertPushSubscription
} from '../lib/dashboardPush.ts';

describe('dashboard push delivery hardening', () => {
    test('redacts contact-shaped text even when it arrives in notification-safe attribution fields', () => {
        const parts = safeNotificationParts({
            session_key: 'lead-session',
            utm_campaign: 'buyer@example.com',
            kind: 'Call +91 98765 43210'
        });
        expect(parts.body).toContain('[redacted]');
        expect(parts.body).not.toContain('buyer@example.com');
        expect(parts.body).not.toContain('98765');
        expect(parts.payload).toEqual({ title: parts.title, body: parts.body, tag: expect.any(String), url: parts.url });
    });

    test('schema gives the initial send all four planned retry delays', async () => {
        const queries = [];
        await ensureDashboardPushSchema({
            async query(sql) {
                queries.push(String(sql));
                return { rows: [], rowCount: 0 };
            }
        });
        const sql = queries.join('\n');
        expect(sql).toContain('max_attempts INTEGER NOT NULL DEFAULT 5');
        expect(sql).toContain('ALTER COLUMN max_attempts SET DEFAULT 5');
        expect(sql).toContain("WHERE max_attempts = 4 AND status IN ('queued','running')");
        const source = await Bun.file(new URL('../lib/dashboardPush.ts', import.meta.url)).text();
        expect(source).toContain("timeout: positiveEnv('PUSH_DELIVERY_TIMEOUT_MS'");
    });

    test('marks revoked, disabled-user, and transferred-recipient deliveries stale', async () => {
        let query = '';
        const count = await expireUndeliverablePushDeliveries({
            async query(sql) {
                query = String(sql);
                return { rows: [], rowCount: 3 };
            }
        });
        expect(count).toBe(3);
        expect(query).toContain('subscription.revoked_at IS NOT NULL');
        expect(query).toContain('subscription.user_id <> delivery.user_id');
        expect(query).toContain("user_row.status <> 'active'");
        expect(query).toContain("delivery.status IN ('queued','running')");
    });

    test('bounds and validates subscription-status endpoints before querying', async () => {
        let queryCount = 0;
        const pool = {
            async query() {
                queryCount += 1;
                return { rows: [] };
            }
        };
        expect(await pushSubscriptionStatus(pool, 'user-id', '')).toEqual({ subscribed: false, belongsToCurrentUser: false });
        await expect(pushSubscriptionStatus(pool, 'user-id', 'http://push.example/subscription-id')).rejects.toThrow('HTTPS');
        await expect(pushSubscriptionStatus(pool, 'user-id', 'ftp://localhost/push/subscription-id')).rejects.toThrow('HTTPS');
        await expect(pushSubscriptionStatus(pool, 'user-id', `https://push.example/${'x'.repeat(2100)}`)).rejects.toThrow('invalid');
        expect(queryCount).toBe(0);
    });

    test('stales pending deliveries owned by the previous user during explicit endpoint transfer', async () => {
        const queries = [];
        const client = {
            async query(sql, params) {
                queries.push({ sql: String(sql), params });
                if (String(sql).includes('RETURNING id')) return { rows: [{ id: 'subscription-id' }], rowCount: 1 };
                return { rows: [], rowCount: 2 };
            },
            release() {}
        };
        const pool = { async connect() { return client; } };
        await upsertPushSubscription(pool, 'new-user-id', {
            endpoint: 'https://push.example/subscription-id',
            keys: { p256dh: 'p'.repeat(30), auth: 'a'.repeat(20) },
            userAgent: 'Test browser'
        });
        const stale = queries.find(entry => entry.sql.includes('moved to another dashboard user'));
        expect(stale).toBeDefined();
        expect(stale.sql).toContain('user_id <> $2');
        expect(stale.params).toEqual(['subscription-id', 'new-user-id']);
        expect(queries.map(entry => entry.sql)).toContain('COMMIT');
    });

    test('rolls back endpoint transfer when delivery staling fails', async () => {
        const queries = [];
        const client = {
            async query(sql) {
                const text = String(sql);
                queries.push(text);
                if (text.includes('RETURNING id')) return { rows: [{ id: 'subscription-id' }], rowCount: 1 };
                if (text.includes('moved to another dashboard user')) throw new Error('staling failed');
                return { rows: [], rowCount: 1 };
            },
            release() {}
        };
        const pool = { async connect() { return client; } };

        await expect(upsertPushSubscription(pool, 'new-user-id', {
            endpoint: 'https://push.example/subscription-id',
            keys: { p256dh: 'p'.repeat(30), auth: 'a'.repeat(20) }
        })).rejects.toThrow('staling failed');

        expect(queries).toContain('ROLLBACK');
        expect(queries).not.toContain('COMMIT');
    });
});
