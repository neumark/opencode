import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "path"
import { Cgroup } from "../../src/util/cgroup.js"

const linux = process.platform === "linux"

describe("util.cgroup", () => {
  const dirs: string[] = []
  const make = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-cgroup-"))
    dirs.push(dir)
    return dir
  }

  afterEach(() => {
    delete process.env["FC_AGENT_CG"]
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test("base resolves the FC_AGENT_CG override", () => {
    const dir = make()
    process.env["FC_AGENT_CG"] = dir
    expect(Cgroup.base()).toBe(linux ? dir : undefined)
  })

  test("base is undefined when the cgroup directory is missing", () => {
    process.env["FC_AGENT_CG"] = path.join(tmpdir(), "opencode-cgroup-missing")
    expect(Cgroup.base()).toBeUndefined()
  })

  test("oomKilled matches the command's leaf by pid", () => {
    const dir = make()
    process.env["FC_AGENT_CG"] = dir
    mkdirSync(path.join(dir, "fc-cmd-4242-7"))
    const events = path.join(dir, "fc-cmd-4242-7", "memory.events")
    writeFileSync(events, "low 0\nhigh 12\nmax 0\noom 0\noom_kill 0\n")
    expect(Cgroup.oomKilled(4242)).toBe(false)
    writeFileSync(events, "low 0\nhigh 12\nmax 3\noom 1\noom_kill 2\n")
    expect(Cgroup.oomKilled(4242)).toBe(linux)
    expect(Cgroup.oomKilled(9999)).toBe(false)
  })

  test("oomKilled is a silent no-op without the base directory", () => {
    process.env["FC_AGENT_CG"] = path.join(tmpdir(), "opencode-cgroup-missing")
    expect(Cgroup.oomKilled(4242)).toBe(false)
  })
})
