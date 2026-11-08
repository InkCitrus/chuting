// Pure helpers for the time-travel sequence: timing, a rolling clock, and cover poses.
export const TRAVEL_MS = 2600
export const TRAVEL_BACK_MS = 920
export const TRAVEL_REDUCED_MS = 340
export const TRAVEL_MAX_COVERS = 24

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
  const others = rest.filter(e => e.cover).concat(rest.filter(e => !e.cover))
  const step = Math.max(1, Math.floor(others.length / Math.max(1, cap - 1)))
  for (let i = 0; i < others.length && out.length < cap - 1; i += step) add(others[i])
  for (const e of others) { if (out.length >= cap - 1) break; add(e) }
  if (target) add(target)
  return out
}

// A card starts far down the corridor and rushes past the camera as t goes 0 → 1.
export function cardPose(i, n, t, reverse = false) {
  const p = reverse ? 1 - t : t
  const lane = (i % 7) - 3
  const along = (i / Math.max(1, n - 1))
  const z = -200 - along * 980 + p * 1520
  const x = lane * 72 + Math.sin(i * 1.7 + p * 1.8) * 16
  const y = ((i % 5) - 2) * 34 + Math.cos(i * 1.3) * 10
  let opacity = 1
  if (z > 260) opacity = Math.max(0, 1 - (z - 260) / 180)
  else if (z < -860) opacity = Math.max(0, (z + 1100) / 240)
  return { x, y, z, opacity, rotate: lane * 3.5 }
}
