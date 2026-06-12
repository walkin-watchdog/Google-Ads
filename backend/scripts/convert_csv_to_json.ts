import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { parseAuctionInsightsCsv, writeJsonAtomic } from '../lib/auctionInsights';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const defaultOutputPath = path.resolve(__dirname, '..', 'exports', 'auction-insights-domains.json');

const inputPath = process.argv[2] ? path.resolve(process.argv[2]) : null;

const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : defaultOutputPath;

if (!inputPath) {
    console.error('Pass an explicit Auction Insights CSV path: bun run scripts/convert_csv_to_json.ts /path/to/export.csv [/path/to/output.json]');
    process.exit(1);
}

const defaultCampaignName = process.env.AUCTION_INSIGHTS_DEFAULT_CAMPAIGN_NAME || undefined;
const parsed = parseAuctionInsightsCsv(fs.readFileSync(inputPath, 'utf8'), defaultCampaignName);

if (parsed.length === 0) {
    console.error('CSV parsed successfully, but no Auction Insights data rows were found.');
    process.exit(1);
}

writeJsonAtomic(outputPath, parsed);
console.log(`Wrote ${parsed.length} Auction Insights rows to ${outputPath}`);
