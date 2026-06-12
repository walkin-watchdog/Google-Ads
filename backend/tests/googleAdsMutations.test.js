import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import {
    buildGoogleAdsPartialFailureSummary,
    buildGoogleAdsMutationOperations,
    hashConfirmationToken,
    listRecentGoogleAdsMutations,
    normalizeKeywordText,
    prepareGoogleAdsMutationChanges,
    validateAdSchedule
} from '../lib/googleAdsMutations.ts';

describe('Google Ads mutation operation builders', () => {
    test('builds positive keyword add operations with Google v24 shapes', () => {
        const built = buildGoogleAdsMutationOperations({
            customerId: '1234567890',
            mutationType: 'keyword_changes',
            changes: [{
                action: 'add',
                campaignId: '111',
                adGroupId: '222',
                keywordText: 'whatsapp crm',
                matchType: 'EXACT'
            }]
        });

        expect(built.operationsByPath['adGroupCriteria:mutate'][0]).toEqual({
            create: {
                adGroup: 'customers/1234567890/adGroups/222',
                status: 'ENABLED',
                negative: false,
                keyword: { text: 'whatsapp crm', matchType: 'EXACT' }
            }
        });
        expect(built.diff[0]).toMatchObject({ action: 'add_keyword', adGroupId: '222' });
    });

    test('ignores duplicate input operations before building Google requests', () => {
        const built = buildGoogleAdsMutationOperations({
            customerId: '1234567890',
            mutationType: 'keyword_changes',
            changes: [
                { action: 'add', campaignId: '111', adGroupId: '222', keywordText: 'whatsapp crm', matchType: 'EXACT' },
                { action: 'add', campaignId: '111', adGroupId: '222', keywordText: 'whatsapp crm', matchType: 'EXACT' }
            ]
        });

        expect(built.operationsByPath['adGroupCriteria:mutate']).toHaveLength(1);
        expect(built.warnings.join(' ')).toContain('Duplicate change ignored');
    });

    test('validates and includes an optional keyword final URL in the previewed Google operation', () => {
        const built = buildGoogleAdsMutationOperations({
            customerId: '1234567890',
            mutationType: 'keyword_changes',
            changes: [{
                action: 'add', campaignId: '111', adGroupId: '222', keywordText: 'whatsapp crm',
                matchType: 'PHRASE', finalUrl: 'https://example.com/whatsapp?source=ads'
            }]
        });

        expect(built.operationsByPath['adGroupCriteria:mutate'][0].create.finalUrls).toEqual([
            'https://example.com/whatsapp?source=ads'
        ]);
        expect(built.diff[0].finalUrl).toBe('https://example.com/whatsapp?source=ads');
        expect(() => buildGoogleAdsMutationOperations({
            customerId: '1234567890', mutationType: 'keyword_changes',
            changes: [{ action: 'add', adGroupId: '222', keywordText: 'bad url', matchType: 'BROAD', finalUrl: 'javascript:alert(1)' }]
        })).toThrow(/http or https URL/);
    });

    test('builds campaign and ad-group negative keyword operations', () => {
        const campaign = buildGoogleAdsMutationOperations({
            customerId: '1234567890',
            mutationType: 'negative_keyword_changes',
            changes: [{ action: 'add', scope: 'campaign', campaignId: '111', keywordText: 'free', matchType: 'BROAD' }]
        });
        const adGroup = buildGoogleAdsMutationOperations({
            customerId: '1234567890',
            mutationType: 'negative_keyword_changes',
            changes: [{ action: 'add', scope: 'ad_group', campaignId: '111', adGroupId: '222', keywordText: 'jobs', matchType: 'PHRASE' }]
        });

        expect(campaign.operationsByPath['campaignCriteria:mutate'][0].create).toMatchObject({
            campaign: 'customers/1234567890/campaigns/111',
            negative: true,
            keyword: { text: 'free', matchType: 'BROAD' }
        });
        expect(adGroup.operationsByPath['adGroupCriteria:mutate'][0].create).toMatchObject({
            adGroup: 'customers/1234567890/adGroups/222',
            negative: true,
            keyword: { text: 'jobs', matchType: 'PHRASE' }
        });
    });

    test('builds pause and resume operations without remove support', () => {
        const built = buildGoogleAdsMutationOperations({
            customerId: '1234567890',
            mutationType: 'entity_status_changes',
            changes: [
                { entityType: 'campaign', campaignId: '111', targetStatus: 'PAUSED' },
                { entityType: 'ad_group', campaignId: '111', adGroupId: '222', targetStatus: 'ENABLED' }
            ]
        });

        expect(built.operationsByPath['campaigns:mutate'][0]).toEqual({
            update: { resourceName: 'customers/1234567890/campaigns/111', status: 'PAUSED' },
            updateMask: 'status'
        });
        expect(built.operationsByPath['adGroups:mutate'][0]).toEqual({
            update: { resourceName: 'customers/1234567890/adGroups/222', status: 'ENABLED' },
            updateMask: 'status'
        });
    });

    test('builds atomic keyword replacements that preserve status and final URL', () => {
        const built = buildGoogleAdsMutationOperations({
            customerId: '1234567890',
            mutationType: 'keyword_changes',
            changes: [{
                action: 'replace', campaignId: '111', adGroupId: '222', criterionId: '333',
                resourceName: 'customers/1234567890/adGroupCriteria/222~333',
                keywordText: 'old keyword', matchType: 'PHRASE',
                newKeywordText: 'new keyword', newMatchType: 'EXACT',
                currentStatus: 'PAUSED', currentFinalUrl: 'https://example.com/landing'
            }]
        });

        expect(built.operationsByPath['adGroupCriteria:mutate']).toEqual([
            {
                create: {
                    adGroup: 'customers/1234567890/adGroups/222',
                    status: 'PAUSED',
                    negative: false,
                    keyword: { text: 'new keyword', matchType: 'EXACT' },
                    finalUrls: ['https://example.com/landing']
                }
            },
            { remove: 'customers/1234567890/adGroupCriteria/222~333' }
        ]);
        expect(built.diff[0]).toMatchObject({
            action: 'replace_keyword', keywordText: 'old keyword', newKeywordText: 'new keyword',
            matchType: 'PHRASE', newMatchType: 'EXACT'
        });
    });

    test('builds direct keyword status and final URL updates', () => {
        const built = buildGoogleAdsMutationOperations({
            customerId: '1234567890',
            mutationType: 'keyword_changes',
            changes: [
                { action: 'set_status', adGroupId: '222', criterionId: '333', keywordText: 'crm', matchType: 'BROAD', targetStatus: 'PAUSED' },
                { action: 'set_final_url', adGroupId: '222', criterionId: '444', keywordText: 'sales', matchType: 'EXACT', finalUrl: 'https://example.com/sales' },
                { action: 'set_final_url', adGroupId: '222', criterionId: '555', keywordText: 'support', matchType: 'PHRASE', finalUrl: '' }
            ]
        });

        expect(built.operationsByPath['adGroupCriteria:mutate']).toEqual([
            {
                update: { resourceName: 'customers/1234567890/adGroupCriteria/222~333', status: 'PAUSED' },
                updateMask: 'status'
            },
            {
                update: { resourceName: 'customers/1234567890/adGroupCriteria/222~444', finalUrls: ['https://example.com/sales'] },
                updateMask: 'finalUrls'
            },
            {
                update: { resourceName: 'customers/1234567890/adGroupCriteria/222~555', finalUrls: [] },
                updateMask: 'finalUrls'
            }
        ]);
    });

    test('builds shared-list negative adds, removals, and atomic replacements', () => {
        const built = buildGoogleAdsMutationOperations({
            customerId: '1234567890',
            mutationType: 'negative_keyword_changes',
            changes: [
                { action: 'add', scope: 'shared_list', sharedSetId: '777', keywordText: 'free', matchType: 'BROAD' },
                { action: 'remove', scope: 'shared_list', sharedSetId: '777', criterionId: '888', keywordText: 'jobs', matchType: 'PHRASE' },
                {
                    action: 'replace', scope: 'shared_list', sharedSetId: '777', criterionId: '999',
                    keywordText: 'cheap', matchType: 'BROAD', newKeywordText: 'cheap trial', newMatchType: 'EXACT'
                }
            ]
        });

        expect(built.operationsByPath['sharedCriteria:mutate']).toEqual([
            {
                create: {
                    sharedSet: 'customers/1234567890/sharedSets/777',
                    negative: true,
                    keyword: { text: 'free', matchType: 'BROAD' }
                }
            },
            { remove: 'customers/1234567890/sharedCriteria/777~888' },
            {
                create: {
                    sharedSet: 'customers/1234567890/sharedSets/777',
                    negative: true,
                    keyword: { text: 'cheap trial', matchType: 'EXACT' }
                }
            },
            { remove: 'customers/1234567890/sharedCriteria/777~999' }
        ]);
        expect(built.diff.map(change => change.action)).toEqual([
            'add_negative_keyword', 'remove_negative_keyword', 'replace_negative_keyword'
        ]);
    });

    test('rejects criterion resource names from a different owner or account', () => {
        expect(() => buildGoogleAdsMutationOperations({
            customerId: '1234567890',
            mutationType: 'keyword_changes',
            changes: [{
                action: 'remove', adGroupId: '222', criterionId: '333', keywordText: 'crm', matchType: 'BROAD',
                resourceName: 'customers/1234567890/adGroupCriteria/999~333'
            }]
        })).toThrow(/does not match the selected account and owner/);
    });
});

describe('Google Ads mutation validation', () => {
    test('keeps each durable preview bounded to 100 changes for controlled client batching', () => {
        const changes = Array.from({ length: 101 }, (_, index) => ({
            action: 'add',
            campaignId: '111',
            adGroupId: '222',
            keywordText: `keyword ${index}`,
            matchType: 'BROAD'
        }));

        expect(() => buildGoogleAdsMutationOperations({
            customerId: '1234567890',
            mutationType: 'keyword_changes',
            changes
        })).toThrow(/at most 100 changes/);
    });

    test('rejects keywords over documented text limits', () => {
        expect(() => normalizeKeywordText('one two three four five six seven eight nine ten eleven')).toThrow(/10 words/);
        expect(() => normalizeKeywordText('x'.repeat(81))).toThrow(/80 characters/);
    });

    test('validates ad schedules and immutable replace remove/create behavior', () => {
        expect(validateAdSchedule({
            dayOfWeek: 'MONDAY',
            startHour: 9,
            startMinute: 'ZERO',
            endHour: 18,
            endMinute: 'ZERO'
        })).toMatchObject({ dayOfWeek: 'MONDAY', startHour: 9, endHour: 18 });

        const built = buildGoogleAdsMutationOperations({
            customerId: '1234567890',
            mutationType: 'ad_schedule_changes',
            changes: [{
                action: 'replace',
                campaignId: '111',
                criterionId: '333',
                dayOfWeek: 'TUESDAY',
                startHour: 10,
                startMinute: 'THIRTY',
                endHour: 19,
                endMinute: 'ZERO'
            }]
        });
        expect(built.operationsByPath['campaignCriteria:mutate'][0]).toEqual({
            remove: 'customers/1234567890/campaignCriteria/111~333'
        });
        expect(built.operationsByPath['campaignCriteria:mutate'][1].create.adSchedule).toMatchObject({
            dayOfWeek: 'TUESDAY',
            startMinute: 'THIRTY'
        });
        expect(built.diff[0]).toMatchObject({
            action: 'remove_ad_schedule',
            schedule: {
                dayOfWeek: 'TUESDAY',
                startHour: '10',
                startMinute: 'THIRTY',
                endHour: '19',
                endMinute: 'ZERO'
            }
        });
    });

    test('rejects more than six ad schedules per campaign day', () => {
        const changes = Array.from({ length: 7 }, (_, index) => ({
            action: 'add',
            campaignId: '111',
            dayOfWeek: 'FRIDAY',
            startHour: index,
            startMinute: 'ZERO',
            endHour: index + 1,
            endMinute: 'ZERO'
        }));
        expect(() => buildGoogleAdsMutationOperations({
            customerId: '1234567890',
            mutationType: 'ad_schedule_changes',
            changes
        })).toThrow(/maximum of six/);
    });

    test('hashes confirmation tokens without retaining plaintext', () => {
        const hash = hashConfirmationToken('confirm-me');
        expect(hash).not.toBe('confirm-me');
        expect(hash).toHaveLength(64);
        expect(hashConfirmationToken('confirm-me')).toBe(hash);
    });

    test('mutation history only lists successfully executed changes', async () => {
        const queries = [];
        const pool = {
            async query(sql, params) {
                queries.push({ sql, params });
                return { rows: [] };
            }
        };

        await listRecentGoogleAdsMutations(pool, { limit: 10 });
        expect(queries.some(query => query.sql.includes('DELETE FROM google_ads_mutation_requests'))).toBe(false);
        const expiry = queries.find(query => query.sql.includes('UPDATE google_ads_mutation_requests') && query.sql.includes("status = 'expired'"));
        expect(expiry.sql).toContain("status = 'previewed'");
        const select = queries.find(query => query.sql.includes('FROM google_ads_mutation_requests') && query.sql.includes('SELECT id'));
        expect(select.sql).toContain("status = 'executed'");
    });

    test('mutation previews are durable DB rows, not in-process map entries', () => {
        const source = fs.readFileSync(path.join(import.meta.dir, '..', 'lib', 'googleAdsMutations.ts'), 'utf8');
        expect(source).not.toContain('pendingMutationPreviews');
        expect(source).not.toContain('new Map<string, PendingMutationPreview>');
        expect(source).toContain("status, preview_payload, operations, confirmation_token_hash, expires_at");
        expect(source).toContain("VALUES ($1, $2, $3, $4, $5, 'previewed'");
        expect(source).toContain("SET status = 'confirmed'");
        expect(source).toContain('changes: prepared.changes');
        expect(source).toContain('Google Ads changed after this preview');
        expect(source).toContain('stableJson(rebuilt.operationsByPath) !== stableJson(operationsByPath)');
    });

    test('keyword duplicate checks preserve owner scope and use live fallbacks', () => {
        const source = fs.readFileSync(path.join(import.meta.dir, '..', 'lib', 'googleAdsMutations.ts'), 'utf8');
        expect(source).toContain('findCurrentConfiguredKeywordRows');
        expect(source).toContain('findCurrentNegativeKeywordRows');
        expect(source).toContain("return snapshotRows.length ? snapshotRows : await resolveKeywordViaGaql");
        expect(source).toContain('AND ad_group_id = $2');
        expect(source).toContain('AND campaign_id = $2');
        expect(source).toContain('AND match_type = $4');
        expect(source).toContain('if (duplicateRows.length)');
        expect(source).toContain('oppositeConflicts: []');
        expect(source).toContain('oppositeConflicts: uniqueKeywordConflicts');
    });

    test('campaign and ad-group negative duplicate checks query only the selected level', async () => {
        const checkedTables = [];
        const pool = {
            async query(sql, params) {
                if (sql.includes('FROM google_ads_campaign_negatives') || sql.includes('FROM google_ads_ad_group_negatives')) {
                    checkedTables.push({ sql, params });
                    return { rows: [{ status: 'ENABLED' }] };
                }
                return { rows: [] };
            }
        };

        await expect(prepareGoogleAdsMutationChanges(pool, {
            customerId: '1234567890',
            mutationType: 'negative_keyword_changes',
            token: 'unused',
            changes: [{ action: 'add', scope: 'campaign', campaignId: '111', keywordText: 'free', matchType: 'PHRASE' }]
        })).rejects.toThrow(/already exists at the selected scope/);
        expect(checkedTables).toHaveLength(1);
        expect(checkedTables[0].sql).toContain('FROM google_ads_campaign_negatives');
        expect(checkedTables[0].params).toEqual(['1234567890', '111', 'free', 'PHRASE']);

        checkedTables.length = 0;
        await expect(prepareGoogleAdsMutationChanges(pool, {
            customerId: '1234567890',
            mutationType: 'negative_keyword_changes',
            token: 'unused',
            changes: [{ action: 'add', scope: 'ad_group', campaignId: '111', adGroupId: '222', keywordText: 'free', matchType: 'EXACT' }]
        })).rejects.toThrow(/already exists at the selected scope/);
        expect(checkedTables).toHaveLength(1);
        expect(checkedTables[0].sql).toContain('FROM google_ads_ad_group_negatives');
        expect(checkedTables[0].params).toEqual(['1234567890', '222', 'free', 'EXACT']);
    });

    test('prepares preview changes by skipping existing adds and resolving text-only removals from snapshots', async () => {
        const pool = {
            async query(sql, params) {
                if (sql.includes('FROM google_ads_configured_keywords') && params[1] === '222' && params[2] === 'existing keyword') {
                    return { rows: [{ criterion_id: '333', criterion_resource_name: 'customers/1234567890/adGroupCriteria/222~333', status: 'ENABLED' }] };
                }
                if (sql.includes('FROM google_ads_configured_keywords') && params[1] === '222' && params[2] === 'remove me') {
                    return { rows: [{ criterion_id: '444', criterion_resource_name: 'customers/1234567890/adGroupCriteria/222~444', status: 'ENABLED' }] };
                }
                return { rows: [] };
            }
        };

        const prepared = await prepareGoogleAdsMutationChanges(pool, {
            customerId: '1234567890',
            mutationType: 'keyword_changes',
            token: 'unused',
            changes: [
                { action: 'add', campaignId: '111', adGroupId: '222', keywordText: 'existing keyword', matchType: 'EXACT' },
                { action: 'remove', campaignId: '111', adGroupId: '222', keywordText: 'remove me', matchType: 'PHRASE' }
            ]
        });

        expect(prepared.changes).toHaveLength(1);
        expect(prepared.changes[0].resourceName).toBe('customers/1234567890/adGroupCriteria/222~444');
        expect(prepared.warnings.join(' ')).toContain('already exists');
    });

    test('reuses one owner snapshot when reviewing a bulk keyword selection', async () => {
        let configuredKeywordQueries = 0;
        const rows = Array.from({ length: 6 }, (_, index) => ({
            criterion_id: String(300 + index),
            criterion_resource_name: `customers/1234567890/adGroupCriteria/222~${300 + index}`,
            keyword_text: `existing keyword ${index + 1}`,
            match_type: 'EXACT',
            status: 'ENABLED'
        }));
        const pool = {
            async query(sql) {
                if (sql.includes('FROM google_ads_configured_keywords')) {
                    configuredKeywordQueries += 1;
                    return { rows };
                }
                return { rows: [] };
            }
        };

        await expect(prepareGoogleAdsMutationChanges(pool, {
            customerId: '1234567890',
            mutationType: 'keyword_changes',
            token: 'unused',
            changes: rows.map((row, index) => ({
                action: 'add', campaignId: '111', adGroupId: '222',
                keywordText: `existing keyword ${index + 1}`, matchType: 'EXACT'
            }))
        })).rejects.toThrow(/already exists in the selected ad group/);

        expect(configuredKeywordQueries).toBe(1);
    });

    test('summarizes partial execution failures in human language', () => {
        const summary = buildGoogleAdsPartialFailureSummary({
            previewPayload: {
                mutationType: 'negative_keyword_changes',
                diff: [
                    { action: 'add_negative_keyword', scope: 'campaign', ownerId: '111', keywordText: 'free', matchType: 'BROAD' },
                    { action: 'add_negative_keyword', scope: 'ad_group', ownerId: '222', keywordText: 'jobs', matchType: 'PHRASE' }
                ]
            },
            operationPaths: ['campaignCriteria:mutate', 'adGroupCriteria:mutate'],
            successfulPaths: ['campaignCriteria:mutate'],
            failedPath: 'adGroupCriteria:mutate',
            errors: [{ code: 'criterionError.KEYWORD_HAS_INVALID_CHARS', message: 'Keyword text is invalid.', fieldPath: null, trigger: null, operationIndex: null }]
        });

        expect(summary.message).toContain('Some Google Ads changes were applied');
        expect(summary.message).toContain('Applied: add campaign negative keyword "free" to campaign 111');
        expect(summary.message).toContain('Failed: add ad group negative keyword "jobs" to ad group 222');
        expect(summary.message).toContain('Google Ads said: Keyword text is invalid.');
    });
});
