import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';

const backendRoot = path.join(import.meta.dir, '..');
const app = fs.readFileSync(path.join(backendRoot, 'client/app.js'), 'utf8');
const html = fs.readFileSync(path.join(backendRoot, 'client/index.html'), 'utf8');

function simpleFunctionSource(name) {
    const match = app.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    if (!match) throw new Error(`Could not find ${name}`);
    return match[0];
}

const classifyRemovedAdGroup = new Function(`
    ${simpleFunctionSource('normalizedKeywordPrimaryStatusReason')}
    ${simpleFunctionSource('isKeywordFromRemovedAdGroup')}
    return isKeywordFromRemovedAdGroup;
`)();

describe('configured keyword removed-ad-group visibility', () => {
    test('classifies only the Google Ads AD_GROUP_REMOVED primary reason', () => {
        expect(classifyRemovedAdGroup({ primaryStatusReasons: ['AD_GROUP_REMOVED'] })).toBe(true);
        expect(classifyRemovedAdGroup({ primaryStatusReasons: ['ad group removed'] })).toBe(true);
        expect(classifyRemovedAdGroup({ primaryStatusReasons: ['AD_GROUP_CRITERION_REMOVED'] })).toBe(false);
        expect(classifyRemovedAdGroup({ primaryStatusReasons: ['CAMPAIGN_REMOVED'] })).toBe(false);
        expect(classifyRemovedAdGroup({ primaryStatusReasons: null })).toBe(false);
    });

    test('hides removed-ad-group rows by default and exposes an explicit opt-in', () => {
        expect(html).toContain('id="showRemovedAdGroupKeywords"');
        expect(html).toContain('Show removed ad groups');
        expect(app).toContain('let showRemovedAdGroupKeywords = false;');
        expect(app).toContain('isExternalFilterPresent: () => !showRemovedAdGroupKeywords');
        expect(app).toContain('!isKeywordFromRemovedAdGroup(node?.data)');
        expect(app).toContain("gridInstances['grid-allKeywords']");
        expect(app).toContain('grid.onFilterChanged()');
    });
});
