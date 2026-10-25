import { describe, expect } from "bun:test"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Global } from "@flynncode/core/global"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Auth } from "../../src/auth"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Auth.node))

describe("Auth", () => {
  it.instance("set normalizes trailing slashes in keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeDefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set cleans up pre-existing trailing-slash entry", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "old",
      })
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "new",
      })
      const data = yield* auth.all()
      const keys = Object.keys(data).filter((key) => key.includes("example.com"))
      expect(keys).toEqual(["https://example.com"])
      const entry = data["https://example.com"]!
      expect(entry.type).toBe("wellknown")
      if (entry.type === "wellknown") expect(entry.token).toBe("new")
    }),
  )

  it.instance("remove deletes both trailing-slash and normalized keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      yield* auth.remove("https://example.com/")
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeUndefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set and remove are no-ops on keys without trailing slashes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", {
        type: "api",
        key: "sk-test",
      })
      const data = yield* auth.all()
      expect(data["anthropic"]).toBeDefined()
      yield* auth.remove("anthropic")
      const after = yield* auth.all()
      expect(after["anthropic"]).toBeUndefined()
    }),
  )

  const file = path.join(Global.Path.data, "auth.json")
  const writeRaw = (content: string) => Effect.promise(() => fs.writeFile(file, content, { mode: 0o600 }))
  const readRaw = () => Effect.promise(() => fs.readFile(file, "utf8"))

  it.instance("set keeps entries it cannot decode", () =>
    Effect.gen(function* () {
      // An entry written by a newer build or a plugin must survive another
      // provider's token refresh; dropping it silently deleted credentials.
      yield* writeRaw(JSON.stringify({ meta: { type: "api", key: "m" }, future: { type: "device", code: "x" } }))
      const auth = yield* Auth.Service
      yield* auth.set("openai", { type: "api", key: "o" })
      const raw = JSON.parse(yield* readRaw())
      expect(raw.future).toEqual({ type: "device", code: "x" })
      expect(raw.meta).toEqual({ type: "api", key: "m" })
      expect(raw.openai).toEqual({ type: "api", key: "o" })
    }),
  )

  it.instance("set refuses to overwrite an unreadable auth file", () =>
    Effect.gen(function* () {
      // A half-written file (another writer mid-write) parsed as {} and the
      // write then replaced every stored credential with a single entry.
      const partial = '{\n  "meta": { "type": "api", "key": "m" },\n  "xai'
      yield* writeRaw(partial)
      const auth = yield* Auth.Service
      const result = yield* auth.set("openai", { type: "api", key: "o" }).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      expect(yield* readRaw()).toBe(partial)
    }),
  )

  it.instance("set replaces the file atomically", () =>
    Effect.gen(function* () {
      yield* writeRaw(JSON.stringify({ meta: { type: "api", key: "m" } }))
      const before = yield* Effect.promise(() => fs.stat(file))
      const auth = yield* Auth.Service
      yield* auth.set("openai", { type: "api", key: "o" })
      const after = yield* Effect.promise(() => fs.stat(file))
      // A rename swaps in a new inode, so readers never see a truncated file.
      expect(after.ino).not.toBe(before.ino)
      expect((after.mode & 0o777).toString(8)).toBe("600")
      const leftovers = (yield* Effect.promise(() => fs.readdir(Global.Path.data))).filter((name) =>
        name.startsWith("auth.json."),
      )
      expect(leftovers).toEqual([])
    }),
  )
})
