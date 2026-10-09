import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable, SessionTombstoneTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionID = SessionV2.ID.make("ses_tombstone_test")

describe("session tombstones", () => {
  it.effect("records a tombstone when a session is deleted", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
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
      const before = Date.now()

      yield* events.publish(SessionV1.Event.Deleted, {
        sessionID,
        info: {
          id: sessionID,
          slug: "test",
          projectID: Project.ID.global,
          directory: "/project",
          title: "test",
          version: "test",
          kind: "code",
          time: { created: 1, updated: 1 },
        },
      })

      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toBeUndefined()
      const tombstone = yield* db
        .select()
        .from(SessionTombstoneTable)
        .where(eq(SessionTombstoneTable.id, sessionID))
        .get()
      expect(tombstone?.time_deleted).toBeGreaterThanOrEqual(before)
    }),
  )
})
