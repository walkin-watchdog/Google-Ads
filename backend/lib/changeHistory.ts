import crypto from 'crypto';
import { Pool } from 'pg';

export interface ChangeHistoryEvent {
    event_uid: string;
    change_date_time: string;
    campaign_id: string | null;
    ad_group_id: string | null;
    resource_type: string;
    operation: string;
    changed_fields: string[];
    client_type: string | null;
    user_email: string | null;
    payload: Record<string, any>;
}

function clean(value: any): string | null {
    const text = String(value ?? '').trim();
    return text || null;
}

function cleanId(value: any): string | null {
    const text = clean(value);
    if (!text || text === '0') return null;
    return text;
}

function parseChangedFields(value: any): string[] {
    if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function eventUid(row: Record<string, any>): string {
    const resourceName = clean(row['change_event.resource_name']);
    if (resourceName) return resourceName;
    const hash = crypto.createHash('sha256')
        .update(JSON.stringify({
            date: row['change_event.change_date_time'],
            campaign: row['campaign.id'],
            adGroup: row['ad_group.id'],
            type: row['change_event.change_resource_type'],
            operation: row['change_event.resource_change_operation'],
            changedFields: row['change_event.changed_fields'],
            payload: row
        }))
        .digest('hex');
    return `change_event_${hash}`;
}

export function normalizeChangeHistoryRows(rows: any[]): ChangeHistoryEvent[] {
    return rows
        .filter(row => row && typeof row === 'object')
        .map(row => ({
            event_uid: eventUid(row),
            change_date_time: String(row['change_event.change_date_time'] || ''),
            campaign_id: cleanId(row['campaign.id']),
            ad_group_id: cleanId(row['ad_group.id']),
            resource_type: String(row['change_event.change_resource_type'] || 'UNKNOWN'),
            operation: String(row['change_event.resource_change_operation'] || 'UNKNOWN'),
            changed_fields: parseChangedFields(row['change_event.changed_fields']),
            client_type: clean(row['change_event.client_type']),
            user_email: clean(row['change_event.user_email']),
            payload: row
        }))
        .filter(event => Boolean(event.change_date_time));
}

export async function ensureChangeHistorySchema(pool: Pool): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS google_ads_change_events (
            event_uid TEXT PRIMARY KEY,
            change_date_time TIMESTAMP NOT NULL,
            campaign_id VARCHAR(100),
            ad_group_id VARCHAR(100),
            resource_type VARCHAR(80),
            operation VARCHAR(40),
            changed_fields JSONB DEFAULT '[]'::jsonb,
            client_type VARCHAR(120),
            user_email TEXT,
            payload JSONB DEFAULT '{}'::jsonb,
            fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS google_ads_change_events_date_idx ON google_ads_change_events(change_date_time);
        CREATE INDEX IF NOT EXISTS google_ads_change_events_campaign_idx ON google_ads_change_events(campaign_id);
        CREATE INDEX IF NOT EXISTS google_ads_change_events_ad_group_idx ON google_ads_change_events(ad_group_id);
    `);
}

export async function archiveChangeHistoryRows(pool: Pool, rows: any[]): Promise<number> {
    const events = normalizeChangeHistoryRows(rows);
    if (events.length === 0) return 0;
    await ensureChangeHistorySchema(pool);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const BATCH_SIZE = 100;
        for (let i = 0; i < events.length; i += BATCH_SIZE) {
            const batch = events.slice(i, i + BATCH_SIZE);
            const valueStrings: string[] = [];
            const values: any[] = [];

            batch.forEach((event, index) => {
                const offset = index * 10;
                valueStrings.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, CURRENT_TIMESTAMP)`);
                values.push(
                    event.event_uid,
                    event.change_date_time,
                    event.campaign_id,
                    event.ad_group_id,
                    event.resource_type,
                    event.operation,
                    JSON.stringify(event.changed_fields),
                    event.client_type,
                    event.user_email,
                    event.payload
                );
            });

            const query = `
                INSERT INTO google_ads_change_events
                (event_uid, change_date_time, campaign_id, ad_group_id, resource_type, operation, changed_fields, client_type, user_email, payload, fetched_at)
                VALUES ${valueStrings.join(', ')}
                ON CONFLICT (event_uid) DO UPDATE SET
                    change_date_time = EXCLUDED.change_date_time,
                    campaign_id = EXCLUDED.campaign_id,
                    ad_group_id = EXCLUDED.ad_group_id,
                    resource_type = EXCLUDED.resource_type,
                    operation = EXCLUDED.operation,
                    changed_fields = EXCLUDED.changed_fields,
                    client_type = EXCLUDED.client_type,
                    user_email = EXCLUDED.user_email,
                    payload = EXCLUDED.payload,
                    fetched_at = CURRENT_TIMESTAMP
            `;

            await client.query(query, values);
        }

        await client.query('COMMIT');
        return events.length;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

export async function getChangeHistoryEvents(pool: Pool, input: {
    start: Date;
    end: Date;
    campaignId?: string | null;
    adGroupId?: string | null;
}): Promise<ChangeHistoryEvent[]> {
    await ensureChangeHistorySchema(pool);
    const params: any[] = [input.start.toISOString(), input.end.toISOString()];
    const conditions = ['change_date_time >= $1::timestamp', 'change_date_time < $2::timestamp'];
    const campaignId = clean(input.campaignId);
    const adGroupId = clean(input.adGroupId);
    if (campaignId) {
        params.push(campaignId);
        conditions.push(`(campaign_id = $${params.length} OR campaign_id IS NULL)`);
    }
    if (adGroupId) {
        params.push(adGroupId);
        conditions.push(`(ad_group_id = $${params.length} OR ad_group_id IS NULL)`);
    }
    const { rows } = await pool.query(
        `SELECT event_uid, change_date_time, campaign_id, ad_group_id, resource_type, operation, changed_fields, client_type, user_email, payload
         FROM google_ads_change_events
         WHERE ${conditions.join(' AND ')}
         ORDER BY change_date_time ASC`,
        params
    );
    return rows.map(row => ({
        event_uid: row.event_uid,
        change_date_time: row.change_date_time instanceof Date ? row.change_date_time.toISOString() : String(row.change_date_time),
        campaign_id: row.campaign_id,
        ad_group_id: row.ad_group_id,
        resource_type: row.resource_type || 'UNKNOWN',
        operation: row.operation || 'UNKNOWN',
        changed_fields: Array.isArray(row.changed_fields) ? row.changed_fields : parseChangedFields(row.changed_fields),
        client_type: row.client_type,
        user_email: row.user_email,
        payload: row.payload || {}
    }));
}
