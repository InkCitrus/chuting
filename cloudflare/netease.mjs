// Minimal read-only transport, ported from api-enhanced 4.41.1 util/crypto.js.
// MIT, Copyright (c) 2013-2022 Binaryify. See LICENSE.api-enhanced.
// Deliberately excludes its filesystem, axios, proxy and subprocess dependencies.
import { createCipheriv, createHash, publicEncrypt, constants, randomBytes } from 'node:crypto'

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`
function aes(text, key, mode, encoding) {
  const cipher = createCipheriv(`aes-128-${mode}`, Buffer.from(key), mode === 'cbc' ? Buffer.from('0102030405060708') : null)
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString(encoding)
}
export function eapi(path, data) {
  const text = JSON.stringify(data)
  const md5 = createHash('md5').update(`nobody${path}use${text}md5forencrypt`).digest('hex')
  return { params: aes(`${path}-36cd479b6b5-${text}-36cd479b6b5-${md5}`, 'e82ckenh8dichen8', 'ecb', 'hex').toUpperCase() }
}
export function weapi(data, secret = randomBytes(16).toString('hex').slice(0, 16)) {
  const padded = Buffer.alloc(128)
  Buffer.from([...secret].reverse().join('')).copy(padded, 112)
  return {
    params: aes(aes(JSON.stringify(data), '0CoJUm6Qyw8W8jud', 'cbc', 'base64'), secret, 'cbc', 'base64'),
    encSecKey: publicEncrypt({ key: PUBLIC_KEY, padding: constants.RSA_NO_PADDING }, padded).toString('hex'),
  }
}
export class ApiError extends Error {
  constructor(message, code = 0) { super(message); this.code = code }
}
const id = value => {
  if (!/^[1-9]\d{0,17}$/.test(String(value))) throw new ApiError('歌曲或歌单 ID 格式错误', 400)
  return String(value)
}
const bounded = (value, max, fallback = 0) => {
  const n = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(n) || n < 0 || n > max) throw new ApiError('参数超出范围', 400)
  return n
}
export function endpoint(method, query = {}, uid) {
  switch (method) {
    case 'qr_key': return ['/api/login/qrcode/unikey', { type: 3 }]
    case 'qr_check': return ['/api/login/qrcode/client/login', { key: query.key, type: 3 }]
    case 'login_status': return ['/api/w/nuser/account/get', {}, 'weapi']
    case 'record_recent_song': return ['/api/play-record/song/list', { limit: 1000 }, 'weapi']
    case 'user_record': return ['/api/v1/play/record', { uid, type: bounded(query.type, 1) }, 'weapi']
    case 'likelist': return ['/api/song/like/get', { uid }]
    case 'user_playlist': return ['/api/user/playlist', { uid, limit: 100, offset: bounded(query.offset, 10000), includeVideo: true }, 'weapi']
    case 'playlist_detail': return ['/api/v6/playlist/detail', { id: id(query.id), n: 100000, s: 0 }]
    case 'music_first_listen_info': return ['/api/content/activity/music/first/listen/info', { songId: id(query.id) }]
    case 'song_detail': {
      const ids = String(query.ids).split(',')
      if (ids.length > 100) throw new ApiError('一次最多查询 100 首详情', 400)
      return ['/api/v3/song/detail', { c: JSON.stringify(ids.map(x => ({ id: Number(id(x)) }))) }, 'weapi']
    }
    // Playable URL for the logged-in account (its VIP rights come with the session cookie).
    case 'song_url': {
      const level = ['standard', 'higher', 'exhigh'].includes(query.level) ? query.level : 'exhigh'
      // MP3 is the default. An AAC request can still come back as FLAC when that is the other
      // master on the song, and browsers then report media error 4. Never ask for FLAC here.
      const encodeType = ['mp3', 'aac'].includes(query.encodeType) ? query.encodeType : 'mp3'
      return ['/api/song/enhance/player/url/v1', { ids: JSON.stringify([Number(id(query.id))]), level, encodeType }]
    }
    // Older bitrate-capped endpoint: only used by the worker when v1 keeps returning a lossless master.
    case 'song_url_legacy': return ['/api/song/enhance/player/url', { ids: JSON.stringify([Number(id(query.id))]), br: 128000 }]
    // Catalogue search, used only to find a streamable twin of a cloud-drive (uploaded) song.
    case 'song_search': {
      const text = String(query.s || '').trim().slice(0, 200)
      if (!text) throw new ApiError('缺少搜索词', 400)
      return ['/api/cloudsearch/pc', { s: text, type: 1, limit: 10, offset: 0 }]
    }
    case 'listen_data_year_report': return ['/api/content/activity/listen/data/year/report', {}]
    case 'summary_annual': {
      const year = bounded(query.year, new Date().getUTCFullYear())
      if (year < 2017) throw new ApiError('年份超出范围', 400)
      return [`/api/activity/summary/annual/${year}/${year <= 2019 ? 'userdata' : 'data'}`, {}]
    }
    case 'listen_data_song_play_rank': {
      const endTime = Number(query.endTime)
      if (!Number.isSafeInteger(endTime) || endTime < 1483200000000 || endTime > Date.now() + 86400000) throw new ApiError('月份超出范围', 400)
      return ['/api/content/activity/listen/data/song/play/rank', { type: 'month', endTime }]
    }
    default: throw new ApiError('不支持的接口', 400)
  }
}
export async function callNetease(method, query, cookie = {}, uid, fetcher = fetch) {
  const [path, original, mode = 'eapi'] = endpoint(method, query, uid)
  const data = { ...original, e_r: false }
  let cookies, url, encrypted
  const base = { os: 'osx', appver: '3.1.10.5100', osver: '15.5', channel: 'netease', __remember_me: 'true', ...cookie }
  if (mode === 'weapi') {
    data.csrf_token = cookie.__csrf || ''
    cookies = base
    url = 'https://music.163.com/weapi/' + path.slice(5)
    encrypted = weapi(data)
  } else {
    const header = { ...base, versioncode: '140', buildver: String(Math.floor(Date.now() / 1000)), resolution: '1920x1080', __csrf: cookie.__csrf || '', requestId: `${Date.now()}_${randomBytes(2).toString('hex')}` }
    data.header = header
    cookies = header
    url = 'https://interfacepc.music.163.com/eapi/' + path.slice(5)
    encrypted = eapi(path, data)
  }
  let response, body
  try {
    response = await fetcher(url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(18000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://music.163.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        Cookie: Object.entries(cookies).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('; ') },
      body: new URLSearchParams(encrypted).toString() })
    body = await response.json()
  } catch { throw new ApiError('网易接口连接失败或超时，请稍后重试', 503) }
  let code = Number(body.code || response.status)
  // NetEase answers risk control with -460/-462 in an HTTP 200 body: treat it like a rate limit.
  if ([-460, -462].includes(code)) code = 429
  if ((!response.ok || code !== 200) && !(method === 'qr_check' && [800, 801, 802, 803].includes(code))) {
    throw new ApiError([301, 401].includes(code) ? '登录已失效，请重新扫码' : [403, 429, 460].includes(code) ? '接口请求受限，请稍后再同步' : '网易接口暂时没有返回有效结果', code)
  }
  const setCookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie') || '']
  const updated = { ...cookie }
  for (const line of setCookies) for (const match of line.matchAll(/(?:^|,\s*)(MUSIC_U|__csrf|NMTID)=([^;,\s]+)/g)) updated[match[1]] = match[2]
  return { body, cookie: updated }
}
