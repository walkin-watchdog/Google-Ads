import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { ensureAdsWarehouseSchema } from '../lib/adsWarehouse';
import { buildDashboardPayload, resolveDashboardFilters } from '../lib/dashboardPayload';
import { ensureLeadSchema } from '../lib/leads';
import { ensureDatabaseSchema } from '../lib/proposals';

interface CliOptions {
    customerId?: string;
    startDate?: string;
    endDate?: string;
    campaignId?: string;
    adGroupId?: string;
    section?: string;
}

function parseArgs(argv: string[]): CliOptions {
    const options: CliOptions = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) continue;
        if (arg === '--customer-id') options.customerId = next;
        if (arg === '--start-date') options.startDate = next;
        if (arg === '--end-date') options.endDate = next;
        if (arg === '--campaign-id') options.campaignId = next;
        if (arg === '--ad-group-id') options.adGroupId = next;
        if (arg === '--section') options.section = next;
    }
    return options;
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function run() {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is required to build a dashboard payload from the Google Ads warehouse.');
    }

    await ensureDatabaseSchema(pool);
    await ensureAdsWarehouseSchema(pool);
    await ensureLeadSchema(pool);

    const options = parseArgs(process.argv.slice(2));
    const filters = await resolveDashboardFilters(pool, options);
    const payload = await buildDashboardPayload(pool, filters);
    const output = options.section
        ? { [options.section]: Object.prototype.hasOwnProperty.call(payload, options.section) ? payload[options.section] : null, meta: payload.meta }
        : payload;

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

run()
    .catch(err => {
        console.error('Failed to build dashboard payload:', err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
