import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// One-time bootstrap for CI. Runtime keys stay in Cloudflare and are never
// regenerated on normal deployments or copied into GitHub/build artifacts.
export async function configurePages({ accountId, apiToken, project = 'chuting', fetcher = fetch, putSecret }) {
  if (!/^[a-f0-9]{32}$/.test(accountId || '') || !apiToken) throw new Error('Cloudflare Actions credentials are missing or invalid')
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects`
  async function request(suffix, options = {}) {
    const response = await fetcher(url + suffix, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' } })
    if (response.status === 404 && !options.method) return null
    const body = await response.json()
    if (!response.ok || !body.success) throw new Error(`Cloudflare project operation failed (HTTP ${response.status})`)
    return body.result
  }
  let existing = await request('/' + project)
  if (!existing) existing = await request('', { method: 'POST', body: JSON.stringify({ name: project, production_branch: 'main' }) })
  if (existing.deployment_configs?.production?.env_vars?.SESSION_SECRET) return { createdSecret: false }
  await putSecret(randomBytes(48).toString('base64url'))
  return { createdSecret: true }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await configurePages({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID, apiToken: process.env.CLOUDFLARE_API_TOKEN,
      putSecret: async value => {
        const run = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'pages', 'secret', 'put', 'SESSION_SECRET', '--project-name', 'chuting'],
          { input: value + '\n', encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
        if (run.error || run.status !== 0) throw new Error('Cloudflare SESSION_SECRET setup failed; check Pages edit permission')
      } })
    console.log(result.createdSecret ? 'Pages project ready; created runtime SESSION_SECRET.' : 'Pages project ready; retained existing runtime SESSION_SECRET.')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
