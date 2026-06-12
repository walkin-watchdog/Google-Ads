import { describe, expect, test } from 'bun:test';
import {
    resolveTriggerRefreshRequest,
    resolveTriggerRefreshWindow,
    shouldRunCronCooldownLightRefresh,
    utcDateKey
} from '../lib/triggerRefresh.ts';

describe('light client refresh today window', () => {
    const now = new Date('2026-07-16T12:34:56.000Z');

    test('derives today when an App/browser reload has no explicit window', () => {
        expect(resolveTriggerRefreshWindow(undefined, now)).toEqual({
            startDate: '2026-07-16',
            endDate: '2026-07-16',
            defaultedToToday: true
        });
        expect(resolveTriggerRefreshWindow({ force: true }, now)).toEqual({
            startDate: '2026-07-16',
            endDate: '2026-07-16',
            defaultedToToday: true
        });
    });

    test('preserves explicit repair and historical windows', () => {
        expect(resolveTriggerRefreshWindow({
            startDate: '2026-06-01',
            endDate: '2026-06-30'
        }, now)).toEqual({
            startDate: '2026-06-01',
            endDate: '2026-06-30',
            defaultedToToday: false
        });
        expect(resolveTriggerRefreshWindow({ endDate: '2026-06-30' }, now)).toEqual({
            startDate: undefined,
            endDate: '2026-06-30',
            defaultedToToday: false
        });
    });

    test('rejects an invalid clock value', () => {
        expect(() => utcDateKey(new Date('invalid'))).toThrow('Unable to determine today');
    });

    test('routes Data, reload, and cron requests to distinct refresh profiles', () => {
        expect(resolveTriggerRefreshRequest({ force: true }, { force: true, now })).toEqual({
            startDate: undefined,
            endDate: undefined,
            lightClientRefresh: false,
            scheduledCronRefresh: false
        });
        expect(resolveTriggerRefreshRequest({
            force: true,
            refreshProfile: 'light_today'
        }, { force: true, now })).toEqual({
            startDate: '2026-07-16',
            endDate: '2026-07-16',
            lightClientRefresh: true,
            scheduledCronRefresh: false
        });
        expect(resolveTriggerRefreshRequest({}, { force: false, now })).toEqual({
            startDate: undefined,
            endDate: undefined,
            lightClientRefresh: false,
            scheduledCronRefresh: true
        });
    });

    test('never applies the light profile to an explicit historical window', () => {
        expect(resolveTriggerRefreshRequest({
            startDate: '2026-06-01',
            endDate: '2026-06-30',
            refreshProfile: 'light_today'
        }, { force: true, now })).toEqual({
            startDate: '2026-06-01',
            endDate: '2026-06-30',
            lightClientRefresh: false,
            scheduledCronRefresh: false
        });
    });

    test('accepts the browser local calendar day as an explicit light window', () => {
        expect(resolveTriggerRefreshRequest({
            startDate: '2026-07-17',
            endDate: '2026-07-17',
            refreshProfile: 'light_today'
        }, { force: true, now })).toEqual({
            startDate: '2026-07-17',
            endDate: '2026-07-17',
            lightClientRefresh: true,
            scheduledCronRefresh: false
        });
    });

    test('falls back to light only when a scheduled cron full refresh hits cooldown', () => {
        const cronRequest = resolveTriggerRefreshRequest({}, { force: false, now });
        expect(shouldRunCronCooldownLightRefresh(cronRequest, {
            status: 'skipped',
            skipped: true,
            cooldownRemainingMs: 60_000
        })).toBe(true);
        expect(shouldRunCronCooldownLightRefresh(cronRequest, {
            status: 'in_progress'
        })).toBe(false);
        expect(shouldRunCronCooldownLightRefresh(
            resolveTriggerRefreshRequest({ force: true }, { force: true, now }),
            { status: 'skipped', skipped: true, cooldownRemainingMs: 60_000 }
        )).toBe(false);
    });
});
