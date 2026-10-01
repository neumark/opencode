import { afterEach, describe, expect, test } from "bun:test"
import { FenceBreaker } from "@/util/fence-breaker"

describe("util.fence-breaker", () => {
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

  test("half-open after cooldown: one probe allowed, clean exit resets", () => {
    const t0 = 1_000_000
    for (let i = 0; i < 3; i++) FenceBreaker.recordKill("s1", t0 + i)
    // openUntil = last kill (t0+2) + cooldown (600s)
    const after = t0 + 600_003
    const probe = FenceBreaker.gate("s1", after)
    expect(probe.refused).toBe(false) // the one allowed probe
    FenceBreaker.recordSuccess("s1") // probe completed without a fence kill
    const next = FenceBreaker.gate("s1", after + 1000)
    expect(next.refused).toBe(false)
    expect(next.kills).toBe(0) // fully reset
  })

  test("half-open probe killed re-trips instantly", () => {
    const t0 = 1_000_000
    for (let i = 0; i < 3; i++) FenceBreaker.recordKill("s1", t0 + i)
    expect(FenceBreaker.gate("s1", t0 + 600_003).refused).toBe(false) // probe
    const kills = FenceBreaker.recordKill("s1", t0 + 601_000)
    expect(kills).toBe(4) // 3 original (still in window) + the probe kill
    const g = FenceBreaker.gate("s1", t0 + 601_500)
    expect(g.refused).toBe(true)
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

  test('"0", "off" and unset-disabled refusals never refuse but still count', () => {
    for (const value of ["0", "off", ""]) {
      process.env["OPENCODE_FENCE_BREAKER"] = value
      FenceBreaker._reset()
      const t0 = 1_000_000
      for (let i = 0; i < 5; i++) FenceBreaker.recordKill("s1", t0 + i)
      expect(FenceBreaker.gate("s1", t0 + 10).refused).toBe(false)
    }
    // invalid values disable too
    process.env["OPENCODE_FENCE_BREAKER"] = "nope"
    FenceBreaker._reset()
    FenceBreaker.recordKill("s1", 1)
    expect(FenceBreaker.gate("s1", 2).refused).toBe(false)
  })

  test("recordSuccess without a probe does not reset kills", () => {
    const t0 = 1_000_000
    FenceBreaker.recordKill("s1", t0)
    FenceBreaker.recordSuccess("s1") // not a half-open probe: no reset
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
