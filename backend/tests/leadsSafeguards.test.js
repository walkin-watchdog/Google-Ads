import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';

import { exportLeadReviewCsv } from '../lib/leads.ts';

class FakeLeadReviewPool {
    async query(sql) {
        const compact = sql.replace(/\s+/g, ' ').trim();
        if (compact.includes('CREATE TABLE IF NOT EXISTS lead_events')) return { rows: [] };
        if (compact.includes('FROM lead_events')) return { rows: [] };
        if (compact.includes('SELECT session_key, session_key_type') && compact.includes('FROM lead_sessions')) {
            return {
                rows: [{
                    session_key: 'session_id:=formula-session',
                    session_key_type: 'session_id',
                    status: 'useless',
                    status_rank: 3,
                    progress_status: 'in_progress',
                    progress_trigger: 'safeguard',
                    progress_revision: 8,
                    progress_answered_count: 4,
                    event_count: 2,
                    lead_ids: ['=formula-lead'],
                    attribution: {
                        utm_campaign: '=formula-campaign',
                        utm_term: '@formula-term',
                        keyword: '+formula-keyword',
                        gclid: 'gclid-1'
                    },
                    contact: {
                        name: '=FORMULA()',
                        email: 'lead@example.com',
                        phone: '+919876543210'
                    },
                    qualification_progress: {
                        status: 'in_progress',
                        trigger: 'safeguard',
                        revision: 8,
                        answeredCount: 4,
                        questionsAndAnswers: [{
                            questionId: 'use_case_detail',
                            question: 'Explain intended use',
                            answerId: 'typed',
                            answer: '=SUM(1+1) coordinate appointment reminders for patients'
                        }],
                        safeguards: {
                            version: 1,
                            reasonCodes: ['rushed_clickthrough', 'weak_business_detail'],
                            typedChallenge: {
                                status: 'pending',
                                reasonCodes: ['rushed_clickthrough'],
                                failedAttempts: 1
                            },
                            timing: {
                                earlyClickAttemptCount: 2,
                                fastAnswerCount: 4,
                                timedAnswerCount: 5,
                                firstSixReadingTimeMs: 7999,
                                evaluatedFlowAnswerCount: 5,
                                evaluatedFlowReadingTimeMs: 4166,
                                evaluatedFlowThresholdMs: 4167,
                                totalReadingTimeMs: 8200,
                                totalTransitionTimeMs: 750,
                                samples: []
                            }
                        }
                    },
                    first_seen: '2026-07-10T10:00:00.000Z',
                    last_seen: '2026-07-10T10:05:00.000Z',
                    updated_at: '2026-07-10T10:05:00.000Z'
                }]
            };
        }
        return { rows: [] };
    }
}

describe('lead safeguard exports', () => {
    test('exports safeguard fields and neutralizes formula-prefixed user text', async () => {
        const result = await exportLeadReviewCsv(new FakeLeadReviewPool());

        expect(result.rowCount).toBe(1);
        expect(result.csv).toContain('Safeguard Reasons');
        expect(result.csv).toContain('Excluded Transition Time (ms)');
        expect(result.csv).toContain('Evaluated Flow Threshold (ms)');
        expect(result.csv).toContain('4167');
        expect(result.csv).toContain('rushed_clickthrough | weak_business_detail');
        expect(result.csv).toContain("'=FORMULA()");
        expect(result.csv).toContain("'=SUM(1+1) coordinate appointment reminders for patients");
        expect(result.csv).toContain("'@formula-term");
        expect(result.csv).toContain("'+919876543210");
    });
});

describe('lead safeguard client contract', () => {
    const root = path.join(import.meta.dir, '..');
    const app = fs.readFileSync(path.join(root, 'client', 'app.js'), 'utf8');
    const styles = fs.readFileSync(path.join(root, 'client', 'styles.css'), 'utf8');

    test('renders a filterable safeguard column and escaped modal values', () => {
        expect(app).toContain("field: 'safeguardSummary'");
        expect(app).toContain("filter: 'agTextColumnFilter'");
        expect(app).toContain("Object.prototype.hasOwnProperty.call(lead, 'qualificationSafeguards')");
        expect(app).toContain('${esc(answer.answer)}');
        expect(app).toContain("${esc(`Answer: ${sample.answerId || ''}`)}");
        expect(app).toContain('Qualification Safeguards');
        expect(app).toContain('<span>Rushed below</span>');
        expect(styles).toContain('.lead-safeguard-badge');
        expect(styles).toContain('.lead-timing-sample-row');
    });

    test('labels concrete lead actions instead of generic webhook captures', () => {
        expect(app).toContain("return 'No form submitted'");
        expect(app).toContain("demo: 'Demo / booking form'");
        expect(app).toContain("whatsapp: 'WhatsApp widget'");
        expect(app).toContain("signup: 'Signup'");
        expect(app).toContain("contact: 'Contact form'");
        expect(app).toContain("request: 'Request form'");
    });
});
