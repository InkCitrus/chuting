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
export function sessionCookie(request, value, age = 604800) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `chuting_session=${value}; Path=/api/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`
}
export async function getSession(request, secret) {
  const token = (request.headers.get('Cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith('chuting_session='))?.slice(16)
  return unseal(token, secret, 'session')
}
