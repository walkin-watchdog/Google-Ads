import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { getImpactMetricWindow } from './adsWarehouse';

export const PROPOSAL_STATUSES = [
    'pending_review',
    'accepted',
    'rejected',
    'ignored',
    'user_marked_implemented',
    'detected_implemented',
    'monitoring_14',
    'monitoring_30',
    'completed',
    'expired',
    'superseded'
] as const;

export type ProposalStatus = typeof PROPOSAL_STATUSES[number];

export type DecisionAction = 'accept' | 'reject' | 'ignore' | 'implemented' | 'dismissed' | 'accepted' | 'rejected' | 'ignored' | 'user_marked_implemented';

export const PROPOSAL_FEEDBACK_TYPES = ['agree', 'disagree', 'correction', 'preference', 'context', 'other'] as const;
export const PROPOSAL_FEEDBACK_STATUSES = ['raw', 'reviewed', 'converted_to_memory', 'ignored'] as const;

export type ProposalFeedbackType = typeof PROPOSAL_FEEDBACK_TYPES[number];
export type ProposalFeedbackStatus = typeof PROPOSAL_FEEDBACK_STATUSES[number];

export class ProposalValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ProposalValidationError';
    }
}

export interface ProposalOptionPayload {
    option_id: string;
    strategy_type: string;
    description?: string;
    hypothesis?: string;
    recommendation?: string;
    evidence?: any[];
    counter_evidence?: any[];
    risks?: string[];
    manual_steps?: string[];
    expected_outcome?: string;
    win_probability?: number | null;
    verification_spec?: VerificationSpec;
    baseline_metrics?: any;
    memory_context?: ProposalMemoryContext | null;
}

export type VerificationKind =
    | 'campaign_status'
    | 'keyword_status'
    | 'keyword_added_exact'
    | 'negative_search_term_added'
    | 'campaign_budget_changed'
    | 'target_cpa_changed'
    | 'target_roas_changed'
    | 'manual_bid_changed'
    | 'diagnosis_only';

export interface VerificationSpec {
    kind: VerificationKind;
    observable: boolean;
    entity: Record<string, any>;
    expected: Record<string, any>;
}

export interface ProposalPayload {
    proposal_id: string;
    type: string;
    summary: string;
    status?: string;
    campaignId?: string | null;
    campaign_id?: string | null;
    confidence?: number;
    selected_option_id?: string | null;
    evidence_window?: { start?: string; end?: string } | null;
    created_by?: 'agent' | 'deterministic_signal';
    source_signal_ids?: string[];
    memory_context?: ProposalMemoryContext | null;
    options: ProposalOptionPayload[];
    [key: string]: any;
}

export interface ProposalMemoryReference {
    memory_id?: string;
    scope_type?: string;
    category?: string;
    authority?: string;
    verification_status?: string;
    content?: string;
    reason?: string;
    influence?: string;
    source_ref?: string;
    valid_until?: string | null;
}

export interface ProposalMemoryContext {
    summary?: string;
    memories: ProposalMemoryReference[];
    caveats: string[];
}

export interface ProposalFeedback {
    feedback_id: string;
    customer_id: string | null;
    proposal_id: string;
    option_id: string | null;
    feedback_type: ProposalFeedbackType;
    comment: string;
    status: ProposalFeedbackStatus;
    related_memory_id: string | null;
    created_by: string;
    reviewed_by: string | null;
    reviewer_note: string | null;
    created_at: string;
    updated_at: string;
    reviewed_at: string | null;
}

function normalizeStatus(status: string | undefined | null): ProposalStatus {
    if (status === 'dismissed') return 'ignored';
    if (status === 'implemented') return 'detected_implemented';
    if (status && (PROPOSAL_STATUSES as readonly string[]).includes(status)) return status as ProposalStatus;
    return 'pending_review';
}

export function normalizeDecision(action: DecisionAction | string): ProposalStatus {
    if (action === 'accept' || action === 'accepted') return 'accepted';
    if (action === 'reject' || action === 'rejected') return 'rejected';
    if (action === 'implemented' || action === 'user_marked_implemented') return 'user_marked_implemented';
    if (action === 'dismissed' || action === 'ignore' || action === 'ignored') return 'ignored';
    return normalizeStatus(action);
}

interface NormalizeProposalOptions {
    requireActionVerification?: boolean;
    requireSelectedOptionForTrackedStatus?: boolean;
}

const TRACKED_PROPOSAL_STATUSES = new Set<ProposalStatus>(['accepted', 'user_marked_implemented']);
const SUPPORTED_OBSERVABLE_VERIFICATION_KINDS = new Set<VerificationKind>([
    'campaign_status',
    'keyword_status',
    'keyword_added_exact',
    'negative_search_term_added',
    'campaign_budget_changed',
    'target_cpa_changed',
    'target_roas_changed',
    'manual_bid_changed'
]);

function requireString(value: any, message: string): string {
    const text = String(value ?? '').trim();
    if (!text) throw new ProposalValidationError(message);
    return text;
}

function optionalString(value: any): string | undefined {
    const text = String(value ?? '').trim();
    return text || undefined;
}

function requireFiniteNumber(value: any, message: string): number {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) throw new ProposalValidationError(message);
    return numberValue;
}

function normalizeStatusValue(value: any, message: string): string {
    return requireString(value, message).toUpperCase();
}

function normalizeStatusList(value: any, fallback: string[]): string[] {
    const raw = Array.isArray(value) ? value : value ? [value] : fallback;
    const statuses = raw.map(item => String(item ?? '').trim().toUpperCase()).filter(Boolean);
    if (statuses.length === 0) throw new ProposalValidationError('verification_spec.expected.statuses must contain at least one status.');
    return statuses;
}

function normalizeMicrosExpected(expected: Record<string, any>, kind: VerificationKind): Record<string, any> {
    const valueMicros = expected.value_micros ?? expected.amount_micros ?? expected.bid_micros ?? expected.cpc_bid_micros;
    const previousValueMicros = expected.previous_value_micros ?? expected.previous_amount_micros ?? expected.previous_bid_micros ?? expected.previous_cpc_bid_micros;
    const comparison = String(expected.comparison || (valueMicros != null ? 'eq' : 'changed')).trim().toLowerCase();
    if (!['eq', 'gte', 'lte', 'changed'].includes(comparison)) {
        throw new ProposalValidationError(`${kind} verification_spec.expected.comparison must be eq, gte, lte, or changed.`);
    }
    if (valueMicros == null && previousValueMicros == null) {
        throw new ProposalValidationError(`${kind} requires expected.value_micros/amount_micros/bid_micros or previous_*_micros. Currency-unit values are intentionally rejected.`);
    }
    return {
        comparison,
        ...(valueMicros != null ? { value_micros: requireFiniteNumber(valueMicros, `${kind} expected micros value must be numeric.`) } : {}),
        ...(previousValueMicros != null ? { previous_value_micros: requireFiniteNumber(previousValueMicros, `${kind} previous micros value must be numeric.`) } : {})
    };
}

export function normalizeVerificationSpec(raw: any, context = 'verification_spec'): VerificationSpec {
    if (!raw || typeof raw !== 'object') {
        return { kind: 'diagnosis_only', observable: false, entity: {}, expected: {} };
    }

    const kind = String(raw.kind || '').trim() as VerificationKind;
    if (kind === 'diagnosis_only') {
        return {
            kind,
            observable: false,
            entity: raw.entity && typeof raw.entity === 'object' ? raw.entity : {},
            expected: raw.expected && typeof raw.expected === 'object' ? raw.expected : {}
        };
    }

    if (!SUPPORTED_OBSERVABLE_VERIFICATION_KINDS.has(kind)) {
        throw new ProposalValidationError(`${context}.kind ${kind || '(missing)'} is not supported.`);
    }

    const entity = raw.entity && typeof raw.entity === 'object' ? { ...raw.entity } : {};
    const expectedRaw = raw.expected && typeof raw.expected === 'object' ? { ...raw.expected } : {};
    const expected: Record<string, any> = {};

    if (raw.observable === false) {
        throw new ProposalValidationError(`${context}.${kind} must be observable=true. Use diagnosis_only for unobservable investigations.`);
    }

    if (kind === 'campaign_status') {
        entity.campaign_id = requireString(entity.campaign_id ?? entity.id, `${context}.entity.campaign_id is required for campaign_status.`);
        expected.status = normalizeStatusValue(expectedRaw.status, `${context}.expected.status is required for campaign_status.`);
    }

    if (kind === 'keyword_status') {
        entity.campaign_id = requireString(entity.campaign_id ?? entity.id?.split('|')?.[0], `${context}.entity.campaign_id is required for keyword_status.`);
        entity.ad_group_id = optionalString(entity.ad_group_id);
        entity.criterion_id = optionalString(entity.criterion_id);
        entity.keyword_text = optionalString(entity.keyword_text);
        entity.match_type = optionalString(entity.match_type);
        if (!entity.criterion_id && !entity.keyword_text) {
            throw new ProposalValidationError(`${context}.entity.criterion_id or keyword_text is required for keyword_status.`);
        }
        expected.status = normalizeStatusValue(expectedRaw.status, `${context}.expected.status is required for keyword_status.`);
    }

    if (kind === 'keyword_added_exact') {
        entity.campaign_id = requireString(entity.campaign_id ?? entity.id?.split('|')?.[0], `${context}.entity.campaign_id is required for keyword_added_exact.`);
        entity.keyword_text = requireString(entity.keyword_text ?? entity.search_term ?? entity.id?.split('|')?.[1], `${context}.entity.keyword_text or search_term is required for keyword_added_exact.`);
        entity.ad_group_id = optionalString(entity.ad_group_id);
        expected.match_type = 'EXACT';
        expected.status = normalizeStatusValue(expectedRaw.status ?? 'ENABLED', `${context}.expected.status is required for keyword_added_exact.`);
    }

    if (kind === 'negative_search_term_added') {
        entity.campaign_id = requireString(entity.campaign_id ?? entity.id?.split('|')?.[0], `${context}.entity.campaign_id is required for negative_search_term_added.`);
        entity.search_term = requireString(entity.search_term ?? entity.id, `${context}.entity.search_term is required for negative_search_term_added.`);
        entity.ad_group_id = optionalString(entity.ad_group_id);
        expected.statuses = normalizeStatusList(expectedRaw.statuses ?? expectedRaw.status, ['EXCLUDED', 'PHRASE_EXCLUDED']);
    }

    if (kind === 'campaign_budget_changed') {
        entity.campaign_id = requireString(entity.campaign_id ?? entity.id, `${context}.entity.campaign_id is required for campaign_budget_changed.`);
        Object.assign(expected, normalizeMicrosExpected(expectedRaw, kind));
    }

    if (kind === 'target_cpa_changed') {
        entity.campaign_id = requireString(entity.campaign_id ?? entity.id, `${context}.entity.campaign_id is required for target_cpa_changed.`);
        Object.assign(expected, normalizeMicrosExpected(expectedRaw, kind));
    }

    if (kind === 'manual_bid_changed') {
        entity.campaign_id = requireString(entity.campaign_id ?? entity.id?.split('|')?.[0], `${context}.entity.campaign_id is required for manual_bid_changed.`);
        entity.ad_group_id = optionalString(entity.ad_group_id);
        entity.criterion_id = optionalString(entity.criterion_id);
        entity.keyword_text = optionalString(entity.keyword_text);
        entity.match_type = optionalString(entity.match_type);
        if (!entity.criterion_id && !entity.keyword_text) {
            throw new ProposalValidationError(`${context}.entity.criterion_id or keyword_text is required for manual_bid_changed.`);
        }
        Object.assign(expected, normalizeMicrosExpected(expectedRaw, kind));
    }

    if (kind === 'target_roas_changed') {
        entity.campaign_id = requireString(entity.campaign_id ?? entity.id, `${context}.entity.campaign_id is required for target_roas_changed.`);
        const value = expectedRaw.value ?? expectedRaw.target_roas;
        const previousValue = expectedRaw.previous_value ?? expectedRaw.previous_target_roas;
        const comparison = String(expectedRaw.comparison || (value != null ? 'eq' : 'changed')).trim().toLowerCase();
        if (!['eq', 'gte', 'lte', 'changed'].includes(comparison)) {
            throw new ProposalValidationError(`${context}.expected.comparison must be eq, gte, lte, or changed.`);
        }
        if (value == null && previousValue == null) {
            throw new ProposalValidationError(`${context}.expected.value or previous_value is required for target_roas_changed.`);
        }
        expected.comparison = comparison;
        if (value != null) expected.value = requireFiniteNumber(value, `${context}.expected.value must be numeric for target_roas_changed.`);
        if (previousValue != null) expected.previous_value = requireFiniteNumber(previousValue, `${context}.expected.previous_value must be numeric for target_roas_changed.`);
    }

    return { kind, observable: true, entity, expected };
}

export function verificationIsObservable(verification: any): boolean {
    try {
        const spec = normalizeVerificationSpec(verification);
        return spec.observable && SUPPORTED_OBSERVABLE_VERIFICATION_KINDS.has(spec.kind);
    } catch {
        return false;
    }
}

function optionVerification(option: any): VerificationSpec | null {
    return option?.verification_spec || null;
}

function cleanOptionalString(value: any, maxLength: number): string | undefined {
    if (value === undefined || value === null) return undefined;
    const text = String(value).trim();
    if (!text) return undefined;
    return text.slice(0, maxLength);
}

function boundedRequiredString(value: any, fieldName: string, maxLength: number): string {
    const text = requireString(value, `${fieldName} is required.`);
    if (text.length > maxLength) {
        throw new ProposalValidationError(`${fieldName} must be ${maxLength} characters or fewer.`);
    }
    return text;
}

function normalizeFeedbackType(value: any): ProposalFeedbackType {
    const normalized = String(value || 'context').trim().toLowerCase().replace(/[\s-]+/g, '_');
    return (PROPOSAL_FEEDBACK_TYPES as readonly string[]).includes(normalized)
        ? normalized as ProposalFeedbackType
        : 'other';
}

function normalizeFeedbackStatus(value: any): ProposalFeedbackStatus {
    const normalized = String(value || 'raw').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if ((PROPOSAL_FEEDBACK_STATUSES as readonly string[]).includes(normalized)) return normalized as ProposalFeedbackStatus;
    throw new ProposalValidationError(`feedback status must be one of: ${PROPOSAL_FEEDBACK_STATUSES.join(', ')}.`);
}

function feedbackFromRow(row: any): ProposalFeedback {
    const asIso = (value: any): string => value instanceof Date ? value.toISOString() : String(value || '');
    const asIsoOrNull = (value: any): string | null => value ? asIso(value) : null;
    return {
        feedback_id: String(row.feedback_id),
        customer_id: row.customer_id || null,
        proposal_id: String(row.proposal_id),
        option_id: row.option_id || null,
        feedback_type: normalizeFeedbackType(row.feedback_type),
        comment: String(row.comment || ''),
        status: normalizeFeedbackStatus(row.status),
        related_memory_id: row.related_memory_id || null,
        created_by: row.created_by || 'user',
        reviewed_by: row.reviewed_by || null,
        reviewer_note: row.reviewer_note || null,
        created_at: asIso(row.created_at),
        updated_at: asIso(row.updated_at),
        reviewed_at: asIsoOrNull(row.reviewed_at)
    };
}

function normalizeStringArray(value: any, maxItems: number, maxLength: number): string[] {
    const raw = Array.isArray(value) ? value : value ? [value] : [];
    return raw
        .map(item => cleanOptionalString(item, maxLength))
        .filter((item): item is string => Boolean(item))
        .slice(0, maxItems);
}

function normalizeMemoryContext(input: any): ProposalMemoryContext | null {
    if (!input) return null;
    const raw = Array.isArray(input) ? { memories: input } : input;
    if (!raw || typeof raw !== 'object') return null;

    const memories = (Array.isArray(raw.memories) ? raw.memories : [])
        .filter((item: any) => item && typeof item === 'object')
        .map((item: any) => {
            const memory: ProposalMemoryReference = {};
            const fields: Array<[keyof ProposalMemoryReference, number]> = [
                ['memory_id', 120],
                ['scope_type', 50],
                ['category', 80],
                ['authority', 50],
                ['verification_status', 50],
                ['content', 1200],
                ['reason', 800],
                ['influence', 80],
                ['source_ref', 500],
                ['valid_until', 80]
            ];
            for (const [field, maxLength] of fields) {
                const value = cleanOptionalString(item[field], maxLength);
                if (value) (memory as any)[field] = value;
            }
            return memory;
        })
        .filter((item: ProposalMemoryReference) => Boolean(item.content || item.reason || item.memory_id))
        .slice(0, 10);

    const summary = cleanOptionalString(raw.summary, 1000);
    const caveats = normalizeStringArray(raw.caveats, 6, 500);
    if (!summary && memories.length === 0 && caveats.length === 0) return null;
    return { summary, memories, caveats };
}

export function normalizeProposal(input: any, optionsInput: NormalizeProposalOptions = {}): ProposalPayload {
    if (!input || typeof input !== 'object') throw new Error('Proposal must be an object.');
    if (!input.proposal_id || typeof input.proposal_id !== 'string') throw new Error('Proposal requires proposal_id.');
    if (!input.type || typeof input.type !== 'string') throw new Error('Proposal requires type.');
    if (!input.summary || typeof input.summary !== 'string') throw new Error('Proposal requires summary.');
    if (!Array.isArray(input.options) || input.options.length === 0) throw new Error('Proposal requires at least one option.');

    const options = input.options.map((option: any, index: number) => {
        if (!option || typeof option !== 'object') throw new Error(`Option ${index + 1} must be an object.`);
        if (!option.option_id || typeof option.option_id !== 'string') throw new Error(`Option ${index + 1} requires option_id.`);
        if (!option.strategy_type || typeof option.strategy_type !== 'string') throw new Error(`Option ${index + 1} requires strategy_type.`);
        const verification = normalizeVerificationSpec(option.verification_spec, `options[${index}].verification_spec`);
        if (optionsInput.requireActionVerification && input.type !== 'DIAGNOSE' && !verificationIsObservable(verification)) {
            throw new ProposalValidationError(`Option ${option.option_id} on ${input.type} requires an observable verification_spec so telemetry can track it.`);
        }
        const hypothesis = typeof option.hypothesis === 'string' ? option.hypothesis.trim() : (typeof option.description === 'string' ? option.description.trim() : '');
        const recommendation = typeof option.recommendation === 'string' ? option.recommendation.trim() : (typeof option.description === 'string' ? option.description.trim() : '');
        if (!hypothesis) throw new ProposalValidationError(`Option ${option.option_id} requires a non-empty string hypothesis (or description fallback).`);
        if (!recommendation) throw new ProposalValidationError(`Option ${option.option_id} requires a non-empty string recommendation (or description fallback).`);

        return {
            ...option,
            hypothesis,
            recommendation,
            evidence: Array.isArray(option.evidence) ? option.evidence : [],
            counter_evidence: Array.isArray(option.counter_evidence) ? option.counter_evidence : [],
            risks: Array.isArray(option.risks) ? option.risks : [],
            manual_steps: Array.isArray(option.manual_steps) ? option.manual_steps : [],
            expected_outcome: option.expected_outcome || '',
            memory_context: normalizeMemoryContext(option.memory_context ?? option.memoryContext),
            verification_spec: verification
        };
    });

    const status = normalizeStatus(input.status);
    const optionIds = new Set(options.map((option: ProposalOptionPayload) => option.option_id));
    let selectedOptionId = input.selected_option_id || null;
    if (selectedOptionId && !optionIds.has(selectedOptionId)) {
        throw new ProposalValidationError(`selected_option_id ${selectedOptionId} does not belong to proposal ${input.proposal_id}.`);
    }
    if (optionsInput.requireSelectedOptionForTrackedStatus && TRACKED_PROPOSAL_STATUSES.has(status)) {
        if (!selectedOptionId && options.length === 1) selectedOptionId = options[0].option_id;
        if (!selectedOptionId) {
            throw new ProposalValidationError(`selected_option_id is required when proposal status is ${status}.`);
        }
        const selectedOption = options.find((option: ProposalOptionPayload) => option.option_id === selectedOptionId);
        if (!verificationIsObservable(optionVerification(selectedOption))) {
            throw new ProposalValidationError(`selected_option_id ${selectedOptionId} does not have a supported observable verification_spec.`);
        }
    }
    return {
        ...input,
        status,
        campaign_id: input.campaign_id ?? input.campaignId ?? null,
        campaignId: input.campaignId ?? input.campaign_id ?? null,
        selected_option_id: selectedOptionId,
        evidence_window: input.evidence_window || null,
        created_by: input.created_by || 'agent',
        source_signal_ids: Array.isArray(input.source_signal_ids) ? input.source_signal_ids : [],
        memory_context: normalizeMemoryContext(input.memory_context ?? input.memoryContext),
        options
    };
}

function campaignIdForOption(proposal: ProposalPayload, option: ProposalOptionPayload): string | null {
    const spec = (option.verification_spec || {}) as Partial<VerificationSpec>;
    const entity = spec.entity || {};
    const expected = spec.expected || {};
    const raw = proposal.campaign_id
        || proposal.campaignId
        || entity.campaign_id
        || entity.campaignId
        || expected.campaign_id
        || expected.campaignId
        || expected.id
        || null;
    return raw == null || raw === '' ? null : String(raw);
}

function cleanString(value: any): string | null {
    const text = String(value ?? '').trim();
    return text || null;
}

function isoDateOrNull(value: any): string | null {
    const text = cleanString(value);
    return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function addDaysIso(date: string, days: number): string {
    const [year, month, day] = date.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function daysInclusive(start: string, end: string): number {
    return Math.max(1, Math.floor((Date.parse(end) - Date.parse(start)) / 86400000) + 1);
}

function baselineWindow(proposal: ProposalPayload): { start: string; end: string; endExclusive: string; days: number } {
    const today = new Date().toISOString().slice(0, 10);
    const end = isoDateOrNull(proposal.evidence_window?.end) || today;
    const start = isoDateOrNull(proposal.evidence_window?.start) || addDaysIso(end, -29);
    return { start, end, endExclusive: addDaysIso(end, 1), days: daysInclusive(start, end) };
}

async function customerIdForBaseline(db: Pool | PoolClient, proposal: ProposalPayload): Promise<string | null> {
    const explicit = cleanString(proposal.customer_id || proposal.customerId || process.env.GOOGLE_ADS_CUSTOMER_ID || process.env.GOOGLE_ADS_CUSTOMER);
    if (explicit) return explicit;
    const fromRun = await db.query(
        `SELECT customer_id
         FROM google_ads_refresh_runs
         WHERE customer_id IS NOT NULL
         ORDER BY started_at DESC
         LIMIT 1`
    );
    const runCustomer = cleanString(fromRun.rows[0]?.customer_id);
    if (runCustomer) return runCustomer;
    const fromFact = await db.query(`SELECT customer_id FROM google_ads_campaign_daily LIMIT 1`);
    return cleanString(fromFact.rows[0]?.customer_id);
}

async function captureOptionBaseline(db: Pool | PoolClient, proposal: ProposalPayload, option: ProposalOptionPayload): Promise<any | null> {
    const verification = normalizeVerificationSpec(option.verification_spec, `proposal ${proposal.proposal_id} option ${option.option_id}`);
    const campaignId = campaignIdForOption(proposal, option);
    const customerId = await customerIdForBaseline(db, proposal);
    if (!campaignId || !customerId) return null;

    const entity = verification.entity || {};
    const campaignName = cleanString(entity.campaign_name || entity.campaignName || proposal.campaign_name || proposal.campaignName);
    const window = baselineWindow(proposal);
    let scope: 'campaign' | 'keyword' | 'search_term' = 'campaign';
    let baselineEntity: Record<string, any> = { campaign_id: campaignId, campaign_name: campaignName };

    if (verification.kind === 'keyword_status' || verification.kind === 'manual_bid_changed') {
        scope = 'keyword';
        baselineEntity = {
            campaign_id: campaignId,
            campaign_name: campaignName,
            ad_group_id: entity.ad_group_id || null,
            criterion_id: entity.criterion_id || null,
            keyword_text: entity.keyword_text || null,
            match_type: entity.match_type || null
        };
    } else if (verification.kind === 'negative_search_term_added' || verification.kind === 'keyword_added_exact') {
        scope = 'search_term';
        baselineEntity = {
            campaign_id: campaignId,
            campaign_name: campaignName,
            ad_group_id: entity.ad_group_id || null,
            search_term: entity.search_term || entity.keyword_text || null
        };
    }

    const metrics = await getImpactMetricWindow(db, {
        customerId,
        startDate: window.start,
        endDate: window.endExclusive,
        scope,
        campaignId,
        adGroupId: cleanString(entity.ad_group_id),
        criterionId: cleanString(entity.criterion_id),
        keywordText: scope === 'keyword' ? cleanString(entity.keyword_text) : null,
        matchType: scope === 'keyword' ? cleanString(entity.match_type) : null,
        searchTerm: scope === 'search_term' ? cleanString(entity.search_term || entity.keyword_text) : null,
        mode: 'target'
    });

    return {
        captured_at: new Date().toISOString(),
        scope,
        entity: baselineEntity,
        campaign_id: campaignId,
        campaign_name: campaignName,
        spend: metrics.spend,
        clicks: metrics.clicks,
        impressions: metrics.impressions,
        conversions: metrics.conversions,
        conversionValue: metrics.conversionValue,
        cpa: metrics.cpa,
        roas: metrics.roas,
        days: window.days,
        start: window.start,
        end: window.end
    };
}

function optionUid(proposalId: string, optionId: string): string {
    return `${proposalId}:${optionId}`;
}

export async function ensureDatabaseSchema(pool: Pool): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS proposals (
            proposal_id VARCHAR(100) PRIMARY KEY,
            payload JSONB NOT NULL,
            status VARCHAR(50) DEFAULT 'pending_review',
            selected_option_id VARCHAR(100),
            campaign_id VARCHAR(100),
            type VARCHAR(50),
            created_by VARCHAR(50) DEFAULT 'agent',
            source_signal_ids JSONB DEFAULT '[]'::jsonb,
            evidence_window JSONB,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS proposal_options (
            option_uid VARCHAR(220) PRIMARY KEY,
            option_id VARCHAR(100) NOT NULL,
            proposal_id VARCHAR(100) REFERENCES proposals(proposal_id) ON DELETE CASCADE,
            strategy_type VARCHAR(100),
            payload JSONB DEFAULT '{}'::jsonb,
            strategy_id VARCHAR(200),
            verification_spec JSONB,
            baseline_metrics JSONB,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS proposal_events (
            id BIGSERIAL PRIMARY KEY,
            proposal_id VARCHAR(100) REFERENCES proposals(proposal_id) ON DELETE CASCADE,
            event_type VARCHAR(80) NOT NULL,
            payload JSONB DEFAULT '{}'::jsonb,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS proposal_feedback (
            feedback_id VARCHAR(120) PRIMARY KEY,
            customer_id VARCHAR(50),
            proposal_id VARCHAR(100) REFERENCES proposals(proposal_id) ON DELETE CASCADE,
            option_id VARCHAR(100),
            feedback_type VARCHAR(40) NOT NULL DEFAULT 'context',
            comment TEXT NOT NULL,
            status VARCHAR(40) NOT NULL DEFAULT 'raw',
            related_memory_id VARCHAR(120),
            created_by VARCHAR(80) NOT NULL DEFAULT 'user',
            reviewed_by VARCHAR(80),
            reviewer_note TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            reviewed_at TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS impact_tracking (
            option_uid VARCHAR(220) PRIMARY KEY,
            option_id VARCHAR(100),
            proposal_id VARCHAR(100),
            selected_option_id VARCHAR(100),
            verified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            campaign_id VARCHAR(100),
            strategy_id VARCHAR(200),
            verification_spec JSONB,
            baseline_metrics JSONB,
            tracking_status VARCHAR(50) DEFAULT 'pending_14',
            outcome_14 VARCHAR(50),
            outcome_30 VARCHAR(50),
            lead_outcome_14 VARCHAR(50),
            lead_outcome_30 VARCHAR(50),
            lead_metrics_14 JSONB,
            lead_metrics_30 JSONB,
            outcome_details_14 JSONB,
            outcome_details_30 JSONB
        );
        CREATE UNIQUE INDEX IF NOT EXISTS proposal_options_proposal_option_idx ON proposal_options(proposal_id, option_id);
        CREATE INDEX IF NOT EXISTS proposals_status_idx ON proposals(status);
        CREATE INDEX IF NOT EXISTS proposal_feedback_proposal_idx ON proposal_feedback(proposal_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS proposal_feedback_status_idx ON proposal_feedback(status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS proposal_feedback_customer_idx ON proposal_feedback(customer_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS impact_tracking_status_idx ON impact_tracking(tracking_status);

        CREATE TABLE IF NOT EXISTS google_ads_change_events (
            event_uid TEXT PRIMARY KEY,
            change_date_time TIMESTAMP NOT NULL,
            campaign_id VARCHAR(100),
            ad_group_id VARCHAR(100),
            resource_type VARCHAR(80),
            operation VARCHAR(40),
            changed_fields JSONB DEFAULT '[]'::jsonb,
            client_type VARCHAR(120),
            user_email TEXT,
            payload JSONB DEFAULT '{}'::jsonb,
            fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS google_ads_change_events_date_idx ON google_ads_change_events(change_date_time);
        CREATE INDEX IF NOT EXISTS google_ads_change_events_campaign_idx ON google_ads_change_events(campaign_id);
        CREATE INDEX IF NOT EXISTS google_ads_change_events_ad_group_idx ON google_ads_change_events(ad_group_id);

        CREATE TABLE IF NOT EXISTS ai_diagnoses (
            diagnosis_id VARCHAR(100) PRIMARY KEY,
            payload JSONB NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS auction_insights_settings (
            entity_type VARCHAR(30) NOT NULL,
            entity_id VARCHAR(120) NOT NULL,
            entity_name TEXT,
            sheet_name TEXT,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (entity_type, entity_id)
        );
        CREATE INDEX IF NOT EXISTS auction_insights_settings_enabled_idx ON auction_insights_settings(enabled);
    `);
}

export async function upsertProposal(pool: Pool, rawProposal: any): Promise<ProposalPayload> {
    const proposal = normalizeProposal(rawProposal, { requireActionVerification: true, requireSelectedOptionForTrackedStatus: true });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query('SELECT payload FROM proposals WHERE proposal_id = $1 FOR UPDATE', [proposal.proposal_id]);
        const existingBaselines = new Map<string, any>();
        if (existing.rows[0]?.payload?.options && Array.isArray(existing.rows[0].payload.options)) {
            for (const option of existing.rows[0].payload.options) {
                if (option?.option_id && option.baseline_metrics) existingBaselines.set(option.option_id, option.baseline_metrics);
            }
        }
        for (const option of proposal.options) {
            option.baseline_metrics = existingBaselines.get(option.option_id)
                || option.baseline_metrics
                || await captureOptionBaseline(client, proposal, option);
        }
        await client.query(
            `INSERT INTO proposals (proposal_id, payload, status, selected_option_id, campaign_id, type, created_by, source_signal_ids, evidence_window, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
             ON CONFLICT (proposal_id) DO UPDATE SET
                payload = EXCLUDED.payload,
                status = EXCLUDED.status,
                selected_option_id = EXCLUDED.selected_option_id,
                campaign_id = EXCLUDED.campaign_id,
                type = EXCLUDED.type,
                created_by = EXCLUDED.created_by,
                source_signal_ids = EXCLUDED.source_signal_ids,
                evidence_window = EXCLUDED.evidence_window,
                updated_at = CURRENT_TIMESTAMP`,
            [
                proposal.proposal_id,
                proposal,
                proposal.status,
                proposal.selected_option_id,
                proposal.campaign_id,
                proposal.type,
                proposal.created_by,
                JSON.stringify(proposal.source_signal_ids),
                proposal.evidence_window
            ]
        );

        for (const option of proposal.options) {
            const verification = normalizeVerificationSpec(option.verification_spec, `proposal ${proposal.proposal_id} option ${option.option_id}`);
            const strategyId = `${proposal.type}:${option.strategy_type}:${verification.kind}`;
            const uid = optionUid(proposal.proposal_id, option.option_id);
            await client.query(
                `INSERT INTO proposal_options (option_uid, option_id, proposal_id, strategy_type, payload, strategy_id, verification_spec, baseline_metrics)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (option_uid) DO UPDATE SET
                    option_id = EXCLUDED.option_id,
                    proposal_id = EXCLUDED.proposal_id,
                    strategy_type = EXCLUDED.strategy_type,
                    payload = EXCLUDED.payload,
                    strategy_id = EXCLUDED.strategy_id,
                    verification_spec = EXCLUDED.verification_spec,
                    baseline_metrics = COALESCE(proposal_options.baseline_metrics, EXCLUDED.baseline_metrics)`,
                [uid, option.option_id, proposal.proposal_id, option.strategy_type, option, strategyId, verification, option.baseline_metrics]
            );
        }

        await client.query(
            `INSERT INTO proposal_events (proposal_id, event_type, payload) VALUES ($1, 'upserted', $2)`,
            [proposal.proposal_id, { status: proposal.status, option_count: proposal.options.length }]
        );
        await client.query('COMMIT');
        return proposal;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

export async function recordProposalDecision(pool: Pool, input: {
    proposalId: string;
    action: DecisionAction | string;
    selectedOptionId?: string | null;
}): Promise<ProposalPayload> {
    const status = normalizeDecision(input.action);
    const selectedOptionId = input.selectedOptionId || null;
    const requiresTrackedOption = status === 'accepted' || status === 'user_marked_implemented';
    const { rows } = await pool.query('SELECT payload FROM proposals WHERE proposal_id = $1', [input.proposalId]);
    if (rows.length === 0) throw new Error(`Proposal not found: ${input.proposalId}`);

    const payload = normalizeProposal(rows[0].payload);
    const optionIds = new Set(payload.options.map(opt => opt.option_id));

    if (selectedOptionId && !optionIds.has(selectedOptionId)) {
        throw new ProposalValidationError(`selected_option_id ${selectedOptionId} does not belong to proposal ${input.proposalId}.`);
    }

    if (payload.selected_option_id && !optionIds.has(payload.selected_option_id)) {
        throw new ProposalValidationError(`Existing selected_option_id ${payload.selected_option_id} is invalid for proposal ${input.proposalId}.`);
    }

    if (requiresTrackedOption && !selectedOptionId && !payload.selected_option_id) {
        throw new ProposalValidationError(`selected_option_id is required when ${status} is recorded so telemetry knows which option to verify.`);
    }

    if (selectedOptionId) {
        payload.selected_option_id = selectedOptionId;
    }

    if (requiresTrackedOption && payload.selected_option_id) {
        const selectedOption = payload.options.find(opt => opt.option_id === payload.selected_option_id);
        const verification = selectedOption ? optionVerification(selectedOption) : null;
        if (!verificationIsObservable(verification)) {
            throw new ProposalValidationError(`selected_option_id ${payload.selected_option_id} does not have an observable verification_spec; use reject/ignore or create a DIAGNOSE-only record instead.`);
        }
    }

    payload.status = status;

    await pool.query(
        `UPDATE proposals
         SET status = $1, selected_option_id = $2, payload = $3, updated_at = CURRENT_TIMESTAMP
         WHERE proposal_id = $4`,
        [payload.status, payload.selected_option_id, payload, payload.proposal_id]
    );
    await pool.query(
        `INSERT INTO proposal_events (proposal_id, event_type, payload) VALUES ($1, $2, $3)`,
        [payload.proposal_id, `decision:${payload.status}`, { selected_option_id: payload.selected_option_id }]
    );
    return payload;
}

export async function createProposalFeedback(pool: Pool, input: {
    proposalId: string;
    comment: string;
    feedbackType?: string | null;
    optionId?: string | null;
    customerId?: string | null;
    createdBy?: string | null;
}): Promise<ProposalFeedback> {
    const proposalId = boundedRequiredString(input.proposalId, 'proposal_id', 100);
    const comment = boundedRequiredString(input.comment, 'comment', 4000);
    const optionId = cleanOptionalString(input.optionId, 100) || null;
    const customerId = cleanOptionalString(input.customerId, 50) || null;
    const createdBy = cleanOptionalString(input.createdBy, 80) || 'user';
    const feedbackType = normalizeFeedbackType(input.feedbackType);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query('SELECT payload FROM proposals WHERE proposal_id = $1 FOR UPDATE', [proposalId]);
        if (existing.rows.length === 0) throw new Error(`Proposal not found: ${proposalId}`);

        const proposal = normalizeProposal(existing.rows[0].payload);
        if (optionId && !proposal.options.some(option => option.option_id === optionId)) {
            throw new ProposalValidationError(`option_id ${optionId} does not belong to proposal ${proposalId}.`);
        }

        const feedbackId = `pf_${randomUUID()}`;
        const inserted = await client.query(
            `INSERT INTO proposal_feedback
                (feedback_id, customer_id, proposal_id, option_id, feedback_type, comment, status, created_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'raw', $7, CURRENT_TIMESTAMP)
             RETURNING *`,
            [feedbackId, customerId, proposalId, optionId, feedbackType, comment, createdBy]
        );
        await client.query(
            `INSERT INTO proposal_events (proposal_id, event_type, payload) VALUES ($1, 'feedback:created', $2)`,
            [proposalId, { feedback_id: feedbackId, option_id: optionId, feedback_type: feedbackType }]
        );
        await client.query('COMMIT');
        return feedbackFromRow(inserted.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

export async function listProposalFeedback(pool: Pool, input: {
    proposalId?: string | null;
    customerId?: string | null;
    status?: string | null;
    limit?: number | string | null;
} = {}): Promise<ProposalFeedback[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    const proposalId = cleanOptionalString(input.proposalId, 100);
    const customerId = cleanOptionalString(input.customerId, 50);
    const status = input.status == null ? null : normalizeFeedbackStatus(input.status);
    const limit = Math.max(1, Math.min(200, Number(input.limit || 100) || 100));

    if (proposalId) {
        params.push(proposalId);
        conditions.push(`proposal_id = $${params.length}`);
    }
    if (customerId) {
        params.push(customerId);
        conditions.push(`customer_id = $${params.length}`);
    }
    if (status) {
        params.push(status);
        conditions.push(`status = $${params.length}`);
    }
    params.push(limit);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
        `SELECT *
         FROM proposal_feedback
         ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length}`,
        params
    );
    return result.rows.map(feedbackFromRow);
}

export async function proposalFeedbackByProposalIds(pool: Pool, proposalIds: string[]): Promise<Map<string, ProposalFeedback[]>> {
    const ids = Array.from(new Set(proposalIds.map(id => cleanOptionalString(id, 100)).filter((id): id is string => Boolean(id))));
    const byProposal = new Map<string, ProposalFeedback[]>();
    if (ids.length === 0) return byProposal;
    const result = await pool.query(
        `SELECT *
         FROM proposal_feedback
         WHERE proposal_id = ANY($1)
         ORDER BY created_at DESC`,
        [ids]
    );
    for (const row of result.rows) {
        const feedback = feedbackFromRow(row);
        const list = byProposal.get(feedback.proposal_id) || [];
        list.push(feedback);
        byProposal.set(feedback.proposal_id, list);
    }
    return byProposal;
}

export async function updateProposalFeedbackStatus(pool: Pool, input: {
    feedbackId: string;
    status: string;
    relatedMemoryId?: string | null;
    reviewedBy?: string | null;
    reviewerNote?: string | null;
}): Promise<ProposalFeedback> {
    const feedbackId = boundedRequiredString(input.feedbackId, 'feedback_id', 120);
    const status = normalizeFeedbackStatus(input.status);
    const relatedMemoryId = cleanOptionalString(input.relatedMemoryId, 120) || null;
    const reviewedBy = cleanOptionalString(input.reviewedBy, 80) || 'agent';
    const reviewerNote = cleanOptionalString(input.reviewerNote, 1000) || null;
    if (status === 'converted_to_memory' && !relatedMemoryId) {
        throw new ProposalValidationError('related_memory_id is required when feedback is converted_to_memory.');
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const updated = await client.query(
            `UPDATE proposal_feedback
             SET status = $2,
                 related_memory_id = $3,
                 reviewed_by = $4,
                 reviewer_note = $5,
                 reviewed_at = CASE WHEN $2 = 'raw' THEN NULL ELSE COALESCE(reviewed_at, CURRENT_TIMESTAMP) END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE feedback_id = $1
             RETURNING *`,
            [feedbackId, status, relatedMemoryId, reviewedBy, reviewerNote]
        );
        if (updated.rows.length === 0) throw new Error(`Proposal feedback not found: ${feedbackId}`);
        const feedback = feedbackFromRow(updated.rows[0]);
        await client.query(
            `INSERT INTO proposal_events (proposal_id, event_type, payload) VALUES ($1, 'feedback:status_updated', $2)`,
            [feedback.proposal_id, { feedback_id: feedback.feedback_id, status, related_memory_id: relatedMemoryId }]
        );
        await client.query('COMMIT');
        return feedback;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}
