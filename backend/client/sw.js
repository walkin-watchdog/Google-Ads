const SHELL_CACHE = 'zenseeo-shell-v1';
const STATIC_CACHE = 'zenseeo-static-v1';
const SHELL_URLS = [
  '/',
  '/styles.css?v=1',
  '/offline.js?v=1',
  '/app.js?v=1',
  '/manifest.webmanifest',
  '/logo.png',
  '/vendor/chart.umd.min.js',
  '/vendor/chartjs-chart-sankey.min.js',
  '/vendor/ag-grid-community.min.js',
  '/vendor/jquery.min.js',
  '/vendor/moment.min.js',
  '/vendor/daterangepicker.js',
  '/vendor/daterangepicker.css',
  '/vendor/idb.umd.js',
  '/fonts/fonts.css',
  '/fonts/inter-latin-300-normal.woff2',
  '/fonts/inter-latin-400-normal.woff2',
  '/fonts/inter-latin-500-normal.woff2',
  '/fonts/inter-latin-600-normal.woff2',
  '/fonts/inter-latin-700-normal.woff2',
  '/fonts/outfit-latin-400-normal.woff2',
  '/fonts/outfit-latin-500-normal.woff2',
  '/fonts/outfit-latin-600-normal.woff2',
  '/fonts/outfit-latin-700-normal.woff2',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-192-maskable.png',
  '/icons/icon-512-maskable.png',
  '/icons/apple-touch-icon.png',
  '/icons/badge-72.png'
];

function isBypassed(url) {
  return url.pathname.startsWith('/api/')
    || url.pathname.startsWith('/auth/')
    || url.pathname === '/login'
    || url.pathname === '/forgot-password'
    || url.searchParams.has('token');
}

function isStatic(url) {
  return url.pathname.startsWith('/vendor/')
    || url.pathname.startsWith('/fonts/')
    || url.pathname.startsWith('/icons/')
    || ['/styles.css', '/offline.js', '/app.js', '/manifest.webmanifest', '/logo.png'].includes(url.pathname);
}

async function precacheShellAssets(cache, urls = SHELL_URLS, fetcher = fetch) {
  const result = { attempted: urls.length, cached: 0, failed: 0 };
  // A content blocker or a transient response must not prevent the worker from
  // installing: an inactive worker also disables Web Push after iOS has already
  // granted notification permission. Attempt every public shell asset and let
  // normal network-first requests fill any gaps later.
  await Promise.all(urls.map(async url => {
    try {
      const request = new Request(new URL(url, self.location.origin), { cache: 'reload' });
      const response = await fetcher(request);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await cache.put(request, response);
      result.cached += 1;
    } catch (error) {
      result.failed += 1;
      console.warn('Shell asset could not be precached', url, error?.message || error);
    }
  }));
  return result;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await precacheShellAssets(cache);
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key.startsWith('zenseeo-') && ![SHELL_CACHE, STATIC_CACHE].includes(key))
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isBypassed(url)) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (url.pathname === '/' && response.ok && String(response.headers.get('content-type') || '').includes('text/html')) {
          const cache = await caches.open(SHELL_CACHE);
          cache.put('/', response.clone()).catch(() => undefined);
        }
        return response;
      } catch {
        return (await caches.match('/')) || Response.error();
      }
    })());
    return;
  }
  if (isStatic(url)) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(STATIC_CACHE);
          cache.put(request, response.clone()).catch(() => undefined);
        }
        return response;
      } catch {
        return (await caches.match(request)) || Response.error();
      }
    })());
  }
});

function safeRelativeUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  try {
    const parsed = new URL(value, self.location.origin);
    if (parsed.origin !== self.location.origin) return '/';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}

function safePushPayload(event) {
  try {
    const parsed = event.data ? event.data.json() : {};
    const url = safeRelativeUrl(parsed.url);
    return {
      title: String(parsed.title || 'New lead received').slice(0, 80),
      body: String(parsed.body || 'Open Zenseeo to review the lead.').slice(0, 160),
      tag: String(parsed.tag || 'zenseeo-lead').slice(0, 120),
      url
    };
  } catch {
    return { title: 'New lead received', body: 'Open Zenseeo to review the lead.', tag: 'zenseeo-lead', url: '/' };
  }
}

self.addEventListener('push', event => {
  const payload = safePushPayload(event);
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    tag: payload.tag,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    data: { url: payload.url }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = new URL(safeRelativeUrl(event.notification.data?.url), self.location.origin).toString();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        try {
          await client.focus();
          if ('navigate' in client) await client.navigate(targetUrl);
          return;
        } catch {
          // Try another client or open a new window below.
        }
      }
    }
    await self.clients.openWindow(targetUrl);
  })());
});

if (typeof module !== 'undefined') {
  module.exports = { precacheShellAssets, safeRelativeUrl, safePushPayload };
}
