import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { FenceBreaker } from "@/util/fence-breaker"

describe("util.fence-breaker", () => {
  beforeEach(() => {
    delete process.env["OPENCODE_FENCE_BREAKER"]
    FenceBreaker._reset()
  })

  afterEach(() => {
    delete process.env["OPENCODE_FENCE_BREAKER"]
    FenceBreaker._reset()
  })

  test("closed by default: commands run, kills are counted", () => {
    const t0 = 1_000_000
    expect(FenceBreaker.gate("s1", t0).refused).toBe(false)
    expect(FenceBreaker.recordKill("s1", t0)).toBe(1)
    expect(FenceBreaker.recordKill("s1", t0 + 1000)).toBe(2)
    const g = FenceBreaker.gate("s1", t0 + 2000)
    expect(g.refused).toBe(false)
    expect(g.kills).toBe(2)
    expect(g.opensAtKills).toBe(3) // default 3,3600,600
  })

  // regression (review finding 1): a clean command between kills must NOT
  // reset the count — the real-world cycle interleaves cheap clean commands
  // (ls/cat/tail) between balloon attempts, and gate() marking
  // never-opened entries as probes let recordSuccess erase them
  test("clean commands between kills do not reset the count", () => {
    const t0 = 1_000_000
    FenceBreaker.recordKill("s1", t0)
    FenceBreaker.recordKill("s1", t0 + 1000)
    expect(FenceBreaker.gate("s1", t0 + 2000).refused).toBe(false) // still closed
    FenceBreaker.recordSuccess("s1") // a clean ls between attempts: no probe claim -> no reset
    expect(FenceBreaker.gate("s1", t0 + 3000).kills).toBe(2)
    expect(FenceBreaker.recordKill("s1", t0 + 4000)).toBe(3) // trips
    expect(FenceBreaker.gate("s1", t0 + 5000).refused).toBe(true)
  })

  test("trips at maxKills and refuses for the cooldown", () => {
    const t0 = 1_000_000
    FenceBreaker.recordKill("s1", t0)
    FenceBreaker.recordKill("s1", t0 + 1000)
    const kills = FenceBreaker.recordKill("s1", t0 + 2000)
    expect(kills).toBe(3)
    const g = FenceBreaker.gate("s1", t0 + 3000)
    expect(g.refused).toBe(true)
    expect(g.retryInMs).toBe(600_000 - 1000)
    // still refused mid-cooldown
    expect(FenceBreaker.gate("s1", t0 + 300_000).refused).toBe(true)
  })

  // a kill recorded while open (an in-flight command started before the
  // trip) re-arms the cooldown from the new kill
  test("kill during cooldown extends it", () => {
    const t0 = 1_000_000
    for (let i = 0; i < 3; i++) FenceBreaker.recordKill("s1", t0 + i)
    expect(FenceBreaker.gate("s1", t0 + 1000).refused).toBe(true)
    FenceBreaker.recordKill("s1", t0 + 60_000) // in-flight command dies late
    const g = FenceBreaker.gate("s1", t0 + 61_000)
    expect(g.refused).toBe(true)
    expect(g.retryInMs).toBeGreaterThan(600_000 - 61_000) // re-armed from the late kill
  })

  test("half-open after cooldown: one probe allowed, clean exit resets", () => {
    const t0 = 1_000_000
    for (let i = 0; i < 3; i++) FenceBreaker.recordKill("s1", t0 + i)
    // openUntil = last kill (t0+2) + cooldown (600s)
    const after = t0 + 600_003
    const probe = FenceBreaker.gate("s1", after)
    expect(probe.refused).toBe(false) // the allowed probe claim
    FenceBreaker.recordSuccess("s1") // probe completed without a fence kill
    const next = FenceBreaker.gate("s1", after + 1000)
    expect(next.refused).toBe(false)
    expect(next.kills).toBe(0) // fully reset
  })

  // the probe claim is exclusive: a concurrent command while a claim is in
  // flight is refused with a short retry (review finding 4)
  test("only one concurrent probe claim", () => {
    const t0 = 1_000_000
    for (let i = 0; i < 3; i++) FenceBreaker.recordKill("s1", t0 + i)
    const first = FenceBreaker.gate("s1", t0 + 600_003)
    expect(first.refused).toBe(false)
    const concurrent = FenceBreaker.gate("s1", t0 + 600_010)
    expect(concurrent.refused).toBe(true)
    expect(concurrent.retryInMs).toBeLessThanOrEqual(2000)
    // after the probe concludes, the cooldown elapsed state still gates
    FenceBreaker.recordSuccess("s1") // reset
    expect(FenceBreaker.gate("s1", t0 + 600_020).refused).toBe(false)
  })

  // review finding 5: a probe kill re-trips UNCONDITIONALLY — the cooldown
  // elapsed but the workload still balloons; window arithmetic (all original
  // kills aged out) does not get a vote
  test("probe kill re-trips unconditionally even after window decay", () => {
    const t0 = 1_000_000
    process.env["OPENCODE_FENCE_BREAKER"] = "3,60,600" // window shorter than cooldown
    FenceBreaker._reset()
    for (let i = 0; i < 3; i++) FenceBreaker.recordKill("s1", t0 + i) // trips
    const probe = FenceBreaker.gate("s1", t0 + 600_003) // cooldown elapsed, kills aged out of the 60s window
    expect(probe.refused).toBe(false)
    expect(probe.kills).toBe(0)
    const kills = FenceBreaker.recordKill("s1", t0 + 600_010) // probe dies
    expect(kills).toBe(1) // only itself in window
    const g = FenceBreaker.gate("s1", t0 + 600_020)
    expect(g.refused).toBe(true) // re-tripped regardless
    expect(g.retryInMs).toBeGreaterThan(0)
  })

  test("kills decay outside the window", () => {
    const t0 = 1_000_000
    for (let i = 0; i < 3; i++) FenceBreaker.recordKill("s1", t0 + i) // trips
    const later = t0 + 3_600_100 // window elapsed from the last kill (t0+2), cooldown elapsed
    const g = FenceBreaker.gate("s1", later)
    expect(g.refused).toBe(false)
    expect(g.kills).toBe(0) // all three kills aged out of the window
  })

  // closed entries with nothing left in the window are dropped (state hygiene)
  test("stale closed entries are dropped by the gate", () => {
    const t0 = 1_000_000
    FenceBreaker.recordKill("s1", t0)
    const g = FenceBreaker.gate("s1", t0 + 3_600_100) // aged out, never tripped, no claim
    expect(g.refused).toBe(false)
    expect(g.kills).toBe(0)
    expect(FenceBreaker.refusing("s1", t0 + 3_600_200).kills).toBe(0) // entry gone entirely
  })

  test("settings parse from OPENCODE_FENCE_BREAKER", () => {
    process.env["OPENCODE_FENCE_BREAKER"] = "2,60,30"
    FenceBreaker._reset()
    const t0 = 1_000_000
    FenceBreaker.recordKill("s1", t0)
    expect(FenceBreaker.recordKill("s1", t0 + 1000)).toBe(2)
    expect(FenceBreaker.gate("s1", t0 + 2000).refused).toBe(true)
    expect(FenceBreaker.gate("s1", t0 + 2000).retryInMs).toBe(29_000)
    // a kill 60.5s later ages the first out of the 60s window, the second stays
    expect(FenceBreaker.recordKill("s1", t0 + 60_500)).toBe(2)
  })

  // partial values: kills-only keeps the default window/cooldown
  test("partial settings keep defaults", () => {
    process.env["OPENCODE_FENCE_BREAKER"] = "2,"
    FenceBreaker._reset()
    const t0 = 1_000_000
    FenceBreaker.recordKill("s1", t0)
    expect(FenceBreaker.recordKill("s1", t0 + 1000)).toBe(2)
    expect(FenceBreaker.gate("s1", t0 + 2000).refused).toBe(true)
    expect(FenceBreaker.gate("s1", t0 + 2000).retryInMs).toBe(599_000) // default 600s cooldown
  })

  test('"0", "off" and "" disable refusals but still count', () => {
    for (const value of ["0", "off", ""]) {
      process.env["OPENCODE_FENCE_BREAKER"] = value
      FenceBreaker._reset()
      const t0 = 1_000_000
      for (let i = 0; i < 5; i++) FenceBreaker.recordKill("s1", t0 + i)
      expect(FenceBreaker.gate("s1", t0 + 10).refused).toBe(false)
    }
  })

  // review finding 9: garbage fails SAFE to defaults, never silently to off
  test("invalid values fail safe to defaults", () => {
    for (const value of ["nope", "-1", "1e400,", ",,,"]) {
      process.env["OPENCODE_FENCE_BREAKER"] = value
      FenceBreaker._reset()
      const t0 = 1_000_000
      for (let i = 0; i < 3; i++) FenceBreaker.recordKill("s1", t0 + i)
      expect(FenceBreaker.gate("s1", t0 + 10).refused).toBe(true) // defaults, not disabled
    }
  })

  test("recordSuccess without a probe claim does not reset kills", () => {
    const t0 = 1_000_000
    FenceBreaker.recordKill("s1", t0)
    FenceBreaker.recordSuccess("s1") // no claim in flight: no reset
    expect(FenceBreaker.gate("s1", t0 + 1000).kills).toBe(1)
  })

  test("state is per-session", () => {
    const t0 = 1_000_000
    for (let i = 0; i < 3; i++) FenceBreaker.recordKill("s1", t0 + i)
    expect(FenceBreaker.gate("s1", t0 + 10).refused).toBe(true)
    expect(FenceBreaker.gate("s2", t0 + 10).refused).toBe(false)
    expect(FenceBreaker.refusing("s2", t0 + 10).kills).toBe(0)
  })
})
