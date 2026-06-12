import * as fs from 'fs';
import * as path from 'path';
import type { SourceCoverageEntry, SourceCoverageSummary } from './decisionContext';

export interface SourceCoverageReport {
    name: string;
    fileName: string;
}

export interface SourceCoverageOptions {
    staleAfterHours?: number;
    nowMs?: number;
}

function sourceStatusKeys(reportName: string, fileName: string): string[] {
    const baseName = fileName.replace(/\.json$/i, '');
    return Array.from(new Set([
        reportName,
        reportName.replace(/_/g, '-'),
        reportName.replace(/-/g, '_'),
        baseName,
        baseName.replace(/_/g, '-'),
        baseName.replace(/-/g, '_')
    ].map(value => String(value || '').trim()).filter(Boolean)));
}

function readSourceStatusOverrides(sourceDir: string): Record<string, any> {
    for (const fileName of ['source-status.json', 'source-summary.json']) {
        const filePath = path.join(sourceDir, fileName);
        if (!fs.existsSync(filePath)) continue;
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            if (parsed && typeof parsed === 'object') return parsed;
        } catch {
            return {};
        }
    }
    return {};
}

function sourceStatusOverride(sourceDir: string, reportName: string, fileName: string): any | null {
    const overrides = readSourceStatusOverrides(sourceDir);
    for (const key of sourceStatusKeys(reportName, fileName)) {
        const value = overrides[key];
        if (value && typeof value === 'object') return value;
    }
    return null;
}

export function sourceStaleThresholdHours(value: any = process.env.DASHBOARD_SOURCE_STALE_HOURS): number {
    const n = Number(value ?? 48);
    return Number.isFinite(n) ? Math.max(1, n) : 48;
}

export function sourceEntry(
    sourceDir: string,
    reportName: string,
    fileName: string,
    options: SourceCoverageOptions = {}
): SourceCoverageEntry {
    const filePath = path.join(sourceDir, fileName);
    const override = sourceStatusOverride(sourceDir, reportName, fileName);
    if (!fs.existsSync(filePath)) {
        if (override?.status === 'failed') {
            return {
                name: reportName,
                fileName,
                status: 'failed',
                rows: override.rows ?? null,
                generatedAt: override.generatedAt || override.completedAt || null,
                ageHours: null,
                error: override.error || null,
                message: override.message || override.error || 'Source refresh failed.'
            };
        }
        return { name: reportName, fileName, status: 'missing', rows: null, generatedAt: null, ageHours: null };
    }

    const stat = fs.statSync(filePath);
    const nowMs = options.nowMs ?? Date.now();
    const ageHours = +((nowMs - stat.mtimeMs) / 3_600_000).toFixed(2);
    const staleAfterHours = sourceStaleThresholdHours(options.staleAfterHours);

    let parsed: any;
    try {
        parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (err: any) {
        return {
            name: reportName,
            fileName,
            status: 'failed',
            rows: null,
            generatedAt: stat.mtime.toISOString(),
            ageHours,
            error: err?.message || String(err)
        };
    }

    const rows = Array.isArray(parsed) ? parsed.length : parsed ? 1 : 0;
    let status: SourceCoverageEntry['status'] = ageHours > staleAfterHours
        ? 'stale'
        : rows > 0
            ? 'ok'
            : 'empty';

    if (override?.status === 'failed') status = 'failed';

    return {
        name: reportName,
        fileName,
        status,
        rows,
        generatedAt: stat.mtime.toISOString(),
        ageHours,
        error: override?.status === 'failed' ? override.error || null : null,
        message: override?.status === 'failed'
            ? override.message || override.error || 'Source refresh failed; preserved local file may be stale.'
            : status === 'stale'
                ? `Source file is ${ageHours} hours old; threshold is ${staleAfterHours} hours.`
                : null
    };
}

export function buildSourceCoverage(
    sourceDir: string,
    reports: SourceCoverageReport[],
    options: SourceCoverageOptions = {}
): SourceCoverageSummary {
    const sources = reports.map(report => sourceEntry(sourceDir, report.name, report.fileName, options));
    return {
        generatedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
        sources,
        missingSources: sources.filter(entry => entry.status === 'missing').map(entry => entry.name),
        staleSources: sources.filter(entry => entry.status === 'stale').map(entry => entry.name),
        failedSources: sources.filter(entry => entry.status === 'failed').map(entry => entry.name)
    };
}
