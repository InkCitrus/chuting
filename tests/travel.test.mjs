import test from 'node:test'
import assert from 'node:assert/strict'
import { easeOut, lerp, clockParts, formatClock, pickTravelCovers, cardPose, TRAVEL_MAX_COVERS } from '../web/travel.js'

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
  assert.equal(new Set(covers.map(e => e.cover || `id:${e.song_id}`)).size, covers.length)
})

test('card poses move toward the camera and fade when too close', () => {
  const start = cardPose(0, 12, 0)
  const end = cardPose(0, 12, 1)
  assert.ok(end.z > start.z)
  assert.ok(end.opacity <= start.opacity || end.z < 260)
})
