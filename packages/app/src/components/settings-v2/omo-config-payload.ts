import type { FallbackChain } from "./omo-catalog"

export type Pin = "automatic" | "inherit" | { model: string; variant?: string }

export type PayloadInput = {
  scope: "global" | "project"
  shownProviders: readonly string[]
  checked: readonly string[]
  hiddenBans: readonly string[]
  globalOpenCodeBans: readonly string[]
  globalPluginBans: readonly string[]
  agents: Record<string, Pin>
  categories: Record<string, Pin>
  existingAgents: Record<string, Record<string, unknown>>
  existingCategories: Record<string, Record<string, unknown>>
}

export function pluginPatch(input: PayloadInput) {
  return {
    agents: mapPins(input.agents, input.existingAgents),
    categories: mapPins(input.categories, input.existingCategories),
    disabledProviders:
      input.scope === "project"
        ? input.checked.filter((id) => !input.globalPluginBans.includes(id))
        : [...input.checked],
  }
}

export function openCodeBans(input: PayloadInput): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  const add = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    result.push(id)
  }
  input.hiddenBans.forEach(add)
  if (input.scope === "project") input.globalOpenCodeBans.forEach(add)
  input.checked.forEach(add)
  return result
}

export function fallbackLabel(chain: FallbackChain, connected: ReadonlySet<string>) {
  for (const entry of chain) {
    const provider = entry.providers.find((id) => connected.has(id))
    if (provider !== undefined) return { model: `${provider}/${entry.model}`, connected: true }
  }
  const head = chain[0]
  return { model: `${head.providers[0]}/${head.model}`, connected: false }
}

function mapPins(
  pins: Record<string, Pin>,
  existing: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown> | null> {
  return Object.fromEntries(Object.entries(pins).map(([key, pin]) => [key, resolvePin(pin, existing[key])]))
}

function resolvePin(pin: Pin, existing: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (pin === "inherit") return null
  const base: Record<string, unknown> = { ...(existing ?? {}) }
  delete base.model
  delete base.variant
  if (pin === "automatic") return Object.keys(base).length === 0 ? null : base
  base.model = pin.model
  if (pin.variant !== undefined && pin.variant.trim() !== "") base.variant = pin.variant
  return base
}
