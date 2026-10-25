import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Database } from "@flynncode/core/database/database"
import { Storage } from "../../src/storage/storage"
import { SessionDiffSweep } from "../../src/storage/session-diff-sweep"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, Database.node, SessionDiffSweep.node])))

describe("SessionDiffSweep", () => {
  it.instance("removes session_diff files of deleted sessions only", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      yield* database.db.run(sql`INSERT OR IGNORE INTO project (id, worktree, sandboxes, time_created, time_updated)
                                 VALUES ('prj_sweep', '/repo', '[]', 1, 1)`)
      yield* database.db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
                                 VALUES ('ses_kept', 'prj_sweep', 'k', '/repo', 't', '1', 1, 1)`)
      yield* storage.write(["session_diff", "ses_kept"], [])
      yield* storage.write(["session_diff", "ses_gone"], [])
      const sweep = yield* SessionDiffSweep.Service
      const removed = yield* sweep.sweep()
      const left = (yield* storage.list(["session_diff"])).map((key) => key.at(-1))
      expect(removed).toBe(1)
      expect(left).toEqual(["ses_kept"])
    }),
  )
})
