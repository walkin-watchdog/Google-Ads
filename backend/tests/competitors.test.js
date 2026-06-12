import { describe, expect, test } from 'bun:test';
import { COMPETITOR_ROOTS } from '../lib/competitors.ts';

describe('COMPETITOR_ROOTS', () => {
    test('includes roots used by backend deterministic and dashboard competitor calculations', () => {
        expect(COMPETITOR_ROOTS).toEqual([
            'aisensy',
            'wati',
            'interakt',
            'doubletick',
            'gallabox',
            'sendwo',
            'whatsbox',
            'alvo chat',
            'rocketsend'
        ]);
    });
});
