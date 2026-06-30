import dotenv from 'dotenv';
dotenv.config();

import crypto from 'crypto';
import { Pool } from 'pg';
import { ensureLeadSchema } from '../lib/leads';
import { ensureDatabaseSchema } from '../lib/proposals';
import { cpaBenchmarkForAccount, currencyCodeFromAccountRow } from '../lib/accountBenchmarks';
import { COMPETITOR_ROOTS } from '../lib/competitors';
import { DECISION_SOURCE_STATUS_REPORTS, classifyDataCoverageGaps, type DataCoverageSourceStatus } from '../lib/dataCoverageRisk';
import {
    buildDecisionContextSummary,
    configuredKeywordRuleFromReportRow,
    decisionContextForTerm,
    matchNegativeCoverage,
    normalizeNegativeRulesFromReports,
    type ConfiguredKeywordRule,
    type NegativeRule,
    type TermScope
} from '../lib/decisionContext';
import { plannerFields, plannerNumber } from '../lib/plannerScoring';
import { resolveDashboardFilters } from '../lib/dashboardPayload';
import {
    completeWarehouseRefreshRun,
    ensureAdsWarehouseSchema,
    getDashboardReportBundle,
    replaceCandidateSignals,
    startWarehouseRefreshRun,
    type CandidateSignalRow,
    type CoverageEntry,
    type DashboardFilters,
    type DashboardReportBundle
} from '../lib/adsWarehouse';

type Severity = 'critical' | 'high' | 'medium' | 'low' | 'watchlist';

interface CandidateSignal {
    signal_id: string;
    type:
        | 'ROAS_DROP'
        | 'WASTED_SPEND'
        | 'QUERY_MISMATCH'
        | 'KEYWORD_SCALE'
        | 'BUDGET_CONSTRAINT'
        | 'TRACKING_RISK'
        | 'LANDING_PAGE_LEAK'
        | 'COMPETITOR_PRESSURE'
        | 'BIDDING_TARGET_MISSING'
        | 'LOW_DATA_WATCHLIST'
        | 'QUALITY_SCORE_RISK'
        | 'LANDING_PAGE_TECH_RISK'
        | 'DEVICE_SEGMENT_RISK'
        | 'DAYPART_SEGMENT_RISK'
        | 'PLANNER_EXPANSION'
        | 'DATA_COVERAGE_RISK';
    severity: Severity;
    campaign_id: string | null;
    entity: Record<string, any>;
    evidence_window: { start: string | null; end: string | null };
    metrics: Record<string, any>;
    evidence: string[];
    counter_evidence: string[];
    missing_data: string[];
    recommended_angles: string[];
    verificationSpec?: Record<string, any>;
    verification_spec?: Record<string, any>;
}

interface AccountMetrics {
    spend: number;
    clicks: number;
    conversions: number;
    conversionValue: number;
    avgCpa: number;
    avgRoas: number;
    avgCvr: number;
}

interface CampaignStats {
    id: string;
    name: string;
    status: string;
    biddingStrategy: string;
    spend: number;
    clicks: number;
    impressions: number;
    conversions: number;
    conversionValue: number;
    cpa: number;
    roas: number;
    cvr: number;
    targetCpa: number | null;
    targetRoas: number | null;
    budget: number | null;
    impressionShare: number | null;
    lostISBudget: number;
    lostISRank: number;
    start: string | null;
    end: string | null;
}

function normalizeData(flatData: any[]): any[] {
    return flatData.map(row => {
        const obj: any = {};
        for (const [key, value] of Object.entries(row)) {
            const parts = key.split('.');
            let current = obj;
            for (let i = 0; i < parts.length - 1; i++) {
                const camelPart = parts[i].replace(/_([a-z])/g, (_g, c) => c.toUpperCase());
                current[camelPart] = current[camelPart] || {};
                current = current[camelPart];
            }
            const finalKey = parts[parts.length - 1].replace(/_([a-z])/g, (_g, c) => c.toUpperCase());
            current[finalKey] = value;
            if (finalKey === 'resourceName') {
                const segments = String(value).split('/');
                if (segments.length >= 4) current.id = segments[3].split('~')[0];
            }
        }
        return obj;
    });
}

const rawReportCache = new Map<string, any[]>();
const sourceStatusCache = new Map<string, DataCoverageSourceStatus>();

function readReport(name: string): any[] {
    return normalizeData(rawReportCache.get(name) || []);
}

function moneyMicros(value: any): number {
    return Number(value || 0) / 1_000_000;
}

function safeDiv(a: number, b: number): number {
    return b ? a / b : 0;
}

function pctMetric(value: any): number | null {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function signalId(type: CandidateSignal['type'], parts: any[]): string {
    return `${type.toLowerCase()}_${crypto.createHash('md5').update(parts.map(String).join('|')).digest('hex')}`;
}

function evidenceWindowFromRows(rows: any[]): { start: string | null; end: string | null } {
    let start: string | null = null;
    let end: string | null = null;
    for (const row of rows) {
        const d = row.segments?.date;
        if (!d) continue;
        if (!start || d < start) start = d;
        if (!end || d > end) end = d;
    }
    return { start, end };
}

function calculateAccount(rows: any[], fallbackCpaBenchmark: number): AccountMetrics {
    const spend = rows.reduce((s, r) => s + moneyMicros(r.metrics?.costMicros), 0);
    const clicks = rows.reduce((s, r) => s + Number(r.metrics?.clicks || 0), 0);
    const conversions = rows.reduce((s, r) => s + Number(r.metrics?.conversions || 0), 0);
    const conversionValue = rows.reduce((s, r) => s + Number(r.metrics?.conversionsValue || 0), 0);
    return {
        spend,
        clicks,
        conversions,
        conversionValue,
        avgCpa: conversions > 0 ? spend / conversions : fallbackCpaBenchmark,
        avgRoas: spend > 0 ? conversionValue / spend : 0,
        avgCvr: clicks > 0 ? conversions / clicks : 0
    };
}

function buildCampaignStats(rows: any[], acc: AccountMetrics): Record<string, CampaignStats> {
    const stats: Record<string, CampaignStats> = {};
    for (const row of rows) {
        const id = String(row.campaign?.id || '');
        if (!id) continue;
        if (!stats[id]) {
            stats[id] = {
                id,
                name: row.campaign?.name || 'Unknown',
                status: row.campaign?.status || 'UNKNOWN',
                biddingStrategy: row.campaign?.biddingStrategyType || 'UNKNOWN',
                spend: 0,
                clicks: 0,
                impressions: 0,
                conversions: 0,
                conversionValue: 0,
                cpa: 0,
                roas: 0,
                cvr: 0,
                targetCpa: null,
                targetRoas: null,
                budget: null,
                impressionShare: null,
                lostISBudget: 0,
                lostISRank: 0,
                start: null,
                end: null
            };
        }
        const camp = stats[id];
        camp.spend += moneyMicros(row.metrics?.costMicros);
        camp.clicks += Number(row.metrics?.clicks || 0);
        camp.impressions += Number(row.metrics?.impressions || 0);
        camp.conversions += Number(row.metrics?.conversions || 0);
        camp.conversionValue += Number(row.metrics?.conversionsValue || 0);
        const targetCpaMicros = row.campaign?.targetCpa?.targetCpaMicros || row.campaign?.maximizeConversions?.targetCpaMicros;
        if (targetCpaMicros) camp.targetCpa = moneyMicros(targetCpaMicros);
        const targetRoas = row.campaign?.targetRoas?.targetRoas || row.campaign?.maximizeConversionValue?.targetRoas;
        if (targetRoas) camp.targetRoas = Number(targetRoas);
        if (row.campaignBudget?.amountMicros) camp.budget = moneyMicros(row.campaignBudget.amountMicros);
        camp.impressionShare = pctMetric(row.metrics?.searchImpressionShare) ?? camp.impressionShare;
        camp.lostISBudget = Math.max(camp.lostISBudget, pctMetric(row.metrics?.searchBudgetLostImpressionShare) || 0);
        camp.lostISRank = Math.max(camp.lostISRank, pctMetric(row.metrics?.searchRankLostImpressionShare) || 0);
        const d = row.segments?.date;
        if (d) {
            if (!camp.start || d < camp.start) camp.start = d;
            if (!camp.end || d > camp.end) camp.end = d;
        }
    }
    for (const camp of Object.values(stats)) {
        camp.cpa = camp.conversions > 0 ? camp.spend / camp.conversions : 0;
        camp.roas = camp.spend > 0 ? camp.conversionValue / camp.spend : acc.avgRoas;
        camp.cvr = camp.clicks > 0 ? camp.conversions / camp.clicks : acc.avgCvr;
    }
    return stats;
}

function aggregatePeriod(rows: any[]): { spend: number; conv: number; value: number; roas: number } {
    const spend = rows.reduce((s, r) => s + moneyMicros(r.metrics?.costMicros), 0);
    const conv = rows.reduce((s, r) => s + Number(r.metrics?.conversions || 0), 0);
    const value = rows.reduce((s, r) => s + Number(r.metrics?.conversionsValue || 0), 0);
    return { spend, conv, value, roas: spend > 0 ? value / spend : 0 };
}

function splitCampaignRows(rows: any[], campaignId: string): { previous: any[]; current: any[] } {
    const filtered = rows.filter(r => String(r.campaign?.id || '') === campaignId && r.segments?.date)
        .sort((a, b) => String(a.segments.date).localeCompare(String(b.segments.date)));
    const midpoint = Math.floor(filtered.length / 2);
    return { previous: filtered.slice(0, midpoint), current: filtered.slice(midpoint) };
}

function auctionEvidence(campaignName: string, auctionRows: any[]): { evidence: string[]; counter: string[]; missing: string[] } {
    const matching = auctionRows.filter(row => !row.campaign?.name || row.campaign.name === campaignName);
    if (matching.length === 0) {
        return { evidence: [], counter: [], missing: ['auction_insights'] };
    }
    const competitors = matching
        .filter(row => {
            const domain = String(row.segments?.auctionInsightDomain || '').toLowerCase();
            return domain && domain !== 'you';
        })
        .map(row => ({
            domain: row.segments.auctionInsightDomain,
            impressionShare: Number(row.metrics?.auctionInsightSearchImpressionShare || 0),
            overlap: row.metrics?.auctionInsightSearchOverlapRate,
            positionAbove: row.metrics?.auctionInsightSearchPositionAboveRate,
            outranking: row.metrics?.auctionInsightSearchOutrankingShare
        }))
        .sort((a, b) => b.impressionShare - a.impressionShare);

    if (competitors.length === 0) {
        return { evidence: [], counter: ['Auction Insights loaded, but no competitor domain rows were present.'], missing: [] };
    }
    const top = competitors.slice(0, 3).map(c =>
        `${c.domain}: impression share ${(c.impressionShare * 100).toFixed(1)}%, overlap ${c.overlap == null ? 'n/a' : `${(Number(c.overlap) * 100).toFixed(1)}%`}, position above ${c.positionAbove == null ? 'n/a' : `${(Number(c.positionAbove) * 100).toFixed(1)}%`}.`
    );
    return { evidence: top, counter: [], missing: [] };
}

interface PrimaryConversionMaps {
    hasPrimaryData: boolean;
    byKeyword: Map<string, number>;
    bySearchTerm: Map<string, number>;
}

interface LeadQualityBucket {
    uniqueLeads: number;
    eventCount: number;
    useless: number;
    qualified: number;
    qualifiedLost: number;
    converted: number;
    qualifiedPipeline: number;
}

interface SemanticRootBucket extends LeadQualityBucket {
    root: string;
    campaigns: Set<string>;
    exampleTerms: Set<string>;
}

interface LeadQualityMaps {
    hasLeadData: boolean;
    byCampaign: Map<string, LeadQualityBucket>;
    bySearchTerm: Map<string, LeadQualityBucket>;
    bySemanticRoot: Map<string, SemanticRootBucket>;
    campaignAliases: Map<string, string>;
    campaignScopedTerms: Map<string, Set<string>>;
}

interface DecisionSources {
    customerId: string | null;
    negativeRules: NegativeRule[];
    configuredKeywords: ConfiguredKeywordRule[];
    plannerIdeas: any[];
    plannerHistoricalMetrics: any[];
    qualityRows: any[];
    landingRows: any[];
    expandedLandingRows: any[];
    deviceRows: any[];
    dayRows: any[];
    dayHourRows: any[];
    sourceStatuses: DataCoverageSourceStatus[];
}

function norm(v: any): string {
    return String(v || '').trim().toLowerCase();
}

function termScope(customerId: string | null, campaignId: any, campaignName: any, adGroupId?: any, adGroupName?: any): TermScope {
    return {
        customerId,
        campaignId: campaignId == null ? null : String(campaignId),
        campaignName: campaignName == null ? null : String(campaignName),
        adGroupId: adGroupId == null ? null : String(adGroupId),
        adGroupName: adGroupName == null ? null : String(adGroupName)
    };
}

function rawJsonReport(name: string): any[] {
    return rawReportCache.get(name) || [];
}

function reportStatus(name: string): DataCoverageSourceStatus {
    return sourceStatusCache.get(name) || { name, status: 'missing', rows: 0, ageHours: null, message: null };
}

function emptyLeadQualityMaps(): LeadQualityMaps {
    return {
        hasLeadData: false,
        byCampaign: new Map(),
        bySearchTerm: new Map(),
        bySemanticRoot: new Map(),
        campaignAliases: new Map(),
        campaignScopedTerms: new Map()
    };
}

function campaignAliasKey(value: any): string {
    return norm(value);
}

function buildCampaignAliasLookup(campaignRows: any[]): Map<string, string> {
    const aliasToIds = new Map<string, Set<string>>();
    for (const row of campaignRows) {
        const campaign = row?.campaign || {};
        const id = campaignAliasKey(campaign.id || row?.campaignId || row?.campaign_id);
        if (!id) continue;
        const aliases = [
            id,
            campaign.name,
            row?.campaignName,
            row?.campaign_name,
            row?.name
        ].map(campaignAliasKey).filter(Boolean);
        for (const alias of aliases) {
            const ids = aliasToIds.get(alias) || new Set<string>();
            ids.add(id);
            aliasToIds.set(alias, ids);
        }
    }

    const out = new Map<string, string>();
    for (const [alias, ids] of aliasToIds) {
        if (ids.size !== 1) continue;
        out.set(alias, Array.from(ids)[0]);
    }
    return out;
}

function canonicalCampaignKey(value: any, aliases: Map<string, string>): string {
    const key = campaignAliasKey(value);
    return aliases.get(key) || key;
}

function addScopedTerm(maps: LeadQualityMaps, campaignId: string, searchTerm: string): void {
    if (!campaignId || !searchTerm) return;
    const campaigns = maps.campaignScopedTerms.get(searchTerm) || new Set<string>();
    campaigns.add(campaignId);
    maps.campaignScopedTerms.set(searchTerm, campaigns);
}

function bumpLeadBucket(map: Map<string, LeadQualityBucket>, key: string, row: any): void {
    if (!key) return;
    const bucket = map.get(key) || { uniqueLeads: 0, eventCount: 0, useless: 0, qualified: 0, qualifiedLost: 0, converted: 0, qualifiedPipeline: 0 };
    bucket.uniqueLeads += 1;
    bucket.eventCount += Number(row.event_count || 0);
    if (row.status === 'useless') bucket.useless += 1;
    if (row.status === 'qualified') bucket.qualified += 1;
    if (row.status === 'qualified_lost') bucket.qualifiedLost += 1;
    if (row.status === 'converted') bucket.converted += 1;
    if (row.status === 'qualified' || row.status === 'qualified_lost' || row.status === 'converted') bucket.qualifiedPipeline += 1;
    map.set(key, bucket);
}

const ROOT_STOPWORDS = new Set([
    'and', 'the', 'for', 'with', 'from', 'near', 'best', 'top', 'online', 'apply', 'application',
    'admission', 'admissions', 'college', 'course', 'courses', 'institute', 'academy', 'whatsapp',
    'software', 'service', 'services', 'india', 'delhi', 'mumbai', 'bangalore', 'hyderabad'
]);

function semanticRootsFromTerm(term: string): string[] {
    const tokens = norm(term)
        .replace(/[^a-z0-9\s]+/g, ' ')
        .split(/\s+/)
        .filter(token => token.length >= 3 && !/^\d+$/.test(token) && !ROOT_STOPWORDS.has(token));
    const roots = new Set<string>();
    for (const token of tokens) roots.add(token);
    for (let i = 0; i < tokens.length - 1; i++) {
        const pair = `${tokens[i]} ${tokens[i + 1]}`;
        if (pair.length >= 7) roots.add(pair);
    }
    return Array.from(roots);
}

function bumpSemanticRoot(map: Map<string, SemanticRootBucket>, root: string, row: any, campaignId: string, searchTerm: string): void {
    const bucket = map.get(root) || {
        root,
        uniqueLeads: 0,
        eventCount: 0,
        useless: 0,
        qualified: 0,
        qualifiedLost: 0,
        converted: 0,
        qualifiedPipeline: 0,
        campaigns: new Set<string>(),
        exampleTerms: new Set<string>()
    };
    bucket.uniqueLeads += 1;
    bucket.eventCount += Number(row.event_count || 0);
    if (row.status === 'useless') bucket.useless += 1;
    if (row.status === 'qualified') bucket.qualified += 1;
    if (row.status === 'qualified_lost') bucket.qualifiedLost += 1;
    if (row.status === 'converted') bucket.converted += 1;
    if (row.status === 'qualified' || row.status === 'qualified_lost' || row.status === 'converted') bucket.qualifiedPipeline += 1;
    if (campaignId) bucket.campaigns.add(campaignId);
    if (searchTerm) bucket.exampleTerms.add(searchTerm);
    map.set(root, bucket);
}

async function buildLeadQualityMaps(existingPool?: Pool, campaignRows: any[] = readReport('campaign-performance')): Promise<LeadQualityMaps> {
    if (!process.env.DATABASE_URL) return emptyLeadQualityMaps();
    const pool = existingPool || new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 3000
    });
    try {
        await ensureLeadSchema(pool);
        const { rows } = await pool.query(
            `SELECT status, event_count, attribution
             FROM lead_sessions
             ORDER BY last_seen DESC`
        );
        const maps = emptyLeadQualityMaps();
        maps.campaignAliases = buildCampaignAliasLookup(campaignRows);
        maps.hasLeadData = rows.length > 0;
        for (const row of rows) {
            const attribution = row.attribution || {};
            const campaignId = canonicalCampaignKey(attribution.utm_campaign, maps.campaignAliases);
            const searchTerm = norm(attribution.utm_term);
            bumpLeadBucket(maps.byCampaign, campaignId, row);
            if (campaignId && searchTerm) {
                bumpLeadBucket(maps.bySearchTerm, `${campaignId}|${searchTerm}`, row);
                addScopedTerm(maps, campaignId, searchTerm);
            }
            bumpLeadBucket(maps.bySearchTerm, searchTerm, row);
            for (const root of semanticRootsFromTerm(searchTerm)) {
                bumpSemanticRoot(maps.bySemanticRoot, root, row, campaignId, searchTerm);
            }
        }
        return maps;
    } catch (err: any) {
        console.warn(`First-party lead quality unavailable for candidate signals: ${err?.message || err}`);
        return emptyLeadQualityMaps();
    } finally {
        if (!existingPool) await pool.end().catch(() => undefined);
    }
}

function searchTermLeadQuality(maps: LeadQualityMaps, campaignId: string, term: string): LeadQualityBucket | null {
    const searchTerm = norm(term);
    const campaignKey = canonicalCampaignKey(campaignId, maps.campaignAliases);
    const scoped = campaignKey ? maps.bySearchTerm.get(`${campaignKey}|${searchTerm}`) : null;
    if (scoped) return scoped;
    if (campaignKey && (maps.campaignScopedTerms.get(searchTerm)?.size || 0) > 0) return null;
    return maps.bySearchTerm.get(searchTerm) || null;
}

function rootMatchesTerm(root: string, term: string): boolean {
    const normalizedTerm = ` ${norm(term).replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ')} `;
    return normalizedTerm.includes(` ${root} `);
}

function learnedSemanticRoot(maps: LeadQualityMaps, term: string): SemanticRootBucket | null {
    const candidates = Array.from(maps.bySemanticRoot.values())
        .filter(bucket => {
            if (!rootMatchesTerm(bucket.root, term)) return false;
            const uselessRate = bucket.uniqueLeads > 0 ? bucket.useless / bucket.uniqueLeads : 0;
            return bucket.uniqueLeads >= 3 && uselessRate >= 0.6 && bucket.qualifiedPipeline === 0;
        })
        .sort((a, b) => b.useless - a.useless || b.uniqueLeads - a.uniqueLeads);
    return candidates[0] || null;
}

function buildPrimaryConversionMaps(conversionActionRows: any[], attributionRows: any[]): PrimaryConversionMaps {
    const primaryActions = new Set<string>();
    for (const row of conversionActionRows) {
        const name = norm(row.conversionAction?.name);
        if (!name) continue;
        if (row.conversionAction?.primaryForGoal || row.conversionAction?.includeInConversionsMetric) {
            primaryActions.add(name);
        }
    }

    const byKeyword = new Map<string, number>();
    const bySearchTerm = new Map<string, number>();
    if (primaryActions.size === 0) return { hasPrimaryData: false, byKeyword, bySearchTerm };

    for (const row of attributionRows) {
        const actionName = norm(row.segments?.conversionActionName);
        if (!actionName || !primaryActions.has(actionName)) continue;
        const conversions = Number(row.metrics?.conversions || 0);
        if (conversions <= 0) continue;

        const campaignId = String(row.campaign?.id || '');
        const adGroupId = String(row.adGroup?.id || '');
        const searchTerm = norm(row.searchTermView?.searchTerm);
        const keyword = norm(row.segments?.keyword?.info?.text);
        const matchType = String(row.segments?.keyword?.info?.matchType || '');

        if (searchTerm) {
            const keys = [`${campaignId}|${adGroupId}|${searchTerm}`, `${campaignId}|${searchTerm}`];
            for (const key of keys) bySearchTerm.set(key, (bySearchTerm.get(key) || 0) + conversions);
        }
        if (keyword) {
            const keys = [`${campaignId}|${adGroupId}|${keyword}|${matchType}`, `${campaignId}|${keyword}|${matchType}`, `${campaignId}|${keyword}`];
            for (const key of keys) byKeyword.set(key, (byKeyword.get(key) || 0) + conversions);
        }
    }

    return { hasPrimaryData: true, byKeyword, bySearchTerm };
}

function primaryKeywordConversions(maps: PrimaryConversionMaps, kw: any): number | null {
    if (!maps.hasPrimaryData) return null;
    const keyword = norm(kw.text);
    const matchType = String(kw.matchType || '');
    const keys = [
        `${kw.campaignId}|${kw.adGroupId || ''}|${keyword}|${matchType}`,
        `${kw.campaignId}|${keyword}|${matchType}`,
        `${kw.campaignId}|${keyword}`
    ];
    for (const key of keys) {
        if (maps.byKeyword.has(key)) return maps.byKeyword.get(key) || 0;
    }
    return 0;
}

function primarySearchTermConversions(maps: PrimaryConversionMaps, st: any): number | null {
    if (!maps.hasPrimaryData) return null;
    const searchTerm = norm(st.term);
    const keys = [
        `${st.campaignId}|${st.adGroupId || ''}|${searchTerm}`,
        `${st.campaignId}|${searchTerm}`
    ];
    for (const key of keys) {
        if (maps.bySearchTerm.has(key)) return maps.bySearchTerm.get(key) || 0;
    }
    return 0;
}

function roasDropSignals(campaignRows: any[], campaigns: Record<string, CampaignStats>, auctionRows: any[]): CandidateSignal[] {
    const signals: CandidateSignal[] = [];
    for (const camp of Object.values(campaigns)) {
        if (camp.spend < 50) continue;
        const missing: string[] = [];
        const evidence: string[] = [];
        const counter: string[] = [];
        let trigger = false;
        let severity: Severity = 'medium';
        let baselineRoas: number | null = null;

        if (camp.targetRoas && camp.roas < camp.targetRoas * 0.7) {
            trigger = true;
            severity = camp.roas < camp.targetRoas * 0.5 ? 'critical' : 'high';
            evidence.push(`ROAS ${camp.roas.toFixed(2)} is below 70% of configured target ROAS ${camp.targetRoas.toFixed(2)}.`);
        } else if (!camp.targetRoas) {
            missing.push('target_roas');
            const { previous, current } = splitCampaignRows(campaignRows, camp.id);
            const prev = aggregatePeriod(previous);
            const curr = aggregatePeriod(current);
            baselineRoas = prev.roas;
            if (previous.length > 0 && current.length > 0 && prev.roas > 0 && curr.roas < prev.roas * 0.7 && curr.spend >= 50) {
                trigger = true;
                severity = curr.roas < prev.roas * 0.5 ? 'high' : 'medium';
                evidence.push(`Current split ROAS ${curr.roas.toFixed(2)} is down >30% from previous split ROAS ${prev.roas.toFixed(2)}.`);
            }
        }

        if (!trigger) continue;
        const auction = auctionEvidence(camp.name, auctionRows);
        signals.push({
            signal_id: signalId('ROAS_DROP', [camp.id, camp.start, camp.end]),
            type: 'ROAS_DROP',
            severity,
            campaign_id: camp.id,
            entity: { resource: 'campaign', id: camp.id, name: camp.name },
            evidence_window: { start: camp.start, end: camp.end },
            metrics: {
                spend: camp.spend,
                conversions: camp.conversions,
                conversion_value: camp.conversionValue,
                roas: camp.roas,
                target_roas: camp.targetRoas,
                baseline_roas: baselineRoas
            },
            evidence: [...evidence, ...auction.evidence],
            counter_evidence: [...counter, ...auction.counter],
            missing_data: [...missing, ...auction.missing],
            recommended_angles: [
                'Debate whether competitor pressure caused ROAS drop.',
                'Check whether conversion tracking or conversion mix changed.',
                'Check bidding target, budget pressure, rank loss, and landing-page performance before changing bids.',
                'If Auction Insights are account-scoped, avoid pretending pressure is campaign-specific.'
            ]
        });
    }
    return signals;
}

function wastedSpendSignals(keywordRows: any[], campaigns: Record<string, CampaignStats>, acc: AccountMetrics, primaryMaps: PrimaryConversionMaps): CandidateSignal[] {
    const stats: Record<string, any> = {};
    const window = evidenceWindowFromRows(keywordRows);
    for (const row of keywordRows) {
        if (row.adGroupCriterion?.status !== 'ENABLED') continue;
        const campaignId = String(row.campaign?.id || '');
        const key = `${campaignId}|${row.adGroup?.id || row.adGroup?.name}|${row.adGroupCriterion?.criterionId || row.adGroupCriterion?.keyword?.text}|${row.adGroupCriterion?.keyword?.matchType}`;
        if (!stats[key]) {
            stats[key] = {
                campaignId,
                campaignName: row.campaign?.name,
                adGroupId: row.adGroup?.id || null,
                adGroupName: row.adGroup?.name,
                criterionId: row.adGroupCriterion?.criterionId || null,
                text: row.adGroupCriterion?.keyword?.text || '',
                matchType: row.adGroupCriterion?.keyword?.matchType || '',
                spend: 0,
                clicks: 0,
                conversions: 0,
                firstDate: row.segments?.date || null
            };
        }
        stats[key].spend += moneyMicros(row.metrics?.costMicros);
        stats[key].clicks += Number(row.metrics?.clicks || 0);
        stats[key].conversions += Number(row.metrics?.conversions || 0);
        if (row.segments?.date && (!stats[key].firstDate || row.segments.date < stats[key].firstDate)) stats[key].firstDate = row.segments.date;
    }

    const out: CandidateSignal[] = [];
    for (const [key, kw] of Object.entries(stats)) {
        const primaryConversions = primaryKeywordConversions(primaryMaps, kw);
        const effectiveConversions = primaryConversions ?? kw.conversions;
        if (effectiveConversions > 0 || kw.spend <= 0) continue;
        const camp = campaigns[kw.campaignId];
        const referenceCpa = camp?.targetCpa || camp?.cpa || acc.avgCpa || 2000;
        const clicksEnough = kw.clicks >= 10;
        const fastBleed = kw.clicks >= 3 && kw.spend > referenceCpa * 3;
        const matureWaste = clicksEnough && kw.spend > referenceCpa * 1.5;
        const watch = kw.spend > referenceCpa && kw.clicks > 0;
        if (!fastBleed && !matureWaste && !watch) continue;
        out.push({
            signal_id: signalId(fastBleed || matureWaste ? 'WASTED_SPEND' : 'LOW_DATA_WATCHLIST', [key, window.start, window.end]),
            type: fastBleed || matureWaste ? 'WASTED_SPEND' : 'LOW_DATA_WATCHLIST',
            severity: fastBleed ? 'high' : matureWaste ? 'medium' : 'watchlist',
            campaign_id: kw.campaignId || null,
            entity: {
                resource: 'keyword',
                campaign_id: kw.campaignId,
                campaign_name: kw.campaignName || null,
                ad_group_id: kw.adGroupId,
                criterion_id: kw.criterionId,
                keyword_text: kw.text,
                match_type: kw.matchType
            },
            evidence_window: window,
            metrics: { spend: kw.spend, clicks: kw.clicks, conversions: effectiveConversions, total_conversions: kw.conversions, primary_conversions: primaryConversions, reference_cpa: referenceCpa },
            evidence: [`Keyword spent ₹${kw.spend.toFixed(0)} across ${kw.clicks} clicks with 0 ${primaryConversions === null ? 'conversions' : 'primary conversions'}.`],
            counter_evidence: [
                ...(clicksEnough ? [] : ['Click volume is still low; avoid a blind pause unless spend velocity is dangerous.']),
                ...(primaryConversions === 0 && kw.conversions > 0 ? [`Keyword has ${kw.conversions} total conversions, but none from fetched primary conversion actions.`] : [])
            ],
            missing_data: camp?.targetCpa ? [] : ['target_cpa'],
            recommended_angles: [
                'Debate pause vs bid reduction vs match-type tightening.',
                'Check search terms before pausing broad/phrase keywords.',
                'Use exact IDs for telemetry: campaign, ad group, criterion.'
            ]
        });
    }
    return out;
}

function querySignals(searchTermRows: any[], campaigns: Record<string, CampaignStats>, acc: AccountMetrics, primaryMaps: PrimaryConversionMaps, leadMaps: LeadQualityMaps, decision: DecisionSources): CandidateSignal[] {
    const out: CandidateSignal[] = [];
    const window = evidenceWindowFromRows(searchTermRows);
    const lowIntent = ['free', 'job', 'login', 'support', 'tutorial', 'template', 'meaning', 'download', 'salary', 'career', 'internship'];

    const stats: Record<string, any> = {};
    for (const row of searchTermRows) {
        const term = row.searchTermView?.searchTerm;
        if (!term) continue;
        const campaignId = String(row.campaign?.id || '');
        const key = `${campaignId}|${row.adGroup?.id || row.adGroup?.name}|${term}`;
        if (!stats[key]) stats[key] = { campaignId, adGroupId: row.adGroup?.id || null, adGroupName: row.adGroup?.name, term, spend: 0, clicks: 0, conversions: 0, status: row.searchTermView?.status };
        stats[key].spend += moneyMicros(row.metrics?.costMicros);
        stats[key].clicks += Number(row.metrics?.clicks || 0);
        stats[key].conversions += Number(row.metrics?.conversions || 0);
    }

    for (const [key, st] of Object.entries(stats)) {
        const camp = campaigns[st.campaignId];
        const referenceCpa = camp?.targetCpa || camp?.cpa || acc.avgCpa || 2000;
        const root = lowIntent.find(word => st.term.toLowerCase().includes(word));
        const primaryConversions = primarySearchTermConversions(primaryMaps, st);
        const effectiveConversions = primaryConversions ?? st.conversions;
        const leadQuality = searchTermLeadQuality(leadMaps, st.campaignId, st.term);
        const qualifiedOrConverted = (leadQuality?.qualified || 0) + (leadQuality?.converted || 0);
        const qualifiedPipeline = leadQuality?.qualifiedPipeline || 0;
        const uselessRate = leadQuality && leadQuality.uniqueLeads > 0 ? leadQuality.useless / leadQuality.uniqueLeads : 0;
        const leadQualityPrune = Boolean(leadQuality && leadQuality.uniqueLeads >= 2 && uselessRate >= 0.6 && qualifiedPipeline === 0);
        const learnedRoot = learnedSemanticRoot(leadMaps, st.term);
        const scope = termScope(decision.customerId, st.campaignId, camp?.name || null, st.adGroupId, st.adGroupName);
        const termDecision = decisionContextForTerm(st.term, scope, decision.negativeRules, decision.configuredKeywords);
        const negativeCoverage = termDecision.negativeCoverage;
        const configuredCoverage = termDecision.configuredKeywordCoverage;
        if ((root && st.spend > 0 && effectiveConversions === 0) || leadQualityPrune || learnedRoot) {
            if (negativeCoverage.isNegativeCovered) {
                out.push({
                    signal_id: signalId('LOW_DATA_WATCHLIST', ['negative_covered_query', key, negativeCoverage.negativeCoverageKeyword, window.start, window.end]),
                    type: 'LOW_DATA_WATCHLIST',
                    severity: st.spend > referenceCpa ? 'medium' : 'watchlist',
                    campaign_id: st.campaignId || null,
                    entity: {
                        resource: 'search_term',
                        campaign_id: st.campaignId,
                        campaign_name: camp?.name || null,
                        ad_group_id: st.adGroupId,
                        search_term: st.term,
                        already_negative: true
                    },
                    evidence_window: window,
                    metrics: {
                        spend: st.spend,
                        clicks: st.clicks,
                        conversions: effectiveConversions,
                        negative_coverage: negativeCoverage
                    },
                    evidence: [`Search term "${st.term}" looks low-quality, but it is already covered by ${negativeCoverage.negativeCoverageSource} negative "${negativeCoverage.negativeCoverageKeyword}".`],
                    counter_evidence: ['Do not add a duplicate negative; continued spend may be reporting lag, scope mismatch, or match-type mismatch.'],
                    missing_data: [],
                    recommended_angles: ['Verify negative keyword scope and recent date lag before creating another exclusion.']
                });
                continue;
            }
            const evidence = root
                ? [`Search term "${st.term}" contains known low-intent root "${root}" and spent ₹${st.spend.toFixed(0)} with 0 ${primaryConversions === null ? 'conversions' : 'primary conversions'}.`]
                : [];
            if (leadQualityPrune && leadQuality) {
                evidence.push(`First-party lead quality shows ${leadQuality.useless}/${leadQuality.uniqueLeads} leads marked useless and 0 qualified, qualified-lost, or converted leads for this UTM term.`);
            }
            if (learnedRoot) {
                const uselessRateText = ((learnedRoot.useless / Math.max(learnedRoot.uniqueLeads, 1)) * 100).toFixed(0);
                evidence.push(`Self-learning root "${learnedRoot.root}" appears in ${learnedRoot.uniqueLeads} captured lead terms; ${learnedRoot.useless} (${uselessRateText}%) are useless and none are qualified, qualified-lost, or converted.`);
            }
            out.push({
                signal_id: signalId('QUERY_MISMATCH', [key, root || learnedRoot?.root || 'lead_quality', window.start, window.end]),
                type: 'QUERY_MISMATCH',
                severity: leadQualityPrune || learnedRoot ? 'high' : st.spend > referenceCpa ? 'medium' : 'low',
                campaign_id: st.campaignId || null,
                entity: {
                    resource: 'search_term',
                    campaign_id: st.campaignId,
                    campaign_name: camp?.name || null,
                    ad_group_id: st.adGroupId,
                    search_term: st.term,
                    semantic_root: learnedRoot?.root || root || null,
                    recommended_negative_match_type: learnedRoot ? 'PHRASE' : 'EXACT_OR_PHRASE_REVIEW'
                },
                evidence_window: window,
                metrics: {
                    spend: st.spend,
                    clicks: st.clicks,
                    conversions: effectiveConversions,
                    total_conversions: st.conversions,
                    primary_conversions: primaryConversions,
                    low_intent_root: root,
                    learned_semantic_root: learnedRoot?.root || null,
                    learned_root_leads: learnedRoot?.uniqueLeads || 0,
                    learned_root_useless_leads: learnedRoot?.useless || 0,
                    first_party_leads: leadQuality?.uniqueLeads || 0,
                    useless_leads: leadQuality?.useless || 0,
                    qualified_lost_leads: leadQuality?.qualifiedLost || 0,
                    qualified_or_converted_leads: qualifiedOrConverted,
                    negative_coverage: negativeCoverage,
                    configured_keyword_coverage: configuredCoverage
                },
                evidence,
                counter_evidence: [
                    'Phrase/root negatives can over-block; apply phrase match only when examples are clearly junk across enough lead volume.',
                    ...(primaryConversions === 0 && st.conversions > 0 ? [`Search term has ${st.conversions} total conversions, but none from fetched primary conversion actions.`] : []),
                    ...(leadMaps.hasLeadData && !leadQuality ? ['First-party lead tracking is active, but this UTM term has no matched lead-quality rows yet.'] : [])
                ],
                missing_data: [],
                recommended_angles: ['Debate exact negative vs phrase/root negative.', 'Check whether this term appears across multiple ad groups before broad exclusion.']
            });
        }

        const cpa = effectiveConversions > 0 ? st.spend / effectiveConversions : Infinity;
        const leadCpa = qualifiedOrConverted > 0 ? st.spend / qualifiedOrConverted : Infinity;
        const conversionScale = effectiveConversions >= 2 && cpa <= referenceCpa * 1.1;
        const leadQualityScale = qualifiedOrConverted >= 2 && leadCpa <= referenceCpa * 1.2 && uselessRate <= 0.4;
        if ((conversionScale || leadQualityScale) && !negativeCoverage.isNegativeCovered) {
            const basis = leadQualityScale && (!conversionScale || leadCpa <= cpa)
                ? `${qualifiedOrConverted} first-party qualified/converted leads at CPA ₹${leadCpa.toFixed(0)}`
                : `${effectiveConversions} ${primaryConversions === null ? 'conversions' : 'primary conversions'} at CPA ₹${cpa.toFixed(0)}`;
            if (configuredCoverage.isConfiguredKeyword && configuredCoverage.configuredKeywordStatus === 'ENABLED') {
                continue;
            }
            out.push({
                signal_id: signalId('KEYWORD_SCALE', [key, configuredCoverage.configuredKeywordStatus || 'new', window.start, window.end]),
                type: 'KEYWORD_SCALE',
                severity: 'medium',
                campaign_id: st.campaignId || null,
                entity: {
                    resource: 'search_term',
                    campaign_id: st.campaignId,
                    campaign_name: camp?.name || null,
                    ad_group_id: st.adGroupId,
                    search_term: st.term,
                    already_configured: configuredCoverage.isConfiguredKeyword,
                    configured_status: configuredCoverage.configuredKeywordStatus
                },
                evidence_window: window,
                metrics: {
                    spend: st.spend,
                    conversions: effectiveConversions,
                    total_conversions: st.conversions,
                    primary_conversions: primaryConversions,
                    cpa,
                    reference_cpa: referenceCpa,
                    first_party_leads: leadQuality?.uniqueLeads || 0,
                    useless_leads: leadQuality?.useless || 0,
                    qualified_or_converted_leads: qualifiedOrConverted,
                    lead_quality_cpa: Number.isFinite(leadCpa) ? leadCpa : null,
                    configured_keyword_coverage: configuredCoverage,
                    negative_coverage: negativeCoverage
                },
                evidence: [
                    configuredCoverage.isConfiguredKeyword
                        ? `Search term "${st.term}" produced ${basis}, but it already exists as a configured keyword with status ${configuredCoverage.configuredKeywordStatus || 'unknown'}.`
                        : `Search term "${st.term}" produced ${basis}, within reference CPA ₹${referenceCpa.toFixed(0)}.`
                ],
                counter_evidence: [
                    ...(camp?.impressionShare && camp.impressionShare >= 0.8 ? ['Campaign already has high impression share; scaling room may be limited.'] : []),
                    ...(leadQuality && leadQuality.useless > 0 ? [`First-party quality is mixed: ${leadQuality.useless}/${leadQuality.uniqueLeads} leads are marked useless.`] : []),
                    ...(configuredCoverage.isConfiguredKeyword ? ['Do not add a duplicate keyword; review status, match type, or eligibility instead.'] : [])
                ],
                missing_data: [...(camp?.targetCpa ? [] : ['target_cpa']), ...(leadMaps.hasLeadData ? [] : ['first_party_lead_quality'])],
                recommended_angles: configuredCoverage.isConfiguredKeyword
                    ? ['Debate re-enabling, match-type tightening, or eligibility fixes for the existing configured keyword.']
                    : ['Debate promote-only vs promote-and-isolate exact match.', 'Avoid disrupting Smart Bidding learning unless isolation benefit is clear.']
            });
        }
    }
    return out;
}

function semanticRootSignals(leadMaps: LeadQualityMaps, decision: DecisionSources): CandidateSignal[] {
    if (!leadMaps.hasLeadData) return [];
    const out: CandidateSignal[] = [];
    for (const bucket of leadMaps.bySemanticRoot.values()) {
        const uselessRate = bucket.uniqueLeads > 0 ? bucket.useless / bucket.uniqueLeads : 0;
        if (bucket.uniqueLeads < 3 || uselessRate < 0.6 || bucket.qualifiedPipeline > 0) continue;
        const campaigns = Array.from(bucket.campaigns).filter(Boolean);
        const examples = Array.from(bucket.exampleTerms).slice(0, 8);
        const coverage = matchNegativeCoverage(bucket.root, { customerId: decision.customerId, campaignId: campaigns.length === 1 ? campaigns[0] : null }, decision.negativeRules, { allowAnyScope: campaigns.length !== 1 });
        if (coverage.isNegativeCovered) {
            out.push({
                signal_id: signalId('LOW_DATA_WATCHLIST', ['semantic_root_already_negative', bucket.root, bucket.uniqueLeads, bucket.useless]),
                type: 'LOW_DATA_WATCHLIST',
                severity: 'watchlist',
                campaign_id: campaigns.length === 1 ? campaigns[0] : null,
                entity: {
                    resource: 'semantic_root',
                    semantic_root: bucket.root,
                    campaign_ids: campaigns,
                    already_negative: true
                },
                evidence_window: { start: null, end: null },
                metrics: {
                    first_party_leads: bucket.uniqueLeads,
                    useless_leads: bucket.useless,
                    negative_coverage: coverage
                },
                evidence: [`Learned junk root "${bucket.root}" is already covered by ${coverage.negativeCoverageSource} negative "${coverage.negativeCoverageKeyword}".`],
                counter_evidence: ['Do not add a duplicate phrase negative; review scope only if spend continues.'],
                missing_data: [],
                recommended_angles: ['Verify that the existing negative applies to every campaign where the bad root appears.']
            });
            continue;
        }
        out.push({
            signal_id: signalId('QUERY_MISMATCH', ['semantic_root', bucket.root, bucket.uniqueLeads, bucket.useless]),
            type: 'QUERY_MISMATCH',
            severity: bucket.useless >= 5 || uselessRate >= 0.8 ? 'high' : 'medium',
            campaign_id: campaigns.length === 1 ? campaigns[0] : null,
            entity: {
                resource: 'semantic_root',
                semantic_root: bucket.root,
                campaign_ids: campaigns,
                recommended_negative_match_type: 'PHRASE'
            },
            evidence_window: { start: null, end: null },
            metrics: {
                first_party_leads: bucket.uniqueLeads,
                useless_leads: bucket.useless,
                useless_rate: uselessRate,
                qualified_leads: bucket.qualified,
                qualified_lost_leads: bucket.qualifiedLost,
                converted_leads: bucket.converted
            },
            evidence: [
                `Self-learning root "${bucket.root}" appears in ${bucket.uniqueLeads} captured UTM terms; ${bucket.useless} are marked useless and 0 are qualified, qualified-lost, or converted.`,
                `Example terms: ${examples.join(', ')}`
            ],
            counter_evidence: [
                'This is learned from first-party lead labels, not Google Ads search-term conversions alone.',
                'Review examples before adding a phrase negative because broad roots can block future qualified intent.'
            ],
            missing_data: [],
            recommended_angles: [
                `Consider adding "${bucket.root}" as a phrase-match negative where the examples are clearly junk.`,
                'If examples span multiple campaigns, decide whether the negative belongs account-wide or only on the affected campaigns.'
            ]
        });
    }
    return out.sort((a, b) => (b.metrics.useless_leads || 0) - (a.metrics.useless_leads || 0)).slice(0, 25);
}

function campaignSignals(campaigns: Record<string, CampaignStats>, acc: AccountMetrics): CandidateSignal[] {
    const out: CandidateSignal[] = [];
    for (const camp of Object.values(campaigns)) {
        if (camp.spend > acc.avgCpa * 3 && camp.conversions === 0) {
            out.push({
                signal_id: signalId('TRACKING_RISK', [camp.id, camp.start, camp.end]),
                type: 'TRACKING_RISK',
                severity: 'critical',
                campaign_id: camp.id,
                entity: { resource: 'campaign', id: camp.id, name: camp.name },
                evidence_window: { start: camp.start, end: camp.end },
                metrics: { spend: camp.spend, conversions: camp.conversions, account_avg_cpa: acc.avgCpa },
                evidence: [`Campaign spent ₹${camp.spend.toFixed(0)} with zero conversions, exceeding 3x account average CPA reference.`],
                counter_evidence: ['If this campaign is new or tracking recently changed, label as diagnosis before pausing.'],
                missing_data: camp.targetCpa ? [] : ['target_cpa'],
                recommended_angles: ['Check conversion tracking, landing page availability, and query quality before scale decisions.']
            });
        }
        if (camp.biddingStrategy === 'MAXIMIZE_CONVERSIONS' && !camp.targetCpa && camp.spend > 50) {
            out.push({
                signal_id: signalId('BIDDING_TARGET_MISSING', [camp.id, camp.start, camp.end]),
                type: 'BIDDING_TARGET_MISSING',
                severity: 'medium',
                campaign_id: camp.id,
                entity: { resource: 'campaign', id: camp.id, name: camp.name },
                evidence_window: { start: camp.start, end: camp.end },
                metrics: { spend: camp.spend, bidding_strategy: camp.biddingStrategy },
                evidence: ['Campaign uses Maximize Conversions without a fetched Target CPA cap.'],
                counter_evidence: ['Google Smart Bidding can intentionally run uncapped during exploration; do not apply a cap without checking volume and history.'],
                missing_data: ['target_cpa'],
                recommended_angles: ['Debate whether missing target is intentional exploration or runaway risk.']
            });
        }
        if (camp.targetCpa && camp.cpa > 0 && camp.cpa < camp.targetCpa * 0.8 && camp.lostISBudget > 0.1 && camp.lostISBudget > camp.lostISRank) {
            out.push({
                signal_id: signalId('BUDGET_CONSTRAINT', [camp.id, camp.start, camp.end]),
                type: 'BUDGET_CONSTRAINT',
                severity: 'medium',
                campaign_id: camp.id,
                entity: { resource: 'campaign', id: camp.id, name: camp.name },
                evidence_window: { start: camp.start, end: camp.end },
                metrics: { cpa: camp.cpa, target_cpa: camp.targetCpa, lost_is_budget: camp.lostISBudget, lost_is_rank: camp.lostISRank, budget: camp.budget },
                evidence: [`CPA ₹${camp.cpa.toFixed(0)} is below Target CPA ₹${camp.targetCpa.toFixed(0)} and lost IS budget ${(camp.lostISBudget * 100).toFixed(1)}% exceeds rank loss.`],
                counter_evidence: ['Budget increase should be staged; low recent volume can make CPA look artificially good.'],
                missing_data: [],
                recommended_angles: ['Debate 10-20% budget increase vs reallocating from weaker campaigns.']
            });
        }
    }
    return out;
}

function landingPageSignals(rows: any[], campaigns: Record<string, CampaignStats>): CandidateSignal[] {
    const window = evidenceWindowFromRows(rows);
    const groups: Record<string, Record<string, any>> = {};
    for (const row of rows) {
        const campId = String(row.campaign?.id || '');
        const adGroupId = String(row.adGroup?.id || '');
        const url = String(row.landingPageView?.unexpandedFinalUrl || '').split('?')[0].replace(/\/+$/, '');
        if (!campId || !adGroupId || !url) continue;
        const key = `${campId}|${adGroupId}`;
        groups[key] = groups[key] || {};
        groups[key][url] = groups[key][url] || { url, campId, adGroupId, adGroupName: row.adGroup?.name, clicks: 0, conversions: 0, spend: 0 };
        groups[key][url].clicks += Number(row.metrics?.clicks || 0);
        groups[key][url].conversions += Number(row.metrics?.conversions || 0);
        groups[key][url].spend += moneyMicros(row.metrics?.costMicros);
    }
    const out: CandidateSignal[] = [];
    for (const urlMap of Object.values(groups)) {
        const urls = Object.values(urlMap);
        if (urls.length < 2) continue;
        const best = urls.reduce((a: any, b: any) => safeDiv(b.conversions, b.clicks) > safeDiv(a.conversions, a.clicks) ? b : a);
        if (!best || best.conversions === 0) continue;
        for (const candidate of urls) {
            if (candidate.url === best.url || candidate.clicks < 50) continue;
            const candidateCvr = safeDiv(candidate.conversions, candidate.clicks);
            const bestCvr = safeDiv(best.conversions, best.clicks);
            if (candidateCvr >= bestCvr * 0.5) continue;
            const camp = campaigns[candidate.campId];
            out.push({
                signal_id: signalId('LANDING_PAGE_LEAK', [candidate.campId, candidate.adGroupId, candidate.url, window.start, window.end]),
                type: 'LANDING_PAGE_LEAK',
                severity: 'medium',
                campaign_id: candidate.campId,
                entity: { resource: 'landing_page', campaign_id: candidate.campId, ad_group_id: candidate.adGroupId, url: candidate.url },
                evidence_window: window,
                metrics: { clicks: candidate.clicks, conversions: candidate.conversions, cvr: candidateCvr, control_url: best.url, control_cvr: bestCvr, spend: candidate.spend },
                evidence: [`URL ${candidate.url} has ${(candidateCvr * 100).toFixed(2)}% CVR vs ${best.url} at ${(bestCvr * 100).toFixed(2)}% CVR in the same ad group.`],
                counter_evidence: ['Different URLs may represent different intents; confirm ad copy/query mix before pausing.'],
                missing_data: camp ? [] : ['campaign_join'],
                recommended_angles: ['Debate pausing losing URL vs rewriting ad-to-page mapping vs collecting more data.']
            });
        }
    }
    return out;
}

function qualityScoreSignals(qualityRows: any[], keywordRows: any[], campaigns: Record<string, CampaignStats>, acc: AccountMetrics): CandidateSignal[] {
    const window = evidenceWindowFromRows(keywordRows);
    const perf = new Map<string, { spend: number; clicks: number; conversions: number }>();
    for (const row of keywordRows) {
        const key = `${row.campaign?.id || ''}|${row.adGroup?.id || ''}|${norm(row.adGroupCriterion?.keyword?.text)}|${row.adGroupCriterion?.keyword?.matchType || ''}`;
        const bucket = perf.get(key) || { spend: 0, clicks: 0, conversions: 0 };
        bucket.spend += moneyMicros(row.metrics?.costMicros);
        bucket.clicks += Number(row.metrics?.clicks || 0);
        bucket.conversions += Number(row.metrics?.conversions || 0);
        perf.set(key, bucket);
    }

    const out: CandidateSignal[] = [];
    for (const row of qualityRows) {
        const campaignId = String(row.campaign?.id || '');
        const adGroupId = String(row.adGroup?.id || '');
        const text = String(row.adGroupCriterion?.keyword?.text || '');
        const matchType = String(row.adGroupCriterion?.keyword?.matchType || '');
        if (!text || row.adGroupCriterion?.status === 'REMOVED') continue;
        const qualityScore = Number(row.adGroupCriterion?.qualityInfo?.qualityScore || 0);
        const adRelevance = String(row.adGroupCriterion?.qualityInfo?.creativeQualityScore || '');
        const landingPage = String(row.adGroupCriterion?.qualityInfo?.postClickQualityScore || '');
        const expectedCtr = String(row.adGroupCriterion?.qualityInfo?.searchPredictedCtr || '');
        const p = perf.get(`${campaignId}|${adGroupId}|${norm(text)}|${matchType}`) || { spend: 0, clicks: 0, conversions: 0 };
        const camp = campaigns[campaignId];
        const referenceCpa = camp?.targetCpa || camp?.cpa || acc.avgCpa || 2000;
        const componentRisk = [adRelevance, landingPage, expectedCtr].some(value => value.includes('BELOW_AVERAGE'));
        if (!(qualityScore > 0 && qualityScore <= 3) && !componentRisk) continue;
        if (p.clicks < 10 && p.spend < referenceCpa * 0.5) continue;
        out.push({
            signal_id: signalId('QUALITY_SCORE_RISK', [campaignId, adGroupId, text, matchType, qualityScore]),
            type: 'QUALITY_SCORE_RISK',
            severity: qualityScore > 0 && qualityScore <= 2 ? 'high' : 'medium',
            campaign_id: campaignId || null,
            entity: { resource: 'keyword', campaign_id: campaignId, ad_group_id: adGroupId, keyword_text: text, match_type: matchType },
            evidence_window: window,
            metrics: {
                quality_score: qualityScore || null,
                ad_relevance: adRelevance || null,
                landing_page_experience: landingPage || null,
                expected_ctr: expectedCtr || null,
                spend: p.spend,
                clicks: p.clicks,
                conversions: p.conversions
            },
            evidence: [`Keyword "${text}" has Quality Score ${qualityScore || 'missing'} with ${p.clicks} clicks and ₹${p.spend.toFixed(0)} spend.`],
            counter_evidence: ['Quality Score is diagnostic; confirm query mix, ad relevance, and landing page before changing bids or pausing.'],
            missing_data: [],
            recommended_angles: ['Debate ad relevance, landing-page alignment, and match-type cleanup before budget changes.']
        });
    }
    return out;
}

function landingPageTechSignals(rows: any[], expandedRows: any[], campaigns: Record<string, CampaignStats>, acc: AccountMetrics): CandidateSignal[] {
    const allRows = [...rows, ...expandedRows];
    const window = evidenceWindowFromRows(allRows);
    const out: CandidateSignal[] = [];
    const seen = new Set<string>();
    for (const row of allRows) {
        const campaignId = String(row.campaign?.id || '');
        const adGroupId = String(row.adGroup?.id || '');
        const url = String(row.landingPageView?.unexpandedFinalUrl || row.expandedLandingPageView?.expandedFinalUrl || '').split('?')[0].replace(/\/+$/, '');
        if (!campaignId || !url) continue;
        const clicks = Number(row.metrics?.clicks || 0);
        const spend = moneyMicros(row.metrics?.costMicros);
        const conversions = Number(row.metrics?.conversions || 0);
        const mobileFriendly = plannerNumber(row.metrics?.mobileFriendlyClicksPercentage);
        const validAmp = plannerNumber(row.metrics?.validAcceleratedMobilePagesClicksPercentage);
        const speedScore = plannerNumber(row.metrics?.speedScore);
        const camp = campaigns[campaignId];
        const referenceCpa = camp?.targetCpa || camp?.cpa || acc.avgCpa || 2000;
        const mobileRisk = mobileFriendly !== null && mobileFriendly < 0.8;
        const ampRisk = validAmp !== null && validAmp < 0.8;
        const speedRisk = speedScore !== null && speedScore > 0 && speedScore <= 5;
        if (!mobileRisk && !ampRisk && !speedRisk) continue;
        if (clicks < 25 && spend < referenceCpa * 0.5) continue;
        const key = `${campaignId}|${adGroupId}|${url}|${mobileRisk}|${ampRisk}|${speedRisk}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            signal_id: signalId('LANDING_PAGE_TECH_RISK', [key, window.start, window.end]),
            type: 'LANDING_PAGE_TECH_RISK',
            severity: spend > referenceCpa ? 'medium' : 'low',
            campaign_id: campaignId,
            entity: { resource: 'landing_page', campaign_id: campaignId, ad_group_id: adGroupId || null, url },
            evidence_window: window,
            metrics: {
                spend,
                clicks,
                conversions,
                mobile_friendly_clicks_percentage: mobileFriendly,
                valid_amp_clicks_percentage: validAmp,
                speed_score: speedScore,
                reference_cpa: referenceCpa
            },
            evidence: [`Landing page ${url} has ${clicks} clicks, ₹${spend.toFixed(0)} spend, mobile-friendly ${mobileFriendly == null ? 'n/a' : `${(mobileFriendly * 100).toFixed(0)}%`}, valid AMP ${validAmp == null ? 'n/a' : `${(validAmp * 100).toFixed(0)}%`}, speed score ${speedScore ?? 'n/a'}.`],
            counter_evidence: ['Landing-page technical metrics can be sparse; confirm in PageSpeed and compare query intent before changing traffic.'],
            missing_data: [mobileFriendly === null ? 'mobile_friendly_clicks_percentage' : '', validAmp === null ? 'valid_amp_clicks_percentage' : '', speedScore === null ? 'speed_score' : ''].filter(Boolean),
            recommended_angles: ['Debate page speed/mobile fixes vs routing only affected ad groups to stronger pages.']
        });
    }
    return out;
}

function segmentRiskSignals(rows: any[], campaigns: Record<string, CampaignStats>, acc: AccountMetrics, kind: 'device' | 'daypart'): CandidateSignal[] {
    const window = evidenceWindowFromRows(rows);
    const groups = new Map<string, any>();
    for (const row of rows) {
        const campaignId = String(row.campaign?.id || '');
        if (!campaignId) continue;
        const device = String(row.segments?.device || '');
        const day = String(row.segments?.dayOfWeek || '');
        const hour = row.segments?.hour == null ? '' : String(row.segments.hour);
        const segment = kind === 'device' ? device : `${day} ${hour}:00`;
        if (!segment.trim()) continue;
        const key = `${campaignId}|${segment}`;
        const bucket = groups.get(key) || { campaignId, segment, spend: 0, clicks: 0, conversions: 0, impressions: 0 };
        bucket.spend += moneyMicros(row.metrics?.costMicros);
        bucket.clicks += Number(row.metrics?.clicks || 0);
        bucket.conversions += Number(row.metrics?.conversions || 0);
        bucket.impressions += Number(row.metrics?.impressions || 0);
        groups.set(key, bucket);
    }

    const out: CandidateSignal[] = [];
    for (const item of groups.values()) {
        const camp = campaigns[item.campaignId];
        const referenceCpa = camp?.targetCpa || camp?.cpa || acc.avgCpa || 2000;
        const cpa = item.conversions > 0 ? item.spend / item.conversions : 0;
        const waste = item.conversions === 0 && item.clicks >= 8 && item.spend > referenceCpa * 0.75;
        const inefficient = item.conversions > 0 && cpa > referenceCpa * 1.8 && item.spend > referenceCpa;
        if (!waste && !inefficient) continue;
        out.push({
            signal_id: signalId(kind === 'device' ? 'DEVICE_SEGMENT_RISK' : 'DAYPART_SEGMENT_RISK', [item.campaignId, item.segment, window.start, window.end]),
            type: kind === 'device' ? 'DEVICE_SEGMENT_RISK' : 'DAYPART_SEGMENT_RISK',
            severity: item.spend > referenceCpa * 2 ? 'medium' : 'low',
            campaign_id: item.campaignId,
            entity: { resource: kind, campaign_id: item.campaignId, segment: item.segment },
            evidence_window: window,
            metrics: { spend: item.spend, clicks: item.clicks, conversions: item.conversions, cpa, reference_cpa: referenceCpa },
            evidence: [`${kind === 'device' ? 'Device' : 'Day/hour'} segment "${item.segment}" spent ₹${item.spend.toFixed(0)} across ${item.clicks} clicks with ${item.conversions} conversions.`],
            counter_evidence: ['Segment bid or schedule edits can restrict Smart Bidding learning; treat low volume as watchlist first.'],
            missing_data: camp?.targetCpa ? [] : ['target_cpa'],
            recommended_angles: [kind === 'device' ? 'Debate device bid adjustment or device-specific landing page checks.' : 'Debate schedule exclusions, bid modifiers, or monitoring until more data accumulates.']
        });
    }
    return out;
}

function plannerExpansionSignals(decision: DecisionSources, acc: AccountMetrics): CandidateSignal[] {
    const out: CandidateSignal[] = [];
    const rows = [...decision.plannerIdeas, ...decision.plannerHistoricalMetrics];
    for (const row of rows) {
        const keyword = String(row.keyword || row.text || '').trim();
        if (!keyword) continue;
        const context = decisionContextForTerm(keyword, { customerId: decision.customerId }, decision.negativeRules, decision.configuredKeywords, { allowAnyScope: true });
        if (context.negativeCoverage.isNegativeCovered || context.configuredKeywordCoverage.isConfiguredKeyword) continue;
        const fields = plannerFields(keyword, row, {}, acc.avgCpa || 2000);
        const avgMonthlySearches = fields.avgMonthlySearches;
        const plannerScore = fields.plannerScore;
        const lowBid = fields.lowBid;
        if ((plannerScore !== null && plannerScore < 65) && (avgMonthlySearches === null || avgMonthlySearches < 100)) continue;
        out.push({
            signal_id: signalId('PLANNER_EXPANSION', [keyword, avgMonthlySearches || 0, plannerScore || 0]),
            type: 'PLANNER_EXPANSION',
            severity: plannerScore !== null && plannerScore >= 80 ? 'medium' : 'low',
            campaign_id: null,
            entity: { resource: 'keyword_planner_idea', keyword_text: keyword },
            evidence_window: { start: null, end: null },
            metrics: {
                avg_monthly_searches: avgMonthlySearches,
                competition: fields.competition,
                competition_index: fields.competitionIndex,
                low_bid: lowBid,
                high_bid: fields.highBid,
                planner_score: plannerScore,
                planner_source: fields.plannerSource,
                account_avg_cpa: acc.avgCpa
            },
            evidence: [`Planner idea "${keyword}" is not configured and not negative-covered; AMS ${avgMonthlySearches ?? 'n/a'}, score ${plannerScore ?? 'n/a'}.`],
            counter_evidence: ['Planner volume is market context, not account profitability proof. Start as a test unless current search-term or lead-quality evidence supports it.'],
            missing_data: decision.plannerIdeas.length || decision.plannerHistoricalMetrics.length ? [] : ['keyword_planner'],
            recommended_angles: ['Debate small exact/phrase test vs waiting for search-term evidence.']
        });
        if (out.length >= 25) break;
    }
    return out;
}

function dataCoverageSignals(decision: DecisionSources, leadMaps: LeadQualityMaps): CandidateSignal[] {
    const coverage = classifyDataCoverageGaps(decision.sourceStatuses, leadMaps.hasLeadData);
    if (!coverage.hasGap) return [];
    return [{
        signal_id: signalId('DATA_COVERAGE_RISK', [
            coverage.missingOrFailedSources.join(','),
            coverage.staleSources.join(','),
            coverage.emptyDecisionSources.join(',')
        ]),
        type: 'DATA_COVERAGE_RISK',
        severity: coverage.severity,
        campaign_id: null,
        entity: { resource: 'account' },
        evidence_window: { start: null, end: null },
        metrics: {
            missing_sources: coverage.missingOrFailedSources,
            stale_sources: coverage.staleSources,
            empty_decision_sources: coverage.emptyDecisionSources,
            first_party_lead_quality_present: leadMaps.hasLeadData
        },
        evidence: [`Decision context has missing/failed sources: ${coverage.missingOrFailedSources.length ? coverage.missingOrFailedSources.join(', ') : 'none'}. Stale sources: ${coverage.staleSources.length ? coverage.staleSources.join(', ') : 'none'}. Empty decision sources: ${coverage.emptyDecisionSources.join(', ') || 'none'}.`],
        counter_evidence: ['Empty report files can mean no rows; stale report files can still contain valid rows but should lower confidence until a fresh refresh succeeds.'],
        missing_data: coverage.missingData,
        recommended_angles: ['Refresh or verify report compatibility before making high-confidence proposal decisions.']
    }];
}

function attachDecisionContext(signals: CandidateSignal[], decision: DecisionSources): CandidateSignal[] {
    return signals.map(signal => {
        const entity = signal.entity || {};
        const term = entity.search_term || entity.keyword_text || entity.semantic_root || '';
        if (!term) return signal;
        const scope = termScope(
            decision.customerId,
            entity.campaign_id || signal.campaign_id || null,
            entity.campaign_name || null,
            entity.ad_group_id || null,
            entity.ad_group_name || null
        );
        const context = decisionContextForTerm(String(term), scope, decision.negativeRules, decision.configuredKeywords, { allowAnyScope: !scope.campaignId });
        return {
            ...signal,
            decisionContext: context,
            decision_context: context
        };
    });
}

function diagnosisVerificationSpec(reason: string): Record<string, any> {
    return {
        kind: 'diagnosis_only',
        observable: false,
        entity: {},
        expected: {},
        reason
    };
}

function suggestedVerificationSpec(signal: CandidateSignal): Record<string, any> {
    const entity = signal.entity || {};
    const campaignId = String(entity.campaign_id || signal.campaign_id || '').trim();
    const adGroupId = String(entity.ad_group_id || '').trim();

    if (signal.type === 'WASTED_SPEND' && entity.resource === 'keyword' && campaignId && (entity.criterion_id || entity.keyword_text)) {
        return {
            kind: 'keyword_status',
            observable: true,
            entity: {
                campaign_id: campaignId,
                campaign_name: entity.campaign_name || undefined,
                ad_group_id: adGroupId || undefined,
                criterion_id: entity.criterion_id || undefined,
                keyword_text: entity.keyword_text || undefined,
                match_type: entity.match_type || undefined
            },
            expected: { status: 'PAUSED' }
        };
    }

    if (signal.type === 'QUERY_MISMATCH' && entity.resource === 'search_term' && campaignId && entity.search_term && !entity.already_negative) {
        return {
            kind: 'negative_search_term_added',
            observable: true,
            entity: {
                campaign_id: campaignId,
                campaign_name: entity.campaign_name || undefined,
                ad_group_id: adGroupId || undefined,
                search_term: entity.search_term
            },
            expected: { statuses: ['EXCLUDED', 'PHRASE_EXCLUDED'] }
        };
    }

    if (signal.type === 'KEYWORD_SCALE' && entity.resource === 'search_term' && campaignId && entity.search_term) {
        if (entity.already_configured) {
            return {
                kind: 'keyword_status',
                observable: true,
                entity: {
                    campaign_id: campaignId,
                    campaign_name: entity.campaign_name || undefined,
                    ad_group_id: adGroupId || undefined,
                    keyword_text: entity.search_term
                },
                expected: { status: 'ENABLED' }
            };
        }
        return {
            kind: 'keyword_added_exact',
            observable: true,
            entity: {
                campaign_id: campaignId,
                campaign_name: entity.campaign_name || undefined,
                ad_group_id: adGroupId || undefined,
                keyword_text: entity.search_term
            },
            expected: { match_type: 'EXACT', status: 'ENABLED' }
        };
    }

    return diagnosisVerificationSpec('Candidate signal does not identify a single concrete Google Ads account-state change to verify.');
}

function attachVerificationSpecs(signals: CandidateSignal[]): CandidateSignal[] {
    return signals.map(signal => {
        const spec = signal.verificationSpec || signal.verification_spec || suggestedVerificationSpec(signal);
        return {
            ...signal,
            verificationSpec: spec,
            verification_spec: spec
        };
    });
}

function competitorPressureSignals(searchTermRows: any[], keywordRows: any[], auctionRows: any[], acc: AccountMetrics, decision: DecisionSources): CandidateSignal[] {
    const window = evidenceWindowFromRows(searchTermRows);
    const domains = new Set<string>();
    for (const row of auctionRows) {
        const domain = String(row.segments?.auctionInsightDomain || '').toLowerCase();
        if (!domain || domain === 'you') continue;
        const parts = domain.split('.');
        const root = parts.length > 2 ? parts[parts.length - 2] : parts[0];
        if (root.length > 2) domains.add(root);
    }
    for (const root of COMPETITOR_ROOTS) {
        const keywordHit = keywordRows.some(row => String(row.adGroupCriterion?.keyword?.text || '').toLowerCase().includes(root));
        const searchTermHit = searchTermRows.some(row => String(row.searchTermView?.searchTerm || '').toLowerCase().includes(root));
        if (keywordHit || searchTermHit) domains.add(root);
    }
    if (domains.size === 0) return [];
    let spend = 0;
    let uncoveredSpend = 0;
    let coveredSpend = 0;
    let conversions = 0;
    const terms = new Set<string>();
    for (const row of searchTermRows) {
        const term = String(row.searchTermView?.searchTerm || '').toLowerCase();
        if (!Array.from(domains).some(root => term.includes(root))) continue;
        const rowSpend = moneyMicros(row.metrics?.costMicros);
        spend += rowSpend;
        conversions += Number(row.metrics?.conversions || 0);
        const coverage = matchNegativeCoverage(term, termScope(decision.customerId, row.campaign?.id, row.campaign?.name, row.adGroup?.id, row.adGroup?.name), decision.negativeRules);
        if (coverage.isNegativeCovered) coveredSpend += rowSpend;
        else uncoveredSpend += rowSpend;
        if (rowSpend > 0) terms.add(term);
    }

    let keywordSpend = 0;
    let keywordConversions = 0;
    const keywordExamples = new Set<string>();
    for (const row of keywordRows) {
        const keywordText = String(row.adGroupCriterion?.keyword?.text || '').toLowerCase();
        if (!keywordText || !Array.from(domains).some(root => keywordText.includes(root))) continue;
        const rowSpend = moneyMicros(row.metrics?.costMicros);
        keywordSpend += rowSpend;
        keywordConversions += Number(row.metrics?.conversions || 0);
        if (rowSpend > 0) keywordExamples.add(keywordText);
    }

    const totalEvidenceSpend = Math.max(spend, keywordSpend);
    if (totalEvidenceSpend <= 0) return [];
    const effectiveConversions = Math.max(conversions, keywordConversions);
    const cpa = effectiveConversions > 0 ? totalEvidenceSpend / effectiveConversions : totalEvidenceSpend;
    if (totalEvidenceSpend < acc.spend * 0.05 && cpa <= acc.avgCpa * 1.5) return [];

    const signals: CandidateSignal[] = [];
    if (spend > 0) {
        signals.push({
            signal_id: signalId('COMPETITOR_PRESSURE', ['visible_terms', window.start, window.end, spend.toFixed(0)]),
            type: 'COMPETITOR_PRESSURE',
            severity: spend > acc.spend * 0.25 ? 'high' : 'medium',
            campaign_id: null,
            entity: { resource: 'account', competitor_roots: Array.from(domains), example_terms: Array.from(terms).slice(0, 10), covered_by_negatives: coveredSpend > 0, coverage_status: 'classified_search_terms' },
            evidence_window: window,
            metrics: { spend, uncovered_spend: uncoveredSpend, covered_spend: coveredSpend, conversions, cpa: conversions > 0 ? spend / conversions : spend, account_spend: acc.spend, account_avg_cpa: acc.avgCpa },
            evidence: [`Competitor-root search terms spent ₹${spend.toFixed(0)} (${((spend / Math.max(acc.spend, 1)) * 100).toFixed(1)}% of spend); ₹${uncoveredSpend.toFixed(0)} is not covered by fetched negatives.`],
            counter_evidence: [
                ...(conversions > 0 ? ['Competitor terms did produce conversions; evaluate lead quality before cutting.'] : []),
                ...(coveredSpend > 0 ? ['Some competitor spend is already covered by negatives; continued spend may reflect lag, scope, or match-type mismatch rather than missing exclusions.'] : [])
            ],
            missing_data: [],
            recommended_angles: uncoveredSpend > 0
                ? ['Debate competitor conquesting cap vs adding negatives only for uncovered roots vs separate campaign/budget.']
                : ['Do not add duplicate negatives; verify existing negative scope and recent spend lag.']
        });
    }

    const unclassifiedSpend = Math.max(keywordSpend - spend, 0);
    if (unclassifiedSpend > 0 && (spend === 0 || unclassifiedSpend >= totalEvidenceSpend * 0.25)) {
        signals.push({
            signal_id: signalId('COMPETITOR_PRESSURE', ['unclassified_competitor_spend', window.start, window.end, unclassifiedSpend.toFixed(0)]),
            type: 'COMPETITOR_PRESSURE',
            severity: unclassifiedSpend > acc.spend * 0.1 ? 'medium' : 'watchlist',
            campaign_id: null,
            entity: {
                resource: 'account',
                competitor_roots: Array.from(domains),
                example_keywords: Array.from(keywordExamples).slice(0, 10),
                coverage_status: 'unclassified_search_terms'
            },
            evidence_window: window,
            metrics: {
                keyword_competitor_spend: keywordSpend,
                visible_search_term_spend: spend,
                unclassified_spend: unclassifiedSpend,
                keyword_conversions: keywordConversions,
                account_spend: acc.spend,
                account_avg_cpa: acc.avgCpa
            },
            evidence: [`Competitor-root keywords spent ₹${keywordSpend.toFixed(0)}, but only ₹${spend.toFixed(0)} appears in visible matching search-term rows; ₹${unclassifiedSpend.toFixed(0)} is coverage-unknown due to hidden or absent search terms.`],
            counter_evidence: ['Google may hide low-volume search terms; do not infer the hidden portion is safe or already excluded.'],
            missing_data: ['complete_search_term_visibility'],
            recommended_angles: ['Review matched keywords and available search terms before adding broad competitor negatives; classify visible uncovered terms first.']
        });
    }

    return signals;
}

function sourceName(reportName: string): string {
    return reportName.replace(/_/g, '-');
}

function rawPayloadRows(rows: any[]): any[] {
    return rows.map(row => row.raw_payload || row).filter(Boolean);
}

function resolveDecisionCustomerId(accountRows: any[], filters: DashboardFilters): string | null {
    const accountRow = accountRows[0] || {};
    return String(accountRow.customer?.id || accountRow['customer.id'] || filters.customerId || process.env.GOOGLE_ADS_CUSTOMER_ID || '').trim() || null;
}

function coverageStatus(entry: CoverageEntry | undefined, name: string): DataCoverageSourceStatus {
    if (!entry) return { name, status: 'missing', rows: 0, ageHours: null, message: null };
    return {
        name,
        status: entry.status === 'covered' ? 'ok' : entry.status === 'partial' ? 'failed' : entry.status,
        rows: entry.rowCount,
        ageHours: null,
        message: entry.error || (entry.status === 'partial' ? `Partial coverage for ${name}.` : null)
    };
}

function addRawReport(name: string, rows: any[], coverage?: CoverageEntry): void {
    rawReportCache.set(name, rows);
    sourceStatusCache.set(name, coverage ? coverageStatus(coverage, name) : {
        name,
        status: rows.length ? 'ok' : 'empty',
        rows: rows.length,
        ageHours: null,
        message: null
    });
}

function hydrateReportCaches(bundle: DashboardReportBundle): void {
    rawReportCache.clear();
    sourceStatusCache.clear();
    const coverageByName = new Map(bundle.coverage.map(entry => [sourceName(entry.reportName), entry]));
    addRawReport('account-summary', rawPayloadRows(bundle.accountDaily), coverageByName.get('account-summary'));
    addRawReport('campaign-performance', rawPayloadRows(bundle.campaignDaily), coverageByName.get('campaign-performance'));
    addRawReport('keyword-performance', rawPayloadRows(bundle.keywordDaily), coverageByName.get('keyword-performance'));
    addRawReport('search-term-performance', rawPayloadRows(bundle.searchTermDaily), coverageByName.get('search-term-performance'));
    addRawReport('auction-insights-domains', rawPayloadRows(bundle.auctionInsightsRows), coverageByName.get('auction-insights-domains'));
    addRawReport('landing-page-performance', rawPayloadRows(bundle.landingPageDaily), coverageByName.get('landing-page-performance'));
    addRawReport('expanded-landing-page-performance', rawPayloadRows(bundle.expandedLandingPageDaily), coverageByName.get('expanded-landing-page-performance'));
    addRawReport('quality-score', rawPayloadRows(bundle.qualityScores), coverageByName.get('quality-score'));
    addRawReport('device-performance', rawPayloadRows(bundle.deviceDaily), coverageByName.get('device-performance'));
    addRawReport('day-of-week-performance', rawPayloadRows(bundle.dayOfWeekDaily), coverageByName.get('day-of-week-performance'));
    addRawReport('day-and-hour-performance', rawPayloadRows(bundle.dayHourDaily), coverageByName.get('day-and-hour-performance'));
    addRawReport('conversion-action-performance', rawPayloadRows(bundle.conversionActionDaily), coverageByName.get('conversion-action-performance'));
    addRawReport('conversion-attribution-by-search-term', rawPayloadRows(bundle.conversionSearchTermDaily), coverageByName.get('conversion-attribution-by-search-term'));
    addRawReport('configured-keywords', rawPayloadRows(bundle.configuredKeywords));
    addRawReport('account-negatives', rawPayloadRows(bundle.negatives.accountNegativeLists));
    addRawReport('campaign-negatives', rawPayloadRows(bundle.negatives.campaignNegatives));
    addRawReport('ad-group-negatives', rawPayloadRows(bundle.negatives.adGroupNegatives));
    addRawReport('shared-negative-sets', rawPayloadRows(bundle.negatives.sharedNegativeSets));
    addRawReport('shared-negative-criteria', rawPayloadRows(bundle.negatives.sharedNegativeCriteria));
    addRawReport('campaign-shared-sets', rawPayloadRows(bundle.negatives.campaignSharedSets));
    addRawReport('keyword-planner-ideas', rawPayloadRows(bundle.keywordPlannerIdeas));
    addRawReport('keyword-planner-historical-metrics', rawPayloadRows(bundle.keywordPlannerHistorical));
    addRawReport('auction-insights-status', rawPayloadRows(bundle.auctionInsightsStatus));
}

function signalToWarehouseRow(signal: CandidateSignal, filters: DashboardFilters): CandidateSignalRow {
    return {
        signal_id: signal.signal_id,
        customer_id: filters.customerId,
        signal_type: signal.type,
        severity: signal.severity,
        campaign_id: signal.campaign_id || signal.entity?.campaign_id || null,
        ad_group_id: signal.entity?.ad_group_id || null,
        evidence_start_date: signal.evidence_window?.start || filters.startDate,
        evidence_end_date: signal.evidence_window?.end || filters.endDate,
        payload: signal
    };
}

export interface GenerateCandidateSignalsOptions {
    filters?: Partial<DashboardFilters>;
    runId?: string;
    useExistingRun?: boolean;
    ensureSchemas?: boolean;
}

export async function generateCandidateSignals(pool: Pool, options: GenerateCandidateSignalsOptions = {}): Promise<{
    filters: DashboardFilters;
    runId: string;
    signals: CandidateSignal[];
}> {
    const signalRunId = options.runId || `signals_${crypto.randomUUID()}`;
    let filters: DashboardFilters | null = null;
    let ownRunInserted = false;
    try {
        if (options.ensureSchemas !== false) {
            await ensureDatabaseSchema(pool);
            await ensureAdsWarehouseSchema(pool);
        }
        filters = await resolveDashboardFilters(pool, options.filters || {});
        const bundle = await getDashboardReportBundle(pool, filters);
        hydrateReportCaches(bundle);
        if (!options.useExistingRun) {
            await startWarehouseRefreshRun(pool, {
                id: signalRunId,
                kind: 'repair',
                customerId: filters.customerId,
                requestedStartDate: filters.startDate,
                requestedEndDate: filters.endDate
            });
            ownRunInserted = true;
        }
    } catch (err) {
        throw err;
    }
    if (!filters) throw new Error('Failed to resolve dashboard filters for candidate signals.');
    const campaignRows = readReport('campaign-performance');
    const accountRows = readReport('account-summary');
    const keywordRows = readReport('keyword-performance');
    const searchTermRows = readReport('search-term-performance');
    const auctionRows = readReport('auction-insights-domains');
    const landingRows = readReport('landing-page-performance');
    const expandedLandingRows = readReport('expanded-landing-page-performance');
    const qualityRows = readReport('quality-score');
    const deviceRows = readReport('device-performance');
    const dayRows = readReport('day-of-week-performance');
    const dayHourRows = readReport('day-and-hour-performance');
    const conversionActionRows = readReport('conversion-action-performance');
    const conversionAttributionRows = readReport('conversion-attribution-by-search-term');
    const customerId = resolveDecisionCustomerId(accountRows, filters);
    const configuredKeywordRows = rawJsonReport('configured-keywords');
    const decision: DecisionSources = {
        customerId,
        configuredKeywords: configuredKeywordRows
            .map(configuredKeywordRuleFromReportRow)
            .filter((row): row is ConfiguredKeywordRule => Boolean(row)),
        negativeRules: normalizeNegativeRulesFromReports({
            customerId,
            accountNegatives: rawJsonReport('account-negatives'),
            campaignNegatives: rawJsonReport('campaign-negatives'),
            adGroupNegatives: rawJsonReport('ad-group-negatives'),
            sharedNegativeSets: rawJsonReport('shared-negative-sets'),
            sharedNegativeCriteria: rawJsonReport('shared-negative-criteria'),
            campaignSharedSets: rawJsonReport('campaign-shared-sets')
        }),
        plannerIdeas: rawJsonReport('keyword-planner-ideas'),
        plannerHistoricalMetrics: rawJsonReport('keyword-planner-historical-metrics'),
        qualityRows,
        landingRows,
        expandedLandingRows,
        deviceRows,
        dayRows,
        dayHourRows,
        sourceStatuses: DECISION_SOURCE_STATUS_REPORTS.map(reportStatus)
    };

    const currency = currencyCodeFromAccountRow(accountRows[0], 'INR');
    const fallbackCpaBenchmark = cpaBenchmarkForAccount(0, currency);
    const acc = calculateAccount(accountRows.length ? accountRows : campaignRows, fallbackCpaBenchmark);
    const campaigns = buildCampaignStats(campaignRows, acc);
    const primaryMaps = buildPrimaryConversionMaps(conversionActionRows, conversionAttributionRows);
    const leadMaps = await buildLeadQualityMaps(pool, campaignRows);

    const rawSignals = [
        ...roasDropSignals(campaignRows, campaigns, auctionRows),
        ...wastedSpendSignals(keywordRows, campaigns, acc, primaryMaps),
        ...querySignals(searchTermRows, campaigns, acc, primaryMaps, leadMaps, decision),
        ...semanticRootSignals(leadMaps, decision),
        ...campaignSignals(campaigns, acc),
        ...landingPageSignals(landingRows, campaigns),
        ...qualityScoreSignals(qualityRows, keywordRows, campaigns, acc),
        ...landingPageTechSignals(landingRows, expandedLandingRows, campaigns, acc),
        ...segmentRiskSignals(deviceRows, campaigns, acc, 'device'),
        ...segmentRiskSignals(dayHourRows.length ? dayHourRows : dayRows, campaigns, acc, 'daypart'),
        ...plannerExpansionSignals(decision, acc),
        ...dataCoverageSignals(decision, leadMaps),
        ...competitorPressureSignals(searchTermRows, keywordRows, auctionRows, acc, decision)
    ];

    const decisionSummary = buildDecisionContextSummary({
        negativeRules: decision.negativeRules,
        configuredKeywords: decision.configuredKeywords,
        candidateSignals: rawSignals,
        plannerIdeas: decision.plannerIdeas,
        plannerHistoricalMetrics: decision.plannerHistoricalMetrics,
        decisionInputs: {
            sourceStatuses: decision.sourceStatuses,
            hasLeadData: leadMaps.hasLeadData
        }
    });

    const signals = attachVerificationSpecs(attachDecisionContext(rawSignals, decision)).map(signal => ({
        ...signal,
        missingData: signal.missing_data || [],
        counterEvidence: signal.counter_evidence || [],
        accountDecisionSummary: {
            negativeRules: decisionSummary.negativeRules,
            configuredKeywords: decisionSummary.configuredKeywords,
            sourceCoverage: decisionSummary.sourceCoverage
        }
    })).sort((a, b) => {
        const order: Record<Severity, number> = { critical: 5, high: 4, medium: 3, low: 2, watchlist: 1 };
        return order[b.severity] - order[a.severity];
    });

    try {
        await replaceCandidateSignals(pool, filters.customerId, filters, signals.map(signal => signalToWarehouseRow(signal, filters)), signalRunId);
        if (ownRunInserted) {
            await completeWarehouseRefreshRun(pool, signalRunId, {
                status: 'succeeded',
                customerId: filters.customerId,
                effectiveStartDate: filters.startDate,
                effectiveEndDate: filters.endDate,
                sourceSummary: { candidate_signals: { status: 'ok', rows: signals.length } }
            });
        }
        console.log(`Saved ${signals.length} candidate signals to Postgres candidate_signals`);
        return { filters, runId: signalRunId, signals };
    } catch (err: any) {
        if (ownRunInserted) await completeWarehouseRefreshRun(pool, signalRunId, {
            status: 'failed',
            customerId: filters.customerId,
            effectiveStartDate: filters.startDate,
            effectiveEndDate: filters.endDate,
            sourceSummary: { candidate_signals: { status: 'failed', rows: 0 } },
            error: err?.message || String(err)
        }).catch(() => undefined);
        throw err;
    }
}

async function run() {
    console.log('Running deterministic candidate signal engine...');
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for DB-backed deterministic candidate signals.');
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });
    try {
        await generateCandidateSignals(pool);
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    run().catch(err => {
        console.error('Fatal error in candidate signal engine:', err);
        process.exitCode = 1;
    });
}

export const __deterministicRulesTestHooks = {
    buildCampaignAliasLookup,
    buildLeadQualityMaps,
    resolveDecisionCustomerId,
    searchTermLeadQuality
};
