import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platform } from 'node:process'

import {
  atLeastVersion,
  buildDelegatePayload,
  DelegateSession,
  DELEGATE_PERMISSION_POLICY,
  findOpencodeBinary,
  MIN_OPENCODE_VERSION,
  OpencodeDelegate,
  seedDelegateAuth,
  sessionPermissionArray,
} from '../src/adapter/delegate.ts'
import { toPiContext, type HarnessGenerateOptions } from '../src/adapter/messages.ts'

/** A scripted mock `opencode serve` speaking the issue's protocol shape. */
interface MessageOutcome {
  status?: number
  info?: Record<string, unknown>
  parts?: Array<Record<string, unknown>>
  /** Hold the turn until the monitor refuses this permission id. */
  delayUntilReply?: string
}
type MessageHandler = (body: unknown) => MessageOutcome

interface MockOpencode {
  url: string
  close: () => Promise<void>
  /** Requests the mock received, for assertions. */
  log: Array<{ method: string; path: string; body: unknown }>
  /** Pending permission replies captured by the mock. */
  replies: Array<{ id: string; body: { reply?: string } }>
  sessionsCreated: Array<{ body: unknown }>
  messagesPosted: Array<{ body: unknown }>
  deletedSessions: string[]
  abortedSessions: string[]
  /** Configure how the next /session/{id}/message responds. */
  onMessage: (handler: MessageHandler | null) => void
  /** Inject a pending permission the monitor should refuse. */
  raisePermission: (id: string, callID: string) => void
}

function mockOpencode(): Promise<MockOpencode> {
  const log: MockOpencode['log'] = []
  const replies: MockOpencode['replies'] = []
  const sessionsCreated: MockOpencode['sessionsCreated'] = []
  const messagesPosted: MockOpencode['messagesPosted'] = []
  const deletedSessions: string[] = []
  const abortedSessions: string[] = []
  let pendingPermissions: Array<{ id: string; sessionID: string; tool: { callID: string } }> = []
  let messageHandler: MessageHandler | null = null
  let permissionWaiters: Array<() => void> = []

  return new Promise((resolve, reject) => {
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk as Buffer))
      req.on('end', () => {
        const path = req.url ?? '/'
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
        log.push({ method: req.method ?? 'GET', path, body })
        const respond = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(payload))
        }

        if (path === '/global/health' && req.method === 'GET') return respond(200, { healthy: true, version: '1.19.0' })
        if (path === '/session' && req.method === 'POST') {
          sessionsCreated.push({ body })
          return respond(200, { id: 'ses_delegatemock' })
        }
        if (path === '/permission' && req.method === 'GET') {
          return respond(200, pendingPermissions)
        }
        const replyMatch = /^\/permission\/([^/]+)\/reply$/.exec(path)
        if (replyMatch && req.method === 'POST') {
          replies.push({ id: decodeURIComponent(replyMatch[1] ?? ''), body: body as { reply?: string } })
          pendingPermissions = pendingPermissions.filter((permission) => permission.id !== replyMatch[1])
          // Wake a message POST that was waiting for this refusal.
          for (const wake of permissionWaiters.splice(0)) wake()
          return respond(200, {})
        }
        const abortMatch = /^\/session\/([^/]+)\/abort$/.exec(path)
        if (abortMatch && req.method === 'POST') {
          abortedSessions.push(decodeURIComponent(abortMatch[1] ?? ''))
          return respond(200, {})
        }
        const messageMatch = /^\/session\/([^/]+)\/message$/.exec(path)
        if (messageMatch && req.method === 'POST') {
          messagesPosted.push({ body })
          const handler = messageHandler
          if (!handler) return respond(200, { info: { finish: 'stop', tokens: { input: 3, output: 4 } }, parts: [{ type: 'text', text: 'ok' }] })
          const outcome = handler(body)
          const send = (): void => respond(outcome.status ?? 200, { info: outcome.info ?? { finish: 'stop', tokens: { input: 1, output: 1 } }, parts: outcome.parts ?? [] })
          if (outcome.delayUntilReply) {
            // Hold the turn open until the monitor refuses this permission id.
            const id = outcome.delayUntilReply
            const trySend = (): void => {
              if (replies.some((reply) => reply.id === id)) send()
              else permissionWaiters.push(trySend)
            }
            trySend()
            return
          }
          return send()
        }
        const sessionMatch = /^\/session\/([^/]+)$/.exec(path)
        if (sessionMatch && req.method === 'DELETE') {
          deletedSessions.push(decodeURIComponent(sessionMatch[1] ?? ''))
          return respond(200, {})
        }
        respond(404, { error: 'not found' })
      })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
        log,
        replies,
        sessionsCreated,
        messagesPosted,
        deletedSessions,
        abortedSessions,
        onMessage: (handler) => { messageHandler = handler },
        raisePermission: (id, callID) => {
          pendingPermissions.push({ id, sessionID: 'ses_delegatemock', tool: { callID } })
          for (const wake of permissionWaiters.splice(0)) wake()
        },
      })
    })
  })
}

const turnOptions: HarnessGenerateOptions = {
  provider: 'opencode2dsh',
  model: 'mimo-v2.6-flash-free',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  system: 'be nice',
}

async function tempHome(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'o2ds-delegate-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

// --- version floor -----------------------------------------------------------

test('atLeastVersion compares numeric semver, accepting the floor and above', () => {
  assert.equal(atLeastVersion('1.18.0', '1.18.0'), true)
  assert.equal(atLeastVersion('1.19.0', '1.18.0'), true)
  assert.equal(atLeastVersion('2.0.0', '1.18.0'), true)
  assert.equal(atLeastVersion('1.17.9', '1.18.0'), false)
  assert.equal(atLeastVersion('1.9.0', '1.18.0'), false, 'numeric compare, not lexical: 1.9 < 1.18')
  assert.equal(atLeastVersion('0.9.9', MIN_OPENCODE_VERSION), false)
})

// --- credential seeding ------------------------------------------------------

test('seedDelegateAuth copies ONLY the opencode entry, never other providers', async () => {
  const { dir, cleanup } = await tempHome()
  try {
    const authDir = join(dir, '.local', 'share', 'opencode')
    await mkdir(authDir, { recursive: true })
    await writeFile(join(authDir, 'auth.json'), JSON.stringify({
      opencode: { key: 'oc_sk_real', type: 'api' },
      anthropic: { key: 'sk-ant-secret', type: 'api' },
      openai: { key: 'sk-secret', type: 'api' },
    }))
    const dataDir = join(dir, 'delegate-data')
    const state = await seedDelegateAuth({ dataDir, home: dir, env: {} })
    assert.equal(state, 'seeded')

    const target = join(dataDir, 'opencode', 'data', 'opencode', 'auth.json')
    const seeded = JSON.parse(await readFile(target, 'utf8'))
    assert.deepEqual(seeded, { opencode: { key: 'oc_sk_real', type: 'api' } }, 'only the opencode provider entry lands in the isolated tree')
    assert.equal('anthropic' in seeded, false)
    assert.equal('openai' in seeded, false)
    if (platform !== 'win32') {
      const mode = (await stat(target)).mode & 0o777
      assert.equal(mode, 0o600, 'seeded credential is written 0600')
    }
    // Idempotent: a second seed is a no-op.
    assert.equal(await seedDelegateAuth({ dataDir, home: dir, env: {} }), 'present')
  } finally {
    await cleanup()
  }
})

test('seedDelegateAuth reports missing when there is no opencode credential anywhere', async () => {
  const { dir, cleanup } = await tempHome()
  try {
    const dataDir = join(dir, 'delegate-data')
    // No auth.json at all -> missing, and nothing is written.
    assert.equal(await seedDelegateAuth({ dataDir, home: dir, env: {} }), 'missing')
    assert.equal(existsSync(join(dataDir, 'opencode', 'data', 'opencode', 'auth.json')), false)
  } finally {
    await cleanup()
  }
})

test('seedDelegateAuth reports missing when the file has no opencode entry', async () => {
  const { dir, cleanup } = await tempHome()
  try {
    const authDir = join(dir, '.local', 'share', 'opencode')
    await mkdir(authDir, { recursive: true })
    await writeFile(join(authDir, 'auth.json'), JSON.stringify({ anthropic: { key: 'sk-ant' }, openai: { key: 'sk' } }))
    const dataDir = join(dir, 'delegate-data')
    assert.equal(await seedDelegateAuth({ dataDir, home: dir, env: {} }), 'missing')
    assert.equal(existsSync(join(dataDir, 'opencode', 'data', 'opencode', 'auth.json')), false, 'no credential is seeded from a file without an opencode entry')
  } finally {
    await cleanup()
  }
})

test('seedDelegateAuth prefers OPENCODE2DSH_AUTH_JSON, then XDG, then ~/.local', async () => {
  const { dir, cleanup } = await tempHome()
  try {
    const explicit = join(dir, 'custom-auth.json')
    await writeFile(explicit, JSON.stringify({ opencode: { key: 'oc_sk_custom' } }))
    const dataDir = join(dir, 'dd')
    await seedDelegateAuth({ dataDir, home: dir, env: { OPENCODE2DSH_AUTH_JSON: explicit } })
    const seeded = JSON.parse(await readFile(join(dataDir, 'opencode', 'data', 'opencode', 'auth.json'), 'utf8'))
    assert.deepEqual(seeded, { opencode: { key: 'oc_sk_custom' } })
  } finally {
    await cleanup()
  }
})

// --- binary resolution -------------------------------------------------------

test('findOpencodeBinary honors an explicit path only when it passes the floor', async () => {
  const { dir, cleanup } = await tempHome()
  try {
    const binary = join(dir, 'opencode')
    await writeFile(binary, '#!/bin/sh\n')
    // Above the floor: accepted.
    const ok = await findOpencodeBinary({ dataDir: dir, opencodePath: binary, versionProbe: async () => '1.19.2' })
    assert.equal(ok, binary)
    // Below the floor: rejected with a clear error.
    await assert.rejects(
      () => findOpencodeBinary({ dataDir: dir, opencodePath: binary, versionProbe: async () => '1.17.0' }),
      /below 1\.18\.0/,
    )
  } finally {
    await cleanup()
  }
})

test('findOpencodeBinary skips managed installs below the floor and adopts a usable user install', async () => {
  const { dir, cleanup } = await tempHome()
  try {
    // A managed install that is too old: must be skipped.
    await mkdir(join(dir, 'runtime', '1.17.0'), { recursive: true })
    await writeFile(join(dir, 'runtime', '1.17.0', 'opencode.exe'), 'old')
    // A user install on PATH that is new enough: adopted (copied) into the tree.
    const userBin = join(dir, 'userbin')
    await mkdir(userBin, { recursive: true })
    await writeFile(join(userBin, 'opencode.exe'), 'new')
    const found = await findOpencodeBinary({
      dataDir: dir,
      platform: 'win32',
      arch: 'x64',
      env: { PATH: userBin },
      home: join(dir, 'nohome'),
      versionProbe: async (file) => {
        if (!existsSync(file)) throw new Error('candidate does not exist')
        return file.includes('1.17.0') ? '1.17.0' : '1.19.0'
      },
    })
    assert.ok(found.includes('1.19.0'), `adopted the new user install, got: ${found}`)
  } finally {
    await cleanup()
  }
})

test('findOpencodeBinary falls back to the injected downloader when nothing local passes', async () => {
  const { dir, cleanup } = await tempHome()
  try {
    let downloaded = false
    const found = await findOpencodeBinary({
      dataDir: dir,
      platform: 'win32',
      arch: 'x64',
      env: {},
      home: join(dir, 'nohome'),
      versionProbe: async () => { throw new Error('no usable local binary') },
      downloader: async (target) => {
        downloaded = true
        const binary = join(target, '1.20.0', 'opencode.exe')
        await mkdir(join(target, '1.20.0'), { recursive: true })
        await writeFile(binary, 'downloaded')
        return binary
      },
    })
    assert.equal(downloaded, true, 'no local candidate passed, so the downloader ran')
    assert.ok(found.includes('1.20.0'))
  } finally {
    await cleanup()
  }
})

// --- payload construction ----------------------------------------------------

test('buildDelegatePayload targets the opencode provider with a JSON conversation', async () => {
  const context = await toPiContext(turnOptions)
  const payload = buildDelegatePayload(turnOptions, context) as {
    model: { providerID: string; modelID: string }
    agent: string
    system: string
    parts: Array<{ type: string; text: string }>
  }
  assert.equal(payload.model.providerID, 'opencode')
  assert.equal(payload.model.modelID, 'mimo-v2.6-flash-free')
  assert.equal(typeof payload.agent, 'string')
  assert.match(payload.system, /plain text/i, 'chat-only system instruction')
  assert.match(payload.system, /be nice/, 'the client system prompt is carried along')
  assert.equal(payload.parts.length, 1)
  assert.equal(payload.parts[0]?.type, 'text')
  const conversation = JSON.parse(payload.parts[0]?.text ?? '[]') as Array<{ role: string }>
  assert.equal(conversation[0]?.role, 'user')
})

// --- protocol against a mock opencode serve ---------------------------------

test('session creation carries the ask-then-reject permission array', async () => {
  const mock = await mockOpencode()
  try {
    const session = new DelegateSession(mock.url, 'pw')
    await session.completeTurn(buildDelegatePayload(turnOptions, await toPiContext(turnOptions)))
    const created = mock.sessionsCreated[0]?.body as { permission: Array<{ permission: string; action: string }> }
    assert.ok(Array.isArray(created.permission), 'session created with a permission array')
    const actions = new Map(created.permission.map((entry) => [entry.permission, entry.action]))
    assert.equal(actions.get('*'), 'ask', 'every native operation is asked, never auto-approved')
    assert.equal(actions.get('question'), 'deny')
    assert.equal(actions.get('webfetch'), 'deny')
    assert.equal(created.permission.length, Object.keys(DELEGATE_PERMISSION_POLICY).length)
    assert.deepEqual(sessionPermissionArray()[0], { permission: '*', pattern: '*', action: 'ask' })
  } finally {
    await mock.close()
  }
})

test('a completed turn is judged by info.error, never by text parts (the HTTP-200 gotcha)', async () => {
  const mock = await mockOpencode()
  try {
    // The mock answers HTTP 200 with BOTH a text part AND info.error — the exact
    // gate-failure shape that "has text part?" would misread as success.
    mock.onMessage(() => ({
      status: 200,
      info: { error: { name: 'APIError', message: "FreeTierError: free tier can only be used from within OpenCode" } },
      parts: [{ type: 'text', text: 'a plausible-looking answer' }],
    }))
    const session = new DelegateSession(mock.url, 'pw')
    await assert.rejects(
      async () => session.completeTurn(buildDelegatePayload(turnOptions, await toPiContext(turnOptions))),
      (error: unknown) => error instanceof Error && /free tier can only be used/i.test(error.message),
      'HTTP 200 + info.error must surface as a failure even with a text part present',
    )
  } finally {
    await mock.close()
  }
})

test('a non-2xx message response is a transport-class failure', async () => {
  const mock = await mockOpencode()
  try {
    mock.onMessage(() => ({ status: 500, info: {}, parts: [] }))
    const session = new DelegateSession(mock.url, 'pw')
    await assert.rejects(
      async () => session.completeTurn(buildDelegatePayload(turnOptions, await toPiContext(turnOptions))),
      /HTTP 500/,
    )
  } finally {
    await mock.close()
  }
})

test('a successful turn returns content parts and usage, then deletes the session', async () => {
  const mock = await mockOpencode()
  try {
    mock.onMessage(() => ({
      info: { finish: 'stop', tokens: { input: 11, output: 7, cache: { read: 3, write: 1 }, reasoning: 2 } },
      parts: [
        { type: 'reasoning', text: 'thinking it over' },
        { type: 'text', text: 'hello back' },
      ],
    }))
    const session = new DelegateSession(mock.url, 'pw')
    const turn = await session.completeTurn(buildDelegatePayload(turnOptions, await toPiContext(turnOptions)))
    assert.deepEqual(turn.parts, [
      { type: 'reasoning', text: 'thinking it over' },
      { type: 'text', text: 'hello back' },
    ], 'content parts keep their original order')
    assert.equal(turn.usage.inputTokens, 11)
    assert.equal(turn.usage.outputTokens, 9, 'reasoning folds into output')
    assert.equal(turn.usage.cacheReadTokens, 3)
    assert.equal(turn.usage.cacheWriteTokens, 1)
    assert.equal(turn.finish, 'stop')
    assert.deepEqual(mock.deletedSessions, ['ses_delegatemock'], 'the session is cleaned up')
  } finally {
    await mock.close()
  }
})

test('a native tool call is asked-then-rejected: the monitor refuses it and the turn still answers', async () => {
  const mock = await mockOpencode()
  try {
    mock.onMessage(() => ({
      // Hold the turn until the monitor refuses "perm-1"; the model then answers.
      delayUntilReply: 'perm-1',
      info: { finish: 'stop', tokens: { input: 5, output: 5 } },
      parts: [
        // The rejected call is recorded errored (nothing executed)...
        { type: 'tool', tool: 'bash', callID: 'call-1', state: { status: 'error', input: { command: 'ls' } } },
        // ...and the model answers in text afterwards.
        { type: 'text', text: 'I cannot run commands; here is the answer.' },
      ],
    }))
    const session = new DelegateSession(mock.url, 'pw')
    mock.raisePermission('perm-1', 'call-1')
    const turn = await session.completeTurn(buildDelegatePayload(turnOptions, await toPiContext(turnOptions)))
    assert.deepEqual(mock.replies.map((reply) => [reply.id, reply.body.reply]), [['perm-1', 'reject']], 'the approval was refused, not granted')
    assert.equal(turn.parts.some((part) => part.type === 'text'), true)
  } finally {
    await mock.close()
  }
})

test('an unexpected (non-rejected) tool part fails the turn: nothing may execute locally', async () => {
  const mock = await mockOpencode()
  try {
    // A tool part that was NOT rejected-and-errored means the ask-then-reject
    // gate leaked: the whole response is refused.
    mock.onMessage(() => ({
      info: { finish: 'stop', tokens: { input: 1, output: 1 } },
      parts: [
        { type: 'tool', tool: 'bash', callID: 'call-9', state: { status: 'completed', input: { command: 'id' } } },
        { type: 'text', text: 'done' },
      ],
    }))
    const session = new DelegateSession(mock.url, 'pw')
    await assert.rejects(
      async () => session.completeTurn(buildDelegatePayload(turnOptions, await toPiContext(turnOptions))),
      (error: unknown) => error instanceof Error && error.message.includes('native tool'),
      'a completed native tool part must fail the turn even alongside text',
    )
  } finally {
    await mock.close()
  }
})

test('an empty turn (no content) is an honest empty_response, not a fake success', async () => {
  const mock = await mockOpencode()
  try {
    mock.onMessage(() => ({ info: { finish: 'stop', tokens: { input: 1, output: 0 } }, parts: [] }))
    const session = new DelegateSession(mock.url, 'pw')
    await assert.rejects(
      async () => session.completeTurn(buildDelegatePayload(turnOptions, await toPiContext(turnOptions))),
      /no text or reasoning/,
    )
  } finally {
    await mock.close()
  }
})

// --- OpencodeDelegate end-to-end against the mock ----------------------------

test('OpencodeDelegate.stream translates a mock turn into a harness chunk stream', async () => {
  const mock = await mockOpencode()
  const { dir, cleanup } = await tempHome()
  try {
    mock.onMessage(() => ({
      info: { finish: 'stop', tokens: { input: 9, output: 6 } },
      parts: [{ type: 'text', text: 'delegated answer' }],
    }))
    const delegate = new OpencodeDelegate({
      dataDir: join(dir, 'dd'),
      connect: async () => ({ baseUrl: mock.url, password: 'pw', version: '1.19.0', pid: null, stop: async () => {} }),
    })
    const chunks = []
    for await (const chunk of delegate.stream(turnOptions, await toPiContext(turnOptions))) chunks.push(chunk)
    assert.deepEqual(chunks, [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'delegated answer' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'delegated answer' } },
      { type: 'usage', usage: { inputTokens: 9, outputTokens: 6 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    await delegate.dispose()
  } finally {
    await mock.close()
    await cleanup()
  }
})

test('OpencodeDelegate.ready seeds the credential from a temp HOME and reports true', async () => {
  const mock = await mockOpencode()
  const { dir, cleanup } = await tempHome()
  try {
    const authDir = join(dir, '.local', 'share', 'opencode')
    await mkdir(authDir, { recursive: true })
    await writeFile(join(authDir, 'auth.json'), JSON.stringify({ opencode: { key: 'oc_sk_x' }, other: { key: 'no' } }))
    const delegate = new OpencodeDelegate({
      dataDir: join(dir, 'dd'),
      home: dir,
      env: {},
      connect: async () => ({ baseUrl: mock.url, password: 'pw', version: '1.19.0', pid: null, stop: async () => {} }),
    })
    assert.equal(await delegate.ready(), true, 'seeded credential means the delegate can arm')
    // And the seeded file carries ONLY the opencode entry.
    const seeded = JSON.parse(await readFile(join(dir, 'dd', 'opencode', 'data', 'opencode', 'auth.json'), 'utf8'))
    assert.deepEqual(seeded, { opencode: { key: 'oc_sk_x' } })
    await delegate.dispose()
  } finally {
    await mock.close()
    await cleanup()
  }
})

test('OpencodeDelegate.ready is false without any opencode credential', async () => {
  const { dir, cleanup } = await tempHome()
  try {
    const delegate = new OpencodeDelegate({ dataDir: join(dir, 'dd'), home: dir, env: {} })
    assert.equal(await delegate.ready(), false, 'no credential anywhere -> delegate stays disarmed')
    await delegate.dispose()
  } finally {
    await cleanup()
  }
})
