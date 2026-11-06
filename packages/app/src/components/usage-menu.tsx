import { Popover } from "@flynncode/ui/popover"
import { ButtonV2 } from "@flynncode/ui/v2/button-v2"
import { Icon } from "@flynncode/ui/v2/icon"
import { IconButtonV2 } from "@flynncode/ui/v2/icon-button-v2"
import { TooltipV2 } from "@flynncode/ui/v2/tooltip-v2"
import { A } from "@solidjs/router"
import { createMemo, createUniqueId, For, Match, Show, Switch, type Accessor, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { createSessionContextFormatter } from "@/components/session/session-context-format"
import { getSessionContext, getSessionModelUsage } from "@/components/session/session-context-metrics"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { ServerConnection, useServer } from "@/context/server"
import type { ServerSync } from "@/context/server-sync"
import { useProviderUsage } from "@/hooks/use-provider-usage"
import { useProviders } from "@/hooks/use-providers"
import {
  formatRequestCount,
  formatResetTime,
  orderedWindows,
  windowLabel,
  type UsageWindow,
} from "@/utils/provider-usage"

// The accounts the menu reports, in display order.
const PROVIDERS = [
  { id: "openai", name: "usage.provider.openai" },
  { id: "anthropic", name: "usage.provider.anthropic" },
  { id: "ollama-cloud", name: "usage.provider.ollama" },
] as const

// A meter at or above this percent reads as nearly exhausted.
const DANGER_PERCENT = 90

type Chat = { sessionID: string; sync: ServerSync }
type Context = ReturnType<typeof getSessionContext>

// Titlebar entry point for usage: the open chat's current model and context window, and the account limits of
// OpenAI, Anthropic and Ollama.com. Nothing is requested until the menu opens.
export function UsageMenu() {
  const language = useLanguage()
  const layout = useLayout()
  const global = useGlobal()
  const server = useServer()
  const providers = useProviders(() => undefined)
  const [state, setState] = createStore({ open: false })
  const usage = useProviderUsage(() => state.open)
  const connected = createMemo(() => new Set(providers.connected().map((provider) => provider.id)))

  // The titlebar sits outside the session route, so the open chat comes from the route, on the server that owns it.
  const chat = createMemo(
    () => {
      const route = layout.route()
      if (route.type !== "session") return
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === (route.server ?? server.key))
      if (!conn) return
      return { sessionID: route.sessionId, sync: global.ensureServerCtx(conn).sync }
    },
    undefined,
    { equals: (a, b) => a?.sessionID === b?.sessionID && a?.sync === b?.sync },
  )
  const context = createMemo(() => {
    const target = chat()
    if (!target) return
    return getSessionContext(
      target.sync.session.data.message[target.sessionID],
      [...target.sync.data.provider.all.values()],
      target.sync.lookupProvider,
    )
  })
  const percent = createMemo(() => context()?.usage ?? undefined)
  const danger = () => (percent() ?? 0) >= DANGER_PERCENT
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))

  return (
    <TooltipV2
      class="shrink-0"
      placement="bottom"
      value={
        <>
          {language.t("usage.page.title")}
          <Show when={percent() !== undefined}>
            <div class="text-v2-text-text-muted">
              {language.t("usage.menu.contextTooltip", { percent: formatter().number(percent()) })}
            </div>
          </Show>
        </>
      }
    >
      <Popover
        open={state.open}
        onOpenChange={(open) => setState("open", open)}
        triggerAs={ButtonV2}
        triggerProps={{
          variant: "ghost-muted",
          size: "normal",
          icon: "status",
          class: "shrink-0",
          "data-action": "titlebar-usage",
        }}
        trigger={
          <>
            <span class="max-sm:sr-only">{language.t("usage.page.title")}</span>
            <Show when={percent() !== undefined}>
              <span class="tabular-nums" classList={{ "text-v2-state-fg-danger": danger() }}>
                {formatter().percent(percent())}
              </span>
            </Show>
          </>
        }
        title={language.t("usage.page.title")}
        class="w-[360px] max-w-[calc(100vw-40px)]"
        gutter={4}
        placement="bottom-end"
      >
        <div data-component="usage-menu" aria-busy={usage.fetching()} class="flex flex-col gap-3 text-[13px] leading-5">
          {/* Tall enough for every section; only a short window scrolls, with the footer staying put. */}
          <div class="flex max-h-[calc(100vh-160px)] flex-col divide-y divide-v2-border-border-muted overflow-y-auto">
            <Show when={chat()}>{(target) => <ChatSection chat={target()} context={context} />}</Show>
            <For each={PROVIDERS}>
              {(provider) => (
                <ProviderSection
                  name={language.t(provider.name)}
                  connected={connected().has(provider.id)}
                  windows={usage.data() ? (usage.data()?.[provider.id]?.windows ?? []) : undefined}
                  failed={usage.failed()}
                />
              )}
            </For>
          </div>
          <div class="flex items-center justify-between gap-2">
            <TooltipV2 placement="top" value={language.t("usage.menu.refresh")} class="shrink-0">
              <IconButtonV2
                type="button"
                data-action="usage-menu-refresh"
                variant="ghost-muted"
                size="normal"
                aria-label={language.t("usage.menu.refresh")}
                onClick={() => usage.refetch()}
                icon={<Icon name="reset" size="small" classList={{ "animate-pulse": usage.fetching() }} />}
              />
            </TooltipV2>
            <A
              href="/usage"
              data-action="usage-menu-view-all"
              class="rounded-md px-1.5 text-v2-text-text-muted outline outline-1 outline-transparent hover:text-v2-text-text-base hover:underline focus-visible:outline-v2-border-border-focus"
              onClick={() => setState("open", false)}
            >
              {language.t("usage.menu.viewAll")}
            </A>
          </div>
        </div>
      </Popover>
    </TooltipV2>
  )
}

// What the open chat has used: the model currently doing the work with its context window, then the others.
function ChatSection(props: { chat: Chat; context: Accessor<Context> }) {
  const language = useLanguage()
  const headingID = createUniqueId()
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))
  const usd = createMemo(() => new Intl.NumberFormat(language.intl(), { style: "currency", currency: "USD" }))
  // Aggregated here rather than in the trigger: the walk over every message only runs while the menu is open.
  const models = createMemo(() =>
    getSessionModelUsage(
      props.chat.sync.session.data.message[props.chat.sessionID],
      [...props.chat.sync.data.provider.all.values()],
      props.chat.sync.lookupProvider,
    ),
  )
  const cost = () =>
    props.chat.sync.session.get(props.chat.sessionID)?.cost ?? models().reduce((sum, model) => sum + model.cost, 0)

  return (
    <section aria-labelledby={headingID} class="flex flex-col gap-2 pb-3">
      <h3 id={headingID} class="font-[530] text-v2-text-text-base">
        {language.t("usage.menu.chat")}
      </h3>
      <Show when={models()[0]} fallback={<Note>{language.t("provider.usage.none")}</Note>}>
        {(current) => (
          <>
            <div class="flex min-w-0 flex-col">
              <span class="truncate text-v2-text-text-base">
                <bdi dir="ltr">{current().modelLabel}</bdi>
              </span>
              <span class="truncate text-[12px] leading-4 text-v2-text-text-faint">
                <bdi dir="ltr">{current().providerLabel}</bdi>
              </span>
            </div>
            <Show when={props.context()}>
              {(ctx) => (
                <Show when={ctx().limit}>
                  {(limit) => (
                    <div class="flex flex-col gap-1">
                      <Reading label={language.t("model.tooltip.context.label")} percent={ctx().usage ?? 0} />
                      <span class="text-[12px] leading-4 text-v2-text-text-faint">
                        {language.t("usage.menu.contextTokens", {
                          used: formatter().number(ctx().total),
                          limit: formatter().number(limit()),
                        })}
                      </span>
                    </div>
                  )}
                </Show>
              )}
            </Show>
            <dl class="flex flex-col gap-1">
              <Stat label={language.t("context.usage.tokens")} value={formatter().number(current().tokens)} />
              <Stat label={language.t("context.usage.cost")} value={usd().format(cost())} />
            </dl>
          </>
        )}
      </Show>
      <Show when={models().length > 1}>
        <table class="w-full table-fixed border-collapse text-[12px] leading-4">
          <thead>
            <tr class="text-v2-text-text-faint">
              <th scope="col" class="pb-1 text-start font-normal">
                {language.t("usage.menu.otherModels")}
              </th>
              <th scope="col" class="w-20 pb-1 text-end font-normal">
                {language.t("context.usage.tokens")}
              </th>
              <th scope="col" class="w-16 pb-1 text-end font-normal">
                {language.t("context.usage.cost")}
              </th>
            </tr>
          </thead>
          <tbody class="text-v2-text-text-muted">
            <For each={models().slice(1)}>
              {(model) => (
                <tr>
                  <td class="truncate pe-2">
                    <bdi dir="ltr">{model.modelLabel}</bdi>
                  </td>
                  <td class="text-end tabular-nums">{formatter().number(model.tokens)}</td>
                  <td class="text-end tabular-nums">{usd().format(model.cost)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </section>
  )
}

// One account: its limit windows, or why there are none to show.
function ProviderSection(props: {
  name: string
  connected: boolean
  // Undefined until the first response arrives.
  windows: UsageWindow[] | undefined
  failed: boolean
}) {
  const language = useLanguage()
  const headingID = createUniqueId()
  const windows = createMemo(() => (props.windows ? orderedWindows(props.windows) : undefined))

  return (
    <section aria-labelledby={headingID} class="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <h3 id={headingID} class="font-[530] text-v2-text-text-base">
        {props.name}
      </h3>
      <Switch>
        <Match when={!props.connected}>
          <Note>{language.t("usage.provider.notConnected")}</Note>
        </Match>
        <Match when={windows()}>
          {(list) => (
            <Show when={list().length > 0} fallback={<Note>{language.t("usage.noLimit")}</Note>}>
              <For each={list()}>{(window) => <WindowRow window={window} />}</For>
            </Show>
          )}
        </Match>
        <Match when={props.failed}>
          <Note>{language.t("usage.menu.failed")}</Note>
        </Match>
        <Match when={true}>
          <Note>{language.t("usage.menu.loading")}</Note>
        </Match>
      </Switch>
    </section>
  )
}

// A percent window is a labelled meter; a window that only counts requests is one line of text.
function WindowRow(props: { window: UsageWindow }) {
  const language = useLanguage()
  const label = () => windowLabel(language.t, props.window.id)
  const resets = () =>
    props.window.resetsAt === undefined ? undefined : formatResetTime(props.window.resetsAt, Date.now())

  return (
    <Show
      when={props.window.percent !== undefined}
      fallback={
        <Note>
          {language.t(resets() ? "provider.usage.countRowResets" : "provider.usage.countRow", {
            label: label(),
            count: formatRequestCount(props.window.count ?? 0),
            time: resets() ?? "",
          })}
        </Note>
      }
    >
      <div class="flex flex-col gap-1">
        <Reading label={label()} percent={props.window.percent ?? 0} />
        <Show when={resets()}>
          {(time) => (
            <span class="text-[12px] leading-4 text-v2-text-text-faint">
              {language.t("usage.menu.resets", { time: time() })}
            </span>
          )}
        </Show>
      </div>
    </Show>
  )
}

// A labelled percent with its bar. The fill grows from the inline start, so it mirrors in right-to-left layouts.
function Reading(props: { label: string; percent: number }) {
  const language = useLanguage()
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))
  const clamped = () => Math.max(0, Math.min(100, props.percent))
  // The same rounded number the label shows, so "90%" is never drawn as safe.
  const danger = () => Math.round(props.percent) >= DANGER_PERCENT

  return (
    <div class="flex flex-col gap-1">
      <div class="flex items-baseline justify-between gap-2">
        <span class="text-v2-text-text-muted">{props.label}</span>
        <span
          class="tabular-nums"
          classList={{ "text-v2-state-fg-danger": danger(), "text-v2-text-text-base": !danger() }}
        >
          {formatter().percent(Math.round(props.percent))}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={props.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped())}
        class="h-1 w-full overflow-hidden rounded-full bg-v2-background-bg-layer-04"
      >
        <div
          class="h-full rounded-full"
          classList={{ "bg-v2-state-fg-danger": danger(), "bg-v2-icon-icon-base": !danger() }}
          style={{ "inline-size": `${clamped()}%` }}
        />
      </div>
    </div>
  )
}

function Stat(props: { label: string; value: string }) {
  return (
    <div class="flex items-baseline justify-between gap-2">
      <dt class="text-v2-text-text-muted">{props.label}</dt>
      <dd class="tabular-nums text-v2-text-text-base">{props.value}</dd>
    </div>
  )
}

function Note(props: ParentProps) {
  return <span class="text-v2-text-text-muted">{props.children}</span>
}
