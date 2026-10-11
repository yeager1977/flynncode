import { ConfigHooksV1 } from "@opencode-ai/core/v1/config/hooks"

export function matchesMatcher(toolOrSource: string, matcher: string | undefined) {
  if (!matcher) return true
  if (matcher === "") return true
  if (matcher === "*") return true
  try {
    return new RegExp(matcher).test(toolOrSource)
  } catch {
    // Invalid patterns never match rather than crashing the tool call.
    return false
  }
}

export function filterGroups(groups: Array<ConfigHooksV1.HookGroup>, toolOrSource: string) {
  return groups.filter((group) => matchesMatcher(toolOrSource, group.matcher))
}

// Plan form: (event, name, groups). The event is reserved for future
// event-scoped matching; filtering is by tool/source name today.
export function matchHooks(
  event: string,
  name: string | undefined,
  groups: Array<ConfigHooksV1.HookGroup>,
) {
  void event
  return filterGroups(groups, name ?? "")
}

function lookup(path: string, payload: Record<string, unknown>) {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === "object" && key in acc) return (acc as Record<string, unknown>)[key]
    return undefined
  }, payload)
}

const wholePlaceholder = /^\$\{([a-zA-Z0-9_.]+)\}$/

export function expandValue(template: unknown, payload: Record<string, unknown>): unknown {
  if (typeof template === "string") {
    const whole = wholePlaceholder.exec(template)
    if (whole) return lookup(whole[1], payload)
    return template.replace(/\$\{([a-zA-Z0-9_.]+)\}/g, (_m, p: string) => String(lookup(p, payload) ?? ""))
  }
  if (Array.isArray(template)) return template.map((item) => expandValue(item, payload))
  if (template !== null && typeof template === "object") {
    return Object.fromEntries(
      Object.entries(template as Record<string, unknown>).map((entry) => [entry[0], expandValue(entry[1], payload)]),
    )
  }
  return template
}

export function expandMcpInput(
  template: Record<string, unknown> | undefined,
  payload: Record<string, unknown>,
) {
  if (!template) return {}
  const expanded = expandValue(template, payload)
  if (expanded !== null && typeof expanded === "object" && !Array.isArray(expanded)) {
    return expanded as Record<string, unknown>
  }
  return {}
}

export function mergeHooksConfigs(
  ...layers: Array<ConfigHooksV1.Info | undefined>
) {
  const merged: Record<string, Array<ConfigHooksV1.HookGroup>> = {}
  // The kill switch is fail-safe: any layer enabling it keeps every hook
  // disabled, and a later layer without it never re-enables hooks.
  let disableAllHooks = false
  for (const layer of layers) {
    if (!layer) continue
    if (layer.disableAllHooks === true) disableAllHooks = true
    for (const entry of Object.entries(layer)) {
      const key = entry[0]
      // disableAllHooks is the kill-switch flag, not an event: never merged
      // as a groups array here.
      if (key === "disableAllHooks") continue
      const groups = entry[1] as Array<ConfigHooksV1.HookGroup> | undefined
      if (!Array.isArray(groups)) continue
      const existing = merged[key] ?? []
      merged[key] = [...existing, ...groups]
    }
  }
  return (disableAllHooks ? { ...merged, disableAllHooks: true } : merged) as ConfigHooksV1.Info
}

export * as HooksConfig from "./config"
