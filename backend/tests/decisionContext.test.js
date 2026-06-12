import { describe, expect, test } from 'bun:test';
import {
    buildDecisionContextSummary,
    decisionContextForTerm,
    normalizeNegativeRulesFromReports
} from '../lib/decisionContext.ts';

const configuredKeywords = [
    {
        campaignId: '100',
        campaignName: 'Generic',
        adGroupId: '200',
        adGroupName: 'Core',
        keywordText: 'whatsapp crm',
        matchType: 'EXACT',
        status: 'ENABLED'
    },
    {
        campaignId: '100',
        campaignName: 'Generic',
        adGroupId: '201',
        adGroupName: 'Paused',
        keywordText: 'whatsapp pricing',
        matchType: 'PHRASE',
        status: 'PAUSED'
    }
];

describe('decisionContextForTerm negative matching', () => {
    test('matches exact negatives only on identical normalized terms', () => {
        const rules = [{
            source: 'campaign',
            campaignId: '100',
            campaignName: 'Generic',
            keywordText: 'free crm',
            matchType: 'EXACT',
            status: 'ENABLED'
        }];
        const covered = decisionContextForTerm('Free CRM', { campaignId: '100' }, rules, []);
        const notCovered = decisionContextForTerm('free crm software', { campaignId: '100' }, rules, []);
        expect(covered.negativeCoverage.isNegativeCovered).toBe(true);
        expect(notCovered.negativeCoverage.isNegativeCovered).toBe(false);
    });

    test('matches phrase negatives as contiguous token phrases', () => {
        const rules = [{
            source: 'campaign',
            campaignId: '100',
            keywordText: 'job salary',
            matchType: 'PHRASE',
            status: 'ENABLED'
        }];
        expect(decisionContextForTerm('whatsapp job salary india', { campaignId: '100' }, rules, []).negativeCoverage.isNegativeCovered).toBe(true);
        expect(decisionContextForTerm('salary for whatsapp job', { campaignId: '100' }, rules, []).negativeCoverage.isNegativeCovered).toBe(false);
    });

    test('matches broad negatives by token containment', () => {
        const rules = [{
            source: 'account',
            keywordText: 'free template',
            matchType: 'BROAD',
            status: 'ENABLED'
        }];
        expect(decisionContextForTerm('download free whatsapp template', {}, rules, []).negativeCoverage.isNegativeCovered).toBe(true);
    });

    test('honors ad group and campaign scope specificity', () => {
        const rules = [{
            source: 'ad_group',
            campaignId: '100',
            adGroupId: '200',
            keywordText: 'login',
            matchType: 'BROAD',
            status: 'ENABLED'
        }];
        expect(decisionContextForTerm('whatsapp login', { campaignId: '100', adGroupId: '200' }, rules, []).negativeCoverage.isNegativeCovered).toBe(true);
        expect(decisionContextForTerm('whatsapp login', { campaignId: '100', adGroupId: '201' }, rules, []).negativeCoverage.isNegativeCovered).toBe(false);
    });

    test('honors shared-list campaign attachments', () => {
        const rules = [{
            source: 'shared_list',
            sharedSetId: 's1',
            sharedSetName: 'Shared junk',
            attachedCampaignIds: ['100'],
            keywordText: 'career',
            matchType: 'BROAD',
            status: 'ENABLED'
        }];
        expect(decisionContextForTerm('whatsapp career', { campaignId: '100' }, rules, []).negativeCoverage.isNegativeCovered).toBe(true);
        expect(decisionContextForTerm('whatsapp career', { campaignId: '999' }, rules, []).negativeCoverage.isNegativeCovered).toBe(false);
    });

    test('does not treat scoped negatives as account-wide coverage without campaign scope', () => {
        const rules = [
            {
                source: 'campaign',
                campaignId: '100',
                keywordText: 'career',
                matchType: 'BROAD',
                status: 'ENABLED'
            },
            {
                source: 'ad_group',
                campaignId: '100',
                adGroupId: '200',
                keywordText: 'jobs',
                matchType: 'BROAD',
                status: 'ENABLED'
            },
            {
                source: 'shared_list',
                sharedSetId: 's1',
                attachedCampaignIds: ['100'],
                attachmentCount: 1,
                activeAttachmentCount: 1,
                keywordText: 'salary',
                matchType: 'BROAD',
                status: 'ENABLED'
            }
        ];

        expect(decisionContextForTerm('whatsapp career', {}, rules, [], { allowAnyScope: true }).negativeCoverage.isNegativeCovered).toBe(false);
        expect(decisionContextForTerm('whatsapp jobs', {}, rules, [], { allowAnyScope: true }).negativeCoverage.isNegativeCovered).toBe(false);
        expect(decisionContextForTerm('whatsapp salary', {}, rules, [], { allowAnyScope: true }).negativeCoverage.isNegativeCovered).toBe(false);
        expect(decisionContextForTerm('whatsapp salary', { campaignId: '100' }, rules, []).negativeCoverage.isNegativeCovered).toBe(true);
    });

    test('ignores removed shared negative lists and removed campaign attachments', () => {
        const removedListRules = normalizeNegativeRulesFromReports({
            customerId: '123',
            sharedNegativeSets: [{ 'shared_set.id': '1', 'shared_set.resource_name': 'customers/123/sharedSets/1', 'shared_set.name': 'Removed shared', 'shared_set.status': 'REMOVED' }],
            sharedNegativeCriteria: [{ 'shared_criterion.shared_set': 'customers/123/sharedSets/1', 'shared_criterion.keyword.text': 'career', 'shared_criterion.keyword.match_type': 'BROAD' }],
            campaignSharedSets: [{ 'campaign.id': '100', 'campaign.name': 'Generic', 'campaign_shared_set.shared_set': 'customers/123/sharedSets/1', 'campaign_shared_set.status': 'ENABLED' }]
        });
        expect(decisionContextForTerm('whatsapp career', { campaignId: '100' }, removedListRules, []).negativeCoverage.isNegativeCovered).toBe(false);

        const removedAttachmentRules = normalizeNegativeRulesFromReports({
            customerId: '123',
            sharedNegativeSets: [{ 'shared_set.id': '2', 'shared_set.resource_name': 'customers/123/sharedSets/2', 'shared_set.name': 'Detached shared', 'shared_set.status': 'ENABLED' }],
            sharedNegativeCriteria: [{ 'shared_criterion.shared_set': 'customers/123/sharedSets/2', 'shared_criterion.keyword.text': 'jobs', 'shared_criterion.keyword.match_type': 'BROAD' }],
            campaignSharedSets: [{ 'campaign.id': '100', 'campaign.name': 'Generic', 'campaign_shared_set.shared_set': 'customers/123/sharedSets/2', 'campaign_shared_set.status': 'REMOVED' }]
        });
        expect(decisionContextForTerm('whatsapp jobs', { campaignId: '100' }, removedAttachmentRules, []).negativeCoverage.isNegativeCovered).toBe(false);
        expect(decisionContextForTerm('whatsapp jobs', {}, removedAttachmentRules, [], { allowAnyScope: true }).negativeCoverage.isNegativeCovered).toBe(false);
    });
});

describe('decisionContextForTerm configured keyword coverage', () => {
    test('uses configured keywords as account truth even without performance rows', () => {
        const context = decisionContextForTerm('Whatsapp CRM', { campaignId: '100', adGroupId: '200' }, [], configuredKeywords);
        expect(context.configuredKeywordCoverage.isConfiguredKeyword).toBe(true);
        expect(context.configuredKeywordCoverage.configuredKeywordStatus).toBe('ENABLED');
    });

    test('surfaces paused configured keywords distinctly', () => {
        const context = decisionContextForTerm('whatsapp pricing', { campaignId: '100', adGroupId: '201' }, [], configuredKeywords);
        expect(context.configuredKeywordCoverage.isConfiguredKeyword).toBe(true);
        expect(context.configuredKeywordCoverage.configuredKeywordStatus).toBe('PAUSED');
    });

    test('still uses configured keywords as account truth when planner rows lack scope', () => {
        const context = decisionContextForTerm('whatsapp crm', {}, [], configuredKeywords, { allowAnyScope: true });
        expect(context.configuredKeywordCoverage.isConfiguredKeyword).toBe(true);
        expect(context.configuredKeywordCoverage.configuredKeywordStatus).toBe('ENABLED');
    });
});

describe('normalizeNegativeRulesFromReports', () => {
    test('builds account, campaign, ad group, and shared negative rules', () => {
        const rules = normalizeNegativeRulesFromReports({
            customerId: '123',
            accountNegatives: [{
                'customer.id': '123',
                'customer_negative_criterion.id': '900',
                'customer_negative_criterion.type': 'NEGATIVE_KEYWORD_LIST',
                'customer_negative_criterion.negative_keyword_list.shared_set': 'customers/123/sharedSets/9'
            }],
            campaignNegatives: [{ 'campaign.id': '100', 'campaign.name': 'Generic', 'campaign_criterion.keyword.text': 'campaign junk', 'campaign_criterion.keyword.match_type': 'PHRASE' }],
            adGroupNegatives: [{ 'campaign.id': '100', 'ad_group.id': '200', 'ad_group.name': 'Core', 'ad_group_criterion.keyword.text': 'adgroup junk', 'ad_group_criterion.keyword.match_type': 'EXACT' }],
            sharedNegativeSets: [
                { 'shared_set.id': '9', 'shared_set.resource_name': 'customers/123/sharedSets/9', 'shared_set.name': 'Account junk', 'shared_set.status': 'ENABLED' },
                { 'shared_set.id': '1', 'shared_set.resource_name': 'customers/123/sharedSets/1', 'shared_set.name': 'Shared junk', 'shared_set.status': 'ENABLED' }
            ],
            sharedNegativeCriteria: [
                { 'shared_criterion.shared_set': 'customers/123/sharedSets/9', 'shared_criterion.keyword.text': 'account junk', 'shared_criterion.keyword.match_type': 'BROAD' },
                { 'shared_criterion.shared_set': 'customers/123/sharedSets/1', 'shared_criterion.keyword.text': 'shared junk', 'shared_criterion.keyword.match_type': 'BROAD' }
            ],
            campaignSharedSets: [{ 'campaign.id': '100', 'campaign.name': 'Generic', 'campaign_shared_set.shared_set': 'customers/123/sharedSets/1' }]
        });
        expect(rules.map(rule => rule.source).sort()).toEqual(['account', 'ad_group', 'campaign', 'shared_list']);
        expect(rules.find(rule => rule.source === 'shared_list').attachedCampaignIds).toEqual(['100']);
        expect(decisionContextForTerm('account junk query', {}, rules, []).negativeCoverage.isNegativeCovered).toBe(true);
        expect(decisionContextForTerm('shared junk query', {}, rules, [], { allowAnyScope: true }).negativeCoverage.isNegativeCovered).toBe(false);
        expect(decisionContextForTerm('shared junk query', { campaignId: '100' }, rules, []).negativeCoverage.isNegativeCovered).toBe(true);
    });
});

describe('buildDecisionContextSummary', () => {
    test('counts blocked/configured rows and missing data', () => {
        const summary = buildDecisionContextSummary({
            negativeRules: [{ source: 'account', keywordText: 'free', matchType: 'BROAD' }],
            configuredKeywords,
            searchTerms: [{ isNegativeCovered: true }, { isConfiguredKeyword: true }],
            plannerIdeas: [{ blockedByNegative: true }, { inAccountKeyword: true, configuredKeywordCoverage: { isConfiguredKeyword: true } }],
            candidateSignals: [{ type: 'DATA_COVERAGE_RISK', missing_data: ['leadAttribution'] }],
            sourceCoverage: { generatedAt: 'now', sources: [], missingSources: ['account_negatives'], staleSources: [], failedSources: [] }
        });
        expect(summary.negativeRules.bySource.account).toBe(1);
        expect(summary.configuredKeywords.byStatus.ENABLED).toBe(1);
        expect(summary.searchTerms.alreadyExcluded).toBe(1);
        expect(summary.keywordPlanner.blockedByNegatives).toBe(1);
        expect(summary.candidateSignals.withMissingData).toBe(1);
        expect(summary.sourceCoverage.missingSources).toEqual(['account_negatives']);
    });

    test('derives source coverage from deterministic source statuses', () => {
        const summary = buildDecisionContextSummary({
            negativeRules: [],
            configuredKeywords: [],
            decisionInputs: {
                sourceStatuses: [
                    { name: 'configured-keywords', status: 'stale', rows: 12, ageHours: 72 },
                    { name: 'account-negatives', status: 'missing', rows: 0 },
                    { name: 'quality-score', status: 'failed', rows: 0 }
                ]
            }
        });

        expect(summary.sourceCoverage.staleSources).toEqual(['configured-keywords']);
        expect(summary.sourceCoverage.missingSources).toEqual(['account-negatives']);
        expect(summary.sourceCoverage.failedSources).toEqual(['quality-score']);
    });
});
