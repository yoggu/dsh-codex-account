import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CodexControl } from '../lib/control.js'
import { codexCommand } from '../lib/command.js'
import { translate } from '../lib/auth.js'
import { safeError, safeFailure } from '../lib/safe-error.js'

const secret = 'refresh_token=super-secret&code=one-time-code'
const upstreamError = new Error(`OAuth rejected: ${secret}`)
const account = { id: 'personal', provider: 'codex-personal' }
const nextTurn = () => new Promise((resolve) => setImmediate(resolve))

test('safeError permits only locally marked failure messages', () => {
  assert.equal(safeError(safeFailure('Credential-Datei nicht gefunden')), 'Credential-Datei nicht gefunden')
  assert.doesNotMatch(safeError(upstreamError), /super-secret|one-time-code/)
  assert.doesNotMatch(safeError({ message: secret, safeMessage: secret }), /super-secret|one-time-code/)
  assert.doesNotMatch(safeError(new Proxy({}, { get: () => { throw new Error(secret) } })), /super-secret|one-time-code/)
})

test('translate does not forward upstream progress or info messages', () => {
  for (const type of ['progress', 'info']) {
    const event = translate({ type, message: secret })
    assert.equal(event.kind, type)
    assert.doesNotMatch(JSON.stringify(event), /super-secret|one-time-code/)
  }
})

test('control never returns an upstream login or action failure', async () => {
  const control = new CodexControl({
    accounts: [account],
    store: {},
    login: async () => { throw upstreamError },
    logout: async () => { throw upstreamError },
    status: async () => ({ configured: false }),
    importFromCodexCli: async () => { throw upstreamError },
  })
  control.startLogin('personal')
  await nextTurn()
  const state = await control.state()
  assert.equal(state.lastResult.ok, false)
  assert.doesNotMatch(JSON.stringify(state), /super-secret|one-time-code/)
  for (const action of ['logout', 'import']) {
    const response = await control.handle(new Request('http://localhost/', {
      method: 'POST', body: JSON.stringify({ action, accountId: 'personal' }),
    }))
    assert.equal(response.status, 400)
    assert.doesNotMatch(await response.text(), /super-secret|one-time-code/)
  }
})

test('command does not copy an upstream exception into its result', async () => {
  const command = codexCommand({
    accounts: [account], store: {}, login: async () => { throw upstreamError },
  })
  const response = await command.handler({ rawInput: 'login personal' })
  assert.equal(response.kind, 'error')
  assert.doesNotMatch(response.text, /super-secret|one-time-code/)
})
