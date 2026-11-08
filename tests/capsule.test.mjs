import test from 'node:test'
import assert from 'node:assert/strict'
import { localYmd, yearsAgoLabel, monthDayDistance, onThisDay, nearestDay, capsuleToday, neighbors, randomMoment, sinceLabel } from '../web/capsule.js'

const ev = (id, iso, extra = {}) => {
  const first_listen_ms = Date.parse(iso)
  const d = new Date(first_listen_ms)
  return {
    song_id: String(id), name: extra.name || `song-${id}`, artists: extra.artists || 'artist',
    first_listen_ms, date: extra.date || `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    time: extra.time || `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    ...extra
  }
}

test('onThisDay matches previous years on the same local month and day', () => {
  const now = new Date(2026, 10, 8, 13, 0, 0) // 8 Nov 2026 local
  const hit = ev(1, new Date(2024, 10, 8, 22, 3).toISOString())
  const sameYear = ev(2, new Date(2026, 10, 8, 9, 0).toISOString())
  const otherDay = ev(3, new Date(2024, 10, 7, 22, 3).toISOString())
  const hits = onThisDay([hit, sameYear, otherDay], now)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].event.song_id, '1')
  assert.equal(hits[0].yearsAgo, 2)
  assert.equal(yearsAgoLabel(1), '去年')
  assert.equal(yearsAgoLabel(2), '2 年前')
})

test('onThisDay uses the local calendar, not the archive Shanghai date string', () => {
  // 7 Nov 2023 23:30 in Shanghai is 8 Nov 00:30 in Tokyo (UTC+9) and 7 Nov 15:30 UTC.
  const ms = Date.parse('2023-11-07T23:30:00+08:00')
  const event = ev(1, new Date(ms).toISOString(), { date: '2023-11-07', name: 'Late' })
  event.first_listen_ms = ms
  const local = new Date(ms)
  const nowLocal = new Date(local.getFullYear() + 1, local.getMonth(), local.getDate(), 12, 0, 0)
  const hits = onThisDay([event], nowLocal)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].yearsAgo, 1)
  const shanghai = new Date(ms + 8 * 3600000)
  const sh = { y: shanghai.getUTCFullYear(), m: shanghai.getUTCMonth() + 1, d: shanghai.getUTCDate() }
  const loc = localYmd(ms)
  if (sh.d !== loc.d) {
    const nowShanghaiDate = new Date(sh.y + 1, sh.m - 1, sh.d, 12, 0, 0)
    assert.equal(onThisDay([event], nowShanghaiDate).length, 0)
  }
})

test('29 February only matches other leap days, and is the nearest neighbour of 28 Feb', () => {
  const leap = ev(1, new Date(2020, 1, 29, 12, 0).toISOString(), { name: 'Leap' })
  const feb28 = ev(2, new Date(2023, 1, 28, 12, 0).toISOString(), { name: 'Eve' })
  const mar1 = ev(3, new Date(2021, 2, 1, 12, 0).toISOString(), { name: 'Mar' })
  assert.equal(onThisDay([leap, feb28, mar1], new Date(2024, 1, 29, 10, 0)).map(x => x.event.song_id).join(), '1')
  assert.equal(onThisDay([leap, feb28, mar1], new Date(2025, 1, 28, 10, 0)).map(x => x.event.song_id).join(), '2')
  assert.equal(onThisDay([leap], new Date(2025, 1, 28, 10, 0)).length, 0)
  assert.equal(monthDayDistance({ m: 2, d: 28 }, { m: 2, d: 29 }), 1)
  assert.equal(monthDayDistance({ m: 2, d: 29 }, { m: 3, d: 1 }), 1)
  const empty = capsuleToday([leap, mar1], new Date(2025, 1, 28, 10, 0))
  assert.equal(empty.kind, 'empty')
  assert.ok(empty.nearest)
  assert.equal(empty.nearest.dist, 1)
  assert.ok([29, 1].includes(empty.nearest.d))
})

test('empty today suggests the nearest month-day and random can re-roll', () => {
  const a = ev(1, new Date(2024, 3, 5, 8, 0).toISOString())
  const b = ev(2, new Date(2024, 3, 12, 8, 0).toISOString())
  const c = ev(3, new Date(2025, 6, 2, 8, 0).toISOString())
  const now = new Date(2026, 10, 8, 12, 0)
  const empty = capsuleToday([a, b, c], now)
  assert.equal(empty.kind, 'empty')
  assert.equal(empty.songs.length, 0)
  assert.ok(empty.nearest.dist > 0)
  const picked = new Set([randomMoment([a, b, c], () => 0).song_id, randomMoment([a, b, c], () => 0.99).song_id])
  assert.ok(picked.size >= 1)
  const reroll = randomMoment([a, b, c], () => 0, a.song_id)
  assert.notEqual(reroll.song_id, a.song_id)
  assert.equal(randomMoment([], () => 0), null)
})

test('neighbors stay inside the window around a first-listen moment', () => {
  const mid = ev(2, new Date(2024, 3, 5, 12, 0).toISOString())
  const near = ev(1, new Date(2024, 3, 6, 12, 0).toISOString())
  const far = ev(3, new Date(2024, 3, 20, 12, 0).toISOString())
  const around = neighbors([near, mid, far], mid, { days: 3, limit: 4 })
  assert.deepEqual(around.map(e => e.song_id), ['1'])
})

test('sinceLabel names the gap in years and months', () => {
  const now = new Date(2026, 10, 8, 13, 0, 0)
  assert.equal(sinceLabel(new Date(2025, 3, 13, 8, 2), now), '1 年 6 个月前')
  assert.equal(sinceLabel(new Date(2025, 10, 8, 8, 0), now), '1 年前')
  assert.equal(sinceLabel(new Date(2026, 9, 8, 8, 0), now), '1 个月前')
  assert.equal(sinceLabel(new Date(2026, 10, 7, 13, 0), now), '昨天')
  assert.equal(sinceLabel(now, now), '今天')
  assert.equal(sinceLabel(new Date(2024, 10, 8, 12, 0), now), '2 年前')
  assert.equal(sinceLabel(new Date(2027, 0, 1), now), '')
})
