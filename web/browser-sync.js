import { metadata, reportSongs, monthEnds, needsQuery, inScope, DAY } from './archive-core.js'
const STOP_CODES = [301, 401, 403, 429, 460]
const THROTTLED = [429, 460]
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// Liked songs first (newest like first), then the opt-in sources.
const PRIORITY = ['喜欢的歌曲', '最近播放', '本周排行', '累计排行', '我的歌单']
const rank = song => Math.min(...(song.sources || []).map(s => { const i = PRIORITY.indexOf(s); return i < 0 ? PRIORITY.length : i }), PRIORITY.length)
export class BrowserSync {
  // Adaptive pacing: requests start at most every `interval` ms (shared by all lanes and retries).
  // A rate-limit answer triples the gap and cools down before retrying; steady success slowly
  // tightens it again, never below `minInterval`. Repeated throttling stops the run, progress kept.
  constructor(store, rpc, options = {}) {
    this.store = store; this.rpc = rpc
    this.wait = options.wait || sleep
    this.minInterval = options.interval ?? 280; this.interval = this.minInterval
    this.maxInterval = options.maxInterval ?? 2400; this.cooldown = options.cooldown ?? 15000
    this.lastStart = 0; this.gate = Promise.resolve(); this.stop = false; this.task = null
    this.throttles = 0; this.streak = 0
  }
  async request(method, query = {}) {
    for (let attempt = 0, throttled = 0; ; attempt++) {
      // One shared dispatch gate, including retries and all concurrent lanes.
      const turn = this.gate.then(async () => {
        await this.wait(Math.max(0, this.lastStart + this.interval - Date.now()))
        if (this.stop) throw new Error('PAUSED')
        this.lastStart = Date.now()
      })
      this.gate = turn.catch(() => {})
      await turn
      try {
        const body = await this.rpc(method, query)
        if (++this.streak >= 25 && this.interval > this.minInterval) { this.streak = 0; this.interval = Math.max(this.minInterval, Math.round(this.interval * .85)) }
        return body
      } catch (err) {
        this.streak = 0
        if (THROTTLED.includes(err.code) && throttled < 2 && ++this.throttles <= 3 && !this.stop) {
          throttled++
          this.interval = Math.min(this.maxInterval, Math.max(900, this.interval * 3))
          if (this.run) await this.phase(`网易云说慢点，歇 ${Math.round(this.cooldown * throttled / 1000)} 秒再来…`).catch(() => {})
          await this.wait(this.cooldown * throttled)
          continue
        }
        if (STOP_CODES.includes(err.code) || err.message === 'PAUSED' || attempt >= 2 || ![0, 408, 500, 502, 503, 504].includes(err.code || 0)) throw err
        await this.wait(2000 * 2 ** attempt)
      }
    }
  }
  async start(account, options = {}) {
    if (this.task) throw new Error('已经有一个同步任务在进行')
    const limit = Number(options.limit ?? 0), concurrency = Number(options.concurrency ?? 3)
    if (!Number.isInteger(limit) || limit < 0 || limit > 100000 || ![1, 2, 3, 4].includes(concurrency)) throw new Error('同步参数不正确')
    this.stop = false; this.throttles = 0; this.interval = this.minInterval
    let accept, reject
    const accepted = new Promise((a, b) => { accept = a; reject = b })
    const work = async lock => {
      if (!lock) { reject(new Error('另一个标签页正在同步，请在那里暂停')); return }
      try {
        this.uid = account.uid
        this.run = { status: 'running', phase: '正在准备…', queried: 0, found: 0, empty: 0, failed: 0, total: 0, started_ms: Date.now() }
        await this.saveRun()
        accept({ ok: true })
        await (options.covers_only ? this.coversOnly(account) : this.collect(account, { ...options, limit, concurrency }))
      } catch (err) { reject(err) }
    }
    this.task = (globalThis.navigator?.locks
      ? navigator.locks.request(`chuting-sync-${account.uid}`, { ifAvailable: true }, work)
      : Promise.reject(new Error('浏览器不支持安全的跨标签页同步，请使用新版浏览器')))
      .catch(err => reject(err)).finally(() => { this.task = null })
    return accepted
  }
  pause() { this.stop = true }
  async saveRun() { await this.store.patchMeta(this.uid, { run: { ...this.run, updated_ms: Date.now() } }) }
  async phase(text) { this.run.phase = text; await this.saveRun() }
  async discover(options) {
    const uid = this.uid, warnings = []
    const optional = async (label, fn) => {
      if (this.stop) throw new Error('PAUSED')
      await this.phase('查找歌曲 · ' + label)
      try { await fn() }
      catch (err) { if (STOP_CODES.includes(err.code) || err.message === 'PAUSED') throw err; warnings.push(label + '没读到') }
    }
    if (!options.history_only && options.recent) await optional('最近播放', async () => {
      const b = await this.request('record_recent_song')
      await this.store.candidates(uid, (b.data?.list || []).map(x => metadata(x.data)).filter(Boolean), '最近播放')
    })
    if (!options.history_only && options.recent) for (const type of [0, 1]) await optional(type ? '本周排行' : '累计排行', async () => {
      const b = await this.request('user_record', { type })
      await this.store.candidates(uid, (b[type ? 'weekData' : 'allData'] || []).map(x => metadata(x.song)).filter(Boolean), type ? '本周排行' : '累计排行')
    })
    if (!options.history_only) await optional('喜欢的歌曲', async () => {
      const b = await this.request('likelist')
      // likelist is ordered newest like first; the rank lets the newest likes be dated first.
      await this.store.candidates(uid, (b.ids || []).map((id, like_rank) => ({ id, like_rank })), '喜欢的歌曲')
    })
    if (options.playlists && !options.history_only) await optional('我的歌单', async () => {
      const visited = new Set()
      for (let offset = 0; offset < 10000;) {
        const b = await this.request('user_playlist', { offset }), lists = b.playlist || []
        for (const p of lists) {
          if (visited.has(String(p.id)) || String(p.creator?.userId) !== uid) continue
          visited.add(String(p.id))
          await optional('歌单 ' + (p.name || '').slice(0, 30), async () => {
            const detail = (await this.request('playlist_detail', { id: p.id })).playlist || {}
            await this.store.candidates(uid, (detail.tracks || []).map(metadata).filter(Boolean), '我的歌单')
            await this.store.candidates(uid, (detail.trackIds || []).map(x => ({ id: x.id })), '我的歌单')
          })
        }
        if (!b.more || !lists.length) break
        offset += lists.length
        if (offset >= 10000) warnings.push('歌单列表达到单次上限')
      }
    })
    if (options.history && !options.basic_only) {
      const checkpoints = { ...(await this.store.getMeta(uid))?.checkpoints }
      const checkpoint = async (key, ttl, label, method, query) => {
        if (Date.now() - (checkpoints[key] || 0) < ttl) return
        await optional(label, async () => {
          const body = await this.request(method, query)
          await this.store.candidates(uid, reportSongs(body.data), label)
          checkpoints[key] = Date.now()
          await this.store.patchMeta(uid, { checkpoints: { ...checkpoints } })
        })
      }
      let years = []
      await optional('历史年份', async () => {
        const body = await this.request('listen_data_year_report')
        years = (body.data?.yearItems || []).map(x => Number(x.year)).filter(y => Number.isInteger(y) && y >= 2017 && y <= new Date().getFullYear())
      })
      // Explicit range permits exploring years absent from the footprint index.
      const from = Number(options.history_from || (years.length ? Math.min(...years) : new Date().getFullYear() - 3))
      if (!Number.isInteger(from) || from < 2017 || from > new Date().getFullYear()) throw new Error('历史起始年份不正确')
      const jobs = monthEnds(from).map(month => () => checkpoint(`month:${month.key}`, (month.current ? 1 : 30) * DAY, '历史月榜 ' + month.key, 'listen_data_song_play_rank', { endTime: month.endTime }))
      for (let year = new Date().getFullYear() - 1; year >= from; year--) jobs.push(() => checkpoint(`annual:${year}`, 30 * DAY, '年度报告 ' + year, 'summary_annual', { year }))
      // Reports are independent, so they share the request lanes (still paced by the gate); newest first.
      let next = 0, halted = null
      await Promise.all(Array.from({ length: Math.max(1, options.concurrency || 1) }, async () => {
        while (!halted && next < jobs.length) { try { await jobs[next++]() } catch (err) { halted = err } }
      }))
      if (halted) throw halted
    }
    return [...new Set(warnings)]
  }
  // Names and album art, 100 songs per request. Marks every asked id so missing art is not re-requested soon.
  async details(songs, label) {
    const warnings = []
    for (let i = 0; i < songs.length && !this.stop; i += 100) {
      const chunk = songs.slice(i, i + 100)
      if (label) await this.phase(`${label} · ${Math.min(i + 100, songs.length)} / ${songs.length}`)
      try {
        const rows = ((await this.request('song_detail', { ids: chunk.map(s => s.id).join(',') })).songs || []).map(metadata).filter(Boolean)
        await this.store.candidates(this.uid, rows, null)
        await this.store.covers(this.uid, new Map(rows.map(r => [r.id, r.cover])), chunk.map(s => s.id))
      } catch (err) { if (STOP_CODES.includes(err.code) || err.message === 'PAUSED') throw err; warnings.push('有些歌名或封面没读到') }
    }
    return warnings
  }
  // Lazily backfills album art for archives synced (or imported) before covers were stored.
  async coversOnly(account) {
    try {
      const current = await this.request('login_status')
      if (current.account?.uid !== account.uid) throw new Error('登录账号与本地档案不一致，请重新连接')
      const missing = (await this.store.songs(this.uid)).filter(s => s.first_listen_ms && !s.cover && !s.cover_checked_ms)
        .sort((a, b) => b.first_listen_ms - a.first_listen_ms)
      const warnings = await this.details(missing, '补全专辑封面')
      Object.assign(this.run, { status: this.stop ? 'paused' : 'completed', phase: this.stop ? '停了，进度都在' : '封面补好了', error: warnings[0] || null })
    } catch (err) {
      Object.assign(this.run, { status: err.message === 'PAUSED' ? 'paused' : 'failed', phase: '封面没补全，下次再来', error: err.message === 'PAUSED' ? null : err.message })
    }
    await this.saveRun()
  }
  // Queries everything currently pending (recent sources first). Called once per discovery pass.
  async drain(options, warnings) {
    const songs = await this.store.songs(this.uid)
    // Only songs from the enabled sources are queried (liked songs always); others already in the archive stay untouched.
    let queue = songs.filter(s => needsQuery(s, options.retry_empty) && inScope(s, options))
      .sort((a, b) => (a.attempts || 0) - (b.attempts || 0) || rank(a) - rank(b) || (a.like_rank ?? 1e9) - (b.like_rank ?? 1e9) || a.id.localeCompare(b.id))
    if (options.limit) queue = queue.slice(0, Math.max(0, options.limit - this.run.queried))
    // ID-only candidates and songs without art get metadata in batches, rather than one extra call per song.
    const queued = new Set(queue.map(s => s.id))
    const lacking = songs.filter(s => (queued.has(s.id) && !s.name) || ((queued.has(s.id) || s.first_listen_ms) && !s.cover && !s.cover_checked_ms))
    if (lacking.length) warnings.push(...await this.details(lacking, '读取歌名与封面'))
    const offset = this.run.queried
    this.run.total = offset + queue.length
    let cursor = 0, consecutiveErrors = 0, fatal = null
    // Await all lanes before finalizing: a paused/failed run cannot race late writes.
    const lane = async () => {
      while (!this.stop && !fatal && cursor < queue.length) {
        const song = queue[cursor++]
        try {
          const body = await this.request('music_first_listen_info', { id: song.id })
          const result = await this.store.result(this.uid, song.id, body)
          this.run[result]++
          consecutiveErrors = 0
        } catch (err) {
          if (err.message === 'PAUSED') break
          try { await this.store.failure(this.uid, song.id, err.message) }
          catch { fatal = new Error('本地存储失败，请检查可用空间'); this.stop = true; break }
          this.run.failed++
          consecutiveErrors++
          if (STOP_CODES.includes(err.code) || consecutiveErrors >= 3) { fatal = err; this.stop = true }
        }
        this.run.queried++
        this.run.phase = `查询初听时间 · ${this.run.queried - offset} / ${queue.length}`
        await this.saveRun()
      }
    }
    const lanes = await Promise.allSettled(Array.from({ length: options.concurrency }, lane))
    const rejected = lanes.find(x => x.status === 'rejected')
    if (rejected) throw rejected.reason
    if (fatal) throw fatal
  }
  async collect(account, options) {
    const warnings = []
    try {
      const current = await this.request('login_status')
      if (current.account?.uid !== account.uid) throw new Error('登录账号与本地档案不一致，请重新连接')
      // Pass 1: liked songs (plus recent plays, rankings and playlists when enabled) are cheap to find, so their dates show up within seconds.
      warnings.push(...await this.discover({ ...options, basic_only: true }))
      await this.drain(options, warnings)
      // Pass 2: monthly and annual reports reach further back; dozens of calls, so they come second.
      if (options.history && !this.stop && !(options.limit && this.run.queried >= options.limit)) {
        warnings.push(...await this.discover({ ...options, history_only: true }))
        await this.drain(options, warnings)
      }
      this.run.status = this.stop ? 'paused' : 'completed'
      this.run.phase = this.stop ? '停了，进度都在' : '同步好了'
      const unique = [...new Set(warnings)]
      this.run.error = unique.length ? unique.slice(0, 5).join('；') + (unique.length > 5 ? `；另有 ${unique.length - 5} 项未读取` : '') : null
    } catch (err) {
      this.run.status = err.message === 'PAUSED' ? 'paused' : 'failed'
      this.run.phase = err.message === 'PAUSED' ? '停了，进度都在' : '先停一下，进度都在'
      this.run.error = err.message === 'PAUSED' ? null : err.message
    }
    await this.saveRun()
  }
}
