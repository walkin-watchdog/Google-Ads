import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSourceCoverage, sourceEntry, sourceStaleThresholdHours } from '../lib/sourceCoverage.ts';

const tempDirs = [];

function tempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-coverage-'));
    tempDirs.push(dir);
    return dir;
}

function writeJson(dir, fileName, data, mtimeMs = Date.now()) {
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(data));
    const time = new Date(mtimeMs);
    fs.utimesSync(filePath, time, time);
    return filePath;
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('source coverage helpers', () => {
    test('marks missing files without row or freshness data', () => {
        const entry = sourceEntry(tempDir(), 'account_negatives', 'account-negatives.json');

        expect(entry.status).toBe('missing');
        expect(entry.rows).toBeNull();
        expect(entry.ageHours).toBeNull();
    });

    test('marks fresh arrays as ok with row counts', () => {
        const nowMs = Date.now();
        const dir = tempDir();
        writeJson(dir, 'configured-keywords.json', [{ keyword: 'whatsapp crm' }], nowMs);

        const entry = sourceEntry(dir, 'configured_keywords', 'configured-keywords.json', { staleAfterHours: 48, nowMs });

        expect(entry.status).toBe('ok');
        expect(entry.rows).toBe(1);
        expect(entry.message).toBeNull();
    });

    test('marks valid but old source files as stale by age threshold', () => {
        const nowMs = Date.now();
        const dir = tempDir();
        writeJson(dir, 'account-negatives.json', [{ keyword: 'free' }], nowMs - (3 * 3_600_000));

        const entry = sourceEntry(dir, 'account_negatives', 'account-negatives.json', { staleAfterHours: 2, nowMs });

        expect(entry.status).toBe('stale');
        expect(entry.rows).toBe(1);
        expect(entry.ageHours).toBe(3);
        expect(entry.message).toContain('threshold is 2 hours');
    });

    test('marks malformed JSON as failed instead of stale or empty', () => {
        const nowMs = Date.now();
        const dir = tempDir();
        const filePath = path.join(dir, 'shared-negative-sets.json');
        fs.writeFileSync(filePath, '{broken');
        fs.utimesSync(filePath, new Date(nowMs), new Date(nowMs));

        const entry = sourceEntry(dir, 'shared_negative_sets', 'shared-negative-sets.json', { nowMs });

        expect(entry.status).toBe('failed');
        expect(entry.error).toBeTruthy();
        expect(entry.rows).toBeNull();
    });

    test('preserves explicit refresh failures from source-status sidecar', () => {
        const nowMs = Date.now();
        const dir = tempDir();
        writeJson(dir, 'account-negatives.json', [], nowMs);
        writeJson(dir, 'source-status.json', {
            account_negatives: { status: 'failed', error: 'GAQL_FIELD_ERROR', rows: 0 }
        }, nowMs);

        const entry = sourceEntry(dir, 'account_negatives', 'account-negatives.json', { nowMs });

        expect(entry.status).toBe('failed');
        expect(entry.rows).toBe(0);
        expect(entry.error).toBe('GAQL_FIELD_ERROR');
        expect(entry.message).toContain('GAQL_FIELD_ERROR');
    });

    test('marks missing files as failed when refresh sidecar recorded a failure', () => {
        const dir = tempDir();
        writeJson(dir, 'source-status.json', {
            'campaign-negatives': { status: 'failed', error: 'unsupported report' }
        });

        const entry = sourceEntry(dir, 'campaign_negatives', 'campaign-negatives.json');

        expect(entry.status).toBe('failed');
        expect(entry.error).toBe('unsupported report');
        expect(entry.rows).toBeNull();
    });

    test('builds missing, stale, and failed summaries from report descriptors', () => {
        const nowMs = Date.now();
        const dir = tempDir();
        writeJson(dir, 'fresh.json', [{}], nowMs);
        writeJson(dir, 'old.json', [{}], nowMs - (4 * 3_600_000));
        fs.writeFileSync(path.join(dir, 'bad.json'), '{broken');

        const summary = buildSourceCoverage(dir, [
            { name: 'fresh', fileName: 'fresh.json' },
            { name: 'old', fileName: 'old.json' },
            { name: 'bad', fileName: 'bad.json' },
            { name: 'missing', fileName: 'missing.json' }
        ], { staleAfterHours: 2, nowMs });

        expect(summary.sources.map(entry => entry.status)).toEqual(['ok', 'stale', 'failed', 'missing']);
        expect(summary.staleSources).toEqual(['old']);
        expect(summary.failedSources).toEqual(['bad']);
        expect(summary.missingSources).toEqual(['missing']);
    });

    test('defaults invalid stale thresholds to 48 hours', () => {
        expect(sourceStaleThresholdHours('not-a-number')).toBe(48);
        expect(sourceStaleThresholdHours(0)).toBe(1);
    });
});
