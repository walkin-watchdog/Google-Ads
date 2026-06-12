import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { migrationIds } from '../lib/migrations.ts';

const root = path.join(import.meta.dir, '..');

describe('database migrations', () => {
    test('starts from one clean baseline plus optional semantic memory', () => {
        expect(migrationIds()).toEqual(['0001_initial_schema', '0002_initial_semantic_memory']);

        const migrations = fs.readFileSync(path.join(root, 'lib', 'migrations.ts'), 'utf8');
        expect(migrations).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
        expect(migrations).toContain('pg_advisory_lock(hashtext($1))');
        expect(migrations).toContain('pg_advisory_unlock(hashtext($1))');
        expect(migrations).not.toMatch(/20\\d{6,}/);
        expect(migrations).not.toContain('ALTER TABLE');
        expect(migrations).not.toContain('DROP TABLE');
    });

    test('baseline creates current schema directly and startup remains idempotent', () => {
        const schema = fs.readFileSync(path.join(root, 'lib', 'schema.ts'), 'utf8');
        const start = fs.readFileSync(path.join(root, 'scripts', 'start.ts'), 'utf8');
        const migrate = fs.readFileSync(path.join(root, 'scripts', 'migrate.ts'), 'utf8');
        const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

        for (const initializer of [
            'ensureDatabaseSchema',
            'ensureAdsWarehouseSchema',
            'ensureLeadSchema',
            'ensureDashboardUsersSchema',
            'ensureDashboardAuthSchema',
            'ensureOfflineConversionsAuthSchema',
            'ensureMcpCoreSchema',
            'ensureGoogleAdsMutationSchema',
            'ensureRefreshQueueSchema',
            'ensureGoogleAdsQuotaSchema',
            'ensureDashboardPushSchema',
            'ensureUserPreferencesSchema'
        ]) {
            expect(schema).toContain(`${initializer}(pool)`);
        }
        expect(migrate).toContain('runSchemaMigrations(pool)');
        expect(start).toContain("scripts/migrate.ts");
        expect(packageJson.scripts['db:migrate']).toBe('bun run scripts/migrate.ts');
        expect(packageJson.scripts['db:reset']).toBe('bun run scripts/reset_db.ts');
    });

    test('schema creators contain final columns and no repair SQL', () => {
        const schemaFiles = [
            'adsWarehouse.ts',
            'dashboardAuth.ts',
            'dashboardPush.ts',
            'dashboardUsers.ts',
            'leads.ts',
            'googleAdsQuota.ts',
            'semanticMemory.ts'
        ].map(file => fs.readFileSync(path.join(root, 'lib', file), 'utf8')).join('\n');

        expect(schemaFiles).toContain('matched_keyword_text TEXT');
        expect(schemaFiles).toContain('advertising_channel_type TEXT');
        expect(schemaFiles).toContain("targeting_restrictions JSONB NOT NULL DEFAULT '[]'::jsonb");
        expect(schemaFiles).toContain('tracking_only BOOLEAN NOT NULL DEFAULT FALSE');
        expect(schemaFiles).toContain('user_id UUID REFERENCES dashboard_users(id) ON DELETE CASCADE');
        expect(schemaFiles).not.toContain('ALTER TABLE');
    });
});
