import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';

import { getLeadAttributionSummary } from '../lib/leads.ts';

class LeadReviewDateScopePool {
    constructor() {
        this.calls = [];
    }

    async query(sql, params = []) {
        const compact = String(sql).replace(/\s+/g, ' ').trim();
        this.calls.push({ sql: compact, params });
        if (compact.includes('FROM lead_events') && compact.includes('WHERE session_key = ANY')) {
            return { rows: [] };
        }
        if (compact.includes('SELECT session_key, session_key_type') && compact.includes('FROM lead_sessions')) {
            const isAllTimeGoogleReview = !compact.includes('first_seen >=') && params.at(-1) === 'google';
            return {
                rows: isAllTimeGoogleReview ? [{
                    session_key: 'all-time-google-lead',
                    session_key_type: 'session_id',
                    status: 'new',
                    status_rank: 1,
                    progress_status: null,
                    progress_trigger: null,
                    progress_revision: 0,
                    progress_answered_count: 0,
                    qualification_progress: {},
                    lead_source: 'webhook',
                    event_count: 1,
                    lead_ids: [],
                    attribution: { ad_platform: 'google', gclid: 'gclid-all-time' },
                    contact: { name: 'All-time lead' },
                    first_seen: '2025-12-15T10:00:00.000Z',
                    last_seen: '2025-12-15T10:05:00.000Z',
                    updated_at: '2025-12-15T10:05:00.000Z'
                }] : []
            };
        }
        return { rows: [] };
    }
}

describe('Lead Review date scope', () => {
    test('keeps review rows all-time while analytical attribution remains date-scoped', async () => {
        const pool = new LeadReviewDateScopePool();
        const summary = await getLeadAttributionSummary(pool, {
            meta: {
                accountId: '1234567890',
                dateRange: { start: '2026-01-01', end: '2026-01-31' },
                filters: { campaignId: null, adGroupId: null }
            },
            campaigns: [],
            filterOptions: { campaigns: [], adGroups: [] }
        });

        expect(summary.totals.uniqueLeads).toBe(0);
        expect(summary.platforms.google.review.allTime).toBe(true);
        expect(summary.platforms.google.review.totals.uniqueLeads).toBe(1);
        expect(summary.platforms.google.review.recentLeads[0].sessionKey).toBe('all-time-google-lead');

        const sessionCalls = pool.calls.filter(call =>
            call.sql.includes('SELECT session_key, session_key_type')
            && call.sql.includes('FROM lead_sessions')
        );
        expect(sessionCalls.some(call => call.sql.includes('first_seen >=') && call.sql.includes('first_seen <'))).toBe(true);
        expect(sessionCalls.some(call => !call.sql.includes('first_seen >=') && call.params.at(-1) === 'google')).toBe(true);
    });

    test('client exports and review API do not forward the dashboard date range', () => {
        const root = path.join(import.meta.dir, '..');
        const app = fs.readFileSync(path.join(root, 'client', 'app.js'), 'utf8');
        const server = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');
        const exportControls = app.slice(
            app.indexOf('function setupLeadExportControls()'),
            app.indexOf('function parseKeywordPlannerSeeds')
        );
        const reviewRoute = server.slice(
            server.indexOf("app.get('/api/leads/review.csv'"),
            server.indexOf("app.get('/api/leads/session/:sessionKey'")
        );

        expect(exportControls).not.toContain("params.set('startDate'");
        expect(exportControls).not.toContain("params.set('endDate'");
        expect(reviewRoute).not.toContain('startDate: filters.startDate');
        expect(reviewRoute).not.toContain('endDate: filters.endDate');
        expect(app).toContain('lead-review-all-time');
    });
});
