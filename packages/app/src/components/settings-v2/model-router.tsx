import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode-ai/ui/v2/dialog-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createQuery } from "@tanstack/solid-query"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { useProviders } from "@/hooks/use-providers"
import { useServerSync } from "@/context/server-sync"
import { pathKey } from "@/utils/path-key"
import { showToast } from "@/utils/toast"
import {
  TASK_NAMES,
  formFromConfig,
  serializeForm,
  validateForm,
  type ModelRouterFormState,
  type ModelScoreRow,
  type TaskName,
} from "./model-router-payload"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type RawScores = Record<string, string>

const scoreKey = (prefix: string, index: number, dim: string) => `${prefix}:${index}:${dim}`

export const SettingsModelRouterV2: Component<{ directory?: string }> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const serverSync = useServerSync()
  const models = useModels()
  const agentsQuery = createQuery(() => serverSync().queryOptions.agents(pathKey(props.directory ?? "")))

  const config = () => serverSync().data.config?.model_router as Record<string, unknown> | undefined

  const [form, setForm] = createStore<ModelRouterFormState>(formFromConfig(config()))
  const [raw, setRaw] = createStore<RawScores>({})
  const [saving, setSaving] = createSignal(false)
  const [errors, setErrors] = createSignal<string[]>([])

  const dirty = createMemo(() => {
    return JSON.stringify(serializeForm(form)) !== JSON.stringify(serializeForm(formFromConfig(config())))
  })

  const reset = () => {
    setForm(formFromConfig(config()))
    setRaw({})
    setErrors([])
  }

  const parseScore = (value: string) => {
    const parsed = Number(value.trim())
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) return undefined
    return parsed
  }

  const agentOptions = createMemo(() => (agentsQuery.data ?? []).map((agent) => agent.name))

  const providerOptions = createMemo(() => {
    const chosen = new Set(form.providers)
    return Array.from(new Set(Object.keys(serverSync().data.provider.all))).filter((id) => !chosen.has(id))
  })

  const invalidRaw = createMemo(() =>
    Object.entries(raw).filter(([key, value]) => {
      const [scope, , dim] = key.split(":")
      if (dim === undefined) return false
      const trimmed = value.trim()
      if (trimmed === "") return true
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed)) return true
      if (scope === "m") return !Number.isInteger(parsed) || parsed < 1 || parsed > 10
      return parsed < 0
    }),
  )

  const save = async () => {
    const badRaw = invalidRaw()
    if (badRaw.length > 0) {
      showToast({ variant: "error", description: language.t("settings.modelRouter.invalid") })
      return
    }
    const result = validateForm(form)
    if (!result.ok) {
      setErrors(result.errors)
      showToast({ variant: "error", description: language.t("settings.modelRouter.invalid") })
      return
    }
    setErrors([])
    setSaving(true)
    try {
      await serverSync().updateConfig({ model_router: result.value })
      setRaw({})
      setErrors([])
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.modelRouter.saved"),
        description: language.t("settings.modelRouter.appliesOnRestart"),
      })
    } catch (error) {
      showToast({
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setSaving(false)
    }
  }

  const addModelDialog = () => {
    const chosen = new Set(form.models.map((model) => model.key))
    const [query, setQuery] = createSignal("")
    const matches = createMemo(() => {
      const q = query().trim().toLowerCase()
      const all = models
        .list()
        .map((model) => ({ key: `${model.provider.id}/${model.id}`, name: model.name, provider: model.provider.name }))
        .filter((model) => !chosen.has(model.key))
      if (!q) return all.slice(0, 200)
      return all
        .filter((model) => model.key.toLowerCase().includes(q) || model.name.toLowerCase().includes(q))
        .slice(0, 200)
    })
    const add = (key: string) => {
      setForm(
        produce((draft) => {
          draft.models.push({ key, tags: [], price: 5, capability: 5, speed: 5 })
        }),
      )
      setRaw({})
      dialog.close()
    }
    dialog.push(() => (
      <Dialog fit>
        <DialogHeader>
          <DialogTitleGroup
            title={language.t("settings.modelRouter.add.title")}
            description={language.t("settings.modelRouter.add.description")}
          />
        </DialogHeader>
        <DialogBody class="flex w-full min-w-0 flex-1 flex-col gap-3 px-4 pt-4 pb-2">
          <TextInputV2
            type="search"
            appearance="base"
            value={query()}
            placeholder={language.t("settings.modelRouter.model")}
            onInput={(event) => setQuery(event.currentTarget.value)}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
          />
          <div class="flex max-h-80 flex-col overflow-y-auto">
            <For each={matches()}>
              {(model) => (
                <button
                  type="button"
                  class="flex flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-left hover:bg-v2-overlay-simple-overlay-hover"
                  onClick={() => add(model.key)}
                >
                  <span class="text-13-regular text-text-base">{model.key}</span>
                  <span class="text-12-regular text-text-muted-base">
                    {model.name} · {model.provider}
                  </span>
                </button>
              )}
            </For>
          </div>
        </DialogBody>
        <DialogFooter>
          <ButtonV2 variant="neutral" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </ButtonV2>
        </DialogFooter>
      </Dialog>
    ))
  }

  const confirmRemove = (model: ModelScoreRow, index: number) => {
    dialog.push(() => (
      <Dialog fit>
        <DialogHeader>
          <DialogTitleGroup
            title={language.t("settings.modelRouter.remove.title")}
            description={language.t("settings.modelRouter.remove.description", { model: model.key })}
          />
        </DialogHeader>
        <DialogFooter>
          <ButtonV2 variant="neutral" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2
            variant="danger"
            onClick={() => {
              setForm(
                produce((draft) => {
                  draft.models.splice(index, 1)
                }),
              )
              setRaw({})
              dialog.close()
            }}
          >
            {language.t("common.delete")}
          </ButtonV2>
        </DialogFooter>
      </Dialog>
    ))
  }

  const scoreInput = (key: string, value: number, onInput: (value: string) => void) => (
    <TextInputV2
      type="text"
      appearance="base"
      class="w-14"
      numeric
      value={raw[key] ?? String(value)}
      onInput={(event) => onInput(event.currentTarget.value)}
    />
  )

  return (
    <>
      <div class="settings-v2-tab-header">
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("settings.modelRouter.title")}</h2>
          <div class="flex items-center gap-2">
            <ButtonV2 size="normal" variant="ghost-muted" disabled={!dirty() || saving()} onClick={reset}>
              {language.t("common.discard")}
            </ButtonV2>
            <ButtonV2 size="normal" variant="neutral" disabled={!dirty() || saving()} onClick={() => void save()}>
              {language.t("settings.modelRouter.save")}
            </ButtonV2>
          </div>
        </div>
      </div>

      <div class="settings-v2-tab-body">
        <p class="settings-v2-plugins-note">{language.t("settings.modelRouter.description")}</p>

        <Show when={errors().length > 0}>
          <p class="settings-v2-plugins-note">
            {language.t("settings.modelRouter.invalid")} {errors().join(", ")}
          </p>
        </Show>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.tab.general")}</h3>
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.modelRouter.autoRoute.title")}
              description={language.t("settings.modelRouter.autoRoute.description")}
            >
              <Switch checked={form.autoRoute} onChange={(checked) => setForm("autoRoute", checked)} hideLabel>
                {language.t("settings.modelRouter.autoRoute.title")}
              </Switch>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.modelRouter.allowUnscored.title")}
              description={language.t("settings.modelRouter.allowUnscored.description")}
            >
              <Switch checked={form.allowUnscored} onChange={(checked) => setForm("allowUnscored", checked)} hideLabel>
                {language.t("settings.modelRouter.allowUnscored.title")}
              </Switch>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("settings.modelRouter.overrideExplicit.title")}
              description={language.t("settings.modelRouter.overrideExplicit.description")}
            >
              <Switch
                checked={form.overrideExplicit}
                onChange={(checked) => setForm("overrideExplicit", checked)}
                hideLabel
              >
                {language.t("settings.modelRouter.overrideExplicit.title")}
              </Switch>
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.modelRouter.providers.title")}</h3>
          <p class="settings-v2-plugins-note">{language.t("settings.modelRouter.providers.description")}</p>
          <div class="flex flex-wrap items-center gap-1.5 py-1">
            <For each={form.providers}>
              {(provider, index) => (
                <span class="flex items-center gap-1">
                  <Tag variant="neutral">{provider}</Tag>
                  <IconButtonV2
                    type="button"
                    size="small"
                    variant="ghost-muted"
                    icon={<Icon name="close-small" />}
                    aria-label={language.t("settings.modelRouter.providers.add")}
                    onClick={() =>
                      setForm(
                        produce((draft) => {
                          draft.providers.splice(index(), 1)
                        }),
                      )
                    }
                  />
                </span>
              )}
            </For>
            <Show when={providerOptions().length > 0}>
              <SelectV2
                appearance="inline"
                options={providerOptions()}
                value={(option) => option}
                label={(option) => option}
                onSelect={(option) => {
                  if (!option) return
                  setForm(
                    produce((draft) => {
                      if (!draft.providers.includes(option)) draft.providers.push(option)
                    }),
                  )
                }}
                placeholder={language.t("settings.modelRouter.providers.add")}
              />
            </Show>
          </div>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.modelRouter.agents.title")}</h3>
          <p class="settings-v2-plugins-note">{language.t("settings.modelRouter.agents.description")}</p>
          <SettingsListV2>
            <For each={form.agentTasks}>
              {(row, index) => (
                <SettingsRowV2 title={row.agent} description={language.t(`settings.modelRouter.model`)}>
                  <div class="flex items-center gap-1.5">
                    <SelectV2
                      appearance="inline"
                      options={agentOptions()}
                      current={row.agent}
                      value={(option) => option}
                      label={(option) => option}
                      onSelect={(option) => {
                        if (!option) return
                        setForm("agentTasks", index(), "agent", option)
                      }}
                    />
                    <SelectV2
                      appearance="inline"
                      options={TASK_NAMES}
                      current={row.task}
                      value={(option) => option}
                      label={(option) => option}
                      onSelect={(option) => {
                        if (!option) return
                        setForm("agentTasks", index(), "task", option)
                      }}
                    />
                    <IconButtonV2
                      type="button"
                      size="small"
                      variant="ghost-muted"
                      icon={<Icon name="trash" />}
                      aria-label={language.t("settings.modelRouter.scorecard.remove")}
                      onClick={() =>
                        setForm(
                          produce((draft) => {
                            draft.agentTasks.splice(index(), 1)
                          }),
                        )
                      }
                    />
                  </div>
                </SettingsRowV2>
              )}
            </For>
          </SettingsListV2>
          <div class="pt-2">
            <ButtonV2
              size="small"
              variant="outline"
              onClick={() =>
                setForm(
                  produce((draft) => {
                    const used = new Set(draft.agentTasks.map((row) => row.agent))
                    const next = agentOptions().find((agent) => !used.has(agent))
                    if (!next) return
                    draft.agentTasks.push({ agent: next, task: "coding" })
                  }),
                )
              }
            >
              {language.t("settings.modelRouter.agents.add")}
            </ButtonV2>
          </div>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.modelRouter.weights.title")}</h3>
          <p class="settings-v2-plugins-note">{language.t("settings.modelRouter.weights.description")}</p>
          <SettingsListV2>
            <For each={TASK_NAMES}>
              {(task, index) => (
                <SettingsRowV2 title={task} description={language.t("settings.modelRouter.weights.description")}>
                  <div class="flex items-center gap-1.5">
                    {scoreInput(scoreKey("w", index(), "capability"), form.taskWeights[task].capability, (value) => {
                      setRaw(scoreKey("w", index(), "capability"), value)
                      const parsed = Number(value)
                      if (!Number.isFinite(parsed) || parsed < 0) return
                      setForm("taskWeights", task, "capability", parsed)
                    })}
                    {scoreInput(scoreKey("w", index(), "price"), form.taskWeights[task].price, (value) => {
                      setRaw(scoreKey("w", index(), "price"), value)
                      const parsed = Number(value)
                      if (!Number.isFinite(parsed) || parsed < 0) return
                      setForm("taskWeights", task, "price", parsed)
                    })}
                    {scoreInput(scoreKey("w", index(), "speed"), form.taskWeights[task].speed, (value) => {
                      setRaw(scoreKey("w", index(), "speed"), value)
                      const parsed = Number(value)
                      if (!Number.isFinite(parsed) || parsed < 0) return
                      setForm("taskWeights", task, "speed", parsed)
                    })}
                  </div>
                </SettingsRowV2>
              )}
            </For>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.modelRouter.scorecard.title")}</h3>
          <p class="settings-v2-plugins-note">{language.t("settings.modelRouter.scorecard.description")}</p>
          <Show
            when={form.models.length > 0}
            fallback={<p class="settings-v2-plugins-note">{language.t("settings.modelRouter.scorecard.empty")}</p>}
          >
            <SettingsListV2>
              <For each={form.models}>
                {(model, index) => (
                  <SettingsRowV2
                    title={model.key}
                    description={
                      <TextInputV2
                        type="text"
                        appearance="base"
                        value={model.tags.join(", ")}
                        placeholder={language.t("settings.modelRouter.tags")}
                        onInput={(event) => {
                          const tags = event.currentTarget.value
                            .split(",")
                            .map((tag) => tag.trim())
                            .filter((tag): tag is TaskName => (TASK_NAMES as string[]).includes(tag))
                          setForm("models", index(), "tags", tags)
                        }}
                      />
                    }
                  >
                    <div class="flex items-center gap-1.5">
                      {scoreInput(scoreKey("m", index(), "capability"), model.capability, (value) => {
                        setRaw(scoreKey("m", index(), "capability"), value)
                        const parsed = parseScore(value)
                        if (parsed === undefined) return
                        setForm("models", index(), "capability", parsed)
                      })}
                      {scoreInput(scoreKey("m", index(), "price"), model.price, (value) => {
                        setRaw(scoreKey("m", index(), "price"), value)
                        const parsed = parseScore(value)
                        if (parsed === undefined) return
                        setForm("models", index(), "price", parsed)
                      })}
                      {scoreInput(scoreKey("m", index(), "speed"), model.speed, (value) => {
                        setRaw(scoreKey("m", index(), "speed"), value)
                        const parsed = parseScore(value)
                        if (parsed === undefined) return
                        setForm("models", index(), "speed", parsed)
                      })}
                      <IconButtonV2
                        type="button"
                        size="small"
                        variant="ghost-muted"
                        icon={<Icon name="trash" />}
                        aria-label={language.t("settings.modelRouter.scorecard.remove")}
                        onClick={() => confirmRemove(model, index())}
                      />
                    </div>
                  </SettingsRowV2>
                )}
              </For>
            </SettingsListV2>
          </Show>
          <div class="pt-2">
            <ButtonV2 size="small" variant="outline" onClick={addModelDialog}>
              {language.t("settings.modelRouter.scorecard.add")}
            </ButtonV2>
          </div>
        </div>
      </div>
    </>
  )
}
