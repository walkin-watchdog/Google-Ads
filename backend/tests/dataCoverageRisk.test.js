import { describe, expect, test } from 'bun:test';
import {
    CRITICAL_DATA_COVERAGE_SOURCES,
    DECISION_SOURCE_STATUS_REPORTS,
    classifyDataCoverageGaps
} from '../lib/dataCoverageRisk.ts';

describe('classifyDataCoverageGaps', () => {
    test('deterministic source statuses include every critical coverage source', () => {
        expect(DECISION_SOURCE_STATUS_REPORTS).toEqual(expect.arrayContaining(CRITICAL_DATA_COVERAGE_SOURCES));
        expect(DECISION_SOURCE_STATUS_REPORTS).toContain('auction-insights-domains');
        expect(DECISION_SOURCE_STATUS_REPORTS).toContain('auction-insights-status');
        expect(new Set(DECISION_SOURCE_STATUS_REPORTS).size).toBe(DECISION_SOURCE_STATUS_REPORTS.length);
    });

    test('treats stale critical sources as DATA_COVERAGE_RISK pressure', () => {
        const gaps = classifyDataCoverageGaps([
            { name: 'configured-keywords', status: 'stale', rows: 10, ageHours: 72 },
            { name: 'campaign-negatives', status: 'ok', rows: 3 }
        ], true);

        expect(gaps.hasGap).toBe(true);
        expect(gaps.staleSources).toEqual(['configured-keywords']);
        expect(gaps.missingOrFailedSources).toEqual([]);
        expect(gaps.missingData).toEqual(['stale_source:configured-keywords']);
        expect(gaps.severity).toBe('medium');
    });

    test('keeps missing or failed sources separate from stale sources', () => {
        const gaps = classifyDataCoverageGaps([
            { name: 'account-negatives', status: 'missing', rows: 0 },
            { name: 'quality-score', status: 'failed', rows: 0 },
            { name: 'landing-page-performance', status: 'stale', rows: 4 }
        ], false);

        expect(gaps.missingOrFailedSources).toEqual(['account-negatives', 'quality-score']);
        expect(gaps.staleSources).toEqual(['landing-page-performance']);
        expect(gaps.missingData).toEqual([
            'account-negatives',
            'quality-score',
            'stale_source:landing-page-performance',
            'first_party_lead_quality'
        ]);
    });

    test('treats missing or stale Auction Insights as critical decision coverage', () => {
        const gaps = classifyDataCoverageGaps([
            { name: 'auction-insights-domains', status: 'missing', rows: 0 },
            { name: 'auction-insights-status', status: 'stale', rows: 1, ageHours: 96 }
        ], true);

        expect(gaps.hasGap).toBe(true);
        expect(gaps.missingOrFailedSources).toEqual(['auction-insights-domains']);
        expect(gaps.staleSources).toEqual(['auction-insights-status']);
        expect(gaps.missingData).toEqual([
            'auction-insights-domains',
            'stale_source:auction-insights-status'
        ]);
        expect(gaps.severity).toBe('low');
    });

    test('still flags empty decision sources without treating non-critical empty files as pressure', () => {
        const gaps = classifyDataCoverageGaps([
            { name: 'configured-keywords', status: 'empty', rows: 0 },
            { name: 'keyword-planner-historical-metrics', status: 'empty', rows: 0 }
        ], true);

        expect(gaps.hasGap).toBe(true);
        expect(gaps.emptyDecisionSources).toEqual(['configured-keywords']);
        expect(gaps.missingData).toEqual([]);
    });
});
