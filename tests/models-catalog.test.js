/**
 * Der Modellkatalog der Codex-Route (`lib/index.js`, `lib/adapter.js`).
 *
 * Diese Datei bewacht die eine Eigenschaft, die schon einmal still verloren
 * ging: **ohne `models` bietet die Route den vollständigen Codex-Katalog der
 * installierten pi-ai-Version an.** Eine fest eingetragene Liste war hier
 * Vorgabe und versteckte jedes Modell, das pi-ai längst führte — neue Modelle
 * tauchten erst auf, nachdem jemand die Id nachgetragen hatte.
 *
 * Der Test vergleicht bewusst gegen den Katalog der installierten pi-ai-Version
 * statt gegen eine feste Id-Liste: nur so wächst er mit einem pi-ai-Update mit,
 * und ein erneutes Einfrieren fällt auf. Er prüft außerdem, dass die Notausfahrt
 * `models: [...]` weiterhin filtert und ein ausgefiltertes Modell den richtigen
 * Fehlercode liefert.
 *
 * Ausführen mit: node --test "tests/*.test.js"
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModels } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'

import { Config, DEFAULT_MODELS, apply } from '../lib/index.js'

/**
 * Die Modell-Ids, die die installierte pi-ai-Version für Codex führt.
 *
 * Bewusst über den Provider und nicht über eine Konstante aus dem Paket: eine
 * Änderung an pi-ai soll diesen Test nicht brechen, sondern ihn mitziehen.
 *
 * @returns die Katalog-Ids in Katalogreihenfolge.
 */
function installedCatalog() {
  const models = createModels()
  models.setProvider(openaiCodexProvider())
  return models.getModels('openai-codex').map((model) => model.id)
}

/**
 * Das Plugin mit einem Ersatz-Kontext mounten und den Adapter einsammeln.
 *
 * Der Ersatz ist absichtlich minimal: `apply` braucht den LLM-Seam, den
 * Effekt-Sammler, einen Logger und — für die Steuerroute — einen Kontext ohne
 * `connection`. Letzteres lässt die Weboberfläche aus, ohne dass `apply`
 * scheitert; genau dieser Fall ist der Headless-Betrieb.
 *
 * @param config - die Zeilenkonfiguration, wie sie in der Patch-Ebene steht.
 * @param storePath - Pfad des Credential-Dokuments; ein temporärer im Test.
 * @returns die registrierten Routen mit ihren Adaptern.
 */
function mount(config, storePath) {
  const registered = []
  const ctx = {
    get: () => undefined,
    inject: () => {},
    effect: (fn) => fn(),
    logger: { warn: () => {}, info: () => {} },
    llm: {
      registerAdapter: (routes, adapter) => {
        registered.push({ routes, adapter })
        return () => {}
      },
    },
  }
  apply(ctx, Config({ storePath, ...config }))
  return registered
}

/** Ein temporäres Verzeichnis für das Credential-Dokument. */
async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-catalog-'))
  try {
    return await run(join(dir, 'codex-accounts.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('ohne models bietet die Route den ganzen installierten Katalog an', async () => {
  await withStore(async (storePath) => {
    const catalog = installedCatalog()
    assert.ok(catalog.length > 5, 'die installierte pi-ai-Version führt mehr als fünf Codex-Modelle')

    const registered = mount({
      accounts: [{ id: 'business', provider: 'codex-business' }],
    }, storePath)
    assert.equal(registered.length, 1, 'ein Konto, eine Route')

    const { routes, adapter } = registered[0]
    assert.deepEqual(routes, ['codex-business'])

    const listed = (await adapter.listModels('codex-business')).map((model) => model.id)
    assert.deepEqual(listed, catalog, 'die Route meldet genau den Katalog der installierten pi-ai-Version')
  })
})

test('die Vorgabe ist leer, damit keine zweite Modellliste veraltet', async () => {
  assert.deepEqual(DEFAULT_MODELS, [], 'DEFAULT_MODELS ist kein Filter')

  await withStore(async (storePath) => {
    const resolved = Config({
      storePath,
      accounts: [{ id: 'business', provider: 'codex-business' }],
    })
    assert.deepEqual(resolved.models, [], 'ohne models-Angabe bleibt die Liste leer')
  })
})

test('ein explizites models filtert weiterhin auf die genannten Ids', async () => {
  await withStore(async (storePath) => {
    const [first, second] = installedCatalog()

    const registered = mount({
      accounts: [{ id: 'business', provider: 'codex-business' }],
      models: [first, second],
    }, storePath)
    const { adapter } = registered[0]

    const listed = (await adapter.listModels('codex-business')).map((model) => model.id)
    assert.deepEqual(listed, [first, second], 'genau die beiden genannten Modelle')

    // Ein Modell, das der Katalog kennt, aber der Filter ausschließt: das ist
    // eine bewusste Entscheidung des Deployments und muss als UNKNOWN_MODEL
    // ankommen, nicht als Provider-Fehler.
    const excluded = installedCatalog().find((id) => id !== first && id !== second)
    if (excluded !== undefined) {
      await assert.rejects(
        () => adapter.resolveModel('codex-business', excluded),
        (error) => error.code === 'UNKNOWN_MODEL',
      )
    }
  })
})
