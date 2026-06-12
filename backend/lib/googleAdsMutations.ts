import crypto from 'crypto';
import type { Pool } from 'pg';
import { executeGaql, getAccessToken, getAccessibleCustomer } from './googleAds';
import { requestGoogleAdsJson } from './googleAdsClient';
import { GoogleAdsMutationValidationError } from './googleAdsMutationValidationError';
import { buildAudienceMutationOperations, prepareAudienceMutationChanges } from './googleAdsAudienceMutations';

export { GoogleAdsMutationValidationError } from './googleAdsMutationValidationError';

const DEFAULT_CONFIRM_TTL_MINUTES = 10;
const KEYWORD_MATCH_TYPES = new Set(['BROAD', 'PHRASE', 'EXACT']);
const ENTITY_STATUSES = new Set(['ENABLED', 'PAUSED']);
const MINUTE_MARKS = new Set(['ZERO', 'FIFTEEN', 'THIRTY', 'FORTY_FIVE']);
const DAYS = new Set(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']);

export type GoogleAdsMutationType =
    | 'keyword_changes'
    | 'negative_keyword_changes'
    | 'ad_schedule_changes'
    | 'entity_status_changes'
    | 'audience_changes';

export type NormalizedGoogleAdsError = {
    code: string | null;
    message: string;
    fieldPath: string | null;
    trigger: string | null;
    operationIndex: number | null;
};

export type MutationPreviewResult = {
    mutationId: string;
    confirmationToken: string;
    expiresAt: string;
    diff: any[];
    warnings: string[];
    operationsSummary: any;
};

export type KeywordConflict = {
    kind: 'keyword' | 'negative_keyword';
    scope: 'account' | 'shared_list' | 'campaign' | 'ad_group';
    campaignId: string | null;
    adGroupId: string | null;
    sharedSetId?: string | null;
    matchType: string;
};

export type KeywordMutationPreflightResult = {
    duplicate: boolean;
    keywordText: string;
    matchType: string;
    target: {
        scope: 'account' | 'shared_list' | 'campaign' | 'ad_group';
        campaignId: string | null;
        adGroupId: string | null;
        sharedSetId?: string | null;
    };
    oppositeConflicts: KeywordConflict[];
};

type BuiltMutation = {
    mutationType: GoogleAdsMutationType;
    operationsByPath: Record<string, any[]>;
    diff: any[];
    warnings: string[];
    touched: {
        campaignIds: string[];
        adGroupIds: string[];
    };
};

type PreparedChanges = {
    changes: any[];
    warnings: string[];
};

type PartialFailureSummary = {
    message: string;
    applied: string[];
    failed: string[];
    notAttempted: string[];
    successfulPaths: string[];
    failedPath: string | null;
    notAttemptedPaths: string[];
    errors: NormalizedGoogleAdsError[];
};

function clean(value: unknown): string {
    return String(value ?? '').trim();
}

function cleanOptional(value: unknown): string | null {
    const text = clean(value);
    return text || null;
}

function normalizeCustomerId(value: unknown): string | null {
    const text = clean(value).replace(/-/g, '');
    if (!text) return null;
    if (!/^\d{6,20}$/.test(text)) throw new GoogleAdsMutationValidationError('customerId must be a numeric Google Ads customer id.');
    return text;
}

function normalizeMatchType(value: unknown): string {
    const text = clean(value).toUpperCase().replace(/[\s-]+/g, '_');
    if (!KEYWORD_MATCH_TYPES.has(text)) {
        throw new GoogleAdsMutationValidationError('matchType must be BROAD, PHRASE, or EXACT.');
    }
    return text;
}

function normalizeNegativeScope(value: unknown, fallback: any = {}): 'campaign' | 'ad_group' | 'shared_list' {
    const text = clean(value || (fallback.adGroupId ? 'ad_group' : fallback.sharedSetId || fallback.sharedSetResourceName ? 'shared_list' : 'campaign'))
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
    if (text === 'account') return 'shared_list';
    if (text !== 'campaign' && text !== 'ad_group' && text !== 'shared_list') {
        throw new GoogleAdsMutationValidationError('Negative keyword scope must be campaign, ad_group, or shared_list.');
    }
    return text;
}

function normalizeFinalUrl(value: unknown): string | null {
    const text = clean(value);
    if (!text) return null;
    if (text.length > 2048) throw new GoogleAdsMutationValidationError('finalUrl must be 2,048 characters or fewer.');
    let parsed: URL;
    try {
        parsed = new URL(text);
    } catch {
        throw new GoogleAdsMutationValidationError('finalUrl must be a valid http or https URL.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new GoogleAdsMutationValidationError('finalUrl must be a valid http or https URL.');
    }
    return parsed.toString();
}

export function normalizeKeywordText(value: unknown): string {
    const text = clean(value).replace(/\s+/g, ' ');
    if (!text) throw new GoogleAdsMutationValidationError('keyword text is required.');
    const words = text.split(/\s+/).filter(Boolean);
    if (text.length > 80 || words.length > 10) {
        throw new GoogleAdsMutationValidationError('keyword text must be 80 characters or fewer and no more than 10 words.');
    }
    return text;
}

function normalizeEntityId(value: unknown, label: 'campaignId' | 'adGroupId' | 'sharedSetId'): string {
    const id = clean(value);
    if (!/^\d+$/.test(id)) throw new GoogleAdsMutationValidationError(`${label} must be numeric.`);
    return id;
}

function resourceName(customerId: string, type: 'campaigns' | 'adGroups' | 'sharedSets', id: unknown): string {
    const cleanId = normalizeEntityId(id, type === 'campaigns' ? 'campaignId' : type === 'adGroups' ? 'adGroupId' : 'sharedSetId');
    return `customers/${customerId}/${type}/${cleanId}`;
}

function criterionResourceName(customerId: string, collection: 'adGroupCriteria' | 'campaignCriteria' | 'sharedCriteria', ownerId: unknown, criterionId: unknown): string {
    const owner = clean(ownerId);
    const criterion = clean(criterionId);
    if (!/^\d+$/.test(owner) || !/^\d+$/.test(criterion)) {
        throw new GoogleAdsMutationValidationError('criterion removal requires numeric owner id and criterion id.');
    }
    return `customers/${customerId}/${collection}/${owner}~${criterion}`;
}

function sharedSetIdFromChange(change: any, expectedCustomerId?: string): string {
    const explicit = clean(change.sharedSetId || change.ownerId);
    const resource = clean(change.sharedSetResourceName || change.sharedSet);
    const match = resource.match(/^customers\/(\d+)\/sharedSets\/(\d+)$/);
    if (resource && !match) throw new GoogleAdsMutationValidationError('sharedSetId or a valid sharedSetResourceName is required.');
    if (match && expectedCustomerId && match[1] !== expectedCustomerId) {
        throw new GoogleAdsMutationValidationError('The shared negative keyword list belongs to a different Google Ads account.');
    }
    if (explicit) {
        const id = normalizeEntityId(explicit, 'sharedSetId');
        if (match && match[2] !== id) throw new GoogleAdsMutationValidationError('sharedSetId does not match sharedSetResourceName.');
        return id;
    }
    if (!match) throw new GoogleAdsMutationValidationError('sharedSetId or a valid sharedSetResourceName is required.');
    return match[2];
}

function existingCriterionResourceName(
    customerId: string,
    collection: 'adGroupCriteria' | 'campaignCriteria' | 'sharedCriteria',
    ownerId: unknown,
    criterionId: unknown,
    suppliedResourceName: unknown
): string {
    const supplied = clean(suppliedResourceName);
    const owner = clean(ownerId);
    if (supplied) {
        const escapedOwner = owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`^customers/${customerId}/${collection}/${escapedOwner}~\\d+$`);
        if (!pattern.test(supplied)) {
            throw new GoogleAdsMutationValidationError('The criterion resource name does not match the selected account and owner.');
        }
        return supplied;
    }
    const expected = criterionResourceName(customerId, collection, owner, criterionId);
    if (!expected) {
        throw new GoogleAdsMutationValidationError('The criterion resource name does not match the selected account and owner.');
    }
    return expected;
}

function addTouched(touched: BuiltMutation['touched'], change: any): void {
    const campaignId = cleanOptional(change.campaignId);
    const adGroupId = cleanOptional(change.adGroupId);
    if (campaignId && !touched.campaignIds.includes(campaignId)) touched.campaignIds.push(campaignId);
    if (adGroupId && !touched.adGroupIds.includes(adGroupId)) touched.adGroupIds.push(adGroupId);
}

function pushOperation(map: Record<string, any[]>, path: string, operation: any): void {
    if (!map[path]) map[path] = [];
    map[path].push(operation);
}

function gaqlString(value: string): string {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function operationKey(mutationType: string, raw: any): string {
    const action = clean(raw.action || raw.operation).toLowerCase();
    const scope = clean(raw.scope || (raw.adGroupId ? 'ad_group' : raw.sharedSetId || raw.sharedSetResourceName ? 'shared_list' : 'campaign')).toLowerCase().replace(/[\s-]+/g, '_');
    const entityType = clean(raw.entityType || raw.scope).toLowerCase().replace('-', '_');
    return [
        mutationType,
        action,
        scope,
        entityType,
        clean(raw.campaignId || raw.entityId),
        clean(raw.adGroupId || raw.entityId),
        clean(raw.sharedSetId || raw.sharedSetResourceName),
        clean(raw.criterionId || raw.resourceName),
        clean(raw.keywordText || raw.keyword).toLowerCase().replace(/\s+/g, ' '),
        clean(raw.matchType).toUpperCase().replace(/[\s-]+/g, '_'),
        clean(raw.newKeywordText).toLowerCase().replace(/\s+/g, ' '),
        clean(raw.newMatchType).toUpperCase().replace(/[\s-]+/g, '_'),
        clean(raw.finalUrl),
        clean(raw.targetStatus || raw.status).toUpperCase(),
        clean(raw.dayOfWeek).toUpperCase(),
        clean(raw.startHour),
        clean(raw.startMinute).toUpperCase(),
        clean(raw.endHour),
        clean(raw.endMinute).toUpperCase()
    ].join('|');
}

function dedupeInputChanges(mutationType: string, changes: any[]): PreparedChanges {
    const seen = new Set<string>();
    const deduped: any[] = [];
    const warnings: string[] = [];
    for (const change of changes) {
        const key = operationKey(mutationType, change);
        if (seen.has(key)) {
            warnings.push('Duplicate change ignored before preview.');
            continue;
        }
        seen.add(key);
        deduped.push(change);
    }
    return { changes: deduped, warnings };
}

async function querySnapshotRows(pool: Pool, sql: string, params: any[]): Promise<any[]> {
    try {
        const result = await pool.query(sql, params);
        return result.rows || [];
    } catch {
        return [];
    }
}

function activeCriterionRows(rows: any[]): any[] {
    return rows.filter(row => String(row.status || row.criterion_status || '').toUpperCase() !== 'REMOVED');
}

async function findConfiguredKeywordRows(pool: Pool, customerId: string, change: any): Promise<any[]> {
    const adGroupId = clean(change.adGroupId);
    const keywordText = normalizeKeywordText(change.keywordText || change.keyword);
    const matchType = normalizeMatchType(change.matchType);
    return activeCriterionRows(await querySnapshotRows(pool, `
        SELECT campaign_id, ad_group_id, criterion_id, criterion_resource_name, keyword_text, match_type, status
        FROM google_ads_configured_keywords
        WHERE customer_id = $1
          AND ad_group_id = $2
          AND lower(keyword_text) = lower($3)
          AND match_type = $4
          AND present_in_latest_snapshot = true
        LIMIT 2`,
        [customerId, adGroupId, keywordText, matchType]
    ));
}

async function findNegativeKeywordRows(pool: Pool, customerId: string, change: any): Promise<any[]> {
    const scope = normalizeNegativeScope(change.scope, change);
    const keywordText = normalizeKeywordText(change.keywordText || change.keyword);
    const matchType = normalizeMatchType(change.matchType);
    if (scope === 'campaign') {
        return activeCriterionRows(await querySnapshotRows(pool, `
            SELECT campaign_id, criterion_id, keyword_text, match_type, status
            FROM google_ads_campaign_negatives
            WHERE customer_id = $1
              AND campaign_id = $2
              AND lower(keyword_text) = lower($3)
              AND match_type = $4
              AND present_in_latest_snapshot = true
            LIMIT 2`,
            [customerId, clean(change.campaignId), keywordText, matchType]
        ));
    }
    if (scope === 'ad_group') {
        return activeCriterionRows(await querySnapshotRows(pool, `
            SELECT campaign_id, ad_group_id, criterion_id, keyword_text, match_type, status
            FROM google_ads_ad_group_negatives
            WHERE customer_id = $1
              AND ad_group_id = $2
              AND lower(keyword_text) = lower($3)
              AND match_type = $4
              AND present_in_latest_snapshot = true
            LIMIT 2`,
            [customerId, clean(change.adGroupId), keywordText, matchType]
        ));
    }
    const sharedSetId = sharedSetIdFromChange(change, customerId);
    const sharedSetResource = `customers/${customerId}/sharedSets/${sharedSetId}`;
    return activeCriterionRows(await querySnapshotRows(pool, `
        SELECT shared_set_resource_name, criterion_id, keyword_text, match_type, 'ENABLED' AS status
        FROM google_ads_shared_negative_criteria
        WHERE customer_id = $1
          AND shared_set_resource_name = $2
          AND lower(keyword_text) = lower($3)
          AND match_type = $4
          AND present_in_latest_snapshot = true
        LIMIT 2`,
        [customerId, sharedSetResource, keywordText, matchType]
    ));
}

async function resolveKeywordViaGaql(token: string, customerId: string, change: any, negative: boolean, scope: 'campaign' | 'ad_group' | 'shared_list'): Promise<any[]> {
    const keywordText = normalizeKeywordText(change.keywordText || change.keyword);
    const matchType = normalizeMatchType(change.matchType);
    if (scope === 'campaign') {
        const campaignId = normalizeEntityId(change.campaignId, 'campaignId');
        return executeGaql(token, customerId, `
            SELECT campaign.id, campaign_criterion.criterion_id, campaign_criterion.keyword.text,
                   campaign_criterion.keyword.match_type, campaign_criterion.status
            FROM campaign_criterion
            WHERE campaign.id = ${campaignId}
              AND campaign_criterion.type = KEYWORD
              AND campaign_criterion.negative = TRUE
              AND campaign_criterion.status != REMOVED
              AND campaign_criterion.keyword.text = ${gaqlString(keywordText)}
              AND campaign_criterion.keyword.match_type = ${matchType}
            LIMIT 2
        `);
    }
    if (scope === 'shared_list') {
        const sharedSetId = sharedSetIdFromChange(change, customerId);
        return executeGaql(token, customerId, `
            SELECT shared_criterion.criterion_id, shared_criterion.resource_name,
                   shared_criterion.shared_set, shared_criterion.keyword.text,
                   shared_criterion.keyword.match_type
            FROM shared_criterion
            WHERE shared_criterion.shared_set = ${gaqlString(`customers/${customerId}/sharedSets/${sharedSetId}`)}
              AND shared_criterion.type = KEYWORD
              AND shared_criterion.negative = TRUE
              AND shared_criterion.keyword.text = ${gaqlString(keywordText)}
              AND shared_criterion.keyword.match_type = ${matchType}
            LIMIT 2
        `);
    }
    const adGroupId = normalizeEntityId(change.adGroupId, 'adGroupId');
    return executeGaql(token, customerId, `
        SELECT campaign.id, ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.resource_name,
               ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status
        FROM ad_group_criterion
        WHERE ad_group.id = ${adGroupId}
          AND ad_group_criterion.type = KEYWORD
          AND ad_group_criterion.negative = ${negative ? 'TRUE' : 'FALSE'}
          AND ad_group_criterion.status != REMOVED
          AND ad_group_criterion.keyword.text = ${gaqlString(keywordText)}
          AND ad_group_criterion.keyword.match_type = ${matchType}
        LIMIT 2
    `);
}

async function findCurrentConfiguredKeywordRows(pool: Pool, customerId: string, token: string, change: any): Promise<any[]> {
    const snapshotRows = await findConfiguredKeywordRows(pool, customerId, change);
    return snapshotRows.length ? snapshotRows : await resolveKeywordViaGaql(token, customerId, change, false, 'ad_group');
}

async function findCurrentNegativeKeywordRows(pool: Pool, customerId: string, token: string, change: any): Promise<any[]> {
    const scope = normalizeNegativeScope(change.scope, change);
    const snapshotRows = await findNegativeKeywordRows(pool, customerId, change);
    return snapshotRows.length ? snapshotRows : await resolveKeywordViaGaql(token, customerId, change, true, scope);
}

function keywordRowText(row: any): string {
    return clean(row.keyword_text || row['ad_group_criterion.keyword.text'] || row['campaign_criterion.keyword.text'] || row['shared_criterion.keyword.text']).replace(/\s+/g, ' ');
}

function keywordRowMatchType(row: any): string {
    return clean(row.match_type || row['ad_group_criterion.keyword.match_type'] || row['campaign_criterion.keyword.match_type'] || row['shared_criterion.keyword.match_type']).toUpperCase();
}

function matchingKeywordRows(rows: any[], change: any): any[] {
    const text = normalizeKeywordText(change.keywordText || change.keyword).toLowerCase();
    const matchType = normalizeMatchType(change.matchType);
    return activeCriterionRows(rows).filter(row => keywordRowText(row).toLowerCase() === text && keywordRowMatchType(row) === matchType);
}

function currentOwnerCacheKey(mutationType: 'keyword_changes' | 'negative_keyword_changes', change: any): string {
    if (mutationType === 'keyword_changes') return `keyword|ad_group|${clean(change.adGroupId)}`;
    const scope = normalizeNegativeScope(change.scope, change);
    const owner = scope === 'campaign' ? clean(change.campaignId) : scope === 'ad_group' ? clean(change.adGroupId) : clean(change.sharedSetId || change.sharedSetResourceName);
    return `negative|${scope}|${owner}`;
}

async function loadCurrentOwnerKeywordRows(
    pool: Pool,
    customerId: string,
    token: string,
    mutationType: 'keyword_changes' | 'negative_keyword_changes',
    change: any,
    source: 'snapshot' | 'live'
): Promise<any[]> {
    if (mutationType === 'keyword_changes') {
        const adGroupId = normalizeEntityId(change.adGroupId, 'adGroupId');
        if (source === 'snapshot') {
            return activeCriterionRows(await querySnapshotRows(pool, `
                SELECT campaign_id, ad_group_id, criterion_id, criterion_resource_name, keyword_text, match_type, status
                FROM google_ads_configured_keywords
                WHERE customer_id = $1 AND ad_group_id = $2 AND present_in_latest_snapshot = true
                LIMIT 10000`, [customerId, adGroupId]));
        }
        return executeGaql(token, customerId, `
            SELECT campaign.id, ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.resource_name,
                   ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status
            FROM ad_group_criterion
            WHERE ad_group.id = ${adGroupId}
              AND ad_group_criterion.type = KEYWORD
              AND ad_group_criterion.negative = FALSE
              AND ad_group_criterion.status != REMOVED
            LIMIT 10000
        `);
    }
    const scope = normalizeNegativeScope(change.scope, change);
    if (scope === 'campaign') {
        const campaignId = normalizeEntityId(change.campaignId, 'campaignId');
        if (source === 'snapshot') {
            return activeCriterionRows(await querySnapshotRows(pool, `
                SELECT campaign_id, criterion_id, keyword_text, match_type, status
                FROM google_ads_campaign_negatives
                WHERE customer_id = $1 AND campaign_id = $2 AND present_in_latest_snapshot = true
                LIMIT 10000`, [customerId, campaignId]));
        }
        return executeGaql(token, customerId, `
            SELECT campaign.id, campaign_criterion.criterion_id, campaign_criterion.resource_name,
                   campaign_criterion.keyword.text, campaign_criterion.keyword.match_type, campaign_criterion.status
            FROM campaign_criterion
            WHERE campaign.id = ${campaignId}
              AND campaign_criterion.type = KEYWORD
              AND campaign_criterion.negative = TRUE
              AND campaign_criterion.status != REMOVED
            LIMIT 10000
        `);
    }
    if (scope === 'ad_group') {
        const adGroupId = normalizeEntityId(change.adGroupId, 'adGroupId');
        if (source === 'snapshot') {
            return activeCriterionRows(await querySnapshotRows(pool, `
                SELECT campaign_id, ad_group_id, criterion_id, keyword_text, match_type, status
                FROM google_ads_ad_group_negatives
                WHERE customer_id = $1 AND ad_group_id = $2 AND present_in_latest_snapshot = true
                LIMIT 10000`, [customerId, adGroupId]));
        }
        return executeGaql(token, customerId, `
            SELECT campaign.id, ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.resource_name,
                   ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status
            FROM ad_group_criterion
            WHERE ad_group.id = ${adGroupId}
              AND ad_group_criterion.type = KEYWORD
              AND ad_group_criterion.negative = TRUE
              AND ad_group_criterion.status != REMOVED
            LIMIT 10000
        `);
    }
    const sharedSetId = sharedSetIdFromChange(change, customerId);
    const sharedSetResource = `customers/${customerId}/sharedSets/${sharedSetId}`;
    if (source === 'snapshot') {
        return querySnapshotRows(pool, `
            SELECT shared_set_resource_name, criterion_id, keyword_text, match_type, 'ENABLED' AS status
            FROM google_ads_shared_negative_criteria
            WHERE customer_id = $1 AND shared_set_resource_name = $2 AND present_in_latest_snapshot = true
            LIMIT 10000`, [customerId, sharedSetResource]);
    }
    return executeGaql(token, customerId, `
        SELECT shared_criterion.criterion_id, shared_criterion.resource_name, shared_criterion.shared_set,
               shared_criterion.keyword.text, shared_criterion.keyword.match_type
        FROM shared_criterion
        WHERE shared_criterion.shared_set = ${gaqlString(sharedSetResource)}
          AND shared_criterion.type = KEYWORD
          AND shared_criterion.negative = TRUE
        LIMIT 10000
    `);
}

async function findCurrentKeywordRowsCached(
    pool: Pool,
    customerId: string,
    token: string,
    mutationType: 'keyword_changes' | 'negative_keyword_changes',
    change: any,
    cache: Map<string, Promise<any[]>>
): Promise<any[]> {
    const ownerKey = currentOwnerCacheKey(mutationType, change);
    const snapshotKey = `${ownerKey}|snapshot`;
    if (!cache.has(snapshotKey)) {
        cache.set(snapshotKey, loadCurrentOwnerKeywordRows(pool, customerId, token, mutationType, change, 'snapshot'));
    }
    const snapshotMatches = matchingKeywordRows(await cache.get(snapshotKey)!, change);
    if (snapshotMatches.length) return snapshotMatches;

    const liveKey = `${ownerKey}|live`;
    if (!cache.has(liveKey)) {
        cache.set(liveKey, loadCurrentOwnerKeywordRows(pool, customerId, token, mutationType, change, 'live'));
    }
    return matchingKeywordRows(await cache.get(liveKey)!, change);
}

async function findOppositeSnapshotRows(
    pool: Pool,
    customerId: string,
    mutationType: 'keyword_changes' | 'negative_keyword_changes',
    change: any
): Promise<any[]> {
    const keywordText = normalizeKeywordText(change.keywordText || change.keyword);
    if (mutationType === 'keyword_changes') {
        const adGroupRows = activeCriterionRows(await querySnapshotRows(pool, `
            SELECT campaign_id, ad_group_id, keyword_text, match_type, status
            FROM google_ads_ad_group_negatives
            WHERE customer_id = $1
              AND ad_group_id = $2
              AND lower(keyword_text) = lower($3)
              AND present_in_latest_snapshot = true
            LIMIT 20`,
            [customerId, clean(change.adGroupId), keywordText]
        ));
        const campaignRows = activeCriterionRows(await querySnapshotRows(pool, `
            SELECT campaign_id, keyword_text, match_type, status
            FROM google_ads_campaign_negatives
            WHERE customer_id = $1
              AND campaign_id = $2
              AND lower(keyword_text) = lower($3)
              AND present_in_latest_snapshot = true
            LIMIT 20`,
            [customerId, clean(change.campaignId), keywordText]
        ));
        const sharedRows = activeCriterionRows(await querySnapshotRows(pool, `
            SELECT css.campaign_id, sc.shared_set_resource_name, sc.keyword_text, sc.match_type,
                   'ENABLED' AS status, 'shared_list' AS conflict_scope
            FROM google_ads_shared_negative_criteria sc
            JOIN google_ads_campaign_shared_sets css
              ON css.customer_id = sc.customer_id
             AND css.shared_set_resource_name = sc.shared_set_resource_name
             AND css.present_in_latest_snapshot = true
             AND upper(coalesce(css.status, 'ENABLED')) NOT IN ('REMOVED', 'DISABLED')
            WHERE sc.customer_id = $1
              AND css.campaign_id = $2
              AND lower(sc.keyword_text) = lower($3)
              AND sc.present_in_latest_snapshot = true
            UNION ALL
            SELECT NULL AS campaign_id, sc.shared_set_resource_name, sc.keyword_text, sc.match_type,
                   'ENABLED' AS status, 'account' AS conflict_scope
            FROM google_ads_shared_negative_criteria sc
            JOIN google_ads_account_negative_lists anl
              ON anl.customer_id = sc.customer_id
             AND anl.shared_set_resource_name = sc.shared_set_resource_name
             AND anl.present_in_latest_snapshot = true
            WHERE sc.customer_id = $1
              AND lower(sc.keyword_text) = lower($3)
              AND sc.present_in_latest_snapshot = true
            LIMIT 100`,
            [customerId, clean(change.campaignId), keywordText]
        ));
        return [...adGroupRows.map(row => ({ ...row, conflict_scope: 'ad_group' })),
            ...campaignRows.map(row => ({ ...row, conflict_scope: 'campaign' })),
            ...sharedRows];
    }

    const scope = normalizeNegativeScope(change.scope, change);
    const scopeClause = scope === 'campaign' ? 'campaign_id = $2' : scope === 'ad_group' ? 'ad_group_id = $2' : 'customer_id = $1';
    const ownerId = scope === 'campaign' ? clean(change.campaignId) : scope === 'ad_group' ? clean(change.adGroupId) : customerId;
    return activeCriterionRows(await querySnapshotRows(pool, `
        SELECT campaign_id, ad_group_id, keyword_text, match_type, status
        FROM google_ads_configured_keywords
        WHERE customer_id = $1
          AND ${scopeClause}
          AND lower(keyword_text) = lower($3)
          AND present_in_latest_snapshot = true
        LIMIT 100`,
        [customerId, ownerId, keywordText]
    )).map(row => ({ ...row, conflict_scope: 'ad_group' }));
}

async function resolveOppositeRowsViaGaql(
    token: string,
    customerId: string,
    mutationType: 'keyword_changes' | 'negative_keyword_changes',
    change: any
): Promise<any[]> {
    const keywordText = normalizeKeywordText(change.keywordText || change.keyword);
    if (mutationType === 'keyword_changes') {
        const campaignId = normalizeEntityId(change.campaignId, 'campaignId');
        const adGroupId = normalizeEntityId(change.adGroupId, 'adGroupId');
        const [adGroupRows, campaignRows, campaignSharedSets, accountNegativeLists] = await Promise.all([
            executeGaql(token, customerId, `
                SELECT campaign.id, ad_group.id, ad_group_criterion.keyword.match_type, ad_group_criterion.status
                FROM ad_group_criterion
                WHERE ad_group.id = ${adGroupId}
                  AND ad_group_criterion.type = KEYWORD
                  AND ad_group_criterion.negative = TRUE
                  AND ad_group_criterion.status != REMOVED
                  AND ad_group_criterion.keyword.text = ${gaqlString(keywordText)}
                LIMIT 20
            `),
            executeGaql(token, customerId, `
                SELECT campaign.id, campaign_criterion.keyword.match_type, campaign_criterion.status
                FROM campaign_criterion
                WHERE campaign.id = ${campaignId}
                  AND campaign_criterion.type = KEYWORD
                  AND campaign_criterion.negative = TRUE
                  AND campaign_criterion.status != REMOVED
                  AND campaign_criterion.keyword.text = ${gaqlString(keywordText)}
                LIMIT 20
            `),
            executeGaql(token, customerId, `
                SELECT campaign.id, campaign_shared_set.shared_set, campaign_shared_set.status
                FROM campaign_shared_set
                WHERE campaign.id = ${campaignId}
                  AND campaign_shared_set.status = ENABLED
                LIMIT 100
            `),
            executeGaql(token, customerId, `
                SELECT customer_negative_criterion.negative_keyword_list.shared_set
                FROM customer_negative_criterion
                WHERE customer_negative_criterion.type = NEGATIVE_KEYWORD_LIST
                LIMIT 100
            `)
        ]);
        const sharedSetScopes = new Map<string, 'account' | 'shared_list'>();
        campaignSharedSets.forEach(row => {
            const resource = clean(row['campaign_shared_set.shared_set']);
            if (resource) sharedSetScopes.set(resource, 'shared_list');
        });
        accountNegativeLists.forEach(row => {
            const resource = clean(row['customer_negative_criterion.negative_keyword_list.shared_set']);
            if (resource) sharedSetScopes.set(resource, 'account');
        });
        const sharedResources = Array.from(sharedSetScopes.keys());
        const sharedRows = sharedResources.length
            ? await executeGaql(token, customerId, `
                SELECT shared_criterion.shared_set, shared_criterion.keyword.match_type
                FROM shared_criterion
                WHERE shared_criterion.shared_set IN (${sharedResources.map(gaqlString).join(', ')})
                  AND shared_criterion.type = KEYWORD
                  AND shared_criterion.negative = TRUE
                  AND shared_criterion.keyword.text = ${gaqlString(keywordText)}
                LIMIT 100
            `)
            : [];
        return [...adGroupRows.map(row => ({ ...row, conflict_scope: 'ad_group' })),
            ...campaignRows.map(row => ({ ...row, conflict_scope: 'campaign' })),
            ...sharedRows.map(row => {
                const sharedSetResource = clean(row['shared_criterion.shared_set']);
                return { ...row, shared_set_resource_name: sharedSetResource, conflict_scope: sharedSetScopes.get(sharedSetResource) || 'shared_list' };
            })];
    }

    const scope = normalizeNegativeScope(change.scope, change);
    const ownerClause = scope === 'campaign'
        ? `campaign.id = ${normalizeEntityId(change.campaignId, 'campaignId')}`
        : scope === 'ad_group'
            ? `ad_group.id = ${normalizeEntityId(change.adGroupId, 'adGroupId')}`
            : 'campaign.status != REMOVED';
    return (await executeGaql(token, customerId, `
        SELECT campaign.id, ad_group.id, ad_group_criterion.keyword.match_type, ad_group_criterion.status
        FROM ad_group_criterion
        WHERE ${ownerClause}
          AND ad_group_criterion.type = KEYWORD
          AND ad_group_criterion.negative = FALSE
          AND ad_group_criterion.status != REMOVED
          AND ad_group_criterion.keyword.text = ${gaqlString(keywordText)}
        LIMIT 100
    `)).map(row => ({ ...row, conflict_scope: 'ad_group' }));
}

function normalizeConflictRow(row: any, kind: KeywordConflict['kind'], fallback: any): KeywordConflict {
    const rawScope = String(row.conflict_scope || (kind === 'keyword' ? 'ad_group' : fallback.scope || 'ad_group'));
    const scope: KeywordConflict['scope'] = rawScope === 'account'
        ? 'account'
        : rawScope === 'shared_list'
            ? 'shared_list'
            : rawScope === 'campaign'
                ? 'campaign'
                : 'ad_group';
    return {
        kind,
        scope,
        campaignId: cleanOptional(row.campaign_id || row['campaign.id'] || fallback.campaignId),
        adGroupId: scope === 'ad_group'
            ? cleanOptional(row.ad_group_id || row['ad_group.id'] || fallback.adGroupId)
            : null,
        sharedSetId: scope === 'account' || scope === 'shared_list'
            ? cleanOptional(row.shared_set_id || String(row.shared_set_resource_name || '').split('/').pop())
            : null,
        matchType: normalizeMatchType(row.match_type || row['ad_group_criterion.keyword.match_type'] || row['campaign_criterion.keyword.match_type'] || row['shared_criterion.keyword.match_type'])
    };
}

function uniqueKeywordConflicts(conflicts: KeywordConflict[]): KeywordConflict[] {
    const seen = new Set<string>();
    return conflicts.filter(conflict => {
        const key = [conflict.kind, conflict.scope, conflict.campaignId, conflict.adGroupId, conflict.matchType].join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export async function preflightGoogleAdsKeywordMutation(pool: Pool, input: {
    customerId?: unknown;
    mutationType: unknown;
    change: any;
}): Promise<KeywordMutationPreflightResult> {
    const mutationType = clean(input.mutationType) as 'keyword_changes' | 'negative_keyword_changes';
    if (mutationType !== 'keyword_changes' && mutationType !== 'negative_keyword_changes') {
        throw new GoogleAdsMutationValidationError('Keyword preflight only supports keyword or negative keyword changes.');
    }
    const change = { ...(input.change || {}) };
    const action = clean(change.action || change.operation).toLowerCase();
    if (!['add', 'create'].includes(action)) {
        throw new GoogleAdsMutationValidationError('Keyword preflight only supports add actions.');
    }
    const token = await getAccessToken();
    const customerId = normalizeCustomerId(input.customerId) || await getAccessibleCustomer(token);
    const keywordText = normalizeKeywordText(change.keywordText || change.keyword);
    const matchType = normalizeMatchType(change.matchType);
    const scope = mutationType === 'keyword_changes'
        ? 'ad_group'
        : normalizeNegativeScope(change.scope, change);
    if (scope !== 'shared_list') change.campaignId = normalizeEntityId(change.campaignId, 'campaignId');
    if (scope === 'ad_group') change.adGroupId = normalizeEntityId(change.adGroupId, 'adGroupId');
    if (scope === 'shared_list') change.sharedSetId = sharedSetIdFromChange(change, customerId);
    change.scope = scope;

    const duplicateRows = mutationType === 'keyword_changes'
        ? await findCurrentConfiguredKeywordRows(pool, customerId, token, change)
        : await findCurrentNegativeKeywordRows(pool, customerId, token, change);
    const target: KeywordMutationPreflightResult['target'] = {
        scope,
        campaignId: cleanOptional(change.campaignId),
        adGroupId: scope === 'ad_group' ? cleanOptional(change.adGroupId) : null,
        sharedSetId: scope === 'shared_list' ? cleanOptional(change.sharedSetId) : null
    };
    if (duplicateRows.length) {
        return {
            duplicate: true,
            keywordText,
            matchType,
            target,
            oppositeConflicts: []
        };
    }
    const snapshotOppositeRows = await findOppositeSnapshotRows(pool, customerId, mutationType, change);
    const oppositeRows = snapshotOppositeRows.length
        ? snapshotOppositeRows
        : await resolveOppositeRowsViaGaql(token, customerId, mutationType, change);
    const oppositeKind: KeywordConflict['kind'] = mutationType === 'keyword_changes' ? 'negative_keyword' : 'keyword';

    return {
        duplicate: false,
        keywordText,
        matchType,
        target,
        oppositeConflicts: uniqueKeywordConflicts(oppositeRows.map(row => normalizeConflictRow(row, oppositeKind, change)))
    };
}

async function resolveRemovalChange(pool: Pool, customerId: string, token: string, mutationType: GoogleAdsMutationType, change: any): Promise<any> {
    if (cleanOptional(change.resourceName) || cleanOptional(change.criterionId)) return change;
    if (mutationType === 'keyword_changes') {
        const snapshotRows = await findConfiguredKeywordRows(pool, customerId, change);
        const liveRows = snapshotRows.length ? snapshotRows : await resolveKeywordViaGaql(token, customerId, change, false, 'ad_group');
        if (liveRows.length !== 1) {
            throw new GoogleAdsMutationValidationError(liveRows.length > 1
                ? 'Keyword removal matched multiple active criteria. Provide criterionId or resourceName.'
                : 'Keyword removal did not match an active criterion. Provide criterionId/resourceName or refresh warehouse data.');
        }
        const row = liveRows[0];
        return {
            ...change,
            criterionId: row.criterion_id || row['ad_group_criterion.criterion_id'],
            resourceName: row.criterion_resource_name || row['ad_group_criterion.resource_name']
        };
    }

    if (mutationType === 'negative_keyword_changes') {
        const scope = normalizeNegativeScope(change.scope, change);
        const snapshotRows = await findNegativeKeywordRows(pool, customerId, change);
        const liveRows = snapshotRows.length ? snapshotRows : await resolveKeywordViaGaql(token, customerId, change, true, scope);
        if (liveRows.length !== 1) {
            throw new GoogleAdsMutationValidationError(liveRows.length > 1
                ? 'Negative keyword removal matched multiple active criteria. Provide criterionId or resourceName.'
                : 'Negative keyword removal did not match an active criterion. Provide criterionId/resourceName or refresh warehouse data.');
        }
        const row = liveRows[0];
        return {
            ...change,
            criterionId: row.criterion_id || row['campaign_criterion.criterion_id'] || row['ad_group_criterion.criterion_id'] || row['shared_criterion.criterion_id'],
            resourceName: row.criterion_resource_name || row['campaign_criterion.resource_name'] || row['ad_group_criterion.resource_name'] || row['shared_criterion.resource_name']
        };
    }

    return change;
}

function criterionIdFromRow(row: any): string | null {
    return cleanOptional(
        row.criterion_id
        || row['ad_group_criterion.criterion_id']
        || row['campaign_criterion.criterion_id']
        || row['shared_criterion.criterion_id']
    );
}

async function hydrateCurrentKeywordChange(pool: Pool, customerId: string, mutationType: GoogleAdsMutationType, change: any): Promise<any> {
    const criterionId = cleanOptional(change.criterionId);
    if (!criterionId) return change;
    if (mutationType === 'keyword_changes') {
        const rows = await querySnapshotRows(pool, `
            SELECT criterion_id, criterion_resource_name, keyword_text, match_type, status, final_urls
            FROM google_ads_configured_keywords
            WHERE customer_id = $1 AND ad_group_id = $2 AND criterion_id = $3
              AND present_in_latest_snapshot = true
            LIMIT 1`,
            [customerId, clean(change.adGroupId), criterionId]
        );
        const row = rows[0];
        if (!row) return change;
        const finalUrls = Array.isArray(row.final_urls) ? row.final_urls : [];
        return {
            ...change,
            resourceName: change.resourceName || row.criterion_resource_name,
            keywordText: change.keywordText || row.keyword_text,
            matchType: change.matchType || row.match_type,
            currentStatus: change.currentStatus || row.status,
            currentFinalUrl: change.currentFinalUrl ?? finalUrls[0] ?? ''
        };
    }
    if (mutationType !== 'negative_keyword_changes') return change;
    const scope = normalizeNegativeScope(change.scope, change);
    const table = scope === 'campaign'
        ? 'google_ads_campaign_negatives'
        : scope === 'ad_group'
            ? 'google_ads_ad_group_negatives'
            : 'google_ads_shared_negative_criteria';
    const ownerColumn = scope === 'campaign' ? 'campaign_id' : scope === 'ad_group' ? 'ad_group_id' : 'shared_set_resource_name';
    const ownerId = scope === 'campaign'
        ? clean(change.campaignId)
        : scope === 'ad_group'
            ? clean(change.adGroupId)
            : `customers/${customerId}/sharedSets/${sharedSetIdFromChange(change, customerId)}`;
    const rows = await querySnapshotRows(pool, `
        SELECT criterion_id, keyword_text, match_type${scope === 'shared_list' ? '' : ', status'}
        FROM ${table}
        WHERE customer_id = $1 AND ${ownerColumn} = $2 AND criterion_id = $3
          AND present_in_latest_snapshot = true
        LIMIT 1`,
        [customerId, ownerId, criterionId]
    );
    const row = rows[0];
    if (!row) return change;
    return {
        ...change,
        keywordText: change.keywordText || row.keyword_text,
        matchType: change.matchType || row.match_type,
        currentStatus: change.currentStatus || row.status || 'ENABLED'
    };
}

async function oppositeKeywordWarnings(
    pool: Pool,
    customerId: string,
    token: string,
    mutationType: 'keyword_changes' | 'negative_keyword_changes',
    change: any,
    snapshotCache?: Map<string, Promise<any[]>>
): Promise<string[]> {
    let rows: any[];
    if (snapshotCache) {
        const scope = mutationType === 'keyword_changes' ? 'ad_group' : normalizeNegativeScope(change.scope, change);
        const owner = mutationType === 'keyword_changes'
            ? `${clean(change.campaignId)}|${clean(change.adGroupId)}`
            : scope === 'campaign'
                ? clean(change.campaignId)
                : scope === 'ad_group'
                    ? clean(change.adGroupId)
                    : sharedSetIdFromChange(change, customerId);
        const cacheKey = `${mutationType}|${scope}|${owner}`;
        if (!snapshotCache.has(cacheKey)) {
            snapshotCache.set(cacheKey, loadOppositeOwnerSnapshotRows(pool, customerId, mutationType, change));
        }
        const keywordText = normalizeKeywordText(change.keywordText || change.keyword).toLowerCase();
        rows = activeCriterionRows(await snapshotCache.get(cacheKey)!)
            .filter(row => keywordRowText(row).toLowerCase() === keywordText);
    } else {
        const snapshotRows = await findOppositeSnapshotRows(pool, customerId, mutationType, change);
        rows = snapshotRows.length ? snapshotRows : await resolveOppositeRowsViaGaql(token, customerId, mutationType, change);
    }
    if (!rows.length) return [];
    const kind = mutationType === 'keyword_changes' ? 'negative keyword' : 'positive keyword';
    const text = normalizeKeywordText(change.keywordText || change.keyword);
    return [`“${text}” is already present as an opposite ${kind} in an overlapping scope. This change is allowed, but review the targeting conflict.`];
}

async function loadOppositeOwnerSnapshotRows(
    pool: Pool,
    customerId: string,
    mutationType: 'keyword_changes' | 'negative_keyword_changes',
    change: any
): Promise<any[]> {
    if (mutationType === 'keyword_changes') {
        const [adGroupRows, campaignRows, sharedRows] = await Promise.all([
            querySnapshotRows(pool, `
                SELECT campaign_id, ad_group_id, keyword_text, match_type, status, 'ad_group' AS conflict_scope
                FROM google_ads_ad_group_negatives
                WHERE customer_id = $1 AND ad_group_id = $2 AND present_in_latest_snapshot = true
                LIMIT 10000`, [customerId, clean(change.adGroupId)]),
            querySnapshotRows(pool, `
                SELECT campaign_id, keyword_text, match_type, status, 'campaign' AS conflict_scope
                FROM google_ads_campaign_negatives
                WHERE customer_id = $1 AND campaign_id = $2 AND present_in_latest_snapshot = true
                LIMIT 10000`, [customerId, clean(change.campaignId)]),
            querySnapshotRows(pool, `
                SELECT css.campaign_id, sc.shared_set_resource_name, sc.keyword_text, sc.match_type,
                       'ENABLED' AS status, 'shared_list' AS conflict_scope
                FROM google_ads_shared_negative_criteria sc
                JOIN google_ads_campaign_shared_sets css
                  ON css.customer_id = sc.customer_id
                 AND css.shared_set_resource_name = sc.shared_set_resource_name
                 AND css.present_in_latest_snapshot = true
                 AND upper(coalesce(css.status, 'ENABLED')) NOT IN ('REMOVED', 'DISABLED')
                WHERE sc.customer_id = $1 AND css.campaign_id = $2 AND sc.present_in_latest_snapshot = true
                UNION ALL
                SELECT NULL AS campaign_id, sc.shared_set_resource_name, sc.keyword_text, sc.match_type,
                       'ENABLED' AS status, 'account' AS conflict_scope
                FROM google_ads_shared_negative_criteria sc
                JOIN google_ads_account_negative_lists anl
                  ON anl.customer_id = sc.customer_id
                 AND anl.shared_set_resource_name = sc.shared_set_resource_name
                 AND anl.present_in_latest_snapshot = true
                WHERE sc.customer_id = $1 AND sc.present_in_latest_snapshot = true
                LIMIT 10000`, [customerId, clean(change.campaignId)])
        ]);
        return [...adGroupRows, ...campaignRows, ...sharedRows];
    }

    const scope = normalizeNegativeScope(change.scope, change);
    const scopeClause = scope === 'campaign' ? 'campaign_id = $2' : scope === 'ad_group' ? 'ad_group_id = $2' : 'customer_id = $1';
    const ownerId = scope === 'campaign' ? clean(change.campaignId) : scope === 'ad_group' ? clean(change.adGroupId) : customerId;
    return querySnapshotRows(pool, `
        SELECT campaign_id, ad_group_id, keyword_text, match_type, status, 'ad_group' AS conflict_scope
        FROM google_ads_configured_keywords
        WHERE customer_id = $1 AND ${scopeClause} AND present_in_latest_snapshot = true
        LIMIT 10000`, scope === 'shared_list' ? [customerId] : [customerId, ownerId]);
}

export async function prepareGoogleAdsMutationChanges(pool: Pool, input: {
    customerId: string;
    mutationType: GoogleAdsMutationType;
    changes: any[];
    token: string;
}): Promise<PreparedChanges> {
    if (input.mutationType === 'audience_changes') {
        return prepareAudienceMutationChanges(pool, {
            customerId: input.customerId,
            changes: input.changes,
            token: input.token
        });
    }
    const deduped = dedupeInputChanges(input.mutationType, input.changes);
    const prepared: any[] = [];
    const warnings = [...deduped.warnings];
    const replacementDestinations = new Set<string>();
    const bulkCurrentStateCache = new Map<string, Promise<any[]>>();
    const useBulkCurrentStateCache = deduped.changes.length > 5
        && (input.mutationType === 'keyword_changes' || input.mutationType === 'negative_keyword_changes');
    const bulkOppositeSnapshotCache = useBulkCurrentStateCache ? new Map<string, Promise<any[]>>() : undefined;
    const findCurrentRows = (change: any): Promise<any[]> => {
        if (input.mutationType !== 'keyword_changes' && input.mutationType !== 'negative_keyword_changes') return Promise.resolve([]);
        if (useBulkCurrentStateCache) {
            return findCurrentKeywordRowsCached(
                pool,
                input.customerId,
                input.token,
                input.mutationType,
                change,
                bulkCurrentStateCache
            );
        }
        return input.mutationType === 'keyword_changes'
            ? findCurrentConfiguredKeywordRows(pool, input.customerId, input.token, change)
            : findCurrentNegativeKeywordRows(pool, input.customerId, input.token, change);
    };

    for (const change of deduped.changes) {
        const action = clean(change.action || change.operation).toLowerCase();
        if (input.mutationType === 'keyword_changes' && ['add', 'create'].includes(action)) {
            const rows = await findCurrentRows(change);
            if (rows.length) {
                warnings.push(`Keyword already exists in the selected ad group and was skipped: ${normalizeKeywordText(change.keywordText || change.keyword)} (${normalizeMatchType(change.matchType)}).`);
                continue;
            }
            warnings.push(...await oppositeKeywordWarnings(pool, input.customerId, input.token, 'keyword_changes', change, bulkOppositeSnapshotCache));
        }
        if (input.mutationType === 'negative_keyword_changes' && ['add', 'create'].includes(action)) {
            const rows = await findCurrentRows(change);
            if (rows.length) {
                warnings.push(`Negative keyword already exists at the selected scope and was skipped: ${normalizeKeywordText(change.keywordText || change.keyword)} (${normalizeMatchType(change.matchType)}).`);
                continue;
            }
            warnings.push(...await oppositeKeywordWarnings(pool, input.customerId, input.token, 'negative_keyword_changes', change, bulkOppositeSnapshotCache));
        }
        if ((input.mutationType === 'keyword_changes' || input.mutationType === 'negative_keyword_changes') && ['replace', 'edit'].includes(action)) {
            const hydrated = await hydrateCurrentKeywordChange(pool, input.customerId, input.mutationType, change);
            const currentText = normalizeKeywordText(hydrated.keywordText || hydrated.keyword);
            const currentMatchType = normalizeMatchType(hydrated.matchType);
            const nextText = normalizeKeywordText(hydrated.newKeywordText ?? currentText);
            const nextMatchType = normalizeMatchType(hydrated.newMatchType ?? currentMatchType);
            if (currentText.toLowerCase() === nextText.toLowerCase() && currentMatchType === nextMatchType) {
                warnings.push(`Keyword edit skipped because the text and match type are unchanged: ${currentText} (${currentMatchType}).`);
                continue;
            }
            const scope = input.mutationType === 'keyword_changes' ? 'ad_group' : normalizeNegativeScope(hydrated.scope, hydrated);
            const ownerId = scope === 'campaign'
                ? clean(hydrated.campaignId)
                : scope === 'ad_group'
                    ? clean(hydrated.adGroupId)
                    : sharedSetIdFromChange(hydrated, input.customerId);
            const destinationKey = [input.mutationType, scope, ownerId, nextText.toLowerCase(), nextMatchType].join('|');
            if (replacementDestinations.has(destinationKey)) {
                warnings.push(`Keyword edit skipped because another selected change has the same destination: ${nextText} (${nextMatchType}).`);
                continue;
            }
            replacementDestinations.add(destinationKey);
            const destination = { ...hydrated, keywordText: nextText, matchType: nextMatchType };
            const rows = await findCurrentRows(destination);
            const currentCriterionId = cleanOptional(hydrated.criterionId);
            const duplicateRows = rows.filter(row => criterionIdFromRow(row) !== currentCriterionId);
            if (duplicateRows.length) {
                warnings.push(`${input.mutationType === 'keyword_changes' ? 'Keyword' : 'Negative keyword'} edit skipped because the replacement already exists at the selected scope: ${nextText} (${nextMatchType}).`);
                continue;
            }
            warnings.push(...await oppositeKeywordWarnings(pool, input.customerId, input.token, input.mutationType, destination, bulkOppositeSnapshotCache));
            prepared.push({ ...hydrated, newKeywordText: nextText, newMatchType: nextMatchType });
            continue;
        }
        if (input.mutationType === 'keyword_changes' && ['set_status', 'status', 'set_final_url', 'update_url'].includes(action)) {
            const hydrated = await hydrateCurrentKeywordChange(pool, input.customerId, input.mutationType, change);
            if (['set_status', 'status'].includes(action)) {
                const currentStatus = clean(hydrated.currentStatus).toUpperCase();
                const targetStatus = clean(hydrated.targetStatus || hydrated.status).toUpperCase();
                if (currentStatus && currentStatus === targetStatus) {
                    warnings.push(`Keyword status change skipped because it is already ${targetStatus}.`);
                    continue;
                }
            } else {
                const currentUrl = normalizeFinalUrl(hydrated.currentFinalUrl) || '';
                const nextUrl = normalizeFinalUrl(hydrated.finalUrl) || '';
                if (currentUrl === nextUrl) {
                    warnings.push('Final URL change skipped because the URL is unchanged.');
                    continue;
                }
            }
            prepared.push(hydrated);
            continue;
        }
        if ((input.mutationType === 'keyword_changes' || input.mutationType === 'negative_keyword_changes') && ['remove', 'delete'].includes(action)) {
            prepared.push(await resolveRemovalChange(pool, input.customerId, input.token, input.mutationType, change));
            continue;
        }
        prepared.push(change);
    }

    if (prepared.length === 0) {
        throw new GoogleAdsMutationValidationError(`No actionable Google Ads changes remain after duplicate/current-state checks. ${warnings.join(' ')}`.trim());
    }
    return { changes: prepared, warnings: Array.from(new Set(warnings)) };
}

export function validateAdSchedule(change: any): any {
    const dayOfWeek = clean(change.dayOfWeek).toUpperCase();
    const startHour = Number(change.startHour);
    const endHour = Number(change.endHour);
    const startMinute = clean(change.startMinute || 'ZERO').toUpperCase();
    const endMinute = clean(change.endMinute || 'ZERO').toUpperCase();
    if (!DAYS.has(dayOfWeek)) throw new GoogleAdsMutationValidationError('Ad schedule dayOfWeek is invalid.');
    if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) throw new GoogleAdsMutationValidationError('Ad schedule startHour must be 0-23.');
    if (!Number.isInteger(endHour) || endHour < 0 || endHour > 24) throw new GoogleAdsMutationValidationError('Ad schedule endHour must be 0-24.');
    if (!MINUTE_MARKS.has(startMinute) || !MINUTE_MARKS.has(endMinute)) {
        throw new GoogleAdsMutationValidationError('Ad schedule minutes must be ZERO, FIFTEEN, THIRTY, or FORTY_FIVE.');
    }
    const minuteValue: Record<string, number> = { ZERO: 0, FIFTEEN: 15, THIRTY: 30, FORTY_FIVE: 45 };
    const startTotal = startHour * 60 + minuteValue[startMinute];
    const endTotal = endHour * 60 + minuteValue[endMinute];
    if (endTotal <= startTotal) throw new GoogleAdsMutationValidationError('Ad schedule interval must have a positive length.');
    if (endHour === 24 && endMinute !== 'ZERO') throw new GoogleAdsMutationValidationError('Ad schedule endMinute must be ZERO when endHour is 24.');
    return { dayOfWeek, startHour, startMinute, endHour, endMinute };
}

function enforceScheduleLimits(changes: any[]): void {
    const counts = new Map<string, number>();
    for (const change of changes) {
        if (!['add', 'create', 'set'].includes(clean(change.action).toLowerCase())) continue;
        const day = validateAdSchedule(change).dayOfWeek;
        const campaignId = clean(change.campaignId);
        const key = `${campaignId}|${day}`;
        const next = (counts.get(key) || 0) + 1;
        counts.set(key, next);
        if (next > 6) throw new GoogleAdsMutationValidationError('Ad schedule supports a maximum of six schedules per day.');
    }
}

export function buildGoogleAdsMutationOperations(input: {
    customerId: string;
    mutationType: string;
    changes: any[];
}): BuiltMutation {
    const customerId = normalizeCustomerId(input.customerId);
    if (!customerId) throw new GoogleAdsMutationValidationError('customerId is required.');
    const mutationType = clean(input.mutationType) as GoogleAdsMutationType;
    if (!['keyword_changes', 'negative_keyword_changes', 'ad_schedule_changes', 'entity_status_changes', 'audience_changes'].includes(mutationType)) {
        throw new GoogleAdsMutationValidationError('Unsupported mutationType.');
    }
    if (!Array.isArray(input.changes) || input.changes.length === 0) {
        throw new GoogleAdsMutationValidationError('changes must contain at least one change.');
    }
    if (input.changes.length > 100) throw new GoogleAdsMutationValidationError('A mutation preview can include at most 100 changes.');
    if (mutationType === 'audience_changes') {
        return buildAudienceMutationOperations({ customerId, changes: input.changes });
    }

    const operationsByPath: Record<string, any[]> = {};
    const diff: any[] = [];
    const warnings: string[] = [];
    const touched = { campaignIds: [] as string[], adGroupIds: [] as string[] };
    const duplicateKeys = new Set<string>();

    if (mutationType === 'ad_schedule_changes') enforceScheduleLimits(input.changes);

    for (const raw of input.changes) {
        const action = clean(raw.action || raw.operation).toLowerCase();
        const key = operationKey(mutationType, raw);
        if (duplicateKeys.has(key)) {
            warnings.push('Duplicate change ignored in operation builder.');
            continue;
        }
        duplicateKeys.add(key);
        addTouched(touched, raw);

        if (mutationType === 'keyword_changes') {
            const adGroupId = clean(raw.adGroupId);
            const text = normalizeKeywordText(raw.keywordText || raw.keyword);
            const matchType = normalizeMatchType(raw.matchType);
            const path = 'adGroupCriteria:mutate';
            if (['add', 'create'].includes(action)) {
                const finalUrl = normalizeFinalUrl(raw.finalUrl);
                const create: any = {
                    adGroup: resourceName(customerId, 'adGroups', adGroupId),
                    status: 'ENABLED',
                    negative: false,
                    keyword: { text, matchType }
                };
                if (finalUrl) create.finalUrls = [finalUrl];
                pushOperation(operationsByPath, path, {
                    create
                });
                diff.push({ action: 'add_keyword', adGroupId, keywordText: text, matchType, finalUrl, targetStatus: 'ENABLED' });
            } else if (['remove', 'delete'].includes(action)) {
                const resource = existingCriterionResourceName(customerId, 'adGroupCriteria', adGroupId, raw.criterionId, raw.resourceName);
                pushOperation(operationsByPath, path, { remove: resource });
                diff.push({ action: 'remove_keyword', adGroupId, keywordText: text, matchType, resourceName: resource });
            } else if (['replace', 'edit'].includes(action)) {
                const resource = existingCriterionResourceName(customerId, 'adGroupCriteria', adGroupId, raw.criterionId, raw.resourceName);
                const newKeywordText = normalizeKeywordText(raw.newKeywordText);
                const newMatchType = normalizeMatchType(raw.newMatchType);
                const finalUrl = normalizeFinalUrl(raw.currentFinalUrl ?? raw.finalUrl);
                const status = clean(raw.currentStatus || 'ENABLED').toUpperCase();
                if (!ENTITY_STATUSES.has(status)) throw new GoogleAdsMutationValidationError('Current keyword status must be ENABLED or PAUSED.');
                const create: any = {
                    adGroup: resourceName(customerId, 'adGroups', adGroupId),
                    status,
                    negative: false,
                    keyword: { text: newKeywordText, matchType: newMatchType }
                };
                if (finalUrl) create.finalUrls = [finalUrl];
                pushOperation(operationsByPath, path, { create });
                pushOperation(operationsByPath, path, { remove: resource });
                diff.push({
                    action: 'replace_keyword', adGroupId, resourceName: resource,
                    keywordText: text, matchType, newKeywordText, newMatchType,
                    finalUrl, targetStatus: status
                });
            } else if (['set_status', 'status'].includes(action)) {
                const resource = existingCriterionResourceName(customerId, 'adGroupCriteria', adGroupId, raw.criterionId, raw.resourceName);
                const targetStatus = clean(raw.targetStatus || raw.status).toUpperCase();
                if (!ENTITY_STATUSES.has(targetStatus)) throw new GoogleAdsMutationValidationError('Keyword targetStatus must be ENABLED or PAUSED.');
                pushOperation(operationsByPath, path, {
                    update: { resourceName: resource, status: targetStatus },
                    updateMask: 'status'
                });
                diff.push({ action: 'set_keyword_status', adGroupId, resourceName: resource, keywordText: text, matchType, currentStatus: cleanOptional(raw.currentStatus), targetStatus });
            } else if (['set_final_url', 'update_url'].includes(action)) {
                const resource = existingCriterionResourceName(customerId, 'adGroupCriteria', adGroupId, raw.criterionId, raw.resourceName);
                const finalUrl = normalizeFinalUrl(raw.finalUrl);
                pushOperation(operationsByPath, path, {
                    update: { resourceName: resource, finalUrls: finalUrl ? [finalUrl] : [] },
                    updateMask: 'finalUrls'
                });
                diff.push({ action: 'set_keyword_final_url', adGroupId, resourceName: resource, keywordText: text, matchType, currentFinalUrl: cleanOptional(raw.currentFinalUrl), finalUrl });
            } else {
                throw new GoogleAdsMutationValidationError('Keyword changes support add, remove, replace, set_status, or set_final_url actions.');
            }
        }

        if (mutationType === 'negative_keyword_changes') {
            const scope = normalizeNegativeScope(raw.scope, raw);
            const text = normalizeKeywordText(raw.keywordText || raw.keyword);
            const matchType = normalizeMatchType(raw.matchType);
            const path = scope === 'campaign' ? 'campaignCriteria:mutate' : scope === 'ad_group' ? 'adGroupCriteria:mutate' : 'sharedCriteria:mutate';
            const ownerId = scope === 'campaign' ? clean(raw.campaignId) : scope === 'ad_group' ? clean(raw.adGroupId) : sharedSetIdFromChange(raw, customerId);
            if (['add', 'create'].includes(action)) {
                const create: any = {
                    negative: true,
                    keyword: { text, matchType }
                };
                if (scope === 'campaign') {
                    create.campaign = resourceName(customerId, 'campaigns', ownerId);
                    create.status = 'ENABLED';
                } else if (scope === 'ad_group') {
                    create.adGroup = resourceName(customerId, 'adGroups', ownerId);
                    create.status = 'ENABLED';
                } else {
                    create.sharedSet = resourceName(customerId, 'sharedSets', ownerId);
                }
                pushOperation(operationsByPath, path, { create });
                diff.push({ action: 'add_negative_keyword', scope, ownerId, keywordText: text, matchType });
            } else if (['remove', 'delete'].includes(action)) {
                const collection = scope === 'campaign' ? 'campaignCriteria' : scope === 'ad_group' ? 'adGroupCriteria' : 'sharedCriteria';
                const resource = existingCriterionResourceName(customerId, collection, ownerId, raw.criterionId, raw.resourceName);
                pushOperation(operationsByPath, path, { remove: resource });
                diff.push({ action: 'remove_negative_keyword', scope, ownerId, keywordText: text, matchType, resourceName: resource });
            } else if (['replace', 'edit'].includes(action)) {
                const collection = scope === 'campaign' ? 'campaignCriteria' : scope === 'ad_group' ? 'adGroupCriteria' : 'sharedCriteria';
                const resource = existingCriterionResourceName(customerId, collection, ownerId, raw.criterionId, raw.resourceName);
                const newKeywordText = normalizeKeywordText(raw.newKeywordText);
                const newMatchType = normalizeMatchType(raw.newMatchType);
                const create: any = { negative: true, keyword: { text: newKeywordText, matchType: newMatchType } };
                if (scope === 'campaign') {
                    create.campaign = resourceName(customerId, 'campaigns', ownerId);
                    create.status = clean(raw.currentStatus || 'ENABLED').toUpperCase();
                } else if (scope === 'ad_group') {
                    create.adGroup = resourceName(customerId, 'adGroups', ownerId);
                    create.status = clean(raw.currentStatus || 'ENABLED').toUpperCase();
                } else {
                    create.sharedSet = resourceName(customerId, 'sharedSets', ownerId);
                }
                if (create.status && !ENTITY_STATUSES.has(create.status)) throw new GoogleAdsMutationValidationError('Current negative keyword status must be ENABLED or PAUSED.');
                pushOperation(operationsByPath, path, { create });
                pushOperation(operationsByPath, path, { remove: resource });
                diff.push({ action: 'replace_negative_keyword', scope, ownerId, resourceName: resource, keywordText: text, matchType, newKeywordText, newMatchType });
            } else {
                throw new GoogleAdsMutationValidationError('Negative keyword changes support add, remove, or replace actions.');
            }
        }

        if (mutationType === 'ad_schedule_changes') {
            const campaignId = clean(raw.campaignId);
            const path = 'campaignCriteria:mutate';
            if (['remove', 'delete', 'replace', 'set'].includes(action)) {
                const resource = cleanOptional(raw.resourceName) || (raw.criterionId ? criterionResourceName(customerId, 'campaignCriteria', campaignId, raw.criterionId) : null);
                if (resource) {
                    pushOperation(operationsByPath, path, { remove: resource });
                    const schedule = raw.dayOfWeek || raw.startHour !== undefined || raw.endHour !== undefined
                        ? {
                            dayOfWeek: cleanOptional(raw.dayOfWeek),
                            startHour: cleanOptional(raw.startHour),
                            startMinute: cleanOptional(raw.startMinute),
                            endHour: cleanOptional(raw.endHour),
                            endMinute: cleanOptional(raw.endMinute)
                        }
                        : undefined;
                    diff.push({ action: 'remove_ad_schedule', campaignId, resourceName: resource, ...(schedule ? { schedule } : {}) });
                }
            }
            if (['add', 'create', 'replace', 'set'].includes(action)) {
                const schedule = validateAdSchedule(raw);
                pushOperation(operationsByPath, path, {
                    create: {
                        campaign: resourceName(customerId, 'campaigns', campaignId),
                        negative: false,
                        adSchedule: schedule
                    }
                });
                diff.push({ action: 'add_ad_schedule', campaignId, schedule });
            }
            if (!['add', 'create', 'remove', 'delete', 'replace', 'set'].includes(action)) {
                throw new GoogleAdsMutationValidationError('Ad schedule changes support add, remove, replace, or set actions.');
            }
        }

        if (mutationType === 'entity_status_changes') {
            const entityType = clean(raw.entityType || raw.scope).toLowerCase().replace('-', '_');
            const targetStatus = clean(raw.targetStatus || raw.status).toUpperCase();
            if (!ENTITY_STATUSES.has(targetStatus)) throw new GoogleAdsMutationValidationError('targetStatus must be ENABLED or PAUSED.');
            if (entityType === 'campaign') {
                const campaignId = clean(raw.campaignId || raw.entityId);
                pushOperation(operationsByPath, 'campaigns:mutate', {
                    update: {
                        resourceName: resourceName(customerId, 'campaigns', campaignId),
                        status: targetStatus
                    },
                    updateMask: 'status'
                });
                diff.push({ action: 'set_campaign_status', campaignId, targetStatus, currentStatus: raw.currentStatus || null });
            } else if (entityType === 'ad_group') {
                const adGroupId = clean(raw.adGroupId || raw.entityId);
                pushOperation(operationsByPath, 'adGroups:mutate', {
                    update: {
                        resourceName: resourceName(customerId, 'adGroups', adGroupId),
                        status: targetStatus
                    },
                    updateMask: 'status'
                });
                diff.push({ action: 'set_ad_group_status', campaignId: cleanOptional(raw.campaignId), adGroupId, targetStatus, currentStatus: raw.currentStatus || null });
            } else {
                throw new GoogleAdsMutationValidationError('entityType must be campaign or ad_group.');
            }
        }
    }

    return { mutationType, operationsByPath, diff, warnings, touched };
}

function ttlMinutes(): number {
    const configured = Number(process.env.GOOGLE_ADS_MUTATION_CONFIRM_TTL_MINUTES || DEFAULT_CONFIRM_TTL_MINUTES);
    return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : DEFAULT_CONFIRM_TTL_MINUTES;
}

export function hashConfirmationToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function newConfirmationToken(): string {
    return crypto.randomBytes(24).toString('base64url');
}

function stableJson(value: any): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

async function mutationAuth(): Promise<{ token: string; customerId: string }> {
    const token = await getAccessToken();
    const customerId = await getAccessibleCustomer(token);
    return { token, customerId };
}

export async function mutateGoogleAds(path: string, body: any, customerId?: string): Promise<{ data: any; requestId: string | null }> {
    const auth = await mutationAuth();
    const resolvedCustomerId = normalizeCustomerId(customerId) || auth.customerId;
    try {
        const response = await requestGoogleAdsJson<any>({
            token: auth.token,
            path: `customers/${resolvedCustomerId}/${path}`,
            body,
            retryMode: body?.validateOnly === true ? 'validate_only' : 'mutate'
        });
        return { data: response.data, requestId: response.requestId };
    } catch (err: any) {
        const error: any = new Error('Google Ads mutation failed');
        error.googleAdsErrors = err?.googleAdsErrors?.length ? err.googleAdsErrors : normalizeGoogleAdsErrors(err?.payload?.error || err?.payload || { message: err?.message });
        error.status = err?.status;
        error.requestId = err?.requestId || null;
        throw error;
    }
}

export function normalizeGoogleAdsErrors(error: any): NormalizedGoogleAdsError[] {
    const details = Array.isArray(error?.details) ? error.details : [];
    const googleAdsFailure = details.find((detail: any) => Array.isArray(detail?.errors));
    const errors = googleAdsFailure?.errors || (error ? [error] : []);
    return errors.map((item: any) => ({
        code: item?.errorCode ? Object.keys(item.errorCode).map(key => `${key}.${item.errorCode[key]}`).join(',') : cleanOptional(error?.status),
        message: item?.message || error?.message || 'Google Ads API error',
        fieldPath: Array.isArray(item?.location?.fieldPathElements)
            ? item.location.fieldPathElements.map((field: any) => field.fieldName).filter(Boolean).join('.')
            : null,
        trigger: cleanOptional(item?.trigger?.stringValue || item?.trigger?.int64Value),
        operationIndex: Number.isInteger(item?.location?.fieldPathElements?.[0]?.index)
            ? item.location.fieldPathElements[0].index
            : null
    }));
}

function diffPath(change: any): string | null {
    const action = clean(change?.action).toLowerCase();
    if (['add_keyword', 'remove_keyword', 'replace_keyword', 'set_keyword_status', 'set_keyword_final_url'].includes(action)) return 'adGroupCriteria:mutate';
    if (['add_negative_keyword', 'remove_negative_keyword', 'replace_negative_keyword'].includes(action)) {
        const scope = clean(change?.scope).toLowerCase();
        return scope === 'campaign' ? 'campaignCriteria:mutate' : scope === 'shared_list' || scope === 'account' ? 'sharedCriteria:mutate' : 'adGroupCriteria:mutate';
    }
    if (action === 'add_ad_schedule' || action === 'remove_ad_schedule') return 'campaignCriteria:mutate';
    if (action === 'set_campaign_status') return 'campaigns:mutate';
    if (action === 'set_ad_group_status') return 'adGroups:mutate';
    if (action === 'create_custom_audience') return 'customAudiences:mutate';
    if (['add_segment', 'remove_segment', 'set_bid_modifier', 'set_targeting_mode', 'set_demographics'].includes(action)) return 'googleAds:mutate';
    return null;
}

function formatScheduleMinuteForUser(value: any): string {
    const normalized = clean(value || 'ZERO').toUpperCase();
    const minuteMap: Record<string, string> = {
        ZERO: '00',
        FIFTEEN: '15',
        THIRTY: '30',
        FORTY_FIVE: '45'
    };
    return minuteMap[normalized] || String(value || '00').padStart(2, '0');
}

function formatScheduleTimeForUser(hour: any, minute: any): string {
    if (hour === undefined || hour === null || hour === '') return 'unknown time';
    const hourNumber = Number(hour);
    if (!Number.isFinite(hourNumber)) return 'unknown time';
    const displayHour = hourNumber % 12 || 12;
    const suffix = hourNumber >= 12 && hourNumber < 24 ? 'PM' : 'AM';
    return `${displayHour}:${formatScheduleMinuteForUser(minute)} ${suffix}`;
}

function formatScheduleRangeForUser(schedule: any): string {
    return `${formatScheduleTimeForUser(schedule?.startHour ?? schedule?.start_hour, schedule?.startMinute ?? schedule?.start_minute)} to ${formatScheduleTimeForUser(schedule?.endHour ?? schedule?.end_hour, schedule?.endMinute ?? schedule?.end_minute)}`;
}

function formatDayForUser(day: any): string {
    return clean(day || 'selected day')
        .toLowerCase()
        .replace(/_/g, ' ')
        .replace(/\b\w/g, char => char.toUpperCase());
}

function describeMutationDiff(change: any, mutationType: any): string {
    const action = clean(change?.action).toLowerCase();
    if (action === 'add_keyword') {
        return `add keyword "${clean(change.keywordText)}" to ad group ${clean(change.adGroupId)}`;
    }
    if (action === 'remove_keyword') {
        return `remove keyword "${clean(change.keywordText)}" from ad group ${clean(change.adGroupId)}`;
    }
    if (action === 'replace_keyword') {
        return `replace keyword "${clean(change.keywordText)}" with "${clean(change.newKeywordText)}" in ad group ${clean(change.adGroupId)}`;
    }
    if (action === 'set_keyword_status') {
        const verb = clean(change.targetStatus).toUpperCase() === 'ENABLED' ? 'enable' : 'pause';
        return `${verb} keyword "${clean(change.keywordText)}" in ad group ${clean(change.adGroupId)}`;
    }
    if (action === 'set_keyword_final_url') {
        return `change final URL for keyword "${clean(change.keywordText)}" in ad group ${clean(change.adGroupId)}`;
    }
    if (action === 'add_negative_keyword' || action === 'remove_negative_keyword') {
        const rawScope = clean(change.scope).toLowerCase();
        const scope = rawScope === 'campaign' ? 'campaign' : rawScope === 'shared_list' || rawScope === 'account' ? 'negative list' : 'ad group';
        const ownerId = clean(change.ownerId || change.adGroupId || change.campaignId);
        const verb = action === 'add_negative_keyword' ? 'add' : 'remove';
        const direction = action === 'add_negative_keyword' ? 'to' : 'from';
        return `${verb} ${scope} negative keyword "${clean(change.keywordText)}" ${direction} ${scope} ${ownerId}`;
    }
    if (action === 'replace_negative_keyword') {
        const rawScope = clean(change.scope).toLowerCase();
        const scope = rawScope === 'campaign' ? 'campaign' : rawScope === 'shared_list' || rawScope === 'account' ? 'negative list' : 'ad group';
        return `replace ${scope} negative keyword "${clean(change.keywordText)}" with "${clean(change.newKeywordText)}" in ${scope} ${clean(change.ownerId)}`;
    }
    if (action === 'add_ad_schedule' || action === 'remove_ad_schedule') {
        const schedule = change.schedule || change;
        const verb = action === 'add_ad_schedule' ? 'add' : 'remove';
        return `${verb} ad schedule ${formatDayForUser(schedule.dayOfWeek || schedule.day_of_week)} ${formatScheduleRangeForUser(schedule)} for campaign ${clean(change.campaignId)}`;
    }
    if (action === 'set_campaign_status') {
        const verb = clean(change.targetStatus).toUpperCase() === 'ENABLED' ? 'enable' : 'pause';
        return `${verb} campaign ${clean(change.campaignId)}`;
    }
    if (action === 'set_ad_group_status') {
        const verb = clean(change.targetStatus).toUpperCase() === 'ENABLED' ? 'enable' : 'pause';
        return `${verb} ad group ${clean(change.adGroupId)}`;
    }
    return clean(mutationType).replace(/_/g, ' ') || 'Google Ads change';
}

function summarizeList(items: string[], emptyLabel: string): string {
    const cleanItems = items.map(item => item.trim()).filter(Boolean);
    if (!cleanItems.length) return emptyLabel;
    const visible = cleanItems.slice(0, 4);
    const suffix = cleanItems.length > visible.length ? `, plus ${cleanItems.length - visible.length} more` : '';
    return `${visible.join('; ')}${suffix}`;
}

function summarizeDiffsForPaths(previewPayload: any, paths: string[]): string[] {
    const pathSet = new Set(paths);
    const diff: any[] = Array.isArray(previewPayload?.diff) ? previewPayload.diff : [];
    return diff
        .filter((change: any) => {
            const path = diffPath(change);
            return path ? pathSet.has(path) : false;
        })
        .map((change: any) => describeMutationDiff(change, previewPayload?.mutationType));
}

export function buildGoogleAdsPartialFailureSummary(input: {
    previewPayload: any;
    operationPaths: string[];
    successfulPaths: string[];
    failedPath: string | null;
    errors: NormalizedGoogleAdsError[];
}): PartialFailureSummary {
    const failedIndex = input.failedPath ? input.operationPaths.indexOf(input.failedPath) : -1;
    const notAttemptedPaths = failedIndex >= 0 ? input.operationPaths.slice(failedIndex + 1) : [];
    const applied = summarizeDiffsForPaths(input.previewPayload, input.successfulPaths);
    const failed = input.failedPath ? summarizeDiffsForPaths(input.previewPayload, [input.failedPath]) : [];
    const notAttempted = summarizeDiffsForPaths(input.previewPayload, notAttemptedPaths);
    const googleError = summarizeList(input.errors.map(error => error.message), 'Google Ads did not return a detailed reason.');
    const appliedText = summarizeList(applied, 'nothing');
    const failedText = summarizeList(failed, input.failedPath || 'the next Google Ads request');
    const notAttemptedText = notAttempted.length ? ` Not attempted: ${summarizeList(notAttempted, '')}.` : '';
    const message = applied.length
        ? `Some Google Ads changes were applied before a later change failed. Applied: ${appliedText}. Failed: ${failedText}.${notAttemptedText} Google Ads said: ${googleError}`
        : `No Google Ads changes were applied. Failed: ${failedText}.${notAttemptedText} Google Ads said: ${googleError}`;
    return {
        message,
        applied,
        failed,
        notAttempted,
        successfulPaths: input.successfulPaths,
        failedPath: input.failedPath,
        notAttemptedPaths,
        errors: input.errors
    };
}

export async function ensureGoogleAdsMutationSchema(pool: Pool): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS google_ads_mutation_requests (
            id UUID PRIMARY KEY,
            customer_id TEXT NOT NULL,
            requested_by TEXT,
            source TEXT NOT NULL CHECK (source IN ('ui', 'mcp')),
            mutation_type TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('previewed', 'confirmed', 'executed', 'failed', 'expired')),
            preview_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            operations JSONB NOT NULL DEFAULT '{}'::jsonb,
            confirmation_token_hash TEXT NOT NULL,
            expires_at TIMESTAMP NOT NULL,
            google_request_id TEXT,
            result_payload JSONB,
            error_payload JSONB,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS google_ads_mutation_requests_customer_created_idx
            ON google_ads_mutation_requests(customer_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS google_ads_mutation_requests_status_expiry_idx
            ON google_ads_mutation_requests(status, expires_at);
    `);
}

async function runValidateOnly(operationsByPath: Record<string, any[]>, customerId: string): Promise<NormalizedGoogleAdsError[]> {
    const errors: NormalizedGoogleAdsError[] = [];
    for (const [path, operations] of Object.entries(operationsByPath)) {
        if (!operations.length) continue;
        try {
            await mutateGoogleAds(path, mutationRequestBody(path, operations, true), customerId);
        } catch (err: any) {
            errors.push(...(err.googleAdsErrors || normalizeGoogleAdsErrors({ message: err.message })));
        }
    }
    return errors;
}

function mutationRequestBody(path: string, operations: any[], validateOnly: boolean): any {
    return path === 'googleAds:mutate'
        ? { mutateOperations: operations, partialFailure: false, validateOnly, responseContentType: 'MUTABLE_RESOURCE' }
        : { operations, validateOnly };
}

async function expireOldMutationPreviews(pool: Pool): Promise<void> {
    await pool.query(
        `UPDATE google_ads_mutation_requests
         SET status = 'expired', updated_at = CURRENT_TIMESTAMP
         WHERE status = 'previewed'
           AND expires_at <= CURRENT_TIMESTAMP`
    );
}

export async function previewGoogleAdsMutation(pool: Pool, input: {
    mutationType: string;
    customerId?: unknown;
    changes: any[];
    reason?: unknown;
    requestedBy?: string | null;
    source: 'ui' | 'mcp';
    validateOnly?: boolean;
}): Promise<MutationPreviewResult> {
    await ensureGoogleAdsMutationSchema(pool);
    const token = await getAccessToken();
    const customerId = normalizeCustomerId(input.customerId) || await getAccessibleCustomer(token);
    const mutationType = clean(input.mutationType) as GoogleAdsMutationType;
    const prepared = await prepareGoogleAdsMutationChanges(pool, {
        customerId,
        mutationType,
        changes: input.changes,
        token
    });
    const built = buildGoogleAdsMutationOperations({ customerId, mutationType, changes: prepared.changes });
    built.warnings.unshift(...prepared.warnings);
    const apiErrors = input.validateOnly === false ? [] : await runValidateOnly(built.operationsByPath, customerId);
    if (apiErrors.length) throw new GoogleAdsMutationValidationError(`Google Ads validateOnly failed: ${apiErrors.map(err => err.message).join('; ')}`);

    await expireOldMutationPreviews(pool);
    const confirmationToken = newConfirmationToken();
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + ttlMinutes() * 60_000).toISOString();
    const previewPayload = {
        mutationType: built.mutationType,
        reason: cleanOptional(input.reason),
        changes: prepared.changes,
        diff: built.diff,
        warnings: built.warnings,
        touched: built.touched
    };
    await pool.query(
        `INSERT INTO google_ads_mutation_requests
         (id, customer_id, requested_by, source, mutation_type, status, preview_payload, operations, confirmation_token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'previewed', $6, $7, $8, $9)`,
        [id, customerId, input.requestedBy || null, input.source, built.mutationType, previewPayload, built.operationsByPath, hashConfirmationToken(confirmationToken), expiresAt]
    );
    return {
        mutationId: id,
        confirmationToken,
        expiresAt,
        diff: built.diff,
        warnings: built.warnings,
        operationsSummary: Object.fromEntries(Object.entries(built.operationsByPath).map(([path, operations]) => [path, operations.length]))
    };
}

export async function confirmGoogleAdsMutation(pool: Pool, input: {
    mutationId: string;
    confirmationToken: string;
}): Promise<any> {
    await ensureGoogleAdsMutationSchema(pool);
    if (process.env.GOOGLE_ADS_MUTATIONS_ENABLED !== 'true') {
        throw Object.assign(new GoogleAdsMutationValidationError('Google Ads mutations are disabled. Set GOOGLE_ADS_MUTATIONS_ENABLED=true to execute confirmed previews.'), { statusCode: 403 });
    }
    const tokenHash = hashConfirmationToken(clean(input.confirmationToken));
    await expireOldMutationPreviews(pool);

    const { rows } = await pool.query(
        `SELECT *
         FROM google_ads_mutation_requests
         WHERE id = $1`,
        [input.mutationId]
    );
    const row = rows[0];
    if (!row) throw Object.assign(new GoogleAdsMutationValidationError('Mutation preview not found.'), { statusCode: 404 });
    if (row.status !== 'previewed') throw new GoogleAdsMutationValidationError(`Mutation is not confirmable from status ${row.status}.`);
    if (new Date(row.expires_at).getTime() <= Date.now()) {
        await pool.query(`UPDATE google_ads_mutation_requests SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [input.mutationId]);
        throw Object.assign(new GoogleAdsMutationValidationError('Mutation confirmation token has expired.'), { statusCode: 410 });
    }
    if (row.confirmation_token_hash !== tokenHash) throw Object.assign(new GoogleAdsMutationValidationError('Invalid confirmation token.'), { statusCode: 403 });

    let operationsByPath = row.operations || {};
    const mutationType = clean(row.mutation_type) as GoogleAdsMutationType;
    const previewChanges = Array.isArray(row.preview_payload?.changes) ? row.preview_payload.changes : [];
    if ((mutationType === 'keyword_changes' || mutationType === 'negative_keyword_changes' || mutationType === 'audience_changes') && previewChanges.length) {
        const token = await getAccessToken();
        let rebuilt: BuiltMutation;
        try {
            const prepared = await prepareGoogleAdsMutationChanges(pool, {
                customerId: row.customer_id,
                mutationType,
                changes: previewChanges,
                token
            });
            rebuilt = buildGoogleAdsMutationOperations({
                customerId: row.customer_id,
                mutationType,
                changes: prepared.changes
            });
        } catch (err: any) {
            throw new GoogleAdsMutationValidationError(`Google Ads changed after this preview. Close this dialog and review the selection again. ${err?.message || ''}`.trim());
        }
        if (stableJson(rebuilt.operationsByPath) !== stableJson(operationsByPath)) {
            throw new GoogleAdsMutationValidationError('Google Ads changed after this preview. Close this dialog and review the selection again before applying it.');
        }
        operationsByPath = rebuilt.operationsByPath;
    }

    const claimed = await pool.query(
        `UPDATE google_ads_mutation_requests
         SET status = 'confirmed', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
           AND status = 'previewed'
           AND expires_at > CURRENT_TIMESTAMP
         RETURNING id`,
        [input.mutationId]
    );
    if (!claimed.rows.length) throw new GoogleAdsMutationValidationError('Mutation preview was already claimed or is no longer confirmable.');
    const results: any[] = [];
    let googleRequestId: string | null = null;
    const operationPaths = Object.entries(operationsByPath)
        .filter(([, operations]) => Array.isArray(operations) && operations.length)
        .map(([path]) => path);
    let currentPath: string | null = null;
    try {
        for (const [path, operations] of Object.entries(operationsByPath)) {
            if (!Array.isArray(operations) || !operations.length) continue;
            currentPath = path;
            const result = await mutateGoogleAds(path, mutationRequestBody(path, operations as any[], false), row.customer_id);
            googleRequestId = result.requestId || googleRequestId;
            results.push({ path, result: result.data });
            currentPath = null;
        }
    } catch (err: any) {
        const normalized = err.googleAdsErrors || normalizeGoogleAdsErrors({ message: err.message });
        const failedPath = currentPath || operationPaths.find(path => !results.some(result => result.path === path)) || null;
        const partialFailure = buildGoogleAdsPartialFailureSummary({
            previewPayload: row.preview_payload,
            operationPaths,
            successfulPaths: results.map(result => result.path),
            failedPath,
            errors: normalized
        });
        await pool.query(
            `UPDATE google_ads_mutation_requests
             SET status = 'failed', error_payload = $2, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [input.mutationId, { errors: normalized, partialFailure, partialResults: results }]
        );
        throw Object.assign(new GoogleAdsMutationValidationError(partialFailure.message), {
            errors: normalized,
            partialFailure,
            partialResults: results
        });
    }
    await pool.query(
        `UPDATE google_ads_mutation_requests
         SET status = 'executed', google_request_id = $2, result_payload = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [input.mutationId, googleRequestId, { results }]
    );
    return { mutationId: input.mutationId, status: 'executed', googleRequestId, results, preview: row.preview_payload };
}

export async function listRecentGoogleAdsMutations(pool: Pool, input: { customerId?: unknown; limit?: unknown } = {}): Promise<any[]> {
    await ensureGoogleAdsMutationSchema(pool);
    await expireOldMutationPreviews(pool);
    const params: any[] = [];
    const clauses: string[] = [`status = 'executed'`];
    const customerId = normalizeCustomerId(input.customerId);
    if (customerId) {
        params.push(customerId);
        clauses.push(`customer_id = $${params.length}`);
    }
    const limit = Math.min(Math.max(Number(input.limit) || 25, 1), 100);
    params.push(limit);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await pool.query(
        `SELECT id, customer_id, requested_by, source, mutation_type, status, preview_payload,
                expires_at, google_request_id, result_payload, error_payload, created_at, updated_at
         FROM google_ads_mutation_requests
         ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length}`,
        params
    );
    return rows;
}

export async function getAccountControlsState(pool: Pool, input: { customerId?: unknown } = {}): Promise<any> {
    const token = await getAccessToken();
    const customerId = normalizeCustomerId(input.customerId) || await getAccessibleCustomer(token);
    const campaignRows = await pool.query(
        `SELECT campaign_id, campaign_name, campaign_status
         FROM google_ads_campaign_snapshot
         WHERE customer_id = $1
         ORDER BY campaign_name ASC NULLS LAST, campaign_id ASC`,
        [customerId]
    ).catch(() => ({ rows: [] as any[] }));
    const adGroupRows = await pool.query(
        `SELECT campaign_id, campaign_name, ad_group_id, ad_group_name, ad_group_status
         FROM google_ads_ad_group_snapshot
         WHERE customer_id = $1
         ORDER BY campaign_name ASC NULLS LAST, ad_group_name ASC NULLS LAST`,
        [customerId]
    ).catch(() => ({ rows: [] as any[] }));
    const keywordRows = await pool.query(
        `SELECT campaign_id, campaign_name, ad_group_id, ad_group_name, criterion_id, criterion_resource_name,
                keyword_text, match_type, status, final_urls
         FROM google_ads_configured_keywords
         WHERE customer_id = $1
         ORDER BY campaign_name ASC NULLS LAST, ad_group_name ASC NULLS LAST, keyword_text ASC`,
        [customerId]
    ).catch(() => ({ rows: [] as any[] }));
    const campaignNegatives = await pool.query(
        `SELECT campaign_id, campaign_name, criterion_id, keyword_text, match_type, status
         FROM google_ads_campaign_negatives
         WHERE customer_id = $1
         ORDER BY campaign_name ASC NULLS LAST, keyword_text ASC`,
        [customerId]
    ).catch(() => ({ rows: [] as any[] }));
    const adGroupNegatives = await pool.query(
        `SELECT campaign_id, campaign_name, ad_group_id, ad_group_name, criterion_id, keyword_text, match_type, status
         FROM google_ads_ad_group_negatives
         WHERE customer_id = $1
         ORDER BY campaign_name ASC NULLS LAST, ad_group_name ASC NULLS LAST, keyword_text ASC`,
        [customerId]
    ).catch(() => ({ rows: [] as any[] }));
    const sharedNegativeSets = await pool.query(
        `SELECT shared_set_id, shared_set_resource_name, shared_set_name, shared_set_type, shared_set_status
         FROM google_ads_shared_negative_sets
         WHERE customer_id = $1
           AND present_in_latest_snapshot = true
           AND upper(coalesce(shared_set_status, 'ENABLED')) != 'REMOVED'
           AND shared_set_type IN ('NEGATIVE_KEYWORDS', 'ACCOUNT_LEVEL_NEGATIVE_KEYWORDS')
         ORDER BY shared_set_name ASC NULLS LAST, shared_set_id ASC`,
        [customerId]
    ).catch(() => ({ rows: [] as any[] }));

    let adSchedules: any[] = [];
    try {
        adSchedules = await executeGaql(token, customerId, `
            SELECT campaign.id, campaign.name, campaign_criterion.criterion_id, campaign_criterion.resource_name,
                   campaign_criterion.status, campaign_criterion.ad_schedule.day_of_week,
                   campaign_criterion.ad_schedule.start_hour, campaign_criterion.ad_schedule.start_minute,
                   campaign_criterion.ad_schedule.end_hour, campaign_criterion.ad_schedule.end_minute
            FROM campaign_criterion
            WHERE campaign_criterion.type = AD_SCHEDULE
              AND campaign_criterion.status != REMOVED
            LIMIT 1000
        `);
    } catch {
        adSchedules = [];
    }

    return {
        customerId,
        campaigns: campaignRows.rows.map(row => ({
            campaignId: String(row.campaign_id),
            campaignName: row.campaign_name || String(row.campaign_id),
            status: row.campaign_status || null
        })),
        adGroups: adGroupRows.rows.map(row => ({
            campaignId: String(row.campaign_id),
            campaignName: row.campaign_name || null,
            adGroupId: String(row.ad_group_id),
            adGroupName: row.ad_group_name || String(row.ad_group_id),
            status: row.ad_group_status || null
        })),
        keywords: keywordRows.rows.map(row => ({
            campaignId: String(row.campaign_id),
            campaignName: row.campaign_name || null,
            adGroupId: String(row.ad_group_id),
            adGroupName: row.ad_group_name || null,
            criterionId: String(row.criterion_id),
            resourceName: row.criterion_resource_name || null,
            keywordText: row.keyword_text || '',
            matchType: row.match_type || null,
            status: row.status || null,
            finalUrl: Array.isArray(row.final_urls) ? row.final_urls[0] || '' : ''
        })),
        negatives: {
            campaign: campaignNegatives.rows.map(row => ({
                ...row,
                scope: 'campaign',
                campaignId: String(row.campaign_id),
                campaignName: row.campaign_name || null,
                criterionId: String(row.criterion_id),
                resourceName: `customers/${customerId}/campaignCriteria/${row.campaign_id}~${row.criterion_id}`,
                keywordText: row.keyword_text || '',
                matchType: row.match_type || null,
                status: row.status || null
            })),
            adGroup: adGroupNegatives.rows.map(row => ({
                ...row,
                scope: 'ad_group',
                campaignId: String(row.campaign_id),
                campaignName: row.campaign_name || null,
                adGroupId: String(row.ad_group_id),
                adGroupName: row.ad_group_name || null,
                criterionId: String(row.criterion_id),
                resourceName: `customers/${customerId}/adGroupCriteria/${row.ad_group_id}~${row.criterion_id}`,
                keywordText: row.keyword_text || '',
                matchType: row.match_type || null,
                status: row.status || null
            })),
            sharedListsReadOnly: false
        },
        sharedNegativeSets: sharedNegativeSets.rows.map(row => ({
            sharedSetId: String(row.shared_set_id),
            sharedSetResourceName: row.shared_set_resource_name,
            sharedSetName: row.shared_set_name || String(row.shared_set_id),
            sharedSetType: row.shared_set_type || null,
            status: row.shared_set_status || null
        })),
        adSchedules
    };
}
