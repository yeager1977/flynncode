export * as McpDefer from "./defer"

export type Input = {
  /** Visible MCP tool ids (after permission filtering). */
  tools: string[]
  servers: Record<string, { defer?: boolean }>
  serverOf: (id: string) => string
  threshold: number
  loaded: ReadonlySet<string>
  disabled: boolean
}

export type Plan = { sent: string[]; deferred: string[] }

// Pure so callers can recompute per provider step: the plan only changes when the
// tool list, config, or loaded set changes, which keeps the prompt prefix stable.
export function plan(input: Input): Plan {
  const sorted = input.tools.toSorted()
  if (input.disabled) return { sent: sorted, deferred: [] }
  const overThreshold = sorted.length > input.threshold
  const deferred = sorted.filter((id) => {
    if (input.loaded.has(id)) return false
    const defer = input.servers[input.serverOf(id)]?.defer
    return defer ?? overThreshold
  })
  const skip = new Set(deferred)
  return { sent: sorted.filter((id) => !skip.has(id)), deferred }
}
