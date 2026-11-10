const encoder = new TextEncoder()
async function key(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('SESSION_SECRET 未配置（至少 32 字符）')
  return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(secret)), 'AES-GCM', false, ['encrypt', 'decrypt'])
}
export async function seal(value, secret, purpose, seconds) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(purpose) }, await key(secret), encoder.encode(JSON.stringify({ ...value, exp: Date.now() + seconds * 1000 })))
  return Buffer.concat([Buffer.from(iv), Buffer.from(encrypted)]).toString('base64url')
}
export async function unseal(token, secret, purpose) {
  try {
    if (typeof token !== 'string' || token.length > 6000) return null
    const raw = Buffer.from(token, 'base64url')
    const decoded = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: encoder.encode(purpose) }, await key(secret), raw.subarray(12))
    const value = JSON.parse(new TextDecoder().decode(decoded))
    return value.exp > Date.now() ? value : null
  } catch { return null }
}
// Failover: the Pages Functions and the fallback proxies share SHARED_SESSION_SECRET, so a session sealed by
// one opens on the others. SESSION_SECRET stays readable so sessions sealed before the switch keep working.
const usable = s => typeof s === 'string' && s.length >= 32
export function sealingSecret(env = {}) { return usable(env.SHARED_SESSION_SECRET) ? env.SHARED_SESSION_SECRET : usable(env.SESSION_SECRET) ? env.SESSION_SECRET : null }
export function openingSecrets(env = {}) { return [...new Set([env.SHARED_SESSION_SECRET, env.SESSION_SECRET].filter(usable))] }
export async function unsealAny(token, env, purpose) {
  for (const secret of openingSecrets(env)) {
    const value = await unseal(token, secret, purpose)
    if (value) return value
  }
  return null
}
export function sessionCookie(request, value, age = 604800) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `chuting_session=${value}; Path=/api/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`
}
// Two ways to carry a session: the HttpOnly cookie (same origin, Pages Functions), and a relay token in an
// Authorization header, which the page sends only to the fallback proxies on other hosts (no cross-site
// cookies needed). The relay token is the same sealed session under a different purpose and expiry.
export async function getSession(request, envOrSecret) {
  const env = typeof envOrSecret === 'string' ? { SESSION_SECRET: envOrSecret } : envOrSecret || {}
  const tokens = (request.headers.get('Cookie') || '').split(';').map(x => x.trim()).filter(x => x.startsWith('chuting_session=')).map(x => x.slice(16))
  for (const token of tokens) { const value = await unsealAny(token, env, 'session'); if (value) return value }
  const bearer = /^Bearer ([\w-]{20,6000})$/.exec(request.headers.get('Authorization') || '')?.[1]
  return bearer ? unsealAny(bearer, env, 'relay') : null
}
export async function relayToken(session, secret) {
  const left = Math.floor((session.exp - Date.now()) / 1000)
  return left > 5 ? seal({ account: session.account, cookie: session.cookie }, secret, 'relay', left) : null
}
