// Service worker: caches the app shell and ledger code so the app opens and works with no network.
// Ledger data lives in IndexedDB, not in this cache.
const CACHE = 'karigar-ledger-v2';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './store.js', './manifest.webmanifest', './icon.svg',
  '../src/core/units.js', '../src/core/crypto.js', '../src/core/reconcile.js', '../src/core/ledger.js',
  '../src/core/gate.js', '../src/core/agent.js',
  '../src/mocks/upi.js', '../src/mocks/huid.js', '../src/mocks/speech.js', '../src/mocks/whatsapp.js',
];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
// Network first, revalidating with the server (cache: 'no-cache') so updates are never hidden by the
// browser's HTTP cache. Falls back to the SW cache when offline.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
