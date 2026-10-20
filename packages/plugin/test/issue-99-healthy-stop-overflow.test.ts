/**
 * #99 regression: sessions near the advertised context window failed with a
 * fabricated CONTEXT_WINDOW_EXCEEDED while official opencode continued.
 * mapStopReason ported dsh-llm-pi-ai's isContextOverflow heuristic — an
 * error-free `stop` finish was re-classified as a context error whenever wire
 * usage.input alone exceeded the resolved window. The wire token count runs
 * ~4-5k above the host's history estimate (system prompt + gate tools +
 * serialization), so history filled to the advertised window reliably tripped
 * it. Post-fix contract: if the upstream accepted and answered, the turn
 * succeeded at any size; a genuine upstream refusal (HTTP 400
 * context_length_exceeded) still surfaces as CONTEXT_WINDOW_EXCEEDED with the
 * upstream body preserved.
 *
 * Drives the REAL adapter + REAL pi-ai 0.82.1 against a local scripted SSE
 * server (fetch-redirect technique from reasoning-signature-roundtrip.test.ts).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'

import { ZenAdapter } from '../src/adapter/zen-adapter.ts'
import type { HarnessChunk } from '../src/adapter/events.ts'
import type { HarnessGenerateOptions } from '../src/adapter/messages.ts'

const MODEL = 'deepseek-v4.1-flash-free'

function sse(...frames: Record<string, unknown>[]): string {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
}

interface Captured { body: Record<string, unknown>; estimatedTokens: number }

function startServer(mode: 'ok' | 'ctx400'): Promise<{ server: Server; url: string; captured: Captured[] }> {
  const captured: Captured[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += String(chunk) })
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>
      const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : []
      let chars = 0
      for (const message of messages) chars += JSON.stringify(message).length
      const estimated = Math.round(chars / 4)
      captured.push({ body, estimatedTokens: estimated })
      if (mode === 'ctx400') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'context_length_exceeded', message: `This model's maximum context length is 200000 tokens. However, you requested ${estimated} tokens.` } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(sse(
        { choices: [{ index: 0, delta: { role: 'assistant', content: 'ok continuation' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: estimated, completion_tokens: 4 } },
      ))
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

/** ~targetToken history: alternating user/assistant turns with text, one
 * tool-call + reasoning pair to match the reporter's shape. ~4 chars/token. */
function bigHistory(targetTokens: number): HarnessGenerateOptions['messages'] {
  const messages: NonNullable<HarnessGenerateOptions['messages']> = []
  const turnChars = 8_000 // ≈2k tokens per message
  const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '
  let total = 0
  let i = 0
  while (total < targetTokens * 4) {
    const text = filler.repeat(Math.ceil(turnChars / filler.length))
    messages.push({ role: 'user', content: [{ type: 'text', text: `turn ${i}: ${text}` }] })
    messages.push({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'thinking', signature: 'reasoning_content' },
        { type: 'text', text: `answer ${i}: ${text}` },
      ],
      source: { kind: 'model', provider: 'opencode2dsh', model: MODEL },
    })
    total += turnChars * 2
    i += 1
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: 'continue' }] })
  return messages
}

interface CaseResult { chunks: HarnessChunk[]; captured: Captured[]; err: string | null }

async function runCase(window: number, tokens: number, mode: 'ok' | 'ctx400'): Promise<CaseResult> {
  const { server, url, captured } = await startServer(mode)
  const realFetch = globalThis.fetch
  globalThis.fetch = ((input: unknown, init?: unknown) => {
    const original = typeof input === 'string' ? input : (input as { url?: string })?.url ?? String(input)
    return realFetch(original.replace(/^https:\/\/opencode\.ai/, url), init as never)
  }) as typeof fetch
  const chunks: HarnessChunk[] = []
  let err: string | null = null
  try {
    const adapter = new ZenAdapter({
      list: () => [MODEL],
      decision: () => ({ allowed: true, known: true, source: 'test' }),
      reasoningCapability: () => ({ reasoning: true, effortValues: ['max'] }),
      limits: () => ({ contextWindow: window, maxOutput: 32_000 }),
    } as never)
    try {
      for await (const chunk of adapter.stream({
        provider: 'opencode2dsh', model: MODEL,
        messages: bigHistory(tokens),
        reasoningEffort: 'max', maxTokens: 32_000,
        signal: AbortSignal.timeout(30_000),
      })) chunks.push(chunk)
    } catch (e) {
      err = e instanceof Error ? e.message : String(e)
    }
    return { chunks, captured, err }
  } finally {
    globalThis.fetch = realFetch
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function finishOf(result: CaseResult): Extract<HarnessChunk, { type: 'finish' }> {
  assert.equal(result.err, null, `the adapter stream must not throw: ${result.err ?? ''}`)
  const finish = result.chunks.at(-1)
  assert.equal(finish?.type, 'finish', 'the chunk stream must end with a finish chunk')
  return finish as Extract<HarnessChunk, { type: 'finish' }>
}

test('#99: a 200k-advertised model at ~205k history on a healthy server finishes with a clean stop', async () => {
  // The reporter's shape: history filled to the advertised window, upstream
  // answers normally — pre-fix this came back as CONTEXT_WINDOW_EXCEEDED.
  const result = await runCase(200_000, 205_000, 'ok')
  assert.ok((result.captured[0]?.estimatedTokens ?? 0) > 200_000, 'the wire request must actually cross the advertised window')
  assert.deepEqual(finishOf(result).reason, { kind: 'stop' })
})

test('#99: a genuine upstream 400 context_length_exceeded still surfaces CONTEXT_WINDOW_EXCEEDED with the upstream body', async () => {
  const result = await runCase(1_048_576, 205_000, 'ctx400')
  const finish = finishOf(result)
  assert.equal(finish.reason.kind, 'error')
  if (finish.reason.kind !== 'error') return
  assert.equal(finish.reason.failure.code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.match(finish.reason.failure.message, /maximum context length is 200000 tokens/, 'the upstream message text must be preserved')
})

test('#99: a 1M-advertised model at ~1.06M history on a healthy server also finishes cleanly', async () => {
  // Post-fix contract: a healthy answer is a healthy answer at any size — no
  // client-side size policing beyond what the upstream itself reports.
  const result = await runCase(1_048_576, 1_060_000, 'ok')
  assert.ok((result.captured[0]?.estimatedTokens ?? 0) > 1_048_576, 'the wire request must actually cross the advertised window')
  assert.deepEqual(finishOf(result).reason, { kind: 'stop' })
})
