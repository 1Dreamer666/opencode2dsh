/**
 * #77 regression, half two: the hoisted-profile layout. A DSH profile
 * (nodeLinker: hoisted) resolves ONE pi-ai copy for the whole profile —
 * 0.87.1 today — so the plugin's raw `provider.streamSimple(context)` call
 * dropped every host tool (the wire carried only the injected gate stubs,
 * with `tool_choice: "none"` as the tell). This test spawns a child process
 * that loads the BUILT plugin with '@earendil-works/pi-ai' redirected to the
 * 0.87.1 copy pinned by the test-only alias devDependency
 * (@opencode2dsh/pi-ai-0.87), drives one request through the real adapter
 * against a local capture server, and asserts host tools and gate stubs
 * COEXIST on the wire.
 *
 * Fails before the fix (wireTools == ["bash","read"], toolChoice "none"),
 * passes after. The repo-pinned-pi-ai half of the regression lives in
 * host-tools-wire.test.ts; the raw-versus-Models trap itself is pinned in
 * pi-ai-models-route.test.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const here = fileURLToPath(new URL('.', import.meta.url))
const registerUrl = new URL('./fixtures/hoisted087-register.mjs', import.meta.url)
const driveUrl = new URL('./fixtures/hoisted087-drive.mjs', import.meta.url)
const libEntry = new URL('../lib/index.js', import.meta.url)

interface HoistedReport {
  piAiVersion: string
  finish: string
  errorMessage: string | null
  requestCount: number
  requests: string[]
  wireTools: string[]
  toolChoice: string | null
}

async function runHoistedDrive(mode: 'with-tools' | 'no-tools'): Promise<HoistedReport> {
  assert.ok(existsSync(libEntry), 'lib/index.js missing — run `pnpm build` first (same convention as client-build.test.ts)')
  // The alias devDependency resolves to the real 0.87.1 package inside the
  // pnpm store; passing its URL to the child lets the redirect hook serve it
  // as the hoisted copy without any node_modules surgery or network.
  let hoistedUrl: string
  try {
    hoistedUrl = import.meta.resolve('@opencode2dsh/pi-ai-0.87')
  } catch (error) {
    throw new Error(`test-only alias '@opencode2dsh/pi-ai-0.87' is not installed (run pnpm install): ${error instanceof Error ? error.message : error}`)
  }
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', registerUrl.href, fileURLToPath(driveUrl), mode],
    {
      cwd: here,
      timeout: 90_000,
      env: { ...process.env, OPENCODE2DSH_PI_AI_HOISTED_URL: hoistedUrl },
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  const line = stdout.trim().split('\n').find((entry) => entry.startsWith('HOISTED087 '))
  assert.ok(line, `child printed no HOISTED087 report; stdout:\n${stdout}`)
  return JSON.parse(line.slice('HOISTED087 '.length)) as HoistedReport
}

test('hoisted pi-ai 0.87.1: host tools reach the wire alongside the gate stubs', async () => {
  const report = await runHoistedDrive('with-tools')
  assert.match(report.piAiVersion, /^0\.87\./, `the child must resolve the hoisted 0.87.1 copy (got ${report.piAiVersion})`)
  assert.equal(report.finish, 'stop', `stream should finish cleanly: ${JSON.stringify(report)}`)
  const chatRequests = report.requests.filter((url) => url.includes('/chat/completions'))
  assert.equal(chatRequests.length, 1, `one chat request, no sibling replay (the local server answers 200): ${JSON.stringify(report.requests)}`)
  // The exact pre-#77 failure was wireTools == ["bash","read"] with
  // tool_choice "none" — three host tools were passed and dropped.
  assert.deepEqual(report.wireTools, ['bash', 'grep', 'pwsh', 'read'])
  assert.notEqual(report.toolChoice, 'none', 'host tools present -> the stubs are callable, not force-disabled')
})

test('hoisted pi-ai 0.87.1: the stub-only gate shape is unchanged when the host passes no tools', async () => {
  const report = await runHoistedDrive('no-tools')
  assert.match(report.piAiVersion, /^0\.87\./)
  assert.deepEqual(report.wireTools, ['bash', 'read'])
  assert.equal(report.toolChoice, 'none', 'no caller tools -> the injected stubs stay uncalled')
})
