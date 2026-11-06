import { describe, expect, test } from "bun:test"
import type { NormalizedProviderListResponse } from "@flynncode/session-ui/context"
import { createMemo, createRoot, createSignal, getListener } from "solid-js"
import { createProviderLookup } from "../src/context/global-sync/provider-lookup"

const catalog = (...ids: string[]) =>
  ({
    all: new Map(ids.map((id) => [id, { id, name: id.toUpperCase(), models: {} }])),
    connected: [],
    default: {},
  }) as unknown as NormalizedProviderListResponse

// A query result whose data the test sets. `reads` records every read made outside a user effect: with a solid-query
// result those are the reads that register with a <Suspense> boundary and blank the route when the query reloads.
function fakeQuery() {
  const [data, setData] = createSignal<NormalizedProviderListResponse>()
  const query = { wanted: () => false, reads: [] as string[] }
  const load = (wanted: () => boolean) => {
    query.wanted = wanted
    return {
      get data() {
        if (getListener() && !getListener()?.user) query.reads.push("render computation")
        return data()
      },
    }
  }
  return { load, setData, query }
}

async function until(done: () => boolean) {
  for (const _ of Array.from({ length: 100 })) {
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("timed out waiting for the catalog query to be enabled")
}

describe("createProviderLookup", () => {
  test("loads nothing until a lookup asks, then resolves providers once the catalog arrives", async () => {
    const fake = fakeQuery()
    const seen: (string | undefined)[] = []
    const dispose = createRoot((dispose) => {
      const lookup = createProviderLookup(fake.load)
      createMemo(() => seen.push(lookup("retired")?.name))
      return dispose
    })

    await until(() => fake.query.wanted())
    expect(seen).toEqual([undefined])

    fake.setData(catalog("retired"))
    expect(seen).toEqual([undefined, "RETIRED"])
    dispose()
  })

  test("does not enable the catalog query while no lookup has asked", async () => {
    const fake = fakeQuery()
    const dispose = createRoot((dispose) => {
      createProviderLookup(fake.load)
      return dispose
    })

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fake.query.wanted()).toBe(false)
    dispose()
  })

  test("reads the query data only from a user effect, never from a render computation", async () => {
    const fake = fakeQuery()
    const dispose = createRoot((dispose) => {
      const lookup = createProviderLookup(fake.load)
      // The way the session route calls it: inside a memo.
      createMemo(() => lookup("retired"))
      return dispose
    })
    await until(() => fake.query.wanted())
    fake.setData(catalog("retired"))

    expect(fake.query.reads).toEqual([])
    dispose()
  })
})
