import { describe, expect, test } from 'bun:test';
import { disableDashboardUser, normalizeEmail, validateDashboardPassword } from '../lib/dashboardUsers.ts';

describe('dashboard named-user security invariants', () => {
    test('normalizes email and enforces the password policy', () => {
        expect(normalizeEmail('  Admin@Example.COM ')).toBe('admin@example.com');
        expect(validateDashboardPassword('correct horse 123')).toBe('correct horse 123');
        expect(() => validateDashboardPassword('letters-only-password')).toThrow('number');
        expect(() => validateDashboardPassword('123456789012')).toThrow('letter');
        expect(() => validateDashboardPassword('short1')).toThrow('12 to 200');
    });

    test('invalidates unused invite/reset tokens when disabling a user', async () => {
        const queries = [];
        const userId = '11111111-1111-4111-8111-111111111111';
        const user = {
            id: userId,
            email: 'admin@example.com',
            email_normalized: 'admin@example.com',
            name: 'Admin',
            status: 'disabled',
            invited_at: new Date('2026-07-10T00:00:00.000Z'),
            activated_at: null,
            last_login_at: null,
            created_at: new Date('2026-07-10T00:00:00.000Z'),
            updated_at: new Date('2026-07-11T00:00:00.000Z')
        };
        const client = {
            async query(sql, params = []) {
                const text = String(sql);
                queries.push({ text, params });
                if (text.includes('UPDATE dashboard_users')) return { rows: [user], rowCount: 1 };
                return { rows: [], rowCount: 1 };
            },
            release() {}
        };
        const pool = { async connect() { return client; } };

        const disabled = await disableDashboardUser(pool, { userId });

        expect(disabled.status).toBe('disabled');
        const tokenUpdate = queries.find(entry => entry.text.includes('UPDATE dashboard_user_tokens'));
        const sessionUpdate = queries.find(entry => entry.text.includes('UPDATE dashboard_sessions'));
        expect(tokenUpdate).toBeDefined();
        expect(tokenUpdate.text).toContain('used_at = COALESCE(used_at, now())');
        expect(tokenUpdate.params).toEqual([userId]);
        expect(queries.indexOf(tokenUpdate)).toBeLessThan(queries.indexOf(sessionUpdate));
    });

    test('rolls back instead of reporting success when revocation work fails', async () => {
        const queries = [];
        const userId = '11111111-1111-4111-8111-111111111111';
        const client = {
            async query(sql) {
                const text = String(sql);
                queries.push(text);
                if (text.includes('UPDATE dashboard_users')) {
                    return {
                        rows: [{
                            id: userId,
                            email: 'admin@example.com',
                            email_normalized: 'admin@example.com',
                            name: 'Admin',
                            status: 'disabled',
                            invited_at: new Date(),
                            activated_at: null,
                            last_login_at: null,
                            created_at: new Date(),
                            updated_at: new Date()
                        }],
                        rowCount: 1
                    };
                }
                if (text.includes('UPDATE dashboard_push_subscriptions')) throw new Error('push revocation failed');
                return { rows: [], rowCount: 1 };
            },
            release() {}
        };
        const pool = { async connect() { return client; } };

        await expect(disableDashboardUser(pool, { userId })).rejects.toThrow('push revocation failed');
        expect(queries).toContain('ROLLBACK');
        expect(queries).not.toContain('COMMIT');
    });
});
