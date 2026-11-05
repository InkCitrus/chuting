import test from 'node:test'
import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { BrowserStore } from '../web/browser-store.js'
import { BrowserSync } from '../web/browser-sync.js'
import { parseFirst, needsQuery, reportSongs, monthEnds, csv, DAY } from '../web/archive-core.js'
const account = { uid: '1', nickname: 'Test' }, stamp = 1709991108310
const response = (id, ms = stamp) => ({ code: 200, data: { songInfoDto: { songId: id, songName: "and I'm home", singer: 'Test' }, musicFirstListenDto: { listenTime: ms }, musicTotalPlayDto: { playCount: 162 } } })
async function store() { return new BrowserStore('test-' + crypto.randomUUID()).open() }
test('millisecond validation and reported song identity are mandatory', () => {
  for (const n of [true, stamp / 1000, Date.now() + DAY * 2]) assert.throws(() => parseFirst(response('1', n), '1'))
  assert.throws(() => parseFirst(response('2'), '1'), /ID/)
  assert.equal(parseFirst({ code: 200, data: {} }, '1'), null)
})
test('concurrent IndexedDB writes preserve all observations and isolate accounts', async () => {
  const db = await store()
  await db.account(account)
  await db.candidates('1', [{ id: '10' }, { id: '11' }], 'test')
  await db.candidates('2', [{ id: '10' }], 'test')
  await Promise.all([db.result('1', '10', response('10')), db.result('1', '11', response('11')), db.result('1', '10', response('10', stamp + 1000))])
  await db.result('1', '10', { code: 200, data: {} })
  const songs = await db.songs('1'), song = songs.find(s => s.id === '10')
  assert.equal(song.first_listen_ms, stamp)
  assert.equal(song.status, 'conflict')
  assert.equal(song.observations.length, 2)
  assert.equal((await db.songs('2'))[0].status, 'pending')
  assert.equal((await db.status(account)).stats.available, 2)
  db.db.close()
})
test('imports validate before writes, merge duplicates, preserve existing first fact', async () => {
  const db = await store(), event = { song_id: '10', first_listen_ms: stamp, name: 'original' }
  const archive = { account, events: [event] }
  await db.import(archive); await db.import(archive)
  await db.import({ account, events: [{ ...event, first_listen_ms: stamp - 1000 }] })
  assert.equal((await db.songs('1')).length, 1)
  assert.equal((await db.songs('1'))[0].first_listen_ms, stamp)
  assert.equal((await db.songs('1'))[0].observations.length, 2)
  await assert.rejects(db.import({ account, events: [{ ...event, song_id: '11' }, { ...event, uid: '2' }] }))
  assert.equal((await db.songs('1')).length, 1)
  const other = await store(); await other.import(await db.backup(account))
  assert.equal((await other.songs('1'))[0].observations.length, 2)
  db.db.close(); other.db.close()
})
test('empty TTL, explicit retry, report candidates, month boundaries and CSV safety', () => {
  assert.equal(needsQuery({ status: 'empty', last_attempt_ms: Date.now() }), false)
  assert.equal(needsQuery({ status: 'empty', last_attempt_ms: Date.now() - 31 * DAY }), true)
  assert.equal(needsQuery({ status: 'empty', last_attempt_ms: Date.now() }, true), true)
  assert.equal(needsQuery({ first_listen_ms: stamp, status: 'available' }, true), false)
  assert.deepEqual(reportSongs({ artist: { id: 123, name: 'artist' }, songs: [{ songId: 10, songName: 'song', firstDate: 0 }] }).map(s => s.id), ['10'])
  assert.equal(monthEnds(2024, new Date('2024-03-01T00:00:00Z'))[1].endTime, Date.parse('2024-02-29T00:00:00+08:00'))
  assert.match(csv([{ name: '=1+1' }]), /'=/)
})
test('bounded parallel collection retries transient errors and resumes without duplicate queries', async () => {
  const db = await store(); await db.account(account)
  await db.candidates('1', [10, 11, 12, 13].map(id => ({ id, name: 'song' })), 'test')
  let inFlight = 0, max = 0, transient = true, requests = []
  const rpc = async (method, query) => {
    if (method === 'login_status') return { account }
    if (method === 'record_recent_song') return { data: { list: [] } }
    if (method === 'user_record') return { allData: [], weekData: [] }
    if (method === 'likelist') return { ids: [] }
    if (method === 'music_first_listen_info') {
      requests.push(query.id); inFlight++; max = Math.max(max, inFlight)
      await new Promise(r => setTimeout(r, 8)); inFlight--
      if (query.id === '10' && transient) { transient = false; throw Object.assign(new Error('retry'), { code: 503 }) }
      return response(query.id)
    }
    throw new Error(method)
  }
  // The browser provides Web Locks; this faithful exclusive test gate only admits one run.
  let held = false
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name, _options, work) => {
    if (held) return work(null)
    held = true; try { return await work({}) } finally { held = false }
  } } } })
  const sync = new BrowserSync(db, rpc, { interval: 0, wait: async () => {} })
  await sync.start(account, { concurrency: 2, limit: 0 })
  await sync.task
  assert.equal(max, 2)
  assert.equal((await db.status(account)).stats.available, 4)
  assert.equal(requests.filter(id => id === '10').length, 2)
  const before = requests.length
  await sync.start(account, { concurrency: 2, limit: 0 }); await sync.task
  assert.equal(requests.length, before)
  db.db.close()
})
test('rate limiting stops both lanes and records final state after in-flight writes', async () => {
  const db = await store(); await db.account(account)
  await db.candidates('1', [10, 11, 12, 13].map(id => ({ id, name: 'song' })), 'test')
  let count = 0
  const sync = new BrowserSync(db, async (method, query) => {
    if (method === 'login_status') return { account }
    if (method === 'music_first_listen_info') {
      count++
      await new Promise(r => setTimeout(r, query.id === '10' ? 1 : 20))
      if (query.id === '10') throw Object.assign(new Error('limited'), { code: 429 })
      return response(query.id)
    }
    return { data: {}, ids: [], allData: [], weekData: [] }
  }, { interval: 0, wait: async () => {} })
  await sync.start(account, { concurrency: 2, limit: 0 }); await sync.task
  assert.ok(count <= 2)
  const status = await db.status(account)
  assert.equal(status.run.status, 'failed')
  assert.equal(status.stats.available, 1)
  assert.equal(status.stats.failed, 1)
  db.db.close()
})
test('history scans persist checkpoints and only add candidates, never report dates', async () => {
  const db = await store(); await db.account(account)
  let historical = 0
  const year = new Date().getFullYear() - 1
  const sync = new BrowserSync(db, async method => {
    if (method === 'listen_data_year_report') return { data: { yearItems: [{ year }] } }
    if (['listen_data_song_play_rank', 'summary_annual'].includes(method)) { historical++; return { data: { songItems: [{ songId: 15, songName: 'older', firstDate: stamp }] } } }
    return { data: {}, allData: [], weekData: [], ids: [] }
  }, { interval: 0, wait: async () => {} })
  sync.uid = '1'; sync.run = { status: 'running' }
  await sync.discover({ history: true, history_from: year })
  const first = historical
  await sync.discover({ history: true, history_from: year })
  assert.ok(first >= 13)
  assert.equal(historical, first)
  assert.equal((await db.songs('1')).length, 1)
  assert.equal((await db.status(account)).stats.available, 0)
  db.db.close()
})
test('pausing leaves work pending and a fresh collector can resume it', async () => {
  const db = await store(); await db.account(account)
  await db.candidates('1', [10, 11, 12].map(id => ({ id, name: 'song' })), 'test')
  let sync, count = 0
  const rpc = async (method, query) => {
    if (method === 'login_status') return { account }
    if (method === 'music_first_listen_info') { count++; sync.pause(); return response(query.id) }
    return { data: {}, ids: [], allData: [], weekData: [] }
  }
  sync = new BrowserSync(db, rpc, { interval: 0, wait: async () => {} })
  await sync.start(account, { concurrency: 1, limit: 0 }); await sync.task
  assert.equal((await db.status(account)).run.status, 'paused')
  assert.equal((await db.status(account)).stats.pending, 2)
  assert.equal(count, 1)
  db.db.close()
  const reopened = await new BrowserStore(db.name).open()
  assert.equal((await reopened.status(account)).stats.available, 1)
  assert.equal((await reopened.songs('1')).filter(s => needsQuery(s)).length, 2)
  reopened.db.close()
})
