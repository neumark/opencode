import type { ChildProcessWithoutNullStreams } from "child_process"
import path from "path"
import { Cgroup } from "@/util/cgroup"
import { Process } from "@/util/process"

type Child = Process.Child & ChildProcessWithoutNullStreams

export function spawn(cmd: string, args: string[], opts?: Process.Options): Child
export function spawn(cmd: string, opts?: Process.Options): Child
export function spawn(cmd: string, argsOrOpts?: string[] | Process.Options, opts?: Process.Options) {
  const args = Array.isArray(argsOrOpts) ? [...argsOrOpts] : []
  const cfg = Array.isArray(argsOrOpts) ? opts : argsOrOpts
  const proc = Process.spawn([cmd, ...args], {
    ...cfg,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as Child

  if (!proc.stdin || !proc.stdout || !proc.stderr) throw new Error("Process output not available")

  // fc-opencode guests: confine the server to its own fenced cgroup leaf so a
  // bloated language server cannot eat the daemon's budget. No-op elsewhere.
  if (proc.pid) Cgroup.fenceLsp(proc.pid, cmd)

  return proc
}
