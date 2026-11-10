import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createDecipheriv } from 'node:crypto'
import { eapi, weapi, endpoint, ApiError, callNetease } from '../cloudflare/netease.mjs'
import { seal, unseal, sessionCookie } from '../cloudflare/session.mjs'
import { handleApi, pickMatch, hardAudio, playable, cloudHint } from '../cloudflare/worker.mjs'
const require = createRequire(import.meta.url)
const upstreamCrypto = require('@neteasecloudmusicapienhanced/api/util/crypto.js')
const secret = 'test-only-secret-32-characters-long-123456789'
const origin = 'https://chuting.example'
function req(path, body = {}, cookie, customOrigin = origin) { return new Request(origin + path, { method: 'POST', headers: { Origin: customOrigin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) }) }
test('eapi encryption exactly matches pinned upstream including Unicode', () => {
  const data = { songId: '28684050', title: '初听 🎵', header: { MUSIC_U: 'fixture' }, e_r: false }
  assert.deepEqual(eapi('/api/content/activity/music/first/listen/info', data), upstreamCrypto.eapi('/api/content/activity/music/first/listen/info', data))
})
test('weapi payload decrypts with fixed test secret, valid 1024-bit RSA', () => {
  const data = { uid: '1', csrf_token: '', e_r: false }, key = '0123456789abcdef'
  const result = weapi(data, key)
  function decrypt(text, aesKey) { const d = createDecipheriv('aes-128-cbc', Buffer.from(aesKey), Buffer.from('0102030405060708')); return Buffer.concat([d.update(text, 'base64'), d.final()]).toString() }
  assert.deepEqual(JSON.parse(decrypt(decrypt(result.params, key), '0CoJUm6Qyw8W8jud')), data)
  assert.equal(result.encSecKey.length, 256)
})
test('sealed session rejects tampering, wrong purposes and expiration', async () => {
  const sealed = await seal({ account: { uid: '1' } }, secret, 'session', 60)
  assert.equal((await unseal(sealed, secret, 'session')).account.uid, '1')
  assert.equal(await unseal(sealed + 'x', secret, 'session'), null)
  assert.equal(await unseal(sealed, secret, 'qr'), null)
  assert.equal(await unseal(await seal({}, secret, 'session', -1), secret, 'session'), null)
  assert.match(sessionCookie(req('/'), sealed), /HttpOnly; SameSite=Strict; Max-Age=604800; Secure/)
})
test('proxy rejects cross origin, no session, account mismatch and arbitrary routes', async () => {
  let calls = 0
  const rpc = async () => { calls++; return { body: { code: 200 }, cookie: {} } }
  const env = { SESSION_SECRET: secret }
  assert.equal((await handleApi(req('/api/netease', {}, null, 'https://other.example'), env, rpc)).status, 403)
  assert.equal((await handleApi(req('/api/netease'), env, rpc)).status, 401)
  const token = await seal({ account: { uid: '1' }, cookie: { MUSIC_U: 'fake' } }, secret, 'session', 60)
  assert.equal((await handleApi(req('/api/netease', { uid: '2' }, 'chuting_session=' + token), env, rpc)).status, 401)
  assert.equal((await handleApi(req('/api/auth/key'), {}, rpc)).status, 503)
  assert.equal(calls, 0)
  assert.throws(() => endpoint('send_message'), /不支持/)
  assert.throws(() => endpoint('song_detail', { ids: '1);DROP TABLE' }), /格式/)
  assert.equal(endpoint('user_playlist', { uid: 'ATTACKER' }, '1')[1].uid, '1')
})
test('session status probe answers without a session instead of failing', async () => {
  const env = { SESSION_SECRET: secret }, rpc = async () => assert.fail('status must not call upstream')
  const anonymous = await handleApi(req('/api/auth/status'), env, rpc)
  assert.equal(anonymous.status, 200)
  assert.deepEqual(await anonymous.json(), { account: null })
  const token = await seal({ account: { uid: '1', nickname: 'Test' }, cookie: { MUSIC_U: 'fake' } }, secret, 'session', 60)
  const { relay, ...status } = await (await handleApi(req('/api/auth/status', {}, 'chuting_session=' + token), env, rpc)).json()
  assert.deepEqual(status, { account: { uid: '1', nickname: 'Test' } })
  assert.match(relay, /^[\w-]{40,}$/)
  assert.ok(!relay.includes('fake'))
  const noCookie = await seal({ account: { uid: '1' }, cookie: {} }, secret, 'session', 60)
  assert.deepEqual(await (await handleApi(req('/api/auth/status', {}, 'chuting_session=' + noCookie), env, rpc)).json(), { account: null })
  assert.equal((await handleApi(req('/api/auth/status', {}, null, 'https://other.example'), env, rpc)).status, 403)
})
test('QR login returns only account and an encrypted HttpOnly credential', async () => {
  const rpc = async method => method === 'qr_key' ? { body: { unikey: 'qr-fixture' } }
    : method === 'qr_check' ? { body: { code: 803 }, cookie: { MUSIC_U: 'sensitive-fixture' } }
      : { body: { profile: { userId: 1, nickname: 'Test', avatarUrl: 'http://p1.music.126.net/abc/avatar.jpg?param=200y200' } } }
  const env = { SESSION_SECRET: secret }
  const keyResponse = await handleApi(req('/api/auth/key'), env, rpc), key = await keyResponse.json()
  assert.match(key.image, /^data:image\/svg\+xml/)
  const login = await handleApi(req('/api/auth/check', { ticket: key.ticket }), env, rpc)
  const { relay, ...answer } = await login.json()
  assert.deepEqual(answer, { code: 803, account: { uid: '1', nickname: 'Test', avatarUrl: 'https://p1.music.126.net/abc/avatar.jpg' } })
  assert.ok(typeof relay === 'string' && !relay.includes('sensitive-fixture'))
  assert.ok(!login.headers.get('Set-Cookie').includes('sensitive-fixture'))
  assert.match(login.headers.get('Cache-Control'), /no-store/)
})
test('transport maps HTTP rate limit and does not expose upstream error', async () => {
  await assert.rejects(callNetease('music_first_listen_info', { id: '1' }, {}, '1', async () => Response.json({ code: 429, message: 'credential-secret' }, { status: 429 })), err => err instanceof ApiError && err.code === 429 && !err.message.includes('secret'))
})
test('NetEase risk-control codes are treated as rate limits', async () => {
  await assert.rejects(callNetease('music_first_listen_info', { id: '1' }, {}, '1', async () => Response.json({ code: -460, message: 'Cheating' })), err => err.code === 429)
})
test('song details are trimmed to names and album art before reaching the browser', async () => {
  const env = { SESSION_SECRET: secret }
  const token = await seal({ account: { uid: '1' }, cookie: { MUSIC_U: 'fake' } }, secret, 'session', 60)
  const rpc = async () => ({ body: { code: 200, songs: [{ id: 7, name: 'n', ar: [{ name: 'a', id: 9, alias: [] }], al: { name: 'al', picUrl: 'http://p1.music.126.net/x/1.jpg', pic: 1 }, privilege: { big: 'x' }, mv: 0 }], privileges: [{}] }, cookie: {} })
  const body = await (await handleApi(req('/api/netease', { uid: '1', method: 'song_detail', query: { ids: '7' } }, 'chuting_session=' + token), env, rpc)).json()
  assert.deepEqual(body, { code: 200, songs: [{ id: 7, name: 'n', ar: [{ name: 'a' }], al: { name: 'al', picUrl: 'http://p1.music.126.net/x/1.jpg' } }] })
})
test('artist search returns only the name and a sanitized portrait URL', async () => {
  const env = { SESSION_SECRET: secret }
  const token = await seal({ account: { uid: '1' }, cookie: { MUSIC_U: 'fake' } }, secret, 'session', 60)
  const [path, query] = endpoint('artist_search', { s: '甲' })
  assert.equal(path, '/api/cloudsearch/pc')
  assert.equal(query.type, 100)
  const rpc = async (method, q) => {
    assert.equal(method, 'artist_search')
    assert.equal(q.s, '甲')
    return { body: { code: 200, result: { artists: [
      { name: '甲', id: 9, picUrl: 'http://p2.music.126.net/ok/face.jpg?param=640y300', albumSize: 12, followed: true },
      { name: '乙', img1v1Url: 'https://p1.music.126.net/x/18686200114669622.jpg' },
    ] } }, cookie: {} }
  }
  const body = await (await handleApi(req('/api/netease', { uid: '1', method: 'artist_search', query: { s: '甲' } }, 'chuting_session=' + token), env, rpc)).json()
  assert.deepEqual(body, { code: 200, artists: [{ name: '甲', picUrl: 'https://p2.music.126.net/ok/face.jpg' }, { name: '乙' }] })
})
test('CSP allows album art only from the NetEase image CDN', async () => {
  const response = await handleApi(new Request(origin + '/api/runtime'), {})
  const csp = response.headers.get('Content-Security-Policy')
  assert.match(csp, /img-src 'self' data: https:\/\/\*\.music\.126\.net;/)
  assert.match(csp, /script-src 'self';/)
})
test('transport uses Workers-compatible manual redirects and only fixed official hosts', async () => {
  await callNetease('qr_key', {}, {}, null, async (url, options) => {
    assert.equal(new URL(url).hostname, 'interfacepc.music.163.com')
    assert.equal(options.redirect, 'manual')
    const decoded = upstreamCrypto.eapiReqDecrypt(new URLSearchParams(options.body).get('params'))
    assert.equal(decoded.url, '/api/login/qrcode/unikey')
    assert.equal(decoded.data.type, 3)
    return Response.json({ code: 200, unikey: 'fixture' })
  })
})
test('player: the session is forwarded, the URL comes back over https from the audio CDN only', async () => {
  const env = { SESSION_SECRET: secret }
  const token = await seal({ account: { uid: '1' }, cookie: { MUSIC_U: 'vip-session', __csrf: 'c' } }, secret, 'session', 60)
  const ask = (rpc, query = { id: '7' }) => handleApi(req('/api/netease', { uid: '1', method: 'song_url', query }, 'chuting_session=' + token), env, rpc).then(r => r.json())
  // Full track for a VIP account at exhigh.
  let seen = []
  let body = await ask(async (method, query, cookie) => { seen.push([method, query.level, cookie.MUSIC_U]); return { body: { code: 200, data: [{ id: 7, url: 'http://m701.music.126.net/2026/a.mp3?vuutv=x', br: 320000, type: 'MP3', time: 241000, fee: 1, level: 'exhigh', freeTrialInfo: null }] }, cookie: {} } })
  assert.deepEqual(seen, [['song_url', undefined, 'vip-session']])
  assert.deepEqual(body, { id: '7', url: 'https://m701.music.126.net/2026/a.mp3?vuutv=x', type: 'mp3', br: 320000, duration: 241000, level: 'exhigh', trial: null })
  // No file at the high level: falls back to standard once.
  seen = []
  body = await ask(async (method, query) => { seen.push(query.level); return { body: { code: 200, data: [query.level === 'standard' ? { id: 7, url: 'https://m801.music.126.net/b.mp3', fee: 0, freeTrialInfo: null } : { id: 7, url: null, fee: 0 }] }, cookie: {} } })
  assert.deepEqual(seen, [undefined, 'standard'])
  assert.equal(body.url, 'https://m801.music.126.net/b.mp3')
  // Account without the rights: a preview clip is flagged as a trial, not passed off as the full track.
  body = await ask(async () => ({ body: { code: 200, data: [{ id: 7, url: 'http://m701.music.126.net/clip.mp3', fee: 1, freeTrialInfo: { start: 30, end: 60 } }] }, cookie: {} }))
  assert.deepEqual(body.trial, { start: 30, end: 60 })
  // Nothing playable, or a host outside the NetEase CDN: no URL, a reason the page can phrase.
  body = await ask(async () => ({ body: { code: 200, data: [{ id: 7, url: null, fee: 4 }] }, cookie: {} }))
  assert.deepEqual(body, { id: '7', url: null, reason: 'rights' })
  body = await ask(async () => ({ body: { code: 200, data: [{ id: 7, url: 'https://evil.example/a.mp3', fee: 0 }] }, cookie: {} }))
  assert.equal(body.url, null); assert.equal(body.reason, 'unavailable')
  // The host is kept (m7 and m701 are different storage zones); only the scheme is upgraded.
  body = await ask(async () => ({ body: { code: 200, data: [{ id: 7, url: 'http://m8.music.126.net/a.mp3', br: 128000, type: 'mp3', time: 1000, fee: 0 }] }, cookie: {} }))
  assert.equal(body.url, 'https://m8.music.126.net/a.mp3')
  body = await ask(async () => ({ body: { code: 200, data: [{ id: 7, url: 'http://m7.music.126.net/20261108/ymusic/a.mp3?vuutv=x', br: 128000, type: 'mp3', time: 1000, fee: 0 }] }, cookie: {} }))
  assert.equal(body.url, 'https://m7.music.126.net/20261108/ymusic/a.mp3?vuutv=x')
  body = await ask(async () => ({ body: { code: 200, data: [{ id: 7, url: 'http://vodkgeyttp9.vod.126.net/obj/a.mp3', br: 128000, type: 'mp3', time: 1000, fee: 0 }] }, cookie: {} }))
  assert.equal(body.url, 'https://vodkgeyttp9.vod.126.net/obj/a.mp3')
  // If the standard-quality retry throws, keep the first answer (rights / trial) instead of 500.
  body = await ask(async (_method, query) => {
    if (query.level === 'standard') throw new Error('upstream failed')
    return { body: { code: 200, data: [{ id: 7, url: null, fee: 1 }] }, cookie: {} }
  })
  assert.deepEqual(body, { id: '7', url: null, reason: 'rights' })
  // A FLAC / hi-res master is asked again once, at standard MP3, and that lossy URL wins.
  const levels = []
  body = await ask(async (_method, query) => {
    levels.push(query.level || 'first')
    if (query.level === 'standard') return { body: { code: 200, data: [{ id: 7, url: 'https://m801.music.126.net/std.mp3', br: 128000, type: 'mp3', time: 368000, fee: 1, level: 'standard' }] }, cookie: {} }
    return { body: { code: 200, data: [{ id: 7, url: 'https://m701.music.126.net/sq.flac', br: 983061, type: 'flac', time: 368000, fee: 1, level: 'lossless' }] }, cookie: {} }
  })
  assert.deepEqual(levels, ['first', 'standard'])
  assert.equal(body.type, 'mp3')
  assert.equal(body.url, 'https://m801.music.126.net/std.mp3')
  // Still lossless at standard: one ask on the bitrate-capped legacy endpoint, and its MP3 wins.
  let methods = []
  body = await ask(async (method) => {
    methods.push(method)
    if (method === 'song_url_legacy') return { body: { code: 200, data: [{ id: 7, url: 'http://m7.music.126.net/legacy.mp3', br: 128000, type: 'mp3', time: 368000, fee: 0 }] }, cookie: {} }
    return { body: { code: 200, data: [{ id: 7, url: 'https://m701.music.126.net/sq.m4a', br: 988000, type: 'm4a', time: 368000, fee: 0, level: 'lossless' }] }, cookie: {} }
  })
  assert.deepEqual(methods, ['song_url', 'song_url', 'song_url_legacy'])
  assert.equal(body.url, 'https://m7.music.126.net/legacy.mp3')
  // Lossless everywhere: recover may also ask detail and download URLs, then stop.
  let calls = 0
  body = await ask(async () => {
    calls++
    return { body: { code: 200, data: [{ id: 7, url: 'https://m701.music.126.net/sq.flac', br: 983061, type: 'flac', time: 368000, fee: 0, level: 'lossless' }] }, cookie: {} }
  })
  assert.equal(calls, 6)
  assert.equal(body.type, 'flac')
  // No URL, and the privilege says the track cannot be listened to: copyright, not a format error.
  body = await ask(async () => ({ body: { code: 200, data: [{ id: 7, url: null, fee: 0, code: 404, freeTrialPrivilege: { cannotListenReason: 1 } }] }, cookie: {} }))
  assert.deepEqual(body, { id: '7', url: null, reason: 'copyright' })
})
test('player endpoint asks NetEase for one song at a bounded quality level', () => {
  const [path, data] = endpoint('song_url', { id: '7', level: 'lossless' })
  assert.equal(path, '/api/song/enhance/player/url/v1')
  assert.deepEqual(data, { ids: '[7]', level: 'exhigh', encodeType: 'mp3' })
  assert.equal(endpoint('song_url', { id: '7', level: 'standard' })[1].level, 'standard')
  assert.equal(endpoint('song_url', { id: '7', encodeType: 'mp3' })[1].encodeType, 'mp3')
  assert.equal(endpoint('song_url', { id: '7', encodeType: 'aac' })[1].encodeType, 'aac')
  assert.equal(endpoint('song_url', { id: '7', encodeType: 'flac' })[1].encodeType, 'mp3')
  assert.equal(endpoint('song_url', { id: '7', encodeType: 'ogg' })[1].encodeType, 'mp3')
  assert.throws(() => endpoint('song_url', { id: '7;drop' }))
  assert.deepEqual(endpoint('song_download_url', { id: '7' })[1], { id: 7, br: 128000 })
  assert.equal(endpoint('song_download_url', { id: '7', br: 320000 })[1].br, 320000)
  const [dlPath, dlData, dlMode] = endpoint('song_download_url_v1', { id: '7', encodeType: 'flac', level: 'lossless' })
  assert.equal(dlPath, '/api/song/enhance/download/url/v1')
  assert.deepEqual(dlData, { id: 7, level: 'standard', encodeType: 'mp3' })
  assert.equal(dlMode, 'weapi')
})
test('CSP lets audio play only from the NetEase CDN', async () => {
  const csp = (await handleApi(new Request(origin + '/api/runtime'), {})).headers.get('Content-Security-Policy')
  assert.match(csp, /media-src 'self' https:\/\/\*\.music\.126\.net https:\/\/\*\.vod\.126\.net;/)
})

test('avatarUrl is forwarded from login_status and stripped of query params', async () => {
  const env = { SESSION_SECRET: secret }
  const token = await seal({ account: { uid: '1', nickname: 'Test' }, cookie: { MUSIC_U: 'fake' } }, secret, 'session', 60)
  const rpc = async () => ({ body: { profile: { userId: 1, nickname: 'Test', avatarUrl: '//p2.music.126.net/x/y.png?param=1' } }, cookie: {} })
  const body = await (await handleApi(req('/api/netease', { uid: '1', method: 'login_status' }, 'chuting_session=' + token), env, rpc)).json()
  assert.deepEqual(body, { account: { uid: '1', nickname: 'Test', avatarUrl: 'https://p2.music.126.net/x/y.png' } })
})

test('pickMatch finds the catalogue copy of an uploaded song by title and artist', () => {
  const songs = [
    { id: 1, name: '鳥の詩', ar: [{ name: 'Someone Else' }] },
    { id: 2, name: '鳥の詩', ar: [{ name: 'Lia' }] },
    { id: 3, name: '鳥の詩 (Remix)', ar: [{ name: 'Lia' }] }
  ]
  assert.equal(pickMatch(songs, '鳥の詩', 'Lia', 99).id, 2)
  assert.equal(pickMatch(songs, ' 鳥の詩 ', 'lia / Key', 99).id, 2)
  assert.equal(pickMatch(songs, '鳥の詩', 'Nobody', 99), null)
  assert.equal(pickMatch(songs, '鳥の詩', '未知歌手', 99).id, 1)
  assert.equal(pickMatch(songs, '鳥の詩', 'Lia', 2), null)
  assert.equal(pickMatch([], '鳥の詩', 'Lia', 99), null)
})

test('a lossless-only upload plays the matched catalogue MP3 instead', async () => {
  const secret = 'x'.repeat(32)
  const env = { SESSION_SECRET: secret }
  const token = await seal({ account: { uid: '1' }, cookie: { MUSIC_U: 'vip-session' } }, secret, 'session', 60)
  const ask = (rpc, query) => handleApi(req('/api/netease', { uid: '1', method: 'song_url', query }, 'chuting_session=' + token), env, rpc).then(r => r.json())
  const calls = []
  const body = await ask(async (method, query) => {
    calls.push([method, query.id || query.s])
    if (method === 'song_search') return { body: { code: 200, result: { songs: [{ id: 555, name: 'My Dearest', ar: [{ name: 'supercell' }] }] } }, cookie: {} }
    if (method === 'song_url' && query.id === '555') return { body: { code: 200, data: [{ id: 555, url: 'http://m801.music.126.net/cat.mp3', br: 128000, type: 'mp3', time: 290000, fee: 0, level: 'standard' }] }, cookie: {} }
    return { body: { code: 200, data: [{ id: 42, url: 'https://m701.music.126.net/up.m4a', br: 900000, type: 'm4a', time: 290000, fee: 0, level: 'lossless' }] }, cookie: {} }
  }, { id: '42', name: 'My Dearest', artist: 'supercell' })
  assert.equal(body.url, 'https://m801.music.126.net/cat.mp3')
  assert.equal(body.id, '42')
  assert.equal(body.matched, '555')
  assert.ok(calls.some(([m, s]) => m === 'song_search' && s === 'My Dearest supercell'))
  // No title sent: no search, the original answer stands.
  const plain = await ask(async (method) => ({ body: { code: 200, data: [{ id: 42, url: 'https://m701.music.126.net/up.m4a', br: 900000, type: 'm4a', time: 1, fee: 0, level: 'lossless' }] }, cookie: {} }), { id: '42' })
  assert.equal(plain.type, 'm4a')
})

test('hardAudio treats a tagged-lossless MP3 as playable and flags ape, ALAC and Dolby', () => {
  assert.equal(hardAudio({ url: 'https://m801.music.126.net/a.mp3', type: 'mp3', level: 'lossless', br: 320000 }), false)
  assert.equal(hardAudio({ url: 'https://m801.music.126.net/a.ape', type: 'ape', br: 850000 }), true)
  assert.equal(hardAudio({ url: 'https://m801.music.126.net/a.m4a', type: 'm4a', level: 'exhigh', br: 256000 }), false)
  assert.equal(hardAudio({ url: 'https://m801.music.126.net/a.m4a', type: 'm4a', encodeType: 'alac', level: 'lossless', br: 980000 }), true)
  assert.equal(hardAudio({ url: 'https://m801.music.126.net/a.m4a', type: 'm4a', level: 'jymaster', br: 900000 }), true)
})

test('playable reads a download-url object payload and encodeType', () => {
  const body = playable({ data: { id: 7, url: 'http://m7.music.126.net/x.mp3', br: 128000, encodeType: 'mp3', type: '', time: 1000 } }, 7)
  assert.equal(body.url, 'https://m7.music.126.net/x.mp3')
  assert.equal(body.type, 'mp3')
  assert.equal(body.encodeType, 'mp3')
})

test('cloudHint reads pc.sid, the uploaded filename, and cloud flags', () => {
  const hint = cloudHint({ t: 2, pc: { sid: 555, fn: 'demo-upload.APE' }, privilege: { cs: true } })
  assert.equal(hint.cloud, true)
  assert.equal(hint.sid, '555')
  assert.equal(hint.format, 'ape')
  assert.equal(cloudHint({ privilege: {} }).cloud, false)
})

test('a cloud upload with a different pc.sid plays that catalogue MP3', async () => {
  const secret = 'x'.repeat(32)
  const env = { SESSION_SECRET: secret }
  const token = await seal({ account: { uid: '1' }, cookie: { MUSIC_U: 'vip-session' } }, secret, 'session', 60)
  const ask = (rpc, query) => handleApi(req('/api/netease', { uid: '1', method: 'song_url', query }, 'chuting_session=' + token), env, rpc).then(r => r.json())
  const calls = []
  const body = await ask(async (method, query) => {
    calls.push([method, String(query.id || query.ids || query.s || '')])
    if (method === 'song_detail') return { body: { code: 200, songs: [{ id: 42, pc: { sid: 555, fn: 'demo.flac' }, privilege: { cs: true } }] }, cookie: {} }
    if (method === 'song_url' && String(query.id) === '555') return { body: { code: 200, data: [{ id: 555, url: 'http://m801.music.126.net/cat.mp3', br: 128000, type: 'mp3', time: 233000, fee: 0, level: 'standard' }] }, cookie: {} }
    return { body: { code: 200, data: [{ id: 42, url: 'https://m701.music.126.net/up.flac', br: 980000, type: 'flac', time: 233000, fee: 0, level: 'lossless' }] }, cookie: {} }
  }, { id: '42' })
  assert.equal(body.url, 'https://m801.music.126.net/cat.mp3')
  assert.equal(body.id, '42')
  assert.equal(body.matched, '555')
  assert.ok(calls.some(([m, s]) => m === 'song_detail' && s === '42'))
  assert.ok(calls.some(([m, s]) => m === 'song_url' && s === '555'))
  assert.equal(calls.some(([m]) => m === 'song_search'), false)
})

test('a same-id cloud overlay uses the transcoded download URL', async () => {
  const secret = 'x'.repeat(32)
  const env = { SESSION_SECRET: secret }
  const token = await seal({ account: { uid: '1' }, cookie: { MUSIC_U: 'vip-session' } }, secret, 'session', 60)
  const ask = (rpc, query) => handleApi(req('/api/netease', { uid: '1', method: 'song_url', query }, 'chuting_session=' + token), env, rpc).then(r => r.json())
  const calls = []
  const body = await ask(async (method, query) => {
    calls.push(method)
    if (method === 'song_detail') return { body: { code: 200, songs: [{ id: 42, pc: { sid: 42, fn: 'demo.ape' }, privilege: { cs: true }, t: 2 }] }, cookie: {} }
    if (method === 'song_download_url') return { body: { code: 200, data: { id: 42, url: 'http://m7.music.126.net/trans.mp3', br: 128000, type: 'mp3', time: 233000, fee: 0, level: 'standard' } }, cookie: {} }
    if (method === 'song_search') return { body: { code: 200, result: { songs: [{ id: 42, name: 'Fixture', ar: [{ name: 'Demo' }] }] } }, cookie: {} }
    return { body: { code: 200, data: [{ id: 42, url: 'https://m701.music.126.net/up.ape', br: 850000, type: 'ape', time: 233000, fee: 0, level: 'lossless' }] }, cookie: {} }
  }, { id: '42', name: 'Fixture', artist: 'Demo' })
  assert.equal(body.url, 'https://m7.music.126.net/trans.mp3')
  assert.equal(body.type, 'mp3')
  assert.ok(calls.includes('song_download_url'))
})

test('an unmatched hard cloud file is marked with its uploaded format', async () => {
  const secret = 'x'.repeat(32)
  const env = { SESSION_SECRET: secret }
  const token = await seal({ account: { uid: '1' }, cookie: { MUSIC_U: 'vip-session' } }, secret, 'session', 60)
  const ask = (rpc, query) => handleApi(req('/api/netease', { uid: '1', method: 'song_url', query }, 'chuting_session=' + token), env, rpc).then(r => r.json())
  const body = await ask(async (method) => {
    if (method === 'song_detail') return { body: { code: 200, songs: [{ id: 42, pc: { sid: 0, fn: 'unmatched.APE' }, privilege: { cs: true } }] }, cookie: {} }
    if (method === 'song_search') return { body: { code: 200, result: { songs: [] } }, cookie: {} }
    return { body: { code: 200, data: [{ id: 42, url: 'https://m701.music.126.net/up.ape', br: 850000, type: 'ape', time: 233000, fee: 0, level: 'lossless' }] }, cookie: {} }
  }, { id: '42', name: 'Fixture Three', artist: 'Demo' })
  assert.equal(body.type, 'ape')
  assert.equal(body.cloud, true)
  assert.equal(body.format, 'ape')
  assert.match(body.url, /up\.ape/)
})
