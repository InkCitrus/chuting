import test from 'node:test'
import assert from 'node:assert/strict'
import { easeOut, easeTravel, lerp, clockParts, formatClock, formatTravelMeta, travelFx, pickTravelCovers, fillTravelWall, cardPose, heroPose, tileLayout, travelStageLayout, travelQuality, cardTransform, cardDepthIndex, cardKeyframes, ringDepthIndex, travelProgress, depthLook, TRAVEL_MAX_COVERS, TRAVEL_TILES, TRAVEL_MS, TRAVEL_RINGS } from '../web/travel.js'

test('easeOut stays in range and slows near the end', () => {
  assert.equal(easeOut(0), 0)
  assert.equal(easeOut(1), 1)
  assert.ok(easeOut(0.5) > 0.5)
  assert.ok(easeOut(1.4) === 1)
})

test('easeTravel accelerates then decelerates', () => {
  assert.equal(easeTravel(0), 0)
  assert.equal(easeTravel(1), 1)
  assert.ok(Math.abs(easeTravel(2.1 / 3.5) - 0.5) < 0.02, 'peak stays at eased 0.5, later in raw time')
  const early = easeTravel(0.18) - easeTravel(0)
  const cruise = easeTravel(0.5) - easeTravel(0.35)
  const late = easeTravel(1) - easeTravel(0.85)
  assert.ok(cruise > early, 'should be faster in the cruise than at the start')
  assert.ok(cruise > late, 'should be faster in the cruise than at the end')
})

test('clock parts and lerp walk backward through a date', () => {
  const from = Date.parse('2026-11-08T12:00:00Z')
  const to = Date.parse('2025-04-13T12:00:00Z')
  const mid = lerp(from, to, 0.5)
  assert.ok(mid < from && mid > to)
  const parts = clockParts(to)
  assert.equal(parts.y, 2025)
  assert.equal(parts.m, 4)
  assert.equal(parts.d, 13)
  assert.equal(formatClock(parts), '2025.04.13')
})

test('formatTravelMeta counts down toward the destination', () => {
  const to = Date.parse('2024-11-08T00:00:00+09:00')
  const from = Date.parse('2026-11-08T00:00:00+09:00')
  assert.equal(formatTravelMeta(from, to), `T−${Math.round((from - to) / 86400000)}`)
  assert.equal(formatTravelMeta(to, to), 'T−0')
})

test('travelFx peaks around the midpoint', () => {
  assert.ok(travelFx(0.5).flash > travelFx(0.2).flash)
  assert.ok(travelFx(0.5).flash > travelFx(0.8).flash)
  assert.ok(travelFx(0.48).streaks > travelFx(0.1).streaks)
})

test('pickTravelCovers keeps the target and stays within the cap', () => {
  const events = Array.from({ length: 40 }, (_, i) => ({ song_id: String(i), cover: i % 2 ? `c${i}` : '', name: `s${i}` }))
  const target = events[7]
  const covers = pickTravelCovers(events, target, 24)
  assert.ok(covers.length <= TRAVEL_MAX_COVERS)
  assert.equal(covers.at(-1).song_id, '7')
  assert.ok(covers.every(e => e.cover))
  assert.equal(new Set(covers.map(e => e.cover || `id:${e.song_id}`)).size, covers.length)
})

test('pickTravelCovers does not pad with letter tiles when artwork exists', () => {
  const blanks = Array.from({ length: 20 }, (_, i) => ({ song_id: `b${i}`, cover: '', name: `blank-${i}` }))
  const pictured = [
    { song_id: 'c1', cover: 'http://x/a.jpg', name: 'A' },
    { song_id: 'c2', cover: 'http://x/b.jpg', name: 'B' },
    { song_id: '7', cover: 'http://x/t.jpg', name: 'T' }
  ]
  const covers = pickTravelCovers([...blanks, ...pictured], pictured[2], 24)
  assert.equal(covers.length, 3)
  assert.ok(covers.every(e => e.cover))
  assert.equal(covers.at(-1).song_id, '7')
})

test('fillTravelWall repeats a short decoded set instead of inventing blanks', () => {
  const few = [{ cover: 'a' }, { cover: 'b' }, { cover: 'c' }]
  const wall = fillTravelWall(few, 18)
  assert.equal(wall.length, 18)
  assert.ok(wall.every(item => item.cover))
  assert.equal(fillTravelWall([], 18).length, 0)
  assert.equal(fillTravelWall(few, TRAVEL_TILES).length, TRAVEL_TILES)
  assert.ok(TRAVEL_TILES <= 120)
  assert.equal(TRAVEL_MS, 3500)
  assert.equal(TRAVEL_RINGS, 6)
  assert.equal(tileLayout(0, TRAVEL_TILES).rings, 6)
})

test('card poses tile four tunnel faces and stream toward the camera', () => {
  const n = TRAVEL_TILES
  const faces = new Set()
  const zs = []
  for (let i = 0; i < n; i++) {
    const pose = cardPose(i, n, 0)
    faces.add(pose.face)
    zs.push(pose.z)
    assert.equal(tileLayout(i, n).face, pose.face)
  }
  assert.equal(faces.size, 4)
  assert.ok(faces.has(0) && faces.has(1) && faces.has(2) && faces.has(3))
  const left = cardPose(0, n, 0)
  const right = cardPose(4, n, 0)
  assert.ok(left.x < 0 && right.x > 0)
  const far = cardPose(0, n, 0)
  const moved = cardPose(0, n, 0.35)
  assert.ok(moved.z !== far.z)
  const byZ = [...Array(n)].map((_, i) => cardPose(i, n, 0.2)).sort((a, b) => a.z - b.z)
  assert.ok(byZ[0].brightness <= byZ.at(-1).brightness)
})

test('hero cover stays hidden until late, then grows out of the vanishing point', () => {
  const early = heroPose(0.3)
  const late = heroPose(1)
  assert.equal(early.opacity, 0)
  assert.ok(late.opacity === 1)
  assert.ok(late.z > early.z)
  assert.ok(late.scale > early.scale)
})

test('pickTravelCovers takes a random unique sample from the whole archive and caps at 48', () => {
  assert.equal(TRAVEL_MAX_COVERS, 48)
  const target = { song_id: 't', cover: 'ct', name: 'T' }
  const events = Array.from({ length: 80 }, (_, i) => ({
    song_id: String(i),
    cover: `c${i}`,
    first_listen_ms: Date.parse('2020-01-01T00:00:00+09:00') + i * 86400000
  }))
  let n = 0
  const rng = () => { const x = (n++ * 0.173) % 1; return x }
  const covers = pickTravelCovers([...events, target], target, 12, rng)
  assert.ok(covers.length <= 12)
  assert.equal(covers.length, 12)
  assert.equal(covers.at(-1).song_id, 't')
  assert.equal(new Set(covers.map(e => e.cover)).size, covers.length)
  const ids = covers.slice(0, -1).map(e => Number(e.song_id))
  assert.ok(Math.max(...ids) - Math.min(...ids) > 20)
  const again = pickTravelCovers([...events, target], target, 12, () => 0.9)
  assert.notDeepEqual(covers.slice(0, -1).map(e => e.song_id), again.slice(0, -1).map(e => e.song_id))
})

test('pickTravelCovers dedupes by cover URL and keeps unique art', () => {
  const target = { song_id: 't', cover: 'unique-t', first_listen_ms: Date.parse('2024-01-01T00:00:00+09:00') }
  const events = Array.from({ length: 12 }, (_, i) => ({
    song_id: String(i),
    cover: i < 8 ? 'shared' : `other-${i}`,
    first_listen_ms: Date.parse('2025-01-01T00:00:00+09:00') + i * 86400000
  }))
  const covers = pickTravelCovers([...events, target], target, 8)
  assert.equal(new Set(covers.map(e => e.cover || `id:${e.song_id}`)).size, covers.length)
  assert.ok(covers.some(e => e.cover === 'shared'))
  assert.equal(covers.filter(e => e.cover === 'shared').length, 1)
})

test('portrait stage layout pulls the tunnel walls into a phone frame', () => {
  const phone = travelStageLayout(390, 844)
  assert.equal(phone.portrait, true)
  assert.ok(phone.wallX >= 128 && phone.wallX <= 178)
  assert.ok(phone.wallY > phone.wallX)
  assert.deepEqual(phone.faceCounts, [6, 6, 4, 4])
  assert.equal(phone.tiles, TRAVEL_TILES)
  assert.equal(phone.zMin, -1420)
  assert.equal(phone.rotateY, 16)
  assert.equal(phone.rotateX, 14)
  assert.equal(phone.coverPx, 272)
  assert.equal(phone.perspective, 640)
  assert.ok(phone.spacing < 310)
  assert.equal(phone.cornerInset, 0)

  const wide = travelStageLayout(1280, 800)
  assert.equal(wide.portrait, false)
  assert.equal(wide.wallX, 470)
  assert.equal(wide.wallY, 278)
  assert.equal(wide.perspective, 900)
  assert.equal(wide.tiles, TRAVEL_TILES)
  assert.equal(wide.zMin, -1640)
  assert.equal(wide.rotateY, 28)
  assert.equal(wide.rotateX, 24)
  assert.equal(wide.coverPx, 300)
  assert.equal(wide.cornerInset, 0)

  const n = TRAVEL_TILES
  const plain = cardPose(3, n, 0.2)
  const viaWide = cardPose(3, n, 0.2, false, wide)
  assert.equal(plain.face, viaWide.face)
  assert.equal(plain.x, viaWide.x)
  assert.equal(viaWide.y, plain.y)

  const left = cardPose(0, n, 0, false, phone)
  const right = cardPose(phone.faceCounts[0], n, 0, false, phone)
  assert.equal(left.face, 0)
  assert.equal(right.face, 1)
  assert.ok(Math.abs(left.x) <= phone.wallX + 0.5)
  assert.ok(Math.abs(left.x) < 195, 'left wall stays inside a 390px frame')
  assert.ok(right.x > 0 && Math.abs(right.x) < 195)
  assert.ok(Math.abs(Math.abs(left.y) - phone.wallY) < 0.5, 'end cards sit at the tube corners')
  assert.ok(left.rotateY > 0 && right.rotateY < 0)

  const sampled = [0, 0.2, 0.45, 0.7, 1].flatMap(t => [...Array(wide.tiles)].map((_, i) => cardPose(i, wide.tiles, t, false, wide)))
  const nearish = sampled.filter(p => p.z > -80 && p.z < wide.perspective - 80)
  assert.ok(nearish.length > 0 && nearish.every(p => p.opacity === 1), 'near cards stay visible until they cross the near plane')
  const pastNear = sampled.filter(p => p.z >= wide.perspective - 40)
  assert.ok(pastNear.every(p => p.opacity === 0))
  const far = sampled.filter(p => p.z < wide.zMin + 90)
  assert.ok(far.length > 0 && far.every(p => p.opacity >= 0.28))

  const faces = new Set([...Array(n)].map((_, i) => cardPose(i, n, 0.15, false, phone).face))
  assert.equal(faces.size, 4)
})

test('travelQuality picks a lighter path on constrained devices', () => {
  assert.equal(travelQuality({ reducedMotion: true }), 'reduced')
  assert.equal(travelQuality({ hardwareConcurrency: 4, deviceMemory: 4 }), 'lite')
  assert.equal(travelQuality({ hardwareConcurrency: 4 }), 'full', 'Safari-like 4 cores without deviceMemory stays full')
  assert.equal(travelQuality({ hardwareConcurrency: 2 }), 'lite')
  assert.equal(travelQuality({ hardwareConcurrency: 8, deviceMemory: 8 }), 'full')
  const lite = travelStageLayout(390, 844, 'lite')
  assert.ok(lite.tiles < travelStageLayout(390, 844, 'full').tiles)
  assert.ok(lite.rotateY >= 10)
  assert.ok(lite.rotateX >= 8)
})


// 4x4 helpers (column vectors) to check the per-card projection numerically.
const mul = (a, b) => a.map((row, i) => b[0].map((_, j) => row.reduce((acc, _v, k) => acc + a[i][k] * b[k][j], 0)))
const T = (x, y, z = 0) => [[1, 0, 0, x], [0, 1, 0, y], [0, 0, 1, z], [0, 0, 0, 1]]
const P = d => [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, -1 / d, 1]]
const RY = deg => { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [[c, 0, s, 0], [0, 1, 0, 0], [-s, 0, c, 0], [0, 0, 0, 1]] }
const project = (m, p) => { const v = mul(m, [[p[0]], [p[1]], [p[2]], [1]]).map(r => r[0]); return [v[0] / v[3], v[1] / v[3]] }

test('cardTransform needs no 3D context: it projects exactly like a parent perspective with that origin', () => {
  const pose = { x: -164, y: -266, z: -312, rotateX: 0, rotateY: 16, scale: 1 }
  const cam = { perspective: 640, ox: 0, oy: -13.3 }
  const css = cardTransform(pose, cam)
  assert.match(css, /^translate3d\(0\.0px, -13\.3px, 0px\) perspective\(640px\) translate3d\(-164\.0px, -252\.7px, -312\.0px\) rotateX\(0deg\) rotateY\(16deg\) scale\(1\.0000\)$/)
  assert.ok(!/var\(|calc\(/.test(css), 'no var()/calc() for iOS to drop')
  // Old: parent perspective about origin o; card transform about its centre (o - offset).
  const o = [cam.ox, cam.oy]
  const parent = mul(mul(mul(T(o[0], o[1]), P(640)), T(-o[0], -o[1])), mul(T(pose.x, pose.y, pose.z), RY(16)))
  const own = mul(mul(mul(T(o[0], o[1]), P(640)), T(pose.x - o[0], pose.y - o[1], pose.z)), RY(16))
  for (const pt of [[-74, -74, 0], [74, -74, 0], [74, 74, 0], [-74, 74, 0]]) {
    const a = project(parent, pt), b = project(own, pt)
    assert.ok(Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9)
  }
  // Tilt really survives: the far edge of a rotated card is shorter than the near edge.
  const near = project(own, [74, -74, 0]), near2 = project(own, [74, 74, 0])
  const far = project(own, [-74, -74, 0]), far2 = project(own, [-74, 74, 0])
  assert.notEqual(Math.round(Math.abs(near2[1] - near[1])), Math.round(Math.abs(far2[1] - far[1])))
  assert.equal(cardTransform({ x: 1, y: 2, z: 3 }, { perspective: 900 }).startsWith('perspective(900px) '), true)
})

test('lite and portrait layouts keep the tilt in the per-card transform', () => {
  for (const [w, h, q] of [[390, 664, 'lite'], [390, 664, 'full'], [1280, 800, 'lite']]) {
    const layout = travelStageLayout(w, h, q)
    const tilted = Array.from({ length: 24 }, (_, i) => cardPose(i, 24, 0.42, false, layout)).filter(p => p.opacity > 0.01)
    assert.ok(tilted.some(p => (p.rotateX || 0) !== 0 || (p.rotateY || 0) !== 0), `${w}x${h} ${q}`)
    assert.ok(tilted.every(p => /rotateY\(/.test(cardTransform(p, { perspective: layout.perspective }))))
  }
})

test('cardDepthIndex paints far rings under near rings and only changes a few times per ring', () => {
  const layout = travelStageLayout(390, 664, 'full')
  let last = 0, changes = 0
  for (let z = layout.zMin; z < layout.zMin + layout.spacing * 4; z += 5) {
    const zi = cardDepthIndex(z, layout)
    assert.ok(zi >= last)
    if (zi !== last) changes += 1
    last = zi
  }
  assert.ok(changes <= 9)
  assert.ok(cardDepthIndex(layout.zMin + layout.spacing, layout) > cardDepthIndex(layout.zMin, layout))
  assert.ok(cardDepthIndex(-1e6, layout) >= 1)
})


// Evaluate WAAPI keyframes the way a browser does: find the segment, apply its
// cubic-bezier easing, interpolate numbers inside translate3d / opacity.
function bezierY(easing, x) {
  if (easing === 'linear') return x
  const [x1, y1, x2, y2] = easing.match(/-?[\d.]+/g).map(Number)
  let lo = 0, hi = 1
  for (let k = 0; k < 60; k++) {
    const s = (lo + hi) / 2
    const bx = 3 * (1 - s) ** 2 * s * x1 + 3 * (1 - s) * s * s * x2 + s ** 3
    if (bx < x) lo = s; else hi = s
  }
  const s = (lo + hi) / 2
  return 3 * (1 - s) ** 2 * s * y1 + 3 * (1 - s) * s * s * y2 + s ** 3
}
const zOf = transform => Number(transform.match(/translate3d\([^)]*?,[^)]*?,\s*(-?[\d.]+)px\)\s*rotateX/)[1])
function sample(frames, u, key) {
  let k = 0
  while (k < frames.length - 2 && frames[k + 1].offset <= u) k++
  const a = frames[k], b = frames[k + 1]
  if (b.offset - a.offset < 1e-12) return key(b)
  const y = bezierY(a.easing, (u - a.offset) / (b.offset - a.offset))
  return key(a) + (key(b) - key(a)) * y
}

test('compositor keyframes reproduce cardPose depth, opacity and shade through the whole flight', () => {
  for (const [w, h] of [[390, 664], [1280, 800]]) {
    for (const reverse of [false, true]) {
      const layout = travelStageLayout(w, h, 'full')
      const n = layout.tiles
      let worstZ = 0, worstO = 0, worstS = 0
      for (const i of [0, 7, 21, 45, n - 1]) {
        const { card, shade } = cardKeyframes(i, n, layout, { perspective: layout.perspective }, { reverse })
        assert.equal(card[0].offset, 0); assert.equal(card.at(-1).offset, 1)
        assert.ok(card.length < 40, `few keyframes (${card.length})`)
        for (let k = 1; k < card.length; k++) assert.ok(card[k].offset >= card[k - 1].offset)
        for (let u = 0.0005; u < 1; u += 0.0037) {
          const want = cardPose(i, n, travelProgress(u, reverse) * (reverse ? -1 : 1) + (reverse ? 1 : 0), reverse, layout)
          const z = sample(card, u, f => zOf(f.transform))
          // Skip the instant of a wrap, where both ends are correct values.
          if (Math.abs(z - want.z) > 700) continue
          worstZ = Math.max(worstZ, Math.abs(z - want.z))
          worstO = Math.max(worstO, Math.abs(sample(card, u, f => f.opacity) - want.opacity))
          worstS = Math.max(worstS, Math.abs(sample(shade, u, f => f.opacity) - (1 - want.brightness)))
        }
      }
      assert.ok(worstZ < 2.5, `${w}x${h} reverse=${reverse}: z off by ${worstZ.toFixed(2)}px`)
      assert.ok(worstO < 0.02, `opacity off by ${worstO}`)
      assert.ok(worstS < 0.01, `shade off by ${worstS}`)
    }
  }
})

test('ringDepthIndex only changes when a ring wraps, and nearer rings always paint on top', () => {
  const layout = travelStageLayout(390, 664, 'full')
  const rings = layout.rings
  let changes = 0, prev = null
  for (let p = 0; p <= 1; p += 0.0005) {
    const idx = Array.from({ length: rings }, (_, r) => ringDepthIndex(r, p, layout))
    const zs = Array.from({ length: rings }, (_, r) => cardPose(r * 20, layout.tiles, p, false, layout).z)
    for (let a = 0; a < rings; a++) for (let b = 0; b < rings; b++) if (zs[a] > zs[b] + 1) assert.ok(idx[a] > idx[b])
    assert.ok(idx.every(v => v >= 1))
    if (prev) changes += idx.filter((v, r) => v !== prev[r]).length
    prev = idx
  }
  assert.ok(changes <= Math.ceil(rings * 2.25) + rings, `z-index writes per flight: ${changes}`)
  assert.deepEqual(depthLook(layout.zMin, layout), { opacity: 0.28, brightness: 0.2 })
})
