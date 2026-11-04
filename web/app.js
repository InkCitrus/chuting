'use strict'
const $ = id => document.getElementById(id)
const state = { month: '', selected: '', events: [], account: null, status: null, query: '', initialized: false, request: 0 }
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]))
const today = `${parts.year}-${parts.month}-${parts.day}`
state.month = today.slice(0, 7)
state.selected = today
let toastTimer, searchTimer

function node(tag, className, text) {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || '操作未完成，请稍后重试')
  return result
}
function toast(message) {
  $('toast').textContent = message
  $('toast').hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { $('toast').hidden = true }, 8000)
}
function dayLabel(date, year = false) {
  const [y, m, d] = date.split('-').map(Number)
  return `${year ? `${y} 年 ` : ''}${m} 月 ${d} 日`
}
function running() { return state.status?.run?.status === 'running' }
function renderStatus() {
  const status = state.status || {}, stats = status.stats || {}, calendar = status.calendar || {}
  $('accountLabel').textContent = state.account ? state.account.nickname : '本机音乐档案'
  $('connectButton').textContent = state.account ? '重新连接' : '连接账号'
  $('connectButton').disabled = running()
  $('collectButton').textContent = running() ? '采集中…' : '＋ 采集歌曲'
  $('availableCount').textContent = (stats.available || 0).toLocaleString()
  $('daysCount').textContent = (calendar.days || 0).toLocaleString()
  $('discoveredCount').textContent = (stats.discovered || 0).toLocaleString()
  $('dateRange').textContent = calendar.earliest ? `${calendar.earliest} — ${calendar.latest}` : '等待你的第一首歌'
  $('coverageText').textContent = `${stats.pending || 0} 首待查询 · ${stats.empty || 0} 首暂无首次时间`
  $('queriedCount').replaceChildren(document.createTextNode((stats.queried || 0).toLocaleString()), node('span', 'fraction', ` / ${(stats.discovered || 0).toLocaleString()}`))
  $('coverageProgress').max = stats.discovered || 1
  $('coverageProgress').value = stats.queried || 0
  $('runLabel').textContent = '已查询 / 候选总数'
  $('qualityText').textContent = `${stats.failed || 0} 首查询失败 · ${stats.conflicts || 0} 首时间冲突`
  const run = status.run
  $('runNotice').hidden = !run
  $('runMessage').textContent = run ? run.phase + (run.error ? ` · ${run.error}` : '') : ''
  $('pauseButton').hidden = !running()
  $('startCollect').disabled = running()
  $('startCollect').textContent = running() ? '已有采集任务进行中' : '开始采集'
  for (const id of ['exportJson', 'exportCsv']) {
    $(id).setAttribute('aria-disabled', String(!state.account))
    $(id).tabIndex = state.account ? 0 : -1
  }
}
function renderCalendar() {
  const [year, month] = state.month.split('-').map(Number)
  $('monthTitle').textContent = `${year} 年 ${month} 月`
  $('monthPicker').value = state.month
  const grouped = new Map()
  for (const event of state.events) {
    const list = grouped.get(event.date) || []
    list.push(event)
    grouped.set(event.date, list)
  }
  const thisMonth = state.events.filter(e => e.date.startsWith(state.month))
  $('monthCount').textContent = `本月 ${thisMonth.length} 首初听`
  const first = new Date(Date.UTC(year, month - 1, 1))
  const offset = (first.getUTCDay() + 6) % 7
  const grid = $('calendarGrid')
  grid.replaceChildren()
  for (let i = 0; i < 42; i++) {
    const date = new Date(Date.UTC(year, month - 1, 1 - offset + i))
    const iso = date.toISOString().slice(0, 10)
    const songs = grouped.get(iso) || []
    const cell = node('button', 'date-cell')
    cell.type = 'button'
    if (!iso.startsWith(state.month)) cell.classList.add('other-month')
    if (songs.length) cell.classList.add('has-events')
    if (iso === state.selected) cell.classList.add('selected')
    if (iso === today) cell.classList.add('today')
    cell.setAttribute('aria-label', `${dayLabel(iso, true)}，${songs.length} 首已归档初听歌曲`)
    cell.setAttribute('aria-pressed', String(iso === state.selected))
    const top = node('span', 'date-top')
    top.append(node('span', 'date-number', date.getUTCDate()))
    if (songs.length) top.append(node('span', 'date-count', songs.length))
    cell.append(top)
    for (const song of songs.slice(0, 2)) cell.append(node('span', 'date-song', song.name))
    if (songs.length > 2) cell.append(node('span', 'date-more', `+${songs.length - 2} 首`))
    cell.addEventListener('click', async () => {
      state.selected = iso
      if (!iso.startsWith(state.month)) { state.month = iso.slice(0, 7); await loadEvents() }
      else { renderCalendar(); renderDay() }
    })
    grid.append(cell)
  }
}
function renderDay() {
  const search = state.query.trim()
  const events = search ? [...state.events].reverse() : state.events.filter(e => e.date === state.selected)
  $('dayEyebrow').textContent = search ? 'ACROSS YOUR ARCHIVE' : `${state.selected.slice(0, 4)} · DAY IN MUSIC`
  $('dayTitle').textContent = search ? '搜索结果' : dayLabel(state.selected)
  $('daySubtitle').textContent = search ? `${events.length} 首匹配歌曲 · 所有月份` : `${events.length} 首已归档的初听歌曲`
  const list = $('songList')
  list.replaceChildren()
  if (!events.length) {
    const empty = node('div', 'empty-state')
    empty.append(node('span', 'empty-mark', '◎'), node('h3', '', search ? '还没有找到这首歌' : state.account ? '这一天，等待一段旋律' : '从第一次听见开始'))
    empty.append(node('p', '', search ? '试试其他歌名或歌手，也可以继续采集更多歌曲。' : state.account ? '当前还没有采集到这一天的首次播放记录。可以继续采集，或换一个日期看看。' : '连接你的网易云音乐账号，把有记录的第一次播放，整理成自己的音乐日历。'))
    const button = node('button', 'button subtle', state.account ? '采集更多歌曲' : '连接网易云账号')
    button.addEventListener('click', () => state.account ? openCollect() : connect())
    empty.append(button)
    list.append(empty)
    return
  }
  for (const event of events) {
    const row = node('button', 'song-row')
    const copy = node('span', 'song-copy')
    copy.append(node('span', 'song-name', event.name), node('span', 'song-artist', event.artists || '歌手信息待补充'))
    if (search) copy.append(node('span', 'song-date', event.date))
    if (event.status === 'conflict') copy.append(node('span', 'song-date', '首次时间存在差异，点开查看'))
    row.append(node('time', 'song-time', event.time), copy, node('span', 'song-arrow', '↗'))
    row.addEventListener('click', () => showSong(event))
    list.append(row)
  }
}
function showSong(event) {
  $('detailName').textContent = event.name
  $('detailArtists').textContent = event.artists || '歌手信息待补充'
  const dl = $('detailFacts')
  dl.replaceChildren()
  const entries = [['首次播放（北京时间）', `${event.date} ${event.time}`], ['累计播放次数', event.play_count == null ? '暂无数据' : `${event.play_count} 次（接口累计统计）`], ['时间来源', '网易云音乐 · 回忆坐标'], ['原始时间', `${event.timestamp_local} · ${event.first_listen_ms}`]]
  if (event.status === 'conflict') entries.push(['时间差异', '多次查询的首次时间不一致，日历保留最早采集的版本。所有版本：' + event.observations.map(o => `${o.upstream_date || o.first_listen_ms}`).join('；')])
  for (const [title, text] of entries) { const div = node('div'); div.append(node('dt', '', title), node('dd', '', text)); dl.append(div) }
  $('songLink').href = `https://music.163.com/#/song?id=${encodeURIComponent(event.song_id)}`
  $('songDialog').showModal()
}
async function loadEvents() {
  const id = ++state.request
  if (!state.account) { state.events = []; renderCalendar(); renderDay(); return }
  const params = new URLSearchParams()
  if (state.query.trim()) params.set('q', state.query.trim())
  else params.set('month', state.month)
  try {
    const result = await api('/api/events?' + params)
    if (id !== state.request) return
    state.events = result.events
    renderCalendar(); renderDay()
  } catch (err) { if (id === state.request) toast(err.message) }
}
async function loadStatus(force = false) {
  const old = state.status
  const status = await api('/api/status')
  state.status = status
  state.account = status.account
  if (!state.initialized && status.account) {
    state.initialized = true
    const months = status.calendar.months
    if (months.length && !months.includes(state.month)) {
      state.month = months[months.length - 1]
      state.selected = status.calendar.latest
    }
    force = true
  }
  renderStatus()
  if (force || old?.stats?.available !== status.stats.available || old?.stats?.conflicts !== status.stats.conflicts) await loadEvents()
}
async function connect() {
  $('connectButton').disabled = true
  $('connectButton').textContent = '正在连接…'
  try { await api('/api/connect', {}); state.initialized = false; await loadStatus(true); toast('账号已连接，音乐档案保存在本机') }
  catch (err) { toast(err.message); renderStatus() }
}
function openCollect() {
  if (!state.account) { connect().then(() => { if (state.account) $('collectDialog').showModal() }); return }
  $('collectError').textContent = ''
  renderStatus()
  $('collectDialog').showModal()
}
async function moveMonth(offset) {
  const [y, m] = state.month.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1 + offset, 1))
  state.month = date.toISOString().slice(0, 7)
  state.selected = state.month + '-01'
  await loadEvents()
}
$('connectButton').addEventListener('click', connect)
$('collectButton').addEventListener('click', openCollect)
$('closeCollect').addEventListener('click', () => $('collectDialog').close())
$('closeSong').addEventListener('click', () => $('songDialog').close())
$('previousMonth').addEventListener('click', () => moveMonth(-1))
$('nextMonth').addEventListener('click', () => moveMonth(1))
$('monthPicker').addEventListener('change', async event => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) return
  state.month = event.target.value; state.selected = state.month + '-01'; await loadEvents()
})
$('todayButton').addEventListener('click', async () => { state.month = today.slice(0, 7); state.selected = today; await loadEvents() })
$('songSearch').addEventListener('input', event => {
  state.query = event.target.value
  clearTimeout(searchTimer)
  searchTimer = setTimeout(loadEvents, 220)
})
$('collectForm').addEventListener('submit', async event => {
  event.preventDefault()
  $('startCollect').disabled = true
  $('collectError').textContent = ''
  try {
    await api('/api/sync', { limit: Number($('batchLimit').value), playlists: $('includePlaylists').checked, retry_empty: $('retryEmpty').checked })
    $('collectDialog').close(); await loadStatus(true)
  } catch (err) { $('collectError').textContent = err.message; $('startCollect').disabled = false }
})
$('pauseButton').addEventListener('click', async () => {
  try { await api('/api/sync/pause', {}); toast('正在暂停，当前请求完成后会保存进度'); await loadStatus() }
  catch (err) { toast(err.message) }
})
for (const id of ['exportJson', 'exportCsv']) $(id).addEventListener('click', e => { if (!state.account) { e.preventDefault(); toast('请先连接账号') } })
renderStatus(); renderCalendar(); renderDay()
loadStatus(true).then(() => { if (!state.account) connect() }).catch(err => toast(err.message))
setInterval(() => loadStatus().catch(() => {}), 5000)
