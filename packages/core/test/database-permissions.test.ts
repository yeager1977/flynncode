import { describe, expect, test } from "bun:test"
import { chmod, stat, writeFile } from "node:fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Database } from "@flynncode/core/database/database"
import { tmpdir } from "./fixture/tmpdir"

const openModes = (filename: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Layer.build(Database.layerFromPath(filename))
      return yield* Effect.promise(async () => {
        const modes: number[] = []
        for (const suffix of ["", "-wal", "-shm"]) {
          try {
            modes.push((await stat(filename + suffix)).mode & 0o777)
          } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error
          }
        }
        return modes
      })
    }).pipe(Effect.scoped),
  )

describe.skipIf(process.platform === "win32")("Database file permissions", () => {
  test("creates the database readable only by the owner", async () => {
    await using tmp = await tmpdir()
    const modes = await openModes(path.join(tmp.path, "flynncode.db"))
    expect(modes[0]).toBe(0o600)
    for (const mode of modes.slice(1)) expect(mode).toBe(0o600)
  })

  test("tightens an existing database and sidecars", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "flynncode.db")
    await Promise.all(
      ["", "-wal", "-shm"].map(async (suffix) => {
        await writeFile(filename + suffix, "")
        await chmod(filename + suffix, 0o644)
      }),
    )

    expect(await openModes(filename)).toEqual([0o600, 0o600, 0o600])
  })
})
