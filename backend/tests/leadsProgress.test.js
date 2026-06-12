import { describe, expect, test } from 'bun:test';
import { normalizeLeadWebhookPayload } from '../lib/leads.ts';

const basePayload = (progress, extra = {}) => ({
    session_id: 'session-progress-1',
    lead_id: 'lead-progress-1',
    gclid: 'gclid-progress-1',
    kind: 'demo',
    source: 'demo_page',
    name: 'Progress Lead',
    email: 'progress@example.com',
    phoneNumber: '9876543210',
    phoneCountryCode: '91',
    submittedAt: '2026-07-08T12:00:00.000Z',
    qualification_progress: progress,
    qualification_questions_and_answers: progress?.questionsAndAnswers,
    ...extra
});

const safeguards = (status, overrides = {}) => ({
    version: 1,
    reasonCodes: ['rushed_clickthrough'],
    typedChallenge: {
        status,
        reasonCodes: ['rushed_clickthrough'],
        failedAttempts: status === 'failed' ? 2 : 0
    },
    timing: {
        earlyClickAttemptCount: 2,
        fastAnswerCount: 4,
        timedAnswerCount: 4,
        totalReadingTimeMs: 2800,
        totalTransitionTimeMs: 900,
        samples: []
    },
    ...overrides
});

const paidBusinessAnswers = [
    { questionId: 'primary_intent', question: 'How can we help you today?', answerId: 'primary-crm', answer: 'WhatsApp CRM' },
    { questionId: 'business_use', question: 'Is this for a business?', answerId: 'business-use-business', answer: 'Yes, for my business' },
    { questionId: 'paid_intent', question: 'Are you open to paying?', answerId: 'paid-ready', answer: 'Yes, I can pay' }
];

describe('Zenseeo qualification progress webhook normalization', () => {
    test('starts the first progress snapshot as junk until qualification is visible', () => {
        const event = normalizeLeadWebhookPayload(basePayload({
            status: 'started',
            trigger: 'identity',
            revision: 1,
            currentStep: 'primary',
            answeredCount: 1,
            questionsAndAnswers: [{
                questionId: 'language',
                question: 'Which language should we use?',
                answerId: 'en',
                answer: 'English'
            }]
        }));

        expect(event.status).toBe('useless');
        expect(event.kind).toBe('demo');
        expect(event.source).toBe('demo_page');
        expect(event.progress_status).toBe('started');
        expect(event.progress_revision).toBe(1);
        expect(event.progress_answered_count).toBe(1);
        expect(event.qualification_progress.questionsAndAnswers[0].question).toBe('Which language should we use?');
    });

    test('marks an incomplete but clearly paid business path as maybe', () => {
        const event = normalizeLeadWebhookPayload(basePayload({
            status: 'in_progress',
            trigger: 'answer',
            revision: 5,
            currentStep: 'paid',
            answeredCount: 4,
            questionsAndAnswers: [
                { questionId: 'primary_intent', question: 'How can we help you today?', answerId: 'primary-bulk-messaging', answer: 'Bulk messaging / campaigns / Business promotion' },
                { questionId: 'business_use', question: 'Is this for a business?', answerId: 'business-use-business', answer: 'Yes, for my business' },
                { questionId: 'business_size_or_volume', question: 'How many people are in your organization?', answerId: 'size-solo', answer: 'Solo' },
                { questionId: 'paid_intent', question: 'Are you open to paying?', answerId: 'paid-ready', answer: 'Yes, I can pay' }
            ]
        }));

        expect(event.status).toBe('maybe');
    });

    test('keeps lower-budget intent as junk until the budget amount qualifies', () => {
        const event = normalizeLeadWebhookPayload(basePayload({
            status: 'in_progress',
            trigger: 'answer',
            revision: 4,
            currentStep: 'budget',
            answeredCount: 3,
            questionsAndAnswers: [
                { questionId: 'primary_intent', question: 'How can we help you today?', answerId: 'primary-crm', answer: 'WhatsApp CRM / team inbox' },
                { questionId: 'business_use', question: 'Is this for a business?', answerId: 'business-use-business', answer: 'Yes, for my business' },
                { questionId: 'paid_intent', question: 'Are you open to paying?', answerId: 'paid-lower-budget', answer: 'Lower Budget' }
            ]
        }));

        expect(event.status).toBe('useless');
    });

    test('uses completed website qualification metadata to mark the lead maybe', () => {
        const event = normalizeLeadWebhookPayload(basePayload({
            status: 'completed',
            trigger: 'completed',
            revision: 6,
            currentStep: 'terminal',
            answeredCount: 4,
            decision: 'qualified_future',
            questionsAndAnswers: [
                { questionId: 'primary_intent', question: 'How can we help you today?', answerId: 'primary-ban-resolution', answer: 'WhatsApp ban problem' },
                { questionId: 'ban_bulk', question: 'Was this after bulk messaging?', answerId: 'ban-bulk-yes', answer: 'Yes' },
                { questionId: 'paid_intent', question: 'Are you open to paid software?', answerId: 'ban-paid-ready', answer: 'Yes' }
            ]
        }, {
            qualification_decision: 'qualified_future',
            qualification_reason_code: 'bulk_ban_future_paid_intent'
        }));

        expect(event.status).toBe('maybe');
        expect(event.qualification_progress.decision).toBe('qualified_future');
    });

    test('normalizes snake-case safeguard evidence and clamps every bounded field', () => {
        const event = normalizeLeadWebhookPayload(basePayload({
            status: 'in_progress',
            trigger: 'safeguard',
            revision: 8,
            answeredCount: 3,
            questionsAndAnswers: paidBusinessAnswers,
            safeguards: {
                version: 1,
                reason_codes: ['rushed-clickthrough', 'unknown_reason', 'rushed_clickthrough'],
                typed_challenge: {
                    status: 'pending',
                    reason_codes: ['rushed-clickthrough', 'unknown_reason'],
                    failed_attempts: 99
                },
                timing: {
                    early_click_attempt_count: 999,
                    fast_answer_count: 99,
                    timed_answer_count: 99,
                    first_six_reading_time_ms: 99999999,
                    evaluated_flow_answer_count: 99,
                    evaluated_flow_reading_time_ms: 99999999,
                    evaluated_flow_threshold_ms: 99999999,
                    total_reading_time_ms: 99999999,
                    total_transition_time_ms: -10,
                    samples: [{
                        sequence: 99,
                        question_id: 'q'.repeat(100),
                        answer_id: 'a'.repeat(150),
                        reading_time_ms: 999999,
                        transition_time_ms: -5,
                        early_click_attempts: 99
                    }]
                }
            }
        }));

        const normalized = event.qualification_progress.safeguards;
        expect(normalized.reasonCodes).toEqual(['rushed_clickthrough']);
        expect(normalized.typedChallenge).toEqual({
            status: 'pending',
            reasonCodes: ['rushed_clickthrough'],
            failedAttempts: 2
        });
        expect(normalized.timing).toMatchObject({
            earlyClickAttemptCount: 100,
            fastAnswerCount: 30,
            timedAnswerCount: 30,
            firstSixReadingTimeMs: 1800000,
            evaluatedFlowAnswerCount: 6,
            evaluatedFlowReadingTimeMs: 1800000,
            evaluatedFlowThresholdMs: 60000,
            totalReadingTimeMs: 9000000,
            totalTransitionTimeMs: 0
        });
        expect(normalized.timing.samples[0]).toMatchObject({
            sequence: 30,
            readingTimeMs: 300000,
            transitionTimeMs: 0,
            earlyClickAttempts: 20
        });
        expect(Array.from(normalized.timing.samples[0].questionId)).toHaveLength(80);
        expect(Array.from(normalized.timing.samples[0].answerId)).toHaveLength(120);
    });

    test.each(['pending', 'failed'])('%s challenge overrides paid answers and a supplied qualified decision', status => {
        const event = normalizeLeadWebhookPayload(basePayload({
            status: status === 'failed' ? 'completed' : 'in_progress',
            trigger: 'safeguard',
            revision: 6,
            answeredCount: 3,
            decision: 'qualified_now',
            questionsAndAnswers: paidBusinessAnswers,
            safeguards: safeguards(status)
        }, {
            qualification_decision: 'qualified_now'
        }));

        expect(event.status).toBe('useless');
    });

    test.each(['pending', 'failed'])('%s challenge overrides an explicit top-level qualified status', status => {
        const event = normalizeLeadWebhookPayload(basePayload({
            status: status === 'failed' ? 'completed' : 'in_progress',
            trigger: 'safeguard',
            revision: 6,
            answeredCount: 3,
            questionsAndAnswers: paidBusinessAnswers,
            safeguards: safeguards(status)
        }, {
            status: 'qualified'
        }));

        expect(event.status).toBe('useless');
    });

    test('a later passed snapshot permits maybe status inference', () => {
        const event = normalizeLeadWebhookPayload(basePayload({
            status: 'completed',
            trigger: 'completed',
            revision: 7,
            answeredCount: 3,
            decision: 'qualified_now',
            questionsAndAnswers: paidBusinessAnswers,
            safeguards: safeguards('passed')
        }));

        expect(event.status).toBe('maybe');
        expect(event.qualification_progress.safeguards.typedChallenge.status).toBe('passed');
    });

    test('payloads without safeguards keep the legacy paid-path inference', () => {
        const event = normalizeLeadWebhookPayload(basePayload({
            status: 'in_progress',
            trigger: 'answer',
            revision: 5,
            answeredCount: 3,
            questionsAndAnswers: paidBusinessAnswers
        }));

        expect(event.status).toBe('maybe');
        expect(event.qualification_progress).not.toHaveProperty('safeguards');
    });

    test('marks explicit progress snapshots as tracking-only and final submissions as lead actions', () => {
        const progress = normalizeLeadWebhookPayload(basePayload({
            status: 'in_progress',
            trigger: 'answer',
            revision: 5,
            answeredCount: 3,
            questionsAndAnswers: paidBusinessAnswers
        }, {
            event_id: 'qualification_progress:lead-progress-1:5',
            tracking_only: true
        }));
        const submission = normalizeLeadWebhookPayload(basePayload({
            status: 'completed',
            trigger: 'completed',
            revision: 6,
            answeredCount: 3,
            decision: 'qualified_now',
            questionsAndAnswers: paidBusinessAnswers
        }, {
            tracking_only: false,
            qualification_decision: 'qualified_now'
        }));

        expect(progress.tracking_only).toBe(true);
        expect(submission.tracking_only).toBe(false);
    });

    test('recognizes legacy qualification progress event ids without misclassifying legacy final submissions', () => {
        const progress = normalizeLeadWebhookPayload(basePayload({}, {
            event_id: 'qualification_progress:lead-progress-1:4'
        }));
        const finalSubmission = normalizeLeadWebhookPayload(basePayload({}, {
            event_id: 'qualification_progress:lead-progress-1:5',
            qualification_decision: 'qualified_future'
        }));

        expect(progress.tracking_only).toBe(true);
        expect(finalSubmission.tracking_only).toBe(false);
    });

    test('drops malformed or unsupported safeguard envelopes without retaining raw fields', () => {
        const event = normalizeLeadWebhookPayload(basePayload({
            status: 'in_progress',
            trigger: 'answer',
            revision: 5,
            answeredCount: 3,
            questionsAndAnswers: paidBusinessAnswers,
            safeguards: {
                version: 2,
                reasonCodes: ['rushed_clickthrough'],
                typedChallenge: { status: 'bypass', reasonCodes: [], failedAttempts: 0 },
                timing: { samples: [] },
                untrusted: '<script>alert(1)</script>'
            }
        }));

        expect(event.status).toBe('maybe');
        expect(event.qualification_progress).not.toHaveProperty('safeguards');
        expect(JSON.stringify(event.qualification_progress)).not.toContain('untrusted');
    });

    test('keeps an explicit human or upstream qualified status qualified', () => {
        const event = normalizeLeadWebhookPayload(basePayload({}, {
            status: 'qualified'
        }));

        expect(event.status).toBe('qualified');
    });
});
