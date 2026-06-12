import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
    getOfflineConversionsBasicAuthStatus,
    revealOfflineConversionsBasicAuthPassword,
    upsertOfflineConversionsBasicAuth,
    verifyOfflineConversionsBasicAuth
} from '../lib/offlineConversionsAuth.ts';

const ORIGINAL_SECRET_API_KEY = process.env.SECRET_API_KEY;

class FakePool {
    row = null;

    async query(sql, params = []) {
        if (/CREATE TABLE IF NOT EXISTS offline_conversions_basic_auth_settings/.test(sql)) {
            return { rows: [] };
        }
        if (/INSERT INTO offline_conversions_basic_auth_settings/.test(sql)) {
            this.row = {
                username: params[0],
                password_hash: params[1],
                password_salt: params[2],
                password_ciphertext: params[3],
                password_iv: params[4],
                password_auth_tag: params[5],
                updated_at: new Date('2026-07-05T00:00:00Z')
            };
            return { rows: [this.row] };
        }
        if (/SELECT password_hash, password_salt/.test(sql)) {
            return { rows: this.row ? [this.row] : [] };
        }
        if (/SELECT username, password_hash, password_salt/.test(sql)) {
            return { rows: this.row ? [this.row] : [] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
    }
}

describe('offline conversions Basic Auth settings', () => {
    beforeEach(() => {
        process.env.SECRET_API_KEY = 'offline-auth-test-secret';
        delete process.env.OFFLINE_CONVERSIONS_AUTH_ENCRYPTION_KEY;
    });

    afterAll(() => {
        if (ORIGINAL_SECRET_API_KEY === undefined) delete process.env.SECRET_API_KEY;
        else process.env.SECRET_API_KEY = ORIGINAL_SECRET_API_KEY;
    });

    test('reports unconfigured status before credentials exist', async () => {
        const pool = new FakePool();
        await expect(getOfflineConversionsBasicAuthStatus(pool)).resolves.toEqual({
            configured: false,
            username: null,
            passwordConfigured: false,
            passwordRevealAvailable: false,
            updatedAt: null
        });
    });

    test('stores a salted password hash and verifies credentials', async () => {
        const pool = new FakePool();
        const saved = await upsertOfflineConversionsBasicAuth(pool, {
            username: 'google-data-manager',
            password: 'secret-pass'
        });
        expect(saved).toMatchObject({
            configured: true,
            username: 'google-data-manager',
            passwordConfigured: true,
            passwordRevealAvailable: true
        });
        expect(pool.row.password_hash).not.toBe('secret-pass');
        expect(pool.row.password_ciphertext).toBeTruthy();
        await expect(revealOfflineConversionsBasicAuthPassword(pool)).resolves.toMatchObject({
            username: 'google-data-manager',
            password: 'secret-pass'
        });
        await expect(verifyOfflineConversionsBasicAuth(pool, 'google-data-manager', 'secret-pass')).resolves.toEqual({
            configured: true,
            ok: true
        });
        await expect(verifyOfflineConversionsBasicAuth(pool, 'google-data-manager', 'wrong-pass')).resolves.toEqual({
            configured: true,
            ok: false
        });
    });

    test('can edit username without rotating the existing password hash', async () => {
        const pool = new FakePool();
        await upsertOfflineConversionsBasicAuth(pool, {
            username: 'old-user',
            password: 'secret-pass'
        });
        const originalHash = pool.row.password_hash;
        await upsertOfflineConversionsBasicAuth(pool, {
            username: 'new-user'
        });
        expect(pool.row.password_hash).toBe(originalHash);
        await expect(verifyOfflineConversionsBasicAuth(pool, 'old-user', 'secret-pass')).resolves.toEqual({
            configured: true,
            ok: false
        });
        await expect(verifyOfflineConversionsBasicAuth(pool, 'new-user', 'secret-pass')).resolves.toEqual({
            configured: true,
            ok: true
        });
    });

    test('requires a password for initial setup', async () => {
        const pool = new FakePool();
        await expect(upsertOfflineConversionsBasicAuth(pool, { username: 'user' })).rejects.toThrow('password is required');
    });
});
