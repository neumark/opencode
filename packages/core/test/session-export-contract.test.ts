// Deployment contract: the JSON shape of `opencode session export` and
// `opencode session list` is load-bearing for the fc-opencode fleet's
// tooling (docs/scripts/session-usage.mjs + lib/sessionUsage.mjs consume
// exactly these fields to build the token-usage ledger). The v1 -> v2 port
// silently moved the CLI command (top-level `export` -> `session export`)
// and restructured the payload (`info.role` -> `type`, `info.tokens` ->
// `tokens`, `parts` -> `content`), which took the ledger offline with
// "no API calls in the window" until both sides were re-pinned. This test
// is the fork-side pin: if upstream restructures the export again, this
// fails BEFORE a release ships, and FORK.md's contract list says what to
// update (tooling side) alongside it.
import { afterAll, describe, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { Money } from "@opencode/schema/money"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Agent } from "@opencode/core/agent"
import { AbsolutePath } from "@opencode/core/schema"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { SessionTransfer } from "@opencode/core/session/transfer"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { offlineModels } from "./fixture/models"
import { globalProjectNode } from "./lib/project"
import { testEffect } from "./lib/effect"

const root = await mkdtemp(path.join(tmpdir(), "opencode-export-contract-"))
afterAll(() => rm(root, { recursive: true, force: true }))
const location = Location.Ref.make({ directory: AbsolutePath.make(root) })

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Project.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      SessionTransfer.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
      offlineModels,
    ],
  ),
)

describe("session export deployment contract", () => {
  it.effect("export payload carries the fields the fleet tooling parses", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const transfer = yield* SessionTransfer.Service
      const created = yield* session.create({ location })
      yield* session.prompt({ sessionID: created.id, text: "contract probe", resume: false })

      const assistantMessageID = SessionMessage.ID.create()
      const model = Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") })
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID: created.id,
        assistantMessageID,
        agent: Agent.ID.make("build"),
        model,
        started: 0,
      })
      yield* bus.publish(SessionEvent.Step.Ended, {
        sessionID: created.id,
        assistantMessageID,
        finish: "stop",
        cost: Money.USD.make(0),
        tokens: { input: 6, output: 3, reasoning: 1, cache: { read: 2, write: 1 } },
      })

      const exported = yield* transfer.export({ sessionID: created.id })

      // session-level aggregate
      expect(exported.info.id).toBe(created.id)
      expect(exported.info.tokens).toMatchObject({ input: 6, output: 3, reasoning: 1 })

      const messages = exported.messages

      // per-message record: type (not info.role), tokens and model directly
      // on the entry, content (not parts) — the v2 shape sessionUsage.mjs
      // reads. Every field asserted here is one its parser touches. (User
      // entries are not asserted: their delivery needs live execution, and
      // the ledger parser only reads assistant records.)
      const assistant = messages.find((message) => message.type === "assistant")
      expect(assistant).toBeDefined()
      expect(assistant!.id).toBe(assistantMessageID)
      expect(assistant!.tokens).toEqual({ input: 6, output: 3, reasoning: 1, cache: { read: 2, write: 1 } })
      expect(assistant!.model).toMatchObject({ id: "model", providerID: "provider" })
      // the CLI/HTTP boundary encodes these as epoch millis; the tooling
      // reads time.completed ?? time.created — both must exist
      expect(assistant!.time.created).toBeDefined()
      expect(assistant!.time.completed).toBeDefined()
      expect(Array.isArray(assistant!.content)).toBe(true)
    }),
  )
})
