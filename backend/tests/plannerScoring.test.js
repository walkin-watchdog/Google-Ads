import { describe, expect, test } from 'bun:test';
import { plannerFields } from '../lib/plannerScoring.ts';

describe('plannerFields', () => {
    test('computes the local planner score instead of trusting a raw plannerScore field', () => {
        const fields = plannerFields('whatsapp api pricing', {
            avgMonthlySearches: '1000',
            competition: 'LOW',
            competitionIndex: '12',
            lowBid: '20',
            highBid: '50',
            plannerScore: 0,
            source: 'idea'
        }, { spend: 500, clicks: 12, conversions: 1, cpa: 500 }, 2000);

        expect(fields.plannerScore).toBe(100);
        expect(fields.plannerSource).toBe('idea');
        expect(fields.avgMonthlySearches).toBe(1000);
        expect(fields.lowBid).toBe(20);
    });

    test('penalizes low-intent terms while preserving the same planner row shape', () => {
        const commercial = plannerFields('whatsapp api pricing', {
            avgMonthlySearches: 1000,
            competition: 'LOW',
            lowBid: 20,
            highBid: 50
        }, {}, 2000);

        const lowIntent = plannerFields('whatsapp job salary', {
            avgMonthlySearches: 1000,
            competition: 'LOW',
            lowBid: 20,
            highBid: 50
        }, {}, 2000);

        expect(commercial.plannerScore).toBeGreaterThan(lowIntent.plannerScore);
        expect(lowIntent.monthlySearchVolumes).toEqual([]);
    });

    test('returns explicit null enrichment when planner data is absent', () => {
        expect(plannerFields('missing idea', null, {}, 2000)).toEqual({
            avgMonthlySearches: null,
            competition: null,
            competitionIndex: null,
            lowBid: null,
            highBid: null,
            plannerScore: null,
            plannerSource: null,
            monthlySearchVolumes: []
        });
    });
});
