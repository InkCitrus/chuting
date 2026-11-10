// 初听 service worker: offline copy of the app shell + a bounded cache of viewed album covers.
// Code is always network-first with cache:'no-store' so a deploy (and a zone TTL change) is picked up
// even when Safari/WebKit would otherwise reuse a stale HTTP-cached module through the SW.
// The Cache Storage copy is used only when the network fails. VERSION is stamped by the Pages build,
// and activating a new version drops older shell caches.
const VERSION = '__BUILD__'
const SHELL = `chuting-shell-${VERSION}`
const COVERS = 'chuting-covers-v1'
const MAX_COVERS = 600
const FILES = ['/', '/styles.css', '/theme.js', '/app.js', '/backend.js', '/transport.js', '/browser-store.js', '/browser-sync.js', '/archive-core.js', '/insights.js', '/share.js', '/rotator.js', '/copy.js', '/player.js', '/capsule.js', '/travel.js',
  '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png']
const COVER_HOST = /^p\d{1,2}\.music\.126\.net$/

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()))
})
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('chuting-shell-') && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()))
})
self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/')) return // live data and login are never cached here
    // Pathname only: ?v= build stamps must not bypass the shell handler.
    const shell = request.mode === 'navigate' ? '/' : FILES.includes(url.pathname) ? url.pathname : null
    if (shell) event.respondWith(networkFirst(request, shell))
    return
  }
  // Audio (m*.music.126.net, signed and short-lived) is never intercepted or cached.
  if (COVER_HOST.test(url.hostname) && request.destination === 'image') event.respondWith(cover(event, request))
})
async function networkFirst(request, key) {
  const cache = await caches.open(SHELL)
  try {
    // cache:'no-store' is the Safari/WebKit fix: SW fetch() otherwise reuses a long-lived HTTP
    // cache entry even after Cache-Control flips to max-age=0 (Cmd+Shift+R only bypasses the document).
    const response = await fetch(request, { cache: 'no-store' })
    if (response.ok && response.type === 'basic') cache.put(key, response.clone())
    return response
  } catch (err) {
    const cached = await cache.match(key) || (request.mode === 'navigate' && await caches.match('/'))
    if (cached) return cached
    throw err
  }
}
// Covers never change for a URL: cache-first, keep the newest MAX_COVERS (CORS responses, so sizes are real).
async function cover(event, request) {
  const cache = await caches.open(COVERS)
  const hit = await cache.match(request)
  if (hit) return hit
  const response = await fetch(request)
  if (response.ok && response.type === 'cors') event.waitUntil(cache.put(request, response.clone()).then(() => trim(cache)))
  return response
}
async function trim(cache) {
  const keys = await cache.keys()
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_COVERS))) await cache.delete(key)
}
