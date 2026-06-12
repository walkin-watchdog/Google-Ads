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

    test('keyword click details mapper reads keyword slot click rows from keyword_view reports', () => {
        const mapped = mapReportRows('keyword_click_details', '1234567890', [{
            'segments.date': '2026-01-16',
            'campaign.id': 'C1',
            'campaign.name': 'Core Campaign',
            'ad_group.id': 'A1',
            'ad_group.name': 'Core Ad Group',
            'ad_group_criterion.criterion_id': 'K1',
            'ad_group_criterion.resource_name': 'customers/123/adGroupCriteria/K1',
            'ad_group_criterion.keyword.text': 'whatsapp crm',
            'ad_group_criterion.keyword.match_type': 'EXACT',
            'segments.slot': 'SEARCH_TOP',
            'segments.device': 'MOBILE',
            'metrics.clicks': 7
        }]);

        expect(mapped.keywordClickDaily).toHaveLength(1);
        expect(mapped.keywordClickDaily[0]).toMatchObject({
            customer_id: '1234567890',
            date: '2026-01-16',
            campaign_id: 'C1',
            campaign_name: 'Core Campaign',
            ad_group_id: 'A1',
            ad_group_name: 'Core Ad Group',
            criterion_id: 'K1',
            keyword_text: 'whatsapp crm',
            match_type: 'EXACT',
            slot: 'SEARCH_TOP',
            device: 'MOBILE',
            clicks: 7
        });
        expect(mapped.keywordClickDaily[0].dimension_hash).toMatch(/^[a-f0-9]{64}$/);
    });

    test('conversion search-term mapper preserves matched keyword dimensions in its identity', () => {
        const row = {
            'segments.date': '2026-01-16',
            'campaign.id': 'C1',
            'campaign.name': 'Core Campaign',
            'ad_group.id': 'A1',
            'ad_group.name': 'Core Ad Group',
            'search_term_view.search_term': 'whatsapp crm',
            'segments.keyword.info.text': 'whatsapp marketing tool',
            'segments.keyword.info.match_type': 'PHRASE',
            'segments.conversion_action_name': 'Submit lead form',
            'segments.conversion_action_category': 'SUBMIT_LEAD_FORM',
            'metrics.conversions': 2
        };
        const first = mapReportRows('conversion_attribution_by_search_term', '1234567890', [row]);
        const second = mapReportRows('conversion_attribution_by_search_term', '1234567890', [{
            ...row,
            'segments.keyword.info.text': 'whatsapp crm software'
        }]);

        expect(first.conversionSearchTermDaily[0]).toMatchObject({
            matched_keyword_text: 'whatsapp marketing tool',
            matched_keyword_match_type: 'PHRASE'
        });
        expect(first.conversionSearchTermDaily[0].dimension_hash).not.toBe(second.conversionSearchTermDaily[0].dimension_hash);
    });

    test('campaign audience criteria mapper preserves detailed-demographic scope and identity', () => {
        const mapped = mapReportRows('campaign_audience_criteria', '1234567890', [{
            'campaign.id': '111',
            'campaign.name': 'Search campaign',
            'campaign_criterion.criterion_id': '444',
            'campaign_criterion.resource_name': 'customers/1234567890/campaignCriteria/111~444',
            // Google exposes the populated subtype even though CriterionType has
            // no EXTENDED_DEMOGRAPHIC enum constant. The subtype must win.
            'campaign_criterion.type': 'USER_INTEREST',
            'campaign_criterion.status': 'ENABLED',
            'campaign_criterion.negative': true,
            'campaign_criterion.extended_demographic.extended_demographic_id': '567'
        }]);

        expect(mapped.campaignAudienceCriteria).toHaveLength(1);
        expect(mapped.campaignAudienceCriteria[0]).toMatchObject({
            customer_id: '1234567890',
            campaign_id: '111',
            criterion_id: '444',
            criterion_type: 'EXTENDED_DEMOGRAPHIC',
            negative: true,
            audience_resource_name: 'customers/1234567890/detailedDemographics/567',
            audience_id: '567'
        });
    });

    test('audience performance mapper retains reporting metrics and audience criterion type', () => {
        const mapped = mapReportRows('ad_group_audience_performance', '1234567890', [{
            'segments.date': '2026-07-19',
            'campaign.id': '111',
            'campaign.name': 'Search campaign',
            'ad_group.id': '222',
            'ad_group.name': 'Core',
            'ad_group_criterion.criterion_id': '333',
            'ad_group_criterion.resource_name': 'customers/1234567890/adGroupCriteria/222~333',
            'ad_group_criterion.type': 'USER_INTEREST',
            'metrics.cost_micros': 2500000,
            'metrics.clicks': 5,
            'metrics.impressions': 100,
            'metrics.conversions': 2
        }]);

        expect(mapped.adGroupAudienceDaily[0]).toMatchObject({
            date: '2026-07-19',
            campaign_id: '111',
            ad_group_id: '222',
            criterion_id: '333',
            criterion_type: 'USER_INTEREST',
            cost_micros: 2500000,
            clicks: 5,
            impressions: 100,
            conversions: 2
        });
    });
});
