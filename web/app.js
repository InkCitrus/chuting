'use strict'
import { createBackend, remote } from './backend.js'
import { insights, artistRanks } from './insights.js'
import { renderPoster, sharePayload, shareMethod } from './share.js'
import { coverSize, coverUrl } from './archive-core.js'

// Rotator / copy / player are nice-to-have. If a stale cache drops one of them, the archive
// still opens: welcome copy stays put, rotation and playback quietly no-op.
const fallbackCopy = {
  WELCOME_LINES: ['每首歌，都有第一次响起的那天。'],
  SYNCING_LINES: ['正在一首首翻找，你和它们相遇的日子。'],
  LOADING_LINES: ['正在翻开你的初听…'],
  INTRO_TITLES: ['扫一次码，剩下的交给它'],
  CLOSING_LINES: ['第一次只有一次，所以值得记下来。'],
  SYNCING_EMPTY: ['第一首马上就到。'],
  taglines: () => fallbackCopy.WELCOME_LINES,
  timelineLedes: () => ['每一行，都是一首歌第一次响起的时刻。'],
  endTitles: () => ['故事暂时写到这里。']
}
const plain = line => String(line || '').replaceAll('*', '')
const softRotate = (el, pool) => { if (el) el.textContent = plain((pool && pool[0]) || '') }
const softClear = (el, text) => { if (el) el.textContent = text || '' }
const softPlayer = () => ({ show() {}, play() { return Promise.resolve({ ok: false, error: '', reason: '' }) }, unlock() {}, duck() { return Promise.resolve() }, get current() { return null }, get playing() { return false }, get note() { return '' }, setActions() {}, setOffline() {}, render() {} })

const [copyMod, rotMod, playerMod, capsuleMod, travelMod] = await Promise.all([
  import('./copy.js').catch(() => null),
  import('./rotator.js').catch(() => null),
  import('./player.js').catch(() => null),
  import('./capsule.js').catch(() => null),
  import('./travel.js').catch(() => null)
])
const { taglines, timelineLedes, endTitles, WELCOME_LINES, SYNCING_LINES, LOADING_LINES, INTRO_TITLES, CLOSING_LINES, SYNCING_EMPTY } = copyMod || fallbackCopy
const rotate = rotMod?.rotate || softRotate
const clearCopy = rotMod?.clearCopy || softClear
const createPlayer = playerMod?.createPlayer || softPlayer
const capsuleToday = capsuleMod?.capsuleToday
const yearsAgoLabel = capsuleMod?.yearsAgoLabel || (n => n === 1 ? '去年' : `${n} 年前`)
const capsuleNeighbors = capsuleMod?.neighbors || (() => [])
const capsuleRandom = capsuleMod?.randomMoment || (events => events[0] || null)
const sinceLabel = capsuleMod?.sinceLabel || (() => '')
const TRAVEL_MS = travelMod?.TRAVEL_MS || 2600
const TRAVEL_BACK_MS = travelMod?.TRAVEL_BACK_MS || 920
const TRAVEL_REDUCED_MS = travelMod?.TRAVEL_REDUCED_MS || 340
const easeOut = travelMod?.easeOut || (t => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3)
const easeTravel = travelMod?.easeTravel || (t => { const x = Math.min(1, Math.max(0, t)); return x * x * x * (x * (x * 6 - 15) + 10) })
const lerp = travelMod?.lerp || ((a, b, t) => a + (b - a) * t)
const clockParts = travelMod?.clockParts || (ms => { const d = new Date(ms); return Number.isNaN(d.getTime()) ? null : { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() } })
const pickTravelCovers = travelMod?.pickTravelCovers || ((events, target, limit = 48) => (target ? [target] : []).concat(events || []).slice(0, limit))
const fillTravelWall = travelMod?.fillTravelWall || (items => items || [])
const cardPose = travelMod?.cardPose || ((i, n, t) => ({ x: (i % 2 ? 1 : -1) * 400, y: 0, z: -400 + t * 800, opacity: 1, rotate: 0, scale: 1, blur: 0, brightness: 1 }))
const heroPose = travelMod?.heroPose || ((t) => ({ x: 0, y: 0, z: -200 + t * 240, scale: 0.4 + t, opacity: t < 0.6 ? 0 : 1, blur: 0, brightness: 1 }))
const travelFx = travelMod?.travelFx || (() => ({ flash: 0, streaks: 0, chroma: 0, bloom: 0.4 }))
const formatTravelMeta = travelMod?.formatTravelMeta || ((ms, toMs) => 'T−0')
const travelStageLayout = travelMod?.travelStageLayout || ((w, h) => ({ portrait: Number(h) > Number(w), wallX: 470, wallY: 278, faceCounts: [4, 4, 6, 6], perspective: 900, spacing: 310, zMin: -1640, tiles: 120, coverPx: 200 }))
const travelQuality = travelMod?.travelQuality || (() => 'full')
const cardTransform = travelMod?.cardTransform || ((pose) => `translate3d(${pose.x}px, ${pose.y}px, ${pose.z}px)`)
const cardDepthIndex = travelMod?.cardDepthIndex || (() => 1)
const cardKeyframes = travelMod?.cardKeyframes || null
const ringDepthIndex = travelMod?.ringDepthIndex || null
const tileLayout = travelMod?.tileLayout || null
const sampleTrack = travelMod?.sampleTrack || null
// Main-thread cadence during a compositor flight: clock digits, the name line
// and z-index at ring wraps. Any per-frame rAF makes Blink/WebKit restyle every
// animated card each frame, so the flight deliberately has none.
const FLIGHT_TICK_MS = 66
const canFly = typeof Element === 'function' && typeof Element.prototype.animate === 'function'
const TRAVEL_BACK_PX = travelMod?.TRAVEL_BACK_PX || 32
const TRAVEL_COVER_PX = travelMod?.TRAVEL_COVER_PX || 200
const TRAVEL_TILES = travelMod?.TRAVEL_TILES || travelMod?.TRAVEL_WALL || 72
const TRAVEL_MAX_COVERS = travelMod?.TRAVEL_MAX_COVERS || 48
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
// v3: only liked songs are synced by default; older saved choices keep just the auto-sync switch.
const savedSettings = stored('chuting-settings', {})
const settings = { auto: true, recent: false, playlists: false, history: false, likedOnly: false,
  ...(savedSettings.v === 3 ? savedSettings : { auto: savedSettings.auto ?? true }), v: 3 }
const LIKED = '喜欢的歌曲'
const wideScope = () => settings.recent || settings.playlists || settings.history
// Songs waiting in the current scope (liked songs only, unless more sources are switched on).
const pendingNow = stats => (wideScope() || stats.pending_liked == null ? stats.pending : stats.pending_liked) || 0
let storedOrder = 'newest'
try { storedOrder = localStorage.getItem('chuting-order') === 'oldest' ? 'oldest' : 'newest' } catch {}

const state = {
  account: null, status: null, initialized: false, loading: true, error: '', local: false, online: false, offline: !navigator.onLine,
  all: [], results: null, query: '', terms: [], order: storedOrder, request: 0, autoTried: false,
  view: [], chapters: [], rendered: 0, active: '', counted: false, current: -1,
}
let player = null
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
function artistCount(events) {
  const names = new Set()
  for (const e of events) for (const part of String(e.artists || '').split(' / ')) {
    const name = part.trim()
    if (name) names.add(name)
  }
  return names.size
}
function padDate(y, m, d) { return `${y}.${String(m).padStart(2, '0')}.${String(d).padStart(2, '0')}` }
function renderHeroStats(shown) {
  const box = $('heroStats')
  if (!box) return
  if (!shown) { box.hidden = true; return }
  const songs = $('statSongs'), artists = $('statArtists'), days = $('statDays')
  if (!songs || !artists || !days) return
  const sig = `${shown.available}-${shown.artists}-${shown.days}-${shown.range}`
  const before = [songs, artists, days].map(el => Number(String(el.textContent || '').replace(/[^\d]/g, '')))
  songs.textContent = n(shown.available)
  artists.textContent = n(shown.artists)
  days.textContent = n(shown.days)
  $('heroStatRange').textContent = shown.range || ''
  box.hidden = false
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig
    countUp(box, before.some(Boolean) ? before : [])
  }
}
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
function avatarThumb(url) { return coverSize(url, 96) }
function paintAvatar(el, account, { letter = '初' } = {}) {
  if (!el) return
  const text = account ? glyph(account.nickname || account.uid) : letter
  if (!account?.avatarUrl) { el.replaceChildren(); el.textContent = text; return }
  const img = new Image()
  img.alt = ''
  img.referrerPolicy = 'no-referrer'
  img.decoding = 'async'
  img.src = avatarThumb(account.avatarUrl)
  img.onerror = () => { el.replaceChildren(); el.textContent = text }
  el.replaceChildren(img)
}
function paintChipAvatar(account) {
  const img = $('accountAvatar'), name = $('accountName')
  if (name) name.textContent = account ? account.nickname : ''
  if (!img) return
  if (!account?.avatarUrl) { img.hidden = true; img.removeAttribute('src'); return }
  img.referrerPolicy = 'no-referrer'
  img.onerror = () => { img.hidden = true; img.removeAttribute('src') }
  // Show immediately; onerror hides. Avoids a cached-load race where onload fires before the handler binds.
  const src = avatarThumb(account.avatarUrl)
  img.hidden = false
  if (img.getAttribute('src') !== src) img.src = src
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
  const reveal = () => { if (img.naturalWidth) img.classList.add('loaded') }
  if (img.complete) reveal()
  else img.addEventListener('load', reveal, { once: true })
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
const PORTRAIT_TTL = 30 * 86400000
const DEFAULT_ARTIST_PIC = /\/(18686200114669622|5639395138885805)(\.|$)/
function readPortraitCache() {
  try { return JSON.parse(localStorage.getItem('chuting-artist-portraits') || '{}') } catch { return {} }
}
function writePortraitCache(cache) {
  try {
    const keys = Object.keys(cache)
    if (keys.length > 200) for (const key of keys.slice(0, keys.length - 200)) delete cache[key]
    localStorage.setItem('chuting-artist-portraits', JSON.stringify(cache))
  } catch { /* quota or private mode */ }
}
function squashName(value) {
  return String(value || '').toLowerCase().normalize('NFKC').replace(/\s+/g, '')
}
async function fetchArtistPortrait(name) {
  const key = String(name || '').trim()
  if (!key) return ''
  const cache = readPortraitCache()
  const hit = cache[key]
  if (hit && Date.now() - hit.checked_ms < PORTRAIT_TTL) return hit.picUrl || ''
  if (!state.account?.uid) return hit?.picUrl || ''
  try {
    const data = await remote('/api/netease', { method: 'artist_search', query: { s: key.slice(0, 80) }, uid: state.account.uid })
    const artists = data?.artists || []
    const want = squashName(key)
    const match = artists.find(a => squashName(a.name) === want)
      || artists.find(a => squashName(a.name).includes(want) || want.includes(squashName(a.name)))
      || artists[0]
    let pic = coverUrl(match?.picUrl || '')
    if (pic && DEFAULT_ARTIST_PIC.test(pic)) pic = ''
    cache[key] = { picUrl: pic, checked_ms: Date.now() }
    writePortraitCache(cache)
    return pic
  } catch { return hit?.picUrl || '' }
}
async function hydrateArtistPortrait() {
  const item = hl.items.find(entry => entry.kind === 'artist')
  if (!item?.title) return
  const pic = await fetchArtistPortrait(item.title)
  if (!pic || item.portrait === pic) return
  item.portrait = pic
  const slot = document.querySelector('.hl-slide[data-kind="artist"] .hl-portrait')
  if (!slot) return
  slot.replaceChildren(coverImg(pic, 400, true))
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
function countUp(root, from = []) {
  if (!motion) return
  for (const [k, b] of [...root.querySelectorAll('.num')].entries()) {
    const target = Number(b.textContent.replace(/[^\d]/g, '')), origin = from[k] ?? 0
    if (!target || target < 3 || origin === target) continue
    const start = performance.now() + k * 90, duration = from.length ? 700 : Math.min(1400, 600 + target * 4)
    b.classList.add('counting')
    const tick = now => {
      if (now < start) { requestAnimationFrame(tick); return }
      const t = Math.min(1, (now - start) / duration), eased = 1 - (1 - t) ** 4
      b.textContent = n(Math.round(origin + (target - origin) * eased))
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
  paintChipAvatar(has ? state.account : null)
  if (!$('accountName')) label.textContent = has ? state.account.nickname : ''
  label.dataset.state = !has ? 'none' : state.offline ? 'away' : online ? 'online' : 'offline'
  label.title = !has ? '' : state.offline ? '没网也能翻' : online ? '已连接网易云音乐' : '本地档案 · 扫码后接着同步'
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

  const story = $('heroStory'), sub = $('heroSub'), action = $('heroAction'), tagline = $('heroTagline')
  story.classList.toggle('is-loading', state.loading)
  $('heroKicker').textContent = has ? `网易云音乐 · ${state.account.nickname} 的初听档案` : '网易云音乐 · 初听档案'
  action.hidden = true
  $('scrollCue').hidden = true
  $('intro').hidden = state.loading || has || Boolean(state.error)
  if (!$('intro').hidden) rotate($('introTitle'), INTRO_TITLES, { interval: 9400, delay: 1800 })
  $('timelineSection').hidden = !state.loading && !has && !state.error
  if (state.loading) {
    story.replaceChildren(node('span', 'skeleton-line'), node('span', 'skeleton-line short'))
    rotate(sub, LOADING_LINES, { interval: 2400, delay: -1200 })
    rotate(tagline, WELCOME_LINES, { interval: 8200, delay: 3200 })
  } else if (!has) {
    sentence(story, ['扫一下，把你', ['喜欢的歌', 'mark'], '一首首送回第一次听见它的那天。'])
    rotate(tagline, WELCOME_LINES, { interval: 8200, delay: 3200 })
    clearCopy(sub, '先从你喜欢的歌开始，想多翻点，设置里再开。')
    action.textContent = '连接网易云音乐'; action.hidden = false; action.dataset.action = 'connect'
  } else if (!stats.available) {
    if (running()) {
      sentence(story, ['正在翻你', ['喜欢的歌', 'mark'], '，第一批马上就到。'])
      rotate(tagline, SYNCING_LINES, { interval: 7600, delay: 2600 })
      clearCopy(sub, stats.discovered ? `找到 ${n(stats.discovered)} 首，正在一首首问网易云。` : '先翻翻你喜欢的歌…')
    } else {
      sentence(story, ['还空着呢。', ['同步一下', 'mark'], '，看看你们是哪天认识的。'])
      rotate(tagline, WELCOME_LINES, { interval: 8200, delay: 3200 })
      clearCopy(sub, stats.discovered ? `找到 ${n(stats.discovered)} 首，还有 ${n(pendingNow(stats))} 首在排队。` : '先从「我喜欢的音乐」翻起。')
      if (!state.offline) { action.textContent = online || !state.local ? '开始同步' : '扫码登录，开始同步'; action.hidden = false; action.dataset.action = online || !state.local ? 'sync' : 'connect' }
    }
  } else {
    // Numbers follow what is shown (the liked-only filter included).
    const shown = state.all.length ? { earliest: state.all[0].date, latest: state.all.at(-1).date, days: new Set(state.all.map(e => e.date)).size, available: state.all.length, artists: artistCount(state.all) } : { ...calendar, available: stats.available, artists: 0 }
    const [ey, em, ed] = ymd(shown.earliest), [ly, lm, ld] = ymd(shown.latest)
    const from = `${ey} 年 ${em} 月 ${ed} 日`, to = ey === ly ? `${lm} 月 ${ld} 日` : `${ly} 年 ${lm} 月 ${ld} 日`
    const first = state.all[0]
    const pieces = ['从 ', [from, 'mark'], ' 到 ', [to, 'mark'], '，你在 ', [n(shown.days)], ' 个日子里，第一次听见了 ', [n(shown.available)], ' 首歌。']
    if (first) pieces.push('一切从', [`《${first.name}》`, 'mark wrap'], '开始。')
    rotate(tagline, taglines(state.all), { interval: 8200, delay: 1200 })
    const sig = `${shown.available}-${shown.days}-${first?.song_id}`
    if (!story.querySelector('.num') || story.dataset.sig !== sig) {
      const before = [...story.querySelectorAll('.num')].map(b => Number(b.textContent.replace(/[^\d]/g, '')))
      sentence(story, pieces)
      story.dataset.sig = sig
      if (!state.counted && first) { state.counted = true; countUp(story) }
      else if (before.length) countUp(story, before) // numbers glide from the old value while a sync adds songs
    }
    clearCopy(sub, pendingNow(stats)
      ? `还有 ${n(pendingNow(stats))} 首在排队`
      : state.local && !online
        ? '这份档案来自备份，扫码后就能接着同步'
        : wideScope() ? '都查完了' : '你喜欢的歌都查完了')
    renderHeroStats({ ...shown, range: `${padDate(ey, em, ed)}  —  ${padDate(ly, lm, ld)}` })
    $('scrollCue').hidden = false
    $('scrollCueText').textContent = state.order === 'newest' ? '最近的一首' : '最早的一首'
  }
  if (!has || !stats.available) renderHeroStats(null)
  renderHeroCapsule()

  const line = $('syncLine')
  line.hidden = !has || (!run && !stats.discovered)
  line.dataset.status = run ? run.status : 'idle'
  $('syncMessage').textContent = state.offline ? '没网了，先翻翻看'
    : run ? run.phase + (run.error && !running() ? ` · ${run.error}` : '')
    : state.local && !online ? '从备份里来的 · 扫码接着同步' : '还没有同步过'
  $('pauseButton').hidden = !running()
  const total = running() && run.total ? run.total : stats.discovered || 1
  $('coverageProgress').max = total
  $('coverageProgress').value = running() && run.total ? run.queried || 0 : stats.queried || 0
  const shareButton = $('shareButton')
  if (shareButton) shareButton.hidden = !state.all.length
  renderSettings()
  player?.setOffline(state.offline ? 'offline' : has && !online ? 'login' : null)
}

/* ---------- 高光轮播 ---------- */
// Auto-advances every HL_MS; holds while hovered, focused, off-screen, behind a dialog or in a hidden tab;
// never auto-advances with reduced motion. Dots, arrows, ←/→ and swipe all work by hand.
const hl = { items: [], sig: '', index: 0, timer: 0, start: 0, left: HL_MS, paused: !motion, holds: new Set() }
function renderHighlights() {
  const box = $('highlights')
  const items = state.loading || !state.all.length ? [] : insights(state.all)
  const sig = items.map(i => `${i.id}:${i.event?.song_id || i.title}:${i.cover || i.covers?.length || ''}`).join('|')
  if (box.hidden && items.length && motion && performance.now() < 8000 && !hl.introduced) {
    hl.introduced = true // the record drops in once, as part of the page-load choreography
    box.classList.add('is-intro'); hold('intro', true)
    setTimeout(() => { box.classList.remove('is-intro'); hold('intro', false) }, 2600)
  }
  box.hidden = !items.length
  document.querySelector('.hero').classList.toggle('has-highlights', items.length > 0)
  if (sig === hl.sig) { hydrateArtistPortrait(); return }
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
  hydrateArtistPortrait()
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
  } else if (item.kind === 'artist') {
    const portrait = node('span', 'hl-portrait')
    const src = item.portrait || item.covers?.[0]?.cover
    if (src) portrait.append(coverImg(src, 400, i === 0))
    else {
      const glyphEl = node('span', 'hl-portrait-glyph cover-tile', item.title.slice(0, 1))
      tint(glyphEl, { name: item.title, artists: item.title })
      portrait.append(glyphEl)
    }
    art.append(portrait)
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
  applyTone(document.querySelector('.hero'), slides[i].querySelector('.hl-sleeve .cover-img, .hl-portrait .cover-img, .hl-cell .cover-img'))
  if (!options.instant) document.dispatchEvent(new Event('chuting:slide'))
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
  // Drag follows the pointer (with resistance); on release the distance or the flick speed decides.
  let swipe = null, swiped = false
  const release = () => { stage.classList.remove('is-dragging'); stage.style.removeProperty('--drag') }
  stage.addEventListener('pointerdown', e => {
    if (e.button || hl.items.length < 2) return
    swipe = { x: e.clientX, y: e.clientY, t: e.timeStamp, lastX: e.clientX, lastT: e.timeStamp, v: 0, axis: '' }; swiped = false
  })
  stage.addEventListener('pointermove', e => {
    if (!swipe) return
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y
    if (!swipe.axis && Math.hypot(dx, dy) > 8) {
      swipe.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      if (swipe.axis === 'x') { stage.setPointerCapture?.(e.pointerId); stage.classList.add('is-dragging'); hold('drag', true) }
    }
    if (swipe.axis !== 'x') return
    const dt = Math.max(1, e.timeStamp - swipe.lastT)
    swipe.v = .7 * ((e.clientX - swipe.lastX) / dt) + .3 * swipe.v
    swipe.lastX = e.clientX; swipe.lastT = e.timeStamp
    if (motion) stage.style.setProperty('--drag', `${(dx / (1 + Math.abs(dx) / 260)).toFixed(1)}px`)
  })
  const end = e => {
    if (!swipe) return
    const dx = e.clientX - swipe.x, horizontal = swipe.axis === 'x', v = swipe.v
    swipe = null
    if (horizontal) hold('drag', false)
    release()
    if (horizontal && (Math.abs(dx) > 60 || (Math.abs(v) > .45 && Math.abs(dx) > 16))) {
      const dir = (Math.abs(v) > .45 ? v : dx) < 0 ? 1 : -1
      swiped = true; setSlide(hl.index + dir, { dir, announce: true })
    } else if (horizontal && Math.abs(dx) > 8) swiped = true
  }
  stage.addEventListener('pointerup', end)
  stage.addEventListener('pointercancel', () => { swipe = null; hold('drag', false); release() })
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
  if ($('capsuleButton')) $('capsuleButton').hidden = !state.all.length
  const lede = $('timelineLede')
  lede.hidden = state.loading || Boolean(search) || !state.all.length
  if (!lede.hidden) rotate(lede, timelineLedes(state.all, state.order), { interval: 11000, delay: 5200 })
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
    if (search) return timeline.append(emptyBlock('没找到这首', '换个词试试？', '清空搜索', clearSearch))
    if (state.account && running()) return timeline.append(emptyBlock('正在同步', SYNCING_EMPTY))
    if (state.account) return timeline.append(emptyBlock('这里还空着', '同步一下，这里就热闹了。', '开始同步', () => startSync()))
    return timeline.append(emptyBlock('从扫码开始', '扫一下，这里就开始写了。', '连接网易云音乐', connect))
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
  const title = node('p', 'end-title')
  end.append(node('span', 'end-mark'), title)
  rotate(title, endTitles(state.order), { interval: 9800, delay: 2400 })
  end.append(node('p', 'end-copy', running() ? '还在同步，新的会自己接上。' : pendingNow(stats) ? `还有 ${n(pendingNow(stats))} 首在排队。` : '下一首，等你去遇见。'))
  if (pendingNow(stats) && !running() && !state.offline) { const b = node('button', 'button ghost', '接着同步'); b.type = 'button'; b.addEventListener('click', () => startSync()); end.append(b) }
  return end
}
function emptyBlock(title, text, label, action) {
  const box = node('div', 'empty-block')
  const copy = node('p')
  box.append(node('span', 'end-mark'), node('h3', '', title), copy)
  if (Array.isArray(text)) rotate(copy, text, { interval: 6800, delay: 1500 }); else copy.textContent = text
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
function fillSong(event, follow = false) {
  state.current = event.index
  $('player').hidden = !(state.local && state.account)
  player?.show(event, { follow })
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
    ['初听时间', `${dayLabel(event.date, true)} ${weekday(event.date)} ${event.time}`],
    ['听了', event.play_count == null ? '—' : `${event.play_count.toLocaleString('zh-CN')} 遍`],
  ]
  if (event.album) entries.splice(1, 0, ['专辑', event.album])
  if (event.peak_count) entries.push(['听得最多的一天', `${event.peak_ms ? dayLabel(shanghaiDate(event.peak_ms), true) + '，' : ''}这一天听了 ${n(event.peak_count)} 遍`])
  if (event.status === 'conflict') entries.push(['时间有出入', '网易云给过不止一个答案：' + event.observations.map(o => `${o.upstream_date || o.first_listen_ms}`).join('；')])
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
  if (modalLayer.transition) { fillSong(event); if (!dialog.open) openModal(dialog); return }
  const from = source?.querySelector?.('.song-cover, .hl-sleeve, .hl-mosaic, .capsule-cover') || (source?.classList?.contains('capsule-cover') ? source : null)
  // Same-document View Transition: the row's cover morphs into the dialog artwork.
  if (motion && from && document.startViewTransition && !dialog.open) {
    from.style.viewTransitionName = 'song-art'
    if (history.state?.chutingModal !== dialog.id) {
      modalLayer.focus = document.activeElement
      modalLayer.id = dialog.id
      history.pushState({ chutingModal: dialog.id }, '')
    }
    const vt = document.startViewTransition(() => {
      from.style.viewTransitionName = ''
      fillSong(event)
      $('detailCover').style.viewTransitionName = 'song-art'
      dialog.showModal()
    })
    modalLayer.transition = vt
    vt.finished.finally(() => { $('detailCover').style.viewTransitionName = ''; modalLayer.transition = null; syncSettingsExpanded() })
    return
  }
  fillSong(event)
  if (!dialog.open) openModal(dialog)
}
function stepSong(delta) {
  const next = state.view[state.current + delta]
  if (!next) return
  const art = $('detailArt')
  if (motion) { art.classList.remove('swap'); void art.offsetWidth; art.classList.add('swap') }
  fillSong(next, true) // if a song is playing, the next one follows
}

/* ---------- 时间线定位 ---------- */
function locateInTimeline(event) {
  if (!event) return
  const song = state.all.find(e => e.song_id === event.song_id)
  if (!song) { toast('这首歌不在当前时间线里'); return }
  const go = () => {
    if (state.query && !state.view.some(e => e.song_id === song.song_id)) clearSearch()
    const key = song.date.slice(0, 7)
    if (!$(`m-${key}`)) renderMore(key)
    const el = $('timeline').querySelector(`.song[data-song="${song.song_id}"]`)
    if (!el) { toast('没能在时间线里找到这首'); return }
    el.closest('.chapter')?.querySelectorAll('.reveal').forEach(node => node.classList.add('shown'))
    $('timeline').querySelectorAll('.song.is-locate').forEach(node => node.classList.remove('is-locate'))
    el.classList.add('is-locate')
    el.scrollIntoView({ behavior: motion ? 'smooth' : 'auto', block: 'center' })
    try { el.focus({ preventScroll: true }) } catch {}
    const settle = (tries = 0) => requestAnimationFrame(() => {
      const r = el.getBoundingClientRect(), mid = innerHeight / 2
      const off = r.top + r.height / 2 - mid
      if (Math.abs(off) > 8 && tries < 8) { scrollBy(0, off); settle(tries + 1) }
    })
    if (motion) setTimeout(() => settle(), 280)
    const clear = () => el.classList.remove('is-locate')
    el.addEventListener('animationend', clear, { once: true })
    setTimeout(clear, 2400)
  }
  if (travel.open) finishTravel({ fromPop: false })
  const open = ['songDialog', 'capsuleDialog'].map($).filter(d => d?.open)
  if (open.length) {
    for (const d of open) closeDialog(d)
    setTimeout(go, motion ? 260 : 0)
  } else go()
}

/* ---------- 音乐时光胶囊 ---------- */
const capsule = { mode: 'today', lastRandom: null, todayPick: null }
function setLinkLabel(btn, text) {
  if (!btn) return
  const label = btn.querySelector('.text-link-label')
  if (label) label.textContent = text
  else btn.textContent = text
}
function setCapsuleLine(parts) {
  const line = $('heroCapsuleLine')
  if (!line) return
  line.replaceChildren()
  for (const part of parts) {
    if (typeof part === 'string') line.append(part)
    else {
      const el = document.createElement(part.tag || 'span')
      if (part.className) el.className = part.className
      el.textContent = part.text
      line.append(el)
    }
  }
}
function renderHeroCapsule() {
  const box = $('heroCapsule')
  if (!box) return
  const ready = !state.loading && state.all.length > 0
  box.hidden = !ready
  if (!ready) return
  const result = capsuleToday ? capsuleToday(state.all) : { kind: 'empty', songs: [], nearest: null }
  const todayBtn = $('heroTravelToday')
  capsule.todayPick = null
  if (result.kind === 'today' && result.songs.length) {
    const n = result.songs.length
    const first = result.songs[0].event
    if (n === 1) setCapsuleLine(['历史上的今天，你遇见了《', { className: 'hero-capsule-mark', text: first.name }, '》'])
    else setCapsuleLine(['历史上的今天，往年遇见过 ', { className: 'hero-capsule-date', text: String(n) }, ' 首'])
    if (todayBtn) {
      todayBtn.hidden = false
      setLinkLabel(todayBtn, '历史上的今天')
      todayBtn.title = '回到过去某年的同一天'
    }
    capsule.todayPick = first
  } else if (result.nearest?.songs?.length) {
    setCapsuleLine(['往年的今天还是空白。最靠近的是 ', { className: 'hero-capsule-date', text: `${result.nearest.m}月${result.nearest.d}日` }])
    if (todayBtn) {
      todayBtn.hidden = false
      setLinkLabel(todayBtn, '去那年的今天')
      todayBtn.title = '去往年里最靠近今天的那一天'
    }
    capsule.todayPick = result.nearest.songs[0].event
  } else {
    setCapsuleLine(['往年的今天，还没有记下初听'])
    if (todayBtn) todayBtn.hidden = true
  }
  preloadTravelLibrary()
}
function paintCapsuleRibbon() {
  const ribbon = $('capsuleRibbon')
  if (!ribbon) return
  ribbon.replaceChildren()
  const seen = new Set()
  for (const e of state.all) {
    if (!e.cover || seen.has(e.cover)) continue
    seen.add(e.cover)
    ribbon.append(tile(e, 'capsule-film', 80, false))
    if (seen.size >= 10) break
  }
}
function openCapsule(mode = 'today') {
  if (!state.all.length) { toast('还没有可以回顾的初听'); return }
  capsule.mode = mode === 'random' ? 'random' : 'today'
  renderCapsule()
  openModal($('capsuleDialog'))
}
function renderCapsule() {
  const todayBtn = $('capsuleTodayBtn'), randomBtn = $('capsuleRandomBtn'), body = $('capsuleBody')
  if (!todayBtn || !body || !capsuleToday) return
  const isToday = capsule.mode === 'today'
  todayBtn.setAttribute('aria-selected', String(isToday))
  randomBtn.setAttribute('aria-selected', String(!isToday))
  paintCapsuleRibbon()
  body.replaceChildren()
  if (isToday) renderCapsuleToday(body)
  else renderCapsuleRandom(body)
}
function capsuleSongButton(entry, extraClass = '') {
  const event = entry.event || entry
  const button = node('button', `capsule-song ${extraClass}`.trim())
  button.type = 'button'
  button.dataset.song = String(event.song_id)
  const cover = tile(event, 'capsule-cover', 96, true)
  cover.setAttribute('aria-hidden', 'true')
  const text = node('span', 'capsule-song-text')
  text.append(node('b', '', event.name), node('small', '', event.artists || '歌手未知'))
  button.append(cover, text)
  if (entry.yearsAgo) button.append(node('em', 'capsule-ago', yearsAgoLabel(entry.yearsAgo)))
  button.addEventListener('click', () => startTravel(event, { source: 'today' }))
  return button
}
function renderCapsuleToday(body) {
  const result = capsuleToday(state.all)
  const heading = node('p', 'capsule-lede')
  if (result.kind === 'today') {
    heading.textContent = `往年的今天，你遇见过 ${result.songs.length} 首。`
    body.append(heading)
    const list = node('div', 'capsule-list')
    result.songs.forEach((entry, i) => {
      const row = capsuleSongButton(entry)
      row.style.setProperty('--i', i)
      list.append(row)
    })
    body.append(list)
    return
  }
  heading.textContent = '往年的今天，还没有记下初听。'
  body.append(heading)
  if (result.nearest?.songs?.length) {
    const near = node('p', 'capsule-hint', `最靠近的是 ${result.nearest.m} 月 ${result.nearest.d} 日`)
    body.append(near)
    const list = node('div', 'capsule-list')
    result.nearest.songs.slice(0, 6).forEach((entry, i) => {
      const row = capsuleSongButton(entry)
      row.style.setProperty('--i', i)
      list.append(row)
    })
    body.append(list)
  } else {
    body.append(node('p', 'capsule-hint', '档案里还没有能对照的日子。'))
  }
  const retry = node('button', 'button ghost', '随机回到过去')
  retry.type = 'button'
  retry.addEventListener('click', () => { capsule.mode = 'random'; renderCapsule() })
  body.append(retry)
}
function renderCapsuleRandom(body) {
  if (!state.all.length) { body.append(node('p', 'capsule-lede', '还没有可以回顾的初听。')); return }
  const lede = node('p', 'capsule-lede', '不挑日子，从档案里随便抽一个第一次。也许是很久以前，也许就在上个月。')
  const hint = node('p', 'capsule-hint', '和「历史上的今天」不同：这里不会固定月日，每一次都是另一天。')
  const go = node('button', 'button primary', '随机穿越')
  go.type = 'button'
  go.addEventListener('click', () => {
    const event = capsuleRandom(state.all, Math.random, capsule.lastRandom)
    if (!event) return
    capsule.lastRandom = event.song_id
    startTravel(event, { source: 'random' })
  })
  body.append(lede, hint, go)
}


/* ---------- 时空穿梭 ---------- */
const travel = { open: false, phase: '', event: null, source: 'random', raf: 0, start: 0, duration: TRAVEL_MS, fromMs: 0, toMs: 0, play: null, skips: 0, layout: null, quality: 'full', frameBudget: [] }
function dismissCapsuleForTravel() {
  const d = $('capsuleDialog')
  if (!d?.open) return
  d.classList.remove('is-closing')
  d.close()
  if (history.state?.chutingModal === 'capsuleDialog') {
    history.replaceState({ chutingModal: 'travelOverlay' }, '')
    modalLayer.id = 'travelOverlay'
  }
}
function rollClockDigit(el, value) {
  if (!el) return
  const text = String(value).padStart(2, '0')
  if (el.dataset.value === text) return
  const prev = el.dataset.value
  el.dataset.value = text
  if (!prev) { el.textContent = text; return }
  el.replaceChildren()
  const out = node('span', 'travel-roll-out', prev)
  const inn = node('span', 'travel-roll-in', text)
  el.append(out, inn)
  const finish = () => { if (el.dataset.value === text) el.textContent = text }
  inn.addEventListener('animationend', finish, { once: true })
  setTimeout(finish, 180)
}
function paintTravelClock(ms, force = false) {
  const parts = clockParts(ms)
  if (!parts) return
  setText($('travelYear'), String(parts.y))
  setText($('travelMeta'), formatTravelMeta(ms, travel.toMs))
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  if (!force && travel.clockAt && now - travel.clockAt < 72) return
  travel.clockAt = now
  rollClockDigit($('travelMonth'), parts.m)
  rollClockDigit($('travelDay'), parts.d)
}
// Only transform and opacity change per frame (both composited). Depth shading is a dark layer whose
// opacity moves, not a filter; paint order comes from the 3D depth, not z-index. Writes are skipped when
// nothing changed so 120 tiles do not dirty style every frame.
function setStyle(el, key, value) {
  const cache = el._pose || (el._pose = {})
  if (cache[key] === value) return
  cache[key] = value
  el.style[key] = value
}
function applyCardPose(el, pose, { depth = false } = {}) {
  if (!el) return
  const visible = pose.opacity > 0.01
  setStyle(el, 'visibility', visible ? 'visible' : 'hidden')
  if (!visible) return
  setStyle(el, 'opacity', pose.opacity.toFixed(3))
  const layout = travel.layout || syncTravelStageLayout()
  setStyle(el, 'transform', cardTransform(pose, layout.cam))
  if (depth) setStyle(el, 'zIndex', String(cardDepthIndex(pose.z, layout)))
  const shade = el._shade || (el._shade = el.querySelector('.travel-card-shade'))
  if (shade) {
    const dark = pose.brightness == null ? 0 : Math.max(0, Math.min(1, 1 - pose.brightness))
    setStyle(shade, 'opacity', dark.toFixed(2))
  }
}
function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text
}
function detectTravelQuality() {
  // CriOS is Chrome-branded WebKit. It must not be treated as desktop Chrome:
  // a phone-sized touch viewport should ignore a Chromium-style deviceMemory
  // of 4 that would otherwise force the sparse lite tunnel.
  const phoneLike = (Number(navigator.maxTouchPoints) > 0) && Math.min(innerWidth || 0, innerHeight || 0) <= 520
  return travelQuality({
    reducedMotion: reduced.matches,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: phoneLike ? undefined : navigator.deviceMemory
  })
}
function syncTravelStageLayout() {
  const stage = $('travelStage')
  if (!travel.quality) travel.quality = detectTravelQuality()
  const layout = travelStageLayout(stage?.clientWidth || innerWidth || 1280, stage?.clientHeight || innerHeight || 800, travel.quality)
  travel.layout = layout
  if (stage) {
    stage.style.setProperty('--travel-perspective', `${layout.perspective}px`)
    stage.classList.toggle('is-portrait', !!layout.portrait)
    stage.classList.toggle('is-lite', layout.quality === 'lite')
  }
  // The vanishing point stays defined in CSS (perspective-origin); cards project
  // themselves around it, so no 3D rendering context is needed on the stage.
  let ox = 0, oy = 0
  if (stage && stage.clientWidth) {
    const [px, py] = String(getComputedStyle(stage).perspectiveOrigin || '').split(' ').map(parseFloat)
    if (Number.isFinite(px)) ox = px - stage.clientWidth / 2
    if (Number.isFinite(py)) oy = py - stage.clientHeight / 2
  }
  layout.cam = { perspective: layout.perspective, ox, oy }
  return layout
}
function travelCoverPx() {
  return (travel.layout || syncTravelStageLayout()).coverPx || TRAVEL_COVER_PX
}
function travelTileCount() {
  return (travel.layout || syncTravelStageLayout()).tiles || TRAVEL_TILES
}
function paintTravelBack(event) {
  const img = $('travelBackImg')
  if (!img) return
  const raw = event?.cover
  if (!raw) { img.hidden = true; return }
  // A 32px thumb stretched over the stage is the blur — no live CSS filter.
  const url = coverSize(raw, TRAVEL_BACK_PX)
  if (img.getAttribute('src') !== url) img.src = url
  img.hidden = false
}
// The flight runs on the compositor: one Web Animation per card (transform +
// opacity) and one per shade, built once from cardKeyframes. JS per frame only
// touches the clock, the hero, a few overlays, and a ring's z-index when it wraps.
function stopTunnelFlight() {
  const flight = travel.flight
  travel.flight = null
  if (!flight) return
  clearTimeout(flight.timer)
  for (const anim of flight.anims) { try { anim.cancel() } catch {} }
}
function startTunnelFlight(reverse, duration, start) {
  stopTunnelFlight()
  const cards = [...($('travelTunnel')?.children || [])]
  if (!canFly || !cardKeyframes || !ringDepthIndex || !cards.length) return null
  const layout = travel.layout || syncTravelStageLayout()
  const n = cards.length
  const timing = { duration, fill: 'both', easing: 'linear' }
  const anims = []
  try {
    cards.forEach((el, i) => {
      const kf = cardKeyframes(i, n, layout, layout.cam, { reverse })
      el._ring = kf.ring
      setStyle(el, 'visibility', 'visible')
      anims.push(el.animate(kf.card, timing))
      const shade = el._shade || (el._shade = el.querySelector('.travel-card-shade'))
      if (shade) anims.push(shade.animate(kf.shade, timing))
    })
  } catch {
    for (const anim of anims) { try { anim.cancel() } catch {} }
    return null
  }
  for (const anim of anims) anim.startTime = start
  const rings = tileLayout ? tileLayout(0, n, layout.faceCounts).rings : 0
  const perRing = tileLayout ? tileLayout(0, n, layout.faceCounts).perRing : n
  travel.flight = { anims, reverse, duration, start, cards, n, rings, perRing, held: null }
  return travel.flight
}
// Test hook (data-travel-hold) for the compositor path: freeze every card at
// the same raw time, or put them back on the shared start time.
function holdTunnelFlight(hold) {
  const flight = travel.flight
  if (!flight) return
  if (Number.isFinite(hold)) {
    if (flight.held === hold) return
    for (const anim of flight.anims) { anim.pause(); anim.currentTime = hold * flight.duration }
    flight.held = hold
  } else if (flight.held != null) {
    for (const anim of flight.anims) { anim.play(); anim.startTime = flight.start }
    flight.held = null
  }
}
function clockFade(t, reverse) {
  return reverse ? Math.min(1, t * 1.4) : (t < 0.72 ? 1 : Math.max(0, 1 - (t - 0.72) / 0.2))
}
// Hero, flash / streaks / chroma / bloom, progress bar and clock fade: the same
// formulas poseTravelCards uses per frame, sampled once into compositor tracks.
function animateTravelOverlays(flight, layout) {
  if (!sampleTrack) return
  const { reverse, duration, anims } = flight
  const timing = { duration, fill: 'both', easing: 'linear' }
  const add = (el, fn) => { if (el) anims.push(el.animate(sampleTrack(u => fn(easeTravel(u))), timing)) }
  const hero = $('travelHero')
  if (hero && !hero.hidden) {
    setStyle(hero, 'visibility', 'visible')
    add(hero, t => { const pose = heroPose(t, reverse); return { transform: cardTransform(pose, layout.cam), opacity: Number(pose.opacity.toFixed(3)) } })
    const shade = hero._shade || (hero._shade = hero.querySelector('.travel-card-shade'))
    add(shade, t => { const b = heroPose(t, reverse).brightness; return { opacity: Number((b == null ? 0 : Math.max(0, Math.min(1, 1 - b))).toFixed(3)) } })
  }
  add($('travelClock'), t => ({ opacity: Number(clockFade(t, reverse).toFixed(3)) }))
  add($('travelBar'), t => ({ transform: `scaleX(${Math.max(0, Math.min(1, reverse ? 1 - t : t)).toFixed(4)})` }))
  for (const [id, key] of [['travelFlash', 'flash'], ['travelStreaks', 'streaks'], ['travelChroma', 'chroma'], ['travelBloom', 'bloom']]) {
    add($(id), t => ({ opacity: Number((reverse ? { flash: 0, streaks: 0, chroma: 0, bloom: 0.35 } : travelFx(t))[key].toFixed(3)) }))
  }
  for (const anim of anims) anim.startTime = flight.start
}
// Runs a whole flight with no rAF loop. Returns false when the browser cannot
// (no Web Animations), so the caller keeps the per-frame fallback.
function flyTunnel({ reverse, duration, from, to, phase, onDone }) {
  const start = performance.now()
  const flight = startTunnelFlight(reverse, duration, start)
  if (!flight) return false
  const layout = travel.layout || syncTravelStageLayout()
  try { animateTravelOverlays(flight, layout) } catch {}
  const step = () => {
    if (travel.flight !== flight || travel.phase !== phase) return
    const hold = Number(document.documentElement.dataset.travelHold)
    holdTunnelFlight(hold)
    const held = Number.isFinite(hold)
    const raw = held ? Math.min(1, Math.max(0, hold)) : Math.min(1, (performance.now() - start) / duration)
    const t = easeTravel(raw)
    poseTravelCards(t, reverse)
    paintTravelClock(lerp(from, to, t), held)
    if (!held && raw >= 1) { onDone(); return }
    flight.timer = setTimeout(step, held ? 120 : Math.max(0, Math.min(FLIGHT_TICK_MS, duration * (1 - raw))))
  }
  flight.timer = setTimeout(step, 0)
  return true
}
function poseTravelFlight(t, reverse, layout) {
  const flight = travel.flight
  const p = reverse ? 1 - t : t
  const depth = []
  for (let r = 0; r < flight.rings; r++) depth.push(ringDepthIndex(r, p, layout, flight.rings))
  // Cached: a card's z-index is written only when its ring wraps.
  for (const el of flight.cards) if (depth[el._ring] != null) setStyle(el, 'zIndex', String(depth[el._ring]))
  // Name line: the nearest clearly visible ring, first named card in it.
  let pass = '', passZ = -Infinity
  for (let r = 0; r < flight.rings; r++) {
    const i0 = r * flight.perRing
    if (i0 >= flight.n) break
    const pose = cardPose(i0, flight.n, t, reverse, layout)
    if (!(pose.opacity > 0.55 && pose.z > passZ)) continue
    for (let i = i0; i < Math.min(flight.n, i0 + flight.perRing); i++) {
      const el = flight.cards[i]
      if (el?.dataset.name) { passZ = pose.z; pass = [el.dataset.name, el.dataset.artists].filter(Boolean).join(' · '); break }
    }
  }
  return pass
}
function poseTravelCards(t, reverse = false) {
  const cards = $('travelTunnel')?.children || []
  const n = cards.length
  const layout = travel.layout || syncTravelStageLayout()
  let pass = '', passZ = -Infinity
  if (travel.flight) pass = poseTravelFlight(t, reverse, layout)
  else for (let i = 0; i < n; i++) {
    const pose = cardPose(i, n, t, reverse, layout)
    applyCardPose(cards[i], pose, { depth: true })
    if (pose.opacity > 0.55 && pose.z > passZ && cards[i].dataset.name) {
      passZ = pose.z
      pass = [cards[i].dataset.name, cards[i].dataset.artists].filter(Boolean).join(' · ')
    }
  }
  const line = $('travelPass')
  if (line && t > 0.05 && t < 0.82 && pass) setText(line, pass)
  if (travel.flight) return
  const hero = $('travelHero')
  if (hero) applyCardPose(hero, heroPose(t, reverse))
  const clock = $('travelClock')
  if (clock) setStyle(clock, 'opacity', clockFade(t, reverse).toFixed(3))
  const bar = $('travelBar')
  if (bar) setStyle(bar, 'transform', `scaleX(${Math.max(0, Math.min(1, reverse ? 1 - t : t)).toFixed(3)})`)
  const fx = reverse ? { flash: 0, streaks: 0, chroma: 0, bloom: 0.35 } : travelFx(t)
  for (const [id, v] of [['travelFlash', fx.flash], ['travelStreaks', fx.streaks], ['travelChroma', fx.chroma], ['travelBloom', fx.bloom]]) {
    const el = $(id)
    if (el) setStyle(el, 'opacity', v.toFixed(2))
  }
}
function applyTravelGlow(event) {
  const overlay = $('travelOverlay')
  if (!overlay) return
  let rgb = '208 132 64'
  const imgs = []
  const seen = new Set()
  const target = event?.cover && travelArts.get(event.cover)
  if (target) { imgs.push(target); seen.add(target) }
  for (const img of travelArts.values()) {
    if (seen.has(img) || !img?.naturalWidth) continue
    imgs.push(img)
    if (imgs.length >= 8) break
  }
  try {
    const c = document.createElement('canvas')
    c.width = 10
    c.height = 10
    const ctx = c.getContext('2d', { willReadFrequently: true })
    let r = 0, g = 0, b = 0, w = 0
    imgs.forEach((img, index) => {
      ctx.clearRect(0, 0, 10, 10)
      ctx.drawImage(img, 0, 0, 10, 10)
      const data = ctx.getImageData(0, 0, 10, 10).data
      const face = index === 0 ? 1.15 : 1
      for (let i = 0; i < data.length; i += 4) {
        const rr = data[i], gg = data[i + 1], bb = data[i + 2]
        const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb)
        const sat = max ? (max - min) / max : 0
        if (max < 40) continue
        const wt = (0.15 + sat * 2.4) * face
        r += rr * wt; g += gg * wt; b += bb * wt; w += wt
      }
    })
    if (w) {
      r /= w; g /= w; b /= w
      const max = Math.max(r, g, b), min = Math.min(r, g, b)
      const sat = max ? (max - min) / max : 0
      if (sat < 0.36 && max) {
        const avg = (r + g + b) / 3
        const punch = (0.42 - sat) * 2.2
        r += (r - avg) * punch
        g += (g - avg) * punch
        b += (b - avg) * punch
      }
      rgb = `${Math.max(0, Math.min(255, Math.round(r)))} ${Math.max(0, Math.min(255, Math.round(g)))} ${Math.max(0, Math.min(255, Math.round(b)))}`
    }
  } catch {}
  overlay.style.setProperty('--travel-glow', rgb)
  $('travelStage')?.style.setProperty('--travel-glow', rgb)
}
const travelArts = new Map()
const travelArtsPending = new Map()
function coverThumb(url, px) {
  const clean = coverUrl(url) || url
  return coverSize(clean, px)
}
function clonedArt(img, className = '', decoding = 'async') {
  // Reuse the already-fetched URL so the HTTP cache paints immediately.
  // cloneNode of a decoded <img> can stay blank in WebKit.
  const next = new Image()
  next.alt = ''
  next.decoding = decoding
  next.referrerPolicy = 'no-referrer'
  if (className) next.className = className
  const src = img?.currentSrc || img?.src
  if (src) next.src = src
  return next
}
function decodeTravelCover(url, px = travelCoverPx()) {
  if (!url) return Promise.resolve(null)
  const cached = travelArts.get(url)
  if (cached?.naturalWidth > 0) return Promise.resolve(cached)
  const inflight = travelArtsPending.get(url)
  if (inflight) return inflight
  const img = new Image()
  img.decoding = 'async'
  img.referrerPolicy = 'no-referrer'
  // Do not set crossOrigin. NetEase sends ACAO:* together with
  // Allow-Credentials: true, which some WebKit builds reject; a failed
  // CORS attempt can also poison the cache so a no-CORS retry stays blank.
  img.src = coverThumb(url, px)
  const work = img.decode().then(() => {
    if (img.naturalWidth > 0) { travelArts.set(url, img); return img }
    return null
  }).catch(() => new Promise(resolve => {
    const finish = () => {
      if (img.naturalWidth > 0) { travelArts.set(url, img); resolve(img) }
      else resolve(null)
    }
    if (img.complete) { finish(); return }
    img.addEventListener('load', finish, { once: true })
    img.addEventListener('error', () => resolve(null), { once: true })
  })).finally(() => {
    if (travelArtsPending.get(url) === work) travelArtsPending.delete(url)
  })
  travelArtsPending.set(url, work)
  return work
}
function seedTravelCover(event, px = travelCoverPx()) {
  if (!event?.cover) return null
  const cached = travelArts.get(event.cover)
  if (cached?.naturalWidth > 0) return cached
  const img = new Image()
  img.decoding = 'async'
  img.referrerPolicy = 'no-referrer'
  img.src = coverThumb(event.cover, px)
  const remember = () => { if (img.naturalWidth > 0) travelArts.set(event.cover, img) }
  if (img.complete) remember()
  else img.addEventListener('load', remember, { once: true })
  return img
}
let travelCoverPick = null
function refreshTravelCoverPick(target) {
  travelCoverPick = pickTravelCovers(state.all, target, TRAVEL_MAX_COVERS)
  return travelCoverPick
}
function tunnelCoverPick(target) {
  if (!travelCoverPick?.length) refreshTravelCoverPick(target)
  return travelCoverPick
}
function preloadTravelLibrary() {
  const picked = refreshTravelCoverPick(capsule.todayPick || state.all[0])
  for (const e of picked) if (e?.cover) decodeTravelCover(e.cover)
}
function readyTravelArts(picked) {
  const out = []
  const seen = new Set()
  for (const e of picked || []) {
    const img = e?.cover && travelArts.get(e.cover)
    if (!img?.naturalWidth || seen.has(e.cover)) continue
    seen.add(e.cover)
    out.push({ event: e, img })
  }
  return out
}
function gatherTravelArts(target, picked = tunnelCoverPick(target)) {
  return fillTravelWall(readyTravelArts(picked).filter(a => a.event?.song_id !== target?.song_id), travelTileCount())
}
function waitMs(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
async function collectTunnelArts(target) {
  const picked = tunnelCoverPick(target)
  const px = travelCoverPx()
  if (target?.cover) decodeTravelCover(target.cover, px)
  const pending = picked.map(e => e.cover ? decodeTravelCover(e.cover, px) : Promise.resolve(null))
  const pictured = picked.filter(e => e?.cover)
  const want = Math.max(1, Math.min(12, pictured.length || 1))
  await Promise.race([Promise.all(pending).catch(() => {}), waitMs(800)])
  let ready = readyTravelArts(picked)
  if (ready.length < want) {
    await Promise.race([Promise.all(pending).catch(() => {}), waitMs(700)])
    ready = readyTravelArts(picked)
  }
  if (!ready.length && target?.cover) {
    const one = await decodeTravelCover(target.cover, px)
    if (one) ready = [{ event: target, img: one }]
  }
  const others = ready.filter(a => a.event?.song_id !== target?.song_id)
  const wall = fillTravelWall(others.length ? others : ready, travelTileCount())
  if (wall.length) return wall
  // Never start with empty dark glyphs when cover URLs exist: plant images
  // that can fill in from cache as they load, then repeat them to fill the wall.
  const seeds = (pictured.length ? pictured : (target?.cover ? [target] : []))
    .map(e => ({ event: e, img: seedTravelCover(e, px) }))
    .filter(a => a.img)
  return fillTravelWall(seeds, travelTileCount())
}
function makeTravelCard(art, extraClass = '') {
  const card = node('span', extraClass ? `travel-card ${extraClass}` : 'travel-card')
  if (art?.event?.name) card.dataset.name = art.event.name
  if (art?.event?.artists) card.dataset.artists = art.event.artists
  card.append(clonedArt(art.img, 'travel-card-art'), node('i', 'travel-card-shade'))
  return card
}
function paintTravelHero(target) {
  const hero = $('travelHero')
  if (!hero) return
  hero.replaceChildren()
  hero.hidden = true
  const img = target?.cover && travelArts.get(target.cover)
  if (img) {
    hero._pose = null
    hero._shade = null
    hero.append(clonedArt(img, 'travel-card-art', 'sync'), node('i', 'travel-card-shade'))
    hero.hidden = false
    applyCardPose(hero, heroPose(0))
  }
}
function buildTravelTunnel(target, arts) {
  const tunnel = $('travelTunnel')
  if (!tunnel) return 0
  stopTunnelFlight()
  tunnel.replaceChildren()
  const ready = arts && arts.length ? arts : readyTravelArts(tunnelCoverPick(target))
  const want = travelTileCount()
  const walls = fillTravelWall(ready.filter(a => a.event?.song_id !== target?.song_id), want)
  const list = walls.length ? walls : fillTravelWall(ready, want)
  if (!list.length) {
    const picked = pickTravelCovers(state.all, target, TRAVEL_MAX_COVERS)
    const pictured = picked.filter(e => e.cover)
    if (pictured.length) {
      const seeded = fillTravelWall(pictured.map(e => ({ event: e, img: seedTravelCover(e) })).filter(a => a.img), want)
      for (const art of seeded) tunnel.append(makeTravelCard(art))
    } else {
      for (const e of picked.slice(0, 8)) tunnel.append(tile(e, 'travel-card is-glyph', 160, true))
    }
  } else {
    for (const art of list) if (art?.img) tunnel.append(makeTravelCard(art))
  }
  paintTravelHero(target)
  return tunnel.children.length
}
function nearbyFirsts(event) {
  let near = capsuleNeighbors(state.all, event, { days: 3, limit: 4 })
  if (!near.length) near = capsuleNeighbors(state.all, event, { days: 30, limit: 4 })
  if (!near.length) {
    near = (state.all || [])
      .filter(e => e.song_id !== event.song_id)
      .sort((a, b) => Math.abs((a.first_listen_ms || 0) - event.first_listen_ms) - Math.abs((b.first_listen_ms || 0) - event.first_listen_ms)
        || (a.first_listen_ms || 0) - (b.first_listen_ms || 0))
      .slice(0, 4)
  }
  return near
}
function arriveImg(event, className = '') {
  const decoded = event.cover && travelArts.get(event.cover)
  if (decoded) return clonedArt(decoded, className, 'sync')
  if (!event.cover) return null
  const img = new Image()
  img.alt = ''
  img.decoding = 'async'
  img.referrerPolicy = 'no-referrer'
  if (className) img.className = className
  img.src = coverSize(event.cover, TRAVEL_COVER_PX)
  return img
}
// Background layers stack; a new one fades in over the old, then the old is dropped.
function paintArriveBg(event, { fade = false } = {}) {
  const bg = $('arriveBg')
  if (!bg) return
  const raw = event?.cover
  if (!raw) { if (!fade) bg.replaceChildren(); return }
  // Same cheap wash as the tunnel: a 32px thumb, no live CSS blur to tear down on return.
  const img = new Image()
  img.alt = ''
  img.decoding = 'async'
  img.referrerPolicy = 'no-referrer'
  img.src = coverSize(raw, TRAVEL_BACK_PX)
  const layer = node('div', 'arrive-bg-layer')
  layer.append(img)
  if (!fade || !motion || reduced.matches) { bg.replaceChildren(layer); return }
  bg.append(layer)
  const anim = layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 520, easing: 'ease-out' })
  anim.finished.then(() => { if (layer.isConnected) [...bg.children].forEach(c => { if (c !== layer && bg.lastElementChild === layer) c.remove() }) }).catch(() => {})
}
function paintArriveArt(event) {
  const current = $('arriveArt')
  if (!current) return
  const img = arriveImg(event, 'arrive-art-img')
  let next
  if (img) { next = node('div', 'arrive-art'); next.append(img) }
  else next = tile(event, 'arrive-art', 400, true)
  next.id = 'arriveArt'
  current.replaceWith(next)
}
function paintArriveText(event) {
  const when = `${dayLabel(event.date, true)}${event.time ? ` ${event.time}` : ''}`
  setText($('arriveWhen'), when)
  const since = sinceLabel(event.first_listen_ms) || ''
  const sinceEl = $('arriveSince')
  if (sinceEl) { sinceEl.textContent = since; sinceEl.hidden = !since }
  setText($('travelTitle'), event.name || '')
  setText($('arriveArtists'), event.artists || '歌手未知')
}
// "Around then": the arrived song plus its neighbours, in listening order. Switching to a song already on
// the shelf only moves the marker, so the shelf reads as one place in time rather than a new trip.
function shortDay(event) {
  const [, m, d] = ymd(event.date)
  return `${m}.${String(d).padStart(2, '0')}`
}
function paintArriveShelf(event) {
  const around = $('arriveAround')
  if (!around) return
  const items = [event, ...nearbyFirsts(event)]
    .sort((a, b) => (a.first_listen_ms || 0) - (b.first_listen_ms || 0))
  around.replaceChildren()
  around.hidden = items.length < 2
  if (items.length < 2) return
  around.append(node('p', 'arrive-around-label', '那时前后的初听'))
  const list = node('div', 'arrive-shelf')
  for (const [i, item] of items.entries()) {
    const btn = node('button', 'arrive-near')
    btn.style.setProperty('--i', String(i))
    btn.type = 'button'
    btn.dataset.id = String(item.song_id)
    const cover = node('span', 'arrive-near-cover')
    const img = arriveImg(item)
    if (img) cover.append(img)
    else cover.append(tile(item, 'arrive-near-glyph', 120, true))
    const text = node('span', 'arrive-near-text')
    text.append(node('span', 'arrive-near-name', item.name || ''), node('span', 'arrive-near-day', shortDay(item)))
    btn.append(cover, text)
    btn.title = [item.name, item.artists].filter(Boolean).join(' · ')
    btn.addEventListener('click', () => switchArrival(item))
    list.append(btn)
  }
  around.append(list)
  markArriveShelf(event)
}
function markArriveShelf(event) {
  const list = $('arriveAround')?.querySelector('.arrive-shelf')
  if (!list) return false
  let found = false
  for (const btn of list.children) {
    const on = btn.dataset.id === String(event.song_id)
    found ||= on
    if (on) btn.setAttribute('aria-current', 'true')
    else btn.removeAttribute('aria-current')
  }
  return found
}
function revealShelfItem(event) {
  const list = $('arriveAround')?.querySelector('.arrive-shelf')
  const btn = list && [...list.children].find(b => b.dataset.id === String(event.song_id))
  if (!btn || list.scrollWidth <= list.clientWidth) return
  const left = btn.offsetLeft - (list.clientWidth - btn.offsetWidth) / 2
  list.scrollTo({ left: Math.max(0, left), behavior: motion && !reduced.matches ? 'smooth' : 'auto' })
}
function paintArriveActions() {
  // Rerolling only makes sense for a random trip; "that day" already is the answer.
  const reroll = $('arriveReroll')
  const isRandom = travel.source !== 'today'
  if (reroll) reroll.hidden = !isRandom
  return isRandom ? reroll : $('arriveLocate')
}
function paintArriveNote(result) {
  const note = $('arriveNote')
  if (!note) return
  if (!result) return
  if (result.ok) {
    note.hidden = true; note.textContent = ''; note.classList.remove('is-wait-play')
    $('arriveArt')?.classList.remove('is-wait-play')
    return
  }
  const reason = result.reason || ''
  const raw = result.error || player?.note || ''
  const blocked = result.blocked || reason === 'blocked'
  const msg = blocked ? '轻点封面即可播放'
    : reason === 'login' || raw === '扫码登录后就能听。'
    ? '扫码登录后，穿越时会把歌一起带上。'
    : reason === 'offline' || raw === '没网，先不放歌了。'
      ? '没网，先不放歌了。'
      : raw || '这次没能把歌一起带回来。'
  note.textContent = msg
  note.hidden = !msg
  note.classList.toggle('is-wait-play', blocked)
  $('arriveArt')?.classList.toggle('is-wait-play', blocked)
}
// A play result only speaks for the song it was about. Auto-skip, the end of a
// song or a newer tap supersede travel.play, so follow the player's newest job
// and drop results (including stale ones without song_id) for any other song.
function resultFor(event, result) {
  return Boolean(result && event && result.song_id != null && String(result.song_id) === String(event.song_id))
}
function watchArriveNote(event) {
  const job = (player?.current?.song_id === event?.song_id && player?.job) || travel.play
  if (job && typeof job.then === 'function') {
    job.then(result => { if (travel.event === event && resultFor(event, result)) paintArriveNote(result) })
  } else if (player?.note) paintArriveNote({ ok: false, error: player.note })
  else paintArriveNote({ ok: Boolean(player?.playing && player?.current?.song_id === event.song_id) })
}
function showArrival(event) {
  if (!event) return
  const overlay = $('travelOverlay')
  overlay?.classList.add('is-arrive')
  overlay?.classList.remove('is-going')
  const leftover = $('travelHero')
  if (leftover) { leftover._pose = null; leftover.style.opacity = '0'; leftover.hidden = true }
  const box = $('travelArrive')
  if (box) box.hidden = false
  paintArriveBg(event)
  paintArriveArt(event)
  paintArriveText(event)
  watchArriveNote(event)
  paintArriveShelf(event)
  requestAnimationFrame(() => { const list = $('arriveAround')?.querySelector('.arrive-shelf'); const on = list?.querySelector('[aria-current]'); if (on && list.scrollWidth > list.clientWidth) list.scrollLeft = Math.max(0, on.offsetLeft - (list.clientWidth - on.offsetWidth) / 2) })
  paintArriveActions()
  queueMicrotask(() => { try { box?.focus({ preventScroll: true }) } catch {} })
}
// Moving to another song while already "there": no tunnel, the page slides sideways in time.
function switchArrival(item, { play = true } = {}) {
  if (!item || travel.phase !== 'arrive') return
  const prev = travel.event
  if (prev?.song_id === item.song_id) {
    if (play && !(player?.playing && player?.current?.song_id === item.song_id)) travel.play = player?.play?.(item)
    return
  }
  travel.event = item
  travel.toMs = item.first_listen_ms || travel.toMs
  if (play) {
    // play() starts in this tap. Calling unlock() first would consume the
    // iOS user gesture and make the later src+play() fail with NotAllowedError.
    travel.play = player?.play?.(item)
  } else {
    travel.play = null
  }
  if (item.cover) decodeTravelCover(item.cover)
  const dir = (item.first_listen_ms || 0) >= (prev?.first_listen_ms || 0) ? 1 : -1
  const swap = () => {
    paintArriveArt(item)
    paintArriveText(item)
    if ($('arriveNote')) $('arriveNote').hidden = true
    watchArriveNote(item)
    if (!markArriveShelf(item)) paintArriveShelf(item)
    revealShelfItem(item)
  }
  paintArriveBg(item, { fade: true })
  if (!motion || reduced.matches || !play) { swap(); return }
  const ease = 'cubic-bezier(.16, 1, .3, 1)'
  // Cover: the old one stays on top as a ghost and drifts away while the new one settles in beneath.
  const oldArt = $('arriveArt')
  const lines = () => ['arriveWhen', 'travelTitle', 'arriveArtists'].map(id => id === 'arriveWhen' ? $(id)?.parentElement : $(id)).filter(Boolean)
  const outs = lines().map((el, i) => el.animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${-dir * 16}px)` }],
    { duration: 150, delay: i * 22, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' }))
  paintArriveArt(item)
  const newArt = $('arriveArt')
  if (oldArt && newArt && oldArt !== newArt) {
    oldArt.removeAttribute('id')
    oldArt.classList.add('is-ghost')
    oldArt.setAttribute('aria-hidden', 'true')
    newArt.after(oldArt)
    oldArt.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${-dir * 40}px) scale(.94)` }],
      { duration: 420, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' }).finished.finally(() => oldArt.remove())
    newArt.animate([{ opacity: 0, transform: `translateX(${dir * 48}px) scale(.94)` }, { opacity: 1, transform: 'none' }],
      { duration: 640, delay: 60, easing: ease, fill: 'backwards' })
  }
  if (!markArriveShelf(item)) paintArriveShelf(item)
  revealShelfItem(item)
  Promise.all(outs.map(an => an.finished.catch(() => {}))).then(() => {
    if (travel.event !== item) return
    outs.forEach(an => an.cancel())
    paintArriveText(item)
    if ($('arriveNote')) $('arriveNote').hidden = true
    watchArriveNote(item)
    lines().forEach((el, i) => el.animate(
      [{ opacity: 0, transform: `translateX(${dir * 22}px)` }, { opacity: 1, transform: 'none' }],
      { duration: 560, delay: i * 50, easing: ease, fill: 'backwards' }))
  })
}
function syncTravelEventFromPlayer() {
  const current = player?.current
  if (!current || !travel.open) return travel.event
  if (travel.event?.song_id === current.song_id) return travel.event
  travel.event = current
  travel.toMs = current.first_listen_ms || travel.toMs
  return current
}
function finishGoing() {
  const event = syncTravelEventFromPlayer() || travel.event
  stopTunnelFlight()
  travel.phase = 'arrive'
  paintTravelClock(travel.toMs, true)
  poseTravelCards(1, false)
  const hero = $('travelHero')
  const canMorph = motion && !reduced.matches && typeof document.startViewTransition === 'function'
    && hero && !hero.hidden && event?.cover && hero.querySelector('img')
  if (canMorph) {
    hero.style.viewTransitionName = 'travel-hero'
    const vt = document.startViewTransition(() => {
      hero.style.viewTransitionName = ''
      showArrival(travel.event || event)
      const art = $('arriveArt')
      if (art) art.style.viewTransitionName = 'travel-hero'
    })
    vt.finished.finally(() => { const art = $('arriveArt'); if (art) art.style.viewTransitionName = '' })
    return
  }
  showArrival(travel.event || event)
}
function skipTravel() {
  if (travel.phase !== 'going' && travel.phase !== 'waiting') return
  cancelAnimationFrame(travel.raf)
  finishGoing()
}
function beginTravelMotion(event, arts) {
  if (travel.event !== event || (travel.phase !== 'going' && travel.phase !== 'waiting')) return
  travel.phase = 'going'
  travel.clockAt = 0
  syncTravelStageLayout()
  buildTravelTunnel(event, arts)
  paintTravelBack(travel.event || event)
  applyTravelGlow(event)
  if ($('travelClock')) $('travelClock').style.opacity = '1'
  poseTravelCards(0, false)
  paintTravelClock(travel.fromMs, true)
  cancelAnimationFrame(travel.raf)
  travel.start = performance.now()
  travel._lastTick = 0
  if (flyTunnel({ reverse: false, duration: travel.duration, from: travel.fromMs, to: travel.toMs, phase: 'going', onDone: () => finishGoing() })) return
  const tick = now => {
    const hold = Number(document.documentElement.dataset.travelHold)
    const raw = Number.isFinite(hold) ? Math.min(1, Math.max(0, hold)) : Math.min(1, (now - travel.start) / travel.duration)
    const t = easeTravel(raw)
    if (!Number.isFinite(hold) && travel.quality === 'full') {
      const samples = travel.frameBudget
      if (travel._lastTick) samples.push(now - travel._lastTick)
      travel._lastTick = now
      // Ignore the opening hitch and one-off spikes so a capable desktop
      // does not drop cinematic layers after a single slow frame.
      if (samples.length === 24) {
        const steady = samples.slice(4).filter(d => d < 80)
        const avg = steady.length ? steady.reduce((a, b) => a + b, 0) / steady.length : 0
        if (steady.length >= 12 && avg > 28 && travel.layout?.portrait) {
          travel.quality = 'lite'
          $('travelStage')?.classList.add('is-lite')
        }
      }
    }
    poseTravelCards(t, false)
    paintTravelClock(lerp(travel.fromMs, travel.toMs, t), Number.isFinite(hold))
    if (Number.isFinite(hold) && travel.phase === 'going') { travel.raf = requestAnimationFrame(tick); return }
    if (raw < 1 && travel.phase === 'going') travel.raf = requestAnimationFrame(tick)
    else if (travel.phase === 'going') finishGoing()
  }
  travel.raf = requestAnimationFrame(tick)
}
function startTravel(event, { source = 'random' } = {}) {
  if (!event) return
  dismissCapsuleForTravel()
  const continuing = travel.open && travel.event
  travel.event = event
  travel.source = source
  travel.open = true
  travel.phase = 'waiting'
  travel.skips = 0
  travel.quality = detectTravelQuality()
  travel.frameBudget = []
  syncTravelStageLayout()
  travel.fromMs = continuing ? (continuing.first_listen_ms || Date.now()) : Date.now()
  travel.toMs = event.first_listen_ms || travel.fromMs
  const quiet = reduced.matches || !motion
  travel.duration = quiet ? TRAVEL_REDUCED_MS : TRAVEL_MS
  document.body.classList.add('has-travel')
  const overlay = $('travelOverlay')
  if ($('travelArrive')) $('travelArrive').hidden = true
  if ($('travelStage')) { $('travelStage').hidden = quiet; $('travelStage').classList.toggle('is-reduced', quiet) }
  overlay?.classList.toggle('is-arrive', false)
  overlay?.classList.toggle('is-going', !quiet)
  paintTravelClock(quiet ? travel.toMs : travel.fromMs)
  if (overlay && !overlay.open) openModal(overlay)
  const same = player?.current?.song_id === event.song_id && player?.playing
  if (!same) {
    player?.duck?.(240)
    travel.play = player?.play?.(event, { fadeIn: 1600 })
    if (travel.play?.then) travel.play.then(result => { if (travel.event === event && travel.phase === 'arrive' && resultFor(event, result)) paintArriveNote(result) })
  } else {
    travel.play = Promise.resolve({ ok: true })
  }
  cancelAnimationFrame(travel.raf)
  if (event.cover) decodeTravelCover(event.cover)
  if (quiet) { finishGoing(); return }
  collectTunnelArts(event).then(arts => {
    if (!travel.open || (travel.phase !== 'waiting' && travel.phase !== 'going')) return
    // The player may already have skipped to another playable track.
    beginTravelMotion(travel.event || event, arts)
  })
}
function rerollTravel() {
  let next = null
  if (travel.source === 'today') {
    const result = capsuleToday?.(state.all)
    const songs = (result?.kind === 'today' ? result.songs : result?.nearest?.songs) || []
    const ids = songs.map(s => (s.event || s).song_id)
    const idx = ids.indexOf(travel.event?.song_id)
    const pick = songs.length ? songs[(Math.max(idx, 0) + 1) % songs.length] : null
    next = pick ? (pick.event || pick) : null
    if (next?.song_id === travel.event?.song_id) next = null
  }
  if (!next) next = capsuleRandom(state.all, Math.random, travel.event?.song_id)
  if (next) startTravel(next, { source: travel.source === 'today' && next ? travel.source : 'random' })
}
function returnToPresent({ fromPop = false } = {}) {
  if (!travel.open) {
    if ($('travelOverlay')?.open) finishTravel({ fromPop })
    return
  }
  cancelAnimationFrame(travel.raf)
  const canRewind = motion && !reduced.matches && travel.phase === 'arrive' && !fromPop
  if (canRewind) {
    travel.phase = 'back'
    const overlay = $('travelOverlay')
    // Reuse the going tiles when they are still in the DOM; rebuild only
    // from already-decoded covers so the rewind never flashes empty faces.
    if (!$('travelTunnel')?.children.length) {
      const cached = gatherTravelArts(travel.event)
      buildTravelTunnel(travel.event, cached.length ? cached : undefined)
    }
    syncTravelStageLayout()
    paintTravelBack(travel.event)
    // Reveal the 3D stage under the still-visible arrival page so GPU
    // layers are warm before we hide the arrival UI and start motion.
    overlay?.classList.add('is-going')
    overlay?.classList.remove('is-arrive')
    if ($('travelStage')) $('travelStage').hidden = false
    poseTravelCards(0, true)
    paintTravelClock(travel.toMs, true)
    travel.duration = TRAVEL_BACK_MS
    const from = travel.toMs, to = Date.now()
    const begin = () => {
      if (travel.phase !== 'back') return
      if ($('travelArrive')) $('travelArrive').hidden = true
      travel.start = performance.now()
      if (flyTunnel({ reverse: true, duration: travel.duration, from, to, phase: 'back', onDone: () => finishTravel({ fromPop }) })) return
      const tick = now => {
        const raw = Math.min(1, (now - travel.start) / travel.duration)
        const t = easeTravel(raw)
        poseTravelCards(t, true)
        paintTravelClock(lerp(from, to, t))
        if (raw < 1 && travel.phase === 'back') travel.raf = requestAnimationFrame(tick)
        else if (travel.phase === 'back') finishTravel({ fromPop })
      }
      travel.raf = requestAnimationFrame(tick)
    }
    travel.raf = requestAnimationFrame(() => {
      poseTravelCards(0, true)
      travel.raf = requestAnimationFrame(begin)
    })
    return
  }
  finishTravel({ fromPop })
}
function finishTravel({ fromPop = false } = {}) {
  cancelAnimationFrame(travel.raf)
  stopTunnelFlight()
  const overlay = $('travelOverlay')
  travel.phase = ''
  travel.open = false
  if ($('travelStage')) $('travelStage').hidden = true
  $('travelTunnel')?.replaceChildren()
  const hero = $('travelHero')
  if (hero) { hero.replaceChildren(); hero.hidden = true; hero._pose = null; hero._shade = null }
  const revealHome = () => {
    document.body.classList.remove('has-travel')
    overlay?.classList.remove('is-arrive', 'is-going', 'is-closing')
    if (overlay?.open) overlay.close()
    if (!fromPop && history.state?.chutingModal === 'travelOverlay') {
      modalLayer.fromPop = true
      history.back()
    }
    if (modalLayer.id === 'travelOverlay') modalLayer.id = null
    requestAnimationFrame(() => { player?.render() })
  }
  // Let the home timeline paint under the still-open overlay for a frame
  // so closing it does not composite the long list with leftover 3D tiles.
  requestAnimationFrame(revealHome)
}

/* ---------- 弹窗 ---------- */
// History stack so browser Back closes the drawer/dialog instead of leaving the site.
const modalLayer = { id: null, focus: null, closing: false, fromPop: false, transition: null }
function syncSettingsExpanded() {
  const btn = $('settingsButton')
  if (btn) btn.setAttribute('aria-expanded', String(Boolean($('settingsDialog')?.open)))
}
function closeDialog(dialog, { fromPop = false } = {}) {
  if (dialog?.id === 'travelOverlay') {
    if (travel.phase === 'going' || travel.phase === 'waiting') { skipTravel(); return }
    returnToPresent({ fromPop })
    return
  }
  if (!dialog?.open || modalLayer.closing) return
  modalLayer.closing = true
  const afterClose = () => {
    modalLayer.closing = false
    if (modalLayer.id === dialog.id) modalLayer.id = null
    const focus = modalLayer.focus
    modalLayer.focus = null
    if (!fromPop && history.state?.chutingModal === dialog.id) {
      modalLayer.fromPop = true
      history.back()
    }
    syncSettingsExpanded()
    queueMicrotask(() => { try { focus?.focus?.({ preventScroll: true }) } catch {} })
  }
  if (!motion) { dialog.close(); afterClose(); return }
  // The artwork flies back into its row when that row is on screen (shared-element morph, both ways).
  if (dialog.id === 'songDialog' && document.startViewTransition && !modalLayer.transition) {
    const event = state.view[state.current], cover = $('detailCover')
    const target = event && document.querySelector(`.song[data-index="${event.index}"] .song-cover`)
    const r = target?.getBoundingClientRect()
    if (r && r.bottom > 0 && r.top < innerHeight && r.width) {
      cover.style.viewTransitionName = 'song-art'
      const vt = document.startViewTransition(() => { cover.style.viewTransitionName = ''; dialog.close(); target.style.viewTransitionName = 'song-art' })
      modalLayer.transition = vt
      vt.finished.finally(() => { target.style.viewTransitionName = ''; modalLayer.transition = null; afterClose() })
      return
    }
  }
  dialog.classList.add('is-closing')
  setTimeout(() => { dialog.classList.remove('is-closing'); dialog.close(); afterClose() }, 200)
}
for (const id of ['settingsDialog', 'songDialog', 'loginDialog', 'shareDialog', 'capsuleDialog']) {
  const d = $(id)
  d.addEventListener('cancel', e => { e.preventDefault(); closeDialog(d) })
  d.addEventListener('close', () => { tick(); player?.render(); syncSettingsExpanded() })
  // Only a click on the backdrop closes; clicks in the dialog's own padding also target the dialog element.
  d.addEventListener('click', e => {
    if (e.target !== d) return
    const r = d.getBoundingClientRect()
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeDialog(d)
  })
}
const openModal = dialog => {
  if (!dialog) return
  if (!dialog.open) {
    modalLayer.focus = document.activeElement
    modalLayer.id = dialog.id
    if (history.state?.chutingModal !== dialog.id) history.pushState({ chutingModal: dialog.id }, '')
  }
  dialog.showModal()
  syncSettingsExpanded()
  tick()
}
addEventListener('popstate', () => {
  if (modalLayer.fromPop) { modalLayer.fromPop = false; return }
  const open = document.querySelector('dialog[open]')
  if (open) closeDialog(open, { fromPop: true })
})

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
    state.all = settings.likedOnly ? result.events.filter(e => e.sources?.includes(LIKED)) : result.events
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
// Testing aid: localStorage['chuting-pace-strict'] = '1' stops a sync at the first throttle signal instead of cooling down.
function strictPace() { try { return localStorage.getItem('chuting-pace-strict') === '1' } catch { return false } }
async function connect() {
  const bar = $('barAction')
  bar.disabled = true
  try {
    const backend = await backendReady
    if (state.offline) throw new Error('没网，等会儿再扫')
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
    toast('连上啦，先把你喜欢的歌翻出来')
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
        if (result.code === 803) { status('连上啦', 'ok'); cleanup(); closeDialog(dialog); resolve(result.account); return }
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
    await api('/api/sync', { limit: 0, recent: settings.recent, playlists: settings.playlists, retry_empty: false, history: settings.history, history_from: '', concurrency: 8, strict: strictPace(), ...options })
    if (!quiet) toast(options.covers_only ? '补封面中' : '开始同步啦')
    await loadStatus()
  } catch (err) { if (!quiet || !/另一个标签页|已经有一个/.test(err.message)) fail(err) }
}
async function pauseSync() {
  try { await api('/api/sync/pause', {}); toast('好，这首查完就停'); await loadStatus() }
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
  if (settings.auto && (pendingNow(stats) > 0 || run?.status === 'paused' || stale)) return startSync({ quiet: true })
  if (stats.missing_covers > 0) return startSync({ quiet: true, covers_only: true })
}

/* ---------- 设置 ---------- */
function renderSettings() {
  const has = Boolean(state.account), online = has && state.online && !state.offline, stats = state.status?.stats || {}
  paintAvatar($('setAvatar'), has ? state.account : null)
  $('setName').textContent = has ? state.account.nickname : '还没有连接'
  $('setState').textContent = !has ? '扫一下，你喜欢的歌就会自己排好队' : state.offline ? '没网也能翻' : online ? '已连上网易云' : '先看着本地的，扫码再接着同步'
  $('setLogin').textContent = !has ? '扫码连接' : online ? '重新扫码' : '扫码登录'
  $('setLogin').disabled = state.offline || running()
  $('setLogout').hidden = !online || !state.local
  $('retryEmpty').disabled = !online || running() || !stats.empty
  $('retryEmpty').textContent = stats.empty ? `再问一遍没查到的 ${n(stats.empty)} 首` : '没有要再问的歌'
  for (const id of ['exportJson', 'exportCsv']) $(id).disabled = !has
  $('archiveNote').textContent = has && stats.discovered
    ? `这里存着 ${n(stats.available)} 首初听。${state.local ? '换设备前，记得带一份走。' : ''}`
    : '有备份文件的话，直接导进来。'
  // Older, wider syncs may have left non-liked songs; they stay, and can be tucked away.
  $('likedOnlyRow').hidden = !(stats.liked_available < stats.available) && !settings.likedOnly
  syncThemeSeg()
}
function renderOffline(text) { $('offlineNote').textContent = text }
async function setupOffline(backend) {
  if (!backend.local) { $('offlineNote').closest('.set-group').hidden = true; return }
  if (!('serviceWorker' in navigator)) { renderOffline('这个浏览器还不支持离线。'); return }
  const ready = '断网也能翻、也能搜。'
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
    if (navigator.serviceWorker.controller) renderOffline(ready)
    else {
      renderOffline('离线版准备中…')
      navigator.serviceWorker.addEventListener('controllerchange', () => renderOffline(ready), { once: true })
    }
    // Check for a new version whenever the tab comes back; the worker itself always prefers the network.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}) })
  } catch { renderOffline('离线版没准备好，在线照常用。') }
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
  // Cursor-aware depth: the hero title layers drift apart, the intro cards tilt toward the cursor.
  const hero = document.querySelector('.hero')
  let heroFrame = 0
  hero.addEventListener('pointermove', e => {
    if (!motion || heroFrame) return
    heroFrame = requestAnimationFrame(() => {
      heroFrame = 0
      const r = hero.getBoundingClientRect()
      hero.style.setProperty('--px', ((e.clientX - r.left) / r.width - .5).toFixed(3))
      hero.style.setProperty('--py', ((e.clientY - r.top) / r.height - .5).toFixed(3))
    })
  })
  hero.addEventListener('pointerleave', () => { hero.style.setProperty('--px', 0); hero.style.setProperty('--py', 0) })
  const steps = document.querySelector('.intro-steps')
  let cardFrame = 0
  steps?.addEventListener('pointermove', e => {
    const card = e.target.closest('li')
    if (!motion || !card || cardFrame) return
    cardFrame = requestAnimationFrame(() => {
      cardFrame = 0
      const r = card.getBoundingClientRect()
      card.style.setProperty('--rx', ((e.clientX - r.left) / r.width - .5).toFixed(3))
      card.style.setProperty('--ry', ((e.clientY - r.top) / r.height - .5).toFixed(3))
    })
  })
  steps?.addEventListener('pointerout', e => { const card = e.target.closest('li'); if (card && !card.contains(e.relatedTarget)) { card.style.removeProperty('--rx'); card.style.removeProperty('--ry') } })
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
rotate($('closingLine'), CLOSING_LINES, { interval: 12500, delay: 6000 })
$('barAction').addEventListener('click', e => { const a = e.currentTarget.dataset.action; if (a === 'connect') connect(); else if (a === 'sync') startSync(); else if (a === 'pause') pauseSync() })
$('heroAction').addEventListener('click', e => e.currentTarget.dataset.action === 'connect' ? connect() : startSync())

/* ---------- 外观 ---------- */
function syncThemeSeg() {
  const mode = window.__chutingTheme?.read?.() || 'system'
  for (const btn of document.querySelectorAll('#themeSeg [data-theme-opt]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.themeOpt === mode))
  }
}
function setTheme(mode) {
  window.__chutingTheme?.apply?.(mode)
  syncThemeSeg()
}
$('themeSeg')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-theme-opt]')
  if (btn) setTheme(btn.dataset.themeOpt)
})
syncThemeSeg()
let shareJob = 0
const shareState = { text: '', blob: null, name: '' }
async function copyShareText() {
  const text = shareState.text
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    toast('已复制')
    return
  } catch { /* fall through to the selection copy */ }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.cssText = 'position:fixed;left:-9999px'
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    if (!ok) throw new Error('copy')
    toast('已复制')
  } catch { toast('复制失败了', 'error') }
}
function saveShare() {
  if (!shareState.blob) return
  const url = URL.createObjectURL(shareState.blob)
  const link = document.createElement('a')
  link.href = url
  link.download = shareState.name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
async function nativeShare() {
  const text = shareState.text
  const method = shareMethod(shareState.blob)
  try {
    if (method === 'files') {
      const file = new File([shareState.blob], shareState.name, { type: 'image/png' })
      await navigator.share({ files: [file], title: '初听', text })
      return
    }
    if (method === 'text') {
      await navigator.share({ title: '初听', text })
      return
    }
  } catch (err) {
    if (err?.name === 'AbortError') return
    toast('没能分享出去', 'error')
    return
  }
  await copyShareText()
}
async function openShare() {
  const top = artistRanks(state.all)[0]
  const portrait = top?.[0] ? await fetchArtistPortrait(top[0]) : ''
  const payload = sharePayload({ events: state.all }, { portrait })
  if (!payload) return
  const job = ++shareJob
  shareState.text = payload.text
  shareState.blob = null
  shareState.name = payload.poster.rangeStart === payload.poster.rangeEnd
    ? `chuting-${payload.poster.rangeStart}.png`
    : `chuting-${payload.poster.rangeStart}-${payload.poster.rangeEnd}.png`
  const dialog = $('shareDialog')
  const status = $('shareStatus')
  status.hidden = false
  status.textContent = '正在排版海报…'
  $('shareStage').replaceChildren()
  $('shareStage').setAttribute('aria-busy', 'true')
  $('shareSave').disabled = true
  openModal(dialog)
  try {
    const { canvas, blob } = await renderPoster(payload.poster)
    if (job !== shareJob || !dialog.open) return
    canvas.className = 'share-canvas'
    canvas.setAttribute('role', 'img')
    canvas.setAttribute('aria-label', `初听海报，${payload.poster.songs} 首歌`)
    $('shareStage').replaceChildren(canvas)
    $('shareStage').setAttribute('aria-busy', 'false')
    status.hidden = true
    shareState.blob = blob
    $('shareSave').disabled = false
  } catch {
    if (job !== shareJob) return
    $('shareStage').setAttribute('aria-busy', 'false')
    status.hidden = false
    status.textContent = '海报没画出来，还可以分享文字。'
  }
}
$('shareButton')?.addEventListener('click', () => openShare())
$('closeShare')?.addEventListener('click', () => closeDialog($('shareDialog')))
$('shareDialog')?.addEventListener('close', () => { shareJob++ })
$('shareSave')?.addEventListener('click', saveShare)
$('shareAction')?.addEventListener('click', () => nativeShare())
$('settingsButton').addEventListener('click', () => { renderSettings(); openModal($('settingsDialog')) })
$('closeSettings').addEventListener('click', () => closeDialog($('settingsDialog')))
$('closeSong').addEventListener('click', () => closeDialog($('songDialog')))
$('closeLogin').addEventListener('click', () => closeDialog($('loginDialog')))
$('closeCapsule')?.addEventListener('click', () => closeDialog($('capsuleDialog')))
$('capsuleButton')?.addEventListener('click', () => openCapsule('today'))
$('capsuleTodayBtn')?.addEventListener('click', () => { capsule.mode = 'today'; renderCapsule() })
$('capsuleRandomBtn')?.addEventListener('click', () => { capsule.mode = 'random'; renderCapsule() })
$('heroTravelToday')?.addEventListener('click', () => startTravel(capsule.todayPick, { source: 'today' }))
$('heroTravelRandom')?.addEventListener('click', () => {
  const event = capsuleRandom(state.all, Math.random, capsule.lastRandom)
  if (!event) { toast('还没有可以回顾的初听'); return }
  capsule.lastRandom = event.song_id
  startTravel(event, { source: 'random' })
})
$('arriveReroll')?.addEventListener('click', rerollTravel)
$('arriveLocate')?.addEventListener('click', () => locateInTimeline(travel.event))
$('arriveBack')?.addEventListener('click', () => returnToPresent())
$('travelOverlay')?.addEventListener('cancel', e => {
  e.preventDefault()
  if (travel.phase === 'going' || travel.phase === 'waiting') skipTravel()
  else returnToPresent()
})
$('travelStage')?.addEventListener('click', () => { if (travel.phase === 'going' || travel.phase === 'waiting') skipTravel() })
function resumeBlockedTravelPlay() {
  if (travel.phase !== 'arrive' || !travel.event) return
  const art = $('arriveArt')
  if (!art?.classList.contains('is-wait-play') && !$('arriveNote')?.classList.contains('is-wait-play')) return
  // resume() calls play() synchronously in this tap when the URL is already on
  // the element, which is what iOS needs; a fresh load would wait on the network.
  const event = travel.event
  travel.play = player?.resume ? player.resume(event) : player?.play?.(event)
  if (travel.play?.then) travel.play.then(result => { if (travel.event === event && resultFor(event, result)) paintArriveNote(result) })
}
$('arriveArt')?.addEventListener('click', resumeBlockedTravelPlay)
$('arriveNote')?.addEventListener('click', resumeBlockedTravelPlay)
$('locateBtn')?.addEventListener('click', () => locateInTimeline(state.view[state.current] || player?.current))
$('miniLocate')?.addEventListener('click', () => locateInTimeline(player?.current))
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
for (const [id, key] of [['optAuto', 'auto'], ['optRecent', 'recent'], ['optHistory', 'history'], ['optPlaylists', 'playlists'], ['optLikedOnly', 'likedOnly']]) {
  $(id).checked = settings[key]
  $(id).addEventListener('change', e => {
    settings[key] = e.target.checked; save('chuting-settings', settings)
    if (key === 'likedOnly') loadEvents(true)
    else renderStatus()
  })
}
$('setLogin').addEventListener('click', () => { closeDialog($('settingsDialog')); connect() })
$('setLogout').addEventListener('click', async () => {
  try { await (await backendReady).logout(); state.online = false; renderStatus(); toast('已退出，档案还在') } catch (err) { fail(err) }
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
    toast(format === 'json' ? '备份好了' : 'CSV 已下载')
  } catch (err) { fail(err) }
})
addEventListener('online', () => { state.offline = false; renderStatus(); checkSession().then(autoSync) })
/* ---------- 播放器 ---------- */
// Plays through the worker's song_url (the account's own rights); prev/next and the end of a song move along the timeline.
const playerAt = (event, delta) => { const i = state.view.findIndex(x => x.song_id === event?.song_id); return i < 0 ? null : state.view[i + delta] }
function followTravelPlayer(event) {
  if (!travel.open || !event) return
  if (travel.event?.song_id === event.song_id) return
  if (travel.phase === 'arrive') {
    switchArrival(event, { play: false })
    return
  }
  if (travel.phase === 'going' || travel.phase === 'waiting') {
    travel.event = event
    travel.toMs = event.first_listen_ms || travel.toMs
    paintTravelBack(event)
  }
}
function playRelative(delta) {
  const next = playerAt(player.current, delta)
  if (!next) return
  if ($('songDialog').open && state.view[state.current]?.song_id === player.current?.song_id) fillSong(next)
  if (travel.open && travel.phase === 'arrive') {
    switchArrival(next)
    return
  }
  player.play(next)
}
player = createPlayer({
  els: { root: $('player'), dialog: $('songDialog'), play: $('playBtn'), seek: $('seek'), scrub: $('scrub'), cur: $('curTime'), dur: $('durTime'), note: $('playerNote'), volume: finePointer ? $('volume') : null },
  mini: { root: $('miniPlayer'), play: $('miniPlay'), open: $('miniOpen'), close: $('miniClose'), title: $('miniTitle'), artist: $('miniArtist'), cover: $('miniCover') },
  getUrl: (event, query = {}) => remote('/api/netease', { method: 'song_url', query: { id: String(event.song_id), name: event.name || '', artist: event.artists || '', ...query }, uid: state.account?.uid }),
  coverFor: event => (event.cover ? px => coverSize(event.cover, px) : null),
  onEnded: () => playRelative(1),
  onChange: event => followTravelPlayer(event),
  onUnplayable: (_event, result) => {
    if (!travel.open) return
    if (travel.phase !== 'arrive' && travel.phase !== 'going' && travel.phase !== 'waiting') return
    if (result?.blocked || result?.reason === 'blocked') return
    if (travel.skips >= 8) return
    travel.skips += 1
    playRelative(1)
  },
  onOpen: event => showSong(state.view.find(x => x.song_id === event.song_id) || event)
})
player.setActions(() => playRelative(-1), () => playRelative(1))
if (!finePointer) $('volume').closest('.player-vol').hidden = true
addEventListener('offline', () => { state.offline = true; state.online = false; renderStatus() })
backendReady.then(backend => {
  state.local = backend.local
  $('historyRow').hidden = !backend.local
  setupOffline(backend)
  renderStatus()
}).catch(() => {})
renderStatus(); renderTimeline()
loadStatus(true).then(async () => {
  await checkSession()
  if (!state.account && !(await backendReady).local) connect()
  else autoSync()
}).catch(err => { state.loading = false; state.error = err.message; renderStatus(); renderTimeline(); fail(err) })
