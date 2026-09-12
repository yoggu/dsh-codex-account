/**
 * Browser-Hälfte: die Einstellungsseite "OpenAI Codex".
 *
 * Handgeschrieben im `window.__ModuleLoader__.load`-Format, ohne JSX und ohne
 * Bundler — dieselbe Form, die das Referenz-Plugin `dsh-openai-codex-auth`
 * benutzt. Sie erklärt `./client` in der `exports`-Map des Pakets; der
 * Host-Halbbesitz des Pakets scannt `dsh.client` und hängt dieses Bundle als
 * eigene Zeile in den Boot-Graphen.
 *
 * Die Karte spricht über eine gewöhnliche JSON-Route mit dem Host
 * (`/api/codex-account/control`) und sieht niemals einen Token: sie zeigt
 * Konto-Id, Tarif und Ablaufzeit und löst Login, Import und Logout aus.
 *
 * @module dsh-codex-account/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-codex-account',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const PLUGIN_ID = 'dsh-codex-account'
    const ENDPOINT = '/api/codex-account/control'

    // Farben und Flächen kommen ausschließlich aus den Theme-Tokens des
    // Harness (`--dsw-alias-*`). Eigene Hex-Werte waren der Fehler der ersten
    // Fassung: sie greifen nur, solange das Theme zufällig passt, und liefern
    // sonst Browser-Defaults — im dunklen Theme unlesbar. Jeder hier benutzte
    // Token ist im Theme-Paket nachweislich definiert.
    const CSS = `
      .codexAccount{max-width:720px;padding:4px 0 40px;color:var(--dsw-alias-label-primary)}
      .codexAccountTitle{margin:0 0 10px;font-size:17px;line-height:1.35;font-weight:650;color:var(--dsw-alias-label-primary)}
      .codexAccountIntro{margin:0 0 22px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.75}
      .codexAccountCard{overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}
      .codexAccountCard + .codexAccountCard{margin-top:14px}
      .codexAccountHead{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:18px 20px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
      .codexAccountName{margin:0;font-size:15px;font-weight:650;color:var(--dsw-alias-label-primary)}
      .codexAccountMeta{margin:5px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;overflow-wrap:anywhere}
      .codexAccountBadge{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;border-radius:999px;padding:5px 11px;font-size:12px;font-weight:600;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
      .codexAccountBadge.on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
      .codexAccountBadge.wait{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
      .codexAccountBadge.off{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
      .codexAccountDot{width:7px;height:7px;border-radius:50%;background:currentColor}
      .codexAccountBody{padding:18px 20px 20px}
      .codexAccountGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 20px;margin:0}
      .codexAccountRow{display:flex;flex-direction:column;gap:6px;min-width:0}
      .codexAccountKey{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-caption)}
      .codexAccountValue{font-size:14px;line-height:1.45;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
      .codexAccountActions{display:flex;flex-wrap:wrap;gap:9px;margin-top:22px}
      .codexAccountButton{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:8px 14px;font:600 13px/1.2 inherit;cursor:pointer}
      .codexAccountButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
      .codexAccountButton:disabled{opacity:.45;cursor:not-allowed}
      .codexAccountButton.primary{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
      .codexAccountButton.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}
      .codexAccountButton.danger{color:var(--dsw-alias-state-error-primary)}
      .codexAccountNote{margin:16px 0 0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:11px 13px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.7;overflow-wrap:anywhere}
      .codexAccountError{margin:16px 0 0;border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;padding:11px 13px;color:var(--dsw-alias-state-error-primary);font-size:12.5px;line-height:1.7;overflow-wrap:anywhere}
      .codexAccountLink{color:var(--dsw-alias-brand-primary);text-decoration:underline;overflow-wrap:anywhere}
      @media(max-width:620px){.codexAccountGrid{grid-template-columns:1fr}}
    `

    if (
      typeof document !== 'undefined'
      && document.querySelector(`style[data-plugin="${PLUGIN_ID}"]`) === null
    ) {
      const style = document.createElement('style')
      style.dataset.plugin = PLUGIN_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /** Eine Anfrage an die Steuerroute des Hosts. */
    async function call(method, body) {
      const response = await fetch(ENDPOINT, {
        method,
        cache: 'no-store',
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      })
      const value = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`)
      return value
    }

    /** Eine Konto-Id kurz darstellen; die volle steht im title-Attribut. */
    function short(value) {
      if (typeof value !== 'string' || value.length === 0) return '—'
      return value.length > 22 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value
    }

    /** Die Restlaufzeit eines Tokens in Worten. */
    function remaining(expiresAt) {
      if (typeof expiresAt !== 'number') return 'unbekannt'
      const ms = expiresAt - Date.now()
      if (ms <= 0) return 'abgelaufen — wird beim nächsten Aufruf erneuert'
      const minutes = Math.floor(ms / 60000)
      if (minutes < 60) return `${minutes} min`
      const hours = Math.floor(minutes / 60)
      if (hours < 48) return `${hours} h`
      return `${Math.floor(hours / 24)} Tage`
    }

    /** Ein Zeitpunkt, lokal und knapp. */
    function when(expiresAt) {
      if (typeof expiresAt !== 'number') return '—'
      return new Date(expiresAt).toLocaleString([], {
        day: 'numeric',
        month: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    }

    /** Eine Zeile im Datenraster. */
    function Row(props) {
      return h('div', { className: 'codexAccountRow' },
        h('span', { className: 'codexAccountKey' }, props.label),
        h('span', { className: 'codexAccountValue', title: props.title ?? undefined }, props.value),
      )
    }

    /** Eine Kontokarte mit Status und Aktionen. */
    function AccountCard(props) {
      const { account, login, busy, onAction } = props
      const connected = account.configured === true
      const pending = login !== null && login.accountId === account.id
      const badgeClass = pending
        ? 'codexAccountBadge wait'
        : connected
          ? 'codexAccountBadge on'
          : 'codexAccountBadge off'
      const badgeText = pending
        ? 'Warte auf Browser'
        : connected
          ? (account.expired ? 'Token abgelaufen' : 'Verbunden')
          : 'Nicht angemeldet'

      return h('div', { className: 'codexAccountCard' },
        h('div', { className: 'codexAccountHead' },
          h('div', { style: { minWidth: 0 } },
            h('h3', { className: 'codexAccountName' }, account.displayName),
            h('p', { className: 'codexAccountMeta' }, `Route ${account.provider} · Konto ${account.id}`),
          ),
          h('span', { className: badgeClass },
            h('span', { className: 'codexAccountDot' }),
            badgeText,
          ),
        ),
        h('div', { className: 'codexAccountBody' },
          h('div', { className: 'codexAccountGrid' },
            h(Row, { label: 'Konto-Id', value: short(account.account), title: account.account ?? undefined }),
            h(Row, { label: 'Tarif', value: account.plan ?? '—' }),
            h(Row, { label: 'Token gültig', value: remaining(account.expiresAt) }),
            h(Row, { label: 'Läuft ab', value: when(account.expiresAt) }),
          ),
          account.error === null || account.error === undefined
            ? null
            : h('p', { className: 'codexAccountError', role: 'alert' }, account.error),
          pending && typeof login.url === 'string'
            ? h('p', { className: 'codexAccountNote' },
                'Login läuft. ',
                h('a', { className: 'codexAccountLink', href: login.url, target: '_blank', rel: 'noreferrer' }, 'Autorisierung in neuem Tab öffnen'),
                ' und dort bestätigen. Nach dem Login kehrt OpenAI auf localhost:1455 zurück; diese Karte aktualisiert sich von selbst.',
              )
            : null,
          h('div', { className: 'codexAccountActions' },
            h('button', {
              type: 'button',
              className: 'codexAccountButton primary',
              disabled: busy || (login !== null && !pending),
              onClick: () => onAction(pending ? 'cancel' : 'login', account.id),
            }, pending ? 'Abbrechen' : connected ? 'Neu anmelden' : 'Anmelden'),
            h('button', {
              type: 'button',
              className: 'codexAccountButton',
              disabled: busy || login !== null,
              onClick: () => onAction('import', account.id),
            }, 'Aus Codex CLI übernehmen'),
            connected
              ? h('button', {
                  type: 'button',
                  className: 'codexAccountButton danger',
                  disabled: busy,
                  onClick: () => onAction('logout', account.id),
                }, 'Abmelden')
              : null,
          ),
        ),
      )
    }

    /** Die Einstellungsseite. */
    function CodexSettings() {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const alive = useRef(true)

      const load = useCallback(async () => {
        try {
          const next = await call('GET')
          if (alive.current) {
            setState(next)
            setError('')
          }
        } catch (loadError) {
          if (alive.current) setError(String(loadError?.message ?? loadError))
        }
      }, [])

      useEffect(() => {
        alive.current = true
        void load()
        return () => { alive.current = false }
      }, [load])

      // Solange ein Login auf den Browser-Callback wartet, ist Abfragen der
      // einzige Weg, das Ergebnis zu bemerken — der Host schiebt nichts.
      const pending = state !== null && state.login !== null
      useEffect(() => {
        if (!pending) return undefined
        const timer = window.setInterval(() => { void load() }, 2000)
        return () => window.clearInterval(timer)
      }, [pending, load])

      const onAction = useCallback(async (action, accountId) => {
        setBusy(true)
        try {
          await call('POST', { action, accountId })
          await load()
        } catch (actionError) {
          setError(String(actionError?.message ?? actionError))
        } finally {
          setBusy(false)
        }
      }, [load])

      const accounts = state === null ? [] : state.accounts
      const last = state === null ? null : state.lastResult

      return h('section', { className: 'codexAccount' },
        h('h2', { className: 'codexAccountTitle' }, 'OpenAI Codex'),
        h('p', { className: 'codexAccountIntro' },
          'Zugang über ein ChatGPT-Abonnement (Plus, Pro, Business). Der Login läuft über die offizielle Autorisierungsseite von OpenAI; '
          + 'der Token wird ausschließlich auf dem Host gespeichert und diese Seite sieht ihn nie.',
        ),
        error.length > 0 ? h('p', { className: 'codexAccountError', role: 'alert' }, error) : null,
        last !== null && last.ok === false
          ? h('p', { className: 'codexAccountError', role: 'alert' }, `Letzter Vorgang für „${last.accountId}“ fehlgeschlagen: ${last.error}`)
          : null,
        state === null
          ? h('p', { className: 'codexAccountNote' }, 'Zustand wird gelesen …')
          : accounts.map((account) => h(AccountCard, {
              key: account.id,
              account,
              login: state.login,
              busy,
              onAction,
            })),
        h('p', { className: 'codexAccountNote' },
          'Die Modelle dieser Konten stehen im Modellwähler unter der jeweiligen Route. '
          + 'Bild-Eingabe ist derzeit abgeschaltet.',
        ),
      )
    }

    const inject = ['slots']

    /**
     * Die Seite in den Einstellungen registrieren.
     *
     * `order: 11` setzt sie direkt hinter „Models" (order 10) — dieselbe
     * Stelle, die auch die Referenz-Plugins wählen. Eine eigene Sektion statt
     * einer Karte in der Model-Liste, weil jene Liste nur Einträge zeigt, die
     * aus `settings.yaml` verwaltet werden; diese Route wird von der
     * Composition registriert.
     *
     * @param ctx - der Client-Kontext.
     */
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'codex',
        order: 11,
        label: () => 'OpenAI Codex',
      }, CodexSettings))
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
