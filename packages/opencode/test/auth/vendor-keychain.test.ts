import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { VendorKeychain } from "../../src/auth/keychain"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(VendorKeychain.node))

describe("VendorKeychain file fallback", () => {
  it.instance("round-trips api credentials", () =>
    Effect.gen(function* () {
      const store = yield* VendorKeychain.KeychainService
      yield* store.set({ vendor: "anthropic", kind: "api", key: "sk-ant-test" })
      const got = yield* store.get("anthropic")
      expect(got).toMatchObject({ vendor: "anthropic", kind: "api" })
      yield* store.remove("anthropic")
      expect(yield* store.get("anthropic")).toBeUndefined()
    }),
  )
  it.instance("round-trips oauth credentials", () =>
    Effect.gen(function* () {
      const store = yield* VendorKeychain.KeychainService
      yield* store.set({
        vendor: "openai",
        kind: "oauth",
        refresh: "refresh-value",
        access: "access-value",
        expires: Date.now() + 3600_000,
        accountId: "acc-1",
      })
      const got = yield* store.get("openai")
      expect(got).toMatchObject({ vendor: "openai", kind: "oauth", accountId: "acc-1" })
      yield* store.remove("openai")
      expect(yield* store.get("openai")).toBeUndefined()
    }),
  )
  it.instance("reports keychain unavailable on server without exposing secrets", () =>
    Effect.gen(function* () {
      const store = yield* VendorKeychain.KeychainService
      expect(yield* store.available()).toBe(false)
      expect(yield* store.get("anthropic")).toBeUndefined()
    }),
  )
})
