/**
 * #96 regression: the reasoning_content round-trip. With reasoning enabled,
 * Zen's DeepSeek rejects (HTTP 400) any multi-step conversation whose replayed
 * assistant messages lack `reasoning_content`. pi-ai records the upstream
 * reasoning field name (the replay key, e.g. "reasoning_content") as the
 * thinking block's `thinkingSignature` while parsing the stream, but the
 * adapter dropped it twice: toStreamChunks' thinking_end -> harness reasoning
 * block, and toPiAssistant's "reasoning" case back to pi-ai. The plugin's
 * provider id/baseUrl also matches neither of pi-ai isDeepSeek conditions,
 * so its empty-reasoning_content fallback never fired on its own.
 *
 * Fix under test, per the issue's B + C suggestions:
 * - B: the signature survives the stream -> persisted block -> history rebuild
 *   round trip and lands as `reasoning_content` on the wire again.
 * - C: toPiModel declares compat.requiresReasoningContentOnAssistantMessages,
 *   so pi-ai writes an empty `reasoning_content` whenever a block arrives
 *   without a signature — histories persisted by pre-fix plugin builds, and
 *   reasoning produced on lanes that cannot carry one (the local opencode
 *   delegate). The key must be present, not populated, to avoid the 400.
 *
 * Verified against BOTH pinned pi-ai copies: the repo dependency
 * (@earendil-works/pi-ai 0.82.1) and the hoisted-profile copy
 * (@opencode2dsh/pi-ai-0.87 = 0.87.1) — same flag name, same
 * `model.compat ?? detected` merge, same signature-keyed replay in both.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'

import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions'
import type { Context, Model } from '@earendil-works/pi-ai'
import * as openaiCompletions087 from '@opencode2dsh/pi-ai-0.87/api/openai-completions'
import type { Model as Model087 } from '@opencode2dsh/pi-ai-0.87'

import { toStreamChunks, type HarnessChunk, type PiDoneMessage, type PiEvent } from '../src/adapter/events.ts'
import { toPiContext, type HarnessBlock, type HarnessGenerateOptions } from '../src/adapter/messages.ts'
import { ZenAdapter } from '../src/adapter/zen-adapter.ts'

const MODEL = 'deepseek-v4.1-flash-free'
const REASONING_TEXT = 'thinking out the tool call'

function doneMessage(overrides: Partial<PiDoneMessage> = {}): PiDoneMessage {
  return {
    api: 'openai-completions', provider: 'opencode2dsh', model: MODEL,
    content: [{ type: 'thinking', thinking: REASONING_TEXT, thinkingSignature: 'reasoning_content' }],
    stopReason: 'stop',
    usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14 },
    ...overrides,
  }
}

async function collectChunks(events: PiEvent[]): Promise<HarnessChunk[]> {
  const source = async function* () { yield* events }()
  const chunks: HarnessChunk[] = []
  for await (const chunk of toStreamChunks(source, 128_000)) chunks.push(chunk)
  return chunks
}

test('#96 fix B: thinking_end forwards the pi-ai thinkingSignature as the reasoning block signature', async () => {
  const partial = { content: [{ type: 'thinking', thinking: REASONING_TEXT, thinkingSignature: 'reasoning_content' }] }
  const events: PiEvent[] = [
    { type: 'thinking_start', contentIndex: 0, partial },
    { type: 'thinking_delta', contentIndex: 0, delta: REASONING_TEXT, partial },
    { type: 'thinking_end', contentIndex: 0, content: REASONING_TEXT, partial },
    { type: 'done', message: doneMessage() },
  ]
  const ends = (await collectChunks(events)).filter(
    (chunk): chunk is Extract<HarnessChunk, { type: 'block-end' }> => chunk.type === 'block-end' && chunk.block.type === 'reasoning',
  )
  assert.equal(ends.length, 1)
  const end = ends[0]!
  const reasoning = end.block.type === 'reasoning' ? end.block : undefined
  assert.ok(reasoning, 'the block is a reasoning block')
  assert.equal(reasoning.text, REASONING_TEXT)
  assert.equal(reasoning.signature, 'reasoning_content', 'the replay key must survive the chunk boundary')
})

test('#96 fix B: a reasoning chunk without a signature stays signature-free (no invented field)', async () => {
  const partial = { content: [{ type: 'thinking', thinking: REASONING_TEXT }] }
  const events: PiEvent[] = [
    { type: 'thinking_start', contentIndex: 0, partial },
    { type: 'thinking_end', contentIndex: 0, content: REASONING_TEXT, partial },
    { type: 'done', message: doneMessage() },
  ]
  const ends = (await collectChunks(events)).filter(
    (chunk): chunk is Extract<HarnessChunk, { type: 'block-end' }> => chunk.type === 'block-end' && chunk.block.type === 'reasoning',
  )
  assert.equal(ends.length, 1)
  const end = ends[0]!
  const reasoning = end.block.type === 'reasoning' ? end.block : undefined
  assert.ok(reasoning, 'the block is a reasoning block')
  assert.equal('signature' in reasoning, false, 'lanes without a signature must not gain a fabricated one')
})

test('#96 fix B: toPiAssistant replays the persisted signature as thinkingSignature', async () => {
  const options: HarnessGenerateOptions = {
    provider: 'opencode2dsh',
    model: MODEL,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'run ls' }] },
      { role: 'assistant', content: [
        { type: 'reasoning', text: REASONING_TEXT, signature: 'reasoning_content' },
        { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' },
      ], source: { kind: 'model', provider: 'opencode2dsh', model: MODEL } },
    ],
  }
  const context = await toPiContext(options)
  const assistant = context.messages.find((message) => message.role === 'assistant')
  assert.ok(assistant && assistant.role === 'assistant')
  const thinking = assistant.content.find((block) => block.type === 'thinking')
  assert.ok(thinking, 'the rebuilt assistant carries the thinking block')
  assert.equal(
    (thinking as { type: string; thinkingSignature?: string }).thinkingSignature,
    'reasoning_content',
    'the rebuild must hand the replay key back to pi-ai',
  )
})

/** A model shaped like toPiModel output; compat toggles fix C on and off. */
function chatModel082(compat?: { requiresReasoningContentOnAssistantMessages?: boolean }): Model<'openai-completions'> {
  return {
    id: MODEL, name: MODEL, api: 'openai-completions', provider: 'opencode2dsh',
    baseUrl: 'https://opencode.ai/zen/v1',
    reasoning: true, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000, maxTokens: 32_000,
    ...(compat ? { compat } : {}),
  }
}

function chatModel087(compat?: { requiresReasoningContentOnAssistantMessages?: boolean }): Model087<'openai-completions'> {
  return chatModel082(compat) as unknown as Model087<'openai-completions'>
}

type Compat082 = Parameters<typeof openaiCompletions.convertMessages>[2]
type Compat087 = Parameters<typeof openaiCompletions087.convertMessages>[2]
// 0.87.1 names its context parameter TranscriptContext; use the parameter type itself.
type Context87Arg = Parameters<typeof openaiCompletions087.convertMessages>[1]

/** Resolved compat as pi-ai detectCompat produces it for opencode.ai, plus the #96 override. */
function resolvedCompat(flag: boolean): Compat082 {
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: true,
    supportsUsageInStreaming: true,
    maxTokensField: 'max_completion_tokens',
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    requiresReasoningContentOnAssistantMessages: flag,
    thinkingFormat: 'openai',
    openRouterRouting: {},
    vercelGatewayRouting: {},
    chatTemplateKwargs: {},
    zaiToolStream: false,
    supportsStrictMode: true,
    supportsOpenAIGrammarTools: false,
    sendSessionAffinityHeaders: false,
    sessionAffinityFormat: 'openai',
    supportsLongCacheRetention: true,
  }
}

function resolvedCompat087(flag: boolean): Compat087 {
  return resolvedCompat(flag) as unknown as Compat087
}

/** One multi-step turn: user -> assistant (thinking + tool call) -> tool result. */
function multiStepContext(thinkingBlock: Record<string, unknown>): Context {
  return {
    messages: [
      { role: 'user', content: 'run ls', timestamp: 0 },
      {
        role: 'assistant',
        content: [thinkingBlock, { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } }],
        api: 'openai-completions',
        provider: 'opencode2dsh',
        model: MODEL,
        usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14 },
        stopReason: 'toolUse',
        timestamp: 0,
      },
      { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'file list' }], isError: false, timestamp: 0 },
    ],
  } as unknown as Context
}

const SIGNED_THINKING = { type: 'thinking', thinking: REASONING_TEXT, thinkingSignature: 'reasoning_content' }
const BARE_THINKING = { type: 'thinking', thinking: REASONING_TEXT }

function assistantOf(messages: Array<Record<string, unknown>>): Record<string, unknown> {
  const assistant = messages.find((message) => message.role === 'assistant')
  assert.ok(assistant, 'converted history carries the assistant message')
  return assistant
}

test('#96 pi-ai 0.82.1: the preserved signature lands as reasoning_content on replayed history', () => {
  const messages = openaiCompletions.convertMessages(
    chatModel082(),
    multiStepContext(SIGNED_THINKING),
    resolvedCompat(false),
  ) as unknown as Array<Record<string, unknown>>
  const assistant = assistantOf(messages)
  assert.equal(assistant.reasoning_content, REASONING_TEXT, 'fix B: the real thinking text is replayed under the recorded key')
})

test('#96 pi-ai 0.82.1: before-fix shape — no signature and no flag loses reasoning_content entirely', () => {
  const messages = openaiCompletions.convertMessages(
    chatModel082(),
    multiStepContext(BARE_THINKING),
    resolvedCompat(false),
  ) as unknown as Array<Record<string, unknown>>
  const assistant = assistantOf(messages)
  assert.equal('reasoning_content' in assistant, false, 'this absent key is exactly the reported 400 shape')
})

test('#96 pi-ai 0.82.1: migration — the compat flag writes an (empty) reasoning_content for old histories', () => {
  const messages = openaiCompletions.convertMessages(
    chatModel082({ requiresReasoningContentOnAssistantMessages: true }),
    multiStepContext(BARE_THINKING),
    resolvedCompat(true),
  ) as unknown as Array<Record<string, unknown>>
  const assistant = assistantOf(messages)
  assert.equal(assistant.reasoning_content, '', 'fix C: the key must be present, not populated')
})

test('#96 pi-ai 0.87.1: the same three wire shapes hold on the hoisted-profile copy', () => {
  const signed = openaiCompletions087.convertMessages(
    chatModel087(),
    multiStepContext(SIGNED_THINKING) as unknown as Context87Arg,
    resolvedCompat087(false),
  ) as unknown as Array<Record<string, unknown>>
  assert.equal(assistantOf(signed).reasoning_content, REASONING_TEXT, 'fix B survives the 0.87.1 serializer')

  const before = openaiCompletions087.convertMessages(
    chatModel087(),
    multiStepContext(BARE_THINKING) as unknown as Context87Arg,
    resolvedCompat087(false),
  ) as unknown as Array<Record<string, unknown>>
  assert.equal('reasoning_content' in assistantOf(before), false, 'the 0.87.1 before-fix shape loses the key too')

  const after = openaiCompletions087.convertMessages(
    chatModel087({ requiresReasoningContentOnAssistantMessages: true }),
    multiStepContext(BARE_THINKING) as unknown as Context87Arg,
    resolvedCompat087(true),
  ) as unknown as Array<Record<string, unknown>>
  assert.equal(assistantOf(after).reasoning_content, '', 'fix C covers old histories on 0.87.1 as well')
})

/** SSE frames served in request order by the local capture server. */
function sse(...chunks: Array<Record<string, unknown>>): string {
  const frames = chunks.map((chunk) => 'data: ' + JSON.stringify({ id: 'chatcmpl-96', object: 'chat.completion.chunk', created: 0, model: MODEL, ...chunk }))
  frames.push('data: [DONE]')
  return frames.join('\n\n') + '\n\n'
}

const REASONING_TOOL_SSE = sse(
  { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: REASONING_TEXT }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
)
const ANSWER_SSE = sse(
  { choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
)

interface Captured { url?: string; body: Record<string, unknown> }

function startScriptedServer(scripts: string[]): Promise<{ server: Server; url: string; captured: Captured[] }> {
  const captured: Captured[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += String(chunk) })
    req.on('end', () => {
      let parsed: Record<string, unknown> = {}
      try { parsed = JSON.parse(raw) as Record<string, unknown> } catch { parsed = { unparsable: raw } }
      captured.push({ url: req.url, body: parsed })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(scripts[captured.length - 1] ?? ANSWER_SSE)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no port')
      resolve({ server, url: 'http://127.0.0.1:' + address.port, captured })
    })
  })
}

/** The drive from host-tools-wire.test.ts: real adapter, opencode.ai redirected to localhost. */
async function driveAdapter(
  requests: HarnessGenerateOptions[],
  scripts: string[],
): Promise<{ captured: Captured[]; streams: HarnessChunk[][] }> {
  const { server, url, captured } = await startScriptedServer(scripts)
  const realFetch = globalThis.fetch
  globalThis.fetch = ((input: unknown, init?: unknown) => {
    const original = typeof input === 'string' ? input : (input as { url?: string })?.url ?? String(input)
    return realFetch(original.replace(/^https:\/\/opencode\.ai/, url), init as never)
  }) as typeof fetch
  const streams: HarnessChunk[][] = []
  try {
    const adapter = new ZenAdapter({
      list: () => [MODEL],
      decision: () => ({ allowed: true, known: true, source: 'test' }),
      reasoningCapability: () => ({ reasoning: true, effortValues: ['max'] }),
    } as never)
    for (const request of requests) {
      const chunks: HarnessChunk[] = []
      for await (const chunk of adapter.stream(request)) chunks.push(chunk)
      streams.push(chunks)
    }
    return { captured, streams }
  } finally {
    globalThis.fetch = realFetch
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('#96 end-to-end: the turn 2 wire carries reasoning_content from the turn 1 streamed signature', async () => {
  const turn1: HarnessGenerateOptions = {
    provider: 'opencode2dsh', model: MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'run ls' }] }],
    reasoningEffort: 'max', maxTokens: 32_000,
    signal: AbortSignal.timeout(15_000),
  }
  const first = await driveAdapter([turn1], [REASONING_TOOL_SSE])
  assert.equal(first.captured.length, 1, 'one request, no sibling replay')

  // Turn 1: the chunk stream must carry the replay key forward (fix B, stream side).
  const ends0 = first.streams[0]!.filter(
    (chunk): chunk is Extract<HarnessChunk, { type: 'block-end' }> => chunk.type === 'block-end',
  )
  const reasoningEnd = ends0.find((chunk) => chunk.block.type === 'reasoning')
  assert.ok(reasoningEnd, 'turn 1 streams a reasoning block')
  assert.equal(reasoningEnd.block.type === 'reasoning' ? reasoningEnd.block.signature : undefined, 'reasoning_content')
  const toolEnd = ends0.find((chunk) => chunk.block.type === 'tool-call')
  assert.ok(toolEnd, 'turn 1 streams a tool call')

  // Persist exactly what the chunks announced (what a host stores), then replay it.
  const assistantBlocks = first.streams[0]!
    .filter((chunk): chunk is Extract<HarnessChunk, { type: 'block-end' }> => chunk.type === 'block-end')
    .map((chunk) => chunk.block) as HarnessBlock[]
  const turn2: HarnessGenerateOptions = {
    ...turn1,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'run ls' }] },
      { role: 'assistant', content: assistantBlocks, source: { kind: 'model', provider: 'opencode2dsh', model: MODEL } },
      { role: 'tool', toolCallId: 'call_1', isError: false, content: [{ type: 'text', text: 'file list' }], source: { kind: 'tool', callId: 'call_1' } },
    ],
  }
  const second = await driveAdapter([turn2], [ANSWER_SSE])
  const body = second.captured[0]!.body
  const assistant = assistantOf((body.messages ?? []) as Array<Record<string, unknown>>)
  assert.equal(assistant.reasoning_content, REASONING_TEXT, 'the reported 400 no longer reproduces: the field is back on the wire')
  assert.ok(Array.isArray(assistant.tool_calls), 'the tool call still replays alongside the reasoning')
})

test('#96 end-to-end migration: pre-fix persisted history (signature-less) still sends reasoning_content', async () => {
  // A conversation stored by any plugin build before fix B: the reasoning
  // block has text but no signature. Fix C must keep the key on the wire.
  const request: HarnessGenerateOptions = {
    provider: 'opencode2dsh', model: MODEL,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'run ls' }] },
      { role: 'assistant', content: [
        { type: 'reasoning', text: REASONING_TEXT },
        { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' },
      ] },
      { role: 'tool', toolCallId: 'call_1', isError: false, content: [{ type: 'text', text: 'file list' }], source: { kind: 'tool', callId: 'call_1' } },
    ],
    reasoningEffort: 'max', maxTokens: 32_000,
    signal: AbortSignal.timeout(15_000),
  }
  const { captured } = await driveAdapter([request], [ANSWER_SSE])
  const body = captured[0]!.body
  const assistant = assistantOf((body.messages ?? []) as Array<Record<string, unknown>>)
  assert.equal(assistant.reasoning_content, '', 'old histories get the empty-but-present key instead of a 400')
})

interface WireOptions {
  onPayload: (payload: unknown) => unknown
  maxTokens?: number
  signal?: AbortSignal
  headers: Record<string, string>
}

test('#96: the reasoning-recovery retry keeps the signature on the first-attempt reasoning block', async () => {
  // Recovery (reasoning-only max-tokens -> retry with Off) re-emits the first
  // attempt's terminal chunks; the signature must survive that re-emission.
  const partial = { content: [{ type: 'thinking', thinking: REASONING_TEXT, thinkingSignature: 'reasoning_content' }] }
  const thinkingEvents: PiEvent[] = [
    { type: 'thinking_start', contentIndex: 0, partial },
    { type: 'thinking_delta', contentIndex: 0, delta: REASONING_TEXT, partial },
    { type: 'thinking_end', contentIndex: 0, content: REASONING_TEXT, partial },
    { type: 'done', message: doneMessage({ stopReason: 'length', usage: { input: 10, output: 64, cacheRead: 3, cacheWrite: 2, totalTokens: 79 } }) },
  ]
  const answerPartial = { content: [{ type: 'text', text: '323' }] }
  const answerEvents: PiEvent[] = [
    { type: 'text_start', contentIndex: 0, partial: answerPartial },
    { type: 'text_delta', contentIndex: 0, delta: '323', partial: answerPartial },
    { type: 'text_end', contentIndex: 0, content: '323', partial: answerPartial },
    { type: 'done', message: doneMessage({ stopReason: 'stop', content: answerPartial.content, usage: { input: 11, output: 4, cacheRead: 5, cacheWrite: 1, totalTokens: 21 } }) },
  ]
  const calls: WireOptions[] = []
  const adapter = new ZenAdapter({
    list: () => [MODEL],
    decision: () => ({ allowed: true, known: true, source: 'test' }),
    reasoningCapability: () => ({ reasoning: true, effortValues: [] }),
  } as never, { providerOverride: {
    streamSimple(_model: unknown, _context: unknown, wireOptions: WireOptions) {
      calls.push(wireOptions)
      const events = calls.length === 1 ? thinkingEvents : answerEvents
      return (async function* () {
        for (const event of events) yield event
      })()
    },
  } as never })
  const chunks: HarnessChunk[] = []
  for await (const chunk of adapter.stream({
    provider: 'opencode2dsh', model: MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Calculate 17 * 19.' }] }],
    reasoningEffort: 'high', maxTokens: 64,
  })) chunks.push(chunk)
  assert.equal(calls.length, 2, 'the recovery retry fired')
  const reasoningEnds = chunks.filter(
    (chunk): chunk is Extract<HarnessChunk, { type: 'block-end' }> => chunk.type === 'block-end' && chunk.block.type === 'reasoning',
  )
  assert.ok(reasoningEnds.length >= 1)
  for (const chunk of reasoningEnds) {
    assert.ok(chunk.block.type === 'reasoning')
    assert.equal(chunk.block.signature, 'reasoning_content', 'every re-emitted reasoning block keeps the replay key')
  }
})
