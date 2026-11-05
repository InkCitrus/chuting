import { validId, timestamp, mergeResult, parseFirst, archiveStatus, coverUrl, SOURCE } from './archive-core.js'
const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) })
const finished = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error || new Error('本地存储失败')) })
// Reads are served from an in-memory copy of each account's songs: status polls during a sync used to
// clone every record (including raw responses) out of IndexedDB several times a second.
// Writes update the copy in place; other tabs are told to drop theirs through a BroadcastChannel.
export class BrowserStore {
  constructor(name = 'chuting-v1') {
    this.name = name; this.cache = new Map(); this.version = 0
    if (typeof BroadcastChannel === 'function') {
      this.channel = new BroadcastChannel(`chuting-store:${name}`)
      this.channel.unref?.()
      this.channel.onmessage = event => { this.cache.delete(event.data?.uid); this.version++ }
    }
  }
  remember(uid, songs) {
    const rows = this.cache.get(uid)
    if (rows) for (const song of songs) rows.set(song.id, song)
    this.version++
    this.channel?.postMessage({ uid })
  }
  async open() {
    const req = indexedDB.open(this.name, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('settings', { keyPath: 'key' })
      req.result.createObjectStore('accounts', { keyPath: 'uid' })
      req.result.createObjectStore('songs', { keyPath: ['uid', 'id'] }).createIndex('uid', 'uid')
    }
    this.db = await request(req)
    this.db.onversionchange = () => this.db.close()
    return this
  }
  async transact(stores, mode, fn) {
    const tx = this.db.transaction(stores, mode), done = finished(tx)
    try { const result = await fn(tx); await done; return result }
    catch (err) { try { tx.abort() } catch {} await done.catch(() => {}); throw err }
  }
  async getMeta(uid) { return this.transact(['accounts'], 'readonly', tx => request(tx.objectStore('accounts').get(uid))) }
  async patchMeta(uid, changes) {
    return this.transact(['accounts'], 'readwrite', async tx => {
      const s = tx.objectStore('accounts'), old = await request(s.get(uid))
      s.put({ ...old, uid, ...changes })
    })
  }
  async active() {
    const setting = await this.transact(['settings'], 'readonly', tx => request(tx.objectStore('settings').get('active')))
    return setting ? (await this.getMeta(setting.value))?.account : null
  }
  async account(account) {
    if (!validId(account?.uid)) throw new Error('账号格式不正确')
    account = { uid: String(account.uid), nickname: String(account.nickname || account.uid) }
    await this.transact(['settings', 'accounts'], 'readwrite', async tx => {
      const accounts = tx.objectStore('accounts'), old = await request(accounts.get(account.uid))
      accounts.put({ ...old, uid: account.uid, account })
      tx.objectStore('settings').put({ key: 'active', value: account.uid })
    })
    return account
  }
  async songs(uid) {
    if (!this.cache.has(uid)) {
      const version = this.version
      const rows = await this.transact(['songs'], 'readonly', tx => request(tx.objectStore('songs').index('uid').getAll(uid)))
      // A write that landed while reading means this snapshot may be stale: use it once, do not keep it.
      if (version !== this.version) return rows
      this.cache.set(uid, new Map(rows.map(row => [row.id, row])))
    }
    return [...this.cache.get(uid).values()]
  }
  async candidates(uid, songs, source) {
    const written = []
    await this.transact(['songs'], 'readwrite', async tx => {
      const table = tx.objectStore('songs')
      for (const item of songs) {
        if (!item || !validId(item.id)) continue
        const id = String(item.id), old = await request(table.get([uid, id]))
        const merged = old || { uid, id, name: '', artists: '', album: '', status: 'pending', attempts: 0, observations: [], sources: [] }
        for (const k of ['name', 'artists', 'album']) if (item[k]) merged[k] = String(item[k])
        const cover = coverUrl(item.cover)
        if (cover) merged.cover = cover
        if (source) merged.sources = [...new Set([...merged.sources, source])]
        if (Number.isInteger(item.like_rank)) merged.like_rank = item.like_rank
        table.put(merged); written.push(merged)
      }
    })
    this.remember(uid, written)
  }
  // Album art backfill: `found` maps id -> cover URL; every id in `checked` is marked so it is not asked again soon.
  async covers(uid, found, checked) {
    const written = []
    await this.transact(['songs'], 'readwrite', async tx => {
      const table = tx.objectStore('songs')
      for (const id of checked) {
        const song = await request(table.get([uid, String(id)]))
        if (!song) continue
        const cover = coverUrl(found.get(String(id)))
        if (cover) song.cover = cover
        song.cover_checked_ms = Date.now()
        table.put(song); written.push(song)
      }
    })
    this.remember(uid, written)
  }
  async result(uid, id, body) {
    const parsed = parseFirst(body, id)
    let merged
    await this.transact(['songs'], 'readwrite', async tx => {
      const table = tx.objectStore('songs'), song = await request(table.get([uid, id]))
      if (!song) throw new Error('候选歌曲不存在')
      table.put(merged = mergeResult(song, parsed, body))
    })
    this.remember(uid, [merged])
    return parsed ? 'found' : 'empty'
  }
  async failure(uid, id, error) {
    let row
    await this.transact(['songs'], 'readwrite', async tx => {
      const table = tx.objectStore('songs'), song = await request(table.get([uid, id]))
      if (song) table.put(row = { ...song, status: song.first_listen_ms ? song.status : 'failed', attempts: (song.attempts || 0) + 1, last_attempt_ms: Date.now(), error: String(error).slice(0, 200) })
    })
    if (row) this.remember(uid, [row])
  }
  async status(account) {
    const data = account ? archiveStatus(await this.songs(account.uid)) : { stats: {}, calendar: { months: [], days: 0 } }
    return { account, mode: 'first_listen', timezone: 'Asia/Shanghai', stats: data.stats, calendar: data.calendar, run: account ? (await this.getMeta(account.uid))?.run || null : null }
  }
  async backup(account) {
    return { format: 'chuting-browser', version: 1, account, exported_at: new Date().toISOString(),
      songs: await this.songs(account.uid), checkpoints: (await this.getMeta(account.uid))?.checkpoints || {} }
  }
  async import(data) {
    const account = data.account || data.summary?.account
    if (!validId(account?.uid)) throw new Error('备份中缺少有效账号')
    const uid = String(account.uid), complete = data.format === 'chuting-browser'
    if (complete && data.version !== 1) throw new Error('暂不支持这个备份版本')
    const rows = complete ? data.songs : data.events
    if (!Array.isArray(rows) || rows.length > 100000) throw new Error('备份内容不正确或记录过多')
    // Validate every row before the first write; malformed imports cannot be partial.
    const validated = rows.map(row => {
      const id = String(row.id || row.song_id)
      if (!validId(id) || (row.uid != null && String(row.uid) !== uid)) throw new Error('备份歌曲或账号不一致')
      const song = { uid, id, name: String(row.name || ''), artists: String(row.artists || ''), album: String(row.album || ''),
        sources: [...new Set((complete ? row.sources || [] : ['导入档案']).map(String))], attempts: Math.max(0, Number(row.attempts) || 0),
        status: ['pending', 'empty', 'failed', 'available', 'conflict'].includes(row.status) ? row.status : 'pending',
        last_attempt_ms: Number(row.last_attempt_ms) || null, play_count: row.play_count ?? null, observations: [] }
      const cover = coverUrl(row.cover)
      if (cover) song.cover = cover
      for (const k of ['peak_count', 'peak_ms']) if (Number.isSafeInteger(row[k]) && row[k] > 0) song[k] = row[k]
      if (row.first_listen_ms) {
        song.first_listen_ms = timestamp(row.first_listen_ms)
        song.captured_ms = Number(row.captured_ms) || Date.now()
        song.source = SOURCE
        song.observations = (row.observations || []).map(o => ({ first_listen_ms: timestamp(o.first_listen_ms), source: SOURCE,
          captured_ms: Number(o.captured_ms) || Date.now(), upstream_date: o.upstream_date || null }))
        if (!song.observations.some(o => o.first_listen_ms === song.first_listen_ms)) song.observations.push({ first_listen_ms: song.first_listen_ms, source: SOURCE, captured_ms: song.captured_ms })
        song.observations = [...new Map(song.observations.map(o => [o.first_listen_ms, o])).values()]
        song.status = song.observations.length > 1 ? 'conflict' : 'available'
      } else if (['available', 'conflict'].includes(song.status)) throw new Error('备份缺少初听时间')
      if (complete && row.raw) song.raw = row.raw
      return song
    })
    await this.transact(['songs', 'accounts', 'settings'], 'readwrite', async tx => {
      const songs = tx.objectStore('songs')
      for (const song of validated) {
        const old = await request(songs.get([uid, song.id]))
        if (old) {
          song.sources = [...new Set([...old.sources, ...song.sources])]
          song.attempts = Math.max(song.attempts, old.attempts || 0)
          if ((old.last_attempt_ms || 0) > (song.last_attempt_ms || 0)) {
            song.last_attempt_ms = old.last_attempt_ms
            if (!song.first_listen_ms && !old.first_listen_ms) song.status = old.status
            if (old.play_count != null) song.play_count = old.play_count
          }
          if (old.first_listen_ms) {
            song.observations = [...new Map([...song.observations, ...old.observations].map(o => [o.first_listen_ms, o])).values()]
            song.first_listen_ms = old.first_listen_ms
            song.captured_ms = old.captured_ms
          }
          for (const k of ['name', 'artists', 'album', 'cover', 'cover_checked_ms', 'peak_count', 'peak_ms', 'raw']) if (!song[k] && old[k]) song[k] = old[k]
          if (song.first_listen_ms) song.status = song.observations.length > 1 ? 'conflict' : 'available'
        }
        songs.put(song)
      }
      const accounts = tx.objectStore('accounts'), old = await request(accounts.get(uid))
      const checkpoints = { ...old?.checkpoints }
      if (complete) for (const [k, v] of Object.entries(data.checkpoints || {})) {
        if (/^(month:\d{4}-(0[1-9]|1[0-2])|annual:\d{4})$/.test(k) && Number.isSafeInteger(v) && v > 0 && v <= Date.now()) checkpoints[k] = Math.max(v, checkpoints[k] || 0)
      }
      accounts.put({ ...old, uid, account: { uid, nickname: String(account.nickname || uid) }, checkpoints })
      tx.objectStore('settings').put({ key: 'active', value: uid })
    })
    this.cache.delete(uid); this.version++; this.channel?.postMessage({ uid })
    return { uid, nickname: String(account.nickname || uid) }
  }
}
