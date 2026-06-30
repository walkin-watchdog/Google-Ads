import { Pool } from 'pg';
import { getWarehouseWatermark, selectCandidateSignals, type DashboardFilters } from './adsWarehouse';
import { buildDashboardPayloadForView, resolveDashboardFilters } from './dashboardPayload';

const DEFAULT_CANDIDATE_SIGNAL_LIMIT = 250;

function cleanText(value: any): string {
    return String(value ?? '').trim();
}

function numberValue(value: any): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
}

function normalizeText(value: any): string {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .replace(/\s+/g, ' ');
}

function statusIsEnabled(value: any): boolean {
    const status = cleanText(value).toUpperCase();
    return !status || status === 'ENABLED';
}

function campaignIsConsistent(row: any, campaignId: any, campaignName?: any): boolean {
    const rowCampaignId = cleanText(row?.campaignId || row?.campaign_id);
    const campaignIdText = cleanText(campaignId);
    if (rowCampaignId && campaignIdText) return rowCampaignId === campaignIdText;
    const rowCampaignName = cleanText(row?.campaign || row?.campaignName || row?.campaign_name);
    const campaignNameText = cleanText(campaignName);
    if (rowCampaignName && campaignNameText && rowCampaignName !== campaignNameText) return false;
    return true;
}

function rowMatchesAdGroup(row: any, adGroup: any): boolean {
    if (!campaignIsConsistent(row, adGroup?.campaignId, adGroup?.campaign)) return false;
    const rowAdGroupId = cleanText(row?.adGroupId || row?.ad_group_id);
    const adGroupId = cleanText(adGroup?.id || adGroup?.adGroupId);
    if (rowAdGroupId && adGroupId) return rowAdGroupId === adGroupId;
    const rowAdGroupName = cleanText(row?.adGroup || row?.ad_group_name);
    const adGroupName = cleanText(adGroup?.name || adGroup?.adGroup);
    return Boolean(rowAdGroupName && adGroupName && rowAdGroupName === adGroupName);
}

function rowMatchesCampaign(row: any, campaignId: any, campaignName?: any): boolean {
    const rowCampaignId = String(row?.campaignId || row?.campaign_id || '').trim();
    const campaignIdText = String(campaignId || '').trim();
    if (rowCampaignId && campaignIdText) return rowCampaignId === campaignIdText;
    const rowCampaignName = String(row?.campaign || row?.campaignName || row?.campaign_name || '').trim();
    const campaignNameText = String(campaignName || '').trim();
    return Boolean(rowCampaignName && campaignNameText && rowCampaignName === campaignNameText);
}

function compactSignal(signal: any): any {
    return {
        signal_id: signal.signal_id,
        type: signal.type,
        severity: signal.severity,
        campaign_id: signal.campaign_id,
        ad_group_id: signal.ad_group_id,
        entity: signal.entity,
        metrics: signal.metrics,
        missing_data: signal.missing_data,
        counter_evidence: signal.counter_evidence || signal.counterEvidence,
        decisionContext: signal.decisionContext || signal.decision_context || null,
        verificationSpec: signal.verificationSpec || signal.verification_spec || null,
        evidence_window: signal.evidence_window || signal.evidenceWindow || null
    };
}

function candidateSignalPayload(row: any): any {
    const payload = row.payload || {};
    return {
        ...payload,
        signal_id: payload.signal_id || row.signal_id,
        type: payload.type || row.signal_type,
        severity: payload.severity || row.severity,
        campaign_id: payload.campaign_id || row.campaign_id,
        ad_group_id: payload.ad_group_id || row.ad_group_id,
        evidence_window: payload.evidence_window || {
            start: row.evidence_start_date,
            end: row.evidence_end_date
        }
    };
}

function compactPerformanceRow(row: any): any {
    return {
        id: row.id || row.adGroupId || row.campaignId || null,
        name: row.name || row.adGroup || row.campaign || null,
        status: row.status || null,
        campaignId: row.campaignId || null,
        campaign: row.campaign || row.campaignName || null,
        adGroupId: row.adGroupId || null,
        adGroup: row.adGroup || null,
        spend: numberValue(row.spend),
        clicks: numberValue(row.clicks),
        impressions: numberValue(row.impressions),
        conversions: numberValue(row.conversions),
        allConversions: numberValue(row.allConversions),
        ctr: row.ctr ?? null,
        cvr: row.cvr ?? null,
        cpa: row.cpa ?? null,
        avgCpc: row.avgCpc ?? null,
        impressionShare: row.impressionShare ?? null,
        lostISBudget: row.lostISBudget ?? null,
        lostISRank: row.lostISRank ?? null,
        biddingStrategy: row.biddingStrategy || null,
        targetCpa: row.targetCpa ?? null,
        targetRoas: row.targetRoas ?? null,
        budget: row.budget ?? null
    };
}

function sourceStatusRank(status: any): number {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'failed') return 5;
    if (normalized === 'stale') return 4;
    if (normalized === 'missing') return 3;
    if (normalized === 'empty') return 2;
    if (normalized === 'ok' || normalized === 'cached') return 1;
    return 0;
}

function mergeSourceCoverage(...coverages: any[]): any {
    const byName = new Map<string, any>();
    const missingSources = new Set<string>();
    const staleSources = new Set<string>();
    const failedSources = new Set<string>();
    let refreshRun: any = null;
    for (const coverage of coverages) {
        if (!refreshRun && coverage?.refreshRun) refreshRun = coverage.refreshRun;
        for (const name of Array.isArray(coverage?.missingSources) ? coverage.missingSources : []) {
            const text = cleanText(name);
            if (text) missingSources.add(text);
        }
        for (const name of Array.isArray(coverage?.staleSources) ? coverage.staleSources : []) {
            const text = cleanText(name);
            if (text) staleSources.add(text);
        }
        for (const name of Array.isArray(coverage?.failedSources) ? coverage.failedSources : []) {
            const text = cleanText(name);
            if (text) failedSources.add(text);
        }
        for (const source of Array.isArray(coverage?.sources) ? coverage.sources : []) {
            const name = String(source?.name || '').trim();
            if (!name) continue;
            const existing = byName.get(name);
            if (!existing
                || sourceStatusRank(source.status) > sourceStatusRank(existing.status)
                || numberValue(source.rows) > numberValue(existing.rows)) {
                byName.set(name, source);
            }
        }
    }
    const sources = Array.from(byName.values()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const source of sources) {
        if (source.status === 'missing') missingSources.add(source.name);
        if (source.status === 'stale') staleSources.add(source.name);
        if (source.status === 'failed') failedSources.add(source.name);
    }
    const merged: any = {
        generatedAt: new Date().toISOString(),
        sources,
        missingSources: Array.from(missingSources).sort(),
        staleSources: Array.from(staleSources).sort(),
        failedSources: Array.from(failedSources).sort()
    };
    if (refreshRun) merged.refreshRun = refreshRun;
    return merged;
}

function compactLeadAttribution(leadAttribution: any, searchTermLimit = 25): any {
    if (!leadAttribution) return null;
    return {
        generatedAt: leadAttribution.generatedAt,
        mode: leadAttribution.mode || null,
        totals: leadAttribution.totals,
        byCampaign: (leadAttribution.byCampaign || []).slice(0, 50),
        bySearchTerm: (leadAttribution.bySearchTerm || []).slice(0, searchTermLimit),
        journeySummary: leadAttribution.journeySummary ? {
            totalSessions: leadAttribution.journeySummary.totalSessions,
            sessionsWithMultipleActions: leadAttribution.journeySummary.sessionsWithMultipleActions,
            topPaths: (leadAttribution.journeySummary.topPaths || []).slice(0, 10),
            pathOutcomes: (leadAttribution.journeySummary.pathOutcomes || []).slice(0, 10)
        } : null,
        offlineExport: leadAttribution.offlineExport
    };
}

function compactDecisionContextFromPayloads(input: {
    overview: any;
    keywords?: any;
    rank?: any;
    candidateSignals?: any[];
}): any {
    const overview = input.overview || {};
    const keywords = input.keywords || {};
    const rank = input.rank || {};
    const sourceCoverage = mergeSourceCoverage(overview.sourceCoverage, keywords.sourceCoverage, rank.sourceCoverage);
    const decisionContext = {
        ...(overview.decisionContext || {}),
        ...(keywords.decisionContext || {}),
        sourceCoverage: {
            ...(overview.decisionContext?.sourceCoverage || {}),
            ...(keywords.decisionContext?.sourceCoverage || {}),
            ...(rank.decisionContext?.sourceCoverage || {}),
            missingSources: sourceCoverage.missingSources,
            staleSources: sourceCoverage.staleSources,
            failedSources: sourceCoverage.failedSources
        },
        decisionInputs: {
            ...(overview.decisionContext?.decisionInputs || {}),
            ...(keywords.decisionContext?.decisionInputs || {}),
            ...(rank.decisionContext?.decisionInputs || {})
        }
    };
    const candidateSignals = input.candidateSignals || keywords.candidateSignals || rank.candidateSignals || [];
    return {
        meta: overview.meta || keywords.meta || rank.meta || {},
        summary: overview.summary || keywords.summary || rank.summary || {},
        periodComparison: overview.periodComparison || null,
        decisionContext,
        sourceCoverage,
        campaigns: (overview.campaigns || []).slice(0, 50).map(compactPerformanceRow),
        adGroups: (overview.adGroups || []).slice(0, 100).map(compactPerformanceRow),
        leadAttribution: compactLeadAttribution(overview.leadAttribution || keywords.leadAttribution, 25),
        keywordPlanner: keywords.keywordPlanner ? {
            status: keywords.keywordPlanner.status,
            topIdeas: (keywords.keywordPlanner.ideas || []).slice(0, 10).map((idea: any) => ({
                keyword: idea.keyword || idea.text,
                avgMonthlySearches: idea.avgMonthlySearches,
                competition: idea.competition,
                lowBid: idea.lowBid,
                highBid: idea.highBid,
                plannerScore: idea.plannerScore,
                blockedByNegative: idea.blockedByNegative,
                plannerClassification: idea.plannerClassification
            }))
        } : null,
        rankSupport: {
            qualityScoreRows: Array.isArray(rank.qualityScores) ? rank.qualityScores.length : 0,
            landingPageRows: Array.isArray(rank.landingPages) ? rank.landingPages.length : 0,
            expandedLandingPageRows: Array.isArray(rank.expandedLandingPages) ? rank.expandedLandingPages.length : 0,
            deviceRows: Array.isArray(rank.devicePerformance) ? rank.devicePerformance.length : 0,
            dayOfWeekRows: Array.isArray(rank.dayOfWeekPerformance) ? rank.dayOfWeekPerformance.length : 0,
            dayAndHourRows: Array.isArray(rank.dayAndHourPerformance) ? rank.dayAndHourPerformance.length : 0
        },
        auctionInsightsStatus: rank.auctionInsightsStatus || [],
        candidateSignals: candidateSignals.slice(0, 25).map(compactSignal),
        sections: Array.from(new Set([
            ...Object.keys(overview || {}),
            ...Object.keys(keywords || {}),
            ...Object.keys(rank || {})
        ])).sort()
    };
}

function compactLimit(value: any, fallback: number, max: number): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
    return Math.min(Math.floor(numeric), max);
}

export async function getCandidateSignalsPayload(pool: Pool, rawArgs: Record<string, any> = {}): Promise<any[]> {
    const filters = await resolveDashboardFilters(pool, rawArgs);
    const limitValue = rawArgs.limit === undefined || rawArgs.limit === null
        ? DEFAULT_CANDIDATE_SIGNAL_LIMIT
        : compactLimit(rawArgs.limit, DEFAULT_CANDIDATE_SIGNAL_LIMIT, 1000);
    const rows = await selectCandidateSignals(pool, filters, limitValue);
    return rows.map(candidateSignalPayload);
}

export async function getCompactDecisionContext(pool: Pool, rawArgs: Record<string, any> = {}): Promise<any> {
    const filters = await resolveDashboardFilters(pool, rawArgs);
    const warehouseWatermark = await getWarehouseWatermark(pool, filters);
    const overview = await buildDashboardPayloadForView(pool, filters, 'overview', { filtersResolved: true, warehouseWatermark });
    const [keywords, rank, candidateSignals] = await Promise.all([
        buildDashboardPayloadForView(pool, filters, 'keywords', { filtersResolved: true, warehouseWatermark }),
        buildDashboardPayloadForView(pool, filters, 'rank', { filtersResolved: true, warehouseWatermark }),
        selectCandidateSignals(pool, filters, 50).then(rows => rows.map(candidateSignalPayload))
    ]);
    return compactDecisionContextFromPayloads({ overview, keywords, rank, candidateSignals });
}

function activeNegativeRule(rule: any): boolean {
    const statuses = [rule?.status, rule?.sourceStatus]
        .map(value => String(value || '').trim().toUpperCase())
        .filter(Boolean);
    return !statuses.some(status => ['REMOVED', 'DISABLED'].includes(status));
}

function negativeRuleAppliesToAdGroup(rule: any, adGroup: any): boolean {
    const source = String(rule?.source || '').trim();
    if (source === 'account') return true;
    if (source === 'campaign') return rowMatchesCampaign(rule, adGroup.campaignId, adGroup.campaign);
    if (source === 'ad_group') return rowMatchesAdGroup(rule, adGroup);
    if (source === 'shared_list') {
        const campaignId = String(adGroup.campaignId || '').trim();
        const campaignName = String(adGroup.campaign || '').trim();
        const attachedIds = new Set((rule?.attachedCampaignIds || []).map(String));
        const attachedNames = new Set((rule?.attachedCampaignNames || []).map(String));
        return Boolean((campaignId && attachedIds.has(campaignId)) || (campaignName && attachedNames.has(campaignName)));
    }
    return false;
}

function countByField(rows: any[], field: string): Record<string, number> {
    return rows.reduce((acc: Record<string, number>, row) => {
        const key = String(row?.[field] || 'UNKNOWN').trim() || 'UNKNOWN';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
}

function compactSearchTerm(row: any): any {
    return {
        searchTerm: row.searchTerm,
        campaignId: row.campaignId,
        adGroupId: row.adGroupId,
        spend: numberValue(row.spend),
        clicks: numberValue(row.clicks),
        impressions: numberValue(row.impressions),
        conversions: numberValue(row.conversions),
        cpa: row.cpa ?? null,
        matchedKeyword: row.matchedKeyword || null,
        keywordMatchType: row.keywordMatchType || null,
        searchTermMatchType: row.searchTermMatchType || null,
        decisionClassification: row.decisionClassification || null,
        isNegativeCovered: Boolean(row.isNegativeCovered),
        negativeCoverageSource: row.negativeCoverageSource || null,
        negativeCoverageKeyword: row.negativeCoverageKeyword || null,
        isConfiguredKeyword: Boolean(row.isConfiguredKeyword),
        configuredKeywordStatus: row.configuredKeywordStatus || null,
        leadQuality: row.leadQuality || null,
        leadQualityStatus: row.leadQualityStatus || null,
        plannerScore: row.plannerScore ?? null,
        avgMonthlySearches: row.avgMonthlySearches ?? null
    };
}

function leadAttributionRowMatchesCampaign(row: any, adGroup: any): boolean {
    const campaignId = cleanText(adGroup?.campaignId);
    const campaignName = cleanText(adGroup?.campaign);
    const rowIds = [
        row?.campaignId,
        row?.campaign_id,
        row?.utmCampaignId,
        row?.utm_campaign
    ].map(cleanText).filter(Boolean);
    const rowNames = [
        row?.campaign,
        row?.campaignName,
        row?.campaign_name
    ].map(cleanText).filter(Boolean);
    if (campaignId && rowIds.includes(campaignId)) return true;
    if (campaignName && rowNames.includes(campaignName)) return true;
    // Lead attribution can retain an unresolved UTM campaign name in campaignId.
    if (campaignName && rowIds.includes(campaignName)) return true;
    if (campaignId && rowNames.includes(campaignId)) return true;
    return false;
}

function leadSummaryForAdGroup(adGroup: any, leadAttribution: any, adGroupSearchTerms: any[]): any {
    const byCampaign = (leadAttribution?.byCampaign || []).filter((row: any) =>
        leadAttributionRowMatchesCampaign(row, adGroup)
    );
    const adGroupTerms = new Set(adGroupSearchTerms.map(row => normalizeText(row.searchTerm)).filter(Boolean));
    const bySearchTerm = (leadAttribution?.bySearchTerm || [])
        .filter((row: any) =>
            adGroupTerms.has(normalizeText(row.searchTerm || row.utmTerm))
            && leadAttributionRowMatchesCampaign(row, adGroup)
        )
        .slice(0, 10);
    return {
        attributionLevel: 'campaign_and_search_term',
        byCampaign,
        bySearchTerm,
        caveats: [
            'Ad-group lead quality depends on website capture of ad group identifiers; campaign and search-term matches may be incomplete.',
            'Search-term lead quality is only attached when the lead-attribution campaign matches this ad group.'
        ]
    };
}

function qualitySummaryForAdGroup(adGroup: any, rank: any): any {
    const rows = (rank.qualityScores || []).filter((row: any) => rowMatchesAdGroup(row, adGroup));
    const numericScores: number[] = rows
        .map((row: any) => Number(row.qualityScore))
        .filter((score: number) => Number.isFinite(score) && score > 0);
    const averageQualityScore = numericScores.length
        ? +(numericScores.reduce((sum: number, score: number) => sum + score, 0) / numericScores.length).toFixed(2)
        : null;
    return {
        rows: rows.length,
        averageQualityScore,
        weakRows: rows.filter((row: any) => Number(row.qualityScore || 0) > 0 && Number(row.qualityScore || 0) <= 5).slice(0, 10).map((row: any) => ({
            keyword: row.keyword,
            matchType: row.matchType,
            qualityScore: row.qualityScore,
            adRelevance: row.adRelevance,
            landingPageExperience: row.landingPageExperience,
            expectedCtr: row.expectedCtr
        }))
    };
}

function landingPageSummaryForAdGroup(adGroup: any, rank: any): any {
    const pages = [...(rank.landingPages || []), ...(rank.expandedLandingPages || [])]
        .filter((row: any) => rowMatchesAdGroup(row, adGroup))
        .sort((a: any, b: any) => numberValue(b.spend) - numberValue(a.spend))
        .slice(0, 5)
        .map((row: any) => ({
            url: row.url || row.finalUrl || row.expandedFinalUrl || row.unexpandedFinalUrl || null,
            spend: numberValue(row.spend),
            clicks: numberValue(row.clicks),
            conversions: numberValue(row.conversions),
            cpa: row.cpa ?? null,
            mobileFriendlyClicksPct: row.mobileFriendlyClicksPct ?? null,
            validAmpClicksPct: row.validAmpClicksPct ?? null,
            speedScore: row.speedScore ?? null
        }));
    return { topPages: pages };
}

function auctionStatusForAdGroup(adGroup: any, rank: any): any[] {
    return (rank.auctionInsightsStatus || [])
        .filter((row: any) => {
            const entityType = String(row.entityType || '').toLowerCase();
            if (entityType === 'account') return true;
            if (entityType === 'campaign') return String(row.entityId || '') === String(adGroup.campaignId || '');
            if (entityType === 'ad_group' || entityType === 'adgroup') return String(row.entityId || '') === String(adGroup.adGroupId || adGroup.id || '');
            return false;
        })
        .slice(0, 10);
}

function signalMatchesAdGroup(signal: any, adGroup: any): boolean {
    const signalAdGroupId = String(signal.ad_group_id || signal.adGroupId || signal.entity?.ad_group_id || signal.entity?.adGroupId || '').trim();
    const adGroupId = String(adGroup.adGroupId || adGroup.id || '').trim();
    if (signalAdGroupId && adGroupId) return signalAdGroupId === adGroupId;
    const signalCampaignId = String(signal.campaign_id || signal.campaignId || signal.entity?.campaign_id || signal.entity?.campaignId || '').trim();
    const campaignId = String(adGroup.campaignId || '').trim();
    return !signalCampaignId || !campaignId || signalCampaignId === campaignId;
}

function adGroupKey(row: any): string | null {
    const id = cleanText(row?.adGroupId || row?.id);
    if (!id) return null;
    const campaignId = cleanText(row?.campaignId);
    return campaignId ? `${campaignId}|${id}` : id;
}

function adGroupMatchesFilters(row: any, filters: DashboardFilters): boolean {
    if (filters.campaignId && cleanText(row?.campaignId) !== filters.campaignId) return false;
    if (filters.adGroupId && cleanText(row?.adGroupId || row?.id) !== filters.adGroupId) return false;
    return true;
}

export function buildProposalContextFromPayloads(
    filters: DashboardFilters,
    rawArgs: Record<string, any> = {},
    overview: any,
    keywords: any,
    rank: any,
    candidateSignals: any[]
): any {
    const topSearchTerms = compactLimit(rawArgs.topSearchTerms, 8, 25);
    const topSignals = compactLimit(rawArgs.topSignals, 10, 25);
    const sourceCoverage = mergeSourceCoverage(overview.sourceCoverage, keywords.sourceCoverage, rank.sourceCoverage);
    const performanceAdGroups = new Map<string, any>();
    for (const row of overview.adGroups || []) {
        const key = adGroupKey(row);
        if (key) performanceAdGroups.set(key, row);
        const id = cleanText(row?.adGroupId || row?.id);
        if (id && !performanceAdGroups.has(id)) performanceAdGroups.set(id, row);
    }
    const configuredAdGroups = (overview.filterOptions?.adGroups || []).map((row: any) => {
        const id = cleanText(row.id || row.adGroupId);
        const campaignId = cleanText(row.campaignId) || null;
        const performance = performanceAdGroups.get(campaignId ? `${campaignId}|${id}` : id)
            || performanceAdGroups.get(id);
        return {
            ...(performance || {}),
            id,
            name: performance?.name || row.name || id,
            status: performance?.status || row.status || null,
            campaignId: performance?.campaignId || campaignId,
            campaign: performance?.campaign || row.campaignName || null,
            adGroupId: performance?.adGroupId || id,
            adGroup: performance?.adGroup || row.name || id
        };
    });
    const sourceAdGroups = configuredAdGroups.length ? configuredAdGroups : (overview.adGroups || []);
    const enabledAdGroups = sourceAdGroups
        .filter((row: any) => statusIsEnabled(row.status))
        .filter((row: any) => adGroupMatchesFilters(row, filters))
        .sort((a: any, b: any) => numberValue(b.spend) - numberValue(a.spend));
    const maxAdGroups = rawArgs.maxAdGroups === undefined || rawArgs.maxAdGroups === null
        ? enabledAdGroups.length
        : compactLimit(rawArgs.maxAdGroups, enabledAdGroups.length, enabledAdGroups.length);
    const adGroups = enabledAdGroups.slice(0, maxAdGroups).map((adGroup: any) => {
        const compactAdGroup = compactPerformanceRow(adGroup);
        const searchTerms = (keywords.searchTerms || [])
            .filter((row: any) => rowMatchesAdGroup(row, compactAdGroup))
            .sort((a: any, b: any) => numberValue(b.spend) - numberValue(a.spend));
        const configuredKeywords = (keywords.configuredKeywords || []).filter((row: any) => rowMatchesAdGroup(row, compactAdGroup));
        const negativeRules = (keywords.negatives || []).filter((rule: any) => negativeRuleAppliesToAdGroup(rule, compactAdGroup));
        const activeNegativeRules = negativeRules.filter(activeNegativeRule);
        const signals = candidateSignals.filter((signal: any) => signalMatchesAdGroup(signal, compactAdGroup)).slice(0, topSignals);
        const visibleSpend = searchTerms.reduce((sum: number, row: any) => sum + numberValue(row.spend), 0);
        const negativeCoveredSpend = searchTerms
            .filter((row: any) => row.isNegativeCovered)
            .reduce((sum: number, row: any) => sum + numberValue(row.spend), 0);
        const configuredSpend = searchTerms
            .filter((row: any) => row.isConfiguredKeyword)
            .reduce((sum: number, row: any) => sum + numberValue(row.spend), 0);
        return {
            adGroup: compactAdGroup,
            leadQuality: leadSummaryForAdGroup(compactAdGroup, overview.leadAttribution || keywords.leadAttribution, searchTerms),
            searchTerms: {
                totalVisible: searchTerms.length,
                spend: +visibleSpend.toFixed(2),
                negativeCoveredSpend: +negativeCoveredSpend.toFixed(2),
                configuredSpend: +configuredSpend.toFixed(2),
                top: searchTerms.slice(0, topSearchTerms).map(compactSearchTerm)
            },
            configuredKeywordCoverage: {
                total: configuredKeywords.length,
                byStatus: countByField(configuredKeywords, 'status'),
                byMatchType: countByField(configuredKeywords, 'matchType'),
                samples: configuredKeywords.slice(0, 10).map((row: any) => ({
                    keyword: row.keyword,
                    matchType: row.matchType,
                    status: row.status,
                    primaryStatus: row.primaryStatus,
                    criterionId: row.criterionId
                }))
            },
            negativeCoverage: {
                totalRules: negativeRules.length,
                activeRules: activeNegativeRules.length,
                bySource: countByField(activeNegativeRules, 'source'),
                samples: activeNegativeRules.slice(0, 10).map((rule: any) => ({
                    source: rule.source,
                    keywordText: rule.keywordText || rule.keyword,
                    matchType: rule.matchType,
                    addedTo: rule.addedTo || rule.sourceName || null
                }))
            },
            qualityScores: qualitySummaryForAdGroup(compactAdGroup, rank),
            landingPages: landingPageSummaryForAdGroup(compactAdGroup, rank),
            auctionInsightsStatus: auctionStatusForAdGroup(compactAdGroup, rank),
            candidateSignals: signals.map(compactSignal),
            signalIds: signals.map((signal: any) => signal.signal_id).filter(Boolean)
        };
    });
    return {
        meta: {
            ...(overview.meta || {}),
            contextKind: 'proposal_context',
            enabledAdGroups: enabledAdGroups.length,
            returnedAdGroups: adGroups.length,
            topSearchTerms,
            topSignals
        },
        summary: overview.summary || {},
        sourceCoverage,
        leadAttribution: compactLeadAttribution(overview.leadAttribution || keywords.leadAttribution, 25),
        keywordPlanner: keywords.keywordPlanner ? { status: keywords.keywordPlanner.status } : null,
        decisionContext: compactDecisionContextFromPayloads({ overview, keywords, rank, candidateSignals }).decisionContext,
        adGroups
    };
}

export async function getProposalContext(pool: Pool, rawArgs: Record<string, any> = {}): Promise<any> {
    const filters = await resolveDashboardFilters(pool, rawArgs);
    const warehouseWatermark = await getWarehouseWatermark(pool, filters);
    const overview = await buildDashboardPayloadForView(pool, filters, 'overview', { filtersResolved: true, warehouseWatermark });
    const [keywords, rank, candidateSignals] = await Promise.all([
        buildDashboardPayloadForView(pool, filters, 'keywords', { filtersResolved: true, warehouseWatermark }),
        buildDashboardPayloadForView(pool, filters, 'rank', { filtersResolved: true, warehouseWatermark }),
        selectCandidateSignals(pool, filters, 500).then(rows => rows.map(candidateSignalPayload))
    ]);
    return buildProposalContextFromPayloads(filters, rawArgs, overview, keywords, rank, candidateSignals);
}
