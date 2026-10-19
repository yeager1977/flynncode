export * as ActiveSessionReconcile from "./active-session-reconcile"

import { createEffect } from "solid-js"

// Connected reconnects must always land a fresh active-session reconcile. If a
// reconnect arrives while a reconcile fetch is already running (a slow server
// makes that window long), skipping the refetch would leave sessions whose
// live status events were missed pinned "busy" until the next reconnect —
// their subagent cards keep reading "running" even after the work ended. So
// the plan queues exactly one follow-up refetch that flushes once the fetch
// settles. Pure so it can be tested without a query client.
export function activeSessionRefetchPlan(input: {
  connected: boolean
  isFetching: boolean
  queued: boolean
}): { refetch: boolean; queue: boolean } {
  if (!input.connected) return { refetch: false, queue: false }
  if (input.isFetching) return { refetch: false, queue: true }
  return { refetch: true, queue: false }
}

// Owns the queued flag shared by the reconnect handler and the flusher.
export function createActiveSessionRefetch(query: { readonly isFetching: boolean; refetch: () => unknown }) {
  let queued = false
  createEffect(() => {
    // Read the signal first: `queued` is a plain flag, so returning on it
    // before reading isFetching would leave the effect with no dependency and
    // the queued refetch would never flush.
    const fetching = query.isFetching
    if (!queued || fetching) return
    queued = false
    void query.refetch()
  })
  return {
    connected() {
      const plan = activeSessionRefetchPlan({ connected: true, isFetching: query.isFetching, queued })
      if (plan.refetch) void query.refetch()
      queued = plan.queue
    },
  }
}

