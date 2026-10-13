export * as Cgroup from "./cgroup.js"

import { existsSync, readdirSync, readFileSync } from "node:fs"
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
