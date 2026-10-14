/**
 * The unified probe verdict (src/pool/probe-verdict.ts) and the failure
 * classification that feeds it.
 *
 * The live regression these lock down (2026-10-14): a 726-node subscription
 * pool had 703 exits sitting at `unknown` with zero facts. They had all been
 * probed; the subscription path simply never wrote anything on failure, so a
 * verified-dead link was indistinguishable from a never-probed node — on the
 * settings card AND in the rotation, since `isUsable` treats `unknown` as
 * usable.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { ExitPool, type ExitNode } from '../src/pool/pool.ts'
import { applyProbeVerdict } from '../src/pool/probe-verdict.ts'
import type { AdmissionResult } from '../src/pool/admission.ts'

let clock = 5_000_000
const now = () => clock

function pool(options: ConstructorParameters<typeof ExitPool>[0] = {}) {
  return new ExitPool({ now, ...options })
}

function node(overrides: Partial<ExitNode> = {}): ExitNode {
  return {
    id: 'sub:1',
    protocol: 'socks5',
    source: 'subscription',
    pinned: false,
    exitIP: '',
    exitLocation: '',
    latencyMs: 0,
    quality: 'C',
    addedAt: 0,
    ...overrides,
  }
}

/** An `admitTrusted` degraded verdict, as the subscription path receives it. */
function degraded(failure: AdmissionResult['failure'], reason = ''): AdmissionResult {
  return { admitted: true, degraded: true, failure, reason }
}

// -- the core regression: a dead link must stop looking unprobed ---------------

test('verdict: a transport failure marks the exit dead instead of leaving it unknown', () => {
  const p = pool()
  p.add(node({ id: 'sub:1' }))
  assert.equal(p.list()[0]!.health.state, 'unknown')

  const applied = applyProbeVerdict(p, 'sub:1', degraded('transport', 'SOCKS5 connection timeout'), {
    source: 'subscription',
    model: 'space-bunny-free',
  })

  assert.equal(applied, 'dead')
  const health = p.list()[0]!.health
  assert.equal(health.state, 'dead')
  assert.equal(health.lastProbeFailure, 'transport')
  assert.equal(health.lastProbeReason, 'SOCKS5 connection timeout')
  // ...and it is out of the rotation, which is the point.
  assert.equal(p.isUsable('sub:1', 'space-bunny-free'), false)
})

test('verdict: only the transport class strikes dead — every answering class does not', () => {
  const answering = ['refused', 'server-error', 'geo-blocked', 'slow', 'malformed'] as const
  for (const failure of answering) {
    const p = pool()
    p.add(node({ id: 'sub:1' }))
    applyProbeVerdict(p, 'sub:1', degraded(failure, failure), { source: 'subscription', model: 'm' })
    const health = p.list()[0]!.health
    assert.notEqual(health.state, 'dead', `${failure} must not strike the exit dead`)
    // but the failure IS recorded, so the card can explain itself
    assert.equal(health.lastProbeFailure, failure)
    // and a live exit stays usable for a model it was never banned on
    assert.equal(p.isUsable('sub:1', 'other-model'), true)
  }
})

// -- per-class bookkeeping ------------------------------------------------------

test('verdict: refused bans the (exit × model) pairing but keeps the exit alive', () => {
  const p = pool({ })
  p.add(node({ id: 'sub:1' }))
  applyProbeVerdict(p, 'sub:1', degraded('refused', 'zen models HTTP 403'), { source: 'subscription', model: 'muse' })
  // one sample = suspect (§4.2 banConfirmations), exit itself never dead
  assert.equal(p.isUsable('sub:1', 'muse'), true)
  assert.equal(p.list()[0]!.health.state, 'unknown')

  // a second consecutive refusal bans the pairing only
  applyProbeVerdict(p, 'sub:1', degraded('refused', 'zen models HTTP 403'), { source: 'subscription', model: 'muse' })
  assert.equal(p.isUsable('sub:1', 'muse'), false)
  assert.equal(p.isUsable('sub:1', 'space-bunny-free'), true, 'other models on the same exit stay usable')
  assert.equal(p.list()[0]!.health.state, 'unknown', 'a refusal never strikes the exit dead')
})

test('verdict: a 429 cooldown leaves the exit alive and clears the stale failure label', () => {
  const p = pool()
  p.add(node({ id: 'sub:1' }))
  applyProbeVerdict(p, 'sub:1', degraded('transport', 'boom'), { source: 'subscription', model: 'm' })
  assert.equal(p.list()[0]!.health.lastProbeFailure, 'transport')

  const applied = applyProbeVerdict(p, 'sub:1', { admitted: true, limited: true, reason: 'zen smoke HTTP 429' }, {
    source: 'subscription',
    model: 'm',
  })
  assert.equal(applied, 'limited')
  const health = p.list()[0]!.health
  assert.equal(health.state, 'ok')
  assert.ok(health.cooldownUntil > now())
  assert.equal(health.lastProbeFailure, '', '429 is a verified-alive verdict; the old failure must not linger')
})

test('verdict: a clean pass is ok and clears the failure record', () => {
  const p = pool()
  p.add(node({ id: 'sub:1', exitIP: '1.1.1.1', latencyMs: 300 }))
  applyProbeVerdict(p, 'sub:1', degraded('transport', 'boom'), { source: 'subscription', model: 'm' })
  assert.equal(p.list()[0]!.health.state, 'dead')

  const applied = applyProbeVerdict(p, 'sub:1', {
    admitted: true,
    node: node({ exitIP: '1.1.1.1', latencyMs: 300 }),
  }, { source: 'subscription', model: 'm' })
  assert.equal(applied, 'ok')
  const health = p.list()[0]!.health
  assert.equal(health.state, 'ok')
  assert.equal(health.lastProbeFailure, '')
  assert.equal(health.deadStrikes, 0)
})

// -- retention stays the ONLY source-dependent rule (docs §3.5) ------------------

test('retention: identical transport failure deads a subscription exit in place but evicts a free one', () => {
  const p = pool()
  p.add(node({ id: 'sub:1', source: 'subscription' }))
  p.add(node({ id: 'free:1', source: 'free', exitIP: '9.9.9.9' }))
  const options = { model: 'm' }

  // The verdict is the SAME for both sources...
  assert.equal(applyProbeVerdict(p, 'sub:1', degraded('transport'), { ...options, source: 'subscription' }), 'dead')
  assert.equal(applyProbeVerdict(p, 'free:1', degraded('transport'), { ...options, source: 'free' }), 'dead')

  // ...only what happens to the row differs.
  assert.equal(p.has('sub:1'), true, 'a subscription exit is disabled in place, never dropped')
  assert.equal(p.list()[0]!.health.state, 'dead')

  // second strike: the free node is evicted (deadEvictions default 2)
  applyProbeVerdict(p, 'free:1', degraded('transport'), { ...options, source: 'free' })
  assert.equal(p.has('free:1'), false, 'a free exit is evicted so its slot can be refilled')
})

test('retention: a pinned exit is never struck dead by a failed probe', () => {
  const p = pool()
  p.add(node({ id: 'pin:1', source: 'manual', pinned: true }))
  const applied = applyProbeVerdict(p, 'pin:1', degraded('transport', 'boom'), {
    source: 'manual',
    model: 'm',
    pinned: true,
  })
  assert.equal(applied, 'unchanged')
  assert.equal(p.list()[0]!.health.state, 'unknown', "the user's own line must not be disabled by a probe")
  assert.equal(p.list()[0]!.health.lastProbeFailure, 'transport', 'but the failure is still on record')
})

// -- the honest default ---------------------------------------------------------

test('verdict: an unclassified failure stays unknown rather than asserting death', () => {
  const p = pool()
  p.add(node({ id: 'sub:1' }))
  const applied = applyProbeVerdict(p, 'sub:1', { admitted: false, reason: 'agent-build: bad uri' }, {
    source: 'subscription',
    model: 'm',
  })
  assert.equal(applied, 'unchanged')
  assert.equal(p.list()[0]!.health.state, 'unknown', 'never assert death from an unclassified failure')
})

test('verdict: a never-probed exit is distinguishable from a probed-and-failed one', () => {
  const p = pool()
  p.add(node({ id: 'never:1', source: 'subscription' }))
  p.add(node({ id: 'failed:1', source: 'subscription' }))
  applyProbeVerdict(p, 'failed:1', degraded('server-error', 'zen models HTTP 500'), { source: 'subscription', model: 'm' })

  const rows = p.list()
  const never = rows.find((r) => r.id === 'never:1')!.health
  const failed = rows.find((r) => r.id === 'failed:1')!.health
  // both are 'unknown' at the state level — the failure record is what the
  // settings card uses to tell them apart (the whole point of this change)
  assert.equal(never.state, 'unknown')
  assert.equal(failed.state, 'unknown')
  assert.equal(never.lastProbeFailure, '')
  assert.equal(failed.lastProbeFailure, 'server-error')
})

// -- the dead-retry loop this feeds (docs §4.3) ---------------------------------

test('a dead subscription exit is re-probed by PeriodicProber and returns on success', () => {
  const p = pool()
  p.add(node({ id: 'sub:1', exitIP: '1.1.1.1', latencyMs: 200 }))
  p.markOk('sub:1')
  applyProbeVerdict(p, 'sub:1', degraded('transport', 'boom'), { source: 'subscription', model: 'm' })
  assert.equal(p.list()[0]!.health.state, 'dead')

  // recovery: a later probe passes and the exit is usable again
  applyProbeVerdict(p, 'sub:1', { admitted: true, node: node({ exitIP: '1.1.1.1', latencyMs: 210 }) }, {
    source: 'subscription',
    model: 'm',
  })
  assert.equal(p.list()[0]!.health.state, 'ok')
  assert.equal(p.isUsable('sub:1', 'm'), true)
})
