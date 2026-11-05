'use strict'
import { createBackend, remote } from './backend.js'
import { insights } from './insights.js'
import { coverSize } from './archive-core.js'
const backendReady = createBackend()
const $ = id => document.getElementById(id)
const SVG = 'http://www.w3.org/2000/svg'
const MONTHS = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
const BATCH = 160 // songs rendered per batch; later months render as you scroll
const HL_MS = 6500 // highlight carousel: time per slide
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]))
const today = `${parts.year}-${parts.month}-${parts.day}`
const reduced = matchMedia('(prefers-reduced-motion: reduce)')
let motion = !reduced.matches && 'IntersectionObserver' in window
const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches
const stored = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback } }
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)) } catch {} }
const settings = { auto: true, history: true, playlists: true, ...stored('chuting-settings', {}) }
let storedOrder = 'newest'
try { storedOrder = localStorage.getItem('chuting-order') === 'oldest' ? 'oldest' : 'newest' } catch {}

const state = {
  account: null, status: null, initialized: false, loading: true, error: '', local: false, online: false, offline: !navigator.onLine,
  all: [], results: null, query: '', terms: [], order: storedOrder, request: 0, autoTried: false,
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
const shanghaiDate = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 10)
function running() { return state.status?.run?.status === 'running' }
function partOfDay(time) { const h = Number(time.slice(0, 2)); return h < 5 ? '凌晨' : h < 11 ? '上午' : h < 17 ? '下午' : '晚上' }
const norm = text => String(text || '').normalize('NFKC').toLocaleLowerCase()

/* ---------- 封面 ---------- */
// Fallback tiles stay inside one tonal family around the accent (warm reds to ambers),
// varied only in lightness and chroma by artist, so a page of songs never looks like a rainbow.
function hash(text) { let h = 2166136261; for (const c of String(text)) h = Math.imul(h ^ c.codePointAt(0), 16777619); return h >>> 0 }
function tint(el, event) {
  const h = hash((event.artists || '').split(' / ')[0] || event.name || '')
  el.style.setProperty('--tile-h', 22 + (h % 34))
  el.style.setProperty('--tile-l', (.4 + ((h >>> 8) % 26) / 100).toFixed(2))
  el.style.setProperty('--tile-c', (.035 + ((h >>> 16) % 6) / 100).toFixed(3))
}
function glyph(name) { return ([...(name || '').trim()][0] || '♪').toLocaleUpperCase() }
// Real album art from NetEase's CDN, sized per use; the tile underneath shows until (or unless) it loads.
function coverImg(url, px, eager = false) {
  const img = new Image()
  img.className = 'cover-img'
  img.alt = ''
  img.decoding = 'async'
  img.loading = eager ? 'eager' : 'lazy'
  img.crossOrigin = 'anonymous'
  img.referrerPolicy = 'no-referrer'
  img.src = coverSize(url, px)
  return img
}
function tile(event, className, px, eager, defer = false) {
  const box = node('span', `${className} cover-tile`)
  tint(box, event)
  box.append(node('span', 'glyph', glyph(event.name)))
  if (event.cover && defer) { box.dataset.cover = event.cover; box.dataset.px = String(px) }
  else if (event.cover) box.append(coverImg(event.cover, px, eager))
  return box
}
// Timeline rows get their <img> after the rows are on screen, keeping image setup off the first paint.
let hydrateFrame = 0
function hydrateCovers() {
  if (hydrateFrame) return
  hydrateFrame = requestAnimationFrame(() => setTimeout(() => {
    hydrateFrame = 0
    for (const box of $('timeline').querySelectorAll('[data-cover]')) { box.append(coverImg(box.dataset.cover, Number(box.dataset.px))); delete box.dataset.cover }
  }))
}
document.addEventListener('load', e => { if (e.target.classList?.contains('cover-img')) e.target.classList.add('loaded') }, true)
document.addEventListener('error', e => { if (e.target.classList?.contains('cover-img')) e.target.remove() }, true)
// A single average colour from the artwork, used only for faint glows (never for text).
const toneCache = new Map()
function coverTone(img) {
  if (toneCache.has(img.currentSrc)) return toneCache.get(img.currentSrc)
  let tone = null
  try {
    const c = document.createElement('canvas'); c.width = c.height = 12
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0, 12, 12)
    const d = ctx.getImageData(0, 0, 12, 12).data
    let r = 0, g = 0, b = 0, w = 0
    for (let i = 0; i < d.length; i += 4) {
      const max = Math.max(d[i], d[i + 1], d[i + 2]), min = Math.min(d[i], d[i + 1], d[i + 2])
      const weight = 1 + (max - min) / 40 // favour coloured pixels over greys
      r += d[i] * weight; g += d[i + 1] * weight; b += d[i + 2] * weight; w += weight
    }
    tone = `rgb(${Math.round(r / w)} ${Math.round(g / w)} ${Math.round(b / w)})`
  } catch {}
  toneCache.set(img.currentSrc, tone)
  return tone
}
function applyTone(target, img) {
  const set = () => { const tone = coverTone(img); if (tone) target.style.setProperty('--cover', tone); else target.style.removeProperty('--cover') }
  target.style.removeProperty('--cover')
  if (!img) return
  if (img.complete && img.naturalWidth) set(); else img.addEventListener('load', set, { once: true })
}

function highlight(target, text, terms) {
  if (!terms?.length) { target.textContent = text; return target }
  const lower = text.toLocaleLowerCase(), marks = []
  for (const t of terms) { let i = -1; while (t && (i = lower.indexOf(t, i + 1)) !== -1) marks.push([i, i + t.length]) }
  marks.sort((a, b) => a[0] - b[0])
  let at = 0
  for (const [from, to] of marks) {
    if (to <= at) continue
    const start = Math.max(from, at)
    if (start > at) target.append(text.slice(at, start))
    target.append(node('mark', '', text.slice(start, to)))
    at = to
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
  const has = Boolean(state.account), online = has && state.online && !state.offline
  document.body.classList.toggle('is-syncing', running())
  const label = $('accountLabel')
  label.textContent = has ? state.account.nickname : ''
  label.dataset.state = !has ? 'none' : state.offline ? 'away' : online ? 'online' : 'offline'
  label.title = !has ? '' : state.offline ? '离线中，档案照常可看' : online ? '已连接网易云音乐' : '正在浏览本地档案，同步前需要扫码登录'
  label.hidden = !has

  const bar = $('barAction')
  bar.disabled = false
  bar.classList.toggle('is-running', running())
  if (running()) {
    const pct = run.total ? Math.round(100 * (run.queried || 0) / run.total) : 0
    bar.textContent = pct ? `暂停 · ${pct}%` : '暂停同步'; bar.dataset.action = 'pause'; bar.className = 'button ghost is-running'
  } else if (!has) { bar.textContent = '连接网易云'; bar.dataset.action = 'connect'; bar.className = 'button primary' }
  else if (state.offline) { bar.textContent = '离线浏览'; bar.dataset.action = ''; bar.disabled = true; bar.className = 'button ghost' }
  else if (state.local && !online) { bar.textContent = '扫码登录'; bar.dataset.action = 'connect'; bar.className = 'button primary' }
  else { bar.textContent = '同步'; bar.dataset.action = 'sync'; bar.className = 'button primary' }

  const story = $('heroStory'), sub = $('heroSub'), action = $('heroAction')
  story.classList.toggle('is-loading', state.loading)
  $('heroKicker').textContent = has ? `网易云音乐 · ${state.account.nickname} 的初听档案` : '网易云音乐 · 初听档案'
  action.hidden = true
  $('scrollCue').hidden = true
  $('intro').hidden = state.loading || has || Boolean(state.error)
  $('timelineSection').hidden = !state.loading && !has && !state.error
  if (state.loading) {
    story.replaceChildren(node('span', 'skeleton-line'), node('span', 'skeleton-line short'))
    sub.textContent = '正在翻开你的初听…'
  } else if (!has) {
    sentence(story, ['每首歌，都有第一次响起的那天。', ['扫一次码', 'mark'], '，初听会把它们一首首找回来，排成只属于你的时间线。'])
    sub.textContent = state.local ? '连上后自动同步全部歌曲。档案只保存在这个浏览器里，不上传到任何服务器。' : '数据只保存在这台电脑上，登录只在同步时用到。'
    action.textContent = '连接网易云音乐'; action.hidden = false; action.dataset.action = 'connect'
  } else if (!stats.available) {
    if (running()) {
      sentence(story, ['正在把你的歌一首首找回来。', ['第一批初听', 'mark'], '很快就会出现在下面。'])
      sub.textContent = stats.discovered ? `已经找到 ${n(stats.discovered)} 首歌，正在逐首查询初听时间。` : '先从最近播放、排行、喜欢的歌和歌单里找歌。'
    } else {
      sentence(story, ['故事还没开始。', ['同步一下', 'mark'], '，看看你和每首歌是哪天相遇的。'])
      sub.textContent = stats.discovered ? `已经找到 ${n(stats.discovered)} 首歌，其中 ${n(stats.pending)} 首还在排队。` : '会从最近播放、听歌排行、喜欢的歌和你的歌单里找歌。'
      if (!state.offline) { action.textContent = online || !state.local ? '开始同步' : '扫码登录，开始同步'; action.hidden = false; action.dataset.action = online || !state.local ? 'sync' : 'connect' }
    }
  } else {
    const [ey, em, ed] = ymd(calendar.earliest), [ly, lm, ld] = ymd(calendar.latest)
    const from = `${ey} 年 ${em} 月 ${ed} 日`, to = ey === ly ? `${lm} 月 ${ld} 日` : `${ly} 年 ${lm} 月 ${ld} 日`
    const first = state.all[0]
    const pieces = ['从 ', [from, 'mark'], ' 到 ', [to, 'mark'], '，你在 ', [n(calendar.days)], ' 个日子里，第一次听见了 ', [n(stats.available)], ' 首歌。']
    if (first) pieces.push('一切从', [`《${first.name}》`, 'mark wrap'], '开始。')
    const sig = `${stats.available}-${calendar.days}-${first?.song_id}`
    if (!story.querySelector('.num') || story.dataset.sig !== sig) {
      sentence(story, pieces)
      story.dataset.sig = sig
      if (!state.counted && first) { state.counted = true; countUp(story) }
    }
    sub.textContent = [`已查询 ${n(stats.queried)} / ${n(stats.discovered)} 首`, stats.pending ? `还有 ${n(stats.pending)} 首在排队` : '找到的歌都查完了',
      stats.empty ? `${n(stats.empty)} 首暂无记录` : ''].filter(Boolean).join(' · ')
    $('scrollCue').hidden = false
    $('scrollCueText').textContent = state.order === 'newest' ? '最近的一首' : '最早的一首'
  }

  const line = $('syncLine')
  line.hidden = !has || (!run && !stats.discovered)
  line.dataset.status = run ? run.status : 'idle'
  $('syncMessage').textContent = state.offline ? '离线中 · 档案和搜索照常可用，联网后会继续同步'
    : run ? run.phase + (run.error && !running() ? ` · ${run.error}` : '')
    : state.local && !online ? '这份档案来自备份 · 扫码登录后会继续同步' : '还没有同步过'
  $('pauseButton').hidden = !running()
  const total = running() && run.total ? run.total : stats.discovered || 1
  $('coverageProgress').max = total
  $('coverageProgress').value = running() && run.total ? run.queried || 0 : stats.queried || 0
  renderSettings()
}

/* ---------- 高光轮播 ---------- */
// Auto-advances every HL_MS; holds while hovered, focused, off-screen, behind a dialog or in a hidden tab;
// never auto-advances with reduced motion. Dots, arrows, ←/→ and swipe all work by hand.
const hl = { items: [], sig: '', index: 0, timer: 0, start: 0, left: HL_MS, paused: !motion, holds: new Set() }
function renderHighlights() {
  const box = $('highlights')
  const items = state.loading || !state.all.length ? [] : insights(state.all)
  const sig = items.map(i => `${i.id}:${i.event?.song_id || i.title}:${i.cover || i.covers?.length || ''}`).join('|')
  box.hidden = !items.length
  document.querySelector('.hero').classList.toggle('has-highlights', items.length > 0)
  if (sig === hl.sig) return
  hl.sig = sig; hl.items = items
  const stage = $('hlStage'), dots = $('hlDots')
  stage.replaceChildren(); dots.replaceChildren()
  items.forEach((item, i) => {
    stage.append(slideNode(item, i, items.length))
    const dot = node('button', 'hl-dot'); dot.type = 'button'; dot.dataset.i = String(i)
    dot.setAttribute('aria-label', `${i + 1} / ${items.length}：${item.kicker}`)
    dot.append(node('i'))
    dots.append(dot)
  })
  $('hlPlay').hidden = !motion || items.length < 2
  $('hlPrev').hidden = $('hlNext').hidden = items.length < 2
  setSlide(Math.min(hl.index, items.length - 1), { instant: true })
}
function slideNode(item, i, total) {
  const slide = node('div', 'hl-slide')
  slide.setAttribute('role', 'group')
  slide.setAttribute('aria-roledescription', 'slide')
  slide.setAttribute('aria-label', `${i + 1} / ${total}：${item.kicker}`)
  slide.dataset.kind = item.kind
  const open = node('button', 'hl-open'); open.type = 'button'; open.dataset.i = String(i)
  const art = node('span', 'hl-art')
  art.setAttribute('aria-hidden', 'true')
  if (item.kind === 'song') {
    const disc = node('span', 'hl-disc'), label = node('span', 'disc-label')
    if (item.cover) label.append(coverImg(item.cover, 120, i === 0))
    disc.append(label)
    art.append(disc, tile(item.event, 'hl-sleeve', 500, i === 0))
  } else {
    const grid = node('span', `hl-mosaic n${Math.max(1, item.covers.length)}`)
    for (const e of item.covers.length ? item.covers : []) grid.append(tile(e, 'hl-cell', 250, i === 0))
    if (!item.covers.length) grid.append(node('span', 'hl-cell cover-tile', item.title.slice(0, 1)))
    art.append(grid)
  }
  const text = node('span', 'hl-text')
  text.append(node('span', 'hl-kicker', item.kicker), node('span', 'hl-title', item.title), node('span', 'hl-meta', item.meta), node('span', 'hl-line', item.line))
  open.setAttribute('aria-label', `${item.kicker}：${item.title}，${item.meta}，${item.line}。${item.kind === 'song' ? '查看详情' : item.kind === 'artist' ? '搜索这位歌手' : '跳到那个月'}`)
  open.append(art, text)
  slide.append(open)
  return slide
}
function setSlide(i, options = {}) {
  const slides = [...$('hlStage').children], count = slides.length
  if (!count) return
  i = (i + count) % count
  const prev = hl.index, dir = options.dir || (i >= prev ? 1 : -1)
  hl.index = i
  slides.forEach((slide, k) => {
    const on = k === i
    slide.classList.toggle('is-active', on)
    slide.classList.toggle('is-leaving', !options.instant && motion && k === prev && k !== i)
    slide.dataset.dir = String(dir)
    slide.inert = !on
    slide.setAttribute('aria-hidden', String(!on))
  })
  if (!options.instant && motion) setTimeout(() => slides[prev]?.classList.remove('is-leaving'), 900)
  for (const [k, dot] of [...$('hlDots').children].entries()) {
    dot.classList.toggle('is-active', k === i)
    if (k === i) dot.setAttribute('aria-current', 'true'); else dot.removeAttribute('aria-current')
  }
  if (options.announce) $('hlLive').textContent = `${hl.items[i].kicker}：${hl.items[i].title}`
  applyTone(document.querySelector('.hero'), slides[i].querySelector('.hl-sleeve .cover-img, .hl-cell .cover-img'))
  restartTimer()
}
function restartTimer() {
  clearTimeout(hl.timer)
  hl.left = HL_MS
  const box = $('highlights')
  box.classList.remove('is-ticking'); void box.offsetWidth
  tick()
}
function tick() {
  clearTimeout(hl.timer)
  const box = $('highlights')
  const held = hl.paused || hl.holds.size > 0 || hl.items.length < 2 || document.hidden || Boolean(document.querySelector('dialog[open]'))
  box.classList.toggle('is-held', held)
  box.classList.toggle('is-paused', hl.paused)
  $('hlPlay').setAttribute('aria-pressed', String(hl.paused))
  $('hlPlay').setAttribute('aria-label', hl.paused ? '继续自动轮播' : '暂停自动轮播')
  if (held || !motion) return
  box.classList.add('is-ticking')
  hl.start = performance.now()
  hl.timer = setTimeout(() => setSlide(hl.index + 1, { dir: 1 }), hl.left)
}
function hold(reason, on) {
  const before = hl.holds.size > 0
  if (on) hl.holds.add(reason); else hl.holds.delete(reason)
  const now = hl.holds.size > 0
  if (before === now) return
  if (now && hl.start) hl.left = Math.max(400, hl.left - (performance.now() - hl.start))
  tick()
}
function openHighlight(i) {
  const item = hl.items[i]
  if (!item) return
  if (item.kind === 'song') {
    if (state.query.trim()) clearSearch()
    state.view = state.all; state.all.forEach((x, k) => { x.index = k })
    showSong(item.event, $('hlStage').children[i])
  } else if (item.kind === 'artist') {
    $('songSearch').value = item.query
    runSearch(item.query)
    $('timelineSection').scrollIntoView({ behavior: motion ? 'smooth' : 'auto', block: 'start' })
  } else if (item.month) {
    if (state.query.trim()) clearSearch()
    jumpTo(item.month)
  }
}
function setupHighlights() {
  const box = $('highlights'), stage = $('hlStage')
  $('hlPrev').addEventListener('click', () => { setSlide(hl.index - 1, { dir: -1, announce: true }) })
  $('hlNext').addEventListener('click', () => { setSlide(hl.index + 1, { dir: 1, announce: true }) })
  $('hlDots').addEventListener('click', e => { const d = e.target.closest('.hl-dot'); if (d) setSlide(Number(d.dataset.i), { announce: true }) })
  $('hlPlay').addEventListener('click', () => { hl.paused = !hl.paused; hl.left = HL_MS; restartTimer() })
  box.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') hold('hover', true) })
  box.addEventListener('pointerleave', () => hold('hover', false))
  box.addEventListener('focusin', () => hold('focus', true))
  box.addEventListener('focusout', e => { if (!box.contains(e.relatedTarget)) hold('focus', false) })
  box.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); setSlide(hl.index - 1, { dir: -1, announce: true }) }
    if (e.key === 'ArrowRight') { e.preventDefault(); setSlide(hl.index + 1, { dir: 1, announce: true }) }
  })
  let swipe = null, swiped = false
  stage.addEventListener('pointerdown', e => { swipe = { x: e.clientX, y: e.clientY }; swiped = false })
  stage.addEventListener('pointerup', e => {
    if (!swipe) return
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y
    swipe = null
    if (Math.abs(dx) > 44 && Math.abs(dx) > Math.abs(dy) * 1.4) { swiped = true; setSlide(hl.index + (dx < 0 ? 1 : -1), { dir: dx < 0 ? 1 : -1, announce: true }) }
  })
  stage.addEventListener('click', e => {
    const open = e.target.closest('.hl-open')
    if (!open) return
    if (swiped) { swiped = false; e.preventDefault(); return }
    openHighlight(Number(open.dataset.i))
  })
  if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => hold('offscreen', !e.isIntersecting), { threshold: .25 }).observe(box)
  document.addEventListener('visibilitychange', () => tick())
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
    if (state.account && running()) return timeline.append(emptyBlock('正在同步', '查到第一首有初听记录的歌，它就会出现在这里。'))
    if (state.account) return timeline.append(emptyBlock('这一页还空着', '同步之后，每一首初听都会按月份和日子排在这里。', '开始同步', () => startSync()))
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
  hydrateCovers()
}
function renderChapter(chapter) {
  const [y, m] = ymd(chapter.key)
  const search = state.query.trim()
  const events = chapter.days.flatMap(d => d.songs)
  const section = node('section', 'chapter')
  section.id = `m-${chapter.key}`
  section.dataset.month = chapter.key
  section.setAttribute('aria-label', `${y} 年 ${MONTHS[m - 1]}`)
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
  for (const day of chapter.days) days.append(renderDay(day, state.terms))
  section.append(head, days)
  return section
}
function renderDay(day, terms) {
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
    button.setAttribute('aria-label', `${event.time}，${event.name}，${event.artists || '歌手未知'}${event.status === 'conflict' ? '，初听时间有出入' : ''}，查看详情`)
    const time = node('time', 'song-time', event.time)
    time.dateTime = `${event.date}T${event.time}+08:00`
    const cover = tile(event, 'song-cover', 96, false, true)
    cover.setAttribute('aria-hidden', 'true')
    const main = node('span', 'song-main')
    main.append(highlight(node('span', 'song-title'), event.name, terms), highlight(node('span', 'song-artist'), event.artists || '歌手未知', terms))
    if (terms.length && event.album && terms.some(t => event.album.toLocaleLowerCase().includes(t))) main.append(highlight(node('span', 'song-album'), `《${event.album}》`, terms))
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
  end.append(node('p', 'end-copy', running() ? '同步还在进行，新查到的初听会自动续写在这里。' : stats.pending ? `还有 ${n(stats.pending)} 首歌在排队，更多初听也许就藏在里面。` : '之后遇见的新歌，同步一下就会续写在这里。'))
  if (stats.pending && !running() && !state.offline) { const b = node('button', 'button ghost', '继续同步'); b.type = 'button'; b.addEventListener('click', () => startSync()); end.append(b) }
  return end
}
function emptyBlock(title, text, label, action) {
  const box = node('div', 'empty-block')
  box.append(node('span', 'end-mark'), node('h3', '', title), node('p', '', text))
  if (!label) return box
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
  const cover = $('detailCover'), label = $('detailLabel')
  tint(cover, event)
  $('detailGlyph').textContent = glyph(event.name)
  cover.querySelector('.cover-img')?.remove(); label.replaceChildren()
  let img = null
  if (event.cover) { img = coverImg(event.cover, 500, true); cover.append(img); label.append(coverImg(event.cover, 120, true)) }
  applyTone($('songDialog'), img)
  $('detailKicker').textContent = `初听 · ${dayLabel(event.date, true)} ${event.time}`
  $('detailName').textContent = event.name
  $('detailArtists').textContent = event.artists || '歌手未知'
  const dl = $('detailFacts')
  dl.replaceChildren()
  const entries = [
    ['初听时间', `${dayLabel(event.date, true)} ${weekday(event.date)} ${event.time}（北京时间）`],
    ['累计播放', event.play_count == null ? '暂无数据' : `${event.play_count.toLocaleString('zh-CN')} 次（网易云累计统计）`],
  ]
  if (event.album) entries.splice(1, 0, ['专辑', event.album])
  if (event.peak_count) entries.push(['听得最多的一天', `${event.peak_ms ? dayLabel(shanghaiDate(event.peak_ms), true) + '，' : ''}这一天听了 ${n(event.peak_count)} 遍`])
  entries.push(['数据来源', '网易云音乐 · 回忆坐标'], ['原始时间戳', `${event.timestamp_local}\n${event.first_listen_ms}`, 'mono'])
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
  const from = source?.querySelector('.song-cover, .hl-sleeve, .hl-mosaic')
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
  setTimeout(() => { dialog.classList.remove('is-closing'); dialog.close() }, 200)
}
for (const id of ['settingsDialog', 'songDialog', 'loginDialog']) {
  const d = $(id)
  d.addEventListener('cancel', e => { e.preventDefault(); closeDialog(d) })
  d.addEventListener('close', () => tick())
  // Only a click on the backdrop closes; clicks in the dialog's own padding also target the dialog element.
  d.addEventListener('click', e => {
    if (e.target !== d) return
    const r = d.getBoundingClientRect()
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeDialog(d)
  })
}
const openModal = dialog => { dialog.showModal(); tick() }

/* ---------- 数据加载 ---------- */
// The whole archive is already in memory, so search is a plain filter over pre-normalised text:
// no round trip, no re-sorting, results on the next frame.
function index(events) { for (const e of events) e.hay ||= norm(`${e.name}\n${e.artists}\n${e.album || ''}`) }
function runSearch(value) {
  state.query = value
  state.terms = norm(value).split(/\s+/).filter(Boolean)
  state.results = state.terms.length ? state.all.filter(e => state.terms.every(t => e.hay.includes(t))) : null
  renderTimeline()
}
async function loadEvents(all = false, options = {}) {
  const id = ++state.request
  if (!state.account) { state.all = []; state.results = null; state.error = ''; renderStatus(); renderTimeline(); renderHighlights(); return }
  try {
    const result = await api('/api/events')
    if (id !== state.request) return
    index(result.events)
    state.all = result.events
    if (state.terms.length) state.results = state.all.filter(e => state.terms.every(t => e.hay.includes(t)))
    state.error = ''
  } catch (err) {
    if (id !== state.request) return
    state.error = err.message
    fail(err)
  }
  renderStatus(); renderTimeline(options); renderHighlights()
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
  if (firstLoad || force || old?.stats?.available !== status.stats.available || old?.stats?.conflicts !== status.stats.conflicts || old?.stats?.missing_covers !== status.stats.missing_covers) await loadEvents(true, { keep: !firstLoad && !force })
  else if (old?.run?.status !== status.run?.status || old?.stats?.pending !== status.stats.pending) $('timeline').querySelector('.timeline-end')?.replaceWith(Object.assign(renderEnd(), { className: 'timeline-end reveal observed shown' }))
  if (old?.run?.status === 'running' && status.run?.status !== 'running') syncFinished(status)
  schedulePoll()
}
async function checkSession() {
  const backend = await backendReady
  state.online = backend.local ? !state.offline && await backend.session() : Boolean(state.account)
  renderStatus()
}
// Poll quickly only while a sync is running, and never while the tab is hidden.
function schedulePoll() {
  clearTimeout(pollTimer)
  if (document.hidden) return
  pollTimer = setTimeout(() => loadStatus().catch(() => schedulePoll()), running() ? 1500 : 15000)
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadStatus().catch(() => {}); else clearTimeout(pollTimer) })

/* ---------- 连接与同步 ---------- */
async function connect() {
  const bar = $('barAction')
  bar.disabled = true
  try {
    const backend = await backendReady
    if (state.offline) throw new Error('现在没有网络，联网后再扫码')
    if (backend.local) {
      if (!backend.configured) throw new Error('这个部署还没有配置 SESSION_SECRET，暂时只能浏览导入的档案')
      if (backend.sync.task) throw new Error('请先暂停同步，再连接账号')
      await backend.connect(await qrLogin())
    } else await api('/api/connect', {})
    state.online = true
    state.initialized = false
    await loadStatus(true)
    // Connecting means syncing: everything is fetched right away, no separate import step.
    await startSync({ quiet: true })
    toast('连上了，正在把你的歌全部同步进来')
    return true
  }
  catch (err) { if (err.message !== '已取消连接') fail(err); renderStatus(); return false }
}
function qrLogin() {
  const dialog = $('loginDialog')
  openModal(dialog)
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
        if (result.code === 803) { status('登录成功，马上开始同步', 'ok'); cleanup(); closeDialog(dialog); resolve(result.account); return }
        if (result.code === 802) status('已扫码，请在手机上点「确认登录」', 'ok')
        else if (result.code === 800) { status('二维码过期了，换一张再扫', 'warn'); $('loginQr').classList.add('expired') }
        else status('打开网易云音乐 App，扫一扫')
        if (result.code !== 800) timer = setTimeout(() => poll(version), 2000)
      } catch (err) { if (!done && generation === version) status(err.message + '，可以换一张二维码重试', 'warn') }
    }
    async function refresh() {
      const version = ++generation
      clearTimeout(timer); $('loginQr').hidden = true; $('loginQr').classList.remove('expired'); status('正在生成二维码…')
      try {
        const result = await remote('/api/auth/key', {})
        if (done || generation !== version) return
        ticket = result.ticket; $('loginQr').src = result.image; $('loginQr').hidden = false; status('打开网易云音乐 App，扫一扫')
        timer = setTimeout(() => poll(version), 2000)
      } catch (err) { if (!done && generation === version) status(err.message, 'warn') }
    }
    $('refreshQr').addEventListener('click', refresh)
    refresh()
  })
}
async function startSync(extra = {}) {
  const { quiet, ...options } = extra
  if (running()) return
  if (!state.account || (state.local && !state.online)) { await connect(); return }
  try {
    await api('/api/sync', { limit: 0, playlists: settings.playlists, retry_empty: false, history: settings.history, history_from: '', concurrency: 3, ...options })
    if (!quiet) toast(options.covers_only ? '正在补全专辑封面' : '开始同步，查到的初听会陆续出现')
    await loadStatus()
  } catch (err) { if (!quiet || !/另一个标签页|已经有一个/.test(err.message)) fail(err) }
}
async function pauseSync() {
  try { await api('/api/sync/pause', {}); toast('好的，手头这首查完就停，进度已保存'); await loadStatus() }
  catch (err) { fail(err) }
}
function syncFinished(status) {
  const run = status.run || {}
  if (run.status === 'completed' && run.found !== undefined) toast(run.found ? `同步好了，这次新找到 ${n(run.found)} 首初听` : '同步好了，没有新的初听')
  else if (run.status === 'failed' && run.error) toast(run.error, 'error')
}
// Opening the page quietly continues where the archive left off (and fills in missing album art).
async function autoSync() {
  if (state.autoTried || !state.local || !state.online || state.offline || running()) return
  state.autoTried = true
  const stats = state.status?.stats || {}, run = state.status?.run
  const stale = !run?.updated_ms || Date.now() - run.updated_ms > 6 * 3600000
  if (settings.auto && (stats.pending > 0 || run?.status === 'paused' || stale)) return startSync({ quiet: true })
  if (stats.missing_covers > 0) return startSync({ quiet: true, covers_only: true })
}

/* ---------- 设置 ---------- */
function renderSettings() {
  const has = Boolean(state.account), online = has && state.online && !state.offline, stats = state.status?.stats || {}
  $('setAvatar').textContent = has ? glyph(state.account.nickname) : '初'
  $('setName').textContent = has ? state.account.nickname : '还没有连接'
  $('setState').textContent = !has ? '扫码后会自动把所有歌曲同步进来' : state.offline ? '离线中 · 档案和搜索照常可用' : online ? '已连接网易云音乐 · 登录 7 天内有效' : '只有本地档案 · 扫码登录后继续同步'
  $('setLogin').textContent = !has ? '扫码连接' : online ? '重新扫码' : '扫码登录'
  $('setLogin').disabled = state.offline || running()
  $('setLogout').hidden = !online || !state.local
  $('retryEmpty').disabled = !online || running() || !stats.empty
  $('retryEmpty').textContent = stats.empty ? `重新查询 ${n(stats.empty)} 首暂无记录的歌` : '没有需要重查的歌'
  for (const id of ['exportJson', 'exportCsv']) $(id).disabled = !has
  $('archiveNote').textContent = has && stats.discovered
    ? `${state.local ? '这个浏览器里' : '这台电脑上'}存着 ${n(stats.available)} 首初听、${n(stats.discovered)} 首歌曲。${state.local ? '换设备或清理浏览器前，先备份一份。' : ''}`
    : state.local ? '档案只保存在这个浏览器里。已有备份文件的话，可以直接导入。' : '档案保存在这台电脑上。'
}
function renderOffline(text) { $('offlineNote').textContent = text }
async function setupOffline(backend) {
  if (!backend.local) { $('offlineNote').closest('.set-group').hidden = true; return }
  if (!('serviceWorker' in navigator)) { renderOffline('这个浏览器不支持离线使用。'); return }
  const ready = '已可离线使用：断网时也能打开初听，翻看和搜索整份档案；看过的专辑封面也会留一份。'
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
    if (navigator.serviceWorker.controller) renderOffline(ready)
    else {
      renderOffline('正在准备离线版本…')
      navigator.serviceWorker.addEventListener('controllerchange', () => renderOffline(ready), { once: true })
    }
    // Check for a new version whenever the tab comes back; the worker itself always prefers the network.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}) })
  } catch { renderOffline('离线版本没能准备好，在线使用不受影响。') }
  addEventListener('beforeinstallprompt', event => {
    event.preventDefault()
    const button = $('installApp') || node('button', 'button ghost', '安装到桌面')
    button.id = 'installApp'; button.type = 'button'
    button.onclick = async () => { button.hidden = true; await event.prompt(); }
    if (!button.isConnected) { const row = node('div', 'set-actions'); row.append(button); $('offlineNote').after(row) }
    button.hidden = false
  })
}

/* ---------- 交互 ---------- */
function setOrder(order) {
  if (state.order === order) return
  const apply = () => { state.order = order; renderStatus(); renderTimeline() }
  try { localStorage.setItem('chuting-order', order) } catch {}
  if (motion && document.startViewTransition) document.startViewTransition(apply)
  else apply()
}
function clearSearch() {
  $('songSearch').value = ''
  clearTimeout(searchTimer)
  runSearch('')
}

/* ---------- 动效：指针光斑、回到顶部 ---------- */
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
  const stage = $('hlStage')
  let tiltFrame = 0
  stage.addEventListener('pointermove', e => {
    if (!motion || tiltFrame) return
    tiltFrame = requestAnimationFrame(() => {
      tiltFrame = 0
      const r = stage.getBoundingClientRect()
      stage.style.setProperty('--tx', ((e.clientX - r.left) / r.width - .5).toFixed(3))
      stage.style.setProperty('--ty', ((e.clientY - r.top) / r.height - .5).toFixed(3))
    })
  })
  stage.addEventListener('pointerleave', () => { stage.style.setProperty('--tx', 0); stage.style.setProperty('--ty', 0) })
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
reduced.addEventListener?.('change', () => {
  motion = !reduced.matches && 'IntersectionObserver' in window
  document.documentElement.classList.toggle('motion', motion)
  hl.paused = !motion; $('hlPlay').hidden = !motion || hl.items.length < 2; restartTimer()
})
requestAnimationFrame(() => document.documentElement.classList.add('ready'))
setupPointerEffects()
setupHighlights()
$('barAction').addEventListener('click', e => { const a = e.currentTarget.dataset.action; if (a === 'connect') connect(); else if (a === 'sync') startSync(); else if (a === 'pause') pauseSync() })
$('heroAction').addEventListener('click', e => e.currentTarget.dataset.action === 'connect' ? connect() : startSync())
$('settingsButton').addEventListener('click', () => { renderSettings(); openModal($('settingsDialog')) })
$('closeSettings').addEventListener('click', () => closeDialog($('settingsDialog')))
$('closeSong').addEventListener('click', () => closeDialog($('songDialog')))
$('closeLogin').addEventListener('click', () => closeDialog($('loginDialog')))
$('prevSong').addEventListener('click', () => stepSong(-1))
$('nextSong').addEventListener('click', () => stepSong(1))
$('songDialog').addEventListener('keydown', e => { if (e.key === 'ArrowLeft') stepSong(-1); if (e.key === 'ArrowRight') stepSong(1) })
$('orderNewest').addEventListener('click', () => setOrder('newest'))
$('orderOldest').addEventListener('click', () => setOrder('oldest'))
$('timeline').addEventListener('click', e => {
  const button = e.target.closest('.song')
  if (button) showSong(state.view[Number(button.dataset.index)], button)
})
$('scrubber').addEventListener('click', e => { const b = e.target.closest('.scrub-month'); if (b) jumpTo(b.dataset.month) })
$('songSearch').addEventListener('input', event => {
  if (event.isComposing) return // wait for the IME to commit Chinese/Japanese input
  clearTimeout(searchTimer)
  const value = event.target.value
  searchTimer = setTimeout(() => runSearch(value), value ? 60 : 0)
})
$('songSearch').addEventListener('compositionend', event => runSearch(event.target.value))
$('songSearch').addEventListener('keydown', e => { if (e.key === 'Escape' && e.target.value) { e.preventDefault(); clearSearch() } })
document.addEventListener('keydown', e => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || $('timelineSection').hidden) return
  e.preventDefault()
  $('songSearch').focus({ preventScroll: true })
  $('timelineSection').scrollIntoView({ behavior: motion ? 'smooth' : 'auto', block: 'start' })
})
$('pauseButton').addEventListener('click', pauseSync)
for (const [id, key] of [['optAuto', 'auto'], ['optHistory', 'history'], ['optPlaylists', 'playlists']]) {
  $(id).checked = settings[key]
  $(id).addEventListener('change', e => { settings[key] = e.target.checked; save('chuting-settings', settings) })
}
$('setLogin').addEventListener('click', () => { closeDialog($('settingsDialog')); connect() })
$('setLogout').addEventListener('click', async () => {
  try { await (await backendReady).logout(); state.online = false; renderStatus(); toast('已退出登录，本地档案还在') } catch (err) { fail(err) }
})
$('retryEmpty').addEventListener('click', () => { closeDialog($('settingsDialog')); startSync({ retry_empty: true }) })
$('importButton').addEventListener('click', () => $('importFile').click())
$('importFile').addEventListener('change', async event => {
  const file = event.target.files[0]
  if (!file) return
  try {
    if (file.size > 25 * 1024 * 1024) throw new Error('档案超过 25 MB，请拆分后再导入')
    toast('正在导入档案，请稍候…')
    let data
    try { data = JSON.parse(await file.text()) } catch { throw new Error('这个文件不是有效的 JSON 档案') }
    await (await backendReady).import(data)
    closeDialog($('settingsDialog'))
    state.initialized = false; state.counted = false; await loadStatus(true); await checkSession(); toast('档案已导入，欢迎回来'); autoSync()
  } catch (err) { fail(err) }
  event.target.value = ''
})
for (const id of ['exportJson', 'exportCsv']) $(id).addEventListener('click', async () => {
  try {
    const backend = await backendReady, format = id === 'exportCsv' ? 'csv' : 'json'
    if (backend.local) await backend.download(format); else location.href = `/api/export?format=${format}`
    toast(format === 'json' ? '备份已下载，换设备时导入它就行' : 'CSV 已下载')
  } catch (err) { fail(err) }
})
addEventListener('online', () => { state.offline = false; renderStatus(); checkSession().then(autoSync) })
addEventListener('offline', () => { state.offline = true; state.online = false; renderStatus() })
backendReady.then(backend => {
  state.local = backend.local
  $('historyRow').hidden = !backend.local
  $('storageNote').textContent = backend.local ? '档案只保存在这个浏览器里 · 断网也能翻看 · 时间按北京时间显示' : '所有数据只保存在这台电脑上 · 时间按北京时间显示'
  setupOffline(backend)
  renderStatus()
}).catch(() => {})
renderStatus(); renderTimeline()
loadStatus(true).then(async () => {
  await checkSession()
  if (!state.account && !(await backendReady).local) connect()
  else autoSync()
}).catch(err => { state.loading = false; state.error = err.message; renderStatus(); renderTimeline(); fail(err) })
