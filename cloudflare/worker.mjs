import QRCode from 'qrcode'
import { ApiError, callNetease } from './netease.mjs'
import { seal, unseal, getSession, sessionCookie } from './session.mjs'

export const securityHeaders = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://*.music.126.net; media-src 'self' https://*.music.126.net; connect-src 'self' https://*.music.126.net; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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
export function briefSong(song) {
  return { id: song.id, name: song.name, ar: (song.ar || []).map(a => ({ name: a.name })), al: { name: song.al?.name || '', picUrl: song.al?.picUrl || '' } }
}
// Audio comes straight from NetEase's CDN (m701/m801…music.126.net). URLs are signed and expire in minutes,
// so they are handed to the page as-is (upgraded to https) and never cached anywhere.
const AUDIO_HOST = /^([a-z0-9-]+\.)*music\.126\.net$/
export function audioUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (!['http:', 'https:'].includes(url.protocol) || !AUDIO_HOST.test(url.hostname)) return null
    url.protocol = 'https:'
    return url.toString()
  } catch { return null }
}
export function playable(body, id) {
  const item = (body?.data || []).find(x => String(x.id) === String(id)) || body?.data?.[0] || {}
  const url = audioUrl(item.url)
  if (!url) return { id: String(id), url: null, reason: [1, 4].includes(item.fee) ? 'rights' : 'unavailable' }
  // freeTrialInfo is only set when this account lacks the rights: the URL is then a preview clip.
  const trial = item.freeTrialInfo ? { start: Number(item.freeTrialInfo.start) || 0, end: Number(item.freeTrialInfo.end) || 0 } : null
  return { id: String(id), url, type: String(item.type || '').toLowerCase(), br: Number(item.br) || 0, duration: Number(item.time) || 0, level: item.level || '', trial }
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
      const account = { uid: String(p.userId), nickname: String(p.nickname || p.userId) }
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
      return json({ account: { uid: String(p.userId), nickname: String(p.nickname || p.userId) } })
    }
    // Song details are only used for names and album art: trim ~1–2 KB per song down to what is stored.
    if (body.method === 'song_detail') return json({ code: 200, songs: (result.body.songs || []).map(briefSong) })
    if (body.method === 'song_url') {
      let answer = playable(result.body, body.query?.id)
      // Some tracks have no high-bitrate file: ask once more at standard quality.
      if ((!answer.url || answer.trial) && body.query?.level !== 'standard') {
        const again = playable((await upstream('song_url', { ...body.query, level: 'standard' }, session.cookie, session.account.uid)).body, body.query?.id)
        if (again.url && (!again.trial || !answer.url)) answer = again
      }
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
