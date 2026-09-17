import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import {
  decodeProvenance,
  encodeProvenance,
  findImported,
} from "@opencode-ai/core/session/import-registry"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionsLayer = AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])

describe("import provenance", () => {
  test("round-trips through session metadata", () => {
    const encoded = encodeProvenance({
      source: "claude-code",
      sourceSessionID: "abc",
      sourcePath: "/tmp/abc.jsonl",
      importedAt: 5,
    })
    expect(decodeProvenance(encoded)).toEqual({
      source: "claude-code",
      sourceSessionID: "abc",
      sourcePath: "/tmp/abc.jsonl",
      importedAt: 5,
    })
  })

  test("ignores unrelated metadata", () => {
    expect(decodeProvenance({ other: true })).toBeUndefined()
    expect(decodeProvenance(undefined)).toBeUndefined()
    expect(decodeProvenance({ import: { source: "nope" } })).toBeUndefined()
  })

  it.effect("persists provenance through create and finds it by source and directory", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const directory = AbsolutePath.make("/project/imported")

      const session = yield* sessions.create({
        id: SessionV2.ID.make("ses_imported"),
        location: { directory },
        metadata: encodeProvenance({
          source: "codex",
          sourceSessionID: "rollout-1",
          sourcePath: "/tmp/rollout-1.jsonl",
          importedAt: 1,
        }),
      })

      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie)
      expect(decodeProvenance(row?.metadata)).toMatchObject({ source: "codex", sourceSessionID: "rollout-1" })

      const found = yield* findImported(db, { source: "codex", directory: "/project/imported" })
      expect(found).toEqual([{ sourceSessionID: "rollout-1", sessionID: "ses_imported" }])

      const other = yield* findImported(db, { source: "claude-code", directory: "/project/imported" })
      expect(other).toEqual([])
    }).pipe(Effect.provide(sessionsLayer)),
  )
})