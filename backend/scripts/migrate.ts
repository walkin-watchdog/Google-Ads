import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { createPoolConfig } from '../lib/dbConfig';
import { runSchemaMigrations } from '../lib/migrations';

const pool = new Pool(createPoolConfig());

async function run(): Promise<void> {
    if (!process.env.DATABASE_URL) {
        console.log('No DATABASE_URL configured; skipping database migration.');
        return;
    }
    const result = await runSchemaMigrations(pool);
    for (const failure of result.optionalFailures) {
        console.warn(`Optional migration ${failure.id} unavailable: ${failure.error}`);
    }
    console.log('Database migrations complete.');
}

run()
    .catch(err => {
        console.error('Database migration failed:', err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
