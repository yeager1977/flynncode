import { expect, test } from "bun:test"
import { createRelayStore } from "../src/relay.ts"

test("relay store expires digests after 24h", () => {
  let now = 1_000_000
  const store = createRelayStore({ now: () => now })
  store.publish({ originID: "laptop", items: [], updatedAt: now })
  now += 25 * 3600 * 1000
  expect(store.list()).toEqual([])
})
