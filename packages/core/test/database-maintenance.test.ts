import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { sql } from "drizzle-orm"
import { Context, Effect, Layer, Logger } from "effect"
import { Database } from "@flynncode/core/database/database"
import { DatabaseMaintenance } from "@flynncode/core/database/maintenance"
import { DatabaseMaintenanceNode } from "@flynncode/core/database/maintenance-node"
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
    expect(result.pruned).toEqual({ candidates: 1, sessions: 1, events: 5 })
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
        yield* seedSession(db, { id: "ses_v2msg", updated: NOW - 8 * DAY, messages: 2 })
        yield* db.run(sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
                          VALUES ('msg_v2', 'ses_v2msg', 'user', 1, ${NOW}, ${NOW}, '{}')`)
        const pruned = yield* DatabaseMaintenance.pruneIdleSessions(db, { now: NOW })
        return {
          pruned,
          counts: yield* db.all<{ aggregate_id: string; n: number }>(
            sql`SELECT aggregate_id, count(*) AS n FROM event GROUP BY aggregate_id ORDER BY aggregate_id`,
          ),
        }
      }),
    )
    expect(result.pruned).toEqual({ candidates: 0, sessions: 0, events: 0 })
    expect(result.counts).toEqual([
      { aggregate_id: "ses_input", n: 3 },
      { aggregate_id: "ses_owned", n: 3 },
      { aggregate_id: "ses_recent", n: 3 },
      { aggregate_id: "ses_v2", n: 4 },
      { aggregate_id: "ses_v2msg", n: 3 },
    ])
  })

  test("stops draining a session that becomes owned between chunks", async () => {
    const result = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedSession(db, { id: "ses_resumed", updated: NOW - 8 * DAY, messages: 5 })
        // Simulates a live server claiming the session right after the first chunk commits.
        yield* db.run(sql`CREATE TRIGGER claim_after_delete AFTER DELETE ON event
                          BEGIN UPDATE event_sequence SET owner_id = 'proc_live' WHERE aggregate_id = OLD.aggregate_id; END`)
        const pruned = yield* DatabaseMaintenance.pruneIdleSessions(db, { now: NOW, chunk: 1 })
        return { pruned, types: yield* eventTypes(db, "ses_resumed") }
      }),
    )
    expect(result.pruned).toEqual({ candidates: 1, sessions: 1, events: 1 })
    expect(result.types).toHaveLength(5)
  })
})

const seedMessage = (db: Db, input: { session: string; id: string; updated: number }) =>
  db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
             VALUES (${input.id}, ${input.session}, ${input.updated}, ${input.updated}, '{}')`)

describe("DatabaseMaintenance.pruneIdleSessions message activity", () => {
  test("keeps events of a session whose messages or parts changed recently", async () => {
    const result = await withDb((db) =>
      Effect.gen(function* () {
        // Message and part writes do not bump session.time_updated.
        yield* seedSession(db, { id: "ses_msg", updated: NOW - 8 * DAY, messages: 2 })
        yield* seedMessage(db, { session: "ses_msg", id: "msg_recent", updated: NOW - DAY })
        yield* seedSession(db, { id: "ses_part", updated: NOW - 8 * DAY, messages: 2 })
        yield* seedMessage(db, { session: "ses_part", id: "msg_old", updated: NOW - 8 * DAY })
        yield* db.run(sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
                          VALUES ('prt_recent', 'msg_old', 'ses_part', ${NOW - DAY}, ${NOW - DAY}, '{}')`)
        yield* seedSession(db, { id: "ses_quiet", updated: NOW - 8 * DAY, messages: 2 })
        yield* seedMessage(db, { session: "ses_quiet", id: "msg_quiet", updated: NOW - 8 * DAY })
        const pruned = yield* DatabaseMaintenance.pruneIdleSessions(db, { now: NOW })
        return {
          pruned,
          msg: yield* eventTypes(db, "ses_msg"),
          part: yield* eventTypes(db, "ses_part"),
          quiet: yield* eventTypes(db, "ses_quiet"),
        }
      }),
    )
    expect(result.pruned).toEqual({ candidates: 1, sessions: 1, events: 2 })
    expect(result.msg).toHaveLength(3)
    expect(result.part).toHaveLength(3)
    expect(result.quiet).toEqual(["session.created.1"])
  })

  test("stops draining a session that gets a new message between chunks", async () => {
    const result = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedSession(db, { id: "ses_active", updated: NOW - 8 * DAY, messages: 5 })
        // Simulates the session receiving a message right after the first chunk commits.
        // Triggers cannot use bound parameters, so NOW is inlined.
        yield* db.run(
          sql.raw(`CREATE TRIGGER message_after_delete AFTER DELETE ON event
                               BEGIN INSERT OR IGNORE INTO message (id, session_id, time_created, time_updated, data)
                                     VALUES ('msg_live', OLD.aggregate_id, ${NOW}, ${NOW}, '{}'); END`),
        )
        const pruned = yield* DatabaseMaintenance.pruneIdleSessions(db, { now: NOW, chunk: 1 })
        return { pruned, types: yield* eventTypes(db, "ses_active") }
      }),
    )
    expect(result.pruned).toEqual({ candidates: 1, sessions: 1, events: 1 })
    expect(result.types).toHaveLength(5)
  })
})

describe("DatabaseMaintenance.sweepOrphans", () => {
  test("removes events of a session row that no longer exists and keeps live ones", async () => {
    const result = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedSession(db, { id: "ses_live", updated: NOW, messages: 3 })
        yield* seedSession(db, { id: "ses_gone", updated: NOW, messages: 3 })
        // A delete that died between the session row and its events.
        yield* db.run(sql`DELETE FROM session WHERE id = 'ses_gone'`)
        const swept = yield* DatabaseMaintenance.sweepOrphans(db, { chunk: 2 })
        return {
          swept,
          live: yield* eventTypes(db, "ses_live"),
          gone: yield* eventTypes(db, "ses_gone"),
          sequences: yield* db.all<{ aggregate_id: string }>(sql`SELECT aggregate_id FROM event_sequence`),
        }
      }),
    )
    expect(result.swept).toEqual({ aggregates: 1, events: 4 })
    expect(result.live).toHaveLength(4)
    expect(result.gone).toEqual([])
    expect(result.sequences).toEqual([{ aggregate_id: "ses_live" }])
  })

  test("keeps the events and sequence of a session re-created while the sweep runs", async () => {
    const result = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedSession(db, { id: "ses_back", updated: NOW, messages: 3 })
        yield* db.run(sql`DELETE FROM session WHERE id = 'ses_back'`)
        // Simulates the same id being re-created (sync, import) right after the first chunk commits.
        yield* db.run(
          sql.raw(`CREATE TRIGGER recreate_after_delete AFTER DELETE ON event
                               BEGIN INSERT OR IGNORE INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
                                     VALUES (OLD.aggregate_id, 'prj_test', OLD.aggregate_id, '/repo', 't', '1', ${NOW}, ${NOW}); END`),
        )
        const swept = yield* DatabaseMaintenance.sweepOrphans(db, { chunk: 1 })
        return {
          swept,
          events: yield* eventTypes(db, "ses_back"),
          sequence: yield* db.get<{ seq: number }>(sql`SELECT seq FROM event_sequence WHERE aggregate_id = 'ses_back'`),
        }
      }),
    )
    expect(result.swept).toEqual({ aggregates: 1, events: 1 })
    expect(result.events).toHaveLength(3)
    expect(result.sequence?.seq).toBe(3)
  })

  test("only sweeps ses_ aggregates, so other aggregate kinds without a session row survive", async () => {
    const result = await withDb((db) =>
      Effect.gen(function* () {
        yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('sesXfoo', 0)`)
        yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data)
                          VALUES ('evt_sesXfoo_0', 'sesXfoo', 0, 'other.created.1', '{}')`)
        const swept = yield* DatabaseMaintenance.sweepOrphans(db)
        return { swept, events: yield* eventTypes(db, "sesXfoo") }
      }),
    )
    expect(result.swept).toEqual({ aggregates: 0, events: 0 })
    expect(result.events).toEqual(["other.created.1"])
  })
})

const autoVacuum = (db: Db) =>
  db.get<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`).pipe(Effect.map((row) => row?.auto_vacuum))

const attempts = (filename: string) =>
  Effect.promise(async () => {
    const marker = Bun.file(`${filename}.compact-attempt`)
    return (await marker.exists()) ? (await marker.text()).trim() : undefined
  })

const legacy = (db: Db) => db.run(sql`PRAGMA auto_vacuum = NONE`).pipe(Effect.andThen(db.run(sql`VACUUM`)))

describe("DatabaseMaintenance compaction", () => {
  beforeEach(() => {
    DatabaseMaintenance.resetForTests()
    // Without a listener compactOnce prints a line to stderr.
    DatabaseMaintenance.onProgress(() => {})
  })
  afterEach(() => DatabaseMaintenance.onProgress(undefined))

  test("a new database starts in incremental mode, so compaction is a no-op", async () => {
    // Opening the database must not have compacted it: a VACUUM there would mean new files are not born incremental.
    const progress: DatabaseMaintenance.Progress[] = []
    DatabaseMaintenance.onProgress((event) => progress.push(event))
    const result = await withDb((db, filename) =>
      Effect.gen(function* () {
        return {
          mode: yield* autoVacuum(db),
          compact: yield* DatabaseMaintenance.compactOnce(db, { filename, now: NOW }),
        }
      }),
    ).finally(() => DatabaseMaintenance.onProgress(undefined))
    expect(result).toEqual({ mode: 2, compact: "already" })
    expect(progress).toEqual([])
  })

  test("converts a legacy database once and frees pruned pages", async () => {
    const progress: DatabaseMaintenance.Progress["state"][] = []
    DatabaseMaintenance.onProgress((event) => progress.push(event.state))
    const result = await withDb((db, filename) =>
      Effect.gen(function* () {
        // Simulate a pre-maintenance database: auto_vacuum NONE.
        yield* db.run(sql`PRAGMA auto_vacuum = NONE`)
        yield* db.run(sql`VACUUM`)
        yield* seedSession(db, { id: "ses_big", updated: NOW - 8 * DAY, messages: 400 })
        yield* db.run(sql`UPDATE event SET data = json_object('pad', hex(randomblob(2000)))`)
        const before = yield* autoVacuum(db)
        const first = yield* DatabaseMaintenance.compactOnce(db, { filename, now: NOW })
        // The VACUUM rewrite goes through the WAL; it must be checkpointed away.
        const wal = Bun.file(`${filename}-wal`).size
        const second = yield* DatabaseMaintenance.compactOnce(db, { filename, now: NOW })
        yield* seedSession(db, { id: "ses_more", updated: NOW - 8 * DAY, messages: 400 })
        yield* db.run(
          sql`UPDATE event SET data = json_object('pad', hex(randomblob(2000))) WHERE aggregate_id = 'ses_more'`,
        )
        yield* DatabaseMaintenance.pruneIdleSessions(db, { now: NOW })
        const freeBefore = (yield* db.get<{ n: number }>(sql`SELECT freelist_count AS n FROM pragma_freelist_count`))?.n
        const freed = yield* DatabaseMaintenance.reclaim(db)
        const freeAfter = (yield* db.get<{ n: number }>(sql`SELECT freelist_count AS n FROM pragma_freelist_count`))?.n
        return {
          before,
          after: yield* autoVacuum(db),
          first,
          wal,
          second,
          freeBefore,
          freed,
          freeAfter,
          marker: yield* attempts(filename),
        }
      }),
    ).finally(() => DatabaseMaintenance.onProgress(undefined))
    expect(progress).toEqual(["started", "finished"])
    expect(result.wal).toBeLessThan(64 * 1024)
    expect(result.before).toBe(0)
    expect(result.after).toBe(2)
    expect(result.first).toBe("compacted")
    expect(result.marker).toBeUndefined()
    expect(result.second).toBe("already")
    expect(result.freeBefore).toBeGreaterThan(0)
    expect(result.freed).toBeGreaterThan(0)
    expect(result.freeAfter).toBe(0)
  })

  test("skips compaction when the disk is too full", async () => {
    const progress: DatabaseMaintenance.Progress["state"][] = []
    DatabaseMaintenance.onProgress((event) => progress.push(event.state))
    const result = await withDb((db, filename) =>
      Effect.gen(function* () {
        yield* db.run(sql`PRAGMA auto_vacuum = NONE`)
        yield* db.run(sql`VACUUM`)
        const compact = yield* DatabaseMaintenance.compactOnce(db, {
          filename,
          now: NOW,
          freeBytes: async () => 1024,
        })
        return { compact, mode: yield* autoVacuum(db), marker: yield* attempts(filename) }
      }),
    ).finally(() => DatabaseMaintenance.onProgress(undefined))
    expect(result).toEqual({ compact: "low-disk", mode: 0, marker: undefined })
    expect(progress).toEqual(["started", "finished"])
  })

  test("a failure before VACUUM skips compaction and leaves the database usable", async () => {
    const result = await withDb((db, filename) =>
      Effect.gen(function* () {
        yield* db.run(sql`PRAGMA auto_vacuum = NONE`)
        yield* db.run(sql`VACUUM`)
        yield* seedSession(db, { id: "ses_live", updated: NOW, messages: 3 })
        // A regular file where the temp directory goes makes its mkdir fail.
        const blocker = path.join(path.dirname(filename), ".vacuum-tmp")
        yield* Effect.promise(() => Bun.write(blocker, "keep"))
        const compact = yield* DatabaseMaintenance.compactOnce(db, { filename, now: NOW })
        return {
          compact,
          mode: yield* autoVacuum(db),
          events: yield* eventTypes(db, "ses_live"),
          blocker: yield* Effect.promise(() => Bun.file(blocker).text()),
        }
      }),
    )
    expect(result).toEqual({ compact: "skipped", mode: 0, events: expect.any(Array), blocker: "keep" })
    expect(result.events).toHaveLength(4)
  })

  test("skips compaction while another connection holds the database", async () => {
    const { Database: BunDatabase } = await import("bun:sqlite")
    const result = await withDb((db, filename) =>
      Effect.gen(function* () {
        yield* db.run(sql`PRAGMA auto_vacuum = NONE`)
        yield* db.run(sql`VACUUM`)
        yield* db.run(sql`PRAGMA busy_timeout = 100`)
        // An earlier interrupted attempt; a busy database must not count as another.
        yield* Effect.promise(() => Bun.write(`${filename}.compact-attempt`, "1\n"))
        const other = new BunDatabase(filename)
        // WAL lets VACUUM run beside a reader, so the other connection must hold the write lock.
        other.run("BEGIN IMMEDIATE")
        const compact = yield* DatabaseMaintenance.compactOnce(db, { filename, now: NOW })
        other.run("COMMIT")
        other.close()
        return { compact, mode: yield* autoVacuum(db), marker: yield* attempts(filename) }
      }),
    )
    expect(result).toEqual({ compact: "skipped", mode: 0, marker: "1" })
  })

  test("needs free disk for twice the kept size, not just once", async () => {
    const result = await withDb((db, filename) =>
      Effect.gen(function* () {
        yield* legacy(db)
        // Recent, so the prune inside compactOnce keeps it and the measured size matches.
        yield* seedSession(db, { id: "ses_recent", updated: NOW, messages: 200 })
        yield* db.run(sql`UPDATE event SET data = json_object('pad', hex(randomblob(2000)))`)
        const kept = (yield* db.get<{ kept: number }>(
          sql`SELECT (p.page_count - f.freelist_count) * s.page_size AS kept
              FROM pragma_page_count p, pragma_freelist_count f, pragma_page_size s`,
        ))!.kept
        const compact = yield* DatabaseMaintenance.compactOnce(db, {
          filename,
          now: NOW,
          freeBytes: async () => 1024 * 1024 * 1024 + 1.5 * kept,
        })
        return { kept, compact, mode: yield* autoVacuum(db) }
      }),
    )
    expect(result.kept).toBeGreaterThan(512 * 1024)
    expect(result.compact).toBe("low-disk")
    expect(result.mode).toBe(0)
  })

  test("attempts the conversion only once per process", async () => {
    const result = await withDb((db, filename) =>
      Effect.gen(function* () {
        yield* legacy(db)
        const calls: string[] = []
        const freeBytes = async (directory: string) => {
          calls.push(directory)
          return 1024
        }
        const first = yield* DatabaseMaintenance.compactOnce(db, { filename, now: NOW, freeBytes })
        const second = yield* DatabaseMaintenance.compactOnce(db, { filename, now: NOW, freeBytes })
        return { first, second, calls: calls.length, mode: yield* autoVacuum(db) }
      }),
    )
    expect(result).toEqual({ first: "low-disk", second: "attempted", calls: 1, mode: 0 })
  })

  test("backs off after three attempts that did not finish", async () => {
    const progress: DatabaseMaintenance.Progress["state"][] = []
    DatabaseMaintenance.onProgress((event) => progress.push(event.state))
    const result = await withDb((db, filename) =>
      Effect.gen(function* () {
        yield* legacy(db)
        yield* seedSession(db, { id: "ses_idle", updated: NOW - 8 * DAY, messages: 3 })
        yield* Effect.promise(() => Bun.write(`${filename}.compact-attempt`, "3\n"))
        const compact = yield* DatabaseMaintenance.compactOnce(db, { filename, now: NOW })
        return {
          compact,
          mode: yield* autoVacuum(db),
          events: yield* eventTypes(db, "ses_idle"),
          marker: yield* attempts(filename),
        }
      }),
    )
    expect(result.compact).toBe("backoff")
    expect(result.mode).toBe(0)
    // Neither the prune nor the VACUUM ran.
    expect(result.events).toHaveLength(4)
    expect(result.marker).toBe("3")
    expect(progress).toEqual([])
  })

  test("counts an earlier interrupted attempt and clears the marker once compacted", async () => {
    const result = await withDb((db, filename) =>
      Effect.gen(function* () {
        yield* legacy(db)
        yield* Effect.promise(() => Bun.write(`${filename}.compact-attempt`, "2\n"))
        const compact = yield* DatabaseMaintenance.compactOnce(db, { filename, now: NOW })
        return { compact, mode: yield* autoVacuum(db), marker: yield* attempts(filename) }
      }),
    )
    expect(result).toEqual({ compact: "compacted", mode: 2, marker: undefined })
  })

  test("a VACUUM that fails for a reason other than a busy database counts as an attempt", async () => {
    const result = await withDb((db, filename) =>
      Effect.gen(function* () {
        yield* legacy(db)
        yield* Effect.promise(() => Bun.write(`${filename}.compact-attempt`, "1\n"))
        // Nothing to prune, so only the VACUUM writes, and query_only makes it fail as read-only.
        yield* db.run(sql`PRAGMA query_only = ON`)
        const compact = yield* DatabaseMaintenance.compactOnce(db, { filename, now: NOW })
        yield* db.run(sql`PRAGMA query_only = OFF`)
        return { compact, mode: yield* autoVacuum(db), marker: yield* attempts(filename) }
      }),
    )
    expect(result).toEqual({ compact: "failed", mode: 0, marker: "2" })
  })
})

const silent = Effect.provide(Logger.layer([], { mergeWithExisting: false }))

describe("DatabaseMaintenanceNode.pass", () => {
  test("prunes, sweeps and reclaims in one pass", async () => {
    const result = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedSession(db, { id: "ses_idle", updated: NOW - 8 * DAY, messages: 3 })
        yield* seedSession(db, { id: "ses_gone", updated: NOW, messages: 2 })
        yield* db.run(sql`DELETE FROM session WHERE id = 'ses_gone'`)
        return yield* DatabaseMaintenanceNode.pass(db, NOW).pipe(silent)
      }),
    )
    expect(result.pruned).toEqual({ candidates: 1, sessions: 1, events: 3 })
    expect(result.orphans).toEqual({ aggregates: 1, events: 3 })
    expect(result.freed).toBeGreaterThanOrEqual(0)
  })
  test("truncates the WAL after reclaiming pages", async () => {
    const result = await withDb((db, filename) =>
      Effect.gen(function* () {
        yield* seedSession(db, { id: "ses_idle", updated: NOW - 8 * DAY, messages: 400 })
        yield* db.run(sql`UPDATE event SET data = json_object('pad', hex(randomblob(2000)))`)
        const pass = yield* DatabaseMaintenanceNode.pass(db, NOW).pipe(silent)
        return { freed: pass.freed, wal: Bun.file(`${filename}-wal`).size }
      }),
    )
    expect(result.freed).toBeGreaterThan(0)
    expect(result.wal).toBeLessThan(64 * 1024)
  })
  test("a failing step is logged and does not stop the others", async () => {
    const result = await withDb((db) =>
      Effect.gen(function* () {
        yield* seedSession(db, { id: "ses_gone", updated: NOW, messages: 2 })
        yield* db.run(sql`DELETE FROM session WHERE id = 'ses_gone'`)
        // The prune candidate query reads session_message, so this makes only that step fail.
        yield* db.run(sql`DROP TABLE session_message`)
        const messages: unknown[] = []
        const capture = Logger.layer(
          [Logger.make((options) => messages.push({ level: options.logLevel, message: options.message }))],
          { mergeWithExisting: false },
        )
        const pass = yield* DatabaseMaintenanceNode.pass(db, NOW).pipe(Effect.provide(capture))
        return { pass, messages }
      }),
    )
    expect(result.pass.pruned).toEqual({ candidates: 0, sessions: 0, events: 0 })
    expect(result.pass.orphans).toEqual({ aggregates: 1, events: 3 })
    expect(JSON.stringify(result.messages)).toContain("database maintenance step failed")
    expect(JSON.stringify(result.messages)).toContain("database maintenance pass")
  })
})
