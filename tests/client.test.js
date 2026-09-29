import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
function harness({ ready = { flowAvailable: true, credentialPresent: true, providerPresent: true, inFlight: false },
  attempt = null, locale = 'en', respond } = {}) {
  let plugin, page, cursor = 0
  const slots = [], calls = [], state = [ready, attempt, '', '', '']
  const React = {
    Fragment: 'fragment',
    createElement(type, props, ...children) {
      return typeof type === 'function' ? type(props ?? {}) : { type, props: props ?? {}, children: children.flat(Infinity) }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in state)) state[index] = initial
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value }]
    },
    useEffect() {},
    useSyncExternalStore: (_, snapshot) => snapshot(),
  }
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: config => { plugin = config.factory(() => React) } } },
    fetch: async (url, options) => {
      const body = options.body ? JSON.parse(options.body) : null
      calls.push({ url, method: options.method, body })
      return respond ? respond(body) : { ok: true, json: async () => body
        ? { status: 'signed-out' } : { ...ready, credentialPresent: false } }
    },
    AbortController, setTimeout, clearTimeout,
  })
  const ctx = {
    locale: { subscribe() {}, getSnapshot: () => ({ active: locale }) },
    slots: { inject: (_, callback) => callback(), register(config, component) {
      slots.push(config)
      if (config.name === 'plugins.bundle.config') page = component
    } },
  }
  plugin.apply(ctx)
  return { calls, slots, state, render() { cursor = 0; return page({ view: 'config' }) } }
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...tree.children.flatMap(nodes)]
}
function text(tree) {
  if (!tree || typeof tree === 'boolean') return ''
  return typeof tree === 'object' ? tree.children.map(text).join('') : String(tree)
}
function button(tree, label) { return nodes(tree).find(node => node.type === 'button' && text(node) === label) }

test('card is registered only on Plugins and offers sign-out for a saved sign-in', () => {
  const h = harness(), tree = h.render()
  assert.deepEqual(h.slots.map(slot => slot.name), ['plugins.bundle.config'])
  assert.equal(button(tree, 'Sign out').props.disabled, false)
  assert.ok(button(tree, 'Sign in again'))
  assert.ok(nodes(tree).some(node => node.props.className === 'codexAccountCard'))
  assert.ok(nodes(tree).some(node => node.type === 'dl'))
})

test('successful sign-out posts only the action, clears login state and keeps provider presence', async () => {
  const h = harness({ attempt: { id: 'old', status: 'authorized' } })
  await button(h.render(), 'Sign out').props.onClick()
  assert.deepEqual(h.calls, [
    { url: '/api/dsh-codex-account', method: 'POST', body: { action: 'sign-out' } },
    { url: '/api/dsh-codex-account', method: 'GET', body: null },
  ])
  const tree = h.render()
  assert.equal(button(tree, 'Sign out'), undefined)
  assert.ok(button(tree, 'Sign in with ChatGPT'))
  assert.ok(text(tree).includes('Signed out of ChatGPT on this host.'))
  assert.ok(text(tree).includes('Available in Models'))
  assert.equal(text(tree).includes('Signed in; openai-codex'), false)
})

test('sign-out failure keeps signed-in state and displays an alert', async () => {
  const h = harness({ respond: () => ({ ok: false, json: async () => ({ error: 'sign-out-failed' }) }) })
  await button(h.render(), 'Sign out').props.onClick()
  const tree = h.render()
  assert.ok(button(tree, 'Sign out'))
  assert.ok(nodes(tree).some(node => node.props.role === 'alert' && text(node) === 'sign-out-failed'))
  assert.equal(h.state[0].credentialPresent, true)
})

test('signed-out card hides sign-out; external authorization disables account mutations', () => {
  const off = harness({ ready: { flowAvailable: true, credentialPresent: false, providerPresent: true } }).render()
  assert.equal(button(off, 'Sign out'), undefined)
  assert.ok(button(off, 'Sign in with ChatGPT'))
  const busy = harness({ ready: { flowAvailable: true, credentialPresent: true, providerPresent: false, inFlight: true } }).render()
  for (const label of ['Sign out', 'Sign in again', 'Add to Models']) assert.equal(button(busy, label).props.disabled, true)
})

test('pending and configuring cards keep flow feedback and never offer sign-out', () => {
  const pending = harness({ attempt: { id: 'flow', status: 'pending', notices: [{ message: 'Continue',
    url: 'https://auth.openai.com/', code: 'TEST-CODE' }], prompt: { kind: 'secret', message: 'Response' } } }).render()
  assert.equal(button(pending, 'Sign out'), undefined)
  assert.ok(button(pending, 'Cancel sign-in'))
  assert.ok(nodes(pending).some(node => node.type === 'a' && node.props.rel === 'noopener noreferrer'))
  assert.ok(nodes(pending).some(node => node.type === 'input' && node.props.type === 'password'))
  assert.ok(text(pending).includes('TEST-CODE'))
  const configuring = harness({ attempt: { id: 'flow', status: 'configuring' } }).render()
  assert.equal(button(configuring, 'Sign out'), undefined)
  assert.equal(button(configuring, 'Cancel sign-in'), undefined)
  assert.ok(text(configuring).includes('Adding openai-codex to Models…'))
})

test('German card localizes sign-out and provider-repair actions', () => {
  const tree = harness({ locale: 'de', ready: { flowAvailable: true, credentialPresent: true, providerPresent: false } }).render()
  assert.ok(button(tree, 'Abmelden'))
  assert.ok(button(tree, 'Zu Modelle hinzufügen'))
  assert.ok(text(tree).includes('Die Modellkonfiguration bleibt erhalten.'))
})
