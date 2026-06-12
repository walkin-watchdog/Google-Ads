import type { SourceCoverageEntry, SourceCoverageSummary } from './decisionContext';

type LeadQualityTone = 'positive' | 'negative' | 'mixed' | 'neutral' | 'missing';

interface LeadQualitySummary {
    source: string;
    scope: string;
    uniqueLeads: number;
    eventCount: number;
    new: number;
    useless: number;
    maybe: number;
    qualified: number;
    qualifiedLost: number;
    converted: number;
    qualifiedPipeline: number;
    qualifiedOrConverted: number;
    uselessRate: number;
    tone: LeadQualityTone;
    reason: string;
}

function termKey(value: any): string {
    return String(value || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function clean(value: any): string {
    return String(value ?? '').trim();
}

function emptyLeadQuality(scope = 'none'): LeadQualitySummary {
    return {
        source: 'leadAttribution',
        scope,
        uniqueLeads: 0,
        eventCount: 0,
        new: 0,
        useless: 0,
        maybe: 0,
        qualified: 0,
        qualifiedLost: 0,
        converted: 0,
        qualifiedPipeline: 0,
        qualifiedOrConverted: 0,
        uselessRate: 0,
        tone: 'missing',
        reason: 'No first-party lead attribution matched this term.'
    };
}

function leadStatus(value: any): string {
    return String(value || 'new').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function finalizeLeadQuality(bucket: LeadQualitySummary): LeadQualitySummary {
    bucket.qualifiedPipeline = bucket.qualified + bucket.qualifiedLost + bucket.converted;
    bucket.qualifiedOrConverted = bucket.qualified + bucket.converted;
    bucket.uselessRate = bucket.uniqueLeads > 0 ? +(bucket.useless / bucket.uniqueLeads).toFixed(4) : 0;
    if (bucket.uniqueLeads <= 0) {
        bucket.tone = 'missing';
        bucket.reason = 'No first-party lead attribution matched this term.';
    } else if (bucket.uselessRate >= 0.6 && bucket.qualifiedPipeline === 0) {
        bucket.tone = 'negative';
        bucket.reason = `${bucket.useless}/${bucket.uniqueLeads} matched leads are useless with no qualified pipeline.`;
    } else if (bucket.qualifiedOrConverted > 0 && bucket.uselessRate <= 0.5) {
        bucket.tone = 'positive';
        bucket.reason = `${bucket.qualifiedOrConverted}/${bucket.uniqueLeads} matched leads are qualified or converted.`;
    } else if (bucket.useless > 0 && bucket.qualifiedPipeline > 0) {
        bucket.tone = 'mixed';
        bucket.reason = `${bucket.useless}/${bucket.uniqueLeads} matched leads are useless, but ${bucket.qualifiedPipeline} reached qualified pipeline.`;
    } else {
        bucket.tone = 'neutral';
        bucket.reason = `${bucket.uniqueLeads} matched first-party lead(s), but quality is not decisive.`;
    }
    return bucket;
}

function bumpLeadQuality(bucket: LeadQualitySummary, lead: any): void {
    bucket.uniqueLeads += 1;
    bucket.eventCount += Number(lead?.eventCount || lead?.event_count || 0);
    const status = leadStatus(lead?.status);
    if (status === 'useless') bucket.useless += 1;
    else if (status === 'maybe') bucket.maybe += 1;
    else if (status === 'qualified') bucket.qualified += 1;
    else if (status === 'qualified_lost') bucket.qualifiedLost += 1;
    else if (status === 'converted') bucket.converted += 1;
    else bucket.new += 1;
}

function cloneLeadQuality(bucket: LeadQualitySummary | null): LeadQualitySummary | null {
    return bucket ? { ...bucket } : null;
}

function addBucket(map: Map<string, LeadQualitySummary>, key: string, scope: string, lead: any): void {
    if (!key) return;
    const bucket = map.get(key) || emptyLeadQuality(scope);
    bumpLeadQuality(bucket, lead);
    map.set(key, bucket);
}

function leadTerm(lead: any): string {
    const attr = lead?.attribution || {};
    return clean(attr.utm_term) || clean(attr.keyword) || clean(lead?.searchTerm) || clean(lead?.keyword);
}

function leadCampaignId(lead: any): string {
    const attr = lead?.attribution || {};
    return clean(lead?.campaign?.campaignId) || clean(attr.utm_campaign);
}

function buildLeadIndexes(leadAttribution: any): {
    hasLeadData: boolean;
    byTerm: Map<string, LeadQualitySummary>;
    byCampaignTerm: Map<string, LeadQualitySummary>;
    campaignScopedTerms: Map<string, Set<string>>;
    leads: any[];
} {
    const byTerm = new Map<string, LeadQualitySummary>();
    const byCampaignTerm = new Map<string, LeadQualitySummary>();
    const campaignScopedTerms = new Map<string, Set<string>>();
    const leads = Array.isArray(leadAttribution?.allLeads) ? leadAttribution.allLeads : [];

    for (const lead of leads) {
        const term = termKey(leadTerm(lead));
        const campaignId = leadCampaignId(lead);
        if (!term) continue;
        addBucket(byTerm, term, 'term', lead);
        if (campaignId) {
            addBucket(byCampaignTerm, `${campaignId}|${term}`, 'campaign_term', lead);
            const campaigns = campaignScopedTerms.get(term) || new Set<string>();
            campaigns.add(campaignId);
            campaignScopedTerms.set(term, campaigns);
        }
    }

    if (leads.length === 0 && Array.isArray(leadAttribution?.bySearchTerm)) {
        for (const row of leadAttribution.bySearchTerm) {
            const term = termKey(row?.searchTerm || row?.keyword);
            if (!term) continue;
            const campaignId = clean(row?.campaignId || row?.campaign_id);
            const bucket: LeadQualitySummary = {
                ...emptyLeadQuality('term'),
                uniqueLeads: Number(row.uniqueLeads || 0),
                eventCount: Number(row.eventCount || 0),
                new: Number(row.new || 0),
                useless: Number(row.useless || 0),
                qualified: Number(row.qualified || 0),
                qualifiedLost: Number(row.qualifiedLost || 0),
                converted: Number(row.converted || 0)
            };
            const finalized = finalizeLeadQuality(bucket);
            byTerm.set(term, finalized);
            if (campaignId && campaignId !== '(none)') {
                byCampaignTerm.set(`${campaignId}|${term}`, {
                    ...finalized,
                    scope: 'campaign_term'
                });
                const campaigns = campaignScopedTerms.get(term) || new Set<string>();
                campaigns.add(campaignId);
                campaignScopedTerms.set(term, campaigns);
            }
        }
    }

    for (const [key, bucket] of byTerm) byTerm.set(key, finalizeLeadQuality(bucket));
    for (const [key, bucket] of byCampaignTerm) byCampaignTerm.set(key, finalizeLeadQuality(bucket));

    const totalLeads = Number(leadAttribution?.totals?.uniqueLeads || 0);
    return { hasLeadData: leads.length > 0 || totalLeads > 0 || byTerm.size > 0, byTerm, byCampaignTerm, campaignScopedTerms, leads };
}

function leadQualityForRow(indexes: ReturnType<typeof buildLeadIndexes>, row: any, termField: string): LeadQualitySummary | null {
    const term = termKey(row?.[termField] || row?.searchTerm || row?.keyword || row?.keywordText);
    if (!term) return null;
    const campaignId = clean(row?.campaignId || row?.campaign_id);
    const scoped = campaignId ? indexes.byCampaignTerm.get(`${campaignId}|${term}`) : null;
    if (campaignId && (indexes.campaignScopedTerms.get(term)?.size || 0) > 0 && !scoped) return null;
    return cloneLeadQuality(scoped || indexes.byTerm.get(term) || null);
}

function sourceMap(sourceCoverage: SourceCoverageSummary | null | undefined): Map<string, SourceCoverageEntry> {
    const map = new Map<string, SourceCoverageEntry>();
    for (const entry of sourceCoverage?.sources || []) {
        const keys = [
            entry.name,
            entry.name.replace(/_/g, '-'),
            entry.name.replace(/-/g, '_'),
            entry.fileName || '',
            String(entry.fileName || '').replace(/\.json$/i, ''),
            String(entry.fileName || '').replace(/\.json$/i, '').replace(/_/g, '-'),
            String(entry.fileName || '').replace(/\.json$/i, '').replace(/-/g, '_')
        ].map(key => String(key || '').trim()).filter(Boolean);
        for (const key of keys) map.set(key, entry);
    }
    return map;
}

function compactSource(entry: SourceCoverageEntry | undefined): Record<string, any> {
    if (!entry) return { status: 'missing', rows: null, ageHours: null };
    return {
        name: entry.name,
        status: entry.status,
        rows: entry.rows ?? null,
        ageHours: entry.ageHours ?? null,
        message: entry.message || entry.error || null
    };
}

function sourceStatus(map: Map<string, SourceCoverageEntry>, names: string[]): Record<string, any> {
    for (const name of names) {
        const entry = map.get(name) || map.get(name.replace(/_/g, '-')) || map.get(name.replace(/-/g, '_'));
        if (entry) return compactSource(entry);
    }
    return compactSource(undefined);
}

function sourceFreshnessForRows(sourceCoverage: SourceCoverageSummary | null | undefined, leadAttribution: any): Record<string, any> {
    const sources = sourceMap(sourceCoverage);
    return {
        searchTerms: sourceStatus(sources, ['search_term_performance', 'search-term-performance']),
        configuredKeywords: sourceStatus(sources, ['configured_keywords', 'configured-keywords']),
        negatives: [
            sourceStatus(sources, ['account_negatives', 'account-negatives']),
            sourceStatus(sources, ['campaign_negatives', 'campaign-negatives']),
            sourceStatus(sources, ['ad_group_negatives', 'ad-group-negatives']),
            sourceStatus(sources, ['shared_negative_criteria', 'shared-negative-criteria']),
            sourceStatus(sources, ['campaign_shared_sets', 'campaign-shared-sets'])
        ],
        keywordPlanner: [
            sourceStatus(sources, ['keyword_planner_ideas', 'keyword-planner-ideas']),
            sourceStatus(sources, ['keyword_planner_historical_metrics', 'keyword-planner-historical-metrics'])
        ],
        leadAttribution: leadAttribution
            ? { status: 'ok', rows: leadAttribution?.totals?.uniqueLeads ?? null, generatedAt: leadAttribution.generatedAt || null }
            : { status: 'missing', rows: null, generatedAt: null }
    };
}

function relatedSearchTermEvidence(searchTerms: any[], keyword: any): any[] {
    const key = termKey(keyword);
    if (!key) return [];
    return searchTerms
        .filter(row => termKey(row.searchTerm) === key)
        .slice(0, 5)
        .map(row => ({
            campaignId: row.campaignId || null,
            campaign: row.campaign || null,
            adGroupId: row.adGroupId || null,
            adGroup: row.adGroup || null,
            spend: row.spend || 0,
            clicks: row.clicks || 0,
            conversions: row.conversions || 0,
            cpa: row.cpa || 0,
            decisionClassification: row.decisionClassification || null,
            leadQuality: row.leadQuality || null
        }));
}

function competitorLeadQuality(indexes: ReturnType<typeof buildLeadIndexes>, root: string): LeadQualitySummary | null {
    const normalizedRoot = termKey(root);
    if (!normalizedRoot) return null;
    const bucket = emptyLeadQuality('competitor_root');
    for (const lead of indexes.leads) {
        const haystack = termKey(`${leadTerm(lead)} ${lead?.attribution?.keyword || ''}`);
        if (!haystack.includes(normalizedRoot)) continue;
        bumpLeadQuality(bucket, lead);
    }
    return bucket.uniqueLeads > 0 ? finalizeLeadQuality(bucket) : null;
}

export function enrichDashboardDecisionRows(payload: any, leadAttribution: any = payload?.leadAttribution || null): any {
    if (!payload || typeof payload !== 'object') return payload;
    if (leadAttribution) payload.leadAttribution = leadAttribution;

    const indexes = buildLeadIndexes(leadAttribution);
    const sourceFreshness = sourceFreshnessForRows(payload.sourceCoverage, leadAttribution);

    if (Array.isArray(payload.searchTerms)) {
        payload.searchTerms = payload.searchTerms.map((row: any) => {
            const leadQuality = leadQualityForRow(indexes, row, 'searchTerm');
            const enriched = {
                ...row,
                leadQualityStatus: leadQuality?.tone || (indexes.hasLeadData ? 'missing' : 'unavailable'),
                leadQualityReason: leadQuality?.reason || (indexes.hasLeadData ? 'No matching first-party lead rows.' : 'First-party lead attribution is unavailable.')
            };
            if (leadQuality) enriched.leadQuality = leadQuality;
            return enriched;
        });
    }

    const searchTerms = Array.isArray(payload.searchTerms) ? payload.searchTerms : [];
    const enrichPlannerRows = (rows: any[]) => rows.map(row => {
        const leadQuality = leadQualityForRow(indexes, row, 'keyword');
        const enriched = { ...row };
        if (leadQuality) {
            enriched.leadQuality = leadQuality;
            if (leadQuality.tone === 'negative') enriched.leadQualityCounterEvidence = leadQuality.reason;
        }
        const evidence = relatedSearchTermEvidence(searchTerms, row.keyword || row.text);
        if (evidence.length) enriched.relatedSearchTermEvidence = evidence;
        return enriched;
    });

    if (payload.keywordPlanner) {
        payload.keywordPlanner = {
            ...payload.keywordPlanner,
            ideas: enrichPlannerRows(Array.isArray(payload.keywordPlanner.ideas) ? payload.keywordPlanner.ideas : []),
            historicalMetrics: enrichPlannerRows(Array.isArray(payload.keywordPlanner.historicalMetrics) ? payload.keywordPlanner.historicalMetrics : [])
        };
    }

    if (Array.isArray(payload.competitorBreakdown)) {
        payload.competitorBreakdown = payload.competitorBreakdown.map((row: any) => {
            const leadQuality = competitorLeadQuality(indexes, row.competitor);
            return {
                ...row,
                competitorLeadQuality: leadQuality,
                leadQuality,
                leadQualityStatus: leadQuality?.tone || (indexes.hasLeadData ? 'missing' : 'unavailable'),
                realLeadCount: leadQuality?.uniqueLeads || 0,
                uselessLeads: leadQuality?.useless || 0,
                qualifiedOrConvertedLeads: leadQuality?.qualifiedOrConverted || 0
            };
        });
    }

    payload.decisionInputEnrichment = {
        ...(payload.decisionInputEnrichment || {}),
        sourceFreshness,
        leadAttribution: leadAttribution ? {
            generatedAt: leadAttribution.generatedAt || null,
            uniqueLeads: leadAttribution.totals?.uniqueLeads || 0,
            bySearchTermRows: Array.isArray(leadAttribution.bySearchTerm) ? leadAttribution.bySearchTerm.length : 0
        } : {
            generatedAt: null,
            uniqueLeads: 0,
            bySearchTermRows: 0
        }
    };

    return payload;
}
