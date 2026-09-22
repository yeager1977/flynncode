import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode-ai/ui/v2/dialog-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { For, Show, createEffect, createSignal, onCleanup, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { searchRegistry, type RegistryEntry } from "./mcp-registry-payload"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

export const RegistrySearchDialog: Component<{
  onSelect: (entry: RegistryEntry) => void
}> = (props) => {
  const language = useLanguage()
  const [query, setQuery] = createSignal("")
  const [filter, setFilter] = createSignal<"all" | "stdio" | "remote">("all")
  const [entries, setEntries] = createSignal<RegistryEntry[]>([])
  const [cursor, setCursor] = createSignal<string | undefined>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal(false)

  let runId = 0
  let pendingSearchTimer: ReturnType<typeof setTimeout> | undefined
  const run = async (search: string) => {
    const id = ++runId
    setBusy(true)
    setError(false)
    try {
      const page = await searchRegistry(search === "" ? {} : { search })
      if (id !== runId) return
      setEntries(page.entries)
      setCursor(page.nextCursor)
    } catch {
      if (id !== runId) return
      setEntries([])
      setCursor(undefined)
      setError(true)
    } finally {
      if (id === runId) setBusy(false)
    }
  }

  // No browse-all: an empty query shows a prompt instead of fetching the
  // unfiltered listing (spec choice: search + filters, no browse default).
  createEffect(() => {
    const search = query().trim()
    runId++
    if (search === "") {
      setEntries([])
      setCursor(undefined)
      setBusy(false)
      setError(false)
      return
    }
    const timer = setTimeout(() => {
      pendingSearchTimer = undefined
      void run(search)
    }, 300)
    pendingSearchTimer = timer
    onCleanup(() => {
      clearTimeout(timer)
      if (pendingSearchTimer === timer) pendingSearchTimer = undefined
    })
  })

  const visible = () => {
    const active = filter()
    if (active === "all") return entries()
    // "unsupported" entries only appear under All.
    return entries().filter((entry) => entry.transport === active)
  }

  const loadMore = async () => {
    const next = cursor()
    if (next === undefined) return
    const id = ++runId
    setCursor(undefined)
    setBusy(true)
    try {
      const search = query().trim()
      const page = await searchRegistry(search === "" ? { cursor: next } : { search, cursor: next })
      if (id !== runId) return
      setEntries((current) => [...current, ...page.entries])
      setCursor(page.nextCursor)
    } catch {
      if (id !== runId) return
      setError(true)
    } finally {
      if (id === runId) setBusy(false)
    }
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup
          title={language.t("settings.mcp.registry.title")}
          description={language.t("settings.mcp.registry.subtitle")}
        />
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col gap-4 px-4 pt-4 pb-2">
        <TextInputV2
          type="text"
          value={query()}
          placeholder={language.t("settings.mcp.registry.placeholder")}
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            const search = query().trim()
            if (search === "") return
            if (pendingSearchTimer !== undefined) {
              clearTimeout(pendingSearchTimer)
              pendingSearchTimer = undefined
            }
            void run(search)
          }}
        />
        <div class="flex gap-2">
          {(["all", "stdio", "remote"] as const).map((value) => (
            <ButtonV2
              size="normal"
              variant={filter() === value ? "neutral" : "ghost-muted"}
              onClick={() => setFilter(value)}
            >
              {language.t(`settings.mcp.registry.filter.${value}`)}
            </ButtonV2>
          ))}
        </div>
        <Show
          when={!error()}
          fallback={
            <div class="settings-v2-plugins-note flex items-center justify-between gap-2">
              <span>{language.t("settings.mcp.registry.error")}</span>
              <ButtonV2 size="normal" variant="outline" disabled={busy()} onClick={() => void run(query().trim())}>
                {language.t("settings.mcp.registry.retry")}
              </ButtonV2>
            </div>
          }
        >
          <Show
            when={visible().length > 0}
            fallback={
              <div class="settings-v2-plugins-note">
                <Show
                  when={query().trim() !== ""}
                  fallback={language.t("settings.mcp.registry.typePrompt")}
                >
                  {busy()
                    ? `${language.t("common.loading")}${language.t("common.loading.ellipsis")}`
                    : language.t("settings.mcp.registry.empty")}
                </Show>
              </div>
            }
          >
            <SettingsListV2>
              <For each={visible()}>
                {(entry) => (
                  <SettingsRowV2
                    title={entry.title}
                    description={
                      <div class="flex items-center gap-2">
                        <Tag variant="neutral">{entry.transport}</Tag>
                        <Show when={entry.status === "deprecated"}>
                          <Tag variant="neutral">{language.t("settings.mcp.registry.deprecated")}</Tag>
                        </Show>
                      </div>
                    }
                  >
                    <div class="flex items-center gap-2">
                      <span class="text-text-muted-base">{entry.description}</span>
                      <Show
                        when={entry.transport !== "unsupported"}
                        fallback={<span class="text-text-muted-base">{language.t("settings.mcp.registry.unsupported")}</span>}
                      >
                        <ButtonV2 size="normal" variant="neutral" onClick={() => props.onSelect(entry)}>
                          {language.t("settings.mcp.registry.select")}
                        </ButtonV2>
                      </Show>
                    </div>
                  </SettingsRowV2>
                )}
              </For>
            </SettingsListV2>
          </Show>
        </Show>
        <Show when={cursor() !== undefined && !error()}>
          <ButtonV2 variant="outline" disabled={busy()} onClick={() => void loadMore()}>
            {language.t("settings.mcp.registry.loadMore")}
          </ButtonV2>
        </Show>
      </DialogBody>
    </Dialog>
  )
}
