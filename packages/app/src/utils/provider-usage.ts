export type UsageWindow = { id: string; percent?: number; count?: number; resetsAt?: number }

export type UsageEntry = { providerID: string; windows: UsageWindow[] }

export type UsageMap = Record<string, { windows?: UsageWindow[] }>

// Sentinel provider the router plugin injects; it is a picker entry, not a
// connection with usage.
export const ROUTER_PROVIDER_ID = "model-router"

// Quota windows with a percent of a plan limit render before count-only
// windows, in a stable label order (session plans read before weekly plans).
const PERCENT_WINDOW_ORDER = ["session", "primary", "weekly", "secondary", "daily", "monthly"]

export function orderedWindows(windows: UsageWindow[]): UsageWindow[] {
  const rank = (id: string) => {
    const index = PERCENT_WINDOW_ORDER.indexOf(id)
    return index === -1 ? PERCENT_WINDOW_ORDER.length : index
  }
  const percent = windows
    .filter((window) => window.percent !== undefined)
    .sort((a, b) => rank(a.id) - rank(b.id))
  const counts = windows.filter((window) => window.percent === undefined && window.count !== undefined)
  return [...percent, ...counts]
}

// The reported window closest to its limit; the number worth watching.
export function bindingWindow(windows: UsageWindow[]): UsageWindow | undefined {
  return orderedWindows(windows)
    .filter((window) => window.percent !== undefined)
    .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0]
}

// One meter row per enabled provider: every connected provider shows, plus
// any provider that reports usage on its own, router excluded, name-sorted.
export function usageEntries(
  input: {
    connected: Array<{ id: string; name: string }>
    usage: UsageMap | undefined
    extraIDs?: string[]
  },
): Array<{ providerID: string; name: string; windows: UsageWindow[] }> {
  const rows = new Map<string, { providerID: string; name: string; windows: UsageWindow[] }>()
  for (const id of input.extraIDs ?? []) {
    if (id === ROUTER_PROVIDER_ID || rows.has(id)) continue
    rows.set(id, { providerID: id, name: id, windows: [] })
  }
  for (const provider of input.connected) {
    if (provider.id === ROUTER_PROVIDER_ID || rows.has(provider.id)) continue
    rows.set(provider.id, { providerID: provider.id, name: provider.name, windows: [] })
  }
  if (input.usage) {
    for (const entry of Object.entries(input.usage)) {
      const [providerID, value] = entry
      if (!Array.isArray(value?.windows) || providerID === ROUTER_PROVIDER_ID || rows.has(providerID)) continue
      rows.set(providerID, { providerID, name: providerID, windows: value.windows })
    }
  }
  return [...rows.values()].sort(
    (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.providerID.localeCompare(b.providerID),
  )
}

// Reset timestamps render short, with the date once it is beyond today.
export function formatResetTime(resetsAt: number, now: number) {
  const date = new Date(resetsAt)
  const sameDay =
    new Date(now).getFullYear() === date.getFullYear() &&
    new Date(now).getMonth() === date.getMonth() &&
    new Date(now).getDate() === date.getDate()
  if (sameDay) return date.toLocaleTimeString(undefined, { timeStyle: "short" })
  return date.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
}

export function windowLabel(t: (key: string) => string, id: string) {
  if (id === "session") return t("provider.usage.window.session")
  if (id === "weekly") return t("provider.usage.window.weekly")
  if (id === "primary") return t("provider.usage.window.primary")
  if (id === "secondary") return t("provider.usage.window.secondary")
  if (id === "daily") return t("provider.usage.window.daily")
  if (id === "monthly") return t("provider.usage.window.monthly")
  return id
}

// 1423 requests -> 1.4k; a count row keeps this short.
export function formatRequestCount(count: number) {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(Math.round(count))
}
