import { Pool } from 'pg';
import { cpaBenchmarkForAccount } from './accountBenchmarks';
import { getCoverageForWindow, getWarehouseWatermark, selectCandidateSignals, type DashboardFilters } from './adsWarehouse';
import {
    buildDecisionContextSummary,
    configuredKeywordRuleFromReportRow,
    decisionContextForTerm,
    flattenDecisionContext,
    normalizeNegativeRulesFromReports
} from './decisionContext';
import { buildDashboardPayloadForView, resolveDashboardFilters } from './dashboardPayload';
import { getLeadAttributionSummary } from './leads';
import { plannerFields } from './plannerScoring';

const DEFAULT_CANDIDATE_SIGNAL_LIMIT = 250;
const DEFAULT_PROPOSAL_CONTEXT_AD_GROUP_LIMIT = 250;
const DEFAULT_PROPOSAL_CONTEXT_SEARCH_TERM_LIMIT = 2_000;
const DEFAULT_PROPOSAL_CONTEXT_PLANNER_ROW_LIMIT = 1_000;

function cleanText(value: any): string {
    return String(value ?? '').trim();
}

function numberValue(value: any): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
}

function nullableNumber(value: any): number | null {
    if (value === undefined || value === null || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function microsValue(value: any): number {
    return +(numberValue(value) / 1_000_000).toFixed(2);
}

function microsNullable(value: any): number | null {
    const numeric = nullableNumber(value);
    return numeric === null ? null : +(numeric / 1_000_000).toFixed(2);
}

function percentFromFraction(value: any): number | null {
    const numeric = nullableNumber(value);
    return numeric === null ? null : +(numeric * 100).toFixed(2);
}

function positiveIntegerEnv(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function proposalSearchTermLimit(): number {
    return positiveIntegerEnv('DASHBOARD_SEARCH_TERM_ROW_LIMIT', DEFAULT_PROPOSAL_CONTEXT_SEARCH_TERM_LIMIT);
}

function proposalPlannerRowLimit(): number {
    return positiveIntegerEnv('DASHBOARD_PLANNER_ROW_LIMIT', DEFAULT_PROPOSAL_CONTEXT_PLANNER_ROW_LIMIT);
}

function metricFields(row: any): any {
    const spend = microsValue(row?.cost_micros);
    const clicks = numberValue(row?.clicks);
    const impressions = numberValue(row?.impressions);
    const conversions = numberValue(row?.conversions);
    return {
        spend,
        clicks,
        impressions,
        conversions: +conversions.toFixed(2),
        allConversions: +numberValue(row?.all_conversions).toFixed(2),
        ctr: impressions ? +((clicks / impressions) * 100).toFixed(2) : 0,
        cvr: clicks ? +((conversions / clicks) * 100).toFixed(2) : 0,
        cpa: conversions ? +(spend / conversions).toFixed(2) : 0,
        avgCpc: clicks ? +(spend / clicks).toFixed(2) : 0,
        impressionShare: percentFromFraction(row?.search_impression_share),
        lostISBudget: percentFromFraction(row?.search_budget_lost_impression_share),
        lostISRank: percentFromFraction(row?.search_rank_lost_impression_share)
    };
}

function normalizeText(value: any): string {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .replace(/\s+/g, ' ');
}

function normKey(value: any): string {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function safeDiv(a: number, b: number): number {
    return b ? +(a / b).toFixed(2) : 0;
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
    const supportViewOptions = {
        filtersResolved: true,
        warehouseWatermark,
        liveAttach: { leadMode: 'none' as const, includeProposals: false, includeDiagnoses: false }
    };
    const [keywords, rank, candidateSignals] = await Promise.all([
        buildDashboardPayloadForView(pool, filters, 'keywords', supportViewOptions),
        buildDashboardPayloadForView(pool, filters, 'rank', supportViewOptions),
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

function isoDate(value: any): string | null {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    const text = String(value);
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : text;
}

function normalizeDbRows(rows: any[]): any[] {
    return rows.map(row => {
        const out: Record<string, any> = {};
        for (const [key, value] of Object.entries(row)) {
            if (value instanceof Date) {
                out[key] = key === 'date' || key.endsWith('_date') ? isoDate(value) : value.toISOString();
            } else {
                out[key] = value;
            }
        }
        return out;
    });
}

function sourceName(reportName: string): string {
    return reportName.replace(/_/g, '-');
}

function sourceCoverageFromRows(coverageRows: any[], snapshots: Record<string, number>): any {
    const sources = coverageRows.map(entry => {
        const status = entry.status === 'covered' ? 'ok' : entry.status === 'partial' ? 'failed' : entry.status;
        return {
            name: sourceName(entry.reportName),
            status,
            rows: entry.rowCount,
            generatedAt: entry.lastFetchedAt,
            ageHours: null,
            error: entry.error,
            message: entry.status === 'partial'
                ? `Partial coverage. Missing ${entry.missingDates?.length || 0}, failed ${entry.failedDates?.length || 0}.`
                : entry.error || null
        };
    });
    const seen = new Set(sources.map(source => source.name));
    for (const [name, rows] of Object.entries(snapshots)) {
        if (seen.has(name)) continue;
        sources.push({
            name,
            status: rows > 0 ? 'ok' : 'empty',
            rows,
            generatedAt: null,
            ageHours: null,
            error: null,
            message: null
        });
    }
    return {
        generatedAt: new Date().toISOString(),
        sources,
        missingSources: sources.filter(source => source.status === 'missing').map(source => source.name),
        staleSources: sources.filter(source => source.status === 'stale').map(source => source.name),
        failedSources: sources.filter(source => source.status === 'failed').map(source => source.name)
    };
}

async function selectLatestRefreshRun(pool: Pool, customerId: string): Promise<any | null> {
    const { rows } = await pool.query(
        `SELECT id, kind, status, customer_id, requested_start_date, requested_end_date,
                effective_start_date, effective_end_date, started_at, completed_at, source_summary, error
         FROM google_ads_refresh_runs
         WHERE customer_id = $1 OR customer_id IS NULL
         ORDER BY started_at DESC
         LIMIT 1`,
        [customerId]
    );
    return normalizeDbRows(rows)[0] || null;
}

function refreshRunReportsWithStatus(sourceSummary: any, status: string): string[] {
    return Array.from(new Set(Object.entries(sourceSummary || {})
        .filter(([, value]: [string, any]) => value?.status === status)
        .map(([name]) => sourceName(String(name)))));
}

function mergeRefreshRunIntoSourceCoverage(sourceCoverage: any, refreshRun: any): any | null {
    if (!refreshRun) return null;
    const sourceSummary = refreshRun.source_summary || {};
    const failedReports = Array.from(new Set([
        ...(Array.isArray(sourceSummary.failedReports) ? sourceSummary.failedReports : []),
        ...refreshRunReportsWithStatus(sourceSummary, 'failed')
    ].map(value => sourceName(String(value)))));
    const missingReports = refreshRunReportsWithStatus(sourceSummary, 'missing');
    sourceCoverage.failedSources = Array.from(new Set([...(sourceCoverage.failedSources || []), ...failedReports])).sort();
    sourceCoverage.missingSources = Array.from(new Set([...(sourceCoverage.missingSources || []), ...missingReports])).sort();
    sourceCoverage.refreshRun = refreshRun;
    return { failedReports, missingReports, sourceSummary };
}

function scopedFactClauses(filters: DashboardFilters, alias = 'src'): { clauses: string[]; params: any[] } {
    const prefix = alias ? `${alias}.` : '';
    const clauses = [`${prefix}customer_id = $1`, `${prefix}date BETWEEN $2::date AND $3::date`];
    const params: any[] = [filters.customerId, filters.startDate, filters.endDate];
    if (filters.campaignId) {
        params.push(filters.campaignId);
        clauses.push(`${prefix}campaign_id = $${params.length}`);
    }
    if (filters.adGroupId) {
        params.push(filters.adGroupId);
        clauses.push(`${prefix}ad_group_id = $${params.length}`);
    }
    return { clauses, params };
}

function snapshotScopeClausesFromFactParams(filters: DashboardFilters, alias = 's'): string[] {
    const prefix = alias ? `${alias}.` : '';
    const clauses: string[] = [];
    let index = 3;
    if (filters.campaignId) {
        index += 1;
        clauses.push(`${prefix}campaign_id = $${index}`);
    }
    if (filters.adGroupId) {
        index += 1;
        clauses.push(`${prefix}ad_group_id = $${index}`);
    }
    return clauses;
}

function adGroupIds(adGroups: any[]): string[] {
    return Array.from(new Set(adGroups.map(row => cleanText(row?.adGroupId || row?.id)).filter(Boolean)));
}

function adGroupIdFilterSql(params: any[], ids: string[], alias = ''): string {
    if (!ids.length) return '';
    const prefix = alias ? `${alias}.` : '';
    params.push(ids);
    return ` AND ${prefix}ad_group_id = ANY($${params.length}::text[])`;
}

const aggregateMetricWithAllConversionsSql = `
    SUM(src.cost_micros)::bigint AS cost_micros,
    SUM(src.clicks)::bigint AS clicks,
    SUM(src.impressions)::bigint AS impressions,
    SUM(src.conversions) AS conversions,
    SUM(COALESCE(src.all_conversions, 0)) AS all_conversions
`;

const aggregateMetricWithoutAllConversionsSql = `
    SUM(src.cost_micros)::bigint AS cost_micros,
    SUM(src.clicks)::bigint AS clicks,
    SUM(src.impressions)::bigint AS impressions,
    SUM(src.conversions) AS conversions,
    0::numeric AS all_conversions
`;

const weightedImpressionShareSql = `
    CASE WHEN SUM(src.impressions) > 0
        THEN SUM(COALESCE(src.search_impression_share, 0) * src.impressions)
            / NULLIF(SUM(CASE WHEN src.search_impression_share IS NULL THEN 0 ELSE src.impressions END), 0)
        ELSE NULL
    END AS search_impression_share
`;

function plannerMetric(row: any): any {
    const raw = row.raw_payload || row;
    const monthlySearchVolumes = raw.monthlySearchVolumes ?? row.monthly_search_volumes ?? [];
    return {
        keyword: row.keyword || raw.keyword,
        text: row.keyword || raw.keyword,
        source: raw.source || (row.seed_type !== undefined ? 'idea' : 'historical'),
        seedType: raw.seedType ?? row.seed_type ?? null,
        seedKeywords: raw.seedKeywords ?? row.seed_keywords ?? [],
        seedUrl: raw.seedUrl ?? row.seed_url ?? null,
        seedSite: raw.seedSite ?? row.seed_site ?? null,
        closeVariants: raw.closeVariants ?? row.close_variants ?? [],
        avgMonthlySearches: raw.avgMonthlySearches ?? row.avg_monthly_searches,
        competition: raw.competition ?? row.competition,
        competitionIndex: raw.competitionIndex ?? row.competition_index,
        lowBidMicros: raw.lowBidMicros ?? row.low_bid_micros,
        highBidMicros: raw.highBidMicros ?? row.high_bid_micros,
        lowBid: raw.lowBid ?? microsNullable(row.low_bid_micros),
        highBid: raw.highBid ?? microsNullable(row.high_bid_micros),
        geoTargetConstants: raw.geoTargetConstants ?? row.geo_target_constants ?? [],
        language: raw.language ?? row.language ?? null,
        keywordPlanNetwork: raw.keywordPlanNetwork ?? row.keyword_plan_network ?? null,
        monthlySearchVolumes: Array.isArray(monthlySearchVolumes) ? monthlySearchVolumes : []
    };
}

function plannerMap(rows: any[]): Map<string, any> {
    const map = new Map<string, any>();
    for (const row of rows) {
        const key = normKey(row.keyword);
        if (!key) continue;
        const existing = map.get(key);
        if (!existing || numberValue(row.avgMonthlySearches || row.avg_monthly_searches) > numberValue(existing.avgMonthlySearches || existing.avg_monthly_searches)) {
            map.set(key, row);
        }
        const closeVariants = Array.isArray(row.closeVariants || row.close_variants) ? (row.closeVariants || row.close_variants) : [];
        for (const variant of closeVariants) {
            const variantKey = normKey(variant);
            if (variantKey && !map.has(variantKey)) map.set(variantKey, row);
        }
    }
    return map;
}

function plannerDisplayFields(text: string, metric: any, perf: any, referenceCpa: number): any {
    const { monthlySearchVolumes: _monthlySearchVolumes, ...fields } = plannerFields(text, metric, perf, referenceCpa);
    return fields;
}

function compactPlannerMetric(metric: any): any {
    return {
        keyword: metric.keyword,
        text: metric.text,
        source: metric.source,
        seedType: metric.seedType,
        avgMonthlySearches: metric.avgMonthlySearches,
        competition: metric.competition,
        competitionIndex: metric.competitionIndex,
        lowBid: metric.lowBid,
        highBid: metric.highBid
    };
}

function getCampaignCategory(name: string): 'competitor' | 'generic' {
    const lower = String(name || '').toLowerCase();
    return lower.includes('comp') || lower.includes('competitor') ? 'competitor' : 'generic';
}

function historicalCpaBenchmarks(campaigns: any[], summary: any): Record<string, number> {
    const fallback = cpaBenchmarkForAccount(summary.cpa, summary.currency);
    const catStats = {
        competitor: { spend: 0, conv: 0 },
        generic: { spend: 0, conv: 0 }
    };
    for (const campaign of campaigns) {
        const category = getCampaignCategory(campaign.name || campaign.campaign);
        catStats[category].spend += numberValue(campaign.spend);
        catStats[category].conv += numberValue(campaign.conversions);
    }
    return {
        competitor: catStats.competitor.conv > 0 ? safeDiv(catStats.competitor.spend, catStats.competitor.conv) : fallback,
        generic: catStats.generic.conv > 0 ? safeDiv(catStats.generic.spend, catStats.generic.conv) : fallback
    };
}

async function selectProposalSummary(pool: Pool, filters: DashboardFilters): Promise<any> {
    const table = filters.adGroupId
        ? 'google_ads_ad_group_daily'
        : filters.campaignId
            ? 'google_ads_campaign_daily'
            : 'google_ads_account_daily';
    const { clauses, params } = scopedFactClauses(filters);
    const aggregateSql = table === 'google_ads_account_daily'
        ? aggregateMetricWithAllConversionsSql
        : `${aggregateMetricWithAllConversionsSql}, ${weightedImpressionShareSql}`;
    const conversionsValueSql = table === 'google_ads_ad_group_daily'
        ? '0::numeric'
        : 'SUM(COALESCE(src.conversions_value, 0))';
    const currencySql = table === 'google_ads_account_daily'
        ? 'MAX(src.currency_code)'
        : `COALESCE((
            SELECT MAX(acct.currency_code)
            FROM google_ads_account_daily acct
            WHERE acct.customer_id = $1
              AND acct.date BETWEEN $2::date AND $3::date
        ), 'INR')`;
    const extraSelect = table === 'google_ads_campaign_daily'
        ? `,
            CASE WHEN SUM(src.impressions) > 0
                THEN SUM(COALESCE(src.search_budget_lost_impression_share, 0) * src.impressions)
                    / NULLIF(SUM(CASE WHEN src.search_budget_lost_impression_share IS NULL THEN 0 ELSE src.impressions END), 0)
                ELSE NULL
            END AS search_budget_lost_impression_share,
            CASE WHEN SUM(src.impressions) > 0
                THEN SUM(COALESCE(src.search_rank_lost_impression_share, 0) * src.impressions)
                    / NULLIF(SUM(CASE WHEN src.search_rank_lost_impression_share IS NULL THEN 0 ELSE src.impressions END), 0)
                ELSE NULL
            END AS search_rank_lost_impression_share`
        : '';
    const { rows } = await pool.query(
        `SELECT
            ${aggregateSql},
            ${conversionsValueSql} AS conversions_value,
            ${currencySql} AS currency_code
            ${extraSelect}
         FROM ${table} src
         WHERE ${clauses.join(' AND ')}`,
        params
    );
    const row = rows[0] || {};
    return {
        ...metricFields(row),
        conversionsValue: +numberValue(row.conversions_value).toFixed(2),
        currency: cleanText(row.currency_code) || 'INR'
    };
}

async function selectProposalCampaigns(pool: Pool, filters: DashboardFilters): Promise<any[]> {
    const campaignFilters = { ...filters, adGroupId: null };
    const { clauses, params } = scopedFactClauses(campaignFilters, 'src');
    const snapshotClauses = [
        's.customer_id = $1',
        's.present_in_latest_snapshot = true',
        ...snapshotScopeClausesFromFactParams(campaignFilters, 's')
    ];
    const { rows } = await pool.query(
        `WITH perf AS (
            SELECT
                src.campaign_id,
                MAX(src.campaign_name) AS campaign_name,
                MAX(src.campaign_status) AS campaign_status,
                MAX(src.bidding_strategy_type) AS bidding_strategy_type,
                MAX(src.campaign_budget_resource_name) AS campaign_budget_resource_name,
                MAX(src.budget_amount_micros) AS budget_amount_micros,
                MAX(src.target_cpa_micros) AS target_cpa_micros,
                MAX(src.target_roas) AS target_roas,
                ${aggregateMetricWithAllConversionsSql},
                ${weightedImpressionShareSql},
                CASE WHEN SUM(src.impressions) > 0
                    THEN SUM(COALESCE(src.search_budget_lost_impression_share, 0) * src.impressions)
                        / NULLIF(SUM(CASE WHEN src.search_budget_lost_impression_share IS NULL THEN 0 ELSE src.impressions END), 0)
                    ELSE NULL
                END AS search_budget_lost_impression_share,
                CASE WHEN SUM(src.impressions) > 0
                    THEN SUM(COALESCE(src.search_rank_lost_impression_share, 0) * src.impressions)
                        / NULLIF(SUM(CASE WHEN src.search_rank_lost_impression_share IS NULL THEN 0 ELSE src.impressions END), 0)
                    ELSE NULL
                END AS search_rank_lost_impression_share
            FROM google_ads_campaign_daily src
            WHERE ${clauses.join(' AND ')}
            GROUP BY src.campaign_id
        ), snapshot AS (
            SELECT *
            FROM google_ads_campaign_snapshot s
            WHERE ${snapshotClauses.join(' AND ')}
        )
        SELECT
            COALESCE(s.campaign_id, p.campaign_id) AS campaign_id,
            COALESCE(s.campaign_name, p.campaign_name, s.campaign_id, p.campaign_id) AS campaign_name,
            COALESCE(s.campaign_status, p.campaign_status) AS campaign_status,
            COALESCE(s.bidding_strategy_type, p.bidding_strategy_type) AS bidding_strategy_type,
            COALESCE(s.campaign_budget_resource_name, p.campaign_budget_resource_name) AS campaign_budget_resource_name,
            COALESCE(s.budget_amount_micros, p.budget_amount_micros) AS budget_amount_micros,
            COALESCE(s.target_cpa_micros, p.target_cpa_micros) AS target_cpa_micros,
            COALESCE(s.target_roas, p.target_roas) AS target_roas,
            COALESCE(p.cost_micros, 0) AS cost_micros,
            COALESCE(p.clicks, 0) AS clicks,
            COALESCE(p.impressions, 0) AS impressions,
            COALESCE(p.conversions, 0) AS conversions,
            COALESCE(p.all_conversions, 0) AS all_conversions,
            p.search_impression_share,
            p.search_budget_lost_impression_share,
            p.search_rank_lost_impression_share
        FROM snapshot s
        FULL OUTER JOIN perf p ON p.campaign_id = s.campaign_id
        WHERE COALESCE(s.campaign_id, p.campaign_id) IS NOT NULL
        ORDER BY COALESCE(p.cost_micros, 0) DESC, COALESCE(s.campaign_name, p.campaign_name) ASC NULLS LAST`,
        params
    );
    return normalizeDbRows(rows).map(row => ({
        id: row.campaign_id,
        name: row.campaign_name || row.campaign_id,
        status: row.campaign_status || null,
        campaignId: row.campaign_id,
        campaign: row.campaign_name || row.campaign_id,
        biddingStrategy: row.bidding_strategy_type || null,
        budgetResourceName: row.campaign_budget_resource_name || null,
        targetCpa: microsNullable(row.target_cpa_micros),
        targetRoas: nullableNumber(row.target_roas),
        budget: microsNullable(row.budget_amount_micros),
        ...metricFields(row)
    }));
}

async function selectProposalAdGroups(pool: Pool, filters: DashboardFilters, maxAdGroups: number): Promise<{ adGroups: any[]; enabledCount: number }> {
    const { clauses, params } = scopedFactClauses(filters, 'src');
    const snapshotClauses = [
        's.customer_id = $1',
        's.present_in_latest_snapshot = true',
        ...snapshotScopeClausesFromFactParams(filters, 's')
    ];
    const limitSql = maxAdGroups > 0 ? ` LIMIT $${params.push(maxAdGroups)}` : '';
    const { rows } = await pool.query(
        `WITH perf AS (
            SELECT
                src.campaign_id,
                MAX(src.campaign_name) AS campaign_name,
                src.ad_group_id,
                MAX(src.ad_group_name) AS ad_group_name,
                MAX(src.ad_group_status) AS ad_group_status,
                ${aggregateMetricWithAllConversionsSql},
                ${weightedImpressionShareSql}
            FROM google_ads_ad_group_daily src
            WHERE ${clauses.join(' AND ')}
            GROUP BY src.campaign_id, src.ad_group_id
        ), snapshot AS (
            SELECT *
            FROM google_ads_ad_group_snapshot s
            WHERE ${snapshotClauses.join(' AND ')}
        ), source_ad_groups AS (
            SELECT
                COALESCE(s.campaign_id, p.campaign_id) AS campaign_id,
                COALESCE(s.campaign_name, p.campaign_name, s.campaign_id, p.campaign_id) AS campaign_name,
                COALESCE(s.ad_group_id, p.ad_group_id) AS ad_group_id,
                COALESCE(s.ad_group_name, p.ad_group_name, s.ad_group_id, p.ad_group_id) AS ad_group_name,
                COALESCE(s.ad_group_status, p.ad_group_status) AS ad_group_status,
                COALESCE(p.cost_micros, 0) AS cost_micros,
                COALESCE(p.clicks, 0) AS clicks,
                COALESCE(p.impressions, 0) AS impressions,
                COALESCE(p.conversions, 0) AS conversions,
                COALESCE(p.all_conversions, 0) AS all_conversions,
                p.search_impression_share
            FROM snapshot s
            FULL OUTER JOIN perf p
                ON p.campaign_id = s.campaign_id
               AND p.ad_group_id = s.ad_group_id
            WHERE COALESCE(s.campaign_id, p.campaign_id) IS NOT NULL
              AND COALESCE(s.ad_group_id, p.ad_group_id) IS NOT NULL
              AND UPPER(COALESCE(s.ad_group_status, p.ad_group_status, 'ENABLED')) = 'ENABLED'
        )
        SELECT
            COUNT(*) OVER()::int AS enabled_count,
            sg.campaign_id,
            sg.campaign_name,
            sg.ad_group_id,
            sg.ad_group_name,
            sg.ad_group_status,
            cs.bidding_strategy_type,
            cs.campaign_budget_resource_name,
            cs.budget_amount_micros,
            cs.target_cpa_micros,
            cs.target_roas,
            sg.cost_micros,
            sg.clicks,
            sg.impressions,
            sg.conversions,
            sg.all_conversions,
            sg.search_impression_share
        FROM source_ad_groups sg
        LEFT JOIN google_ads_campaign_snapshot cs
            ON cs.customer_id = $1
           AND cs.campaign_id = sg.campaign_id
           AND cs.present_in_latest_snapshot = true
        ORDER BY sg.cost_micros DESC, sg.campaign_name ASC NULLS LAST, sg.ad_group_name ASC NULLS LAST${limitSql}`,
        params
    );
    const normalized = normalizeDbRows(rows);
    return {
        enabledCount: numberValue(normalized[0]?.enabled_count),
        adGroups: normalized.map(row => ({
            id: row.ad_group_id,
            name: row.ad_group_name || row.ad_group_id,
            status: row.ad_group_status || null,
            campaignId: row.campaign_id,
            campaign: row.campaign_name || row.campaign_id,
            adGroupId: row.ad_group_id,
            adGroup: row.ad_group_name || row.ad_group_id,
            biddingStrategy: row.bidding_strategy_type || null,
            budgetResourceName: row.campaign_budget_resource_name || null,
            targetCpa: microsNullable(row.target_cpa_micros),
            targetRoas: nullableNumber(row.target_roas),
            budget: microsNullable(row.budget_amount_micros),
            ...metricFields(row)
        }))
    };
}

function rawConfiguredKeywordRow(row: any): any {
    return {
        ...(row.raw_payload || {}),
        'campaign.id': row.campaign_id,
        'campaign.name': row.campaign_name,
        'ad_group.id': row.ad_group_id,
        'ad_group.name': row.ad_group_name,
        'ad_group_criterion.criterion_id': row.criterion_id,
        'ad_group_criterion.resource_name': row.criterion_resource_name,
        'ad_group_criterion.keyword.text': row.keyword_text,
        'ad_group_criterion.keyword.match_type': row.match_type,
        'ad_group_criterion.status': row.status,
        'ad_group_criterion.primary_status': row.primary_status
    };
}

function rawNegativeRows(rows: any[], kind: 'campaign' | 'ad_group' | 'account' | 'shared_set' | 'shared_criterion' | 'campaign_shared_set'): any[] {
    return rows.map(row => {
        const payload = row.raw_payload || {};
        if (kind === 'campaign') {
            return {
                ...payload,
                'campaign.id': row.campaign_id,
                'campaign.name': row.campaign_name,
                'campaign_criterion.keyword.text': row.keyword_text,
                'campaign_criterion.keyword.match_type': row.match_type,
                'campaign_criterion.status': row.status
            };
        }
        if (kind === 'ad_group') {
            return {
                ...payload,
                'campaign.id': row.campaign_id,
                'campaign.name': row.campaign_name,
                'ad_group.id': row.ad_group_id,
                'ad_group.name': row.ad_group_name,
                'ad_group_criterion.keyword.text': row.keyword_text,
                'ad_group_criterion.keyword.match_type': row.match_type,
                'ad_group_criterion.status': row.status
            };
        }
        if (kind === 'account') {
            return {
                ...payload,
                'customer.id': row.customer_id,
                'customer_negative_criterion.negative_keyword_list.shared_set': row.shared_set_resource_name
            };
        }
        if (kind === 'shared_set') {
            return {
                ...payload,
                'shared_set.id': row.shared_set_id,
                'shared_set.resource_name': row.shared_set_resource_name,
                'shared_set.name': row.shared_set_name,
                'shared_set.status': row.shared_set_status
            };
        }
        if (kind === 'shared_criterion') {
            return {
                ...payload,
                'shared_criterion.shared_set': row.shared_set_resource_name,
                'shared_criterion.criterion_id': row.criterion_id,
                'shared_criterion.keyword.text': row.keyword_text,
                'shared_criterion.keyword.match_type': row.match_type
            };
        }
        return {
            ...payload,
            'campaign.id': row.campaign_id,
            'campaign.name': row.campaign_name,
            'campaign_shared_set.shared_set': row.shared_set_resource_name,
            'campaign_shared_set.status': row.status
        };
    });
}

async function selectConfiguredKeywords(pool: Pool, filters: DashboardFilters, ids: string[]): Promise<any[]> {
    if (!ids.length) return [];
    const params: any[] = [filters.customerId];
    const clauses = ['customer_id = $1', 'present_in_latest_snapshot = true'];
    if (filters.campaignId) {
        params.push(filters.campaignId);
        clauses.push(`campaign_id = $${params.length}`);
    }
    if (filters.adGroupId) {
        params.push(filters.adGroupId);
        clauses.push(`ad_group_id = $${params.length}`);
    } else {
        clauses.push(adGroupIdFilterSql(params, ids).replace(/^ AND /, ''));
    }
    const { rows } = await pool.query(
        `SELECT *
         FROM google_ads_configured_keywords
         WHERE ${clauses.join(' AND ')}
         ORDER BY keyword_text ASC`,
        params
    );
    return normalizeDbRows(rows);
}

async function selectQualityRows(pool: Pool, filters: DashboardFilters, ids: string[]): Promise<any[]> {
    if (!ids.length) return [];
    const params: any[] = [filters.customerId];
    const clauses = ['customer_id = $1', 'present_in_latest_snapshot = true'];
    if (filters.campaignId) {
        params.push(filters.campaignId);
        clauses.push(`campaign_id = $${params.length}`);
    }
    if (filters.adGroupId) {
        params.push(filters.adGroupId);
        clauses.push(`ad_group_id = $${params.length}`);
    } else {
        clauses.push(adGroupIdFilterSql(params, ids).replace(/^ AND /, ''));
    }
    const { rows } = await pool.query(
        `SELECT *
         FROM google_ads_quality_score_snapshot
         WHERE ${clauses.join(' AND ')}
         ORDER BY keyword_text ASC NULLS LAST
         LIMIT 2000`,
        params
    );
    return normalizeDbRows(rows).map(row => ({
        campaignId: row.campaign_id,
        campaign: row.campaign_name || row.campaign_id,
        adGroupId: row.ad_group_id,
        adGroup: row.ad_group_name || row.ad_group_id,
        criterionId: row.criterion_id,
        keyword: row.keyword_text,
        matchType: row.match_type,
        status: row.status,
        qualityScore: row.quality_score || 0,
        adRelevance: row.creative_quality_score || 'UNSPECIFIED',
        landingPageExperience: row.post_click_quality_score || 'UNSPECIFIED',
        expectedCtr: row.search_predicted_ctr || 'UNSPECIFIED'
    }));
}

async function selectNegativeRuleData(pool: Pool, filters: DashboardFilters): Promise<{ rules: any[]; sourceCounts: Record<string, number> }> {
    const scopedParams: any[] = [filters.customerId];
    const campaignScoped = ['customer_id = $1', 'present_in_latest_snapshot = true'];
    if (filters.campaignId) {
        scopedParams.push(filters.campaignId);
        campaignScoped.push(`campaign_id = $${scopedParams.length}`);
    }
    const adGroupParams = [...scopedParams];
    const adGroupScoped = [...campaignScoped];
    if (filters.adGroupId) {
        adGroupParams.push(filters.adGroupId);
        adGroupScoped.push(`ad_group_id = $${adGroupParams.length}`);
    }
    const [
        campaignNegatives,
        adGroupNegatives,
        accountNegativeLists,
        sharedNegativeSets,
        sharedNegativeCriteria,
        campaignSharedSets
    ] = await Promise.all([
        pool.query(`SELECT * FROM google_ads_campaign_negatives WHERE ${campaignScoped.join(' AND ')}`, scopedParams),
        pool.query(`SELECT * FROM google_ads_ad_group_negatives WHERE ${adGroupScoped.join(' AND ')}`, adGroupParams),
        pool.query(`SELECT * FROM google_ads_account_negative_lists WHERE customer_id = $1 AND present_in_latest_snapshot = true`, [filters.customerId]),
        pool.query(`SELECT * FROM google_ads_shared_negative_sets WHERE customer_id = $1 AND present_in_latest_snapshot = true`, [filters.customerId]),
        pool.query(`SELECT * FROM google_ads_shared_negative_criteria WHERE customer_id = $1 AND present_in_latest_snapshot = true`, [filters.customerId]),
        pool.query(`SELECT * FROM google_ads_campaign_shared_sets WHERE ${campaignScoped.join(' AND ')}`, scopedParams)
    ]);
    const campaignNegativeRows = normalizeDbRows(campaignNegatives.rows);
    const adGroupNegativeRows = normalizeDbRows(adGroupNegatives.rows);
    const accountNegativeListRows = normalizeDbRows(accountNegativeLists.rows);
    const sharedNegativeSetRows = normalizeDbRows(sharedNegativeSets.rows);
    const sharedNegativeCriterionRows = normalizeDbRows(sharedNegativeCriteria.rows);
    const campaignSharedSetRows = normalizeDbRows(campaignSharedSets.rows);
    return {
        rules: normalizeNegativeRulesFromReports({
            customerId: filters.customerId,
            campaignNegatives: rawNegativeRows(campaignNegativeRows, 'campaign'),
            adGroupNegatives: rawNegativeRows(adGroupNegativeRows, 'ad_group'),
            accountNegatives: rawNegativeRows(accountNegativeListRows, 'account'),
            sharedNegativeSets: rawNegativeRows(sharedNegativeSetRows, 'shared_set'),
            sharedNegativeCriteria: rawNegativeRows(sharedNegativeCriterionRows, 'shared_criterion'),
            campaignSharedSets: rawNegativeRows(campaignSharedSetRows, 'campaign_shared_set')
        }),
        sourceCounts: {
            campaignNegatives: campaignNegativeRows.length,
            adGroupNegatives: adGroupNegativeRows.length,
            accountNegatives: accountNegativeListRows.length,
            sharedNegativeSets: sharedNegativeSetRows.length,
            sharedNegativeCriteria: sharedNegativeCriterionRows.length,
            campaignSharedSets: campaignSharedSetRows.length
        }
    };
}

async function selectPlannerRows(pool: Pool, filters: DashboardFilters): Promise<{ ideas: any[]; historicalMetrics: any[] }> {
    const limit = proposalPlannerRowLimit();
    const limitSql = limit > 0 ? ' LIMIT $2' : '';
    const params = limit > 0 ? [filters.customerId, limit] : [filters.customerId];
    const [ideas, historical] = await Promise.all([
        pool.query(
            `SELECT *
             FROM google_ads_keyword_planner_ideas
             WHERE customer_id = $1
             ORDER BY avg_monthly_searches DESC NULLS LAST, keyword ASC${limitSql}`,
            params
        ),
        pool.query(
            `SELECT *
             FROM google_ads_keyword_planner_historical
             WHERE customer_id = $1
             ORDER BY avg_monthly_searches DESC NULLS LAST, keyword ASC${limitSql}`,
            params
        )
    ]);
    return {
        ideas: normalizeDbRows(ideas.rows).map(plannerMetric),
        historicalMetrics: normalizeDbRows(historical.rows).map(plannerMetric)
    };
}

async function selectSegmentRows(
    pool: Pool,
    filters: DashboardFilters,
    table: string,
    segmentSelect: string,
    groupBy: string,
    orderBy: string,
    includeConversionsValue = true
): Promise<any[]> {
    const { clauses, params } = scopedFactClauses(filters, 'src');
    const conversionsValueSql = includeConversionsValue
        ? 'SUM(COALESCE(src.conversions_value, 0)) AS conversions_value'
        : '0::numeric AS conversions_value';
    const { rows } = await pool.query(
        `SELECT
            src.customer_id,
            MAX(src.date)::text AS date,
            MAX(src.campaign_id) AS campaign_id,
            MAX(src.campaign_name) AS campaign_name,
            MAX(src.ad_group_id) AS ad_group_id,
            MAX(src.ad_group_name) AS ad_group_name,
            ${segmentSelect},
            ${aggregateMetricWithoutAllConversionsSql},
            ${conversionsValueSql}
         FROM ${table} src
         WHERE ${clauses.join(' AND ')}
         GROUP BY src.customer_id, ${groupBy}
         ORDER BY ${orderBy}`,
        params
    );
    return normalizeDbRows(rows).map(row => ({
        date: row.date,
        campaignId: row.campaign_id,
        campaign: row.campaign_name || row.campaign_id,
        adGroupId: row.ad_group_id,
        adGroup: row.ad_group_name || row.ad_group_id,
        device: row.device,
        day: row.day_of_week,
        hour: row.hour,
        conversionsValue: +numberValue(row.conversions_value).toFixed(2),
        ...metricFields(row)
    }));
}

async function selectProposalSegments(pool: Pool, filters: DashboardFilters): Promise<{ device: any[]; dayOfWeek: any[]; dayAndHour: any[] }> {
    const [device, dayOfWeek, dayAndHour] = await Promise.all([
        selectSegmentRows(
            pool,
            filters,
            'google_ads_device_daily',
            'src.device',
            'src.device',
            'SUM(src.cost_micros) DESC, src.device ASC'
        ),
        selectSegmentRows(
            pool,
            filters,
            'google_ads_day_of_week_daily',
            'src.day_of_week',
            'src.day_of_week',
            'SUM(src.cost_micros) DESC, src.day_of_week ASC'
        ),
        selectSegmentRows(
            pool,
            filters,
            'google_ads_day_hour_daily',
            'src.day_of_week, src.hour',
            'src.day_of_week, src.hour',
            'SUM(src.cost_micros) DESC, src.day_of_week ASC, src.hour ASC',
            false
        )
    ]);
    return { device, dayOfWeek, dayAndHour };
}

async function selectAuctionInsightRowCount(pool: Pool, filters: DashboardFilters): Promise<number> {
    const clauses = ['customer_id = $1', 'auction_date BETWEEN $2::date AND $3::date'];
    const params: any[] = [filters.customerId, filters.startDate, filters.endDate];
    if (filters.adGroupId) {
        params.push(filters.adGroupId);
        clauses.push(`source_scope = 'ad_group'`);
        clauses.push(`(entity_id = $${params.length} OR ad_group_id = $${params.length})`);
    } else if (filters.campaignId) {
        params.push(filters.campaignId);
        clauses.push(`source_scope = 'campaign'`);
        clauses.push(`(entity_id = $${params.length} OR campaign_id = $${params.length})`);
    } else {
        clauses.push(`source_scope = 'account'`);
    }
    const { rows } = await pool.query(
        `SELECT COUNT(DISTINCT LOWER(domain))::int AS rows
         FROM google_ads_auction_insights_rows
         WHERE ${clauses.join(' AND ')}`,
        params
    );
    return numberValue(rows[0]?.rows);
}

function decisionFieldsForTerm(term: string, filters: DashboardFilters, row: any, negativeRules: any[], configuredKeywords: any[]): Record<string, any> {
    return flattenDecisionContext(decisionContextForTerm(
        term,
        {
            customerId: filters.customerId,
            campaignId: cleanText(row.campaignId || row.campaign_id),
            campaignName: cleanText(row.campaign || row.campaign_name),
            adGroupId: cleanText(row.adGroupId || row.ad_group_id),
            adGroupName: cleanText(row.adGroup || row.ad_group_name)
        },
        negativeRules,
        configuredKeywords
    ));
}

async function selectSearchTermsForAdGroups(
    pool: Pool,
    filters: DashboardFilters,
    ids: string[],
    searchTermLimit: number,
    perAdGroupLimit: number,
    negativeRules: any[],
    configuredKeywords: any[],
    plannerByKeyword: Map<string, any>,
    referenceCpa: number
): Promise<any[]> {
    if (!ids.length) return [];
    const { clauses, params } = scopedFactClauses(filters, 'src');
    if (!filters.adGroupId) clauses.push(adGroupIdFilterSql(params, ids, 'src').replace(/^ AND /, ''));
    const perAdGroupLimitSql = ` WHERE rn <= $${params.push(perAdGroupLimit)}`;
    const limitSql = searchTermLimit > 0 ? ` LIMIT $${params.push(searchTermLimit)}` : '';
    const { rows } = await pool.query(
        `WITH grouped AS (
            SELECT
                src.customer_id,
                src.campaign_id,
                MAX(src.campaign_name) AS campaign_name,
                src.ad_group_id,
                MAX(src.ad_group_name) AS ad_group_name,
                LOWER(src.search_term) AS search_term_key,
                MAX(src.search_term) AS search_term,
                MAX(src.search_term_status) AS search_term_status,
                MAX(src.matched_keyword_text) AS matched_keyword_text,
                MAX(src.matched_keyword_match_type) AS matched_keyword_match_type,
                MAX(src.search_term_match_type) AS search_term_match_type,
                MAX(src.search_term_match_source) AS search_term_match_source,
                ${aggregateMetricWithAllConversionsSql}
            FROM google_ads_search_term_daily src
            WHERE ${clauses.join(' AND ')}
            GROUP BY src.customer_id, src.campaign_id, src.ad_group_id, LOWER(src.search_term)
        ), ranked AS (
            SELECT
                grouped.*,
                COUNT(*) OVER(PARTITION BY campaign_id, ad_group_id)::int AS total_visible,
                SUM(cost_micros) OVER(PARTITION BY campaign_id, ad_group_id)::bigint AS total_cost_micros,
                ROW_NUMBER() OVER(PARTITION BY campaign_id, ad_group_id ORDER BY cost_micros DESC, clicks DESC, search_term ASC) AS rn
            FROM grouped
        )
        SELECT *
        FROM ranked
        ${perAdGroupLimitSql}
        ORDER BY rn ASC, cost_micros DESC, clicks DESC, search_term ASC${limitSql}`,
        params
    );
    return normalizeDbRows(rows).map(row => {
        const base = {
            campaignId: row.campaign_id,
            campaign: row.campaign_name || row.campaign_id,
            adGroupId: row.ad_group_id,
            adGroup: row.ad_group_name || row.ad_group_id,
            searchTerm: row.search_term,
            status: row.search_term_status || null,
            matchedKeyword: row.matched_keyword_text || null,
            keywordMatchType: row.matched_keyword_match_type || null,
            searchTermMatchType: row.search_term_match_type || null,
            searchTermMatchSource: row.search_term_match_source || null,
            totalVisible: numberValue(row.total_visible),
            totalCostMicros: numberValue(row.total_cost_micros),
            ...metricFields(row)
        };
        const metric = plannerByKeyword.get(normKey(base.searchTerm));
        return {
            ...base,
            ...plannerDisplayFields(base.searchTerm, metric, base, referenceCpa),
            ...decisionFieldsForTerm(base.searchTerm, filters, base, negativeRules, configuredKeywords)
        };
    });
}

async function selectLandingPageRows(pool: Pool, filters: DashboardFilters, ids: string[]): Promise<any[]> {
    if (!ids.length) return [];
    const { clauses, params } = scopedFactClauses(filters, 'src');
    if (!filters.adGroupId) clauses.push(adGroupIdFilterSql(params, ids, 'src').replace(/^ AND /, ''));
    const queryParams = [...params, ...params];
    const secondOffset = params.length;
    const secondClauses = clauses.map(clause => clause.replace(/\$(\d+)/g, (_match, index) => `$${Number(index) + secondOffset}`));
    const { rows } = await pool.query(
        `WITH landing AS (
            SELECT
                'landing' AS page_source,
                src.campaign_id,
                MAX(src.campaign_name) AS campaign_name,
                src.ad_group_id,
                MAX(src.ad_group_name) AS ad_group_name,
                src.url_hash,
                MAX(src.unexpanded_final_url) AS final_url,
                ${aggregateMetricWithoutAllConversionsSql},
                CASE WHEN SUM(src.clicks) > 0
                    THEN SUM(COALESCE(src.mobile_friendly_clicks_percentage, 0) * src.clicks)
                        / NULLIF(SUM(CASE WHEN src.mobile_friendly_clicks_percentage IS NULL THEN 0 ELSE src.clicks END), 0)
                    ELSE NULL
                END AS mobile_friendly_clicks_percentage,
                CASE WHEN SUM(src.clicks) > 0
                    THEN SUM(COALESCE(src.valid_amp_clicks_percentage, 0) * src.clicks)
                        / NULLIF(SUM(CASE WHEN src.valid_amp_clicks_percentage IS NULL THEN 0 ELSE src.clicks END), 0)
                    ELSE NULL
                END AS valid_amp_clicks_percentage,
                CASE WHEN SUM(src.clicks) > 0
                    THEN SUM(COALESCE(src.speed_score, 0) * src.clicks)
                        / NULLIF(SUM(CASE WHEN src.speed_score IS NULL THEN 0 ELSE src.clicks END), 0)
                    ELSE NULL
                END AS speed_score
            FROM google_ads_landing_page_daily src
            WHERE ${clauses.join(' AND ')}
            GROUP BY src.campaign_id, src.ad_group_id, src.url_hash
            UNION ALL
            SELECT
                'expanded_landing' AS page_source,
                src.campaign_id,
                MAX(src.campaign_name) AS campaign_name,
                src.ad_group_id,
                MAX(src.ad_group_name) AS ad_group_name,
                src.url_hash,
                MAX(src.expanded_final_url) AS final_url,
                ${aggregateMetricWithoutAllConversionsSql},
                CASE WHEN SUM(src.clicks) > 0
                    THEN SUM(COALESCE(src.mobile_friendly_clicks_percentage, 0) * src.clicks)
                        / NULLIF(SUM(CASE WHEN src.mobile_friendly_clicks_percentage IS NULL THEN 0 ELSE src.clicks END), 0)
                    ELSE NULL
                END AS mobile_friendly_clicks_percentage,
                CASE WHEN SUM(src.clicks) > 0
                    THEN SUM(COALESCE(src.valid_amp_clicks_percentage, 0) * src.clicks)
                        / NULLIF(SUM(CASE WHEN src.valid_amp_clicks_percentage IS NULL THEN 0 ELSE src.clicks END), 0)
                    ELSE NULL
                END AS valid_amp_clicks_percentage,
                CASE WHEN SUM(src.clicks) > 0
                    THEN SUM(COALESCE(src.speed_score, 0) * src.clicks)
                        / NULLIF(SUM(CASE WHEN src.speed_score IS NULL THEN 0 ELSE src.clicks END), 0)
                    ELSE NULL
                END AS speed_score
            FROM google_ads_expanded_landing_page_daily src
            WHERE ${secondClauses.join(' AND ')}
            GROUP BY src.campaign_id, src.ad_group_id, src.url_hash
        ), ranked AS (
            SELECT
                landing.*,
                ROW_NUMBER() OVER(PARTITION BY campaign_id, ad_group_id ORDER BY cost_micros DESC, clicks DESC, final_url ASC) AS rn
            FROM landing
        )
        SELECT *
        FROM ranked
        WHERE rn <= 5
        ORDER BY campaign_name ASC NULLS LAST, ad_group_name ASC NULLS LAST, rn ASC`,
        queryParams
    );
    return normalizeDbRows(rows).map(row => ({
        campaignId: row.campaign_id,
        campaign: row.campaign_name || row.campaign_id,
        adGroupId: row.ad_group_id,
        adGroup: row.ad_group_name || row.ad_group_id,
        url: row.final_url || null,
        source: row.page_source,
        mobileFriendlyClicksPct: percentFromFraction(row.mobile_friendly_clicks_percentage),
        validAmpClicksPct: percentFromFraction(row.valid_amp_clicks_percentage),
        speedScore: nullableNumber(row.speed_score),
        ...metricFields(row)
    }));
}

async function selectAuctionStatusRows(pool: Pool, filters: DashboardFilters, ids: string[]): Promise<any[]> {
    const params: any[] = [filters.customerId];
    const clauses = ['customer_id = $1'];
    const typeSql = 'LOWER(entity_type)';
    const adGroupTypeSql = `${typeSql} IN ('ad_group', 'adgroup', 'ad-group')`;
    if (filters.adGroupId) {
        const scopeClauses = [`${typeSql} = 'account'`];
        if (filters.campaignId) {
            params.push(filters.campaignId);
            scopeClauses.push(`(${typeSql} = 'campaign' AND entity_id = $${params.length})`);
        }
        params.push(filters.adGroupId);
        scopeClauses.push(`(${adGroupTypeSql} AND entity_id = $${params.length})`);
        clauses.push(`(${scopeClauses.join(' OR ')})`);
    } else if (filters.campaignId) {
        const scopeClauses = [`${typeSql} = 'account'`];
        params.push(filters.campaignId);
        scopeClauses.push(`(${typeSql} = 'campaign' AND entity_id = $${params.length})`);
        if (ids.length) {
            params.push(ids);
            scopeClauses.push(`(${adGroupTypeSql} AND entity_id = ANY($${params.length}::text[]))`);
        }
        clauses.push(`(${scopeClauses.join(' OR ')})`);
    } else if (ids.length) {
        params.push(ids);
        clauses.push(`(${typeSql} IN ('account', 'campaign') OR (${adGroupTypeSql} AND entity_id = ANY($${params.length}::text[])))`);
    }
    const { rows } = await pool.query(
        `SELECT *
         FROM google_ads_auction_insights_status
         WHERE ${clauses.join(' AND ')}
         ORDER BY entity_type ASC, entity_name ASC NULLS LAST
         LIMIT 500`,
        params
    );
    return normalizeDbRows(rows).map(row => ({
        entityType: row.entity_type,
        entityId: row.entity_id,
        entityName: row.entity_name,
        status: row.status,
        sheetName: row.sheet_name,
        rows: numberValue(row.rows_fetched),
        message: row.message,
        spreadsheetId: row.spreadsheet_id,
        spreadsheetModifiedTime: row.spreadsheet_modified_time
    }));
}

function configuredKeywordPayload(row: any): any {
    return {
        campaignId: row.campaign_id,
        adGroupId: row.ad_group_id,
        criterionId: row.criterion_id,
        resourceName: row.criterion_resource_name || null,
        keyword: row.keyword_text,
        keywordText: row.keyword_text,
        matchType: row.match_type || null,
        status: row.status || null,
        campaign: row.campaign_name || row.campaign_id,
        adGroup: row.ad_group_name || row.ad_group_id,
        primaryStatus: row.primary_status || '',
        primaryStatusReasons: row.primary_status_reasons || [],
        finalUrl: Array.isArray(row.final_urls) ? row.final_urls[0] || '' : ''
    };
}

async function getLeadAttributionForProposalContext(pool: Pool, filters: DashboardFilters, campaigns: any[], adGroups: any[]): Promise<any> {
    const dashboardData = {
        meta: {
            accountId: filters.customerId,
            dateRange: { start: filters.startDate, end: filters.endDate },
            filters: {
                campaignId: filters.campaignId || null,
                adGroupId: filters.adGroupId || null
            }
        },
        campaigns,
        adGroups,
        filterOptions: {
            campaigns: campaigns.map(row => ({ id: row.campaignId || row.id, name: row.campaign || row.name, status: row.status || null })),
            adGroups: adGroups.map(row => ({
                id: row.adGroupId || row.id,
                name: row.adGroup || row.name,
                status: row.status || null,
                campaignId: row.campaignId,
                campaignName: row.campaign
            }))
        },
        periodComparison: null
    };
    try {
        return await getLeadAttributionSummary(pool, dashboardData, { mode: 'overview' });
    } catch (err) {
        return {
            generatedAt: new Date().toISOString(),
            mode: 'unavailable',
            totals: null,
            byCampaign: [],
            bySearchTerm: [],
            journeySummary: null,
            offlineExport: null,
            error: err instanceof Error ? err.message : String(err)
        };
    }
}

async function getProposalContextDirect(pool: Pool, rawArgs: Record<string, any> = {}): Promise<any> {
    const filters = await resolveDashboardFilters(pool, rawArgs);
    const topSearchTerms = compactLimit(rawArgs.topSearchTerms, 8, 25);
    const topSignals = compactLimit(rawArgs.topSignals, 10, 25);
    const searchTermContextLimit = proposalSearchTermLimit();
    const requestedMax = rawArgs.maxAdGroups === undefined || rawArgs.maxAdGroups === null
        ? DEFAULT_PROPOSAL_CONTEXT_AD_GROUP_LIMIT
        : compactLimit(rawArgs.maxAdGroups, DEFAULT_PROPOSAL_CONTEXT_AD_GROUP_LIMIT, DEFAULT_PROPOSAL_CONTEXT_AD_GROUP_LIMIT);
    const [summary, campaigns, adGroupResult, coverageRows, latestRefreshRun] = await Promise.all([
        selectProposalSummary(pool, filters),
        selectProposalCampaigns(pool, filters),
        selectProposalAdGroups(pool, filters, requestedMax),
        getCoverageForWindow(pool, filters),
        selectLatestRefreshRun(pool, filters.customerId)
    ]);
    const ids = adGroupIds(adGroupResult.adGroups);
    const [
        configuredKeywordRows,
        qualityRows,
        negativeRuleData,
        landingRows,
        auctionInsightsStatus,
        auctionInsightsRows,
        segments,
        plannerRows,
        candidateRows
    ] = await Promise.all([
        selectConfiguredKeywords(pool, filters, ids),
        selectQualityRows(pool, filters, ids),
        selectNegativeRuleData(pool, filters),
        selectLandingPageRows(pool, filters, ids),
        selectAuctionStatusRows(pool, filters, ids),
        selectAuctionInsightRowCount(pool, filters),
        selectProposalSegments(pool, filters),
        selectPlannerRows(pool, filters),
        selectCandidateSignals(pool, filters, 500).then(rows => rows.map(candidateSignalPayload))
    ]);
    const negativeRules = negativeRuleData.rules;
    const configuredRules: any[] = configuredKeywordRows
        .map(rawConfiguredKeywordRow)
        .map(configuredKeywordRuleFromReportRow)
        .filter(Boolean);
    const referenceCpa = cpaBenchmarkForAccount(summary.cpa, summary.currency || 'INR');
    const plannerByKeyword = plannerMap([...plannerRows.historicalMetrics, ...plannerRows.ideas]);
    const searchTermRows = await selectSearchTermsForAdGroups(
        pool,
        filters,
        ids,
        searchTermContextLimit,
        topSearchTerms,
        negativeRules,
        configuredRules,
        plannerByKeyword,
        referenceCpa
    );
    const leadAttribution = await getLeadAttributionForProposalContext(pool, filters, campaigns, adGroupResult.adGroups);
    const existingKeywordSet = new Set(configuredRules.map((row: any) => normKey(row.keywordText || row.keyword)).filter(Boolean));
    const existingSearchTermSet = new Set(searchTermRows.map((row: any) => normKey(row.searchTerm)).filter(Boolean));
    const plannerIdeas = plannerRows.ideas.map((metric: any) => {
        const coverage = flattenDecisionContext(decisionContextForTerm(
            metric.keyword,
            { customerId: filters.customerId },
            negativeRules,
            configuredRules,
            { allowAnyScope: true }
        ));
        const inAccountKeyword = Boolean(coverage.isConfiguredKeyword || existingKeywordSet.has(normKey(metric.keyword)));
        const inAccountSearchTerm = existingSearchTermSet.has(normKey(metric.keyword));
        return {
            ...compactPlannerMetric(metric),
            ...plannerDisplayFields(metric.keyword, metric, {}, referenceCpa),
            inAccountKeyword,
            inAccountSearchTerm,
            blockedByNegative: coverage.isNegativeCovered,
            plannerClassification: coverage.isNegativeCovered
                ? 'blocked_by_negative'
                : inAccountKeyword
                    ? 'already_configured'
                    : inAccountSearchTerm
                        ? 'already_seen'
                        : 'new_opportunity',
            ...coverage
        };
    }).sort((a: any, b: any) =>
        numberValue(b.plannerScore) - numberValue(a.plannerScore)
        || numberValue(b.avgMonthlySearches) - numberValue(a.avgMonthlySearches)
    );
    const plannerHistoricalMetrics = plannerRows.historicalMetrics.map(compactPlannerMetric);
    const keywordPlannerStatus = {
        status: plannerIdeas.length || plannerHistoricalMetrics.length ? 'ok' : 'empty',
        ideas: plannerIdeas.length,
        historicalMetrics: plannerHistoricalMetrics.length,
        message: plannerIdeas.length || plannerHistoricalMetrics.length ? 'Keyword Planner data loaded from warehouse.' : 'Keyword Planner has not run yet.'
    };
    const sourceCoverage = sourceCoverageFromRows(coverageRows, {
        'search-term-performance': searchTermRows.length,
        'configured-keywords': configuredKeywordRows.length,
        'campaign-negatives': negativeRuleData.sourceCounts.campaignNegatives,
        'ad-group-negatives': negativeRuleData.sourceCounts.adGroupNegatives,
        'account-negatives': negativeRuleData.sourceCounts.accountNegatives,
        'shared-negative-sets': negativeRuleData.sourceCounts.sharedNegativeSets,
        'shared-negative-criteria': negativeRuleData.sourceCounts.sharedNegativeCriteria,
        'campaign-shared-sets': negativeRuleData.sourceCounts.campaignSharedSets,
        'keyword-planner-ideas': plannerIdeas.length,
        'keyword-planner-historical-metrics': plannerHistoricalMetrics.length,
        'quality-score': qualityRows.length,
        'landing-page-performance': landingRows.filter(row => row.source === 'landing').length,
        'expanded-landing-page-performance': landingRows.filter(row => row.source === 'expanded_landing').length,
        'auction-insights-domains': auctionInsightsRows,
        'auction-insights-status': auctionInsightsStatus.length,
        'device-performance': segments.device.length,
        'day-of-week-performance': segments.dayOfWeek.length,
        'day-and-hour-performance': segments.dayAndHour.length,
        'candidate-signals': candidateRows.length,
        'lead-attribution': leadAttribution?.mode === 'unavailable' ? 0 : numberValue(leadAttribution?.totals?.uniqueLeads)
    });
    if (leadAttribution?.mode === 'unavailable') {
        sourceCoverage.failedSources = Array.from(new Set([...(sourceCoverage.failedSources || []), 'lead-attribution'])).sort();
        const failedLeadSource = {
            name: 'lead-attribution',
            status: 'failed',
            rows: 0,
            generatedAt: leadAttribution.generatedAt,
            ageHours: null,
            error: leadAttribution.error,
            message: leadAttribution.error
        };
        const existingLeadSource = sourceCoverage.sources.find((source: any) => source.name === 'lead-attribution');
        if (existingLeadSource) Object.assign(existingLeadSource, failedLeadSource);
        else sourceCoverage.sources.push(failedLeadSource);
    }
    const refreshCoverage = mergeRefreshRunIntoSourceCoverage(sourceCoverage, latestRefreshRun);
    const configuredPayloads = configuredKeywordRows.map(configuredKeywordPayload);
    const adGroups = adGroupResult.adGroups.map((adGroup: any) => {
        const compactAdGroup = compactPerformanceRow(adGroup);
        const searchTerms = searchTermRows.filter((row: any) => rowMatchesAdGroup(row, compactAdGroup));
        const configuredKeywords = configuredPayloads.filter((row: any) => rowMatchesAdGroup(row, compactAdGroup));
        const negativeRulesForAdGroup = negativeRules.filter((rule: any) => negativeRuleAppliesToAdGroup(rule, compactAdGroup));
        const activeNegativeRules = negativeRulesForAdGroup.filter(activeNegativeRule);
        const signals = candidateRows.filter((signal: any) => signalMatchesAdGroup(signal, compactAdGroup)).slice(0, topSignals);
        const visibleSpend = searchTerms[0]?.totalCostMicros !== undefined
            ? microsValue(searchTerms[0].totalCostMicros)
            : searchTerms.reduce((sum: number, row: any) => sum + numberValue(row.spend), 0);
        const negativeCoveredSpend = searchTerms
            .filter((row: any) => row.isNegativeCovered)
            .reduce((sum: number, row: any) => sum + numberValue(row.spend), 0);
        const configuredSpend = searchTerms
            .filter((row: any) => row.isConfiguredKeyword)
            .reduce((sum: number, row: any) => sum + numberValue(row.spend), 0);
        return {
            adGroup: compactAdGroup,
            leadQuality: leadSummaryForAdGroup(compactAdGroup, leadAttribution, searchTerms),
            searchTerms: {
                totalVisible: numberValue(searchTerms[0]?.totalVisible || searchTerms.length),
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
                totalRules: negativeRulesForAdGroup.length,
                activeRules: activeNegativeRules.length,
                bySource: countByField(activeNegativeRules, 'source'),
                samples: activeNegativeRules.slice(0, 10).map((rule: any) => ({
                    source: rule.source,
                    keywordText: rule.keywordText || rule.keyword,
                    matchType: rule.matchType,
                    addedTo: rule.addedTo || rule.sourceName || null
                }))
            },
            qualityScores: qualitySummaryForAdGroup(compactAdGroup, { qualityScores: qualityRows }),
            landingPages: landingPageSummaryForAdGroup(compactAdGroup, {
                landingPages: landingRows.filter(row => row.source === 'landing'),
                expandedLandingPages: landingRows.filter(row => row.source === 'expanded_landing')
            }),
            auctionInsightsStatus: auctionStatusForAdGroup(compactAdGroup, { auctionInsightsStatus }),
            candidateSignals: signals.map(compactSignal),
            signalIds: signals.map((signal: any) => signal.signal_id).filter(Boolean)
        };
    });
    const decisionContext = buildDecisionContextSummary({
        negativeRules,
        configuredKeywords: configuredRules,
        searchTerms: searchTermRows,
        plannerIdeas,
        plannerHistoricalMetrics,
        candidateSignals: candidateRows,
        sourceCoverage,
        decisionInputs: {
            keywordPlannerStatus: keywordPlannerStatus.status,
            auctionInsightsRows,
            auctionInsightsStatusRows: auctionInsightsStatus.length,
            qualityScoreRows: qualityRows.length,
            landingPageRows: landingRows.filter(row => row.source === 'landing').length,
            expandedLandingPageRows: landingRows.filter(row => row.source === 'expanded_landing').length,
            deviceRows: segments.device.length,
            dayOfWeekRows: segments.dayOfWeek.length,
            dayAndHourRows: segments.dayAndHour.length
        }
    });
    if (refreshCoverage) {
        decisionContext.sourceCoverage = {
            ...(decisionContext.sourceCoverage || {}),
            refreshRunStatus: latestRefreshRun?.status || null,
            failedReports: refreshCoverage.failedReports,
            missingReports: refreshCoverage.missingReports,
            sourceSummary: refreshCoverage.sourceSummary
        };
    }
    return {
        meta: {
            generatedAt: new Date().toISOString(),
            accountId: filters.customerId,
            currency: summary.currency || 'INR',
            dateRange: { start: filters.startDate, end: filters.endDate },
            filters: {
                campaignId: filters.campaignId || null,
                adGroupId: filters.adGroupId || null
            },
            historicalCpaBenchmarks: historicalCpaBenchmarks(campaigns, summary),
            contextKind: 'proposal_context',
            enabledAdGroups: adGroupResult.enabledCount,
            returnedAdGroups: adGroups.length,
            topSearchTerms,
            searchTermContextLimit,
            topSignals,
            capApplied: adGroupResult.enabledCount > adGroups.length
        },
        summary,
        sourceCoverage,
        leadAttribution: compactLeadAttribution(leadAttribution, 25),
        keywordPlanner: { status: keywordPlannerStatus },
        decisionContext,
        adGroups
    };
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
    return getProposalContextDirect(pool, rawArgs);
}
