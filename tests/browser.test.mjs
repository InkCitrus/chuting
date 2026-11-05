import test from 'node:test'
import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { BrowserStore } from '../web/browser-store.js'
import { BrowserSync } from '../web/browser-sync.js'
import { parseFirst, needsQuery, reportSongs, monthEnds, csv, coverUrl, metadata, eventFromSong, inScope, archiveStatus, DAY } from '../web/archive-core.js'
import { insights } from '../web/insights.js'
import { taglines, timelineLedes, endTitles, WELCOME_LINES, CLOSING_LINES } from '../web/copy.js'
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
  await db.candidates('1', [10, 11, 12, 13].map(id => ({ id, name: 'song' })), '喜欢的歌曲')
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
test('rate limiting slows down and retries, then stops all lanes and records final state', async () => {
  const db = await store(); await db.account(account)
  await db.candidates('1', [10, 11, 12, 13].map(id => ({ id, name: 'song' })), '喜欢的歌曲')
  let count = 0, waited = []
  const sync = new BrowserSync(db, async (method, query) => {
    if (method === 'login_status') return { account }
    if (method === 'music_first_listen_info') {
      count++
      await new Promise(r => setTimeout(r, query.id === '10' ? 1 : 20))
      if (query.id === '10') throw Object.assign(new Error('limited'), { code: 429 })
      return response(query.id)
    }
    return { data: {}, ids: [], allData: [], weekData: [] }
  }, { interval: 0, cooldown: 1000, wait: async ms => { waited.push(ms) } })
  await sync.start(account, { concurrency: 2, limit: 0 }); await sync.task
  // Two slower retries with a cool-down for the throttled song, never a burst.
  assert.ok(waited.includes(1000) && waited.includes(2000))
  assert.ok(sync.interval >= 900)
  assert.ok(count <= 7)
  const status = await db.status(account)
  assert.equal(status.run.status, 'failed')
  assert.ok(status.stats.available >= 1)
  assert.equal(status.stats.failed, 1)
  db.db.close()
})
test('a single rate-limit answer only slows the run down; it still finishes', async () => {
  const db = await store(); await db.account(account)
  await db.candidates('1', [10, 11, 12].map(id => ({ id, name: 'song', cover: 'http://p1.music.126.net/x/1.jpg' })), '喜欢的歌曲')
  let limited = false
  const sync = new BrowserSync(db, async (method, query) => {
    if (method === 'login_status') return { account }
    if (method === 'music_first_listen_info') {
      if (query.id === '11' && !limited) { limited = true; throw Object.assign(new Error('limited'), { code: 429 }) }
      return response(query.id)
    }
    return { data: {}, ids: [], allData: [], weekData: [] }
  }, { interval: 100, wait: async () => {} })
  await sync.start(account, { concurrency: 3, limit: 0 }); await sync.task
  const status = await db.status(account)
  assert.equal(status.run.status, 'completed')
  assert.equal(status.stats.available, 3)
  assert.ok(sync.interval > 100)
  db.db.close()
})
test('album art: URLs are validated, stored from song lists, and backfilled in batches', async () => {
  assert.equal(coverUrl('http://p2.music.126.net/a-b==/1099.jpg?param=40y40'), 'https://p2.music.126.net/a-b==/1099.jpg')
  for (const bad of ['https://evil.example/p1.music.126.net/x.jpg', 'javascript:alert(1)', 'https://p1.music.126.net.evil.example/x.jpg']) assert.equal(coverUrl(bad), '')
  assert.equal(metadata({ id: 5, name: 's', ar: [{ name: 'a' }], al: { name: 'al', picUrl: 'http://p1.music.126.net/c/2.jpg' } }).cover, 'https://p1.music.126.net/c/2.jpg')
  const db = await store(); await db.account(account)
  await db.candidates('1', [{ id: '20', name: 'a' }, { id: '21', name: 'b' }], 'test')
  await db.result('1', '20', response('20')); await db.result('1', '21', response('21'))
  assert.equal((await db.status(account)).stats.missing_covers, 2)
  const asked = []
  const sync = new BrowserSync(db, async (method, query) => {
    if (method === 'login_status') return { account }
    if (method === 'song_detail') { asked.push(query.ids); return { songs: [{ id: 20, name: 'a', al: { picUrl: 'http://p1.music.126.net/z/3.jpg' } }] } }
    throw new Error(method)
  }, { interval: 0, wait: async () => {} })
  await sync.start(account, { covers_only: true }); await sync.task
  assert.equal(asked.length, 1)
  const songs = await db.songs('1')
  assert.equal(songs.find(s => s.id === '20').cover, 'https://p1.music.126.net/z/3.jpg')
  assert.ok(songs.find(s => s.id === '21').cover_checked_ms)
  assert.equal((await db.status(account)).stats.missing_covers, 0)
  db.db.close()
})
test('peak day is read from the response and from archives that only kept the raw body', () => {
  const body = response('1'); body.data.musicPlayMostDto = { timestamp: stamp + DAY, mostPlayedCount: 12 }
  assert.deepEqual([parseFirst(body, '1').peak_count, parseFirst(body, '1').peak_ms], [12, stamp + DAY])
  const event = eventFromSong({ id: '1', first_listen_ms: stamp, raw: body })
  assert.equal(event.peak_count, 12)
  assert.equal(event.raw, undefined)
})
test('in-memory song cache follows writes, including writes from another tab', async () => {
  const name = 'test-' + crypto.randomUUID()
  const a = await new BrowserStore(name).open(), b = await new BrowserStore(name).open()
  await a.account(account)
  await a.candidates('1', [{ id: '30', name: 'x' }], 'test')
  assert.equal((await a.songs('1')).length, 1)
  await b.candidates('1', [{ id: '31', name: 'y' }], 'test')
  await new Promise(r => setTimeout(r, 20))
  assert.equal((await a.songs('1')).length, 2)
  await a.result('1', '30', response('30'))
  assert.equal((await a.songs('1')).find(s => s.id === '30').status, 'available')
  a.db.close(); b.db.close(); a.channel?.close(); b.channel?.close()
})
test('highlights only claim what the data supports', () => {
  const ev = (id, date, time, extra = {}) => ({ song_id: id, name: 'song ' + id, artists: 'A', date, time, ...extra })
  const plain = [ev('1', '2024-01-01', '02:10'), ev('2', '2024-01-02', '15:00'), ev('3', '2024-01-03', '21:00'), ev('4', '2024-02-01', '09:00'), ev('5', '2024-02-02', '03:30')]
  const ids = insights(plain).map(i => i.id)
  assert.ok(ids.includes('earliest') && ids.includes('streak') && ids.includes('artist'))
  assert.ok(!ids.includes('most-played') && !ids.includes('afternoon'), 'no play counts, no play-based claims')
  const counted = insights(plain.map((e, i) => ({ ...e, play_count: [5, 40, 3, 9, 7][i] })))
  assert.equal(counted.find(i => i.id === 'most-played').event.song_id, '2')
  const afternoon = counted.find(i => i.id === 'afternoon')
  assert.ok(!afternoon || afternoon.event.song_id !== '2', 'a song is featured once')
  assert.match(counted.find(i => i.id === 'late-night').kicker, /深夜遇见/)
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
  await db.candidates('1', [10, 11, 12].map(id => ({ id, name: 'song' })), '喜欢的歌曲')
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
test('recent songs are dated before the long history scan runs', async () => {
  const db = await store(); await db.account(account)
  const order = []
  const rpc = async (method, query) => {
    order.push(method === 'music_first_listen_info' ? 'q' + query.id : method)
    if (method === 'login_status') return { account }
    if (method === 'record_recent_song') return { data: { list: [{ data: { id: 20, name: 'recent', ar: [{ name: 'a' }], al: { name: 'b', picUrl: 'https://p1.music.126.net/x.jpg' } } }] } }
    if (method === 'listen_data_song_play_rank') return { data: { songItems: [{ songId: 21, songName: 'older', firstDate: stamp }] } }
    if (method === 'song_detail') return { songs: [] }
    if (method === 'music_first_listen_info') return response(query.id)
    return {}
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_n, _o, work) => work({}) } } })
  const sync = new BrowserSync(db, rpc, { interval: 0, wait: async () => {} })
  await sync.start(account, { concurrency: 2, limit: 0, recent: true, history: true, history_from: new Date().getFullYear() }); await sync.task
  assert.ok(order.indexOf('q20') < order.indexOf('listen_data_song_play_rank'))
  assert.ok(order.indexOf('q21') > order.indexOf('listen_data_song_play_rank'))
  assert.equal(sync.run.status, 'completed'); assert.equal(sync.run.queried, 2); assert.equal(sync.run.total, 2)
  db.db.close()
})
test('rotating copy: stable first line, data lines only when the archive supports them', () => {
  assert.deepEqual(taglines([]), WELCOME_LINES)
  const ev = (date, time, extra = {}) => ({ date, time, name: 's' + date, ...extra })
  const plain = [ev('2025-01-02', '13:00'), ev('2025-01-02', '14:00'), ev('2025-03-05', '15:00')]
  const lines = taglines(plain)
  assert.equal(lines[0], WELCOME_LINES[0])
  assert.ok(!lines.some(l => l.includes('遍')), 'no play-count line without play counts')
  assert.ok(!lines.some(l => l.includes('最常在')), 'no time-of-day line from three songs')
  assert.ok(lines.includes('这条时间线，已经走了 2 个月。'))
  const counted = [...plain, ev('2025-03-06', '15:30', { play_count: 41 }), ev('2025-03-07', '16:00'), ev('2025-03-08', '12:10')]
  const more = taglines(counted)
  assert.ok(more.includes('《s2025-03-06》听了 41 遍，第一次是在 2025 年 3 月 6 日。'))
  assert.ok(more.includes('你最常在午后遇见新歌。'))
  const ledes = timelineLedes(plain, 'newest')
  assert.equal(ledes[0], '每一行，都是一首歌第一次响起的时刻。')
  assert.ok(ledes.includes('最热闹的一天是 2025 年 1 月 2 日，一天遇见了 2 首。'))
  assert.notDeepEqual(endTitles('newest'), endTitles('oldest'))
  assert.ok(CLOSING_LINES.every(l => !/记录|不是/.test(l)), 'no disclaimers in the closing lines')
})
test('by default only liked songs are requested and dated, newest like first; other songs are kept', async () => {
  const db = await store(); await db.account(account)
  await db.candidates('1', [{ id: '50', name: 'old playlist song' }], '我的歌单') // from an earlier, wider sync
  const calls = [], dated = []
  const rpc = async (method, query) => {
    calls.push(method)
    if (method === 'login_status') return { account }
    if (method === 'likelist') return { ids: [62, 61, 60] } // NetEase lists the newest like first
    if (method === 'song_detail') return { songs: query.ids.split(',').map(id => ({ id: Number(id), name: 'n' + id, ar: [{ name: 'a' }], al: { name: 'b' } })) }
    if (method === 'music_first_listen_info') { dated.push(query.id); return response(query.id) }
    throw new Error('unexpected ' + method)
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_n, _o, work) => work({}) } } })
  const sync = new BrowserSync(db, rpc, { interval: 0, wait: async () => {} })
  await sync.start(account, { concurrency: 1, limit: 0 }); await sync.task
  assert.deepEqual(dated, ['62', '61', '60'])
  for (const m of ['record_recent_song', 'user_record', 'user_playlist', 'listen_data_year_report']) assert.ok(!calls.includes(m), m + ' is opt-in')
  const songs = await db.songs('1'), kept = songs.find(s => s.id === '50')
  assert.equal(kept.status, 'pending', 'non-liked songs are kept, not deleted and not queried')
  const stats = archiveStatus(songs).stats
  assert.equal(stats.liked, 3); assert.equal(stats.pending_liked, 0); assert.equal(stats.pending, 1)
  assert.equal(inScope(kept, {}), false); assert.equal(inScope(kept, { playlists: true }), true)
  assert.equal(inScope({ sources: ['历史月榜 2024-01'] }, { history: true }), true)
  // Opting in brings the other sources back.
  calls.length = 0
  await sync.start(account, { concurrency: 1, limit: 0, recent: true }); await sync.task
  assert.ok(calls.includes('record_recent_song') && calls.includes('user_record'))
  db.db.close()
})
test('pacing: clean answers tighten the gap to the 15 req/s floor and the learned gap is remembered', async () => {
  const db = await store(); await db.account(account)
  await db.candidates('1', Array.from({ length: 80 }, (_, i) => ({ id: 100 + i, name: 'song', cover: 'http://p1.music.126.net/x/1.jpg' })), '喜欢的歌曲')
  let saved = null
  const pace = { get: () => saved, set: v => { saved = v } }
  const sync = new BrowserSync(db, async (method, query) => method === 'login_status' ? { account } : method === 'music_first_listen_info' ? response(query.id) : { data: {}, ids: [], allData: [], weekData: [] },
    { pace, wait: async () => {} })
  assert.equal(sync.minInterval, 67)
  assert.equal(sync.interval, 120)
  await sync.start(account, { concurrency: 8, limit: 0 }); await sync.task
  assert.equal(sync.interval, 67)
  assert.equal(saved.interval, 67)
  assert.equal((await db.status(account)).run.pace.rate, 14.9)
  // The next run starts at the remembered rate; stale or silly values are clamped.
  assert.equal(new BrowserSync(db, async () => ({}), { pace, wait: async () => {} }).interval, 67)
  saved = { interval: 5 }; assert.equal(new BrowserSync(db, async () => ({}), { pace }).interval, 67)
  saved = { interval: 99999 }; assert.equal(new BrowserSync(db, async () => ({}), { pace }).interval, 400)
  await assert.rejects(sync.start(account, { concurrency: 9 }), /同步参数不正确/)
  db.db.close()
})
test('pacing: a throttle answer multiplies the gap and the refused rate is never reused', async () => {
  const db = await store(); await db.account(account)
  await db.candidates('1', Array.from({ length: 40 }, (_, i) => ({ id: 200 + i, name: 'song', cover: 'http://p1.music.126.net/x/1.jpg' })), '喜欢的歌曲')
  let saved = { interval: 67 }, n = 0
  const pace = { get: () => saved, set: v => { saved = v } }
  const sync = new BrowserSync(db, async (method, query) => {
    if (method === 'login_status') return { account }
    if (method === 'music_first_listen_info' && ++n === 20) throw Object.assign(new Error('cheating'), { code: 429 })
    return method === 'music_first_listen_info' ? response(query.id) : { data: {}, ids: [], allData: [], weekData: [] }
  }, { pace, wait: async () => {} })
  await sync.start(account, { concurrency: 8, limit: 0 }); await sync.task
  assert.equal((await db.status(account)).run.status, 'completed')
  assert.ok(saved.interval >= 100, `remembered ${saved.interval}`)
  db.db.close()
})
test('pacing: strict mode stops at the first throttle signal and records where', async () => {
  const db = await store(); await db.account(account)
  await db.candidates('1', Array.from({ length: 30 }, (_, i) => ({ id: 300 + i, name: 'song', cover: 'http://p1.music.126.net/x/1.jpg' })), '喜欢的歌曲')
  let n = 0, waited = 0
  const sync = new BrowserSync(db, async (method, query) => {
    if (method === 'login_status') return { account }
    if (method === 'music_first_listen_info' && ++n === 12) throw Object.assign(new Error('busy'), { code: 503 })
    return method === 'music_first_listen_info' ? response(query.id) : { data: {}, ids: [], allData: [], weekData: [] }
  }, { pace: { get: () => null, set() {} }, cooldown: 5000, wait: async ms => { if (ms >= 5000) waited++ } })
  await sync.start(account, { concurrency: 4, limit: 0, strict: true }); await sync.task
  const { run, stats } = await db.status(account)
  assert.equal(run.status, 'failed')
  assert.equal(run.pace.stopped_by, 429)
  assert.equal(run.pace.method, 'music_first_listen_info')
  assert.equal(waited, 0)
  assert.ok(stats.available >= 8 && stats.available < 30)
  db.db.close()
})
test('pacing: a sustained latency rise eases off before NetEase complains', async () => {
  const db = await store(); await db.account(account)
  await db.candidates('1', Array.from({ length: 40 }, (_, i) => ({ id: 400 + i, name: 'song', cover: 'http://p1.music.126.net/x/1.jpg' })), '喜欢的歌曲')
  let n = 0
  const sync = new BrowserSync(db, async (method, query) => {
    if (method === 'login_status') return { account }
    if (method !== 'music_first_listen_info') return { data: {}, ids: [], allData: [], weekData: [] }
    await new Promise(r => setTimeout(r, ++n > 15 ? 160 : 5))
    return response(query.id)
  }, { pace: { get: () => null, set() {} }, latencySlack: 50, wait: async () => {} })
  await sync.start(account, { concurrency: 2, limit: 0 }); await sync.task
  assert.ok(sync.slowdowns >= 1)
  db.db.close()
})

test('stores avatarUrl on the account record', async () => {
  const db = await store()
  const saved = await db.account({ uid: '1', nickname: 'Test', avatarUrl: 'https://p1.music.126.net/a/b.jpg' })
  assert.equal(saved.avatarUrl, 'https://p1.music.126.net/a/b.jpg')
  assert.equal((await db.active()).avatarUrl, 'https://p1.music.126.net/a/b.jpg')
  // A later write without avatar keeps the previous one.
  await db.account({ uid: '1', nickname: 'Test2' })
  assert.equal((await db.active()).nickname, 'Test2')
  assert.equal((await db.active()).avatarUrl, 'https://p1.music.126.net/a/b.jpg')
})
