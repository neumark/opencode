import { afterEach, describe, expect, mock } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { SyncPaths } from "../../src/server/routes/instance/httpapi/groups/sync"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Session } from "@/session/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
const context = Context.empty() as Context.Context<unknown>
const it = testEffect(Layer.mergeAll(LayerNode.compile(Session.node), httpApiLayer))

afterEach(async () => {
  mock.restore()
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("sync HttpApi", () => {
  it.instance(
    "serves sync routes",
    () =>
      Effect.gen(function* () {
        Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
        const tmp = yield* TestInstance
        const headers = { "x-opencode-directory": tmp.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "sync" })

        const started = yield* requestInDirectory(SyncPaths.start, tmp.directory, { method: "POST", headers })
        expect(started.status).toBe(200)
        expect(yield* started.json).toBe(true)

        const history = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        expect(history.status).toBe(200)
        const rows = (yield* history.json) as Array<{
          id: string
          aggregate_id: string
          seq: number
          type: string
          data: Record<string, unknown>
        }>
        expect(rows.map((row) => row.aggregate_id)).toContain(session.id)

        const replayed = yield* requestInDirectory(SyncPaths.replay, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            directory: tmp.directory,
            events: rows
              .filter((row) => row.aggregate_id === session.id)
              .map((row) => ({
                id: row.id,
                aggregateID: row.aggregate_id,
                seq: row.seq,
                type: row.type,
                data: row.data,
              })),
          }),
        })
        expect(replayed.status).toBe(200)
        expect(yield* replayed.json).toEqual({ sessionID: session.id })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "validates seq values",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-opencode-directory": tmp.directory, "content-type": "application/json" }
        const cases = [
          {
            path: SyncPaths.history,
            body: { aggregate: -1 },
          },
          {
            path: SyncPaths.history,
            body: { aggregate: 1.5 },
          },
          {
            path: SyncPaths.replay,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: -1, type: "session.created", data: {} }],
            },
          },
          {
            path: SyncPaths.replay,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: 1.5, type: "session.created", data: {} }],
            },
          },
          {
            path: SyncPaths.replay,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: 0, type: "session.created", data: {} }],
            },
          },
        ]

        for (const item of cases) {
          const response = yield* requestInDirectory(item.path, tmp.directory, {
            method: "POST",
            headers,
            body: JSON.stringify(item.body),
          })
          expect(response.status).toBe(400)
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "history watermarks skip known aggregates and return only newer events",
    () =>
      Effect.gen(function* () {
        Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
        const tmp = yield* TestInstance
        const headers = { "x-opencode-directory": tmp.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "watermark" })
        const sessionB = yield* Session.use.create({ title: "watermark-b" })
        // a second durable event on the same aggregate (session.updated)
        const renamed = yield* requestInDirectory(`/session/${session.id}`, tmp.directory, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ title: "watermark-2" }),
        })
        expect(renamed.status).toBe(200)

        const all = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        expect(all.status).toBe(200)
        const rows = (yield* all.json) as Array<{ aggregate_id: string; seq: number }>
        const own = rows.filter((row) => row.aggregate_id === session.id)
        // pins the PATCH-written second durable event: without it the
        // mid-watermark check below degenerates into a vacuous zero-watermark
        expect(own.length).toBeGreaterThanOrEqual(2)
        const lastSeq = Math.max(...own.map((row) => row.seq))
        const seqs = rows.map((row) => row.seq)
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b)) // ordered by seq

        // a watermark at the aggregate's last seq skips it entirely
        const caughtUp = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ [session.id]: lastSeq }),
        })
        expect(caughtUp.status).toBe(200)
        const remaining = (yield* caughtUp.json) as Array<{ aggregate_id: string }>
        expect(remaining.map((row) => row.aggregate_id)).not.toContain(session.id)
        expect(remaining.map((row) => row.aggregate_id)).toContain(sessionB.id)

        // a watermark for an aggregate that does not exist is silently ignored
        const ghost = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ "ses_nonexistent-ghost": lastSeq }),
        })
        expect(ghost.status).toBe(200)
        expect(((yield* ghost.json) as Array<{ aggregate_id: string }>).map((row) => row.aggregate_id)).toContain(
          sessionB.id,
        )

        // watermark 0 is valid (NonNegativeInt) and excludes nothing
        const zero = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ [session.id]: 0 }),
        })
        expect(zero.status).toBe(200)
        expect(((yield* zero.json) as Array<{ aggregate_id: string }>).map((row) => row.aggregate_id)).toContain(
          session.id,
        )

        // an unknown aggregate keeps its full history, a watermarked one only newer events
        const midSeq = Math.max(0, lastSeq - 1)
        const partial = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ [session.id]: midSeq }),
        })
        expect(partial.status).toBe(200)
        const newer = ((yield* partial.json) as Array<{ aggregate_id: string; seq: number }>).filter(
          (row) => row.aggregate_id === session.id,
        )
        expect(newer.map((row) => row.seq)).toEqual([lastSeq])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance.skip(
    "returns structured validation errors",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* Effect.promise(() =>
          HttpApiApp.webHandler().handler(
            new Request(`http://localhost${SyncPaths.history}`, {
              method: "POST",
              headers: { "x-opencode-directory": tmp.directory, "content-type": "application/json" },
              body: JSON.stringify({ aggregate: -1 }),
            }),
            context,
          ),
        )

        expect(response.status).toBe(400)
        expect(response.headers.get("content-type") ?? "").toContain("application/json")
        const body = (yield* Effect.promise(() => response.json())) as Record<string, unknown>
        expect(body.success).toBe(false)
        expect(Array.isArray(body.error) || Array.isArray(body.errors)).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
