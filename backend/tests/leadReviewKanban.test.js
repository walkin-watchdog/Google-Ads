import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';

const clientRoot = path.join(import.meta.dir, '..', 'client');
const indexHtml = fs.readFileSync(path.join(clientRoot, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(clientRoot, 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(clientRoot, 'styles.css'), 'utf8');

describe('lead review Kanban view', () => {
    test('offers an accessible table and Kanban view switch beside the existing controls', () => {
        expect(indexHtml).toContain('role="group" aria-label="Lead review view"');
        expect(indexHtml).toContain('data-lead-review-view="table" aria-pressed="true"');
        expect(indexHtml).toContain('data-lead-review-view="kanban" aria-pressed="false"');
        expect(indexHtml).toContain('id="leadReviewTableView"');
        expect(indexHtml).toContain('id="leadReviewKanban"');
    });

    test('groups every supported lead state into desktop board columns', () => {
        expect(appJs).toContain("const LEAD_REVIEW_KANBAN_STATUS_ORDER = ['new', 'maybe', 'qualified', 'converted', 'qualified_lost', 'useless'];");
        expect(styles).toContain('grid-auto-columns: 310px;');
        expect(styles).toContain('.lead-kanban-column.is-drop-target');
        expect(styles).toContain('.lead-kanban-card[draggable="true"]');
    });

    test('shares search state and persists the selected view', () => {
        expect(appJs).toContain("const LEAD_REVIEW_VIEW_STORAGE_KEY = 'leadReviewViewMode';");
        expect(appJs).toContain('localStorage.setItem(LEAD_REVIEW_VIEW_STORAGE_KEY, normalizedMode);');
        expect(appJs).toContain("searchInput?.addEventListener('input', () => renderLeadReviewKanban());");
        expect(appJs).toContain('leadReviewRowsForView.filter(row => leadReviewSearchMatches(row, query))');
    });

    test('uses the existing optimistic-concurrency status mutation for card moves', () => {
        expect(appJs).toContain('void moveLeadReviewKanbanCard(sessionKey, targetStatus);');
        expect(appJs).toContain('await window.updateLeadStatus(sessionKey, status, row.updatedAt || null);');
        expect(appJs).toContain("const canDrop = status !== 'new';");
    });

    test('keeps Kanban controls and content off the mobile layout', () => {
        expect(styles).toContain('@media (max-width: 768px)');
        expect(styles).toContain('.lead-review-view-toggle,\n    .lead-review-kanban-view {\n        display: none !important;');
        expect(appJs).toContain("const isDesktop = window.matchMedia('(min-width: 769px)').matches;");
    });
});
