import test from 'node:test'
import assert from 'node:assert/strict'
import { easeOut, easeTravel, lerp, clockParts, formatClock, pickTravelCovers, fillTravelWall, cardPose, heroPose, TRAVEL_MAX_COVERS } from '../web/travel.js'

test('easeOut stays in range and slows near the end', () => {
  assert.equal(easeOut(0), 0)
  assert.equal(easeOut(1), 1)
  assert.ok(easeOut(0.5) > 0.5)
  assert.ok(easeOut(1.4) === 1)
})

test('easeTravel accelerates then decelerates', () => {
  assert.equal(easeTravel(0), 0)
  assert.equal(easeTravel(1), 1)
  assert.ok(Math.abs(easeTravel(0.5) - 0.5) < 1e-9)
  const early = easeTravel(0.2) - easeTravel(0)
  const mid = easeTravel(0.6) - easeTravel(0.4)
  const late = easeTravel(1) - easeTravel(0.8)
  assert.ok(mid > early, 'should be faster in the middle than at the start')
  assert.ok(mid > late, 'should be faster in the middle than at the end')
})

test('clock parts and lerp walk backward through a date', () => {
  const from = Date.parse('2026-11-08T04:00:00+09:00')
  const to = Date.parse('2025-04-13T08:02:00+09:00')
  const mid = lerp(from, to, 0.5)
  assert.ok(mid < from && mid > to)
  const parts = clockParts(to)
  assert.equal(parts.y, 2025)
  assert.equal(parts.m, 4)
  assert.equal(parts.d, 13)
  assert.equal(formatClock(parts), '2025.04.13')
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
})

test('card poses sit on opposite walls and rush toward the camera', () => {
  const project = pose => pose.x * 1000 / (1000 - Math.min(pose.z, 920))
  const left = cardPose(0, 10, 0)
  const right = cardPose(1, 10, 0)
  assert.ok(left.x * right.x < 0)
  assert.ok(Math.abs(left.x) > 200)
  const later = cardPose(0, 10, 1)
  assert.ok(later.z > left.z)
  assert.ok(later.opacity <= left.opacity || later.z < 260)
  const far = cardPose(0, 10, 0)
  const midNear = cardPose(4, 10, 0.5)
  assert.ok(Math.abs(project(far)) > 220, 'far covers stay outside the date')
  assert.ok(Math.abs(project(far)) < Math.abs(project(midNear)), 'near covers swing wider')
  assert.ok(far.brightness < midNear.brightness)
  assert.ok(far.blur >= midNear.blur)
})

test('hero cover stays hidden until late, then grows out of the vanishing point', () => {
  const early = heroPose(0.3)
  const late = heroPose(1)
  assert.equal(early.opacity, 0)
  assert.ok(late.opacity === 1)
  assert.ok(late.z > early.z)
  assert.ok(late.scale > early.scale)
})
