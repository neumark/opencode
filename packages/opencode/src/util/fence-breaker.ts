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
//   closed   — commands run; every fence kill is counted (with window decay)
//              and counted in the annotation ("fence-kill #N of this session")
//   open     — >= maxKills within windowMs: shell execution in this session
//              is REFUSED as a normal tool result (not a defect — the model
//              must be able to read it and change strategy) until cooldownMs
//   half-open — cooldown elapsed: exactly one probe attempt is allowed; a
//              clean exit (any result that is not a fence kill) resets the
//              breaker, a fence kill re-trips it instantly
//
// OPENCODE_FENCE_BREAKER="N,windowSeconds,cooldownSeconds" (defaults
// "3,3600,600"); "0" or "off" disables the refusal (annotations keep
// counting). Inert outside fc-opencode guests: kills are only recorded when
// the cgroup fences exist (Cgroup.oomKilled detects them), so elsewhere the
// breaker never trips.

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
  probing: boolean
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
  if (typeof rawKills !== "number" || !Number.isFinite(rawKills) || rawKills < 1) return undefined
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

// Pre-spawn gate for a session's shell commands. Marks the half-open probe
// when the cooldown has elapsed (exactly one attempt flows through; the
// caller reports back via recordSuccess / recordKill).
export function gate(sessionID: string, now: number = Date.now()): Refusal {
  const cfg = config()
  const windowMs = cfg?.windowMs ?? DEFAULTS.windowMs
  const item = state.get(sessionID)
  const kills = counts(item, windowMs, now)
  if (!cfg || !item) {
    return { refused: false, opensAtKills: cfg?.maxKills ?? DEFAULTS.maxKills, kills, retryInMs: 0 }
  }
  if (now < item.openUntil) {
    return { refused: true, opensAtKills: cfg.maxKills, kills, retryInMs: item.openUntil - now }
  }
  // cooldown elapsed: half-open — allow exactly one probe
  item.probing = true
  return { refused: false, opensAtKills: cfg.maxKills, kills, retryInMs: 0 }
}

// Is the breaker currently refusing? (gate() both checks and marks the probe;
// this is the pure read for callers that must not mutate.)
export function refusing(sessionID: string, now: number = Date.now()): Refusal {
  const cfg = config()
  const windowMs = cfg?.windowMs ?? DEFAULTS.windowMs
  const item = state.get(sessionID)
  const kills = counts(item, windowMs, now)
  const refused = Boolean(cfg && item && now < item.openUntil)
  return {
    refused,
    opensAtKills: cfg?.maxKills ?? DEFAULTS.maxKills,
    kills,
    retryInMs: refused ? item!.openUntil - now : 0,
  }
}

// A fence kill was detected for the session: count it (with window decay),
// trip or re-trip the breaker, clear the half-open probe. Returns the
// in-window kill count for the annotation ("fence-kill #N").
export function recordKill(sessionID: string, now: number = Date.now()): number {
  const cfg = config()
  let item = state.get(sessionID)
  if (!item) {
    item = { killTs: [], openUntil: 0, probing: false }
    state.set(sessionID, item)
  }
  item.probing = false
  item.killTs.push(now)
  const windowMs = cfg?.windowMs ?? DEFAULTS.windowMs
  item.killTs = item.killTs.filter((ts) => now - ts <= windowMs)
  if (cfg && item.killTs.length >= cfg.maxKills) item.openUntil = now + cfg.cooldownMs
  return item.killTs.length
}

// A shell command completed without a fence kill: if this was the half-open
// probe, the workload changed — reset the breaker entirely.
export function recordSuccess(sessionID: string): void {
  const item = state.get(sessionID)
  if (item?.probing) state.delete(sessionID)
}

// test seam: clear state and memoized settings
export function _reset(): void {
  state.clear()
  settings = null
}

export * as FenceBreaker from "./fence-breaker"
