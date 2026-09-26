/**
 * Die Steuerroute der Codex-Karte (`lib/control.js`, `lib/index.js`).
 *
 * Diese Datei bewacht den Fehler, der die Route im Betrieb immer wieder
 * abgeräumt hat: **`connection` darf nur über einen Kontext gelesen werden,
 * der es auch injiziert.**
 *
 * Der Harness hängt eine Plugin-Zeile bei jedem Live-Reload neu ein — jede
 * Änderung an `cordis.patch.yml`, also jeder Modellwechsel im GUI, ein Pin
 * oder ein Preset. Beim ersten Mount fehlt `connection` noch, deshalb lief
 * die Registrierung über `ctx.inject(['connection'], …)` und funktionierte.
 * Stand `connection` beim erneuten Mounten dagegen schon bereit, nahm der
 * alte Schnellweg `register(ctx)` mit dem Kontext der Zeile — und der führt
 * `connection` nicht in `inject`. Cordis wirft dort beim Eigenschaftszugriff
 * („cannot get property \"connection\" without inject"), `apply` brach ab und
 * der Fiber wurde mitsamt der Adapter-Registrierung abgeräumt: jede Sitzung
 * auf der Route scheiterte danach mit `NO_ADAPTER`, die Karte zeigte nur noch
 * `HTTP 404`.
 *
 * Der Ersatz-Kontext unten bildet genau diesen Cordis-Vertrag nach: `get()`
 * ist der weiche Blick auf den Dienst, der Eigenschaftszugriff `connection`
 * ist ohne `inject` gesperrt. Ein Test gegen einen permissiven Fake würde den
 * Fehler nicht bemerken.
 *
 * Ausführen mit: node --test "tests/*.test.js"
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Config, apply } from '../lib/index.js'
import { CONTROL_PATH } from '../lib/control.js'

/** Der Cordis-Fehler, wenn ein Kontext einen Dienst ohne `inject` liest. */
const WITHOUT_INJECT = 'cannot get property "connection" without inject'

/**
 * Einen Cordis-nahen Ersatz-Kontext bauen.
 *
 * @param routes - die Registrierung der Fetch-Routen (Pfad → Route).
 * @param adapters - die registrierten LLM-Routen.
 * @param warnings - Sammler für Logger-Warnungen.
 * @returns der Kontext der Plugin-Zeile samt `dispose`.
 */
function cordisContext(routes, adapters, warnings, { failRegistration = false } = {}) {
  const connection = {
    fetch: {
      /** Wie der echte Träger: ein Pfad gehört genau einer Registrierung. */
      register: (route) => {
        if (failRegistration) throw new Error('Träger verweigert die Route')
        if (routes.has(route.path)) {
          throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
        }
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }

  const disposers = []
  const track = (result) => {
    if (typeof result === 'function') disposers.push(result)
    return result
  }

  const services = {
    effect: (fn, _label) => track(fn()),
    logger: { warn: (...args) => warnings.push(args), info: () => {} },
    llm: {
      registerAdapter: (providers) => {
        for (const provider of providers) adapters.add(provider)
        return () => {
          for (const provider of providers) adapters.delete(provider)
        }
      },
    },
  }

  const readConnection = (name) => (name === 'connection' ? connection : undefined)

  /**
   * Die Sicht eines Kind-Fibers aus `ctx.inject`: dieser Kontext **führt**
   * `connection` und darf es deshalb lesen.
   */
  const childContext = () => ({ ...services, get: readConnection, inject: () => {}, connection })

  const ctx = {
    ...services,
    /** Der weiche Blick auf einen Dienst, unabhängig von `inject`. */
    get: readConnection,
    /**
     * Ein Kind-Fiber, der die genannten Dienste führt. Genau hier liegt der
     * Unterschied zum Zugriff auf `ctx.connection`.
     */
    inject: (deps, callback) => {
      const child = childContext()
      if (deps.includes('connection')) callback(child)
      return child
    },
    /** Alle Effekte abräumen, wie es ein Live-Reload tut. */
    dispose: () => {
      for (const disposer of disposers.splice(0).reverse()) disposer()
    },
  }

  // Wie Cordis: der Kontext der Zeile injiziert `connection` nicht, also ist
  // der Eigenschaftszugriff darauf gesperrt — auch wenn `get()` ihn sieht.
  Object.defineProperty(ctx, 'connection', {
    get() {
      throw new Error(WITHOUT_INJECT)
    },
  })

  return ctx
}

/** Ein temporäres Verzeichnis für das Credential-Dokument. */
async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-control-'))
  try {
    return await run(join(dir, 'codex-accounts.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('die Karte registriert ihre Route auch, wenn connection schon bereitsteht', async () => {
  await withStore(async (storePath) => {
    const routes = new Map()
    const adapters = new Set()
    const warnings = []
    const ctx = cordisContext(routes, adapters, warnings)

    // Der Live-Reload-Fall: `connection` läuft bereits, die Zeile wird neu
    // eingehängt. Ein Zugriff auf `ctx.connection` wäre hier ein Fehler.
    apply(ctx, Config({ storePath, accounts: [{ id: 'business', provider: 'codex-business' }] }))

    assert.ok(routes.has(CONTROL_PATH), `die Steuerroute ${CONTROL_PATH} ist registriert`)
    assert.equal(routes.get(CONTROL_PATH).methods.join(','), 'GET,POST')
    assert.ok(adapters.has('codex-business'), 'die Modellroute ist unabhängig davon registriert')
    assert.deepEqual(warnings, [], 'kein Zusatzbaustein meldet einen Fehler')
  })
})

test('ein wiederholter Mount lässt Route und Modellroute bestehen', async () => {
  await withStore(async (storePath) => {
    const routes = new Map()
    const adapters = new Set()
    const warnings = []
    const ctx = cordisContext(routes, adapters, warnings)
    const config = Config({ storePath, accounts: [{ id: 'business', provider: 'codex-business' }] })

    apply(ctx, config)
    // Wie ein Live-Reload: erst abräumen, dann dieselbe Zeile neu einhängen.
    ctx.dispose()
    assert.equal(routes.has(CONTROL_PATH), false, 'das Abräumen gibt den Pfad wieder frei')
    assert.equal(adapters.has('codex-business'), false, 'das Abräumen gibt die Route wieder frei')

    apply(ctx, config)
    assert.ok(routes.has(CONTROL_PATH), 'der zweite Mount registriert die Steuerroute erneut')
    assert.ok(adapters.has('codex-business'), 'der zweite Mount registriert die Modellroute erneut')
    assert.deepEqual(warnings, [], 'kein Zusatzbaustein meldet einen Fehler')
  })
})

test('ein Fehler in der Karte nimmt die Modellroute nicht mit', async () => {
  await withStore(async (storePath) => {
    const routes = new Map()
    const adapters = new Set()
    const warnings = []
    // Der Träger verweigert die Registrierung — die Karte ist damit tot, die
    // Modellroute muss trotzdem stehen bleiben.
    const ctx = cordisContext(routes, adapters, warnings, { failRegistration: true })

    apply(ctx, Config({ storePath, accounts: [{ id: 'business', provider: 'codex-business' }] }))

    assert.equal(routes.has(CONTROL_PATH), false, 'die Karte hat keine Route')
    assert.ok(adapters.has('codex-business'), 'die Modellroute bleibt registriert')
    // Der Ausfall wird gemeldet (Meldung plus Fehlerobjekt), nicht verschluckt.
    const labels = warnings.map((args) => String(args[1] ?? ''))
    assert.ok(labels.includes('settings card route'), 'der Ausfall der Karte wird als Warnung gemeldet')
  })
})
