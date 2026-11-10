// Pure helpers for the time-travel sequence: timing, a rolling clock, and cover poses.
export const TRAVEL_MS = 3500
export const TRAVEL_BACK_MS = 920
export const TRAVEL_REDUCED_MS = 340
export const TRAVEL_MAX_COVERS = 48
export const TRAVEL_COVER_PX = 200
export const TRAVEL_COVER_PX_DESKTOP = 300
export const TRAVEL_COVER_PX_MOBILE = 272
export const TRAVEL_COVER_PX_LITE = 200
export const TRAVEL_BACK_PX = 32
export const TRAVEL_TILES = 120
export const TRAVEL_SIDES = 4
export const TRAVEL_FACE_COUNTS = [4, 4, 6, 6]
export const TRAVEL_RINGS = 6

export function easeOut(t) {
  const x = Math.min(1, Math.max(0, Number(t) || 0))
  return 1 - (1 - x) ** 3
}

// Slow at both ends, fastest in the middle. Extra duration sits in a high-speed
// cruise before the peak (eased 0.5 at raw 2.1/3.5), then the same deceleration.
export function easeTravel(t) {
  const x = Math.min(1, Math.max(0, Number(t) || 0))
  const accel = 0.9 / 3.5
  const peak = 2.1 / 3.5
  const oldAccel = 0.9 / 2.8
  let u
  if (x <= accel) u = (x / accel) * oldAccel
  else if (x <= peak) u = oldAccel + ((x - accel) / (peak - accel)) * (0.5 - oldAccel)
  else u = 0.5 + ((x - peak) / (1 - peak)) * 0.5
  return u * u * u * (u * (u * 6 - 15) + 10)
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

export function formatTravelMeta(ms, toMs) {
  const days = Math.round((Number(ms) - Number(toMs)) / 86400000)
  if (!Number.isFinite(days)) return 'T−0'
  return days < 0 ? `T+${Math.abs(days)}` : `T−${days}`
}

export function travelFx(t) {
  const x = Math.min(1, Math.max(0, Number(t) || 0))
  const flash = Math.exp(-((x - 0.5) ** 2) / 0.0028) * 0.82
  const rush = Math.exp(-((x - 0.48) ** 2) / 0.03)
  return {
    flash,
    streaks: rush * 0.95,
    chroma: rush * 0.8,
    bloom: 0.45 + rush * 0.5
  }
}

// Up to 48 distinct covers, picked at random from the whole archive and
// deduped by cover URL. Never pad with letter tiles when at least one real
// cover exists; the letter fallback is only for empty archives.
export function pickTravelCovers(events, target, limit = TRAVEL_MAX_COVERS, rng = Math.random) {
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
  const budget = cap - reserve
  const shuffled = pool.slice()
  for (let i = shuffled.length - 1; i > 0; i--) {
    const n = Number(typeof rng === 'function' ? rng() : Math.random())
    const j = Math.min(i, Math.max(0, Math.floor((Number.isFinite(n) ? n : 0) * (i + 1))))
    const swap = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = swap
  }
  for (const e of shuffled) { if (out.length >= budget) break; add(e) }
  if (target && (target.cover || !pictured.length)) add(target)
  return out
}

// Repeat a short decoded set so a small library still fills a dense tunnel.
export function fillTravelWall(items, want = TRAVEL_TILES) {
  const list = Array.isArray(items) ? items.filter(Boolean) : []
  if (!list.length) return []
  const target = Math.min(120, Math.max(1, want || TRAVEL_TILES))
  if (list.length >= target) return list.slice(0, target)
  const out = []
  while (out.length < target) out.push(list[out.length % list.length])
  return out
}

export function travelQuality({ reducedMotion, hardwareConcurrency, deviceMemory } = {}) {
  if (reducedMotion) return 'reduced'
  const cores = Number(hardwareConcurrency)
  const mem = Number(deviceMemory)
  // deviceMemory is the reliable low-end signal. Safari does not expose it
  // and often reports hardwareConcurrency as 4 even on modern iPhones, so
  // "4 cores" alone must not force the sparse lite tunnel.
  if (Number.isFinite(mem) && mem > 0 && mem <= 4) return 'lite'
  if (Number.isFinite(cores) && cores > 0 && cores <= 2) return 'lite'
  return 'full'
}

export function travelStageLayout(width, height, quality = 'full') {
  const w = Math.max(1, Number(width) || 0)
  const h = Math.max(1, Number(height) || 0)
  const portrait = h > w * 1.08
  const lite = quality === 'lite' || quality === 'reduced'
  if (!portrait) {
    const faceCounts = TRAVEL_FACE_COUNTS.slice()
    const perRing = faceCounts.reduce((sum, count) => sum + count, 0)
    const rings = lite ? 4 : TRAVEL_RINGS
    const spacing = 310
    return {
      portrait: false,
      quality: lite ? 'lite' : 'full',
      wallX: 470,
      wallY: 278,
      faceCounts,
      perspective: 900,
      spacing,
      zMin: lite ? 20 - rings * spacing : -1640,
      rotateX: lite ? 16 : 24,
      rotateY: lite ? 20 : 28,
      cornerInset: 0,
      rings,
      tiles: perRing * rings,
      coverPx: lite ? TRAVEL_COVER_PX_LITE : TRAVEL_COVER_PX_DESKTOP
    }
  }
  // Side walls sit inside a phone frame so covers stream through the whole
  // portrait. Density, depth and wall span match the original full-bleed
  // tunnel; cards stay tilted. A card is hidden only once it crosses the
  // near plane, not earlier, so the near covers still reach the screen edges.
  const faceCounts = lite ? [3, 3, 2, 2] : [6, 6, 4, 4]
  const perRing = faceCounts.reduce((sum, count) => sum + count, 0)
  const rings = lite ? 3 : TRAVEL_RINGS
  const spacing = 250
  return {
    portrait: true,
    quality: lite ? 'lite' : 'full',
    wallX: Math.round(Math.min(178, Math.max(128, w * 0.42))),
    wallY: Math.round(Math.min(380, Math.max(248, h * 0.40))),
    faceCounts,
    perspective: 640,
    spacing,
    zMin: lite ? 30 - rings * spacing : -1420,
    rotateX: lite ? 10 : 14,
    rotateY: lite ? 12 : 16,
    cornerInset: 0,
    rings,
    tiles: perRing * rings,
    coverPx: lite ? TRAVEL_COVER_PX_LITE : TRAVEL_COVER_PX_MOBILE
  }
}

export function tileLayout(i, n = TRAVEL_TILES, faceCounts = TRAVEL_FACE_COUNTS) {
  const counts = Array.isArray(faceCounts) && faceCounts.length ? faceCounts : TRAVEL_FACE_COUNTS
  const perRing = counts.reduce((sum, count) => sum + count, 0)
  const rings = Math.max(1, Math.round((Number(n) || TRAVEL_TILES) / perRing) || TRAVEL_RINGS)
  const index = ((Number(i) || 0) % (rings * perRing) + rings * perRing) % (rings * perRing)
  const ring = Math.floor(index / perRing)
  let rest = index % perRing
  let face = 0
  while (face < counts.length - 1 && rest >= counts[face]) {
    rest -= counts[face]
    face += 1
  }
  return { ring, face, col: rest, rings, across: counts[face], perRing }
}

// Rectangular tube: more tiles on floor/ceiling than on the side walls so a
// wide frame fills a landscape screen. Rings wrap along Z to stay dense.
export function cardPose(i, n, t, reverse = false, layout = null) {
  const p = reverse ? 1 - t : t
  const { ring, face, col, rings, across } = tileLayout(i, n, layout?.faceCounts)
  const spacing = layout?.spacing ?? 310
  const length = rings * spacing
  const zMin = layout?.zMin ?? -1640
  const shift = p * length * 2.25
  let z = zMin + ring * spacing + shift
  z = zMin + ((z - zMin) % length + length) % length

  const wallX = layout?.wallX ?? 470
  const wallY = layout?.wallY ?? 278
  const inset = Math.max(0, Number(layout?.cornerInset) || 0)
  const spanX = Math.max(40, wallX - inset)
  const spanY = Math.max(40, wallY - inset)
  const pitchY = across > 1 ? (2 * spanY) / (across - 1) : 0
  const pitchX = across > 1 ? (2 * spanX) / (across - 1) : 0
  const offset = col - (across - 1) / 2
  const tiltY = layout?.rotateY ?? 28
  const tiltX = layout?.rotateX ?? 24
  let x = 0, y = 0, rotateX = 0, rotateY = 0
  if (face === 0) { x = -wallX; y = offset * pitchY; rotateY = tiltY }
  else if (face === 1) { x = wallX; y = offset * pitchY; rotateY = -tiltY }
  else if (face === 2) { y = -wallY; x = offset * pitchX; rotateX = -tiltX }
  else { y = wallY; x = offset * pitchX; rotateX = tiltX }

  const nearness = Math.min(1, Math.max(0, (z - zMin) / Math.max(1, length - 220)))
  const brightness = 0.2 + 0.8 * nearness
  let opacity = 1
  // Hide a card only when its center actually crosses the near plane
  // (approaches the camera at `perspective`). Earlier fades and edge-aware
  // hides removed the large near and corner covers that filled the frame.
  const cam = layout?.perspective ?? 900
  const nearHide = cam - 40
  if (z >= nearHide) opacity = 0
  else if (z > nearHide - 80) opacity = Math.max(0, (nearHide - z) / 80)
  else if (z < zMin + 90) opacity = 0.28 + 0.72 * Math.max(0, (z - zMin) / 90)
  return { x, y, z, opacity, rotate: 0, rotateX, rotateY, scale: 1, blur: 0, brightness, face, ring, side: face < 2 ? (face === 0 ? -1 : 1) : 0 }
}

// Per-card projection. Each card carries its own perspective() instead of
// relying on a parent `perspective` + `transform-style: preserve-3d` 3D
// rendering context, which iOS WebKit (Safari and Chrome on iPhone) can
// flatten into a static 2D frame. translate(o) perspective(P) translate(-o)
// is the same projection a parent with perspective-origin o would apply,
// where o is the origin's offset from the card's own centre.
export function cardTransform(pose, cam = {}) {
  const p = Math.max(1, Number(cam.perspective) || 900)
  const ox = Number(cam.ox) || 0
  const oy = Number(cam.oy) || 0
  const f = n => (Number(n) || 0).toFixed(1)
  const lead = ox || oy ? `translate3d(${f(ox)}px, ${f(oy)}px, 0px) ` : ''
  return `${lead}perspective(${p}px) translate3d(${f(pose.x - ox)}px, ${f(pose.y - oy)}px, ${f(pose.z)}px) ` +
    `rotateX(${Number(pose.rotateX) || 0}deg) rotateY(${Number(pose.rotateY) || 0}deg) scale(${(Number(pose.scale) || 1).toFixed(4)})`
}

// Paint order without a 3D context: farther cards stack lower. Quantised to
// half a ring so z-index only changes a few times per ring pass.
export function cardDepthIndex(z, layout = null) {
  const zMin = layout?.zMin ?? -1640
  const step = Math.max(1, (layout?.spacing ?? 310) / 2)
  return 1 + Math.max(0, Math.floor(((Number(z) || 0) - zMin) / step))
}

// The destination cover grows out of the vanishing point after the speed peak.
export function heroPose(t, reverse = false) {
  const p = reverse ? 1 - t : t
  const u = Math.min(1, Math.max(0, (p - 0.68) / 0.32))
  const e = u * u * (3 - 2 * u)
  return {
    x: 0,
    y: 0,
    z: -1100 + e * 1180,
    scale: 0.22 + e * 1.55,
    opacity: !u ? 0 : u < 0.08 ? u / 0.08 : 1,
    blur: (1 - e) * 1.1,
    brightness: 0.72 + 0.28 * e,
    rotate: 0,
    rotateX: 0,
    rotateY: 0
  }
}
