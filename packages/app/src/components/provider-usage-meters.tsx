import { Show, For, createMemo, type Accessor } from "solid-js"
import { ProgressCircle } from "@flynncode/ui/progress-circle"
import { TooltipV2 } from "@flynncode/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { useProviders } from "@/hooks/use-providers"
import { useProviderUsage } from "@/hooks/use-provider-usage"
import { getSessionContext } from "@/components/session/session-context-metrics"
import {
  bindingWindow,
  formatRequestCount,
  orderedWindows,
  usageEntries,
  windowLabel,
  type UsageWindow,
} from "@/utils/provider-usage"

type Row = { text: string }

// One circle per reporting provider, as in the session header ("providers"),
// or concentric rings per connected provider ("rings"), as in the sidebar: an
// inner context band (the open session), a session quota band, and a weekly
// quota band.
export function ProviderUsageMeters(props: {
  row?: boolean
  variant?: "providers" | "rings"
  sessionID?: Accessor<string | undefined>
}) {
  const language = useLanguage()
  const serverSync = useServerSync()
  const providers = useProviders(() => undefined)
  const query = useProviderUsage()

  const messages = createMemo(() => {
    const sessionID = props.sessionID?.()
    if (!sessionID) return []
    return serverSync().session.data.message[sessionID] ?? []
  })

  const context = createMemo(() => getSessionContext(messages(), [...providers.all().values()]))

  const rows = createMemo(() => {
    const engaged = context()
    return usageEntries({
      connected: providers.connected(),
      usage: query.data,
      extraIDs: engaged ? [engaged.message.providerID] : [],
    })
  })

  const ringRows = (providerID: string, windows: UsageWindow[]): Row[] => {
    const engaged = context()
    const rows: Row[] = []
    if (engaged && engaged.message.providerID === providerID && engaged.usage !== null)
      rows.push({ text: language.t("provider.usage.contextRow", { percent: Math.round(engaged.usage) }) })
    for (const window of orderedWindows(windows)) {
      if (window.percent !== undefined)
        rows.push({
          text: language.t("provider.usage.row", {
            label: windowLabel(language.t, window.id),
            percent: Math.round(window.percent),
          }),
        })
      else if (window.count !== undefined)
        rows.push({
          text: language.t("provider.usage.countRow", {
            label: windowLabel(language.t, window.id),
            count: formatRequestCount(window.count),
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
    const binding = createMemo(() => bindingWindow(props.windows))
    const circumference = (radius: number) => 2 * Math.PI * radius
    return (
      <TooltipV2 placement="bottom" value={ringTooltip(props.name, rows())}>
        <button
          type="button"
          class="flex cursor-pointer items-center justify-center gap-0.5"
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
          <Show when={binding()}>
            {(binding) => {
              const clamped = Math.max(0, Math.min(100, binding().percent ?? 0))
              return (
                <span
                  class="text-10-medium"
                  classList={{
                    "text-v2-state-fg-danger": clamped >= 90,
                    "text-v2-text-text-muted": clamped < 90,
                  }}
                >
                  {Math.round(clamped)}%
                </span>
              )
            }}
          </Show>
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
    <For each={rows()}>
      {(ring) => <UsageRing name={ring.name} providerID={ring.providerID} windows={ring.windows} />}
    </For>
  )

  const providerStrip = () => (
    <For
      each={query.data ? Object.entries(query.data).filter(([, value]) => Array.isArray(value?.windows)) : []}
    >
      {(entry) => {
        // Circles need a plan limit; providers that only report counts render
        // as count pills instead.
        const percent = bindingWindow(entry[1]?.windows ?? [])?.percent
        const count = (entry[1]?.windows ?? []).find((window) => window.count !== undefined)?.count
        const rows = orderedWindows(entry[1]?.windows ?? []).flatMap((window) => {
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
                count: formatRequestCount(window.count),
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
                  aria-label={language.t("provider.usage.meterCount", { provider: entry[0], count: count ?? 0 })}
                  onClick={() => void query.refetch()}
                >
                  <span class="rounded-full bg-v2-overlay-simple-overlay-hover px-1.5 text-11-medium text-v2-text-text-muted">
                    {formatRequestCount(count ?? 0)}
                  </span>
                </div>
              }
            >
              <button
                type="button"
                class="flex cursor-pointer items-center justify-center"
                role="img"
                aria-label={language.t("provider.usage.meter", { provider: entry[0], percent: Math.round(percent ?? 0) })}
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
    props.variant === "rings" ? rows().length > 0 : Object.values(query.data ?? {}).some((value) => (value?.windows ?? []).length > 0),
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
