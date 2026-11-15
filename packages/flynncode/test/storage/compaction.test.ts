import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@flynncode/core/database/database"
import { AppNodeBuilder } from "@flynncode/core/effect/app-node-builder"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { StorageCompaction } from "@/storage/compaction"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node])))

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const PNG = `data:image/png;base64,${"A".repeat(4096)}`

type Db = Database.Interface["db"]

const read = (attachments?: Array<{ mime: string; url: string; filename?: string }>) => ({
  type: "tool",
  callID: "call_1",
  tool: "read",
  state: {
    status: "completed",
    input: { filePath: "/repo/shot.png" },
    output: "Image read successfully",
    title: "shot.png",
    metadata: {},
    time: { start: 1, end: 2 },
    ...(attachments
      ? {
          attachments: attachments.map((item) => ({
            id: "prt_a",
            sessionID: "s",
            messageID: "m",
            type: "file",
            ...item,
          })),
        }
      : {}),
  },
})

// A classic session last written at `updated`, with one message, the given parts, and `events` message events.
const seed = (db: Db, input: { id: string; updated: number; parts: unknown[]; events?: number }) =>
  Effect.gen(function* () {
    yield* db.run(sql`INSERT OR IGNORE INTO project (id, worktree, sandboxes, time_created, time_updated)
                      VALUES ('prj_test', '/repo', '[]', ${NOW}, ${NOW})`)
    yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
                      VALUES (${input.id}, 'prj_test', ${input.id}, '/repo', 't', '1', ${input.updated}, ${input.updated})`)
    yield* db.run(sql`INSERT INTO message (id, session_id, time_created, time_updated, data)
                      VALUES (${`msg_${input.id}`}, ${input.id}, ${input.updated}, ${input.updated}, '{"role":"assistant"}')`)
    yield* Effect.forEach(input.parts, (part, index) =>
      db.run(sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
                 VALUES (${`prt_${input.id}_${index}`}, ${`msg_${input.id}`}, ${input.id}, ${input.updated},
                         ${input.updated}, ${JSON.stringify(part)})`),
    )
    yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES (${input.id}, ${input.events ?? 0})`)
    yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data)
                      VALUES (${`evt_${input.id}_0`}, ${input.id}, 0, 'session.created.1', '{}')`)
    yield* Effect.forEach(
      Array.from({ length: input.events ?? 0 }, (_, index) => index + 1),
      (seq) =>
        db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data)
                   VALUES (${`evt_${input.id}_${seq}`}, ${input.id}, ${seq}, 'message.part.updated.1',
                           ${JSON.stringify({ sessionID: input.id, pad: "x".repeat(100) })})`),
    )
  })

const part = (db: Db, id: string) =>
  db
    .get<{ data: string; time_updated: number }>(sql`SELECT data, time_updated FROM part WHERE id = ${id}`)
    .pipe(Effect.map((row) => ({ data: JSON.parse(row?.data ?? "null"), time_updated: row?.time_updated })))

const eventTypes = (db: Db, id: string) =>
  db
    .all<{ type: string }>(sql`SELECT type FROM event WHERE aggregate_id = ${id} ORDER BY seq`)
    .pipe(Effect.map((rows) => rows.map((row) => row.type)))

describe("StorageCompaction", () => {
  it.effect("estimates without writing, and run drops exactly what the estimate counted", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* seed(db, {
        id: "ses_old",
        updated: NOW - 10 * DAY,
        parts: [read([{ mime: "image/png", url: PNG }])],
        events: 3,
      })
      yield* seed(db, {
        id: "ses_mid",
        updated: NOW - 3 * DAY,
        parts: [read([{ mime: "image/png", url: PNG }])],
        events: 2,
      })
      yield* seed(db, {
        id: "ses_new",
        updated: NOW - 1000,
        parts: [read([{ mime: "image/png", url: PNG }])],
        events: 4,
      })
      const options = { now: NOW, eventIdleDays: 2, mediaIdleDays: 7 }

      const before = yield* StorageCompaction.estimate(db, options)
      expect(before.events.sessions).toBe(2)
      expect(before.events.rows).toBe(5)
      expect(before.events.bytes).toBeGreaterThan(500)
      expect(before.media).toEqual({ sessions: 1, parts: 1, attachments: 1, bytes: PNG.length })
      // The estimate wrote nothing.
      expect(yield* eventTypes(db, "ses_old")).toHaveLength(4)
      expect((yield* part(db, "prt_ses_old_0")).data.state.attachments).toHaveLength(1)

      const result = yield* StorageCompaction.run(db, options)
      expect(result.events.events).toBe(before.events.rows)
      expect(result.media).toEqual({ sessions: 1, parts: 1 })
      expect(yield* eventTypes(db, "ses_old")).toEqual(["session.created.1"])
      expect(yield* eventTypes(db, "ses_mid")).toEqual(["session.created.1"])
      expect(yield* eventTypes(db, "ses_new")).toHaveLength(5)
      // Only the session past the media window lost its image.
      expect((yield* part(db, "prt_ses_mid_0")).data.state.attachments).toHaveLength(1)
      expect((yield* part(db, "prt_ses_new_0")).data.state.attachments).toHaveLength(1)

      const after = yield* StorageCompaction.estimate(db, options)
      expect(after.events).toEqual({ sessions: 0, rows: 0, bytes: 0 })
      expect(after.media).toEqual({ sessions: 0, parts: 0, attachments: 0, bytes: 0 })
    }),
  )

  it.effect("strips inline media, keeps the text output and referenced attachments, and leaves time_updated", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const updated = NOW - 10 * DAY
      yield* seed(db, {
        id: "ses_strip",
        updated,
        parts: [
          read([
            { mime: "image/png", url: PNG, filename: "shot.png" },
            { mime: "application/pdf", url: PNG.replace("image/png", "application/pdf") },
            { mime: "text/plain", url: "file:///repo/notes.txt", filename: "notes.txt" },
          ]),
          read(),
          { type: "text", text: 'a text part that mentions "attachments":[{ and data: urls' },
        ],
      })

      const result = yield* StorageCompaction.stripIdleMedia(db, { cutoff: NOW - 7 * DAY, chunk: 1 })
      expect(result).toEqual({ sessions: 1, parts: 1 })

      const stripped = yield* part(db, "prt_ses_strip_0")
      expect(stripped.data.state.attachments).toEqual([
        {
          id: "prt_a",
          sessionID: "s",
          messageID: "m",
          type: "file",
          mime: "text/plain",
          url: "file:///repo/notes.txt",
          filename: "notes.txt",
        },
      ])
      expect(stripped.data.state.output).toBe(
        "Image read successfully\n\n[Attachments removed from stored history to save space: shot.png, application/pdf]",
      )
      expect(stripped.data.state.input).toEqual({ filePath: "/repo/shot.png" })
      expect(stripped.time_updated).toBe(updated)
      expect((yield* part(db, "prt_ses_strip_1")).data).toEqual(read())
      expect((yield* part(db, "prt_ses_strip_2")).data.text).toContain("data: urls")

      // A second pass finds nothing left to strip.
      expect(yield* StorageCompaction.stripIdleMedia(db, { cutoff: NOW - 7 * DAY })).toEqual({ sessions: 0, parts: 0 })
    }),
  )

  it.effect("leaves a session alone when a part was written after the cutoff or a turn is queued", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* seed(db, { id: "ses_resumed", updated: NOW - 10 * DAY, parts: [read([{ mime: "image/png", url: PNG }])] })
      yield* db.run(sql`UPDATE part SET time_updated = ${NOW - DAY} WHERE session_id = 'ses_resumed'`)
      yield* seed(db, { id: "ses_queued", updated: NOW - 10 * DAY, parts: [read([{ mime: "image/png", url: PNG }])] })
      yield* db.run(sql`INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, time_created)
                        VALUES ('inp_1', 'ses_queued', '{}', 'steer', 1, ${NOW - 10 * DAY})`)

      expect(yield* StorageCompaction.stripIdleMedia(db, { cutoff: NOW - 7 * DAY })).toEqual({ sessions: 0, parts: 0 })
      expect((yield* part(db, "prt_ses_resumed_0")).data.state.attachments).toHaveLength(1)
      expect((yield* part(db, "prt_ses_queued_0")).data.state.attachments).toHaveLength(1)
    }),
  )
})
