import type { Pool } from 'pg';
import { ensureAdsWarehouseSchema } from './adsWarehouse';
import { ensureDashboardAuthSchema } from './dashboardAuth';
import { ensureLeadSchema } from './leads';
import { ensureMcpCoreSchema } from './mcp/session';
import { ensureOfflineConversionsAuthSchema } from './offlineConversionsAuth';
import { ensureDatabaseSchema } from './proposals';
import { ensureSemanticMemorySchema } from './semanticMemory';
import { ensureGoogleAdsMutationSchema } from './googleAdsMutations';
import { ensureGoogleAdsQuotaSchema, migrateGoogleAdsQuotaAccounting } from './googleAdsQuota';
import { ensureRefreshQueueSchema } from './refreshQueue';
import { ensureDashboardUsersSchema } from './dashboardUsers';
import { ensureDashboardPushSchema } from './dashboardPush';
import { ensureUserPreferencesSchema } from './userPreferences';

type Migration = {
    id: string;
    description: string;
    up: (pool: Pool) => Promise<void>;
    optional?: boolean;
};

export type MigrationFailure = {
    id: string;
    description: string;
    error: string;
};

export type MigrationResult = {
    applied: string[];
    skipped: string[];
    optionalFailures: MigrationFailure[];
};

const MIGRATIONS: Migration[] = [
    { id: '202607050001_proposals_core', description: 'Proposal, feedback, impact, and related core tables', up: ensureDatabaseSchema },
    { id: '202607050002_ads_warehouse', description: 'Google Ads warehouse, coverage, watermarks, and refresh runs', up: ensureAdsWarehouseSchema },
    { id: '202607050003_leads', description: 'Lead events, lead sessions, and attribution tables', up: ensureLeadSchema },
    { id: '202607050004_dashboard_auth', description: 'Dashboard magic links and sessions', up: ensureDashboardAuthSchema },
    { id: '202607050005_offline_conversions_auth', description: 'Offline conversions Basic Auth credentials', up: ensureOfflineConversionsAuthSchema },
    { id: '202607050006_mcp_core', description: 'MCP sessions, audit rows, and rate limits', up: ensureMcpCoreSchema },
    { id: '202607050007_google_ads_mutations', description: 'Durable Google Ads mutation preview and execution rows', up: ensureGoogleAdsMutationSchema },
    { id: '202607050008_semantic_memory', description: 'Semantic memory tables, pgvector embeddings, and vector indexes', up: ensureSemanticMemorySchema, optional: true },
    { id: '202607050009_refresh_queue', description: 'Durable PostgreSQL refresh queue and worker lease state', up: ensureRefreshQueueSchema },
    { id: '202607050010_google_ads_quota', description: 'Google Ads API shared quota token buckets', up: ensureGoogleAdsQuotaSchema },
    { id: '202607050011_remove_legacy_learning_priors', description: 'Remove legacy alpha/beta strategy priors and vote tokens', up: removeLegacyLearningPriors },
    { id: '202607100001_dashboard_named_users', description: 'Dashboard named admin users, password tokens, throttling, named sessions, and CSRF state', up: ensureDashboardUsersSchema },
    { id: '202607100002_dashboard_push_outbox', description: 'Dashboard push subscriptions, lead notification outbox, and delivery rows', up: ensureDashboardPushSchema },
    {
        id: '202607100003_dashboard_pwa_hardening',
        description: 'Idempotent auth-rate-limit and push-delivery hardening for upgraded PWA deployments',
        up: async pool => {
            await ensureDashboardUsersSchema(pool);
            await ensureDashboardPushSchema(pool);
        }
    },
    {
        id: '202607140001_google_ads_rolling_operation_quota',
        description: 'Align Google Ads quota accounting to developer-token operations in a rolling 24-hour window',
        up: migrateGoogleAdsQuotaAccounting
    },
    {
        id: '202607150001_conversion_search_term_keyword_dimensions',
        description: 'Preserve matched keyword dimensions on conversion-attributed search terms',
        up: async pool => {
            await pool.query(`
                ALTER TABLE google_ads_conversion_search_term_daily
                    ADD COLUMN IF NOT EXISTS matched_keyword_text TEXT,
                    ADD COLUMN IF NOT EXISTS matched_keyword_match_type TEXT;
            `);
        }
    },
    {
        id: '202607190001_google_ads_audiences',
        description: 'Audience criteria, catalogs, demographic performance, targeting settings, and audience performance warehouse tables',
        up: ensureAdsWarehouseSchema
    },
    {
        id: '202607190002_google_ads_audience_snapshot_columns',
        description: 'Add audience channel and targeting-restriction columns to existing campaign and ad-group snapshots',
        up: async pool => {
            await pool.query(`
                ALTER TABLE google_ads_campaign_snapshot
                    ADD COLUMN IF NOT EXISTS advertising_channel_type TEXT,
                    ADD COLUMN IF NOT EXISTS advertising_channel_sub_type TEXT,
                    ADD COLUMN IF NOT EXISTS targeting_restrictions JSONB NOT NULL DEFAULT '[]'::jsonb;
                ALTER TABLE google_ads_ad_group_snapshot
                    ADD COLUMN IF NOT EXISTS targeting_restrictions JSONB NOT NULL DEFAULT '[]'::jsonb;
            `);
        }
    },
    {
        id: '202607220001_dashboard_user_preferences',
        description: 'Dashboard named user preferences key-value table',
        up: ensureUserPreferencesSchema
    }
];

async function removeLegacyLearningPriors(pool: Pool): Promise<void> {
    await pool.query(`
        DROP TABLE IF EXISTS strategy_success_rates;
        ALTER TABLE impact_tracking DROP COLUMN IF EXISTS interim_vote_14;
        UPDATE impact_tracking
        SET outcome_details_14 = outcome_details_14 - 'vote_column' - 'vote_weight'
        WHERE outcome_details_14 ?| ARRAY['vote_column', 'vote_weight'];
        UPDATE impact_tracking
        SET outcome_details_30 = outcome_details_30 - 'vote_column' - 'vote_weight'
        WHERE outcome_details_30 ?| ARRAY['vote_column', 'vote_weight'];
    `);
}

export async function ensureMigrationLedger(pool: Pool): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id TEXT PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

export async function runSchemaMigrations(pool: Pool): Promise<MigrationResult> {
    const client = await pool.connect();
    const lockName = 'google_ads_schema_migrations';
    try {
        // Serialize the check/apply/ledger sequence across app instances. A
        // dedicated client is also safe with DASHBOARD_DB_POOL_MAX=1 because
        // every migration query below uses this same connection.
        await client.query(`SELECT pg_advisory_lock(hashtext($1))`, [lockName]);
        const migrationDb = client as unknown as Pool;
        await ensureMigrationLedger(migrationDb);
        const result: MigrationResult = { applied: [], skipped: [], optionalFailures: [] };
        for (const migration of MIGRATIONS) {
            const { rows } = await client.query(`SELECT id FROM schema_migrations WHERE id = $1`, [migration.id]);
            if (rows.length) {
                result.skipped.push(migration.id);
                continue;
            }
            try {
                await migration.up(migrationDb);
            } catch (err: any) {
                if (!migration.optional) throw err;
                result.optionalFailures.push({
                    id: migration.id,
                    description: migration.description,
                    error: err?.message || String(err)
                });
                continue;
            }
            await client.query(
                `INSERT INTO schema_migrations (id, description) VALUES ($1, $2)
                 ON CONFLICT (id) DO NOTHING`,
                [migration.id, migration.description]
            );
            result.applied.push(migration.id);
        }
        return result;
    } finally {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [lockName]).catch(() => undefined);
        client.release();
    }
}

export function migrationIds(): string[] {
    return MIGRATIONS.map(migration => migration.id);
}
