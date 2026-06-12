import type { Pool } from 'pg';
import { executeGaql } from './googleAds';
import { GoogleAdsMutationValidationError } from './googleAdsMutationValidationError';

type AudienceScope = 'campaign' | 'ad_group';
type AudienceCriterionType =
    | 'AUDIENCE'
    | 'USER_INTEREST'
    | 'USER_LIST'
    | 'CUSTOM_AUDIENCE'
    | 'COMBINED_AUDIENCE'
    | 'LIFE_EVENT'
    | 'EXTENDED_DEMOGRAPHIC';
type DemographicDimension = 'AGE_RANGE' | 'GENDER' | 'INCOME_RANGE' | 'PARENTAL_STATUS';

export type AudiencePreparedChanges = { changes: any[]; warnings: string[] };
export type AudienceBuiltMutation = {
    mutationType: 'audience_changes';
    operationsByPath: Record<string, any[]>;
    diff: any[];
    warnings: string[];
    touched: { campaignIds: string[]; adGroupIds: string[] };
};

const CRITERION_TYPES = new Set<AudienceCriterionType>([
    'AUDIENCE', 'USER_INTEREST', 'USER_LIST', 'CUSTOM_AUDIENCE',
    'COMBINED_AUDIENCE', 'LIFE_EVENT', 'EXTENDED_DEMOGRAPHIC'
]);
const DEMOGRAPHIC_VALUES: Record<DemographicDimension, readonly string[]> = {
    AGE_RANGE: [
        'AGE_RANGE_18_24', 'AGE_RANGE_25_34', 'AGE_RANGE_35_44', 'AGE_RANGE_45_54',
        'AGE_RANGE_55_64', 'AGE_RANGE_65_UP', 'AGE_RANGE_UNDETERMINED'
    ],
    GENDER: ['FEMALE', 'MALE', 'UNDETERMINED'],
    INCOME_RANGE: [
        'INCOME_RANGE_90_UP', 'INCOME_RANGE_80_90', 'INCOME_RANGE_70_80',
        'INCOME_RANGE_60_70', 'INCOME_RANGE_50_60', 'INCOME_RANGE_0_50',
        'INCOME_RANGE_UNDETERMINED'
    ],
    PARENTAL_STATUS: ['PARENT', 'NOT_A_PARENT', 'UNDETERMINED']
};
const RESOURCE_COLLECTION: Record<AudienceCriterionType, string> = {
    AUDIENCE: 'audiences',
    USER_INTEREST: 'userInterests',
    USER_LIST: 'userLists',
    CUSTOM_AUDIENCE: 'customAudiences',
    COMBINED_AUDIENCE: 'combinedAudiences',
    LIFE_EVENT: 'lifeEvents',
    EXTENDED_DEMOGRAPHIC: 'detailedDemographics'
};
const NEGATIVE_SUPPORTED = new Set<AudienceCriterionType>(['USER_INTEREST', 'USER_LIST', 'LIFE_EVENT', 'EXTENDED_DEMOGRAPHIC']);
const CAMPAIGN_SUPPORTED = new Set<AudienceCriterionType>([
    'USER_INTEREST', 'USER_LIST', 'CUSTOM_AUDIENCE', 'COMBINED_AUDIENCE',
    'LIFE_EVENT', 'EXTENDED_DEMOGRAPHIC'
]);
const AD_GROUP_SUPPORTED = new Set<AudienceCriterionType>([
    'AUDIENCE', 'USER_INTEREST', 'USER_LIST', 'CUSTOM_AUDIENCE', 'COMBINED_AUDIENCE'
]);

function clean(value: unknown): string {
    return String(value ?? '').trim();
}

function numericId(value: unknown, label: string): string {
    const id = clean(value);
    if (!/^\d+$/.test(id)) throw new GoogleAdsMutationValidationError(`${label} must be numeric.`);
    return id;
}

function normalizeScope(value: unknown, fallback: any = {}): AudienceScope {
    const scope = clean(value || (fallback.adGroupId ? 'ad_group' : 'campaign')).toLowerCase().replace(/[\s-]+/g, '_');
    if (scope !== 'campaign' && scope !== 'ad_group') {
        throw new GoogleAdsMutationValidationError('Audience scope must be campaign or ad_group.');
    }
    return scope;
}

function normalizeCriterionType(value: unknown): AudienceCriterionType {
    const type = clean(value).toUpperCase().replace(/[\s-]+/g, '_') as AudienceCriterionType;
    if (!CRITERION_TYPES.has(type)) throw new GoogleAdsMutationValidationError('Unsupported audience segment type.');
    return type;
}

function normalizeDimension(value: unknown): DemographicDimension {
    const dimension = clean(value).toUpperCase().replace(/[\s-]+/g, '_') as DemographicDimension;
    if (!Object.prototype.hasOwnProperty.call(DEMOGRAPHIC_VALUES, dimension)) {
        throw new GoogleAdsMutationValidationError('Demographic dimension must be AGE_RANGE, GENDER, INCOME_RANGE, or PARENTAL_STATUS.');
    }
    return dimension;
}

function ownerId(scope: AudienceScope, change: any): string {
    return scope === 'campaign'
        ? numericId(change.campaignId, 'campaignId')
        : numericId(change.adGroupId, 'adGroupId');
}

function ownerResource(customerId: string, scope: AudienceScope, id: string): string {
    return `customers/${customerId}/${scope === 'campaign' ? 'campaigns' : 'adGroups'}/${id}`;
}

function criterionCollection(scope: AudienceScope): 'campaignCriteria' | 'adGroupCriteria' {
    return scope === 'campaign' ? 'campaignCriteria' : 'adGroupCriteria';
}

function normalizeAudienceResource(customerId: string, type: AudienceCriterionType, value: unknown): string {
    const resource = clean(value);
    const collection = RESOURCE_COLLECTION[type];
    const pattern = new RegExp(`^customers/${customerId}/${collection}/([^/]+)$`);
    if (!pattern.test(resource)) {
        throw new GoogleAdsMutationValidationError(`The selected ${type.toLowerCase().replace(/_/g, ' ')} does not belong to this Google Ads account.`);
    }
    return resource;
}

function validateScopeAndPolarity(scope: AudienceScope, type: AudienceCriterionType, negative: boolean): void {
    if (scope === 'campaign' && !CAMPAIGN_SUPPORTED.has(type)) {
        throw new GoogleAdsMutationValidationError(`${type.replace(/_/g, ' ')} cannot be configured at campaign level.`);
    }
    if (scope === 'ad_group' && !AD_GROUP_SUPPORTED.has(type)) {
        throw new GoogleAdsMutationValidationError(`${type.replace(/_/g, ' ')} cannot be configured at ad-group level.`);
    }
    if (negative && !NEGATIVE_SUPPORTED.has(type)) {
        throw new GoogleAdsMutationValidationError(`${type.replace(/_/g, ' ')} cannot be used as an audience exclusion at this scope.`);
    }
}

function criterionResource(customerId: string, scope: AudienceScope, id: string, value: unknown): string {
    const supplied = clean(value);
    const collection = criterionCollection(scope);
    const pattern = new RegExp(`^customers/${customerId}/${collection}/${id}~\\d+$`);
    if (!pattern.test(supplied)) {
        throw new GoogleAdsMutationValidationError('The audience criterion does not belong to the selected account and scope.');
    }
    return supplied;
}

function gaqlString(value: string): string {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function canonicalRestrictions(value: unknown): Array<{ targetingDimension: string; bidOnly: boolean }> {
    if (!Array.isArray(value)) return [];
    const normalized = value.map((item: any) => ({
        targetingDimension: clean(item?.targetingDimension ?? item?.targeting_dimension).toUpperCase(),
        bidOnly: item?.bidOnly === true || item?.bid_only === true
    })).filter(item => item.targetingDimension && !['UNKNOWN', 'UNSPECIFIED'].includes(item.targetingDimension));
    const deduped = new Map<string, { targetingDimension: string; bidOnly: boolean }>();
    for (const item of normalized) deduped.set(item.targetingDimension, item);
    return [...deduped.values()].sort((a, b) => a.targetingDimension.localeCompare(b.targetingDimension));
}

function criterionIdentity(customerId: string, scope: AudienceScope, row: any): {
    resourceName: string;
    criterionType: string;
    audienceResourceName: string | null;
    demographicValue: string | null;
    negative: boolean;
    bidModifier: number | null;
} {
    const prefix = scope === 'campaign' ? 'campaign_criterion' : 'ad_group_criterion';
    const type = clean(row[`${prefix}.type`]).toUpperCase();
    const candidates: Array<[string, AudienceCriterionType]> = [
        [`${prefix}.audience.audience`, 'AUDIENCE'],
        [`${prefix}.user_interest.user_interest_category`, 'USER_INTEREST'],
        [`${prefix}.user_list.user_list`, 'USER_LIST'],
        [`${prefix}.custom_audience.custom_audience`, 'CUSTOM_AUDIENCE'],
        [`${prefix}.combined_audience.combined_audience`, 'COMBINED_AUDIENCE']
    ];
    let audienceResourceName: string | null = null;
    for (const [field] of candidates) {
        if (clean(row[field])) {
            audienceResourceName = clean(row[field]);
            break;
        }
    }
    const lifeEventId = clean(row[`${prefix}.life_event.life_event_id`]);
    const detailedId = clean(row[`${prefix}.extended_demographic.extended_demographic_id`]);
    if (!audienceResourceName && lifeEventId) audienceResourceName = `customers/${customerId}/lifeEvents/${lifeEventId}`;
    if (!audienceResourceName && detailedId) audienceResourceName = `customers/${customerId}/detailedDemographics/${detailedId}`;
    const demographicFields = [
        `${prefix}.age_range.type`, `${prefix}.gender.type`,
        `${prefix}.income_range.type`, `${prefix}.parental_status.type`
    ];
    const demographicValue = demographicFields.map(field => clean(row[field])).find(Boolean) || null;
    const modifier = Number(row[`${prefix}.bid_modifier`]);
    return {
        resourceName: clean(row[`${prefix}.resource_name`]),
        criterionType: type,
        audienceResourceName,
        demographicValue,
        negative: row[`${prefix}.negative`] === true,
        bidModifier: Number.isFinite(modifier) ? modifier : null
    };
}

function ownerCriteriaQuery(scope: AudienceScope, id: string): string {
    const prefix = scope === 'campaign' ? 'campaign_criterion' : 'ad_group_criterion';
    const owner = scope === 'campaign' ? 'campaign' : 'ad_group';
    const fields = [
        `${prefix}.criterion_id`, `${prefix}.resource_name`, `${prefix}.type`, `${prefix}.negative`,
        `${prefix}.status`, `${prefix}.bid_modifier`,
        ...(scope === 'ad_group' ? [`${prefix}.audience.audience`] : []),
        `${prefix}.user_interest.user_interest_category`, `${prefix}.user_list.user_list`,
        `${prefix}.custom_audience.custom_audience`, `${prefix}.combined_audience.combined_audience`,
        `${prefix}.life_event.life_event_id`, `${prefix}.extended_demographic.extended_demographic_id`,
        `${prefix}.age_range.type`, `${prefix}.gender.type`, `${prefix}.income_range.type`,
        `${prefix}.parental_status.type`
    ];
    return `SELECT ${fields.join(', ')} FROM ${prefix} WHERE ${owner}.id = ${id} AND ${prefix}.status != REMOVED LIMIT 10000`;
}

async function loadTargetingRestrictions(token: string, customerId: string, scope: AudienceScope, id: string): Promise<Array<{ targetingDimension: string; bidOnly: boolean }>> {
    const resource = scope === 'campaign' ? 'campaign' : 'ad_group';
    const rows = await executeGaql(token, customerId,
        `SELECT ${resource}.targeting_setting.target_restrictions FROM ${resource} WHERE ${resource}.id = ${id} LIMIT 1`);
    if (!rows.length) throw new GoogleAdsMutationValidationError(`The selected ${scope === 'campaign' ? 'campaign' : 'ad group'} no longer exists.`);
    return canonicalRestrictions(rows[0][`${resource}.targeting_setting.target_restrictions`]);
}

async function assertTargetingLevelAvailable(token: string, customerId: string, scope: AudienceScope, change: any): Promise<void> {
    if (scope === 'ad_group') {
        const campaignId = numericId(change.campaignId, 'campaignId');
        const restrictions = await loadTargetingRestrictions(token, customerId, 'campaign', campaignId);
        if (restrictions.some(item => item.targetingDimension === 'AUDIENCE')) {
            throw new GoogleAdsMutationValidationError('Audience targeting mode is set at campaign level. Remove that campaign-level setting before changing it for an ad group.');
        }
        return;
    }
    const rows = await executeGaql(token, customerId,
        `SELECT ad_group.id, ad_group.targeting_setting.target_restrictions FROM ad_group WHERE campaign.id = ${numericId(change.campaignId, 'campaignId')} AND ad_group.status != REMOVED LIMIT 10000`);
    if (rows.some(row => canonicalRestrictions(row['ad_group.targeting_setting.target_restrictions']).some(item => item.targetingDimension === 'AUDIENCE'))) {
        throw new GoogleAdsMutationValidationError('Audience targeting mode is set on one or more child ad groups. Remove those ad-group settings before changing it at campaign level.');
    }
}

function normalizeMembers(value: unknown): any[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new GoogleAdsMutationValidationError('A custom segment needs at least one keyword, URL, app, or place category.');
    }
    if (value.length > 1000) throw new GoogleAdsMutationValidationError('A custom segment can contain at most 1,000 members per change.');
    const seen = new Set<string>();
    const result: any[] = [];
    for (const raw of value) {
        const memberType = clean(raw?.memberType || raw?.type).toUpperCase().replace(/[\s-]+/g, '_');
        if (!['KEYWORD', 'URL', 'APP', 'PLACE_CATEGORY'].includes(memberType)) {
            throw new GoogleAdsMutationValidationError('Custom segment member type must be KEYWORD, URL, APP, or PLACE_CATEGORY.');
        }
        let member: any;
        if (memberType === 'KEYWORD') {
            const keyword = clean(raw?.keyword ?? raw?.value).replace(/\s+/g, ' ');
            if (!keyword || keyword.length > 80 || keyword.split(/\s+/).length > 10) {
                throw new GoogleAdsMutationValidationError('Custom segment keywords must be 80 characters or fewer and no more than 10 words.');
            }
            member = { memberType, keyword };
        } else if (memberType === 'URL') {
            const url = clean(raw?.url ?? raw?.value);
            let parsed: URL;
            try { parsed = new URL(url); } catch { throw new GoogleAdsMutationValidationError('Custom segment URLs must be valid http or https URLs.'); }
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.toString().length > 2048) {
                throw new GoogleAdsMutationValidationError('Custom segment URLs must be valid http or https URLs up to 2,048 characters.');
            }
            member = { memberType, url: parsed.toString() };
        } else if (memberType === 'APP') {
            const app = clean(raw?.app ?? raw?.value);
            if (!app || app.length > 300) throw new GoogleAdsMutationValidationError('Custom segment app identifiers are invalid.');
            member = { memberType, app };
        } else {
            const placeCategory = numericId(raw?.placeCategory ?? raw?.value, 'placeCategory');
            member = { memberType, placeCategory };
        }
        const key = JSON.stringify(member);
        if (!seen.has(key)) {
            seen.add(key);
            result.push(member);
        }
    }
    return result;
}

function normalizeCustomAudience(change: any): any {
    const name = clean(change.name).replace(/\s+/g, ' ');
    if (!name || name.length > 255) throw new GoogleAdsMutationValidationError('Custom segment name must be 1 to 255 characters.');
    const description = clean(change.description);
    if (description.length > 10_000) throw new GoogleAdsMutationValidationError('Custom segment description is too long.');
    const type = clean(change.customAudienceType || change.type || 'AUTO').toUpperCase();
    if (!['AUTO', 'SEARCH'].includes(type)) {
        throw new GoogleAdsMutationValidationError('New custom segments can use AUTO or SEARCH type.');
    }
    return { name, description, type, members: normalizeMembers(change.members) };
}

export async function prepareAudienceMutationChanges(pool: Pool, input: {
    customerId: string;
    changes: any[];
    token: string;
}): Promise<AudiencePreparedChanges> {
    void pool;
    if (!Array.isArray(input.changes) || input.changes.length === 0) {
        throw new GoogleAdsMutationValidationError('changes must contain at least one audience change.');
    }
    const criteriaCache = new Map<string, Promise<any[]>>();
    const prepared: any[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();

    const loadCriteria = (scope: AudienceScope, id: string): Promise<any[]> => {
        const key = `${scope}|${id}`;
        if (!criteriaCache.has(key)) criteriaCache.set(key, executeGaql(input.token, input.customerId, ownerCriteriaQuery(scope, id)));
        return criteriaCache.get(key)!;
    };

    for (const raw of input.changes) {
        const action = clean(raw.action || raw.operation).toLowerCase().replace(/[\s-]+/g, '_');
        if (action === 'set_targeting_mode') {
            const scope = normalizeScope(raw.scope, raw);
            const id = ownerId(scope, raw);
            const mode = clean(raw.mode || raw.targetingMode).toUpperCase();
            if (!['TARGETING', 'OBSERVATION'].includes(mode)) {
                throw new GoogleAdsMutationValidationError('Audience targeting mode must be TARGETING or OBSERVATION.');
            }
            await assertTargetingLevelAvailable(input.token, input.customerId, scope, raw);
            const current = await loadTargetingRestrictions(input.token, input.customerId, scope, id);
            const bidOnly = mode === 'OBSERVATION';
            const existing = current.find(item => item.targetingDimension === 'AUDIENCE');
            if (existing?.bidOnly === bidOnly) {
                warnings.push(`Audience targeting mode is already ${mode} at the selected ${scope === 'campaign' ? 'campaign' : 'ad group'} and was skipped.`);
                continue;
            }
            const next = current.filter(item => item.targetingDimension !== 'AUDIENCE');
            next.push({ targetingDimension: 'AUDIENCE', bidOnly });
            prepared.push({ ...raw, action, scope, ownerId: id, mode, currentTargetingRestrictions: current, targetingRestrictions: canonicalRestrictions(next) });
            continue;
        }

        if (action === 'set_demographics') {
            const scope = normalizeScope(raw.scope, raw);
            const id = ownerId(scope, raw);
            const dimension = normalizeDimension(raw.dimension);
            const allowed = DEMOGRAPHIC_VALUES[dimension];
            if (!Array.isArray(raw.includedValues)) throw new GoogleAdsMutationValidationError('includedValues must be an array.');
            const included: string[] = [...new Set<string>(raw.includedValues.map((value: unknown) => clean(value).toUpperCase()))];
            if (included.some(value => !allowed.includes(value))) throw new GoogleAdsMutationValidationError(`An included ${dimension.toLowerCase()} value is invalid.`);
            const rows = (await loadCriteria(scope, id)).map(row => criterionIdentity(input.customerId, scope, row));
            const currentNegatives = rows.filter(row => row.negative && allowed.includes(row.demographicValue || ''));
            const excluded = allowed.filter(value => !included.includes(value));
            const adds = excluded.filter(value => !currentNegatives.some(row => row.demographicValue === value));
            const removes = currentNegatives.filter(row => included.includes(row.demographicValue || '')).map(row => ({ value: row.demographicValue, resourceName: row.resourceName }));
            if (!adds.length && !removes.length) {
                warnings.push(`${dimension.replace(/_/g, ' ')} selections are unchanged and were skipped.`);
                continue;
            }
            if (included.length === 0) warnings.push(`All ${dimension.replace(/_/g, ' ').toLowerCase()} groups will be excluded; this can prevent the selected scope from serving ads.`);
            prepared.push({ ...raw, action, scope, ownerId: id, dimension, includedValues: included, adds, removes });
            continue;
        }

        if (action === 'create_custom_audience') {
            const customAudience = normalizeCustomAudience(raw);
            const duplicateRows = await executeGaql(input.token, input.customerId,
                `SELECT custom_audience.resource_name FROM custom_audience WHERE custom_audience.name = ${gaqlString(customAudience.name)} AND custom_audience.status != REMOVED LIMIT 2`);
            if (duplicateRows.length) throw new GoogleAdsMutationValidationError(`A custom segment named “${customAudience.name}” already exists.`);
            if (raw.attach === true) {
                throw new GoogleAdsMutationValidationError('Google Ads does not support atomically creating and attaching a custom segment. Create it first, refresh the audience list, then select it in a separate reviewed change.');
            }
            prepared.push({ ...raw, action, customAudience });
            continue;
        }

        const scope = normalizeScope(raw.scope, raw);
        const id = ownerId(scope, raw);
        const type = normalizeCriterionType(raw.criterionType || raw.segmentType || raw.type);
        const negative = raw.negative === true || action.includes('exclude');
        validateScopeAndPolarity(scope, type, negative);
        const resourceName = normalizeAudienceResource(input.customerId, type, raw.audienceResourceName || raw.resourceName || raw.segmentResourceName);
        const key = [action, scope, id, type, resourceName, negative].join('|');
        if (seen.has(key)) {
            warnings.push('Duplicate audience change ignored before preview.');
            continue;
        }
        seen.add(key);
        const rows = (await loadCriteria(scope, id)).map(row => criterionIdentity(input.customerId, scope, row));
        const matching = rows.filter(row => row.audienceResourceName === resourceName && row.negative === negative);

        if (['add', 'create', 'add_segment', 'include', 'exclude', 'add_exclusion'].includes(action)) {
            if (matching.length) {
                warnings.push(`The selected audience segment is already ${negative ? 'excluded' : 'present'} at this scope and was skipped.`);
                continue;
            }
            const opposite = rows.find(row => row.audienceResourceName === resourceName && row.negative !== negative);
            if (opposite) warnings.push('The same audience segment exists with the opposite include/exclude setting at this scope. Google Ads may reject or neutralize overlapping criteria.');
            prepared.push({ ...raw, action: 'add_segment', scope, ownerId: id, criterionType: type, audienceResourceName: resourceName, negative });
            continue;
        }

        if (['remove', 'delete', 'remove_segment', 'remove_exclusion'].includes(action)) {
            const selectedResource = clean(raw.criterionResourceName || raw.criterionResource);
            const row = selectedResource
                ? rows.find(item => item.resourceName === criterionResource(input.customerId, scope, id, selectedResource))
                : matching[0];
            if (!row) throw new GoogleAdsMutationValidationError('The selected audience criterion no longer exists. Refresh and review the change again.');
            prepared.push({ ...raw, action: 'remove_segment', scope, ownerId: id, criterionType: type, audienceResourceName: resourceName, negative: row.negative, criterionResourceName: row.resourceName });
            continue;
        }

        if (action === 'set_bid_modifier') {
            if (negative) throw new GoogleAdsMutationValidationError('Bid modifiers are not available for excluded audience segments.');
            const selectedResource = clean(raw.criterionResourceName || raw.criterionResource);
            const row = selectedResource
                ? rows.find(item => item.resourceName === criterionResource(input.customerId, scope, id, selectedResource))
                : matching[0];
            if (!row) throw new GoogleAdsMutationValidationError('The selected audience criterion no longer exists. Refresh and review the change again.');
            const bidModifier = Number(raw.bidModifier);
            if (!Number.isFinite(bidModifier) || bidModifier < 0.1 || bidModifier > 10) {
                throw new GoogleAdsMutationValidationError('Audience bidModifier must be between 0.1 and 10.');
            }
            if (row.bidModifier === bidModifier) {
                warnings.push('Audience bid modifier is unchanged and was skipped.');
                continue;
            }
            prepared.push({ ...raw, action, scope, ownerId: id, criterionType: type, audienceResourceName: resourceName, negative: false, criterionResourceName: row.resourceName, currentBidModifier: row.bidModifier, bidModifier });
            continue;
        }

        throw new GoogleAdsMutationValidationError('Unsupported audience change action.');
    }

    if (!prepared.length) {
        throw new GoogleAdsMutationValidationError(`No actionable audience changes remain. ${warnings.join(' ')}`.trim());
    }
    return { changes: prepared, warnings: [...new Set(warnings)] };
}

function audienceCriterionInfo(type: AudienceCriterionType, resourceName: string): any {
    const id = resourceName.split('/').pop();
    switch (type) {
        case 'AUDIENCE': return { audience: { audience: resourceName } };
        case 'USER_INTEREST': return { userInterest: { userInterestCategory: resourceName } };
        case 'USER_LIST': return { userList: { userList: resourceName } };
        case 'CUSTOM_AUDIENCE': return { customAudience: { customAudience: resourceName } };
        case 'COMBINED_AUDIENCE': return { combinedAudience: { combinedAudience: resourceName } };
        case 'LIFE_EVENT': return { lifeEvent: { lifeEventId: id } };
        case 'EXTENDED_DEMOGRAPHIC': return { extendedDemographic: { extendedDemographicId: id } };
    }
}

function demographicInfo(dimension: DemographicDimension, value: string): any {
    if (dimension === 'AGE_RANGE') return { ageRange: { type: value } };
    if (dimension === 'GENDER') return { gender: { type: value } };
    if (dimension === 'INCOME_RANGE') return { incomeRange: { type: value } };
    return { parentalStatus: { type: value } };
}

function mutateWrapper(scope: AudienceScope, operation: any): any {
    return scope === 'campaign'
        ? { campaignCriterionOperation: operation }
        : { adGroupCriterionOperation: operation };
}

export function buildAudienceMutationOperations(input: { customerId: string; changes: any[] }): AudienceBuiltMutation {
    const customerId = numericId(input.customerId, 'customerId');
    const operations: any[] = [];
    const diff: any[] = [];
    const touched = { campaignIds: [] as string[], adGroupIds: [] as string[] };
    const includesCustomAudienceCreate = input.changes.some(change => clean(change.action) === 'create_custom_audience');
    if (includesCustomAudienceCreate && input.changes.length !== 1) {
        throw new GoogleAdsMutationValidationError('Custom segment creation must be reviewed separately so an unrelated audience failure cannot leave a partially applied change.');
    }
    const touch = (change: any): void => {
        const campaignId = clean(change.campaignId);
        const adGroupId = clean(change.adGroupId);
        if (campaignId && !touched.campaignIds.includes(campaignId)) touched.campaignIds.push(campaignId);
        if (adGroupId && !touched.adGroupIds.includes(adGroupId)) touched.adGroupIds.push(adGroupId);
    };

    for (const change of input.changes) {
        touch(change);
        const action = clean(change.action);
        if (action === 'set_targeting_mode') {
            const scope = normalizeScope(change.scope, change);
            const update = {
                resourceName: ownerResource(customerId, scope, ownerId(scope, change)),
                targetingSetting: { targetRestrictions: canonicalRestrictions(change.targetingRestrictions) }
            };
            operations.push(scope === 'campaign'
                ? { campaignOperation: { update, updateMask: 'targetingSetting.targetRestrictions' } }
                : { adGroupOperation: { update, updateMask: 'targetingSetting.targetRestrictions' } });
            diff.push({ action, scope, ownerId: change.ownerId, mode: change.mode, from: change.currentTargetingRestrictions, to: change.targetingRestrictions });
            continue;
        }
        if (action === 'set_demographics') {
            const scope = normalizeScope(change.scope, change);
            const id = ownerId(scope, change);
            for (const value of change.adds || []) {
                operations.push(mutateWrapper(scope, { create: {
                    ...(scope === 'campaign' ? { campaign: ownerResource(customerId, scope, id) } : { adGroup: ownerResource(customerId, scope, id) }),
                    status: 'ENABLED',
                    negative: true,
                    ...demographicInfo(normalizeDimension(change.dimension), value)
                } }));
            }
            for (const item of change.removes || []) {
                operations.push(mutateWrapper(scope, { remove: criterionResource(customerId, scope, id, item.resourceName) }));
            }
            diff.push({ action, scope, ownerId: id, dimension: change.dimension, includedValues: change.includedValues, excludedValues: DEMOGRAPHIC_VALUES[normalizeDimension(change.dimension)].filter(value => !change.includedValues.includes(value)) });
            continue;
        }
        if (action === 'create_custom_audience') {
            const custom = change.customAudience;
            operations.push({ create: custom });
            diff.push({ action, name: custom.name, type: custom.type, memberCount: custom.members.length });
            continue;
        }
        const scope = normalizeScope(change.scope, change);
        const id = ownerId(scope, change);
        const type = normalizeCriterionType(change.criterionType);
        const resource = normalizeAudienceResource(customerId, type, change.audienceResourceName);
        if (action === 'add_segment') {
            operations.push(mutateWrapper(scope, { create: {
                ...(scope === 'campaign' ? { campaign: ownerResource(customerId, scope, id) } : { adGroup: ownerResource(customerId, scope, id) }),
                status: 'ENABLED', negative: change.negative === true,
                ...audienceCriterionInfo(type, resource)
            } }));
            diff.push({ action, scope, ownerId: id, criterionType: type, audienceResourceName: resource, negative: change.negative === true });
        } else if (action === 'remove_segment') {
            const criterion = criterionResource(customerId, scope, id, change.criterionResourceName);
            operations.push(mutateWrapper(scope, { remove: criterion }));
            diff.push({ action, scope, ownerId: id, criterionType: type, audienceResourceName: resource, criterionResourceName: criterion, negative: change.negative === true });
        } else if (action === 'set_bid_modifier') {
            const criterion = criterionResource(customerId, scope, id, change.criterionResourceName);
            operations.push(mutateWrapper(scope, { update: { resourceName: criterion, bidModifier: change.bidModifier }, updateMask: 'bidModifier' }));
            diff.push({ action, scope, ownerId: id, criterionType: type, audienceResourceName: resource, criterionResourceName: criterion, from: change.currentBidModifier, to: change.bidModifier });
        } else {
            throw new GoogleAdsMutationValidationError('Unsupported prepared audience change action.');
        }
    }
    if (!operations.length) throw new GoogleAdsMutationValidationError('No Google Ads audience operations were generated.');
    return {
        mutationType: 'audience_changes',
        operationsByPath: { [includesCustomAudienceCreate ? 'customAudiences:mutate' : 'googleAds:mutate']: operations },
        diff,
        warnings: [],
        touched
    };
}
