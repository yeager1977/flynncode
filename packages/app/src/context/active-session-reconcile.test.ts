import { beforeAll, describe, expect, it, mock } from "bun:test"

// The `solid` test condition resolves solid-js to its SSR build, where
// createEffect is a no-op. Point it at the client build before the module
// under test resolves solid-js (same convention as session-composer-state).
let reconcile: typeof import("./active-session-reconcile")
let solid: typeof import("solid-js")

beforeAll(async () => {
  // @ts-expect-error - deep import has no declaration file
  mock.module("solid-js", async () => await import("solid-js/dist/solid.js"))
  solid = await import("solid-js")
  reconcile = await import("./active-session-reconcile")
})

describe("active session refetch wiring", () => {
  it("flushes one queued refetch once the in-flight fetch settles", () => {
    const [isFetching, setFetching] = solid.createSignal(true)
    let refetches = 0
    const query = {
      get isFetching() {
        return isFetching()
      },
      refetch: () => {
        refetches++
        setFetching(true)
      },
    }
    const root = solid.createRoot((dispose) => ({ dispose, refetch: reconcile.createActiveSessionRefetch(query) }))
    // Reconnect events arrive later, after the effect's first run saw an empty
    // queue: two reconnects while the first reconcile is still running.
    root.refetch.connected()
    root.refetch.connected()
    expect(refetches).toBe(0)

    setFetching(false)
    expect(refetches).toBe(1)

    // The follow-up is one-shot: settling again does not refetch again.
    setFetching(false)
    expect(refetches).toBe(1)
    root.dispose()
  })
})

// A reconnect that arrives while the active-session reconcile fetch is already
// running must queue exactly one follow-up refetch instead of skipping it —
// skipping leaves sessions whose live status events were missed pinned "busy"
// in the subagent list until the next reconnect.

describe("active session reconnect reconcile", () => {
  it("refetches immediately when no fetch is in flight", () => {
    expect(reconcile.activeSessionRefetchPlan({ connected: true, isFetching: false, queued: false })).toEqual({
      refetch: true,
      queue: false,
    })
  })

  it("queues a follow-up when a fetch is already in flight", () => {
    expect(reconcile.activeSessionRefetchPlan({ connected: true, isFetching: true, queued: false })).toEqual({
      refetch: false,
      queue: true,
    })
    // Idempotent while the fetch keeps running.
    expect(reconcile.activeSessionRefetchPlan({ connected: true, isFetching: true, queued: true })).toEqual({
      refetch: false,
      queue: true,
    })
  })

  it("flushes the queued follow-up once the fetch settles", () => {
    expect(reconcile.activeSessionRefetchPlan({ connected: true, isFetching: false, queued: true })).toEqual({
      refetch: true,
      queue: false,
    })
  })

  it("ignores non-connect events", () => {
    expect(reconcile.activeSessionRefetchPlan({ connected: false, isFetching: false, queued: false })).toEqual({
      refetch: false,
      queue: false,
    })
  })
})
