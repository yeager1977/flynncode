import { createQuery } from "@tanstack/solid-query"
import { ProgressCircle } from "@flynncode/ui/progress-circle"
import { TooltipV2 } from "@flynncode/ui/v2/tooltip-v2"
import { For, Show, createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useServerSDK } from "@/context/server-sdk"

type UsageWindow = { id: string; percent?: number; count?: number; resetsAt?: number }

type UsageEntry = { providerID: string; name: string; percent?: number; count?: number; windows: UsageWindow[] }

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

export function ProviderUsageMeters(props: { row?: boolean }) {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const providers = useProviders(() => undefined)

  const query = createQuery(() => ({
    queryKey: [serverSDK().scope, null, "provider-usage"],
    queryFn: async ({ signal }) => {
      const result = await serverSDK().client.provider.usage(undefined, { signal })
      return (result.data ?? {}) as Record<string, { windows?: UsageWindow[] }>
    },
    refetchInterval: 120_000,
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
      .map(([providerID, usage]) => {
        const windows = usage.windows
        // Circles need a plan limit; providers that only report counts render
        // as count pills on the first count window instead.
        const percent = windows.find((window) => window.percent !== undefined)?.percent
        const count = windows.find((window) => window.count !== undefined)?.count
        return {
          providerID,
          name: providers.all().get(providerID)?.name ?? providerID,
          ...(percent !== undefined ? { percent } : {}),
          ...(count !== undefined ? { count } : {}),
          windows,
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  return (
    <Show when={entries().length > 0}>
      <div
        class="flex items-center gap-1"
        classList={{ "min-h-7 w-full px-2.5": !!props.row }}
      >
        <For each={entries()}>
          {(entry) => (
            <TooltipV2
              placement="bottom"
              value={
                <div class="flex flex-col gap-1">
                  <div>{entry.name}</div>
                  <For each={entry.windows}>
                    {(window) => {
                      const time = formatTime(window.resetsAt)
                      if (window.percent !== undefined)
                        return (
                          <div>
                            {time
                              ? language.t("provider.usage.rowResets", {
                                  label: windowLabel(language.t, window.id),
                                  percent: Math.round(window.percent),
                                  time,
                                })
                              : language.t("provider.usage.row", {
                                  label: windowLabel(language.t, window.id),
                                  percent: Math.round(window.percent),
                                })}
                          </div>
                        )
                      if (window.count !== undefined)
                        return (
                          <div>
                            {time
                              ? language.t("provider.usage.countRowResets", {
                                  label: windowLabel(language.t, window.id),
                                  count: formatCount(window.count),
                                  time,
                                })
                              : language.t("provider.usage.countRow", {
                                  label: windowLabel(language.t, window.id),
                                  count: formatCount(window.count),
                                })}
                          </div>
                        )
                      return <div>{windowLabel(language.t, window.id)}</div>
                    }}
                  </For>
                </div>
              }
            >
              <Show
                when={entry.percent !== undefined}
                fallback={
                  <div class="flex items-center justify-center" role="img" aria-label={language.t("provider.usage.meterCount", { provider: entry.name, count: entry.count ?? 0 })}>
                    <span class="rounded-full bg-v2-overlay-simple-overlay-hover px-1.5 text-11-medium text-v2-text-text-muted">
                      {formatCount(entry.count ?? 0)}
                    </span>
                  </div>
                }
              >
                <div class="flex items-center justify-center" role="img" aria-label={language.t("provider.usage.meter", { provider: entry.name, percent: Math.round(entry.percent ?? 0) })}>
                  <ProgressCircle
                    size={16}
                    strokeWidth={2}
                    percentage={entry.percent ?? 0}
                    style={
                      (entry.percent ?? 0) >= 90
                        ? { "--progress-circle-progress": "var(--v2-state-fg-danger)" }
                        : { "--progress-circle-progress": "var(--v2-icon-icon-base)" }
                    }
                  />
                </div>
              </Show>
            </TooltipV2>
          )}
        </For>
      </div>
    </Show>
  )
}