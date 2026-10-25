import { afterEach, beforeEach, describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Duration, Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Flag } from "@flynncode/core/flag/flag"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Database } from "@flynncode/core/database/database"
import { Storage } from "../../src/storage/storage"
import { SessionDiffSweep } from "../../src/storage/session-diff-sweep"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, Database.node, SessionDiffSweep.node])))

describe("SessionDiffSweep", () => {
  it.instance("removes diff files of tombstoned sessions and keeps live ones", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      yield* database.db.run(sql`INSERT OR IGNORE INTO project (id, worktree, sandboxes, time_created, time_updated)
                                 VALUES ('prj_sweep', '/repo', '[]', 1, 1)`)
      yield* database.db
        .run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
                                 VALUES ('ses_kept', 'prj_sweep', 'k', '/repo', 't', '1', 1, 1)`)
      yield* database.db.run(sql`INSERT INTO session_tombstone (id, time_deleted) VALUES ('ses_gone', 2)`)
      yield* storage.write(["session_diff", "ses_kept"], [])
      yield* storage.write(["session_diff", "ses_gone"], [])
      const sweep = yield* SessionDiffSweep.Service
      const removed = yield* sweep.sweep()
      const left = (yield* storage.list(["session_diff"])).map((key) => key.at(-1))
      expect(removed).toBe(1)
      expect(left).toContain("ses_kept")
      expect(left).not.toContain("ses_gone")
    }),
  )

  it.instance("keeps diff files of sessions this database never knew (other channels)", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      yield* storage.write(["session_diff", "ses_other_channel"], [])
      const sweep = yield* SessionDiffSweep.Service
      const removed = yield* sweep.sweep()
      const left = (yield* storage.list(["session_diff"])).map((key) => key.at(-1))
      expect(removed).toBe(0)
      expect(left).toContain("ses_other_channel")
    }),
  )

  it.instance("keeps diff files of tombstoned ids that were re-created", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      yield* database.db.run(sql`INSERT OR IGNORE INTO project (id, worktree, sandboxes, time_created, time_updated)
                                 VALUES ('prj_sweep', '/repo', '[]', 1, 1)`)
      yield* database.db
        .run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
                                 VALUES ('ses_back', 'prj_sweep', 'b', '/repo', 't', '1', 1, 1)`)
      yield* database.db.run(sql`INSERT INTO session_tombstone (id, time_deleted) VALUES ('ses_back', 2)`)
      yield* storage.write(["session_diff", "ses_back"], [])
      const sweep = yield* SessionDiffSweep.Service
      const removed = yield* sweep.sweep()
      const left = (yield* storage.list(["session_diff"])).map((key) => key.at(-1))
      expect(removed).toBe(0)
      expect(left).toContain("ses_back")
    }),
  )

  // Runs the hourly loop's first sweep (1 minute after start) on the test clock.
  const firstScheduledSweep = (id: string) =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      yield* database.db.run(sql`INSERT OR IGNORE INTO session_tombstone (id, time_deleted) VALUES (${id}, 2)`)
      yield* storage.write(["session_diff", id], [])
      yield* TestClock.adjust(Duration.minutes(2))
      // The sweep's file I/O finishes in real time after the clock fires; wait up
      // to a second for the file to go before reporting what is left.
      for (let attempt = 0; attempt < 50; attempt++) {
        const left = (yield* storage.list(["session_diff"])).map((key) => key.at(-1))
        if (!left.includes(id)) return left
        yield* Effect.promise(() => Bun.sleep(20))
      }
      return (yield* storage.list(["session_diff"])).map((key) => key.at(-1))
    })

  it.effect("sweeps on its hourly schedule", () =>
    Effect.gen(function* () {
      expect(yield* firstScheduledSweep("ses_scheduled")).not.toContain("ses_scheduled")
    }),
  )

  describe("with OPENCODE_DISABLE_DB_MAINTENANCE", () => {
    const original = Flag.OPENCODE_DISABLE_DB_MAINTENANCE
    // Set before the layer is built, which is when the loop is scheduled.
    beforeEach(() => {
      Flag.OPENCODE_DISABLE_DB_MAINTENANCE = true
    })
    afterEach(() => {
      Flag.OPENCODE_DISABLE_DB_MAINTENANCE = original
    })

    it.effect("does not schedule the sweep", () =>
      Effect.gen(function* () {
        expect(yield* firstScheduledSweep("ses_unscheduled")).toContain("ses_unscheduled")
      }),
    )
  })
})
