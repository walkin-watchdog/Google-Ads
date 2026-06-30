import { describe, expect, test } from 'bun:test';
import { normalizeChangeHistoryRows } from '../lib/changeHistory.ts';

describe('change history normalization', () => {
    test('reads v24 change_event campaign and ad group resource names', () => {
        const [event] = normalizeChangeHistoryRows([{
            'change_event.resource_name': 'customers/123/changeEvents/abc',
            'change_event.change_date_time': '2026-06-01 10:00:00',
            'change_event.change_resource_type': 'AD_GROUP',
            'change_event.resource_change_operation': 'UPDATE',
            'change_event.changed_fields': 'ad_group.status',
            'change_event.campaign': 'customers/123/campaigns/111',
            'change_event.ad_group': 'customers/123/adGroups/222'
        }]);

        expect(event.campaign_id).toBe('111');
        expect(event.ad_group_id).toBe('222');
    });
});
