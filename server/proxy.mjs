// Fallback for the Pages Functions proxy: the same handleApi (cloudflare/worker.mjs) on node:http, meant to
// run behind a TLS reverse proxy with access logs off. Stateless: the page sends its session as a relay
// token (Authorization header) sealed with SHARED_SESSION_SECRET, so nothing about an account is stored
// here, and nothing per request is logged.
//
// Environment:
//   SHARED_SESSION_SECRET  same value as the Pages project secret (≥ 32 chars)
//   PUBLIC_ORIGIN          this proxy's own https origin (the Host header is never trusted)
//   ALLOWED_ORIGINS        page origin(s) allowed to call it, comma-separated
//   HOST / PORT            listen address, default 127.0.0.1:8790
import http from 'node:http'
import { handleApi } from '../cloudflare/worker.mjs'

const MAX_BODY = 16 * 1024
export function config(source = process.env) {
  const env = {
    SHARED_SESSION_SECRET: source.SHARED_SESSION_SECRET || '',
    ALLOWED_ORIGINS: source.ALLOWED_ORIGINS || '',
  }
  if (!source.PUBLIC_ORIGIN) throw new Error('PUBLIC_ORIGIN is required')
  const origin = new URL(source.PUBLIC_ORIGIN)
  if (origin.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(origin.hostname)) throw new Error('PUBLIC_ORIGIN must be https')
  return { env, origin: origin.origin, port: Number(source.PORT) || 8790, host: source.HOST || '127.0.0.1' }
}
function allowed(env, origin) { return Boolean(origin) && env.ALLOWED_ORIGINS.split(',').map(x => x.trim()).includes(origin) }
export function corsHeaders(env, origin) {
  if (!allowed(env, origin)) return {}
  // No credentials mode: the session travels in the Authorization header, never as a cross-site cookie.
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
}
// Turns a node request into a fetch Request on this proxy's fixed public origin (the Host header is not
// trusted), runs handleApi, and adds CORS for the allowed page origin only.
export async function handle(req, cfg, upstream) {
  const origin = req.headers.origin || ''
  const cors = corsHeaders(cfg.env, origin)
  const path = (req.url || '/').split('?')[0]
  if (path === '/healthz') return new Response('ok', { headers: { 'Cache-Control': 'no-store' } })
  if (!path.startsWith('/api/')) return new Response('not found', { status: 404 })
  if (req.method === 'OPTIONS') {
    if (!cors['Access-Control-Allow-Origin']) return new Response(null, { status: 403 })
    return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' } })
  }
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > MAX_BODY) return Response.json({ error: '请求过大', code: 413 }, { status: 413, headers: cors })
    chunks.push(chunk)
  }
  const headers = new Headers()
  for (const name of ['content-type', 'origin', 'authorization']) if (req.headers[name]) headers.set(name, String(req.headers[name]))
  const request = new Request(cfg.origin + path, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) })
  const response = await handleApi(request, cfg.env, upstream, null)
  for (const [k, v] of Object.entries(cors)) response.headers.set(k, v)
  return response
}
async function send(res, response) {
  const headers = {}
  // Cookies are not used across origins; Set-Cookie from login answers is dropped here.
  for (const [k, v] of response.headers) if (k !== 'set-cookie') headers[k] = v
  res.writeHead(response.status, headers)
  res.end(Buffer.from(await response.arrayBuffer()))
}
export function createServer(cfg = config(), upstream) {
  return http.createServer((req, res) => {
    handle(req, cfg, upstream).then(response => send(res, response)).catch(() => {
      // No request details: the body and cookie may hold a session.
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end('{"error":"接口处理失败，请稍后重试","code":500}')
    })
  })
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = config()
  if (cfg.env.SHARED_SESSION_SECRET.length < 32) { console.error('SHARED_SESSION_SECRET is missing (≥ 32 chars)'); process.exit(1) }
  createServer(cfg).listen(cfg.port, cfg.host, () => console.log(`chuting proxy listening on ${cfg.host}:${cfg.port}`))
}
