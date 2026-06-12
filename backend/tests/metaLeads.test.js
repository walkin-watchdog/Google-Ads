import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import {
    buildPlatformLeadAttributionSummary,
    normalizeLeadWebhookPayload,
    rebuildLeadSession
} from '../lib/leads.ts';

const metaPayload = {
    event_id: 'lead_submission:whatsapp_widget:whatsapp:meta-lead-1',
    session_id: 'meta-session-1',
    lead_id: 'meta-lead-1',
    source: 'whatsapp_widget',
    kind: 'whatsapp',
    ad_platform: 'meta',
    utm_source: 'ig',
    utm_medium: 'paid_social',
    utm_campaign: 'Clinic launch',
    utm_term: 'Clinic owners',
    utm_content: 'Demo video',
    campaign_id: '1201001',
    adset_id: '1201002',
    ad_id: '1201003',
    placement: 'instagram_stories',
    phone: '9999999999'
};

describe('Meta first-party lead ingestion', () => {
    test('normalizes Meta names, ids, and placement without treating the ad set as a Google keyword', () => {
        const event = normalizeLeadWebhookPayload(metaPayload);

        expect(event.ad_platform).toBe('meta');
        expect(event.utm_campaign).toBe('Clinic launch');
        expect(event.utm_term).toBe('Clinic owners');
        expect(event.utm_content).toBe('Demo video');
        expect(event.meta_campaign_id).toBe('1201001');
        expect(event.meta_adset_id).toBe('1201002');
        expect(event.meta_ad_id).toBe('1201003');
        expect(event.placement).toBe('instagram_stories');
        expect(event.keyword).toBeNull();
        expect(event.match_type).toBeNull();
    });

    test('keeps Google classification and click ids unchanged', () => {
        const event = normalizeLeadWebhookPayload({
            event_id: 'lead_submission:demo_page:demo:google-lead-1',
            session_id: 'google-session-1',
            lead_id: 'google-lead-1',
            source: 'demo_page',
            kind: 'demo',
            utm_source: 'google',
            utm_medium: 'cpc',
            utm_campaign: 'Search campaign',
            utm_term: 'whatsapp crm',
            gclid: 'google-click-1'
        });

        expect(event.ad_platform).toBe('google');
        expect(event.gclid).toBe('google-click-1');
        expect(event.meta_campaign_id).toBeNull();
        expect(event.keyword).toBe('whatsapp crm');
    });

    test('does not classify unrelated paid social traffic as Meta', () => {
        const event = normalizeLeadWebhookPayload({
            event_id: 'lead_submission:request_page:contact:linkedin-lead',
            session_id: 'linkedin-session',
            lead_id: 'linkedin-lead',
            source: 'request_page',
            kind: 'contact',
            utm_source: 'linkedin',
            utm_medium: 'paid_social'
        });

        expect(event.ad_platform).toBe('other');
        expect(event.meta_campaign_id).toBeNull();
    });

    test('uses the latest paid platform when rebuilding a shared browser session', async () => {
        let sessionInsertParams = null;
        const googleEvent = {
            event_id: 'google-event',
            session_key: 'session_id:shared-session',
            session_key_type: 'session_id',
            kind: 'demo',
            source: 'demo_page',
            lead_id: 'shared-lead',
            session_id: 'shared-session',
            gclid: 'stale-google-click',
            gbraid: null,
            wbraid: null,
            ad_platform: 'google',
            utm_source: 'google',
            utm_medium: 'cpc',
            utm_campaign: 'Old Google campaign',
            ad_group_id: 'google-group',
            meta_campaign_id: null,
            meta_adset_id: null,
            meta_ad_id: null,
            placement: null,
            utm_term: 'old keyword',
            utm_content: null,
            keyword: 'old keyword',
            match_type: 'EXACT',
            name: 'Lead',
            email: 'lead@example.com',
            phone: '9999999999',
            tracking_only: false,
            status: 'new',
            status_rank: 0,
            progress_revision: null,
            qualification_progress: {},
            submitted_at: '2026-07-20T10:00:00.000Z',
            received_at: '2026-07-20T10:00:00.000Z'
        };
        const metaEvent = {
            ...googleEvent,
            event_id: 'meta-event',
            kind: 'whatsapp',
            source: 'whatsapp_widget',
            gclid: null,
            ad_platform: 'meta',
            utm_source: 'ig',
            utm_medium: 'paid_social',
            utm_campaign: 'New Meta campaign',
            ad_group_id: null,
            meta_campaign_id: 'meta-campaign',
            meta_adset_id: 'meta-adset',
            meta_ad_id: 'meta-ad',
            placement: 'instagram_feed',
            utm_term: 'Meta ad set',
            utm_content: 'Meta ad',
            keyword: null,
            match_type: null,
            submitted_at: '2026-07-21T10:00:00.000Z',
            received_at: '2026-07-21T10:00:00.000Z'
        };
        const pool = {
            async query(sql, params) {
                if (String(sql).includes('FROM lead_events')) {
                    return { rows: [googleEvent, metaEvent] };
                }
                if (String(sql).includes('INSERT INTO lead_sessions')) {
                    sessionInsertParams = params;
                    return { rows: [] };
                }
                throw new Error(`Unexpected query: ${sql}`);
            }
        };

        await rebuildLeadSession(pool, 'session_id:shared-session');

        const attribution = sessionInsertParams[15];
        expect(attribution.ad_platform).toBe('meta');
        expect(attribution.meta_campaign_id).toBe('meta-campaign');
        expect(attribution.meta_adset_id).toBe('meta-adset');
        expect(attribution.meta_ad_id).toBe('meta-ad');
        expect(attribution.gclid).toBeNull();
        expect(attribution.ad_group_id).toBeNull();
    });

    test('keeps same-named Meta ad sets and ads separate by campaign and placement', () => {
        const metaSession = (sessionKey, campaignId, campaignName, placement) => ({
            session_key: sessionKey,
            session_key_type: 'session_id',
            status: 'new',
            status_rank: 0,
            qualification_progress: {},
            lead_source: 'whatsapp_widget',
            event_count: 1,
            lead_ids: [],
            attribution: {
                ad_platform: 'meta',
                utm_source: 'ig',
                utm_medium: 'paid_social',
                utm_campaign: campaignName,
                utm_term: 'Shared audience',
                utm_content: 'Shared creative',
                meta_campaign_id: campaignId,
                placement
            },
            contact: {},
            first_seen: '2026-07-20T10:00:00.000Z',
            last_seen: '2026-07-20T10:00:00.000Z'
        });
        const summary = buildPlatformLeadAttributionSummary({
            platform: 'meta',
            sessions: [
                metaSession('session-a-feed', 'campaign-a', 'Campaign A', 'instagram_feed'),
                metaSession('session-a-story', 'campaign-a', 'Campaign A', 'instagram_stories'),
                metaSession('session-b-feed', 'campaign-b', 'Campaign B', 'instagram_feed')
            ],
            events: [],
            spendByCampaign: new Map(),
            scope: { level: 'account', dateRangeOnly: true }
        });

        expect(summary.byAdSet).toHaveLength(2);
        expect(summary.byAd).toHaveLength(3);
        expect(summary.byAd.map(row => row.placement).sort()).toEqual([
            'instagram_feed',
            'instagram_feed',
            'instagram_stories'
        ]);
    });
});

describe('Meta lead dashboard contract', () => {
    test('provides platform switching, Meta fields, and Meta overview leads', () => {
        const html = readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');
        const app = readFileSync(new URL('../client/app.js', import.meta.url), 'utf8');
        const styles = readFileSync(new URL('../client/styles.css', import.meta.url), 'utf8');
        const leads = readFileSync(new URL('../lib/leads.ts', import.meta.url), 'utf8');

        expect(html).toContain('data-lead-platform="google"');
        expect(html).toContain('data-lead-platform="meta"');
        expect(html).toContain('card-header lead-attribution-header');
        expect(html).toContain('grid-controls lead-attribution-controls');
        expect(styles).toContain('.lead-attribution-header .lead-attribution-controls {');
        expect(styles).toContain('justify-content: space-between;');
        expect(styles).toContain('.lead-attribution-controls #downloadOfflineConversionsBtn {');
        expect(app).toContain("label: 'Meta Leads'");
        expect(app).toContain("headerName: 'Ad Set'");
        expect(app).toContain("headerName: 'Ad'");
        expect(app).toContain("headerName: 'Placement'");
        expect(app).toContain('exportBtn.hidden = isMeta');
        expect(app).toContain('attribution?.platforms?.meta?.recentLeads');
        expect(leads).toContain('meta_campaign_id TEXT');
        expect(leads).toContain('meta_adset_id TEXT');
        expect(leads).toContain('meta_ad_id TEXT');
        expect(leads).toContain('const attributionPlatform = detectLeadAdPlatform');
        expect(leads).not.toContain('WITH extracted_meta AS');
        expect(leads).not.toContain('rebuilt_attribution AS');
        expect(leads).toContain("WHEN EXCLUDED.ad_platform = 'other'");
        expect(leads).not.toContain("WHEN bool_or(ad_platform = 'google')");
    });
});
