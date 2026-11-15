import type { Argv } from "yargs"
import { spawn } from "child_process"
import { Database } from "@flynncode/core/database/database"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { effectCmd } from "../effect-cmd"
import { StorageCompaction } from "@/storage/compaction"

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

const QueryCommand = effectCmd({
  command: "$0 [query]",
  describe: "open an interactive sqlite3 shell or run a query",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: Effect.fn("Cli.db.query")(function* (args: { query?: string; format: string }) {
    const query = args.query as string | undefined
    if (query) {
      const { db } = yield* Database.Service
      const result = yield* db.all<Record<string, unknown>>(sql.raw(query)).pipe(Effect.orDie)
      if (args.format === "json") console.log(JSON.stringify(result, null, 2))
      else if (result.length > 0) {
        const keys = Object.keys(result[0])
        console.log(keys.join("\t"))
        for (const row of result) console.log(keys.map((key) => row[key]).join("\t"))
      }
      return
    }
    const child = spawn("sqlite3", [Database.path()], {
      stdio: "inherit",
    })
    yield* Effect.promise(() => new Promise((resolve) => child.on("close", resolve)))
  }),
})

const PathCommand = effectCmd({
  command: "path",
  describe: "print the database path",
  instance: false,
  handler: Effect.fn("Cli.db.path")(function* () {
    console.log(Database.path())
  }),
})

const CompactCommand = effectCmd({
  command: "compact",
  describe: "report what idle sessions hold that can be dropped; --apply drops it",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .option("apply", {
        type: "boolean",
        default: false,
        describe: "Delete and strip instead of only reporting",
      })
      .option("event-idle-days", {
        type: "number",
        default: 7,
        describe: "Delete the projected message events of classic sessions idle for this many days",
      })
      .option("media-idle-days", {
        type: "number",
        describe: "Strip inline images and PDFs from tool results of sessions idle for this many days (off when unset)",
      })
  },
  handler: Effect.fn("Cli.db.compact")(function* (args: {
    apply: boolean
    "event-idle-days": number
    "media-idle-days"?: number
  }) {
    const { db } = yield* Database.Service
    const options = { now: Date.now(), eventIdleDays: args["event-idle-days"], mediaIdleDays: args["media-idle-days"] }
    const before = yield* StorageCompaction.estimate(db, options).pipe(Effect.orDie)
    console.log(`database: ${Database.path()}`)
    console.log(`in use: ${megabytes(before.usedBytes)} (${megabytes(before.freeBytes)} free pages)`)
    console.log(
      `message events of sessions idle ${options.eventIdleDays}+ days: ${before.events.rows} rows in ${before.events.sessions} sessions, ${megabytes(before.events.bytes)}`,
    )
    console.log(
      options.mediaIdleDays === undefined
        ? "inline media: not measured (pass --media-idle-days)"
        : `inline media of sessions idle ${options.mediaIdleDays}+ days: ${before.media.attachments} attachments in ${before.media.parts} tool results of ${before.media.sessions} sessions, ${megabytes(before.media.bytes)}`,
    )
    if (!args.apply) {
      console.log(
        `dry run: ${megabytes(before.events.bytes + before.media.bytes)} would be dropped; nothing was changed (pass --apply)`,
      )
      return
    }
    const result = yield* StorageCompaction.run(db, options).pipe(Effect.orDie)
    const after = yield* StorageCompaction.estimate(db, options).pipe(Effect.orDie)
    console.log(
      `applied: deleted ${result.events.events} events in ${result.events.sessions} sessions, stripped media from ${result.media.parts} tool results in ${result.media.sessions} sessions`,
    )
    console.log(
      `in use now: ${megabytes(after.usedBytes)} (${megabytes(after.freeBytes)} free pages), ${megabytes(before.usedBytes - after.usedBytes)} less`,
    )
  }),
})

export const DbCommand = effectCmd({
  command: "db",
  describe: "database tools",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs.command(QueryCommand).command(PathCommand).command(CompactCommand).demandCommand()
  },
  handler: Effect.fn("Cli.db")(function* () {}),
})
