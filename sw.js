/**
 * TNCF Rainfall Monitor — Service Worker
 * Strategy:
 *   - App Shell (HTML/CSS/JS/icons) → Cache First
 *   - CDN Libraries (Bootstrap, Chart.js, etc.) → Stale-While-Revalidate
 *   - GAS API calls (script.google.com) → Network Only (always live)
 *   - Offline fallback → offline.html
 */

const CACHE_VERSION = 'tncf-v1.2';
const SHELL_CACHE   = `${CACHE_VERSION}-shell`;
const CDN_CACHE     = `${CACHE_VERSION}-cdn`;

// ─── App Shell: file-file lokal yang wajib di-cache ───────────────────────────
const REPO_PATH = '/tncf-rainfallmonitor';
const SHELL_ASSETS = [
  `${REPO_PATH}/index.html`,
  `${REPO_PATH}/offline.html`,
  `${REPO_PATH}/manifest.json`,
  `${REPO_PATH}/icon-72.png`,
  `${REPO_PATH}/icon-96.png`,
  `${REPO_PATH}/icon-128.png`,
  `${REPO_PATH}/icon-144.png`,
  `${REPO_PATH}/icon-152.png`,
  `${REPO_PATH}/icon-192.png`,
  `${REPO_PATH}/icon-384.png`,
  `${REPO_PATH}/icon-512.png`
];

// ─── CDN Assets: di-cache saat pertama kali diminta ───────────────────────────
const CDN_ORIGINS = [
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'cdn.sheetjs.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

// ─── Google Apps Script — selalu network only ─────────────────────────────────
const GAS_ORIGINS = [
  'script.google.com',
  'script.googleusercontent.com'
];

// ─── Install: pre-cache app shell ─────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing TNCF v1.2...');
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => {
        console.log('[SW] Shell cached ✓');
        return self.skipWaiting();
      })
      .catch(err => console.warn('[SW] Shell cache failed (some assets may be missing):', err))
  );
});

// ─── Activate: hapus cache lama ───────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('tncf-') && k !== SHELL_CACHE && k !== CDN_CACHE)
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch: routing strategy ──────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Skip non-GET
  if (request.method !== 'GET') return;

  // 2. Google Apps Script / GAS API → Network Only
  if (GAS_ORIGINS.some(o => url.hostname.includes(o))) {
    event.respondWith(networkOnly(request));
    return;
  }

  // 3. CDN assets → Stale-While-Revalidate
  if (CDN_ORIGINS.some(o => url.hostname.includes(o))) {
    event.respondWith(staleWhileRevalidate(request, CDN_CACHE));
    return;
  }

  // 4. Local app shell → Cache First, fallback to offline.html for navigation
  if (url.origin === self.location.origin || request.url.startsWith(self.location.origin)) {
    if (request.mode === 'navigate') {
      event.respondWith(navigationHandler(request));
    } else {
      event.respondWith(cacheFirst(request, SHELL_CACHE));
    }
    return;
  }

  // 5. Google CDN (lh3.googleusercontent.com untuk logo/gambar) → Network First
  if (url.hostname.includes('googleusercontent.com') || url.hostname.includes('googleapis.com')) {
    event.respondWith(networkFirst(request, CDN_CACHE));
    return;
  }
});

// ─── Strategy Helpers ─────────────────────────────────────────────────────────

async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch {
    return new Response('{"success":false,"message":"Tidak ada koneksi internet"}', {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Asset not found', { status: 404 });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => cached);
  return cached || networkPromise;
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('', { status: 503 });
  }
}

async function navigationHandler(request) {
  try {
    // Coba network dulu untuk navigasi agar konten selalu fresh
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, response.clone());
      return response;
    }
  } catch {
    // Offline — coba cache dulu
  }
  const cached = await caches.match(request) || await caches.match('./index.html');
  if (cached) return cached;
  // Last resort: offline page
  return caches.match('./offline.html');
}

// ─── Background Sync (untuk simpan data saat offline) ─────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-rainfall-data') {
    event.waitUntil(syncPendingData());
  }
});

async function syncPendingData() {
  // Kirim notif ke semua client agar mereka coba kirim ulang data pending
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(client => {
    client.postMessage({ type: 'SYNC_PENDING_DATA' });
  });
}

// ─── Push Notification (stub, siap dikembangkan) ──────────────────────────────
self.addEventListener('push', event => {
  const data = event.data?.json() || { title: 'TNCF Rainfall Monitor', body: 'Ada notifikasi baru.' };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './icon-192.png',
      badge: './icon-72.png',
      tag: 'tncf-notif',
      renotify: true
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        if (clients.length > 0) return clients[0].focus();
        return self.clients.openWindow('./index.html');
      })
  );
});

console.log('[SW] TNCF Service Worker loaded ✓');
