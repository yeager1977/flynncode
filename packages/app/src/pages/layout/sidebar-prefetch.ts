import { type Accessor, createEffect } from "solid-js"

// Opening a session loads its newest page (20 messages); warming more than that only adds boot contention.
export const NEIGHBOUR_PREFETCH_MESSAGES = 20

// Warms the routed session's direct neighbours once per routed session. The session list re-sorts on
// every session update, so it is read only until the routed session has been found in it.
export function createNeighbourWarmup<T extends { id: string }>(input: {
  enabled: Accessor<boolean>
  sessionID: Accessor<string | undefined>
  sessions: Accessor<T[]>
  warm: (session: T) => void
}) {
  const warmed = { id: undefined as string | undefined }
  createEffect(() => {
    if (!input.enabled()) return
    const current = input.sessionID()
    if (!current || current === warmed.id) return
    const sessions = input.sessions()
    const index = sessions.findIndex((session) => session.id === current)
    if (index === -1) return
    warmed.id = current
    ;[sessions[index + 1], sessions[index - 1]].filter((session) => session !== undefined).forEach(input.warm)
  })
}
