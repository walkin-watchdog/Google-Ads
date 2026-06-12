import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { ensureDatabaseSchema } from '../lib/proposals';
import { ensureLeadSchema } from '../lib/leads';
import { ensureSemanticMemorySchema } from '../lib/semanticMemory';
import { ensureDashboardAuthSchema } from '../lib/dashboardAuth';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function run() {
    if (!process.env.DATABASE_URL) {
        console.log('No DATABASE_URL configured; skipping database migration.');
        return;
    }
    await ensureDatabaseSchema(pool);
    await ensureLeadSchema(pool);
    await ensureDashboardAuthSchema(pool);
    await ensureSemanticMemorySchema(pool);
    console.log('Database schema migration complete.');
}

run()
    .catch(err => {
        console.error('Database migration failed:', err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
