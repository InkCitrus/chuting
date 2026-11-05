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
const reduced = matchMedia('(prefers-reduced-motion: reduce)')
let motion = !reduced.matches && 'IntersectionObserver' in window
const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches
let storedOrder = 'newest'
try { storedOrder = localStorage.getItem('chuting-order') === 'oldest' ? 'oldest' : 'newest' } catch {}

const state = {
  account: null, status: null, initialized: false, loading: true, error: '', local: false, online: false,
  all: [], results: null, query: '', order: storedOrder, request: 0,
  view: [], chapters: [], rendered: 0, active: '', counted: false, current: -1,
}
let toastTimer, searchTimer, revealObserver, chapterObserver, sentinelObserver, pollTimer

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
  target.replaceChildren(...pieces.filter(p => p !== '').map(p => Array.isArray(p) ? node('b', p[1] || 'num', p[0]) : document.createTextNode(p)))
}
async function api(path, body) {
  return (await backendReady).api(path, body)
}
function toast(message, tone = 'info') {
  const t = $('toast')
  t.textContent = message
  t.dataset.tone = tone
  t.setAttribute('role', tone === 'error' ? 'alert' : 'status')
  t.hidden = false
  t.classList.remove('leaving')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    if (!motion) { t.hidden = true; return }
    t.classList.add('leaving'); toastTimer = setTimeout(() => { t.hidden = true; t.classList.remove('leaving') }, 260)
  }, tone === 'error' ? 7000 : 4200)
}
const fail = err => toast(err.message, 'error')
const n = value => (value || 0).toLocaleString('zh-CN')
const ymd = date => date.split('-').map(Number)
function dayLabel(date, year = false) { const [y, m, d] = ymd(date); return `${year ? `${y} 年 ` : ''}${m} 月 ${d} 日` }
function weekday(date) { const [y, m, d] = ymd(date); return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] }
function running() { return state.status?.run?.status === 'running' }
function partOfDay(time) { const h = Number(time.slice(0, 2)); return h < 5 ? '凌晨' : h < 11 ? '上午' : h < 17 ? '下午' : '晚上' }
// Stable "album" colours: a song's hue follows its first artist, so one singer keeps one colour across the archive.
function hash(text) { let h = 2166136261; for (const c of String(text)) h = Math.imul(h ^ c.codePointAt(0), 16777619); return h >>> 0 }
function hues(event) {
  const artist = (event.artists || '').split(' / ')[0] || event.name || ''
  const base = hash(artist) % 360
  return [base, (base + 28 + hash(event.name || event.song_id) % 70) % 360]
}
function paint(el, [h1, h2]) { el.style.setProperty('--h', h1); el.style.setProperty('--h2', h2) }
function glyph(name) { return ([...(name || '').trim()][0] || '♪').toLocaleUpperCase() }
function highlight(target, text, query) {
  if (!query) { target.textContent = text; return target }
  const lower = text.toLocaleLowerCase(), q = query.toLocaleLowerCase()
  let at = 0, i
  while (q && (i = lower.indexOf(q, at)) !== -1) {
    if (i > at) target.append(text.slice(at, i))
    target.append(node('mark', '', text.slice(i, i + q.length)))
    at = i + q.length
  }
  if (at < text.length) target.append(text.slice(at))
  return target
}

/* ---------- 叙事文案 ---------- */
const PERIOD_LINE = { 凌晨: '大多是在凌晨遇见的，夜还很长。', 上午: '多半是在上午遇见的，像一天的开场曲。', 下午: '多半是在午后遇见的。', 晚上: '多半是在夜里遇见的。' }
function tally(events) {
  const days = new Map(), artists = new Map(), periods = new Map()
  for (const e of events) {
    days.set(e.date, (days.get(e.date) || 0) + 1)
    for (const a of (e.artists || '').split(' / ').filter(Boolean)) artists.set(a, (artists.get(a) || 0) + 1)
    const p = partOfDay(e.time); periods.set(p, (periods.get(p) || 0) + 1)
  }
  const top = map => [...map].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0] || []
  return { days, artists, periods, busy: top(days), artist: top(artists), period: top(periods) }
}
function monthStory(events, search) {
  if (search) return [`这个月有 `, [n(events.length)], ` 首和「${search}」有关。`]
  const { days, busy: [busyDay, busyCount], artist: [artist, artistCount], period: [period, periodCount] } = tally(events)
  const pieces = [`这个月，你在 `, [n(days.size)], ` 个日子里遇见了 `, [n(events.length)], ` 首新歌。`]
  if (days.size === 1) pieces.push(`它们都落在 ${dayLabel(busyDay)} 这一天`)
  else if (busyCount > 1) pieces.push(`最热闹的是 `, [dayLabel(busyDay), 'mark'], `，一天就遇见了 ${busyCount} 首`)
  else pieces.push('每天只遇见一首，细水长流')
  if (artistCount >= 2) pieces.push('；', [artist, 'mark'], ` 出现得最多`)
  pieces.push('。')
  if (events.length >= 4 && periodCount / events.length >= .5) pieces.push(PERIOD_LINE[period])
  return pieces
}

/* ---------- 顶部与开场 ---------- */
function countUp(root) {
  if (!motion) return
  for (const b of root.querySelectorAll('.num')) {
    const target = Number(b.textContent.replace(/[^\d]/g, ''))
    if (!target || target < 3) continue
    const start = performance.now(), duration = Math.min(1400, 600 + target * 4)
    b.classList.add('counting')
    const tick = now => {
      const t = Math.min(1, (now - start) / duration), eased = 1 - (1 - t) ** 4
      b.textContent = n(Math.round(target * eased))
      if (t < 1) requestAnimationFrame(tick); else b.classList.remove('counting')
    }
    requestAnimationFrame(tick)
  }
}
function renderStatus() {
  const status = state.status || {}, stats = status.stats || {}, calendar = status.calendar || {}, run = status.run
  const has = Boolean(state.account), online = has && state.online
  document.body.classList.toggle('is-syncing', running())
  const label = $('accountLabel')
  label.textContent = has ? state.account.nickname : '未连接'
  label.dataset.state = !has ? 'none' : online ? 'online' : 'offline'
  label.title = !has ? '' : online ? '已连接网易云音乐' : '正在浏览本地档案，同步前需要扫码登录'
  label.hidden = !has
  $('connectButton').textContent = !has ? '连接网易云' : online ? '重新连接' : '扫码登录'
  $('connectButton').className = `button ${has ? 'ghost' : 'primary'}`
  $('connectButton').disabled = running()
  $('syncButton').hidden = !has
  $('syncButton').textContent = running() ? '同步中…' : '同步歌曲'
  $('syncButton').classList.toggle('is-running', running())
  $('startCollect').disabled = running()
  $('startCollect').textContent = running() ? '正在同步…' : '开始同步'
  for (const id of ['exportJson', 'exportCsv']) {
    $(id).setAttribute('aria-disabled', String(!has))
    $(id).tabIndex = has ? 0 : -1
  }

  const story = $('heroStory'), sub = $('heroSub'), action = $('heroAction')
  story.classList.toggle('is-loading', state.loading)
  $('heroKicker').textContent = has ? `网易云音乐 · ${state.account.nickname} 的初听档案` : '网易云音乐 · 初听档案'
  action.hidden = true
  $('heroLatest').hidden = true
  $('scrollCue').hidden = true
  $('backupQuick').hidden = !(state.local && has && stats.available)
  $('importQuick').hidden = !(state.local && !stats.available && !state.loading)
  $('intro').hidden = state.loading || has || Boolean(state.error)
  $('timelineSection').hidden = !state.loading && !has && !state.error
  if (state.loading) {
    story.replaceChildren(node('span', 'skeleton-line'), node('span', 'skeleton-line short'))
    sub.textContent = '正在翻开你的初听…'
  } else if (!has) {
    sentence(story, ['每首歌，都有第一次响起的那天。', ['连接网易云音乐', 'mark'], '，把它们一首首找回来，排成只属于你的时间线。'])
    sub.textContent = state.local ? '档案只保存在这个浏览器里，不上传到任何服务器。换设备时，用备份文件带走它。' : '数据只保存在这台电脑上，登录只在同步时用到。'
    action.textContent = '连接网易云音乐'; action.hidden = false; action.dataset.action = 'connect'
  } else if (!stats.available) {
    sentence(story, ['故事还没开始。', ['同步一批歌曲', 'mark'], '，看看你和它们是哪天相遇的。'])
    sub.textContent = stats.discovered ? `已经找到 ${n(stats.discovered)} 首歌，其中 ${n(stats.pending)} 首还在排队等查询。` : '会从最近播放、听歌排行、喜欢的歌和你的歌单里找歌。'
    action.textContent = online || !state.local ? '开始同步' : '扫码登录，开始同步'; action.hidden = false; action.dataset.action = 'sync'
  } else {
    const [ey, em, ed] = ymd(calendar.earliest), [ly, lm, ld] = ymd(calendar.latest)
    const from = `${ey} 年 ${em} 月 ${ed} 日`, to = ey === ly ? `${lm} 月 ${ld} 日` : `${ly} 年 ${lm} 月 ${ld} 日`
    const first = state.all[0]
    const latest = state.all[state.all.length - 1]
    if (latest) {
      const card = $('heroLatest')
      card.hidden = false
      card.dataset.index = String(state.all.length - 1)
      card.setAttribute('aria-label', `最近一次初听：${latest.name}，${dayLabel(latest.date)} ${latest.time}，查看详情`)
      paint(card, hues(latest))
      $('latestTime').textContent = latest.time
      $('latestTitle').textContent = latest.name
      $('latestMeta').textContent = `${latest.artists || '歌手未知'} · ${dayLabel(latest.date)} ${latest.time}`
      const [h] = hues(latest)
      document.documentElement.style.setProperty('--hero-h', h)
    }
    const pieces = ['从 ', [from, 'mark'], ' 到 ', [to, 'mark'], '，你在 ', [n(calendar.days)], ' 个日子里，第一次听见了 ', [n(stats.available)], ' 首歌。']
    if (first) pieces.push('一切从', [`《${first.name}》`, 'mark wrap'], '开始。')
    const sig = `${stats.available}-${calendar.days}-${first?.song_id}`
    const fresh = !story.querySelector('.num') || story.dataset.sig !== sig
    if (fresh) {
      sentence(story, pieces)
      story.dataset.sig = sig
      if (!state.counted && first) { state.counted = true; countUp(story) }
    }
    sub.textContent = [`已查询 ${n(stats.queried)} / ${n(stats.discovered)} 首`, stats.pending ? `还有 ${n(stats.pending)} 首在排队` : '找到的歌都查完了',
      stats.empty ? `${n(stats.empty)} 首暂无记录` : '', stats.failed ? `${n(stats.failed)} 首查询失败` : ''].filter(Boolean).join(' · ')
    $('scrollCue').hidden = false
    $('scrollCueText').textContent = state.order === 'newest' ? '最近的一首' : '最早的一首'
  }

  const line = $('syncLine')
  line.hidden = !has || (!run && !stats.discovered)
  line.dataset.status = run ? run.status : 'idle'
  $('syncMessage').textContent = run ? (running() ? '正在同步 · ' : '') + run.phase + (run.error ? ` · ${run.error}` : '')
    : state.local && !online ? '这份档案来自导入 · 扫码登录后可以继续同步' : '还没有同步过'
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
// Remembers the first visible song so a background refresh (e.g. during sync) does not move the page.
function scrollAnchor() {
  for (const el of $('timeline').querySelectorAll('.song')) {
    const top = el.getBoundingClientRect().top
    if (top > innerHeight) return null
    if (top >= 80) return { id: el.dataset.song, top }
  }
  return null
}
function renderTimeline(options = {}) {
  const keep = options.keep && state.rendered > 0
  const anchor = keep ? scrollAnchor() : null
  const previous = keep ? state.rendered : 0
  const search = state.query.trim()
  state.view = search ? state.results || [] : state.all
  state.view.forEach((e, i) => { e.index = i })
  state.chapters = buildChapters(state.view)
  state.rendered = 0
  state.active = ''
  $('timelineTitle').textContent = search ? `搜索「${search}」` : '时间线'
  $('timelineMeta').textContent = state.loading ? '' : search ? `找到 ${n(state.view.length)} 首` : state.view.length ? `${n(state.chapters.length)} 个月 · ${n(state.view.length)} 首初听` : ''
  $('timelineTools').hidden = !state.loading && !search && !state.all.length
  for (const [id, order] of [['orderNewest', 'newest'], ['orderOldest', 'oldest']]) $(id).setAttribute('aria-pressed', String(state.order === order))
  chapterObserver?.disconnect()
  const timeline = $('timeline')
  timeline.setAttribute('aria-busy', String(state.loading))
  timeline.classList.toggle('compact', Boolean(search))
  timeline.replaceChildren()
  renderScrubber()
  if (state.loading) {
    for (let i = 0; i < 4; i++) { const row = node('div', 'skeleton-row'); row.setAttribute('aria-hidden', 'true'); row.append(node('i'), node('i'), node('i')); timeline.append(row) }
    return
  }
  if (state.error) return timeline.append(emptyBlock('时间线没能加载', state.error, '重新加载', () => loadEvents(true)))
  if (!state.view.length) {
    if (search) return timeline.append(emptyBlock('没有找到相关歌曲', '换个歌名或歌手试试，也可能它还没被同步进来。', '清空搜索', clearSearch))
    if (state.account) return timeline.append(emptyBlock('这一页还空着', '同步之后，每一首初听都会按月份和日子排在这里。', '同步歌曲', openCollect))
    return timeline.append(emptyBlock('从连接账号开始', '连接网易云音乐后，初听会按时间一首首排在这里。', '连接网易云音乐', connect))
  }
  renderMore(undefined, { instant: keep, until: previous })
  if (anchor) {
    const el = timeline.querySelector(`.song[data-song="${anchor.id}"]`)
    if (el) scrollBy(0, el.getBoundingClientRect().top - anchor.top)
  }
}
function renderMore(untilKey, options = {}) {
  const timeline = $('timeline')
  let added = 0
  while (state.rendered < state.chapters.length && (added < BATCH || state.rendered < (options.until || 0) || (untilKey && !$(`m-${untilKey}`)))) {
    const chapter = state.chapters[state.rendered++]
    timeline.append(renderChapter(chapter))
    added += chapter.count
  }
  $('timeline').querySelector('.timeline-end')?.remove()
  if (state.rendered >= state.chapters.length) timeline.append(renderEnd())
  observe(options.instant)
}
function renderChapter(chapter) {
  const [y, m] = ymd(chapter.key)
  const search = state.query.trim()
  const events = chapter.days.flatMap(d => d.songs)
  const section = node('section', 'chapter')
  section.id = `m-${chapter.key}`
  section.dataset.month = chapter.key
  section.setAttribute('aria-label', `${y} 年 ${MONTHS[m - 1]}`)
  const { artist: [artist] } = tally(events)
  paint(section, hues(events.find(e => (e.artists || '').split(' / ')[0] === artist) || events[0]))
  const head = node('header', 'chapter-head reveal')
  const numeral = node('span', 'chapter-numeral', String(m).padStart(2, '0'))
  numeral.setAttribute('aria-hidden', 'true')
  const text = node('div', 'chapter-text')
  text.append(node('p', 'chapter-year', `${y}`))
  const title = node('h3', 'chapter-title', MONTHS[m - 1])
  title.append(node('span', 'chapter-count', `${n(chapter.count)} 首${search ? '匹配' : '初听'}`))
  const story = node('p', 'chapter-story')
  sentence(story, monthStory(events, search))
  text.append(title, story)
  head.append(numeral, text)
  const days = node('ol', 'days')
  for (const day of chapter.days) days.append(renderDay(day, search))
  section.append(head, days)
  return section
}
function renderDay(day, search) {
  const [, m, d] = ymd(day.date)
  const item = node('li', 'day reveal')
  const label = node('div', 'day-label')
  const num = node('span', 'day-num', d)
  const meta = node('span', 'day-meta', `${m} 月 · ${weekday(day.date)}`)
  label.append(num, meta)
  if (day.date === today) label.append(node('span', 'day-tag', '今天'))
  label.append(node('span', 'day-count', `${day.songs.length} 首`))
  const songs = node('ol', 'songs')
  day.songs.forEach((event, i) => {
    const li = node('li')
    const button = node('button', 'song')
    button.type = 'button'
    button.dataset.index = String(event.index)
    button.dataset.song = String(event.song_id)
    button.style.setProperty('--i', Math.min(i, 8))
    paint(button, hues(event))
    button.setAttribute('aria-label', `${event.time}，${event.name}，${event.artists || '歌手未知'}${event.status === 'conflict' ? '，初听时间有出入' : ''}，查看详情`)
    const time = node('time', 'song-time', event.time)
    time.dateTime = `${event.date}T${event.time}+08:00`
    const cover = node('span', 'song-cover', glyph(event.name))
    cover.setAttribute('aria-hidden', 'true')
    const main = node('span', 'song-main')
    main.append(highlight(node('span', 'song-title'), event.name, search), highlight(node('span', 'song-artist'), event.artists || '歌手未知', search))
    if (event.status === 'conflict') main.append(node('span', 'flag', '时间有出入'))
    button.append(time, cover, main)
    const arrow = node('span', 'song-arrow'); arrow.append(icon('m6 3 5 5-5 5')); button.append(arrow)
    li.append(button)
    songs.append(li)
  })
  item.append(label, songs)
  return item
}
function renderEnd() {
  const end = node('div', 'timeline-end reveal')
  const search = state.query.trim()
  if (search) { end.append(node('p', 'end-copy', '搜索结果就这些了。')); return end }
  const stats = state.status?.stats || {}
  end.append(node('span', 'end-mark'), node('p', 'end-title', state.order === 'newest' ? '再往前，是还没被找回的日子。' : '故事暂时写到这里。'))
  end.append(node('p', 'end-copy', stats.pending ? `还有 ${n(stats.pending)} 首歌在排队，更多初听也许就藏在里面。` : '之后遇见的新歌，同步一下就会续写在这里。'))
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
  state.jumpLock = Date.now() + 1600
  setActive(key)
  // Off-screen chapters use content-visibility, so their height is an estimate until rendered.
  // After moving, nudge until the chapter really sits under the bar.
  const want = () => parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0
  const settle = (tries = 0) => requestAnimationFrame(() => {
    const off = target.getBoundingClientRect().top - want()
    if (Math.abs(off) > 2 && tries < 8) { scrollBy(0, off); settle(tries + 1) }
    else state.jumpLock = Date.now() + 300
  })
  const far = Math.abs(target.getBoundingClientRect().top) > innerHeight * 2.5
  if (!motion) { target.scrollIntoView({ block: 'start' }); settle(); return }
  if (far && document.startViewTransition) {
    // Long jumps cross-fade instead of scrolling through dozens of months.
    document.startViewTransition(() => target.scrollIntoView({ block: 'start' })).finished.then(() => settle(), () => settle())
    return
  }
  target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  let done = false
  const finish = () => { if (!done) { done = true; settle() } }
  addEventListener('scrollend', finish, { once: true })
  setTimeout(finish, 1200)
}
function setActive(key) {
  if (state.active === key) return
  state.active = key
  for (const b of $('scrubber').querySelectorAll('.scrub-month')) {
    const on = b.dataset.month === key
    b.classList.toggle('active', on)
    if (on) {
      b.setAttribute('aria-current', 'true')
      // Keep the active month visible inside the scrubber itself, without scrolling the page.
      const nav = $('scrubber'), horizontal = matchMedia('(max-width: 900px)').matches
      const box = nav.getBoundingClientRect(), r = b.getBoundingClientRect()
      if (horizontal) nav.scrollTo({ left: nav.scrollLeft + r.left - box.left - box.width / 2 + r.width / 2, behavior: motion ? 'smooth' : 'auto' })
      else if (r.top < box.top || r.bottom > box.bottom) nav.scrollTo({ top: nav.scrollTop + r.top - box.top - box.height / 2, behavior: motion ? 'smooth' : 'auto' })
    } else b.removeAttribute('aria-current')
  }
}
function observe(instant = false) {
  if (!('IntersectionObserver' in window)) return
  for (const el of $('timeline').querySelectorAll('.reveal:not(.observed)')) {
    el.classList.add('observed')
    if (motion && !instant) revealObserver.observe(el); else el.classList.add('shown')
  }
  for (const el of $('timeline').querySelectorAll('.chapter')) chapterObserver.observe(el)
}

/* ---------- 歌曲详情 ---------- */
function fillSong(event) {
  state.current = event.index
  paint($('songDialog'), hues(event))
  $('detailGlyph').textContent = glyph(event.name)
  $('detailKicker').textContent = `初听 · ${dayLabel(event.date, true)} ${event.time}`
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
  if (event.album) entries.splice(1, 0, ['专辑', event.album])
  if (event.status === 'conflict') entries.push(['时间有出入', '多次查询得到的初听时间不一致，时间线按最早同步到的版本显示。全部版本：' + event.observations.map(o => `${o.upstream_date || o.first_listen_ms}`).join('；')])
  for (const [title, text, cls] of entries) {
    const div = node('div'), dd = node('dd', cls || '')
    for (const [i, line] of text.split('\n').entries()) { if (i) dd.append(node('br')); dd.append(document.createTextNode(line)) }
    div.append(node('dt', '', title), dd)
    dl.append(div)
  }
  $('songLink').href = `https://music.163.com/#/song?id=${encodeURIComponent(event.song_id)}`
  $('prevSong').disabled = event.index <= 0
  $('nextSong').disabled = event.index >= state.view.length - 1
}
function showSong(event, source) {
  if (!event) return
  const dialog = $('songDialog')
  const from = source?.querySelector('.song-cover, .record')
  // Same-document View Transition: the row's cover morphs into the dialog artwork.
  if (motion && from && document.startViewTransition && !dialog.open) {
    from.style.viewTransitionName = 'song-art'
    const t = document.startViewTransition(() => {
      from.style.viewTransitionName = ''
      fillSong(event)
      $('detailCover').style.viewTransitionName = 'song-art'
      dialog.showModal()
    })
    t.finished.finally(() => { $('detailCover').style.viewTransitionName = '' })
    return
  }
  fillSong(event)
  if (!dialog.open) dialog.showModal()
}
function stepSong(delta) {
  const next = state.view[state.current + delta]
  if (!next) return
  const art = $('detailArt')
  if (motion) { art.classList.remove('swap'); void art.offsetWidth; art.classList.add('swap') }
  fillSong(next)
}

/* ---------- 弹窗 ---------- */
function closeDialog(dialog) {
  if (!dialog.open) return
  if (!motion) { dialog.close(); return }
  dialog.classList.add('is-closing')
  setTimeout(() => { dialog.classList.remove('is-closing'); dialog.close() }, 180)
}
for (const id of ['collectDialog', 'songDialog', 'loginDialog']) {
  const d = $(id)
  d.addEventListener('cancel', e => { e.preventDefault(); closeDialog(d) })
  // Only a click on the backdrop closes; clicks in the dialog's own padding also target the dialog element.
  d.addEventListener('click', e => {
    if (e.target !== d) return
    const r = d.getBoundingClientRect()
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeDialog(d)
  })
}

/* ---------- 数据加载 ---------- */
async function loadEvents(all = false, options = {}) {
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
    fail(err)
  }
  renderStatus(); renderTimeline(options)
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
  if (firstLoad || force || old?.stats?.available !== status.stats.available || old?.stats?.conflicts !== status.stats.conflicts) await loadEvents(true, { keep: !firstLoad && !force })
  else if (old?.run?.status !== status.run?.status || old?.stats?.pending !== status.stats.pending) $('timeline').querySelector('.timeline-end')?.replaceWith(Object.assign(renderEnd(), { className: 'timeline-end reveal observed shown' }))
  schedulePoll()
}
async function checkSession() {
  const backend = await backendReady
  state.online = backend.local ? await backend.session() : Boolean(state.account)
  renderStatus()
}
// Poll quickly only while a sync is running, and never while the tab is hidden.
function schedulePoll() {
  clearTimeout(pollTimer)
  if (document.hidden) return
  pollTimer = setTimeout(() => loadStatus().catch(() => schedulePoll()), running() ? 2500 : 15000)
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadStatus().catch(() => {}); else clearTimeout(pollTimer) })

async function connect() {
  $('connectButton').disabled = true
  $('connectButton').textContent = '连接中…'
  try {
    const backend = await backendReady
    if (backend.local) {
      if (!backend.configured) throw new Error('这个部署还没有配置 SESSION_SECRET，暂时只能导入和浏览本地档案')
      if (backend.sync.task) throw new Error('请先暂停同步，再连接账号')
      await backend.connect(await qrLogin())
    } else await api('/api/connect', {})
    state.online = true
    state.initialized = false; await loadStatus(true); toast('连上了。档案只保存在这个浏览器里')
    return true
  }
  catch (err) { if (err.message !== '已取消连接') fail(err); renderStatus(); return false }
}
function qrLogin() {
  const dialog = $('loginDialog')
  dialog.showModal()
  return new Promise((resolve, reject) => {
    let ticket, timer, generation = 0, done = false
    const status = (text, tone = '') => { $('loginStatus').textContent = text; $('loginStatus').dataset.tone = tone }
    const cleanup = () => { done = true; clearTimeout(timer); $('refreshQr').removeEventListener('click', refresh); dialog.removeEventListener('close', cancel) }
    const cancel = () => { cleanup(); reject(new Error('已取消连接')) }
    dialog.addEventListener('close', cancel, { once: true })
    async function poll(version) {
      if (done || generation !== version) return
      try {
        const result = await remote('/api/auth/check', { ticket })
        if (done || generation !== version) return
        if (result.code === 803) { status('登录成功', 'ok'); cleanup(); closeDialog(dialog); resolve(result.account); return }
        if (result.code === 802) status('已扫码，请在手机上点「确认登录」', 'ok')
        else if (result.code === 800) { status('二维码过期了，换一张再扫', 'warn'); $('loginQr').classList.add('expired') }
        else status('打开网易云音乐 App，扫一扫')
        if (result.code !== 800) timer = setTimeout(() => poll(version), 2500)
      } catch (err) { if (!done && generation === version) status(err.message + '，可以换一张二维码重试', 'warn') }
    }
    async function refresh() {
      const version = ++generation
      clearTimeout(timer); $('loginQr').hidden = true; $('loginQr').classList.remove('expired'); status('正在生成二维码…')
      try {
        const result = await remote('/api/auth/key', {})
        if (done || generation !== version) return
        ticket = result.ticket; $('loginQr').src = result.image; $('loginQr').hidden = false; status('打开网易云音乐 App，扫一扫')
        timer = setTimeout(() => poll(version), 2500)
      } catch (err) { if (!done && generation === version) status(err.message, 'warn') }
    }
    $('refreshQr').addEventListener('click', refresh)
    refresh()
  })
}
async function openCollect() {
  if (!state.account || (state.local && !state.online)) { if (!(await connect())) return }
  $('collectError').textContent = ''
  renderStatus()
  $('collectDialog').showModal()
}
function setOrder(order) {
  if (state.order === order) return
  const apply = () => { state.order = order; renderStatus(); renderTimeline() }
  try { localStorage.setItem('chuting-order', order) } catch {}
  if (motion && document.startViewTransition) document.startViewTransition(apply)
  else apply()
}
function clearSearch() {
  $('songSearch').value = ''
  state.query = ''; state.results = null
  renderTimeline()
}

/* ---------- 动效：指针光斑、唱片倾斜、回到顶部 ---------- */
function setupPointerEffects() {
  if (!finePointer) return
  let frame = 0, last
  $('timeline').addEventListener('pointermove', e => {
    last = e
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      const song = last.target.closest?.('.song')
      if (!song) return
      const r = song.getBoundingClientRect()
      song.style.setProperty('--mx', `${last.clientX - r.left}px`)
      song.style.setProperty('--my', `${last.clientY - r.top}px`)
    })
  })
  const card = $('heroLatest')
  let tiltFrame = 0
  card.addEventListener('pointermove', e => {
    if (!motion || tiltFrame) return
    tiltFrame = requestAnimationFrame(() => {
      tiltFrame = 0
      const r = card.getBoundingClientRect()
      card.style.setProperty('--tx', ((e.clientX - r.left) / r.width - .5).toFixed(3))
      card.style.setProperty('--ty', ((e.clientY - r.top) / r.height - .5).toFixed(3))
    })
  })
  card.addEventListener('pointerleave', () => { card.style.setProperty('--tx', 0); card.style.setProperty('--ty', 0) })
}
if ('IntersectionObserver' in window) {
  new IntersectionObserver(([e]) => { $('toTop').hidden = e.isIntersecting }, { rootMargin: '0px 0px -40% 0px' }).observe(document.querySelector('.hero'))
}
$('toTop').addEventListener('click', () => scrollTo({ top: 0, behavior: motion ? 'smooth' : 'auto' }))

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
reduced.addEventListener?.('change', () => { motion = !reduced.matches && 'IntersectionObserver' in window; document.documentElement.classList.toggle('motion', motion) })
requestAnimationFrame(() => document.documentElement.classList.add('ready'))
setupPointerEffects()
$('connectButton').addEventListener('click', connect)
$('syncButton').addEventListener('click', openCollect)
$('heroAction').addEventListener('click', e => e.currentTarget.dataset.action === 'connect' ? connect() : openCollect())
$('closeCollect').addEventListener('click', () => closeDialog($('collectDialog')))
$('closeSong').addEventListener('click', () => closeDialog($('songDialog')))
$('prevSong').addEventListener('click', () => stepSong(-1))
$('nextSong').addEventListener('click', () => stepSong(1))
$('songDialog').addEventListener('keydown', e => { if (e.key === 'ArrowLeft') stepSong(-1); if (e.key === 'ArrowRight') stepSong(1) })
$('orderNewest').addEventListener('click', () => setOrder('newest'))
$('orderOldest').addEventListener('click', () => setOrder('oldest'))
$('timeline').addEventListener('click', e => {
  const button = e.target.closest('.song')
  if (button) showSong(state.view[Number(button.dataset.index)], button)
})
$('heroLatest').addEventListener('click', () => {
  const e = state.all[Number($('heroLatest').dataset.index)]
  if (!e) return
  if (state.query.trim()) clearSearch()
  state.view = state.all; state.all.forEach((x, i) => { x.index = i })
  showSong(e, $('heroLatest'))
})
$('scrubber').addEventListener('click', e => { const b = e.target.closest('.scrub-month'); if (b) jumpTo(b.dataset.month) })
$('songSearch').addEventListener('input', event => {
  state.query = event.target.value
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { state.query.trim() ? loadEvents() : (state.results = null, renderTimeline()) }, 220)
})
$('songSearch').addEventListener('keydown', e => { if (e.key === 'Escape' && e.target.value) { e.preventDefault(); clearSearch() } })
document.addEventListener('keydown', e => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || $('timelineSection').hidden) return
  e.preventDefault()
  $('songSearch').focus({ preventScroll: true })
  $('timelineSection').scrollIntoView({ behavior: motion ? 'smooth' : 'auto', block: 'start' })
})
$('collectForm').addEventListener('submit', async event => {
  event.preventDefault()
  $('startCollect').disabled = true
  $('collectError').textContent = ''
  try {
    await api('/api/sync', { limit: Number($('batchLimit').value), playlists: $('includePlaylists').checked, retry_empty: $('retryEmpty').checked,
      history: $('includeHistory').checked, history_from: $('historyFrom').value, concurrency: Number($('concurrency').value) })
    closeDialog($('collectDialog')); await loadStatus(true)
  } catch (err) { $('collectError').textContent = err.message; $('startCollect').disabled = false }
})
$('pauseButton').addEventListener('click', async () => {
  try { await api('/api/sync/pause', {}); toast('好的，这一首查完就停下，进度已保存'); await loadStatus() }
  catch (err) { fail(err) }
})
$('closeLogin').addEventListener('click', () => closeDialog($('loginDialog')))
$('importButton').addEventListener('click', () => $('importFile').click())
$('importQuick').addEventListener('click', () => $('importFile').click())
$('backupQuick').addEventListener('click', async () => {
  try { await (await backendReady).download('json'); toast('备份文件已下载，换设备时导入它就行') } catch (err) { fail(err) }
})
$('importFile').addEventListener('change', async event => {
  const file = event.target.files[0]
  if (!file) return
  try {
    if (file.size > 25 * 1024 * 1024) throw new Error('档案超过 25 MB，请拆分后再导入')
    toast('正在导入档案，请稍候…')
    let data
    try { data = JSON.parse(await file.text()) } catch { throw new Error('这个文件不是有效的 JSON 档案') }
    await (await backendReady).import(data)
    state.initialized = false; state.counted = false; await loadStatus(true); checkSession(); toast('档案已导入，欢迎回来')
  } catch (err) { fail(err) }
  event.target.value = ''
})
for (const id of ['exportJson', 'exportCsv']) $(id).addEventListener('click', async e => {
  e.preventDefault()
  const href = e.currentTarget.href
  if (!state.account) { toast('请先连接网易云音乐，或导入已有档案'); return }
  try { const backend = await backendReady; if (backend.local) await backend.download(id === 'exportCsv' ? 'csv' : 'json'); else location.href = href }
  catch (err) { fail(err) }
})
backendReady.then(backend => {
  if (!backend.local) return
  state.local = true
  $('importButton').hidden = false; $('cloudCollectOptions').hidden = false
  $('exportJson').textContent = '备份 JSON'
  $('storageNote').textContent = '档案保存在当前浏览器 · 记得定期备份 · 时间按北京时间显示'
  $('syncHint').textContent = '默认同时查 2 首，每次请求至少间隔 0.65 秒，对接口足够温柔。网络出错会稍后重试，遇到限流立即停下；暂无记录的歌 30 天后自动再查。关掉页面就暂停，下次打开可以接着来。'
  for (let y = new Date().getFullYear(); y >= 2017; y--) { const option = node('option', '', String(y)); option.value = String(y); $('historyFrom').append(option) }
  renderStatus()
}).catch(() => {})
renderStatus(); renderTimeline()
loadStatus(true).then(async () => {
  await checkSession()
  if (!state.account && !(await backendReady).local) connect()
}).catch(err => { state.loading = false; state.error = err.message; renderStatus(); renderTimeline(); fail(err) })
