import { Tabs } from "@kobalte/core/tabs"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { For, Show, createEffect, createMemo, createSignal, on, type Accessor, type Component } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { usePlatform } from "@/context/platform"
import { showToast } from "@/utils/toast"
import { authTokenFromCredentials } from "@/utils/server"
import { fallbackChain, OMO_AGENTS, OMO_CATEGORIES } from "./omo-catalog"
import { fallbackLabel, openCodeBans, pluginPatch, type Pin } from "./omo-config-payload"
import { hasOmoPlugin } from "./omo-plugin"
import "./settings-v2.css"
import "./model-router.css"

type Scope = "global" | "project"

const AUTOMATIC_VALUE = "__automatic__"
const INHERIT_VALUE = "__inherit__"

type OmoInfo = {
  path: string | null
  parseError?: string
  agents: Record<string, unknown>
  categories: Record<string, unknown>
  disabledProviders: string[]
  openCodeDisabledProviders: string[]
}

type ModelOption = {
  key: string
  label: string
  kind: "automatic" | "inherit" | "model"
  providerID?: string
  providerName?: string
  modelID?: string
  modelName?: string
  connected: boolean
}

type ScopeForm = {
  agents: Record<string, Pin>
  categories: Record<string, Pin>
  checked: string[]
  existingAgents: Record<string, Record<string, unknown>>
  existingCategories: Record<string, Record<string, unknown>>
  path: string | null
  parseError?: string
  openCodeDisabledProviders: string[]
  disabledProviders: string[]
}

const emptyScopeForm = (): ScopeForm => ({
  agents: {},
  categories: {},
  checked: [],
  existingAgents: {},
  existingCategories: {},
  path: null,
  openCodeDisabledProviders: [],
  disabledProviders: [],
})

export const SettingsOmoV2: Component<{ directory: Accessor<string | undefined> }> = (props) => {
  const language = useLanguage()
  const server = useServer()
  const serverSync = useServerSync()
  const platform = usePlatform()

  const fetcher = () => platform.fetch ?? globalThis.fetch

  const [state, setState] = createStore({
    scope: "global" as Scope,
    saving: false,
    saved: false,
    error: null as { message: string; path: string } | null,
    loading: true,
    loadError: null as string | null,
  })

  const [globalForm, setGlobalForm] = createStore<ScopeForm>(emptyScopeForm())
  const [projectForm, setProjectForm] = createStore<ScopeForm>(emptyScopeForm())
  const [globalBaseline, setGlobalBaseline] = createSignal<string>("")
  const [projectBaseline, setProjectBaseline] = createSignal<string>("")

  const activeForm = () => (state.scope === "global" ? globalForm : projectForm)
  const activeBaseline = () => (state.scope === "global" ? globalBaseline() : projectBaseline())

  const serialize = (form: ScopeForm) =>
    JSON.stringify({ agents: form.agents, categories: form.categories, checked: form.checked })

  const dirty = createMemo(() => serialize(activeForm()) !== activeBaseline())

  // Connected providers/models drive both the bans list and the per-entry
  // model picker. Reuse the server-sync's provider index so id → name lookup
  // matches other tabs.
  const connectedProviderIDs = createMemo(() => serverSync().data.provider.connected)
  const connectedSet = createMemo(() => new Set(connectedProviderIDs()))
  const providerName = (id: string) =>
    serverSync().data.provider.all.get(id)?.name ??
    (serverSync().data.config.provider?.[id] as { name?: string } | undefined)?.name ??
    id

  const modelOptions = createMemo<ModelOption[]>(() => {
    const options: ModelOption[] = []
    for (const id of connectedProviderIDs()) {
      const provider = serverSync().data.provider.all.get(id)
      if (!provider) continue
      for (const model of Object.values(provider.models ?? {})) {
        options.push({
          key: `${id}/${model.id}`,
          label: `${provider.name ?? id} · ${model.name ?? model.id}`,
          kind: "model",
          providerID: id,
          providerName: provider.name,
          modelID: model.id,
          modelName: model.name ?? model.id,
          connected: true,
        })
      }
    }
    options.sort((a, b) => a.label.localeCompare(b.label))
    return options
  })

  // Load one scope from its API and populate the store. Missing files come
  // back from the server as an empty info payload, which we normalise into an
  // empty form so the UI can still edit.
  const loadScope = async (scope: Scope, directory: string | undefined) => {
    const conn = server.current
    if (!conn) return
    if (scope === "project" && !directory) {
      setProjectForm(reconcile(emptyScopeForm()))
      setProjectBaseline(serialize(emptyScopeForm()))
      return
    }
    const url =
      scope === "global"
        ? `${conn.http.url}/global/omo-config`
        : `${conn.http.url}/config/omo?directory=${encodeURIComponent(directory!)}`
    const headers: Record<string, string> = { Accept: "application/json" }
    if (conn.http.password) {
      headers.Authorization = `Basic ${authTokenFromCredentials({
        username: conn.http.username,
        password: conn.http.password,
      })}`
    }
    const response = await fetcher()(url, { headers })
    if (!response.ok) throw new Error(`Failed to load: ${response.status}`)
    const info = (await response.json()) as OmoInfo
    const next = formFromInfo(info)
    if (scope === "global") {
      setGlobalForm(reconcile(next))
      setGlobalBaseline(serialize(next))
      return
    }
    setProjectForm(reconcile(next))
    setProjectBaseline(serialize(next))
  }

  // Load both scopes up front so scope switching is instant and the Save
  // button always has the right baseline to compare against.
  createEffect(
    on(
      () => [server.current, props.directory()],
      async ([, directory]) => {
        setState({ loading: true, loadError: null })
        await Promise.all([
          loadScope("global", undefined).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            setState("loadError", message)
          }),
          loadScope("project", directory as string | undefined).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            setState("loadError", message)
          }),
        ])
        setState("loading", false)
      },
    ),
  )

  // Force scope to global when no project directory is available so the tab
  // does not appear to edit a project without one.
  createEffect(() => {
    if (!props.directory() && state.scope === "project") setState("scope", "global")
  })

  const shownProviders = createMemo(() => {
    const ids = new Set<string>()
    for (const id of connectedProviderIDs()) ids.add(id)
    for (const id of activeForm().disabledProviders) ids.add(id)
    for (const id of activeForm().openCodeDisabledProviders) ids.add(id)
    return Array.from(ids).sort((a, b) => providerName(a).localeCompare(providerName(b)))
  })

  const isLocked = (id: string) => {
    if (state.scope !== "project") return false
    return globalForm.disabledProviders.includes(id) || globalForm.openCodeDisabledProviders.includes(id)
  }

  const toggleBan = (id: string, checked: boolean) => {
    if (isLocked(id)) return
    if (state.scope === "global") {
      setGlobalForm("checked", (list) => (checked ? uniqueList([...list, id]) : list.filter((x) => x !== id)))
      return
    }
    setProjectForm("checked", (list) => (checked ? uniqueList([...list, id]) : list.filter((x) => x !== id)))
  }

  const setPin = (kind: "agents" | "categories", name: string, pin: Pin) => {
    if (state.scope === "global") setGlobalForm(kind, name, pin)
    else setProjectForm(kind, name, pin)
  }

  const currentOptionFor = (pin: Pin | undefined): ModelOption => {
    if (state.scope === "global" && (pin === undefined || pin === "automatic")) {
      return { key: AUTOMATIC_VALUE, label: language.t("settings.omo.automatic"), kind: "automatic", connected: true }
    }
    if (state.scope === "project" && (pin === undefined || pin === "inherit")) {
      return { key: INHERIT_VALUE, label: language.t("settings.omo.inherit"), kind: "inherit", connected: true }
    }
    if (typeof pin === "object") {
      const [providerID, ...rest] = pin.model.split("/")
      const modelID = rest.join("/")
      const match = modelOptions().find((option) => option.key === pin.model)
      if (match) return match
      return {
        key: pin.model,
        label: pin.model,
        kind: "model",
        providerID,
        modelID,
        connected: false,
      }
    }
    // Fallback: return the scope-default entry to keep the select controlled.
    return state.scope === "global"
      ? { key: AUTOMATIC_VALUE, label: language.t("settings.omo.automatic"), kind: "automatic", connected: true }
      : { key: INHERIT_VALUE, label: language.t("settings.omo.inherit"), kind: "inherit", connected: true }
  }

  const optionsFor = (pin: Pin | undefined): ModelOption[] => {
    const options: ModelOption[] = []
    if (state.scope === "global") {
      options.push({
        key: AUTOMATIC_VALUE,
        label: language.t("settings.omo.automatic"),
        kind: "automatic",
        connected: true,
      })
    } else {
      options.push({
        key: INHERIT_VALUE,
        label: language.t("settings.omo.inherit"),
        kind: "inherit",
        connected: true,
      })
    }
    for (const option of modelOptions()) options.push(option)
    // A pinned model that no connected provider offers stays selectable so
    // the user can see what is saved before choosing something else.
    if (typeof pin === "object" && !options.some((option) => option.key === pin.model)) {
      const [providerID, ...rest] = pin.model.split("/")
      options.push({
        key: pin.model,
        label: pin.model,
        kind: "model",
        providerID,
        modelID: rest.join("/"),
        connected: false,
      })
    }
    return options
  }

  const onSelectPin = (kind: "agents" | "categories", name: string, option: ModelOption | null) => {
    if (!option) return
    if (option.kind === "automatic") {
      setPin(kind, name, "automatic")
      return
    }
    if (option.kind === "inherit") {
      setPin(kind, name, "inherit")
      return
    }
    const current = activeForm()[kind][name]
    const variant = typeof current === "object" ? current.variant : undefined
    const nextPin: Pin =
      variant !== undefined && variant !== "" ? { model: option.key, variant } : { model: option.key }
    setPin(kind, name, nextPin)
  }

  const setVariant = (kind: "agents" | "categories", name: string, value: string) => {
    const current = activeForm()[kind][name]
    if (typeof current !== "object") return
    const trimmed = value.trim()
    const nextPin: Pin = trimmed === "" ? { model: current.model } : { model: current.model, variant: value }
    setPin(kind, name, nextPin)
  }

  const fallbackText = (kind: "agent" | "category", name: string) => {
    const chain = fallbackChain(kind, name)
    if (chain.length === 0) return null
    const label = fallbackLabel(chain, connectedSet())
    return language.t(label.connected ? "settings.omo.fallback" : "settings.omo.fallback.offline", {
      model: label.model,
    })
  }

  const save = async () => {
    if (state.saving) return
    const conn = server.current
    if (!conn) return
    if (state.scope === "project" && !props.directory()) return
    if (activeForm().parseError) return
    setState({ saving: true, error: null, saved: false })
    const shown = shownProviders()
    const shownSet = new Set(shown)
    const loadedBans = uniqueList([
      ...activeForm().disabledProviders,
      ...activeForm().openCodeDisabledProviders,
    ])
    const hiddenBans = loadedBans.filter((id) => !shownSet.has(id))
    const checked =
      state.scope === "project"
        ? uniqueList([...activeForm().checked, ...shown.filter((id) => isLocked(id))])
        : activeForm().checked
    const input = {
      scope: state.scope,
      shownProviders: shown,
      checked,
      hiddenBans,
      globalOpenCodeBans: globalForm.openCodeDisabledProviders,
      globalPluginBans: globalForm.disabledProviders,
      agents: activeForm().agents,
      categories: activeForm().categories,
      existingAgents: activeForm().existingAgents,
      existingCategories: activeForm().existingCategories,
    }
    const patch = pluginPatch(input)
    const body = {
      agents: patch.agents,
      categories: patch.categories,
      disabledProviders: state.scope === "global" ? patch.disabledProviders : openCodeBans(input),
    }
    const url =
      state.scope === "global"
        ? `${conn.http.url}/global/omo-config`
        : `${conn.http.url}/config/omo?directory=${encodeURIComponent(props.directory()!)}`
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    }
    if (conn.http.password) {
      headers.Authorization = `Basic ${authTokenFromCredentials({
        username: conn.http.username,
        password: conn.http.password,
      })}`
    }
    const response = await fetcher()(url, { method: "PUT", headers, body: JSON.stringify(body) }).catch(
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        return new Response(JSON.stringify({ name: "OmoConfigWriteError", data: { message, path: "" } }), {
          status: 500,
        })
      },
    )
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | { name?: string; data?: { message?: string; path?: string } }
        | null
      const message = payload?.data?.message ?? `${response.status}`
      const path = payload?.data?.path ?? ""
      setState({ saving: false, error: { message, path } })
      showToast({
        variant: "error",
        title: language.t("settings.omo.saveFailed", { path }),
      })
      return
    }
    const info = (await response.json()) as OmoInfo
    const next = formFromInfo(info)
    if (state.scope === "global") {
      setGlobalForm(reconcile(next))
      setGlobalBaseline(serialize(next))
    } else {
      setProjectForm(reconcile(next))
      setProjectBaseline(serialize(next))
    }
    setState({ saving: false, saved: true })
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("settings.omo.saved"),
      description: language.t("settings.omo.restart"),
    })
  }

  const canEdit = () => !state.loading && !activeForm().parseError
  const pluginOn = createMemo(() => hasOmoPlugin(serverSync().data.config.plugin))
  const hasDirectory = createMemo(() => Boolean(props.directory()))

  const savedStatusKey = () =>
    dirty() ? "settings.omo.unsaved" : state.saved ? "settings.omo.saved" : "settings.omo.scope." + state.scope

  return (
    <div class="model-router">
      <header class="model-router-header">
        <div class="model-router-heading">
          <div>
            <h2 class="settings-v2-tab-title">{language.t("settings.omo.title")}</h2>
            <p class="model-router-muted">{language.t("settings.omo.description")}</p>
          </div>
          <div class="model-router-actions">
            <ButtonV2
              variant={state.saving ? "loading" : "contrast"}
              disabled={!dirty() || state.saving || !canEdit()}
              onClick={() => void save()}
            >
              {language.t("settings.omo.save")}
            </ButtonV2>
          </div>
        </div>
        <div class="model-router-save-state" role="status">
          <span class="model-router-status" data-dirty={dirty()}>
            {language.t(savedStatusKey() as Parameters<typeof language.t>[0])}
          </span>
          <span>{language.t("settings.omo.restart")}</span>
        </div>
        <Show when={!pluginOn()}>
          <div class="model-router-notice" role="status">
            {language.t("settings.omo.pluginOff")}
          </div>
        </Show>
        <Show when={activeForm().parseError}>
          <div class="model-router-error" role="alert">
            {language.t("settings.omo.parseError")}
          </div>
        </Show>
        <Show when={state.error}>
          {(error) => (
            <div class="model-router-error" role="alert">
              {language.t("settings.omo.saveFailed", { path: error().path })}
            </div>
          )}
        </Show>
      </header>

      <Tabs
        value={state.scope}
        onChange={(value) => setState("scope", value as Scope)}
        class="model-router-tabs"
      >
        <Tabs.List class="model-router-nav" aria-label={language.t("settings.omo.title")}>
          <Tabs.Trigger value="global">{language.t("settings.omo.scope.global")}</Tabs.Trigger>
          <Show when={hasDirectory()}>
            <Tabs.Trigger value="project">{language.t("settings.omo.scope.project")}</Tabs.Trigger>
          </Show>
        </Tabs.List>
        <fieldset
          disabled={state.saving || !canEdit()}
          class="model-router-body"
          aria-label={language.t("settings.omo.title")}
        >
          <section class="model-router-section">
            <div class="model-router-section-heading">
              <div>
                <h3>{language.t("settings.omo.bans")}</h3>
              </div>
            </div>
            <div class="model-router-provider-list">
              <For each={shownProviders()}>
                {(id) => {
                  const locked = () => isLocked(id)
                  const checked = () => activeForm().checked.includes(id) || locked()
                  return (
                    <label class="model-router-choice">
                      <input
                        type="checkbox"
                        aria-label={providerName(id)}
                        disabled={locked()}
                        checked={checked()}
                        onChange={(event) => toggleBan(id, event.currentTarget.checked)}
                      />
                      <span>
                        <bdi>{providerName(id)}</bdi>
                        <small dir="ltr">{id}</small>
                        <Show when={id === "xai"}>
                          <Tag>{language.t("settings.omo.bans.grok")}</Tag>
                        </Show>
                        <Show when={locked()}>
                          <Tag>{language.t("settings.omo.bans.locked")}</Tag>
                        </Show>
                      </span>
                    </label>
                  )
                }}
              </For>
            </div>
          </section>

          <section class="model-router-section">
            <h3>{language.t("settings.omo.agents")}</h3>
            <div class="model-router-agent-list">
              <For each={OMO_AGENTS}>
                {(agent) => (
                  <PinRow
                    kind="agents"
                    name={agent}
                    pin={activeForm().agents[agent]}
                    options={optionsFor(activeForm().agents[agent])}
                    current={currentOptionFor(activeForm().agents[agent])}
                    onSelect={(option) => onSelectPin("agents", agent, option)}
                    onVariantInput={(value) => setVariant("agents", agent, value)}
                    fallback={fallbackText("agent", agent)}
                  />
                )}
              </For>
            </div>
          </section>

          <section class="model-router-section">
            <h3>{language.t("settings.omo.categories")}</h3>
            <div class="model-router-agent-list">
              <For each={OMO_CATEGORIES}>
                {(category) => (
                  <PinRow
                    kind="categories"
                    name={category}
                    pin={activeForm().categories[category]}
                    options={optionsFor(activeForm().categories[category])}
                    current={currentOptionFor(activeForm().categories[category])}
                    onSelect={(option) => onSelectPin("categories", category, option)}
                    onVariantInput={(value) => setVariant("categories", category, value)}
                    fallback={fallbackText("category", category)}
                  />
                )}
              </For>
            </div>
          </section>
        </fieldset>
      </Tabs>
    </div>
  )
}

const PinRow: Component<{
  kind: "agents" | "categories"
  name: string
  pin: Pin | undefined
  options: ModelOption[]
  current: ModelOption
  onSelect: (option: ModelOption | null) => void
  onVariantInput: (value: string) => void
  fallback: string | null
}> = (props) => {
  const language = useLanguage()
  const variantValue = () => (typeof props.pin === "object" ? (props.pin.variant ?? "") : "")
  const modelChosen = () => typeof props.pin === "object"
  return (
    <div class="model-router-agent-row">
      <div class="model-router-agent-name">
        <bdi>{props.name}</bdi>
        <Show when={props.fallback}>{(text) => <small class="model-router-muted">{text()}</small>}</Show>
      </div>
      <div class="model-router-field">
        <SelectV2
          appearance="inline"
          options={props.options}
          current={props.current}
          value={(option) => option.key}
          label={(option) => option.label}
          onSelect={(option) => props.onSelect(option)}
        />
        <Show when={!props.current.connected && props.current.kind === "model"}>
          <span class="model-router-field-error">{language.t("settings.omo.notConnected")}</span>
        </Show>
      </div>
      <Show when={modelChosen()}>
        <label class="model-router-field">
          <span>{language.t("settings.omo.variant")}</span>
          <TextInputV2
            type="text"
            aria-label={language.t("settings.omo.variant")}
            value={variantValue()}
            onInput={(event) => props.onVariantInput(event.currentTarget.value)}
          />
        </label>
      </Show>
    </div>
  )
}

function formFromInfo(info: OmoInfo): ScopeForm {
  return {
    agents: pinsFromRecord(info.agents, OMO_AGENTS),
    categories: pinsFromRecord(info.categories, OMO_CATEGORIES),
    checked: uniqueList([...info.disabledProviders, ...info.openCodeDisabledProviders]),
    existingAgents: recordOfRecords(info.agents),
    existingCategories: recordOfRecords(info.categories),
    path: info.path,
    parseError: info.parseError,
    openCodeDisabledProviders: [...info.openCodeDisabledProviders],
    disabledProviders: [...info.disabledProviders],
  }
}

function pinsFromRecord(record: Record<string, unknown>, keys: readonly string[]): Record<string, Pin> {
  const pins: Record<string, Pin> = {}
  for (const key of keys) {
    const entry = record[key]
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const value = entry as Record<string, unknown>
    if (typeof value.model !== "string") {
      pins[key] = "automatic"
      continue
    }
    const variant = typeof value.variant === "string" ? value.variant : undefined
    pins[key] = variant !== undefined ? { model: value.model, variant } : { model: value.model }
  }
  return pins
}

function recordOfRecords(record: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {}
  for (const [key, value] of Object.entries(record)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = value as Record<string, unknown>
    }
  }
  return result
}

function uniqueList(items: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}
