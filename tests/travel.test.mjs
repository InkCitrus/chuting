import test from 'node:test'
import assert from 'node:assert/strict'
import { easeOut, easeTravel, lerp, clockParts, formatClock, formatTravelMeta, travelFx, pickTravelCovers, fillTravelWall, cardPose, heroPose, tileLayout, TRAVEL_MAX_COVERS, TRAVEL_TILES, TRAVEL_MS, TRAVEL_RINGS } from '../web/travel.js'

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

test('pickTravelCovers prefers covers along the travelled span and caps at 48', () => {
  assert.equal(TRAVEL_MAX_COVERS, 48)
  const targetMs = Date.parse('2024-03-01T00:00:00+09:00')
  const target = { song_id: 't', cover: 'ct', first_listen_ms: targetMs, name: 'T' }
  const along = Array.from({ length: 20 }, (_, i) => ({
    song_id: `a${i}`,
    cover: `along-${i}`,
    first_listen_ms: targetMs + (i + 1) * 30 * 86400000
  }))
  const far = Array.from({ length: 20 }, (_, i) => ({
    song_id: `f${i}`,
    cover: `far-${i}`,
    first_listen_ms: Date.parse('2016-01-01T00:00:00+09:00') + i * 86400000
  }))
  const covers = pickTravelCovers([...far, ...along, target], target, 10)
  assert.ok(covers.length <= 10)
  assert.equal(covers.at(-1).song_id, 't')
  const rest = covers.slice(0, -1)
  const alongCount = rest.filter(e => String(e.cover).startsWith('along-')).length
  assert.ok(alongCount >= 8, `expected most picks from the travelled span, got ${alongCount}`)
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
