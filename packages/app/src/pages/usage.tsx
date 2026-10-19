import { For, Show, createMemo, type Accessor } from "solid-js"
import { TooltipV2 } from "@flynncode/ui/v2/tooltip-v2"
import { Icon } from "@flynncode/ui/v2/icon"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useProviderUsage } from "@/hooks/use-provider-usage"
import {
  formatRequestCount,
  formatResetTime,
  orderedWindows,
  usageEntries,
  windowLabel,
  type UsageWindow,
} from "@/utils/provider-usage"

// Every enabled provider with its reported limit windows: the used percent,
// the reset time, and the absolute request counts where the provider only
// reports counts. Providers without a usage API show a "no account limit" state.
export function UsagePage() {
  const language = useLanguage()
  const providers = useProviders(() => undefined)
  const usage = useProviderUsage()

  const rows = createMemo(() => usageEntries({ connected: providers.connected(), usage: usage.data }))
  const connected = createMemo(() => new Set(providers.connected().map((provider) => provider.id)))

  return (
    <div class="flex flex-col gap-2 px-5 py-4 w-full max-w-[560px] overflow-y-auto">
      <div class="flex items-center justify-between gap-2 py-1">
        <h1 class="text-17-medium text-v2-text-text-base">{language.t("usage.page.title")}</h1>
        <TooltipV2 placement="bottom" value={language.t("provider.usage.clickRefresh")}>
          <button
            type="button"
            class="flex cursor-pointer items-center justify-center text-v2-text-text-muted hover:text-v2-text-text-base"
            aria-label={language.t("provider.usage.clickRefresh")}
            onClick={() => void usage.refetch()}
          >
            <Icon name="reset" size="small" />
          </button>
        </TooltipV2>
      </div>
      <For each={rows()}>
        {(row) => (
          <UsageCard
            name={row.name}
            windows={row.windows}
            connected={() => connected().has(row.providerID)}
          />
        )}
      </For>
      <span
        class="self-center text-11-regular text-v2-text-text-faint"
        classList={{ invisible: rows().length > 0 }}
      >
        {language.t("provider.usage.none")}
      </span>
    </div>
  )
}

function UsageCard(props: { name: string; windows: UsageWindow[]; connected: Accessor<boolean> }) {
  const language = useLanguage()
  const windows = createMemo(() => orderedWindows(props.windows))
  return (
    <div
      data-component="usage-provider-card"
      class="flex flex-col gap-1.5 rounded-xl border border-v2-border-border-muted bg-v2-background-bg-base/40 p-3"
    >
      <div class="flex items-center justify-between gap-2">
        <span class="text-13-medium text-v2-text-text-base">{props.name}</span>
        <span class="text-11-regular text-v2-text-text-faint">
          {props.connected() ? language.t("usage.provider.connected") : language.t("usage.provider.notConnected")}
        </span>
      </div>
      <Show
        when={windows().length > 0}
        fallback={<span class="text-12-regular text-v2-text-text-muted">{language.t("usage.noLimit")}</span>}
      >
        <For each={windows()}>{(window) => <UsageRow window={window} />}</For>
      </Show>
    </div>
  )
}

function UsageRow(props: { window: UsageWindow }) {
  const language = useLanguage()
  const label = () => windowLabel(language.t, props.window.id)
  const resets = () => formatResetTime(props.window.resetsAt ?? Date.now(), Date.now())
  const danger = () => (props.window.percent ?? 0) >= 90
  return (
    <div class="flex items-center justify-between gap-2">
      <span class="text-12-regular text-v2-text-text-muted" classList={{ "text-v2-state-fg-danger": danger() }}>
        <Show
          when={props.window.percent === undefined && props.window.count !== undefined}
          fallback={
            language.t(
              resetsDefined(props.window) ? "provider.usage.rowResets" : "provider.usage.row",
              { label: label(), percent: Math.round(props.window.percent ?? 0), time: resets() },
            )
          }
        >
          {language.t(
            resetsDefined(props.window) ? "provider.usage.countRowResets" : "provider.usage.countRow",
            { label: label(), count: formatRequestCount(props.window.count ?? 0), time: resets() },
          )}
        </Show>
      </span>
      <Show when={props.window.percent !== undefined}>
        <span class="text-12-medium" classList={{ "text-v2-state-fg-danger": danger(), "text-v2-text-text-base": !danger() }}>
          {Math.round(props.window.percent ?? 0)}%
        </span>
      </Show>
    </div>
  )
}

function resetsDefined(window: UsageWindow) {
  return window.resetsAt !== undefined
}
