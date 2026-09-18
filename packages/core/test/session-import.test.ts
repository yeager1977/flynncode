import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { importTranscript } from "@opencode-ai/core/session/import"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageTable, PartTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionID = SessionV2.ID.make("ses_import_test")
const created = DateTime.makeUnsafe(0)

function seed(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })
}

describe("importTranscript", () => {
  it.effect("projects user and assistant text into the V2 message projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* seed(db)

      yield* importTranscript(events, {
        sessionID,
        transcript: [
          { role: "user", text: "hello", time: 1 },
          { role: "assistant", text: "hi there", time: 2 },
        ],
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )

      expect(messages.map((message) => message.type)).toEqual(["user", "assistant"])
      expect(messages[0]).toMatchObject({ type: "user", text: "hello" })
      expect(messages[1]).toMatchObject({
        type: "assistant",
        content: [{ type: "text", text: "hi there" }],
      })
    }),
  )

  it.effect("writes the V1 message and part projections", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* seed(db)

      yield* importTranscript(events, {
        sessionID,
        transcript: [
          { role: "user", text: "hello", time: 1 },
          { role: "assistant", text: "hi there", time: 2 },
        ],
      })

      const messages = yield* db
        .select()
        .from(MessageTable)
        .where(eq(MessageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const parts = yield* db
        .select()
        .from(PartTable)
        .where(eq(PartTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)

      expect(messages).toHaveLength(2)
      expect(parts).toHaveLength(2)
      expect(parts.every((part) => part.data.type === "text")).toBe(true)
    }),
  )

  it.effect("gives every assistant message a user parent, even across consecutive assistant turns", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* seed(db)

      yield* importTranscript(events, {
        sessionID,
        transcript: [
          { role: "user", text: "first prompt", time: 1 },
          { role: "assistant", text: "reply one", time: 2 },
          { role: "assistant", text: "reply two", time: 3 },
          { role: "user", text: "second prompt", time: 4 },
          { role: "assistant", text: "reply three", time: 5 },
        ],
      })

      const rows = yield* db
        .select()
        .from(MessageTable)
        .where(eq(MessageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)

      const assistants = rows.filter((row) => row.data.role === "assistant")
      expect(assistants).toHaveLength(3)
      for (const assistant of assistants) {
        const parentID = (assistant.data as { parentID?: string }).parentID
        expect(parentID).toBeDefined()
        const parent = rows.find((row) => row.id === parentID)
        expect(parent?.data.role).toBe("user")
      }
    }),
  )

  it.effect("imports nothing when a transcript has no user turn", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* seed(db)

      yield* importTranscript(events, {
        sessionID,
        transcript: [{ role: "assistant", text: "no prompt ever", time: 1 }],
      })

      const rows = yield* db
        .select()
        .from(MessageTable)
        .where(eq(MessageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(rows).toEqual([])
    }),
  )

  it.effect("keeps imported usage at zero", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* seed(db)

      yield* importTranscript(events, {
        sessionID,
        transcript: [{ role: "assistant", text: "no tokens", time: 3 }],
      })

      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      expect(row).toMatchObject({ cost: 0, tokens_input: 0, tokens_output: 0, tokens_reasoning: 0 })
    }),
  )

  it.effect("publishes durable events so history is replayable", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* seed(db)

      const user = yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID: SessionMessage.ID.make("msg_probe"),
        timestamp: created,
        prompt: Prompt.make({ text: "probe" }),
        delivery: "steer",
      })
      expect(user.durable?.seq).toBeGreaterThanOrEqual(0)

      yield* importTranscript(events, {
        sessionID,
        transcript: [{ role: "user", text: "second", time: 4 }],
      })

      const rows = yield* db
        .select({ seq: SessionMessageTable.seq })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(rows.map((row) => row.seq)).toEqual([0, 1])
    }),
  )
})