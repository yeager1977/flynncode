import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "../lib/effect"
import { HooksContext } from "../../src/hooks/context"

const it = testEffect(LayerNode.compile(HooksContext.node))

describe("hooks context store", () => {
  it.instance("appended context is returned by get", () =>
    Effect.gen(function* () {
      const store = yield* HooksContext.Service
      yield* store.append("ses_1", "workspace conventions")
      expect(yield* store.get("ses_1")).toEqual(["workspace conventions"])
      expect(yield* store.get("ses_other")).toEqual([])
    }),
  )

  it.instance("identical entries dedupe", () =>
    Effect.gen(function* () {
      const store = yield* HooksContext.Service
      yield* store.append("ses_1", "same")
      yield* store.append("ses_1", "same")
      expect(yield* store.get("ses_1")).toEqual(["same"])
    }),
  )

  it.instance("clear drops the session entry", () =>
    Effect.gen(function* () {
      const store = yield* HooksContext.Service
      yield* store.append("ses_1", "ctx")
      yield* store.clear("ses_1")
      expect(yield* store.get("ses_1")).toEqual([])
    }),
  )

  it.instance("entries are capped to bound growth", () =>
    Effect.gen(function* () {
      const store = yield* HooksContext.Service
      for (let n = 0; n < HooksContext.MAX_ENTRIES + 10; n++) {
        yield* store.append("ses_1", `entry-${n}`)
      }
      const entries = yield* store.get("ses_1")
      expect(entries.length).toBe(HooksContext.MAX_ENTRIES)
      expect(entries[entries.length - 1]).toBe(`entry-${HooksContext.MAX_ENTRIES + 9}`)
    }),
  )
})

describe("hooks context assembly", () => {
  test("hook context rides after built-in sections", () => {
    expect(HooksContext.assembleSystem(["env", "skills"], ["hook ctx"])).toEqual(["env", "skills", "hook ctx"])
    expect(HooksContext.assembleSystem(["env"], [])).toEqual(["env"])
  })

  test("observeAndStore stores additionalContext", async () => {
    const stored: Array<string> = []
    const fake = { append: (sessionID: string, text: string) => Effect.sync(() => void stored.push(`${sessionID}:${text}`)) }
    await HooksContext.observeAndStore(
      "t",
      "ses_1",
      Effect.succeed({ additionalContext: "hello" }),
    ).pipe(
      Effect.provideService(HooksContext.Service, fake as unknown as HooksContext.Interface),
      Effect.runPromise,
    )
    expect(stored).toEqual(["ses_1:hello"])
  })

  test("observeAndStore without a store still succeeds", async () => {
    const exit = await HooksContext.observeAndStore("t", "ses_1", Effect.succeed({ additionalContext: "x" })).pipe(
      Effect.exit,
      Effect.runPromise,
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("observeAndStore ignores observe failures", async () => {
    const exit = await HooksContext.observeAndStore("t", "ses_1", Effect.fail(new Error("boom"))).pipe(
      Effect.exit,
      Effect.runPromise,
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})
