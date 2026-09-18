import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode-ai/ui/v2/dialog-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { For, Show, createMemo, createUniqueId } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { TASK_NAMES, type ModelRouterFormState } from "./model-router-payload"
import { modelAvailability, type RouterModel } from "./model-router-preview"

export function ModelRouterModels(props: {
  form: ModelRouterFormState
  setForm: SetStoreFunction<ModelRouterFormState>
  catalog: RouterModel[]
  onProviders: () => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const id = createUniqueId()
  const [state, setState] = createStore({ search: "", expanded: "" })
  const catalog = createMemo(() => new Map(props.catalog.map((model) => [model.key, model])))
  const filtered = createMemo(() =>
    props.form.models.filter((model) => {
      const item = catalog().get(model.key)
      return `${model.key} ${item?.name ?? ""} ${item?.provider ?? ""}`
        .toLowerCase()
        .includes(state.search.trim().toLowerCase())
    }),
  )
  const available = createMemo(() =>
    props.catalog.filter(
      (model) =>
        modelAvailability(props.form, model) === "available" &&
        !props.form.models.some((row) => row.key === model.key),
    ),
  )
  const scoreModel = (key: string) =>
    props.setForm("models", (rows) => [...rows, { key, tags: [], capability: 5, price: 5, speed: 5 }])

  const add = () =>
    dialog.push(() => (
      <ModelRouterPicker
        models={props.catalog.filter(
          (model) =>
            modelAvailability(props.form, model) === "available" &&
            !props.form.models.some((row) => row.key === model.key),
        )}
        onAdd={(keys) => {
          props.setForm("models", (rows) => [
            ...rows,
            ...keys
              .filter((key) => !rows.some((row) => row.key === key))
              .map((key) => ({ key, tags: [], capability: 5, price: 5, speed: 5 })),
          ])
          setState("search", "")
          dialog.close()
        }}
        onProviders={() => {
          dialog.close()
          props.onProviders()
        }}
      />
    ))

  return (
    <>
      <div class="model-router-section-heading">
        <div>
          <h3>{language.t("settings.modelRouter.models.title")}</h3>
          <p class="model-router-muted">{language.t("settings.modelRouter.models.description")}</p>
        </div>
        <ButtonV2 variant="neutral" onClick={add}>
          {language.t("settings.modelRouter.addModels")}
        </ButtonV2>
      </div>
      <Show
        when={props.form.models.length}
        fallback={
          <div class="model-router-empty">
            <h3>{language.t("settings.modelRouter.scorecard.empty")}</h3>
            <p>{language.t("settings.modelRouter.models.empty")}</p>
          </div>
        }
      >
        <TextInputV2
          type="search"
          appearance="large"
          aria-label={language.t("settings.modelRouter.searchModels")}
          placeholder={language.t("settings.modelRouter.searchModels")}
          value={state.search}
          onInput={(event) => setState("search", event.currentTarget.value)}
        />
        <div class="model-router-model-list">
          <For
            each={filtered()}
            fallback={<p class="model-router-notice">{language.t("settings.modelRouter.noMatches")}</p>}
          >
            {(model) => {
              const index = () => props.form.models.findIndex((row) => row.key === model.key)
              const meta = () => catalog().get(model.key)
              const name = () => meta()?.name ?? model.key.slice(model.key.indexOf("/") + 1)
              const status = () => modelAvailability(props.form, meta())
              const expanded = () => state.expanded === model.key
              const panel = `${id}-${encodeURIComponent(model.key)}`
              return (
                <article class="model-router-card model-router-model" aria-label={name()}>
                  <div class="model-router-section-heading">
                    <div class="model-router-model-name">
                      <h4>
                        <bdi>{name()}</bdi>
                      </h4>
                      <p class="model-router-muted">
                        <bdi>{meta()?.provider ?? model.key.split("/")[0]}</bdi>
                      </p>
                    </div>
                    <div class="model-router-actions">
                      <ButtonV2
                        size="small"
                        variant="outline"
                        aria-expanded={expanded()}
                        aria-controls={panel}
                        onClick={() => setState("expanded", expanded() ? "" : model.key)}
                      >
                        {language.t(expanded() ? "settings.modelRouter.done" : "settings.modelRouter.editScores")}
                      </ButtonV2>
                      <ButtonV2
                        size="small"
                        variant="ghost-muted"
                        aria-label={language.t("settings.modelRouter.removeNamed", { model: name() })}
                        onClick={() => props.setForm("models", (rows) => rows.filter((row) => row.key !== model.key))}
                      >
                        {language.t("settings.modelRouter.remove")}
                      </ButtonV2>
                    </div>
                  </div>
                  <Show when={status() !== "available"}>
                    <p class="model-router-notice">{language.t(`settings.modelRouter.availability.${status()}`)}</p>
                  </Show>
                  <div class="model-router-score-summary">
                    <For each={["capability", "price", "speed"] as const}>
                      {(dim) => (
                        <span>
                          {language.t(`settings.modelRouter.${dim}`)} <strong>{model[dim]}</strong>
                          <span class="model-router-muted">/10</span>
                        </span>
                      )}
                    </For>
                  </div>
                  <Show when={!expanded()}>
                    <div class="model-router-chips" role="group" aria-label={language.t("settings.modelRouter.tasks")}>
                      <Show
                        when={model.tags.length}
                        fallback={
                          <span class="model-router-chip-label">{language.t("settings.modelRouter.allTasks")}</span>
                        }
                      >
                        <For each={model.tags}>
                          {(task) => (
                            <span class="model-router-chip-label">
                              {language.t(`settings.modelRouter.task.${task}`)}
                            </span>
                          )}
                        </For>
                      </Show>
                    </div>
                  </Show>
                  <Show when={expanded()}>
                    <div id={panel} class="model-router-model-editor">
                      <p class="model-router-muted">{language.t("settings.modelRouter.scores.help")}</p>
                      <For each={["capability", "price", "speed"] as const}>
                        {(dim) => (
                          <label class="model-router-slider">
                            <span class="model-router-section-heading">
                              <span>{language.t(`settings.modelRouter.${dim}`)}</span>
                              <strong>
                                {model[dim]}
                                <span class="model-router-muted">/10</span>
                              </strong>
                            </span>
                            <input
                              type="range"
                              min="1"
                              max="10"
                              step="1"
                              aria-label={language.t("settings.modelRouter.scoreLabel", {
                                model: name(),
                                dimension: language.t(`settings.modelRouter.${dim}`),
                              })}
                              value={model[dim]}
                              onInput={(event) =>
                                props.setForm("models", index(), dim, Number(event.currentTarget.value))
                              }
                            />
                            <span class="model-router-slider-scale">
                              <span>{language.t(`settings.modelRouter.scale.${dim}.low`)}</span>
                              <span>{language.t(`settings.modelRouter.scale.${dim}.high`)}</span>
                            </span>
                          </label>
                        )}
                      </For>
                      <div>
                        <h4>{language.t("settings.modelRouter.tasks")}</h4>
                        <p class="model-router-muted">{language.t("settings.modelRouter.tasks.help")}</p>
                      </div>
                      <div class="model-router-chips">
                        <button
                          type="button"
                          aria-pressed={!model.tags.length}
                          onClick={() => props.setForm("models", index(), "tags", [])}
                        >
                          {language.t("settings.modelRouter.allTasks")}
                        </button>
                        <For each={TASK_NAMES}>
                          {(task) => (
                            <button
                              type="button"
                              aria-pressed={model.tags.includes(task)}
                              onClick={() =>
                                props.setForm("models", index(), "tags", (tags) =>
                                  tags.includes(task) ? tags.filter((value) => value !== task) : [...tags, task],
                                )
                              }
                            >
                              {language.t(`settings.modelRouter.task.${task}`)}
                            </button>
                          )}
                        </For>
                      </div>
                      <code class="model-router-id" dir="ltr">
                        {model.key}
                      </code>
                    </div>
                  </Show>
                </article>
              )
            }}
          </For>
        </div>
      </Show>

      <Show when={available().length}>
        <section class="model-router-section">
          <div class="model-router-section-heading">
            <div>
              <h3>{language.t("settings.modelRouter.models.available")}</h3>
              <p class="model-router-muted">{language.t("settings.modelRouter.models.notScored")}</p>
            </div>
          </div>
          <div class="model-router-chips">
            <For each={available().slice(0, 50)}>
              {(model) => (
                <button type="button" onClick={() => scoreModel(model.key)}>
                  <bdi>{model.name}</bdi>
                  <span class="model-router-muted"> {model.provider}</span>
                </button>
              )}
            </For>
          </div>
        </section>
      </Show>
    </>
  )
}

function ModelRouterPicker(props: { models: RouterModel[]; onAdd: (keys: string[]) => void; onProviders: () => void }) {
  const language = useLanguage()
  const dialog = useDialog()
  const [state, setState] = createStore({ search: "", selected: [] as string[] })
  const matches = createMemo(() =>
    props.models.filter((model) =>
      `${model.name} ${model.provider} ${model.key}`.toLowerCase().includes(state.search.trim().toLowerCase()),
    ),
  )
  const groups = createMemo(() => Array.from(new Set(matches().map((model) => model.providerID))))
  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup
          title={language.t("settings.modelRouter.addModels")}
          description={language.t("settings.modelRouter.picker.description")}
        />
      </DialogHeader>
      <DialogBody class="model-router-picker">
        <TextInputV2
          type="search"
          appearance="large"
          aria-label={language.t("settings.modelRouter.searchModels")}
          placeholder={language.t("settings.modelRouter.searchModels")}
          value={state.search}
          onInput={(event) => setState("search", event.currentTarget.value)}
          autofocus
        />
        <Show
          when={props.models.length}
          fallback={
            <div class="model-router-empty">
              <p>{language.t("settings.modelRouter.picker.empty")}</p>
              <ButtonV2 variant="outline" onClick={props.onProviders}>
                {language.t("settings.modelRouter.reviewProviders")}
              </ButtonV2>
            </div>
          }
        >
          <div class="model-router-picker-toolbar">
            <span>{language.t("settings.modelRouter.picker.selected", { count: state.selected.length })}</span>
            <ButtonV2
              size="small"
              variant="ghost-muted"
              disabled={!matches().length}
              onClick={() =>
                setState("selected", (keys) => Array.from(new Set([...keys, ...matches().map((model) => model.key)])))
              }
            >
              {language.t("settings.modelRouter.picker.selectVisible")}
            </ButtonV2>
          </div>
          <div class="model-router-picker-list">
            <For
              each={groups()}
              fallback={<p class="model-router-notice">{language.t("settings.modelRouter.noMatches")}</p>}
            >
              {(provider) => (
                <section>
                  <h4>
                    <bdi>{matches().find((model) => model.providerID === provider)?.provider}</bdi>
                  </h4>
                  <For each={matches().filter((model) => model.providerID === provider)}>
                    {(model) => (
                      <label class="model-router-choice">
                        <input
                          type="checkbox"
                          aria-label={model.name}
                          checked={state.selected.includes(model.key)}
                          onChange={(event) =>
                            setState("selected", (keys) =>
                              event.currentTarget.checked
                                ? [...keys, model.key]
                                : keys.filter((key) => key !== model.key),
                            )
                          }
                        />
                        <span>
                          <bdi>{model.name}</bdi>
                          <small dir="ltr">{model.key}</small>
                        </span>
                      </label>
                    )}
                  </For>
                </section>
              )}
            </For>
          </div>
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="ghost-muted" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={!state.selected.length} onClick={() => props.onAdd(state.selected)}>
          {language.t("settings.modelRouter.picker.addSelected")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
