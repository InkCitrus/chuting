import { BrowserStore } from './browser-store.js'
import { BrowserSync } from './browser-sync.js'
import { archiveStatus, csv } from './archive-core.js'
import { transport } from './transport.js'
export async function remote(path, body) {
  const { response, result } = await transport().request(path, body)
  if (!response.ok) {
    const error = new Error(result.error || '操作没有完成，请稍后再试'); error.code = result.code || response.status
    if (error.code === 429 || error.code === 503) error.busy = true
    throw error
  }
  return result
}
// The runtime answer is remembered so the archive still opens with no network (offline / installed app),
// and a fresh copy (under 12 hours) is used without asking again: one Functions request saved per visit.
const RUNTIME_TTL = 12 * 3600000
async function runtime() {
  let saved = null
  try { saved = JSON.parse(localStorage.getItem('chuting-runtime')) } catch {}
  if (saved?.storage && saved.configured && Date.now() - (saved.saved_ms || 0) < RUNTIME_TTL) return saved
  try {
    const value = await remote('/api/runtime')
    try { localStorage.setItem('chuting-runtime', JSON.stringify({ ...value, saved_ms: Date.now() })) } catch {}
    return value
  } catch (err) {
    if (saved?.storage) return { ...saved, offline: true }
    throw err
  }
}
export async function createBackend() {
  const info = await runtime()
  if (info.storage !== 'indexeddb') return { local: false, api: remote }
  const store = await new BrowserStore().open()
  let account = await store.active()
  const sync = new BrowserSync(store, (method, query) => remote('/api/netease', { method, query, uid: sync.uid }), { batch: 20 })
  if (account && navigator.locks) await navigator.locks.request(`chuting-sync-${account.uid}`, { ifAvailable: true }, async lock => {
    if (lock && (await store.getMeta(account.uid))?.run?.status === 'running') await store.patchMeta(account.uid, { run: { status: 'paused', phase: '上次同步被打断了，进度都在' } })
  })
  // Sorting thousands of songs into events is reused until the store changes.
  let memo = { key: '', value: null }
  async function snapshot() {
    // Pick up nickname/avatar updates written by sync or import.
    account = (await store.active()) || account
    if (!account) return archiveStatus([])
    const key = `${account.uid}:${store.version}`
    if (memo.key !== key) {
      const songs = await store.songs(account.uid)
      memo = { key: `${account.uid}:${store.version}`, value: archiveStatus(songs) }
    }
    return memo.value
  }
  return {
    local: true, configured: info.configured, store, sync,
    // Whether the proxy still holds a valid NetEase session for the local archive's account.
    async session() {
      if (!info.configured || !account) return false
      // Busy proxies say nothing about the login: stay online, and the sync waits and resumes by itself.
      try { return (await remote('/api/auth/status', {})).account?.uid === account.uid } catch (err) { return Boolean(err.busy) }
    },
    async connect(connected) { if (sync.task) throw new Error('请先暂停同步再切换账号'); account = await store.account(connected); await navigator.storage?.persist?.(); return account },
    async logout() { if (sync.task) sync.pause(); await remote('/api/auth/logout', {}) },
    async import(data) { if (sync.task) throw new Error('请先暂停同步再导入'); account = await store.import(data); await navigator.storage?.persist?.(); return account },
    async download(format) {
      if (!account) throw new Error('还没有可以备份的档案')
      const backup = await store.backup(account)
      const data = format === 'csv' ? csv(archiveStatus(backup.songs).events) : JSON.stringify(backup, null, 2)
      const blob = new Blob([data], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json' })
      const url = URL.createObjectURL(blob), link = document.createElement('a')
      link.href = url; link.download = format === 'csv' ? 'first-listens.csv' : 'chuting-backup.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    },
    async api(path, body) {
      const url = new URL(path, location.origin)
      if (path === '/api/status') {
        const data = await snapshot()
        return { account, mode: 'first_listen', timezone: 'Asia/Shanghai', stats: data.stats, calendar: data.calendar, run: account ? (await store.getMeta(account.uid))?.run || null : null }
      }
      if (url.pathname === '/api/events') {
        const { events } = await snapshot()
        const q = (url.searchParams.get('q') || '').toLocaleLowerCase(), month = url.searchParams.get('month')
        return { events: q || month ? events.filter(e => (!q || `${e.name} ${e.artists}`.toLocaleLowerCase().includes(q)) && (!month || e.date.startsWith(month))) : events }
      }
      if (path === '/api/sync') {
        if (!account) throw new Error('请先连接网易云音乐')
        return sync.start(account, body)
      }
      if (path === '/api/sync/pause') { sync.pause(); return { ok: true } }
      throw new Error('不支持的操作')
    },
  }
}
