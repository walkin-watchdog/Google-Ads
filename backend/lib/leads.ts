import crypto from 'crypto';
import { Pool } from 'pg';

export const LEAD_STATUSES = ['new', 'qualified', 'converted', 'qualified_lost', 'useless'] as const;
export type LeadStatus = typeof LEAD_STATUSES[number];

const STATUS_RANK: Record<LeadStatus, number> = {
    new: 0,
    qualified: 1,
    qualified_lost: 2,
    useless: 3,
    converted: 4
};

const TERMINAL_STATUSES = new Set<LeadStatus>(['converted', 'qualified_lost', 'useless']);
const leadSchemaReadyByPool = new WeakMap<object, Promise<void>>();

type LeadAttributionSummaryMode = 'full' | 'overview';
type LeadAttributionSummaryOptions = {
    mode?: LeadAttributionSummaryMode;
};

type LeadAttributionOverviewCacheEntry = {
    expiresAt: number;
    summary: any;
};

const DEFAULT_LEAD_ATTRIBUTION_OVERVIEW_CACHE_SECONDS = 60;
const leadAttributionOverviewCache = new Map<string, LeadAttributionOverviewCacheEntry>();

export class LeadValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LeadValidationError';
    }
}

export interface NormalizedLeadEvent {
    event_id: string;
    session_key: string;
    session_key_type: string;
    kind: string | null;
    lead_id: string | null;
    session_id: string | null;
    gclid: string | null;
    gbraid: string | null;
    wbraid: string | null;
    utm_source: string | null;
    utm_medium: string | null;
    utm_campaign: string | null;
    ad_group_id: string | null;
    utm_term: string | null;
    utm_content: string | null;
    keyword: string | null;
    match_type: string | null;
    name: string | null;
    email: string | null;
    phone: string | null;
    status: LeadStatus;
    submitted_at: string | null;
    payload: any;
}

function clean(value: any): string | null {
    const text = String(value ?? '').trim();
    return text || null;
}

function cleanDate(value: any): string | null {
    const text = clean(value);
    return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function firstClean(...values: any[]): string | null {
    for (const value of values) {
        const cleaned = clean(value);
        if (cleaned) return cleaned;
    }
    return null;
}

function normalizeMatchType(value: any): string | null {
    const text = clean(value);
    if (!text) return null;
    const normalized = text.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (['e', 'exact'].includes(normalized)) return 'EXACT';
    if (['p', 'phrase'].includes(normalized)) return 'PHRASE';
    if (['b', 'broad'].includes(normalized)) return 'BROAD';
    return normalized.toUpperCase();
}

function matchTypeFromUtmContent(value: any): string | null {
    const text = clean(value);
    if (!text) return null;
    const suffix = text.includes('-') ? text.split('-').pop() : text;
    return normalizeMatchType(suffix);
}

function normalizeStatus(value: any): LeadStatus {
    const text = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (['useless', 'junk', 'invalid', 'spam', 'bad_fit', 'bad'].includes(text)) return 'useless';
    if (['qualified_lost', 'lost', 'closed_lost', 'qualified_and_lost', 'qualified_lost_lead'].includes(text)) return 'qualified_lost';
    if (['qualified', 'qualified_lead', 'sql', 'mql'].includes(text)) return 'qualified';
    if (['converted', 'qualified_converted', 'qualified_and_converted', 'customer', 'won', 'paid'].includes(text)) return 'converted';
    return 'new';
}

function parseSubmittedAt(value: any): string | null {
    const text = clean(value);
    if (!text) return null;
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function pickBody(raw: any): any {
    return raw?.webhook?.request?.body
        || raw?.request?.body
        || raw?.body
        || raw;
}

function sessionKeyFor(body: any): { key: string; type: string } {
    const candidates = [
        ['session_id', body.session_id],
        ['gclid', body.gclid],
        ['gbraid', body.gbraid],
        ['wbraid', body.wbraid],
        ['lead_id', body.lead_id]
    ];
    for (const [type, value] of candidates) {
        const cleaned = clean(value);
        if (cleaned) return { key: `${type}:${cleaned}`, type };
    }
    throw new LeadValidationError('Lead webhook requires at least one of session_id, gclid, gbraid, wbraid, or lead_id.');
}

function eventIdFor(raw: any, body: any, sessionKey: string): string {
    const explicit = clean(raw?.webhook?.id) || clean(raw?.triggerWebhookId) || clean(body.event_id);
    if (explicit) return explicit.slice(0, 160);
    const hash = crypto.createHash('sha256')
        .update(JSON.stringify({
            sessionKey,
            kind: body.kind || null,
            lead_id: body.lead_id || null,
            submittedAt: body.submittedAt || body.submitted_at || null,
            payload: body
        }))
        .digest('hex');
    return `lead_evt_${hash}`;
}

export function normalizeLeadWebhookPayload(raw: any): NormalizedLeadEvent {
    if (!raw || typeof raw !== 'object') throw new LeadValidationError('Lead webhook payload must be a JSON object.');
    const body = pickBody(raw);
    if (!body || typeof body !== 'object') throw new LeadValidationError('Lead webhook body must be a JSON object.');

    const session = sessionKeyFor(body);
    const googleAds = body.google_ads || body.googleAds || {};
    const attribution = body.attribution || body.ads || {};
    const utmTerm = clean(body.utm_term);
    const utmContent = clean(body.utm_content);
    const phone = firstClean(body.fullPhoneNumber, body.phoneNumber, body.phone, body.contact_number, body.contactNumber);
    const status = normalizeStatus(body.status || body.lead_status || body.manual_status || body.quality_status);
    return {
        event_id: eventIdFor(raw, body, session.key),
        session_key: session.key,
        session_key_type: session.type,
        kind: clean(body.kind),
        lead_id: clean(body.lead_id),
        session_id: clean(body.session_id),
        gclid: clean(body.gclid),
        gbraid: clean(body.gbraid),
        wbraid: clean(body.wbraid),
        utm_source: clean(body.utm_source),
        utm_medium: clean(body.utm_medium),
        utm_campaign: clean(body.utm_campaign),
        ad_group_id: firstClean(
            body.ad_group_id,
            body.adGroupId,
            body.google_ad_group_id,
            body.googleAdGroupId,
            googleAds.ad_group_id,
            googleAds.adGroupId,
            attribution.ad_group_id,
            attribution.adGroupId,
            body.utm_ad_group,
            body.utm_adgroup
        ),
        utm_term: utmTerm,
        utm_content: utmContent,
        keyword: firstClean(
            body.keyword,
            body.keyword_text,
            body.keywordText,
            body.matched_keyword,
            body.matchedKeyword,
            body.google_keyword,
            body.googleKeyword,
            googleAds.keyword,
            googleAds.keyword_text,
            googleAds.keywordText,
            attribution.keyword,
            attribution.keyword_text,
            attribution.keywordText,
            utmTerm
        ),
        match_type: normalizeMatchType(firstClean(
            body.match_type,
            body.matchType,
            body.keyword_match_type,
            body.keywordMatchType,
            body.google_match_type,
            body.googleMatchType,
            googleAds.match_type,
            googleAds.matchType,
            googleAds.keyword_match_type,
            googleAds.keywordMatchType,
            attribution.match_type,
            attribution.matchType
        )) || matchTypeFromUtmContent(utmContent),
        name: clean(body.name),
        email: clean(body.email),
        phone,
        status,
        submitted_at: parseSubmittedAt(body.submittedAt || body.submitted_at),
        payload: raw
    };
}

export async function ensureLeadSchema(pool: Pool): Promise<void> {
    const key = pool as unknown as object;
    const existing = leadSchemaReadyByPool.get(key);
    if (existing) return existing;
    const ready = ensureLeadSchemaInternal(pool).catch(err => {
        leadSchemaReadyByPool.delete(key);
        throw err;
    });
    leadSchemaReadyByPool.set(key, ready);
    return ready;
}

async function ensureLeadSchemaInternal(pool: Pool): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS lead_events (
            event_id VARCHAR(160) PRIMARY KEY,
            session_key VARCHAR(220) NOT NULL,
            session_key_type VARCHAR(40) NOT NULL,
            kind VARCHAR(80),
            lead_id VARCHAR(120),
            session_id VARCHAR(120),
            gclid TEXT,
            gbraid TEXT,
            wbraid TEXT,
            utm_source TEXT,
            utm_medium TEXT,
            utm_campaign TEXT,
            ad_group_id TEXT,
            utm_term TEXT,
            utm_content TEXT,
            keyword TEXT,
            match_type TEXT,
            name TEXT,
            email TEXT,
            phone TEXT,
            status VARCHAR(40) NOT NULL DEFAULT 'new',
            status_rank INTEGER NOT NULL DEFAULT 0,
            submitted_at TIMESTAMP,
            received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            payload JSONB NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE INDEX IF NOT EXISTS lead_events_session_key_idx ON lead_events(session_key);
        CREATE INDEX IF NOT EXISTS lead_events_session_key_time_idx
            ON lead_events(session_key, (COALESCE(submitted_at, received_at)), received_at);
        CREATE INDEX IF NOT EXISTS lead_events_utm_campaign_idx ON lead_events(utm_campaign);
        CREATE INDEX IF NOT EXISTS lead_events_utm_term_idx ON lead_events(utm_term);
        ALTER TABLE lead_events ADD COLUMN IF NOT EXISTS ad_group_id TEXT;
        ALTER TABLE lead_events ADD COLUMN IF NOT EXISTS keyword TEXT;
        ALTER TABLE lead_events ADD COLUMN IF NOT EXISTS match_type TEXT;
        CREATE INDEX IF NOT EXISTS lead_events_ad_group_id_idx ON lead_events(ad_group_id);
        UPDATE lead_events
        SET
            ad_group_id = COALESCE(
                ad_group_id,
                NULLIF(payload #>> '{webhook,request,body,ad_group_id}', ''),
                NULLIF(payload #>> '{webhook,request,body,adGroupId}', ''),
                NULLIF(payload #>> '{request,body,ad_group_id}', ''),
                NULLIF(payload #>> '{request,body,adGroupId}', ''),
                NULLIF(payload #>> '{body,ad_group_id}', ''),
                NULLIF(payload #>> '{body,adGroupId}', ''),
                NULLIF(payload #>> '{body,google_ads,ad_group_id}', ''),
                NULLIF(payload #>> '{body,googleAds,adGroupId}', ''),
                NULLIF(payload #>> '{body,attribution,ad_group_id}', ''),
                NULLIF(payload #>> '{body,attribution,adGroupId}', ''),
                NULLIF(payload ->> 'ad_group_id', ''),
                NULLIF(payload ->> 'adGroupId', ''),
                NULLIF(payload ->> 'utm_ad_group', ''),
                NULLIF(payload ->> 'utm_adgroup', '')
            ),
            keyword = COALESCE(
                keyword,
                NULLIF(payload #>> '{webhook,request,body,keyword}', ''),
                NULLIF(payload #>> '{webhook,request,body,keyword_text}', ''),
                NULLIF(payload #>> '{webhook,request,body,keywordText}', ''),
                NULLIF(payload #>> '{request,body,keyword}', ''),
                NULLIF(payload #>> '{request,body,keyword_text}', ''),
                NULLIF(payload #>> '{body,keyword}', ''),
                NULLIF(payload #>> '{body,keyword_text}', ''),
                NULLIF(payload ->> 'keyword', ''),
                NULLIF(payload ->> 'keyword_text', ''),
                NULLIF(utm_term, ''),
                NULLIF(payload #>> '{webhook,request,body,utm_term}', ''),
                NULLIF(payload #>> '{request,body,utm_term}', ''),
                NULLIF(payload #>> '{body,utm_term}', ''),
                NULLIF(payload ->> 'utm_term', '')
            ),
            match_type = COALESCE(
                match_type,
                NULLIF(UPPER(REPLACE(payload #>> '{webhook,request,body,match_type}', ' ', '_')), ''),
                NULLIF(UPPER(REPLACE(payload #>> '{webhook,request,body,matchType}', ' ', '_')), ''),
                NULLIF(UPPER(REPLACE(payload #>> '{webhook,request,body,keyword_match_type}', ' ', '_')), ''),
                NULLIF(UPPER(REPLACE(payload #>> '{request,body,match_type}', ' ', '_')), ''),
                NULLIF(UPPER(REPLACE(payload #>> '{body,match_type}', ' ', '_')), ''),
                NULLIF(UPPER(REPLACE(payload ->> 'match_type', ' ', '_')), ''),
                NULLIF(UPPER(REPLACE(payload ->> 'matchType', ' ', '_')), ''),
                CASE LOWER(substring(COALESCE(
                    NULLIF(utm_content, ''),
                    NULLIF(payload #>> '{webhook,request,body,utm_content}', ''),
                    NULLIF(payload #>> '{request,body,utm_content}', ''),
                    NULLIF(payload #>> '{body,utm_content}', ''),
                    NULLIF(payload ->> 'utm_content', ''),
                    ''
                ) from '-([^-]+)$'))
                    WHEN 'e' THEN 'EXACT'
                    WHEN 'exact' THEN 'EXACT'
                    WHEN 'p' THEN 'PHRASE'
                    WHEN 'phrase' THEN 'PHRASE'
                    WHEN 'b' THEN 'BROAD'
                    WHEN 'broad' THEN 'BROAD'
                    ELSE NULL
                END
            )
        WHERE ad_group_id IS NULL OR keyword IS NULL OR match_type IS NULL;

        CREATE TABLE IF NOT EXISTS lead_sessions (
            session_key VARCHAR(220) PRIMARY KEY,
            session_key_type VARCHAR(40) NOT NULL,
            status VARCHAR(40) NOT NULL DEFAULT 'new',
            status_rank INTEGER NOT NULL DEFAULT 0,
            first_seen TIMESTAMP NOT NULL,
            last_seen TIMESTAMP NOT NULL,
            event_count INTEGER NOT NULL DEFAULT 0,
            lead_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
            contact JSONB NOT NULL DEFAULT '{}'::jsonb,
            attribution JSONB NOT NULL DEFAULT '{}'::jsonb,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS lead_sessions_status_idx ON lead_sessions(status);
        CREATE INDEX IF NOT EXISTS lead_sessions_first_seen_idx ON lead_sessions(first_seen);
        CREATE INDEX IF NOT EXISTS lead_sessions_last_seen_idx ON lead_sessions(last_seen DESC);
        CREATE INDEX IF NOT EXISTS lead_sessions_utm_campaign_expr_idx ON lead_sessions ((attribution->>'utm_campaign'));
        CREATE INDEX IF NOT EXISTS lead_sessions_ad_group_expr_idx ON lead_sessions ((attribution->>'ad_group_id'));
    `);
}

async function rebuildLeadSession(pool: Pool, sessionKey: string): Promise<void> {
    const { rows } = await pool.query(
        `SELECT *
         FROM lead_events
         WHERE session_key = $1
         ORDER BY COALESCE(submitted_at, received_at) ASC, received_at ASC`,
        [sessionKey]
    );
    if (rows.length === 0) return;

    const first = rows[0];
    const latest = rows[rows.length - 1];
    const reversedRows = [...rows].reverse();
    const latestStatusRow = reversedRows.find(row => row.status && row.status !== 'new') || first;
    const leadIds = Array.from(new Set(rows.map(row => row.lead_id).filter(Boolean)));
    const firstValue = (field: string) => clean(rows.find(row => clean(row[field]))?.[field]);
    const latestValue = (field: string) => clean(reversedRows.find(row => clean(row[field]))?.[field]);
    const attributionSource = rows.find(row => row.utm_campaign || row.ad_group_id || row.utm_term || row.gclid || row.gbraid || row.wbraid || row.keyword || row.match_type) || first;
    const utmContent = firstValue('utm_content') || attributionSource.utm_content || null;
    const firstSeen = first.submitted_at || first.received_at;
    const lastSeen = latest.submitted_at || latest.received_at;

    await pool.query(
        `INSERT INTO lead_sessions
         (session_key, session_key_type, status, status_rank, first_seen, last_seen, event_count, lead_ids, contact, attribution, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
         ON CONFLICT (session_key) DO UPDATE SET
            session_key_type = EXCLUDED.session_key_type,
            status = EXCLUDED.status,
            status_rank = EXCLUDED.status_rank,
            first_seen = EXCLUDED.first_seen,
            last_seen = EXCLUDED.last_seen,
            event_count = EXCLUDED.event_count,
            lead_ids = EXCLUDED.lead_ids,
            contact = EXCLUDED.contact,
            attribution = EXCLUDED.attribution,
            updated_at = CURRENT_TIMESTAMP`,
        [
            sessionKey,
            first.session_key_type,
            latestStatusRow.status,
            latestStatusRow.status_rank,
            firstSeen,
            lastSeen,
            rows.length,
            JSON.stringify(leadIds),
            {
                name: latestValue('name'),
                email: latestValue('email'),
                phone: latestValue('phone')
            },
            {
                utm_source: firstValue('utm_source') || attributionSource.utm_source || null,
                utm_medium: firstValue('utm_medium') || attributionSource.utm_medium || null,
                utm_campaign: firstValue('utm_campaign') || attributionSource.utm_campaign || null,
                ad_group_id: firstValue('ad_group_id') || attributionSource.ad_group_id || null,
                utm_term: firstValue('utm_term') || attributionSource.utm_term || null,
                utm_content: utmContent,
                keyword: firstValue('keyword') || attributionSource.keyword || firstValue('utm_term') || attributionSource.utm_term || null,
                match_type: firstValue('match_type') || attributionSource.match_type || matchTypeFromUtmContent(utmContent),
                gclid: firstValue('gclid') || attributionSource.gclid || null,
                gbraid: firstValue('gbraid') || attributionSource.gbraid || null,
                wbraid: firstValue('wbraid') || attributionSource.wbraid || null
            }
        ]
    );
}

export async function upsertLeadWebhookEvent(pool: Pool, raw: any): Promise<NormalizedLeadEvent> {
    await ensureLeadSchema(pool);
    const event = normalizeLeadWebhookPayload(raw);
    await pool.query(
        `INSERT INTO lead_events
         (event_id, session_key, session_key_type, kind, lead_id, session_id, gclid, gbraid, wbraid,
          utm_source, utm_medium, utm_campaign, ad_group_id, utm_term, utm_content, keyword, match_type, name, email, phone,
          status, status_rank, submitted_at, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
         ON CONFLICT (event_id) DO UPDATE SET
            kind = COALESCE(EXCLUDED.kind, lead_events.kind),
            lead_id = COALESCE(EXCLUDED.lead_id, lead_events.lead_id),
            session_id = COALESCE(EXCLUDED.session_id, lead_events.session_id),
            gclid = COALESCE(EXCLUDED.gclid, lead_events.gclid),
            gbraid = COALESCE(EXCLUDED.gbraid, lead_events.gbraid),
            wbraid = COALESCE(EXCLUDED.wbraid, lead_events.wbraid),
            utm_source = COALESCE(EXCLUDED.utm_source, lead_events.utm_source),
            utm_medium = COALESCE(EXCLUDED.utm_medium, lead_events.utm_medium),
            utm_campaign = COALESCE(EXCLUDED.utm_campaign, lead_events.utm_campaign),
            ad_group_id = COALESCE(EXCLUDED.ad_group_id, lead_events.ad_group_id),
            utm_term = COALESCE(EXCLUDED.utm_term, lead_events.utm_term),
            utm_content = COALESCE(EXCLUDED.utm_content, lead_events.utm_content),
            keyword = COALESCE(EXCLUDED.keyword, lead_events.keyword),
            match_type = COALESCE(EXCLUDED.match_type, lead_events.match_type),
            name = COALESCE(EXCLUDED.name, lead_events.name),
            email = COALESCE(EXCLUDED.email, lead_events.email),
            phone = COALESCE(EXCLUDED.phone, lead_events.phone),
            status = EXCLUDED.status,
            status_rank = EXCLUDED.status_rank,
            submitted_at = COALESCE(EXCLUDED.submitted_at, lead_events.submitted_at),
            payload = EXCLUDED.payload`,
        [
            event.event_id,
            event.session_key,
            event.session_key_type,
            event.kind,
            event.lead_id,
            event.session_id,
            event.gclid,
            event.gbraid,
            event.wbraid,
            event.utm_source,
            event.utm_medium,
            event.utm_campaign,
            event.ad_group_id,
            event.utm_term,
            event.utm_content,
            event.keyword,
            event.match_type,
            event.name,
            event.email,
            event.phone,
            event.status,
            STATUS_RANK[event.status],
            event.submitted_at,
            event.payload
        ]
    );
    await rebuildLeadSession(pool, event.session_key);
    clearLeadAttributionSummaryCache();
    return event;
}

export async function recordLeadStatus(pool: Pool, input: { sessionKey: string; status: string; note?: string | null }): Promise<void> {
    await ensureLeadSchema(pool);
    const status = normalizeStatus(input.status);
    if (status === 'new') throw new LeadValidationError('Manual lead status must be useless, qualified, converted, or qualified_lost.');
    const sessionKey = clean(input.sessionKey);
    if (!sessionKey) throw new LeadValidationError('sessionKey is required.');
    const exists = await pool.query('SELECT session_key FROM lead_sessions WHERE session_key = $1', [sessionKey]);
    if (exists.rows.length === 0) throw new LeadValidationError(`Lead session not found: ${sessionKey}`);

    const eventId = `manual_${crypto.randomUUID()}`;
    await pool.query(
        `INSERT INTO lead_events
         (event_id, session_key, session_key_type, kind, status, status_rank, payload)
         VALUES ($1, $2::varchar, (SELECT session_key_type FROM lead_sessions WHERE session_key = $2::varchar), 'manual_status_update', $3, $4, $5)`,
        [eventId, sessionKey, status, STATUS_RANK[status], { status, note: input.note || null }]
    );
    await rebuildLeadSession(pool, sessionKey);
    clearLeadAttributionSummaryCache();
}

function campaignSpendMap(dashboardData: any): Map<string, { campaignId: string; campaignName: string | null; spend: number }> {
    const out = new Map<string, { campaignId: string; campaignName: string | null; spend: number }>();
    const rows = Array.isArray(dashboardData?.campaigns) ? dashboardData.campaigns : [];
    const nameToIds = new Map<string, Set<string>>();
    for (const row of rows) {
        const id = clean(row.id || row.campaignId);
        const campaignName = clean(row.name || row.campaign);
        if (!id || !campaignName) continue;
        const ids = nameToIds.get(campaignName) || new Set<string>();
        ids.add(id);
        nameToIds.set(campaignName, ids);
    }
    for (const row of rows) {
        const id = clean(row.id || row.campaignId);
        if (!id) continue;
        const campaignName = clean(row.name || row.campaign);
        const current = out.get(id) || { campaignId: id, campaignName: campaignName || null, spend: 0 };
        current.spend += Number(row.spend || 0);
        if (!current.campaignName && campaignName) current.campaignName = campaignName;
        out.set(id, current);
    }
    for (const current of Array.from(new Set(out.values()))) {
        if (!current.campaignName) continue;
        if ((nameToIds.get(current.campaignName)?.size || 0) === 1) out.set(current.campaignName, current);
    }
    return out;
}

function bumpLeadBucket(bucket: any, session: any): void {
    bucket.uniqueLeads += 1;
    bucket.eventCount += Number(session.event_count || 0);
    if (session.status === 'new') bucket.new += 1;
    if (session.status === 'useless') bucket.useless += 1;
    if (session.status === 'qualified') bucket.qualified += 1;
    if (session.status === 'qualified_lost') bucket.qualifiedLost += 1;
    if (session.status === 'converted') bucket.converted += 1;
    if (session.status === 'qualified') bucket.inProgress += 1;
    if (TERMINAL_STATUSES.has(session.status)) bucket.terminal += 1;
    if (session.status === 'qualified' || session.status === 'converted' || session.status === 'qualified_lost') bucket.qualifiedPipeline += 1;
    if (session.status === 'qualified' || session.status === 'converted') bucket.qualifiedOrConverted += 1;
}

function emptyLeadBucket(extra: Record<string, any> = {}): any {
    return {
        uniqueLeads: 0,
        eventCount: 0,
        new: 0,
        useless: 0,
        qualified: 0,
        qualifiedLost: 0,
        converted: 0,
        inProgress: 0,
        terminal: 0,
        qualifiedPipeline: 0,
        qualifiedOrConverted: 0,
        ...extra
    };
}

function overviewCacheSeconds(): number {
    const value = Number(process.env.LEAD_ATTRIBUTION_OVERVIEW_CACHE_SECONDS);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_LEAD_ATTRIBUTION_OVERVIEW_CACHE_SECONDS;
}

function cloneJson<T>(value: T): T {
    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function leadAttributionOverviewCacheKey(dashboardData: any): string {
    const range = dashboardDateRange(dashboardData);
    const scope = dashboardLeadScope(dashboardData);
    return [
        'lead-overview',
        dashboardData?.meta?.accountId || 'unknown',
        range.start || '',
        range.end || '',
        scope.campaignId || '',
        scope.campaignNames.join('|'),
        scope.adGroupId || '',
        scope.adGroupNames.join('|')
    ].join(':');
}

export function clearLeadAttributionSummaryCache(): void {
    leadAttributionOverviewCache.clear();
}

type LeadAttributionScope = {
    campaignId: string | null;
    campaignNames: string[];
    adGroupId: string | null;
    adGroupNames: string[];
};

function matchingName(rows: any[], selectedId: string | null, idFields: string[], nameFields: string[]): string | null {
    if (!selectedId) return null;
    for (const row of rows) {
        const ids = idFields.map(field => clean(row?.[field])).filter((value): value is string => Boolean(value));
        if (!ids.includes(selectedId)) continue;
        return nameFields.map(field => clean(row?.[field])).find((value): value is string => Boolean(value)) || null;
    }
    return null;
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
    return Array.from(new Set(values.map(value => clean(value)).filter((value): value is string => Boolean(value))));
}

function dashboardLeadScope(dashboardData: any): LeadAttributionScope {
    const filters = dashboardData?.meta?.filters || {};
    const campaignId = clean(filters.campaignId);
    const adGroupId = clean(filters.adGroupId);
    const campaigns = [
        ...(Array.isArray(dashboardData?.campaigns) ? dashboardData.campaigns : []),
        ...(Array.isArray(dashboardData?.filterOptions?.campaigns) ? dashboardData.filterOptions.campaigns : [])
    ];
    const adGroups = [
        ...(Array.isArray(dashboardData?.adGroups) ? dashboardData.adGroups : []),
        ...(Array.isArray(dashboardData?.filterOptions?.adGroups) ? dashboardData.filterOptions.adGroups : [])
    ];
    return {
        campaignId,
        campaignNames: uniqueNonEmpty([
            matchingName(campaigns, campaignId, ['id', 'campaignId'], ['name', 'campaignName', 'campaign']),
            matchingName(adGroups, campaignId, ['campaignId'], ['campaignName', 'campaign'])
        ]),
        adGroupId,
        adGroupNames: uniqueNonEmpty([
            matchingName(adGroups, adGroupId, ['id', 'adGroupId'], ['name', 'adGroupName', 'adGroup'])
        ])
    };
}

function leadAttributionScopeSummary(scope: LeadAttributionScope): Record<string, any> {
    return {
        campaignId: scope.campaignId,
        campaignNames: scope.campaignNames,
        adGroupId: scope.adGroupId,
        adGroupNames: scope.adGroupNames,
        level: scope.adGroupId ? 'ad_group' : scope.campaignId ? 'campaign' : 'account',
        adGroupField: scope.adGroupId ? 'attribution.ad_group_id' : null
    };
}

function sessionDateWhere(
    dateRange: { start: string | null; end: string | null },
    scope: LeadAttributionScope = { campaignId: null, campaignNames: [], adGroupId: null, adGroupNames: [] }
): { where: string; params: any[] } {
    const params: any[] = [];
    const conditions: string[] = [];
    if (dateRange.start) {
        params.push(dateRange.start);
        conditions.push(`first_seen >= $${params.length}::date`);
    }
    if (dateRange.end) {
        params.push(dateRange.end);
        conditions.push(`first_seen < ($${params.length}::date + INTERVAL '1 day')`);
    }
    if (scope.campaignId) {
        params.push(uniqueNonEmpty([scope.campaignId, ...scope.campaignNames]));
        conditions.push(`attribution->>'utm_campaign' = ANY($${params.length}::text[])`);
    }
    if (scope.adGroupId) {
        params.push(uniqueNonEmpty([scope.adGroupId, ...scope.adGroupNames]));
        conditions.push(`attribution->>'ad_group_id' = ANY($${params.length}::text[])`);
    }
    return {
        where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
        params
    };
}

function bumpLeadBucketByCount(bucket: any, statusValue: any, uniqueLeads: any, eventCount: any): void {
    const status = normalizeStatus(statusValue);
    const count = Number(uniqueLeads || 0);
    bucket.uniqueLeads += count;
    bucket.eventCount += Number(eventCount || 0);
    if (status === 'new') bucket.new += count;
    if (status === 'useless') bucket.useless += count;
    if (status === 'qualified') bucket.qualified += count;
    if (status === 'qualified_lost') bucket.qualifiedLost += count;
    if (status === 'converted') bucket.converted += count;
    if (status === 'qualified') bucket.inProgress += count;
    if (TERMINAL_STATUSES.has(status)) bucket.terminal += count;
    if (status === 'qualified' || status === 'converted' || status === 'qualified_lost') bucket.qualifiedPipeline += count;
    if (status === 'qualified' || status === 'converted') bucket.qualifiedOrConverted += count;
}

function bucketFromStatusRows(rows: any[], extra: Record<string, any> = {}): any {
    const bucket = emptyLeadBucket(extra);
    for (const row of rows) {
        bumpLeadBucketByCount(bucket, row.status, row.unique_leads, row.event_count);
    }
    return bucket;
}

function periodMetricsFromBucket(bucket: any): Record<string, number> {
    return {
        realConversions: Number(bucket.uniqueLeads || 0),
        realQualified: Number(bucket.qualified || 0),
        realQualifiedLost: Number(bucket.qualifiedLost || 0),
        realConverted: Number(bucket.converted || 0),
        realUseless: Number(bucket.useless || 0),
        realNew: Number(bucket.new || 0),
        realEventCount: Number(bucket.eventCount || 0)
    };
}

function jsonObject(value: any): any {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch {
            return {};
        }
    }
    return {};
}

function eventTimestamp(row: any): Date {
    const date = new Date(row.submitted_at || row.received_at || 0);
    return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function buildLeadJourneySummary(sessions: any[], events: any[]): any {
    const eventsBySession = new Map<string, any[]>();
    for (const event of events) {
        const list = eventsBySession.get(event.session_key) || [];
        list.push(event);
        eventsBySession.set(event.session_key, list);
    }

    const actionTotals = new Map<string, number>();
    const pairTotals = new Map<string, { from: string; to: string; sessions: number }>();
    const pathTotals = new Map<string, number>();
    const flowEdgeTotals = new Map<string, { from: string; to: string; sessions: number }>();
    const pathStatusTotals = new Map<string, { path: string; status: string; sessions: number }>();
    const journeyRows: any[] = [];

    for (const session of sessions) {
        const sessionEvents = (eventsBySession.get(session.session_key) || [])
            .slice()
            .sort((a, b) => eventTimestamp(a).getTime() - eventTimestamp(b).getTime());
        const actions = sessionEvents
            .filter(event => event.kind && event.kind !== 'manual_status_update')
            .map(event => String(event.kind || 'lead').trim())
            .filter(Boolean);
        const uniqueActions = Array.from(new Set(actions));
        for (const action of uniqueActions) {
            actionTotals.set(action, (actionTotals.get(action) || 0) + 1);
        }
        for (let i = 0; i < uniqueActions.length; i++) {
            for (let j = i + 1; j < uniqueActions.length; j++) {
                const from = uniqueActions[i];
                const to = uniqueActions[j];
                const key = `${from} -> ${to}`;
                const bucket = pairTotals.get(key) || { from, to, sessions: 0 };
                bucket.sessions += 1;
                pairTotals.set(key, bucket);
            }
        }
        const path = actions.length ? actions.join(' -> ') : '(no action kind)';
        pathTotals.set(path, (pathTotals.get(path) || 0) + 1);
        const flowNodes = ['Session start', ...actions, `Outcome: ${String(session.status || 'new').replace(/_/g, ' ')}`];
        for (let i = 0; i < flowNodes.length - 1; i++) {
            const from = flowNodes[i];
            const to = flowNodes[i + 1];
            const key = `${from} -> ${to}`;
            const bucket = flowEdgeTotals.get(key) || { from, to, sessions: 0 };
            bucket.sessions += 1;
            flowEdgeTotals.set(key, bucket);
        }
        const pathStatusKey = `${path}|${session.status}`;
        const pathStatusBucket = pathStatusTotals.get(pathStatusKey) || { path, status: session.status, sessions: 0 };
        pathStatusBucket.sessions += 1;
        pathStatusTotals.set(pathStatusKey, pathStatusBucket);
        journeyRows.push({
            sessionKey: session.session_key,
            status: session.status,
            actionCount: actions.length,
            uniqueActionCount: uniqueActions.length,
            actionPath: path,
            firstSeen: session.first_seen,
            lastSeen: session.last_seen
        });
    }

    const totalSessions = sessions.length || 1;
    return {
        totalSessions: sessions.length,
        sessionsWithMultipleActions: journeyRows.filter(row => row.uniqueActionCount > 1).length,
        topActionOverlaps: Array.from(pairTotals.values())
            .map(pair => ({
                ...pair,
                percentOfFrom: Number(((pair.sessions / Math.max(actionTotals.get(pair.from) || 0, 1)) * 100).toFixed(2)),
                percentOfAll: Number(((pair.sessions / totalSessions) * 100).toFixed(2))
            }))
            .sort((a, b) => b.sessions - a.sessions || b.percentOfFrom - a.percentOfFrom)
            .slice(0, 50),
        topPaths: Array.from(pathTotals.entries())
            .map(([path, sessions]) => ({
                path,
                sessions,
                percentOfAll: Number(((sessions / totalSessions) * 100).toFixed(2))
            }))
            .sort((a, b) => b.sessions - a.sessions)
            .slice(0, 50),
        flowEdges: Array.from(flowEdgeTotals.values())
            .map(edge => ({
                ...edge,
                percentOfAll: Number(((edge.sessions / totalSessions) * 100).toFixed(2))
            }))
            .sort((a, b) => b.sessions - a.sessions)
            .slice(0, 120),
        pathOutcomes: Array.from(pathStatusTotals.values())
            .map(row => ({
                ...row,
                percentOfAll: Number(((row.sessions / totalSessions) * 100).toFixed(2))
            }))
            .sort((a, b) => b.sessions - a.sessions)
            .slice(0, 100),
        recentJourneys: journeyRows.slice(0, 50)
    };
}

function groupEventsBySession(events: any[]): Map<string, any[]> {
    const out = new Map<string, any[]>();
    for (const event of events) {
        const list = out.get(event.session_key) || [];
        list.push(event);
        out.set(event.session_key, list);
    }
    for (const list of out.values()) {
        list.sort((a, b) => eventTimestamp(a).getTime() - eventTimestamp(b).getTime());
    }
    return out;
}

function firstEventValue(events: any[], field: string): string | null {
    for (const event of events) {
        const value = clean(event[field]);
        if (value) return value;
    }
    return null;
}

function latestEventValue(events: any[], field: string): string | null {
    for (let i = events.length - 1; i >= 0; i--) {
        const value = clean(events[i][field]);
        if (value) return value;
    }
    return null;
}

function hasClickId(attribution: any): boolean {
    return Boolean(clean(attribution?.gclid) || clean(attribution?.gbraid) || clean(attribution?.wbraid));
}

function formatToIST(dateVal: any): string | null {
    if (!dateVal) return null;
    const date = new Date(dateVal);
    if (isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'short'
    }).format(date);
}

function buildLeadRows(
    sessions: any[],
    events: any[],
    journeySummary: any,
    spendByCampaign: Map<string, { campaignId: string; campaignName: string | null; spend: number }>
): any[] {
    const eventsBySession = groupEventsBySession(events);
    const journeyBySession = new Map<string, any>(
        (Array.isArray(journeySummary?.recentJourneys) ? journeySummary.recentJourneys : [])
            .map((journey: any) => [journey.sessionKey, journey])
    );

    return sessions.map(session => {
        const sessionEvents = eventsBySession.get(session.session_key) || [];
        const contact = jsonObject(session.contact);
        const attribution = jsonObject(session.attribution);
        const leadIds = parseLeadIds(session.lead_ids);
        const utmTerm = clean(attribution.utm_term) || firstEventValue(sessionEvents, 'utm_term');
        const utmContent = clean(attribution.utm_content) || firstEventValue(sessionEvents, 'utm_content');
        const rawCampaignId = clean(attribution.utm_campaign) || firstEventValue(sessionEvents, 'utm_campaign');
        const adGroupId = clean(attribution.ad_group_id) || firstEventValue(sessionEvents, 'ad_group_id');
        const campaign = rawCampaignId ? spendByCampaign.get(rawCampaignId) : null;
        const campaignId = campaign?.campaignId || rawCampaignId;
        const mergedAttribution = {
            utm_source: clean(attribution.utm_source) || firstEventValue(sessionEvents, 'utm_source'),
            utm_medium: clean(attribution.utm_medium) || firstEventValue(sessionEvents, 'utm_medium'),
            utm_campaign: rawCampaignId,
            ad_group_id: adGroupId,
            utm_term: utmTerm,
            utm_content: utmContent,
            keyword: clean(attribution.keyword) || firstEventValue(sessionEvents, 'keyword') || utmTerm,
            match_type: clean(attribution.match_type) || firstEventValue(sessionEvents, 'match_type') || matchTypeFromUtmContent(utmContent),
            gclid: clean(attribution.gclid) || firstEventValue(sessionEvents, 'gclid'),
            gbraid: clean(attribution.gbraid) || firstEventValue(sessionEvents, 'gbraid'),
            wbraid: clean(attribution.wbraid) || firstEventValue(sessionEvents, 'wbraid')
        };
        const journey: any = journeyBySession.get(session.session_key) || {};
        return {
            sessionKey: session.session_key,
            sessionKeyType: session.session_key_type,
            status: normalizeStatus(session.status),
            statusRank: Number(session.status_rank || 0),
            event_count: Number(session.event_count || 0),
            eventCount: Number(session.event_count || 0),
            leadIds,
            leadId: leadIds[0] || latestEventValue(sessionEvents, 'lead_id'),
            contact: {
                name: clean(contact.name) || latestEventValue(sessionEvents, 'name'),
                email: clean(contact.email) || latestEventValue(sessionEvents, 'email'),
                phone: clean(contact.phone) || latestEventValue(sessionEvents, 'phone')
            },
            attribution: mergedAttribution,
            campaign: campaignId ? {
                campaignId,
                campaignName: campaign?.campaignName || null,
                utmCampaign: rawCampaignId && rawCampaignId !== campaignId ? rawCampaignId : null
            } : null,
            hasClickId: hasClickId(mergedAttribution),
            offlineConversionReady: ['qualified', 'converted'].includes(normalizeStatus(session.status)) && hasClickId(mergedAttribution),
            actionPath: journey.actionPath || '(no action kind)',
            actionCount: Number(journey.actionCount || session.event_count || 0),
            uniqueActionCount: Number(journey.uniqueActionCount || 0),
            firstSeen: session.first_seen,
            lastSeen: session.last_seen,
            firstSeenIst: formatToIST(session.first_seen)
        };
    });
}

function buildOfflineExportReadiness(leadRows: any[]): any {
    const exportStatuses = new Set<LeadStatus>(['qualified', 'converted']);
    let readyRows = 0;
    let skippedMissingClickId = 0;
    let qualifiedOrConverted = 0;
    let needsReview = 0;

    for (const lead of leadRows) {
        const status = normalizeStatus(lead.status);
        if (status === 'new') needsReview += 1;
        if (!exportStatuses.has(status)) continue;
        qualifiedOrConverted += 1;
        if (lead.hasClickId) readyRows += 1;
        else skippedMissingClickId += 1;
    }

    return {
        statuses: Array.from(exportStatuses),
        readyRows,
        skippedMissingClickId,
        qualifiedOrConverted,
        needsReview
    };
}

function dashboardDateRange(dashboardData: any): { start: string | null; end: string | null } {
    const range = dashboardData?.meta?.dateRange || {};
    return {
        start: cleanDate(range.start),
        end: cleanDate(range.end)
    };
}

function periodRange(label: any): { start: string; end: string } | null {
    const text = String(label || '');
    const match = text.match(/(\d{4}-\d{2}-\d{2})\s*[-–]\s*(\d{4}-\d{2}-\d{2})/);
    return match ? { start: match[1], end: match[2] } : null;
}

async function aggregateLeadBucketForRange(pool: Pool, range: { start: string; end: string } | null, scope: LeadAttributionScope): Promise<any> {
    if (!range) return emptyLeadBucket();
    const { where, params } = sessionDateWhere({ start: range.start, end: range.end }, scope);
    const { rows } = await pool.query(
        `SELECT status, COUNT(*)::int AS unique_leads, COALESCE(SUM(event_count), 0)::int AS event_count
         FROM lead_sessions
         ${where}
         GROUP BY status`,
        params
    );
    return bucketFromStatusRows(rows);
}

async function buildLeadAttributionOverviewSummary(pool: Pool, dashboardData: any): Promise<any> {
    const ttlSeconds = overviewCacheSeconds();
    const cacheKey = leadAttributionOverviewCacheKey(dashboardData);
    const now = Date.now();
    const cached = ttlSeconds > 0 ? leadAttributionOverviewCache.get(cacheKey) : null;
    if (cached && cached.expiresAt > now) return cloneJson(cached.summary);

    const dateRange = dashboardDateRange(dashboardData);
    const scope = dashboardLeadScope(dashboardData);
    const { where, params } = sessionDateWhere(dateRange, scope);
    const spendByCampaign = campaignSpendMap(dashboardData);
    const [
        totalsResult,
        byCampaignResult,
        bySearchTermResult,
        recentResult,
        offlineResult,
        previousPeriodBucket,
        currentPeriodBucket
    ] = await Promise.all([
        pool.query(
            `SELECT status, COUNT(*)::int AS unique_leads, COALESCE(SUM(event_count), 0)::int AS event_count
             FROM lead_sessions
             ${where}
             GROUP BY status`,
            params
        ),
        pool.query(
            `SELECT campaign_id, status, COUNT(*)::int AS unique_leads, COALESCE(SUM(event_count), 0)::int AS event_count
             FROM (
                SELECT COALESCE(NULLIF(attribution->>'utm_campaign', ''), '(none)') AS campaign_id, status, event_count
                FROM lead_sessions
                ${where}
             ) sessions
             GROUP BY campaign_id, status`,
            params
        ),
        pool.query(
            `SELECT campaign_id, search_term, keyword, match_type, status, COUNT(*)::int AS unique_leads, COALESCE(SUM(event_count), 0)::int AS event_count
             FROM (
                SELECT
                    COALESCE(NULLIF(attribution->>'utm_campaign', ''), '(none)') AS campaign_id,
                    COALESCE(NULLIF(attribution->>'utm_term', ''), NULLIF(attribution->>'keyword', ''), '(none)') AS search_term,
                    NULLIF(attribution->>'keyword', '') AS keyword,
                    NULLIF(attribution->>'match_type', '') AS match_type,
                    status,
                    event_count
                FROM lead_sessions
                ${where}
             ) sessions
             GROUP BY campaign_id, search_term, keyword, match_type, status`,
            params
        ),
        pool.query(
            `SELECT session_key, session_key_type, status, status_rank, event_count, lead_ids, attribution, contact, first_seen, last_seen
             FROM lead_sessions
             ${where}
             ORDER BY last_seen DESC
             LIMIT 50`,
            params
        ),
        pool.query(
            `SELECT
                COUNT(*) FILTER (WHERE status = 'new')::int AS needs_review,
                COUNT(*) FILTER (WHERE status IN ('qualified', 'converted'))::int AS qualified_or_converted,
                COUNT(*) FILTER (
                    WHERE status IN ('qualified', 'converted')
                      AND (
                        NULLIF(attribution->>'gclid', '') IS NOT NULL
                        OR NULLIF(attribution->>'gbraid', '') IS NOT NULL
                        OR NULLIF(attribution->>'wbraid', '') IS NOT NULL
                      )
                )::int AS ready_rows
             FROM lead_sessions
             ${where}`,
            params
        ),
        aggregateLeadBucketForRange(pool, periodRange(dashboardData?.periodComparison?.previousPeriod?.label), scope),
        aggregateLeadBucketForRange(pool, periodRange(dashboardData?.periodComparison?.currentPeriod?.label), scope)
    ]);

    const totals = bucketFromStatusRows(totalsResult.rows);
    const byCampaign = new Map<string, any>();
    for (const row of byCampaignResult.rows) {
        const rawCampaignId = clean(row.campaign_id) || '(none)';
        const campaignSpend = spendByCampaign.get(rawCampaignId);
        const campaignId = campaignSpend?.campaignId || rawCampaignId;
        const bucket = byCampaign.get(campaignId) || emptyLeadBucket({
            campaignId,
            campaignName: campaignSpend?.campaignName || null,
            spend: campaignSpend?.spend || 0,
            trueCpa: 0,
            qualifiedCpa: 0,
            convertedCpa: 0,
            customerCpa: 0
        });
        bumpLeadBucketByCount(bucket, row.status, row.unique_leads, row.event_count);
        byCampaign.set(campaignId, bucket);
    }

    const bySearchTerm = new Map<string, any>();
    for (const row of bySearchTermResult.rows) {
        const rawCampaignId = clean(row.campaign_id) || '(none)';
        const campaignSpend = spendByCampaign.get(rawCampaignId);
        const campaignId = campaignSpend?.campaignId || rawCampaignId;
        const term = clean(row.search_term) || '(none)';
        const key = `${campaignId}|${term}|${clean(row.keyword) || ''}|${clean(row.match_type) || ''}`;
        const bucket = bySearchTerm.get(key) || emptyLeadBucket({
            campaignId,
            campaignName: campaignSpend?.campaignName || null,
            searchTerm: term,
            keyword: clean(row.keyword),
            matchType: clean(row.match_type)
        });
        bumpLeadBucketByCount(bucket, row.status, row.unique_leads, row.event_count);
        bySearchTerm.set(key, bucket);
    }

    const campaigns = Array.from(byCampaign.values())
        .map(bucket => ({
            ...bucket,
            trueCpa: bucket.uniqueLeads > 0 ? bucket.spend / bucket.uniqueLeads : 0,
            qualifiedCpa: bucket.qualifiedPipeline > 0 ? bucket.spend / bucket.qualifiedPipeline : 0,
            convertedCpa: bucket.converted > 0 ? bucket.spend / bucket.converted : 0,
            customerCpa: bucket.converted > 0 ? bucket.spend / bucket.converted : 0
        }))
        .sort((a, b) => b.spend - a.spend || b.uniqueLeads - a.uniqueLeads);
    const recentLeads = buildLeadRows(recentResult.rows, [], { recentJourneys: [] }, spendByCampaign);
    const offlineRow = offlineResult.rows[0] || {};
    const qualifiedOrConverted = Number(offlineRow.qualified_or_converted || 0);
    const readyRows = Number(offlineRow.ready_rows || 0);
    const summary = {
        generatedAt: new Date().toISOString(),
        mode: 'overview',
        dateRange,
        scope: leadAttributionScopeSummary(scope),
        totals,
        byCampaign: campaigns,
        bySearchTerm: Array.from(bySearchTerm.values()).sort((a, b) => b.uniqueLeads - a.uniqueLeads).slice(0, 100),
        journeySummary: {
            totalSessions: totals.uniqueLeads,
            sessionsWithMultipleActions: recentResult.rows.filter((row: any) => Number(row.event_count || 0) > 1).length,
            topActionOverlaps: [],
            topPaths: [],
            flowEdges: [],
            pathOutcomes: [],
            recentJourneys: []
        },
        recentLeads,
        offlineExport: {
            statuses: ['qualified', 'converted'],
            readyRows,
            skippedMissingClickId: Math.max(0, qualifiedOrConverted - readyRows),
            qualifiedOrConverted,
            needsReview: Number(offlineRow.needs_review || 0)
        },
        periodComparison: {
            previousPeriod: periodMetricsFromBucket(previousPeriodBucket),
            currentPeriod: periodMetricsFromBucket(currentPeriodBucket)
        }
    };

    if (ttlSeconds > 0) {
        leadAttributionOverviewCache.set(cacheKey, {
            summary: cloneJson(summary),
            expiresAt: now + ttlSeconds * 1000
        });
    }
    return summary;
}

export async function getLeadAttributionSummary(
    pool: Pool,
    dashboardData: any,
    options: LeadAttributionSummaryOptions = {}
): Promise<any> {
    await ensureLeadSchema(pool);
    if ((options.mode || 'full') === 'overview') {
        return buildLeadAttributionOverviewSummary(pool, dashboardData);
    }
    const dateRange = dashboardDateRange(dashboardData);
    const scope = dashboardLeadScope(dashboardData);
    const { where: sessionWhere, params: sessionParams } = sessionDateWhere(dateRange, scope);
    const { rows } = await pool.query(
        `SELECT session_key, session_key_type, status, status_rank, event_count, lead_ids, attribution, contact, first_seen, last_seen
         FROM lead_sessions
         ${sessionWhere}
         ORDER BY last_seen DESC`,
        sessionParams
    );
    const eventsResult = rows.length
        ? await pool.query(
            `SELECT session_key, kind, lead_id, session_id, status, submitted_at, received_at,
                    gclid, gbraid, wbraid, utm_source, utm_medium, utm_campaign, ad_group_id, utm_term, utm_content,
                    keyword, match_type, name, email, phone
             FROM lead_events
             WHERE session_key = ANY($1::varchar[])
             ORDER BY session_key ASC, COALESCE(submitted_at, received_at) ASC, received_at ASC`,
            [rows.map((row: any) => row.session_key)]
        )
        : { rows: [] };
    const spendByCampaign = campaignSpendMap(dashboardData);
    const totals = emptyLeadBucket();
    const byCampaign = new Map<string, any>();
    const bySearchTerm = new Map<string, any>();
    const journeySummary = buildLeadJourneySummary(rows, eventsResult.rows);
    const leadRows = buildLeadRows(rows, eventsResult.rows, journeySummary, spendByCampaign);

    for (const session of leadRows) {
        bumpLeadBucket(totals, session);
        const attribution = session.attribution || {};
        const rawCampaignId = clean(attribution.utm_campaign);
        const campaignId = clean(session?.campaign?.campaignId) || rawCampaignId || '(none)';
        const campaignSpend = spendByCampaign.get(campaignId) || (rawCampaignId ? spendByCampaign.get(rawCampaignId) : undefined);
        const campaignBucket = byCampaign.get(campaignId) || emptyLeadBucket({
            campaignId,
            campaignName: campaignSpend?.campaignName || null,
            spend: campaignSpend?.spend || 0,
            trueCpa: 0,
            qualifiedCpa: 0,
            convertedCpa: 0,
            customerCpa: 0
        });
        bumpLeadBucket(campaignBucket, session);
        byCampaign.set(campaignId, campaignBucket);

        const term = clean(attribution.utm_term) || clean(attribution.keyword) || '(none)';
        const termBucket = bySearchTerm.get(term) || emptyLeadBucket({
            searchTerm: term,
            keyword: clean(attribution.keyword),
            matchType: clean(attribution.match_type)
        });
        if (!termBucket.keyword && clean(attribution.keyword)) termBucket.keyword = clean(attribution.keyword);
        if (!termBucket.matchType && clean(attribution.match_type)) termBucket.matchType = clean(attribution.match_type);
        bumpLeadBucket(termBucket, session);
        bySearchTerm.set(term, termBucket);
    }

    const campaigns = Array.from(byCampaign.values())
        .map(bucket => ({
            ...bucket,
            trueCpa: bucket.uniqueLeads > 0 ? bucket.spend / bucket.uniqueLeads : 0,
            qualifiedCpa: bucket.qualifiedPipeline > 0 ? bucket.spend / bucket.qualifiedPipeline : 0,
            convertedCpa: bucket.converted > 0 ? bucket.spend / bucket.converted : 0,
            customerCpa: bucket.converted > 0 ? bucket.spend / bucket.converted : 0
        }))
        .sort((a, b) => b.spend - a.spend || b.uniqueLeads - a.uniqueLeads);

    return {
        generatedAt: new Date().toISOString(),
        dateRange,
        scope: leadAttributionScopeSummary(scope),
        totals,
        byCampaign: campaigns,
        bySearchTerm: Array.from(bySearchTerm.values()).sort((a, b) => b.uniqueLeads - a.uniqueLeads).slice(0, 100),
        journeySummary,
        allLeads: leadRows,
        recentLeads: leadRows.slice(0, 50),
        recentSessions: rows.slice(0, 50),
        offlineExport: buildOfflineExportReadiness(leadRows)
    };
}

function leadStatusShortLabel(value: any): string {
    const labels: Record<LeadStatus, string> = {
        new: 'Needs review',
        qualified: 'Qualified',
        converted: 'Won',
        qualified_lost: 'Lost',
        useless: 'Junk'
    };
    return labels[normalizeStatus(value)];
}

function clickIdSummary(attribution: any): string {
    const parts = [
        clean(attribution?.gclid) ? 'GCLID' : null,
        clean(attribution?.gbraid) ? 'GBRAID' : null,
        clean(attribution?.wbraid) ? 'WBRAID' : null
    ].filter(Boolean);
    return parts.length ? parts.join(', ') : 'No click ID';
}

function leadActionPathLabel(value: any): string {
    const text = clean(value);
    return text && text !== '(no action kind)' ? text : 'Lead captured';
}

export async function exportLeadReviewCsv(pool: Pool, options: {
    startDate?: any;
    endDate?: any;
    campaignId?: any;
    campaignName?: any;
    adGroupId?: any;
    adGroupName?: any;
} = {}): Promise<{ csv: string; rowCount: number }> {
    await ensureLeadSchema(pool);
    const startDate = cleanDate(options.startDate);
    const endDate = cleanDate(options.endDate);
    if (options.startDate && !startDate) throw new LeadValidationError('Invalid startDate. Use YYYY-MM-DD.');
    if (options.endDate && !endDate) throw new LeadValidationError('Invalid endDate. Use YYYY-MM-DD.');
    if (startDate && endDate && startDate > endDate) throw new LeadValidationError('startDate must be before or equal to endDate.');

    const params: any[] = [];
    const conditions: string[] = [];
    if (startDate) {
        params.push(startDate);
        conditions.push(`first_seen >= $${params.length}::date`);
    }
    if (endDate) {
        params.push(endDate);
        conditions.push(`first_seen < ($${params.length}::date + INTERVAL '1 day')`);
    }
    const campaignId = clean(options.campaignId);
    if (campaignId) {
        params.push(uniqueNonEmpty([campaignId, clean(options.campaignName)]));
        conditions.push(`attribution->>'utm_campaign' = ANY($${params.length}::text[])`);
    }
    const adGroupId = clean(options.adGroupId);
    if (adGroupId) {
        params.push(uniqueNonEmpty([adGroupId, clean(options.adGroupName)]));
        conditions.push(`attribution->>'ad_group_id' = ANY($${params.length}::text[])`);
    }
    const sessionWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
        `SELECT session_key, session_key_type, status, status_rank, event_count, lead_ids, attribution, contact, first_seen, last_seen
         FROM lead_sessions
         ${sessionWhere}
         ORDER BY last_seen DESC`,
        params
    );
    const eventsResult = rows.length
        ? await pool.query(
            `SELECT session_key, kind, lead_id, session_id, status, submitted_at, received_at,
                    gclid, gbraid, wbraid, utm_source, utm_medium, utm_campaign, ad_group_id, utm_term, utm_content,
                    keyword, match_type, name, email, phone
             FROM lead_events
             WHERE session_key = ANY($1::varchar[])
             ORDER BY session_key ASC, COALESCE(submitted_at, received_at) ASC, received_at ASC`,
            [rows.map((row: any) => row.session_key)]
        )
        : { rows: [] };
    const journeySummary = buildLeadJourneySummary(rows, eventsResult.rows);
    const leadRows = buildLeadRows(rows, eventsResult.rows, journeySummary, new Map());

    const csvRows: string[][] = [[
        'First Seen',
        'First Seen IST',
        'Last Seen',
        'Status',
        'Name',
        'Email',
        'Phone',
        'Campaign ID',
        'Campaign Name',
        'Ad Group ID',
        'Search Term',
        'Keyword',
        'Match Type',
        'UTM Source',
        'UTM Medium',
        'UTM Campaign',
        'UTM Term',
        'UTM Content',
        'Click ID Summary',
        'GCLID',
        'GBRAID',
        'WBRAID',
        'Has Click ID',
        'Offline Upload Ready',
        'Lead Action Path',
        'Event Count',
        'Unique Action Count',
        'Session Key',
        'Session Key Type',
        'Lead IDs'
    ]];

    for (const lead of leadRows) {
        const attribution = lead.attribution || {};
        const contact = lead.contact || {};
        const campaign = lead.campaign || {};
        csvRows.push([
            String(lead.firstSeen || ''),
            String(lead.firstSeenIst || formatToIST(lead.firstSeen) || ''),
            String(lead.lastSeen || ''),
            leadStatusShortLabel(lead.status),
            clean(contact.name) || '',
            clean(contact.email) || '',
            clean(contact.phone) || '',
            clean(campaign.campaignId) || clean(attribution.utm_campaign) || '',
            clean(campaign.campaignName) || '',
            clean(attribution.ad_group_id) || '',
            clean(attribution.utm_term) || '',
            clean(attribution.keyword) || clean(attribution.utm_term) || '',
            clean(attribution.match_type) || '',
            clean(attribution.utm_source) || '',
            clean(attribution.utm_medium) || '',
            clean(attribution.utm_campaign) || '',
            clean(attribution.utm_term) || '',
            clean(attribution.utm_content) || '',
            clickIdSummary(attribution),
            clean(attribution.gclid) || '',
            clean(attribution.gbraid) || '',
            clean(attribution.wbraid) || '',
            lead.hasClickId ? 'Yes' : 'No',
            lead.offlineConversionReady ? 'Yes' : 'No',
            leadActionPathLabel(lead.actionPath),
            String(lead.eventCount ?? lead.event_count ?? ''),
            String(lead.uniqueActionCount ?? ''),
            clean(lead.sessionKey) || '',
            clean(lead.sessionKeyType) || '',
            Array.isArray(lead.leadIds) ? lead.leadIds.join(' | ') : ''
        ]);
    }

    return {
        csv: csvRows.map(row => row.map(csvCell).join(',')).join('\n') + '\n',
        rowCount: csvRows.length - 1
    };
}

function csvCell(value: any): string {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseLeadIds(value: any): string[] {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
        } catch {
            return [];
        }
    }
    return [];
}

function formatGoogleAdsConversionTime(value: any): string {
    const date = new Date(value || Date.now());
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}+00:00`;
}

function normalizeStatusList(values: any, fallback: LeadStatus[]): LeadStatus[] {
    const raw = Array.isArray(values)
        ? values
        : String(values || '').split(',');
    const normalized = raw
        .map(value => normalizeStatus(value))
        .filter(status => status !== 'new');
    const out = Array.from(new Set(normalized));
    return out.length ? out : fallback;
}

export interface OfflineConversionExportOptions {
    statuses?: any;
    startDate?: any;
    endDate?: any;
    campaignId?: any;
    campaignName?: any;
    currency?: string;
    qualifiedName?: string;
    convertedName?: string;
    qualifiedValue?: any;
    convertedValue?: any;
    defaultValue?: any;
}

export async function exportOfflineConversionsCsv(pool: Pool, options: OfflineConversionExportOptions = {}): Promise<{
    csv: string;
    rowCount: number;
    skippedMissingClickId: number;
    statuses: LeadStatus[];
}> {
    await ensureLeadSchema(pool);
    const statuses = normalizeStatusList(options.statuses, ['qualified', 'converted']);
    const currency = clean(options.currency) || 'INR';
    const defaultValue = Number.isFinite(Number(options.defaultValue)) ? Number(options.defaultValue) : 0;
    const conversionNames: Partial<Record<LeadStatus, string>> = {
        qualified: clean(options.qualifiedName) || 'Qualified Lead',
        converted: clean(options.convertedName) || 'Converted Customer'
    };
    const conversionValues: Partial<Record<LeadStatus, number>> = {
        qualified: Number.isFinite(Number(options.qualifiedValue)) ? Number(options.qualifiedValue) : defaultValue,
        converted: Number.isFinite(Number(options.convertedValue)) ? Number(options.convertedValue) : defaultValue
    };
    const params: any[] = [statuses];
    const conditions = ['ls.status = ANY($1::varchar[])'];
    const startDate = cleanDate(options.startDate);
    const endDate = cleanDate(options.endDate);
    if (startDate) {
        params.push(startDate);
        conditions.push(`ls.first_seen >= $${params.length}::date`);
    }
    if (endDate) {
        params.push(endDate);
        conditions.push(`ls.first_seen < ($${params.length}::date + INTERVAL '1 day')`);
    }
    const campaignId = clean(options.campaignId);
    const campaignValues = uniqueNonEmpty([campaignId, clean(options.campaignName)]);
    if (campaignValues.length) {
        params.push(campaignValues);
        conditions.push(`ls.attribution->>'utm_campaign' = ANY($${params.length}::text[])`);
    }

    const { rows } = await pool.query(
        `SELECT ls.session_key, ls.status, ls.lead_ids, ls.attribution, ls.last_seen, ls.updated_at,
                click_ids.gclid AS event_gclid,
                click_ids.gbraid AS event_gbraid,
                click_ids.wbraid AS event_wbraid
         FROM lead_sessions ls
         LEFT JOIN LATERAL (
             SELECT gclid, gbraid, wbraid
             FROM lead_events
             WHERE session_key = ls.session_key
               AND (gclid IS NOT NULL OR gbraid IS NOT NULL OR wbraid IS NOT NULL)
             ORDER BY COALESCE(submitted_at, received_at) ASC, received_at ASC
             LIMIT 1
         ) click_ids ON true
         WHERE ${conditions.join(' AND ')}
         ORDER BY ls.last_seen DESC`,
        params
    );

    const csvRows: string[][] = [[
        'Google Click ID',
        'GBRAID',
        'WBRAID',
        'Conversion Name',
        'Conversion Time',
        'Conversion Value',
        'Conversion Currency',
        'Order ID'
    ]];
    let skippedMissingClickId = 0;

    for (const row of rows) {
        const status = normalizeStatus(row.status);
        const attribution = row.attribution || {};
        const gclid = clean(attribution.gclid) || clean(row.event_gclid);
        const gbraid = clean(attribution.gbraid) || clean(row.event_gbraid);
        const wbraid = clean(attribution.wbraid) || clean(row.event_wbraid);
        if (!gclid && !gbraid && !wbraid) {
            skippedMissingClickId += 1;
            continue;
        }
        const leadIds = parseLeadIds(row.lead_ids);
        csvRows.push([
            gclid || '',
            gbraid || '',
            wbraid || '',
            conversionNames[status] || status.replace(/_/g, ' '),
            formatGoogleAdsConversionTime(row.last_seen || row.updated_at),
            String(conversionValues[status] ?? defaultValue),
            currency,
            leadIds[0] || row.session_key
        ]);
    }

    return {
        csv: csvRows.map(row => row.map(csvCell).join(',')).join('\n') + '\n',
        rowCount: csvRows.length - 1,
        skippedMissingClickId,
        statuses
    };
}

export interface LeadQualityMetrics {
    uniqueLeads: number;
    new: number;
    useless: number;
    qualified: number;
    qualifiedLost: number;
    converted: number;
    inProgress: number;
    terminal: number;
    qualifiedPipeline: number;
    qualifiedOrConverted: number;
    uselessRate: number;
    qualifiedRate: number;
    conversionRate: number;
}

function finalizeLeadQualityMetrics(bucket: any): LeadQualityMetrics {
    const uniqueLeads = Number(bucket.uniqueLeads || 0);
    const metrics = emptyLeadBucket();
    Object.assign(metrics, bucket);
    return {
        uniqueLeads,
        new: Number(metrics.new || 0),
        useless: Number(metrics.useless || 0),
        qualified: Number(metrics.qualified || 0),
        qualifiedLost: Number(metrics.qualifiedLost || 0),
        converted: Number(metrics.converted || 0),
        inProgress: Number(metrics.inProgress || 0),
        terminal: Number(metrics.terminal || 0),
        qualifiedPipeline: Number(metrics.qualifiedPipeline || 0),
        qualifiedOrConverted: Number(metrics.qualifiedOrConverted || 0),
        uselessRate: uniqueLeads ? Number((Number(metrics.useless || 0) / uniqueLeads).toFixed(4)) : 0,
        qualifiedRate: uniqueLeads ? Number((Number(metrics.qualifiedPipeline || 0) / uniqueLeads).toFixed(4)) : 0,
        conversionRate: uniqueLeads ? Number((Number(metrics.converted || 0) / uniqueLeads).toFixed(4)) : 0
    };
}

export async function getLeadQualityMetricsForWindow(pool: Pool, input: {
    start: Date;
    end: Date;
    campaignId?: string | null;
    campaignName?: string | null;
    searchTerm?: string | null;
}): Promise<LeadQualityMetrics> {
    await ensureLeadSchema(pool);
    const params: any[] = [input.start.toISOString(), input.end.toISOString()];
    const conditions = ['first_seen >= $1::timestamp', 'first_seen < $2::timestamp'];
    const campaignId = clean(input.campaignId);
    const campaignValues = uniqueNonEmpty([campaignId, clean(input.campaignName)]);
    const searchTerm = clean(input.searchTerm);
    if (campaignValues.length) {
        params.push(campaignValues);
        conditions.push(`attribution->>'utm_campaign' = ANY($${params.length}::text[])`);
    }
    if (searchTerm) {
        params.push(searchTerm.toLowerCase());
        conditions.push(`LOWER(COALESCE(attribution->>'utm_term', '')) = $${params.length}`);
    }

    const { rows } = await pool.query(
        `SELECT status, event_count
         FROM lead_sessions
         WHERE ${conditions.join(' AND ')}`,
        params
    );
    const bucket = emptyLeadBucket();
    for (const row of rows) bumpLeadBucket(bucket, row);
    return finalizeLeadQualityMetrics(bucket);
}
