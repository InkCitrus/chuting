import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createDecipheriv } from 'node:crypto'
import { eapi, weapi, endpoint, ApiError, callNetease } from '../cloudflare/netease.mjs'
import { seal, unseal, sessionCookie } from '../cloudflare/session.mjs'
import { handleApi } from '../cloudflare/worker.mjs'
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
test('QR login returns only account and an encrypted HttpOnly credential', async () => {
  const rpc = async method => method === 'qr_key' ? { body: { unikey: 'qr-fixture' } }
    : method === 'qr_check' ? { body: { code: 803 }, cookie: { MUSIC_U: 'sensitive-fixture' } }
      : { body: { profile: { userId: 1, nickname: 'Test' } } }
  const env = { SESSION_SECRET: secret }
  const keyResponse = await handleApi(req('/api/auth/key'), env, rpc), key = await keyResponse.json()
  assert.match(key.image, /^data:image\/svg\+xml/)
  const login = await handleApi(req('/api/auth/check', { ticket: key.ticket }), env, rpc)
  assert.deepEqual(await login.json(), { code: 803, account: { uid: '1', nickname: 'Test' } })
  assert.ok(!login.headers.get('Set-Cookie').includes('sensitive-fixture'))
  assert.match(login.headers.get('Cache-Control'), /no-store/)
})
test('transport maps HTTP rate limit and does not expose upstream error', async () => {
  await assert.rejects(callNetease('music_first_listen_info', { id: '1' }, {}, '1', async () => Response.json({ code: 429, message: 'credential-secret' }, { status: 429 })), err => err instanceof ApiError && err.code === 429 && !err.message.includes('secret'))
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
