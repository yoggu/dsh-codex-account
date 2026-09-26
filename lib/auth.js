/**
 * Codex-OAuth-Vorgänge: Login, Status, Logout — angetrieben durch pi-ais
 * provider-eigenen OAuth-Flow.
 *
 * pi-ai besitzt das Protokoll (Authorization-Code mit lokalem Callback-Server
 * auf Port 1455, Device-Code für headless Rechner, Refresh-Token-Tausch).
 * Dieses Modul besitzt die menschliche Interaktion und die Kontozuordnung:
 * welcher Account gerade eingeloggt wird und ob das Ergebnis der erwartete
 * Account ist.
 *
 * Der Flow wird nicht neu implementiert, sondern über
 * `@earendil-works/pi-ai` aufgerufen — dieselbe Bibliothek, die auch die
 * Route bedient. Damit können Protokolländerungen von OpenAI nicht gegen
 * eine eigene Kopie auseinanderlaufen.
 *
 * @module dsh-codex-account/auth
 */

import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { createModels } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { accountScopedStore } from './store.js'
import { safeFailure } from './safe-error.js'

/** pi-ais Provider-Id für OpenAI Codex (ChatGPT-Abo). */
export const CODEX_PROVIDER_ID = 'openai-codex'

/** Der JWT-Claim, in dem OpenAI Konto-Id und Tarif ablegt. */
const AUTH_CLAIM = 'https://api.openai.com/auth'

/** Die beiden Login-Wege, die pi-ais Codex-Flow anbietet. */
export const LOGIN_METHODS = {
  browser: 'browser',
  device: 'device_code',
}

/**
 * Liest die Kontodaten aus einem Access-Token, ohne ihn zu verifizieren.
 *
 * Das ist eine Diagnose, keine Autorisierung: der Token kommt frisch von
 * OpenAI, und der Claim dient nur dazu, dem Menschen zu zeigen, *welches*
 * Konto gerade verbunden wurde — die Verifikation selbst macht der Provider
 * bei jeder Anfrage.
 *
 * @param token - der Access-Token (JWT).
 * @returns Konto-Id, Tarif und Ablaufzeit, soweit vorhanden.
 */
export function readAccountClaims(token) {
  try {
    const parts = String(token).split('.')
    if (parts.length !== 3) return {}
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const auth = payload?.[AUTH_CLAIM] ?? {}
    return {
      accountId: typeof auth.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : undefined,
      planType: typeof auth.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : undefined,
      expiresAt: typeof payload?.exp === 'number' ? payload.exp * 1000 : undefined,
      email: typeof payload?.email === 'string' ? payload.email : undefined,
    }
  } catch {
    return {}
  }
}

/**
 * Ein gemeldetes Ereignis des Login-Flows, in einer Form, die sowohl ein
 * Terminal als auch eine Browser-Karte rendern kann.
 *
 * @typedef {object} LoginEvent
 * @property {'url'|'device'|'progress'|'info'} kind
 * @property {string} [url] - zu öffnende URL (Browser-Flow oder Device-Bestätigung).
 * @property {string} [code] - Device-Code, den der Mensch eintippt.
 * @property {string} [message] - Freitext für Fortschritt und Hinweise.
 */

/**
 * Öffnet eine URL im Desktop-Browser. Nur https wird weitergereicht, damit
 * kein fremder String an die Shell geht.
 * @param url - die zu öffnende URL.
 * @param onEvent - Empfänger für einen Fehlschlag (die URL bleibt sichtbar).
 */
export function isTrustedOAuthUrl(value) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'auth.openai.com'
      && url.username === '' && url.password === '' && url.port === ''
  } catch {
    return false
  }
}

export function openInBrowser(url, onEvent) {
  if (!isTrustedOAuthUrl(url)) return
  // Windows `cmd /c start <url>` interprets metacharacters in an OAuth URL
  // as shell syntax. Require manual opening there rather than invoking a shell.
  if (process.platform === 'win32') {
    onEvent?.({ kind: 'info', message: 'Autorisierungs-URL bitte manuell im Browser öffnen.' })
    return
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawn(command, [url], { stdio: 'ignore', detached: true, shell: false })
    child.once('error', () => {
      onEvent?.({ kind: 'info', message: 'Browser konnte nicht automatisch geöffnet werden.' })
    })
    child.unref()
  } catch {
    onEvent?.({ kind: 'info', message: 'Browser konnte nicht automatisch geöffnet werden.' })
  }
}

/**
 * Übersetzt ein pi-ai-Ereignis in ein {@link LoginEvent}.
 * @param event - das pi-ai-Ereignis.
 * @returns das gemeldete Ereignis, oder undefined wenn es nichts anzuzeigen gibt.
 */
export function translate(event) {
  switch (event?.type) {
    case 'auth_url':
      return {
        kind: 'url',
        ...(isTrustedOAuthUrl(event.url) ? { url: event.url } : {}),
        message: 'Login im Browser abschließen.',
      }
    case 'device_code':
      return {
        kind: 'device',
        ...(isTrustedOAuthUrl(event.verificationUri) ? { url: event.verificationUri } : {}),
        code: event.userCode,
        message: `Code ${event.userCode} eingeben (gültig ${Math.round((event.expiresInSeconds ?? 900) / 60)} Minuten).`,
      }
    case 'progress':
      return { kind: 'progress', message: 'Anmeldung läuft.' }
    case 'info':
      return { kind: 'info', message: 'Hinweis vom Anmeldedienst; Details können Zugangsdaten enthalten.' }
    default:
      return undefined
  }
}

/**
 * Wählt aus einem pi-ai-Auswahlprompt die gewünschte Login-Methode.
 *
 * Verglichen wird über den Label-Text statt über die Option-Id: pi-ai darf
 * Ids umbenennen, ohne dass dieser Aufrufer bricht.
 *
 * @param prompt - der Auswahlprompt.
 * @param method - die gewünschte Methode.
 * @returns die Option-Id, mit dem ersten Eintrag als Rückfall.
 */
function chooseMethod(prompt, method) {
  const wanted = method === LOGIN_METHODS.device ? /device/i : /browser/i
  const match = prompt.options?.find((option) => wanted.test(option.label ?? ''))
  return match?.id ?? prompt.options?.[0]?.id ?? ''
}

/**
 * Führt den Codex-Login aus und legt den Credential im Store ab.
 *
 * Der `manual_code`-Prompt wird über sein eigenes Signal beantwortet: pi-ai
 * lässt den Browser-Callback und die Handeingabe gegeneinander laufen, damit
 * ein blockierter lokaler Port den Login nicht unmöglich macht. Dieses Modul
 * reicht nur weiter, was der Aufrufer sammeln kann — ein Terminal sammelt
 * nichts und lässt den Callback gewinnen, eine Browser-Karte reicht den
 * eingefügten Code durch.
 *
 * @param options - Store, Account, Methode, Abbruchsignal, Ereignisempfänger
 *   und `openBrowser` (nur ein Aufrufer außerhalb eines Browsers, etwa die CLI,
 *   setzt das auf `true`).
 * @returns die Kontodaten des eingeloggten Tokens.
 */
export async function login(options) {
  const {
    store,
    accountId,
    method = LOGIN_METHODS.browser,
    signal,
    onEvent,
    collectManualCode,
    openBrowser,
  } = options
  const models = createModels({ credentials: accountScopedStore(store, accountId) })
  models.setProvider(openaiCodexProvider())

  const interaction = {
    ...(signal === undefined ? {} : { signal }),
    notify: (event) => {
      const translated = translate(event)
      if (translated === undefined) return
      onEvent?.(translated)
      // Den Systembrowser nur öffnen, wenn der Aufrufer es verlangt. Ein
      // Aufrufer im Web-GUI ist bereits in einem Browser: dort würde
      // `xdg-open` ein zweites Fenster mit frischem Profil auf den Desktop
      // werfen — beim wiederholten Klick mehrere. Die Karte zeigt die URL
      // stattdessen als Link.
      if (openBrowser === true && (translated.kind === 'url' || translated.kind === 'device')) {
        openInBrowser(translated.url ?? '', onEvent)
      }
    },
    prompt: async (prompt) => {
      if (prompt.type === 'select') return chooseMethod(prompt, method)
      if (prompt.type === 'manual_code') {
        // Ein Aufrufer mit Eingabekanal (Browser-Karte) darf den Code liefern;
        // ohne einen solchen wartet dieser Prompt, bis der Callback gewinnt
        // oder der Login abgebrochen wird.
        if (collectManualCode !== undefined) {
          const value = await collectManualCode(prompt)
          if (typeof value === 'string' && value.trim().length > 0) return value.trim()
        }
        await new Promise((resolve, reject) => {
          const onPromptAbort = () => {
            cleanup()
            resolve()
          }
          const onLoginAbort = () => {
            cleanup()
            const reason = signal?.reason
            reject(reason instanceof Error ? reason : new Error('Login abgebrochen'))
          }
          const cleanup = () => {
            prompt.signal?.removeEventListener('abort', onPromptAbort)
            signal?.removeEventListener('abort', onLoginAbort)
          }
          if (signal?.aborted === true) {
            onLoginAbort()
            return
          }
          if (prompt.signal?.aborted === true) {
            onPromptAbort()
            return
          }
          prompt.signal?.addEventListener('abort', onPromptAbort, { once: true })
          signal?.addEventListener('abort', onLoginAbort, { once: true })
        })
        return ''
      }
      throw new Error(`dsh-codex-account: unerwarteter Login-Prompt "${prompt.type}"`)
    },
  }

  const credential = await models.login(CODEX_PROVIDER_ID, 'oauth', interaction)
  if (credential?.type !== 'oauth') {
    throw new Error(`dsh-codex-account: Login lieferte einen Credential vom Typ "${credential?.type}"`)
  }
  return { credential, ...readAccountClaims(credential.access) }
}

/**
 * Den Zustand eines Accounts beschreiben, ohne den Token zu erneuern.
 * @param store - der Store.
 * @param accountId - der Account.
 * @returns ein Statusobjekt für Anzeige und Diagnose.
 */
export async function status(store, accountId) {
  const credential = await store.read(accountId)
  if (credential === undefined) return { accountId, configured: false }
  if (credential.type !== 'oauth') {
    return { accountId, configured: true, kind: credential.type, error: 'unerwarteter Credential-Typ' }
  }
  const claims = readAccountClaims(credential.access)
  return {
    accountId,
    configured: true,
    kind: 'oauth',
    account: claims.accountId,
    plan: claims.planType,
    email: claims.email,
    expiresAt: credential.expires,
    expired: typeof credential.expires === 'number' ? credential.expires <= Date.now() : undefined,
    hasRefreshToken: typeof credential.refresh === 'string' && credential.refresh.length > 0,
  }
}

/**
 * Einen Account abmelden.
 * @param store - der Store.
 * @param accountId - der Account.
 */
export async function logout(store, accountId) {
  await store.delete(accountId)
}

/**
 * Einen vorhandenen Codex-CLI-Login (`~/.codex/auth.json`) übernehmen.
 *
 * Nur ein Import, kein Refresh: der Access-Token muss gültig sein. Der
 * Refresh-Token wird kopiert und ist danach zwischen Codex CLI und diesem
 * Plugin geteilt — die CLI rotiert ihn bei ihrer nächsten Erneuerung. Für
 * einen eigenen, unabhängigen Token-Bestand ist der Browser-Login der
 * richtige Weg.
 *
 * @param store - der Ziel-Store.
 * @param accountId - der Ziel-Account.
 * @param path - Pfad zu `auth.json`.
 * @returns die Kontodaten des übernommenen Tokens.
 */
export async function importFromCodexCli(store, accountId, path) {
  let document
  let handle
  try {
    // O_NOFOLLOW rejects a symlink at the final component on supported hosts.
    // On hosts without it, reject symlinks before opening as a best effort.
    if (constants.O_NOFOLLOW === undefined && (await lstat(path)).isSymbolicLink()) {
      throw new Error('symlinked credential')
    }
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    // Validate the opened inode, not a path that could change between stat and read.
    const info = await handle.stat()
    if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
      throw new Error('insecure credential')
    }
    document = JSON.parse(await handle.readFile('utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') throw safeFailure('Kein Codex-CLI-Login gefunden')
    throw safeFailure('Codex-CLI-Login ist nicht lesbar oder nicht sicher geschützt')
  } finally {
    await handle?.close()
  }
  const tokens = document?.tokens ?? {}
  const access = tokens.access_token
  const refresh = tokens.refresh_token
  if (typeof access !== 'string' || typeof refresh !== 'string') {
    throw safeFailure('Codex-CLI-Login enthält kein access_token/refresh_token-Paar')
  }
  const claims = readAccountClaims(access)
  if (typeof claims.expiresAt !== 'number') throw new Error('access_token ist kein lesbares JWT')
  if (claims.expiresAt <= Date.now()) {
    throw new Error(
      'Der Codex-CLI-Access-Token ist abgelaufen. Codex einmal starten, damit die CLI erneuert, '
      + 'oder den Browser-Login dieses Plugins benutzen.',
    )
  }
  await store.modify(accountId, async () => ({
    type: 'oauth',
    access,
    refresh,
    expires: claims.expiresAt,
    ...(claims.accountId === undefined ? {} : { accountId: claims.accountId }),
  }))
  return claims
}
