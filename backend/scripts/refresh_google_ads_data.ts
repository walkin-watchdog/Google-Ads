import dotenv from 'dotenv';
dotenv.config();

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { getAccessToken, getAccessibleCustomer, executeGaql } from '../lib/googleAds';

const ROOT = path.resolve(__dirname, '..'); // Handle path correctly on Render and locally
const DATA_DIR = path.join(ROOT, 'data', 'latest');
const REPORTS_YML = path.join(ROOT, 'config', 'reports.yml');

// Parse CLI arguments for dynamic date
let targetDate = new Date().toISOString().slice(0, 10);
let startDateStr = '';
let endDateStr = '';

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) targetDate = args[i + 1];
    if (args[i] === '--start-date' && args[i + 1]) startDateStr = args[i + 1];
    if (args[i] === '--end-date' && args[i + 1]) endDateStr = args[i + 1];
}

if (!endDateStr) endDateStr = new Date().toISOString().slice(0, 10);
if (!startDateStr) {
    const today = new Date();
    // Default to last 90 days
    const ninetyDaysAgo = new Date(today.getTime() - 90 * 86400000);
    startDateStr = ninetyDaysAgo.toISOString().slice(0, 10);
}

console.log(`Using target date: ${targetDate} for daily reports.`);
console.log(`Using date range: ${startDateStr} to ${endDateStr} for standard reports.`);

fs.mkdirSync(DATA_DIR, { recursive: true });

function formatQuery(reportDef: any): string {
    const fields = reportDef.fields.join(', ');

    // Format dates in conditions
    let conditions: string[] = reportDef.conditions || [];
    conditions = conditions.map(c => c.replace(/<START_DATE>/g, startDateStr)
        .replace(/<END_DATE>/g, endDateStr)
        .replace(/<YYYY-MM-DD>/g, targetDate));

    const condStr = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const orderStr = reportDef.orderings ? ` ORDER BY ${reportDef.orderings.join(', ')}` : '';

    return `SELECT ${fields} FROM ${reportDef.resource}${condStr}${orderStr}`;
}

async function run() {
    try {
        const token = await getAccessToken();
        const customerId = await getAccessibleCustomer(token);
        console.log(`Using customer ID: ${customerId}`);

        const doc = yaml.load(fs.readFileSync(REPORTS_YML, 'utf8')) as any;
        const reports = doc.reports;

        const reportPromises = Object.entries(reports).map(async ([reportName, reportDef]) => {
            const fileName = reportName.replace(/_/g, '-') + '.json';
            const filePath = path.join(DATA_DIR, fileName);
            console.log(`Running report: ${reportName}...`);

            try {
                const query = formatQuery(reportDef);
                const data = await executeGaql(token, customerId, query);
                fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
                console.log(` -> Saved to ${fileName} (${data.length} rows)`);
            } catch (err: any) {
                console.log(` -> Failed ${reportName}: ${err.message}`);
                fs.writeFileSync(filePath, JSON.stringify([])); // Write empty array on failure
            }
        });

        await Promise.all(reportPromises);

        console.log('All reports fetched. Rebuilding dashboard payload...');
        execSync(`bun run ${path.join(ROOT, 'scripts', 'build_dashboard_payload.ts')} --start-date ${startDateStr} --end-date ${endDateStr}`, { stdio: 'inherit' });

        console.log('Success! Exiting.');
    } catch (err) {
        console.error('Fatal error:', err);
        process.exit(1);
    }
}

run();
