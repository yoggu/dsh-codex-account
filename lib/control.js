/**
 * HTTP-Steuerfläche der Einstellungsseite.
 *
 * Die Karte im Browser braucht drei Dinge vom Host: den Zustand der Konten,
 * einen Login-Start und einen Logout. Statt dafür ein Remote-Service-Namespace
 * mit Typert-Schemata zu deklarieren, hängt dieses Modul eine gewöhnliche
 * JSON-Route an den geteilten `/api`-Kanal der Connection.
 *
 * Der Kanal ist die richtige Ebene, und das ist keine Bequemlichkeit: eine
 * `connection.fetch`-Route wird laut Vertrag **nach** der Vertrauens- und
 * Authentisierungsprüfung des Trägers aufgerufen. Eine direkt am `webServer`
 * registrierte Route läge daneben und wäre unauthentisiert erreichbar — die
 * Konto-Id und der Tarif des OpenAI-Kontos sind nichts, was ohne Sitzung
 * herausgehen darf.
 *
 * Die Route gibt **niemals** Token heraus: sie liefert Konto-Id, Tarif,
 * Ablaufzeit und den Login-Zustand. Der Access-Token verlässt den Host nicht.
 *
 * @module dsh-codex-account/control
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Der Pfad unter `/api`, unter dem die Karte ihren Zustand liest und Aktionen
 * auslöst. Die Konstante ist absolut, weil der Träger sie gegen den
 * `/api`-Kanal auflöst.
 */
export const CONTROL_PATH = '/api/codex-account/control'

/** Wie lange ein Login-Vorgang höchstens auf den Browser-Callback wartet. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/** Eine JSON-Antwort bauen. */
function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Die Steuerfläche eines Plugin-Mounts.
 *
 * Ein Login läuft asynchron: der Aufruf kehrt sofort zurück und die Karte
 * fragt den Zustand ab, bis `login` von `pending` auf ein Ergebnis springt.
 * Nur ein Vorgang gleichzeitig — ein zweiter Klick träfe dasselbe Konto.
 */
export class CodexControl {
  /**
   * @param options - Store, Konten und die OAuth-Vorgänge.
   */
  constructor(options) {
    this.store = options.store
    this.accounts = options.accounts
    this.login = options.login
    this.logout = options.logout
    this.status = options.status
    this.importFromCodexCli = options.importFromCodexCli
    this.codexAuthPath = options.codexAuthPath ?? join(homedir(), '.codex', 'auth.json')
    /** Der laufende Login, oder undefined. */
    this.pending = undefined
    /** Ergebnis des letzten Vorgangs, für die Anzeige. */
    this.lastResult = undefined
  }

  /**
   * Ein Konto über Id auflösen.
   * @param id - die angefragte Konto-Id, oder undefined für das erste Konto.
   * @returns die Kontokonfiguration oder undefined.
   */
  account(id) {
    if (id === undefined) return this.accounts[0]
    return this.accounts.find((account) => account.id === id)
  }

  /**
   * Den Zustand aller Konten beschreiben.
   * @returns die Nutzlast der Karte.
   */
  async state() {
    const rows = []
    for (const account of this.accounts) {
      const state = await this.status(this.store, account.id)
      rows.push({
        id: account.id,
        provider: account.provider,
        displayName: account.displayName ?? 'OpenAI Codex',
        configured: state.configured === true,
        account: state.account ?? null,
        plan: state.plan ?? null,
        expiresAt: typeof state.expiresAt === 'number' ? state.expiresAt : null,
        expired: state.expired === true,
        error: state.error ?? null,
      })
    }
    const pending = this.pending
    return {
      accounts: rows,
      login: pending === undefined
        ? null
        : { accountId: pending.accountId, startedAt: pending.startedAt, url: pending.url ?? null },
      lastResult: this.lastResult ?? null,
    }
  }

  /**
   * Einen Login starten. Kehrt sofort zurück; der Vorgang läuft im Hintergrund
   * und ist über {@link state} beobachtbar.
   * @param accountId - das anzumeldende Konto.
   * @returns der Startzustand.
   */
  startLogin(accountId) {
    const account = this.account(accountId)
    if (account === undefined) throw new Error(`Unbekanntes Konto "${accountId}"`)
    if (this.pending !== undefined) throw new Error(`Für "${this.pending.accountId}" läuft bereits ein Login`)

    const entry = { accountId: account.id, startedAt: Date.now(), url: null, controller: new AbortController() }
    this.pending = entry
    this.lastResult = null

    const timer = setTimeout(() => entry.controller.abort(new Error('Zeitüberschreitung')), LOGIN_TIMEOUT_MS)
    const settle = (result) => {
      clearTimeout(timer)
      this.pending = undefined
      this.lastResult = { accountId: account.id, at: Date.now(), ...result }
    }

    this.login({
      store: this.store,
      accountId: account.id,
      method: 'browser',
      signal: entry.controller.signal,
      // Bewusst kein `openBrowser`: dieser Aufruf kommt aus dem Web-GUI, der
      // Nutzer ist also schon in einem Browser. Ein `xdg-open` würde dort ein
      // zweites Fenster mit frischem Profil auf den Desktop werfen — bei
      // wiederholtem Klick mehrere. Die Karte zeigt die URL als Link.
      onEvent: (event) => {
        // Die Autorisierungs-URL meldet der Flow, bevor er auf den Callback
        // wartet — sie ist das Einzige, was die Karte währenddessen anzeigen kann.
        if (event.kind === 'url' && event.url !== undefined) entry.url = event.url
      },
    })
      .then((claims) => settle({
        ok: true,
        account: claims.accountId ?? null,
        plan: claims.planType ?? null,
      }))
      .catch((error) => {
        const message = String(error?.message ?? error)
        settle({ ok: false, error: /abgebrochen|abort/i.test(message) ? 'abgebrochen oder Zeitüberschreitung' : message })
      })

    return { accountId: account.id, started: true }
  }

  /**
   * Einen laufenden Login abbrechen.
   * @returns ob etwas abgebrochen wurde.
   */
  cancelLogin() {
    if (this.pending === undefined) return { cancelled: false }
    this.pending.controller.abort(new Error('vom Benutzer abgebrochen'))
    return { cancelled: true }
  }

  /**
   * Einen vorhandenen Codex-CLI-Login übernehmen.
   * @param accountId - das Zielkonto.
   * @returns die Kontodaten.
   */
  async importFromCodex(accountId) {
    const account = this.account(accountId)
    if (account === undefined) throw new Error(`Unbekanntes Konto "${accountId}"`)
    const claims = await this.importFromCodexCli(this.store, account.id, this.codexAuthPath)
    return { accountId: account.id, account: claims.accountId ?? null, plan: claims.planType ?? null }
  }

  /**
   * Ein Konto abmelden.
   * @param accountId - das Konto.
   * @returns der Vollzug.
   */
  async logoutAccount(accountId) {
    const account = this.account(accountId)
    if (account === undefined) throw new Error(`Unbekanntes Konto "${accountId}"`)
    if (this.pending?.accountId === account.id) this.cancelLogin()
    await this.logout(this.store, account.id)
    return { accountId: account.id, loggedOut: true }
  }

  /**
   * Eine Anfrage der Karte bedienen.
   *
   * Ein Fehler in einer Aktion ist eine erwartbare Antwort — „läuft schon",
   * „unbekanntes Konto" — und geht als 400 mit Begründung zurück, nicht als
   * 500, das die Karte als kaputt darstellt.
   *
   * @param request - die bereits authentisierte Anfrage.
   * @returns die JSON-Antwort.
   */
  async handle(request) {
    try {
      if (request.method === 'GET') return json(200, await this.state())

      let body = {}
      try {
        const text = (await request.text()).trim()
        if (text.length > 0) {
          const parsed = JSON.parse(text)
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) body = parsed
        }
      } catch (error) {
        return json(400, { error: `Ungültiger Anfrage-Body: ${String(error?.message ?? error)}` })
      }

      switch (body.action) {
        case 'login':
          return json(200, this.startLogin(body.accountId))
        case 'cancel':
          return json(200, this.cancelLogin())
        case 'import':
          return json(200, await this.importFromCodex(body.accountId))
        case 'logout':
          return json(200, await this.logoutAccount(body.accountId))
        default:
          return json(400, { error: `Unbekannte Aktion "${String(body.action)}"` })
      }
    } catch (error) {
      return json(400, { error: String(error?.message ?? error) })
    }
  }
}

/**
 * Die Steuerroute am geteilten API-Kanal registrieren.
 *
 * Wartet über `ctx.inject` auf den `connection`-Service, statt ihn
 * vorauszusetzen: eine Composition ohne Web-Oberfläche mountet dieses Plugin
 * weiterhin, nur ohne Karte.
 *
 * @param ctx - der Cordis-Kontext der Plugin-Zeile.
 * @param control - die Steuerfläche.
 */
export function registerControlRoute(ctx, control) {
  const register = (connCtx) => {
    connCtx.effect(
      () => connCtx.connection.fetch.register({
        path: CONTROL_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: (request) => control.handle(request),
      }),
      'codex-account: settings route',
    )
  }
  if (ctx.get('connection') === undefined) ctx.inject(['connection'], register)
  else register(ctx)
}
