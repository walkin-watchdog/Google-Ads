(function () {
  const DB_NAME = 'zenseeo-dashboard-v1';
  const DB_VERSION = 1;
  const OFFLINE_DAYS = 7;
  const MAX_RESPONSES_PER_USER = 30;
  const NETWORK_TIMEOUT_MS = 12_000;
  const OFFLINE_BLOCK_COOKIE = 'dashboard_offline_block';
  const LOGOUT_PENDING_COOKIE = 'zenseeo_logout_pending';
  const ALLOWED_DASHBOARD_VIEWS = new Set(['overview', 'performance', 'keywords', 'audiences', 'attribution', 'rank', 'proposals']);
  const ALLOWED_STATUSES = new Set(['maybe', 'qualified', 'converted', 'qualified_lost', 'useless']);
  const SERVER_STATUSES = new Set(['new', ...ALLOWED_STATUSES]);

  let dbPromise = null;
  let activeSession = null;
  let csrfToken = null;
  let privateContextGeneration = 0;
  let dashboardWarmGeneration = 0;

  function now() {
    return new Date().toISOString();
  }

  function openDb() {
    if (!dbPromise) {
      dbPromise = idb.openDB(DB_NAME, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains('offlineSessions')) db.createObjectStore('offlineSessions', { keyPath: 'key' });
          if (!db.objectStoreNames.contains('dashboardResponses')) {
            const store = db.createObjectStore('dashboardResponses', { keyPath: 'key' });
            store.createIndex('byUser', 'userId');
          }
          if (!db.objectStoreNames.contains('leadLabelQueue')) {
            const store = db.createObjectStore('leadLabelQueue', { keyPath: 'key' });
            store.createIndex('byUser', 'userId');
            store.createIndex('byCreated', 'createdAt');
          }
          if (!db.objectStoreNames.contains('conflicts')) {
            const store = db.createObjectStore('conflicts', { keyPath: 'key' });
            store.createIndex('byUser', 'userId');
          }
        }
      });
    }
    return dbPromise;
  }

  function setCsrfToken(token) {
    csrfToken = token || null;
  }

  function cookieValue(name) {
    const prefix = `${name}=`;
    for (const part of String(document.cookie || '').split(';')) {
      const value = part.trim();
      if (!value.startsWith(prefix)) continue;
      try {
        return decodeURIComponent(value.slice(prefix.length));
      } catch {
        return null;
      }
    }
    return null;
  }

  function csrfHeaders(headers) {
    const next = new Headers(headers || {});
    const token = csrfToken || cookieValue('dashboard_csrf');
    if (token && !next.has('X-CSRF-Token')) next.set('X-CSRF-Token', token);
    return next;
  }

  function privateOfflineAccessBlocked() {
    return cookieValue(OFFLINE_BLOCK_COOKIE) === '1';
  }

  function setClientCookie(name, value, maxAgeSeconds) {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
  }

  function blockPrivateOfflineAccess() {
    setClientCookie(OFFLINE_BLOCK_COOKIE, '1', 30 * 24 * 60 * 60);
  }

  function pendingLogoutBlocked() {
    return cookieValue(LOGOUT_PENDING_COOKIE) === '1';
  }

  function setPendingLogoutCookie() {
    setClientCookie(LOGOUT_PENDING_COOKIE, '1', OFFLINE_DAYS * 24 * 60 * 60);
  }

  function clearPendingLogoutCookie() {
    setClientCookie(LOGOUT_PENDING_COOKIE, '', 0);
  }

  async function withNetworkTimeout(fetcher) {
    let timeout;
    const controller = new AbortController();
    try {
      return await Promise.race([
        fetcher(controller.signal),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new TypeError('Network request timed out.'));
          }, NETWORK_TIMEOUT_MS);
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  function sessionKey(userId) {
    return `user:${userId}`;
  }

  function replacePrivateContext(session) {
    privateContextGeneration += 1;
    activeSession = session;
    return privateContextGeneration;
  }

  function contextIsCurrent(userId, generation) {
    return activeSession?.userId === userId && privateContextGeneration === generation;
  }

  function responseKey(userId, url) {
    return `${userId}:${canonicalUrl(url)}`;
  }

  function queueKey(userId, sessionKeyValue) {
    return `${userId}:${sessionKeyValue}`;
  }

  function canonicalUrl(url) {
    const parsed = new URL(url, window.location.origin);
    parsed.hash = '';
    parsed.searchParams.sort();
    return `${parsed.pathname}${parsed.search}`;
  }

  function isAllowedDashboardGet(url) {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin !== window.location.origin) return false;
    if (parsed.pathname === '/api/dashboard/filters') return true;
    if (parsed.pathname !== '/api/dashboard') return false;
    const view = parsed.searchParams.get('view') || 'overview';
    return ALLOWED_DASHBOARD_VIEWS.has(view);
  }

  async function enforceResponseLimit(userId) {
    const db = await openDb();
    const all = await db.getAllFromIndex('dashboardResponses', 'byUser', userId);
    if (all.length <= MAX_RESPONSES_PER_USER) return;
    all.sort((a, b) => String(a.lastUsedAt || a.cachedAt).localeCompare(String(b.lastUsedAt || b.cachedAt)));
    for (const row of all.slice(0, all.length - MAX_RESPONSES_PER_USER)) {
      await db.delete('dashboardResponses', row.key);
    }
  }

  async function refreshSession(auth) {
    if (!auth || auth.mode !== 'user' || !auth.user?.id) {
      await detachPrivateContext();
      return null;
    }
    await cleanupExpiredOfflineData();
    const db = await openDb();
    const expiresAt = new Date(Date.now() + OFFLINE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const session = {
      key: sessionKey(auth.user.id),
      userId: auth.user.id,
      email: auth.user.email || '',
      name: auth.user.name || '',
      mode: 'user',
      lastOnlineAt: now(),
      offlineExpiresAt: expiresAt,
      contextGeneration: privateContextGeneration + 1
    };
    const generation = replacePrivateContext(session);
    await db.put('offlineSessions', session);
    if (!contextIsCurrent(session.userId, generation)) {
      const stored = await db.get('offlineSessions', session.key);
      if (stored?.contextGeneration === generation) await db.delete('offlineSessions', session.key);
      return null;
    }
    await db.put('offlineSessions', { key: 'lastActiveUser', userId: auth.user.id, updatedAt: now(), contextGeneration: generation });
    if (!contextIsCurrent(session.userId, generation)) {
      const marker = await db.get('offlineSessions', 'lastActiveUser');
      if (marker?.userId === session.userId && marker?.contextGeneration === generation) {
        await db.delete('offlineSessions', 'lastActiveUser');
      }
      return null;
    }
    return session;
  }

  async function lastActiveValidSession() {
    await cleanupExpiredOfflineData();
    const db = await openDb();
    const marker = await db.get('offlineSessions', 'lastActiveUser');
    if (!marker?.userId) return null;
    const session = await db.get('offlineSessions', sessionKey(marker.userId));
    if (!session) return null;
    if (new Date(session.offlineExpiresAt).getTime() <= Date.now()) {
      await purgeUser(marker.userId);
      return null;
    }
    const pendingLogout = await db.get('offlineSessions', `logout_pending:${marker.userId}`);
    if (pendingLogout) return null;
    replacePrivateContext(session);
    return session;
  }

  async function cacheJsonResponse(userId, url, payload, generation) {
    if (!contextIsCurrent(userId, generation)) return false;
    const db = await openDb();
    const key = responseKey(userId, url);
    const row = {
      key,
      userId,
      url: canonicalUrl(url),
      payload,
      cachedAt: now(),
      lastUsedAt: now(),
      contextGeneration: generation
    };
    await db.put('dashboardResponses', row);
    if (!contextIsCurrent(userId, generation)) {
      const stored = await db.get('dashboardResponses', key);
      if (stored?.contextGeneration === generation) await db.delete('dashboardResponses', key);
      return false;
    }
    await enforceResponseLimit(userId);
    if (!contextIsCurrent(userId, generation)) {
      const stored = await db.get('dashboardResponses', key);
      if (stored?.contextGeneration === generation) await db.delete('dashboardResponses', key);
      return false;
    }
    return true;
  }

  async function offlineDashboardFallback(user, generation, url, err) {
    if (!contextIsCurrent(user.userId, generation)) throw err;
    const db = await openDb();
    const row = await db.get('dashboardResponses', responseKey(user.userId, url));
    if (!row) throw err;
    if (!contextIsCurrent(user.userId, generation)) throw err;
    row.lastUsedAt = now();
    row.contextGeneration = generation;
    await db.put('dashboardResponses', row).catch(() => undefined);
    if (!contextIsCurrent(user.userId, generation)) {
      const stored = await db.get('dashboardResponses', row.key);
      if (stored?.contextGeneration === generation) await db.delete('dashboardResponses', row.key);
      throw err;
    }
    window.dispatchEvent(new CustomEvent('zenseeo-offline-fallback', { detail: { cachedAt: row.cachedAt } }));
    return new Response(JSON.stringify({
      ...row.payload,
      offline: { cached: true, cachedAt: row.cachedAt }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Zenseeo-Offline': 'true', 'X-Zenseeo-Cached-At': row.cachedAt }
    });
  }

  async function cachedDashboardFetch(url, fetcher) {
    const user = activeSession;
    const generation = privateContextGeneration;
    if (!user?.userId || !isAllowedDashboardGet(url)) return fetcher();
    let response;
    try {
      response = await withNetworkTimeout(fetcher);
    } catch (err) {
      return offlineDashboardFallback(user, generation, url, err);
    }
    if (!response.ok) return response;
    let payload;
    try {
      payload = await response.clone().json();
    } catch (err) {
      console.warn('offline_cache_response_not_json', err);
      return response;
    }
    if (!contextIsCurrent(user.userId, generation)) {
      throw new TypeError('The active dashboard user changed while data was loading.');
    }
    let cached;
    try {
      cached = await cacheJsonResponse(user.userId, url, payload, generation);
    } catch (err) {
      console.warn('offline_cache_write_failed', err);
      if (!contextIsCurrent(user.userId, generation)) {
        throw new TypeError('The active dashboard user changed while data was loading.');
      }
      return response;
    }
    if (!cached || !contextIsCurrent(user.userId, generation)) {
      throw new TypeError('The active dashboard user changed while data was loading.');
    }
    return new Response(JSON.stringify(payload), {
      status: response.status,
      statusText: response.statusText,
      headers: { 'Content-Type': 'application/json', 'X-Zenseeo-Offline': 'false' }
    });
  }

  async function warmDashboard(apiBase, queryBuilder) {
    if (!activeSession?.userId) return { warmed: 0 };
    const userId = activeSession.userId;
    const generation = privateContextGeneration;
    const warmGeneration = ++dashboardWarmGeneration;
    const warmIsCurrent = () => contextIsCurrent(userId, generation) && dashboardWarmGeneration === warmGeneration;
    const views = ['overview', 'performance', 'keywords', 'attribution', 'rank', 'proposals'];
    let warmed = 0;
    window.dispatchEvent(new CustomEvent('zenseeo-offline-status', { detail: { message: 'Preparing offline data' } }));
    for (const view of views) {
      if (!warmIsCurrent()) break;
      const url = `${apiBase}/api/dashboard${queryBuilder({ view })}`;
      try {
        const res = await withNetworkTimeout(signal => fetch(url, { credentials: 'include', signal }));
        if (!res.ok) continue;
        const payload = await res.json();
        if (!warmIsCurrent()) break;
        if (await cacheJsonResponse(userId, url, payload, generation)) warmed += 1;
      } catch {
        break;
      }
    }
    try {
      if (!warmIsCurrent()) return { warmed };
      const filterUrl = `${apiBase}/api/dashboard/filters`;
      const res = await withNetworkTimeout(signal => fetch(filterUrl, { credentials: 'include', signal }));
      if (res.ok) {
        const payload = await res.json();
        if (warmIsCurrent()) await cacheJsonResponse(userId, filterUrl, payload, generation);
      }
    } catch {
      // Warming is opportunistic.
    }
    if (warmIsCurrent()) {
      window.dispatchEvent(new CustomEvent('zenseeo-offline-status', { detail: { message: warmed ? 'Offline ready' : 'Offline data not ready' } }));
    }
    return { warmed };
  }

  async function queueLeadStatus(input) {
    if (!activeSession?.userId) throw new Error('Offline lead changes require named-user login.');
    const status = String(input.status || '');
    if (!ALLOWED_STATUSES.has(status)) throw new Error('This lead status is not allowed offline.');
    const baseUpdatedAt = String(input.baseUpdatedAt || '').trim();
    if (!baseUpdatedAt || !Number.isFinite(new Date(baseUpdatedAt).getTime())) {
      throw new Error('This lead is missing the server version required for safe offline editing. Reconnect and refresh before changing it.');
    }
    const userId = activeSession.userId;
    const generation = privateContextGeneration;
    const db = await openDb();
    if (!contextIsCurrent(userId, generation)) throw new Error('The active dashboard user changed before this edit could be saved.');
    const key = queueKey(userId, input.sessionKey);
    const existing = await db.get('leadLabelQueue', key);
    const row = {
      key,
      userId,
      sessionKey: input.sessionKey,
      status,
      label: input.label || status,
      baseUpdatedAt: existing?.baseUpdatedAt || baseUpdatedAt,
      createdAt: existing?.createdAt || now(),
      updatedAt: now(),
      contextGeneration: generation
    };
    await db.put('leadLabelQueue', row);
    if (!contextIsCurrent(userId, generation)) {
      const stored = await db.get('leadLabelQueue', key);
      if (stored?.contextGeneration === generation) await db.delete('leadLabelQueue', key);
      throw new Error('The active dashboard user changed before this edit could be saved.');
    }
    window.dispatchEvent(new CustomEvent('zenseeo-offline-status', { detail: { message: 'Lead change pending sync' } }));
  }

  async function queuedLeadStatus(sessionKeyValue) {
    if (!activeSession?.userId) return null;
    const userId = activeSession.userId;
    const generation = privateContextGeneration;
    const db = await openDb();
    const row = await db.get('leadLabelQueue', queueKey(userId, sessionKeyValue));
    return contextIsCurrent(userId, generation) ? row || null : null;
  }

  async function invalidateDashboardCache(userId) {
    const db = await openDb();
    const rows = await db.getAllFromIndex('dashboardResponses', 'byUser', userId);
    for (const row of rows) await db.delete('dashboardResponses', row.key);
  }

  async function syncLeadQueue(apiBase) {
    if (!activeSession?.userId) return { synced: 0, conflicts: 0 };
    const userId = activeSession.userId;
    const generation = privateContextGeneration;
    const db = await openDb();
    const rows = (await db.getAllFromIndex('leadLabelQueue', 'byUser', userId))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    let synced = 0;
    let conflicts = 0;
    for (const row of rows) {
      if (!contextIsCurrent(userId, generation)) break;
      try {
        const res = await withNetworkTimeout(signal => fetch(`${apiBase}/api/leads/${encodeURIComponent(row.sessionKey)}/status`, {
          method: 'POST',
          credentials: 'include',
          headers: csrfHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ status: row.status, baseUpdatedAt: row.baseUpdatedAt }),
          signal
        }));
        const data = await res.json().catch(() => ({}));
        if (!contextIsCurrent(userId, generation)) break;
        if (res.status === 401 || res.status === 403) break;
        if (res.status === 409) {
          const serverStatus = String(data.conflict?.serverStatus || '');
          const serverUpdatedAt = String(data.conflict?.serverUpdatedAt || '');
          if (!SERVER_STATUSES.has(serverStatus) || !Number.isFinite(new Date(serverUpdatedAt).getTime())) {
            break;
          }
          await db.put('conflicts', {
            key: row.key,
            userId: row.userId,
            sessionKey: row.sessionKey,
            offlineStatus: row.status,
            serverStatus,
            serverUpdatedAt,
            createdAt: now(),
            contextGeneration: generation
          });
          if (!contextIsCurrent(userId, generation)) {
            const stored = await db.get('conflicts', row.key);
            if (stored?.contextGeneration === generation) await db.delete('conflicts', row.key);
            break;
          }
          await db.delete('leadLabelQueue', row.key);
          conflicts += 1;
          continue;
        }
        if (!res.ok) continue;
        await db.delete('leadLabelQueue', row.key);
        synced += 1;
      } catch {
        break;
      }
    }
    if ((synced > 0 || conflicts > 0) && contextIsCurrent(userId, generation)) await invalidateDashboardCache(userId);
    if ((synced || conflicts) && contextIsCurrent(userId, generation)) {
      window.dispatchEvent(new CustomEvent('zenseeo-offline-status', { detail: { message: conflicts ? 'Lead conflict needs review' : 'Offline changes synced' } }));
    }
    return { synced, conflicts };
  }

  async function conflicts() {
    if (!activeSession?.userId) return [];
    const userId = activeSession.userId;
    const generation = privateContextGeneration;
    const db = await openDb();
    const rows = await db.getAllFromIndex('conflicts', 'byUser', userId);
    return contextIsCurrent(userId, generation) ? rows : [];
  }

  async function removeConflict(sessionKeyValue) {
    if (!activeSession?.userId) return;
    const userId = activeSession.userId;
    const generation = privateContextGeneration;
    const db = await openDb();
    if (contextIsCurrent(userId, generation)) await db.delete('conflicts', queueKey(userId, sessionKeyValue));
  }

  async function purgeUserData(userId) {
    const db = await openDb();
    const deleteByIndex = async (store, index) => {
      const rows = await db.getAllFromIndex(store, index, userId);
      for (const row of rows) await db.delete(store, row.key);
    };
    const marker = await db.get('offlineSessions', 'lastActiveUser');
    if (marker?.userId === userId) await db.delete('offlineSessions', 'lastActiveUser');
    await db.delete('offlineSessions', sessionKey(userId));
    await deleteByIndex('dashboardResponses', 'byUser');
    await deleteByIndex('leadLabelQueue', 'byUser');
    await deleteByIndex('conflicts', 'byUser');
  }

  async function purgeUser(userId) {
    if (activeSession?.userId === userId) replacePrivateContext(null);
    await purgeUserData(userId);
  }

  async function cleanupExpiredOfflineData() {
    const db = await openDb();
    const sessions = await db.getAll('offlineSessions');
    const expiredUserIds = sessions
      .filter(row => String(row.key || '').startsWith('user:'))
      .filter(row => {
        const expiresAt = new Date(row.offlineExpiresAt || '').getTime();
        return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
      })
      .map(row => row.userId)
      .filter(Boolean);
    for (const userId of new Set(expiredUserIds)) await purgeUser(userId);
  }

  async function detachPrivateContext() {
    const generation = replacePrivateContext(null);
    const db = await openDb();
    if (privateContextGeneration === generation && !activeSession) {
      await db.delete('offlineSessions', 'lastActiveUser');
    }
  }

  async function clearCurrentUser() {
    const userId = activeSession?.userId;
    blockPrivateOfflineAccess();
    replacePrivateContext(null);
    if (userId) await purgeUserData(userId);
  }

  async function markOfflineLogout() {
    csrfToken = csrfToken || cookieValue('dashboard_csrf');
    blockPrivateOfflineAccess();
    setPendingLogoutCookie();
    const db = await openDb();
    if (!activeSession?.userId) {
      replacePrivateContext(null);
      await db.put('offlineSessions', { key: 'logout_pending:session', userId: null, createdAt: now() });
      await db.delete('offlineSessions', 'lastActiveUser');
      return;
    }
    const userId = activeSession.userId;
    replacePrivateContext(null);
    await purgeUserData(userId);
    await db.put('offlineSessions', { key: `logout_pending:${userId}`, userId, createdAt: now() });
  }

  async function completePendingLogout(apiBase) {
    let db;
    try {
      db = await openDb();
    } catch {
      if (!pendingLogoutBlocked()) return true;
      try {
        const response = await withNetworkTimeout(signal => fetch(`${apiBase}/auth/logout`, {
          method: 'POST',
          credentials: 'include',
          headers: csrfHeaders(),
          signal
        }));
        if (!response.ok && response.status !== 401) return false;
        clearPendingLogoutCookie();
        return true;
      } catch {
        return false;
      }
    }
    const sessions = await db.getAll('offlineSessions');
    const pending = sessions.filter(row => String(row.key || '').startsWith('logout_pending:'));
    if (!pending.length && pendingLogoutBlocked()) {
      pending.push({ key: 'logout_pending:cookie' });
    }
    for (const row of pending) {
      try {
        const res = await withNetworkTimeout(signal => fetch(`${apiBase}/auth/logout`, {
          method: 'POST',
          credentials: 'include',
          headers: csrfHeaders(),
          signal
        }));
        if (res.ok || res.status === 401) {
          await db.delete('offlineSessions', row.key);
          continue;
        }
        return false;
      } catch {
        return false;
      }
    }
    clearPendingLogoutCookie();
    return true;
  }

  async function clearPendingLogoutMarkers() {
    let db;
    try {
      db = await openDb();
    } catch {
      return;
    }
    const sessions = await db.getAll('offlineSessions');
    const pending = sessions.filter(row => String(row.key || '').startsWith('logout_pending:'));
    for (const row of pending) await db.delete('offlineSessions', row.key);
    clearPendingLogoutCookie();
  }

  window.ZenseeoOffline = {
    openDb,
    refreshSession,
    lastActiveValidSession,
    cachedDashboardFetch,
    warmDashboard,
    queueLeadStatus,
    queuedLeadStatus,
    syncLeadQueue,
    conflicts,
    removeConflict,
    clearCurrentUser,
    detachPrivateContext,
    purgeUser,
    markOfflineLogout,
    completePendingLogout,
    clearPendingLogoutMarkers,
    setCsrfToken,
    csrfHeaders,
    privateOfflineAccessBlocked,
    pendingLogoutBlocked,
    get activeSession() {
      return activeSession;
    }
  };
})();
