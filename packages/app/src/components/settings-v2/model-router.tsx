import { Tabs } from "@kobalte/core/tabs"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { For, Show, batch, createEffect, createMemo, on, type Component } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createQuery } from "@tanstack/solid-query"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { useServerSync } from "@/context/server-sync"
import { pathKey } from "@/utils/path-key"
import {
  DEFAULT_AGENT_TASKS,
  TASK_NAMES,
  formFromConfig,
  modelAfterDisable,
  serializeForm,
  validateForm,
  type TaskName,
} from "./model-router-payload"
import { hasOmoPlugin, setOmoPlugin } from "./omo-plugin"
import {
  parseWeight,
  priorityWeights,
  routerCatalog,
  type Priority,
  type RouterSource,
} from "./model-router-preview"
import { ModelRouterModels } from "./model-router-models"
import { ModelRouterRoutes } from "./model-router-routes"
import "./settings-v2.css"
import "./model-router.css"

export const SettingsModelRouterV2: Component<{ directory?: string }> = (props) => {
  const language = useLanguage()
  const serverSync = useServerSync()
  const models = useModels()
  const agentsQuery = createQuery(() => serverSync().queryOptions.agents(pathKey(props.directory ?? "")))
  const config = () => serverSync().data.config?.model_router as Record<string, unknown> | undefined
  const [form, setForm] = createStore(formFromConfig(config()))
  const [state, setState] = createStore({
    tab: "routing",
    saving: false,
    saved: false,
    error: "",
    baseline: JSON.stringify(serializeForm(form)),
    incoming: undefined as string | undefined,
    raw: {} as Record<string, string>,
  })
  const invalid = createMemo(() => Object.values(state.raw).some((value) => parseWeight(value) === undefined))
  const dirty = createMemo(() => invalid() || JSON.stringify(serializeForm(form)) !== state.baseline)

  // Remember refreshes while editing, then adopt the newest saved configuration
  // after Discard or a manual undo. In-flight saves keep their own baseline.
  createEffect(on(config, (value) => setState("incoming", JSON.stringify(serializeForm(formFromConfig(value))))))
  createEffect(() => {
    if (dirty() || state.saving) return
    setState("error", "")
    if (state.incoming === undefined) return
    const next = state.incoming
    setForm(reconcile(formFromConfig(JSON.parse(next))))
    setState({ baseline: next, incoming: undefined, raw: {} })
  })

  // Match runtime candidate discovery: models.dev providers such as Anthropic and
  // OpenAI only exist in the connected catalog, never in raw config. Limit the
  // merge to providers that are configured or in scope so the picker stays small.
  const catalogSource = createMemo<RouterSource>(() => {
    const provider: NonNullable<RouterSource["provider"]> = {}
    const add = (id: string, source: { name?: string; models?: Record<string, { name?: string }> } | undefined) => {
      if (!source) return
      provider[id] = {
        name: provider[id]?.name ?? source.name,
        models: { ...(provider[id]?.models ?? {}), ...(source.models ?? {}) },
      }
    }
    const ids = new Set([
      ...Object.keys(serverSync().data.config.provider ?? {}),
      ...serverSync().data.provider.connected,
      ...form.providers,
    ])
    ids.delete("model-router")
    for (const id of ids) add(id, serverSync().data.provider.all.get(id))
    for (const [id, config] of Object.entries(serverSync().data.config.provider ?? {})) {
      if (id !== "model-router") add(id, config as any)
    }
    return { provider, disabled_providers: serverSync().data.config.disabled_providers }
  })
  const catalog = createMemo(() =>
    routerCatalog(catalogSource(), (providerID, modelID) => models.visible({ providerID, modelID })).map((model) => ({
      ...model,
      provider: serverSync().data.provider.all.get(model.providerID)?.name ?? model.provider,
    })),
  )
  const providers = createMemo(() =>
    Array.from(
      new Set([
        ...Object.keys(serverSync().data.config.provider ?? {}),
        ...serverSync().data.provider.connected,
        ...form.providers,
      ]),
    )
      .map((id) => ({
        id,
        name: serverSync().data.provider.all.get(id)?.name ?? serverSync().data.config.provider?.[id]?.name ?? id,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  )
  const agents = createMemo(() =>
    Array.from(
      new Set([
        ...Object.keys(DEFAULT_AGENT_TASKS),
        ...(agentsQuery.data ?? []).filter((agent) => !agent.hidden).map((agent) => agent.name),
        ...form.agentTasks.map((row) => row.agent),
      ]),
    ),
  )

  const reset = () =>
    batch(() => {
      const next = state.incoming ?? state.baseline
      setForm(reconcile(formFromConfig(JSON.parse(next))))
      setState({ baseline: next, incoming: undefined, raw: {}, error: "" })
    })

  const inScope = (providerID: string) =>
    form.providers.length > 0 ? form.providers.includes(providerID) : providerID.startsWith("ollama")

  // Manage Models visibility is a client-side store the server plugin cannot
  // read, so snapshot the hidden in-scope models into the config the router
  // does see. Models hidden later need another Save to take effect.
  const excludeSnapshot = () =>
    catalog()
      .filter((model) => !model.enabled && !model.disabled && inScope(model.providerID))
      .map((model) => model.key)

  const save = async () => {
    if (state.saving || invalid()) return
    const excludeModels = excludeSnapshot()
    const result = validateForm({ ...form, excludeModels })
    if (!result.ok) {
      setState("error", language.t("settings.modelRouter.invalid"))
      return
    }
    setState({ saving: true, error: "" })
    const config = serverSync().data.config
    const nextModel = form.enabled ? config.model : modelAfterDisable(config.model, config.small_model)
    const patch: Record<string, unknown> = { model_router: result.value }
    if (nextModel !== config.model) patch.model = nextModel
    await serverSync()
      .updateConfig(patch)
      .then(
        () => {
          setForm("excludeModels", excludeModels)
          setState({ baseline: JSON.stringify(result.value), incoming: undefined, raw: {}, saved: true })
        },
        () => setState("error", language.t("settings.modelRouter.saveFailed")),
      )
      .finally(() => setState("saving", false))
  }

  const changePriority = (task: TaskName, priority: Priority) => {
    setForm("taskWeights", task, priorityWeights(task, priority))
    setState(
      "raw",
      reconcile(Object.fromEntries(Object.entries(state.raw).filter(([key]) => !key.startsWith(`${task}:`)))),
    )
  }

  return (
    <div class="model-router">
      <header class="model-router-header">
        <div class="model-router-heading">
          <div>
            <h2 class="settings-v2-tab-title">{language.t("settings.modelRouter.title")}</h2>
            <p class="model-router-muted">{language.t("settings.modelRouter.subtitle")}</p>
          </div>
          <div class="model-router-actions">
            <ButtonV2 variant="ghost-muted" disabled={!dirty() || state.saving} onClick={reset}>
              {language.t("common.discard")}
            </ButtonV2>
            <ButtonV2
              variant={state.saving ? "loading" : "contrast"}
              disabled={!dirty() || invalid() || state.saving}
              onClick={() => void save()}
            >
              {language.t("settings.modelRouter.save")}
            </ButtonV2>
          </div>
        </div>
        <div class="model-router-save-state" role="status">
          <span class="model-router-status" data-dirty={dirty()}>
            {language.t(
              dirty()
                ? "settings.modelRouter.unsaved"
                : state.saved
                  ? "settings.modelRouter.saved"
                  : "settings.modelRouter.global",
            )}
          </span>
          <span>{language.t("settings.modelRouter.appliesOnRestart")}</span>
        </div>
        <Show when={state.error || invalid()}>
          <div class="model-router-error" role="alert">
            {state.error || language.t("settings.modelRouter.weights.invalid")}
            <Show when={invalid() && state.tab !== "advanced"}>
              <ButtonV2 size="small" variant="ghost" onClick={() => setState("tab", "advanced")}>
                {language.t("settings.modelRouter.reviewWeights")}
              </ButtonV2>
            </Show>
          </div>
        </Show>
      </header>

      <Tabs value={state.tab} onChange={(tab) => setState("tab", tab)} class="model-router-tabs">
        <Tabs.List class="model-router-nav" aria-label={language.t("settings.modelRouter.title")}>
          <For each={["routing", "models", "advanced"] as const}>
            {(tab) => <Tabs.Trigger value={tab}>{language.t(`settings.modelRouter.tab.${tab}`)}</Tabs.Trigger>}
          </For>
        </Tabs.List>
        <fieldset
          disabled={state.saving}
          class="model-router-body"
          aria-label={language.t("settings.modelRouter.title")}
        >
          <Tabs.Content value="routing" class="model-router-panel">
            <div class="model-router-enable model-router-card">
              <div>
                <h3>{language.t("settings.modelRouter.enabled.title")}</h3>
                <p class="model-router-muted">{language.t("settings.modelRouter.enabled.description")}</p>
              </div>
              <Switch
                checked={form.enabled}
                disabled={state.saving}
                onChange={(checked) => setForm("enabled", checked)}
                hideLabel
              >
                {language.t("settings.modelRouter.enabled.title")}
              </Switch>
            </div>
            <div class="model-router-enable model-router-card">
              <div>
                <h3>{language.t("settings.modelRouter.omo.title")}</h3>
                <p class="model-router-muted">{language.t("settings.modelRouter.omo.description")}</p>
              </div>
              <Switch
                checked={hasOmoPlugin(serverSync().data.config.plugin)}
                disabled={state.saving}
                onChange={(checked) => {
                  void serverSync().updateConfig({
                    plugin: setOmoPlugin(serverSync().data.config.plugin, checked) as (
                      | string
                      | [string, { [key: string]: unknown }]
                    )[],
                  })
                }}
                hideLabel
              >
                {language.t("settings.modelRouter.omo.title")}
              </Switch>
            </div>
            <div class="model-router-enable model-router-card">
              <div>
                <h3>{language.t("settings.modelRouter.autoRoute.title")}</h3>
                <p class="model-router-muted">{language.t("settings.modelRouter.autoRoute.description")}</p>
              </div>
              <Switch
                checked={form.autoRoute}
                disabled={state.saving}
                onChange={(checked) => setForm("autoRoute", checked)}
                hideLabel
              >
                {language.t("settings.modelRouter.autoRoute.title")}
              </Switch>
            </div>
            <Show when={!form.models.length && !form.allowUnscored}>
              <div class="model-router-empty">
                <h3>{language.t("settings.modelRouter.start.title")}</h3>
                <p>{language.t("settings.modelRouter.start.description")}</p>
                <ButtonV2 variant="neutral" onClick={() => setState("tab", "models")}>
                  {language.t("settings.modelRouter.chooseModels")}
                </ButtonV2>
              </div>
            </Show>
            <ModelRouterRoutes
              form={form}
              setForm={setForm}
              catalog={catalog()}
              agents={agents()}
              onPriority={changePriority}
              onModels={() => setState("tab", "models")}
            />
          </Tabs.Content>

          <Tabs.Content value="models" class="model-router-panel">
            <ModelRouterModels
              form={form}
              setForm={setForm}
              catalog={catalog()}
              onProviders={() => setState("tab", "advanced")}
            />
          </Tabs.Content>

          <Tabs.Content value="advanced" class="model-router-panel">
            <section class="model-router-section">
              <div class="model-router-section-heading">
                <div>
                  <h3>{language.t("settings.modelRouter.providers.title")}</h3>
                  <p class="model-router-muted">{language.t("settings.modelRouter.providers.help")}</p>
                </div>
                <Show when={form.providers.length}>
                  <ButtonV2 size="small" variant="ghost-muted" onClick={() => setForm("providers", [])}>
                    {language.t("settings.modelRouter.providers.automatic")}
                  </ButtonV2>
                </Show>
              </div>
              <p class="model-router-notice">
                {language.t(
                  form.providers.length
                    ? "settings.modelRouter.providers.selected"
                    : "settings.modelRouter.providers.default",
                )}
              </p>
              <div class="model-router-provider-list">
                <For
                  each={providers()}
                  fallback={<p class="model-router-muted">{language.t("settings.modelRouter.providers.empty")}</p>}
                >
                  {(provider) => (
                    <label class="model-router-choice">
                      <input
                        type="checkbox"
                        aria-label={provider.name}
                        checked={form.providers.includes(provider.id)}
                        onChange={(event) =>
                          setForm("providers", (current) =>
                            event.currentTarget.checked
                              ? [...current, provider.id]
                              : current.filter((id) => id !== provider.id),
                          )
                        }
                      />
                      <span>
                        <bdi>{provider.name}</bdi>
                        <small dir="ltr">{provider.id}</small>
                      </span>
                    </label>
                  )}
                </For>
              </div>
            </section>

            <section class="model-router-section">
              <h3>{language.t("settings.modelRouter.behavior")}</h3>
              <For each={["allowUnscored", "overrideExplicit", "legacyAssign"] as const}>
                {(key) => (
                  <div class="model-router-enable model-router-card">
                    <div>
                      <h4>{language.t(`settings.modelRouter.${key}.title`)}</h4>
                      <p class="model-router-muted">{language.t(`settings.modelRouter.${key}.description`)}</p>
                    </div>
                    <Switch
                      checked={form[key]}
                      disabled={state.saving}
                      onChange={(checked) => setForm(key, checked)}
                      hideLabel
                    >
                      {language.t(`settings.modelRouter.${key}.title`)}
                    </Switch>
                  </div>
                )}
              </For>
            </section>

            <section class="model-router-section">
              <div>
                <h3>{language.t("settings.modelRouter.weights.title")}</h3>
                <p class="model-router-muted">{language.t("settings.modelRouter.weights.help")}</p>
              </div>
              <For each={TASK_NAMES}>
                {(task) => (
                  <div class="model-router-card model-router-weight-card">
                    <h4>{language.t(`settings.modelRouter.task.${task}`)}</h4>
                    <div class="model-router-weight-fields">
                      <For each={["capability", "price", "speed"] as const}>
                        {(dim) => {
                          const key = `${task}:${dim}`
                          const bad = () => state.raw[key] !== undefined && parseWeight(state.raw[key]) === undefined
                          return (
                            <label class="model-router-field">
                              <span>{language.t(`settings.modelRouter.${dim}`)}</span>
                              <TextInputV2
                                type="text"
                                inputmode="decimal"
                                numeric
                                aria-label={language.t("settings.modelRouter.weightLabel", {
                                  task: language.t(`settings.modelRouter.task.${task}`),
                                  dimension: language.t(`settings.modelRouter.${dim}`),
                                })}
                                invalid={bad()}
                                value={state.raw[key] ?? String(form.taskWeights[task][dim])}
                                onInput={(event) => {
                                  const value = event.currentTarget.value
                                  setState("raw", key, value)
                                  const parsed = parseWeight(value)
                                  if (parsed !== undefined) setForm("taskWeights", task, dim, parsed)
                                }}
                              />
                              <Show when={bad()}>
                                <span class="model-router-field-error">
                                  {language.t("settings.modelRouter.weightInvalid")}
                                </span>
                              </Show>
                            </label>
                          )
                        }}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </section>
          </Tabs.Content>
        </fieldset>
      </Tabs>
    </div>
  )
}
