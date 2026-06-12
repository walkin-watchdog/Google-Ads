import crypto from 'crypto';
import { Pool, PoolClient } from 'pg';
import { enqueueLeadNotificationForSession } from './dashboardPush';

export const LEAD_STATUSES = ['new', 'maybe', 'qualified', 'converted', 'qualified_lost', 'useless'] as const;
export type LeadStatus = typeof LEAD_STATUSES[number];

const STATUS_RANK: Record<LeadStatus, number> = {
    new: 0,
    maybe: 1,
    qualified: 2,
    qualified_lost: 3,
    useless: 4,
    converted: 5
};

const TERMINAL_STATUSES = new Set<LeadStatus>(['converted', 'qualified_lost', 'useless']);
const leadSchemaReadyByPool = new WeakMap<object, Promise<void>>();
type Queryable = Pick<Pool | PoolClient, 'query'>;

type LeadAttributionSummaryMode = 'full' | 'overview';
type LeadAttributionSummaryOptions = {
    mode?: LeadAttributionSummaryMode;
};

type LeadAttributionOverviewCacheEntry = {
    expiresAt: number;
    summary: any;
};

const DEFAULT_LEAD_ATTRIBUTION_OVERVIEW_CACHE_SECONDS = 60;
const leadAttributionOverviewCache = new Map<string, LeadAttributionOverviewCacheEntry>();

export class LeadValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LeadValidationError';
    }
}

export interface NormalizedLeadEvent {
    event_id: string;
    session_key: string;
    session_key_type: string;
    kind: string | null;
    source: string | null;
    lead_id: string | null;
    session_id: string | null;
    gclid: string | null;
    gbraid: string | null;
    wbraid: string | null;
    utm_source: string | null;
    utm_medium: string | null;
    utm_campaign: string | null;
    ad_group_id: string | null;
    utm_term: string | null;
    utm_content: string | null;
    keyword: string | null;
    match_type: string | null;
    name: string | null;
    email: string | null;
    phone: string | null;
    tracking_only: boolean;
    status: LeadStatus;
    progress_status: string | null;
    progress_trigger: string | null;
    progress_revision: number | null;
    progress_answered_count: number | null;
    qualification_progress: Record<string, any>;
    submitted_at: string | null;
    payload: any;
}

function clean(value: any): string | null {
    const text = String(value ?? '').trim();
    return text || null;
}

function cleanDate(value: any): string | null {
    const text = clean(value);
    return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function firstClean(...values: any[]): string | null {
    for (const value of values) {
        const cleaned = clean(value);
        if (cleaned) return cleaned;
    }
    return null;
}

function normalizeMatchType(value: any): string | null {
    const text = clean(value);
    if (!text) return null;
    const normalized = text.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (['e', 'exact'].includes(normalized)) return 'EXACT';
    if (['p', 'phrase'].includes(normalized)) return 'PHRASE';
    if (['b', 'broad'].includes(normalized)) return 'BROAD';
    return normalized.toUpperCase();
}

function matchTypeFromUtmContent(value: any): string | null {
    const text = clean(value);
    if (!text) return null;
    const suffix = text.includes('-') ? text.split('-').pop() : text;
    return normalizeMatchType(suffix);
}

function normalizeStatus(value: any): LeadStatus {
    const text = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (['useless', 'junk', 'invalid', 'spam', 'bad_fit', 'bad'].includes(text)) return 'useless';
    if (['maybe', 'potential', 'potential_lead'].includes(text)) return 'maybe';
    if (['qualified_lost', 'lost', 'closed_lost', 'qualified_and_lost', 'qualified_lost_lead'].includes(text)) return 'qualified_lost';
    if (['qualified', 'qualified_lead', 'sql', 'mql'].includes(text)) return 'qualified';
    if (['converted', 'qualified_converted', 'qualified_and_converted', 'customer', 'won', 'paid'].includes(text)) return 'converted';
    return 'new';
}

function numberOrNull(value: any): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function clampInteger(value: any, min: number, max: number, fallback = min): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function boundedText(value: any, maxCharacters: number): string | null {
    const text = clean(value);
    return text ? Array.from(text).slice(0, maxCharacters).join('') : null;
}

const QUALIFICATION_SAFEGUARD_REASONS = new Set([
    'rushed_clickthrough',
    'inconsistent_answers',
    'weak_business_detail',
    'high_abuse_path'
]);
const QUALIFICATION_CHALLENGE_REASONS = new Set([
    'personal_use',
    'rushed_clickthrough',
    'inconsistent_answers',
    'high_abuse_path'
]);
const QUALIFICATION_CHALLENGE_STATUSES = new Set([
    'not_required',
    'pending',
    'passed',
    'failed'
]);

function normalizeEnumList(value: any, allowed: Set<string>, maxItems: number): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        const normalized = clean(item)?.toLowerCase().replace(/[\s-]+/g, '_');
        if (!normalized || !allowed.has(normalized) || out.includes(normalized)) continue;
        out.push(normalized);
        if (out.length >= maxItems) break;
    }
    return out;
}

function normalizeInteractionSample(value: any): Record<string, any> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const questionId = boundedText(value.questionId ?? value.question_id, 80);
    const answerId = boundedText(value.answerId ?? value.answer_id, 120);
    if (!questionId || !answerId) return null;
    return {
        sequence: clampInteger(value.sequence, 1, 30, 1),
        questionId,
        answerId,
        readingTimeMs: clampInteger(value.readingTimeMs ?? value.reading_time_ms, 0, 300_000),
        transitionTimeMs: clampInteger(value.transitionTimeMs ?? value.transition_time_ms, 0, 300_000),
        earlyClickAttempts: clampInteger(value.earlyClickAttempts ?? value.early_click_attempts, 0, 20)
    };
}

function normalizeQualificationSafeguards(value: any): Record<string, any> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Number(value.version) !== 1) return null;
    const rawChallenge = value.typedChallenge ?? value.typed_challenge;
    const rawTiming = value.timing;
    if (!rawChallenge || typeof rawChallenge !== 'object' || Array.isArray(rawChallenge)) return null;
    if (!rawTiming || typeof rawTiming !== 'object' || Array.isArray(rawTiming)) return null;

    const status = clean(rawChallenge.status)?.toLowerCase().replace(/[\s-]+/g, '_');
    if (!status || !QUALIFICATION_CHALLENGE_STATUSES.has(status)) return null;
    const samples = (Array.isArray(rawTiming.samples) ? rawTiming.samples : [])
        .map(normalizeInteractionSample)
        .filter(Boolean)
        .slice(0, 30);
    const firstSixRaw = numberOrNull(rawTiming.firstSixReadingTimeMs ?? rawTiming.first_six_reading_time_ms);
    const evaluatedFlowAnswerCountRaw = numberOrNull(
        rawTiming.evaluatedFlowAnswerCount ?? rawTiming.evaluated_flow_answer_count
    );
    const evaluatedFlowReadingTimeRaw = numberOrNull(
        rawTiming.evaluatedFlowReadingTimeMs ?? rawTiming.evaluated_flow_reading_time_ms
    );
    const evaluatedFlowThresholdRaw = numberOrNull(
        rawTiming.evaluatedFlowThresholdMs ?? rawTiming.evaluated_flow_threshold_ms
    );
    const timing: Record<string, any> = {
        earlyClickAttemptCount: clampInteger(rawTiming.earlyClickAttemptCount ?? rawTiming.early_click_attempt_count, 0, 100),
        fastAnswerCount: clampInteger(rawTiming.fastAnswerCount ?? rawTiming.fast_answer_count, 0, 30),
        timedAnswerCount: clampInteger(rawTiming.timedAnswerCount ?? rawTiming.timed_answer_count, 0, 30, samples.length),
        totalReadingTimeMs: clampInteger(rawTiming.totalReadingTimeMs ?? rawTiming.total_reading_time_ms, 0, 9_000_000),
        totalTransitionTimeMs: clampInteger(rawTiming.totalTransitionTimeMs ?? rawTiming.total_transition_time_ms, 0, 9_000_000),
        samples
    };
    if (firstSixRaw !== null) {
        timing.firstSixReadingTimeMs = clampInteger(firstSixRaw, 0, 1_800_000);
    }
    if (evaluatedFlowAnswerCountRaw !== null) {
        timing.evaluatedFlowAnswerCount = clampInteger(evaluatedFlowAnswerCountRaw, 3, 6);
    }
    if (evaluatedFlowReadingTimeRaw !== null) {
        timing.evaluatedFlowReadingTimeMs = clampInteger(evaluatedFlowReadingTimeRaw, 0, 1_800_000);
    }
    if (evaluatedFlowThresholdRaw !== null) {
        timing.evaluatedFlowThresholdMs = clampInteger(evaluatedFlowThresholdRaw, 0, 60_000);
    }

    return {
        version: 1,
        reasonCodes: normalizeEnumList(
            value.reasonCodes ?? value.reason_codes,
            QUALIFICATION_SAFEGUARD_REASONS,
            4
        ),
        typedChallenge: {
            status,
            reasonCodes: normalizeEnumList(
                rawChallenge.reasonCodes ?? rawChallenge.reason_codes,
                QUALIFICATION_CHALLENGE_REASONS,
                4
            ),
            failedAttempts: clampInteger(rawChallenge.failedAttempts ?? rawChallenge.failed_attempts, 0, 2)
        },
        timing
    };
}

function normalizeQuestionAnswer(entry: any): any | null {
    if (!entry || typeof entry !== 'object') return null;
    const questionId = boundedText(firstClean(entry.questionId, entry.question_id, entry.id), 80);
    const question = boundedText(firstClean(entry.question, entry.label, questionId), 500);
    const answerId = boundedText(firstClean(entry.answerId, entry.answer_id, entry.value), 120);
    const answer = boundedText(firstClean(entry.answer, entry.text, answerId), 500);
    if (!questionId && !question && !answerId && !answer) return null;
    return {
        questionId: questionId || '',
        question: question || questionId || 'Question',
        answerId: answerId || answer || '',
        answer: answer || answerId || 'Answer'
    };
}

function qualificationAnswersFromProgress(progress: any): any[] {
    if (!progress || typeof progress !== 'object') return [];
    const raw = Array.isArray(progress.questionsAndAnswers)
        ? progress.questionsAndAnswers
        : Array.isArray(progress.questions_and_answers)
            ? progress.questions_and_answers
            : [];
    return raw.map(normalizeQuestionAnswer).filter(Boolean).slice(0, 30);
}

function normalizeQualificationProgress(body: any): Record<string, any> {
    const raw = body?.qualification_progress || body?.qualificationProgress || {};
    const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const bodyQuestions = Array.isArray(body?.qualification_questions_and_answers)
        ? body.qualification_questions_and_answers
        : Array.isArray(body?.qualificationQuestionsAndAnswers)
            ? body.qualificationQuestionsAndAnswers
            : [];
    const questionsAndAnswers = qualificationAnswersFromProgress({
        questionsAndAnswers: qualificationAnswersFromProgress(base).length
            ? qualificationAnswersFromProgress(base)
            : bodyQuestions
    });
    const revision = numberOrNull(base.revision ?? body?.qualification_progress_revision);
    const answeredCount = numberOrNull(base.answeredCount ?? base.answered_count ?? body?.qualification_progress_answered_count) ?? questionsAndAnswers.length;
    const progress: Record<string, any> = {};
    const status = firstClean(base.status, body?.qualification_progress_status);
    const trigger = firstClean(base.trigger, body?.qualification_progress_trigger);
    const currentStep = firstClean(base.currentStep, base.current_step, body?.qualification_progress_current_step);
    const updatedAt = firstClean(base.progressUpdatedAt, base.progress_updated_at, body?.qualification_progress_updated_at);
    const decision = firstClean(base.decision, body?.qualification_decision);
    const reasonCode = firstClean(base.reasonCode, base.reason_code, body?.qualification_reason_code);
    const safeguards = normalizeQualificationSafeguards(
        base.safeguards ?? body?.qualification_safeguards ?? body?.qualificationSafeguards
    );
    if (status) progress.status = status;
    if (trigger) progress.trigger = trigger;
    if (revision !== null) progress.revision = Math.max(0, Math.floor(revision));
    if (currentStep) progress.currentStep = currentStep;
    progress.answeredCount = Math.max(0, Math.floor(answeredCount));
    if (questionsAndAnswers.length) progress.questionsAndAnswers = questionsAndAnswers;
    if (updatedAt) progress.progressUpdatedAt = updatedAt;
    if (decision) progress.decision = decision;
    if (reasonCode) progress.reasonCode = reasonCode;
    if (safeguards) progress.safeguards = safeguards;
    return Object.keys(progress).length ? progress : {};
}

function qualificationDecision(body: any, progress: any): string | null {
    return firstClean(
        body?.qualification_decision,
        body?.qualificationDecision,
        progress?.decision
    )?.toLowerCase().replace(/[\s-]+/g, '_') || null;
}

function hasProgress(progress: any): boolean {
    return Boolean(progress && typeof progress === 'object' && Object.keys(progress).length > 0);
}

function answerMatches(progress: any, questionId: string, patterns: RegExp[]): boolean {
    return qualificationAnswersFromProgress(progress).some(answer => {
        if (answer.questionId !== questionId) return false;
        const text = `${answer.answerId} ${answer.answer}`.toLowerCase();
        return patterns.some(pattern => pattern.test(text));
    });
}

function progressLooksQualified(progress: any): boolean {
    const paidPositive = answerMatches(progress, 'paid_intent', [/ready/, /discount/, /yes/, /can pay/]);
    const businessUse = answerMatches(progress, 'business_use', [/business/, /agency/]);
    const productNeed =
        answerMatches(progress, 'primary_intent', [/bulk/, /crm/, /automation/, /business-api/, /business api/, /competitor/, /ban-resolution/]) ||
        answerMatches(progress, 'api_intent', [/paid/]) ||
        answerMatches(progress, 'support_issue', [/business software/]) ||
        answerMatches(progress, 'ban_bulk', [/yes/]) ||
        answerMatches(progress, 'ban_type', [/business/, /safer/]);
    const acceptableBudget = qualificationAnswersFromProgress(progress).some(answer => {
        if (answer.questionId !== 'monthly_budget') return false;
        const text = `${answer.answerId} ${answer.answer}`.toUpperCase();
        const amount = Number((text.match(/\d+/) || [])[0]);
        if (!Number.isFinite(amount)) return false;
        return text.includes('USD') ? amount >= 20 : amount >= 1000;
    });
    return (paidPositive && productNeed) || (businessUse && (paidPositive || acceptableBudget));
}

function challengeBlocksQualification(progress: any): boolean {
    const status = clean(progress?.safeguards?.typedChallenge?.status);
    return status === 'pending' || status === 'failed';
}

function inferStatusFromPayload(body: any, progress: any): LeadStatus {
    if (challengeBlocksQualification(progress)) return 'useless';
    const decision = qualificationDecision(body, progress);
    if (decision === 'qualified_now' || decision === 'qualified_future') return 'maybe';
    if (decision === 'rejected' || decision === 'nurture_only') return 'useless';
    if (progressLooksQualified(progress)) return 'maybe';
    if (hasProgress(progress)) return 'useless';
    return 'new';
}

function parseSubmittedAt(value: any): string | null {
    const text = clean(value);
    if (!text) return null;
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function pickBody(raw: any): any {
    return raw?.webhook?.request?.body
        || raw?.request?.body
        || raw?.body
        || raw;
}

function booleanFlag(value: any): boolean | null {
    if (typeof value === 'boolean') return value;
    const normalized = clean(value)?.toLowerCase();
    if (['true', '1', 'yes'].includes(normalized || '')) return true;
    if (['false', '0', 'no'].includes(normalized || '')) return false;
    return null;
}

function isTrackingOnlyWebhook(body: any): boolean {
    const explicit = booleanFlag(body?.tracking_only ?? body?.trackingOnly);
    if (explicit !== null) return explicit;
    const eventId = clean(body?.event_id);
    return Boolean(
        eventId?.startsWith('qualification_progress:') &&
        !firstClean(body?.qualification_decision, body?.qualificationDecision)
    );
}

function sessionKeyFor(body: any): { key: string; type: string } {
    const candidates = [
        ['session_id', body.session_id],
        ['gclid', body.gclid],
        ['gbraid', body.gbraid],
        ['wbraid', body.wbraid],
        ['lead_id', body.lead_id]
    ];
    for (const [type, value] of candidates) {
        const cleaned = clean(value);
        if (cleaned) {
            const key = `${type}:${cleaned}`;
            if (key.length > 220) throw new LeadValidationError(`${type} is too long.`);
            return { key, type };
        }
    }
    throw new LeadValidationError('Lead webhook requires at least one of session_id, gclid, gbraid, wbraid, or lead_id.');
}

function eventIdFor(raw: any, body: any, sessionKey: string): string {
    const explicit = clean(raw?.webhook?.id) || clean(raw?.triggerWebhookId) || clean(body.event_id);
    if (explicit) return explicit.slice(0, 160);
    const hash = crypto.createHash('sha256')
        .update(JSON.stringify({
            sessionKey,
            kind: body.kind || null,
            lead_id: body.lead_id || null,
            submittedAt: body.submittedAt || body.submitted_at || null,
            payload: body
        }))
        .digest('hex');
    return `lead_evt_${hash}`;
}

export function normalizeLeadWebhookPayload(raw: any): NormalizedLeadEvent {
    if (!raw || typeof raw !== 'object') throw new LeadValidationError('Lead webhook payload must be a JSON object.');
    const body = pickBody(raw);
    if (!body || typeof body !== 'object') throw new LeadValidationError('Lead webhook body must be a JSON object.');

    const session = sessionKeyFor(body);
    const googleAds = body.google_ads || body.googleAds || {};
    const attribution = body.attribution || body.ads || {};
    const utmTerm = clean(body.utm_term);
    const utmContent = clean(body.utm_content);
    const phone = firstClean(body.fullPhoneNumber, body.phoneNumber, body.phone, body.contact_number, body.contactNumber);
    const qualificationProgress = normalizeQualificationProgress(body);
    const explicitStatus = firstClean(body.status, body.lead_status, body.manual_status, body.quality_status);
    const normalizedExplicitStatus = explicitStatus ? normalizeStatus(explicitStatus) : null;
    const status = (normalizedExplicitStatus === 'qualified' || normalizedExplicitStatus === 'maybe') && challengeBlocksQualification(qualificationProgress)
        ? 'useless'
        : normalizedExplicitStatus || inferStatusFromPayload(body, qualificationProgress);
    return {
        event_id: eventIdFor(raw, body, session.key),
        session_key: session.key,
        session_key_type: session.type,
        kind: clean(body.kind),
        source: clean(body.source),
        lead_id: clean(body.lead_id),
        session_id: clean(body.session_id),
        gclid: clean(body.gclid),
        gbraid: clean(body.gbraid),
        wbraid: clean(body.wbraid),
        utm_source: clean(body.utm_source),
        utm_medium: clean(body.utm_medium),
        utm_campaign: clean(body.utm_campaign),
        ad_group_id: firstClean(
            body.ad_group_id,
            body.adGroupId,
            body.google_ad_group_id,
            body.googleAdGroupId,
            googleAds.ad_group_id,
            googleAds.adGroupId,
            attribution.ad_group_id,
            attribution.adGroupId,
            body.utm_ad_group,
            body.utm_adgroup
        ),
        utm_term: utmTerm,
        utm_content: utmContent,
        keyword: firstClean(
            body.keyword,
            body.keyword_text,
            body.keywordText,
            body.matched_keyword,
            body.matchedKeyword,
            body.google_keyword,
            body.googleKeyword,
            googleAds.keyword,
            googleAds.keyword_text,
            googleAds.keywordText,
            attribution.keyword,
            attribution.keyword_text,
            attribution.keywordText,
            utmTerm
        ),
        match_type: normalizeMatchType(firstClean(
            body.match_type,
            body.matchType,
            body.keyword_match_type,
            body.keywordMatchType,
            body.google_match_type,
            body.googleMatchType,
            googleAds.match_type,
            googleAds.matchType,
            googleAds.keyword_match_type,
            googleAds.keywordMatchType,
            attribution.match_type,
            attribution.matchType
        )) || matchTypeFromUtmContent(utmContent),
        name: clean(body.name),
        email: clean(body.email),
        phone,
        tracking_only: isTrackingOnlyWebhook(body),
        status,
        progress_status: clean(qualificationProgress.status),
        progress_trigger: clean(qualificationProgress.trigger),
        progress_revision: numberOrNull(qualificationProgress.revision),
        progress_answered_count: numberOrNull(qualificationProgress.answeredCount),
        qualification_progress: qualificationProgress,
        submitted_at: parseSubmittedAt(body.submittedAt || body.submitted_at),
        payload: raw
    };
}

export async function ensureLeadSchema(pool: Pool): Promise<void> {
    const key = pool as unknown as object;
    const existing = leadSchemaReadyByPool.get(key);
    if (existing) return existing;
    const ready = ensureLeadSchemaInternal(pool).catch(err => {
        leadSchemaReadyByPool.delete(key);
        throw err;
    });
    leadSchemaReadyByPool.set(key, ready);
    return ready;
}

async function ensureLeadSchemaInternal(pool: Pool): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS lead_events (
            event_id VARCHAR(160) PRIMARY KEY,
            session_key VARCHAR(220) NOT NULL,
            session_key_type VARCHAR(40) NOT NULL,
            kind VARCHAR(80),
            source VARCHAR(80),
            lead_id VARCHAR(120),
            session_id VARCHAR(120),
            gclid TEXT,
            gbraid TEXT,
            wbraid TEXT,
            utm_source TEXT,
            utm_medium TEXT,
            utm_campaign TEXT,
            ad_group_id TEXT,
            utm_term TEXT,
            utm_content TEXT,
            keyword TEXT,
            match_type TEXT,
            name TEXT,
            email TEXT,
            phone TEXT,
            tracking_only BOOLEAN NOT NULL DEFAULT FALSE,
            status VARCHAR(40) NOT NULL DEFAULT 'new',
            status_rank INTEGER NOT NULL DEFAULT 0,
            progress_status VARCHAR(40),
            progress_trigger VARCHAR(40),
            progress_revision INTEGER,
            progress_answered_count INTEGER,
            qualification_progress JSONB NOT NULL DEFAULT '{}'::jsonb,
            submitted_at TIMESTAMP,
            received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            payload JSONB NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE INDEX IF NOT EXISTS lead_events_session_key_idx ON lead_events(session_key);
        CREATE INDEX IF NOT EXISTS lead_events_session_key_time_idx
            ON lead_events(session_key, (COALESCE(submitted_at, received_at)), received_at);
        CREATE INDEX IF NOT EXISTS lead_events_utm_campaign_idx ON lead_events(utm_campaign);
        CREATE INDEX IF NOT EXISTS lead_events_utm_term_idx ON lead_events(utm_term);
        CREATE INDEX IF NOT EXISTS lead_events_ad_group_id_idx ON lead_events(ad_group_id);

        CREATE TABLE IF NOT EXISTS lead_sessions (
            session_key VARCHAR(220) PRIMARY KEY,
            session_key_type VARCHAR(40) NOT NULL,
            status VARCHAR(40) NOT NULL DEFAULT 'new',
            status_rank INTEGER NOT NULL DEFAULT 0,
            progress_status VARCHAR(40),
            progress_trigger VARCHAR(40),
            progress_revision INTEGER,
            progress_answered_count INTEGER,
            qualification_progress JSONB NOT NULL DEFAULT '{}'::jsonb,
            lead_source VARCHAR(80),
            first_seen TIMESTAMP NOT NULL,
            last_seen TIMESTAMP NOT NULL,
            event_count INTEGER NOT NULL DEFAULT 0,
            event_count_version SMALLINT NOT NULL DEFAULT 0,
            lead_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
            contact JSONB NOT NULL DEFAULT '{}'::jsonb,
            attribution JSONB NOT NULL DEFAULT '{}'::jsonb,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS lead_sessions_status_idx ON lead_sessions(status);
        CREATE INDEX IF NOT EXISTS lead_sessions_first_seen_idx ON lead_sessions(first_seen);
        CREATE INDEX IF NOT EXISTS lead_sessions_last_seen_idx ON lead_sessions(last_seen DESC);
        CREATE INDEX IF NOT EXISTS lead_sessions_utm_campaign_expr_idx ON lead_sessions ((attribution->>'utm_campaign'));
        CREATE INDEX IF NOT EXISTS lead_sessions_ad_group_expr_idx ON lead_sessions ((attribution->>'ad_group_id'));

        ALTER TABLE lead_events ADD COLUMN IF NOT EXISTS progress_status VARCHAR(40);
        ALTER TABLE lead_events ADD COLUMN IF NOT EXISTS progress_trigger VARCHAR(40);
        ALTER TABLE lead_events ADD COLUMN IF NOT EXISTS progress_revision INTEGER;
        ALTER TABLE lead_events ADD COLUMN IF NOT EXISTS progress_answered_count INTEGER;
        ALTER TABLE lead_events ADD COLUMN IF NOT EXISTS qualification_progress JSONB NOT NULL DEFAULT '{}'::jsonb;
        ALTER TABLE lead_events ADD COLUMN IF NOT EXISTS tracking_only BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE lead_events ADD COLUMN IF NOT EXISTS source VARCHAR(80);
        ALTER TABLE lead_sessions ADD COLUMN IF NOT EXISTS progress_status VARCHAR(40);
        ALTER TABLE lead_sessions ADD COLUMN IF NOT EXISTS progress_trigger VARCHAR(40);
        ALTER TABLE lead_sessions ADD COLUMN IF NOT EXISTS progress_revision INTEGER;
        ALTER TABLE lead_sessions ADD COLUMN IF NOT EXISTS progress_answered_count INTEGER;
        ALTER TABLE lead_sessions ADD COLUMN IF NOT EXISTS qualification_progress JSONB NOT NULL DEFAULT '{}'::jsonb;
        ALTER TABLE lead_sessions ADD COLUMN IF NOT EXISTS event_count_version SMALLINT NOT NULL DEFAULT 0;
        ALTER TABLE lead_sessions ADD COLUMN IF NOT EXISTS lead_source VARCHAR(80);
        CREATE INDEX IF NOT EXISTS lead_events_progress_revision_idx ON lead_events(session_key, progress_revision);
        CREATE INDEX IF NOT EXISTS lead_sessions_progress_status_idx ON lead_sessions(progress_status);

        UPDATE lead_events
        SET source = NULLIF(COALESCE(
            payload->>'source',
            payload#>>'{webhook,request,body,source}',
            payload#>>'{request,body,source}',
            payload#>>'{body,source}',
            ''
        ), '')
        WHERE NULLIF(source, '') IS NULL;

        UPDATE lead_sessions AS session
        SET lead_source = first_event.lead_source
        FROM (
            SELECT DISTINCT ON (session_key)
                   session_key,
                   COALESCE(NULLIF(source, ''), NULLIF(kind, '')) AS lead_source
            FROM lead_events
            WHERE COALESCE(NULLIF(source, ''), NULLIF(kind, '')) IS NOT NULL
              AND COALESCE(kind, '') <> 'manual_status_update'
            ORDER BY session_key, COALESCE(submitted_at, received_at) ASC, received_at ASC
        ) AS first_event
        WHERE session.session_key = first_event.session_key
          AND NULLIF(session.lead_source, '') IS NULL;

        UPDATE lead_events
        SET tracking_only = TRUE
        WHERE tracking_only = FALSE
          AND event_id LIKE 'qualification_progress:%'
          AND NULLIF(COALESCE(
              payload->>'qualification_decision',
              payload->>'qualificationDecision',
              payload#>>'{webhook,request,body,qualification_decision}',
              payload#>>'{webhook,request,body,qualificationDecision}',
              payload#>>'{request,body,qualification_decision}',
              payload#>>'{request,body,qualificationDecision}',
              payload#>>'{body,qualification_decision}',
              payload#>>'{body,qualificationDecision}',
              ''
          ), '') IS NULL;

        UPDATE lead_sessions AS session
        SET event_count = counts.event_count,
            event_count_version = 1,
            updated_at = CASE
                WHEN session.event_count IS DISTINCT FROM counts.event_count
                THEN CURRENT_TIMESTAMP
                ELSE session.updated_at
            END
        FROM (
            SELECT event.session_key AS session_key,
                   COUNT(*) FILTER (
                       WHERE event.tracking_only = FALSE
                         AND kind IS NOT NULL
                         AND kind <> 'manual_status_update'
                   )::int AS event_count
            FROM lead_events AS event
            INNER JOIN lead_sessions AS pending_session
                    ON pending_session.session_key = event.session_key
                   AND pending_session.event_count_version < 1
            GROUP BY event.session_key
        ) AS counts
        WHERE session.session_key = counts.session_key
          AND session.event_count_version < 1;
    `);
}

export async function rebuildLeadSession(pool: Queryable, sessionKey: string): Promise<void> {
    const { rows } = await pool.query(
        `SELECT *
         FROM lead_events
         WHERE session_key = $1
         ORDER BY COALESCE(submitted_at, received_at) ASC, received_at ASC`,
        [sessionKey]
    );
    if (rows.length === 0) return;

    const first = rows[0];
    const latest = rows[rows.length - 1];
    const reversedRows = [...rows].reverse();
    const latestStatusRow = reversedRows.find(row => row.status && row.status !== 'new') || first;
    const latestProgressRow = rows
        .filter(row => Object.keys(jsonObject(row.qualification_progress)).length > 0 || row.progress_revision !== null)
        .slice()
        .sort((a, b) => {
            const revisionDelta = Number(a.progress_revision || 0) - Number(b.progress_revision || 0);
            if (revisionDelta !== 0) return revisionDelta;
            return eventTimestamp(a).getTime() - eventTimestamp(b).getTime();
        })
        .pop();
    const latestProgress = latestProgressRow ? jsonObject(latestProgressRow.qualification_progress) : {};
    const leadIds = Array.from(new Set(rows.map(row => row.lead_id).filter(Boolean)));
    const firstValue = (field: string) => clean(rows.find(row => clean(row[field]))?.[field]);
    const latestValue = (field: string) => clean(reversedRows.find(row => clean(row[field]))?.[field]);
    const attributionSource = rows.find(row => row.utm_campaign || row.ad_group_id || row.utm_term || row.gclid || row.gbraid || row.wbraid || row.keyword || row.match_type) || first;
    const utmContent = firstValue('utm_content') || attributionSource.utm_content || null;
    const firstSeen = first.submitted_at || first.received_at;
    const lastSeen = latest.submitted_at || latest.received_at;
    const actionCount = rows.filter(row =>
        !row.tracking_only &&
        clean(row.kind) &&
        row.kind !== 'manual_status_update'
    ).length;
    const firstSourceEvent = rows.find(row => row.kind !== 'manual_status_update' && clean(row.source));
    const firstKindEvent = rows.find(row => row.kind !== 'manual_status_update' && clean(row.kind));
    const leadSource = clean(firstSourceEvent?.source) || clean(firstKindEvent?.kind) || null;

    await pool.query(
        `INSERT INTO lead_sessions
         (session_key, session_key_type, status, status_rank, progress_status, progress_trigger, progress_revision, progress_answered_count, qualification_progress, lead_source, first_seen, last_seen, event_count, event_count_version, lead_ids, contact, attribution, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1, $14, $15, $16, CURRENT_TIMESTAMP)
         ON CONFLICT (session_key) DO UPDATE SET
            session_key_type = EXCLUDED.session_key_type,
            status = EXCLUDED.status,
            status_rank = EXCLUDED.status_rank,
            progress_status = EXCLUDED.progress_status,
            progress_trigger = EXCLUDED.progress_trigger,
            progress_revision = EXCLUDED.progress_revision,
            progress_answered_count = EXCLUDED.progress_answered_count,
            qualification_progress = EXCLUDED.qualification_progress,
            lead_source = COALESCE(EXCLUDED.lead_source, lead_sessions.lead_source),
            first_seen = EXCLUDED.first_seen,
            last_seen = EXCLUDED.last_seen,
            event_count = EXCLUDED.event_count,
            event_count_version = EXCLUDED.event_count_version,
            lead_ids = EXCLUDED.lead_ids,
            contact = EXCLUDED.contact,
            attribution = EXCLUDED.attribution,
            updated_at = CURRENT_TIMESTAMP`,
        [
            sessionKey,
            first.session_key_type,
            latestStatusRow.status,
            latestStatusRow.status_rank,
            clean(latestProgress.status),
            clean(latestProgress.trigger),
            numberOrNull(latestProgress.revision),
            numberOrNull(latestProgress.answeredCount),
            latestProgress,
            leadSource,
            firstSeen,
            lastSeen,
            actionCount,
            JSON.stringify(leadIds),
            {
                name: latestValue('name'),
                email: latestValue('email'),
                phone: latestValue('phone')
            },
            {
                utm_source: firstValue('utm_source') || attributionSource.utm_source || null,
                utm_medium: firstValue('utm_medium') || attributionSource.utm_medium || null,
                utm_campaign: firstValue('utm_campaign') || attributionSource.utm_campaign || null,
                ad_group_id: firstValue('ad_group_id') || attributionSource.ad_group_id || null,
                utm_term: firstValue('utm_term') || attributionSource.utm_term || null,
                utm_content: utmContent,
                keyword: firstValue('keyword') || attributionSource.keyword || firstValue('utm_term') || attributionSource.utm_term || null,
                match_type: firstValue('match_type') || attributionSource.match_type || matchTypeFromUtmContent(utmContent),
                gclid: firstValue('gclid') || attributionSource.gclid || null,
                gbraid: firstValue('gbraid') || attributionSource.gbraid || null,
                wbraid: firstValue('wbraid') || attributionSource.wbraid || null
            }
        ]
    );
}

function advisoryLockKey(value: string): string {
    return crypto.createHash('sha256').update(value).digest().readBigInt64BE(0).toString();
}

async function upsertLeadEventWithClient(client: Queryable, event: NormalizedLeadEvent): Promise<void> {
    await client.query(
        `INSERT INTO lead_events
         (event_id, session_key, session_key_type, kind, lead_id, session_id, gclid, gbraid, wbraid,
          utm_source, utm_medium, utm_campaign, ad_group_id, utm_term, utm_content, keyword, match_type, name, email, phone,
          tracking_only, status, status_rank, progress_status, progress_trigger, progress_revision, progress_answered_count, qualification_progress, submitted_at, payload, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31)
         ON CONFLICT (event_id) DO UPDATE SET
            kind = COALESCE(EXCLUDED.kind, lead_events.kind),
            source = COALESCE(EXCLUDED.source, lead_events.source),
            lead_id = COALESCE(EXCLUDED.lead_id, lead_events.lead_id),
            session_id = COALESCE(EXCLUDED.session_id, lead_events.session_id),
            gclid = COALESCE(EXCLUDED.gclid, lead_events.gclid),
            gbraid = COALESCE(EXCLUDED.gbraid, lead_events.gbraid),
            wbraid = COALESCE(EXCLUDED.wbraid, lead_events.wbraid),
            utm_source = COALESCE(EXCLUDED.utm_source, lead_events.utm_source),
            utm_medium = COALESCE(EXCLUDED.utm_medium, lead_events.utm_medium),
            utm_campaign = COALESCE(EXCLUDED.utm_campaign, lead_events.utm_campaign),
            ad_group_id = COALESCE(EXCLUDED.ad_group_id, lead_events.ad_group_id),
            utm_term = COALESCE(EXCLUDED.utm_term, lead_events.utm_term),
            utm_content = COALESCE(EXCLUDED.utm_content, lead_events.utm_content),
            keyword = COALESCE(EXCLUDED.keyword, lead_events.keyword),
            match_type = COALESCE(EXCLUDED.match_type, lead_events.match_type),
            name = COALESCE(EXCLUDED.name, lead_events.name),
            email = COALESCE(EXCLUDED.email, lead_events.email),
            phone = COALESCE(EXCLUDED.phone, lead_events.phone),
            tracking_only = EXCLUDED.tracking_only,
            status = EXCLUDED.status,
            status_rank = EXCLUDED.status_rank,
            progress_status = COALESCE(EXCLUDED.progress_status, lead_events.progress_status),
            progress_trigger = COALESCE(EXCLUDED.progress_trigger, lead_events.progress_trigger),
            progress_revision = CASE
                WHEN COALESCE(EXCLUDED.progress_revision, -1) >= COALESCE(lead_events.progress_revision, -1)
                THEN EXCLUDED.progress_revision
                ELSE lead_events.progress_revision
            END,
            progress_answered_count = COALESCE(EXCLUDED.progress_answered_count, lead_events.progress_answered_count),
            qualification_progress = CASE
                WHEN COALESCE(EXCLUDED.progress_revision, -1) >= COALESCE(lead_events.progress_revision, -1)
                THEN EXCLUDED.qualification_progress
                ELSE lead_events.qualification_progress
            END,
            submitted_at = COALESCE(EXCLUDED.submitted_at, lead_events.submitted_at),
            payload = EXCLUDED.payload`,
        [
            event.event_id,
            event.session_key,
            event.session_key_type,
            event.kind,
            event.lead_id,
            event.session_id,
            event.gclid,
            event.gbraid,
            event.wbraid,
            event.utm_source,
            event.utm_medium,
            event.utm_campaign,
            event.ad_group_id,
            event.utm_term,
            event.utm_content,
            event.keyword,
            event.match_type,
            event.name,
            event.email,
            event.phone,
            event.tracking_only,
            event.status,
            STATUS_RANK[event.status],
            event.progress_status,
            event.progress_trigger,
            event.progress_revision,
            event.progress_answered_count,
            event.qualification_progress,
            event.submitted_at,
            event.payload,
            event.source
        ]
    );
}

export async function upsertLeadWebhookEvent(pool: Pool, raw: any): Promise<NormalizedLeadEvent> {
    await ensureLeadSchema(pool);
    const event = normalizeLeadWebhookPayload(raw);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [advisoryLockKey(event.session_key)]);
        const before = await client.query(`SELECT session_key, event_count FROM lead_sessions WHERE session_key = $1 FOR UPDATE`, [event.session_key]);
        const hadLeadAction = Number(before.rows[0]?.event_count || 0) > 0;
        await upsertLeadEventWithClient(client, event);
        await rebuildLeadSession(client, event.session_key);
        if (
            !event.tracking_only &&
            event.kind &&
            event.kind !== 'manual_status_update' &&
            !hadLeadAction
        ) {
            await enqueueLeadNotificationForSession(client, event);
        }
        await client.query('COMMIT');
        clearLeadAttributionSummaryCache();
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
    return event;
}

export type LeadStatusUpdateResult = {
    status: LeadStatus;
    updatedAt: string;
    conflict?: {
        serverStatus: LeadStatus;
        serverUpdatedAt: string;
    };
};

export async function recordLeadStatus(pool: Pool, input: { sessionKey: string; status: string; note?: string | null; baseUpdatedAt?: string | null }): Promise<LeadStatusUpdateResult> {
    await ensureLeadSchema(pool);
    const status = normalizeStatus(input.status);
    if (status === 'new') throw new LeadValidationError('Manual lead status must be useless, maybe, qualified, converted, or qualified_lost.');
    const sessionKey = clean(input.sessionKey);
    if (!sessionKey) throw new LeadValidationError('sessionKey is required.');
    if (sessionKey.length > 220) throw new LeadValidationError('sessionKey must be 220 characters or fewer.');
    const note = input.note === undefined || input.note === null ? null : String(input.note).trim();
    if (note && note.length > 1000) throw new LeadValidationError('note must be 1000 characters or fewer.');
    const hasBaseUpdatedAt = input.baseUpdatedAt !== undefined && input.baseUpdatedAt !== null && input.baseUpdatedAt !== '';
    const expectedUpdatedAt = hasBaseUpdatedAt ? new Date(String(input.baseUpdatedAt)).getTime() : null;
    if (hasBaseUpdatedAt && (expectedUpdatedAt === null || !Number.isFinite(expectedUpdatedAt))) {
        throw new LeadValidationError('baseUpdatedAt must be a valid timestamp.');
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const exists = await client.query('SELECT session_key, session_key_type, status, updated_at FROM lead_sessions WHERE session_key = $1 FOR UPDATE', [sessionKey]);
        const current = exists.rows[0];
        if (!current) throw new LeadValidationError(`Lead session not found: ${sessionKey}`);
        if (expectedUpdatedAt !== null) {
            const actual = new Date(current.updated_at).getTime();
            if (expectedUpdatedAt !== actual) {
                await client.query('ROLLBACK');
                return {
                    status: normalizeStatus(current.status),
                    updatedAt: new Date(current.updated_at).toISOString(),
                    conflict: {
                        serverStatus: normalizeStatus(current.status),
                        serverUpdatedAt: new Date(current.updated_at).toISOString()
                    }
                };
            }
        }
        const eventId = `manual_${crypto.randomUUID()}`;
        await client.query(
            `INSERT INTO lead_events
             (event_id, session_key, session_key_type, kind, status, status_rank, payload)
             VALUES ($1, $2::varchar, $3, 'manual_status_update', $4, $5, $6)`,
            [eventId, sessionKey, current.session_key_type, status, STATUS_RANK[status], { status, note: note || null }]
        );
        await rebuildLeadSession(client, sessionKey);
        const updated = await client.query(`SELECT status, updated_at FROM lead_sessions WHERE session_key = $1`, [sessionKey]);
        await client.query('COMMIT');
        clearLeadAttributionSummaryCache();
        return {
            status: normalizeStatus(updated.rows[0].status),
            updatedAt: new Date(updated.rows[0].updated_at).toISOString()
        };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
}

function campaignSpendMap(dashboardData: any): Map<string, { campaignId: string; campaignName: string | null; spend: number }> {
    const out = new Map<string, { campaignId: string; campaignName: string | null; spend: number }>();
    const rows = Array.isArray(dashboardData?.campaigns) ? dashboardData.campaigns : [];
    const nameToIds = new Map<string, Set<string>>();
    for (const row of rows) {
        const id = clean(row.id || row.campaignId);
        const campaignName = clean(row.name || row.campaign);
        if (!id || !campaignName) continue;
        const ids = nameToIds.get(campaignName) || new Set<string>();
        ids.add(id);
        nameToIds.set(campaignName, ids);
    }
    for (const row of rows) {
        const id = clean(row.id || row.campaignId);
        if (!id) continue;
        const campaignName = clean(row.name || row.campaign);
        const current = out.get(id) || { campaignId: id, campaignName: campaignName || null, spend: 0 };
        current.spend += Number(row.spend || 0);
        if (!current.campaignName && campaignName) current.campaignName = campaignName;
        out.set(id, current);
    }
    for (const current of Array.from(new Set(out.values()))) {
        if (!current.campaignName) continue;
        if ((nameToIds.get(current.campaignName)?.size || 0) === 1) out.set(current.campaignName, current);
    }
    return out;
}

function bumpLeadBucket(bucket: any, session: any): void {
    bucket.uniqueLeads += 1;
    bucket.eventCount += Number(session.event_count || 0);
    if (session.status === 'new') bucket.new += 1;
    if (session.status === 'useless') bucket.useless += 1;
    if (session.status === 'maybe') bucket.maybe += 1;
    if (session.status === 'qualified') bucket.qualified += 1;
    if (session.status === 'qualified_lost') bucket.qualifiedLost += 1;
    if (session.status === 'converted') bucket.converted += 1;
    if (session.status === 'maybe' || session.status === 'qualified') bucket.inProgress += 1;
    if (TERMINAL_STATUSES.has(session.status)) bucket.terminal += 1;
    if (session.status === 'qualified' || session.status === 'converted' || session.status === 'qualified_lost') bucket.qualifiedPipeline += 1;
    if (session.status === 'qualified' || session.status === 'converted') bucket.qualifiedOrConverted += 1;
}

function emptyLeadBucket(extra: Record<string, any> = {}): any {
    return {
        uniqueLeads: 0,
        eventCount: 0,
        new: 0,
        useless: 0,
        maybe: 0,
        qualified: 0,
        qualifiedLost: 0,
        converted: 0,
        inProgress: 0,
        terminal: 0,
        qualifiedPipeline: 0,
        qualifiedOrConverted: 0,
        ...extra
    };
}

function overviewCacheSeconds(): number {
    const value = Number(process.env.LEAD_ATTRIBUTION_OVERVIEW_CACHE_SECONDS);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_LEAD_ATTRIBUTION_OVERVIEW_CACHE_SECONDS;
}

function cloneJson<T>(value: T): T {
    return typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function leadAttributionOverviewCacheKey(dashboardData: any): string {
    const range = dashboardDateRange(dashboardData);
    const scope = dashboardLeadScope(dashboardData);
    return [
        'lead-overview',
        dashboardData?.meta?.accountId || 'unknown',
        range.start || '',
        range.end || '',
        scope.campaignId || '',
        scope.campaignNames.join('|'),
        scope.adGroupId || '',
        scope.adGroupNames.join('|')
    ].join(':');
}

export function clearLeadAttributionSummaryCache(): void {
    leadAttributionOverviewCache.clear();
}

type LeadAttributionScope = {
    campaignId: string | null;
    campaignNames: string[];
    adGroupId: string | null;
    adGroupNames: string[];
};

function matchingName(rows: any[], selectedId: string | null, idFields: string[], nameFields: string[]): string | null {
    if (!selectedId) return null;
    for (const row of rows) {
        const ids = idFields.map(field => clean(row?.[field])).filter((value): value is string => Boolean(value));
        if (!ids.includes(selectedId)) continue;
        return nameFields.map(field => clean(row?.[field])).find((value): value is string => Boolean(value)) || null;
    }
    return null;
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
    return Array.from(new Set(values.map(value => clean(value)).filter((value): value is string => Boolean(value))));
}

function dashboardLeadScope(dashboardData: any): LeadAttributionScope {
    const filters = dashboardData?.meta?.filters || {};
    const campaignId = clean(filters.campaignId);
    const adGroupId = clean(filters.adGroupId);
    const campaigns = [
        ...(Array.isArray(dashboardData?.campaigns) ? dashboardData.campaigns : []),
        ...(Array.isArray(dashboardData?.filterOptions?.campaigns) ? dashboardData.filterOptions.campaigns : [])
    ];
    const adGroups = [
        ...(Array.isArray(dashboardData?.adGroups) ? dashboardData.adGroups : []),
        ...(Array.isArray(dashboardData?.filterOptions?.adGroups) ? dashboardData.filterOptions.adGroups : [])
    ];
    return {
        campaignId,
        campaignNames: uniqueNonEmpty([
            matchingName(campaigns, campaignId, ['id', 'campaignId'], ['name', 'campaignName', 'campaign']),
            matchingName(adGroups, campaignId, ['campaignId'], ['campaignName', 'campaign'])
        ]),
        adGroupId,
        adGroupNames: uniqueNonEmpty([
            matchingName(adGroups, adGroupId, ['id', 'adGroupId'], ['name', 'adGroupName', 'adGroup'])
        ])
    };
}

function leadAttributionScopeSummary(scope: LeadAttributionScope): Record<string, any> {
    return {
        campaignId: scope.campaignId,
        campaignNames: scope.campaignNames,
        adGroupId: scope.adGroupId,
        adGroupNames: scope.adGroupNames,
        level: scope.adGroupId ? 'ad_group' : scope.campaignId ? 'campaign' : 'account',
        adGroupField: scope.adGroupId ? 'attribution.ad_group_id' : null
    };
}

function sessionDateWhere(
    dateRange: { start: string | null; end: string | null },
    scope: LeadAttributionScope = { campaignId: null, campaignNames: [], adGroupId: null, adGroupNames: [] }
): { where: string; params: any[] } {
    const params: any[] = [];
    const conditions: string[] = [];
    if (dateRange.start) {
        params.push(dateRange.start);
        conditions.push(`first_seen >= $${params.length}::date`);
    }
    if (dateRange.end) {
        params.push(dateRange.end);
        conditions.push(`first_seen < ($${params.length}::date + INTERVAL '1 day')`);
    }
    if (scope.campaignId) {
        params.push(uniqueNonEmpty([scope.campaignId, ...scope.campaignNames]));
        conditions.push(`attribution->>'utm_campaign' = ANY($${params.length}::text[])`);
    }
    if (scope.adGroupId) {
        params.push(uniqueNonEmpty([scope.adGroupId, ...scope.adGroupNames]));
        conditions.push(`attribution->>'ad_group_id' = ANY($${params.length}::text[])`);
    }
    return {
        where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
        params
    };
}

function bumpLeadBucketByCount(bucket: any, statusValue: any, uniqueLeads: any, eventCount: any): void {
    const status = normalizeStatus(statusValue);
    const count = Number(uniqueLeads || 0);
    bucket.uniqueLeads += count;
    bucket.eventCount += Number(eventCount || 0);
    if (status === 'new') bucket.new += count;
    if (status === 'useless') bucket.useless += count;
    if (status === 'maybe') bucket.maybe += count;
    if (status === 'qualified') bucket.qualified += count;
    if (status === 'qualified_lost') bucket.qualifiedLost += count;
    if (status === 'converted') bucket.converted += count;
    if (status === 'maybe' || status === 'qualified') bucket.inProgress += count;
    if (TERMINAL_STATUSES.has(status)) bucket.terminal += count;
    if (status === 'qualified' || status === 'converted' || status === 'qualified_lost') bucket.qualifiedPipeline += count;
    if (status === 'qualified' || status === 'converted') bucket.qualifiedOrConverted += count;
}

function bucketFromStatusRows(rows: any[], extra: Record<string, any> = {}): any {
    const bucket = emptyLeadBucket(extra);
    for (const row of rows) {
        bumpLeadBucketByCount(bucket, row.status, row.unique_leads, row.event_count);
    }
    return bucket;
}

function periodMetricsFromBucket(bucket: any): Record<string, number> {
    return {
        realConversions: Number(bucket.uniqueLeads || 0),
        realMaybe: Number(bucket.maybe || 0),
        realQualified: Number(bucket.qualified || 0),
        realQualifiedLost: Number(bucket.qualifiedLost || 0),
        realConverted: Number(bucket.converted || 0),
        realUseless: Number(bucket.useless || 0),
        realNew: Number(bucket.new || 0),
        realEventCount: Number(bucket.eventCount || 0)
    };
}

function jsonObject(value: any): any {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch {
            return {};
        }
    }
    return {};
}

function jsonArray(value: any): any[] {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return [];
}

function eventTimestamp(row: any): Date {
    const date = new Date(row.submitted_at || row.received_at || 0);
    return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function buildLeadJourneySummary(sessions: any[], events: any[]): any {
    const eventsBySession = new Map<string, any[]>();
    for (const event of events) {
        const list = eventsBySession.get(event.session_key) || [];
        list.push(event);
        eventsBySession.set(event.session_key, list);
    }

    const actionTotals = new Map<string, number>();
    const pairTotals = new Map<string, { from: string; to: string; sessions: number }>();
    const pathTotals = new Map<string, number>();
    const flowEdgeTotals = new Map<string, { from: string; to: string; sessions: number }>();
    const pathStatusTotals = new Map<string, { path: string; status: string; sessions: number }>();
    const journeyRows: any[] = [];

    for (const session of sessions) {
        const sessionEvents = (eventsBySession.get(session.session_key) || [])
            .slice()
            .sort((a, b) => eventTimestamp(a).getTime() - eventTimestamp(b).getTime());
        const actions = sessionEvents
            .filter(event =>
                !booleanFlag(event.tracking_only) &&
                event.kind &&
                event.kind !== 'manual_status_update'
            )
            .map(event => String(event.kind || 'lead').trim())
            .filter(Boolean);
        const uniqueActions = Array.from(new Set(actions));
        for (const action of uniqueActions) {
            actionTotals.set(action, (actionTotals.get(action) || 0) + 1);
        }
        for (let i = 0; i < uniqueActions.length; i++) {
            for (let j = i + 1; j < uniqueActions.length; j++) {
                const from = uniqueActions[i];
                const to = uniqueActions[j];
                const key = `${from} -> ${to}`;
                const bucket = pairTotals.get(key) || { from, to, sessions: 0 };
                bucket.sessions += 1;
                pairTotals.set(key, bucket);
            }
        }
        const path = actions.length ? actions.join(' -> ') : '(no action kind)';
        pathTotals.set(path, (pathTotals.get(path) || 0) + 1);
        const flowNodes = ['Session start', ...actions, `Outcome: ${String(session.status || 'new').replace(/_/g, ' ')}`];
        for (let i = 0; i < flowNodes.length - 1; i++) {
            const from = flowNodes[i];
            const to = flowNodes[i + 1];
            const key = `${from} -> ${to}`;
            const bucket = flowEdgeTotals.get(key) || { from, to, sessions: 0 };
            bucket.sessions += 1;
            flowEdgeTotals.set(key, bucket);
        }
        const pathStatusKey = `${path}|${session.status}`;
        const pathStatusBucket = pathStatusTotals.get(pathStatusKey) || { path, status: session.status, sessions: 0 };
        pathStatusBucket.sessions += 1;
        pathStatusTotals.set(pathStatusKey, pathStatusBucket);
        journeyRows.push({
            sessionKey: session.session_key,
            status: session.status,
            actionCount: actions.length,
            uniqueActionCount: uniqueActions.length,
            actionPath: path,
            firstSeen: session.first_seen,
            lastSeen: session.last_seen
        });
    }

    const totalSessions = sessions.length || 1;
    return {
        totalSessions: sessions.length,
        sessionsWithMultipleActions: journeyRows.filter(row => row.uniqueActionCount > 1).length,
        topActionOverlaps: Array.from(pairTotals.values())
            .map(pair => ({
                ...pair,
                percentOfFrom: Number(((pair.sessions / Math.max(actionTotals.get(pair.from) || 0, 1)) * 100).toFixed(2)),
                percentOfAll: Number(((pair.sessions / totalSessions) * 100).toFixed(2))
            }))
            .sort((a, b) => b.sessions - a.sessions || b.percentOfFrom - a.percentOfFrom)
            .slice(0, 50),
        topPaths: Array.from(pathTotals.entries())
            .map(([path, sessions]) => ({
                path,
                sessions,
                percentOfAll: Number(((sessions / totalSessions) * 100).toFixed(2))
            }))
            .sort((a, b) => b.sessions - a.sessions)
            .slice(0, 50),
        flowEdges: Array.from(flowEdgeTotals.values())
            .map(edge => ({
                ...edge,
                percentOfAll: Number(((edge.sessions / totalSessions) * 100).toFixed(2))
            }))
            .sort((a, b) => b.sessions - a.sessions)
            .slice(0, 120),
        pathOutcomes: Array.from(pathStatusTotals.values())
            .map(row => ({
                ...row,
                percentOfAll: Number(((row.sessions / totalSessions) * 100).toFixed(2))
            }))
            .sort((a, b) => b.sessions - a.sessions)
            .slice(0, 100),
        recentJourneys: journeyRows.slice(0, 50)
    };
}

function groupEventsBySession(events: any[]): Map<string, any[]> {
    const out = new Map<string, any[]>();
    for (const event of events) {
        const list = out.get(event.session_key) || [];
        list.push(event);
        out.set(event.session_key, list);
    }
    for (const list of out.values()) {
        list.sort((a, b) => eventTimestamp(a).getTime() - eventTimestamp(b).getTime());
    }
    return out;
}

function firstEventValue(events: any[], field: string): string | null {
    for (const event of events) {
        const value = clean(event[field]);
        if (value) return value;
    }
    return null;
}

function latestEventValue(events: any[], field: string): string | null {
    for (let i = events.length - 1; i >= 0; i--) {
        const value = clean(events[i][field]);
        if (value) return value;
    }
    return null;
}

function hasClickId(attribution: any): boolean {
    return Boolean(clean(attribution?.gclid) || clean(attribution?.gbraid) || clean(attribution?.wbraid));
}

function formatToIST(dateVal: any): string | null {
    if (!dateVal) return null;
    const date = new Date(dateVal);
    if (isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'short'
    }).format(date);
}

function buildLeadRows(
    sessions: any[],
    events: any[],
    journeySummary: any,
    spendByCampaign: Map<string, { campaignId: string; campaignName: string | null; spend: number }>
): any[] {
    const eventsBySession = groupEventsBySession(events);
    const journeyBySession = new Map<string, any>(
        (Array.isArray(journeySummary?.recentJourneys) ? journeySummary.recentJourneys : [])
            .map((journey: any) => [journey.sessionKey, journey])
    );

    return sessions.map(session => {
        const sessionEvents = eventsBySession.get(session.session_key) || [];
        const hasStoredLeadActions = session.lead_actions !== undefined && session.lead_actions !== null;
        const rawLeadActions = hasStoredLeadActions ? jsonArray(session.lead_actions) : sessionEvents;
        const leadActions = rawLeadActions
            .filter(event =>
                !booleanFlag(event.tracking_only ?? event.trackingOnly) &&
                clean(event.kind) &&
                clean(event.kind) !== 'manual_status_update'
            )
            .map(event => ({
                eventId: clean(event.event_id ?? event.eventId),
                kind: clean(event.kind),
                submittedAt: event.submitted_at ?? event.submittedAt ?? null,
                receivedAt: event.received_at ?? event.receivedAt ?? null
            }));
        const contact = jsonObject(session.contact);
        const attribution = jsonObject(session.attribution);
        const leadIds = parseLeadIds(session.lead_ids);
        const utmTerm = clean(attribution.utm_term) || firstEventValue(sessionEvents, 'utm_term');
        const utmContent = clean(attribution.utm_content) || firstEventValue(sessionEvents, 'utm_content');
        const rawCampaignId = clean(attribution.utm_campaign) || firstEventValue(sessionEvents, 'utm_campaign');
        const adGroupId = clean(attribution.ad_group_id) || firstEventValue(sessionEvents, 'ad_group_id');
        const campaign = rawCampaignId ? spendByCampaign.get(rawCampaignId) : null;
        const campaignId = campaign?.campaignId || rawCampaignId;
        const mergedAttribution = {
            utm_source: clean(attribution.utm_source) || firstEventValue(sessionEvents, 'utm_source'),
            utm_medium: clean(attribution.utm_medium) || firstEventValue(sessionEvents, 'utm_medium'),
            utm_campaign: rawCampaignId,
            ad_group_id: adGroupId,
            utm_term: utmTerm,
            utm_content: utmContent,
            keyword: clean(attribution.keyword) || firstEventValue(sessionEvents, 'keyword') || utmTerm,
            match_type: clean(attribution.match_type) || firstEventValue(sessionEvents, 'match_type') || matchTypeFromUtmContent(utmContent),
            gclid: clean(attribution.gclid) || firstEventValue(sessionEvents, 'gclid'),
            gbraid: clean(attribution.gbraid) || firstEventValue(sessionEvents, 'gbraid'),
            wbraid: clean(attribution.wbraid) || firstEventValue(sessionEvents, 'wbraid')
        };
        const qualificationProgress = jsonObject(session.qualification_progress);
        const qualificationAnswers = qualificationAnswersFromProgress(qualificationProgress);
        const qualificationSafeguards = normalizeQualificationSafeguards(qualificationProgress.safeguards);
        const safeguardBlocked = challengeBlocksQualification({ safeguards: qualificationSafeguards });
        const journey: any = journeyBySession.get(session.session_key) || {};
        const hasActionDetails = hasStoredLeadActions || sessionEvents.length > 0;
        const actionCount = hasActionDetails
            ? leadActions.length
            : Number(journey.actionCount ?? session.event_count ?? 0);
        const actionKinds = leadActions.map(action => action.kind).filter(Boolean);
        const actionPath = actionKinds.length
            ? actionKinds.join(' -> ')
            : (hasActionDetails ? '(no action kind)' : (journey.actionPath || '(no action kind)'));
        const uniqueActionCount = actionKinds.length
            ? new Set(actionKinds).size
            : Number(journey.uniqueActionCount || 0);
        const leadSource = clean(session.lead_source)
            || firstEventValue(sessionEvents, 'source')
            || firstEventValue(sessionEvents, 'kind');
        return {
            sessionKey: session.session_key,
            sessionKeyType: session.session_key_type,
            status: normalizeStatus(session.status),
            statusRank: Number(session.status_rank || 0),
            event_count: actionCount,
            eventCount: actionCount,
            leadIds,
            leadId: leadIds[0] || latestEventValue(sessionEvents, 'lead_id'),
            contact: {
                name: clean(contact.name) || latestEventValue(sessionEvents, 'name'),
                email: clean(contact.email) || latestEventValue(sessionEvents, 'email'),
                phone: clean(contact.phone) || latestEventValue(sessionEvents, 'phone')
            },
            attribution: mergedAttribution,
            campaign: campaignId ? {
                campaignId,
                campaignName: campaign?.campaignName || null,
                utmCampaign: rawCampaignId && rawCampaignId !== campaignId ? rawCampaignId : null
            } : null,
            hasClickId: hasClickId(mergedAttribution),
            offlineConversionReady: ['qualified', 'converted'].includes(normalizeStatus(session.status)) && hasClickId(mergedAttribution) && !safeguardBlocked,
            qualificationProgress,
            qualificationAnswers,
            qualificationSafeguards,
            safeguardReasonCodes: qualificationSafeguards?.reasonCodes || [],
            typedChallengeStatus: qualificationSafeguards?.typedChallenge?.status || null,
            typedChallengeReasonCodes: qualificationSafeguards?.typedChallenge?.reasonCodes || [],
            leadSource,
            leadSourceKind: leadSource,
            progressStatus: clean(session.progress_status) || clean(qualificationProgress.status),
            progressTrigger: clean(session.progress_trigger) || clean(qualificationProgress.trigger),
            progressRevision: numberOrNull(session.progress_revision) ?? numberOrNull(qualificationProgress.revision),
            progressAnsweredCount: numberOrNull(session.progress_answered_count) ?? numberOrNull(qualificationProgress.answeredCount) ?? qualificationAnswers.length,
            leadActions,
            actionPath,
            actionCount,
            uniqueActionCount,
            firstSeen: session.first_seen,
            lastSeen: session.last_seen,
            updatedAt: session.updated_at ? new Date(session.updated_at).toISOString() : null,
            firstSeenIst: formatToIST(session.first_seen)
        };
    });
}

function buildOfflineExportReadiness(leadRows: any[]): any {
    const exportStatuses = new Set<LeadStatus>(['qualified', 'converted']);
    let readyRows = 0;
    let skippedMissingClickId = 0;
    let qualifiedOrConverted = 0;
    let needsReview = 0;

    for (const lead of leadRows) {
        const status = normalizeStatus(lead.status);
        if (status === 'new' || status === 'maybe') needsReview += 1;
        if (!exportStatuses.has(status)) continue;
        if (challengeBlocksQualification({ safeguards: lead.qualificationSafeguards })) continue;
        qualifiedOrConverted += 1;
        if (lead.hasClickId) readyRows += 1;
        else skippedMissingClickId += 1;
    }

    return {
        statuses: Array.from(exportStatuses),
        readyRows,
        skippedMissingClickId,
        qualifiedOrConverted,
        needsReview
    };
}

function emptyQualificationSafeguardCounts(): Record<string, number> {
    return {
        rushedClickthrough: 0,
        inconsistentAnswers: 0,
        weakBusinessDetail: 0,
        highAbusePath: 0,
        pending: 0,
        passed: 0,
        failed: 0
    };
}

function qualificationSafeguardCountsFromLeads(leadRows: any[]): Record<string, number> {
    const counts = emptyQualificationSafeguardCounts();
    for (const lead of leadRows) {
        const safeguards = lead.qualificationSafeguards;
        const reasons = new Set(Array.isArray(safeguards?.reasonCodes) ? safeguards.reasonCodes : []);
        if (reasons.has('rushed_clickthrough')) counts.rushedClickthrough += 1;
        if (reasons.has('inconsistent_answers')) counts.inconsistentAnswers += 1;
        if (reasons.has('weak_business_detail')) counts.weakBusinessDetail += 1;
        if (reasons.has('high_abuse_path')) counts.highAbusePath += 1;
        const status = safeguards?.typedChallenge?.status;
        if (status === 'pending') counts.pending += 1;
        if (status === 'passed') counts.passed += 1;
        if (status === 'failed') counts.failed += 1;
    }
    return counts;
}

function qualificationSafeguardCountsFromAggregate(row: any): Record<string, number> {
    return {
        rushedClickthrough: Number(row?.rushed_clickthrough || 0),
        inconsistentAnswers: Number(row?.inconsistent_answers || 0),
        weakBusinessDetail: Number(row?.weak_business_detail || 0),
        highAbusePath: Number(row?.high_abuse_path || 0),
        pending: Number(row?.challenge_pending || 0),
        passed: Number(row?.challenge_passed || 0),
        failed: Number(row?.challenge_failed || 0)
    };
}

function dashboardDateRange(dashboardData: any): { start: string | null; end: string | null } {
    const range = dashboardData?.meta?.dateRange || {};
    return {
        start: cleanDate(range.start),
        end: cleanDate(range.end)
    };
}

function periodRange(label: any): { start: string; end: string } | null {
    const text = String(label || '');
    const match = text.match(/(\d{4}-\d{2}-\d{2})\s*[-–]\s*(\d{4}-\d{2}-\d{2})/);
    return match ? { start: match[1], end: match[2] } : null;
}

async function aggregateLeadBucketForRange(pool: Pool, range: { start: string; end: string } | null, scope: LeadAttributionScope): Promise<any> {
    if (!range) return emptyLeadBucket();
    const { where, params } = sessionDateWhere({ start: range.start, end: range.end }, scope);
    const { rows } = await pool.query(
        `SELECT status, COUNT(*)::int AS unique_leads, COALESCE(SUM(event_count), 0)::int AS event_count
         FROM lead_sessions
         ${where}
         GROUP BY status`,
        params
    );
    return bucketFromStatusRows(rows);
}

async function buildLeadAttributionOverviewSummary(pool: Pool, dashboardData: any): Promise<any> {
    const ttlSeconds = overviewCacheSeconds();
    const cacheKey = leadAttributionOverviewCacheKey(dashboardData);
    const now = Date.now();
    const cached = ttlSeconds > 0 ? leadAttributionOverviewCache.get(cacheKey) : null;
    if (cached && cached.expiresAt > now) return cloneJson(cached.summary);

    const dateRange = dashboardDateRange(dashboardData);
    const scope = dashboardLeadScope(dashboardData);
    const { where, params } = sessionDateWhere(dateRange, scope);
    const spendByCampaign = campaignSpendMap(dashboardData);
    const [
        totalsResult,
        byCampaignResult,
        bySearchTermResult,
        recentResult,
        offlineResult,
        previousPeriodBucket,
        currentPeriodBucket
    ] = await Promise.all([
        pool.query(
            `SELECT status, COUNT(*)::int AS unique_leads, COALESCE(SUM(event_count), 0)::int AS event_count
             FROM lead_sessions
             ${where}
             GROUP BY status`,
            params
        ),
        pool.query(
            `SELECT campaign_id, status, COUNT(*)::int AS unique_leads, COALESCE(SUM(event_count), 0)::int AS event_count
             FROM (
                SELECT COALESCE(NULLIF(attribution->>'utm_campaign', ''), '(none)') AS campaign_id, status, event_count
                FROM lead_sessions
                ${where}
             ) sessions
             GROUP BY campaign_id, status`,
            params
        ),
        pool.query(
            `SELECT campaign_id, search_term, keyword, match_type, status, COUNT(*)::int AS unique_leads, COALESCE(SUM(event_count), 0)::int AS event_count
             FROM (
                SELECT
                    COALESCE(NULLIF(attribution->>'utm_campaign', ''), '(none)') AS campaign_id,
                    COALESCE(NULLIF(attribution->>'utm_term', ''), NULLIF(attribution->>'keyword', ''), '(none)') AS search_term,
                    NULLIF(attribution->>'keyword', '') AS keyword,
                    NULLIF(attribution->>'match_type', '') AS match_type,
                    status,
                    event_count
                FROM lead_sessions
                ${where}
             ) sessions
             GROUP BY campaign_id, search_term, keyword, match_type, status`,
            params
        ),
        pool.query(
            `SELECT session_key, session_key_type, status, status_rank, progress_status, progress_trigger, progress_revision, progress_answered_count, qualification_progress, lead_source, event_count, lead_ids, attribution, contact, first_seen, last_seen, updated_at
             FROM lead_sessions
             ${where}
             ORDER BY last_seen DESC
             LIMIT 50`,
            params
        ),
        pool.query(
            `SELECT
                COUNT(*) FILTER (WHERE status IN ('new', 'maybe'))::int AS needs_review,
                COUNT(*) FILTER (
                    WHERE status IN ('qualified', 'converted')
                      AND COALESCE(qualification_progress->'safeguards'->'typedChallenge'->>'status', '') NOT IN ('pending', 'failed')
                )::int AS qualified_or_converted,
                COUNT(*) FILTER (
                    WHERE status IN ('qualified', 'converted')
                      AND COALESCE(qualification_progress->'safeguards'->'typedChallenge'->>'status', '') NOT IN ('pending', 'failed')
                      AND (
                        NULLIF(attribution->>'gclid', '') IS NOT NULL
                        OR NULLIF(attribution->>'gbraid', '') IS NOT NULL
                        OR NULLIF(attribution->>'wbraid', '') IS NOT NULL
                      )
                )::int AS ready_rows,
                COUNT(*) FILTER (WHERE COALESCE(qualification_progress->'safeguards'->'reasonCodes', '[]'::jsonb) ? 'rushed_clickthrough')::int AS rushed_clickthrough,
                COUNT(*) FILTER (WHERE COALESCE(qualification_progress->'safeguards'->'reasonCodes', '[]'::jsonb) ? 'inconsistent_answers')::int AS inconsistent_answers,
                COUNT(*) FILTER (WHERE COALESCE(qualification_progress->'safeguards'->'reasonCodes', '[]'::jsonb) ? 'weak_business_detail')::int AS weak_business_detail,
                COUNT(*) FILTER (WHERE COALESCE(qualification_progress->'safeguards'->'reasonCodes', '[]'::jsonb) ? 'high_abuse_path')::int AS high_abuse_path,
                COUNT(*) FILTER (WHERE qualification_progress->'safeguards'->'typedChallenge'->>'status' = 'pending')::int AS challenge_pending,
                COUNT(*) FILTER (WHERE qualification_progress->'safeguards'->'typedChallenge'->>'status' = 'passed')::int AS challenge_passed,
                COUNT(*) FILTER (WHERE qualification_progress->'safeguards'->'typedChallenge'->>'status' = 'failed')::int AS challenge_failed
             FROM lead_sessions
             ${where}`,
            params
        ),
        aggregateLeadBucketForRange(pool, periodRange(dashboardData?.periodComparison?.previousPeriod?.label), scope),
        aggregateLeadBucketForRange(pool, periodRange(dashboardData?.periodComparison?.currentPeriod?.label), scope)
    ]);

    const totals = bucketFromStatusRows(totalsResult.rows);
    const byCampaign = new Map<string, any>();
    for (const row of byCampaignResult.rows) {
        const rawCampaignId = clean(row.campaign_id) || '(none)';
        const campaignSpend = spendByCampaign.get(rawCampaignId);
        const campaignId = campaignSpend?.campaignId || rawCampaignId;
        const bucket = byCampaign.get(campaignId) || emptyLeadBucket({
            campaignId,
            campaignName: campaignSpend?.campaignName || null,
            spend: campaignSpend?.spend || 0,
            trueCpa: 0,
            qualifiedCpa: 0,
            convertedCpa: 0,
            customerCpa: 0
        });
        bumpLeadBucketByCount(bucket, row.status, row.unique_leads, row.event_count);
        byCampaign.set(campaignId, bucket);
    }

    const bySearchTerm = new Map<string, any>();
    for (const row of bySearchTermResult.rows) {
        const rawCampaignId = clean(row.campaign_id) || '(none)';
        const campaignSpend = spendByCampaign.get(rawCampaignId);
        const campaignId = campaignSpend?.campaignId || rawCampaignId;
        const term = clean(row.search_term) || '(none)';
        const key = `${campaignId}|${term}|${clean(row.keyword) || ''}|${clean(row.match_type) || ''}`;
        const bucket = bySearchTerm.get(key) || emptyLeadBucket({
            campaignId,
            campaignName: campaignSpend?.campaignName || null,
            searchTerm: term,
            keyword: clean(row.keyword),
            matchType: clean(row.match_type)
        });
        bumpLeadBucketByCount(bucket, row.status, row.unique_leads, row.event_count);
        bySearchTerm.set(key, bucket);
    }

    const campaigns = Array.from(byCampaign.values())
        .map(bucket => ({
            ...bucket,
            trueCpa: bucket.uniqueLeads > 0 ? bucket.spend / bucket.uniqueLeads : 0,
            qualifiedCpa: bucket.qualifiedPipeline > 0 ? bucket.spend / bucket.qualifiedPipeline : 0,
            convertedCpa: bucket.converted > 0 ? bucket.spend / bucket.converted : 0,
            customerCpa: bucket.converted > 0 ? bucket.spend / bucket.converted : 0
        }))
        .sort((a, b) => b.spend - a.spend || b.uniqueLeads - a.uniqueLeads);
    const recentLeads = buildLeadRows(recentResult.rows, [], { recentJourneys: [] }, spendByCampaign);
    const offlineRow = offlineResult.rows[0] || {};
    const qualifiedOrConverted = Number(offlineRow.qualified_or_converted || 0);
    const readyRows = Number(offlineRow.ready_rows || 0);
    const summary = {
        generatedAt: new Date().toISOString(),
        mode: 'overview',
        dateRange,
        scope: leadAttributionScopeSummary(scope),
        totals,
        byCampaign: campaigns,
        bySearchTerm: Array.from(bySearchTerm.values()).sort((a, b) => b.uniqueLeads - a.uniqueLeads).slice(0, 100),
        journeySummary: {
            totalSessions: totals.uniqueLeads,
            sessionsWithMultipleActions: recentResult.rows.filter((row: any) => Number(row.event_count || 0) > 1).length,
            topActionOverlaps: [],
            topPaths: [],
            flowEdges: [],
            pathOutcomes: [],
            recentJourneys: []
        },
        recentLeads,
        safeguards: qualificationSafeguardCountsFromAggregate(offlineRow),
        offlineExport: {
            statuses: ['qualified', 'converted'],
            readyRows,
            skippedMissingClickId: Math.max(0, qualifiedOrConverted - readyRows),
            qualifiedOrConverted,
            needsReview: Number(offlineRow.needs_review || 0)
        },
        periodComparison: {
            previousPeriod: periodMetricsFromBucket(previousPeriodBucket),
            currentPeriod: periodMetricsFromBucket(currentPeriodBucket)
        }
    };

    if (ttlSeconds > 0) {
        leadAttributionOverviewCache.set(cacheKey, {
            summary: cloneJson(summary),
            expiresAt: now + ttlSeconds * 1000
        });
    }
    return summary;
}

export async function getLeadAttributionSummary(
    pool: Pool,
    dashboardData: any,
    options: LeadAttributionSummaryOptions = {}
): Promise<any> {
    await ensureLeadSchema(pool);
    if ((options.mode || 'full') === 'overview') {
        return buildLeadAttributionOverviewSummary(pool, dashboardData);
    }
    const dateRange = dashboardDateRange(dashboardData);
    const scope = dashboardLeadScope(dashboardData);
    const { where: sessionWhere, params: sessionParams } = sessionDateWhere(dateRange, scope);
    const { rows } = await pool.query(
        `SELECT session_key, session_key_type, status, status_rank, progress_status, progress_trigger, progress_revision, progress_answered_count, qualification_progress, lead_source, event_count, lead_ids, attribution, contact, first_seen, last_seen, updated_at
         FROM lead_sessions
         ${sessionWhere}
         ORDER BY last_seen DESC`,
        sessionParams
    );
    const eventsResult = rows.length
        ? await pool.query(
            `SELECT event_id, session_key, kind, source, lead_id, session_id, tracking_only, status, submitted_at, received_at,
                    gclid, gbraid, wbraid, utm_source, utm_medium, utm_campaign, ad_group_id, utm_term, utm_content,
                    keyword, match_type, name, email, phone
             FROM lead_events
             WHERE session_key = ANY($1::varchar[])
             ORDER BY session_key ASC, COALESCE(submitted_at, received_at) ASC, received_at ASC`,
            [rows.map((row: any) => row.session_key)]
        )
        : { rows: [] };
    const spendByCampaign = campaignSpendMap(dashboardData);
    const totals = emptyLeadBucket();
    const byCampaign = new Map<string, any>();
    const bySearchTerm = new Map<string, any>();
    const journeySummary = buildLeadJourneySummary(rows, eventsResult.rows);
    const leadRows = buildLeadRows(rows, eventsResult.rows, journeySummary, spendByCampaign);

    for (const session of leadRows) {
        bumpLeadBucket(totals, session);
        const attribution = session.attribution || {};
        const rawCampaignId = clean(attribution.utm_campaign);
        const campaignId = clean(session?.campaign?.campaignId) || rawCampaignId || '(none)';
        const campaignSpend = spendByCampaign.get(campaignId) || (rawCampaignId ? spendByCampaign.get(rawCampaignId) : undefined);
        const campaignBucket = byCampaign.get(campaignId) || emptyLeadBucket({
            campaignId,
            campaignName: campaignSpend?.campaignName || null,
            spend: campaignSpend?.spend || 0,
            trueCpa: 0,
            qualifiedCpa: 0,
            convertedCpa: 0,
            customerCpa: 0
        });
        bumpLeadBucket(campaignBucket, session);
        byCampaign.set(campaignId, campaignBucket);

        const term = clean(attribution.utm_term) || clean(attribution.keyword) || '(none)';
        const keyword = clean(attribution.keyword);
        const matchType = clean(attribution.match_type);
        const termKey = `${campaignId}|${term}|${keyword || ''}|${matchType || ''}`;
        const termBucket = bySearchTerm.get(termKey) || emptyLeadBucket({
            campaignId,
            campaignName: campaignSpend?.campaignName || null,
            searchTerm: term,
            keyword,
            matchType
        });
        bumpLeadBucket(termBucket, session);
        bySearchTerm.set(termKey, termBucket);
    }

    const campaigns = Array.from(byCampaign.values())
        .map(bucket => ({
            ...bucket,
            trueCpa: bucket.uniqueLeads > 0 ? bucket.spend / bucket.uniqueLeads : 0,
            qualifiedCpa: bucket.qualifiedPipeline > 0 ? bucket.spend / bucket.qualifiedPipeline : 0,
            convertedCpa: bucket.converted > 0 ? bucket.spend / bucket.converted : 0,
            customerCpa: bucket.converted > 0 ? bucket.spend / bucket.converted : 0
        }))
        .sort((a, b) => b.spend - a.spend || b.uniqueLeads - a.uniqueLeads);

    return {
        generatedAt: new Date().toISOString(),
        dateRange,
        scope: leadAttributionScopeSummary(scope),
        totals,
        byCampaign: campaigns,
        bySearchTerm: Array.from(bySearchTerm.values()).sort((a, b) => b.uniqueLeads - a.uniqueLeads).slice(0, 100),
        journeySummary,
        allLeads: leadRows,
        recentLeads: leadRows.slice(0, 50),
        recentSessions: rows.slice(0, 50),
        safeguards: qualificationSafeguardCountsFromLeads(leadRows),
        offlineExport: buildOfflineExportReadiness(leadRows)
    };
}

export async function getLeadSessionByKey(pool: Pool, sessionKeyInput: unknown): Promise<any | null> {
    await ensureLeadSchema(pool);
    const sessionKey = clean(sessionKeyInput);
    if (!sessionKey || sessionKey.length > 220) throw new LeadValidationError('sessionKey is required.');
    const { rows } = await pool.query(
        `SELECT session_key, session_key_type, status, status_rank, progress_status, progress_trigger, progress_revision, progress_answered_count, qualification_progress, lead_source, event_count, lead_ids, attribution, contact, first_seen, last_seen, updated_at
         FROM lead_sessions
         WHERE session_key = $1`,
        [sessionKey]
    );
    if (!rows[0]) return null;
    const eventsResult = await pool.query(
        `SELECT event_id, session_key, kind, source, lead_id, session_id, tracking_only, status, submitted_at, received_at,
                gclid, gbraid, wbraid, utm_source, utm_medium, utm_campaign, ad_group_id, utm_term, utm_content,
                keyword, match_type, name, email, phone
         FROM lead_events
         WHERE session_key = $1
         ORDER BY COALESCE(submitted_at, received_at) ASC, received_at ASC`,
        [sessionKey]
    );
    return buildLeadRows(rows, eventsResult.rows, buildLeadJourneySummary(rows, eventsResult.rows), new Map())[0] || null;
}

function leadStatusShortLabel(value: any): string {
    const labels: Record<LeadStatus, string> = {
        new: 'Needs review',
        maybe: 'Maybe',
        qualified: 'Qualified',
        converted: 'Won',
        qualified_lost: 'Lost',
        useless: 'Junk'
    };
    return labels[normalizeStatus(value)];
}

function clickIdSummary(attribution: any): string {
    const parts = [
        clean(attribution?.gclid) ? 'GCLID' : null,
        clean(attribution?.gbraid) ? 'GBRAID' : null,
        clean(attribution?.wbraid) ? 'WBRAID' : null
    ].filter(Boolean);
    return parts.length ? parts.join(', ') : 'No click ID';
}

function leadActionPathLabel(value: any): string {
    const text = clean(value);
    return text && text !== '(no action kind)' ? text : 'Lead captured';
}

function spreadsheetSafeText(value: any): string {
    const text = String(value ?? '');
    return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function intendedUseFromProgress(progress: any): string {
    return qualificationAnswersFromProgress(progress)
        .find(answer => answer.questionId === 'use_case_detail')?.answer || '';
}

export async function exportLeadReviewCsv(pool: Pool, options: {
    startDate?: any;
    endDate?: any;
    campaignId?: any;
    campaignName?: any;
    adGroupId?: any;
    adGroupName?: any;
} = {}): Promise<{ csv: string; rowCount: number }> {
    await ensureLeadSchema(pool);
    const startDate = cleanDate(options.startDate);
    const endDate = cleanDate(options.endDate);
    if (options.startDate && !startDate) throw new LeadValidationError('Invalid startDate. Use YYYY-MM-DD.');
    if (options.endDate && !endDate) throw new LeadValidationError('Invalid endDate. Use YYYY-MM-DD.');
    if (startDate && endDate && startDate > endDate) throw new LeadValidationError('startDate must be before or equal to endDate.');

    const params: any[] = [];
    const conditions: string[] = [];
    if (startDate) {
        params.push(startDate);
        conditions.push(`first_seen >= $${params.length}::date`);
    }
    if (endDate) {
        params.push(endDate);
        conditions.push(`first_seen < ($${params.length}::date + INTERVAL '1 day')`);
    }
    const campaignId = clean(options.campaignId);
    if (campaignId) {
        params.push(uniqueNonEmpty([campaignId, clean(options.campaignName)]));
        conditions.push(`attribution->>'utm_campaign' = ANY($${params.length}::text[])`);
    }
    const adGroupId = clean(options.adGroupId);
    if (adGroupId) {
        params.push(uniqueNonEmpty([adGroupId, clean(options.adGroupName)]));
        conditions.push(`attribution->>'ad_group_id' = ANY($${params.length}::text[])`);
    }
    const sessionWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
        `SELECT session_key, session_key_type, status, status_rank, progress_status, progress_trigger, progress_revision, progress_answered_count, qualification_progress, lead_source, event_count, lead_ids, attribution, contact, first_seen, last_seen, updated_at
         FROM lead_sessions
         ${sessionWhere}
         ORDER BY last_seen DESC`,
        params
    );
    const eventsResult = rows.length
        ? await pool.query(
            `SELECT event_id, session_key, kind, source, lead_id, session_id, tracking_only, status, submitted_at, received_at,
                    gclid, gbraid, wbraid, utm_source, utm_medium, utm_campaign, ad_group_id, utm_term, utm_content,
                    keyword, match_type, name, email, phone
             FROM lead_events
             WHERE session_key = ANY($1::varchar[])
             ORDER BY session_key ASC, COALESCE(submitted_at, received_at) ASC, received_at ASC`,
            [rows.map((row: any) => row.session_key)]
        )
        : { rows: [] };
    const journeySummary = buildLeadJourneySummary(rows, eventsResult.rows);
    const leadRows = buildLeadRows(rows, eventsResult.rows, journeySummary, new Map());

    const csvRows: string[][] = [[
        'First Seen',
        'First Seen IST',
        'Last Seen',
        'Status',
        'Lead Source',
        'Name',
        'Email',
        'Phone',
        'Campaign ID',
        'Campaign Name',
        'Ad Group ID',
        'Search Term',
        'Keyword',
        'Match Type',
        'UTM Source',
        'UTM Medium',
        'UTM Campaign',
        'UTM Term',
        'UTM Content',
        'Click ID Summary',
        'GCLID',
        'GBRAID',
        'WBRAID',
        'Has Click ID',
        'Offline Upload Ready',
        'Lead Action Path',
        'Qualification Progress',
        'Qualification Answers',
        'Safeguard Reasons',
        'Challenge Status',
        'Challenge Reasons',
        'Intended Use',
        'Weak Attempts',
        'Early Clicks',
        'Fast Answer Count',
        'Timed Answer Count',
        'First Six Reading Time (ms)',
        'Evaluated Flow Answer Count',
        'Evaluated Flow Reading Time (ms)',
        'Evaluated Flow Threshold (ms)',
        'Total Reading Time (ms)',
        'Excluded Transition Time (ms)',
        'Event Count',
        'Unique Action Count',
        'Session Key',
        'Session Key Type',
        'Lead IDs'
    ]];

    for (const lead of leadRows) {
        const attribution = lead.attribution || {};
        const contact = lead.contact || {};
        const campaign = lead.campaign || {};
        const safeguards = lead.qualificationSafeguards || {};
        const challenge = safeguards.typedChallenge || {};
        const timing = safeguards.timing || {};
        csvRows.push([
            String(lead.firstSeen || ''),
            String(lead.firstSeenIst || formatToIST(lead.firstSeen) || ''),
            String(lead.lastSeen || ''),
            leadStatusShortLabel(lead.status),
            spreadsheetSafeText(clean(lead.leadSourceKind) || ''),
            spreadsheetSafeText(clean(contact.name) || ''),
            spreadsheetSafeText(clean(contact.email) || ''),
            spreadsheetSafeText(clean(contact.phone) || ''),
            spreadsheetSafeText(clean(campaign.campaignId) || clean(attribution.utm_campaign) || ''),
            spreadsheetSafeText(clean(campaign.campaignName) || ''),
            spreadsheetSafeText(clean(attribution.ad_group_id) || ''),
            spreadsheetSafeText(clean(attribution.utm_term) || ''),
            spreadsheetSafeText(clean(attribution.keyword) || clean(attribution.utm_term) || ''),
            clean(attribution.match_type) || '',
            spreadsheetSafeText(clean(attribution.utm_source) || ''),
            spreadsheetSafeText(clean(attribution.utm_medium) || ''),
            spreadsheetSafeText(clean(attribution.utm_campaign) || ''),
            spreadsheetSafeText(clean(attribution.utm_term) || ''),
            spreadsheetSafeText(clean(attribution.utm_content) || ''),
            spreadsheetSafeText(clickIdSummary(attribution)),
            spreadsheetSafeText(clean(attribution.gclid) || ''),
            spreadsheetSafeText(clean(attribution.gbraid) || ''),
            spreadsheetSafeText(clean(attribution.wbraid) || ''),
            lead.hasClickId ? 'Yes' : 'No',
            lead.offlineConversionReady ? 'Yes' : 'No',
            spreadsheetSafeText(leadActionPathLabel(lead.actionPath)),
            clean(lead.progressStatus) || '',
            spreadsheetSafeText(qualificationAnswersFromProgress(lead.qualificationProgress).map(answer => `${answer.question}: ${answer.answer}`).join(' | ')),
            Array.isArray(safeguards.reasonCodes) ? safeguards.reasonCodes.join(' | ') : '',
            clean(challenge.status) || '',
            Array.isArray(challenge.reasonCodes) ? challenge.reasonCodes.join(' | ') : '',
            spreadsheetSafeText(intendedUseFromProgress(lead.qualificationProgress)),
            String(challenge.failedAttempts ?? ''),
            String(timing.earlyClickAttemptCount ?? ''),
            String(timing.fastAnswerCount ?? ''),
            String(timing.timedAnswerCount ?? ''),
            String(timing.firstSixReadingTimeMs ?? ''),
            String(timing.evaluatedFlowAnswerCount ?? ''),
            String(timing.evaluatedFlowReadingTimeMs ?? ''),
            String(timing.evaluatedFlowThresholdMs ?? ''),
            String(timing.totalReadingTimeMs ?? ''),
            String(timing.totalTransitionTimeMs ?? ''),
            String(lead.eventCount ?? lead.event_count ?? ''),
            String(lead.uniqueActionCount ?? ''),
            spreadsheetSafeText(clean(lead.sessionKey) || ''),
            clean(lead.sessionKeyType) || '',
            spreadsheetSafeText(Array.isArray(lead.leadIds) ? lead.leadIds.join(' | ') : '')
        ]);
    }

    return {
        csv: csvRows.map(row => row.map(csvCell).join(',')).join('\n') + '\n',
        rowCount: csvRows.length - 1
    };
}

function csvCell(value: any): string {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseLeadIds(value: any): string[] {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
        } catch {
            return [];
        }
    }
    return [];
}

function formatGoogleAdsConversionTime(value: any): string {
    const date = new Date(value || Date.now());
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}+00:00`;
}

function normalizeStatusList(values: any, fallback: LeadStatus[]): LeadStatus[] {
    const raw = Array.isArray(values)
        ? values
        : String(values || '').split(',');
    const normalized = raw
        .map(value => normalizeStatus(value))
        .filter(status => status !== 'new');
    const out = Array.from(new Set(normalized));
    return out.length ? out : fallback;
}

export interface OfflineConversionExportOptions {
    statuses?: any;
    startDate?: any;
    endDate?: any;
    campaignId?: any;
    campaignName?: any;
    currency?: string;
    qualifiedName?: string;
    convertedName?: string;
    qualifiedValue?: any;
    convertedValue?: any;
    defaultValue?: any;
}

export async function exportOfflineConversionsCsv(pool: Pool, options: OfflineConversionExportOptions = {}): Promise<{
    csv: string;
    rowCount: number;
    skippedMissingClickId: number;
    statuses: LeadStatus[];
}> {
    await ensureLeadSchema(pool);
    const statuses = normalizeStatusList(options.statuses, ['qualified', 'converted'])
        .filter(status => status === 'qualified' || status === 'converted');
    const currency = clean(options.currency) || 'INR';
    const defaultValue = Number.isFinite(Number(options.defaultValue)) ? Number(options.defaultValue) : 0;
    const conversionNames: Partial<Record<LeadStatus, string>> = {
        qualified: clean(options.qualifiedName) || 'Qualified Lead',
        converted: clean(options.convertedName) || 'Converted Customer'
    };
    const conversionValues: Partial<Record<LeadStatus, number>> = {
        qualified: Number.isFinite(Number(options.qualifiedValue)) ? Number(options.qualifiedValue) : defaultValue,
        converted: Number.isFinite(Number(options.convertedValue)) ? Number(options.convertedValue) : defaultValue
    };
    const params: any[] = [statuses];
    const conditions = [
        'ls.status = ANY($1::varchar[])',
        "COALESCE(ls.qualification_progress->'safeguards'->'typedChallenge'->>'status', '') NOT IN ('pending', 'failed')"
    ];
    const startDate = cleanDate(options.startDate);
    const endDate = cleanDate(options.endDate);
    if (startDate) {
        params.push(startDate);
        conditions.push(`ls.first_seen >= $${params.length}::date`);
    }
    if (endDate) {
        params.push(endDate);
        conditions.push(`ls.first_seen < ($${params.length}::date + INTERVAL '1 day')`);
    }
    const campaignId = clean(options.campaignId);
    const campaignValues = uniqueNonEmpty([campaignId, clean(options.campaignName)]);
    if (campaignValues.length) {
        params.push(campaignValues);
        conditions.push(`ls.attribution->>'utm_campaign' = ANY($${params.length}::text[])`);
    }

    const { rows } = await pool.query(
        `SELECT ls.session_key, ls.status, ls.lead_ids, ls.attribution, ls.last_seen, ls.updated_at,
                click_ids.gclid AS event_gclid,
                click_ids.gbraid AS event_gbraid,
                click_ids.wbraid AS event_wbraid
         FROM lead_sessions ls
         LEFT JOIN LATERAL (
             SELECT gclid, gbraid, wbraid
             FROM lead_events
             WHERE session_key = ls.session_key
               AND (gclid IS NOT NULL OR gbraid IS NOT NULL OR wbraid IS NOT NULL)
             ORDER BY COALESCE(submitted_at, received_at) ASC, received_at ASC
             LIMIT 1
         ) click_ids ON true
         WHERE ${conditions.join(' AND ')}
         ORDER BY ls.last_seen DESC`,
        params
    );

    const csvRows: string[][] = [[
        'Google Click ID',
        'GBRAID',
        'WBRAID',
        'Conversion Name',
        'Conversion Time',
        'Conversion Value',
        'Conversion Currency',
        'Order ID'
    ]];
    let skippedMissingClickId = 0;

    for (const row of rows) {
        const status = normalizeStatus(row.status);
        const attribution = row.attribution || {};
        const gclid = clean(attribution.gclid) || clean(row.event_gclid);
        const gbraid = clean(attribution.gbraid) || clean(row.event_gbraid);
        const wbraid = clean(attribution.wbraid) || clean(row.event_wbraid);
        if (!gclid && !gbraid && !wbraid) {
            skippedMissingClickId += 1;
            continue;
        }
        const leadIds = parseLeadIds(row.lead_ids);
        csvRows.push([
            gclid || '',
            gbraid || '',
            wbraid || '',
            conversionNames[status] || status.replace(/_/g, ' '),
            formatGoogleAdsConversionTime(row.last_seen || row.updated_at),
            String(conversionValues[status] ?? defaultValue),
            currency,
            leadIds[0] || row.session_key
        ]);
    }

    return {
        csv: csvRows.map(row => row.map(csvCell).join(',')).join('\n') + '\n',
        rowCount: csvRows.length - 1,
        skippedMissingClickId,
        statuses
    };
}

export interface LeadQualityMetrics {
    uniqueLeads: number;
    new: number;
    useless: number;
    maybe: number;
    qualified: number;
    qualifiedLost: number;
    converted: number;
    inProgress: number;
    terminal: number;
    qualifiedPipeline: number;
    qualifiedOrConverted: number;
    uselessRate: number;
    qualifiedRate: number;
    conversionRate: number;
}

function finalizeLeadQualityMetrics(bucket: any): LeadQualityMetrics {
    const uniqueLeads = Number(bucket.uniqueLeads || 0);
    const metrics = emptyLeadBucket();
    Object.assign(metrics, bucket);
    return {
        uniqueLeads,
        new: Number(metrics.new || 0),
        useless: Number(metrics.useless || 0),
        maybe: Number(metrics.maybe || 0),
        qualified: Number(metrics.qualified || 0),
        qualifiedLost: Number(metrics.qualifiedLost || 0),
        converted: Number(metrics.converted || 0),
        inProgress: Number(metrics.inProgress || 0),
        terminal: Number(metrics.terminal || 0),
        qualifiedPipeline: Number(metrics.qualifiedPipeline || 0),
        qualifiedOrConverted: Number(metrics.qualifiedOrConverted || 0),
        uselessRate: uniqueLeads ? Number((Number(metrics.useless || 0) / uniqueLeads).toFixed(4)) : 0,
        qualifiedRate: uniqueLeads ? Number((Number(metrics.qualifiedPipeline || 0) / uniqueLeads).toFixed(4)) : 0,
        conversionRate: uniqueLeads ? Number((Number(metrics.converted || 0) / uniqueLeads).toFixed(4)) : 0
    };
}

export async function getLeadQualityMetricsForWindow(pool: Pool, input: {
    start: Date;
    end: Date;
    campaignId?: string | null;
    campaignName?: string | null;
    searchTerm?: string | null;
}): Promise<LeadQualityMetrics> {
    await ensureLeadSchema(pool);
    const params: any[] = [input.start.toISOString(), input.end.toISOString()];
    const conditions = ['first_seen >= $1::timestamp', 'first_seen < $2::timestamp'];
    const campaignId = clean(input.campaignId);
    const campaignValues = uniqueNonEmpty([campaignId, clean(input.campaignName)]);
    const searchTerm = clean(input.searchTerm);
    if (campaignValues.length) {
        params.push(campaignValues);
        conditions.push(`attribution->>'utm_campaign' = ANY($${params.length}::text[])`);
    }
    if (searchTerm) {
        params.push(searchTerm.toLowerCase());
        conditions.push(`LOWER(COALESCE(attribution->>'utm_term', '')) = $${params.length}`);
    }

    const { rows } = await pool.query(
        `SELECT status, event_count
         FROM lead_sessions
         WHERE ${conditions.join(' AND ')}`,
        params
    );
    const bucket = emptyLeadBucket();
    for (const row of rows) bumpLeadBucket(bucket, row);
    return finalizeLeadQualityMetrics(bucket);
}
