// Circuit breaker for fence-killed agent commands (fc-opencode guests). The
// per-command memory fences deterministically kill runaway command trees —
// but nothing stopped the agent from retrying the same ballooning command
// forever: one session was measured in a 55-oom_kill retry cycle, each climb
// wedging the VM in reclaim churn while the killed run's output grew the
// transcript (and with it the per-step context re-assembly) without bound.
// The advisory annotation alone demonstrably does not stop the cycle; the
// breaker makes refusal deterministic.
//
// State machine, per session, in-memory (kills are live-behavior signals; a
// daemon restart legitimately re-arms):
//   closed    — commands run; every fence kill is counted (with window decay)
//               and counted in the annotation ("fence-kill #N of this
//               session"). A clean completion does NOT reset the counts:
//               the real-world cycle interleaves cheap clean commands
//               between balloon attempts (ls/cat/tail between retries), so
//               only window decay and a concluded probe clear history.
//   open      — >= maxKills within windowMs: shell execution in this session
//               is REFUSED as a normal tool result (not a defect — the model
//               must be able to read it and change strategy) until cooldownMs.
//               A kill recorded while open re-arms the cooldown (in-flight
//               commands started before the trip can still die).
//   half-open — cooldown elapsed: ONE probe claim at a time (probeAt
//               timestamp; concurrent commands while a probe is in flight
//               are refused for a short retry). A clean exit (a result that
//               is neither a fence kill, a timeout, nor a user abort)
//               concludes the probe and resets the breaker entirely; a
//               fence kill re-trips it unconditionally — the cooldown
//               elapsed but the workload still balloons, window arithmetic
//               does not get a vote.
//
// Detection limits (fail-open, by design): kills are counted only when the
// shell tool's exit race observes them (Cgroup.oomKilled on the dead pid's
// leaf). A kill masked by the tool's own timeout/abort race, an exit-137
// without leaf evidence, or a leaf pruned before the check undercounts — the
// breaker errs toward running. Entries for abandoned sessions persist until
// a probe concludes or the daemon restarts (a few hundred bytes each).
//
// OPENCODE_FENCE_BREAKER="N,windowSeconds,cooldownSeconds" (defaults
// "3,3600,600"); "0" or "off" disables the refusal (annotations keep
// counting). Garbage values log once and fail SAFE to the defaults (a typo
// disabling the breaker is the worse failure). Inert outside fc-opencode
// guests: kills are only recorded when the cgroup fences exist
// (Cgroup.oomKilled detects them), so elsewhere the breaker never trips.

const DEFAULTS = { maxKills: 3, windowMs: 3600_000, cooldownMs: 600_000 }

export interface Refusal {
  /** true when shell execution in this session must be refused right now */
  readonly refused: boolean
  /** fence kills in the current window (for annotations) */
  readonly kills: number
  /** windowed kill count at which the breaker trips */
  readonly opensAtKills: number
  /** ms until the cooldown elapses and one probe attempt is allowed (0 when not refusing) */
  readonly retryInMs: number
}

interface Entry {
  killTs: number[]
  openUntil: number
  /** timestamp of the in-flight half-open probe claim; 0 = none */
  probeAt: number
}

interface Settings {
  maxKills: number
  windowMs: number
  cooldownMs: number
}

const state = new Map<string, Entry>()

const parseSettings = (): Settings | undefined => {
  const raw = process.env["OPENCODE_FENCE_BREAKER"]
  if (raw === undefined) return { ...DEFAULTS }
  const value = raw.trim().toLowerCase()
  if (value === "" || value === "off" || value === "0") return undefined
  const [rawKills, rawWindow, rawCooldown] = value.split(",").map((item) => Number(item.trim()))
  if (typeof rawKills !== "number" || !Number.isFinite(rawKills) || rawKills < 1) {
    // garbage (a typo) fails SAFE to defaults, never silently to "off"
    console.error(`[fence-breaker] ignoring invalid OPENCODE_FENCE_BREAKER=${raw!} — using defaults ${DEFAULTS.maxKills},${DEFAULTS.windowMs / 1000},${DEFAULTS.cooldownMs / 1000}`)
    return { ...DEFAULTS }
  }
  const seconds = (given: number | undefined, fallback: number) => {
    const value = typeof given === "number" && Number.isFinite(given) && given > 0 ? given : fallback
    return Math.floor(value * 1000)
  }
  return {
    maxKills: Math.floor(rawKills),
    windowMs: seconds(rawWindow, DEFAULTS.windowMs / 1000),
    cooldownMs: seconds(rawCooldown, DEFAULTS.cooldownMs / 1000),
  }
}

let settings: Settings | undefined | null = null
const config = (): Settings | undefined => {
  if (settings === null) settings = parseSettings()
  return settings
}

const counts = (item: Entry | undefined, windowMs: number, now: number) =>
  item ? item.killTs.filter((ts) => now - ts <= windowMs).length : 0

// Pre-spawn gate for a session's shell commands. When the cooldown has
// elapsed it claims the half-open probe (one at a time; concurrent
// commands while a claim is in flight get a short refusal). The claim is
// concluded by recordSuccess (clean exit) or recordKill (re-trip).
export function gate(sessionID: string, now: number = Date.now()): Refusal {
  const cfg = config()
  const windowMs = cfg?.windowMs ?? DEFAULTS.windowMs
  const item = state.get(sessionID)
  const kills = counts(item, windowMs, now)
  if (!cfg) return { refused: false, kills, opensAtKills: DEFAULTS.maxKills, retryInMs: 0 }
  if (!item) return { refused: false, kills, opensAtKills: cfg.maxKills, retryInMs: 0 }
  // state hygiene: a never-opened entry with nothing left in the window
  if (item.openUntil === 0 && item.probeAt === 0 && kills === 0) {
    state.delete(sessionID)
    return { refused: false, kills: 0, opensAtKills: cfg.maxKills, retryInMs: 0 }
  }
  if (now < item.openUntil) {
    return { refused: true, kills, opensAtKills: cfg.maxKills, retryInMs: item.openUntil - now }
  }
  if (item.openUntil === 0) {
    // closed, never opened: NO probe claim — a phantom claim here would let
    // recordSuccess erase sub-threshold history on any clean completion
    // (the real-world cycle interleaves cheap clean commands between
    // balloon attempts; only window decay clears a closed entry's counts)
    return { refused: false, kills, opensAtKills: cfg.maxKills, retryInMs: 0 }
  }
  // open with the cooldown elapsed: claim the single in-flight probe —
  // concurrent commands while a claim is in flight get a short refusal
  if (item.probeAt > 0) {
    return { refused: true, kills, opensAtKills: cfg.maxKills, retryInMs: 2000 }
  }
  item.probeAt = now
  return { refused: false, kills, opensAtKills: cfg.maxKills, retryInMs: 0 }
}

// Is the breaker currently refusing? (gate() checks AND claims; this is the
// pure read for callers that must not mutate, e.g. the kill annotation.)
export function refusing(sessionID: string, now: number = Date.now()): Refusal {
  const cfg = config()
  const windowMs = cfg?.windowMs ?? DEFAULTS.windowMs
  const item = state.get(sessionID)
  const kills = counts(item, windowMs, now)
  const refused = Boolean(cfg && item && now < item.openUntil)
  return {
    refused,
    kills,
    opensAtKills: cfg?.maxKills ?? DEFAULTS.maxKills,
    retryInMs: refused ? item!.openUntil - now : 0,
  }
}

// A fence kill was detected for the session: count it (with window decay),
// conclude any probe claim by re-tripping unconditionally (the cooldown
// elapsed but the workload still balloons — window arithmetic does not get a
// vote), or trip normally at the threshold. Returns the in-window kill count
// for the annotation ("fence-kill #N").
export function recordKill(sessionID: string, now: number = Date.now()): number {
  const cfg = config()
  let item = state.get(sessionID)
  if (!item) {
    item = { killTs: [], openUntil: 0, probeAt: 0 }
    state.set(sessionID, item)
  }
  const probing = item.probeAt > 0
  item.probeAt = 0
  item.killTs.push(now)
  const windowMs = cfg?.windowMs ?? DEFAULTS.windowMs
  item.killTs = item.killTs.filter((ts) => now - ts <= windowMs)
  if (cfg && (probing || item.killTs.length >= cfg.maxKills)) item.openUntil = now + cfg.cooldownMs
  return item.killTs.length
}

// A shell command completed without a fence kill (the caller excludes
// timeouts and user aborts — they conclude nothing): if this was the
// half-open probe, the workload changed — reset the breaker entirely.
export function recordSuccess(sessionID: string): void {
  const item = state.get(sessionID)
  if (item && item.probeAt > 0) state.delete(sessionID)
}

// test seam: clear state and memoized settings
export function _reset(): void {
  state.clear()
  settings = null
}

export * as FenceBreaker from "./fence-breaker"
