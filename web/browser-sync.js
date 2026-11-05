import { metadata, reportSongs, monthEnds, needsQuery, DAY } from './archive-core.js'
const STOP_CODES = [301, 401, 403, 429, 460]
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export class BrowserSync {
  constructor(store, rpc, options = {}) {
    this.store = store; this.rpc = rpc
    this.wait = options.wait || sleep; this.interval = options.interval ?? 650
    this.lastStart = 0; this.gate = Promise.resolve(); this.stop = false; this.task = null
  }
  async request(method, query = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      // One shared dispatch gate, including retries and both concurrent lanes.
      const turn = this.gate.then(async () => {
        await this.wait(Math.max(0, this.lastStart + this.interval - Date.now()))
        if (this.stop) throw new Error('PAUSED')
        this.lastStart = Date.now()
      })
      this.gate = turn.catch(() => {})
      await turn
      try { return await this.rpc(method, query) }
      catch (err) {
        if (STOP_CODES.includes(err.code) || err.message === 'PAUSED' || attempt === 2 || ![0, 408, 500, 502, 503, 504].includes(err.code || 0)) throw err
        await this.wait(2000 * 2 ** attempt)
      }
    }
  }
  async start(account, options = {}) {
    if (this.task) throw new Error('已经有一个同步任务在进行')
    const limit = Number(options.limit ?? 200), concurrency = Number(options.concurrency ?? 2)
    if (!Number.isInteger(limit) || limit < 0 || limit > 100000 || ![1, 2].includes(concurrency)) throw new Error('同步参数不正确')
    this.stop = false
    let accept, reject
    const accepted = new Promise((a, b) => { accept = a; reject = b })
    const work = async lock => {
      if (!lock) { reject(new Error('另一个标签页正在同步，请在那里暂停')); return }
      try {
        this.uid = account.uid
        this.run = { status: 'running', phase: '正在准备…', queried: 0, found: 0, empty: 0, failed: 0, started_ms: Date.now() }
        await this.saveRun()
        accept({ ok: true })
        await this.collect(account, { ...options, limit, concurrency })
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
      catch (err) { if (STOP_CODES.includes(err.code) || err.message === 'PAUSED') throw err; warnings.push(label + '未能读取') }
    }
    await optional('最近播放', async () => {
      const b = await this.request('record_recent_song')
      await this.store.candidates(uid, (b.data?.list || []).map(x => metadata(x.data)).filter(Boolean), '最近播放')
    })
    for (const type of [0, 1]) await optional(type ? '本周排行' : '累计排行', async () => {
      const b = await this.request('user_record', { type })
      await this.store.candidates(uid, (b[type ? 'weekData' : 'allData'] || []).map(x => metadata(x.song)).filter(Boolean), type ? '本周排行' : '累计排行')
    })
    await optional('喜欢的歌曲', async () => {
      const b = await this.request('likelist')
      await this.store.candidates(uid, (b.ids || []).map(id => ({ id })), '喜欢的歌曲')
    })
    if (options.playlists) await optional('我的歌单', async () => {
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
    if (options.history) {
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
      for (const month of monthEnds(from)) await checkpoint(`month:${month.key}`, (month.current ? 1 : 30) * DAY, '历史月榜 ' + month.key, 'listen_data_song_play_rank', { endTime: month.endTime })
      for (let year = from; year < new Date().getFullYear(); year++) await checkpoint(`annual:${year}`, 30 * DAY, '年度报告 ' + year, 'summary_annual', { year })
    }
    return [...new Set(warnings)]
  }
  async collect(account, options) {
    let fatal = null, warnings = []
    try {
      const current = await this.request('login_status')
      if (current.account?.uid !== account.uid) throw new Error('登录账号与本地档案不一致，请重新连接')
      warnings = await this.discover(options)
      let queue = (await this.store.songs(this.uid)).filter(s => needsQuery(s, options.retry_empty))
        .sort((a, b) => (a.attempts || 0) - (b.attempts || 0) || a.id.localeCompare(b.id))
      if (options.limit) queue = queue.slice(0, options.limit)
      // ID-only candidates receive metadata in batches, rather than one extra call per song.
      for (let i = 0; i < queue.length; i += 100) {
        const missing = queue.slice(i, i + 100).filter(s => !s.name)
        if (missing.length) {
          try {
            const b = await this.request('song_detail', { ids: missing.map(s => s.id).join(',') })
            await this.store.candidates(this.uid, (b.songs || []).map(metadata).filter(Boolean), '歌曲详情')
          } catch (err) { if (STOP_CODES.includes(err.code) || err.message === 'PAUSED') throw err; warnings.push('部分歌曲名称未能读取') }
        }
      }
      let cursor = 0, consecutiveErrors = 0
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
          this.run.phase = `查询初听时间 · ${this.run.queried} / ${queue.length} · 同时 ${options.concurrency} 首`
          await this.saveRun()
        }
      }
      const lanes = await Promise.allSettled(Array.from({ length: options.concurrency }, lane))
      const rejected = lanes.find(x => x.status === 'rejected')
      if (rejected) throw rejected.reason
      if (fatal) throw fatal
      this.run.status = this.stop ? 'paused' : 'completed'
      this.run.phase = this.stop ? '已暂停，进度已保存' : '这一批同步好了'
      this.run.error = warnings.length ? warnings.slice(0, 5).join('；') + (warnings.length > 5 ? `；另有 ${warnings.length - 5} 项未读取` : '') : null
    } catch (err) {
      this.run.status = err.message === 'PAUSED' ? 'paused' : 'failed'
      this.run.phase = err.message === 'PAUSED' ? '已暂停，进度已保存' : '同步已停止，进度已保存'
      this.run.error = err.message === 'PAUSED' ? null : err.message
    }
    await this.saveRun()
  }
}
