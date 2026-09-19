/**
 * Bild-Ziele der Codex-Route (`lib/convert.js`).
 *
 * Der Attachment-Dienst verlangt in `readImageRequest` ein Ziel mit den
 * Feldern `width`, `height` und `maxBytes`. Die Route darf deshalb nicht ihre
 * eigene Pixel-/Byte-Policy durchreichen: `maxPixels` ist kein `width`, und
 * eine Anfrage mit `width: undefined` bricht den gesamten Modellaufruf mit
 * „Image request width must be a positive integer" ab, bevor das Modell
 * überhaupt antworten kann.
 *
 * Der Fake-Dienst unten prüft genau das nach, statt die Zielform nur zu
 * protokollieren — ein Test, der `undefined` durchwinkt, würde den Fehler
 * nicht fangen.
 *
 * Ausführen mit: node --test "tests/*.test.js"
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { prepareRequestImages } from '../lib/convert.js'

/**
 * Ein Bild-Block, wie ihn der Harness einer User-Nachricht mitgibt.
 *
 * `extra` landet auf dem Block, nicht auf der Anlage: `offloaded` ist eine
 * Block-Eigenschaft, und genau dort liest `collectImageRefs` sie.
 */
function imageBlock(id, width, height, extra = {}) {
  return {
    type: 'image',
    attachment: { attachmentId: id, mediaType: 'image/png', bytes: 1024, width, height },
    ...extra,
  }
}

/**
 * Ein Attachment-Dienst, der die Zielvalidierung des echten Dienstes
 * nachbildet und die erhaltenen Ziele mitschreibt.
 *
 * @param calls - Sammlung, in die jedes Ziel geschrieben wird.
 * @returns der Fake-Dienst.
 */
function fakeAttachments(calls) {
  return {
    async readImageRequest(ref, target) {
      calls.push({ ref, target })
      for (const [field, name] of [
        ['width', 'Image request width'],
        ['height', 'Image request height'],
        ['maxBytes', 'Image request maxBytes'],
      ]) {
        const value = target[field]
        if (!Number.isSafeInteger(value) || value <= 0) {
          throw new Error(`${name} must be a positive integer.`)
        }
      }
      return {
        data: new Uint8Array([1, 2, 3]),
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: target.width,
        height: target.height,
      }
    },
  }
}

const POLICY = { maxPixels: 4_194_304, maxBytes: 1_048_576 }

test('übergibt ein vollständiges Ziel statt der Roh-Policy', async () => {
  const calls = []
  const messages = [{ role: 'user', content: [imageBlock('a1', 1714, 1263)] }]

  const versions = await prepareRequestImages(messages, fakeAttachments(calls), POLICY)

  assert.equal(calls.length, 1, 'genau eine Bild-Referenz wird geholt')
  assert.deepEqual(calls[0].target, { width: 1714, height: 1263, maxBytes: 1_048_576 })
  assert.deepEqual([...versions.keys()], ['a1'])
})

test('kleine Bilder werden nicht vergrößert', async () => {
  const calls = []
  const messages = [{ role: 'user', content: [imageBlock('small', 100, 50)] }]

  await prepareRequestImages(messages, fakeAttachments(calls), POLICY)

  assert.deepEqual(calls[0].target, { width: 100, height: 50, maxBytes: 1_048_576 })
})

test('große Bilder bleiben innerhalb des Pixel-Budgets', async () => {
  const calls = []
  const messages = [{ role: 'user', content: [imageBlock('big', 4000, 3000)] }]

  await prepareRequestImages(messages, fakeAttachments(calls), POLICY)

  const { width, height } = calls[0].target
  assert.ok(Number.isSafeInteger(width) && width > 0, 'Breite ist eine positive Ganzzahl')
  assert.ok(Number.isSafeInteger(height) && height > 0, 'Höhe ist eine positive Ganzzahl')
  assert.ok(width * height <= POLICY.maxPixels, 'Budget wird eingehalten')
  // Seitenverhältnis bleibt grob erhalten (Rundung auf ganze Pixel).
  assert.ok(Math.abs(width / height - 4000 / 3000) < 0.01, 'Seitenverhältnis bleibt erhalten')
})

test('Bilder in Tool-Ergebnissen werden ebenfalls projiziert', async () => {
  const calls = []
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'tool-result', toolCallId: 'c1', content: [imageBlock('nested', 800, 600)] },
      ],
    },
  ]

  await prepareRequestImages(messages, fakeAttachments(calls), POLICY)

  assert.deepEqual(calls.map((call) => call.ref.attachmentId), ['nested'])
  assert.deepEqual(calls[0].target, { width: 800, height: 600, maxBytes: 1_048_576 })
})

test('eine Anlage wird nur einmal geholt und offloaded bleibt außen vor', async () => {
  const calls = []
  const messages = [
    { role: 'user', content: [imageBlock('dup', 640, 480)] },
    { role: 'user', content: [imageBlock('dup', 640, 480), imageBlock('gone', 640, 480, { offloaded: true })] },
  ]

  const versions = await prepareRequestImages(messages, fakeAttachments(calls), POLICY)

  assert.deepEqual(calls.map((call) => call.ref.attachmentId), ['dup'])
  assert.deepEqual([...versions.keys()], ['dup'])
})
