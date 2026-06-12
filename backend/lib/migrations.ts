import type { Pool } from 'pg';
import { initializeCoreDatabaseSchema } from './schema';
import { ensureSemanticMemorySchema } from './semanticMemory';

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
    {
        id: '0001_initial_schema',
        description: 'Complete application schema',
        up: initializeCoreDatabaseSchema
    },
    {
        id: '0002_initial_semantic_memory',
        description: 'Semantic memory tables and vector indexes',
        up: ensureSemanticMemorySchema,
        optional: true
    }
];

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
