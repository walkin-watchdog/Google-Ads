import dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { ensureDatabaseSchema, normalizeVerificationSpec, VerificationSpec } from '../lib/proposals';
import {
    configuredKeywordRuleFromReportRow,
    decisionContextForTerm,
    matchNegativeCoverage,
    normalizeNegativeRulesFromReports,
    type ConfiguredKeywordRule,
    type NegativeRule
} from '../lib/decisionContext';

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'latest');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

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
    try {
        const file = path.join(DATA_DIR, `${name}.json`);
        if (!fs.existsSync(file)) return [];
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return normalizeData(Array.isArray(raw) ? raw : []);
    } catch {
        return [];
    }
}

function readRawReport(name: string): any[] {
    try {
        const file = path.join(DATA_DIR, `${name}.json`);
        if (!fs.existsSync(file)) return [];
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(raw) ? raw : [];
    } catch {
        return [];
    }
}

function moneyMicros(v: any): number {
    return Number(v || 0) / 1_000_000;
}

function campaignBaseline(rows: any[], campaignId: string): any {
    let spend = 0;
    let conversions = 0;
    let conversionValue = 0;
    let minDate = '9999-12-31';
    let maxDate = '0000-00-00';
    for (const row of rows) {
        if (String(row.campaign?.id || '') !== String(campaignId)) continue;
        spend += moneyMicros(row.metrics?.costMicros);
        conversions += Number(row.metrics?.conversions || 0);
        conversionValue += Number(row.metrics?.conversionsValue || 0);
        const d = row.segments?.date;
        if (d) {
            if (d < minDate) minDate = d;
            if (d > maxDate) maxDate = d;
        }
    }
    const days = minDate !== '9999-12-31' && maxDate !== '0000-00-00'
        ? Math.max(1, Math.floor((new Date(maxDate).getTime() - new Date(minDate).getTime()) / 86400000) + 1)
        : 30;
    return {
        spend,
        conversions,
        conversionValue,
        cpa: conversions > 0 ? spend / conversions : 0,
        roas: spend > 0 ? conversionValue / spend : 0,
        days,
        start: minDate === '9999-12-31' ? null : minDate,
        end: maxDate === '0000-00-00' ? null : maxDate
    };
}

function selectedOption(payload: any): any | null {
    if (!payload || !Array.isArray(payload.options)) return null;
    if (payload.selected_option_id) {
        return payload.options.find((opt: any) => opt.option_id === payload.selected_option_id) || null;
    }
    return payload.options.length === 1 ? payload.options[0] : null;
}

function norm(v: any): string {
    return String(v || '').trim().toLowerCase();
}

function compareValue(current: number | null, expected: Record<string, any>): boolean {
    if (current === null || !Number.isFinite(current)) return false;
    const comparison = String(expected.comparison || 'eq').toLowerCase();
    const value = expected.value_micros ?? expected.value;
    const previousValue = expected.previous_value_micros ?? expected.previous_value;
    if (comparison === 'changed') {
        return previousValue !== undefined && previousValue !== null && current !== Number(previousValue);
    }
    if (value === undefined || value === null) return false;
    const target = Number(value);
    if (!Number.isFinite(target)) return false;
    if (comparison === 'gte') return current >= target;
    if (comparison === 'lte') return current <= target;
    return current === target;
}

function buildCurrentState(keywordData: any[], configuredKeywordData: ConfiguredKeywordRule[], campaignData: any[], searchTermData: any[], negativeRules: NegativeRule[]) {
    const campaigns: Record<string, any> = {};
    for (const row of campaignData) {
        const id = String(row.campaign?.id || '');
        if (!id) continue;
        campaigns[id] = {
            id,
            name: row.campaign?.name,
            status: row.campaign?.status,
            biddingStrategy: row.campaign?.biddingStrategyType || 'UNKNOWN',
            budgetMicros: row.campaignBudget?.amountMicros == null ? null : Number(row.campaignBudget.amountMicros),
            budget: row.campaignBudget?.amountMicros ? moneyMicros(row.campaignBudget.amountMicros) : null,
            targetCpaMicros: row.campaign?.targetCpa?.targetCpaMicros != null
                ? Number(row.campaign.targetCpa.targetCpaMicros)
                : row.campaign?.maximizeConversions?.targetCpaMicros != null
                    ? Number(row.campaign.maximizeConversions.targetCpaMicros)
                    : null,
            targetCpa: row.campaign?.targetCpa?.targetCpaMicros ? moneyMicros(row.campaign.targetCpa.targetCpaMicros) : row.campaign?.maximizeConversions?.targetCpaMicros ? moneyMicros(row.campaign.maximizeConversions.targetCpaMicros) : null,
            targetRoas: row.campaign?.targetRoas?.targetRoas || row.campaign?.maximizeConversionValue?.targetRoas || null
        };
    }

    const keywords: Record<string, any> = {};
    for (const row of configuredKeywordData) {
        const campaignId = String(row.campaignId || '');
        const adGroupId = String(row.adGroupId || '');
        const criterionId = String(row.criterionId || '');
        const text = String(row.keywordText || row.keyword || '');
        const matchType = String(row.matchType || '');
        const obj = { campaignId, adGroupId, criterionId, text, matchType, status: row.status, bidMicros: null, biddingStrategy: campaigns[campaignId]?.biddingStrategy || 'UNKNOWN', source: 'configured_keywords' };
        if (criterionId) keywords[`criterion:${campaignId}|${adGroupId}|${criterionId}`] = obj;
        keywords[`text:${campaignId}|${norm(text)}`] = obj;
        keywords[`textmatch:${campaignId}|${norm(text)}|${matchType}`] = obj;
    }
    for (const row of keywordData) {
        const campaignId = String(row.campaign?.id || '');
        const adGroupId = String(row.adGroup?.id || '');
        const criterionId = String(row.adGroupCriterion?.criterionId || '');
        const text = String(row.adGroupCriterion?.keyword?.text || '');
        const matchType = String(row.adGroupCriterion?.keyword?.matchType || '');
        const obj = { campaignId, adGroupId, criterionId, text, matchType, status: row.adGroupCriterion?.status, bidMicros: row.adGroupCriterion?.cpcBidMicros == null ? null : Number(row.adGroupCriterion.cpcBidMicros), biddingStrategy: row.campaign?.biddingStrategyType || campaigns[campaignId]?.biddingStrategy || 'UNKNOWN', source: 'keyword_performance' };
        if (criterionId) keywords[`criterion:${campaignId}|${adGroupId}|${criterionId}`] = obj;
        keywords[`text:${campaignId}|${norm(text)}`] = obj;
        keywords[`textmatch:${campaignId}|${norm(text)}|${matchType}`] = obj;
    }

    const searchTerms: Record<string, any> = {};
    for (const row of searchTermData) {
        const campaignId = String(row.campaign?.id || '');
        const adGroupId = String(row.adGroup?.id || '');
        const term = String(row.searchTermView?.searchTerm || '');
        const obj = { campaignId, adGroupId, term, status: row.searchTermView?.status };
        searchTerms[`${campaignId}|${adGroupId}|${norm(term)}`] = obj;
        searchTerms[`${campaignId}|${norm(term)}`] = obj;
        searchTerms[norm(term)] = obj;
    }
    return { campaigns, keywords, searchTerms, negativeRules, configuredKeywords: configuredKeywordData };
}

async function latestDashboardDecisionSnapshot(): Promise<Record<string, any> | null> {
    try {
        const { rows } = await pool.query(`SELECT payload FROM dashboard_payloads WHERE id = 'latest'`);
        const payload = rows[0]?.payload || null;
        if (!payload) return null;
        return {
            meta: payload.meta || null,
            decisionContext: payload.decisionContext || null,
            sourceCoverage: payload.sourceCoverage || null,
            generatedAt: payload.meta?.generatedAt || payload.decisionContext?.generatedAt || null
        };
    } catch {
        return null;
    }
}

function termDecisionContextForSpec(spec: VerificationSpec, state: ReturnType<typeof buildCurrentState>): Record<string, any> | null {
    const entity = spec.entity || {};
    const term = String(entity.search_term || entity.keyword_text || '').trim();
    if (!term) return null;
    return decisionContextForTerm(term, {
        campaignId: entity.campaign_id || null,
        adGroupId: entity.ad_group_id || null
    }, state.negativeRules, state.configuredKeywords);
}

function baselineDecisionContext(
    spec: VerificationSpec,
    state: ReturnType<typeof buildCurrentState>,
    result: { reason: string },
    latestDecisionSnapshot: Record<string, any> | null
): Record<string, any> {
    return {
        verification_kind: spec.kind,
        verification_reason: result.reason,
        termDecisionContext: termDecisionContextForSpec(spec, state),
        accountDecisionSummary: latestDecisionSnapshot?.decisionContext || null,
        sourceCoverage: latestDecisionSnapshot?.sourceCoverage || null,
        dashboardGeneratedAt: latestDecisionSnapshot?.generatedAt || null,
        configured_keyword_count: state.configuredKeywords.length,
        negative_rule_count: state.negativeRules.length
    };
}

function verify(spec: VerificationSpec, state: ReturnType<typeof buildCurrentState>): { implemented: boolean; campaignId: string; biddingStrategy: string; reason: string } {
    if (!spec?.observable || spec.kind === 'diagnosis_only') {
        return { implemented: false, campaignId: '', biddingStrategy: 'UNKNOWN', reason: 'not_observable' };
    }
    const entity = spec.entity || {};
    const expected = spec.expected || {};

    if (spec.kind === 'campaign_status') {
        const campaignId = String(entity.campaign_id || '');
        const campaign = state.campaigns[campaignId];
        return {
            implemented: Boolean(campaign && expected.status && campaign.status === expected.status),
            campaignId,
            biddingStrategy: campaign?.biddingStrategy || 'UNKNOWN',
            reason: `campaign_status:${campaign?.status || 'missing'}`
        };
    }

    if (spec.kind === 'keyword_status') {
        const campaignId = String(entity.campaign_id || '');
        const adGroupId = String(entity.ad_group_id || '');
        const criterionId = String(entity.criterion_id || '');
        const keywordText = String(entity.keyword_text || '');
        const matchType = String(entity.match_type || '');
        const current = criterionId
            ? state.keywords[`criterion:${campaignId}|${adGroupId}|${criterionId}`]
            : state.keywords[`textmatch:${campaignId}|${norm(keywordText)}|${matchType}`] || state.keywords[`text:${campaignId}|${norm(keywordText)}`];
        return {
            implemented: Boolean(current && expected.status && current.status === expected.status),
            campaignId: current?.campaignId || campaignId,
            biddingStrategy: current?.biddingStrategy || 'UNKNOWN',
            reason: `keyword_status:${current?.status || 'missing'}`
        };
    }

    if (spec.kind === 'manual_bid_changed') {
        const campaignId = String(entity.campaign_id || '');
        const adGroupId = String(entity.ad_group_id || '');
        const criterionId = String(entity.criterion_id || '');
        const keywordText = String(entity.keyword_text || '');
        const matchType = String(entity.match_type || '');
        const current = criterionId
            ? state.keywords[`criterion:${campaignId}|${adGroupId}|${criterionId}`]
            : state.keywords[`textmatch:${campaignId}|${norm(keywordText)}|${matchType}`] || state.keywords[`text:${campaignId}|${norm(keywordText)}`];
        const currentBid = current?.bidMicros === undefined || current?.bidMicros === null ? null : Number(current.bidMicros);
        const implemented = Boolean(current && compareValue(currentBid, expected));
        return {
            implemented,
            campaignId: current?.campaignId || campaignId,
            biddingStrategy: current?.biddingStrategy || 'UNKNOWN',
            reason: `manual_bid:${currentBid ?? 'missing'}`
        };
    }

    if (spec.kind === 'keyword_added_exact') {
        const campaignId = String(entity.campaign_id || '');
        const text = String(entity.keyword_text || '');
        const current = state.keywords[`textmatch:${campaignId}|${norm(text)}|EXACT`] || state.keywords[`text:${campaignId}|${norm(text)}`];
        return {
            implemented: Boolean(current && current.matchType === expected.match_type && current.status === expected.status),
            campaignId: current?.campaignId || campaignId,
            biddingStrategy: current?.biddingStrategy || 'UNKNOWN',
            reason: `keyword_added_exact:${current?.status || 'missing'}`
        };
    }

    if (spec.kind === 'negative_search_term_added') {
        const campaignId = String(entity.campaign_id || '');
        const adGroupId = String(entity.ad_group_id || '');
        const term = String(entity.search_term || '');
        const coverage = matchNegativeCoverage(term, { campaignId, adGroupId }, state.negativeRules);
        if (coverage.isNegativeCovered) {
            return {
                implemented: true,
                campaignId,
                biddingStrategy: state.campaigns[campaignId]?.biddingStrategy || 'UNKNOWN',
                reason: `negative_criteria:${coverage.negativeCoverageSource}:${coverage.negativeCoverageKeyword}:${coverage.negativeCoverageMatchType}`
            };
        }
        const current = state.searchTerms[`${campaignId}|${adGroupId}|${norm(term)}`] || state.searchTerms[`${campaignId}|${norm(term)}`] || state.searchTerms[norm(term)];
        return {
            implemented: Boolean(current && Array.isArray(expected.statuses) && expected.statuses.includes(String(current.status))),
            campaignId: current?.campaignId || campaignId,
            biddingStrategy: state.campaigns[current?.campaignId || campaignId]?.biddingStrategy || 'UNKNOWN',
            reason: `negative_status:${current?.status || 'missing'}`
        };
    }

    if (spec.kind === 'campaign_budget_changed') {
        const campaignId = String(entity.campaign_id || '');
        const campaign = state.campaigns[campaignId];
        const implemented = Boolean(campaign && compareValue(campaign.budgetMicros, expected));
        return {
            implemented,
            campaignId,
            biddingStrategy: campaign?.biddingStrategy || 'UNKNOWN',
            reason: `campaign_budget_micros:${campaign?.budgetMicros ?? 'missing'}`
        };
    }

    if (spec.kind === 'target_cpa_changed' || spec.kind === 'target_roas_changed') {
        const campaignId = String(entity.campaign_id || '');
        const campaign = state.campaigns[campaignId];
        const value = spec.kind === 'target_cpa_changed'
            ? campaign?.targetCpaMicros == null ? null : Number(campaign.targetCpaMicros)
            : campaign?.targetRoas == null ? null : Number(campaign.targetRoas);
        const implemented = Boolean(campaign && compareValue(value, expected));
        return {
            implemented,
            campaignId,
            biddingStrategy: campaign?.biddingStrategy || 'UNKNOWN',
            reason: `${spec.kind}:${value ?? 'missing'}`
        };
    }

    return { implemented: false, campaignId: '', biddingStrategy: 'UNKNOWN', reason: `unsupported:${spec.kind}` };
}

async function run() {
    console.log('Running telemetry checker...');
    if (!process.env.DATABASE_URL) {
        console.log('No DATABASE_URL configured; skipping telemetry.');
        return;
    }
    await ensureDatabaseSchema(pool);

    const keywordData = readReport('keyword-performance');
    const configuredKeywordData = readRawReport('configured-keywords')
        .map(configuredKeywordRuleFromReportRow)
        .filter((row): row is ConfiguredKeywordRule => Boolean(row));
    const campaignData = readReport('campaign-performance');
    const searchTermData = readReport('search-term-performance');
    const customerId = String(campaignData[0]?.customer?.id || process.env.GOOGLE_ADS_CUSTOMER_ID || '').trim() || null;
    const negativeRules = normalizeNegativeRulesFromReports({
        customerId,
        accountNegatives: readRawReport('account-negatives'),
        campaignNegatives: readRawReport('campaign-negatives'),
        adGroupNegatives: readRawReport('ad-group-negatives'),
        sharedNegativeSets: readRawReport('shared-negative-sets'),
        sharedNegativeCriteria: readRawReport('shared-negative-criteria'),
        campaignSharedSets: readRawReport('campaign-shared-sets')
    });
    const state = buildCurrentState(keywordData, configuredKeywordData, campaignData, searchTermData, negativeRules);
    const latestDecisionSnapshot = await latestDashboardDecisionSnapshot();

    const { rows } = await pool.query(
        `SELECT p.proposal_id, p.payload, p.selected_option_id, po.option_uid, po.option_id, po.strategy_id, po.verification_spec, po.baseline_metrics, po.payload AS option_payload
         FROM proposals p
         LEFT JOIN proposal_options po ON po.proposal_id = p.proposal_id AND po.option_id = COALESCE(p.selected_option_id, po.option_id)
         WHERE p.status IN ('accepted', 'user_marked_implemented')
         ORDER BY p.updated_at ASC`
    );

    let verifiedCount = 0;
    const seen = new Set<string>();
    for (const row of rows) {
        if (seen.has(row.proposal_id)) continue;
        seen.add(row.proposal_id);
        const proposal = row.payload;
        const option = row.selected_option_id
            ? (proposal.options || []).find((opt: any) => opt.option_id === row.selected_option_id)
            : selectedOption(proposal);
        if (!option) continue;
        const spec = normalizeVerificationSpec(row.verification_spec || option.verification_spec, `proposal ${row.proposal_id} option ${option.option_id}`);
        if (!spec?.observable || spec.kind === 'diagnosis_only') {
            await pool.query(
                `INSERT INTO proposal_events (proposal_id, event_type, payload) VALUES ($1, 'telemetry_skipped_unobservable', $2)`,
                [row.proposal_id, { option_id: option.option_id, reason: 'diagnosis_only_or_unobservable' }]
            );
            continue;
        }
        const result = verify(spec, state);
        if (!result.implemented) {
            await pool.query(
                `INSERT INTO proposal_events (proposal_id, event_type, payload) VALUES ($1, 'telemetry_checked_not_detected', $2)`,
                [row.proposal_id, { option_id: option.option_id, reason: result.reason }]
            );
            continue;
        }

        const strategyId = row.strategy_id || `${proposal.type}:${option.strategy_type}:${result.biddingStrategy}:${spec.kind}`;
        const uid = row.option_uid || `${row.proposal_id}:${option.option_id}`;
        const baseline = {
            ...(row.baseline_metrics || option.baseline_metrics || campaignBaseline(campaignData, result.campaignId)),
            decision_context: baselineDecisionContext(spec, state, result, latestDecisionSnapshot)
        };
        await pool.query(
            `INSERT INTO impact_tracking
             (option_uid, option_id, proposal_id, selected_option_id, verified_at, detected_at, campaign_id, strategy_id, verification_spec, baseline_metrics, tracking_status)
             VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $5, $6, $7, $8, 'pending_14')
             ON CONFLICT (option_uid) DO UPDATE SET
                option_id = EXCLUDED.option_id,
                proposal_id = EXCLUDED.proposal_id,
                selected_option_id = EXCLUDED.selected_option_id,
                detected_at = COALESCE(impact_tracking.detected_at, EXCLUDED.detected_at),
                campaign_id = EXCLUDED.campaign_id,
                strategy_id = EXCLUDED.strategy_id,
                verification_spec = EXCLUDED.verification_spec,
                baseline_metrics = COALESCE(impact_tracking.baseline_metrics, EXCLUDED.baseline_metrics)`,
            [uid, option.option_id, row.proposal_id, option.option_id, result.campaignId, strategyId, spec, baseline]
        );

        proposal.status = 'monitoring_14';
        proposal.selected_option_id = option.option_id;
        await pool.query(
            `UPDATE proposals SET status = 'monitoring_14', selected_option_id = $2, payload = $3, updated_at = CURRENT_TIMESTAMP WHERE proposal_id = $1`,
            [row.proposal_id, option.option_id, proposal]
        );
        await pool.query(
            `INSERT INTO proposal_events (proposal_id, event_type, payload) VALUES ($1, 'telemetry_detected_implemented', $2)`,
            [row.proposal_id, { option_id: option.option_id, campaign_id: result.campaignId, strategy_id: strategyId, reason: result.reason }]
        );
        verifiedCount++;
    }

    console.log(`Telemetry complete. Verified ${verifiedCount} selected options.`);
}

run()
    .catch(err => {
        console.error('Fatal error in telemetry:', err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
