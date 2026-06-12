import { describe, expect, test } from 'bun:test';
import { createPoolConfig, databaseSslConfig } from '../lib/dbConfig.ts';

describe('database SSL deployment modes', () => {
    test('uses SSL by default for production remote deployments', () => {
        expect(databaseSslConfig({
            NODE_ENV: 'production',
            DATABASE_URL: 'postgresql://user:pass@example.com/db'
        })).toEqual({ rejectUnauthorized: false });
    });

    test('disables SSL for VPS mode even when NODE_ENV is production', () => {
        expect(databaseSslConfig({
            NODE_ENV: 'production',
            DEPLOYMENT_MODE: 'vps',
            DATABASE_URL: 'postgresql://user:pass@db:5432/google_ads'
        })).toBe(false);
    });

    test('honors explicit DATABASE_SSL overrides', () => {
        expect(databaseSslConfig({
            NODE_ENV: 'production',
            DEPLOYMENT_MODE: 'vps',
            DATABASE_SSL: 'require'
        })).toEqual({ rejectUnauthorized: false });

        expect(databaseSslConfig({
            NODE_ENV: 'production',
            DATABASE_SSL: 'disable'
        })).toBe(false);
    });

    test('honors sslmode from DATABASE_URL', () => {
        expect(databaseSslConfig({
            NODE_ENV: 'production',
            DATABASE_URL: 'postgresql://user:pass@db/google_ads?sslmode=disable'
        })).toBe(false);
    });

    test('merges caller pool options with resolved SSL', () => {
        expect(createPoolConfig({
            max: 1,
            connectionTimeoutMillis: 3000
        }, {
            DEPLOYMENT_MODE: 'vps',
            DATABASE_URL: 'postgresql://user:pass@db/google_ads'
        })).toMatchObject({
            connectionString: 'postgresql://user:pass@db/google_ads',
            ssl: false,
            max: 1,
            connectionTimeoutMillis: 3000
        });
    });
});
