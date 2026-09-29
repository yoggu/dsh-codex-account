import { randomUUID } from 'node:crypto'

// The shipped llm-pi-ai adapter owns both the OAuth flow and its grant record.
// This plugin provides a user-operated Web surface, not another LLM adapter or store.
export const name = 'dsh-codex-account'
export const inject = ['authorization', 'credentials', 'configEditor', 'connection']
export const KEY = 'llm-pi-ai/openai-codex'
export const PATH = '/api/dsh-codex-account'
const PROVIDER = 'openai-codex'
const DEADLINE_MS = 10 * 60_000
const json = (value, status = 200) => Response.json(value, { status, headers: {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
} })
const failure = cause => ['NO_FLOW', 'UNKNOWN_METHOD', 'ALREADY_IN_FLIGHT', 'NOT_COMMITTED']
  .includes(cause?.code) ? cause.code : 'authorization-failed'
const notice = value => {
  const message = typeof value?.message === 'string' ? value.message.slice(0, 2000) : 'Continue signing in.'
  const code = typeof value?.code === 'string' ? value.code.slice(0, 128) : undefined
  let url
  try {
    const target = new URL(value?.url)
    if (target.protocol === 'https:' && ['openai.com', 'chatgpt.com'].some(host =>
      target.hostname === host || target.hostname.endsWith(`.${host}`))) url = target.href
  } catch { /* Never turn an unexpected provider URL into a clickable link. */ }
  return { message, ...(url ? { url } : {}), ...(code ? { code } : {}) }
}
const visiblePrompt = value => ({ kind: value.kind,
  message: typeof value.message === 'string' ? value.message.slice(0, 2000) : 'Continue signing in.',
  ...(typeof value.placeholder === 'string' ? { placeholder: value.placeholder.slice(0, 200) } : {}),
  ...(value.kind === 'select' ? { options: (value.options ?? []).slice(0, 20).map(option => ({
    id: option.id, label: option.label, description: option.description })) } : {}),
})

function providerEntry(ctx) {
  return ctx.configEditor.entries().find(entry => entry.options?.id === 'llm-pi-ai' && entry.fiber?.state === 2)
}
export function providerPresent(ctx) {
  const row = ctx.configEditor.configuration().find(item => item.entry.options?.id === 'llm-pi-ai')
  const providers = row?.override?.providers ?? row?.inherited?.providers
  return !!providers && Object.hasOwn(providers, PROVIDER)
}
export async function ensureProvider(ctx) {
  if (providerPresent(ctx)) return false
  const entry = providerEntry(ctx)
  if (!entry) throw new Error('llm-pi-ai configuration unavailable')
  await ctx.configEditor.edit(entry, (current, inherited) => {
    const providers = current.providers ?? inherited.providers ?? {}
    if (Object.hasOwn(providers, PROVIDER)) return current
    return { ...current, providers: { ...providers, [PROVIDER]: {} } }
  })
  if (!providerPresent(ctx)) throw new Error('provider configuration was not persisted')
  return true
}

export function apply(ctx) {
  let current = null
  let disposed = false
  // Exclude local credential/configuration mutations before their first await.
  let mutation = false
  const locallyBusy = () => mutation || current?.status === 'pending' || current?.status === 'configuring'
  const authorizationBusy = () => !!ctx.authorization.describe(KEY)?.inFlight
  const clearPrompt = attempt => {
    const pending = attempt.prompt
    if (!pending) return
    attempt.prompt = null
    pending.signal?.removeEventListener('abort', pending.onAbort)
  }
  const cancel = attempt => {
    if (!attempt || attempt.status !== 'pending') return
    if (attempt.prompt) {
      const pending = attempt.prompt
      clearPrompt(attempt)
      pending.reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }))
    }
    ctx.authorization.cancel(KEY)
    attempt.status = 'cancelled'
    clearTimeout(attempt.timer)
  }
  const status = attempt => ({ status: attempt.status, notices: attempt.notices,
    prompt: attempt.prompt ? visiblePrompt(attempt.prompt.value) : null,
    ...(attempt.error ? { error: attempt.error } : {}),
  })
  const registration = ctx.connection.fetch.register({ path: PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: async request => {
      if (disposed) return json({ error: 'unavailable' }, 503)
      if (request.method === 'GET') {
        const id = new URL(request.url).searchParams.get('id')
        if (id) return current?.id === id ? json(status(current)) : json({ error: 'attempt-not-found' }, 404)
        try {
          const flow = ctx.authorization.describe(KEY)
          const record = await ctx.credentials.describeRecord(KEY) // Presence only; never read a grant payload.
          return json({ flowAvailable: !!flow?.methods?.some(method => method.id === 'oauth'),
            credentialPresent: record.configured && record.kind === 'grant',
            providerPresent: providerPresent(ctx), inFlight: !!flow?.inFlight })
        } catch { return json({ error: 'status-unavailable' }, 503) }
      }
      let body
      try { body = await request.json() } catch { return json({ error: 'invalid-json' }, 400) }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'invalid-action' }, 400)
      if (body.action === 'sign-out') {
        if (locallyBusy()) return json({ error: 'already-in-flight' }, 409)
        mutation = true
        try {
          if (authorizationBusy()) return json({ error: 'already-in-flight' }, 409)
          const record = await ctx.credentials.describeRecord(KEY) // Metadata only, including the grant discriminant.
          if (disposed) return json({ error: 'unavailable' }, 503)
          // Another surface may have begun OAuth while presence was being inspected.
          if (authorizationBusy()) return json({ error: 'already-in-flight' }, 409)
          // deleteRecord is idempotent; modifyRecord returning undefined does NOT delete.
          if (record.configured && record.kind === 'grant') await ctx.credentials.deleteRecord(KEY)
          return json({ status: 'signed-out' })
        } catch { return json({ error: 'sign-out-failed' }, 503) }
        finally { mutation = false }
      }
      if (body.action === 'start') {
        if (locallyBusy()) return json({ error: 'already-in-flight' }, 409)
        try {
          const flow = ctx.authorization.describe(KEY)
          if (flow?.inFlight) return json({ error: 'already-in-flight' }, 409)
          if (!flow?.methods?.some(method => method.id === 'oauth')) return json({ error: 'flow-unavailable' }, 503)
        } catch { return json({ error: 'flow-unavailable' }, 503) }
        const attempt = { id: randomUUID(), status: 'pending', notices: [], prompt: null, error: null, timer: null }
        current = attempt
        attempt.timer = setTimeout(() => cancel(attempt), DEADLINE_MS)
        // Do not await the human interaction inside an HTTP request. The browser
        // polls notices and answers prompts; no credential is handled here.
        void ctx.authorization.begin({ key: KEY, method: 'oauth', interaction: {
          notify(value) {
            if (attempt.status === 'pending') attempt.notices = [...attempt.notices.slice(-9), notice(value)]
          },
          prompt(value) {
            if (attempt.status !== 'pending') return Promise.reject(new Error('Cancelled'))
            return new Promise((resolve, reject) => {
              const pending = { value, resolve, reject, signal: value.signal, onAbort: null }
              pending.onAbort = () => {
                if (attempt.prompt === pending) clearPrompt(attempt)
                reject(Object.assign(new Error('Prompt cancelled'), { name: 'AbortError' }))
              }
              attempt.prompt = pending
              value.signal?.addEventListener('abort', pending.onAbort, { once: true })
              if (value.signal?.aborted) pending.onAbort()
            })
          },
        } }).then(async result => {
          if (attempt.status !== 'pending') return
          if (result.status !== 'authorized') { attempt.status = result.status; return }
          attempt.status = 'configuring' // Grant committed; cancellation can no longer undo sign-in.
          try {
            await ensureProvider(ctx) // User-triggered completion, never plugin activation / nested HMR.
            if (attempt.status === 'configuring') attempt.status = 'authorized'
          } catch {
            if (attempt.status === 'configuring') {
              attempt.status = 'provider-error'
              attempt.error = 'provider-configuration-failed'
            }
          }
        }, cause => {
          if (attempt.status === 'pending') { attempt.status = 'failed'; attempt.error = failure(cause) }
        }).finally(() => {
          clearTimeout(attempt.timer)
          if (attempt.prompt) {
            const pending = attempt.prompt
            clearPrompt(attempt)
            pending.reject(Object.assign(new Error('Attempt ended'), { name: 'AbortError' }))
          }
        })
        return json({ id: attempt.id, ...status(attempt) })
      }
      if (body.action === 'ensure-provider') {
        if (locallyBusy()) return json({ error: 'already-in-flight' }, 409)
        mutation = true
        try {
          if (authorizationBusy()) return json({ error: 'already-in-flight' }, 409)
          const record = await ctx.credentials.describeRecord(KEY)
          if (disposed) return json({ error: 'unavailable' }, 503)
          if (authorizationBusy()) return json({ error: 'already-in-flight' }, 409)
          if (!record.configured || record.kind !== 'grant') return json({ error: 'sign-in-required' }, 409)
          const added = await ensureProvider(ctx)
          return json({ providerPresent: true, added })
        } catch { return json({ error: 'provider-configuration-failed' }, 503) }
        finally { mutation = false }
      }
      if (typeof body.id !== 'string' || current?.id !== body.id) return json({ error: 'attempt-not-found' }, 404)
      if (body.action === 'cancel') { cancel(current); return json(status(current)) }
      if (body.action === 'answer') {
        const attempt = current, pending = attempt.prompt
        if (attempt.status !== 'pending' || !pending) return json({ error: 'no-prompt' }, 409)
        if (typeof body.value !== 'string' || body.value.length > 4096) return json({ error: 'invalid-answer' }, 400)
        if (pending.value.kind === 'select' && !pending.value.options?.some(option => option.id === body.value))
          return json({ error: 'invalid-answer' }, 400)
        clearPrompt(attempt)
        pending.resolve(body.value)
        return json(status(attempt))
      }
      return json({ error: 'invalid-action' }, 400)
    },
  })
  ctx.effect(() => async () => {
    disposed = true
    cancel(current)
    const unregister = await Promise.resolve(registration).catch(() => null)
    await unregister?.()
  }, 'Codex account bridge')
}
