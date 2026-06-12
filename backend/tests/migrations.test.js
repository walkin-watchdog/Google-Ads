import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { migrationIds } from '../lib/migrations.ts';

const root = path.join(import.meta.dir, '..');

describe('schema migrations', () => {
    test('uses a versioned migration ledger instead of direct ensure calls in migrate script', () => {
        const migrate = fs.readFileSync(path.join(root, 'scripts', 'migrate.ts'), 'utf8');
        const migrations = fs.readFileSync(path.join(root, 'lib', 'migrations.ts'), 'utf8');

        expect(migrate).toContain('runSchemaMigrations(pool)');
        expect(migrate).toContain('optionalFailures');
        expect(migrate).not.toContain('ensureDatabaseSchema(pool)');
        expect(migrate).not.toContain('ensureAdsWarehouseSchema(pool)');
        expect(migrations).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
        expect(migrations).toContain('INSERT INTO schema_migrations');
        expect(migrations).toContain('pg_advisory_lock(hashtext($1))');
        expect(migrations).toContain('pg_advisory_unlock(hashtext($1))');
    });

    test('keeps semantic memory optional so required schemas can still initialize', () => {
        const migrations = fs.readFileSync(path.join(root, 'lib', 'migrations.ts'), 'utf8');
        const server = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');

        expect(migrations).toContain("id: '202607050008_semantic_memory'");
        expect(migrations).toContain('optional: true');
        expect(migrations).toContain('optionalFailures');
        expect(server).toContain('migrationResult.optionalFailures');
        expect(server).toContain('refreshQueueWorker?.start()');
        expect(server.indexOf('initDB()')).toBeLessThan(server.indexOf('app.listen(PORT'));
        expect(server).not.toContain('\ninitDB();');
        expect(server).toContain('process.exitCode = 1');
    });

    test('drops legacy alpha/beta learning state through a ledgered cleanup migration', () => {
        const migrations = fs.readFileSync(path.join(root, 'lib', 'migrations.ts'), 'utf8');
        const proposals = fs.readFileSync(path.join(root, 'lib', 'proposals.ts'), 'utf8');

        expect(migrations).toContain("id: '202607050011_remove_legacy_learning_priors'");
        expect(migrations).toContain('DROP TABLE IF EXISTS strategy_success_rates');
        expect(migrations).toContain('DROP COLUMN IF EXISTS interim_vote_14');
        expect(migrations).toContain("outcome_details_14 - 'vote_column' - 'vote_weight'");
        expect(proposals).not.toContain('CREATE TABLE IF NOT EXISTS strategy_success_rates');
        expect(proposals).not.toContain('interim_vote_14 VARCHAR');
    });

    test('migrates weighted daily quota buckets to rolling developer-token operations', () => {
        const migrations = fs.readFileSync(path.join(root, 'lib', 'migrations.ts'), 'utf8');
        const quota = fs.readFileSync(path.join(root, 'lib', 'googleAdsQuota.ts'), 'utf8');

        expect(migrations).toContain("id: '202607140001_google_ads_rolling_operation_quota'");
        expect(migrations).toContain('up: migrateGoogleAdsQuotaAccounting');
        expect(quota).toContain('CREATE TABLE IF NOT EXISTS google_ads_api_operation_usage');
        expect(quota).toContain("INTERVAL '24 hours'");
        expect(quota).toContain('DELETE FROM google_ads_quota_buckets');
        expect(quota).toContain('google_ads_query_resource_usage_hourly');
    });

    test('migration ids are ordered and unique', () => {
        const ids = migrationIds();
        expect(ids.length).toBeGreaterThan(0);
        expect(new Set(ids).size).toBe(ids.length);
        expect([...ids].sort()).toEqual(ids);
    });

    test('preserves keyword dimensions for conversion-attributed search terms', () => {
        const migrations = fs.readFileSync(path.join(root, 'lib', 'migrations.ts'), 'utf8');

        expect(migrations).toContain("id: '202607150001_conversion_search_term_keyword_dimensions'");
        expect(migrations).toContain('ADD COLUMN IF NOT EXISTS matched_keyword_text TEXT');
        expect(migrations).toContain('ADD COLUMN IF NOT EXISTS matched_keyword_match_type TEXT');
    });

    test('upgrades existing audience snapshot tables through a versioned migration', () => {
        const migrations = fs.readFileSync(path.join(root, 'lib', 'migrations.ts'), 'utf8');

        expect(migrations).toContain("id: '202607190002_google_ads_audience_snapshot_columns'");
        expect(migrations).toContain('ADD COLUMN IF NOT EXISTS advertising_channel_type TEXT');
        expect(migrations).toContain("ADD COLUMN IF NOT EXISTS targeting_restrictions JSONB NOT NULL DEFAULT '[]'::jsonb");
    });
});
