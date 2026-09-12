/**
 * dsh-codex-account — OpenAI-Codex-Accounts (ChatGPT-Abo) über OAuth im
 * DeepSeek Harness, mit ausdrücklicher Kontowahl.
 *
 * Warum ein eigenes Plugin: die ausgelieferte Composition mountet weder
 * `ctx.authorization` (den Credential-Flow-Seam) noch eine UI, die einen
 * Login startet — `dsh-llm-pi-ai` registriert seinen Login-Flow deshalb nie,
 * und der Codex-Provider ist in pi-ais Katalog der eine Provider, der
 * ausschließlich per OAuth authentisiert. Dieses Plugin schließt genau diese
 * Lücke und behält dabei die Kontowahl in der Hand des Menschen:
 *
 * - **Mehrere Konten nebeneinander.** Der Credential-Store ist nach
 *   Account-Id geschlüsselt, nicht nach Provider-Id. Ein persönliches und ein
 *   geschäftliches ChatGPT-Konto stören sich damit nicht gegenseitig, und
 *   jedes bekommt eine eigene Route im Model-Picker.
 * - **Login über pi-ai.** Der OAuth-Flow (PKCE, lokaler Callback auf Port
 *   1455, Device-Code für headless) wird nicht nachgebaut, sondern über
 *   `@earendil-works/pi-ai` aufgerufen — dieselbe Bibliothek, die auch die
 *   Route bedient, damit Protokolländerungen nicht auseinanderlaufen.
 * - **Eigener Adapter.** Die Route wird als `LlmAdapter` registriert; der
 *   Harness bekommt damit Modelle, Kontextgrößen und Denkstufen wie von jeder
 *   anderen Route, ohne dass eine Zeile in `settings.yaml` nötig ist.
 *
 * ```yaml
 * - insert:
 *     - id: codex-account
 *       name: 'dsh-codex-account'
 *       config:
 *         accounts:
 *           - id: personal
 *             provider: codex-personal
 *             displayName: 'Codex (persönlich)'
 * ```
 *
 * @module dsh-codex-account
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { createModels } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { CodexAccountAdapter } from './adapter.js'
import { AccountStore, accountScopedStore } from './store.js'
import { codexCommand } from './command.js'
import { CodexControl, registerControlRoute } from './control.js'
import { importFromCodexCli, login, logout, status } from './auth.js'

export const name = 'dsh-codex-account'

/** Der LLM-Seam ist die eine harte Abhängigkeit; alles andere ist optional. */
export const inject = ['llm']

/** Vorgabe für den Zeitraum ohne Provider-Ereignis, bevor ein Stream als tot gilt. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Die Modelle, die das Codex-Backend für ChatGPT-Konten tatsächlich bedient.
 *
 * pi-ais Katalog ist die Obermenge: `gpt-5.3-codex-spark`, `gpt-5.4` und
 * `gpt-5.4-mini` stehen darin, werden für ein ChatGPT-Konto aber mit
 * „is not supported when using Codex with a ChatGPT account“ abgelehnt. Diese
 * Liste ist gegen ein persönliches Plus-Konto durchprobiert; sie ist eine
 * Vorgabe, keine Regel — `models: []` bietet den ganzen Katalog an.
 */
export const DEFAULT_MODELS = [
  'gpt-6-astra',
  'gpt-5.6-terra',
  'gpt-5.6-sol',
  'gpt-5.6-luna',
  'gpt-5.5',
]

/** Ein konfiguriertes Konto. */
const AccountSchema = Schema.object({
  /** Stabiler Schlüssel im Credential-Store; erscheint in Logout und Diagnose. */
  id: Schema.string().required(),
  /** Die Route, die dieser Account im Model-Picker belegt. */
  provider: Schema.string().required(),
  /** Anzeigename der Route. */
  displayName: Schema.string(),
})

export const Config = Schema.object({
  /**
   * Die Konten, die dieses Plugin anbietet. Ein Eintrag je ChatGPT-Konto;
   * jedes bekommt eine eigene Route und einen eigenen Credential-Eintrag.
   */
  accounts: Schema.array(AccountSchema).default([
    { id: 'personal', provider: 'codex-personal', displayName: 'Codex (persönlich)' },
  ]),
  /** Pfad des Credential-Dokuments; Vorgabe `$DSH_HOME/codex-accounts.json`. */
  storePath: Schema.string(),
  /**
   * Transport des Codex-Protokolls. `sse` ist der Vorgabewert, weil eine
   * zwischengespeicherte WebSocket-Sitzung einen Headless-Lauf offen halten
   * kann; `websocket-cached` lohnt für langlebige interaktive Sitzungen.
   */
  transport: Schema.union(['sse', 'websocket', 'websocket-cached', 'auto']).default('sse'),
  /** Prompt-Cache-Haltung für sitzungsgebundene Codex-Anfragen. */
  cacheRetention: Schema.union(['none', 'short', 'long']).default('long'),
  /** Zeitlimit ohne Provider-Ereignis während eines laufenden Streams. */
  streamIdleTimeoutMs: Schema.number()
    .min(Number.MIN_VALUE)
    .max(MAX_TIMER_DELAY_MS)
    .default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  /** Bild-Eingabe führen; ohne den Attachment-Dienst bleibt die Route textlich. */
  readImages: Schema.boolean().default(true),
  /** Pixel-Budget je Request-Bild; begrenzt die Normalisierung, nicht die Anzahl. */
  requestImagePixelBudget: Schema.number().default(4_194_304),
  /** Kodiertes Byte-Ziel je Request-Bild, bevor die Base64-Expansion greift. */
  requestImageMaxBytes: Schema.number().default(1_048_576),
  /** Aggregierte Obergrenze der Base64-Bildlast; älteste Bilder weichen zuerst. */
  maxRequestImageBytes: Schema.number().default(20 * 1024 * 1024),
  /**
   * Die von diesem Konto bedienten Modelle. Eine leere Liste bietet den
   * ganzen pi-ai-Katalog an — sinnvoll, wenn ein Konto mehr Modelle darf als
   * die Vorgabe kennt.
   */
  models: Schema.array(Schema.string()).default(DEFAULT_MODELS),
})

/**
 * Das Plugin mounten.
 *
 * Jede Route wird als Effekt registriert, damit ein HMR-Wechsel oder ein
 * abgeräumter Fiber beide Registrierungen mitnimmt — der Adapter und die
 * Route gehören zusammen und dürfen nicht getrennt überleben.
 *
 * @param ctx - der Cordis-Kontext der Zeile.
 * @param config - die aufgelöste Zeilenkonfiguration.
 */
export function apply(ctx, config) {
  const store = new AccountStore(config.storePath ?? dshHomePath('codex-accounts.json'))
  const accounts = config.accounts ?? []

  for (const account of accounts) {
    // Jedes Konto bekommt eine eigene Models-Sammlung über einem Store, der
    // genau dieses Konto adressiert: pi-ai spricht seinen CredentialStore über
    // die Provider-Id an, unsere Kontotrennung liegt eine Ebene darunter.
    const models = createModels({ credentials: accountScopedStore(store, account.id) })
    models.setProvider(openaiCodexProvider())
    const adapter = new CodexAccountAdapter({
      provider: account.provider,
      displayName: account.displayName ?? 'OpenAI Codex',
      models,
      readImages: config.readImages,
      // Eine leere Liste heißt „kein Filter", nicht „keine Modelle".
      allowedModels: Array.isArray(config.models) && config.models.length > 0 ? config.models : undefined,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs,
      transport: config.transport,
      cacheRetention: config.cacheRetention,
      // Beide Zugriffe werden pro Anfrage aufgelöst, nicht beim Mounten: der
      // Attachment- oder FS-Dienst kann später kommen (oder bei HMR wechseln),
      // und ein textlicher Lauf darf ohne sie funktionieren.
      resolveAttachments: () => ctx.get('attachments'),
      resolveImageAccess: (attachments, ref) =>
        resolveImageAttachmentAccess(
          attachments,
          (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath),
          ref,
        ),
      requestImagePolicy: {
        maxPixels: config.requestImagePixelBudget,
        maxBytes: config.requestImageMaxBytes,
      },
      maxRequestImageBytes: config.maxRequestImageBytes,
    })
    ctx.effect(() => ctx.llm.registerAdapter([account.provider], adapter))
  }

  // Der Login gehört ins Kommando-Flugzeug, wenn die Composition es mountet:
  // `/codex login` ist der Weg, den ein Mensch im Web-GUI tatsächlich findet.
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    ctx.effect(() => commands.register(codexCommand({
      store,
      accounts,
      login,
      logout,
      status,
      importFromCodexCli,
      codexAuthPath: join(homedir(), '.codex', 'auth.json'),
    })))
  }

  // Die Einstellungsseite im Browser: eine JSON-Route am webServer, die
  // Zustand liefert und Login, Import und Logout auslöst. Ohne Web-Oberfläche
  // mountet dieses Plugin weiterhin, nur ohne Karte.
  const control = new CodexControl({ store, accounts, login, logout, status, importFromCodexCli })
  registerControlRoute(ctx, control)

  // Diagnose ohne Kommando-Flugzeug: der Zustand jedes Kontos landet im Log,
  // damit ein Headless-Betrieb den fehlenden Login sofort sieht.
  for (const account of accounts) {
    status(store, account.id)
      .then((state) => {
        if (state.configured !== true) {
          ctx.logger?.info(
            'dsh-codex-account: Konto "%s" ist nicht angemeldet; /codex login %s',
            account.id,
            account.id,
          )
        }
      })
      .catch((error) => {
        ctx.logger?.warn('dsh-codex-account: Status von "%s" nicht lesbar: %s', account.id, String(error?.message ?? error))
      })
  }
}
