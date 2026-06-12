import dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import { Pool } from 'pg';
import { ensureLeadSchema } from '../lib/leads';

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'latest');
const OUT_FILE = path.join(DATA_DIR, 'deterministic_insights.json');

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
        | 'LOW_DATA_WATCHLIST';
    severity: Severity;
    campaign_id: string | null;
    entity: Record<string, any>;
    evidence_window: { start: string | null; end: string | null };
    metrics: Record<string, any>;
    evidence: string[];
    counter_evidence: string[];
    missing_data: string[];
    recommended_angles: string[];
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

function readReport(name: string): any[] {
    const file = path.join(DATA_DIR, `${name}.json`);
    if (!fs.existsSync(file)) return [];
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return normalizeData(Array.isArray(raw) ? raw : []);
    } catch (err) {
        console.warn(`Could not read ${name}:`, err);
        return [];
    }
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

function calculateAccount(rows: any[]): AccountMetrics {
    const spend = rows.reduce((s, r) => s + moneyMicros(r.metrics?.costMicros), 0);
    const clicks = rows.reduce((s, r) => s + Number(r.metrics?.clicks || 0), 0);
    const conversions = rows.reduce((s, r) => s + Number(r.metrics?.conversions || 0), 0);
    const conversionValue = rows.reduce((s, r) => s + Number(r.metrics?.conversionsValue || 0), 0);
    return {
        spend,
        clicks,
        conversions,
        conversionValue,
        avgCpa: conversions > 0 ? spend / conversions : 2000,
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
}

function norm(v: any): string {
    return String(v || '').trim().toLowerCase();
}

function emptyLeadQualityMaps(): LeadQualityMaps {
    return { hasLeadData: false, byCampaign: new Map(), bySearchTerm: new Map(), bySemanticRoot: new Map() };
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

async function buildLeadQualityMaps(): Promise<LeadQualityMaps> {
    if (!process.env.DATABASE_URL) return emptyLeadQualityMaps();
    const pool = new Pool({
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
        maps.hasLeadData = rows.length > 0;
        for (const row of rows) {
            const attribution = row.attribution || {};
            const campaignId = String(attribution.utm_campaign || '').trim();
            const searchTerm = norm(attribution.utm_term);
            bumpLeadBucket(maps.byCampaign, campaignId, row);
            if (campaignId && searchTerm) bumpLeadBucket(maps.bySearchTerm, `${campaignId}|${searchTerm}`, row);
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
        await pool.end().catch(() => undefined);
    }
}

function searchTermLeadQuality(maps: LeadQualityMaps, campaignId: string, term: string): LeadQualityBucket | null {
    return maps.bySearchTerm.get(`${campaignId}|${norm(term)}`) || maps.bySearchTerm.get(norm(term)) || null;
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

function querySignals(searchTermRows: any[], keywordRows: any[], campaigns: Record<string, CampaignStats>, acc: AccountMetrics, primaryMaps: PrimaryConversionMaps, leadMaps: LeadQualityMaps): CandidateSignal[] {
    const out: CandidateSignal[] = [];
    const window = evidenceWindowFromRows(searchTermRows);
    const lowIntent = ['free', 'job', 'login', 'support', 'tutorial', 'template', 'meaning', 'download', 'salary', 'career', 'internship'];
    const exactKeywords = new Set(keywordRows
        .filter(r => r.adGroupCriterion?.status === 'ENABLED' && r.adGroupCriterion?.keyword?.matchType === 'EXACT')
        .map(r => `${String(r.campaign?.id || '')}|${String(r.adGroupCriterion?.keyword?.text || '').toLowerCase()}`));

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
        if ((root && st.spend > 0 && effectiveConversions === 0) || leadQualityPrune || learnedRoot) {
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
                    qualified_or_converted_leads: qualifiedOrConverted
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
        if ((conversionScale || leadQualityScale) && !exactKeywords.has(`${st.campaignId}|${st.term.toLowerCase()}`)) {
            const basis = leadQualityScale && (!conversionScale || leadCpa <= cpa)
                ? `${qualifiedOrConverted} first-party qualified/converted leads at CPA ₹${leadCpa.toFixed(0)}`
                : `${effectiveConversions} ${primaryConversions === null ? 'conversions' : 'primary conversions'} at CPA ₹${cpa.toFixed(0)}`;
            out.push({
                signal_id: signalId('KEYWORD_SCALE', [key, window.start, window.end]),
                type: 'KEYWORD_SCALE',
                severity: 'medium',
                campaign_id: st.campaignId || null,
                entity: { resource: 'search_term', campaign_id: st.campaignId, ad_group_id: st.adGroupId, search_term: st.term },
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
                    lead_quality_cpa: Number.isFinite(leadCpa) ? leadCpa : null
                },
                evidence: [`Search term "${st.term}" produced ${basis}, within reference CPA ₹${referenceCpa.toFixed(0)}.`],
                counter_evidence: [
                    ...(camp?.impressionShare && camp.impressionShare >= 0.8 ? ['Campaign already has high impression share; scaling room may be limited.'] : []),
                    ...(leadQuality && leadQuality.useless > 0 ? [`First-party quality is mixed: ${leadQuality.useless}/${leadQuality.uniqueLeads} leads are marked useless.`] : [])
                ],
                missing_data: [...(camp?.targetCpa ? [] : ['target_cpa']), ...(leadMaps.hasLeadData ? [] : ['first_party_lead_quality'])],
                recommended_angles: ['Debate promote-only vs promote-and-isolate exact match.', 'Avoid disrupting Smart Bidding learning unless isolation benefit is clear.']
            });
        }
    }
    return out;
}

function semanticRootSignals(leadMaps: LeadQualityMaps): CandidateSignal[] {
    if (!leadMaps.hasLeadData) return [];
    const out: CandidateSignal[] = [];
    for (const bucket of leadMaps.bySemanticRoot.values()) {
        const uselessRate = bucket.uniqueLeads > 0 ? bucket.useless / bucket.uniqueLeads : 0;
        if (bucket.uniqueLeads < 3 || uselessRate < 0.6 || bucket.qualifiedPipeline > 0) continue;
        const campaigns = Array.from(bucket.campaigns).filter(Boolean);
        const examples = Array.from(bucket.exampleTerms).slice(0, 8);
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

function competitorPressureSignals(searchTermRows: any[], auctionRows: any[], acc: AccountMetrics): CandidateSignal[] {
    const window = evidenceWindowFromRows(searchTermRows);
    const domains = new Set<string>();
    for (const row of auctionRows) {
        const domain = String(row.segments?.auctionInsightDomain || '').toLowerCase();
        if (!domain || domain === 'you') continue;
        const parts = domain.split('.');
        const root = parts.length > 2 ? parts[parts.length - 2] : parts[0];
        if (root.length > 2) domains.add(root);
    }
    if (domains.size === 0) return [];
    let spend = 0;
    let conversions = 0;
    const terms = new Set<string>();
    for (const row of searchTermRows) {
        const term = String(row.searchTermView?.searchTerm || '').toLowerCase();
        if (!Array.from(domains).some(root => term.includes(root))) continue;
        const rowSpend = moneyMicros(row.metrics?.costMicros);
        spend += rowSpend;
        conversions += Number(row.metrics?.conversions || 0);
        if (rowSpend > 0) terms.add(term);
    }
    if (spend <= 0) return [];
    const cpa = conversions > 0 ? spend / conversions : spend;
    if (spend < acc.spend * 0.05 && cpa <= acc.avgCpa * 1.5) return [];
    return [{
        signal_id: signalId('COMPETITOR_PRESSURE', [window.start, window.end, spend.toFixed(0)]),
        type: 'COMPETITOR_PRESSURE',
        severity: spend > acc.spend * 0.25 ? 'high' : 'medium',
        campaign_id: null,
        entity: { resource: 'account', competitor_roots: Array.from(domains), example_terms: Array.from(terms).slice(0, 10) },
        evidence_window: window,
        metrics: { spend, conversions, cpa, account_spend: acc.spend, account_avg_cpa: acc.avgCpa },
        evidence: [`Competitor-root search terms spent ₹${spend.toFixed(0)} (${((spend / Math.max(acc.spend, 1)) * 100).toFixed(1)}% of spend) at CPA ₹${cpa.toFixed(0)}.`],
        counter_evidence: conversions > 0 ? ['Competitor terms did produce conversions; evaluate lead quality before cutting.'] : [],
        missing_data: [],
        recommended_angles: ['Debate competitor conquesting cap vs negative isolation vs separate campaign/budget.']
    }];
}

async function run() {
    console.log('Running deterministic candidate signal engine...');
    const campaignRows = readReport('campaign-performance');
    const accountRows = readReport('account-summary');
    const keywordRows = readReport('keyword-performance');
    const searchTermRows = readReport('search-term-performance');
    const auctionRows = readReport('auction-insights-domains');
    const landingRows = readReport('landing-page-performance');
    const conversionActionRows = readReport('conversion-action-performance');
    const conversionAttributionRows = readReport('conversion-attribution-by-search-term');

    const acc = calculateAccount(accountRows.length ? accountRows : campaignRows);
    const campaigns = buildCampaignStats(campaignRows, acc);
    const primaryMaps = buildPrimaryConversionMaps(conversionActionRows, conversionAttributionRows);
    const leadMaps = await buildLeadQualityMaps();

    const signals = [
        ...roasDropSignals(campaignRows, campaigns, auctionRows),
        ...wastedSpendSignals(keywordRows, campaigns, acc, primaryMaps),
        ...querySignals(searchTermRows, keywordRows, campaigns, acc, primaryMaps, leadMaps),
        ...semanticRootSignals(leadMaps),
        ...campaignSignals(campaigns, acc),
        ...landingPageSignals(landingRows, campaigns),
        ...competitorPressureSignals(searchTermRows, auctionRows, acc)
    ].sort((a, b) => {
        const order: Record<Severity, number> = { critical: 5, high: 4, medium: 3, low: 2, watchlist: 1 };
        return order[b.severity] - order[a.severity];
    });

    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(signals, null, 2) + '\n');
    console.log(`Saved ${signals.length} candidate signals to ${OUT_FILE}`);
}

run().catch(err => {
    console.error('Fatal error in candidate signal engine:', err);
    process.exitCode = 1;
});
