import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { createPoolConfig } from '../lib/dbConfig';
import { ensureDatabaseSchema } from '../lib/proposals';
import { ensureLeadSchema, getLeadQualityMetricsForWindow, LeadQualityMetrics } from '../lib/leads';
import { ChangeHistoryEvent, getChangeHistoryEvents } from '../lib/changeHistory';
import { ensureAdsWarehouseSchema, getImpactMetricWindow, type DashboardFilters } from '../lib/adsWarehouse';
import { buildDashboardPayload, resolveDashboardFilters } from '../lib/dashboardPayload';

const pool = new Pool(createPoolConfig());

type ComponentOutcome = 'success' | 'failure' | 'neutral_insufficient_data';
type OutcomeLabel =
    | 'success_high_confidence'
    | 'success_low_confidence'
    | 'failure_high_confidence'
    | 'failure_low_confidence'
    | 'neutral_insufficient_data'
    | 'neutral_confounded'
    | 'neutral_mixed';
type Direction = 'success' | 'failure' | 'neutral';

interface Metrics {
    spend: number;
    clicks: number;
    impressions: number;
    conversions: number;
    conversionValue: number;
    cpa: number;
    roas: number;
}

interface MetricChanges {
    spend_change: number;
    clicks_change: number;
    conversions_change: number;
    cpa_change: number | null;
    roas_change: number | null;
}

interface ControlAssessment {
    available: boolean;
    direction: 'positive' | 'negative' | 'mixed' | 'none';
    summary: string;
    target_change: MetricChanges;
    control_change: MetricChanges;
    target_baseline: Metrics;
    target_post: Metrics;
    control_baseline: Metrics;
    control_post: Metrics;
}

interface ImpactEvaluation {
    label: OutcomeLabel;
    label_text: string;
    plain_english_summary: string;
    reasons: string[];
    caveats: string[];
    direction: Direction;
    confidence: 'high' | 'low' | 'none';
    ads_outcome: ComponentOutcome;
    lead_outcome: ComponentOutcome;
    control_comparison: ControlAssessment;
    confounders: {
        change_history_events: Array<Record<string, any>>;
        overlapping_proposals: Array<Record<string, any>>;
        low_volume: boolean;
    };
    metrics: {
        target_baseline: Metrics;
        target_post: Metrics;
        control_baseline: Metrics;
        control_post: Metrics;
        lead_baseline: LeadQualityMetrics;
        lead_post: LeadQualityMetrics;
    };
}

function norm(value: any): string {
    return String(value || '').trim().toLowerCase();
}

function emptyMetrics(): Metrics {
    return { spend: 0, clicks: 0, impressions: 0, conversions: 0, conversionValue: 0, cpa: 0, roas: 0 };
}

function finalizeMetrics(metrics: Metrics): Metrics {
    return {
        ...metrics,
        cpa: metrics.conversions > 0 ? metrics.spend / metrics.conversions : 0,
        roas: metrics.spend > 0 ? metrics.conversionValue / metrics.spend : 0
    };
}

function recordScope(rec: any): { campaignId: string; campaignName: string; adGroupId: string; searchTerm: string; keywordText: string; criterionId: string; matchType: string; scope: string } {
    const baseline = rec.baseline_metrics || {};
    const entity = baseline.entity || {};
    const spec = rec.verification_spec || {};
    const specEntity = spec.entity || {};
    return {
        campaignId: String(entity.campaign_id || specEntity.campaign_id || rec.campaign_id || ''),
        campaignName: String(entity.campaign_name || entity.campaignName || specEntity.campaign_name || specEntity.campaignName || baseline.campaign_name || rec.campaign_name || ''),
        adGroupId: String(entity.ad_group_id || specEntity.ad_group_id || ''),
        searchTerm: String(entity.search_term || specEntity.search_term || ''),
        keywordText: String(specEntity.keyword_text || entity.keyword_text || entity.search_term || specEntity.search_term || ''),
        criterionId: String(entity.criterion_id || specEntity.criterion_id || ''),
        matchType: String(specEntity.match_type || entity.match_type || ''),
        scope: String(baseline.scope || 'campaign')
    };
}

interface ImpactReportContext {
    customerId: string;
}

function dateOnly(date: Date): string {
    return date.toISOString().slice(0, 10);
}

function impactMetricScope(rec: any): 'campaign' | 'keyword' | 'search_term' {
    const spec = rec.verification_spec || {};
    const scope = recordScope(rec);
    if (scope.scope === 'search_term' || spec.kind === 'negative_search_term_added') return 'search_term';
    if (
        scope.scope === 'keyword' ||
        spec.kind === 'keyword_added_exact' ||
        spec.kind === 'keyword_status' ||
        spec.kind === 'manual_bid_changed'
    ) {
        return 'keyword';
    }
    return 'campaign';
}

async function postMetricsForRecord(rec: any, reports: ImpactReportContext, days: number): Promise<Metrics> {
    const detectedAt = new Date(rec.detected_at);
    return windowMetricsForRecord(rec, reports, detectedAt, addDays(detectedAt, days), 'target');
}

async function preMetricsForRecord(rec: any, reports: ImpactReportContext, days: number): Promise<Metrics> {
    const detectedAt = new Date(rec.detected_at);
    return windowMetricsForRecord(rec, reports, addDays(detectedAt, -days), detectedAt, 'target');
}

async function controlPreMetricsForRecord(rec: any, reports: ImpactReportContext, days: number): Promise<Metrics> {
    const detectedAt = new Date(rec.detected_at);
    return windowMetricsForRecord(rec, reports, addDays(detectedAt, -days), detectedAt, 'control');
}

async function controlPostMetricsForRecord(rec: any, reports: ImpactReportContext, days: number): Promise<Metrics> {
    const detectedAt = new Date(rec.detected_at);
    return windowMetricsForRecord(rec, reports, detectedAt, addDays(detectedAt, days), 'control');
}

async function windowMetricsForRecord(
    rec: any,
    reports: ImpactReportContext,
    startDate: Date,
    endDate: Date,
    mode: 'target' | 'control'
): Promise<Metrics> {
    const scope = recordScope(rec);
    const metrics = await getImpactMetricWindow(pool, {
        customerId: reports.customerId,
        startDate: dateOnly(startDate),
        endDate: dateOnly(endDate),
        scope: impactMetricScope(rec),
        campaignId: scope.campaignId || null,
        adGroupId: scope.adGroupId || null,
        criterionId: scope.criterionId || null,
        keywordText: scope.keywordText || null,
        matchType: scope.matchType || null,
        searchTerm: scope.searchTerm || scope.keywordText || null,
        mode
    });
    return finalizeMetrics(metrics);
}

function leadScopeForRecord(rec: any): { campaignId: string | null; campaignName: string | null; searchTerm: string | null } {
    const scope = recordScope(rec);
    return {
        campaignId: scope.campaignId || null,
        campaignName: scope.campaignName || null,
        searchTerm: scope.searchTerm || scope.keywordText || null
    };
}

async function leadMetricsForRecord(rec: any, days: number): Promise<{ baseline: LeadQualityMetrics; post: LeadQualityMetrics; scope: any }> {
    const detectedAt = new Date(rec.detected_at);
    const baselineStart = addDays(detectedAt, -days);
    const postEnd = addDays(detectedAt, days);
    const scope = leadScopeForRecord(rec);
    const baseInput = { start: baselineStart, end: detectedAt, campaignId: scope.campaignId, campaignName: scope.campaignName, searchTerm: scope.searchTerm };
    const postInput = { start: detectedAt, end: postEnd, campaignId: scope.campaignId, campaignName: scope.campaignName, searchTerm: scope.searchTerm };
    const [baseline, post] = await Promise.all([
        getLeadQualityMetricsForWindow(pool, baseInput),
        getLeadQualityMetricsForWindow(pool, postInput)
    ]);
    return { baseline, post, scope };
}

function evaluateLeadQuality(strategyId: string, baseline: LeadQualityMetrics, post: LeadQualityMetrics, verificationSpec: any): ComponentOutcome {
    const kind = verificationSpec?.kind || '';
    const totalObserved = baseline.uniqueLeads + post.uniqueLeads;
    if (totalObserved < 3) return 'neutral_insufficient_data';

    const isPruningStrategy = strategyId.startsWith('WASTED_SPEND') || kind === 'keyword_status' || kind === 'negative_search_term_added';
    const isScaleStrategy = strategyId.startsWith('OPTIMIZATION') || strategyId.startsWith('BUDGET') || kind === 'keyword_added_exact' || kind === 'manual_bid_changed' || kind === 'target_cpa_changed' || kind === 'target_roas_changed' || kind === 'campaign_budget_changed';

    if (isPruningStrategy) {
        const baselineWasJunk = baseline.uniqueLeads >= 2 && baseline.uselessRate >= 0.5 && baseline.qualifiedPipeline === 0;
        if (baselineWasJunk && post.uniqueLeads === 0) return 'success';
        if (baselineWasJunk && post.uselessRate <= Math.max(baseline.uselessRate - 0.2, 0.2)) return 'success';
        if (post.uniqueLeads >= 2 && post.uselessRate >= 0.6 && post.qualifiedPipeline === 0) return 'failure';
        return 'neutral_insufficient_data';
    }

    if (isScaleStrategy) {
        const qualityImproved = post.qualifiedPipeline > baseline.qualifiedPipeline && post.uselessRate <= baseline.uselessRate + 0.2;
        const conversionImproved = post.converted > baseline.converted && post.uselessRate <= baseline.uselessRate + 0.2;
        if (post.uniqueLeads >= 2 && (qualityImproved || conversionImproved)) return 'success';
        if (post.uniqueLeads >= 2 && post.uselessRate > baseline.uselessRate + 0.2 && post.qualifiedPipeline <= baseline.qualifiedPipeline) return 'failure';
        return 'neutral_insufficient_data';
    }

    if (post.uniqueLeads >= 2 && post.qualifiedRate > baseline.qualifiedRate + 0.15) return 'success';
    if (post.uniqueLeads >= 2 && post.uselessRate > baseline.uselessRate + 0.2) return 'failure';
    return 'neutral_insufficient_data';
}

function evaluateAdsComponent(strategyId: string, baseline: any, post: Metrics, days: number, verificationSpec: any): ComponentOutcome {
    const baselineDays = Math.max(Number(baseline?.days || days || 30), 1);
    const expectedSpend = (Number(baseline?.spend || 0) / baselineDays) * days;
    const expectedConversions = (Number(baseline?.conversions || 0) / baselineDays) * days;
    const kind = verificationSpec?.kind || '';
    const scope = baseline?.scope || 'campaign';

    if (strategyId.startsWith('DIAGNOSE')) return 'neutral_insufficient_data';

    if (
        strategyId.startsWith('WASTED_SPEND') ||
        kind === 'keyword_status' ||
        kind === 'negative_search_term_added'
    ) {
        if (scope === 'keyword' || scope === 'search_term') {
            if (Number(baseline?.spend || 0) <= 0) return 'neutral_insufficient_data';
            const spendReduced = post.spend <= expectedSpend * 0.35;
            const conversionsPreserved = post.conversions >= expectedConversions * 0.75;
            if (spendReduced && conversionsPreserved) return 'success';
            if (post.spend >= expectedSpend * 0.8) return 'failure';
            return 'neutral_insufficient_data';
        }
        return post.spend < expectedSpend * 0.9 && post.conversions >= expectedConversions * 0.85 ? 'success' : 'failure';
    }

    if (strategyId.startsWith('OPTIMIZATION') || strategyId.startsWith('BUDGET') || kind === 'keyword_added_exact' || kind === 'manual_bid_changed' || kind === 'target_cpa_changed' || kind === 'target_roas_changed' || kind === 'campaign_budget_changed') {
        if (post.spend <= 0 && post.conversions <= 0) return 'neutral_insufficient_data';
        const baselineRoas = Number(baseline?.roas || 0);
        const improvedRoas = baselineRoas > 0 && post.roas > baselineRoas * 1.1;
        const improvedConv = post.conversions > expectedConversions * 1.1;
        return improvedRoas || improvedConv ? 'success' : 'failure';
    }
    if (strategyId.startsWith('TRACKING_ISSUE') || strategyId.startsWith('TRACKING_RISK')) {
        if (post.spend <= 0 && post.conversions <= 0) return 'neutral_insufficient_data';
        return post.conversions > expectedConversions || (Number(baseline?.conversions || 0) === 0 && post.conversions > 0) ? 'success' : 'failure';
    }
    return 'neutral_insufficient_data';
}

function addDays(date: Date, days: number): Date {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
}

function pctChange(before: number, after: number): number {
    if (!Number.isFinite(before) || !Number.isFinite(after)) return 0;
    if (before <= 0) return after > 0 ? 1 : 0;
    return (after - before) / before;
}

function metricChanges(before: Metrics, after: Metrics): MetricChanges {
    return {
        spend_change: pctChange(before.spend, after.spend),
        clicks_change: pctChange(before.clicks, after.clicks),
        conversions_change: pctChange(before.conversions, after.conversions),
        cpa_change: before.cpa > 0 && after.cpa > 0 ? pctChange(before.cpa, after.cpa) : null,
        roas_change: before.roas > 0 && after.roas > 0 ? pctChange(before.roas, after.roas) : null
    };
}

function pctText(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return 'not enough data';
    const sign = value > 0 ? '+' : '';
    return `${sign}${(value * 100).toFixed(0)}%`;
}

function isPruningStrategy(strategyId: string, verificationSpec: any): boolean {
    const kind = verificationSpec?.kind || '';
    return strategyId.startsWith('WASTED_SPEND') || kind === 'keyword_status' || kind === 'negative_search_term_added';
}

function isScaleStrategy(strategyId: string, verificationSpec: any): boolean {
    const kind = verificationSpec?.kind || '';
    return strategyId.startsWith('OPTIMIZATION') || strategyId.startsWith('BUDGET') || kind === 'keyword_added_exact' || kind === 'manual_bid_changed' || kind === 'target_cpa_changed' || kind === 'target_roas_changed' || kind === 'campaign_budget_changed';
}

function assessControls(strategyId: string, verificationSpec: any, targetPre: Metrics, targetPost: Metrics, controlPre: Metrics, controlPost: Metrics): ControlAssessment {
    const target = metricChanges(targetPre, targetPost);
    const control = metricChanges(controlPre, controlPost);
    const available = (controlPre.clicks + controlPost.clicks >= 20) || (controlPre.spend + controlPost.spend >= 500);
    let direction: ControlAssessment['direction'] = available ? 'none' : 'none';
    let summary = available
        ? 'Compared this change against similar unchanged traffic in the same period.'
        : 'No meaningful comparison group was available, so confidence is lower.';

    if (available && isPruningStrategy(strategyId, verificationSpec)) {
        const targetSpendDroppedMore = target.spend_change <= control.spend_change - 0.2;
        const conversionsNotHarmed = target.conversions_change >= control.conversions_change - 0.25;
        const spendNotReduced = target.spend_change >= control.spend_change - 0.05;
        if (targetSpendDroppedMore && conversionsNotHarmed) {
            direction = 'positive';
            summary = `The changed item cut spend more than similar unchanged traffic (${pctText(target.spend_change)} vs ${pctText(control.spend_change)}) without a clear conversion drop.`;
        } else if (spendNotReduced || target.conversions_change < control.conversions_change - 0.4) {
            direction = 'negative';
            summary = `The changed item did not reduce waste clearly versus similar unchanged traffic, or conversions fell more than the comparison group.`;
        } else {
            direction = 'mixed';
            summary = 'The changed item moved in the right direction, but the comparison group makes the impact unclear.';
        }
    } else if (available && (isScaleStrategy(strategyId, verificationSpec) || strategyId.startsWith('TRACKING_ISSUE') || strategyId.startsWith('TRACKING_RISK'))) {
        const convBeatControl = target.conversions_change >= control.conversions_change + 0.1;
        const roasBeatControl = target.roas_change !== null && control.roas_change !== null && target.roas_change >= control.roas_change + 0.1;
        const convLaggedControl = target.conversions_change <= control.conversions_change - 0.25;
        const roasLaggedControl = target.roas_change !== null && control.roas_change !== null && target.roas_change <= control.roas_change - 0.1;
        if (convBeatControl || roasBeatControl) {
            direction = 'positive';
            summary = `The changed item improved more than similar unchanged traffic. Conversions changed ${pctText(target.conversions_change)} vs ${pctText(control.conversions_change)} for the comparison group.`;
        } else if (convLaggedControl && (roasLaggedControl || target.roas_change === null || control.roas_change === null)) {
            direction = 'negative';
            summary = `The changed item lagged similar unchanged traffic. Conversions changed ${pctText(target.conversions_change)} vs ${pctText(control.conversions_change)} for the comparison group.`;
        } else {
            direction = 'mixed';
            summary = 'The changed item did not clearly beat or trail the comparison group.';
        }
    }

    return {
        available,
        direction,
        summary,
        target_change: target,
        control_change: control,
        target_baseline: targetPre,
        target_post: targetPost,
        control_baseline: controlPre,
        control_post: controlPost
    };
}

function eventPayloadValue(event: ChangeHistoryEvent, suffixes: string[]): string {
    const entries = Object.entries(event.payload || {});
    for (const suffix of suffixes) {
        const found = entries.find(([key, value]) => key.endsWith(suffix) && value != null && String(value).trim() !== '');
        if (found) return String(found[1]);
    }
    return '';
}

function eventDate(event: ChangeHistoryEvent): Date {
    return new Date(String(event.change_date_time).replace(' ', 'T'));
}

function eventNearDetectedAt(event: ChangeHistoryEvent, detectedAt: Date): boolean {
    const diffDays = Math.abs(eventDate(event).getTime() - detectedAt.getTime()) / 86400000;
    return diffDays <= 7;
}

function eventMatchesExpectedImplementation(event: ChangeHistoryEvent, rec: any): boolean {
    const spec = rec.verification_spec || {};
    const entity = spec.entity || {};
    const expected = spec.expected || {};
    const detectedAt = new Date(rec.detected_at);
    if (!eventNearDetectedAt(event, detectedAt)) return false;

    const fields = event.changed_fields.map(field => field.toLowerCase());
    const resourceType = String(event.resource_type || '').toUpperCase();
    const operation = String(event.operation || '').toUpperCase();
    const eventText = norm(eventPayloadValue(event, [
        'keyword.text',
        'campaign_criterion.keyword.text',
        'ad_group_criterion.keyword.text'
    ]));
    const expectedText = norm(entity.search_term || entity.keyword_text || entity.keywordText);
    const eventCriterionId = eventPayloadValue(event, ['criterion_id', 'criterionId']);
    const expectedCriterionId = String(entity.criterion_id || '');

    if (spec.kind === 'campaign_budget_changed') {
        return resourceType === 'CAMPAIGN_BUDGET' && fields.some(field => field.includes('amount'));
    }
    if (spec.kind === 'target_cpa_changed') {
        return resourceType === 'CAMPAIGN' && fields.some(field => field.includes('targetcpa') || field.includes('maximizeconversions'));
    }
    if (spec.kind === 'target_roas_changed') {
        return resourceType === 'CAMPAIGN' && fields.some(field => field.includes('targetroas') || field.includes('maximizeconversionvalue'));
    }
    if (spec.kind === 'campaign_status') {
        return resourceType === 'CAMPAIGN' && fields.some(field => field.includes('status'));
    }
    if (spec.kind === 'keyword_status') {
        const sameEntity = expectedCriterionId ? eventCriterionId === expectedCriterionId : Boolean(expectedText && eventText === expectedText);
        return resourceType === 'AD_GROUP_CRITERION' && sameEntity && fields.some(field => field.includes('status'));
    }
    if (spec.kind === 'manual_bid_changed') {
        const sameEntity = expectedCriterionId ? eventCriterionId === expectedCriterionId : Boolean(expectedText && eventText === expectedText);
        return resourceType === 'AD_GROUP_CRITERION' && sameEntity && fields.some(field => field.includes('bid') || field.includes('cpc'));
    }
    if (spec.kind === 'keyword_added_exact') {
        const matchType = eventPayloadValue(event, ['keyword.match_type', 'keyword.matchType']);
        return resourceType === 'AD_GROUP_CRITERION'
            && operation === 'CREATE'
            && Boolean(expectedText && eventText === expectedText)
            && String(matchType || expected.match_type || '').toUpperCase() === 'EXACT';
    }
    if (spec.kind === 'negative_search_term_added') {
        const negative = eventPayloadValue(event, ['negative']);
        return (resourceType === 'CAMPAIGN_CRITERION' || resourceType === 'AD_GROUP_CRITERION')
            && operation === 'CREATE'
            && Boolean(expectedText && eventText === expectedText)
            && String(negative).toLowerCase() === 'true';
    }
    return false;
}

function isMaterialChangeEvent(event: ChangeHistoryEvent): boolean {
    const resourceType = String(event.resource_type || '').toUpperCase();
    const operation = String(event.operation || '').toUpperCase();
    const fields = event.changed_fields.join(',').toLowerCase();
    if (['CREATE', 'REMOVE'].includes(operation)) {
        return ['CAMPAIGN', 'AD_GROUP', 'AD_GROUP_CRITERION', 'CAMPAIGN_CRITERION', 'CAMPAIGN_BUDGET', 'AD', 'AD_GROUP_AD'].includes(resourceType);
    }
    return [
        'status',
        'amount',
        'budget',
        'targetcpa',
        'targetroas',
        'maximizeconversions',
        'maximizeconversionvalue',
        'cpc',
        'bid',
        'finalurl',
        'final_urls',
        'keyword.text',
        'keyword.matchtype',
        'negative',
        'biddingstrategy'
    ].some(token => fields.includes(token.toLowerCase()));
}

function eventPlainSummary(event: ChangeHistoryEvent): string {
    const resourceType = String(event.resource_type || 'change').replace(/_/g, ' ').toLowerCase();
    const operation = String(event.operation || 'updated').toLowerCase();
    const fields = event.changed_fields.slice(0, 4).join(', ');
    const dateText = String(event.change_date_time || '').slice(0, 10);
    return `${operation} ${resourceType}${fields ? ` (${fields})` : ''} on ${dateText}`;
}

async function confoundingChangeEvents(rec: any, days: number): Promise<Array<Record<string, any>>> {
    const scope = recordScope(rec);
    const detectedAt = new Date(rec.detected_at);
    const start = addDays(detectedAt, -7);
    const end = addDays(detectedAt, days);
    const events = await getChangeHistoryEvents(pool, {
        start,
        end,
        campaignId: scope.campaignId || null,
        adGroupId: scope.adGroupId || null
    });
    return events
        .filter(event => isMaterialChangeEvent(event))
        .filter(event => !eventMatchesExpectedImplementation(event, rec))
        .slice(0, 12)
        .map(event => ({
            event_uid: event.event_uid,
            change_date_time: event.change_date_time,
            campaign_id: event.campaign_id,
            ad_group_id: event.ad_group_id,
            resource_type: event.resource_type,
            operation: event.operation,
            changed_fields: event.changed_fields,
            client_type: event.client_type,
            summary: eventPlainSummary(event)
        }));
}

function overlappingProposalRows(rec: any, allRows: any[], days: number): Array<Record<string, any>> {
    const detectedAt = new Date(rec.detected_at);
    const end = addDays(detectedAt, days);
    const campaignId = String(rec.campaign_id || '');
    if (!campaignId) return [];
    return allRows
        .filter(row => row.option_uid !== rec.option_uid)
        .filter(row => String(row.campaign_id || '') === campaignId)
        .filter(row => {
            const otherDate = new Date(row.detected_at);
            return otherDate >= detectedAt && otherDate < end;
        })
        .slice(0, 10)
        .map(row => ({
            option_uid: row.option_uid,
            proposal_id: row.proposal_id,
            detected_at: row.detected_at,
            tracking_status: row.tracking_status
        }));
}

function componentDirection(adsOutcome: ComponentOutcome, leadOutcome: ComponentOutcome): Direction | 'mixed' {
    if (adsOutcome !== 'neutral_insufficient_data' && leadOutcome !== 'neutral_insufficient_data' && adsOutcome !== leadOutcome) return 'mixed';
    if (leadOutcome !== 'neutral_insufficient_data') return leadOutcome;
    if (adsOutcome !== 'neutral_insufficient_data') return adsOutcome;
    return 'neutral';
}

function labelText(label: OutcomeLabel): string {
    return label.replace(/_/g, ' ');
}

function lowVolume(targetPre: Metrics, targetPost: Metrics, leadBaseline: LeadQualityMetrics, leadPost: LeadQualityMetrics): boolean {
    const clicks = targetPre.clicks + targetPost.clicks;
    const spend = targetPre.spend + targetPost.spend;
    const conversions = targetPre.conversions + targetPost.conversions;
    const leads = leadBaseline.uniqueLeads + leadPost.uniqueLeads;
    return clicks < 20 && spend < 500 && conversions < 2 && leads < 3;
}

function baselineForAdsEvaluation(rec: any, targetPre: Metrics, days: number): any {
    if (targetPre.spend > 0 || targetPre.clicks > 0 || targetPre.impressions > 0) {
        return {
            ...(rec.baseline_metrics || {}),
            spend: targetPre.spend,
            clicks: targetPre.clicks,
            impressions: targetPre.impressions,
            conversions: targetPre.conversions,
            conversionValue: targetPre.conversionValue,
            cpa: targetPre.cpa,
            roas: targetPre.roas,
            days
        };
    }
    return rec.baseline_metrics || {};
}

function buildImpactEvaluation(input: {
    rec: any;
    days: number;
    adsOutcome: ComponentOutcome;
    leadOutcome: ComponentOutcome;
    leadMetrics: { baseline: LeadQualityMetrics; post: LeadQualityMetrics; scope: any };
    control: ControlAssessment;
    confoundingEvents: Array<Record<string, any>>;
    overlappingProposals: Array<Record<string, any>>;
    sourceIssues: string[];
}): ImpactEvaluation {
    const { rec, adsOutcome, leadOutcome, leadMetrics, control, confoundingEvents, overlappingProposals, sourceIssues } = input;
    const caveats: string[] = [];
    const reasons: string[] = [];
    const hasConfounders = confoundingEvents.length > 0 || overlappingProposals.length > 0 || sourceIssues.length > 0;
    const isLowVolume = lowVolume(control.target_baseline, control.target_post, leadMetrics.baseline, leadMetrics.post);
    const direction = componentDirection(adsOutcome, leadOutcome);

    reasons.push(control.summary);
    if (leadOutcome !== 'neutral_insufficient_data') {
        reasons.push(`Lead quality also pointed to ${leadOutcome.replace(/_/g, ' ')}.`);
    } else {
        caveats.push('There was not enough reviewed first-party lead volume to use lead quality strongly.');
    }
    if (isLowVolume) {
        caveats.push('Traffic volume was low, so a few clicks or leads can swing the result.');
    }
    if (!control.available) {
        caveats.push('There was no strong comparison group of similar unchanged traffic.');
    }
    if (confoundingEvents.length > 0) {
        caveats.push(`Other Google Ads changes were detected in the same measurement window: ${confoundingEvents.slice(0, 3).map(event => event.summary).join('; ')}.`);
    }
    if (overlappingProposals.length > 0) {
        caveats.push(`${overlappingProposals.length} other tracked proposal change(s) touched the same campaign during this window.`);
    }
    if (sourceIssues.length > 0) {
        caveats.push(`Required verification data was missing or stale: ${sourceIssues.join(', ')}.`);
    }

    let label: OutcomeLabel;
    let plain: string;
    let finalDirection: Direction = 'neutral';
    let confidence: ImpactEvaluation['confidence'] = 'none';

    if (hasConfounders) {
        label = 'neutral_confounded';
        plain = sourceIssues.length > 0
            ? 'Cannot fairly credit or blame this one change because required verification data was missing or stale.'
            : 'Cannot fairly credit or blame this one change because other relevant changes happened in the same campaign during the measurement window.';
        reasons.push('The system excludes this result from recommendation-eligible priors so one noisy window does not distort future recommendations.');
    } else if (direction === 'mixed' || control.direction === 'mixed') {
        label = 'neutral_mixed';
        plain = 'The evidence points in different directions, so this is not a clean win or loss.';
        reasons.push('Mixed signals are kept out of the win/loss priors.');
    } else if (direction === 'neutral') {
        label = 'neutral_insufficient_data';
        plain = 'There was not enough reliable activity after the change to judge the result.';
        reasons.push('The system needs enough spend, clicks, conversions, or reviewed leads before it learns from an outcome.');
    } else {
        finalDirection = direction;
        const highConfidence = control.available
            && !isLowVolume
            && ((direction === 'success' && control.direction === 'positive') || (direction === 'failure' && control.direction === 'negative'));
        confidence = highConfidence ? 'high' : 'low';
        label = direction === 'success'
            ? highConfidence ? 'success_high_confidence' : 'success_low_confidence'
            : highConfidence ? 'failure_high_confidence' : 'failure_low_confidence';
        plain = direction === 'success'
            ? highConfidence
                ? 'The changed item improved and beat similar unchanged traffic, with no major conflicting signals.'
                : 'The result looks positive, but confidence is low because the comparison or volume was not strong enough.'
            : highConfidence
                ? 'The changed item worsened and underperformed similar unchanged traffic, with no major conflicting signals.'
                : 'The result looks negative, but confidence is low because the comparison or volume was not strong enough.';
        reasons.push(highConfidence
            ? 'Because the changed item moved differently from similar unchanged traffic, the score is stronger than a simple before/after check.'
            : 'The system labels this as low confidence instead of treating it as a clean result.');
    }

    return {
        label,
        label_text: labelText(label),
        plain_english_summary: plain,
        reasons,
        caveats,
        direction: finalDirection,
        confidence,
        ads_outcome: adsOutcome,
        lead_outcome: leadOutcome,
        control_comparison: control,
        confounders: {
            change_history_events: confoundingEvents,
            overlapping_proposals: overlappingProposals,
            low_volume: isLowVolume
        },
        metrics: {
            target_baseline: control.target_baseline,
            target_post: control.target_post,
            control_baseline: control.control_baseline,
            control_post: control.control_post,
            lead_baseline: leadMetrics.baseline,
            lead_post: leadMetrics.post
        }
    };
}

async function latestDecisionSourceIssues(filters: DashboardFilters): Promise<string[]> {
    try {
        const payload = await buildDashboardPayload(pool, filters);
        const sourceCoverage = payload.sourceCoverage || {};
        const direct = [
            ...(Array.isArray(sourceCoverage.missingSources) ? sourceCoverage.missingSources : []),
            ...(Array.isArray(sourceCoverage.staleSources) ? sourceCoverage.staleSources : []),
            ...(Array.isArray(sourceCoverage.failedSources) ? sourceCoverage.failedSources : [])
        ];
        const refreshFailed = sourceCoverage.refreshRun?.source_summary?.failedReports || [];
        return Array.from(new Set([...direct, ...(Array.isArray(refreshFailed) ? refreshFailed : [])].map(String).filter(Boolean)));
    } catch {
        return [];
    }
}

function requiredSourceIssuesForRecord(rec: any, allIssues: string[]): string[] {
    const kind = rec.verification_spec?.kind || '';
    const issueSet = new Set(allIssues.map(issue => issue.replace(/_/g, '-')));
    const required = kind === 'negative_search_term_added'
        ? ['campaign-negatives', 'ad-group-negatives', 'account-negatives', 'shared-negative-criteria', 'campaign-shared-sets']
        : kind === 'keyword_added_exact' || kind === 'keyword_status' || kind === 'manual_bid_changed'
            ? ['configured-keywords']
            : [];
    return required.filter(source => issueSet.has(source));
}

async function evaluateRecord(rec: any, reports: ImpactReportContext, days: number, allImpactRows: any[], sourceIssues: string[]): Promise<ImpactEvaluation> {
    const [targetPre, targetPost, controlPre, controlPost] = await Promise.all([
        preMetricsForRecord(rec, reports, days),
        postMetricsForRecord(rec, reports, days),
        controlPreMetricsForRecord(rec, reports, days),
        controlPostMetricsForRecord(rec, reports, days)
    ]);
    const baseline = baselineForAdsEvaluation(rec, targetPre, days);
    const adsOutcome = evaluateAdsComponent(rec.strategy_id, baseline, targetPost, days, rec.verification_spec);
    const leadMetrics = await leadMetricsForRecord(rec, days);
    const leadOutcome = evaluateLeadQuality(rec.strategy_id, leadMetrics.baseline, leadMetrics.post, rec.verification_spec);
    const control = assessControls(rec.strategy_id, rec.verification_spec, targetPre, targetPost, controlPre, controlPost);
    const confoundingEvents = await confoundingChangeEvents(rec, days);
    const overlaps = overlappingProposalRows(rec, allImpactRows, days);
    const requiredSourceIssues = requiredSourceIssuesForRecord(rec, sourceIssues);
    return buildImpactEvaluation({
        rec,
        days,
        adsOutcome,
        leadOutcome,
        leadMetrics,
        control,
        confoundingEvents,
        overlappingProposals: overlaps,
        sourceIssues: requiredSourceIssues
    });
}

async function run() {
    console.log('Running impact evaluator...');
    if (!process.env.DATABASE_URL) {
        console.log('No DATABASE_URL configured; skipping impact evaluation.');
        return;
    }
    await ensureDatabaseSchema(pool);
    await ensureLeadSchema(pool);
    await ensureAdsWarehouseSchema(pool);

    const { rows: records } = await pool.query(
        `SELECT option_uid, option_id, proposal_id, detected_at, campaign_id, strategy_id, verification_spec, baseline_metrics, tracking_status
         FROM impact_tracking
         WHERE tracking_status IN ('pending_14', 'pending_30')`
    );
    if (records.length === 0) {
        console.log('No pending impact evaluations.');
        return;
    }

    const { rows: allImpactRows } = await pool.query(
        `SELECT option_uid, proposal_id, campaign_id, detected_at, tracking_status
         FROM impact_tracking
         WHERE campaign_id IS NOT NULL`
    );

    const filters = await resolveDashboardFilters(pool, {});
    const reports = { customerId: filters.customerId };
    const sourceIssues = await latestDecisionSourceIssues(filters);

    const now = new Date();
    for (const rec of records) {
        const detectedAt = new Date(rec.detected_at);
        const ageDays = Math.floor((now.getTime() - detectedAt.getTime()) / 86400000);

        if (rec.tracking_status === 'pending_14' && ageDays >= 14) {
            const evaluation = await evaluateRecord(rec, reports, 14, allImpactRows, sourceIssues);
            await pool.query(
                `UPDATE impact_tracking
                 SET tracking_status = 'pending_30',
                     outcome_14 = $2,
                     lead_outcome_14 = $3,
                     lead_metrics_14 = $4,
                     outcome_details_14 = $5
                 WHERE option_uid = $1`,
                [
                    rec.option_uid,
                    evaluation.label,
                    evaluation.lead_outcome,
                    {
                        baseline: evaluation.metrics.lead_baseline,
                        post: evaluation.metrics.lead_post,
                        scope: leadScopeForRecord(rec),
                        adsOutcome: evaluation.ads_outcome
                    },
                    evaluation
                ]
            );
            if (rec.proposal_id) {
                await pool.query(
                    `UPDATE proposals
                     SET status = 'monitoring_30',
                         payload = jsonb_set(payload, '{status}', '"monitoring_30"'::jsonb),
                         updated_at = CURRENT_TIMESTAMP
                     WHERE proposal_id = $1`,
                    [rec.proposal_id]
                );
                await pool.query(
                    `INSERT INTO proposal_events (proposal_id, event_type, payload) VALUES ($1, 'impact_evaluated_14', $2)`,
                    [rec.proposal_id, evaluation]
                );
            }
        }

        if (rec.tracking_status === 'pending_30' && ageDays >= 30) {
            const evaluation = await evaluateRecord(rec, reports, 30, allImpactRows, sourceIssues);
            await pool.query(
                `UPDATE impact_tracking
                 SET tracking_status = 'completed',
                     outcome_30 = $2,
                     lead_outcome_30 = $3,
                     lead_metrics_30 = $4,
                     outcome_details_30 = $5
                 WHERE option_uid = $1`,
                [
                    rec.option_uid,
                    evaluation.label,
                    evaluation.lead_outcome,
                    {
                        baseline: evaluation.metrics.lead_baseline,
                        post: evaluation.metrics.lead_post,
                        scope: leadScopeForRecord(rec),
                        adsOutcome: evaluation.ads_outcome
                    },
                    evaluation
                ]
            );
            if (rec.proposal_id) {
                await pool.query(
                    `UPDATE proposals
                     SET status = 'completed',
                         payload = jsonb_set(payload, '{status}', '"completed"'::jsonb),
                         updated_at = CURRENT_TIMESTAMP
                     WHERE proposal_id = $1`,
                    [rec.proposal_id]
                );
                await pool.query(
                    `INSERT INTO proposal_events (proposal_id, event_type, payload) VALUES ($1, 'impact_evaluated_30', $2)`,
                    [rec.proposal_id, evaluation]
                );
            }
        }
    }
    console.log('Impact evaluation complete.');
}

run()
    .catch(err => {
        console.error('Fatal error in impact evaluator:', err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
