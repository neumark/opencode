import { Workspace } from "@/control-plane/workspace"
import * as InstanceState from "@/effect/instance-state"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { asc } from "drizzle-orm"
import { and } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { gt } from "drizzle-orm"
import { Effect, Scope } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { HistoryPayload, ReplayPayload, SessionPayload } from "../groups/sync"

export const syncHandlers = HttpApiBuilder.group(InstanceHttpApi, "sync", (handlers) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace.Service
    const session = yield* Session.Service
    const scope = yield* Scope.Scope
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service

    const start = Effect.fn("SyncHttpApi.start")(function* () {
      yield* workspace
        .startWorkspaceSyncing((yield* InstanceState.context).project.id)
        .pipe(Effect.ignore, Effect.forkIn(scope))
      return true
    })

    const replay = Effect.fn("SyncHttpApi.replay")(function* (ctx: { payload: typeof ReplayPayload.Type }) {
      const payload: EventV2.SerializedEvent[] = ctx.payload.events.map((event) => ({
        id: event.id,
        aggregateID: event.aggregateID,
        seq: event.seq,
        type: event.type,
        data: { ...event.data },
      }))
      const source = payload[0].aggregateID
      yield* Effect.logInfo("sync replay requested", {
        sessionID: source,
        events: payload.length,
        first: payload[0]?.seq,
        last: payload.at(-1)?.seq,
        directory: ctx.payload.directory,
      })
      const ownerID = yield* InstanceState.workspaceID
      yield* events.replayAll(payload, { ownerID, strictOwner: true })
      yield* Effect.logInfo("sync replay complete", {
        sessionID: source,
        events: payload.length,
        first: payload[0]?.seq,
        last: payload.at(-1)?.seq,
      })
      return { sessionID: source }
    })

    const steal = Effect.fn("SyncHttpApi.steal")(function* (ctx: { payload: typeof SessionPayload.Type }) {
      const workspaceID = yield* InstanceState.workspaceID
      if (!workspaceID) return yield* new HttpApiError.BadRequest({})

      yield* session.setWorkspace({ sessionID: ctx.payload.sessionID, workspaceID })

      yield* Effect.logInfo("sync session stolen", { sessionID: ctx.payload.sessionID, workspaceID })

      return { sessionID: ctx.payload.sessionID }
    })

    const history = Effect.fn("SyncHttpApi.history")(function* (ctx: { payload: typeof HistoryPayload.Type }) {
      const exclude = new Map(Object.entries(ctx.payload))
      // Aggregate-scoped reads only. The previous NOT(OR(...)) + global ORDER
      // BY seq shape could not use any index (a negation of OR over composite
      // keys, and no global seq index exists) — every sync poll full-scanned
      // the ENTIRE event table and sorted it through a temp B-tree: O(table)
      // disk reads per call. On a long-lived session whose aggregate holds
      // ~84MB of events that is 84MB of reads per poll, ~once per second per
      // reconnecting client — measured live at 84MB/s sustained on an idle VM
      // (bun:sqlite reads are io_uring-backed: invisible to read(2) accounting
      // and to strace), and the read load starved the very responses those
      // clients were waiting for, so they timed out, reconnected, and polled
      // again: a self-sustaining read spiral that grew superlinearly with the
      // event log. Enumerate aggregates from event_sequence (one row per
      // aggregate, a superset of event's aggregates by FK — selectDistinct
      // over event itself is a full covering-index scan per poll) and
      // range-scan each through event_aggregate_seq_idx instead: cost scales
      // with the response, not the table — a fully-watermarked aggregate
      // reads zero rows.
      //
      // Semantics: same row set as the old NOT(OR(...)) shape for every
      // payload (static table); within an aggregate seq is unique, so
      // per-aggregate order is exactly preserved, but cross-aggregate tie
      // order was unspecified before and stays unspecified (JS stable sort
      // over aggregate enumeration). The N+1 statements are not one snapshot
      // like the old single query: aggregates created after the enumeration
      // are missed until the next poll — benign for a watermark catch-up
      // protocol (un-watermarked aggregates return full history next round;
      // no permanent gaps), noted here so it is a decision, not an accident.
      const aggregates = yield* db
        .select({ aggregateID: EventSequenceTable.aggregate_id })
        .from(EventSequenceTable)
        .pipe(Effect.orDie)
      const rows: Array<typeof EventTable.$inferSelect> = []
      for (const { aggregateID } of aggregates) {
        const watermark = exclude.get(aggregateID)
        const events = yield* db
          .select()
          .from(EventTable)
          .where(
            watermark === undefined
              ? eq(EventTable.aggregate_id, aggregateID)
              : and(eq(EventTable.aggregate_id, aggregateID), gt(EventTable.seq, watermark)),
          )
          .orderBy(asc(EventTable.seq))
          .all()
          .pipe(Effect.orDie)
        // loop-push, not spread-push: a single aggregate can hold hundreds of
        // thousands of events and push(...events) blows the JS stack above
        // ~500-700k elements (measured in Bun/JSC) — the runaway-aggregate
        // class this handler exists to survive
        for (const event of events) rows.push(event)
      }
      rows.sort((a, b) => a.seq - b.seq)
      return rows
    })

    return handlers.handle("start", start).handle("replay", replay).handle("steal", steal).handle("history", history)
  }),
)
