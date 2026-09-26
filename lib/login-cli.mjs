#!/usr/bin/env node
/**
 * Login-CLI des Plugins `dsh-codex-account`.
 *
 * Derselbe Code, den die Route benutzt — nur ohne laufenden Harness. Das ist
 * der Weg für einen headless Rechner und der bequemste Weg, einen Account
 * anzumelden, ohne das Web-GUI neu zu starten: der Credential landet im
 * Store, den die Route beim nächsten Aufruf liest.
 *
 *   node lib/login-cli.mjs login personal
 *   node lib/login-cli.mjs login personal --device
 *   node lib/login-cli.mjs status
 *   node lib/login-cli.mjs logout personal
 *   node lib/login-cli.mjs import personal
 *
 * Der Store-Pfad ist `$DSH_HOME/codex-accounts.json`, derselbe den die
 * Composition-Zeile benutzt.
 *
 * @module dsh-codex-account/login-cli
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { safeError } from './safe-error.js'

/** Der Store-Pfad, den auch die Plugin-Zeile als Vorgabe benutzt. */
function defaultStorePath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(resolve(home), 'codex-accounts.json')
}

/** Der Vorgabe-Account, wenn keiner genannt wird. */
const DEFAULT_ACCOUNT = 'personal'

const USAGE = `dsh-codex-account — ChatGPT-Abo-Konten für den DeepSeek Harness

  login [account] [--device]   Browser- oder Device-Code-Login
  import [account]             vorhandenen Codex-CLI-Login übernehmen
  status [account]             angemeldete Konten anzeigen
  logout [account]             Credential entfernen

Optionen:
  --store <path>   Credential-Dokument (Vorgabe: $DSH_HOME/codex-accounts.json)
  --codex-auth     Pfad zu ~/.codex/auth.json für \`import\`
`

/** Argumente in einen Aufruf übersetzen. */
function parse(argv) {
  const flags = new Set()
  const positional = []
  let store
  let codexAuth
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--store') {
      store = argv[index + 1]
      index += 1
      continue
    }
    if (token === '--codex-auth') {
      codexAuth = argv[index + 1]
      index += 1
      continue
    }
    if (token.startsWith('--')) {
      flags.add(token.slice(2))
      continue
    }
    positional.push(token)
  }
  return {
    verb: positional[0],
    account: positional[1] ?? DEFAULT_ACCOUNT,
    store: store === undefined ? defaultStorePath() : resolve(store),
    codexAuth: codexAuth ?? join(homedir(), '.codex', 'auth.json'),
    device: flags.has('device'),
  }
}

/** Eine Zeile auf stdout, ohne Fließtext-Umbruch. */
const say = (text) => process.stdout.write(`${text}\n`)

async function main() {
  const args = parse(process.argv.slice(2))
  if (args.verb === undefined || args.verb === 'help' || args.verb === '--help') {
    say(USAGE)
    return
  }

  // Die Module erst nach der Argumentprüfung laden, damit `help` ohne
  // pi-ai-Auflösung funktioniert.
  const { AccountStore } = await import('./store.js')
  const { login, logout, status, importFromCodexCli, LOGIN_METHODS } = await import('./auth.js')
  const store = new AccountStore(args.store)

  say(`Store:   ${args.store}`)
  say(`Account: ${args.account}`)

  switch (args.verb) {
    case 'login': {
      const result = await login({
        store,
        accountId: args.account,
        method: args.device ? LOGIN_METHODS.device : LOGIN_METHODS.browser,
        // Die CLI ist der eine Aufrufer außerhalb eines Browsers — hier ist
        // das Öffnen des Systembrowsers genau richtig.
        openBrowser: !args.device,
        onEvent: (event) => {
          if (event.kind === 'url') {
            say('')
            say(`  Browser öffnen: ${event.url}`)
            say('  Nach dem Login leitet ChatGPT auf http://localhost:1455/auth/callback weiter.')
            say('')
          } else if (event.kind === 'device') {
            say('')
            say(`  Code ${event.code} eingeben unter: ${event.url}`)
            say('')
          } else if (event.message !== undefined) {
            say(`  … ${event.message}`)
          }
        },
      })
      say('')
      say(`✓ angemeldet: ${result.accountId ?? 'Konto unbekannt'}${result.planType === undefined ? '' : ` (Tarif ${result.planType})`}`)
      return
    }
    case 'import': {
      const claims = await importFromCodexCli(store, args.account, args.codexAuth)
      say(`✓ übernommen: ${claims.accountId ?? 'Konto unbekannt'}${claims.planType === undefined ? '' : ` (Tarif ${claims.planType})`}`)
      say('  Hinweis: der Refresh-Token ist mit der Codex CLI geteilt.')
      return
    }
    case 'status': {
      const state = await status(store, args.account)
      if (state.configured !== true) {
        say('nicht angemeldet')
        return
      }
      say(`Konto:   ${state.account ?? 'unbekannt'}`)
      say(`Tarif:   ${state.plan ?? 'unbekannt'}`)
      say(`Token:   ${state.expired === true ? 'abgelaufen (wird beim nächsten Aufruf erneuert)' : 'gültig'}`)
      say(`Läuft ab: ${typeof state.expiresAt === 'number' ? new Date(state.expiresAt).toISOString() : 'unbekannt'}`)
      return
    }
    case 'logout': {
      await logout(store, args.account)
      say('✓ abgemeldet')
      return
    }
    default:
      say(`Unbekannter Befehl "${args.verb}".`)
      say(USAGE)
      process.exitCode = 2
  }
}

main().catch((error) => {
  process.stderr.write(`\n✗ ${safeError(error)}\n\n`)
  process.exitCode = 1
})
