import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CodexAccountAdapter } from '../lib/adapter.js'

test('Codex-Adapter reicht Session und Limits an pi-ai weiter und übersetzt den Stream', async () => {
  const model = {
    id: 'mock-codex-model',
    name: 'Mock Codex',
    provider: 'openai-codex',
    reasoning: false,
    contextWindow: 128_000,
    input: ['text'],
  }
  const calls = []
  const models = {
    getModel(provider, id) {
      assert.equal(provider, 'openai-codex')
      return id === model.id ? model : undefined
    },
    streamSimple(selected, context, options) {
      calls.push({ selected, context, options })
      return (async function* () {
        yield { type: 'start' }
        yield { type: 'text_start', contentIndex: 0 }
        yield { type: 'text_delta', contentIndex: 0, delta: 'OK' }
        yield { type: 'text_end', contentIndex: 0, content: 'OK' }
        yield {
          type: 'done',
          message: {
            model: model.id,
            content: [{ type: 'text', text: 'OK' }],
            stopReason: 'stop',
            usage: { input: 2, output: 1, cacheRead: 12, cacheWrite: 0 },
          },
        }
      })()
    },
  }
  const adapter = new CodexAccountAdapter({
    provider: 'codex-personal',
    models,
    readImages: false,
    streamIdleTimeoutMs: 30_000,
  })
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'codex-personal',
    model: model.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hallo' }] }],
    sessionId: 'test-session',
    maxTokens: 1,
  })) chunks.push(chunk)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].selected, model)
  assert.equal(calls[0].context.messages[0].content, 'Hallo')
  assert.equal(calls[0].options.sessionId, 'test-session')
  assert.equal(calls[0].options.maxTokens, 1)
  assert.equal(calls[0].options.cacheRetention, 'long')
  assert.equal(calls[0].options.maxRetries, 0)
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'OK' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'OK' } },
    { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 12 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})
