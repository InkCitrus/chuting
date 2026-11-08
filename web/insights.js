// Highlight facts for the hero carousel. Pure functions over first-listen events (sorted oldest first).
// Only facts the data supports are returned. NetEase gives a cumulative play count per song and the one
// day it was played most; it does not give every play's time, so "afternoon" and "late night" are about
// when a song was FIRST heard, ranked by its cumulative plays — and are labelled that way.
const n = value => (value || 0).toLocaleString('zh-CN')
const ymd = date => date.split('-').map(Number)
const dayLabel = (date, year = false) => { const [y, m, d] = ymd(date); return `${year ? `${y} 年 ` : ''}${m} 月 ${d} 日` }
const shanghaiDate = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 10)
const hour = e => Number(e.time.slice(0, 2))
// Shared with the share poster so "listened most" and "met most" stay one definition.
export const playCount = e => (Number.isFinite(e.play_count) && e.play_count > 0 ? e.play_count : 0)
export const leadArtist = e => (e.artists || '').split(' / ')[0] || ''
const plays = playCount
export function artistRanks(events) {
  const artists = new Map()
  for (const e of events) {
    const a = leadArtist(e)
    if (a) (artists.get(a) || artists.set(a, []).get(a)).push(e)
  }
  return [...artists].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
}
const nextDay = date => { const [y, m, d] = ymd(date); return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10) }
const covers = list => [...new Map(list.filter(e => e.cover).map(e => [e.cover, e])).values()].slice(0, 4)

export function insights(events) {
  if (!events.length) return []
  const used = new Set(), out = []
  const best = (list, score) => {
    let top = null, topScore = -Infinity
    for (const e of list) { if (used.has(e.song_id)) continue; const s = score(e); if (s > topScore) { top = e; topScore = s } }
    return top && topScore > 0 ? top : null
  }
  const song = (id, kicker, event, line) => { used.add(event.song_id); out.push({ id, kicker, kind: 'song', event, title: event.name, meta: event.artists || '歌手未知', line, cover: event.cover }) }
  const counted = events.some(plays)

  const first = events[0]
  song('earliest', '最早的一首', first, `${dayLabel(first.date, true)} ${first.time} · 一切从这里开始`)

  if (counted) {
    const top = best(events, plays)
    if (top) song('most-played', '听得最多的歌', top, `听了 ${n(top.play_count)} 遍 · ${dayLabel(top.date, true)}初遇`)
    const afternoon = best(events.filter(e => hour(e) >= 12 && hour(e) < 18), plays)
    if (afternoon) song('afternoon', '午后遇见，后来最常听', afternoon, `下午 ${afternoon.time} 初遇 · 后来听了 ${n(afternoon.play_count)} 遍`)
    const night = best(events.filter(e => hour(e) < 5), plays)
    if (night) song('late-night', '深夜遇见，后来最常听', night, `凌晨 ${night.time} 初遇 · 后来听了 ${n(night.play_count)} 遍`)
  } else {
    const night = best(events.filter(e => hour(e) < 5), e => 1 + (hour(e) * 60 + Number(e.time.slice(3))) / 1e4)
    if (night) song('late-night', '深夜遇见的一首', night, `凌晨 ${night.time}，第一次响起`)
  }

  const peak = best(events.filter(e => e.peak_count >= 3), e => e.peak_count)
  if (peak) song('peak', '单曲循环最狠的一天', peak, `${peak.peak_ms ? dayLabel(shanghaiDate(peak.peak_ms), true) : '有一天'}，这首听了 ${n(peak.peak_count)} 遍`)

  const [artist, songs] = artistRanks(events)[0] || []
  if (songs?.length >= 3) out.push({ id: 'artist', kicker: '遇见最多的歌手', kind: 'artist', title: artist, meta: `${n(songs.length)} 首初听`,
    line: `第一首是《${songs[0].name}》，${dayLabel(songs[0].date, true)}`, covers: covers([...songs].reverse()), query: artist })

  const days = new Map()
  for (const e of events) (days.get(e.date) || days.set(e.date, []).get(e.date)).push(e)
  const dates = [...days.keys()].sort()
  let run = { from: dates[0], to: dates[0], len: 1 }, longest = run
  for (let i = 1; i < dates.length; i++) {
    run = dates[i] === nextDay(dates[i - 1]) ? { ...run, to: dates[i], len: run.len + 1 } : { from: dates[i], to: dates[i], len: 1 }
    if (run.len > longest.len) longest = run
  }
  if (longest.len >= 3) {
    const inRun = dates.filter(d => d >= longest.from && d <= longest.to).flatMap(d => days.get(d))
    out.push({ id: 'streak', kicker: '最长连续', kind: 'range', title: `连续 ${longest.len} 天`, meta: `${dayLabel(longest.from, true)} – ${dayLabel(longest.to, longest.from.slice(0, 4) !== longest.to.slice(0, 4))}`,
      line: `每天都有新歌，一共遇见 ${n(inRun.length)} 首`, covers: covers(inRun), month: longest.from.slice(0, 7) })
  }
  const [busyDay, busy] = [...days].sort((a, b) => b[1].length - a[1].length || b[0].localeCompare(a[0]))[0]
  if (busy.length >= 3) out.push({ id: 'busiest', kicker: '最热闹的一天', kind: 'range', title: dayLabel(busyDay, true), meta: `一天遇见 ${n(busy.length)} 首`,
    line: `从《${busy[0].name}》到《${busy.at(-1).name}》`, covers: covers(busy), month: busyDay.slice(0, 7) })

  const latest = events.at(-1)
  if (!used.has(latest.song_id) || out.length < 2) song('latest', '最近一次初听', latest, `${dayLabel(latest.date, true)} ${latest.time}`)
  return out
}
