export * as Database from "./database"

import { EffectDrizzleSqlite } from "@flynncode/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { closeSync, existsSync, openSync } from "node:fs"
import { chmod } from "node:fs/promises"
import { Global } from "../global"
import { Flag } from "../flag/flag"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { makeGlobalNode } from "../effect/app-node"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)

    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  if (filename === ":memory:") return layer.pipe(Layer.provide(sqliteLayer({ filename })))
  return Layer.unwrap(
    Effect.gen(function* () {
      yield* Effect.promise(() => restrictToOwner(filename))
      return layer.pipe(Layer.provide(sqliteLayer({ filename })))
    }),
  )
}

// SQLite creates new sidecars with the database's mode, but does not tighten existing sidecars.
// Windows relies on the user profile directory's inherited ACLs instead of POSIX modes.
async function restrictToOwner(filename: string) {
  if (process.platform === "win32") return
  // Opening and closing an existing database can release another connection's POSIX locks.
  // Create missing files synchronously so another fiber cannot open one before it is restricted.
  if (!existsSync(filename)) closeSync(openSync(filename, "a", 0o600))
  await chmod(filename, 0o600)
  await Promise.all(
    [`${filename}-wal`, `${filename}-shm`].map((file) =>
      chmod(file, 0o600).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      }),
    ),
  )
}

export function path() {
  if (Flag.OPENCODE_DB) {
    if (Flag.OPENCODE_DB === ":memory:" || isAbsolute(Flag.OPENCODE_DB)) return Flag.OPENCODE_DB
    return join(Global.Path.data, Flag.OPENCODE_DB)
  }
  if (
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
  )
    return join(Global.Path.data, "opencode.db")
  return join(Global.Path.data, channelDatabaseName(InstallationChannel))
}

// An empty channel only comes from a build without a channel define; use the
// dev database instead of silently creating an empty `opencode-.db`.
export function channelDatabaseName(channel: string) {
  return `opencode-${(channel || "dev").replace(/[^a-zA-Z0-9._-]/g, "-")}.db`
}

export const node = makeGlobalNode({ service: Service, layer: layerFromPath(path()), deps: [] })
