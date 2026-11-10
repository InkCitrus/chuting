import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = path.join(root, 'dist/pages')
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
// Only the web directory is ever published. Account data and local secrets are
// outside this explicit source boundary, including when building on a used PC.
for (const entry of await readdir(path.join(root, 'web'), { withFileTypes: true })) {
  if (entry.name.startsWith('.')) continue
  await cp(path.join(root, 'web', entry.name), path.join(output, entry.name), { recursive: true })
}
// Fallback proxies (used when Functions are out of quota or rate limited) come from the build environment,
// so the repository names no hosts: CHUTING_FALLBACK_ORIGINS="https://api1.example.com,https://api2.example.com".
const fallbacks = String(process.env.CHUTING_FALLBACK_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean)
for (const origin of fallbacks) if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) throw new Error(`CHUTING_FALLBACK_ORIGINS: not an https origin: ${origin}`)
{
  const transportPath = path.join(output, 'transport.js'), headersPath = path.join(output, '_headers')
  const transport = await readFile(transportPath, 'utf8')
  if (!transport.includes("'__FALLBACK_ORIGINS__'")) throw new Error('transport.js is missing its fallback placeholder')
  await writeFile(transportPath, transport.replace("'__FALLBACK_ORIGINS__'", JSON.stringify(fallbacks.join(','))))
  if (fallbacks.length) {
    const headers = await readFile(headersPath, 'utf8')
    if (!/connect-src [^;\n]*;/.test(headers)) throw new Error('_headers is missing connect-src')
    await writeFile(headersPath, headers.replace(/(connect-src [^;\n]*);/, `$1 ${fallbacks.join(' ')};`))
  }
}
// Stamp the service worker with a hash of everything it serves, so each deploy gets a fresh offline cache.
const digest = createHash('sha256')
async function hashTree(dir) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await hashTree(full)
    else digest.update(path.relative(output, full)).update(await readFile(full)) // include sw.js so strategy changes bump VERSION
  }
}
await hashTree(output)
const swPath = path.join(output, 'sw.js'), version = digest.digest('hex').slice(0, 12)
const sw = await readFile(swPath, 'utf8')
if (!sw.includes("'__BUILD__'")) throw new Error('sw.js is missing its version placeholder')
await writeFile(swPath, sw.replace("'__BUILD__'", `'${version}'`))
// Append ?v=<stamp> to every module / stylesheet URL the page and its imports use, so a zone-level
// cache that ignores _headers cannot mix an old app.js with a new rotator.js (or the reverse).
const bust = `?v=${version}`
const stampHtml = text => text.replace(/(href|src)="(\/(?:app|backend|transport|browser-store|browser-sync|archive-core|insights|share|rotator|copy|player|capsule|travel|theme|styles)\.[^"]+)"/g,
  (_, attr, url) => `${attr}="${url.includes('?') ? url : url + bust}"`)
const stampJs = text => text.replace(/(from\s+|import\s*\(\s*)(['"])(\.\/[^'"]+\.js)\2/g,
  (_, pre, q, url) => `${pre}${q}${url.includes('?') ? url : url + bust}${q}`)
for (const entry of await readdir(output, { withFileTypes: true })) {
  if (!entry.isFile()) continue
  const full = path.join(output, entry.name)
  if (entry.name === 'index.html') await writeFile(full, stampHtml(await readFile(full, 'utf8')))
  else if (entry.name.endsWith('.js') && entry.name !== 'sw.js') await writeFile(full, stampJs(await readFile(full, 'utf8')))
}
const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js')
const result = spawnSync(process.execPath, [wrangler, 'pages', 'functions', 'build', 'functions',
  '--outdir', 'dist/pages/_worker.js', '--compatibility-date', '2026-11-03', '--compatibility-flag', 'nodejs_compat'],
{ cwd: root, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status || 1)
if (!(await stat(path.join(output, '_worker.js/index.js'))).isFile()) throw new Error('Pages Worker bundle is missing')
console.log(`Pages build ready: dist/pages (static assets + bundled Functions), offline cache ${version}`)
