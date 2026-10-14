/**
 * Periodic health probe — the loop docs/ip-pool.md §4.3 promises but the code
 * never had.
 *
 * The doc's trigger table lists a periodic pass over "cooled-down + never-probed
 * + suspect" exits (default 10min), and §4.5 leans on it in several places
 * ("the periodic probe retries when the expiry", "let periodic probing
 * revisit"). Nothing called `probeAll()` on a timer: the only intervals in the
 * runtime were the free-source refill and the subscription pull. Consequences
 * observed live (2026-10-13):
 *
 *  - a subscription node whose smoke failed at admission stayed
 *    `exitIP: '' / latencyMs: 0` FOREVER, because the subscription refresh
 *    filters `!pool.has(address)` and so never re-examined a node already in
 *    the table;
 *  - a 429-cooldown exit was never re-checked after the cooldown expired, so
 *    its facts and health only ever changed if a real request happened to hit
 *    it;
 *  - 'dead' manual/subscription exits (disable-only, never evicted) had no
 *    route back into service at all.
 *
 * This scheduler closes that gap. It is deliberately conservative: one shared
 * interval, never overlapping rounds, and a per-round cap, because every probe
 * spends anonymous-lane quota (§4.1) — the loop must stay cheaper than the
 * traffic it protects.
 */

import type { ExitPool } from './pool.ts'

export interface PeriodicProbeOptions {
  /** Tick interval (docs §4.6 probeIntervalMs, default 10min). */
  intervalMs?: number
  /** Most exits to re-probe per round (quota guard, default 20). */
  maxPerRound?: number
  /** Clock seam for tests. */
  now?: () => number
}

/** Which exits a round should revisit, in priority order (docs §4.3). */
export interface ProbeCandidate {
  id: string
  reason: 'cooled' | 'never-probed' | 'dead-retry' | 'stale'
}

export class PeriodicProber {
  readonly #pool: ExitPool
  readonly #enqueue: (exitId: string) => Promise<unknown>
  #intervalMs: number
  #maxPerRound: number
  #now: () => number
  #timer: NodeJS.Timeout | null = null
  #running = false
  #stopped = false
  #lastRunAt = 0
  #lastQueued = 0

  constructor(
    pool: ExitPool,
    enqueue: (exitId: string) => Promise<unknown>,
    options: PeriodicProbeOptions = {},
  ) {
    this.#pool = pool
    this.#enqueue = enqueue
    this.#intervalMs = options.intervalMs ?? 10 * 60_000
    this.#maxPerRound = options.maxPerRound ?? 20
    this.#now = options.now ?? Date.now
  }

  get stats(): { running: boolean; lastRunAt: number; lastQueued: number } {
    return { running: this.#running, lastRunAt: this.#lastRunAt, lastQueued: this.#lastQueued }
  }

  /** Live re-apply of the tick interval (settings page, §5.1). */
  setIntervalMs(ms: number): void {
    const next = Math.max(60_000, ms)
    if (next === this.#intervalMs) return
    this.#intervalMs = next
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = setInterval(() => void this.tick(), this.#intervalMs)
      this.#timer.unref?.()
    }
  }

  start(): void {
    if (this.#timer !== null || this.#stopped) return
    this.#timer = setInterval(() => void this.tick(), this.#intervalMs)
    this.#timer.unref?.()
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  /**
   * Exits worth re-probing right now, most-degraded first. Pure read of pool
   * state, so the selection is unit-testable without timers.
   */
  select(now = this.#now()): ProbeCandidate[] {
    const out: ProbeCandidate[] = []
    for (const entry of this.#pool.list()) {
      const health = entry.health
      // A probe already in flight for this exit owns it (per-exit serial, §4.1).
      if (health.inflight) continue
      if (health.state === 'dead') {
        // dead retry (docs §4.6 deadRetryMs): dead exits get another chance;
        // manual/subscription ones are disable-only and would otherwise never
        // come back.
        out.push({ id: entry.id, reason: 'dead-retry' })
        continue
      }
      if (health.cooldownUntil > now) continue // still cooling: probing now wastes quota
      if (health.cooldownUntil !== 0) {
        // cooldown just expired -> re-measure instead of trusting stale facts
        out.push({ id: entry.id, reason: 'cooled' })
        continue
      }
      if (health.state === 'unknown' || entry.latencyMs <= 0) {
        out.push({ id: entry.id, reason: 'never-probed' })
        continue
      }
      const banSuspect = entry.bans.some((b) => b.ban.state === 'suspect')
      if (banSuspect) {
        out.push({ id: entry.id, reason: 'stale' })
      }
    }
    return out.slice(0, this.#maxPerRound)
  }

  /** One round; skipped while the previous one is still draining. */
  async tick(): Promise<void> {
    if (this.#running || this.#stopped) return
    this.#running = true
    try {
      const candidates = this.select()
      this.#lastRunAt = this.#now()
      this.#lastQueued = candidates.length
      for (const candidate of candidates) {
        await this.#enqueue(candidate.id)
      }
    } finally {
      this.#running = false
    }
  }
}
