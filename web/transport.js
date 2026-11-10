// Where /api/* requests go. Pages Functions (same origin) first; when they are out of the free daily
// quota (1027 page, or a static fallback page when the project fails open), rate limited, or NetEase
// blocks Cloudflare's IPs (-460 → 429), the page switches to one of the fallback proxies that run the
// same code (server/proxy.mjs), and probes Cloudflare again later. Each browser sticks to one fallback
// (a random id kept locally), so load splits evenly, and moves to another when its fallback is down.
// The fallbacks are set at build time (CHUTING_FALLBACK_ORIGINS); without them nothing changes.
// Fallbacks get the session as a relay token in an Authorization header (no cross-site cookies). That
// token is sealed with a server-side secret; it is kept in localStorage next to routing state only.
export const BUSY_MESSAGE = '现在使用的人有点多，进度已保存，稍后会自动继续'
// Replaced by scripts/build-pages.mjs with a comma-separated list of https origins.
const CONFIGURED = '__FALLBACK_ORIGINS__'
const KEY = 'chuting-route', RELAY = 'chuting-relay'
const MINUTE = 60000
export function parseOrigins(text) {
  return String(text || '').split(',').map(x => x.trim()).filter(x => /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(x))
}
export function fallbackOrigins() { return globalThis.location?.protocol === 'https:' ? parseOrigins(CONFIGURED) : [] }
const memoryStorage = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) } }
function hash(text) { let h = 2166136261; for (const c of String(text)) h = Math.imul(h ^ c.codePointAt(0), 16777619); return h >>> 0 }
// A reply the proxy code did not write (HTML error page, empty body), or one that says this route cannot
// serve right now: try the next route. JSON answers like 401/400 are real answers and are returned as-is.
export function unavailable(response, result) {
  if (!result) return true
  return response.status === 429 || response.status >= 500
}
export function createTransport({ fetcher = (...a) => globalThis.fetch(...a), storage = globalThis.localStorage || memoryStorage(), now = Date.now, fallbacks = fallbackOrigins() } = {}) {
  const read = () => { try { return JSON.parse(storage.getItem(KEY) || 'null') || {} } catch { return {} } }
  const write = value => { try { storage.setItem(KEY, JSON.stringify(value)) } catch {} }
  function client() {
    const state = read()
    if (!state.client) { state.client = Math.random().toString(36).slice(2, 12); write(state) }
    return state.client
  }
  // Route order for the next request: Cloudflare unless it failed recently, then this browser's fallback, then the others.
  function routes() {
    const state = read(), t = now()
    const pool = fallbacks.length ? fallbacks.map((_, i) => fallbacks[(hash(client()) + i) % fallbacks.length]) : []
    const up = pool.filter(o => !(state.down?.[o] > t)), down = pool.filter(o => state.down?.[o] > t)
    const cfDown = state.cf_until > t
    return cfDown && pool.length ? [...up, ...down, ''] : ['', ...up, ...down]
  }
  function mark(origin, ok) {
    const state = read(), t = now()
    if (origin === '') {
      if (ok) { delete state.cf_until; delete state.cf_backoff }
      else if (fallbacks.length) {
        // Probe Cloudflare again after 5, 10, 20… minutes, at most an hour.
        state.cf_backoff = Math.min(60, (state.cf_backoff || 2.5) * 2)
        state.cf_until = t + state.cf_backoff * MINUTE
      }
    } else {
      state.down ||= {}
      if (ok) delete state.down[origin]
      else state.down[origin] = t + 2 * MINUTE
    }
    write(state)
  }
  // The relay token rides along on status and login answers; it is stored, and removed from what the page sees.
  function keepRelay(path, result) {
    try {
      if (path === '/api/auth/logout' || (path === '/api/auth/status' && !result?.account)) storage.setItem(RELAY, '')
      else if (typeof result?.relay === 'string') storage.setItem(RELAY, result.relay)
    } catch {}
    if (result && typeof result === 'object') delete result.relay
  }
  function remoteOptions(options) {
    let relay = ''
    try { relay = storage.getItem(RELAY) || '' } catch {}
    const headers = { ...options.headers, ...(relay ? { Authorization: `Bearer ${relay}` } : {}) }
    return { ...options, headers, mode: 'cors', credentials: 'omit' }
  }
  async function request(path, body) {
    const options = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    let last = null, answered = false
    const failed = []
    // Routes are only marked down once some route answered: with no network at all, nothing is blamed.
    const settle = () => { if (answered) for (const origin of failed) mark(origin, false) }
    for (const origin of routes()) {
      let response, result = null
      try { response = await fetcher(origin + path, origin ? remoteOptions(options) : options) }
      catch { failed.push(origin); continue }
      answered = true
      try { result = await response.json() } catch {}
      if (unavailable(response, result)) {
        failed.push(origin)
        if (result) last = { response, result }
        continue
      }
      settle(); mark(origin, true)
      keepRelay(path, result)
      return { response, result }
    }
    settle()
    if (last) return last // e.g. NetEase rate limiting on every route: the sync backs off on its 429
    if (!answered) { const error = new Error('网络连接失败，请稍后重试'); error.code = 0; throw error }
    const error = new Error(BUSY_MESSAGE); error.code = 503; error.busy = true; throw error
  }
  return { request, routes, mark }
}
let shared = null
export function transport() { return shared ||= createTransport() }
