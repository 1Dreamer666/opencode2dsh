/**
 * #77 regression, half one: the REAL adapter wiring (no providerOverride)
 * against a local capture server, on the repo's pinned pi-ai. Host tools and
 * the injected free-lane gate stubs must COEXIST on the serialized wire body.
 *
 * The model's wire URL is the ZEN_BASE_URL constant (toPiModel), so the drive
 * intercepts globalThis.fetch and redirects opencode.ai to the capture
 * server — the same technique the issue's hoisted-layout repro used. The
 * hoisted-profile half — the same drive with pi-ai 0.87.1, the version a
 * `nodeLinker: hoisted` DSH profile actually resolves — lives in
 * hoisted-pi-ai-087.test.ts; there the pre-#77 raw-provider call dropped every
 * host tool (wire showed gate stubs only, `tool_choice: "none"`). Both halves
 * assert the same wire facts so a regression on either pi-ai surface is
 * caught by the in-repo suite.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'

import { ZenAdapter } from '../src/adapter/zen-adapter.ts'
import type { HarnessGenerateOptions } from '../src/adapter/messages.ts'

const S = (description: string): Record<string, unknown> => ({ type: 'string', description })

/** The flat declarations a DSH host hands the adapter (issue #77's repro set). */
const HOST_TOOLS = [
  { name: 'pwsh', description: 'shell', parameters: { type: 'object', properties: { command: S('command') }, required: ['command'] } },
  { name: 'read', description: 'read', parameters: { type: 'object', properties: { file_path: S('path') }, required: ['file_path'] } },
  { name: 'grep', description: 'grep', parameters: { type: 'object', properties: { pattern: S('pattern') }, required: ['pattern'] } },
]

const CHAT_MODEL = 'big-pickle'
const RESPONSES_MODEL = 'muse-spark-1.2'

interface Captured {
  url?: string
  body: Record<string, unknown>
}

/** Minimal valid SSE for pi-ai's openai-completions stream parser. */
const CHAT_SSE = [
  'data: {"id":"chatcmpl-c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
].join('\n')

/** Minimal valid SSE for the OpenAI Responses stream (one text item, then terminal). */
const RESPONSES_ITEM = '{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"OK","annotations":[]}]}'
const RESPONSES_SSE = [
  'event: response.output_item.done',
  `data: {"type":"response.output_item.done","output_index":0,"item":${RESPONSES_ITEM}}`,
  '',
  'event: response.completed',
  `data: {"type":"response.completed","response":{"id":"resp_1","object":"response","created_at":0,"status":"completed","output":[${RESPONSES_ITEM}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}`,
  '',
  '',
].join('\n')

function startCaptureServer(): Promise<{ server: Server; url: string; captured: Captured[] }> {
  const captured: Captured[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>
      } catch {
        parsed = { unparsable: raw }
      }
      captured.push({ url: req.url, body: parsed })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(req.url?.includes('/responses') ? RESPONSES_SSE : CHAT_SSE)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no port')
      resolve({ server, url: `http://127.0.0.1:${address.port}`, captured })
    })
  })
}

function fakeCatalog(model: string) {
  return {
    list: () => [model],
    decision: () => ({ allowed: true, source: 'test', known: true }),
    reasoningCapability: () => ({ reasoning: false, effortValues: [] }),
  }
}

async function driveWire(model: string, tools?: typeof HOST_TOOLS): Promise<{ captured: Captured[]; finish: string }> {
  const { server, url, captured } = await startCaptureServer()
  // The model's wire URL is ZEN_BASE_URL regardless of constructor options
  // (pi-ai reads the URL from the model, not the provider — #75), so redirect
  // opencode.ai to the capture server. Every attempt, including the #80
  // sibling replay, stays on localhost.
  const realFetch = globalThis.fetch
  globalThis.fetch = ((input: unknown, init?: unknown) => {
    const original = typeof input === 'string' ? input : (input as { url?: string })?.url ?? String(input)
    return realFetch(original.replace(/^https:\/\/opencode\.ai/, url), init as never)
  }) as typeof fetch
  try {
    const adapter = new ZenAdapter(fakeCatalog(model) as never)
    const request: HarnessGenerateOptions = {
      provider: 'opencode2dsh',
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: `call the ${tools?.[0]?.name ?? 'nothing'} tool` }] }],
      ...(tools ? { tools } : {}),
      maxTokens: 64,
      signal: AbortSignal.timeout(15_000),
    }
    let finish = 'none'
    for await (const chunk of adapter.stream(request)) {
      if (chunk.type === 'finish') finish = chunk.reason.kind
    }
    return { captured, finish }
  } finally {
    globalThis.fetch = realFetch
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function chatToolNames(body: Record<string, unknown>): string[] {
  const tools = Array.isArray(body.tools) ? body.tools as Array<{ function?: { name?: string } }> : []
  return tools.map((tool) => tool.function?.name ?? '').filter(Boolean).sort()
}

function responsesToolNames(body: Record<string, unknown>): string[] {
  const tools = Array.isArray(body.tools) ? body.tools as Array<{ name?: string }> : []
  return tools.map((tool) => tool.name ?? '').filter(Boolean).sort()
}

test('chat wire carries host tools alongside the gate stubs, deduping the host read', async () => {
  const { captured, finish } = await driveWire(CHAT_MODEL, HOST_TOOLS)
  assert.equal(finish, 'stop', 'the local stream completes normally')
  assert.equal(captured.length, 1, 'one request, no sibling replay')
  const body = captured[0]!.body
  // host read satisfies the gate read; only bash is appended (gate recipe #56/#75)
  assert.deepEqual(chatToolNames(body), ['bash', 'grep', 'pwsh', 'read'])
  // the host schema survives verbatim (gate stub injection only appends)
  const tools = body.tools as Array<{ function: { name: string; parameters: { properties?: Record<string, unknown> } } }>
  const pwsh = tools.find((tool) => tool.function.name === 'pwsh')
  assert.ok(pwsh, 'pwsh on the wire')
  assert.ok(pwsh!.function.parameters.properties?.command, 'pwsh keeps its host schema')
  const bash = tools.find((tool) => tool.function.name === 'bash')
  assert.ok(bash, 'bash gate stub on the wire')
  assert.ok(bash!.function.parameters.properties?.command, 'gate stub carries a real schema (#75)')
  // three host tools were passed: the gate must not force tool_choice none
  assert.notEqual(body.tool_choice, 'none')
})

test('chat wire with no host tools keeps the stub-only gate shape', async () => {
  const { captured } = await driveWire(CHAT_MODEL)
  const body = captured[0]!.body
  assert.deepEqual(chatToolNames(body), ['bash', 'read'])
  assert.equal(body.tool_choice, 'none', 'no caller tools -> the stubs stay uncalled')
})

test('responses wire carries host tools alongside the gate stubs', async () => {
  const { captured, finish } = await driveWire(RESPONSES_MODEL, HOST_TOOLS)
  assert.equal(finish, 'stop')
  assert.equal(captured.length, 1)
  const body = captured[0]!.body
  assert.ok(Array.isArray(body.input), 'responses bodies carry the converted transcript as input')
  assert.deepEqual(responsesToolNames(body), ['bash', 'grep', 'pwsh', 'read'])
  const tools = body.tools as Array<{ name: string; parameters: { properties?: Record<string, unknown> } }>
  const pwsh = tools.find((tool) => tool.name === 'pwsh')
  assert.ok(pwsh?.parameters.properties?.command, 'pwsh keeps its host schema on the responses surface')
})
