import QRCode from 'qrcode'
import { ApiError, callNetease } from './netease.mjs'
import { seal, unseal, getSession, sessionCookie } from './session.mjs'

export const securityHeaders = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://*.music.126.net; media-src 'self' https://*.music.126.net https://*.vod.126.net; connect-src 'self' https://*.music.126.net https://*.vod.126.net; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
}
function json(body, status = 200, extra = {}) { return Response.json(body, { status, headers: { ...securityHeaders, 'Cache-Control': 'no-store', ...extra } }) }
async function input(request) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') throw new ApiError('需要 JSON 请求', 415)
  const reader = request.body?.getReader()
  let length = 0, chunks = []
  if (reader) while (true) {
    const { value, done } = await reader.read()
    if (done) break
    length += value.length
    if (length > 12000) { await reader.cancel(); throw new ApiError('请求过大', 413) }
    chunks.push(value)
  }
  try { const body = JSON.parse(Buffer.concat(chunks).toString()); if (!body || Array.isArray(body) || typeof body !== 'object') throw 0; return body }
  catch { throw new ApiError('JSON 格式错误', 400) }
}
// Profile fields we keep for the browser: uid, nickname, and a NetEase CDN avatar when present.
function accountFromProfile(p) {
  const account = { uid: String(p.userId), nickname: String(p.nickname || p.userId) }
  const raw = typeof p.avatarUrl === 'string' ? p.avatarUrl : ''
  const m = /^(?:https?:)?\/\/(p\d{1,2}\.music\.126\.net)\/([\w\-=./]{1,200})(?:\?.*)?$/.exec(raw)
  if (m) account.avatarUrl = `https://${m[1]}/${m[2]}`
  return account
}

function briefSong(song) {
  return { id: song.id, name: song.name, ar: (song.ar || []).map(a => ({ name: a.name })), al: { name: song.al?.name || '', picUrl: song.al?.picUrl || '' } }
}
// Audio comes straight from NetEase's CDN (m701/m801…music.126.net). URLs are signed and expire in minutes,
// so they are handed to the page as-is (upgraded to https) and never cached anywhere.
const AUDIO_HOST = /^([a-z0-9-]+\.)*(music|vod)\.126\.net$/
// Keep the host NetEase gave. Each file lives in one storage zone: m7 and m701 (or m8 and m801) are not
// interchangeable, and the wrong edge answers 400 OperationZoneMismatch. All of them serve valid https.
export function audioUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (!['http:', 'https:'].includes(url.protocol) || !AUDIO_HOST.test(url.hostname)) return null
    url.protocol = 'https:'
    return url.toString()
  } catch { return null }
}
const HARD_AUDIO = new Set(['flac', 'wav', 'ape', 'aiff', 'dsf', 'dff', 'alac', 'wma'])
const SIMPLE_LOSSY = new Set(['mp3', 'aac', 'ogg', 'opus'])
const HARD_LEVELS = new Set(['lossless', 'hires', 'jyeffect', 'sky', 'jymaster', 'dolby'])
const IMMERSIVE = new Set(['jyeffect', 'sky', 'jymaster', 'dolby'])
export function audioKind(answer) {
  if (!answer) return ''
  const type = String(answer.type || '').toLowerCase()
  const encode = String(answer.encodeType || '').toLowerCase()
  const format = String(answer.format || '').toLowerCase()
  let ext = ''
  try {
    const path = new URL(answer.url || '', 'https://music.126.net').pathname.toLowerCase()
    ext = (path.match(/\.([a-z0-9]{2,5})$/) || [])[1] || ''
  } catch {}
  return format || encode || type || ext
}
export function hardAudio(answer) {
  if (!answer?.url) return false
  const type = String(answer.type || answer.encodeType || '').toLowerCase()
  const encode = String(answer.encodeType || '').toLowerCase()
  const level = String(answer.level || '').toLowerCase()
  const kind = audioKind(answer)
  const br = Number(answer.br) || 0
  if (SIMPLE_LOSSY.has(type) || SIMPLE_LOSSY.has(kind)) return false
  if (HARD_AUDIO.has(type) || HARD_AUDIO.has(encode) || HARD_AUDIO.has(kind)) return true
  const boxed = type === 'm4a' || type === 'mp4' || kind === 'm4a' || kind === 'mp4'
  if (boxed && (encode === 'alac' || IMMERSIVE.has(level) || (['lossless', 'hires'].includes(level) && br > 320000))) return true
  if (boxed && encode !== 'alac' && !IMMERSIVE.has(level)) return false
  if (HARD_LEVELS.has(level)) return true
  return br > 320000 && Boolean(type) && !SIMPLE_LOSSY.has(type) && type !== 'm4a'
}
// A null URL is not a codec problem. fee 1/4 is membership or a purchase; cannotListenReason 1
// is the copyright block the public song-url API returns for tracks the account cannot play.
function listenBlock(item) {
  const fee = Number(item?.fee) || 0
  const why = Number(item?.freeTrialPrivilege?.cannotListenReason)
  if ([1, 4].includes(fee) || [2, 3, 4].includes(why)) return 'rights'
  if (why === 1) return 'copyright'
  return 'unavailable'
}
function dataRows(body) {
  if (Array.isArray(body?.data)) return body.data
  if (body?.data && typeof body.data === 'object') return [body.data]
  return []
}
export function playable(body, id) {
  const rows = dataRows(body)
  const item = rows.find(x => String(x.id) === String(id)) || rows[0] || {}
  const url = audioUrl(item.url)
  if (!url) return { id: String(id), url: null, reason: listenBlock(item) }
  // freeTrialInfo is only set when this account lacks the rights: the URL is then a preview clip.
  const trial = item.freeTrialInfo ? { start: Number(item.freeTrialInfo.start) || 0, end: Number(item.freeTrialInfo.end) || 0 } : null
  const encodeType = String(item.encodeType || '').toLowerCase()
  const out = {
    id: String(id), url,
    type: String(item.type || item.encodeType || '').toLowerCase(),
    br: Number(item.br) || 0,
    duration: Number(item.time) || 0,
    level: String(item.level || '').toLowerCase(),
    trial
  }
  if (encodeType) out.encodeType = encodeType
  return out
}
export function fileExt(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/)
  return m ? m[1] : ''
}
export function cloudHint(song, item) {
  const pc = song?.pc && typeof song.pc === 'object' ? song.pc : null
  const cs = Boolean(song?.privilege?.cs)
  const t = Number(song?.t)
  const uf = item?.uf && typeof item.uf === 'object'
  const sid = Number(pc?.sid)
  const fromFn = fileExt(pc?.fn)
  const fromUf = String((uf && (item.uf.type || item.uf.encodeType)) || '').toLowerCase()
  return {
    cloud: Boolean(pc || cs || uf || t === 1 || t === 2),
    sid: Number.isFinite(sid) && sid > 0 ? String(sid) : '',
    format: fromFn || fromUf
  }
}
// Cloud-drive uploads exist only as the uploaded file (often ALAC m4a, which Chrome cannot decode).
// The same song in NetEase's catalogue usually has an MP3, so match by title, then artist.
const squash = value => String(value || '').toLowerCase().normalize('NFKC').replace(/[\s\-_~·・'"’“”()（）\[\]【】「」『』.,，。!！?？]/g, '')
export function pickMatch(songs, name, artist, skipId) {
  const want = squash(name)
  if (!want) return null
  const artists = String(artist || '').split(/[\/、,&]|\s+feat\.?\s+/i).map(squash).filter(a => a && !['未知歌手', '歌手未知', 'unknown', 'unknownartist'].includes(a))
  const same = (songs || []).filter(s => String(s?.id) !== String(skipId) && squash(s?.name) === want)
  const byArtist = same.find(s => artists.length && (s.ar || []).some(a => artists.includes(squash(a?.name))))
  return byArtist || (artists.length ? null : same[0]) || null
}
async function askPlayable(upstream, method, query, session, id) {
  return playable((await upstream(method, query, session.cookie, session.account.uid)).body, id)
}
function takeLossy(current, next, id, extra = {}) {
  if (!next?.url || hardAudio(next)) return current
  if (next.trial && current.url && !current.trial) return current
  return { ...next, id: String(id), ...extra }
}
// After standard + legacy, a cloud upload may still be the original APE / FLAC / ALAC file.
// Prefer a matched catalogue id (pc.sid, then a title search), then a transcoded download URL.
async function recoverCloudAudio(answer, query, session, upstream) {
  if (!answer?.url || !hardAudio(answer)) return answer
  const id = query.id
  let hint = { cloud: false, sid: '', format: '' }
  try {
    const detail = (await upstream('song_detail', { ids: String(id) }, session.cookie, session.account.uid)).body
    const song = (detail?.songs || []).find(s => String(s?.id) === String(id)) || detail?.songs?.[0]
    hint = cloudHint(song)
  } catch {}
  if (hint.sid && hint.sid !== String(id)) {
    try {
      const twin = await askPlayable(upstream, 'song_url', { id: hint.sid, level: 'standard', encodeType: 'mp3' }, session, hint.sid)
      const next = takeLossy(answer, twin, id, { matched: hint.sid })
      if (next !== answer && !hardAudio(next) && !next.trial) return next
    } catch {}
  }
  const name = String(query.name || '').slice(0, 200)
  if (name) {
    try {
      const artist = String(query.artist || '').slice(0, 200)
      const found = (await upstream('song_search', { s: `${name} ${artist}`.trim() }, session.cookie, session.account.uid)).body
      const match = pickMatch(found?.result?.songs, name, artist, id)
      if (match) {
        const twin = await askPlayable(upstream, 'song_url', { id: String(match.id), level: 'standard', encodeType: 'mp3' }, session, match.id)
        const next = takeLossy(answer, twin, id, { matched: String(match.id) })
        if (next !== answer && !hardAudio(next) && !next.trial) return next
      }
    } catch {}
  }
  try {
    const dl = await askPlayable(upstream, 'song_download_url', { id, br: 128000 }, session, id)
    answer = takeLossy(answer, dl, id)
  } catch {}
  if (answer.url && hardAudio(answer)) {
    try {
      const dl = await askPlayable(upstream, 'song_download_url_v1', { id, level: 'standard', encodeType: 'mp3' }, session, id)
      answer = takeLossy(answer, dl, id)
    } catch {}
  }
  if (answer.url && hardAudio(answer) && (hint.cloud || hint.format)) {
    return { ...answer, cloud: true, format: hint.format || answer.type || answer.encodeType }
  }
  return answer
}
// Dependency injection is used by tests, never controlled by HTTP input.
export async function handleApi(request, env, upstream = callNetease) {
  const url = new URL(request.url)
  try {
    if (url.pathname === '/api/runtime' && request.method === 'GET') return json({ storage: 'indexeddb', configured: Boolean(env.SESSION_SECRET?.length >= 32) })
    if (request.method !== 'POST') return json({ error: '需要 POST 请求' }, 405)
    if (request.headers.get('Origin') !== url.origin) return json({ error: '不接受其他网站的请求' }, 403)
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return json({ error: '登录需要 HTTPS' }, 403)
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return json({ error: '部署者尚未配置 SESSION_SECRET' }, 503)
    const body = await input(request)
    if (url.pathname === '/api/auth/key') {
      const { body: result } = await upstream('qr_key', {}, {})
      const key = result.unikey
      if (!key || typeof key !== 'string') throw new ApiError('暂时无法创建登录二维码', 503)
      const qrurl = `https://music.163.com/login?codekey=${encodeURIComponent(key)}`
      return json({ ticket: await seal({ key }, env.SESSION_SECRET, 'qr', 180),
        image: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(await QRCode.toString(qrurl, { type: 'svg', margin: 2, width: 240 })) })
    }
    if (url.pathname === '/api/auth/check') {
      const ticket = await unseal(body.ticket, env.SESSION_SECRET, 'qr')
      if (!ticket) throw new ApiError('二维码已过期，请刷新二维码', 400)
      const result = await upstream('qr_check', { key: ticket.key }, {})
      if (result.body.code !== 803) return json({ code: result.body.code })
      if (!result.cookie.MUSIC_U) throw new ApiError('登录未完成，请重新扫码', 401)
      const { body: accountBody } = await upstream('login_status', {}, result.cookie)
      const p = accountBody.profile
      if (!p?.userId) throw new ApiError('无法读取登录账号', 401)
      const account = accountFromProfile(p)
      return json({ code: 803, account }, 200, { 'Set-Cookie': sessionCookie(request, await seal({ account, cookie: result.cookie }, env.SESSION_SECRET, 'session', 604800)) })
    }
    if (url.pathname === '/api/auth/logout') return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) })
    const session = await getSession(request, env.SESSION_SECRET)
    const valid = Boolean(session?.account && session.cookie?.MUSIC_U)
    // A status probe without a session is a normal answer, not an error (avoids a 401 in every visitor's console).
    if (url.pathname === '/api/auth/status') return json({ account: valid ? session.account : null })
    if (!valid) throw new ApiError('请先扫码连接网易云音乐', 401)
    if (url.pathname !== '/api/netease') return json({ error: '接口不存在' }, 404)
    if (String(body.uid) !== session.account.uid) throw new ApiError('登录账号已改变，请暂停后重新连接', 401)
    // Only collector methods are public. QR exchange is handled above.
    if (['qr_key', 'qr_check'].includes(body.method)) throw new ApiError('不支持的接口', 400)
    const result = await upstream(body.method, body.query || {}, session.cookie, session.account.uid)
    if (body.method === 'login_status') {
      const p = result.body.profile
      if (!p?.userId || String(p.userId) !== session.account.uid) throw new ApiError('登录账号已改变，请重新连接', 401)
      return json({ account: accountFromProfile(p) })
    }
    // Song details are only used for names and album art: trim ~1–2 KB per song down to what is stored.
    if (body.method === 'song_detail') return json({ code: 200, songs: (result.body.songs || []).map(briefSong) })
    if (body.method === 'artist_search') {
      const list = result.body.result?.artists || []
      const placeholder = /\/(18686200114669622|5639395138885805)(\.|$)/
      return json({
        code: 200,
        artists: list.slice(0, 5).map(a => {
          const name = String(a?.name || '').slice(0, 80)
          const raw = (typeof a?.picUrl === 'string' && a.picUrl) || (typeof a?.img1v1Url === 'string' ? a.img1v1Url : '')
          const m = /^(?:https?:)?\/\/(p\d{1,2}\.music\.126\.net)\/([\w\-=./]{1,200})(?:\?.*)?$/.exec(raw)
          const picUrl = m ? `https://${m[1]}/${m[2]}` : ''
          const out = { name }
          if (picUrl && !placeholder.test(picUrl)) out.picUrl = picUrl
          return out
        }).filter(a => a.name),
      })
    }
    if (body.method === 'song_url') {
      let answer = playable(result.body, body.query?.id)
      // One quieter ask: no file, a preview, or a FLAC / hi-res master. Standard MP3 is the level
      // browsers actually decode. A thrown retry keeps the first answer; never ask a third time.
      if ((!answer.url || answer.trial || hardAudio(answer)) && body.query?.level !== 'standard') {
        try {
          const again = playable((await upstream('song_url', { ...body.query, level: 'standard', encodeType: 'mp3' }, session.cookie, session.account.uid)).body, body.query?.id)
          const lossy = again.url && !hardAudio(again)
          if (lossy && (!again.trial || !answer.url || hardAudio(answer))) answer = again
          else if (!answer.url && again.url) answer = again
        } catch {}
      }
      // Some songs answer the v1 standard ask with their lossless master anyway. The older endpoint
      // takes a bitrate cap instead of a level and returns a 128k MP3 for them.
      if (answer.url && hardAudio(answer)) {
        try {
          const legacy = playable((await upstream('song_url_legacy', { id: body.query?.id }, session.cookie, session.account.uid)).body, body.query?.id)
          if (legacy.url && !hardAudio(legacy) && (!legacy.trial || answer.trial)) answer = legacy
        } catch {}
      }
      answer = await recoverCloudAudio(answer, body.query || {}, session, upstream)
      return json(answer)
    }
    // Upstream payload is returned only to this authenticated browser; never cached/logged.
    return json(result.body)
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message, code: error.code }, error.code >= 400 && error.code <= 599 ? error.code : 502)
    return json({ error: '接口处理失败，请稍后重试' }, 500)
  }
}
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname.startsWith('/api/')) return handleApi(request, env)
    const response = await env.ASSETS.fetch(request)
    const headers = new Headers(response.headers)
    for (const [key, value] of Object.entries(securityHeaders)) headers.set(key, value)
    return new Response(response.body, { status: response.status, headers })
  },
}
