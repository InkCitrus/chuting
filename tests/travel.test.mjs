import test from 'node:test'
import assert from 'node:assert/strict'
import { easeOut, lerp, clockParts, formatClock, pickTravelCovers, fillTravelWall, cardPose, TRAVEL_MAX_COVERS } from '../web/travel.js'

test('easeOut stays in range and slows near the end', () => {
  assert.equal(easeOut(0), 0)
  assert.equal(easeOut(1), 1)
  assert.ok(easeOut(0.5) > 0.5)
  assert.ok(easeOut(1.4) === 1)
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

test('card poses move toward the camera, grow, and fade when too close', () => {
  const start = cardPose(0, 12, 0)
  const end = cardPose(0, 12, 1)
  assert.ok(end.z > start.z)
  assert.ok(end.scale >= start.scale)
  assert.ok(end.opacity <= start.opacity || end.z < 260)
})
