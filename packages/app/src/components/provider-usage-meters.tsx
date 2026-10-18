import { createQuery } from "@tanstack/solid-query"
import { ProgressCircle } from "@flynncode/ui/progress-circle"
import { TooltipV2 } from "@flynncode/ui/v2/tooltip-v2"
import { For, Show, createMemo, type Accessor, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { getSessionContext } from "@/components/session/session-context-metrics"

type UsageWindow = { id: string; percent?: number; count?: number; resetsAt?: number }

type UsageEntry = { providerID: string; windows: UsageWindow[] }

type Row = { text: string }

function windowLabel(t: (key: string) => string, id: string) {
  if (id === "session") return t("provider.usage.window.session")
  if (id === "weekly") return t("provider.usage.window.weekly")
  if (id === "primary") return t("provider.usage.window.primary")
  if (id === "secondary") return t("provider.usage.window.secondary")
  if (id === "daily") return t("provider.usage.window.daily")
  if (id === "monthly") return t("provider.usage.window.monthly")
  return id
}

function formatCount(count: number) {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(Math.round(count))
}

// Sentinel provider the router plugin injects; it is a picker entry, not a
// connection with usage.
const ROUTER_PROVIDER_ID = "model-router"

export function ProviderUsageMeters(props: {
  row?: boolean
  // "providers" (default) renders one flat meter per reporting provider, as in
  // the session header; "rings" renders one concentric meter per connected
  // provider: an inner context band (the open session), a session quota band,
  // and a weekly quota band.
  variant?: "providers" | "rings"
  sessionID?: Accessor<string | undefined>
}) {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const providers = useProviders(() => undefined)

  const query = createQuery(() => ({
    queryKey: [serverSDK().scope, null, "provider-usage"],
    queryFn: async ({ signal }) => {
      const result = await serverSDK().client.provider.usage(undefined, { signal })
      return (result.data ?? {}) as Record<string, { windows?: UsageWindow[] }>
    },
    // Minute-level freshness: the server aggregates on a 60s cache, so the two
    // clocks line up instead of stacking provider requests.
    refetchInterval: 60_000,
    staleTime: 60_000,
    retry: false,
  }))

  const messages = createMemo(() => {
    const sessionID = props.sessionID?.()
    if (!sessionID) return []
    return serverSync().session.data.message[sessionID] ?? []
  })

  const context = createMemo(() => getSessionContext(messages(), [...providers.all().values()]))

  const entries = createMemo((): UsageEntry[] => {
    const data = query.data
    if (!data) return []
    return Object.entries(data)
      .filter((entry): entry is [string, { windows: UsageWindow[] }] => Array.isArray(entry[1]?.windows))
      .map(([providerID, usage]) => ({ providerID, windows: usage.windows ?? [] }))
  })

  const rings = createMemo(() => {
    const engaged = context()
    const ids = new Set<string>()
    if (engaged) ids.add(engaged.message.providerID)
    for (const entry of entries()) ids.add(entry.providerID)
    for (const provider of providers.connected()) ids.add(provider.id)
    ids.delete(ROUTER_PROVIDER_ID)
    return [...ids]
      .map((providerID) => ({
        providerID,
        name: providers.all().get(providerID)?.name ?? providerID,
        windows: query.data?.[providerID]?.windows ?? [],
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  const ringRows = (providerID: string, windows: UsageWindow[]): Row[] => {
    const engaged = context()
    const rows: Row[] = []
    if (engaged && engaged.message.providerID === providerID && engaged.usage !== null) {
      rows.push({ text: language.t("provider.usage.contextRow", { percent: Math.round(engaged.usage) }) })
    }
    for (const id of ["session", "primary", "weekly", "secondary"] as const) {
      const window = windows.find((window) => window.id === id && window.percent !== undefined)
      if (!window) continue
      rows.push({
        text: language.t("provider.usage.row", {
          label: windowLabel(language.t, window.id),
          percent: Math.round(window.percent ?? 0),
        }),
      })
    }
    for (const window of windows.filter((window) => window.count !== undefined)) {
      rows.push({
        text: language.t("provider.usage.countRow", {
          label: windowLabel(language.t, window.id),
          count: formatCount(window.count!),
        }),
      })
    }
    if (rows.length === 0) rows.push({ text: language.t("provider.usage.none") })
    return rows
  }

  // Concentric bands inside one provider meter: an inner context band, the
  // session quota, and the weekly quota. Bands with nothing to report render
  // as track only, so every connected provider still shows its circle.
  const bandsFor = (providerID: string, windows: UsageWindow[]) => {
    const engaged = context()
    const contextPercent =
      engaged && engaged.message.providerID === providerID && engaged.usage !== null ? engaged.usage : undefined
    const session = windows.find((window) => (window.id === "session" || window.id === "primary") && window.percent !== undefined)
    const weekly = windows.find((window) => (window.id === "weekly" || window.id === "secondary") && window.percent !== undefined)
    return [
      { radius: 5.5, percent: contextPercent },
      { radius: 11, percent: session?.percent },
      { radius: 16.5, percent: weekly?.percent },
    ]
  }

  const ariaFor = (name: string, rows: Row[]) => language.t("provider.usage.ringMeter", { provider: name, parts: rows.map((row) => row.text).join("; ") })

  function UsageRing(props: { name: string; providerID: string; windows: UsageWindow[] }) {
    const bands = createMemo(() => bandsFor(props.providerID, props.windows))
    const rows = createMemo(() => ringRows(props.providerID, props.windows))
    const circumference = (radius: number) => 2 * Math.PI * radius
    return (
      <TooltipV2 placement="bottom" value={ringTooltip(props.name, rows())}>
        <button
          type="button"
          class="flex cursor-pointer items-center justify-center"
          role="img"
          aria-label={ariaFor(props.name, rows())}
          onClick={() => void query.refetch()}
        >
          <svg width="20" height="20" viewBox="0 0 40 40" fill="none" aria-hidden="true">
            <For each={bands()}>
              {(band) => {
                const clamped = Math.max(0, Math.min(100, band.percent ?? 0))
                return (
                  <>
                    <circle
                      cx="20"
                      cy="20"
                      r={band.radius}
                      stroke="var(--v2-border-border-muted)"
                      stroke-width="4.5"
                    />
                    <Show when={band.percent !== undefined}>
                      <circle
                        cx="20"
                        cy="20"
                        r={band.radius}
                        stroke={clamped >= 90 ? "var(--v2-state-fg-danger)" : "var(--v2-icon-icon-base)"}
                        stroke-width="4.5"
                        stroke-linecap="round"
                        stroke-dasharray={`${(clamped / 100) * circumference(band.radius)} ${circumference(band.radius)}`}
                        transform="rotate(-90 20 20)"
                      />
                    </Show>
                  </>
                )
              }}
            </For>
          </svg>
        </button>
      </TooltipV2>
    )
  }

  // First line names the service so a hovered ring is identifiable; the rest
  // is one line per band: Context/Session/Weekly percent (or count rows).
  function ringTooltip(name: string, rows: Row[]) {
    return (
      <div>
        <div>{name}</div>
        <For each={rows}>{(row) => <div>{row.text}</div>}</For>
      </div>
    )
  }

  const ringStrip = () => (
    <For each={rings()}>
      {(ring) => <UsageRing name={ring.name} providerID={ring.providerID} windows={ring.windows} />}
    </For>
  )

  const providerStrip = () => (
    <For each={entries()}>
      {(entry) => {
        // Circles need a plan limit; providers that only report counts render
        // as count pills on the first count window instead.
        const percent = entry.windows.find((window) => window.percent !== undefined)?.percent
        const count = entry.windows.find((window) => window.count !== undefined)?.count
        const rows = entry.windows.flatMap((window) => {
          if (window.percent !== undefined)
            return [
              language.t("provider.usage.row", {
                label: windowLabel(language.t, window.id),
                percent: Math.round(window.percent),
              }),
            ]
          if (window.count !== undefined)
            return [
              language.t("provider.usage.countRow", {
                label: windowLabel(language.t, window.id),
                count: formatCount(window.count),
              }),
            ]
          return []
        })
        return (
          <TooltipV2
            placement="bottom"
            value={
              <div class="flex flex-col">
                <For each={rows}>{(row) => <div>{row}</div>}</For>
              </div>
            }
          >
            <Show
              when={percent !== undefined}
              fallback={
                <div
                  class="flex cursor-pointer items-center justify-center"
                  role="img"
                  aria-label={language.t("provider.usage.meterCount", { provider: entry.providerID, count: count ?? 0 })}
                  onClick={() => void query.refetch()}
                >
                  <span class="rounded-full bg-v2-overlay-simple-overlay-hover px-1.5 text-11-medium text-v2-text-text-muted">
                    {formatCount(count ?? 0)}
                  </span>
                </div>
              }
            >
              <button
                type="button"
                class="flex cursor-pointer items-center justify-center"
                role="img"
                aria-label={language.t("provider.usage.meter", { provider: entry.providerID, percent: Math.round(percent ?? 0) })}
                onClick={() => void query.refetch()}
              >
                <ProgressCircle
                  size={16}
                  strokeWidth={2}
                  percentage={percent ?? 0}
                  style={
                    (percent ?? 0) >= 90
                      ? { "--progress-circle-progress": "var(--v2-state-fg-danger)" }
                      : { "--progress-circle-progress": "var(--v2-icon-icon-base)" }
                  }
                />
              </button>
            </Show>
          </TooltipV2>
        )
      }}
    </For>
  )

  const visible = createMemo(() =>
    props.variant === "rings" ? rings().length > 0 : entries().some((entry) => entry.windows.length > 0),
  )

  return (
    <Show when={visible()}>
      <div class="flex items-center gap-1" classList={{ "min-h-7 w-full px-2.5": !!props.row }}>
        <Show when={props.variant === "rings"} fallback={providerStrip()}>
          {ringStrip()}
        </Show>
      </div>
    </Show>
  )
}