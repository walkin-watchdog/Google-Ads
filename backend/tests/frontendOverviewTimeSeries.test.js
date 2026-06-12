import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';

const appSource = fs.readFileSync(path.join(import.meta.dir, '..', 'client', 'app.js'), 'utf8');
const helperSource = appSource.slice(
    appSource.indexOf('function buildOverviewTimeSeriesRows'),
    appSource.indexOf('\nconst overviewTimeSeriesHoverLine')
);
const createHarness = new Function(`
    ${helperSource}
    return { buildOverviewTimeSeriesRows, formatOverviewHour, formatOverviewHourRange };
`);
const { buildOverviewTimeSeriesRows, formatOverviewHour, formatOverviewHourRange } = createHarness();

describe('overview time-series bucketing', () => {
    test('uses 24 hourly buckets for a selected single day and recomputes rate metrics', () => {
        const result = buildOverviewTimeSeriesRows({
            meta: { dateRange: { start: '2026-07-28', end: '2026-07-28' } },
            dailyTrend: [{ date: '2026-07-28', clicks: 7 }],
            dayAndHourPerformance: [
                {
                    day: 'TUESDAY',
                    hour: 9,
                    spend: 120,
                    clicks: 3,
                    impressions: 100,
                    conversions: 1
                },
                {
                    day: 'TUESDAY',
                    hour: 9,
                    spend: 80,
                    clicks: 1,
                    impressions: 60,
                    conversions: 0
                },
                {
                    day: 'TUESDAY',
                    hour: 10,
                    spend: 60,
                    clicks: 2,
                    impressions: 40,
                    conversions: 1
                }
            ]
        });

        expect(result.isHourly).toBe(true);
        expect(result.rows).toHaveLength(24);
        expect(result.rows[0]).toMatchObject({ hour: 0, clicks: 0, impressions: 0, ctr: 0 });
        expect(result.rows[9]).toMatchObject({
            hour: 9,
            spend: 200,
            clicks: 4,
            impressions: 160,
            conversions: 1,
            ctr: 2.5,
            avgCpc: 50,
            cpa: 200,
            cvr: 25
        });
        expect(result.rows[10]).toMatchObject({
            hour: 10,
            spend: 60,
            clicks: 2,
            impressions: 40,
            conversions: 1,
            ctr: 5,
            avgCpc: 30,
            cpa: 60,
            cvr: 50
        });
    });

    test('keeps daily buckets for multi-day ranges', () => {
        const dailyTrend = [
            { date: '2026-07-27', clicks: 5 },
            { date: '2026-07-28', clicks: 7 }
        ];
        const result = buildOverviewTimeSeriesRows({
            meta: { dateRange: { start: '2026-07-27', end: '2026-07-28' } },
            dailyTrend,
            dayAndHourPerformance: [{ day: 'TUESDAY', hour: 9, clicks: 3 }]
        });

        expect(result).toEqual({ rows: dailyTrend, isHourly: false });
    });

    test('falls back to the daily point when hourly data is unavailable', () => {
        const dailyTrend = [{ date: '2026-07-28', clicks: 7 }];
        const result = buildOverviewTimeSeriesRows({
            meta: { dateRange: { start: '2026-07-28', end: '2026-07-28' } },
            dailyTrend,
            dayAndHourPerformance: []
        });

        expect(result).toEqual({ rows: dailyTrend, isHourly: false });
    });

    test('keeps the accurate daily point when a selected metric is absent from the hourly feed', () => {
        const dailyTrend = [{ date: '2026-07-28', conversionsValue: 500 }];
        const result = buildOverviewTimeSeriesRows({
            meta: { dateRange: { start: '2026-07-28', end: '2026-07-28' } },
            dailyTrend,
            dayAndHourPerformance: [{ day: 'TUESDAY', hour: 9, clicks: 3 }]
        }, ['clicks', 'conversionsValue']);

        expect(result).toEqual({ rows: dailyTrend, isHourly: false });
    });

    test('formats hour labels without date or timezone conversion', () => {
        expect([0, 1, 11, 12, 13, 23].map(formatOverviewHour))
            .toEqual(['12 AM', '1 AM', '11 AM', '12 PM', '1 PM', '11 PM']);
    });

    test('formats hourly tooltip titles as the full reporting interval', () => {
        expect([0, 7, 8, 11, 12, 23].map(formatOverviewHourRange)).toEqual([
            '12 AM – 1 AM',
            '7 AM – 8 AM',
            '8 AM – 9 AM',
            '11 AM – 12 PM',
            '12 PM – 1 PM',
            '11 PM – 12 AM'
        ]);
    });
});
