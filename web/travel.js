// Pure helpers for the time-travel sequence: timing, a rolling clock, and cover poses.
export const TRAVEL_MS = 2600
export const TRAVEL_BACK_MS = 920
export const TRAVEL_REDUCED_MS = 340
export const TRAVEL_MAX_COVERS = 24
export const TRAVEL_COVER_PX = 240
export const TRAVEL_WALL = 10

export function easeOut(t) {
  const x = Math.min(1, Math.max(0, Number(t) || 0))
  return 1 - (1 - x) ** 3
}

// Slow at both ends, fastest in the middle — accelerate, peak, then ease into arrival.
export function easeTravel(t) {
  const x = Math.min(1, Math.max(0, Number(t) || 0))
  return x * x * x * (x * (x * 6 - 15) + 10)
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
  const reserve = target && (target.cover || !pictured.length) ? 1 : 0
  const step = Math.max(1, Math.floor(pool.length / Math.max(1, cap - reserve)))
  for (let i = 0; i < pool.length && out.length < cap - reserve; i += step) add(pool[i])
  for (const e of pool) { if (out.length >= cap - reserve) break; add(e) }
  if (target && (target.cover || !pictured.length)) add(target)
  return out
}

// Repeat a short decoded wall so a small library still feels like a corridor.
export function fillTravelWall(items, want = TRAVEL_WALL) {
  const list = Array.isArray(items) ? items.filter(Boolean) : []
  if (!list.length) return []
  const target = Math.min(TRAVEL_MAX_COVERS, list.length >= want ? Math.min(list.length, TRAVEL_MAX_COVERS) : Math.max(list.length, want))
  if (list.length >= target) return list.slice(0, target)
  const out = []
  while (out.length < target) out.push(list[out.length % list.length])
  return out
}

// Two walls receding from a vanishing point. Screen-space X stays outside a calm
// centre for the date when far, then slings past the edges as cards rush the camera.
export function cardPose(i, n, t, reverse = false) {
  const p = reverse ? 1 - t : t
  const side = i % 2 === 0 ? -1 : 1
  const slot = Math.floor(i / 2)
  const perspective = 1000
  const z0 = -1560
  const z = z0 + slot * 320 + p * 2400
  const nearness = Math.min(1, Math.max(0, (z + 1400) / 1500))
  const outward = Math.max(0, z + 40) * 0.62
  const screen = 268 + nearness * 148 + outward
  const denom = perspective - Math.min(z, perspective - 80)
  const x = side * screen * denom / perspective
  const y = ((slot % 3) - 1) * (70 + nearness * 50)
  const brightness = 0.4 + 0.6 * nearness
  const blur = nearness < 0.32 ? Math.min(2.4, (0.32 - nearness) * 6.5) : 0
  let opacity = 1
  if (z > 400) opacity = Math.max(0, 1 - (z - 400) / 140)
  else if (z < -1620) opacity = Math.max(0, (z + 1760) / 140)
  return { x, y, z, opacity, rotate: 0, scale: 1, blur, brightness, side }
}

// The destination cover grows out of the vanishing point in the last third of the trip.
export function heroPose(t, reverse = false) {
  const p = reverse ? 1 - t : t
  const u = Math.min(1, Math.max(0, (p - 0.62) / 0.38))
  const e = u * u * (3 - 2 * u)
  return {
    x: 0,
    y: 0,
    z: -1200 + e * 1240,
    scale: 0.3 + e * 1.4,
    opacity: !u ? 0 : u < 0.08 ? u / 0.08 : 1,
    blur: (1 - e) * 1.3,
    brightness: 0.68 + 0.32 * e,
    rotate: 0
  }
}
