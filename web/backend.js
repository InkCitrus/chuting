import { BrowserStore } from './browser-store.js'
import { BrowserSync } from './browser-sync.js'
import { archiveStatus, csv } from './archive-core.js'
export async function remote(path, body) {
  let response
  try { response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
  catch { const error = new Error('网络连接失败，请稍后重试'); error.code = 0; throw error }
  let result = {}
  try { result = await response.json() } catch { if (response.ok) throw new Error('收到了无法识别的响应，请刷新页面重试') }
  if (!response.ok) { const error = new Error(result.error || '操作没有完成，请稍后再试'); error.code = result.code || response.status; throw error }
  return result
}
// The runtime answer is remembered so the archive still opens with no network (offline / installed app).
async function runtime() {
  try {
    const value = await remote('/api/runtime')
    try { localStorage.setItem('chuting-runtime', JSON.stringify(value)) } catch {}
    return value
  } catch (err) {
    let saved = null
    try { saved = JSON.parse(localStorage.getItem('chuting-runtime')) } catch {}
    if (saved?.storage) return { ...saved, offline: true }
    throw err
  }
}
export async function createBackend() {
  const info = await runtime()
  if (info.storage !== 'indexeddb') return { local: false, api: remote }
  const store = await new BrowserStore().open()
  let account = await store.active()
  const sync = new BrowserSync(store, (method, query) => remote('/api/netease', { method, query, uid: sync.uid }))
  if (account && navigator.locks) await navigator.locks.request(`chuting-sync-${account.uid}`, { ifAvailable: true }, async lock => {
    if (lock && (await store.getMeta(account.uid))?.run?.status === 'running') await store.patchMeta(account.uid, { run: { status: 'paused', phase: '上次同步被打断了，进度都在' } })
  })
  // Sorting thousands of songs into events is reused until the store changes.
  let memo = { key: '', value: null }
  async function snapshot() {
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
      try { return (await remote('/api/auth/status', {})).account?.uid === account.uid } catch { return false }
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
