/**
 * Child driver for hoisted-pi-ai-087.test.ts. Runs the BUILT plugin
 * (lib/index.js) in a process where the resolver hook
 * (hoisted087-register.mjs) serves '@earendil-works/pi-ai' — main entry and
 * api/* subpaths alike — from the hoisted 0.87.1 copy, the DSH profile layout
 * from #77. It streams one request through the real adapter against a local
 * capture server and prints the observed wire facts as a single JSON line on
 * stdout (HOISTED087 {...}).
 *
 * Usage: node --import hoisted087-register.mjs hoisted087-drive.mjs [with-tools|no-tools]
 *
 * The process exits explicitly after printing: apply() starts the catalog's
 * refresh cycle, which leaves timers alive that would otherwise keep the
 * child parked long after the report is out.
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const mode = process.argv[2] ?? 'with-tools'

// The hook redirected this specifier to the hoisted 0.87.1 copy; read the
// version straight from that copy's package.json.
const piAiEntry = import.meta.resolve('@earendil-works/pi-ai')
const piAiVersion = JSON.parse(readFileSync(new URL('../package.json', piAiEntry), 'utf8')).version

const S = (description) => ({ type: 'string', description })
const HOST_TOOLS = [
  { name: 'pwsh', description: 'shell', parameters: { type: 'object', properties: { command: S('command') }, required: ['command'] } },
  { name: 'read', description: 'read', parameters: { type: 'object', properties: { file_path: S('path') }, required: ['file_path'] } },
  { name: 'grep', description: 'grep', parameters: { type: 'object', properties: { pattern: S('pattern') }, required: ['pattern'] } },
]

const CHAT_SSE = [
  'data: {"id":"chatcmpl-c","object":"chat.completion.chunk","created":0,"model":"mimo-v2.6-flash-free","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-c","object":"chat.completion.chunk","created":0,"model":"mimo-v2.6-flash-free","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
].join('\n')

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(raw)
    } catch {
      body = { unparsable: raw }
    }
    server.seen.push({ url: req.url, body })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(CHAT_SSE)
  })
})
server.seen = []
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const localUrl = `http://127.0.0.1:${(server.address()).port}`

// The adapter's model baseUrl is the opencode.ai constant; redirect it here.
// models.dev goes to the same local server: the catalog's metadata fetch then
// fails fast on the SSE body instead of racing the real network on every run.
const realFetch = globalThis.fetch
globalThis.fetch = ((input, init) => {
  const original = typeof input === 'string' ? input : input?.url ?? String(input)
  const redirected = original
    .replace(/^https:\/\/opencode\.ai/, localUrl)
    .replace(/^https:\/\/models\.dev/, localUrl)
  if (process.env.HOISTED087_DEBUG) process.stderr.write(`[fetch] ${original} -> ${redirected}\n`)
  return realFetch(redirected, init)
})

const plugin = await import(new URL('../../lib/index.js', import.meta.url).href)
let adapter = null
const noop = () => {}
await plugin.apply({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  llm: { registerAdapter(_ids, a) { adapter = a; return { dispose: noop } } },
  settings: undefined, effect: undefined, inject: undefined,
  emit: noop, on: noop, get: () => undefined,
}, { providerId: 'opencode2dsh' })

if (!adapter) throw new Error('adapter was not registered')

let finish = 'none'
let errorMessage = null
try {
  for await (const chunk of adapter.stream({
    provider: 'opencode2dsh',
    model: 'mimo-v2.6-flash-free',
    messages: [{ role: 'user', content: [{ type: 'text', text: `Run Get-Location with the pwsh tool. (${mode})` }] }],
    ...(mode === 'with-tools' ? { tools: HOST_TOOLS } : {}),
    maxTokens: 64,
    signal: AbortSignal.timeout(15_000),
  })) {
    if (chunk.type === 'finish') {
      finish = chunk.reason.kind
      if (chunk.reason.kind === 'error') errorMessage = chunk.reason.failure?.message ?? null
    }
  }
} catch (error) {
  finish = `thrown: ${error instanceof Error ? error.message : String(error)}`
}

globalThis.fetch = realFetch
server.closeAllConnections()
await new Promise((resolve) => server.close(resolve))

const seen = server.seen.find((entry) => String(entry.url).includes('/chat/completions'))
const tools = Array.isArray(seen?.body?.tools) ? seen.body.tools.map((tool) => (tool.function ?? tool).name ?? '') : []
const report = {
  piAiVersion,
  finish,
  errorMessage,
  requestCount: server.seen.length,
  requests: server.seen.map((entry) => String(entry.url)),
  wireTools: tools.filter(Boolean).sort(),
  toolChoice: seen?.body?.tool_choice ?? null,
}
process.stdout.write(`HOISTED087 ${JSON.stringify(report)}\n`, () => {
  // apply() started the catalog refresh cycle and pi-ai/undici keeps idle
  // keep-alive sockets around; the loop will not drain on its own. Tear the
  // handles down, give the closes a beat to settle, then leave — exiting
  // while libuv is mid-close crashes on Windows (UV_HANDLE_CLOSING).
  for (const handle of process._getActiveHandles()) {
    const kind = handle.constructor?.name
    if (typeof handle.closeAllConnections === 'function') handle.closeAllConnections()
    if (kind === 'Socket' || kind === 'TLSSocket') handle.destroy()
    else if (typeof handle.close === 'function' && handle.listening) handle.close()
  }
  const code = finish === 'stop' ? 0 : 1
  setTimeout(() => process.exit(code), 150)
})
