import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { OpenCode } from "@opencode/client"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { initRepo } from "../../core/test/fixture/git"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

const setup = Effect.gen(function* () {
  const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-session-workspace-default-")))
  const repo = path.join(tmp.path, "repo")
  const config = path.join(tmp.path, "config")
  const destination = path.join(tmp.path, "worktrees")
  yield* Effect.promise(async () => {
    await fs.mkdir(repo)
    await initRepo(repo)
    await fs.mkdir(config)
    await Bun.write(path.join(config, "opencode.json"), JSON.stringify({ worktree: { directory: destination } }))
    await Bun.write(
      path.join(repo, "opencode.json"),
      JSON.stringify({
        plugins: [
          { package: path.join(import.meta.dir, "fixture/worktree-plugin"), options: { strategy: "test-copy" } },
        ],
      }),
    )
  })
  return { repo, config, destination }
})

const withDefaultWorkspace = (strategy: string | undefined) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const prior = process.env.OPENCODE_NEW_SESSION_WORKSPACE
      if (strategy === undefined) delete process.env.OPENCODE_NEW_SESSION_WORKSPACE
      else process.env.OPENCODE_NEW_SESSION_WORKSPACE = strategy
      return () => {
        if (prior === undefined) delete process.env.OPENCODE_NEW_SESSION_WORKSPACE
        else process.env.OPENCODE_NEW_SESSION_WORKSPACE = prior
      }
    }),
    (restore) => Effect.sync(restore),
  )

it.live(
  "OPENCODE_NEW_SESSION_WORKSPACE binds new top-level sessions to fresh strategy worktrees",
  () =>
    Effect.gen(function* () {
      yield* withDefaultWorkspace("test-copy")
      const { repo, config, destination } = yield* setup
      const server = yield* startServer(config)
      const api = OpenCode.make({ baseUrl: server.base, headers: server.headers })
      yield* Effect.promise(async () => {
        const first = await api.session.create({ location: { directory: repo } })
        const second = await api.session.create({ location: { directory: repo } })
        // every top-level session gets its own fresh worktree of the default strategy
        expect(first.location.directory).not.toBe(repo)
        expect(first.location.directory.startsWith(destination)).toBe(true)
        expect(second.location.directory).not.toBe(first.location.directory)
        expect(second.projectID).toBe(first.projectID)
        // children share the parent's location natively — no third worktree
        const child = await api.session.create({ parentID: first.id })
        expect(child.location.directory).toBe(first.location.directory)
        const rows = await api.worktree.list({ projectID: first.projectID })
        expect(rows).toContainEqual({ directory: first.location.directory, strategy: "test-copy" })
        expect(rows).toContainEqual({ directory: second.location.directory, strategy: "test-copy" })
      })
    }),
  30_000,
)

it.live("an unregistered strategy degrades to the requested location, never an error", () =>
  Effect.gen(function* () {
    yield* withDefaultWorkspace("no-such-strategy")
    const { repo, config } = yield* setup
    const server = yield* startServer(config)
    const api = OpenCode.make({ baseUrl: server.base, headers: server.headers })
    yield* Effect.promise(async () => {
      const session = await api.session.create({ location: { directory: repo } })
      expect(session.location.directory).toBe(repo)
    })
  }),
)

it.live("without OPENCODE_NEW_SESSION_WORKSPACE sessions land at the requested location", () =>
  Effect.gen(function* () {
    yield* withDefaultWorkspace(undefined)
    const { repo, config } = yield* setup
    const server = yield* startServer(config)
    const api = OpenCode.make({ baseUrl: server.base, headers: server.headers })
    yield* Effect.promise(async () => {
      const session = await api.session.create({ location: { directory: repo } })
      expect(session.location.directory).toBe(repo)
    })
  }),
)
