// Client-side first-listen poster. Drawn in the browser at 1080×1920. Nothing is uploaded.
// The payload is an allowlist: titles, counts, dates, and NetEase cover URLs. Account ids,
// nicknames, avatars, cookies, MUSIC_U, the session cookie, and raw API bodies never enter it.
import { artistRanks, playCount } from './insights.js'
import { coverSize, coverUrl } from './archive-core.js'

const SITE = 'chuting.inkorange.com'
const WEEK = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const WALL = 66
// When most first listens fall. Boundaries are hour-of-day in Asia/Shanghai, end exclusive.
const PARTS = [
  { from: 0, to: 5, caption: '大多数新歌，都在凌晨找到你' },
  { from: 5, to: 11, caption: '大多数新歌，都在早上找到你' },
  { from: 11, to: 17, caption: '大多数新歌，都在午后找到你' },
  { from: 17, to: 21, caption: '大多数新歌，都在傍晚找到你' },
  { from: 21, to: 24, caption: '大多数新歌，都在晚上找到你' },
]
// The poster is one printed palette (the approved wall), not the site's light/dark theme.
// Type stacks match the page tokens, with the faces the ticket mock was drawn in first.
const SERIF = '"Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "STSong", "Source Serif Pro", Georgia, serif'
const MONO = '"JetBrains Mono", "DejaVu Sans Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace'
const INK = '#1d1b17'
const PAPER = '#f2ede1'
const PAPER_2 = '#d9d2c2'
const PAPER_3 = '#c8bfab'
const ACCENT = '#c2462b'
const ACCENT_SOFT = '#e8a48f'
const CREAM = '#f3efe6'
const NIGHT = '#0c0b09'
const MUTED = '#5d574d'
const FAINT = '#8b8477'
const MINI_MUTED = '#7d776c'
const DASH = '#b9b1a1'
const DASH_MINI = '#bdb5a5'

const num = value => Number(value || 0).toLocaleString('zh-CN')
const dotted = date => date.replaceAll('-', '.')
const clean = value => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 400)

function dateOf(item) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(item?.date || '')) return item.date
  const ms = Number(item?.first_listen_ms)
  if (!Number.isFinite(ms)) return ''
  return new Date(ms + 8 * 3600000).toISOString().slice(0, 10)
}
function timeOf(item) {
  if (/^\d{2}:\d{2}$/.test(item?.time || '')) return item.time
  const ms = Number(item?.first_listen_ms)
  if (!Number.isFinite(ms)) return '00:00'
  return new Date(ms + 8 * 3600000).toISOString().slice(11, 16)
}
function listenMs(date, time) {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  return Date.UTC(y, m - 1, d, hh - 8, mm || 0)
}
function countOf(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
function weekday(date) {
  const [y, m, d] = date.split('-').map(Number)
  return WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}
function hourOf(event) {
  const h = Number(String(event.time || '').slice(0, 2))
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 0
}
function people(events) {
  const names = new Set()
  for (const e of events) for (const part of String(e.artists || '').split(' / ')) {
    const name = part.trim()
    if (name) names.add(name)
  }
  return names.size
}
function credit(event) {
  const artist = event.artists || '歌手未知'
  return event.album ? `${artist} — ${event.album}` : artist
}
function coverOf(songs) {
  for (let i = songs.length - 1; i >= 0; i--) if (songs[i].cover) return songs[i].cover
  return ''
}

function albumIdOf(event) {
  const raw = event?.album_id ?? event?.albumId
  return /^[1-9]\d{0,17}$/.test(String(raw || '')) ? String(raw) : ''
}

// Same picture if the path matches after dropping query strings, p1–p4 hosts, and a trailing size suffix.
export function coverKey(url) {
  const clean = coverUrl(url) || String(url || '').trim()
  if (!clean) return ''
  let path = clean
  try { path = new URL(clean, 'https://p1.music.126.net').pathname } catch {
    path = clean.replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0]
  }
  try { path = decodeURIComponent(path) } catch { /* keep the raw path */ }
  return path.toLowerCase().replace(/[_-](\d{2,4})[xy](\d{2,4})(?=\.[a-z0-9]+$)/i, '')
}

function uniqueCovers(events) {
  const unique = []
  const seenKey = new Set()
  const seenAlbum = new Set()
  for (const event of events || []) {
    const cover = event.cover || ''
    if (!cover) continue
    const key = coverKey(cover)
    const album = albumIdOf(event)
    if ((key && seenKey.has(key)) || (album && seenAlbum.has(album))) continue
    if (key) seenKey.add(key)
    if (album) seenAlbum.add(album)
    unique.push(cover)
  }
  return unique
}

// Size a portrait mosaic to the number of distinct covers instead of repeating tiles.
export function wallGrid(count) {
  if (count >= WALL) return { cols: 6, rows: 11 }
  if (count <= 0) return { cols: 6, rows: 11 }
  if (count === 1) return { cols: 1, rows: 1 }
  if (count === 2) return { cols: 2, rows: 1 }
  if (count === 3) return { cols: 3, rows: 1 }
  let best = { cols: Math.min(6, count), rows: Math.ceil(count / Math.min(6, count)) }
  let bestScore = -Infinity
  for (let cols = 2; cols <= Math.min(6, count); cols++) {
    const rows = Math.ceil(count / cols)
    const empty = cols * rows - count
    const tile = (552 - 3 * (cols - 1)) / cols
    const height = rows * (tile + 3) - 3
    const portrait = rows >= cols ? 6 : 0
    const heightScore = height >= 400 && height <= 1100 ? 8 : height < 400 ? height / 50 : -Math.min(16, (height - 1100) / 50)
    const score = -empty * 15 + heightScore + portrait + Math.min(tile, 200) * 0.12
    if (score > bestScore) { best = { cols, rows }; bestScore = score }
  }
  return best
}

function buildWall(events) {
  const unique = uniqueCovers(events).slice(0, WALL)
  if (!unique.length) {
    return { wall: Array.from({ length: WALL }, (_, i) => ({ cover: '', first: i === 0 })), wallCols: 6 }
  }
  const { cols } = wallGrid(unique.length)
  const firstKey = coverKey(events[0]?.cover || '')
  const wall = unique.map((cover, i) => ({
    cover,
    first: firstKey ? coverKey(cover) === firstKey && !unique.slice(0, i).some(item => coverKey(item) === firstKey) : i === 0,
  }))
  if (!wall.some(slot => slot.first) && wall[0]) wall[0].first = true
  return { wall, wallCols: cols }
}

// Only display fields are copied. Anything else on the archive (account, raw, cookies) is ignored.
function sanitizeEvents(archive) {
  const rows = Array.isArray(archive) ? archive : archive?.events || archive?.songs || []
  if (!Array.isArray(rows)) return []
  const events = []
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue
    const date = dateOf(item)
    if (!date) continue
    const time = timeOf(item)
    const ms = Number(item.first_listen_ms)
    events.push({
      song_id: /^[1-9]\d{0,17}$/.test(String(item.song_id || item.id || '')) ? String(item.song_id || item.id) : '',
      name: clean(item.name) || '未命名',
      artists: clean(item.artists),
      album: clean(item.album),
      date, time,
      ms: Number.isFinite(ms) ? ms : listenMs(date, time),
      play_count: countOf(item.play_count),
      cover: coverUrl(item.cover),
      ...(albumIdOf(item) ? { album_id: albumIdOf(item) } : {}),
    })
  }
  events.sort((a, b) => a.ms - b.ms || a.song_id.localeCompare(b.song_id) || a.name.localeCompare(b.name))
  return events
}

function captionFor(hours, peak) {
  let best = null
  for (const part of PARTS) {
    let count = 0
    for (let h = part.from; h < part.to; h++) count += hours[h] || 0
    const hasPeak = peak >= part.from && peak < part.to
    const later = best && part.from > best.part.from
    if (!best || count > best.count || (count === best.count && hasPeak && !best.hasPeak) || (count === best.count && hasPeak === best.hasPeak && later)) {
      best = { count, hasPeak, part }
    }
  }
  return best.part.caption
}

function card(event, extra) {
  return {
    title: event.name,
    subtitle: event.artists || '歌手未知',
    cover: event.cover || '',
    ...extra,
  }
}

export function posterFrom(events, extras = {}) {
  const first = events[0]
  const latest = events.at(-1)
  let top = first, topScore = -1
  for (const e of events) {
    const score = playCount(e)
    if (score > topScore) { top = e; topScore = score }
  }
  const [metName, metSongs] = artistRanks(events)[0] || []
  const metCount = metSongs?.length || 0
  const metList = metSongs?.length ? metSongs : events
  const hours = Array(24).fill(0)
  for (const e of events) hours[hourOf(e)]++
  let peak = 0
  for (let h = 1; h < 24; h++) if (hours[h] >= hours[peak]) peak = h
  const start = dotted(first.date), end = dotted(latest.date)
  return {
    songs: events.length,
    artists: people(events),
    days: new Set(events.map(e => e.date)).size,
    site: SITE,
    caption: captionFor(hours, peak),
    peakHour: peak,
    peakLabel: `${String(peak).padStart(2, '0')}:00 最多`,
    hours,
    rangeLabel: start === end ? `初听 · ${start}` : `初听 · ${start} — ${end}`,
    rangeStart: start,
    rangeEnd: end,
    first: {
      title: first.name,
      artist: first.artists,
      album: first.album,
      credit: credit(first),
      date: start,
      weekday: weekday(first.date),
      time: first.time,
      cover: first.cover || '',
    },
    stub: { number: '001', of: String(events.length).padStart(3, '0') },
    mostPlayed: card(top, { label: 'MOST PLAYED', value: num(playCount(top)), unit: '次' }),
    mostMet: {
      label: 'MOST MET',
      title: metName || '歌手未知',
      subtitle: `初听 ${num(metCount || events.length)} 首`,
      value: num(metCount || events.length),
      unit: '首',
      cover: coverOf(metList),
      portrait: coverUrl(extras.portrait) || '',
      face: true,
    },
    latest: card(latest, { label: 'LATEST', value: latest.date.slice(5).replace('-', '.'), unit: latest.time }),
    ...buildWall(events),
  }
}

export function shareText(poster) {
  const title = value => {
    const chars = [...(value || '')]
    return chars.length > 36 ? `${chars.slice(0, 35).join('')}…` : chars.join('')
  }
  const lines = [
    `初听 · ${num(poster.songs)} 首歌，${num(poster.artists)} 位歌手，${num(poster.days)} 个日子`,
    `从《${title(poster.first.title)}》开始，${poster.first.date} ${poster.first.time}`,
  ]
  if (poster.songs > 1) {
    lines.push(`听得最多的是《${title(poster.mostPlayed.title)}》，${poster.mostPlayed.value} 次`)
    lines.push(`最近一首是《${title(poster.latest.title)}》，${poster.latest.value} ${poster.latest.unit}`)
  }
  lines.push(poster.caption, poster.site)
  return lines.join('\n')
}

// archive: { events } or { songs } from a backup, or a bare event list. Sensitive fields are dropped.
export function sharePayload(archive, extras) {
  const events = sanitizeEvents(archive)
  if (!events.length) return null
  const poster = posterFrom(events, extras)
  return { text: shareText(poster), poster }
}

export function canSharePoster(blob) {
  return shareMethod(blob) === 'files'
}

// Decide how 「分享」 should work: file+text via Web Share, text-only share, or clipboard copy.
// The payload is only title, text, and optionally the PNG — never a profile url or account fields.
export function shareMethod(blob, nav = typeof navigator === 'undefined' ? null : navigator) {
  try {
    if (blob && typeof nav?.canShare === 'function' && typeof File === 'function'
      && nav.canShare({ files: [new File([blob], 'chuting.png', { type: 'image/png' })] })) return 'files'
  } catch { /* fall through */ }
  if (typeof nav?.share === 'function') return 'text'
  return 'copy'
}

export function shareData({ blob, text, name, title = '初听' } = {}, nav = typeof navigator === 'undefined' ? null : navigator) {
  const method = shareMethod(blob, nav)
  if (method === 'files') {
    const file = new File([blob], name || 'chuting.png', { type: 'image/png' })
    return { method, data: { files: [file], title, text } }
  }
  if (method === 'text') return { method, data: { title, text } }
  return { method, data: { text } }
}

function loadImageElement(src) {
  return new Promise(resolve => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.referrerPolicy = 'no-referrer'
    img.decoding = 'async'
    let settled = false
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value) }
    const timer = setTimeout(() => finish(null), 8000)
    img.onload = () => finish((img.naturalWidth || img.width) > 0 ? img : null)
    img.onerror = () => finish(null)
    img.src = src
  })
}
async function defaultLoadImage(url) {
  const cleanUrl = coverUrl(url)
  if (!cleanUrl) return null
  return (await loadImageElement(coverSize(cleanUrl, 360))) || loadImageElement(cleanUrl)
}
function canDraw(img) {
  try {
    const probe = document.createElement('canvas')
    probe.width = probe.height = 1
    const g = probe.getContext('2d', { willReadFrequently: true })
    g.drawImage(img, 0, 0, 1, 1)
    g.getImageData(0, 0, 1, 1)
    return true
  } catch { return false }
}
async function waitForFonts() {
  if (!document.fonts?.ready) return
  try {
    await document.fonts.ready
    await Promise.all([
      document.fonts.load(`600 50px ${SERIF}`),
      document.fonts.load(`400 15px ${SERIF}`),
      document.fonts.load(`300 34px ${MONO}`),
      document.fonts.load(`500 12px ${MONO}`),
      document.fonts.load(`500 10px ${MONO}`),
      document.fonts.load(`500 9px ${MONO}`),
    ])
    await document.fonts.ready
  } catch { /* draw with whatever is already available */ }
}

let noiseCache
function noiseTile() {
  if (noiseCache) return noiseCache
  const size = 160
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')
  const data = g.createImageData(size, size)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let n = Math.imul(x, 374761393) + Math.imul(y, 668265263)
    n = Math.imul(n ^ (n >>> 13), 1274126177)
    const v = (n ^ (n >>> 16)) & 255
    const i = (y * size + x) * 4
    data.data[i] = data.data[i + 1] = data.data[i + 2] = v
    data.data[i + 3] = 255
  }
  g.putImageData(data, 0, 0)
  noiseCache = canvas
  return canvas
}

function withSpacing(ctx, spacing, fn) {
  if (!spacing || !('letterSpacing' in ctx)) return fn(false)
  const prev = ctx.letterSpacing
  ctx.letterSpacing = `${spacing}px`
  try { return fn(true) } finally { ctx.letterSpacing = prev }
}
function widthOf(ctx, text, spacing) {
  if (!text) return 0
  return withSpacing(ctx, spacing, supported => {
    if (supported || !spacing) return ctx.measureText(text).width
    const chars = [...text]
    return chars.reduce((sum, ch) => sum + ctx.measureText(ch).width, 0) + spacing * Math.max(0, chars.length - 1)
  })
}
function fillSpaced(ctx, text, x, y, spacing) {
  if (!text) return
  withSpacing(ctx, spacing, supported => {
    if (supported || !spacing) { ctx.fillText(text, x, y); return }
    const chars = [...text]
    const widths = chars.map(ch => ctx.measureText(ch).width)
    const total = widths.reduce((a, b) => a + b, 0) + spacing * Math.max(0, chars.length - 1)
    let cursor = x
    if (ctx.textAlign === 'center') cursor -= total / 2
    else if (ctx.textAlign === 'right' || ctx.textAlign === 'end') cursor -= total
    const align = ctx.textAlign
    ctx.textAlign = 'left'
    chars.forEach((ch, i) => { ctx.fillText(ch, cursor, y); cursor += widths[i] + spacing })
    ctx.textAlign = align
  })
}
function ellipsis(ctx, text, maxWidth, spacing) {
  if (widthOf(ctx, text, spacing) <= maxWidth) return text
  let out = ''
  for (const ch of text) {
    if (widthOf(ctx, `${out}${ch}…`, spacing) > maxWidth) return `${out}…`
    out += ch
  }
  return out
}
function wrapClamp(ctx, text, maxWidth, maxLines, spacing) {
  const chars = [...text]
  if (!chars.length) return []
  const lines = []
  let buf = '', index = 0
  while (index < chars.length && lines.length < maxLines) {
    const next = buf + chars[index]
    if (widthOf(ctx, next, spacing) <= maxWidth) { buf = next; index++; continue }
    if (buf) { lines.push(buf); buf = ''; continue }
    lines.push(chars[index])
    index++
    buf = ''
  }
  if (buf && lines.length < maxLines) lines.push(buf)
  if (index < chars.length && lines.length) {
    let last = lines[lines.length - 1]
    while (last && widthOf(ctx, `${last}…`, spacing) > maxWidth) last = [...last].slice(0, -1).join('')
    lines[lines.length - 1] = `${last}…`
  }
  return lines
}
function tokensOf(text) {
  return text.match(/[A-Za-z0-9][A-Za-z0-9''.+-]*|[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]|./gu) || [text]
}
function wrapTitle(ctx, text, maxWidth, maxLines, spacing) {
  if (maxLines < 2 || !/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/.test(text) || /[A-Za-z]{2,}/.test(text)) {
    return wrapSmart(ctx, text, maxWidth, maxLines, spacing)
  }
  if (widthOf(ctx, text, spacing) <= maxWidth) return [text]
  const chars = [...text]
  const noStart = /[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮー々ンん]/
  let best = null, bestScore = -Infinity
  for (let i = 1; i < chars.length; i++) {
    const a = chars.slice(0, i).join('')
    const b = chars.slice(i).join('')
    if (widthOf(ctx, a, spacing) > maxWidth || widthOf(ctx, b, spacing) > maxWidth) continue
    let score = -Math.abs(widthOf(ctx, a, spacing) - widthOf(ctx, b, spacing))
    if (noStart.test(b[0])) score -= 80
    if (/[ズスーンッム]$/.test(a)) score += 12
    score -= (a.length - b.length) * 3
    if (score > bestScore) { best = [a, b]; bestScore = score }
  }
  return best || wrapSmart(ctx, text, maxWidth, maxLines, spacing)
}
function wrapSmart(ctx, text, maxWidth, maxLines, spacing) {
  const tokens = tokensOf(text)
  if (tokens.length <= 1) return wrapClamp(ctx, text, maxWidth, maxLines, spacing)
  const lines = []
  let buf = '', index = 0
  while (index < tokens.length && lines.length < maxLines) {
    const next = buf + tokens[index]
    if (widthOf(ctx, next, spacing) <= maxWidth) { buf = next; index++; continue }
    if (buf) { lines.push(buf); buf = ''; continue }
    lines.push(wrapClamp(ctx, tokens[index], maxWidth, 1, spacing)[0] || tokens[index])
    index++
    buf = ''
  }
  if (buf && lines.length < maxLines) lines.push(buf)
  if (index < tokens.length && lines.length) {
    let last = lines[lines.length - 1]
    while (last && widthOf(ctx, `${last}…`, spacing) > maxWidth) last = [...last].slice(0, -1).join('')
    lines[lines.length - 1] = last ? `${last}…` : '…'
  }
  return lines
}

const PERF_X = 340
const PERF_R = 3.15
const PERF_PITCH = 11
const PERF_PAD = 22
function punchPerf(ctx, h) {
  for (let y = PERF_PAD; y <= h - PERF_PAD + 0.01; y += PERF_PITCH) {
    ctx.moveTo(PERF_X + PERF_R, y)
    ctx.arc(PERF_X, y, PERF_R, 0, Math.PI * 2, true)
  }
}
function traceNotched(ctx, w, h, kind, notch, holes) {
  const r = kind === 'mini' ? 3 : 6
  const nr = kind === 'mini' ? 5 : 9
  ctx.beginPath()
  if (kind === 'mini') {
    const ny = notch ?? Math.round(h * 0.69)
    ctx.moveTo(r, 0)
    ctx.lineTo(w - r, 0)
    ctx.arcTo(w, 0, w, r, r)
    ctx.lineTo(w, ny - nr)
    ctx.arc(w, ny, nr, -Math.PI / 2, Math.PI / 2, true)
    ctx.lineTo(w, h - r)
    ctx.arcTo(w, h, w - r, h, r)
    ctx.lineTo(r, h)
    ctx.arcTo(0, h, 0, h - r, r)
    ctx.lineTo(0, ny + nr)
    ctx.arc(0, ny, nr, Math.PI / 2, -Math.PI / 2, true)
    ctx.lineTo(0, r)
    ctx.arcTo(0, 0, r, 0, r)
  } else {
    const nx = 340
    ctx.moveTo(r, 0)
    ctx.lineTo(nx - nr, 0)
    ctx.arc(nx, 0, nr, Math.PI, 0, true)
    ctx.lineTo(w - r, 0)
    ctx.arcTo(w, 0, w, r, r)
    ctx.lineTo(w, h - r)
    ctx.arcTo(w, h, w - r, h, r)
    ctx.lineTo(nx + nr, h)
    ctx.arc(nx, h, nr, 0, Math.PI, true)
    ctx.lineTo(r, h)
    ctx.arcTo(0, h, 0, h - r, r)
    ctx.lineTo(0, r)
    ctx.arcTo(0, 0, r, 0, r)
  }
  ctx.closePath()
  if (holes && kind === 'main') punchPerf(ctx, h)
}
function place(ctx, x, y, w, h, deg, tx, ty, draw) {
  ctx.save()
  ctx.translate(x + w / 2, y + h / 2)
  ctx.rotate((deg * Math.PI) / 180)
  ctx.translate(tx, ty)
  ctx.translate(-w / 2, -h / 2)
  draw(ctx, w, h)
  ctx.restore()
}
function grain(ctx, w, h, kind, alpha, notch) {
  ctx.save()
  const holes = kind === 'main'
  traceNotched(ctx, w, h, kind, notch, holes)
  ctx.clip(holes ? 'evenodd' : 'nonzero')
  ctx.globalAlpha = alpha
  ctx.globalCompositeOperation = 'multiply'
  const tile = noiseTile()
  for (let y = -10; y < h + 10; y += 90) for (let x = -10; x < w + 10; x += 90) ctx.drawImage(tile, x, y, 90, 90)
  ctx.restore()
}
function drawImageCover(ctx, img, x, y, w, h) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height
  if (!iw || !ih) return
  const ir = iw / ih, r = w / h
  let sx = 0, sy = 0, sw = iw, sh = ih
  if (ir > r) { sw = ih * r; sx = (iw - sw) / 2 } else { sh = iw / r; sy = (ih - sh) / 2 }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h)
}
function paintCover(ctx, img, x, y, w, h, { filter = '', glyph = '', tone = '#14120f', pad = 0, round = false } = {}) {
  ctx.save()
  ctx.beginPath()
  if (round) ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2, 0, Math.PI * 2)
  else ctx.rect(x, y, w, h)
  ctx.clip()
  if (img) {
    try {
      if (filter) ctx.filter = filter
      drawImageCover(ctx, img, x - pad, y - pad, w + pad * 2, h + pad * 2)
      ctx.filter = 'none'
    } catch { ctx.filter = 'none'; ctx.fillStyle = tone; ctx.fillRect(x, y, w, h) }
  } else {
    ctx.fillStyle = tone
    ctx.fillRect(x, y, w, h)
    if (glyph) {
      ctx.fillStyle = 'rgba(29,27,23,.4)'
      ctx.font = `600 ${Math.max(12, Math.round(h * 0.42))}px ${SERIF}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText([...glyph][0] || '♪', x + w / 2, y + h / 2 + 0.5)
    }
  }
  ctx.restore()
}
function barcode(ctx, x, y, w, h) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  ctx.fillStyle = INK
  for (let i = 0; i < w; i += 10) {
    ctx.fillRect(x + i, y, 1, h)
    ctx.fillRect(x + i + 3, y, 2, h)
    ctx.fillRect(x + i + 6, y, 1, h)
  }
  ctx.restore()
}
function layoutTitle(ctx, text, maxWidth) {
  for (let size = 50; size >= 28; size -= 1) {
    ctx.font = `600 ${size}px ${SERIF}`
    const spacing = size * 0.06
    if (widthOf(ctx, text, spacing) <= maxWidth) return { size, spacing, lines: [text] }
  }
  const size = 26
  ctx.font = `600 ${size}px ${SERIF}`
  const spacing = size * 0.04
  return { size, spacing, lines: wrapSmart(ctx, text, maxWidth, 2, spacing) }
}

function neighborImage(images, wall, index, cols) {
  const tryAt = (j, sameRow) => {
    if (j < 0 || j >= wall.length) return null
    if (sameRow && Math.floor(j / cols) !== Math.floor(index / cols)) return null
    return (wall[j].cover && images.get(wall[j].cover)) || null
  }
  return (
    tryAt(index - 1, true) || tryAt(index + 1, true) ||
    tryAt(index - cols, false) || tryAt(index + cols, false) ||
    tryAt(index - cols - 1, false) || tryAt(index - cols + 1, false) ||
    tryAt(index + cols - 1, false) || tryAt(index + cols + 1, false) ||
    wall.map(slot => slot.cover && images.get(slot.cover)).find(Boolean) ||
    null
  )
}
function drawWall(ctx, poster, images) {
  const gap = 3
  const cols = poster.wallCols || 6
  const tile = (552 - gap * (cols - 1)) / cols
  const fieldTile = (552 - gap * 5) / 6
  const fieldH = (fieldTile + gap) * 11
  const backdrop = poster.wall.map(slot => slot.cover && images.get(slot.cover)).find(Boolean) || null
  if (backdrop) {
    paintCover(ctx, backdrop, -6, -6, 552 + 12, fieldH + 12, {
      filter: 'saturate(0.42) brightness(0.26) blur(28px)',
      tone: '#14120f',
      pad: 24,
    })
  }
  poster.wall.forEach((slot, i) => {
    const x = -6 + (i % cols) * (tile + gap)
    const y = -6 + Math.floor(i / cols) * (tile + gap)
    let img = slot.cover ? images.get(slot.cover) : null
    let filter = slot.first ? '' : 'saturate(0.9) brightness(0.82)'
    let pad = 0
    if (!img) {
      img = neighborImage(images, poster.wall, i, cols)
      if (img) {
        filter = 'saturate(0.55) brightness(0.3) blur(12px)'
        pad = 10
      }
    }
    paintCover(ctx, img, x, y, tile, tile, { filter, tone: '#14120f', pad })
    if (slot.first) {
      ctx.save()
      ctx.strokeStyle = ACCENT
      ctx.lineWidth = 3
      ctx.strokeRect(x + 1.5, y + 1.5, tile - 3, tile - 3)
      ctx.restore()
    }
  })
}
function drawFade(ctx) {
  const fade = ctx.createLinearGradient(0, 0, 0, 960)
  fade.addColorStop(0, 'rgba(12,11,9,0)')
  fade.addColorStop(0.20, 'rgba(12,11,9,0)')
  fade.addColorStop(0.34, 'rgba(12,11,9,0.16)')
  fade.addColorStop(0.48, 'rgba(12,11,9,0.66)')
  fade.addColorStop(0.60, NIGHT)
  fade.addColorStop(1, NIGHT)
  ctx.fillStyle = fade
  ctx.fillRect(0, 0, 540, 960)
  ctx.save()
  ctx.globalAlpha = 0.18
  ctx.globalCompositeOperation = 'overlay'
  const tile = noiseTile()
  for (let y = 0; y < 960; y += 140) for (let x = 0; x < 540; x += 140) ctx.drawImage(tile, x, y, 140, 140)
  ctx.restore()
}
function drawMainInk(ctx, w, h, poster) {
  grain(ctx, w, h, 'main', 0.2)
  ctx.save()
  ctx.strokeStyle = 'rgba(29,27,23,.2)'
  ctx.lineWidth = 0.7
  for (let y = PERF_PAD; y <= h - PERF_PAD + 0.01; y += PERF_PITCH) {
    ctx.beginPath()
    ctx.arc(PERF_X, y, PERF_R - 0.25, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()

  const textW = 340 - 26 - 16
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  ctx.fillStyle = ACCENT
  ctx.beginPath()
  ctx.arc(26 + 3, 22 + 6, 3, 0, Math.PI * 2)
  ctx.fill()
  ctx.font = `500 10px ${MONO}`
  ctx.fillStyle = ACCENT
  fillSpaced(ctx, 'ADMIT ONE · 第一次听见', 26 + 6 + 8, 22, 10 * 0.12)

  const title = layoutTitle(ctx, poster.first.title, textW)
  ctx.font = `600 ${title.size}px ${SERIF}`
  ctx.fillStyle = INK
  ctx.textBaseline = 'top'
  const titleTop = 48
  title.lines.forEach((line, i) => fillSpaced(ctx, line, 26, titleTop + i * title.size * 1.12, title.spacing))

  ctx.font = `400 15px ${SERIF}`
  ctx.fillStyle = MUTED
  const creditTop = titleTop + title.lines.length * title.size * 1.12 + 6
  fillSpaced(ctx, ellipsis(ctx, poster.first.credit, textW, 15 * 0.08), 26, creditTop, 15 * 0.08)

  const rowBottom = h - 20
  const borderY = rowBottom - 16
  ctx.strokeStyle = '#d6cfbf'
  ctx.lineWidth = 1
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.moveTo(26, borderY)
  ctx.lineTo(322, borderY)
  ctx.stroke()
  ctx.font = `500 12px ${MONO}`
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = INK
  const base = rowBottom - 2
  const tracking = 12 * 0.06
  fillSpaced(ctx, poster.first.date, 26, base, tracking)
  ctx.font = `400 12px ${MONO}`
  ctx.fillStyle = FAINT
  ctx.textAlign = 'center'
  fillSpaced(ctx, poster.first.weekday, (26 + 322) / 2, base, tracking)
  ctx.font = `500 12px ${MONO}`
  ctx.fillStyle = INK
  ctx.textAlign = 'right'
  fillSpaced(ctx, poster.first.time, 322, base, tracking)

  const stubMid = PERF_X + (w - PERF_X) / 2
  const labelH = 10, numH = 34, barH = 30, ofH = 10
  const stubTop = 30, stubBot = h - 28
  const stubGap = (stubBot - stubTop - labelH - numH - barH - ofH) / 3
  const yN = stubTop
  const yNum = yN + labelH + stubGap
  const yBar = yNum + numH + stubGap
  const yOf = yBar + barH + stubGap
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillStyle = FAINT
  ctx.font = `400 10px ${MONO}`
  fillSpaced(ctx, 'Nº', stubMid, yN, 10 * 0.14)
  ctx.fillStyle = INK
  ctx.font = `300 34px ${MONO}`
  fillSpaced(ctx, poster.stub.number, stubMid, yNum, 34 * 0.02)
  barcode(ctx, stubMid - 36, yBar, 72, barH)
  ctx.fillStyle = FAINT
  ctx.font = `400 10px ${MONO}`
  fillSpaced(ctx, `OF ${poster.stub.of}`, stubMid, yOf, 10 * 0.14)
  ctx.textAlign = 'left'
}
function drawMain(ctx, poster) {
  const x = 44, y = 318, w = 452, h = 206
  const backs = [
    { deg: -7, tx: -6, ty: 22, color: PAPER_3, holes: false },
    { deg: 3.5, tx: 10, ty: 10, color: PAPER_2, holes: false },
    { deg: -2.2, tx: 0, ty: 0, color: PAPER, holes: true },
  ]
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,.42)'
  ctx.shadowBlur = 26
  ctx.shadowOffsetY = 16
  for (const back of backs) {
    place(ctx, x, y, w, h, back.deg, back.tx, back.ty, c => {
      traceNotched(c, w, h, 'main', undefined, back.holes)
      c.fillStyle = back.color
      c.fill(back.holes ? 'evenodd' : 'nonzero')
    })
  }
  ctx.restore()
  place(ctx, x, y, w, h, -2.2, 0, 0, c => drawMainInk(c, w, h, poster))
}
function drawMini(ctx, card, index, images) {
  const inset = 32, gap = 12, w = 151, h = 124
  const x = inset + index * (w + gap), y = 560
  const deg = [-1.4, 1.1, -0.7][index]
  const notchY = 86
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,.48)'
  ctx.shadowBlur = 16
  ctx.shadowOffsetY = 10
  place(ctx, x, y, w, h, deg, 0, 0, c => {
    traceNotched(c, w, h, 'mini', notchY)
    c.fillStyle = PAPER
    c.fill()
  })
  ctx.restore()
  place(ctx, x, y, w, h, deg, 0, 0, c => {
    grain(c, w, h, 'mini', 0.16, notchY)
    c.save()
    c.strokeStyle = DASH_MINI
    c.lineWidth = 1
    c.setLineDash([2, 2.2])
    c.beginPath()
    c.moveTo(12, notchY)
    c.lineTo(w - 12, notchY)
    c.stroke()
    c.restore()

    const img = (card.portrait && images.get(card.portrait)) || (card.cover ? images.get(card.cover) : null)
    paintCover(c, img, 12, 16, 46, 46, { glyph: card.title, tone: '#e4ddd0', round: Boolean(card.portrait || card.face) })
    const textX = 64, textW = w - textX - 6
    c.textAlign = 'left'
    c.textBaseline = 'top'
    c.fillStyle = ACCENT
    c.font = `500 9px ${MONO}`
    const tracking = 9 * 0.08
    const label = (card.label || '').length <= 16 ? (card.label || '') : ellipsis(c, card.label, textW, tracking)
    fillSpaced(c, label, textX, 16, tracking)
    c.fillStyle = INK
    c.font = `600 13px ${SERIF}`
    const lines = wrapTitle(c, card.title, textW, 2, 13 * 0.02)
    lines.forEach((line, i) => fillSpaced(c, line, textX, 32 + i * 16, 13 * 0.02))
    c.fillStyle = MINI_MUTED
    c.font = `400 10px ${SERIF}`
    const subY = 32 + lines.length * 16 + 2
    if (subY < notchY - 6) fillSpaced(c, ellipsis(c, card.subtitle, textW, 0), textX, subY, 0)

    c.textBaseline = 'alphabetic'
    const base = h - 14
    const left = 14, right = w - 14
    c.font = `300 20px ${MONO}`
    const valueW = widthOf(c, card.value, 0)
    c.font = `400 10px ${MONO}`
    const unitW = widthOf(c, card.unit, 10 * 0.06)
    c.font = `300 20px ${MONO}`
    c.fillStyle = INK
    c.textAlign = 'left'
    fillSpaced(c, card.value, left, base, 0)
    c.font = `400 10px ${MONO}`
    c.fillStyle = MINI_MUTED
    const unitBase = base - 3
    if (left + valueW + 8 + unitW > right) fillSpaced(c, card.unit, left + valueW + 6, unitBase, 10 * 0.06)
    else {
      c.textAlign = 'right'
      fillSpaced(c, card.unit, right, unitBase, 10 * 0.06)
    }
  })
}
function drawClock(ctx, poster) {
  const left = 32, width = 476, top = 708
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  const capSpacing = 14 * 0.04
  ctx.font = `400 10px ${MONO}`
  const peakW = widthOf(ctx, poster.peakLabel, 10 * 0.1)
  ctx.font = `400 14px ${SERIF}`
  ctx.fillStyle = CREAM
  const caption = ellipsis(ctx, poster.caption, width - peakW - 16, capSpacing)
  fillSpaced(ctx, caption, left, top + 14, capSpacing)
  ctx.font = `400 10px ${MONO}`
  ctx.fillStyle = ACCENT_SOFT
  ctx.textAlign = 'right'
  fillSpaced(ctx, poster.peakLabel, left + width, top + 13, 10 * 0.1)

  const chartTop = top + 26, chartH = 56, gap = 3
  const barW = (width - 23 * gap) / 24
  const max = Math.max(1, ...poster.hours)
  for (let h = 0; h < 24; h++) {
    const count = poster.hours[h]
    const bh = 6 + (count / max) * (chartH - 6)
    const x = left + h * (barW + gap)
    const y = chartTop + chartH - bh
    ctx.fillStyle = h === poster.peakHour ? ACCENT : 'rgba(242,237,225,.32)'
    ctx.beginPath()
    if (ctx.roundRect) ctx.roundRect(x, y, barW, bh, 1)
    else ctx.rect(x, y, barW, bh)
    ctx.fill()
  }
  ctx.font = `400 10px ${MONO}`
  ctx.fillStyle = 'rgba(243,239,230,.55)'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  const ticks = ['00', '06', '12', '18', '24']
  ticks.forEach((label, i) => {
    const x = i === 0 ? left : i === ticks.length - 1 ? left + width : left + (width * i) / (ticks.length - 1)
    ctx.textAlign = i === 0 ? 'left' : i === ticks.length - 1 ? 'right' : 'center'
    fillSpaced(ctx, label, x, chartTop + chartH + 8, 0)
  })
}
function drawFooter(ctx, poster) {
  const left = 32, right = 508
  const metaY = 920
  const base = 876
  const borderY = 836
  const groups = [
    [num(poster.songs), '首歌'],
    [num(poster.artists), '位歌手'],
    [num(poster.days), '个日子'],
  ]
  ctx.textBaseline = 'alphabetic'
  const colW = (right - left) / 3
  groups.forEach(([value, label], i) => {
    ctx.font = `300 30px ${MONO}`
    const valueW = widthOf(ctx, value, 0)
    ctx.font = `400 14px ${SERIF}`
    const labelW = widthOf(ctx, label, 14 * 0.06)
    const groupW = valueW + 8 + labelW
    const colLeft = left + i * colW
    let x = colLeft
    if (i === 1) x = colLeft + (colW - groupW) / 2
    if (i === 2) x = colLeft + colW - groupW
    ctx.font = `300 30px ${MONO}`
    ctx.fillStyle = CREAM
    ctx.textAlign = 'left'
    fillSpaced(ctx, value, x, base, 0)
    ctx.font = `400 14px ${SERIF}`
    fillSpaced(ctx, label, x + valueW + 8, base, 14 * 0.06)
  })
  ctx.strokeStyle = 'rgba(242,237,225,.18)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(left, borderY)
  ctx.lineTo(right, borderY)
  ctx.stroke()
  ctx.font = `400 11px ${MONO}`
  ctx.fillStyle = 'rgba(243,239,230,.62)'
  ctx.textAlign = 'left'
  fillSpaced(ctx, poster.rangeLabel, left, metaY, 11 * 0.06)
  ctx.textAlign = 'right'
  fillSpaced(ctx, poster.site, right, metaY, 11 * 0.04)
}

function drawPoster(ctx, poster, images) {
  if ('fontVariantNumeric' in ctx) ctx.fontVariantNumeric = 'tabular-nums'
  ctx.fillStyle = NIGHT
  ctx.fillRect(0, 0, 540, 960)
  drawWall(ctx, poster, images)
  drawFade(ctx)
  drawMain(ctx, poster)
  ;[poster.mostPlayed, poster.mostMet, poster.latest].forEach((item, i) => drawMini(ctx, item, i, images))
  drawClock(ctx, poster)
  drawFooter(ctx, poster)
}

async function loadCovers(poster, loadImage) {
  const urls = new Set()
  for (const slot of poster.wall || []) if (slot.cover) urls.add(slot.cover)
  for (const item of [poster.first, poster.mostPlayed, poster.mostMet, poster.latest]) {
    if (item?.cover) urls.add(item.cover)
    if (item?.portrait) urls.add(item.portrait)
  }
  const images = new Map()
  await Promise.all([...urls].map(async url => {
    try {
      const img = await loadImage(url)
      if (img && canDraw(img)) images.set(url, img)
    } catch { /* a missing cover becomes a quiet tile, never a failed export */ }
  }))
  return images
}

// Returns { canvas, blob } at 1080×1920. Cover failures are skipped; they do not reject.
export async function renderPoster(poster, options = {}) {
  if (typeof document === 'undefined') throw new Error('海报只能在浏览器里绘制')
  if (!poster?.first || !poster.wall?.length) throw new Error('没有可以绘制的初听')
  const scale = options.scale || 2
  await waitForFonts()
  const images = await loadCovers(poster, options.loadImage || defaultLoadImage)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(540 * scale)
  canvas.height = Math.round(960 * scale)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  drawPoster(ctx, poster, images)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(value => value ? resolve(value) : reject(new Error('海报没有导出成功')), 'image/png')
  })
  return { canvas, blob, width: canvas.width, height: canvas.height }
}
