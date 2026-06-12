import { afterEach, describe, expect, test } from 'bun:test';

const originalSelf = globalThis.self;

afterEach(() => {
    globalThis.self = originalSelf;
});

function loadServiceWorker() {
    const listeners = new Map();
    globalThis.self = {
        location: { origin: 'https://dashboard.example.com' },
        registration: { showNotification: async () => undefined },
        clients: {
            claim: async () => undefined,
            matchAll: async () => [],
            openWindow: async () => undefined
        },
        addEventListener(type, listener) {
            listeners.set(type, listener);
        },
        skipWaiting: async () => undefined
    };
    delete require.cache[require.resolve('../client/sw.js')];
    return { serviceWorker: require('../client/sw.js'), listeners };
}

describe('service worker runtime hardening', () => {
    test('one blocked shell asset does not reject installation or skip other assets', async () => {
        const { serviceWorker } = loadServiceWorker();
        const stored = [];
        const cache = {
            async put(request) {
                stored.push(new URL(request.url).pathname);
            }
        };
        const result = await serviceWorker.precacheShellAssets(cache, ['/app.js', '/blocked.js', '/styles.css'], async request => {
            if (new URL(request.url).pathname === '/blocked.js') throw new Error('blocked by content blocker');
            return new Response('ok', { status: 200 });
        });

        expect(result).toEqual({ attempted: 3, cached: 2, failed: 1 });
        expect(stored).toEqual(['/app.js', '/styles.css']);
    });

    test('notification links stay same-origin and relative', () => {
        const { serviceWorker } = loadServiceWorker();
        expect(serviceWorker.safeRelativeUrl('/?tab=attribution&lead=abc')).toBe('/?tab=attribution&lead=abc');
        expect(serviceWorker.safeRelativeUrl('https://evil.example/')).toBe('/');
        expect(serviceWorker.safeRelativeUrl('//evil.example/')).toBe('/');
    });
});
