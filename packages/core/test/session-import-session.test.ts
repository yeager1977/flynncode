import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { importSession } from "@opencode-ai/core/session/import"
import { decodeProvenance, findImported } from "@opencode-ai/core/session/import-registry"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])),
)
const sessionsLayer = AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])

describe("importSession", () => {
  it.effect("creates a session, stamps provenance, and writes both projections", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const session = yield* importSession({
        location: { directory: AbsolutePath.make("/project/imported") },
        source: "claude-code",
        sourceSessionID: "abc",
        sourcePath: "/tmp/abc.jsonl",
        title: "Imported thing",
        transcript: [
          { role: "user", text: "hello", time: 1 },
          { role: "assistant", text: "hi", time: 2 },
        ],
      })

      expect(session.title).toBe("Imported thing")

      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie)
      expect(decodeProvenance(row?.metadata)).toMatchObject({
        source: "claude-code",
        sourceSessionID: "abc",
      })

      const sessions = yield* SessionV2.Service
      const messages = yield* sessions.messages({ sessionID: session.id, order: "asc" })
      expect(messages.map((message) => message.type)).toEqual(["user", "assistant"])

      const v1 = yield* db.select().from(MessageTable).where(eq(MessageTable.session_id, session.id)).all().pipe(Effect.orDie)
      expect(v1).toHaveLength(2)

      const found = yield* findImported(db, { source: "claude-code", directory: "/project/imported" })
      expect(found).toEqual([{ sourceSessionID: "abc", sessionID: session.id }])
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("sets session time from the transcript bounds", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const session = yield* importSession({
        location: { directory: AbsolutePath.make("/project/imported") },
        source: "codex",
        sourceSessionID: "rollout-2",
        sourcePath: "/tmp/rollout-2.jsonl",
        title: "Time bounds",
        transcript: [
          { role: "user", text: "first", time: 1_000 },
          { role: "assistant", text: "last", time: 5_000 },
        ],
      })
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie)
      expect(row?.time_created).toBe(1_000)
      expect(row?.time_updated).toBe(5_000)
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("imports two sessions into one database without id collisions", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessions = yield* SessionV2.Service
      const first = yield* importSession({
        location: { directory: AbsolutePath.make("/project/imported") },
        source: "claude-code",
        sourceSessionID: "one",
        sourcePath: "/tmp/one.jsonl",
        title: "First",
        transcript: [
          { role: "user", text: "hello", time: 1 },
          { role: "assistant", text: "hi", time: 2 },
        ],
      })
      const second = yield* importSession({
        location: { directory: AbsolutePath.make("/project/imported") },
        source: "claude-code",
        sourceSessionID: "two",
        sourcePath: "/tmp/two.jsonl",
        title: "Second",
        transcript: [
          { role: "user", text: "other", time: 3 },
          { role: "assistant", text: "reply", time: 4 },
          { role: "user", text: "more", time: 5 },
        ],
      })

      const a = yield* sessions.messages({ sessionID: first.id, order: "asc" })
      const b = yield* sessions.messages({ sessionID: second.id, order: "asc" })
      expect(a.map((message) => message.type)).toEqual(["user", "assistant"])
      expect(b.map((message) => message.type)).toEqual(["user", "assistant", "user"])
      expect(a[0]).toMatchObject({ type: "user", text: "hello" })
      expect(a[1]).toMatchObject({ type: "assistant", content: [{ type: "text", text: "hi" }] })
      expect(b[0]).toMatchObject({ type: "user", text: "other" })
      expect(b[1]).toMatchObject({ type: "assistant", content: [{ type: "text", text: "reply" }] })
      expect(b[2]).toMatchObject({ type: "user", text: "more" })
      expect(a[0]?.id).not.toBe(b[0]?.id)

      const firstV1 = yield* db
        .select()
        .from(MessageTable)
        .where(eq(MessageTable.session_id, first.id))
        .all()
        .pipe(Effect.orDie)
      const secondV1 = yield* db
        .select()
        .from(MessageTable)
        .where(eq(MessageTable.session_id, second.id))
        .all()
        .pipe(Effect.orDie)
      expect(firstV1).toHaveLength(2)
      expect(secondV1).toHaveLength(3)

      const found = yield* findImported(db, { source: "claude-code", directory: "/project/imported" })
      expect([...found].sort((x, y) => x.sourceSessionID.localeCompare(y.sourceSessionID))).toEqual([
        { sourceSessionID: "one", sessionID: first.id },
        { sourceSessionID: "two", sessionID: second.id },
      ])
    }).pipe(Effect.provide(sessionsLayer)),
  )
})
