'use strict'
const $ = id => document.getElementById(id)
const state = { month: '', selected: '', events: [], account: null, status: null, query: '', initialized: false, request: 0, loading: true }
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]))
const today = `${parts.year}-${parts.month}-${parts.day}`
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
const SVG = 'http://www.w3.org/2000/svg'
state.month = today.slice(0, 7)
state.selected = today
let toastTimer, searchTimer

function node(tag, className, text) {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}
function icon(path) {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('aria-hidden', 'true')
  const p = document.createElementNS(SVG, 'path')
  p.setAttribute('d', path)
  svg.append(p)
  return svg
}
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let result = {}
  try { result = await response.json() } catch { if (response.ok) throw new Error('收到了无法识别的响应，请刷新页面重试') }
  if (!response.ok) throw new Error(result.error || '操作没有完成，请稍后再试')
  return result
}
function toast(message) {
  $('toast').textContent = message
  $('toast').hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { $('toast').hidden = true }, 6000)
}
function dayLabel(date, year = false) {
  const [y, m, d] = date.split('-').map(Number)
  return `${year ? `${y} 年 ` : ''}${m} 月 ${d} 日`
}
function weekday(date) {
  const [y, m, d] = date.split('-').map(Number)
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}
function heat(count) { return count >= 5 ? 'l4' : count >= 3 ? 'l3' : count === 2 ? 'l2' : 'l1' }
function n(value) { return (value || 0).toLocaleString('zh-CN') }
function running() { return state.status?.run?.status === 'running' }

function renderStatus() {
  const status = state.status || {}, stats = status.stats || {}, calendar = status.calendar || {}
  $('accountLabel').textContent = state.account ? state.account.nickname : '未连接'
  $('accountLabel').classList.toggle('connected', Boolean(state.account))
  $('accountLabel').title = state.account ? '已连接的网易云音乐账号' : ''
  $('connectButton').textContent = state.account ? '重新连接' : '连接网易云'
  $('connectButton').disabled = running()
  $('collectButton').textContent = running() ? '同步中…' : '同步歌曲'
  $('availableCount').textContent = n(stats.available)
  $('daysCount').textContent = n(calendar.days)
  $('discoveredCount').textContent = n(stats.discovered)
  $('dateRange').textContent = calendar.earliest ? `${calendar.earliest.replaceAll('-', '.')} – ${calendar.latest.replaceAll('-', '.')}` : '还没有记录'
  $('coverageText').textContent = stats.discovered ? `${n(stats.pending)} 首待查询 · ${n(stats.empty)} 首暂无记录` : '来自你的网易云曲库'
  $('queriedCount').replaceChildren(document.createTextNode(n(stats.queried)), node('span', 'fraction', ` / ${n(stats.discovered)}`))
  $('coverageProgress').max = stats.discovered || 1
  $('coverageProgress').value = stats.queried || 0
  $('runLabel').textContent = '查询进度'
  $('qualityText').textContent = stats.failed || stats.conflicts
    ? `${n(stats.failed)} 首查询失败 · ${n(stats.conflicts)} 首时间有出入`
    : stats.queried ? '查询过的歌曲都没有出错' : '没有记录的歌曲会保留，之后可以再查'
  const run = status.run
  $('runNotice').hidden = !run
  $('runNotice').dataset.status = run ? run.status : ''
  $('runMessage').textContent = run ? (running() ? '正在同步 · ' : '') + run.phase + (run.error ? ` · ${run.error}` : '') : ''
  $('pauseButton').hidden = !running()
  $('startCollect').disabled = running()
  $('startCollect').textContent = running() ? '正在同步中…' : '开始同步'
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
  $('monthCount').textContent = state.query.trim() ? `本月有 ${thisMonth.length} 首匹配` : `本月 ${thisMonth.length} 首初听`
  const first = new Date(Date.UTC(year, month - 1, 1))
  const offset = (first.getUTCDay() + 6) % 7
  const grid = $('calendarGrid')
  grid.setAttribute('aria-busy', String(state.loading))
  grid.replaceChildren()
  for (let i = 0; i < 42; i++) {
    const date = new Date(Date.UTC(year, month - 1, 1 - offset + i))
    const iso = date.toISOString().slice(0, 10)
    const songs = grouped.get(iso) || []
    const cell = node('button', 'date-cell')
    cell.type = 'button'
    if (!iso.startsWith(state.month)) cell.classList.add('other-month')
    if (songs.length) cell.classList.add('has-events', heat(songs.length))
    if (iso === state.selected) cell.classList.add('selected')
    if (iso === today) cell.classList.add('today')
    cell.setAttribute('aria-label', `${dayLabel(iso, true)}${iso === today ? '（今天）' : ''}，${songs.length ? `${songs.length} 首初听` : '暂无初听记录'}`)
    cell.setAttribute('aria-pressed', String(iso === state.selected))
    const top = node('span', 'date-top')
    top.append(node('span', 'date-number', date.getUTCDate()))
    if (songs.length) top.append(node('span', 'date-count', songs.length))
    cell.append(top)
    for (const song of songs.slice(0, 2)) cell.append(node('span', 'date-song', song.name))
    if (songs.length > 2) cell.append(node('span', 'date-more', `还有 ${songs.length - 2} 首`))
    cell.addEventListener('click', async () => {
      state.selected = iso
      if (!iso.startsWith(state.month)) { state.month = iso.slice(0, 7); await loadEvents() }
      else { renderCalendar(); renderDay() }
    })
    grid.append(cell)
  }
}
function emptyState(title, text, label, action) {
  const empty = node('div', 'empty-state')
  empty.append(node('span', 'empty-mark'), node('h3', '', title), node('p', '', text))
  if (label) {
    const button = node('button', 'button ghost small', label)
    button.type = 'button'
    button.addEventListener('click', action)
    empty.append(button)
  }
  return empty
}
function renderDay() {
  const search = state.query.trim()
  const events = search ? [...state.events].reverse() : state.events.filter(e => e.date === state.selected)
  $('dayEyebrow').textContent = search ? '全部月份' : state.selected === today ? `今天 · ${weekday(state.selected)}` : `${state.selected.slice(0, 4)} 年 · ${weekday(state.selected)}`
  $('dayTitle').textContent = search ? `搜索「${search}」` : dayLabel(state.selected)
  $('daySubtitle').textContent = state.loading ? '正在读取…' : search ? `找到 ${events.length} 首` : events.length ? `这天第一次听见了 ${events.length} 首歌` : '暂无初听记录'
  const list = $('songList')
  list.setAttribute('aria-busy', String(state.loading))
  list.replaceChildren()
  if (state.loading) {
    for (let i = 0; i < 3; i++) { const row = node('div', 'skeleton'); row.setAttribute('aria-hidden', 'true'); row.append(node('i'), node('i')); list.append(row) }
    return
  }
  if (!events.length) {
    if (search) list.append(emptyState('没有找到相关歌曲', '换个歌名或歌手试试，或者再同步一些歌曲。', '同步更多歌曲', openCollect))
    else if (state.account) list.append(emptyState('这一天还没有初听记录', '可能是还没同步到，也可能那天没有遇见新歌。', '同步更多歌曲', openCollect))
    else list.append(emptyState('从连接账号开始', '连接网易云音乐账号后，就能把每首歌的初听时间整理成日历。数据只保存在本机。', '连接网易云音乐', connect))
    return
  }
  for (const event of events) {
    const row = node('button', 'song-row')
    row.type = 'button'
    row.setAttribute('aria-label', `${event.name}，${event.artists || '歌手未知'}，${search ? dayLabel(event.date, true) + ' ' : ''}${event.time} 初听，查看详情`)
    const copy = node('span', 'song-copy')
    copy.append(node('span', 'song-name', event.name), node('span', 'song-artist', event.artists || '歌手未知'))
    if (search) copy.append(node('span', 'song-date', dayLabel(event.date, true)))
    if (event.status === 'conflict') copy.append(node('span', 'song-date warning', '初听时间有出入，点开查看'))
    const arrow = node('span', 'song-arrow')
    arrow.append(icon('m6 3 5 5-5 5'))
    row.append(node('time', 'song-time', event.time), copy, arrow)
    row.querySelector('time').dateTime = `${event.date}T${event.time}+08:00`
    row.addEventListener('click', () => showSong(event))
    list.append(row)
  }
}
function showSong(event) {
  $('detailName').textContent = event.name
  $('detailArtists').textContent = event.artists || '歌手未知'
  const dl = $('detailFacts')
  dl.replaceChildren()
  const entries = [
    ['初听时间', `${dayLabel(event.date, true)} ${weekday(event.date)} ${event.time}（北京时间）`],
    ['累计播放', event.play_count == null ? '暂无数据' : `${event.play_count.toLocaleString('zh-CN')} 次（网易云累计统计）`],
    ['数据来源', '网易云音乐 · 回忆坐标'],
    ['原始时间戳', `${event.timestamp_local}\n${event.first_listen_ms}`, 'mono'],
  ]
  if (event.status === 'conflict') entries.push(['时间有出入', '多次查询得到的初听时间不一致，日历按最早同步到的版本显示。全部版本：' + event.observations.map(o => `${o.upstream_date || o.first_listen_ms}`).join('；')])
  for (const [title, text, cls] of entries) {
    const div = node('div'), dd = node('dd', cls || '')
    for (const [i, line] of text.split('\n').entries()) { if (i) dd.append(node('br')); dd.append(document.createTextNode(line)) }
    div.append(node('dt', '', title), dd)
    dl.append(div)
  }
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
  const firstLoad = state.loading
  state.loading = false
  if (firstLoad || force || old?.stats?.available !== status.stats.available || old?.stats?.conflicts !== status.stats.conflicts) await loadEvents()
}
async function connect() {
  $('connectButton').disabled = true
  $('connectButton').textContent = '连接中…'
  try { await api('/api/connect', {}); state.initialized = false; await loadStatus(true); toast('已连接，数据只保存在这台电脑上') }
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
for (const id of ['collectDialog', 'songDialog']) $(id).addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close() })
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
  try { await api('/api/sync/pause', {}); toast('正在暂停，当前这首查完就停，进度会保存'); await loadStatus() }
  catch (err) { toast(err.message) }
})
for (const id of ['exportJson', 'exportCsv']) $(id).addEventListener('click', e => { if (!state.account) { e.preventDefault(); toast('请先连接网易云音乐账号') } })
renderStatus(); renderCalendar(); renderDay()
loadStatus(true).then(() => { if (!state.account) connect() }).catch(err => { state.loading = false; renderCalendar(); renderDay(); toast(err.message) })
setInterval(() => loadStatus().catch(() => {}), 5000)
