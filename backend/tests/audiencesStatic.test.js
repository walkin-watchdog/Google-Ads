import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';

const backendRoot = path.join(import.meta.dir, '..');
const repositoryRoot = path.join(backendRoot, '..');

describe('Audiences dashboard static contract', () => {
    test('loads without the removed audience context renderer or strip', () => {
        const html = fs.readFileSync(path.join(backendRoot, 'client/index.html'), 'utf8');
        const app = fs.readFileSync(path.join(backendRoot, 'client/app.js'), 'utf8');
        const css = fs.readFileSync(path.join(backendRoot, 'client/styles.css'), 'utf8');

        expect(html).not.toContain('audienceContextStrip');
        expect(html).not.toContain('audience-context-strip');
        expect(app).not.toContain('renderAudienceContext');
        expect(css).not.toContain('.audience-context-strip');
        expect(css).not.toContain('.audience-context-chip');
    });

    test('ships versioned client assets so a removed audience renderer cannot survive in cache', () => {
        const html = fs.readFileSync(path.join(backendRoot, 'client/index.html'), 'utf8');
        const worker = fs.readFileSync(path.join(backendRoot, 'client/sw.js'), 'utf8');
        const app = fs.readFileSync(path.join(backendRoot, 'client/app.js'), 'utf8');

        expect(html).toContain('styles.css?v=1');
        expect(html).toContain('offline.js?v=1');
        expect(html).toContain('app.js?v=1');
        expect(worker).toContain("const SHELL_CACHE = 'zenseeo-shell-v1';");
        expect(worker).toContain("'/app.js?v=1'");
        expect(app).not.toContain('Dashboard section load failed:');
        expect(app).toContain('handleDashboardSectionLoadError(activeDashboardTab(), err);');
    });

    test('represents the implicit Google Ads audience mode as Targeting', () => {
        const app = fs.readFileSync(path.join(backendRoot, 'client/app.js'), 'utf8');

        expect(app).toContain("return { mode: 'TARGETING', inherited: false, implicit: true };");
        expect(app).not.toContain("return { mode: 'OBSERVATION', inherited: false, implicit: true };");
        expect(app).toContain('Observation (recommended)');
    });

    test('supports audience reloads, deduplicates repeated toasts, and includes required utilities', () => {
        const app = fs.readFileSync(path.join(backendRoot, 'client/app.js'), 'utf8');
        const offline = fs.readFileSync(path.join(backendRoot, 'client/offline.js'), 'utf8');
        const css = fs.readFileSync(path.join(backendRoot, 'client/styles.css'), 'utf8');

        expect(offline).toContain("'audiences'");
        expect(app).toContain('message === lastToastMessage');
        expect(app).toContain('clearTimeout(toastHideTimer)');
        expect(css).toContain('.btn-danger {');
        expect(css).toContain('.sr-only {');
    });

    test('renders exclusions from one filtered collection in a selectable grid and responds to resizing', () => {
        const html = fs.readFileSync(path.join(backendRoot, 'client/index.html'), 'utf8');
        const app = fs.readFileSync(path.join(backendRoot, 'client/app.js'), 'utf8');
        const css = fs.readFileSync(path.join(backendRoot, 'client/styles.css'), 'utf8');

        expect(html).toContain('id="audienceExclusionsCard"');
        expect(html).toContain('id="grid-audienceExclusions"');
        expect(html).toContain('id="audienceExclusionScope"');
        expect(html).toContain('id="audienceExclusionSelection"');
        expect(app).toContain('const exclusions = visibleAudienceExclusions();');
        expect(app).toContain('const exclusionRowData = exclusions.map(row => ({');
        expect(app).toContain("initGrid('grid-audienceExclusions', exclusionRowData, exclusionColDefs, {");
        expect(app).toContain("rowSelection: 'multiple'");
        expect(app).toContain('audienceResizeObserver = new ResizeObserver');
        expect(app).toContain("window.addEventListener('resize', scheduleAudienceVisualResize");
        expect(css).toContain('.audience-demographic-tabs');
        expect(css).toContain('@media (max-width: 640px)');
    });

    test('keeps detailed-demographic fields while using only valid campaign criterion type enums', () => {
        const backendReports = fs.readFileSync(path.join(backendRoot, 'config/reports.yml'), 'utf8');
        const skillReports = fs.readFileSync(path.join(repositoryRoot, 'google-ads-skill/references/reports.yml'), 'utf8');
        const validTypeFilter = 'campaign_criterion.type IN (AUDIENCE, USER_INTEREST, USER_LIST, CUSTOM_AUDIENCE, COMBINED_AUDIENCE, LIFE_EVENT, AGE_RANGE, GENDER, INCOME_RANGE, PARENTAL_STATUS)';
        const invalidTypeFilter = 'campaign_criterion.type IN (AUDIENCE, USER_INTEREST, USER_LIST, CUSTOM_AUDIENCE, COMBINED_AUDIENCE, LIFE_EVENT, EXTENDED_DEMOGRAPHIC';

        expect(backendReports).toContain('campaign_criterion.extended_demographic.extended_demographic_id');
        expect(backendReports).toContain(validTypeFilter);
        expect(backendReports).not.toContain(invalidTypeFilter);
        expect(skillReports).toBe(backendReports);
    });
});
