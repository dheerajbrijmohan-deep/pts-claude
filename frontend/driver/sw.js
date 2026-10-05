// Minimal service worker — just enough for "Add to Home Screen" installability.
// No offline caching yet: every request goes straight to the network, since
// the data here (earnings, announcements) must always be fresh.
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { self.clients.claim(); });
self.addEventListener('fetch', () => {});
