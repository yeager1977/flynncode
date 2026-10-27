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
// Outputs keep the input order (the MCP tool order), so a request with nothing
// deferred is identical to one built without deferral.
export function plan(input: Input): Plan {
  if (input.disabled) return { sent: input.tools, deferred: [] }
  const overThreshold = input.tools.length > input.threshold
  const deferred = input.tools.filter((id) => {
    if (input.loaded.has(id)) return false
    const defer = input.servers[input.serverOf(id)]?.defer
    return defer ?? overThreshold
  })
  const skip = new Set(deferred)
  return { sent: input.tools.filter((id) => !skip.has(id)), deferred }
}
