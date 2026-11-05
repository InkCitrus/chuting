// Cloudflare Pages alternative; the same API is used by Workers Static Assets.
import { handleApi } from '../../cloudflare/worker.mjs'
export function onRequest(context) { return handleApi(context.request, context.env) }
