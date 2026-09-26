import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AccountStore } from '../lib/store.js'
import { importFromCodexCli, isTrustedOAuthUrl, translate } from '../lib/auth.js'

async function withDirectory(run) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-credential-security-'))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const credential = { type: 'oauth', access: 'test-access', refresh: 'test-refresh', expires: 1 }
const jwt = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`
const cliDocument = JSON.stringify({ tokens: { access_token: jwt, refresh_token: 'test-refresh' } })

async function rejectImport(path) {
  let modified = false
  await assert.rejects(
    importFromCodexCli({ modify: async () => { modified = true } }, 'personal', path),
    /Codex-CLI-Login ist nicht lesbar oder nicht sicher geschützt/,
  )
  assert.equal(modified, false, 'rejected import must not write a credential')
}

test('store rejects a world-readable document rather than reading its tokens', { skip: process.platform === 'win32' }, async () => {
  await withDirectory(async (dir) => {
    const path = join(dir, 'accounts.json')
    await writeFile(path, JSON.stringify({ personal: credential }), { mode: 0o644 })
    await chmod(path, 0o644)
    await assert.rejects(new AccountStore(path).read('personal'), /reguläre Datei mit Rechten 0600/)
  })
})

test('store refuses a symlink even when its target is private', { skip: process.platform === 'win32' }, async () => {
  await withDirectory(async (dir) => {
    const target = join(dir, 'target.json')
    const path = join(dir, 'accounts.json')
    await writeFile(target, JSON.stringify({ personal: credential }), { mode: 0o600 })
    await symlink(target, path)
    await assert.rejects(new AccountStore(path).read('personal'))
  })
})

test('store reads private file and writes a private replacement', { skip: process.platform === 'win32' }, async () => {
  await withDirectory(async (dir) => {
    const path = join(dir, 'accounts.json')
    await writeFile(path, JSON.stringify({ personal: credential }), { mode: 0o600 })
    const store = new AccountStore(path)
    assert.deepEqual(await store.read('personal'), credential)
    await store.modify('personal', (current) => ({ ...current, refresh: 'next-refresh' }))
    assert.equal((await readFile(path, 'utf8')).includes('next-refresh'), true)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
  })
})

test('CLI import rejects world-readable file and symlink', { skip: process.platform === 'win32' }, async () => {
  await withDirectory(async (dir) => {
    const target = join(dir, 'cli-auth.json')
    const link = join(dir, 'cli-link.json')
    await writeFile(target, cliDocument, { mode: 0o644 })
    await chmod(target, 0o644)
    await rejectImport(target)
    await chmod(target, 0o600)
    await symlink(target, link)
    await rejectImport(link)
  })
})

test('CLI import reads a secure file', { skip: process.platform === 'win32' }, async () => {
  await withDirectory(async (dir) => {
    const path = join(dir, 'cli-auth.json')
    await writeFile(path, cliDocument, { mode: 0o600 })
    let written
    const claims = await importFromCodexCli({ modify: async (_id, mutate) => { written = await mutate() } }, 'personal', path)
    assert.equal(written.type, 'oauth')
    assert.equal(written.access, jwt)
    assert.equal(written.refresh, 'test-refresh')
    assert.equal(claims.expiresAt, written.expires)
  })
})

test('OAuth browser URL trust pins HTTPS authority and rejects lookalikes', () => {
  assert.equal(isTrustedOAuthUrl('https://auth.openai.com/oauth/authorize?client_id=test'), true)
  for (const url of [
    '\nhttps://auth.openai.com/',
    'http://auth.openai.com/',
    'https://auth.openai.com.evil.test/',
    'https://auth.openai.com@evil.test/',
    'https://user@auth.openai.com/',
    'https://auth.openai.com:444/',
    'javascript:alert(1)',
    'https://evil.test/#auth.openai.com',
    '//auth.openai.com/',
  ]) {
    assert.equal(isTrustedOAuthUrl(url), false, url)
  }
})

test('OAuth events never forward untrusted browser or device hrefs', () => {
  const browser = 'https://auth.openai.com/oauth/authorize?state=sample'
  const device = 'https://auth.openai.com/codex/device'
  assert.equal(translate({ type: 'auth_url', url: browser }).url, browser)
  assert.equal(translate({ type: 'device_code', verificationUri: device, userCode: 'TEST-CODE' }).url, device)
  for (const event of [
    { type: 'auth_url', url: 'javascript:alert(1)' },
    { type: 'auth_url', url: 'https://auth.openai.com.evil.test/' },
    { type: 'device_code', verificationUri: 'https://evil.test/', userCode: 'TEST-CODE' },
    { type: 'device_code', verificationUri: 'https://user@auth.openai.com/', userCode: 'TEST-CODE' },
  ]) {
    assert.equal(Object.hasOwn(translate(event), 'url'), false)
  }
})
