import { describe, expect, test } from 'bun:test';
import { mapReportRows } from '../lib/adsReportMappers.ts';

describe('ads report mappers', () => {
    test('conversion action mapper falls back to all_conversions metrics when conversions fields are absent', () => {
        const mapped = mapReportRows('conversion_action_performance', '1234567890', [{
            'segments.date': '2026-01-15',
            'conversion_action.resource_name': 'customers/1234567890/conversionActions/777',
            'conversion_action.name': 'Qualified lead',
            'conversion_action.category': 'SUBMIT_LEAD_FORM',
            'conversion_action.status': 'ENABLED',
            'conversion_action.primary_for_goal': true,
            'metrics.all_conversions': 3,
            'metrics.all_conversions_value': 1500
        }]);

        expect(mapped.conversionActionDaily).toHaveLength(1);
        expect(mapped.conversionActionDaily[0]).toMatchObject({
            customer_id: '1234567890',
            date: '2026-01-15',
            conversion_action_resource_name: 'customers/1234567890/conversionActions/777',
            conversions: 3,
            conversions_value: 1500,
            all_conversions: 3
        });
    });

    test('click evidence mapper reads ids and click_view keyword fields from click_view reports', () => {
        const mapped = mapReportRows('click_evidence_by_day', '1234567890', [{
            'segments.date': '2026-01-16',
            'click_view.gclid': 'gclid-123',
            'campaign.id': 'C1',
            'ad_group.id': 'A1',
            'click_view.keyword_info.text': 'whatsapp crm',
            'click_view.keyword_info.match_type': 'EXACT',
            'segments.click_type': 'URL_CLICKS',
            'segments.device': 'MOBILE'
        }]);

        expect(mapped.clickEvidenceDaily).toHaveLength(1);
        expect(mapped.clickEvidenceDaily[0]).toMatchObject({
            customer_id: '1234567890',
            date: '2026-01-16',
            gclid: 'gclid-123',
            campaign_id: 'C1',
            ad_group_id: 'A1',
            keyword_text: 'whatsapp crm',
            keyword_match_type: 'EXACT',
            click_type: 'URL_CLICKS',
            device: 'MOBILE'
        });
        expect(mapped.clickEvidenceDaily[0].dimension_hash).toMatch(/^[a-f0-9]{64}$/);
    });
});
