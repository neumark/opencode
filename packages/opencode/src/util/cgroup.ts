import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs"
import path from "path"

// Integration with the fc-opencode guest cgroup fences: the daemon runs in the
// opencode-serve.service unit cgroup, and a BASH_ENV hook moves every agent
// shell command into a fenced fc-cmd-<pid>-* leaf. Everything here is
// best-effort and inert outside an fc-opencode guest (the base directory
// simply does not exist anywhere else).

const DEFAULT_BASE = "/sys/fs/cgroup/system.slice/opencode-serve.service"

export function base(): string | undefined {
  if (process.platform !== "linux") return undefined
  const dir = process.env["FC_AGENT_CG"] ?? DEFAULT_BASE
  return existsSync(dir) ? dir : undefined
}

// Did the fenced leaf of the command spawned as `pid` report OOM kills? The
// hook names leaves fc-cmd-<shell-pid>-$RANDOM and the spawned shell's pid is
// that shell pid (the nice/ionice wrappers exec, preserving the pid). Leaves
// of OOM-killed trees survive until a later hook invocation prunes them, well
// after this check runs.
export function oomKilled(pid: number): boolean {
  const dir = base()
  if (!dir || !pid) return false
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith(`fc-cmd-${pid}-`)) continue
      if (/^oom_kill [1-9]/m.test(readFileSync(path.join(dir, entry, "memory.events"), "utf8"))) return true
    }
  } catch {}
  return false
}

// Move a freshly spawned LSP server into its own fenced leaf: a runaway
// language server is then killed by its own fence (and lazily respawned by the
// LSP layer) instead of eating the unit's budget alongside the daemon and
// agent commands. No cpu fence: the unit-level CPUQuota caps the total and
// indexing speed is user-visible.
export function fenceLsp(pid: number, cmd: string): void {
  const dir = base()
  if (!dir || !pid) return
  try {
    // Prune leaves of previously exited servers (rmdir succeeds only on
    // empty cgroups, so live servers are untouched).
    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith("fc-lsp-")) continue
      try {
        rmdirSync(path.join(dir, entry))
      } catch {}
    }
    const name = path.basename(cmd).replace(/[^A-Za-z0-9._-]/g, "-")
    const leaf = path.join(dir, `fc-lsp-${name}-${pid}`)
    mkdirSync(leaf)
    try {
      const kb = Number(/^MemTotal:\s+(\d+)/m.exec(readFileSync("/proc/meminfo", "utf8"))?.[1] ?? 0)
      if (kb <= 0) throw new Error("no MemTotal")
      const total = kb * 1024
      writeFileSync(path.join(leaf, "memory.high"), String(Math.floor(total * 0.15)))
      writeFileSync(path.join(leaf, "memory.max"), String(Math.floor(total * 0.2)))
      writeFileSync(path.join(leaf, "memory.swap.max"), String(Math.floor(total * 0.05)))
      writeFileSync(path.join(leaf, "memory.oom.group"), "1")
      writeFileSync(path.join(leaf, "cgroup.procs"), String(pid))
    } catch {
      // Controller not delegated (or the process already exited): drop the
      // leaf and leave the server where it spawned.
      try {
        rmdirSync(leaf)
      } catch {}
    }
  } catch {}
}

export * as Cgroup from "./cgroup"
