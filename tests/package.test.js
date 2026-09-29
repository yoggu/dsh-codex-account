import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import vm from 'node:vm'
import { name, PATH, KEY, inject } from '../index.js'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('renamed package, bundle, browser module, card and API use the account identity', async () => {
  const pkg = JSON.parse(await read('package.json'))
  assert.equal(pkg.name, 'dsh-codex-account')
  assert.equal(pkg.version, '0.2.0')
  assert.equal(pkg.main, './index.js')
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.repository.url, 'git+https://github.com/yoggu/dsh-codex-account.git')
  assert.ok(pkg.files.includes('icon.svg'))
  assert.ok(pkg.files.includes('LICENSE'))
  assert.equal(pkg.dependencies, undefined, 'No private pi-ai or custom adapter dependency')
  assert.equal(pkg.bin, undefined, 'The legacy local login CLI is retired')
  for (const file of pkg.files) await access(new URL(`../${file}`, import.meta.url))
  assert.equal(await read('cordis.patch.yml'), '- insert:\n    - id: codex-account\n      name: dsh-codex-account\n')
  let module
  const client = await read('client.js')
  vm.runInNewContext(client, { window: { __ModuleLoader__: { load: value => { module = value } } } })
  assert.equal(module.id, 'dsh-codex-account')
  assert.ok(client.includes("key: 'dsh-codex-account'"))
  assert.ok(client.includes("const URL_PATH = '/api/dsh-codex-account'"))
  assert.ok(client.includes("title: 'Codex Account'"))
  assert.ok(client.includes('.codexAccountCard'))
  assert.doesNotMatch(client, /dsh-codex-sign-in|codexSignIn|settings\.section/)
  assert.equal(JSON.parse(await read('locale/en.json')).meta.title, 'Codex Account')
  assert.equal(name, 'dsh-codex-account')
  assert.equal(PATH, '/api/dsh-codex-account')
  assert.equal(KEY, 'llm-pi-ai/openai-codex', 'Renaming never changes credential ownership')
  assert.deepEqual(inject, ['authorization', 'credentials', 'configEditor', 'connection'])
})
