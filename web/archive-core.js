export const SOURCE = '/music/first/listen/info'
export const DAY = 86400000
export const validId = value => /^[1-9]\d{0,17}$/.test(String(value))
export function timestamp(value, now = Date.now()) {
  if (typeof value === 'boolean' || !/^\d+$/.test(String(value))) throw new Error('初听时间格式异常')
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 946684800000 || n > now + DAY) throw new Error('初听时间的单位或范围异常')
  return n
}
export function parseFirst(body, songId, now = Date.now()) {
  if (body.code !== 200) throw new Error('接口没有返回成功状态')
  const data = body.data || {}, info = data.songInfoDto || {}, first = data.musicFirstListenDto || {}
  if (info.songId != null && String(info.songId) !== String(songId)) throw new Error('接口返回的歌曲 ID 不一致')
  if ([null, undefined, 0, '0', ''].includes(first.listenTime)) return null
  return { first_listen_ms: timestamp(first.listenTime, now), source: SOURCE, captured_ms: now,
    upstream_date: first.date || null, name: info.songName || '', artists: info.singer || '',
    play_count: data.musicTotalPlayDto?.playCount ?? null }
}
export function metadata(song) {
  const id = song?.songId ?? song?.id
  if (!validId(id)) return null
  const artists = song.ar || song.artists || []
  return { id: String(id), name: song.songName || song.name || '',
    artists: typeof artists === 'string' ? artists : artists.map(a => a.name || a.artistName || '').filter(Boolean).join(' / ') || song.artistName || song.artistNameList || '',
    album: (song.al || song.album)?.name || song.albumName || '' }
}
// Only explicit song objects are accepted: never recurse arbitrary `id` fields.
export function reportSongs(value) {
  const songs = new Map()
  function walk(x) {
    if (!x || typeof x !== 'object') return
    if (validId(x.songId)) { const s = metadata(x); if (s) songs.set(s.id, { ...songs.get(s.id), ...s }) }
    for (const child of Object.values(x)) if (child && typeof child === 'object') walk(child)
  }
  walk(value)
  return [...songs.values()]
}
export function mergeResult(song, parsed, body, now = Date.now()) {
  song.attempts = (song.attempts || 0) + 1
  song.last_attempt_ms = now
  song.error = null
  song.raw = body
  song.observations ||= []
  if (parsed) {
    if (!song.first_listen_ms) Object.assign(song, { first_listen_ms: parsed.first_listen_ms, captured_ms: parsed.captured_ms, source: SOURCE })
    if (!song.observations.some(o => o.first_listen_ms === parsed.first_listen_ms)) song.observations.push(parsed)
    if (parsed.name) song.name = parsed.name
    if (parsed.artists) song.artists = parsed.artists
    if (parsed.play_count != null) song.play_count = parsed.play_count
  }
  song.status = song.observations.length > 1 ? 'conflict' : song.first_listen_ms ? 'available' : 'empty'
  return song
}
export function needsQuery(song, retryEmpty = false, now = Date.now()) {
  if (song.first_listen_ms) return false
  return song.status !== 'empty' || retryEmpty || now - (song.last_attempt_ms || 0) >= 30 * DAY
}
export function eventFromSong(song) {
  const { raw, id, ...event } = song
  const iso = new Date(song.first_listen_ms + 8 * 3600000).toISOString()
  return { ...event, song_id: id, date: iso.slice(0, 10), time: iso.slice(11, 16),
    timestamp_local: iso.slice(0, -1) + '+08:00', timezone: 'Asia/Shanghai', kind: 'first_listen',
    source: song.source || SOURCE, observations: song.observations || [] }
}
export function archiveStatus(songs) {
  const events = songs.filter(s => s.first_listen_ms).map(eventFromSong).sort((a, b) => a.first_listen_ms - b.first_listen_ms || a.song_id.localeCompare(b.song_id))
  const sourceCounts = new Map()
  for (const s of songs) for (const source of s.sources || []) sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1)
  return { events,
    stats: { discovered: songs.length, queried: songs.filter(s => s.attempts || s.first_listen_ms || s.status === 'empty').length,
      available: events.length, pending: songs.filter(s => ['pending', 'failed'].includes(s.status)).length,
      empty: songs.filter(s => s.status === 'empty').length, failed: songs.filter(s => s.status === 'failed').length,
      conflicts: songs.filter(s => s.observations?.length > 1).length,
      sources: [...sourceCounts].map(([source, count]) => ({ source, count })) },
    calendar: { months: [...new Set(events.map(e => e.date.slice(0, 7)))], days: new Set(events.map(e => e.date)).size,
      earliest: events[0]?.date, latest: events.at(-1)?.date } }
}
export function monthEnds(fromYear, now = new Date()) {
  const end = new Date(now.getTime() + 8 * 3600000)
  const output = []
  for (let y = fromYear; y <= end.getUTCFullYear(); y++) for (let m = 0; m < 12; m++) {
    if (y === end.getUTCFullYear() && m > end.getUTCMonth()) break
    const current = y === end.getUTCFullYear() && m === end.getUTCMonth()
    output.push({ key: `${y}-${String(m + 1).padStart(2, '0')}`, endTime: current ? now.getTime() : Date.UTC(y, m + 1, 0) - 8 * 3600000, current })
  }
  return output.reverse()
}
export function csv(events) {
  const columns = ['song_id', 'name', 'artists', 'date', 'time', 'first_listen_ms', 'timestamp_local', 'timezone', 'kind', 'play_count', 'status', 'source']
  const cell = value => { let s = String(value ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"', '""') + '"' }
  return '\uFEFF' + [columns.join(','), ...events.map(e => columns.map(k => cell(e[k])).join(','))].join('\r\n')
}
