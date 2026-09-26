/**
 * Der `/codex`-Mensch-Befehl: anmelden, abmelden, Zustand.
 *
 * Das Kommando-Flugzeug rendert genau ein Ergebnis, nachdem der Handler
 * fertig ist — es kann also keinen Device-Code anzeigen, während die
 * Anmeldung noch läuft. Deshalb startet `/codex login` den Browser-Flow und
 * gibt die URL aus; der Device-Weg steht headless über die CLI offen.
 *
 * @module dsh-codex-account/command
 */

import { safeError } from './safe-error.js'

/** Die Unterbefehle, die `/codex` kennt. */
const USAGE = 'login [account] | logout <account> | status'

/**
 * Den `/codex`-Befehl bauen.
 * @param deps - Store, Konten und die OAuth-Vorgänge.
 * @returns die Befehlsdefinition für `ctx.commands`.
 */
export function codexCommand(deps) {
  const { store, accounts, login, logout, status, importFromCodexCli } = deps

  /** Ein Konto über Id auflösen; ohne Argument das erste konfigurierte. */
  const resolve = (raw) => {
    if (accounts.length === 0) return undefined
    if (raw === undefined || raw.length === 0) return accounts[0]
    return accounts.find((account) => account.id === raw)
  }

  /** Die Kontoliste als Text, für Fehlermeldungen und `status`. */
  const knownAccounts = () => accounts.map((account) => account.id).join(', ')

  return {
    name: 'codex',
    description: 'OpenAI-Codex-Konten (ChatGPT-Abo) verwalten',
    input: { hint: USAGE },
    recordInput: false,
    handler: async ({ rawInput, signal }) => {
      const [verb, ...rest] = String(rawInput ?? '').trim().split(/\s+/u).filter((part) => part.length > 0)
      try {
        switch (verb) {
          case 'login':
          case undefined: {
            const account = resolve(rest[0])
            if (account === undefined) {
              return { kind: 'error', text: `Unbekanntes Konto "${rest[0]}"; verfügbar: ${knownAccounts()}` }
            }
            const lines = []
            const result = await login({
              store,
              accountId: account.id,
              method: 'browser',
              ...(signal === undefined ? {} : { signal }),
              onEvent: (event) => {
                if (event.kind === 'url') lines.push(`Browser öffnen: ${event.url}`)
                else if (event.kind === 'device') lines.push(`Code ${event.code} unter ${event.url}`)
                else if (event.message !== undefined) lines.push(event.message)
              },
            })
            const identity = result.accountId === undefined ? 'unbekannt' : result.accountId
            const plan = result.planType === undefined ? '' : ` (Tarif ${result.planType})`
            return {
              kind: 'success',
              text: [
                ...lines,
                `Konto "${account.id}" angemeldet: ${identity}${plan}`,
                `Route: ${account.provider}`,
              ].join('\n'),
            }
          }
          case 'import': {
            // Notausgang: einen vorhandenen Codex-CLI-Login übernehmen, ohne Browser.
            const account = resolve(rest[0])
            if (account === undefined) {
              return { kind: 'error', text: `Unbekanntes Konto "${rest[0]}"; verfügbar: ${knownAccounts()}` }
            }
            const claims = await importFromCodexCli(store, account.id, deps.codexAuthPath)
            const identity = claims.accountId === undefined ? 'unbekannt' : claims.accountId
            return {
              kind: 'success',
              text: `Konto "${account.id}" aus der Codex CLI übernommen: ${identity}${claims.planType === undefined ? '' : ` (Tarif ${claims.planType})`}`,
            }
          }
          case 'logout': {
            const account = resolve(rest[0])
            if (account === undefined) {
              return { kind: 'error', text: `Unbekanntes Konto "${rest[0]}"; verfügbar: ${knownAccounts()}` }
            }
            await logout(store, account.id)
            return { kind: 'success', text: `Konto "${account.id}" abgemeldet.` }
          }
          case 'status': {
            const target = rest[0] === undefined ? accounts : accounts.filter((account) => account.id === rest[0])
            if (target.length === 0) {
              return { kind: 'error', text: `Unbekanntes Konto "${rest[0]}"; verfügbar: ${knownAccounts()}` }
            }
            const rows = []
            for (const account of target) {
              const state = await status(store, account.id)
              rows.push(describeAccount(account, state))
            }
            return { kind: 'success', text: rows.join('\n') }
          }
          default:
            return { kind: 'error', text: `Unbekannter Unterbefehl "${verb}"; benutze ${USAGE}` }
        }
      } catch (error) {
        return { kind: 'error', text: `Codex-Vorgang fehlgeschlagen: ${safeError(error)}` }
      }
    },
  }
}

/**
 * Eine Statuszeile für ein Konto.
 * @param account - die Kontokonfiguration.
 * @param state - das Ergebnis von `status()`.
 * @returns die anzuzeigende Zeile.
 */
function describeAccount(account, state) {
  const route = `Route ${account.provider}`
  if (state.configured !== true) {
    return `${account.id}: nicht angemeldet (${route}) — /codex login ${account.id}`
  }
  const identity = state.account === undefined ? 'Konto unbekannt' : state.account
  const plan = state.plan === undefined ? '' : `, Tarif ${state.plan}`
  const expires = typeof state.expiresAt === 'number' ? new Date(state.expiresAt).toISOString() : 'unbekannt'
  const freshness = state.expired === true ? 'abgelaufen, wird beim nächsten Aufruf erneuert' : 'gültig'
  return `${account.id}: ${identity}${plan} (${route}) — Token ${freshness}, läuft ab ${expires}`
}
