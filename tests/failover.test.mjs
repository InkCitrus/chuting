import test from 'node:test'
import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { createTransport, unavailable, parseOrigins, BUSY_MESSAGE } from '../web/transport.js'
import { handleApi, cacheKey, publicSongs, BATCH_MAX } from '../cloudflare/worker.mjs'
import { seal, getSession } from '../cloudflare/session.mjs'
import { handle, config } from '../server/proxy.mjs'
import { BrowserStore } from '../web/browser-store.js'
import { BrowserSync, RESUME_STEPS } from '../web/browser-sync.js'

const A = 'https://api1.example.test', B = 'https://api2.example.test'
const page = 'https://chuting.example'
const secret = 'test-only-secret-32-characters-long-123456789'
const shared = 'test-only-shared-secret-32-characters-long-987'
const memory = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), m } }
const html = status => new Response('<!doctype html><title>Error 1027</title>', { status, headers: { 'content-type': 'text/html' } })
const ok = body => Response.json(body)
const req = (path, body = {}, headers = {}) => new Request(page + path, { method: 'POST', headers: { Origin: page, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

test('transport: Cloudflare quota page fails over to this browser\'s fallback, then probes Cloudflare later', async () => {
  let t = 1_000_000
  const seen = [], storage = memory()
  const tx = createTransport({ storage, now: () => t, fallbacks: [A, B], fetcher: async (url) => {
    seen.push(url)
    if (url.startsWith('/')) return html(429)
    return ok({ account: null })
  } })
  const { result } = await tx.request('/api/auth/status', {})
  assert.deepEqual(result, { account: null })
  assert.equal(seen[0], '/api/auth/status')
  const first = seen[1]
  assert.ok([A + '/api/auth/status', B + '/api/auth/status'].includes(first))
  // Next request skips Cloudflare while it is marked down, and sticks to the same fallback.
  seen.length = 0
  await tx.request('/api/auth/status', {})
  assert.deepEqual(seen, [first])
  // After the back-off (5 minutes on the first failure), Cloudflare is probed first again.
  t += 5 * 60000 + 1; seen.length = 0
  await tx.request('/api/auth/status', {})
  assert.equal(seen[0], '/api/auth/status')
})
test('transport: a down fallback hands over to the other; everything down is a clear busy error', async () => {
  const storage = memory()
  let down = new Set(['cf', A])
  const tx = createTransport({ storage, fallbacks: [A, B], fetcher: async url => {
    const host = url.startsWith('/') ? 'cf' : url.startsWith(A) ? A : B
    if (down.has(host)) { if (host === 'cf') return html(503); throw new TypeError('fetch failed') }
    return ok({ ok: true })
  } })
  for (let i = 0; i < 4; i++) assert.deepEqual((await tx.request('/api/netease', {})).result, { ok: true })
  down = new Set(['cf', A, B])
  await assert.rejects(tx.request('/api/netease', {}), err => err.busy && err.code === 503 && err.message === BUSY_MESSAGE)
})
test('transport: no network marks nothing down; JSON answers like 401 are returned, not failed over', async () => {
  const storage = memory()
  const offline = createTransport({ storage, fallbacks: [A, B], fetcher: async () => { throw new TypeError('offline') } })
  await assert.rejects(offline.request('/api/netease', {}), err => err.code === 0 && !err.busy)
  assert.equal(JSON.parse(storage.getItem('chuting-route') || '{}').cf_until, undefined)
  const seen = []
  const tx = createTransport({ storage: memory(), fallbacks: [A, B], fetcher: async url => { seen.push(url); return Response.json({ error: 'login', code: 401 }, { status: 401 }) } })
  const { response } = await tx.request('/api/netease', {})
  assert.equal(response.status, 401); assert.equal(seen.length, 1)
  assert.equal(unavailable(new Response('x', { status: 200 }), null), true)
  assert.equal(unavailable(new Response('x', { status: 429 }), { error: 'x' }), true)
  assert.deepEqual(parseOrigins('https://a.example, http://b.example, javascript:x,https://c.example:8443'), ['https://a.example', 'https://c.example:8443'])
})
test('transport: the relay token is kept, sent only to fallbacks (never as a cookie), and hidden from the page', async () => {
  const storage = memory(), calls = []
  let cfUp = true
  const tx = createTransport({ storage, fallbacks: [A], fetcher: async (url, options) => {
    calls.push({ url, options })
    if (url.startsWith('/')) return cfUp ? ok({ account: { uid: '1' }, relay: 'relay-token-fixture-0123456789' }) : html(429)
    return ok({ ok: true })
  } })
  const { result } = await tx.request('/api/auth/status', {})
  assert.deepEqual(result, { account: { uid: '1' } })
  assert.equal(calls[0].options.headers.Authorization, undefined)
  cfUp = false
  await tx.request('/api/netease', { method: 'likelist' })
  const remote = calls.at(-1)
  assert.equal(remote.url, A + '/api/netease')
  assert.equal(remote.options.headers.Authorization, 'Bearer relay-token-fixture-0123456789')
  assert.equal(remote.options.credentials, 'omit')
  await tx.request('/api/auth/logout', {})
  assert.equal(storage.getItem('chuting-relay'), '')
})

test('worker: a relay token sealed with the shared key opens a session on a fallback that only has that key', async () => {
  const token = await seal({ account: { uid: '1', nickname: 'T' }, cookie: { MUSIC_U: 'fake' } }, secret, 'session', 600)
  const cf = { SESSION_SECRET: secret, SHARED_SESSION_SECRET: shared }
  const status = await (await handleApi(req('/api/auth/status', {}, { Cookie: 'chuting_session=' + token }), cf, async () => assert.fail())).json()
  assert.ok(status.relay)
  // The fallback has only the shared key: the old cookie means nothing there, the relay token works.
  const fallback = { SHARED_SESSION_SECRET: shared }
  assert.equal(await getSession(req('/', {}, { Cookie: 'chuting_session=' + token }), fallback), null)
  const session = await getSession(req('/', {}, { Authorization: 'Bearer ' + status.relay }), fallback)
  assert.equal(session.account.uid, '1')
  // A relay token is not a cookie session and vice versa.
  assert.equal(await getSession(req('/', {}, { Cookie: 'chuting_session=' + status.relay }), fallback), null)
})

test('worker: first listens are answered in batches of up to 20, each with the caller\'s own session', async () => {
  const token = await seal({ account: { uid: '1' }, cookie: { MUSIC_U: 'fake' } }, secret, 'session', 600)
  const env = { SESSION_SECRET: secret }, cookie = { Cookie: 'chuting_session=' + token }
  const asked = []
  const rpc = async (method, query, c, uid) => {
    assert.equal(method, 'music_first_listen_info'); assert.equal(c.MUSIC_U, 'fake'); assert.equal(uid, '1')
    asked.push(query.id)
    return { body: { code: 200, data: { songInfoDto: { songId: Number(query.id) } } } }
  }
  const ids = Array.from({ length: BATCH_MAX }, (_, i) => String(100 + i))
  const body = await (await handleApi(req('/api/netease', { uid: '1', method: 'music_first_listen_batch', query: { ids } }, cookie), env, rpc, null)).json()
  assert.equal(body.results.length, 20); assert.deepEqual(asked.sort(), ids)
  assert.equal((await handleApi(req('/api/netease', { uid: '1', method: 'music_first_listen_batch', query: { ids: [...ids, '999'] } }, cookie), env, rpc, null)).status, 400)
  assert.equal((await handleApi(req('/api/netease', { uid: '1', method: 'music_first_listen_batch', query: { ids: ['1', 'x'] } }, cookie), env, rpc, null)).status, 400)
  // Risk control part-way: answered songs come back, the rest are left for later.
  let n = 0
  const limited = async (_m, query) => { if (++n > 3) throw Object.assign(new Error('limited'), { code: 429, name: 'ApiError' }); return { body: { code: 200, data: {} } } }
  const { ApiError } = await import('../cloudflare/netease.mjs')
  const limited2 = async (m, q) => { try { return await limited(m, q) } catch { throw new ApiError('接口请求受限', 429) } }
  const part = await (await handleApi(req('/api/netease', { uid: '1', method: 'music_first_listen_batch', query: { ids } }, cookie), env, limited2, null)).json()
  assert.equal(part.throttled, 429); assert.ok(part.results.length >= 3 && part.results.length < 20)
  const none = await handleApi(req('/api/netease', { uid: '1', method: 'music_first_listen_batch', query: { ids } }, cookie), env, async () => { throw new ApiError('接口请求受限', 429) }, null)
  assert.equal(none.status, 429)
  const expired = await handleApi(req('/api/netease', { uid: '1', method: 'music_first_listen_batch', query: { ids } }, cookie), env, async () => { throw new ApiError('登录已失效，请重新扫码', 301) }, null)
  assert.equal((await expired.json()).code, 301) // the page treats 301 as "log in again" and stops
})

function fakeCache() {
  const m = new Map(), log = []
  return { m, log, match: async key => { log.push(['match', String(key)]); const v = m.get(String(key)); return v ? new Response(v) : undefined },
    put: async (key, response) => { log.push(['put', String(key)]); m.set(String(key), await response.text()) } }
}
test('edge cache: public song details and artist search are shared; cookies and uids never reach a key', async () => {
  const cache = fakeCache(), env = { SESSION_SECRET: secret }
  const t1 = await seal({ account: { uid: '1' }, cookie: { MUSIC_U: 'user-one' } }, secret, 'session', 600)
  const t2 = await seal({ account: { uid: '2' }, cookie: { MUSIC_U: 'user-two' } }, secret, 'session', 600)
  let calls = 0
  const rpc = async method => { calls++; return method === 'song_detail'
    ? { body: { songs: [{ id: 2, name: 'b', ar: [{ name: 'x' }], al: { name: 'al', picUrl: 'https://p1.music.126.net/a.jpg' }, privilege: { fee: 8 } }, { id: 1, name: 'a', ar: [], al: {} }] } }
    : { body: { result: { artists: [{ name: 'x' }] } } } }
  const ask = (token, uid, method, query) => handleApi(req('/api/netease', { uid, method, query }, { Cookie: 'chuting_session=' + token }), env, rpc, cache)
  const first = await (await ask(t1, '1', 'song_detail', { ids: '2,1' })).json()
  const second = await ask(t2, '2', 'song_detail', { ids: '1,2' })
  assert.equal(second.headers.get('X-Chuting-Cache'), 'hit')
  assert.deepEqual(await second.json(), first)
  assert.ok(!JSON.stringify(first).includes('privilege'))
  await ask(t1, '1', 'artist_search', { s: 'X ' }); await ask(t2, '2', 'artist_search', { s: 'x' })
  assert.equal(calls, 2)
  for (const [, key] of cache.log) assert.ok(!/user-|uid|MUSIC_U|session/.test(key) && key.includes('/__edge-cache/'))
  // Per-account methods never touch the cache.
  cache.log.length = 0
  for (const method of ['music_first_listen_info', 'likelist', 'user_record', 'record_recent_song', 'user_playlist', 'login_status', 'song_url', 'playlist_detail']) assert.equal(cacheKey(new URL(page), method, { id: '1', ids: '1' }), null)
  await ask(t1, '1', 'likelist', {}).catch(() => {})
  assert.equal(cache.log.length, 0)
})
test('edge cache: a batch with a cloud-drive upload (one account\'s file) is never cached', async () => {
  assert.equal(publicSongs([{ id: 1, t: 0 }], ['1']), true)
  assert.equal(publicSongs([{ id: 1, pc: { fn: 'x.flac' } }], ['1']), false)
  assert.equal(publicSongs([{ id: 1, t: 1 }], ['1']), false)
  assert.equal(publicSongs([{ id: 1 }], ['1', '2']), false)
  const cache = fakeCache(), env = { SESSION_SECRET: secret }
  const t = await seal({ account: { uid: '1' }, cookie: { MUSIC_U: 'x' } }, secret, 'session', 600)
  await handleApi(req('/api/netease', { uid: '1', method: 'song_detail', query: { ids: '5' } }, { Cookie: 'chuting_session=' + t }), env, async () => ({ body: { songs: [{ id: 5, name: 'mine', pc: { fn: 'mine.flac' } }] } }), cache)
  assert.equal(cache.m.size, 0)
})

function nodeReq(method, path, headers = {}, body = '') {
  return Object.assign((async function* () { if (body) yield Buffer.from(body) })(), { method, url: path, headers })
}
test('fallback proxy: CORS only for the page origin, no credentials mode, the relay token is the session', async () => {
  const cfg = config({ SHARED_SESSION_SECRET: shared, PUBLIC_ORIGIN: A, ALLOWED_ORIGINS: page })
  const pre = await handle(nodeReq('OPTIONS', '/api/netease', { origin: page }), cfg)
  assert.equal(pre.status, 204)
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), page)
  assert.equal(pre.headers.get('Access-Control-Allow-Credentials'), null)
  assert.match(pre.headers.get('Access-Control-Allow-Headers'), /Authorization/)
  assert.equal((await handle(nodeReq('OPTIONS', '/api/netease', { origin: 'https://evil.example' }), cfg)).status, 403)
  const relay = await seal({ account: { uid: '1' }, cookie: { MUSIC_U: 'fake' } }, shared, 'relay', 600)
  const rpc = async method => ({ body: { code: 200, ids: [7], method } })
  const res = await handle(nodeReq('POST', '/api/netease', { origin: page, 'content-type': 'application/json', authorization: 'Bearer ' + relay }, JSON.stringify({ uid: '1', method: 'likelist' })), cfg, rpc)
  assert.equal(res.status, 200); assert.deepEqual((await res.json()).ids, [7])
  const evil = await handle(nodeReq('POST', '/api/netease', { origin: 'https://evil.example', 'content-type': 'application/json', authorization: 'Bearer ' + relay }, JSON.stringify({ uid: '1', method: 'likelist' })), cfg, rpc)
  assert.equal(evil.status, 403); assert.equal(evil.headers.get('Access-Control-Allow-Origin'), null)
  assert.equal((await handle(nodeReq('GET', '/api/runtime', { origin: page }), cfg)).status, 200)
  assert.equal((await handle(nodeReq('GET', '/other'), cfg)).status, 404)
  assert.throws(() => config({ SHARED_SESSION_SECRET: shared }), /PUBLIC_ORIGIN/)
})

const account = { uid: '1', nickname: 'Test' }
const first = (id, ms = 1709991108310) => ({ code: 200, data: { songInfoDto: { songId: id }, musicFirstListenDto: { listenTime: ms } } })
async function store() { return new BrowserStore('fo-' + crypto.randomUUID()).open() }
function locks() {
  let held = false
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_n, _o, work) => { if (held) return work(null); held = true; try { return await work({}) } finally { held = false } } } } })
}
test('sync: 1000 liked songs take 50 batch requests, 10 detail requests and no per-song calls', async () => {
  locks()
  const db = await store(); await db.account(account)
  const ids = Array.from({ length: 1000 }, (_, i) => String(1000 + i))
  const count = {}
  const sync = new BrowserSync(db, async (method, query) => {
    count[method] = (count[method] || 0) + 1
    if (method === 'login_status') return { account }
    if (method === 'likelist') return { ids }
    if (method === 'song_detail') return { songs: query.ids.split(',').map(id => ({ id: Number(id), name: 's', ar: [], al: { picUrl: 'https://p1.music.126.net/c.jpg' } })) }
    if (method === 'music_first_listen_batch') { assert.ok(query.ids.length <= 20); return { code: 200, results: query.ids.map(id => ({ id, body: first(id) })) } }
    throw new Error(method)
  }, { interval: 0, wait: async () => {}, batch: 20 })
  await sync.start(account, { concurrency: 8 }); await sync.task
  assert.deepEqual(count, { login_status: 1, likelist: 1, song_detail: 10, music_first_listen_batch: 50 })
  assert.equal((await db.status(account)).stats.available, 1000)
  // Repeat sync, nothing new: only the like list (profile is refreshed at most once a day).
  for (const k of Object.keys(count)) delete count[k]
  await sync.start(account, { concurrency: 8 }); await sync.task
  assert.deepEqual(count, { likelist: 1 })
  db.db.close()
})
test('sync: a throttled batch keeps its answers and re-queues the rest after a cool-down', async () => {
  locks()
  const db = await store(); await db.account(account)
  await db.candidates('1', Array.from({ length: 30 }, (_, i) => ({ id: String(500 + i), name: 's', cover: 'https://p1.music.126.net/c.jpg' })), '喜欢的歌曲')
  let throttledOnce = false, waits = []
  const sync = new BrowserSync(db, async (method, query) => {
    if (method === 'login_status') return { account }
    if (method === 'likelist') return { ids: [] }
    if (method === 'music_first_listen_batch') {
      if (!throttledOnce) { throttledOnce = true; return { code: 200, results: query.ids.slice(0, 5).map(id => ({ id, body: first(id) })), throttled: 429 } }
      return { code: 200, results: query.ids.map(id => ({ id, body: first(id) })) }
    }
    return { songs: [] }
  }, { interval: 0, cooldown: 1000, wait: async ms => { waits.push(ms) }, batch: 20 })
  await sync.start(account, { concurrency: 2 }); await sync.task
  const status = await db.status(account)
  assert.equal(status.run.status, 'completed'); assert.equal(status.stats.available, 30); assert.equal(status.stats.failed, 0)
  assert.ok(waits.includes(1000)); assert.ok(sync.interval >= 900)
  db.db.close()
})
test('sync: when every route is busy, progress is kept, nothing is marked failed, and a resume is scheduled', async () => {
  locks()
  const db = await store(); await db.account(account)
  await db.candidates('1', Array.from({ length: 45 }, (_, i) => ({ id: String(700 + i), name: 's', cover: 'https://p1.music.126.net/c.jpg' })), '喜欢的歌曲')
  let batches = 0
  const busy = () => Object.assign(new Error(BUSY_MESSAGE), { code: 503, busy: true })
  const sync = new BrowserSync(db, async (method, query) => {
    if (method === 'login_status') return { account }
    if (method === 'likelist') return { ids: [] }
    if (method === 'music_first_listen_batch') {
      if (++batches === 1) return { code: 200, results: query.ids.map(id => ({ id, body: first(id) })) }
      throw busy()
    }
    return { songs: [] }
  }, { interval: 0, cooldown: 10, wait: async () => {}, batch: 20 })
  const before = Date.now()
  await sync.start(account, { concurrency: 1 }); await sync.task
  const status = await db.status(account)
  assert.equal(status.stats.available, 20)
  assert.equal(status.stats.failed, 0)
  assert.equal(status.stats.pending, 25)
  assert.equal(status.run.status, 'failed'); assert.equal(status.run.busy, true)
  assert.equal(status.run.phase, BUSY_MESSAGE)
  assert.ok(status.run.resume_ms >= before + RESUME_STEPS[0])
  db.db.close()
})
