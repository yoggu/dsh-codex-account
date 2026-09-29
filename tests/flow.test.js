import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, ensureProvider, providerPresent, KEY, PATH } from '../index.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const busyResponse = { status: 409, value: { error: 'already-in-flight' } }
const signedOutResponse = { status: 200, value: { status: 'signed-out' } }
function harness(options = {}) {
  const providerConfig = { providers: options.providers ?? { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' } } }
  const entry = { options: { id: 'llm-pi-ai' }, fiber: { state: 2 } }
  let flow = options.flow ?? (async () => ({ status: 'authorized' }))
  let route, cleanup, editCount = 0, began = 0, cancelled = 0, inFlight = options.inFlight ?? false
  const deleted = []
  const records = new Map([
    ['llm-pi-ai/another-provider', { kind: 'grant' }],
    ['another-adapter/openai-codex', { kind: 'grant' }],
  ])
  if (options.credentialPresent ?? true) records.set(KEY, { kind: options.recordKind ?? 'grant' })
  const ctx = {
    configEditor: {
      entries: () => [entry],
      configuration: () => [{ entry, override: providerConfig, inherited: {} }],
      async edit(target, change) {
        assert.equal(target, entry)
        editCount++
        if (options.failEdit) throw Error('do not expose upstream error')
        if (options.editGate) await options.editGate
        Object.assign(providerConfig, change({ ...providerConfig }, {}))
      },
    },
    authorization: {
      describe: key => {
        assert.equal(key, KEY)
        if (options.failAuthorizationDescribe) throw options.failAuthorizationDescribe
        return { methods: [{ id: 'oauth' }], inFlight }
      },
      cancel: key => (assert.equal(key, KEY), cancelled++),
      begin: request => { assert.equal(request.key, KEY); assert.equal(request.method, 'oauth'); began++; return flow(request) },
    },
    credentials: {
      async describeRecord(key) {
        assert.equal(key, KEY)
        if (options.failDescribe) throw options.failDescribe
        if (options.describeGate) await options.describeGate
        const record = records.get(key)
        return { configured: !!record, ...(record ? { kind: record.kind } : {}), writable: true }
      },
      async deleteRecord(key) {
        assert.equal(key, KEY)
        deleted.push(key)
        if (options.failDelete) throw options.failDelete
        if (options.deleteGate) await options.deleteGate
        records.delete(key)
      },
      readRecord: () => assert.fail('Never read credential payloads'),
      modifyRecord: () => assert.fail('Sign-out must use deleteRecord, not modifyRecord'),
      unset: () => assert.fail('Sign-out must not alter credential references'),
    },
    get store() { assert.fail('Never read or alter the old plugin store') },
    connection: { fetch: { register: config => { route = config; return async () => {} } } },
    effect: effect => { cleanup = effect() },
  }
  apply(ctx)
  const fetchRoute = async (method, body, id) => {
    const response = await route.fetch(new Request(`http://localhost${PATH}${id ? `?id=${id}` : ''}`,
      { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }))
    return { status: response.status, value: await response.json() }
  }
  return { ctx, fetchRoute, setFlow: next => { flow = next }, config: providerConfig, records, deleted,
    setInFlight: value => { inFlight = value },
    edits: () => editCount, begins: () => began, cancels: () => cancelled, cleanup: () => cleanup() }
}

test('activation and status checks never start OAuth, configure providers, or mutate credentials', async () => {
  const h = harness()
  assert.equal((await h.fetchRoute('GET')).status, 200)
  assert.equal(h.edits(), 0)
  assert.equal(h.begins(), 0)
  assert.deepEqual(h.deleted, [])
  await h.cleanup()
  assert.equal(h.cancels(), 0)
})

test('user sign-in invokes shipped flow and adds only absent provider', async () => {
  const h = harness()
  const start = await h.fetchRoute('POST', { action: 'start' })
  assert.equal(start.status, 200)
  assert.equal(start.value.status, 'pending')
  await tick()
  const done = await h.fetchRoute('GET', null, start.value.id)
  assert.equal(done.value.status, 'authorized')
  assert.deepEqual(h.config.providers, {
    openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' }, 'openai-codex': {},
  })
  assert.equal(h.edits(), 1)
  assert.equal(h.begins(), 1)
  assert.deepEqual(await h.fetchRoute('GET'), { status: 200, value: {
    flowAvailable: true, credentialPresent: true, providerPresent: true, inFlight: false,
  } })
  await h.cleanup()
})

test('existing provider remains untouched and does not trigger ConfigEditor/HMR', async () => {
  const h = harness({ providers: { 'openai-codex': { displayName: 'My Codex' } } })
  assert.equal(providerPresent(h.ctx), true)
  assert.equal(await ensureProvider(h.ctx), false)
  const start = await h.fetchRoute('POST', { action: 'start' })
  await tick()
  assert.equal((await h.fetchRoute('GET', null, start.value.id)).value.status, 'authorized')
  assert.equal(h.edits(), 0)
  assert.deepEqual(h.config.providers['openai-codex'], { displayName: 'My Codex' })
  await h.cleanup()
})

test('cancelled flow never configures a provider', async () => {
  const h = harness({ flow: async () => ({ status: 'cancelled' }) })
  const start = await h.fetchRoute('POST', { action: 'start' })
  await tick()
  assert.equal((await h.fetchRoute('GET', null, start.value.id)).value.status, 'cancelled')
  assert.equal(h.edits(), 0)
  await h.cleanup()
})

test('provider edit failure does not claim OAuth failed and offers a retry', async () => {
  const h = harness({ failEdit: true })
  const start = await h.fetchRoute('POST', { action: 'start' })
  await tick()
  assert.deepEqual((await h.fetchRoute('GET', null, start.value.id)).value, {
    status: 'provider-error', notices: [], prompt: null, error: 'provider-configuration-failed',
  })
  assert.equal(h.edits(), 1)
  assert.equal((await h.fetchRoute('POST', { action: 'ensure-provider' })).status, 503)
  assert.equal(h.begins(), 1)
  await h.cleanup()
})

test('committed authorization cannot be misreported as cancelled during provider configuration', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const h = harness({ editGate: gate })
  const start = await h.fetchRoute('POST', { action: 'start' })
  await tick()
  assert.equal((await h.fetchRoute('GET', null, start.value.id)).value.status, 'configuring')
  assert.equal((await h.fetchRoute('POST', { action: 'cancel', id: start.value.id })).value.status, 'configuring')
  assert.equal((await h.fetchRoute('POST', { action: 'start' })).status, 409)
  assert.deepEqual(await h.fetchRoute('POST', { action: 'sign-out' }), busyResponse)
  assert.deepEqual(h.deleted, [])
  release()
  await tick()
  assert.equal((await h.fetchRoute('GET', null, start.value.id)).value.status, 'authorized')
  await h.cleanup()
})

test('repair route requires committed grant and exposes no credential payload', async () => {
  const h = harness({ credentialPresent: false })
  assert.equal((await h.fetchRoute('POST', { action: 'ensure-provider' })).status, 409)
  assert.equal(h.edits(), 0)
  const status = await h.fetchRoute('GET')
  assert.equal(status.value.credentialPresent, false)
  assert.equal(JSON.stringify(status.value).includes('payload'), false)
  await h.cleanup()
})

test('sign-out removes only the adapter-owned grant and updates presence without touching configuration', async () => {
  const h = harness({ providers: {
    openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' }, 'openai-codex': { displayName: 'My Codex' },
  } })
  const config = structuredClone(h.config)
  const otherRecords = [...h.records].filter(([key]) => key !== KEY)
  assert.equal(KEY, 'llm-pi-ai/openai-codex')
  assert.equal((await h.fetchRoute('GET')).value.credentialPresent, true)
  // Request-supplied addressing must never redirect the owned deletion.
  assert.deepEqual(await h.fetchRoute('POST', { action: 'sign-out', key: 'another-adapter/openai-codex' }), signedOutResponse)
  assert.deepEqual(h.deleted, [KEY])
  assert.deepEqual([...h.records], otherRecords)
  assert.deepEqual(h.config, config)
  assert.equal(h.edits(), 0)
  assert.equal(h.begins(), 0)
  assert.equal(h.cancels(), 0)
  assert.deepEqual(await h.fetchRoute('GET'), { status: 200, value: {
    flowAvailable: true, credentialPresent: false, providerPresent: true, inFlight: false,
  } })
  await h.cleanup()
})

test('sign-out is idempotent and absent records need no registered OAuth flow', async () => {
  const h = harness()
  assert.deepEqual(await h.fetchRoute('POST', { action: 'sign-out' }), signedOutResponse)
  assert.deepEqual(await h.fetchRoute('POST', { action: 'sign-out' }), signedOutResponse)
  assert.deepEqual(h.deleted, [KEY])
  h.ctx.authorization.describe = key => { assert.equal(key, KEY); return undefined }
  assert.deepEqual(await h.fetchRoute('POST', { action: 'sign-out' }), signedOutResponse)
  assert.equal((await h.fetchRoute('GET')).value.credentialPresent, false)
  assert.equal((await h.fetchRoute('POST', { action: 'ensure-provider' })).status, 409)
  assert.equal(h.edits(), 0)
  await h.cleanup()
})

test('sign-out never deletes a non-grant record at the owned key', async () => {
  const h = harness({ recordKind: 'api-key' })
  const records = [...h.records]
  assert.deepEqual(await h.fetchRoute('POST', { action: 'sign-out' }), signedOutResponse)
  assert.deepEqual(h.deleted, [])
  assert.deepEqual([...h.records], records)
  assert.equal(h.edits(), 0)
  assert.equal((await h.fetchRoute('GET')).value.credentialPresent, false)
  await h.cleanup()
})

for (const failure of ['failDelete', 'failDescribe', 'failAuthorizationDescribe']) {
  test(`sign-out sanitizes ${failure} and releases the mutation guard for retry`, async () => {
    const options = { [failure]: Object.assign(new Error('secret-token-and-private-path'), {
      code: 'secret-upstream-code', cause: new Error('private-grant-payload'),
    }) }
    const h = harness(options)
    const records = [...h.records]
    assert.deepEqual(await h.fetchRoute('POST', { action: 'sign-out' }), {
      status: 503, value: { error: 'sign-out-failed' },
    })
    assert.deepEqual([...h.records], records)
    assert.equal(h.edits(), 0)
    options[failure] = null
    assert.deepEqual(await h.fetchRoute('POST', { action: 'sign-out' }), signedOutResponse)
    assert.equal(h.records.has(KEY), false)
    await h.cleanup()
  })
}

test('sign-out rejects pending OAuth and cancelled attempts still marked inFlight by the shipped service', async () => {
  const flow = deferred()
  const h = harness({ flow: () => flow.promise })
  const start = await h.fetchRoute('POST', { action: 'start' })
  assert.deepEqual(await h.fetchRoute('POST', { action: 'sign-out' }), busyResponse)
  assert.deepEqual(await h.fetchRoute('POST', { action: 'ensure-provider' }), busyResponse)
  h.setInFlight(true)
  assert.equal((await h.fetchRoute('POST', { action: 'cancel', id: start.value.id })).value.status, 'cancelled')
  assert.deepEqual(await h.fetchRoute('POST', { action: 'sign-out' }), busyResponse)
  assert.deepEqual(h.deleted, [])
  assert.equal(h.edits(), 0)
  flow.resolve({ status: 'cancelled' })
  await tick()
  h.setInFlight(false)
  assert.deepEqual(await h.fetchRoute('POST', { action: 'sign-out' }), signedOutResponse)
  await h.cleanup()
})

test('sign-out rejects externally owned inFlight OAuth without cancelling it', async () => {
  const h = harness({ inFlight: true })
  assert.deepEqual(await h.fetchRoute('POST', { action: 'sign-out' }), busyResponse)
  assert.deepEqual(await h.fetchRoute('POST', { action: 'start' }), busyResponse)
  assert.deepEqual(await h.fetchRoute('POST', { action: 'ensure-provider' }), busyResponse)
  assert.deepEqual(h.deleted, [])
  assert.equal(h.cancels(), 0)
  assert.equal(h.begins(), 0)
  assert.equal(h.edits(), 0)
  h.setInFlight(false)
  assert.deepEqual(await h.fetchRoute('POST', { action: 'sign-out' }), signedOutResponse)
  await h.cleanup()
})

test('sign-out excludes concurrent deletion, OAuth start, and provider repair until deletion commits', async () => {
  const gate = deferred()
  const h = harness({ deleteGate: gate.promise })
  const signingOut = h.fetchRoute('POST', { action: 'sign-out' })
  await tick()
  assert.deepEqual(h.deleted, [KEY])
  for (const action of ['sign-out', 'start', 'ensure-provider']) {
    assert.deepEqual(await h.fetchRoute('POST', { action }), busyResponse)
  }
  assert.equal((await h.fetchRoute('GET')).value.credentialPresent, true)
  assert.equal(h.begins(), 0)
  assert.equal(h.edits(), 0)
  gate.resolve()
  assert.deepEqual(await signingOut, signedOutResponse)
  assert.deepEqual(await h.fetchRoute('POST', { action: 'sign-out' }), signedOutResponse)
  assert.deepEqual(h.deleted, [KEY])
  assert.equal((await h.fetchRoute('GET')).value.credentialPresent, false)
  await h.cleanup()
})

test('sign-out holds its guard during metadata inspection and rechecks externally started OAuth', async () => {
  const gate = deferred()
  const options = { describeGate: gate.promise }
  const h = harness(options)
  const signingOut = h.fetchRoute('POST', { action: 'sign-out' })
  await tick()
  for (const action of ['sign-out', 'start', 'ensure-provider']) {
    assert.deepEqual(await h.fetchRoute('POST', { action }), busyResponse)
  }
  h.setInFlight(true)
  gate.resolve()
  assert.deepEqual(await signingOut, busyResponse)
  assert.deepEqual(h.deleted, [])
  h.setInFlight(false)
  assert.deepEqual(await h.fetchRoute('POST', { action: 'sign-out' }), signedOutResponse)
  await h.cleanup()
})

test('provider repair excludes sign-out and start while inspecting presence and editing configuration', async () => {
  const describeGate = deferred(), editGate = deferred()
  const h = harness({ describeGate: describeGate.promise, editGate: editGate.promise })
  const repairing = h.fetchRoute('POST', { action: 'ensure-provider' })
  await tick()
  for (const action of ['sign-out', 'start', 'ensure-provider']) {
    assert.deepEqual(await h.fetchRoute('POST', { action }), busyResponse)
  }
  describeGate.resolve()
  await tick()
  assert.equal(h.edits(), 1)
  for (const action of ['sign-out', 'start', 'ensure-provider']) {
    assert.deepEqual(await h.fetchRoute('POST', { action }), busyResponse)
  }
  assert.deepEqual(h.deleted, [])
  editGate.resolve()
  assert.deepEqual(await repairing, { status: 200, value: { providerPresent: true, added: true } })
  const config = structuredClone(h.config)
  assert.deepEqual(await h.fetchRoute('POST', { action: 'sign-out' }), signedOutResponse)
  assert.deepEqual(h.config, config)
  assert.equal(h.edits(), 1)
  await h.cleanup()
})

test('disposal during sign-out metadata inspection prevents a later deletion', async () => {
  const gate = deferred()
  const h = harness({ describeGate: gate.promise })
  const signingOut = h.fetchRoute('POST', { action: 'sign-out' })
  await tick()
  await h.cleanup()
  gate.resolve()
  assert.deepEqual(await signingOut, { status: 503, value: { error: 'unavailable' } })
  assert.deepEqual(h.deleted, [])
})
