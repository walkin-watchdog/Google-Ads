import { describe, expect, test } from 'bun:test';
import { createProposalFeedback, normalizeProposal, updateProposalFeedbackStatus } from '../lib/proposals.ts';

function diagnosisVerification() {
    return {
        kind: 'diagnosis_only',
        observable: false,
        entity: {},
        expected: {}
    };
}

describe('proposal memory context', () => {
    test('normalizes proposal and option memory_context without requiring old proposals to include it', () => {
        const normalized = normalizeProposal({
            proposal_id: 'prop_memory_context',
            type: 'DIAGNOSE',
            summary: 'Explain launch campaign risk',
            memory_context: {
                summary: 'A remembered launch constraint changed this from a pause recommendation to a watchlist.',
                memories: [{
                    memory_id: 'mem_123',
                    scope_type: 'campaign',
                    category: 'business_context',
                    authority: 'hard_constraint',
                    verification_status: 'user_confirmed',
                    content: 'Brand campaign is strategic during launch month.',
                    reason: 'The proposal should not recommend a direct budget cut while launch protection is active.',
                    influence: 'reframed'
                }],
                caveats: ['Confirm launch month is still active.']
            },
            options: [{
                option_id: 'watch',
                strategy_type: 'WATCHLIST',
                hypothesis: 'CPA is high but launch protection may still apply.',
                recommendation: 'Watch for another week before proposing a cut.',
                memory_context: {
                    summary: 'This option is softer because of the launch constraint.'
                },
                verification_spec: diagnosisVerification()
            }]
        });

        expect(normalized.memory_context.summary).toContain('launch constraint');
        expect(normalized.memory_context.memories[0].content).toContain('Brand campaign');
        expect(normalized.memory_context.caveats).toEqual(['Confirm launch month is still active.']);
        expect(normalized.options[0].memory_context.summary).toContain('softer');

        const oldShape = normalizeProposal({
            proposal_id: 'prop_without_memory_context',
            type: 'DIAGNOSE',
            summary: 'Old proposal shape still works',
            options: [{
                option_id: 'diagnose',
                strategy_type: 'DIAGNOSE',
                hypothesis: 'No memory context exists.',
                recommendation: 'Keep rendering as before.',
                verification_spec: diagnosisVerification()
            }]
        });
        expect(oldShape.memory_context).toBeNull();
        expect(oldShape.options[0].memory_context).toBeNull();
    });
});

describe('proposal feedback', () => {
    function proposalPayload() {
        return normalizeProposal({
            proposal_id: 'prop_feedback',
            type: 'DIAGNOSE',
            summary: 'Feedback test proposal',
            options: [{
                option_id: 'diagnose',
                strategy_type: 'DIAGNOSE',
                hypothesis: 'Feedback should be stored.',
                recommendation: 'Review feedback.',
                verification_spec: diagnosisVerification()
            }]
        });
    }

    test('creates raw feedback only after proposal and option validation', async () => {
        const calls = [];
        const client = {
            async query(sql, params = []) {
                calls.push({ sql, params });
                if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
                if (sql.includes('SELECT payload FROM proposals')) return { rows: [{ payload: proposalPayload() }] };
                if (sql.includes('INSERT INTO proposal_feedback')) {
                    return {
                        rows: [{
                            feedback_id: params[0],
                            customer_id: params[1],
                            proposal_id: params[2],
                            option_id: params[3],
                            feedback_type: params[4],
                            comment: params[5],
                            status: 'raw',
                            related_memory_id: null,
                            created_by: params[6],
                            reviewed_by: null,
                            reviewer_note: null,
                            created_at: '2026-06-22T00:00:00.000Z',
                            updated_at: '2026-06-22T00:00:00.000Z',
                            reviewed_at: null
                        }]
                    };
                }
                if (sql.includes('INSERT INTO proposal_events')) return { rows: [] };
                throw new Error(`Unexpected SQL: ${sql}`);
            },
            release() {}
        };
        const pool = { connect: async () => client };

        const feedback = await createProposalFeedback(pool, {
            proposalId: 'prop_feedback',
            optionId: 'diagnose',
            customerId: '6780466013',
            feedbackType: 'preference',
            comment: 'Do not suggest pausing brand campaigns during launch.',
            createdBy: 'user'
        });

        expect(feedback.feedback_id.startsWith('pf_')).toBe(true);
        expect(feedback.status).toBe('raw');
        expect(feedback.feedback_type).toBe('preference');
        expect(feedback.comment).toContain('brand campaigns');
        expect(calls.some(call => call.sql === 'COMMIT')).toBe(true);
    });

    test('rejects feedback for an option outside the proposal', async () => {
        const client = {
            async query(sql) {
                if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
                if (sql.includes('SELECT payload FROM proposals')) return { rows: [{ payload: proposalPayload() }] };
                throw new Error(`Unexpected SQL: ${sql}`);
            },
            release() {}
        };
        const pool = { connect: async () => client };

        await expect(createProposalFeedback(pool, {
            proposalId: 'prop_feedback',
            optionId: 'missing',
            comment: 'This option does not exist.'
        })).rejects.toThrow(/does not belong to proposal/);
    });

    test('requires a related memory id before marking feedback converted', async () => {
        const pool = {
            connect() {
                throw new Error('Validation should fail before opening a database connection.');
            }
        };

        await expect(updateProposalFeedbackStatus(pool, {
            feedbackId: 'pf_123',
            status: 'converted_to_memory'
        })).rejects.toThrow(/related_memory_id is required/);
    });
});
