// Pure helpers for the time-travel sequence: timing, a rolling clock, and cover poses.
export const TRAVEL_MS = 2600
export const TRAVEL_BACK_MS = 920
export const TRAVEL_REDUCED_MS = 340
export const TRAVEL_MAX_COVERS = 24
export const TRAVEL_COVER_PX = 240

export function easeOut(t) {
  const x = Math.min(1, Math.max(0, Number(t) || 0))
  return 1 - (1 - x) ** 3
}

export function lerp(a, b, t) {
  return a + (b - a) * t
}

export function clockParts(ms) {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), hh: d.getHours(), mm: d.getMinutes() }
}

export function formatClock(parts) {
  if (!parts) return ''
  const pad = n => String(n).padStart(2, '0')
  return `${parts.y}.${pad(parts.m)}.${pad(parts.d)}`
}

// Prefer events that actually have artwork. Never pad the tunnel with letter tiles
// when at least one real cover exists; the letter fallback is only for empty archives.
export function pickTravelCovers(events, target, limit = TRAVEL_MAX_COVERS) {
  const list = Array.isArray(events) ? events : []
  const cap = Math.max(1, Math.min(TRAVEL_MAX_COVERS, limit || TRAVEL_MAX_COVERS))
  const out = [], seen = new Set()
  const add = e => {
    if (!e || out.length >= cap) return
    const key = e.cover || `id:${e.song_id}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(e)
  }
  const rest = list.filter(e => e && e.song_id !== target?.song_id)
  const pictured = rest.filter(e => e.cover)
  const pool = pictured.length ? pictured : rest
  const step = Math.max(1, Math.floor(pool.length / Math.max(1, cap - (target?.cover || !pictured.length ? 1 : 0))))
  for (let i = 0; i < pool.length && out.length < cap - (target && (target.cover || !pictured.length) ? 1 : 0); i += step) add(pool[i])
  for (const e of pool) { if (out.length >= cap - (target && (target.cover || !pictured.length) ? 1 : 0)) break; add(e) }
  if (target && (target.cover || !pictured.length)) add(target)
  return out
}

// Repeat a short decoded wall so a small library still feels like rushing past albums.
export function fillTravelWall(items, want = 18) {
  const list = Array.isArray(items) ? items.filter(Boolean) : []
  if (!list.length) return []
  const target = Math.min(TRAVEL_MAX_COVERS, list.length >= want ? Math.min(list.length, TRAVEL_MAX_COVERS) : Math.max(list.length, want))
  if (list.length >= target) return list.slice(0, target)
  const out = []
  while (out.length < target) out.push(list[out.length % list.length])
  return out
}

// A card starts far down a wide corridor and rushes past the camera as t goes 0 → 1.
export function cardPose(i, n, t, reverse = false) {
  const p = reverse ? 1 - t : t
  const turn = i * 2.399 + p * 1.35
  const radius = 260 + (i % 5) * 42
  const x = Math.cos(turn) * radius
  const y = Math.sin(turn * 0.68) * (radius * 0.4)
  const along = i / Math.max(1, n - 1)
  const z = -1580 + along * 640 + p * 2180
  const scale = 0.82 + Math.max(0, (z + 1000) / 1400)
  let opacity = 1
  if (z > 340) opacity = Math.max(0, 1 - (z - 340) / 200)
  else if (z < -1250) opacity = Math.max(0, (z + 1580) / 330)
  const blur = z < -980 ? 1.8 : Math.min(1.2, Math.abs(x) / 520)
  return { x, y, z, opacity, rotate: Math.cos(turn) * 7, scale, blur }
}
