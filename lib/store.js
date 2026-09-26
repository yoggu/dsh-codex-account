/**
 * Dateibasierter Credential-Store für mehrere Codex-Accounts.
 *
 * Ein JSON-Dokument unter `$DSH_HOME/codex-accounts.json` hält einen
 * typisierten pi-ai-Credential je Account-Id. Geschrieben wird ausschließlich
 * über `modify` (der einzige Schreibpfad, den der pi-ai-Vertrag erlaubt), damit
 * ein Token-Refresh nicht parallel in zwei Prozessen läuft und einen rotierten
 * Refresh-Token doppelt verbraucht. Schreibvorgänge sind atomar und laufen
 * unter der prozessübergreifenden Dateisperre von `dsh-atomic-write`.
 *
 * Das Dokument ist `0600` in einem `0700`-Verzeichnis. Ein Dokument mit
 * Gruppen- oder Fremd-Leserechten wird vor dem Lesen abgelehnt, weil es
 * OAuth-Token enthält.
 *
 * @module dsh-codex-account/store
 */

import { constants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { safeFailure } from './safe-error.js'

/** Datei- und Verzeichnisrechte: nur der Eigentümer liest die Token. */
const FILE_MODE = 0o600
const DIR_MODE = 0o700

/**
 * Ein persistenter Credential-Store über mehrere Accounts.
 *
 * Anders als `$DSH_HOME/.credentials.yaml` ist dieser Store mehrfach-belegt:
 * jeder Account hat seinen eigenen Eintrag, und die Route wählt über die
 * Account-Id aus, welcher gilt. Genau das erlaubt es, ein persönliches und ein
 * geschäftliches ChatGPT-Konto nebeneinander zu betreiben, ohne den jeweils
 * anderen Login zu überschreiben.
 */
export class AccountStore {
  /** @param path - absoluter Pfad des JSON-Dokuments. */
  constructor(path) {
    this.path = path
  }

  /** Elternverzeichnis mit Eigentümer-Rechten sicherstellen. */
  async ensureDir() {
    const parent = dirname(this.path)
    await mkdir(parent, { recursive: true, mode: DIR_MODE })
    const info = await lstat(parent)
    if (!info.isDirectory() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
      throw safeFailure('Credential-Verzeichnis muss ein echtes Verzeichnis mit Rechten 0700 sein')
    }
  }

  /** Das ganze Dokument lesen; fehlende Datei ist ein leeres Dokument. */
  async readDocument() {
    await this.ensureDir()
    let handle
    try {
      // O_NOFOLLOW rejects final-component symlinks; on hosts without it,
      // lstat is a best-effort fallback (it cannot prevent a path-swap race).
      if (constants.O_NOFOLLOW === undefined && (await lstat(this.path)).isSymbolicLink()) {
        throw safeFailure('Credential-Datei darf kein Symlink sein')
      }
      // Check the inode actually read, not a later stat(path): the latter can
      // validate a different inode after a rename and leak the old contents.
      handle = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    } catch (error) {
      if (error?.code === 'ENOENT') return {}
      throw error
    }
    let text
    try {
      const info = await handle.stat()
      if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
        throw safeFailure('Credential-Datei muss eine reguläre Datei mit Rechten 0600 sein')
      }
      text = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
    const parsed = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`dsh-codex-account: ${this.path} ist kein JSON-Objekt`)
    }
    return parsed
  }

  /** Ein Dokument atomar mit Eigentümer-Rechten schreiben. */
  async writeDocument(document) {
    await writeFileAtomic(this.path, `${JSON.stringify(document, null, 2)}\n`, {
      mode: FILE_MODE,
      dirMode: DIR_MODE,
    })
  }

  /** Alle Account-Ids, für Status und Diagnose. */
  async listAccounts() {
    return Object.keys(await this.readDocument())
  }

  /**
   * Ein Credential lesen.
   * @param accountId - Account-Id (nicht der pi-ai-Provider-Id).
   * @returns der gespeicherte Credential oder undefined.
   */
  async read(accountId) {
    return (await this.readDocument())[accountId]
  }

  /**
   * Ein Credential ändern — der einzige Schreibpfad.
   *
   * Der Refresh innerhalb von `modify` ist Absicht: pi-ai erneuert einen
   * abgelaufenen Token genau hier, damit zwei gleichzeitige Anfragen nicht
   * beide denselben Einmal-Refresh-Token einlösen.
   *
   * @param accountId - Account-Id.
   * @param mutate - erhält den aktuellen Credential, liefert den neuen oder undefined.
   * @returns der geschriebene Credential, oder der bestehende bei undefined.
   */
  async modify(accountId, mutate) {
    await this.ensureDir()
    return withFileLock(this.path, async () => {
      const document = await this.readDocument()
      const next = await mutate(document[accountId])
      if (next === undefined) return document[accountId]
      document[accountId] = next
      await this.writeDocument(document)
      return next
    })
  }

  /**
   * Ein Credential entfernen (Logout).
   * @param accountId - Account-Id.
   */
  async delete(accountId) {
    await this.ensureDir()
    return withFileLock(this.path, async () => {
      const document = await this.readDocument()
      if (!(accountId in document)) return
      delete document[accountId]
      await this.writeDocument(document)
    })
  }
}

/**
 * Eine Sicht über den Store, die genau einen Account adressiert.
 *
 * pi-ai spricht seinen `CredentialStore` über die *Provider-Id* an
 * (`openai-codex`), nicht über unsere Account-Id. Diese Hülle übersetzt:
 * `read('openai-codex')` liest den Account, den die Route ausgewählt hat, und
 * `modify('openai-codex', …)` schreibt dorthin zurück — inklusive des Tokens,
 * den pi-ai beim Refresh rotiert.
 *
 * @param store - der Mehr-Account-Store.
 * @param accountId - der Account, den diese Sicht repräsentiert.
 * @returns ein pi-ai-konformer CredentialStore für genau einen Account.
 */
export function accountScopedStore(store, accountId) {
  return {
    async read() {
      return store.read(accountId)
    },
    async list() {
      const credential = await store.read(accountId)
      return credential === undefined ? [] : [{ providerId: accountId, type: credential.type }]
    },
    async modify(_providerId, mutate) {
      return store.modify(accountId, mutate)
    },
    async delete() {
      await store.delete(accountId)
    },
  }
}
