/**
 * Die Codex-Route als Harness-`LlmAdapter`.
 *
 * Ein Adapter bedient eine Route (konfigurierbar, Vorgabe `codex`). Die
 * OAuth-Token erreichen diese Klasse nie: pi-ai löst sie über den
 * Account-Store auf, den die Models-Sammlung bekommen hat, und erneuert sie
 * dort unter der Store-Sperre.
 *
 * @module dsh-codex-account/adapter
 */

import { getSupportedThinkingLevels, isContextOverflow } from '@earendil-works/pi-ai'
import { LlmAdapter, LlmError, ReasoningEffortId, attributionHeaders, contentHasImage } from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { toCodexContextWithImages, toStreamChunks } from './convert.js'

/** Die pi-ai-Provider-Id, unter der die Models-Sammlung den Codex-Provider führt. */
export const PI_AI_CODEX_ID = 'openai-codex'

/**
 * Die Denkstufen, die pi-ai für das Codex-Protokoll kennt. Der Harness
 * materialisiert eine explizite Stufe vor dem Dispatch, deshalb prüft der
 * Adapter sie hier gegen das exakte Modell statt sie stillschweigend zu senden.
 */
const EFFORT_LABELS = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
}

/** Einen Modell-Eintrag aus pi-ai in Harness-Sicht übersetzen. */
function toModelInfo(provider, model, modalities) {
  return {
    provider,
    id: model.id,
    name: model.name,
    inputModalities: modalities,
  }
}

/**
 * Die Eingabe-Modalitäten eines Modells.
 *
 * Maßgeblich ist der pi-ai-Katalog, nicht ein Routen-Schalter: der Katalog
 * führt je Modell, ob es Bilder annimmt. Eine route-weite Angabe würde für
 * ein textliches Modell Bilder versprechen — der Picker böte sie an und die
 * Anfrage scheiterte danach.
 *
 * `readImages: false` bleibt ein harter Riegel für den Fall, dass ein
 * Deployment die Bild-Eingabe ganz abbestellen will.
 *
 * @param model - der pi-ai-Katalog-Eintrag.
 * @param readImages - ob diese Route Bild-Eingabe überhaupt führen darf.
 * @returns die Modalitäten für die Harness-Sicht.
 */
function modalitiesFor(model, readImages) {
  if (!readImages) return ['text']
  return Array.isArray(model.input) && model.input.includes('image') ? ['text', 'image'] : ['text']
}

/**
 * Eine Route des Codex-Providers.
 */
export class CodexAccountAdapter extends LlmAdapter {
  /**
   * @param options - Route, Models-Sammlung und Stream-Verhalten.
   */
  constructor(options) {
    super()
    this.provider = options.provider
    this.displayName = options.displayName ?? 'OpenAI Codex'
    this.models = options.models
    this.readImages = options.readImages === true
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs
    this.transport = options.transport ?? 'sse'
    this.cacheRetention = options.cacheRetention ?? 'long'
    // Bild-Zugriff der Route: der Attachment-Dienst holt die Bytes, der
    // Pfad-Auflöser gibt dem Modell eine lesbare Ablage. Beides wird pro
    // Anfrage über einen Getter geholt, damit ein HMR-Wechsel oder ein
    // später gemounteter Dienst wirkt, ohne den Adapter neu zu bauen.
    this.resolveAttachments = options.resolveAttachments ?? (() => undefined)
    this.resolveImageAccess = options.resolveImageAccess ?? (() => undefined)
    this.requestImagePolicy = options.requestImagePolicy
    this.maxRequestImageBytes = options.maxRequestImageBytes
    // Der pi-ai-Katalog führt Modelle, die das Codex-Backend für
    // ChatGPT-Konten ablehnt ("is not supported when using Codex with a
    // ChatGPT account"). Sie hier herauszufiltern ist keine Kosmetik: ein
    // Picker, der eine Attrappe anbietet, erzeugt einen Fehler, den der
    // Nutzer für seinen eigenen hält.
    this.allowedModels = Array.isArray(options.allowedModels) ? new Set(options.allowedModels) : undefined
    // Die Denkstufe, mit der ein Modell startet (Modell-Id → Stufe). Welche
    // Stufe ein Modell überhaupt führen darf, entscheidet der pi-ai-Katalog;
    // hier wird nur nachgeschlagen, was das Deployment vorzieht. Ein Wert für
    // ein Modell ohne Denkstufen bleibt deshalb wirkungslos statt falsch.
    this.defaultEfforts = new Map(
      Object.entries(options.defaultEfforts ?? {}).filter(([, level]) => typeof level === 'string'),
    )
  }

  /** Ob diese Route das Modell anbietet. */
  offers(modelId) {
    return this.allowedModels === undefined || this.allowedModels.has(modelId)
  }

  /**
   * Die Codex-Katalogmodelle der Sammlung, in Katalogreihenfolge und auf die
   * von diesem Konto bedienten Modelle beschränkt.
   */
  catalog() {
    const all = this.models.getModels(PI_AI_CODEX_ID)
    return this.allowedModels === undefined ? all : all.filter((model) => this.allowedModels.has(model.id))
  }

  /** @returns die Anzeige-Metadaten dieser Route. */
  providerInfo(provider) {
    return { id: provider, name: this.displayName }
  }

  /** @returns die angebotenen Modelle; die Liste ist beratend, nicht ablehnend. */
  async listModels(provider) {
    return this.catalog().map((model) => toModelInfo(provider, model, modalitiesFor(model, this.readImages)))
  }

  /** @returns die exakten Metadaten eines Modells, inklusive Kontext und Denkstufen. */
  async resolveModel(provider, model) {
    const resolved = this.offers(model) ? this.models.getModel(PI_AI_CODEX_ID, model) : undefined
    if (resolved === undefined) {
      throw new LlmError(`Die Codex-Route kennt kein Modell "${model}"`, 'UNKNOWN_MODEL')
    }
    const levels = resolved.reasoning === true ? getSupportedThinkingLevels(resolved) : []
    // Die vorgezogene Stufe wird nur beworben, wenn dieses Modell sie führt:
    // der Harness lehnt eine Vorgabe ab, die nicht in `efforts` steht, und ein
    // Katalog, der deswegen scheitert, nähme die ganze Route aus dem Picker.
    const preferred = this.defaultEfforts.get(model)
    const defaultEffort = preferred !== undefined && levels.includes(preferred) ? preferred : undefined
    return {
      ...toModelInfo(provider, resolved, modalitiesFor(resolved, this.readImages)),
      context: { contextWindow: resolved.contextWindow },
      ...(levels.length === 0
        ? {}
        : {
            reasoning: {
              efforts: levels.map((level) => ({
                id: ReasoningEffortId(level),
                name: EFFORT_LABELS[level] ?? level,
              })),
              ...(defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultEffort) }),
            },
          }),
    }
  }

  /**
   * Eine explizite Denkstufe gegen das exakte Modell prüfen.
   * @param model - das aufgelöste pi-ai-Modell.
   * @param effort - die gewünschte Stufe, oder undefined für die Vorgabe.
   * @returns die pi-ai-Stufe, oder undefined wenn nichts gesendet wird.
   * @throws {LlmError} `UNSUPPORTED_REASONING_EFFORT`.
   */
  resolveEffort(model, effort) {
    if (effort === undefined) return undefined
    const supported = model.reasoning === true ? getSupportedThinkingLevels(model) : []
    if (!supported.includes(effort)) {
      throw new LlmError(
        `Das Codex-Modell "${model.id}" unterstützt die Denkstufe "${effort}" nicht`,
        'UNSUPPORTED_REASONING_EFFORT',
      )
    }
    return effort === 'off' ? undefined : effort
  }

  /**
   * Einen Modellaufruf streamen.
   * @param options - die zusammengesetzte Anfrage.
   * @returns die Harness-Chunks.
   */
  async *stream(options) {
    if (options.stop !== undefined) {
      throw new LlmError('dsh-codex-account unterstützt keine Stop-Sequenzen', 'UNSUPPORTED_OPTION')
    }
    options.signal?.throwIfAborted()

    const model = this.offers(options.model) ? this.models.getModel(PI_AI_CODEX_ID, options.model) : undefined
    if (model === undefined) {
      throw new LlmError(`Die Codex-Route kennt kein Modell "${options.model}"`, 'UNKNOWN_MODEL')
    }
    const reasoning = this.resolveEffort(model, options.reasoningEffort)

    // Der Watchdog besitzt die Abbruchkette: er bricht den Provider-Stream ab,
    // wenn länger als das Zeitlimit kein Ereignis mehr kommt, und wird selbst
    // mit dem Aufrufer-Signal verkettet.
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const watchdog = idleWatchdog(upstream, this.streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      // Der Bild-Zugriff wird nur aufgebaut, wenn die Historie wirklich ein
      // Bild führt: eine textliche Anfrage darf nicht daran scheitern, dass
      // der Attachment-Dienst in dieser Composition fehlt.
      const containsImage = options.messages.some((message) => contentHasImage(message.content))
      const attachments = containsImage ? this.resolveAttachments() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('Die Codex-Route braucht für Bilder den Attachment-Dienst', 'UNSUPPORTED_CONTENT')
      }
      const images = containsImage && attachments !== undefined
        ? {
            attachments,
            resolveImageAccess: (ref) => this.resolveImageAccess(attachments, ref),
            requestImagePolicy: this.requestImagePolicy,
            maxRequestImageBytes: this.maxRequestImageBytes,
          }
        : undefined
      const context = await toCodexContextWithImages(options, images)

      const events = this.models.streamSimple(model, context, {
        transport: this.transport,
        cacheRetention: this.cacheRetention,
        // Ein Adapter-Aufruf ist ein Versuch; die Wiederholungslogik des
        // Harness besitzt Retries, nicht der Adapter.
        maxRetries: 0,
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
        signal: watchdog.signal,
        headers: attributionHeaders(),
      })

      const iterator = toStreamChunks(events, model.contextWindow)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        for (;;) {
          const result = await watchdog.next(iterator)
          const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
          if (timeout !== undefined) throw timeout
          if (result.done === true) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('Codex-Stream-Konsument gestoppt')
          try {
            await iterator.return(undefined)
          } catch {
            // Der stabile Abbruchgrund steht bereits fest; ein Fehler beim
            // Aufräumen des Providers darf ihn nicht überschreiben.
          }
        }
      }
    } catch (error) {
      const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
      if (timeout !== undefined) {
        throw new LlmError(
          `Codex-Stream ohne Ereignis für ${this.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted === true) {
        throw new LlmError('Codex-Anfrage vom Aufrufer abgebrochen', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('Codex-Stream beendet')
      watchdog[Symbol.dispose]()
    }
  }
}

/** Ob eine pi-ai-Antwort ein Kontext-Überlauf ist; für Diagnose und Tests. */
export { isContextOverflow }
