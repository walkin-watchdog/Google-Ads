import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { fetchLatestSheetRowsByName } from './googleSheets';

export type AuctionInsightsEntityType = 'account' | 'campaign' | 'ad_group';

export interface AuctionInsightsEntity {
    entityType: AuctionInsightsEntityType;
    entityId: string;
    entityName: string;
    campaignId?: string | null;
    campaignName?: string | null;
    adGroupId?: string | null;
    adGroupName?: string | null;
    enabled?: boolean;
}

export interface AuctionInsightsSetting {
    entityType: AuctionInsightsEntityType;
    entityId: string;
    entityName?: string | null;
    sheetName?: string | null;
    enabled?: boolean;
}

export interface AuctionInsightsEntityStatus extends AuctionInsightsEntity {
    status: 'ok' | 'missing_credentials' | 'missing_sheet' | 'fetch_failed' | 'empty';
    sheetName: string | null;
    rows: number;
    message: string;
    spreadsheetId?: string | null;
    spreadsheetModifiedTime?: string | null;
}

export interface AuctionInsightsFetchResult {
    rows: Record<string, any>[];
    statuses: AuctionInsightsEntityStatus[];
    source: 'sheets' | 'none';
    message: string;
}

const HEADER_ALIASES: Record<string, string> = {
    'display url domain': 'segments.auction_insight_domain',
    'impression share': 'metrics.auction_insight_search_impression_share',
    'overlap rate': 'metrics.auction_insight_search_overlap_rate',
    'position above rate': 'metrics.auction_insight_search_position_above_rate',
    'top of page rate': 'metrics.auction_insight_search_top_impression_percentage',
    'abs. top of page rate': 'metrics.auction_insight_search_absolute_top_impression_percentage',
    'absolute top of page rate': 'metrics.auction_insight_search_absolute_top_impression_percentage',
    'outranking share': 'metrics.auction_insight_search_outranking_share',
    'day': 'segments.date',
    'week': 'segments.week',
    'month': 'segments.month',
    'quarter': 'segments.quarter',
    'year': 'segments.year',
    'day of the week': 'segments.day_of_week',
    'campaign': 'campaign.name',
    'campaign name': 'campaign.name',
    'ad group': 'ad_group.name',
    'ad group name': 'ad_group.name'
};

function normalizeHeader(value: string): string {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function clean(value: any): string | null {
    const text = String(value ?? '').trim();
    return text || null;
}

function normalizeSheetValuesRange(value: any): string {
    const range = clean(value) || 'A:Z';
    const sheetSeparator = range.lastIndexOf('!');
    if (sheetSeparator < 0) return range;
    return clean(range.slice(sheetSeparator + 1)) || 'A:Z';
}

function parseMetric(value: string): number | null {
    const raw = String(value ?? '').trim();
    if (!raw || raw === '--') return null;
    if (raw.startsWith('<')) {
        const n = Number(raw.replace(/[<%\s,]/g, ''));
        return Number.isFinite(n) ? Math.max((n / 100) - 0.0001, 0) : null;
    }
    const n = Number(raw.replace(/[%\s,]/g, ''));
    if (!Number.isFinite(n)) return null;
    return raw.includes('%') ? n / 100 : n;
}

export function parseCsvRows(csvText: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < csvText.length; i++) {
        const ch = csvText[i];
        const next = csvText[i + 1];
        if (ch === '"' && inQuotes && next === '"') {
            field += '"';
            i++;
        } else if (ch === '"') {
            inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) {
            row.push(field);
            field = '';
        } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
            if (ch === '\r' && next === '\n') i++;
            row.push(field);
            if (row.some(cell => cell.trim() !== '')) rows.push(row);
            row = [];
            field = '';
        } else {
            field += ch;
        }
    }
    row.push(field);
    if (row.some(cell => cell.trim() !== '')) rows.push(row);
    return rows;
}

function entityFromDefault(input?: string | AuctionInsightsEntity): AuctionInsightsEntity | null {
    if (!input) return null;
    if (typeof input === 'string') {
        return {
            entityType: 'campaign',
            entityId: input,
            entityName: input,
            campaignName: input
        };
    }
    return input;
}

export function parseAuctionInsightsRows(rows: string[][], entityInput?: string | AuctionInsightsEntity): Record<string, any>[] {
    const entity = entityFromDefault(entityInput);
    const headerIndex = rows.findIndex(row => row.map(normalizeHeader).includes('display url domain'));
    if (headerIndex < 0) {
        throw new Error('Auction Insights header row not found. Expected a "Display URL domain" column.');
    }

    const headers = rows[headerIndex].map(normalizeHeader);
    const output: Record<string, any>[] = [];

    for (const row of rows.slice(headerIndex + 1)) {
        const parsed: Record<string, any> = {};
        const rawValues: Record<string, string> = {};
        for (let i = 0; i < headers.length; i++) {
            const header = headers[i];
            const key = HEADER_ALIASES[header];
            if (!key) continue;
            const raw = String(row[i] ?? '').trim();
            if (!raw && key !== 'campaign.name' && key !== 'ad_group.name') continue;
            rawValues[header] = raw;
            if (key.startsWith('metrics.')) parsed[key] = parseMetric(raw);
            else parsed[key] = raw;
        }

        if (!parsed['segments.auction_insight_domain']) continue;
        parsed['auction_insights.source_scope'] = entity?.entityType || (parsed['campaign.name'] ? 'campaign' : 'account');
        parsed['auction_insights.entity_id'] = entity?.entityId || null;
        parsed['auction_insights.entity_name'] = entity?.entityName || null;
        parsed['auction_insights.raw_values'] = rawValues;

        if (entity?.campaignId) parsed['campaign.id'] = entity.campaignId;
        if (entity?.campaignName && !parsed['campaign.name']) parsed['campaign.name'] = entity.campaignName;
        if (entity?.adGroupId) parsed['ad_group.id'] = entity.adGroupId;
        if (entity?.adGroupName && !parsed['ad_group.name']) parsed['ad_group.name'] = entity.adGroupName;
        output.push(parsed);
    }
    return output;
}

export function parseAuctionInsightsCsv(csvText: string, defaultCampaignName?: string): Record<string, any>[] {
    return parseAuctionInsightsRows(parseCsvRows(csvText), defaultCampaignName);
}

export function writeJsonAtomic(filePath: string, data: any): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tempPath, filePath);
}

export async function ensureAuctionInsightsSettingsSchema(pool: Pool): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS auction_insights_settings (
            entity_type VARCHAR(30) NOT NULL,
            entity_id VARCHAR(120) NOT NULL,
            entity_name TEXT,
            sheet_name TEXT,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (entity_type, entity_id)
        );
        CREATE INDEX IF NOT EXISTS auction_insights_settings_enabled_idx ON auction_insights_settings(enabled);
    `);
}

function normalizeEntityType(value: any): AuctionInsightsEntityType {
    const text = String(value || '').trim().toLowerCase();
    if (text === 'account' || text === 'campaign' || text === 'ad_group') return text;
    throw new Error(`Unsupported Auction Insights entity type: ${value}`);
}

export async function getAuctionInsightsSettings(pool: Pool): Promise<AuctionInsightsSetting[]> {
    await ensureAuctionInsightsSettingsSchema(pool);
    const { rows } = await pool.query(
        `SELECT entity_type, entity_id, entity_name, sheet_name, enabled
         FROM auction_insights_settings
         ORDER BY entity_type ASC, entity_name ASC, entity_id ASC`
    );
    return rows.map(row => ({
        entityType: normalizeEntityType(row.entity_type),
        entityId: String(row.entity_id),
        entityName: row.entity_name,
        sheetName: row.sheet_name,
        enabled: row.enabled !== false
    }));
}

export async function upsertAuctionInsightsSettings(pool: Pool, settings: AuctionInsightsSetting[]): Promise<AuctionInsightsSetting[]> {
    await ensureAuctionInsightsSettingsSchema(pool);
    if (!Array.isArray(settings)) throw new Error('settings must be an array.');
    const saved: AuctionInsightsSetting[] = [];
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const setting of settings) {
            const entityType = normalizeEntityType(setting.entityType);
            const entityId = clean(setting.entityId);
            if (!entityId) throw new Error('Auction Insights setting requires entityId.');
            const entityName = clean(setting.entityName);
            const sheetName = clean(setting.sheetName);
            const enabled = setting.enabled !== false;
            await client.query(
                `INSERT INTO auction_insights_settings (entity_type, entity_id, entity_name, sheet_name, enabled, updated_at)
                 VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
                 ON CONFLICT (entity_type, entity_id) DO UPDATE SET
                    entity_name = EXCLUDED.entity_name,
                    sheet_name = EXCLUDED.sheet_name,
                    enabled = EXCLUDED.enabled,
                    updated_at = CURRENT_TIMESTAMP`,
                [entityType, entityId, entityName, sheetName, enabled]
            );
            saved.push({ entityType, entityId, entityName, sheetName, enabled });
        }
        await client.query('COMMIT');
        return saved;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

export function buildAuctionInsightsEntities(dashboardPayload: any): AuctionInsightsEntity[] {
    const accountId = clean(dashboardPayload?.meta?.accountId) || 'account';
    const entities = new Map<string, AuctionInsightsEntity>();
    entities.set(`account:${accountId}`, {
        entityType: 'account',
        entityId: accountId,
        entityName: 'Account level',
        enabled: true
    });

    for (const campaign of Array.isArray(dashboardPayload?.campaigns) ? dashboardPayload.campaigns : []) {
        if (campaign.status === 'REMOVED') continue;
        const id = clean(campaign.id || campaign.campaignId);
        const name = clean(campaign.name || campaign.campaign);
        if (!id || !name) continue;
        entities.set(`campaign:${id}`, {
            entityType: 'campaign',
            entityId: id,
            entityName: name,
            campaignId: id,
            campaignName: name,
            enabled: campaign.status !== 'REMOVED'
        });
    }

    for (const adGroup of Array.isArray(dashboardPayload?.adGroups) ? dashboardPayload.adGroups : []) {
        if (adGroup.status === 'REMOVED') continue;
        const id = clean(adGroup.id || adGroup.adGroupId);
        const name = clean(adGroup.name || adGroup.adGroup);
        const campaignId = clean(adGroup.campaignId);
        const campaignName = clean(adGroup.campaign);
        if (!id || !name) continue;
        entities.set(`ad_group:${id}`, {
            entityType: 'ad_group',
            entityId: id,
            entityName: campaignName ? `${campaignName} / ${name}` : name,
            campaignId,
            campaignName,
            adGroupId: id,
            adGroupName: name,
            enabled: adGroup.status !== 'REMOVED'
        });
    }

    return Array.from(entities.values());
}

function settingsMap(settings: AuctionInsightsSetting[]): Map<string, AuctionInsightsSetting> {
    return new Map(settings.map(setting => [`${setting.entityType}:${setting.entityId}`, setting]));
}

function statusFor(entity: AuctionInsightsEntity, status: AuctionInsightsEntityStatus['status'], sheetName: string | null, message: string, rows = 0, extra: Partial<AuctionInsightsEntityStatus> = {}): AuctionInsightsEntityStatus {
    return {
        ...entity,
        status,
        sheetName,
        rows,
        message,
        spreadsheetId: extra.spreadsheetId || null,
        spreadsheetModifiedTime: extra.spreadsheetModifiedTime || null
    };
}

export async function fetchAuctionInsightsFeed(outputPath: string, options: {
    pool?: Pool | null;
    entities: AuctionInsightsEntity[];
    statusOutputPath?: string;
}): Promise<AuctionInsightsFetchResult> {
    const refreshToken = process.env.GOOGLE_SHEETS_REFRESH_TOKEN || '';
    const range = normalizeSheetValuesRange(process.env.GOOGLE_SHEETS_RANGE);
    const entities = options.entities.filter(entity => entity.enabled !== false);
    const statusOutputPath = options.statusOutputPath || outputPath.replace(/\.json$/, '-status.json');

    if (!refreshToken.trim()) {
        const statuses = entities.map(entity => statusFor(
            entity,
            'missing_credentials',
            null,
            'GOOGLE_SHEETS_REFRESH_TOKEN is missing. Add it to .env / Render environment variables.'
        ));
        writeJsonAtomic(outputPath, []);
        writeJsonAtomic(statusOutputPath, statuses);
        return { rows: [], statuses, source: 'none', message: 'GOOGLE_SHEETS_REFRESH_TOKEN is missing; Auction Insights rows were cleared.' };
    }

    const settings = options.pool ? await getAuctionInsightsSettings(options.pool) : [];
    const byEntity = settingsMap(settings);
    const allRows: Record<string, any>[] = [];
    const statuses: AuctionInsightsEntityStatus[] = [];

    for (const entity of entities) {
        const setting = byEntity.get(`${entity.entityType}:${entity.entityId}`);
        const sheetName = clean(setting?.sheetName);
        if (!sheetName) {
            statuses.push(statusFor(
                entity,
                'missing_sheet',
                null,
                `Add a Google Sheet name for ${entity.entityName}.`
            ));
            continue;
        }

        try {
            const result = await fetchLatestSheetRowsByName({
                spreadsheetName: sheetName,
                range,
                refreshToken
            });
            const parsed = parseAuctionInsightsRows(result.rows, entity);
            allRows.push(...parsed);
            statuses.push(statusFor(
                entity,
                parsed.length ? 'ok' : 'empty',
                sheetName,
                parsed.length
                    ? `Fetched ${parsed.length} rows from latest matching sheet "${sheetName}".`
                    : `Latest matching sheet "${sheetName}" had a valid header but no Auction Insights rows.`,
                parsed.length,
                {
                    spreadsheetId: result.file.id,
                    spreadsheetModifiedTime: result.file.modifiedTime || result.file.createdTime || null
                }
            ));
        } catch (err: any) {
            statuses.push(statusFor(
                entity,
                'fetch_failed',
                sheetName,
                `Could not fetch "${sheetName}". Verify sheet name, OAuth credentials, Drive access, and sharing. ${err?.message || err}`
            ));
        }
    }

    writeJsonAtomic(outputPath, allRows);
    writeJsonAtomic(statusOutputPath, statuses);
    const okCount = statuses.filter(status => status.status === 'ok').length;
    return {
        rows: allRows,
        statuses,
        source: allRows.length ? 'sheets' : 'none',
        message: `Fetched ${allRows.length} Auction Insights rows from ${okCount}/${entities.length} configured Google Sheet sources.`
    };
}
