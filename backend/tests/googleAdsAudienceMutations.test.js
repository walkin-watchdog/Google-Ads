import { describe, expect, test } from 'bun:test';
import { buildAudienceMutationOperations } from '../lib/googleAdsAudienceMutations.ts';

const customerId = '1234567890';

describe('Google Ads audience mutation operation builder', () => {
    test('builds campaign and ad-group segment operations with exact owners', () => {
        const result = buildAudienceMutationOperations({
            customerId,
            changes: [
                {
                    action: 'add_segment', scope: 'campaign', campaignId: '111', ownerId: '111',
                    criterionType: 'USER_INTEREST', audienceResourceName: `customers/${customerId}/userInterests/10`, negative: false
                },
                {
                    action: 'add_segment', scope: 'ad_group', campaignId: '111', adGroupId: '222', ownerId: '222',
                    criterionType: 'USER_LIST', audienceResourceName: `customers/${customerId}/userLists/20`, negative: true
                }
            ]
        });

        expect(result.operationsByPath['googleAds:mutate']).toEqual([
            { campaignCriterionOperation: { create: {
                campaign: `customers/${customerId}/campaigns/111`,
                status: 'ENABLED', negative: false,
                userInterest: { userInterestCategory: `customers/${customerId}/userInterests/10` }
            } } },
            { adGroupCriterionOperation: { create: {
                adGroup: `customers/${customerId}/adGroups/222`,
                status: 'ENABLED', negative: true,
                userList: { userList: `customers/${customerId}/userLists/20` }
            } } }
        ]);
        expect(result.touched).toEqual({ campaignIds: ['111'], adGroupIds: ['222'] });
    });

    test('preserves non-audience restrictions when setting an explicit targeting mode', () => {
        const targetingRestrictions = [
            { targetingDimension: 'AGE_RANGE', bidOnly: false },
            { targetingDimension: 'AUDIENCE', bidOnly: false }
        ];
        const result = buildAudienceMutationOperations({
            customerId,
            changes: [{
                action: 'set_targeting_mode', scope: 'campaign', campaignId: '111', ownerId: '111', mode: 'TARGETING',
                currentTargetingRestrictions: [{ targetingDimension: 'AGE_RANGE', bidOnly: false }],
                targetingRestrictions
            }]
        });

        expect(result.operationsByPath['googleAds:mutate'][0]).toEqual({
            campaignOperation: {
                update: {
                    resourceName: `customers/${customerId}/campaigns/111`,
                    targetingSetting: { targetRestrictions: targetingRestrictions }
                },
                updateMask: 'targetingSetting.targetRestrictions'
            }
        });
    });

    test('creates and removes demographic exclusions in one reviewed mutation', () => {
        const result = buildAudienceMutationOperations({
            customerId,
            changes: [{
                action: 'set_demographics', scope: 'ad_group', campaignId: '111', adGroupId: '222', ownerId: '222',
                dimension: 'GENDER', includedValues: ['FEMALE', 'UNDETERMINED'],
                adds: ['MALE'],
                removes: [{ value: 'FEMALE', resourceName: `customers/${customerId}/adGroupCriteria/222~901` }]
            }]
        });

        expect(result.operationsByPath['googleAds:mutate']).toEqual([
            { adGroupCriterionOperation: { create: {
                adGroup: `customers/${customerId}/adGroups/222`, status: 'ENABLED', negative: true,
                gender: { type: 'MALE' }
            } } },
            { adGroupCriterionOperation: { remove: `customers/${customerId}/adGroupCriteria/222~901` } }
        ]);
    });

    test('updates bid modifiers directly and removes only the selected criterion resource', () => {
        const result = buildAudienceMutationOperations({
            customerId,
            changes: [
                {
                    action: 'set_bid_modifier', scope: 'ad_group', campaignId: '111', adGroupId: '222', ownerId: '222',
                    criterionType: 'AUDIENCE', audienceResourceName: `customers/${customerId}/audiences/30`,
                    criterionResourceName: `customers/${customerId}/adGroupCriteria/222~902`,
                    currentBidModifier: 1, bidModifier: 1.25
                },
                {
                    action: 'remove_segment', scope: 'campaign', campaignId: '111', ownerId: '111',
                    criterionType: 'EXTENDED_DEMOGRAPHIC', audienceResourceName: `customers/${customerId}/detailedDemographics/40`,
                    criterionResourceName: `customers/${customerId}/campaignCriteria/111~903`, negative: true
                }
            ]
        });

        expect(result.operationsByPath['googleAds:mutate'][0].adGroupCriterionOperation.updateMask).toBe('bidModifier');
        expect(result.operationsByPath['googleAds:mutate'][0].adGroupCriterionOperation.update.bidModifier).toBe(1.25);
        expect(result.operationsByPath['googleAds:mutate'][1]).toEqual({
            campaignCriterionOperation: { remove: `customers/${customerId}/campaignCriteria/111~903` }
        });
    });

    test('keeps custom-segment creation on its separate Google Ads resource path', () => {
        const customAudience = {
            name: 'High-intent SaaS buyers', description: 'Reviewed segment', type: 'SEARCH',
            members: [{ memberType: 'KEYWORD', keyword: 'saas crm' }]
        };
        const result = buildAudienceMutationOperations({
            customerId,
            changes: [{ action: 'create_custom_audience', customAudience }]
        });

        expect(result.operationsByPath).toEqual({ 'customAudiences:mutate': [{ create: customAudience }] });
        expect(result.diff[0]).toMatchObject({ action: 'create_custom_audience', memberCount: 1 });
        expect(() => buildAudienceMutationOperations({
            customerId,
            changes: [
                { action: 'create_custom_audience', customAudience },
                {
                    action: 'add_segment', scope: 'campaign', campaignId: '111', ownerId: '111',
                    criterionType: 'USER_INTEREST', audienceResourceName: `customers/${customerId}/userInterests/10`
                }
            ]
        })).toThrow('Custom segment creation must be reviewed separately');
    });
});
