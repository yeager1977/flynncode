import { expect, test } from "bun:test"
import { createRelayStore, isRelayAuthorized } from "../src/relay.ts"

test("relay store expires digests after 24h", () => {
  let now = 1_000_000
  const store = createRelayStore({ now: () => now })
  store.publish({ originID: "laptop", items: [], updatedAt: now })
  now += 25 * 3600 * 1000
  expect(store.list()).toEqual([])
})

test("relay auth rejects a missing or mismatched bearer", () => {
  expect(isRelayAuthorized(null, "secret")).toBe(false)
  expect(isRelayAuthorized("Bearer secret", "")).toBe(false)
  expect(isRelayAuthorized("Bearer other", "secret")).toBe(false)
  expect(isRelayAuthorized("Bearer secret", "secret")).toBe(true)
})
