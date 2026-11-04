'use strict'
// Only this process touches the login cookie. Its stdout is a JSON-lines protocol.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const readline = require('node:readline')
for (const name of ['log', 'info', 'warn', 'error', 'debug']) console[name] = () => {}

function nativeCookies() {
  if (process.env.NETEASE_COOKIE) {
    return Object.fromEntries(process.env.NETEASE_COOKIE.split(';').map(s => {
      const i = s.indexOf('=')
      return i > 0 ? [s.slice(0, i).trim(), s.slice(i + 1).trim()] : ['', '']
    }).filter(([k]) => k))
  }
  const file = path.join(os.homedir(), 'Library/HTTPStorages/com.netease.163music.binarycookies')
  const buf = fs.readFileSync(file)
  if (buf.subarray(0, 4).toString() !== 'cook') throw new Error('COOKIE_FORMAT')
  const count = buf.readUInt32BE(4)
  let cursor = 8 + count * 4
  const result = {}
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32BE(8 + i * 4)
    const page = buf.subarray(cursor, cursor + size)
    cursor += size
    for (let j = 0; j < page.readUInt32LE(4); j++) {
      const off = page.readUInt32LE(8 + j * 4)
      const raw = page.subarray(off, off + page.readUInt32LE(off))
      const str = at => {
        const start = raw.readUInt32LE(at)
        const end = raw.indexOf(0, start)
        if (start >= raw.length || end < start) throw new Error('COOKIE_FORMAT')
        return raw.subarray(start, end).toString()
      }
      if (!['music.163.com', '.music.163.com'].includes(str(16))) continue
      const name = str(20)
      if (['MUSIC_U', '__csrf', 'NMTID'].includes(name)) result[name] = str(28)
    }
  }
  return result
}

const allowed = new Set(['login_status', 'record_recent_song', 'user_record', 'likelist',
  'user_playlist', 'playlist_detail', 'song_detail', 'music_first_listen_info'])
let apiRoot, request, cookie
function initialize() {
  if (request) return
  try {
    apiRoot = process.env.NCM_API_MODULE_PATH || path.dirname(require.resolve('@neteasecloudmusicapienhanced/api/package.json'))
  } catch { throw new Error('DEPENDENCY_MISSING') }
  try { cookie = nativeCookies() } catch { throw new Error('LOGIN_MISSING') }
  if (!cookie.MUSIC_U) throw new Error('LOGIN_MISSING')
  cookie.os = cookie.os || 'osx'
  cookie.appver = cookie.appver || '3.1.10.5100'
  // Keep the authenticated transport's optional anonymous-token file task-local.
  fs.mkdirSync(os.tmpdir(), { recursive: true, mode: 0o700 })
  const tokenFile = path.join(os.tmpdir(), 'anonymous_token')
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, '', { mode: 0o600 })
  request = require(path.join(apiRoot, 'util/request.js'))
}

async function handle(input) {
  if (!allowed.has(input.method)) throw new Error('METHOD_NOT_ALLOWED')
  initialize()
  const module = require(path.join(apiRoot, 'module', input.method + '.js'))
  const response = await module({ ...(input.query || {}), cookie, timeout: 15000, e_r: false }, request)
  let body = response.body
  if (input.method === 'login_status') {
    const profile = body.data?.profile
    body = { code: body.data?.code || body.code, account: profile ? { uid: String(profile.userId), nickname: profile.nickname } : null }
  }
  return body
}

const lines = readline.createInterface({ input: process.stdin })
// Chain requests to prevent cookie/session mixing and uncontrolled concurrency.
let sequence = Promise.resolve()
lines.on('line', line => {
  sequence = sequence.then(async () => {
    let input
    try {
      input = JSON.parse(line)
      const body = await handle(input)
      process.stdout.write(JSON.stringify({ id: input.id, body }) + '\n')
    } catch (err) {
      const known = ['DEPENDENCY_MISSING', 'LOGIN_MISSING', 'METHOD_NOT_ALLOWED']
      const code = Number(err.body?.code || err.status) || 0
      const error = known.includes(err.message) ? err.message : 'UPSTREAM_ERROR'
      // Do not serialize upstream exceptions: they may contain request cookies.
      process.stdout.write(JSON.stringify({ id: input?.id, error, code }) + '\n')
    }
  })
})
