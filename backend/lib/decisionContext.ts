export type NegativeSource = 'account' | 'shared_list' | 'campaign' | 'ad_group';
export type NegativeMatchType = 'EXACT' | 'PHRASE' | 'BROAD' | string;

export interface TermScope {
    customerId?: string | null;
    campaignId?: string | null;
    campaignName?: string | null;
    adGroupId?: string | null;
    adGroupName?: string | null;
}

export interface NegativeRule {
    source: NegativeSource;
    customerId?: string | null;
    campaignId?: string | null;
    campaignName?: string | null;
    adGroupId?: string | null;
    adGroupName?: string | null;
    sharedSetId?: string | null;
    sharedSetResourceName?: string | null;
    sharedSetName?: string | null;
    attachedCampaignIds?: string[];
    attachedCampaignNames?: string[];
    attachmentCount?: number;
    activeAttachmentCount?: number;
    keywordText: string;
    keyword?: string;
    matchType: NegativeMatchType;
    status?: string | null;
    sourceStatus?: string | null;
    addedTo?: string | null;
    level?: string;
}

export interface ConfiguredKeywordRule {
    campaignId?: string | null;
    campaignName?: string | null;
    adGroupId?: string | null;
    adGroupName?: string | null;
    criterionId?: string | null;
    resourceName?: string | null;
    keywordText: string;
    keyword?: string;
    matchType?: string | null;
    status?: string | null;
    primaryStatus?: string | null;
}

export interface NegativeCoverage {
    isNegativeCovered: boolean;
    negativeCoverageLevel: NegativeSource | null;
    negativeCoverageSource: string | null;
    negativeCoverageKeyword: string | null;
    negativeCoverageMatchType: string | null;
    negativeCoverageScopeId: string | null;
    negativeCoverageScopeName: string | null;
    negativeCoverageReason: string | null;
    negativeCoverageMatchCount: number;
}

export interface ConfiguredKeywordCoverage {
    isConfiguredKeyword: boolean;
    configuredKeywordText: string | null;
    configuredKeywordStatus: string | null;
    configuredKeywordMatchTypes: string[];
    configuredKeywordScope: string | null;
    configuredKeywordReason: string | null;
    configuredKeywordMatchCount: number;
}

export interface TermDecisionContext {
    negativeCoverage: NegativeCoverage;
    configuredKeywordCoverage: ConfiguredKeywordCoverage;
}

export interface SourceCoverageEntry {
    name: string;
    fileName?: string;
    status: 'ok' | 'empty' | 'missing' | 'failed' | 'stale' | 'cached' | 'unknown';
    rows?: number | null;
    generatedAt?: string | null;
    ageHours?: number | null;
    error?: string | null;
    message?: string | null;
}

export interface SourceCoverageSummary {
    generatedAt: string;
    sources: SourceCoverageEntry[];
    missingSources: string[];
    staleSources: string[];
    failedSources: string[];
}

function sourceCoverageFromStatuses(statuses: any[] | undefined): SourceCoverageSummary | null {
    if (!Array.isArray(statuses)) return null;
    const sources: SourceCoverageEntry[] = statuses.map(status => ({
        name: String(status?.name || ''),
        status: status?.status || 'unknown',
        rows: status?.rows ?? null,
        ageHours: status?.ageHours ?? null,
        message: status?.message ?? null
    })).filter(status => status.name);

    return {
        generatedAt: new Date().toISOString(),
        sources,
        missingSources: sources.filter(entry => entry.status === 'missing').map(entry => entry.name),
        staleSources: sources.filter(entry => entry.status === 'stale').map(entry => entry.name),
        failedSources: sources.filter(entry => entry.status === 'failed').map(entry => entry.name)
    };
}

export function normalizeTerm(value: any): string {
    return String(value || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function keywordKey(value: any): string {
    return normalizeTerm(value);
}

function tokens(value: any): string[] {
    const normalized = normalizeTerm(value);
    return normalized ? normalized.split(' ').filter(Boolean) : [];
}

function matchTypeValue(value: any): string {
    return String(value || '').trim().toUpperCase();
}

function statusValue(value: any): string {
    return String(value || '').trim().toUpperCase();
}

function ruleKeyword(rule: NegativeRule | ConfiguredKeywordRule): string {
    return String(rule.keywordText || rule.keyword || '').trim();
}

function hasSameIdOrName(scopeValue: any, ruleValue: any): boolean {
    const scopeText = String(scopeValue || '').trim();
    const ruleText = String(ruleValue || '').trim();
    return Boolean(scopeText && ruleText && scopeText === ruleText);
}

function negativeTextMatches(term: string, rule: NegativeRule): boolean {
    const termTokens = tokens(term);
    const keywordTokens = tokens(ruleKeyword(rule));
    if (termTokens.length === 0 || keywordTokens.length === 0) return false;

    const matchType = matchTypeValue(rule.matchType);
    if (matchType === 'EXACT') return termTokens.join(' ') === keywordTokens.join(' ');
    if (matchType === 'PHRASE') return ` ${termTokens.join(' ')} `.includes(` ${keywordTokens.join(' ')} `);
    if (matchType === 'BROAD' || !matchType) {
        const termSet = new Set(termTokens);
        return keywordTokens.every(token => termSet.has(token));
    }
    return termTokens.join(' ') === keywordTokens.join(' ');
}

export function isActiveNegativeRule(rule: NegativeRule): boolean {
    const statuses = [rule.status, rule.sourceStatus]
        .map(statusValue)
        .filter(Boolean);
    return !statuses.some(status => ['REMOVED', 'DISABLED'].includes(status));
}

function negativeRuleAppliesToScope(rule: NegativeRule, scope: TermScope, allowScopedWithoutKnownCampaign: boolean): boolean {
    const campaignId = String(scope.campaignId || '').trim();
    const campaignName = String(scope.campaignName || '').trim();
    const adGroupId = String(scope.adGroupId || '').trim();
    const adGroupName = String(scope.adGroupName || '').trim();

    if (rule.source === 'account') return true;
    if (!campaignId && !campaignName && !adGroupId && !adGroupName) {
        if (rule.source === 'shared_list' && Number(rule.attachmentCount || 0) > 0 && Number(rule.activeAttachmentCount || 0) === 0) return false;
        return allowScopedWithoutKnownCampaign;
    }

    if (rule.source === 'campaign') {
        return hasSameIdOrName(campaignId, rule.campaignId) || hasSameIdOrName(campaignName, rule.campaignName);
    }

    if (rule.source === 'ad_group') {
        const campaignMatches = !campaignId && !campaignName
            ? true
            : hasSameIdOrName(campaignId, rule.campaignId) || hasSameIdOrName(campaignName, rule.campaignName);
        const adGroupMatches = hasSameIdOrName(adGroupId, rule.adGroupId) || hasSameIdOrName(adGroupName, rule.adGroupName);
        return campaignMatches && adGroupMatches;
    }

    if (rule.source === 'shared_list') {
        const attachedIds = new Set((rule.attachedCampaignIds || []).map(String).filter(Boolean));
        const attachedNames = new Set((rule.attachedCampaignNames || []).map(String).filter(Boolean));
        if (Number(rule.attachmentCount || 0) > 0 && Number(rule.activeAttachmentCount || 0) === 0) return false;
        if (attachedIds.size === 0 && attachedNames.size === 0) return false;
        return Boolean((campaignId && attachedIds.has(campaignId)) || (campaignName && attachedNames.has(campaignName)));
    }

    return false;
}

function negativeScopeId(rule: NegativeRule): string | null {
    if (rule.source === 'ad_group') return rule.adGroupId || rule.adGroupName || null;
    if (rule.source === 'campaign') return rule.campaignId || rule.campaignName || null;
    if (rule.source === 'shared_list') return rule.sharedSetId || rule.sharedSetResourceName || rule.sharedSetName || null;
    return rule.customerId || 'account';
}

function negativeScopeName(rule: NegativeRule): string | null {
    if (rule.source === 'ad_group') return rule.adGroupName || rule.addedTo || null;
    if (rule.source === 'campaign') return rule.campaignName || rule.addedTo || null;
    if (rule.source === 'shared_list') return rule.sharedSetName || rule.addedTo || null;
    return rule.addedTo || 'Account';
}

function sourceLabel(source: NegativeSource): string {
    if (source === 'ad_group') return 'Ad group';
    if (source === 'shared_list') return 'Shared negative list';
    if (source === 'campaign') return 'Campaign';
    return 'Account';
}

const negativeSpecificity: Record<NegativeSource, number> = {
    ad_group: 4,
    campaign: 3,
    shared_list: 2,
    account: 1
};

const matchSpecificity: Record<string, number> = {
    EXACT: 3,
    PHRASE: 2,
    BROAD: 1
};

export function emptyNegativeCoverage(): NegativeCoverage {
    return {
        isNegativeCovered: false,
        negativeCoverageLevel: null,
        negativeCoverageSource: null,
        negativeCoverageKeyword: null,
        negativeCoverageMatchType: null,
        negativeCoverageScopeId: null,
        negativeCoverageScopeName: null,
        negativeCoverageReason: null,
        negativeCoverageMatchCount: 0
    };
}

export function matchNegativeCoverage(
    term: string,
    scope: TermScope,
    rules: NegativeRule[],
    options: { allowAnyScope?: boolean; allowScopedWithoutKnownCampaign?: boolean } = {}
): NegativeCoverage {
    const allowScopedWithoutKnownCampaign = options.allowScopedWithoutKnownCampaign === true;
    const matches = rules
        .filter(rule => isActiveNegativeRule(rule))
        .filter(rule => negativeTextMatches(term, rule))
        .filter(rule => negativeRuleAppliesToScope(rule, scope, allowScopedWithoutKnownCampaign))
        .sort((a, b) => {
            const sourceDiff = negativeSpecificity[b.source] - negativeSpecificity[a.source];
            if (sourceDiff) return sourceDiff;
            return (matchSpecificity[matchTypeValue(b.matchType)] || 0) - (matchSpecificity[matchTypeValue(a.matchType)] || 0);
        });

    const best = matches[0];
    if (!best) return emptyNegativeCoverage();

    const keyword = ruleKeyword(best);
    const source = sourceLabel(best.source);
    return {
        isNegativeCovered: true,
        negativeCoverageLevel: best.source,
        negativeCoverageSource: source,
        negativeCoverageKeyword: keyword,
        negativeCoverageMatchType: matchTypeValue(best.matchType) || null,
        negativeCoverageScopeId: negativeScopeId(best),
        negativeCoverageScopeName: negativeScopeName(best),
        negativeCoverageReason: `${source} ${matchTypeValue(best.matchType) || 'keyword'} negative "${keyword}" covers this term.`,
        negativeCoverageMatchCount: matches.length
    };
}

function configuredAppliesToScope(rule: ConfiguredKeywordRule, scope: TermScope, allowAnyScope: boolean): boolean {
    const campaignId = String(scope.campaignId || '').trim();
    const campaignName = String(scope.campaignName || '').trim();
    const adGroupId = String(scope.adGroupId || '').trim();
    const adGroupName = String(scope.adGroupName || '').trim();
    if (!campaignId && !campaignName && !adGroupId && !adGroupName) return allowAnyScope;

    const campaignMatches = hasSameIdOrName(campaignId, rule.campaignId) || hasSameIdOrName(campaignName, rule.campaignName);
    const adGroupMatches = hasSameIdOrName(adGroupId, rule.adGroupId) || hasSameIdOrName(adGroupName, rule.adGroupName);
    if (adGroupId || adGroupName) return campaignMatches && adGroupMatches;
    return campaignMatches;
}

const configuredStatusPriority: Record<string, number> = {
    ENABLED: 4,
    PAUSED: 3,
    REMOVED: 2
};

export function emptyConfiguredKeywordCoverage(): ConfiguredKeywordCoverage {
    return {
        isConfiguredKeyword: false,
        configuredKeywordText: null,
        configuredKeywordStatus: null,
        configuredKeywordMatchTypes: [],
        configuredKeywordScope: null,
        configuredKeywordReason: null,
        configuredKeywordMatchCount: 0
    };
}

export function matchConfiguredKeywordCoverage(
    term: string,
    scope: TermScope,
    keywords: ConfiguredKeywordRule[],
    options: { allowAnyScope?: boolean } = {}
): ConfiguredKeywordCoverage {
    const normalized = keywordKey(term);
    if (!normalized) return emptyConfiguredKeywordCoverage();

    const matches = keywords
        .filter(rule => keywordKey(ruleKeyword(rule)) === normalized)
        .filter(rule => configuredAppliesToScope(rule, scope, options.allowAnyScope === true))
        .sort((a, b) => {
            const aAdGroup = configuredAppliesToScope(a, { ...scope, campaignId: scope.campaignId, campaignName: scope.campaignName }, false) && (a.adGroupId || a.adGroupName) ? 1 : 0;
            const bAdGroup = configuredAppliesToScope(b, { ...scope, campaignId: scope.campaignId, campaignName: scope.campaignName }, false) && (b.adGroupId || b.adGroupName) ? 1 : 0;
            if (aAdGroup !== bAdGroup) return bAdGroup - aAdGroup;
            return (configuredStatusPriority[statusValue(b.status)] || 0) - (configuredStatusPriority[statusValue(a.status)] || 0);
        });

    const best = matches[0];
    if (!best) return emptyConfiguredKeywordCoverage();

    const matchTypes = Array.from(new Set(matches.map(match => matchTypeValue(match.matchType)).filter(Boolean)));
    const scopeLabel = best.adGroupName || best.adGroupId
        ? `ad group ${best.adGroupName || best.adGroupId}`
        : best.campaignName || best.campaignId
            ? `campaign ${best.campaignName || best.campaignId}`
            : 'account';
    return {
        isConfiguredKeyword: true,
        configuredKeywordText: ruleKeyword(best),
        configuredKeywordStatus: statusValue(best.status) || null,
        configuredKeywordMatchTypes: matchTypes,
        configuredKeywordScope: scopeLabel,
        configuredKeywordReason: `Configured keyword "${ruleKeyword(best)}" already exists in ${scopeLabel}${best.status ? ` with status ${statusValue(best.status)}` : ''}.`,
        configuredKeywordMatchCount: matches.length
    };
}

export function decisionContextForTerm(
    term: string,
    scope: TermScope,
    negativeRules: NegativeRule[],
    configuredKeywords: ConfiguredKeywordRule[],
    options: { allowAnyScope?: boolean; allowScopedWithoutKnownCampaign?: boolean } = {}
): TermDecisionContext {
    return {
        negativeCoverage: matchNegativeCoverage(term, scope, negativeRules, options),
        configuredKeywordCoverage: matchConfiguredKeywordCoverage(term, scope, configuredKeywords, options)
    };
}

export function flattenDecisionContext(context: TermDecisionContext): Record<string, any> {
    return {
        negativeCoverage: context.negativeCoverage,
        configuredKeywordCoverage: context.configuredKeywordCoverage,
        isNegativeCovered: context.negativeCoverage.isNegativeCovered,
        negativeCoverageLevel: context.negativeCoverage.negativeCoverageLevel,
        negativeCoverageSource: context.negativeCoverage.negativeCoverageSource,
        negativeCoverageKeyword: context.negativeCoverage.negativeCoverageKeyword,
        negativeCoverageMatchType: context.negativeCoverage.negativeCoverageMatchType,
        negativeCoverageReason: context.negativeCoverage.negativeCoverageReason,
        isConfiguredKeyword: context.configuredKeywordCoverage.isConfiguredKeyword,
        configuredKeywordText: context.configuredKeywordCoverage.configuredKeywordText,
        configuredKeywordStatus: context.configuredKeywordCoverage.configuredKeywordStatus,
        configuredKeywordMatchTypes: context.configuredKeywordCoverage.configuredKeywordMatchTypes,
        configuredKeywordScope: context.configuredKeywordCoverage.configuredKeywordScope,
        configuredKeywordReason: context.configuredKeywordCoverage.configuredKeywordReason
    };
}

function toCamel(value: string): string {
    return value.replace(/_([a-z])/g, (_match, chr: string) => chr.toUpperCase());
}

export function getReportField(row: any, flatPath: string): any {
    if (!row || typeof row !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(row, flatPath)) return row[flatPath];

    const parts = flatPath.split('.');
    let current = row;
    for (const part of parts) {
        if (current === null || current === undefined) return undefined;
        const camel = toCamel(part);
        current = current[camel] ?? current[part];
    }
    return current;
}

function parseResourceId(resourceName: any): string | null {
    const text = String(resourceName || '').trim();
    if (!text) return null;
    const parts = text.split('/');
    return parts.length ? parts[parts.length - 1] : text;
}

function asStringArray(value: any): string[] {
    if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
    const text = String(value || '').trim();
    return text ? [text] : [];
}

export function configuredKeywordRuleFromReportRow(row: any): ConfiguredKeywordRule | null {
    const keywordText = String(getReportField(row, 'ad_group_criterion.keyword.text') || '').trim();
    if (!keywordText) return null;
    return {
        campaignId: String(getReportField(row, 'campaign.id') || '').trim() || null,
        campaignName: String(getReportField(row, 'campaign.name') || '').trim() || null,
        adGroupId: String(getReportField(row, 'ad_group.id') || '').trim() || null,
        adGroupName: String(getReportField(row, 'ad_group.name') || '').trim() || null,
        criterionId: String(getReportField(row, 'ad_group_criterion.criterion_id') || '').trim() || null,
        resourceName: String(getReportField(row, 'ad_group_criterion.resource_name') || '').trim() || null,
        keywordText,
        keyword: keywordText,
        matchType: String(getReportField(row, 'ad_group_criterion.keyword.match_type') || '').trim() || null,
        status: String(getReportField(row, 'ad_group_criterion.status') || '').trim() || null,
        primaryStatus: String(getReportField(row, 'ad_group_criterion.primary_status') || '').trim() || null
    };
}

interface NegativeReportInput {
    campaignNegatives?: any[];
    adGroupNegatives?: any[];
    accountNegatives?: any[];
    sharedNegativeSets?: any[];
    sharedNegativeCriteria?: any[];
    campaignSharedSets?: any[];
    customerId?: string | null;
}

export function normalizeNegativeRulesFromReports(input: NegativeReportInput): NegativeRule[] {
    const rules: NegativeRule[] = [];
    const accountAttachedSharedSetKeys = new Set<string>();

    for (const row of input.accountNegatives || []) {
        const sharedSetResource = String(getReportField(row, 'customer_negative_criterion.negative_keyword_list.shared_set') || '').trim();
        const sharedSetId = parseResourceId(sharedSetResource);
        for (const key of [sharedSetResource, sharedSetId].filter(Boolean) as string[]) {
            accountAttachedSharedSetKeys.add(key);
        }

        // Backward compatibility for preserved local files created before v24 exposed
        // account negatives only as shared-list attachments.
        const keywordText = String(getReportField(row, 'customer_negative_criterion.keyword.text') || '').trim();
        if (!keywordText) continue;
        rules.push({
            source: 'account',
            customerId: String(getReportField(row, 'customer.id') || input.customerId || '').trim() || null,
            keywordText,
            keyword: keywordText,
            matchType: String(getReportField(row, 'customer_negative_criterion.keyword.match_type') || '').trim() || 'BROAD',
            status: String(getReportField(row, 'customer_negative_criterion.status') || '').trim() || null,
            addedTo: 'Account',
            level: 'Account'
        });
    }

    for (const row of input.campaignNegatives || []) {
        const keywordText = String(getReportField(row, 'campaign_criterion.keyword.text') || '').trim();
        if (!keywordText) continue;
        rules.push({
            source: 'campaign',
            customerId: input.customerId || null,
            campaignId: String(getReportField(row, 'campaign.id') || '').trim() || null,
            campaignName: String(getReportField(row, 'campaign.name') || '').trim() || null,
            keywordText,
            keyword: keywordText,
            matchType: String(getReportField(row, 'campaign_criterion.keyword.match_type') || '').trim() || 'BROAD',
            status: String(getReportField(row, 'campaign_criterion.status') || '').trim() || null,
            addedTo: String(getReportField(row, 'campaign.name') || '').trim() || null,
            level: 'Campaign'
        });
    }

    for (const row of input.adGroupNegatives || []) {
        const keywordText = String(getReportField(row, 'ad_group_criterion.keyword.text') || '').trim();
        if (!keywordText) continue;
        rules.push({
            source: 'ad_group',
            customerId: input.customerId || null,
            campaignId: String(getReportField(row, 'campaign.id') || '').trim() || null,
            campaignName: String(getReportField(row, 'campaign.name') || '').trim() || null,
            adGroupId: String(getReportField(row, 'ad_group.id') || '').trim() || null,
            adGroupName: String(getReportField(row, 'ad_group.name') || '').trim() || null,
            keywordText,
            keyword: keywordText,
            matchType: String(getReportField(row, 'ad_group_criterion.keyword.match_type') || '').trim() || 'BROAD',
            status: String(getReportField(row, 'ad_group_criterion.status') || '').trim() || null,
            addedTo: String(getReportField(row, 'ad_group.name') || '').trim() || null,
            level: 'Ad Group'
        });
    }

    const sharedSetsByResource = new Map<string, { id: string | null; name: string | null; status: string | null; resourceName: string | null }>();
    for (const row of input.sharedNegativeSets || []) {
        const resourceName = String(getReportField(row, 'shared_set.resource_name') || '').trim();
        const id = String(getReportField(row, 'shared_set.id') || parseResourceId(resourceName) || '').trim() || null;
        if (!resourceName && !id) continue;
        const set = {
            id,
            name: String(getReportField(row, 'shared_set.name') || '').trim() || null,
            status: String(getReportField(row, 'shared_set.status') || '').trim() || null,
            resourceName: resourceName || null
        };
        if (resourceName) sharedSetsByResource.set(resourceName, set);
        if (id) sharedSetsByResource.set(id, set);
    }

    const attachmentsBySharedSet = new Map<string, { ids: Set<string>; names: Set<string>; total: number; active: number }>();
    for (const row of input.campaignSharedSets || []) {
        const sharedSetResource = String(getReportField(row, 'campaign_shared_set.shared_set') || '').trim();
        const sharedSetId = parseResourceId(sharedSetResource);
        const keys = [sharedSetResource, sharedSetId].filter(Boolean) as string[];
        for (const key of keys) {
            const bucket = attachmentsBySharedSet.get(key) || { ids: new Set<string>(), names: new Set<string>(), total: 0, active: 0 };
            const campaignId = String(getReportField(row, 'campaign.id') || '').trim();
            const campaignName = String(getReportField(row, 'campaign.name') || '').trim();
            const status = statusValue(getReportField(row, 'campaign_shared_set.status'));
            bucket.total += 1;
            if (!['REMOVED', 'DISABLED'].includes(status)) {
                bucket.active += 1;
                if (campaignId) bucket.ids.add(campaignId);
                if (campaignName) bucket.names.add(campaignName);
            }
            attachmentsBySharedSet.set(key, bucket);
        }
    }

    for (const row of input.sharedNegativeCriteria || []) {
        const keywordText = String(getReportField(row, 'shared_criterion.keyword.text') || '').trim();
        if (!keywordText) continue;
        const sharedSetResource = String(getReportField(row, 'shared_criterion.shared_set') || '').trim();
        const sharedSetId = parseResourceId(sharedSetResource);
        const setInfo = (sharedSetResource && sharedSetsByResource.get(sharedSetResource))
            || (sharedSetId && sharedSetsByResource.get(sharedSetId))
            || { id: sharedSetId, name: null, status: null, resourceName: sharedSetResource || null };
        const attachment = (sharedSetResource && attachmentsBySharedSet.get(sharedSetResource))
            || (sharedSetId && attachmentsBySharedSet.get(sharedSetId))
            || { ids: new Set<string>(), names: new Set<string>(), total: 0, active: 0 };
        const matchType = String(getReportField(row, 'shared_criterion.keyword.match_type') || '').trim() || 'BROAD';
        const accountAttached = Boolean(
            (sharedSetResource && accountAttachedSharedSetKeys.has(sharedSetResource))
            || (sharedSetId && accountAttachedSharedSetKeys.has(sharedSetId))
        );

        if (accountAttached) {
            rules.push({
                source: 'account',
                customerId: input.customerId || null,
                sharedSetId: setInfo.id || sharedSetId || null,
                sharedSetResourceName: setInfo.resourceName || sharedSetResource || null,
                sharedSetName: setInfo.name || null,
                keywordText,
                keyword: keywordText,
                matchType,
                status: null,
                sourceStatus: setInfo.status || null,
                addedTo: setInfo.name ? `Account negative list: ${setInfo.name}` : 'Account negative list',
                level: 'Account'
            });
        }

        if (!accountAttached) {
            rules.push({
                source: 'shared_list',
                customerId: input.customerId || null,
                sharedSetId: setInfo.id || sharedSetId || null,
                sharedSetResourceName: setInfo.resourceName || sharedSetResource || null,
                sharedSetName: setInfo.name || null,
                attachedCampaignIds: Array.from(attachment.ids),
                attachedCampaignNames: Array.from(attachment.names),
                attachmentCount: attachment.total,
                activeAttachmentCount: attachment.active,
                keywordText,
                keyword: keywordText,
                matchType,
                status: null,
                sourceStatus: setInfo.status || null,
                addedTo: setInfo.name || sharedSetId || 'Shared negative list',
                level: 'Shared List'
            });
        }
    }

    return rules;
}

function countBy<T extends string>(values: T[]): Record<string, number> {
    return values.reduce((acc: Record<string, number>, value) => {
        const key = value || 'unknown';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
}

export function buildDecisionContextSummary(input: {
    negativeRules: NegativeRule[];
    configuredKeywords: ConfiguredKeywordRule[];
    searchTerms?: any[];
    plannerIdeas?: any[];
    plannerHistoricalMetrics?: any[];
    candidateSignals?: any[];
    sourceCoverage?: SourceCoverageSummary;
    decisionInputs?: Record<string, any>;
}): Record<string, any> {
    const searchTerms = input.searchTerms || [];
    const plannerIdeas = input.plannerIdeas || [];
    const plannerHistoricalMetrics = input.plannerHistoricalMetrics || [];
    const candidateSignals = input.candidateSignals || [];
    const plannerRows = [...plannerIdeas, ...plannerHistoricalMetrics];
    const negativeRules = input.negativeRules || [];
    const configuredKeywords = input.configuredKeywords || [];
    const sourceCoverage = input.sourceCoverage || sourceCoverageFromStatuses(input.decisionInputs?.sourceStatuses);

    return {
        generatedAt: new Date().toISOString(),
        negativeRules: {
            total: negativeRules.length,
            bySource: countBy(negativeRules.map(rule => rule.source)),
            active: negativeRules.filter(isActiveNegativeRule).length
        },
        configuredKeywords: {
            total: configuredKeywords.length,
            byStatus: countBy(configuredKeywords.map(rule => statusValue(rule.status) || 'UNKNOWN')),
            byMatchType: countBy(configuredKeywords.map(rule => matchTypeValue(rule.matchType) || 'UNKNOWN'))
        },
        searchTerms: {
            total: searchTerms.length,
            alreadyExcluded: searchTerms.filter(row => row?.negativeCoverage?.isNegativeCovered || row?.isNegativeCovered).length,
            alreadyConfigured: searchTerms.filter(row => row?.configuredKeywordCoverage?.isConfiguredKeyword || row?.isConfiguredKeyword).length,
            googleExcludedStatus: searchTerms.filter(row => ['EXCLUDED', 'PHRASE_EXCLUDED'].includes(statusValue(row?.status))).length
        },
        keywordPlanner: {
            ideas: plannerIdeas.length,
            historicalMetrics: plannerHistoricalMetrics.length,
            blockedByNegatives: plannerRows.filter(row => row?.negativeCoverage?.isNegativeCovered || row?.isNegativeCovered || row?.blockedByNegative).length,
            alreadyConfigured: plannerRows.filter(row => row?.configuredKeywordCoverage?.isConfiguredKeyword || row?.isConfiguredKeyword).length
        },
        candidateSignals: {
            total: candidateSignals.length,
            byType: countBy(candidateSignals.map(signal => String(signal?.type || 'UNKNOWN'))),
            withMissingData: candidateSignals.filter(signal => {
                const missing = Array.isArray(signal?.missing_data) ? signal.missing_data : signal?.missingData;
                return Array.isArray(missing) && missing.length > 0;
            }).length
        },
        sourceCoverage: {
            missingSources: sourceCoverage?.missingSources || [],
            staleSources: sourceCoverage?.staleSources || [],
            failedSources: sourceCoverage?.failedSources || []
        },
        decisionInputs: input.decisionInputs || {}
    };
}
