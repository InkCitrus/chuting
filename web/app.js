'use strict'
import { createBackend, remote } from './backend.js'
const backendReady = createBackend()
const $ = id => document.getElementById(id)
const SVG = 'http://www.w3.org/2000/svg'
const MONTHS = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
const BATCH = 160 // songs rendered per batch; later months render as you scroll
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]))
const today = `${parts.year}-${parts.month}-${parts.day}`
const motion = !matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window
let storedOrder = 'newest'
try { storedOrder = localStorage.getItem('chuting-order') === 'oldest' ? 'oldest' : 'newest' } catch {}

const state = {
  account: null, status: null, initialized: false, loading: true, error: '',
  all: [], results: null, query: '', order: storedOrder, request: 0,
  view: [], chapters: [], rendered: 0, active: '',
}
let toastTimer, searchTimer, revealObserver, chapterObserver, sentinelObserver

/* ---------- 小工具 ---------- */
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
// Builds a sentence from plain strings and [text, className] pieces, never via innerHTML.
function sentence(target, pieces) {
  target.replaceChildren(...pieces.map(p => Array.isArray(p) ? node('b', p[1] || 'num', p[0]) : document.createTextNode(p)))
}
async function api(path, body) {
  return (await backendReady).api(path, body)
}
function toast(message) {
  $('toast').textContent = message
  $('toast').hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { $('toast').hidden = true }, 6000)
}
const n = value => (value || 0).toLocaleString('zh-CN')
const ymd = date => date.split('-').map(Number)
function dayLabel(date, year = false) { const [y, m, d] = ymd(date); return `${year ? `${y} 年 ` : ''}${m} 月 ${d} 日` }
function weekday(date) { const [y, m, d] = ymd(date); return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] }
function running() { return state.status?.run?.status === 'running' }
function partOfDay(time) { const h = Number(time.slice(0, 2)); return h < 6 ? '凌晨' : h < 12 ? '上午' : h < 18 ? '下午' : '晚上' }

/* ---------- 叙事文案 ---------- */
function monthStory(events, search) {
  const days = new Map(), artists = new Map(), periods = new Map()
  for (const e of events) {
    days.set(e.date, (days.get(e.date) || 0) + 1)
    for (const a of (e.artists || '').split(' / ').filter(Boolean)) artists.set(a, (artists.get(a) || 0) + 1)
    const p = partOfDay(e.time); periods.set(p, (periods.get(p) || 0) + 1)
  }
  if (search) return [`这个月有 `, [n(events.length)], ` 首和「${search}」有关。`]
  const pieces = [`你在 `, [n(days.size)], ` 个日子里，遇见了 `, [n(events.length)], ` 首新歌。`]
  const [busyDay, busyCount] = [...days].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
  if (days.size === 1) pieces.push(`它们都发生在 ${dayLabel(busyDay)}。`)
  else if (busyCount > 1) pieces.push(`最忙的一天是 `, [dayLabel(busyDay), 'mark'], `，一口气遇见了 ${busyCount} 首`)
  else pieces.push('每天只遇见一首，细水长流')
  const [artist, artistCount] = [...artists].sort((a, b) => b[1] - a[1])[0] || []
  if (artistCount >= 2) pieces.push(days.size === 1 ? '' : '；', [artist, 'mark'], ` 出现得最多`)
  if (days.size !== 1 || artistCount >= 2) pieces.push('。')
  const [period, periodCount] = [...periods].sort((a, b) => b[1] - a[1])[0]
  if (events.length >= 4 && periodCount / events.length >= .5) pieces.push(`大多数初听发生在${period}。`)
  return pieces
}

/* ---------- 顶部与开场 ---------- */
function renderStatus() {
  const status = state.status || {}, stats = status.stats || {}, calendar = status.calendar || {}, run = status.run
  $('accountLabel').textContent = state.account ? state.account.nickname : '未连接'
  $('accountLabel').classList.toggle('connected', Boolean(state.account))
  $('connectButton').textContent = state.account ? '重新连接' : '连接网易云'
  $('connectButton').disabled = running()
  $('syncButton').textContent = running() ? '同步中…' : '同步歌曲'
  $('syncButton').classList.toggle('is-running', running())
  $('startCollect').disabled = running()
  $('startCollect').textContent = running() ? '正在同步中…' : '开始同步'
  for (const id of ['exportJson', 'exportCsv']) {
    $(id).setAttribute('aria-disabled', String(!state.account))
    $(id).tabIndex = state.account ? 0 : -1
  }

  const story = $('heroStory'), sub = $('heroSub'), action = $('heroAction')
  story.classList.toggle('is-loading', state.loading)
  $('heroKicker').textContent = state.account ? `网易云音乐 · ${state.account.nickname} 的初听档案` : '网易云音乐 · 初听档案'
  action.hidden = true
  $('heroLatest').hidden = true
  $('scrollCue').hidden = true
  if (state.loading) {
    story.replaceChildren(node('span', 'skeleton-line'), node('span', 'skeleton-line short'))
    sub.textContent = '正在翻开你的初听…'
  } else if (!state.account) {
    sentence(story, ['每首歌，都有第一次听见的那天。', ['连接网易云音乐', 'mark'], '，把它们一首首找回来，写成你自己的时间线。'])
    sub.textContent = state.local ? '档案保存在当前浏览器中。已有本地档案可在页底导入。' : '数据只保存在这台电脑上，登录只在同步时用到。'
    action.textContent = '连接网易云音乐'; action.hidden = false; action.dataset.action = 'connect'
  } else if (!stats.available) {
    sentence(story, ['故事还没开始。', ['同步一批歌曲', 'mark'], '，看看你和它们是哪天遇见的。'])
    sub.textContent = stats.discovered ? `已经发现 ${n(stats.discovered)} 首歌，其中 ${n(stats.pending)} 首等着查询。` : '会从最近播放、听歌排行、喜欢的歌曲和你的歌单里找歌。'
    action.textContent = '开始同步'; action.hidden = false; action.dataset.action = 'sync'
  } else {
    const [ey, em, ed] = ymd(calendar.earliest), [ly, lm, ld] = ymd(calendar.latest)
    const from = `${ey} 年 ${em} 月 ${ed} 日`, to = ey === ly ? `${lm} 月 ${ld} 日` : `${ly} 年 ${lm} 月 ${ld} 日`
    const first = state.all[0]
    const latest = state.all[state.all.length - 1]
    if (latest) {
      $('heroLatest').hidden = false
      $('heroLatest').dataset.index = String(state.all.length - 1)
      $('heroLatest').setAttribute('aria-label', `最近一次初听：${latest.name}，${dayLabel(latest.date)} ${latest.time}，查看详情`)
      $('latestTime').textContent = latest.time
      $('latestTitle').textContent = latest.name
      $('latestMeta').textContent = `${latest.artists || '歌手未知'} · ${dayLabel(latest.date)}`
    }
    const pieces = ['从 ', [from, 'mark'], ' 到 ', [to, 'mark'], '，你在 ', [n(calendar.days)], ' 个日子里，第一次听见了 ', [n(stats.available)], ' 首歌。']
    if (first) pieces.push('最早的一首是', [`《${first.name}》`, 'mark wrap'], '。')
    sentence(story, pieces)
    sub.textContent = `已查询 ${n(stats.queried)} / ${n(stats.discovered)} 首` + (stats.pending ? `，还有 ${n(stats.pending)} 首等着同步` : '，已发现的歌都查完了') + (stats.empty ? ` · ${n(stats.empty)} 首暂无记录` : '') + (stats.failed ? ` · ${n(stats.failed)} 首查询失败` : '')
    $('scrollCue').hidden = false
    $('scrollCueText').textContent = state.order === 'newest' ? '最近的一首' : '最早的一首'
  }

  const line = $('syncLine')
  line.hidden = !state.account || (!run && !stats.discovered)
  line.dataset.status = run ? run.status : 'idle'
  $('syncMessage').textContent = run ? (running() ? '正在同步 · ' : '') + run.phase + (run.error ? ` · ${run.error}` : '') : '还没有同步过'
  $('pauseButton').hidden = !running()
  $('coverageProgress').max = stats.discovered || 1
  $('coverageProgress').value = stats.queried || 0
}

/* ---------- 时间线 ---------- */
function buildChapters(events) {
  const months = new Map()
  for (const e of events) {
    const key = e.date.slice(0, 7)
    if (!months.has(key)) months.set(key, new Map())
    const days = months.get(key)
    if (!days.has(e.date)) days.set(e.date, [])
    days.get(e.date).push(e)
  }
  const keys = [...months.keys()].sort()
  if (state.order === 'newest') keys.reverse()
  return keys.map(key => {
    const dayKeys = [...months.get(key).keys()].sort()
    if (state.order === 'newest') dayKeys.reverse()
    const days = dayKeys.map(date => ({ date, songs: months.get(key).get(date) }))
    return { key, days, count: days.reduce((sum, d) => sum + d.songs.length, 0) }
  })
}
function renderTimeline() {
  const search = state.query.trim()
  state.view = search ? state.results || [] : state.all
  state.view.forEach((e, i) => { e.index = i })
  state.chapters = buildChapters(state.view)
  state.rendered = 0
  state.active = ''
  $('timelineTitle').textContent = search ? `搜索「${search}」` : '时间线'
  $('timelineMeta').textContent = state.loading ? '' : search ? `找到 ${n(state.view.length)} 首` : state.view.length ? `${n(state.chapters.length)} 个月 · ${n(state.view.length)} 首初听` : ''
  for (const [id, order] of [['orderNewest', 'newest'], ['orderOldest', 'oldest']]) $(id).setAttribute('aria-pressed', String(state.order === order))
  chapterObserver?.disconnect()
  const timeline = $('timeline')
  timeline.setAttribute('aria-busy', String(state.loading))
  timeline.classList.toggle('compact', Boolean(search))
  timeline.replaceChildren()
  renderScrubber()
  if (state.loading) {
    for (let i = 0; i < 4; i++) { const row = node('div', 'skeleton-row'); row.setAttribute('aria-hidden', 'true'); row.append(node('i'), node('i')); timeline.append(row) }
    return
  }
  if (state.error) return timeline.append(emptyBlock('时间线没能加载', state.error, '重新加载', () => loadEvents(true)))
  if (!state.view.length) {
    if (search) return timeline.append(emptyBlock('没有找到相关歌曲', '换个歌名或歌手试试，或者再同步一些歌曲。', '同步更多歌曲', openCollect))
    if (state.account) return timeline.append(emptyBlock('这里还是空白的一页', '同步之后，每一首初听都会按月份和日子排在这里。', '同步歌曲', openCollect))
    return timeline.append(emptyBlock('从连接账号开始', '连接网易云音乐账号后，初听会按时间一首首排在这里。', '连接网易云音乐', connect))
  }
  renderMore()
}
function renderMore(untilKey) {
  const timeline = $('timeline')
  let added = 0
  while (state.rendered < state.chapters.length && (added < BATCH || (untilKey && !$(`m-${untilKey}`)))) {
    const chapter = state.chapters[state.rendered++]
    timeline.append(renderChapter(chapter))
    added += chapter.count
  }
  $('timeline').querySelector('.timeline-end')?.remove()
  if (state.rendered >= state.chapters.length) timeline.append(renderEnd())
  observe()
}
function renderChapter(chapter) {
  const [y, m] = ymd(chapter.key)
  const search = state.query.trim()
  const section = node('section', 'chapter')
  section.id = `m-${chapter.key}`
  section.dataset.month = chapter.key
  section.setAttribute('aria-label', `${y} 年 ${MONTHS[m - 1]}`)
  const head = node('header', 'chapter-head reveal')
  const numeral = node('span', 'chapter-numeral', String(m).padStart(2, '0'))
  numeral.setAttribute('aria-hidden', 'true')
  const text = node('div', 'chapter-text')
  text.append(node('p', 'chapter-year', `${y} 年`))
  const title = node('h3', 'chapter-title', MONTHS[m - 1])
  title.append(node('span', 'chapter-count', `${n(chapter.count)} 首${search ? '匹配' : '初听'}`))
  const story = node('p', 'chapter-story')
  sentence(story, monthStory(chapter.days.flatMap(d => d.songs), search))
  text.append(title, story)
  head.append(numeral, text)
  const days = node('ol', 'days')
  for (const day of chapter.days) days.append(renderDay(day))
  section.append(head, days)
  return section
}
function renderDay(day) {
  const [, m, d] = ymd(day.date)
  const item = node('li', 'day reveal')
  const label = node('div', 'day-label')
  const num = node('span', 'day-num', d)
  const meta = node('span', 'day-meta', `${m} 月 · ${weekday(day.date)}`)
  label.append(num, meta)
  if (day.date === today) label.append(node('span', 'day-tag', '今天'))
  label.append(node('span', 'day-count', `${day.songs.length} 首`))
  const songs = node('ol', 'songs')
  for (const event of day.songs) {
    const li = node('li')
    const button = node('button', 'song')
    button.type = 'button'
    button.dataset.index = String(event.index)
    button.setAttribute('aria-label', `${event.time}，${event.name}，${event.artists || '歌手未知'}${event.status === 'conflict' ? '，初听时间有出入' : ''}，查看详情`)
    const time = node('time', 'song-time', event.time)
    time.dateTime = `${event.date}T${event.time}+08:00`
    const main = node('span', 'song-main')
    main.append(node('span', 'song-title', event.name), node('span', 'song-artist', event.artists || '歌手未知'))
    if (event.status === 'conflict') main.append(node('span', 'flag', '时间有出入'))
    button.append(time, main)
    const arrow = node('span', 'song-arrow'); arrow.append(icon('m6 3 5 5-5 5')); button.append(arrow)
    li.append(button)
    songs.append(li)
  }
  item.append(label, songs)
  return item
}
function renderEnd() {
  const end = node('div', 'timeline-end reveal')
  const search = state.query.trim()
  if (search) { end.append(node('p', '', '搜索结果到这里就是全部了。')); return end }
  const stats = state.status?.stats || {}
  end.append(node('span', 'end-mark'), node('p', 'end-title', state.order === 'newest' ? '最早的记录到这里为止。' : '故事暂时写到这里。'))
  end.append(node('p', 'end-copy', stats.pending ? `还有 ${n(stats.pending)} 首歌没有查询，更多初听也许还在等着被找回。` : '之后听到的新歌，同步一下就会续写在这里。'))
  if (stats.pending) { const b = node('button', 'button ghost', '继续同步'); b.type = 'button'; b.addEventListener('click', openCollect); end.append(b) }
  return end
}
function emptyBlock(title, text, label, action) {
  const box = node('div', 'empty-block')
  box.append(node('span', 'end-mark'), node('h3', '', title), node('p', '', text))
  const button = node('button', 'button ghost', label)
  button.type = 'button'
  button.addEventListener('click', action)
  box.append(button)
  return box
}
function renderScrubber() {
  const nav = $('scrubber')
  nav.replaceChildren()
  nav.hidden = state.loading || !state.chapters.length
  const list = node('ol')
  let year = ''
  for (const chapter of state.chapters) {
    const [y, m] = chapter.key.split('-')
    if (y !== year) { year = y; const yl = node('li', 'scrub-year', `${y}`); yl.setAttribute('aria-hidden', 'true'); list.append(yl) }
    const li = node('li')
    const button = node('button', 'scrub-month')
    button.type = 'button'
    button.dataset.month = chapter.key
    button.setAttribute('aria-label', `跳到 ${y} 年 ${MONTHS[Number(m) - 1]}，${chapter.count} 首`)
    button.append(node('span', 'scrub-name', MONTHS[Number(m) - 1]), node('span', 'scrub-count', n(chapter.count)))
    li.append(button)
    list.append(li)
  }
  nav.append(list)
}
function jumpTo(key) {
  if (!$(`m-${key}`)) renderMore(key)
  const target = $(`m-${key}`)
  if (!target) return
  for (const el of target.querySelectorAll('.reveal')) el.classList.add('shown')
  state.jumpLock = Date.now() + 1200
  target.scrollIntoView({ behavior: motion ? 'smooth' : 'auto', block: 'start' })
  setActive(key)
}
function setActive(key) {
  if (state.active === key) return
  state.active = key
  for (const b of $('scrubber').querySelectorAll('.scrub-month')) {
    const on = b.dataset.month === key
    b.classList.toggle('active', on)
    if (on) { b.setAttribute('aria-current', 'true'); if (matchMedia('(max-width: 900px)').matches) b.scrollIntoView({ block: 'nearest', inline: 'center' }) }
    else b.removeAttribute('aria-current')
  }
}
function observe() {
  if (!('IntersectionObserver' in window)) return
  for (const el of $('timeline').querySelectorAll('.reveal:not(.observed)')) {
    el.classList.add('observed')
    if (motion) revealObserver.observe(el); else el.classList.add('shown')
  }
  for (const el of $('timeline').querySelectorAll('.chapter')) chapterObserver.observe(el)
}

/* ---------- 歌曲详情 ---------- */
function showSong(event) {
  $('detailKicker').textContent = `初听档案 · ${dayLabel(event.date, true)}`
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
  if (event.status === 'conflict') entries.push(['时间有出入', '多次查询得到的初听时间不一致，时间线按最早同步到的版本显示。全部版本：' + event.observations.map(o => `${o.upstream_date || o.first_listen_ms}`).join('；')])
  for (const [title, text, cls] of entries) {
    const div = node('div'), dd = node('dd', cls || '')
    for (const [i, line] of text.split('\n').entries()) { if (i) dd.append(node('br')); dd.append(document.createTextNode(line)) }
    div.append(node('dt', '', title), dd)
    dl.append(div)
  }
  $('songLink').href = `https://music.163.com/#/song?id=${encodeURIComponent(event.song_id)}`
  $('songDialog').showModal()
}

/* ---------- 数据加载 ---------- */
async function loadEvents(all = false) {
  const id = ++state.request
  if (!state.account) { state.all = []; state.results = null; state.error = ''; renderStatus(); renderTimeline(); return }
  const search = state.query.trim()
  try {
    if (all || !search) {
      const result = await api('/api/events')
      if (id !== state.request) return
      state.all = result.events
    }
    if (search) {
      const result = await api('/api/events?' + new URLSearchParams({ q: search }))
      if (id !== state.request) return
      state.results = result.events
    }
    state.error = ''
  } catch (err) {
    if (id !== state.request) return
    state.error = err.message
    toast(err.message)
  }
  renderStatus(); renderTimeline()
}
async function loadStatus(force = false) {
  const old = state.status
  const status = await api('/api/status')
  state.status = status
  state.account = status.account
  if (!state.initialized && status.account) { state.initialized = true; force = true }
  const firstLoad = state.loading
  state.loading = false
  renderStatus()
  if (firstLoad || force || old?.stats?.available !== status.stats.available || old?.stats?.conflicts !== status.stats.conflicts) await loadEvents(true)
  else if (old?.run?.status !== status.run?.status || old?.stats?.pending !== status.stats.pending) $('timeline').querySelector('.timeline-end')?.replaceWith(renderEnd())
}
async function connect() {
  $('connectButton').disabled = true
  $('connectButton').textContent = '连接中…'
  try {
    const backend = await backendReady
    if (backend.local) {
      if (!backend.configured) throw new Error('部署者尚未配置 SESSION_SECRET，仍可导入并浏览本地档案')
      if (backend.sync.task) throw new Error('请先暂停同步，再连接账号')
      await backend.connect(await qrLogin())
    } else await api('/api/connect', {})
    state.initialized = false; await loadStatus(true); toast('已连接，档案保存在本地')
  }
  catch (err) { toast(err.message); renderStatus() }
}
function qrLogin() {
  const dialog = $('loginDialog')
  dialog.showModal()
  return new Promise((resolve, reject) => {
    let ticket, timer, generation = 0, done = false
    const cleanup = () => { done = true; clearTimeout(timer); $('refreshQr').removeEventListener('click', refresh); dialog.removeEventListener('close', cancel) }
    const cancel = () => { cleanup(); reject(new Error('已取消连接')) }
    dialog.addEventListener('close', cancel, { once: true })
    async function poll(version) {
      if (done || generation !== version) return
      try {
        const result = await remote('/api/auth/check', { ticket })
        if (done || generation !== version) return
        if (result.code === 803) { cleanup(); dialog.close(); resolve(result.account); return }
        $('loginStatus').textContent = result.code === 802 ? '已扫码，请在网易云 App 中确认' : result.code === 800 ? '二维码已过期，请刷新' : '等待扫码…'
        if (result.code !== 800) timer = setTimeout(() => poll(version), 2500)
      } catch (err) { if (!done && generation === version) $('loginStatus').textContent = err.message + '，可刷新二维码重试' }
    }
    async function refresh() {
      const version = ++generation
      clearTimeout(timer); $('loginQr').hidden = true; $('loginStatus').textContent = '正在生成二维码…'
      try {
        const result = await remote('/api/auth/key', {})
        if (done || generation !== version) return
        ticket = result.ticket; $('loginQr').src = result.image; $('loginQr').hidden = false; $('loginStatus').textContent = '等待扫码…'
        timer = setTimeout(() => poll(version), 2500)
      } catch (err) { if (!done && generation === version) $('loginStatus').textContent = err.message }
    }
    $('refreshQr').addEventListener('click', refresh)
    refresh()
  })
}
function openCollect() {
  if (!state.account) { connect().then(() => { if (state.account) $('collectDialog').showModal() }); return }
  $('collectError').textContent = ''
  renderStatus()
  $('collectDialog').showModal()
}
function setOrder(order) {
  if (state.order === order) return
  state.order = order
  try { localStorage.setItem('chuting-order', order) } catch {}
  renderStatus(); renderTimeline()
}

/* ---------- 事件 ---------- */
if ('IntersectionObserver' in window) {
  revealObserver = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('shown'); revealObserver.unobserve(e.target) }
  }, { rootMargin: '0px 0px -8% 0px' })
  chapterObserver = new IntersectionObserver(entries => {
    if (Date.now() < (state.jumpLock || 0)) return
    for (const e of entries) if (e.isIntersecting) setActive(e.target.dataset.month)
  }, { rootMargin: '-35% 0px -60% 0px' })
  sentinelObserver = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting) && state.rendered < state.chapters.length) renderMore()
  }, { rootMargin: '800px 0px' })
  sentinelObserver.observe($('sentinel'))
}
if (motion) document.documentElement.classList.add('motion')
$('connectButton').addEventListener('click', connect)
$('syncButton').addEventListener('click', openCollect)
$('heroAction').addEventListener('click', e => e.currentTarget.dataset.action === 'connect' ? connect() : openCollect())
$('closeCollect').addEventListener('click', () => $('collectDialog').close())
$('closeSong').addEventListener('click', () => $('songDialog').close())
for (const id of ['collectDialog', 'songDialog']) $(id).addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close() })
$('orderNewest').addEventListener('click', () => setOrder('newest'))
$('orderOldest').addEventListener('click', () => setOrder('oldest'))
$('timeline').addEventListener('click', e => {
  const button = e.target.closest('.song')
  if (button) showSong(state.view[Number(button.dataset.index)])
})
$('heroLatest').addEventListener('click', () => { const e = state.all[Number($('heroLatest').dataset.index)]; if (e) showSong(e) })
$('scrubber').addEventListener('click', e => { const b = e.target.closest('.scrub-month'); if (b) jumpTo(b.dataset.month) })
$('songSearch').addEventListener('input', event => {
  state.query = event.target.value
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { state.query.trim() ? loadEvents() : (state.results = null, renderTimeline()) }, 220)
})
$('collectForm').addEventListener('submit', async event => {
  event.preventDefault()
  $('startCollect').disabled = true
  $('collectError').textContent = ''
  try {
    await api('/api/sync', { limit: Number($('batchLimit').value), playlists: $('includePlaylists').checked, retry_empty: $('retryEmpty').checked,
      history: $('includeHistory').checked, history_from: $('historyFrom').value, concurrency: Number($('concurrency').value) })
    $('collectDialog').close(); await loadStatus(true)
  } catch (err) { $('collectError').textContent = err.message; $('startCollect').disabled = false }
})
$('pauseButton').addEventListener('click', async () => {
  try { await api('/api/sync/pause', {}); toast('正在暂停，当前这首查完就停，进度会保存'); await loadStatus() }
  catch (err) { toast(err.message) }
})
$('closeLogin').addEventListener('click', () => $('loginDialog').close())
$('importButton').addEventListener('click', () => $('importFile').click())
$('importQuick').addEventListener('click', () => $('importFile').click())
$('backupQuick').addEventListener('click', async () => {
  try { await (await backendReady).download('json') } catch (err) { toast(err.message) }
})
$('importFile').addEventListener('change', async event => {
  const file = event.target.files[0]
  if (!file) return
  try {
    if (file.size > 25 * 1024 * 1024) throw new Error('档案超过 25 MB，请拆分后导入')
    toast('正在导入档案，请稍候…')
    await (await backendReady).import(JSON.parse(await file.text()))
    state.initialized = false; await loadStatus(true); toast('档案已导入当前浏览器')
  } catch (err) { toast(err.message) }
  event.target.value = ''
})
for (const id of ['exportJson', 'exportCsv']) $(id).addEventListener('click', async e => {
  e.preventDefault()
  const href = e.currentTarget.href
  if (!state.account) { e.preventDefault(); toast('请先连接或导入档案'); return }
  try { const backend = await backendReady; if (backend.local) await backend.download(id === 'exportCsv' ? 'csv' : 'json'); else location.href = href }
  catch (err) { e.preventDefault(); toast(err.message) }
})
backendReady.then(backend => {
  if (!backend.local) return
  state.local = true
  $('importQuick').hidden = false; $('backupQuick').hidden = false
  $('importButton').hidden = false; $('cloudCollectOptions').hidden = false
  $('exportJson').textContent = '备份 JSON'
  $('storageNote').textContent = '档案保存在当前浏览器 · 建议定期备份 · 时间按北京时间显示'
  $('syncHint').textContent = '默认同时查 2 首，发起请求间隔至少 0.65 秒。网络错误会退避重试，限流立即停止。空结果满 30 天自动补查。关闭页面后暂停，再打开可继续。'
  for (let y = new Date().getFullYear(); y >= 2017; y--) { const option = node('option', '', String(y)); option.value = String(y); $('historyFrom').append(option) }
}).catch(() => {})
renderStatus(); renderTimeline()
loadStatus(true).then(async () => { if (!state.account && !(await backendReady).local) connect() }).catch(err => { state.loading = false; state.error = err.message; renderStatus(); renderTimeline(); toast(err.message) })
setInterval(() => loadStatus().catch(() => {}), 5000)
