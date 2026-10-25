import { describe, expect, test } from "bun:test"
import path from "path"
import { sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "@flynncode/core/database/database"
import { DatabaseMaintenance } from "@flynncode/core/database/maintenance"
import { tmpdir } from "./fixture/tmpdir"

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

type Db = Database.Interface["db"]

// Opens a real migrated database file and runs `fn` against it.
const withDb = <A>(fn: (db: Db, filename: string) => Effect.Effect<A, unknown>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const filename = path.join(tmp.path, "history.db")
      const context = yield* Layer.build(Database.layerFromPath(filename))
      return yield* fn(Context.get(context, Database.Service).db, filename)
    }).pipe(Effect.scoped),
  )

const seedProject = (db: Db) =>
  db.run(sql`INSERT OR IGNORE INTO project (id, worktree, sandboxes, time_created, time_updated)
             VALUES ('prj_test', '/repo', '[]', ${NOW}, ${NOW})`)

// A classic session with `messages` message.* events and one session.created event.
const seedSession = (db: Db, input: { id: string; updated: number; messages: number; owner?: string }) =>
  Effect.gen(function* () {
    yield* seedProject(db)
    yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
                      VALUES (${input.id}, 'prj_test', ${input.id}, '/repo', 't', '1', ${input.updated}, ${input.updated})`)
    yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq, owner_id)
                      VALUES (${input.id}, ${input.messages}, ${input.owner ?? null})`)
    yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data)
                      VALUES (${`evt_${input.id}_0`}, ${input.id}, 0, 'session.created.1', '{}')`)
    for (let seq = 1; seq <= input.messages; seq++)
      yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data)
                        VALUES (${`evt_${input.id}_${seq}`}, ${input.id}, ${seq},
                                ${seq % 2 === 0 ? "message.updated.1" : "message.part.updated.1"}, '{}')`)
  })

const eventTypes = (db: Db, id: string) =>
  db
    .all<{ type: string }>(sql`SELECT type FROM event WHERE aggregate_id = ${id} ORDER BY seq`)
    .pipe(Effect.map((rows) => rows.map((row) => row.type)))

describe("DatabaseMaintenance.pruneIdleSessions", () => {
  test("drops message events of a classic session idle for 7 days and keeps the rest", async () => {
    const result = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedSession(db, { id: "ses_idle", updated: NOW - 8 * DAY, messages: 5 })
        const pruned = yield* DatabaseMaintenance.pruneIdleSessions(db, { now: NOW, chunk: 2 })
        const sequence = yield* db.get<{ seq: number }>(
          sql`SELECT seq FROM event_sequence WHERE aggregate_id = 'ses_idle'`,
        )
        return { pruned, types: yield* eventTypes(db, "ses_idle"), sequence }
      }),
    )
    expect(result.pruned).toEqual({ sessions: 1, events: 5 })
    expect(result.types).toEqual(["session.created.1"])
    // The counter survives, so a resumed session appends at seq + 1.
    expect(result.sequence?.seq).toBe(5)
  })

  test("leaves recent, v2, pending-input and owned sessions untouched", async () => {
    const result = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedSession(db, { id: "ses_recent", updated: NOW - 2 * DAY, messages: 2 })
        yield* seedSession(db, { id: "ses_owned", updated: NOW - 8 * DAY, messages: 2, owner: "proc_1" })
        yield* seedSession(db, { id: "ses_v2", updated: NOW - 8 * DAY, messages: 2 })
        yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data)
                          VALUES ('evt_ses_v2_next', 'ses_v2', 3, 'session.next.prompted.1', '{}')`)
        yield* seedSession(db, { id: "ses_input", updated: NOW - 8 * DAY, messages: 2 })
        yield* db.run(sql`INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, time_created)
                          VALUES ('msg_pending', 'ses_input', '{}', 'steer', 1, ${NOW})`)
        const pruned = yield* DatabaseMaintenance.pruneIdleSessions(db, { now: NOW })
        return {
          pruned,
          counts: yield* db.all<{ aggregate_id: string; n: number }>(
            sql`SELECT aggregate_id, count(*) AS n FROM event GROUP BY aggregate_id ORDER BY aggregate_id`,
          ),
        }
      }),
    )
    expect(result.pruned).toEqual({ sessions: 0, events: 0 })
    expect(result.counts).toEqual([
      { aggregate_id: "ses_input", n: 3 },
      { aggregate_id: "ses_owned", n: 3 },
      { aggregate_id: "ses_recent", n: 3 },
      { aggregate_id: "ses_v2", n: 4 },
    ])
  })
})
