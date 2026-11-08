// Music time capsule: "on this day" and a random jump back, computed from the local archive.
// Calendar math uses the viewer's local timezone, not the Asia/Shanghai date string stored on each event.
export function localYmd(value) {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }
}

export function yearsAgoLabel(n) {
  if (n === 1) return '去年'
  return `${n} 年前`
}

// Day-of-year on a leap-year calendar so 29 February exists and is one day from both 28 Feb and 1 Mar.
export function dayOrdinal(m, d) {
  return Math.round((Date.UTC(2024, m - 1, d) - Date.UTC(2024, 0, 1)) / 86400000)
}

export function monthDayDistance(a, b) {
  const da = dayOrdinal(a.m, a.d), db = dayOrdinal(b.m, b.d)
  const diff = Math.abs(da - db)
  return Math.min(diff, 366 - diff)
}

export function onThisDay(events, now = new Date()) {
  const today = localYmd(now)
  if (!today) return []
  return (events || [])
    .filter(e => {
      if (!e?.first_listen_ms) return false
      const when = localYmd(e.first_listen_ms)
      return when && when.m === today.m && when.d === today.d && when.y < today.y
    })
    .sort((a, b) => a.first_listen_ms - b.first_listen_ms || String(a.song_id).localeCompare(String(b.song_id)))
    .map(event => {
      const when = localYmd(event.first_listen_ms)
      return { event, when, yearsAgo: today.y - when.y }
    })
}

export function nearestDay(events, now = new Date()) {
  const today = localYmd(now)
  if (!today) return null
  const groups = new Map()
  for (const event of events || []) {
    if (!event?.first_listen_ms) continue
    const when = localYmd(event.first_listen_ms)
    if (!when) continue
    const dist = monthDayDistance(when, today)
    if (dist === 0) continue
    const key = `${when.m}-${when.d}`
    const group = groups.get(key) || { m: when.m, d: when.d, dist, songs: [] }
    group.songs.push({ event, when, yearsAgo: today.y - when.y })
    groups.set(key, group)
  }
  if (!groups.size) return null
  const best = [...groups.values()].sort((a, b) => a.dist - b.dist || a.m - b.m || a.d - b.d)[0]
  best.songs.sort((a, b) => a.event.first_listen_ms - b.event.first_listen_ms)
  return best
}

export function capsuleToday(events, now = new Date()) {
  const today = localYmd(now)
  const songs = onThisDay(events, now)
  if (songs.length) return { kind: 'today', today, songs, nearest: null }
  return { kind: 'empty', today, songs: [], nearest: nearestDay(events, now) }
}

export function neighbors(events, event, { days = 3, limit = 4 } = {}) {
  if (!event?.first_listen_ms) return []
  const window = Math.max(0, days) * 86400000
  return (events || [])
    .filter(e => e.song_id !== event.song_id && Math.abs((e.first_listen_ms || 0) - event.first_listen_ms) <= window)
    .sort((a, b) => Math.abs(a.first_listen_ms - event.first_listen_ms) - Math.abs(b.first_listen_ms - event.first_listen_ms)
      || a.first_listen_ms - b.first_listen_ms)
    .slice(0, limit)
}

export function randomMoment(events, rng = Math.random, exceptId = null) {
  const all = events || []
  const pool = exceptId ? all.filter(e => e.song_id !== exceptId) : all
  const list = pool.length ? pool : all
  if (!list.length) return null
  const n = Number(rng())
  const index = Math.min(list.length - 1, Math.max(0, Math.floor((Number.isFinite(n) ? n : 0) * list.length)))
  return list[index] || null
}
