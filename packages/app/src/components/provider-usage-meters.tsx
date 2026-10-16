import { createQuery } from "@tanstack/solid-query"
import { ProgressCircle } from "@flynncode/ui/progress-circle"
import { TooltipV2 } from "@flynncode/ui/v2/tooltip-v2"
import { For, Match, Show, Switch, createMemo, type Accessor } from "solid-js"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { getSessionContext } from "@/components/session/session-context-metrics"

type UsageWindow = { id: string; percent?: number; count?: number; resetsAt?: number }

type UsageEntry = { providerID: string; name: string; windows: UsageWindow[] }

type Ring = {
  id: string
  percent: number
  title: string
  rows: Array<{ name?: string; value: string }>
}

function windowLabel(t: (key: string) => string, id: string) {
  if (id === "session") return t("provider.usage.window.session")
  if (id === "weekly") return t("provider.usage.window.weekly")
  if (id === "primary") return t("provider.usage.window.primary")
  if (id === "secondary") return t("provider.usage.window.secondary")
  if (id === "daily") return t("provider.usage.window.daily")
  if (id === "monthly") return t("provider.usage.window.monthly")
  return id
}

function formatTime(resetsAt: number | undefined) {
  if (resetsAt === undefined) return undefined
  return new Date(resetsAt).toLocaleTimeString()
}

function formatCount(count: number) {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(Math.round(count))
}

export function ProviderUsageMeters(props: {
  row?: boolean
  // "providers" (default) renders one meter per reporting provider, as in the
  // session header; "rings" renders the working three: the open session's
  // context window plus the engaged provider's two quota windows.
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

  const entries = createMemo((): UsageEntry[] => {
    const data = query.data
    if (!data) return []
    return Object.entries(data)
      .filter(
        (entry): entry is [string, { windows: UsageWindow[] }] =>
          Array.isArray(entry[1]?.windows) && entry[1].windows.length > 0,
      )
      .map(([providerID, usage]) => ({
        providerID,
        name: providers.all().get(providerID)?.name ?? providerID,
        windows: usage.windows,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  const messages = createMemo(() => {
    const sessionID = props.sessionID?.()
    if (!sessionID) return []
    return serverSync().session.data.message[sessionID] ?? []
  })

  const context = createMemo(() => getSessionContext(messages(), [...providers.all().values()]))

  // The rings' quota windows follow the provider the session actually engaged
  // (the model behind its latest turn) when it reports utilization; count-only
  // or fresh-cold sessions fall through to the first reporting provider so the
  // rings stay visible on home and on providers without plan caps.
  const ringWindows = createMemo((): UsageEntry | undefined => {
    const engaged = entries().find((entry) => entry.providerID === context()?.message.providerID)
    const reporting = (entry: UsageEntry | undefined) =>
      entry?.windows.some((window) => window.percent !== undefined) ? entry : undefined
    return reporting(engaged) ?? entries().find((entry) => entry.windows.some((window) => window.percent !== undefined))
  })

  const rings = createMemo((): Ring[] => {
    const rings: Ring[] = []
    const used = context()
    if (used && used.usage !== null) {
      rings.push({
        id: "context",
        percent: used.usage,
        title: `${used.providerLabel} / ${used.modelLabel}`,
        rows: [
          { name: language.t("context.usage.usage"), value: `${Math.round(used.usage)}%` },
          {
            name: language.t("context.usage.tokens"),
            value: used.total.toLocaleString(language.intl()),
          },
        ],
      })
    }
    const entry = ringWindows()
    if (entry) {
      for (const window of entry.windows.filter((window) => window.percent !== undefined).slice(0, 2)) {
        const time = formatTime(window.resetsAt)
        rings.push({
          id: `${entry.providerID}:${window.id}`,
          percent: window.percent ?? 0,
          title: entry.name,
          rows: [
            {
              value: time
                ? language.t("provider.usage.rowResets", {
                    label: windowLabel(language.t, window.id),
                    percent: Math.round(window.percent ?? 0),
                    time,
                  })
                : language.t("provider.usage.row", {
                    label: windowLabel(language.t, window.id),
                    percent: Math.round(window.percent ?? 0),
                  }),
            },
          ],
        })
      }
    }
    return rings
  })

  const tooltipValue = (content: import("solid-js").JSX.Element) => (
    <div class="flex w-[170px] flex-col gap-1">
      {content}
      <div class="text-v2-text-text-faint">{language.t("provider.usage.clickRefresh")}</div>
    </div>
  )

  const ringStrip = () => (
    <For each={rings()}>
      {(ring) => (
        <TooltipV2 placement="bottom" value={tooltipValue(
          <>
            <div class="font-medium">{ring.title}</div>
            <For each={ring.rows}>
              {(row) => (
                <Show when={row.name} fallback={<div>{row.value}</div>}>
                  {(name) => (
                    <div class="flex min-w-0 items-center justify-between gap-3">
                      <span class="text-v2-text-text-muted">{name()}</span>
                      <span class="min-w-0 truncate text-right">{row.value}</span>
                    </div>
                  )}
                </Show>
              )}
            </For>
          </>,
        )}>
          <button
            type="button"
            class="flex cursor-pointer items-center justify-center"
            role="img"
            aria-label={language.t(
              ring.id === "context" ? "provider.usage.contextMeter" : "provider.usage.meter",
              ring.id === "context"
                ? { percent: Math.round(ring.percent) }
                : { provider: ring.title, percent: Math.round(ring.percent) },
            )}
            onClick={() => void query.refetch()}
          >
            <ProgressCircle
              size={16}
              strokeWidth={2}
              percentage={ring.percent}
              style={
                ring.percent >= 90
                  ? { "--progress-circle-progress": "var(--v2-state-fg-danger)" }
                  : { "--progress-circle-progress": "var(--v2-icon-icon-base)" }
              }
            />
          </button>
        </TooltipV2>
      )}
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
          const time = formatTime(window.resetsAt)
          if (window.percent !== undefined)
            return [
              time
                ? language.t("provider.usage.rowResets", {
                    label: windowLabel(language.t, window.id),
                    percent: Math.round(window.percent),
                    time,
                  })
                : language.t("provider.usage.row", {
                    label: windowLabel(language.t, window.id),
                    percent: Math.round(window.percent),
                  }),
            ]
          if (window.count !== undefined)
            return [
              time
                ? language.t("provider.usage.countRowResets", {
                    label: windowLabel(language.t, window.id),
                    count: formatCount(window.count),
                    time,
                  })
                : language.t("provider.usage.countRow", {
                    label: windowLabel(language.t, window.id),
                    count: formatCount(window.count),
                  }),
            ]
          return []
        })
        return (
          <TooltipV2
            placement="bottom"
            value={tooltipValue(
              <>
                <div class="font-medium">{entry.name}</div>
                <For each={rows}>{(row) => <div>{row}</div>}</For>
              </>,
            )}
          >
            <Show
              when={percent !== undefined}
              fallback={
                <div
                  class="flex cursor-pointer items-center justify-center"
                  role="img"
                  aria-label={language.t("provider.usage.meterCount", { provider: entry.name, count: count ?? 0 })}
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
                aria-label={language.t("provider.usage.meter", { provider: entry.name, percent: Math.round(percent ?? 0) })}
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

  return (
    <Show when={props.variant === "rings" ? rings().length > 0 : entries().length > 0}>
      <div class="flex items-center gap-1" classList={{ "min-h-7 w-full px-2.5": !!props.row }}>
        <Show when={props.variant === "rings"} fallback={providerStrip()}>
          {ringStrip()}
        </Show>
      </div>
    </Show>
  )
}