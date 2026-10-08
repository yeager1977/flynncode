import { ConfigHooksV1 } from "@opencode-ai/core/v1/config/hooks"

export function matchesMatcher(toolOrSource: string, matcher: string | undefined) {
  if (!matcher) return true
  if (matcher === "") return true
  if (matcher === "*") return true
  return new RegExp(matcher).test(toolOrSource)
}

export function filterGroups(groups: Array<ConfigHooksV1.HookGroup>, toolOrSource: string) {
  return groups.filter((group) => matchesMatcher(toolOrSource, group.matcher))
}

export function matchHooks(toolOrSource: string, matcher: string | undefined): boolean
export function matchHooks(
  event: string,
  name: string | undefined,
  groups: Array<ConfigHooksV1.HookGroup>,
): Array<ConfigHooksV1.HookGroup>
export function matchHooks(
  eventOrTool: string,
  nameOrMatcher: string | undefined,
  groups?: Array<ConfigHooksV1.HookGroup>,
) {
  if (groups) return filterGroups(groups, nameOrMatcher ?? "")
  return matchesMatcher(eventOrTool, nameOrMatcher)
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

export function matchHooksGroups(groups: Array<ConfigHooksV1.HookGroup>, toolOrSource: string) {
  return filterGroups(groups, toolOrSource)
}

export function mergeHooksConfigs(
  ...layers: Array<ConfigHooksV1.Info | undefined>
) {
  const merged: Record<string, Array<ConfigHooksV1.HookGroup>> = {}
  for (const layer of layers) {
    if (!layer) continue
    for (const entry of Object.entries(layer)) {
      const key = entry[0]
      const groups = entry[1] as Array<ConfigHooksV1.HookGroup> | undefined
      if (!groups) continue
      const existing = merged[key] ?? []
      merged[key] = [...existing, ...groups]
    }
  }
  return merged as ConfigHooksV1.Info
}

export * as HooksConfig from "./config"
