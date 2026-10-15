import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { Auth } from "@/auth"
import { Plugin } from "../../src/plugin/index"
import { ProviderAuth } from "@/provider/auth"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstance } from "../fixture/fixture"

const calls = { count: 0 }

const fakePlugin = Layer.mock(Plugin.Service, {
  list: () =>
    Effect.succeed([
      {
        auth: {
          provider: "fake-usage",
          methods: [],
          usage: async () => {
            calls.count++
            return { windows: [{ id: "w", percent: 42 }] }
          },
        },
      },
      {
        auth: {
          provider: "fake-failing",
          methods: [],
          usage: async () => {
            throw new Error("boom")
          },
        },
      },
      {
        auth: {
          provider: "fake-nocreds",
          methods: [],
          usage: async () => ({ windows: [{ id: "w", percent: 7 }] }),
        },
      },
      // A later hook for the same provider without usage (e.g. an external
      // auth plugin shadowing a built-in one) must not displace the earlier
      // usage implementation.
      { auth: { provider: "fake-usage", methods: [] } },
      { auth: { provider: "fake-silent", methods: [] } },
    ]),
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([ProviderAuth.node, Auth.node, CrossSpawnSpawner.node]), [
    [Plugin.node, fakePlugin],
  ]),
)

describe("ProviderAuth.usage aggregation", () => {
  it.live("collects hook windows and caches them", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("fake-usage", { type: "api", key: "k" }).pipe(Effect.orDie)
        yield* auth.set("fake-failing", { type: "api", key: "k" }).pipe(Effect.orDie)
        const before = calls.count
        const first = yield* ProviderAuth.use.usage()
        expect(first["fake-usage"].windows).toEqual([{ id: "w", percent: 42 }])
        expect(first["fake-failing"]).toBeUndefined()
        expect(first["fake-silent"]).toBeUndefined()
        expect(calls.count).toBe(before + 1)
        yield* ProviderAuth.use.usage()
        expect(calls.count).toBe(before + 1)
      }),
    ),
  )

  it.live("skips providers without stored credentials", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const usage = yield* ProviderAuth.use.usage()
        expect(usage["fake-nocreds"]).toBeUndefined()
      }),
    ),
  )
})
