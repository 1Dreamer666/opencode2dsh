/**
 * The #77 trap, pinned against a real >= 0.86 pi-ai (the test-only alias
 * devDependency @opencode2dsh/pi-ai-0.87, no child process needed — this
 * test exercises pi-ai directly, not the adapter).
 *
 * pi-ai 0.86.0 changed the provider-facing API to a normalized
 * TranscriptContext: `context.tools` is folded into the leading system
 * message's `toolsAdded` ONLY by the Models entry points (0.87.1
 * dist/models.js:393 `streamSimple` -> `normalizeContext`; the raw provider
 * reads `resolveTranscriptTools(context.messages)` instead —
 * dist/api/openai-completions.js:566,598-599). The adapter's fix routes
 * through Models (zen-adapter.ts `modelsTransport`); this test guards the
 * assumption that route rests on, so a future pi-ai moving the fold point
 * fails here with a precise story instead of silently dropping host tools.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { createModels, createProvider } from '@opencode2dsh/pi-ai-0.87'
import * as openaiCompletions087 from '@opencode2dsh/pi-ai-0.87/api/openai-completions'

const HOST_TOOLS = [
  { name: 'pwsh', description: 'shell', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'read', description: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
  { name: 'grep', description: 'grep', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
]

const CHAT_SSE = [
  'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}',
  '',
  'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
].join('\n')

test('pi-ai >= 0.86: the raw provider drops context.tools; the Models route preserves it', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      try {
        bodies.push(JSON.parse(raw) as Record<string, unknown>)
      } catch {
        bodies.push({ unparsable: raw })
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(CHAT_SSE)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  const wireToolNames = (index: number): string[] => {
    const body = bodies[index]
    if (!body || !Array.isArray(body.tools)) return []
    return (body.tools as Array<{ function?: { name?: string } }>).map((tool) => tool.function?.name ?? '').filter(Boolean).sort()
  }

  try {
    const auth = { apiKey: { name: 'n', resolve: async () => ({ auth: { apiKey: 'public' } }) } }
    const model = {
      id: 'm', name: 'm', api: 'openai-completions' as const, provider: 'p', baseUrl,
      reasoning: false, input: ['text'] as ('text' | 'image')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000, maxTokens: 100,
    }
    const context = {
      messages: [{ role: 'user' as const, content: 'hi', timestamp: 0 }],
      tools: HOST_TOOLS,
    }

    // Trap half: the raw provider reads the transcript, which carries no
    // toolsAdded because nothing folded context.tools into it.
    const raw = createProvider({ id: 'p', name: 'p', baseUrl, auth, models: [], api: openaiCompletions087 })
    for await (const _ of raw.streamSimple(model as never, context as never, { apiKey: "public" })) { /* drain */ }
    assert.deepEqual(wireToolNames(0), [], 'raw provider.streamSimple must document the >= 0.86 drop')

    // Fix half: the Models entry point normalizes the context first.
    const models = createModels()
    models.setProvider(createProvider({ id: 'p', name: 'p', baseUrl, auth, models: [], api: openaiCompletions087 }))
    for await (const _ of models.streamSimple(model as never, context as never, { apiKey: "public" })) { /* drain */ }
    assert.deepEqual(wireToolNames(1), ['grep', 'pwsh', 'read'], 'Models.streamSimple must carry every host tool to the wire')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
