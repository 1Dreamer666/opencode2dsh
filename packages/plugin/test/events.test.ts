import test from 'node:test'
import assert from 'node:assert/strict'
import { toStreamChunks, type HarnessChunk, type PiEvent } from '../src/adapter/events.ts'

const CONTEXT_WINDOW = 262144

function done(overrides: Partial<Parameters<typeof event>[0]> = {}): PiEvent {
  return event({ type: 'done', ...overrides })
}

function event(message: Record<string, unknown>): PiEvent {
  return {
    type: 'done',
    message: {
      api: 'openai-completions',
      provider: 'opencode2dsh',
      model: 'qwen-free',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
      stopReason: 'stop',
      ...message,
    },
  } as unknown as PiEvent
}

async function collect(events: PiEvent[]): Promise<HarnessChunk[]> {
  const chunks: HarnessChunk[] = []
  for await (const chunk of toStreamChunks(
    (async function* () {
      for (const event of events) yield event
    })(),
  )) {
    chunks.push(chunk)
  }
  return chunks
}

type FinishChunk = Extract<HarnessChunk, { type: 'finish' }>

function expectFinish(chunk: HarnessChunk | undefined): FinishChunk {
  assert.equal(chunk?.type, 'finish')
  return chunk as FinishChunk
}

function failureOf(chunk: FinishChunk): { message: string; code: string } {
  if (chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted') assert.fail('expected a failure reason')
  return chunk.reason.failure
}

test('text deltas flow through and the stream ends with usage then finish', async () => {
  const chunks = await collect([
    { type: 'start', partial: { content: [] } },
    { type: 'text_start', contentIndex: 0, partial: { content: [] } },
    { type: 'text_delta', contentIndex: 0, delta: 'hel', partial: { content: [] } },
    { type: 'text_delta', contentIndex: 0, delta: 'lo', partial: { content: [] } },
    { type: 'text_end', contentIndex: 0, content: 'hello', partial: { content: [] } },
    done({ usage: { input: 7, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 12 } }),
  ])
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hel' },
    { type: 'text-delta', index: 0, text: 'lo' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
    { type: 'usage', usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(chunks[chunks.length - 1]?.type, 'finish')
  assert.equal(chunks[chunks.length - 2]?.type, 'usage', 'usage immediately precedes finish')
})

test('tool calls stream as tool-call blocks with stringified arguments', async () => {
  const partial = { content: [{ type: 'toolCall', id: 't1', name: 'shell' }] }
  const chunks = await collect([
    { type: 'toolcall_start', contentIndex: 0, partial },
    { type: 'toolcall_delta', contentIndex: 0, delta: '{"cm', partial },
    { type: 'toolcall_delta', contentIndex: 0, delta: 'd":"ls"}', partial },
    {
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { id: 't1', name: 'shell', arguments: { cmd: 'ls' } },
      partial,
    },
    done({ content: [{ type: 'toolCall', id: 't1', name: 'shell', arguments: { cmd: 'ls' } }], stopReason: 'toolUse' }),
  ])
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'tool-call' })
  assert.deepEqual(chunks[1], { type: 'tool-call-delta', index: 0, id: 't1', name: 'shell', argumentsDelta: '{"cm' })
  assert.deepEqual(chunks[2], { type: 'tool-call-delta', index: 0, id: 't1', name: 'shell', argumentsDelta: 'd":"ls"}' })
  assert.deepEqual(chunks[3], {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: 't1', name: 'shell', arguments: '{"cmd":"ls"}' },
  })
  assert.deepEqual(chunks[5], { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('thinking events map to reasoning blocks', async () => {
  const chunks = await collect([
    { type: 'thinking_start', contentIndex: 0, partial: { content: [] } },
    { type: 'thinking_delta', contentIndex: 0, delta: 'hmm', partial: { content: [] } },
    { type: 'thinking_end', contentIndex: 0, content: 'hmm', partial: { content: [] } },
    done(),
  ])
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'reasoning' })
  assert.deepEqual(chunks[1], { type: 'reasoning-delta', index: 0, text: 'hmm' })
  assert.deepEqual(chunks[2], { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'hmm' } })
})

test('finish reasons: length, aborted, rate limit and other errors', async () => {
  const length = await collect([done({ stopReason: 'length' })])
  assert.deepEqual(length[1], { type: 'finish', reason: { kind: 'max-tokens' } })
  const aborted = await collect([event({ stopReason: 'aborted', errorMessage: 'user aborted' })])
  assert.deepEqual(aborted[1], {
    type: 'finish',
    reason: { kind: 'aborted', failure: { message: 'user aborted', code: 'ABORTED' } },
  })
  const rate = await collect([event({ stopReason: 'error', errorMessage: 'HTTP 429 rate limited' })])
  assert.equal(failureOf(expectFinish(rate[1])).code, 'RATE_LIMIT')
  const server = await collect([event({ stopReason: 'error', errorMessage: 'HTTP 500 oops' })])
  assert.equal(failureOf(expectFinish(server[1])).code, 'SERVER')
})

test('pi-ai stream truncation wording stays on the TRANSPORT retry path', async () => {
  // The native dsh-llm-pi-ai adapter maps all of these provider wordings to
  // TRANSPORT. If the port falls through to UPSTREAM, dsh-llm-retry silently
  // skips the failed step even though the free-lane policy retries TRANSPORT.
  const messages = [
    'other side closed',
    'HTTP2 request did not get a response',
    'WebSocket closed unexpectedly',
    'terminated',
    'Premature close',
    'Anthropic stream ended before message_stop',
    'OpenAI Responses stream ended before a terminal response event',
    'openrouter stream ended without a terminal event',
    'Stream ended without finish_reason',
  ]
  for (const message of messages) {
    const chunks = await collect([event({ stopReason: 'error', errorMessage: message })])
    assert.deepEqual(failureOf(expectFinish(chunks[1])), { message, code: 'TRANSPORT' }, message)
  }
})

test('zero-cache usage omits the optional keys', async () => {
  const chunks = await collect([done()])
  assert.deepEqual(chunks[0], { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } })
})

test('Muse regional 403 keeps its upstream explanation in both error event shapes', async () => {
  const message = 'OpenAI API error (403): {"type":"RegionError","message":"This model is not available in your country."}'
  const completed = event({ stopReason: 'error', errorMessage: message })
  assert.equal(completed.type, 'done')
  if (completed.type !== 'done') assert.fail('expected a done event')
  for (const upstream of [completed, { type: 'error', error: completed.message } as PiEvent]) {
    const chunks = await collect([upstream])
    assert.deepEqual(failureOf(expectFinish(chunks[1])), { message, code: 'REGION_BLOCKED' })
  }
})

test('authentication failures retain AUTH when the upstream does not report a region block', async () => {
  for (const status of [401, 403]) {
    const message = `OpenAI API error (${status}): {"error":{"code":"invalid_api_key","message":"Invalid API key"}}`
    const chunks = await collect([event({ stopReason: 'error', errorMessage: message })])
    assert.deepEqual(failureOf(expectFinish(chunks[1])), { message, code: 'AUTH' })
  }
})

test('FreeTierError preserves the upstream client restriction instead of blaming an API key', async () => {
  const message = 'HTTP 403: {"type":"FreeTierError","message":"OpenCode\'s free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."}'
  const completed = event({ stopReason: 'error', errorMessage: message })
  if (completed.type !== 'done') assert.fail('expected done event')
  for (const upstream of [completed, { type: 'error', error: completed.message } as PiEvent]) {
    const chunks = await collect([upstream])
    assert.deepEqual(failureOf(expectFinish(chunks[1])), { message, code: 'FREE_TIER_RESTRICTED' })
  }
})

test('an empty completed response is an EMPTY_RESPONSE error', async () => {
  const chunks = await collect([event({ content: [] })])
  const failure = failureOf(expectFinish(chunks[1]))
  assert.match(failure.message, /no content/)
  assert.equal(failure.code, 'EMPTY_RESPONSE')
})

test('a healthy stop whose input exceeds the advertised window finishes cleanly (#99)', async () => {
  // The wire count runs ~4-5k above the host's history estimate, so history
  // filled to the advertised window lands above it on the wire. Upstream
  // answered: the turn succeeded. Pre-fix this fabricated
  // CONTEXT_WINDOW_EXCEEDED out of a healthy stop.
  const chunks = await collect([event({ usage: { input: CONTEXT_WINDOW + 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: CONTEXT_WINDOW + 1 } })])
  assert.deepEqual(chunks[1], { type: 'finish', reason: { kind: 'stop' } })
})

test('an upstream context-exceeded error keeps CONTEXT_WINDOW_EXCEEDED with the upstream body preserved', async () => {
  const message = "OpenAI API error (400): This model's maximum context length is 200000 tokens. However, you requested 205000 tokens."
  const chunks = await collect([event({ stopReason: 'error', errorMessage: message })])
  assert.deepEqual(failureOf(expectFinish(chunks[1])), { message, code: 'CONTEXT_WINDOW_EXCEEDED' })
})

test('a stream that ends without done/error is a bug and throws', async () => {
  await assert.rejects(collect([{ type: 'start', partial: { content: [] } }]), /without done\/error/)
})
