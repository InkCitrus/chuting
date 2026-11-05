import test from 'node:test'
import assert from 'node:assert/strict'
import { configurePages } from '../scripts/configure-pages.mjs'
const accountId = 'a'.repeat(32), apiToken = 'fixture-token'
test('deployment retains existing runtime key without changing the project', async () => {
  let calls = 0
  const result = await configurePages({ accountId, apiToken,
    fetcher: async (_url, options) => {
      calls++; assert.equal(options.method, undefined)
      return Response.json({ success: true, result: { deployment_configs: { production: { env_vars: { SESSION_SECRET: { type: 'secret_text', value: '' } } } } } })
    }, putSecret: async () => assert.fail('must retain existing session key') })
  assert.equal(calls, 1); assert.equal(result.createdSecret, false)
})
test('first deployment creates only the named project and a random key', async () => {
  let calls = 0, secret
  const result = await configurePages({ accountId, apiToken,
    fetcher: async (url, options) => {
      calls++; assert.equal(options.headers.Authorization, 'Bearer fixture-token')
      assert.ok(url.startsWith('https://api.cloudflare.com/client/v4/'))
      if (calls === 1) return new Response('', { status: 404 })
      assert.equal(options.method, 'POST')
      assert.deepEqual(JSON.parse(options.body), { name: 'chuting', production_branch: 'main' })
      return Response.json({ success: true, result: { name: 'chuting' } })
    }, putSecret: async value => { secret = value } })
  assert.equal(calls, 2); assert.equal(result.createdSecret, true)
  assert.equal(Buffer.from(secret, 'base64url').length, 48)
})
test('deployment never creates resources when authorization fails', async () => {
  let calls = 0
  await assert.rejects(configurePages({ accountId, apiToken, fetcher: async () => { calls++; return Response.json({ success: false }, { status: 403 }) }, putSecret: async () => assert.fail() }), /HTTP 403/)
  assert.equal(calls, 1)
})
