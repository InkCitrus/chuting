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
// Stamp the service worker with a hash of everything it serves, so each deploy gets a fresh offline cache.
const digest = createHash('sha256')
async function hashTree(dir) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await hashTree(full)
    else if (entry.name !== 'sw.js') digest.update(path.relative(output, full)).update(await readFile(full))
  }
}
await hashTree(output)
const swPath = path.join(output, 'sw.js'), version = digest.digest('hex').slice(0, 12)
const sw = await readFile(swPath, 'utf8')
if (!sw.includes("'__BUILD__'")) throw new Error('sw.js is missing its version placeholder')
await writeFile(swPath, sw.replace("'__BUILD__'", `'${version}'`))
const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js')
const result = spawnSync(process.execPath, [wrangler, 'pages', 'functions', 'build', 'functions',
  '--outdir', 'dist/pages/_worker.js', '--compatibility-date', '2026-11-03', '--compatibility-flag', 'nodejs_compat'],
{ cwd: root, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status || 1)
if (!(await stat(path.join(output, '_worker.js/index.js'))).isFile()) throw new Error('Pages Worker bundle is missing')
console.log(`Pages build ready: dist/pages (static assets + bundled Functions), offline cache ${version}`)
