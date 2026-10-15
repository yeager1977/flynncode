import { createQuery } from "@tanstack/solid-query"
import { ProgressCircle } from "@flynncode/ui/progress-circle"
import { TooltipV2 } from "@flynncode/ui/v2/tooltip-v2"
import { For, Show, createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useServerSDK } from "@/context/server-sdk"

type UsageWindow = { id: string; percent: number; resetsAt?: number }

type UsageEntry = { providerID: string; name: string; percent: number; windows: UsageWindow[] }

function windowLabel(t: (key: string) => string, id: string) {
  if (id === "session") return t("provider.usage.window.session")
  if (id === "weekly") return t("provider.usage.window.weekly")
  if (id === "primary") return t("provider.usage.window.primary")
  if (id === "secondary") return t("provider.usage.window.secondary")
  return id
}

function formatTime(resetsAt: number | undefined) {
  if (resetsAt === undefined) return undefined
  return new Date(resetsAt).toLocaleTimeString()
}

export function ProviderUsageMeters() {
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
      .map(([providerID, usage]) => ({
        providerID,
        name: providers.all().get(providerID)?.name ?? providerID,
        percent: usage.windows[0].percent,
        windows: usage.windows,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  return (
    <Show when={entries().length > 0}>
      <div class="flex shrink-0 items-center gap-1">
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
                    }}
                  </For>
                </div>
              }
            >
              <div class="flex items-center justify-center" role="img" aria-label={language.t("provider.usage.meter", { provider: entry.name, percent: Math.round(entry.percent) })}>
                <ProgressCircle
                  size={16}
                  strokeWidth={2}
                  percentage={entry.percent}
                  style={
                    entry.percent >= 90
                      ? { "--progress-circle-progress": "var(--v2-state-fg-danger)" }
                      : { "--progress-circle-progress": "var(--v2-icon-icon-base)" }
                  }
                />
              </div>
            </TooltipV2>
          )}
        </For>
      </div>
    </Show>
  )
}
