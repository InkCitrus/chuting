import test from 'node:test'
import assert from 'node:assert/strict'
import { insights } from '../web/insights.js'
import { canSharePoster, renderPoster, sharePayload, shareMethod, shareData, coverKey, wallGrid } from '../web/share.js'

const SECRET = {
  uid: '918273645501',
  nickname: 'leak-nick-QingTian',
  avatar: 'https://p3.music.126.net/avatar/leak-avatar-9f3a.jpg',
  musicU: 'leak-music-u-9f3a',
  cookie: 'MUSIC_U=leak-music-u-9f3a; os=pc',
  session: 'leak-session-9f3a',
  raw: 'leak-raw-body-9f3a',
}
const FORBIDDEN_KEYS = ['uid', 'nickname', 'avatar', 'avatarUrl', 'cookie', 'cookies', 'MUSIC_U', 'chuting_session', 'raw', 'error', 'account', 'header', 'observations']

function dirty(event) {
  return {
    ...event,
    uid: SECRET.uid,
    nickname: SECRET.nickname,
    avatar: SECRET.avatar,
    avatarUrl: SECRET.avatar,
    cookie: SECRET.cookie,
    cookies: SECRET.cookie,
    MUSIC_U: SECRET.musicU,
    chuting_session: SECRET.session,
    error: SECRET.raw,
    header: { MUSIC_U: SECRET.musicU, cookie: SECRET.cookie },
    raw: { code: 200, cookie: SECRET.cookie, data: { secret: SECRET.raw, profile: { nickname: SECRET.nickname, avatarUrl: SECRET.avatar } } },
    observations: [{ first_listen_ms: 1, raw: SECRET.raw, cookie: SECRET.cookie }],
  }
}
function keys(value, found = []) {
  if (!value || typeof value !== 'object') return found
  for (const [key, child] of Object.entries(value)) {
    found.push(key)
    keys(child, found)
  }
  return found
}
function assertWall(poster) {
  assert.ok(poster.wall.length >= 1)
  assert.ok(poster.wall.length <= 66)
  assert.equal(poster.wall.filter(slot => slot.first).length, 1)
  assert.equal(poster.wall[0].first, true)
  if (poster.first.cover) assert.equal(coverKey(poster.wall[0].cover), coverKey(poster.first.cover))
  const keys = poster.wall.map(slot => slot.cover).filter(Boolean).map(coverKey)
  assert.equal(new Set(keys).size, keys.length, 'duplicate cover on the wall')
  assert.ok(Number.isInteger(poster.wallCols) && poster.wallCols >= 1 && poster.wallCols <= 6)
}

function assertPrivate(payload) {
  const blob = JSON.stringify(payload)
  for (const secret of Object.values(SECRET)) assert.equal(blob.includes(secret), false, secret)
  for (const key of keys(payload)) assert.equal(FORBIDDEN_KEYS.includes(key), false, key)
  for (const slot of payload.poster.wall) {
    assert.equal(slot.cover === '' || /^https:\/\/p\d{1,2}\.music\.126\.net\/[\w\-=./]+$/.test(slot.cover), true, slot.cover)
  }
}

const cjk = '晴天过后的很长很长的歌名一直继续'.repeat(3)
const japanese = '夜に駆ける'.repeat(8)
const english = 'A Very Long English Title That Should Wrap Or Shrink On The Admission Ticket'

test('share payload keeps poster facts and drops account, cookie, session, and raw fields', () => {
  const archive = {
    account: { uid: SECRET.uid, nickname: SECRET.nickname, avatarUrl: SECRET.avatar },
    cookie: SECRET.cookie,
    cookies: { MUSIC_U: SECRET.musicU },
    MUSIC_U: SECRET.musicU,
    chuting_session: SECRET.session,
    events: [
      dirty({ song_id: '1001', name: '晴天', artists: '周杰伦', album: '叶惠美', date: '2024-01-02', time: '02:10', play_count: 9, cover: 'https://p1.music.126.net/ok/qing.jpg' }),
      dirty({ song_id: '1002', name: japanese, artists: 'YOASOBI', album: '夜に駆ける', date: '2024-03-15', time: '13:40', play_count: 260, cover: 'http://p2.music.126.net/ok/yoa.jpg?param=40y40' }),
      dirty({ song_id: '1003', name: english, artists: '', album: '', date: '2024-05-01', time: '08:15', play_count: 1, cover: 'https://evil.example/p1.music.126.net/x.jpg' }),
      dirty({ song_id: '1004', name: '七里香', artists: '周杰伦 / 嘉宾', album: '七里香', date: '2024-06-01', time: '22:01', play_count: 4, cover: 'javascript:alert(1)' }),
      dirty({ song_id: '1005', name: '搁浅', artists: '周杰伦', album: '七里香', date: '2024-06-02', time: '22:05', play_count: 3, cover: '' }),
      dirty({ song_id: '1006', name: '借口', artists: '周杰伦', album: '七里香', date: '2024-06-03', time: '22:12', play_count: 2, cover: 'https://p1.music.126.net/ok/a.jpg' }),
      dirty({ song_id: '1007', name: '园游会', artists: '周杰伦', album: '七里香', date: '2024-06-04', time: '22:20', play_count: 2, cover: 'https://p1.music.126.net/ok/b.jpg' }),
      dirty({ song_id: '1008', name: '轨迹', artists: '周杰伦', album: '七里香', date: '2024-06-05', time: '22:30', play_count: 8, cover: 'https://p1.music.126.net/ok/met.jpg' }),
      dirty({ song_id: '1009', name: cjk, artists: '新歌手', album: '新专辑', date: '2026-11-04', time: '22:41', play_count: 6, cover: 'https://p4.music.126.net/ok/late.jpg' }),
    ].reverse(),
  }
  const payload = sharePayload(archive)
  assertPrivate(payload)
  const { poster, text } = payload
  assert.equal(poster.songs, 9)
  assert.equal(poster.artists, 4)
  assert.equal(poster.days, 9)
  assert.equal(poster.first.title, '晴天')
  assert.equal(poster.first.credit, '周杰伦 — 叶惠美')
  assert.equal(poster.first.date, '2024.01.02')
  assert.equal(poster.first.weekday, 'TUE')
  assert.equal(poster.first.time, '02:10')
  assert.equal(poster.first.cover, 'https://p1.music.126.net/ok/qing.jpg')
  assert.deepEqual(poster.stub, { number: '001', of: '009' })
  assert.equal(poster.mostPlayed.title, japanese)
  assert.equal(poster.mostPlayed.subtitle, 'YOASOBI')
  assert.equal(poster.mostPlayed.value, '260')
  assert.equal(poster.mostPlayed.unit, '次')
  assert.equal(poster.mostPlayed.cover, 'https://p2.music.126.net/ok/yoa.jpg')
  assert.equal(poster.mostMet.title, '周杰伦')
  assert.equal(poster.mostMet.subtitle, '初听 6 首')
  assert.equal(poster.mostMet.value, '6')
  assert.equal(poster.mostMet.cover, 'https://p1.music.126.net/ok/met.jpg')
  assert.equal(poster.latest.title, cjk)
  assert.equal(poster.latest.value, '11.04')
  assert.equal(poster.latest.unit, '22:41')
  assert.equal(poster.peakHour, 22)
  assert.equal(poster.peakLabel, '22:00 最多')
  assert.equal(poster.caption, '大多数新歌，都在晚上找到你')
  assert.equal(poster.hours.reduce((a, b) => a + b, 0), 9)
  assert.equal(poster.hours[22], 6)
  assert.equal(poster.rangeLabel, '初听 · 2024.01.02 — 2026.11.04')
  assert.equal(poster.site, 'chuting.inkorange.com')
  assert.equal(poster.mostPlayed.label, 'MOST PLAYED')
  assertWall(poster)
  assert.match(text, /晴天/)
  assert.match(text, /260 次/)
  assert.match(text, /chuting\.inkorange\.com/)
  assert.equal(text.includes(cjk), false)
  assert.equal(text.includes(SECRET.uid), false)
  assert.ok(text.length < 500)
})

test('the album wall skips blank sleeves and does not tile the same cover next to itself', () => {
  const payload = sharePayload({ events: [
    { song_id: '1', name: '甲', artists: '甲', date: '2024-01-01', time: '10:00', play_count: 1, cover: 'https://p1.music.126.net/ok/a.jpg' },
    { song_id: '2', name: '乙', artists: '乙', date: '2024-01-02', time: '11:00', play_count: 1, cover: '' },
    { song_id: '3', name: '丙', artists: '丙', date: '2024-01-03', time: '12:00', play_count: 1, cover: 'https://p1.music.126.net/ok/a.jpg' },
    { song_id: '4', name: '丁', artists: '丁', date: '2024-01-04', time: '13:00', play_count: 1, cover: 'https://p2.music.126.net/ok/b.jpg' },
    { song_id: '5', name: '戊', artists: '戊', date: '2024-01-05', time: '14:00', play_count: 1, cover: 'javascript:alert(1)' },
  ] })
  assertWall(payload.poster)
  const covers = payload.poster.wall.map(slot => slot.cover).filter(Boolean)
  assert.deepEqual([...new Set(covers)].sort(), ['https://p1.music.126.net/ok/a.jpg', 'https://p2.music.126.net/ok/b.jpg'])
  assert.equal(covers.length, 2)
})

test('coverKey treats CDN mirrors and size variants as one image', () => {
  const a = 'https://p1.music.126.net/abc/109951.jpg'
  const b = 'http://p2.music.126.net/abc/109951.jpg?param=140y140'
  const c = 'https://p3.music.126.net/abc/109951_140x140.jpg'
  assert.equal(coverKey(a), coverKey(b))
  assert.equal(coverKey(a), coverKey(c))
  assert.deepEqual(wallGrid(50), { cols: 5, rows: 10 })
})

test('the album wall dedupes by album id and does not repeat covers to fill the grid', () => {
  const payload = sharePayload({ events: [
    { song_id: '1', name: '甲', artists: '甲', album: '同专', album_id: '88', date: '2024-01-01', time: '10:00', cover: 'https://p1.music.126.net/ok/a.jpg' },
    { song_id: '2', name: '乙', artists: '甲', album: '同专', album_id: '88', date: '2024-01-02', time: '11:00', cover: 'https://p2.music.126.net/ok/a.jpg?param=500y500' },
    { song_id: '3', name: '丙', artists: '丙', album: '另一张', album_id: '99', date: '2024-01-03', time: '12:00', cover: 'https://p1.music.126.net/ok/b.jpg' },
    { song_id: '4', name: '丁', artists: '丁', album: '第三张', date: '2024-01-04', time: '13:00', cover: 'https://p1.music.126.net/ok/c_180y180.jpg' },
    { song_id: '5', name: '戊', artists: '丁', album: '第三张', date: '2024-01-05', time: '14:00', cover: 'https://p4.music.126.net/ok/c.jpg' },
  ] })
  const covers = payload.poster.wall.map(slot => slot.cover)
  assert.equal(covers.length, 3)
  assert.equal(new Set(covers.map(coverKey)).size, 3)
  assertWall(payload.poster)
})

test('a supplied artist portrait is kept on the most-met stub and the album cover remains as fallback', () => {
  const payload = sharePayload({ events: [
    { song_id: '1', name: '甲', artists: '周杰伦', date: '2024-01-01', time: '10:00', play_count: 1, cover: 'https://p1.music.126.net/ok/a.jpg' },
    { song_id: '2', name: '乙', artists: '周杰伦', date: '2024-01-02', time: '11:00', play_count: 1, cover: 'https://p1.music.126.net/ok/b.jpg' },
    { song_id: '3', name: '丙', artists: '周杰伦', date: '2024-01-03', time: '12:00', play_count: 1, cover: 'https://p1.music.126.net/ok/c.jpg' },
  ] }, { portrait: 'https://p1.music.126.net/ok/face.jpg?param=200y200' })
  assert.equal(payload.poster.mostMet.title, '周杰伦')
  assert.equal(payload.poster.mostMet.portrait, 'https://p1.music.126.net/ok/face.jpg')
  assert.equal(payload.poster.mostMet.cover, 'https://p1.music.126.net/ok/c.jpg')
  assert.equal(payload.poster.mostMet.face, undefined)
})

test('one song, a missing album, and a missing cover still make a poster', () => {
  const payload = sharePayload({ events: [{ song_id: '42', name: '只这一首', artists: '某人', date: '2025-04-05', time: '22:03', play_count: 3 }] })
  const { poster, text } = payload
  assert.equal(poster.songs, 1)
  assert.equal(poster.artists, 1)
  assert.equal(poster.days, 1)
  assert.equal(poster.first.album, '')
  assert.equal(poster.first.credit, '某人')
  assert.equal(poster.first.cover, '')
  assert.equal(poster.first.weekday, 'SAT')
  assert.deepEqual(poster.stub, { number: '001', of: '001' })
  assert.equal(poster.mostPlayed.title, '只这一首')
  assert.equal(poster.mostPlayed.value, '3')
  assert.equal(poster.mostMet.title, '某人')
  assert.equal(poster.mostMet.value, '1')
  assert.equal(poster.latest.title, '只这一首')
  assert.equal(poster.latest.value, '04.05')
  assert.equal(poster.caption, '大多数新歌，都在晚上找到你')
  assert.equal(poster.rangeLabel, '初听 · 2025.04.05')
  assert.ok(poster.wall.every(slot => slot.cover === ''))
  assert.equal(text.includes('最近一首'), false)
  assert.match(text, /只这一首/)
  assert.match(text, /1 首歌，1 位歌手，1 个日子/)
})

test('long CJK, Japanese, and English titles stay on the poster and are shortened in the summary', () => {
  const payload = sharePayload({ events: [
    { song_id: '1', name: cjk, artists: '甲', album: '', date: '2020-01-01', time: '09:00', play_count: 1, cover: 'https://p1.music.126.net/ok/1.jpg' },
    { song_id: '2', name: japanese, artists: '乙', date: '2020-02-01', time: '15:00', play_count: 80 },
    { song_id: '3', name: english, artists: '丙', date: '2020-03-01', time: '23:10', play_count: 2 },
  ] })
  assert.equal(payload.poster.first.title, cjk)
  assert.equal(payload.poster.first.credit, '甲')
  assert.equal(payload.poster.mostPlayed.title, japanese)
  assert.equal(payload.poster.latest.title, english)
  assert.equal(payload.text.includes(cjk), false)
  assert.equal(payload.text.includes(japanese), false)
  assert.equal(payload.text.includes(english), false)
  assert.match(payload.text, /…/)
})

test('the poster uses the true play-count winner, including when the carousel features a different song', () => {
  const events = [
    { song_id: '1', name: '最早也最多', artists: '甲', date: '2022-01-01', time: '10:00', play_count: 100 },
    { song_id: '2', name: '第二', artists: '乙', date: '2022-01-02', time: '11:00', play_count: 40 },
  ]
  const payload = sharePayload({ events })
  assert.equal(payload.poster.mostPlayed.title, '最早也最多')
  assert.equal(insights(events).find(item => item.id === 'most-played').title, '第二')
  const tied = sharePayload({ events: [
    { song_id: '1', name: '先听到', artists: '甲', date: '2022-01-01', time: '10:00', play_count: 10 },
    { song_id: '2', name: '后听到', artists: '甲', date: '2022-01-02', time: '21:00', play_count: 10 },
    { song_id: '3', name: '也是早上', artists: '乙', date: '2022-01-03', time: '10:30', play_count: 1 },
    { song_id: '4', name: '也是晚上', artists: '乙', date: '2022-01-04', time: '21:30', play_count: 1 },
  ] })
  assert.equal(tied.poster.mostPlayed.title, '先听到')
  assert.equal(tied.poster.mostMet.value, '2')
  assert.equal(tied.poster.peakHour, 21)
  assert.equal(tied.poster.caption, '大多数新歌，都在晚上找到你')
})

test('captions follow the part of day where most first listens happen', () => {
  const at = (time, caption) => {
    const payload = sharePayload({ events: [
      { song_id: '1', name: '甲', artists: '甲', date: '2023-01-01', time, play_count: 1 },
      { song_id: '2', name: '乙', artists: '乙', date: '2023-01-02', time, play_count: 1 },
    ] })
    assert.equal(payload.poster.caption, caption, time)
  }
  at('03:10', '大多数新歌，都在凌晨找到你')
  at('08:00', '大多数新歌，都在早上找到你')
  at('14:20', '大多数新歌，都在午后找到你')
  at('19:05', '大多数新歌，都在傍晚找到你')
  at('23:40', '大多数新歌，都在晚上找到你')
})

test('malformed dates and non-NetEase covers cannot smuggle secrets into the poster', () => {
  const ms = Date.parse('2025-04-05T22:03:00+08:00')
  const payload = sharePayload({ songs: [{
    id: '77', name: '由毫秒来', artists: '甲', album: '乙',
    date: `not-a-date ${SECRET.nickname}`,
    time: `nope ${SECRET.session}`,
    first_listen_ms: ms,
    play_count: '12',
    cover: 'http://p1.music.126.net/z/from-song.jpg?param=120y120',
    uid: SECRET.uid,
    raw: SECRET.raw,
  }] })
  assertPrivate(payload)
  assert.equal(payload.poster.first.date, '2025.04.05')
  assert.equal(payload.poster.first.time, '22:03')
  assert.equal(payload.poster.first.weekday, 'SAT')
  assert.equal(payload.poster.mostPlayed.value, '12')
  assert.equal(payload.poster.first.cover, 'https://p1.music.126.net/z/from-song.jpg')
  assert.equal(sharePayload(null), null)
  assert.equal(sharePayload({ events: [] }), null)
  assert.equal(sharePayload({ events: [{ name: '没有日子' }], songs: [{ name: '不该用', date: '2020-01-01', time: '00:00' }] }), null)
})

test('rendering the poster stays in the browser and sharing needs a file-capable share sheet', async () => {
  await assert.rejects(() => renderPoster({ first: {}, wall: [{}] }), /浏览器/)
  assert.equal(canSharePoster(null), false)
})

test('shareMethod prefers file share, then text share, then a clipboard copy', () => {
  const blob = new Blob(['png'], { type: 'image/png' })
  assert.equal(shareMethod(blob, { canShare: ({ files }) => Boolean(files?.length), share() {} }), 'files')
  assert.equal(shareMethod(blob, { canShare: () => false, share() {} }), 'text')
  assert.equal(shareMethod(blob, { share() {} }), 'text')
  assert.equal(shareMethod(blob, {}), 'copy')
  assert.equal(shareMethod(null, { canShare: () => true, share() {} }), 'text')
  const files = shareData({ blob, text: '一段分享文案', name: 'chuting.png', title: '初听' }, { canShare: ({ files }) => Boolean(files?.length), share() {} })
  assert.equal(files.method, 'files')
  assert.equal(files.data.title, '初听')
  assert.equal(files.data.text, '一段分享文案')
  assert.equal(files.data.files.length, 1)
  assert.equal('url' in files.data, false)
  const textOnly = shareData({ blob, text: '一段分享文案' }, { share() {} })
  assert.equal(textOnly.method, 'text')
  assert.deepEqual(Object.keys(textOnly.data).sort(), ['text', 'title'])
  const copied = shareData({ blob, text: '一段分享文案' }, {})
  assert.equal(copied.method, 'copy')
  assert.deepEqual(Object.keys(copied.data), ['text'])
})
