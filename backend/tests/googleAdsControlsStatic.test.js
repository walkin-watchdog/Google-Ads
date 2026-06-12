import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';

const root = path.join(import.meta.dir, '..');

describe('Google Ads controls static coverage', () => {
    test('dashboard exposes distributed controls, activity history, preview modal, and offline auth UI', () => {
        const html = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
        const app = fs.readFileSync(path.join(root, 'client/app.js'), 'utf8');
        const css = fs.readFileSync(path.join(root, 'client/styles.css'), 'utf8');

        expect(html).not.toContain('data-tab="controls"');
        expect(html).not.toContain('id="tab-controls"');
        expect(html).toContain('id="keywordControlForm"');
        expect(html).toContain('id="negativeControlForm"');
        expect(html).toContain('id="openKeywordAddModalBtn"');
        expect(html).toContain('id="openNegativeAddModalBtn"');
        expect(html).toContain('id="keywordAddModalTemplate"');
        expect(html).toContain('id="negativeAddModalTemplate"');
        expect(html).toContain('Large sets are safely reviewed in batches of 100');
        expect(html).toContain('id="keywordBulkToolbar"');
        expect(html).toContain('id="negativeBulkToolbar"');
        expect(html).toContain('data-keyword-bulk-action="match"');
        expect(html).toContain('data-keyword-bulk-action="url"');
        expect(html).toContain('data-negative-bulk-action="match"');
        expect(html).toContain('<option value="shared_list">Negative keyword list</option>');
        expect(html).toContain('id="keywordFinalUrlInput"');
        expect(html).toContain('Campaigns');
        expect(html).toContain('Ad Groups');
        expect(html).toContain('data-tab="ad-schedule"');
        expect(html).toContain('data-tab="activity-history"');
        expect(html).toContain('data-attribution-subtab="auth"');
        expect(html).toContain('id="offlineAuthForm"');
        expect(html).toContain('id="revealOfflineAuthPasswordBtn"');
        expect(html).toContain('id="editOfflineAuthBtn" class="btn btn-secondary btn-sm" type="button">\n                                        Edit');
        expect(html).not.toContain('Edit Auth');
        expect(html).toContain('/api/analytics/offline-conversions.csv');
        expect(html).not.toContain('offlineEndpoint');
        expect(html).not.toContain('OFFLINE_CONVERSIONS_BASIC_PASSWORD" value');
        expect(html).toContain('class="card glass-card span-full controls-card');
        expect(html).toContain('id="grid-allKeywords"');
        expect(html).toContain('id="grid-negatives"');
        expect(html).not.toContain('id="grid-controlsKeywords"');
        expect(html).not.toContain('id="grid-controlsNegatives"');
        expect(html).toContain('id="grid-controlsSchedules"');
        expect(html).toContain('id="grid-controlsMutationHistory"');
        expect(html).toContain('class="control-form-shell');
        expect(html).toContain('class="control-field');
        expect(app).toContain('pendingLocalChange');
        expect(app).toContain('pendingScheduleConflict');
        expect(app).toContain('openControlsPreviewModalLocally');
        expect(app).toContain('openScheduleConflictModal');
        expect(app).toContain('resolveScheduleConflict');
        expect(app).toContain('applyPendingControlsChange');
        expect(app).toContain('previewNegativeRemove');
        expect(app).toContain('previewScheduleRemove');
        expect(app).toContain('loadOfflineConversionsAuthSettings');
        expect(app).toContain('toggleOfflineAuthPasswordReveal');
        expect(app).toContain('setOfflineAuthEditing(false)');
        expect(app).not.toContain('setOfflineAuthEditing(!auth.configured)');
        expect(app).not.toContain('formatTimestamp');
        expect(app).toContain('/api/offline-conversions/auth');
        expect(app).toContain('/api/offline-conversions/auth/password');
        expect(app).toContain('renderKeywordRowAction');
        expect(app).toContain('renderNegativeRowAction');
        expect(app).toContain('parseBulkKeywordEntries');
        expect(app).toContain('openKeywordAddModal');
        expect(app).toContain('closeKeywordAddModal');
        expect(app).toContain('keywordSelectionOptions');
        expect(app).toContain('openKeywordInlineEditor');
        expect(app).toContain('openKeywordStatusMenu');
        expect(app).toContain('handleKeywordBulkAction');
        expect(app).toContain('handleNegativeBulkAction');
        expect(app).toContain("action: 'set_final_url'");
        expect(app).toContain("action: 'set_status'");
        expect(app).toContain("action: 'replace'");
        expect(app).toContain('keepVisibleWhenEmpty: true');
        expect(app).toContain('openControlsPreviewLoadingModal');
        expect(app).toContain('pendingControlsPreview = aggregatePreview');
        expect(app).toContain('Nothing is applied until you confirm below.');
        expect(app).not.toContain("initGrid('grid-controlsKeywords'");
        expect(app).not.toContain("initGrid('grid-controlsNegatives'");
        expect(app).toContain("initGrid('grid-controlsSchedules'");
        expect(app).toContain("initGrid('grid-controlsMutationHistory'");
        expect(app).toContain("'activity-history': ''");
        expect(app).toContain("['campaigns', 'ad-groups', 'keywords', 'ad-schedule', 'activity-history'].includes(tabId)");
        expect(app).toContain('/api/account-controls/mutations/preview');
        expect(app).toContain('/api/account-controls/mutations/${preview.mutationId}/confirm');
        expect(css).toContain('.controls-card');
        expect(css).toContain('.control-form-shell');
        expect(css).toContain('.control-field');
        expect(css).toContain('.offline-auth-form');
        expect(css).toContain('.schedule-conflict-modal');
        expect(css).toContain('@media (max-width: 768px)');
        expect(css).toContain('.controls-card .table-responsive');
        expect(css).toContain('.keyword-bulk-toolbar');
        expect(css).toContain('.keyword-inline-popover');
        expect(css).toContain('.keyword-add-fab');
        expect(css).toContain('.keyword-add-modal__form');
        expect(css).toContain('.controls-preview-list');
        expect(css).toContain('.controls-batch-progress');
        expect(css).toContain('.controls-batch-failure');
    });

    test('large keyword changes are previewed and applied in controlled 100-change batches', () => {
        const app = fs.readFileSync(path.join(root, 'client/app.js'), 'utf8');

        expect(app).toContain('const GOOGLE_ADS_PREVIEW_BATCH_SIZE = 100');
        expect(app).toContain('function splitControlsChangesIntoBatches');
        expect(app).toContain('function dedupeControlsDestinationsBeforeBatching');
        expect(app).toContain("['keyword_changes', 'negative_keyword_changes'].includes(mutationType)");
        expect(app).toContain('changes.slice(index, index + GOOGLE_ADS_PREVIEW_BATCH_SIZE)');
        expect(app).toContain('for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1)');
        expect(app).toContain('for (let batchIndex = 0; batchIndex < previews.length; batchIndex += 1)');
        expect(app).toContain('Later batches wait until this one succeeds.');
        expect(app).toContain('later change${laterCount === 1 ? \' was\' : \'s were\'} not sent');
        expect(app).not.toContain('Review up to 100 keyword changes at a time.');
    });

    test('backend MCP tool list includes preview, confirm, history, and endpoint status tools', () => {
        const registry = fs.readFileSync(path.join(root, 'lib/mcp/toolRegistry.ts'), 'utf8');
        const server = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');
        const localMcp = fs.readFileSync(path.join(root, '..', 'MCP', 'mcp-server.js'), 'utf8');
        for (const toolName of [
            'google_ads_preview_keyword_changes',
            'google_ads_preview_audience_changes',
            'google_ads_preview_ad_schedule_changes',
            'google_ads_preview_entity_status_changes',
            'google_ads_confirm_mutation',
            'google_ads_get_mutation_history',
            'offline_conversions_endpoint_status'
        ]) {
            expect(registry).toContain(toolName);
        }
        expect(server).toContain('createMcpToolRegistry');
        expect(server).not.toContain("params.name === 'google_ads_preview_keyword_changes'");
        expect(registry).toContain('dateRangePreset');
        expect(localMcp).not.toContain("name: 'get_dashboard_data'");
        expect(localMcp).toContain('tools/list');
    });
});
