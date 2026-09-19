/**
 * Übersetzung zwischen Harness- und pi-ai-Vokabular für die Codex-Route.
 *
 * Die Request-Hälfte projiziert `GenerateOptions` in pi-ais `Context`, die
 * Stream-Hälfte übersetzt pi-ai-Assistant-Events in Harness-`StreamChunk`s.
 * Beide Hälften folgen dem Aufbau von `@deepseek-ai/dsh-llm-pi-ai` (MIT,
 * © DeepSeek AI) — `context.ts` und `stream.ts` — ohne provider-eigenen
 * Replay-Zustand: die Codex-Route führt fremde (provider-neutrale) Historie,
 * Bilder aber nativ.
 *
 * Bild-Eingabe: Harness-Content-Blöcke tragen nur eine durable
 * `ImageAttachmentRef`; die Bytes holt `prepareRequestImages` über den
 * Attachment-Dienst und legt sie als pi-ai-`ImageContent` (base64) in den
 * Context. Die Codex-Route serialisiert sie über den gemeinsamen
 * Responses-Pfad von pi-ai als `input_image` — also erst hier, nicht auf der
 * Leitung, entscheidet sich, ob eine Anfrage Bilder führt.
 *
 * @module dsh-codex-account/convert
 */

import {
  ToolCallId,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  INVALID_CREDENTIAL_CODE,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  contentHasImage,
  isContextWindowExceededError,
  isQuotaExceededError,
  offloadedImageText,
  projectOffloadedImages,
  requestImageHandleText,
  requiredImageOffload,
} from '@deepseek-ai/dsh-llm'
import { isContextOverflow } from '@earendil-works/pi-ai'

/** Code, den der Harness für einen fehlenden/ungültigen Credential kennt. */
const AUTH_CODE = INVALID_CREDENTIAL_CODE

/** Tool-Argument-JSON einlesen; Modellfehler werden zu `{}` statt zu einem Abbruch. */
function parseArguments(raw) {
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed
  } catch {
    /* fällt durch */
  }
  return {}
}

/** Der Null-Usage-Wert, den pi-ai auf historischen Assistant-Nachrichten verlangt. */
function emptyPiUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

/** Die Textblöcke einer Harness-Nachricht zusammenziehen. */
function flattenText(message) {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** Text rekursiv aus einem Tool-Ergebnis holen. */
function toolResultText(blocks) {
  return blocks
    .map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'tool-result') return toolResultText(block.content)
      return ''
    })
    .join('')
}

/**
 * Jede durable Bild-Referenz einer Content-Liste einsammeln, Tool-Ergebnisse
 * eingeschlossen.
 *
 * Die Reihenfolge ist die des Auftretens; `attachmentId` entdoppelt, weil ein
 * und dieselbe Anlage in mehreren Nachrichten stehen kann und ihr
 * Request-Byte-Äquivalent nur einmal geholt werden soll.
 *
 * @param blocks - die Content-Blöcke einer Nachricht.
 * @param refs - die Sammlung, in die geschrieben wird.
 */
function collectImageRefs(blocks, refs) {
  for (const block of blocks) {
    if (block.type === 'image' && block.offloaded !== true) refs.set(block.attachment.attachmentId, block.attachment)
    else if (block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
}

/**
 * Die angeforderten Bytes jeder vorkommenden Bild-Referenz holen.
 *
 * @param messages - die vollständige Anfrage-Historie.
 * @param attachments - der durable Attachment-Dienst.
 * @param policy - Pixel-Budget und Byte-Ziel der Route.
 * @param signal - optionale Abbruchkette.
 * @returns Request-Versionen, adressiert über die `attachmentId`.
 */
export async function prepareRequestImages(messages, attachments, policy, signal) {
  const refs = new Map()
  for (const message of messages) collectImageRefs(message.content, refs)
  const ordered = [...refs.values()]
  const prepared = await Promise.all(ordered.map((ref) => attachments.readImageRequest(ref, policy, signal)))
  return new Map(ordered.map((ref, index) => [ref.attachmentId, prepared[index]]))
}

/**
 * Die Textblöcke einer Harness-Nachricht zusammenziehen, wenn sie rein textlich
 * ist; sonst die Blöcke selbst zurückgeben.
 *
 * pi-ai akzeptiert für eine User-Nachricht entweder einen String oder eine
 * Blockliste. Ein String ist der Normalfall und hält die Historie kompakt;
 * sobald ein Bild dabei ist, braucht es die Liste.
 *
 * @param content - die übersetzten pi-ai-Blöcke.
 * @returns der String oder die Blockliste.
 */
function joinOrBlocks(content) {
  return content.every((block) => block.type === 'text')
    ? content.map((block) => block.text).join('')
    : content
}

/**
 * Harness-Content in pi-ai-Content übersetzen, Bilder inklusive.
 *
 * Ein Bild wird zu zwei Blöcken: einem stabilen Modell-Handle (Name,
 * Maße, Ablagepfad) und dem eigentlichen `ImageContent`. Das Handle ist keine
 * Kosmetik — es gibt dem Modell eine Identität, auf die es sich beziehen kann,
 * und es ist der einzige Träger der Anlage, wenn ihr Byte-Äquivalent später
 * einem Request-Budget zum Opfer fällt.
 *
 * @param blocks - die Harness-Content-Blöcke.
 * @param requestImages - die geholten Request-Versionen, adressiert über `attachmentId`.
 * @param resolveImageAccess - Auflöser für den Ausführungswelt-Pfad einer Anlage.
 * @returns der pi-ai-Content als String oder Blockliste.
 * @throws {LlmError} `UNSUPPORTED_CONTENT`, wenn eine Bild-Referenz keine Request-Version hat.
 */
function toUserContent(blocks, requestImages, resolveImageAccess) {
  const content = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text })
        break
      case 'image': {
        const version = requestImages.get(block.attachment.attachmentId)
        // Ohne Request-Version fehlt entweder die Anlage oder der
        // Attachment-Dienst; beides ist kein Zustand, den diese Route
        // stillschweigend zu Text degradieren darf.
        if (version === undefined) {
          throw new LlmError(
            `Die Codex-Route hat keine Request-Version für die Bild-Anlage "${block.attachment.attachmentId}"`,
            'UNSUPPORTED_CONTENT',
          )
        }
        content.push({
          type: 'text',
          text: requestImageHandleText(block.attachment, version, resolveImageAccess(block.attachment)),
        })
        content.push({
          type: 'image',
          data: Buffer.from(version.data).toString('base64'),
          mimeType: version.mediaType,
        })
        break
      }
      case 'tool-result': {
        // Ein eingebettetes Bild in einem Tool-Ergebnis wird genauso
        // geführt wie eines auf oberster Ebene; der rekursive Aufruf erledigt
        // das, ohne dass die Fallunterscheidung doppelt gepflegt wird.
        const nested = toUserContent(block.content, requestImages, resolveImageAccess)
        if (typeof nested === 'string') {
          if (nested.length > 0) content.push({ type: 'text', text: nested })
        } else {
          content.push(...nested)
        }
        break
      }
      default:
        break
    }
  }
  return joinOrBlocks(content)
}

/**
 * Eine historische Assistant-Nachricht in provider-neutrale pi-ai-Historie
 * übersetzen.
 *
 * Bewusst ohne Replay-Zustand: `api`/`provider`/`model` sind als Fremdhistorie
 * markiert, damit pi-ai sie als gewöhnliche Vorgeschichte serialisiert und
 * nicht versucht, einen nicht vorhandenen nativen Zustand wiederherzustellen.
 *
 * @param message - die Harness-Assistant-Nachricht.
 * @returns die pi-ai-Assistant-Nachricht.
 */
function foreignAssistant(message) {
  const source = message.source?.kind === 'model' ? message.source : undefined
  const content = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text })
        break
      case 'reasoning':
        content.push({ type: 'thinking', thinking: block.text })
        break
      case 'tool-call':
        content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: parseArguments(block.arguments) })
        break
      default:
        // Plugin-eigene Blöcke sind kein pi-ai-Vokabular; sie werden bewusst
        // nicht in die Fremdhistorie geschrieben.
        break
    }
  }
  return {
    role: 'assistant',
    content,
    api: 'dsh-foreign',
    provider: source?.provider ?? 'dsh-foreign',
    model: source?.model ?? 'dsh-foreign',
    usage: emptyPiUsage(),
    stopReason: content.some((piece) => piece.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  }
}

/** Harness-Toolschemata in pi-ais Tool-Vokabular projizieren. */
function toolsOf(options) {
  const tools = options.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
  return tools !== undefined && tools.length > 0 ? tools : undefined
}

/**
 * Die vollständige Anfrage in einen pi-ai-`Context` übersetzen, Bilder inklusive.
 *
 * Der Ablauf ist bewusst zweistufig: erst kürzt die geschätzte Länge die
 * Historie, dann werden nur für die verbliebenen Bilder Bytes geholt, und
 * zuletzt kürzt die exakte Länge noch einmal nach. So lädt eine Anfrage, die
 * ihr Budget ohnehin reißt, keine Bilder, die sie gleich wieder wegwirft.
 *
 * @param options - die Harness-Anfrage.
 * @param images - der Bild-Zugriff der Route; fehlt er, ist die Route textlich.
 * @returns der pi-ai-Context.
 * @throws {LlmError} `UNSUPPORTED_CONTENT`, wenn die Route textlich ist und die Historie Bilder führt.
 */
export async function toCodexContextWithImages(options, images) {
  if (images === undefined) {
    // Textliche Route: ein Bild kann hier nicht stillschweigend verschwinden,
    // sonst sähe das Modell eine Anfrage, die der Nutzer nicht gestellt hat.
    if (options.messages.some((message) => contentHasImage(message.content))) {
      throw new LlmError(
        'Die Codex-Route führt keine Bild-Eingabe; Bilder vor dem Senden entfernen',
        'UNSUPPORTED_CONTENT',
      )
    }
    return toCodexContext(options, undefined)
  }

  const requestImages = await prepareRequestImages(
    options.messages,
    images.attachments,
    images.requestImagePolicy,
    options.signal,
  )
  if (images.maxRequestImageBytes !== undefined) {
    const offloadImages = requiredImageOffload(
      options.messages,
      {
        representation: 'base64',
        maxBytes: images.maxRequestImageBytes,
      },
      (block) => requestImages.get(block.attachment.attachmentId).bytes,
    )
    if (offloadImages > 0) {
      throw new LlmError(
        `Codex request images exceed the ${images.maxRequestImageBytes}-byte base64 bound; ${offloadImages} more oldest occurrence(s) must be offloaded.`,
        IMAGE_OFFLOAD_REQUIRED_CODE,
        { offloadImages },
      )
    }
  }
  const exact = projectOffloadedImages(
    options.messages,
    (ref) => offloadedImageText(ref, images.resolveImageAccess(ref)),
  )
  return toCodexContext({ ...options, messages: exact }, {
    requestImages,
    resolveImageAccess: images.resolveImageAccess,
  })
}

/**
 * Harness-Historie in einen pi-ai-`Context` übersetzen.
 *
 * Tool-Ergebnis-Namen werden aus den vorangehenden Assistant-Tool-Aufrufen
 * rekonstruiert, weil der Harness sie im Ergebnisblock nicht mitführt.
 *
 * Bilder laufen über `images`: fehlt es, ist die Route textlich und die
 * Anfrage muss bildfrei sein. Ist es gesetzt, holt der Aufruf zuvor die Bytes
 * und diese Funktion legt sie in den Context.
 *
 * @param options - die Harness-Anfrage.
 * @param images - Attachment-Zugriff und Request-Versionen, oder undefined für die Text-Route.
 * @returns der pi-ai-Context.
 * @throws {LlmError} `UNSUPPORTED_CONTENT`, wenn eine Bild-Anlage nicht auflösbar ist.
 */
export function toCodexContext(options, images) {
  const requestImages = images?.requestImages
  const resolveImageAccess = images?.resolveImageAccess ?? (() => undefined)
  const toolNames = new Map()
  const messages = []
  for (const message of options.messages) {
    if (message.role === 'system') {
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = foreignAssistant(message)
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(ToolCallId(block.id), block.name)
      }
      messages.push(assistant)
      continue
    }
    // Der User-Pfad führt Bilder; deshalb hier die blockweise Übersetzung
    // statt des reinen Textflachziehers. Entscheidend ist ein Bild auf
    // oberster Ebene: eines innerhalb eines Tool-Ergebnisses gehört zu dessen
    // eigener Nachricht weiter unten und darf hier keine leere User-Nachricht
    // erzeugen.
    const topLevel = message.content.filter((block) => block.type !== 'tool-result')
    const hasImage = contentHasImage(topLevel)
    const text = flattenText(message)
    const results = message.content.filter((block) => block.type === 'tool-result')
    if (hasImage || text.length > 0 || results.length === 0) {
      const content = hasImage
        ? toUserContent(topLevel, requestImages ?? new Map(), resolveImageAccess)
        : text
      messages.push({ role: 'user', content, timestamp: 0 })
    }
    for (const result of results) {
      // Ein Tool-Ergebnis kann selbst Bilder tragen (ein Screenshot-Tool
      // etwa). Es behält dann seine Blöcke; ohne Bilder bleibt es der eine
      // Textblock, den die Route schon immer führte.
      const resultContent = contentHasImage(result.content)
        ? toUserContent(result.content, requestImages ?? new Map(), resolveImageAccess)
        : [{ type: 'text', text: toolResultText(result.content) || '(no output)' }]
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: typeof resultContent === 'string' ? [{ type: 'text', text: resultContent }] : resultContent,
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }
  const tools = toolsOf(options)
  return {
    ...(options.system === undefined ? {} : { systemPrompt: options.system }),
    messages,
    ...(tools === undefined ? {} : { tools }),
  }
}

/**
 * pi-ai-Usage auf Harness-Zähler abbilden.
 *
 * Die Zählungen des Harness sind disjunkt: `inputTokens` zählt nur
 * ungecachte Eingabe, Cache-Treffer stehen in eigenen Feldern. pi-ai faltet
 * Reasoning in die Ausgabe, deshalb bleibt `reasoningTokens` hier leer.
 *
 * @param usage - kumulierte Usage aus dem terminalen pi-ai-Event.
 * @returns die Harness-Zählung; Cache-Felder erscheinen nur, wenn sie nicht null sind.
 */
export function mapUsage(usage) {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
  }
}

/**
 * Eine provider-seitige Fehlermeldung in einen Harness-Code einordnen.
 *
 * pi-ai faltet gefangene Fehler auf `error.message`, deshalb arbeitet die
 * Einordnung über den Wortlaut. Das ist bewusst defensiv: ein unbekannter
 * Fehler wird zu `PROVIDER_ERROR` statt zu einer falschen Klasse.
 *
 * @param message - der Fehlertext des Providers.
 * @returns der Harness-Fehlercode.
 */
export function classifyProviderError(message) {
  if (/\bprovider is not configured\b/i.test(message)) return AUTH_CODE
  if (/\b(?:401|403)\b/.test(message)) return AUTH_CODE
  // OpenAI antwortet auf einen ungültigen Codex-Token mit einer Meldung ohne
  // Statuscode im Text ("Could not parse your authentication token…"). Ohne
  // diesen Zweig landete ein abgelaufener Login in der generischen Klasse und
  // die Diagnose wäre irreführend.
  if (/\b(?:unauthori[sz]ed|authentication|not authenticated|sign(?:ed)? in|invalid token|token (?:has )?expired|account (?:is )?deactivated)\b/i.test(message)) {
    return AUTH_CODE
  }
  // Der Codex-Backend lehnt Modelle ab, die der pi-ai-Katalog kennt, für
  // ChatGPT-Konten aber nicht bedient. Ohne diesen Zweig wäre die Diagnose
  // eine generische 400 und der Nutzer suchte den Fehler bei sich.
  if (/is not supported when using Codex with a ChatGPT account/i.test(message)) return 'UNSUPPORTED_MODEL'
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(message)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)) return 'TRANSPORT'
  return 'PROVIDER_ERROR'
}

/**
 * Eine terminale pi-ai-Nachricht auf einen Harness-Finish-Grund abbilden.
 *
 * @param message - die Assistant-Nachricht aus dem `done`- oder `error`-Event.
 * @param contextWindow - aufgelöste Kapazität des Modells, für die Überlauf-Erkennung.
 * @returns der Harness-Grund.
 */
export function mapStopReason(message, contextWindow) {
  const piAiOverflow = isContextOverflow(message, contextWindow)
  const harnessOverflow = message.stopReason === 'error'
    && message.errorMessage !== undefined
    && isContextWindowExceededError(message.errorMessage)
  if (piAiOverflow || harnessOverflow) {
    return {
      kind: 'error',
      failure: {
        message: message.errorMessage ?? `Codex meldet Kontext-Überlauf für "${message.model}"`,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    }
  }

  switch (message.stopReason) {
    case 'stop':
      if (message.content.length === 0) {
        return {
          kind: 'error',
          failure: {
            message: `Modell "${message.model}" hat eine leere Antwort abgeschlossen`,
            code: EMPTY_RESPONSE_CODE,
          },
        }
      }
      return { kind: 'stop' }
    case 'length':
      return { kind: 'max-tokens' }
    case 'toolUse':
      return { kind: 'tool-calls' }
    case 'aborted':
      return {
        kind: 'aborted',
        failure: { message: message.errorMessage ?? 'Codex-Stream abgebrochen', code: 'ABORTED' },
      }
    case 'error': {
      const text = message.errorMessage ?? 'Codex-Stream-Fehler'
      return {
        kind: 'error',
        failure: {
          message: /provider is not configured/i.test(text)
            ? `${text}; zuerst mit /codex login anmelden`
            : text,
          code: classifyProviderError(text),
        },
      }
    }
    default:
      return {
        kind: 'error',
        failure: {
          message: `Modell "${message.model}" hat die Anfrage unerwartet beendet (${message.stopReason})`,
          code: 'PROVIDER_ERROR',
        },
      }
  }
}

/**
 * Den pi-ai-Event-Strom in Harness-`StreamChunk`s übersetzen.
 *
 * pi-ai wirft nie mitten im Stream: Fehler kommen als `error`-Event und
 * werden hier zu einem terminalen `finish` mit Fehlergrund.
 *
 * @param events - der Event-Strom eines Assistant-Turns.
 * @param contextWindow - aufgelöste Kapazität für die Überlauf-Erkennung.
 * @returns die Harness-Chunks, endend mit `usage` und dann `finish`.
 * @throws {LlmError} `STREAM_CLOSED`, wenn die Quelle ohne terminales Event endet.
 */
export async function* toStreamChunks(events, contextWindow) {
  const toolIds = new Map()

  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        break
      case 'toolcall_start': {
        const partial = event.partial?.content?.[event.contentIndex]
        const id = partial?.type === 'toolCall' ? partial.id : ''
        const name = partial?.type === 'toolCall' ? partial.name : ''
        toolIds.set(event.contentIndex, { id, name })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: ToolCallId(known?.id ?? ''),
          ...(typeof known?.name === 'string' && known.name.length > 0 ? { name: known.name } : {}),
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: ToolCallId(event.toolCall.id),
            name: event.toolCall.name,
            // pi-ai liefert geparste Argumente; der Harness führt den Rohstring.
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        }
        break
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield { type: 'finish', reason: mapStopReason(event.message, contextWindow) }
        return
      case 'error':
        yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield { type: 'finish', reason: mapStopReason(event.error, contextWindow) }
        return
      default:
        // Unbekannte Event-Typen werden übersprungen, damit ein pi-ai-Upgrade
        // die Route nicht sofort bricht.
        break
    }
  }
  throw new LlmError('Der Codex-Event-Strom endete ohne done/error', 'STREAM_CLOSED')
}
