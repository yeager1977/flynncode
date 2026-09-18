import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { For, Show, createMemo } from "solid-js"
import { produce, type SetStoreFunction } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { TASK_NAMES, type ModelRouterFormState, type TaskName } from "./model-router-payload"
import {
  PRIORITIES,
  modelAvailability,
  previewTask,
  selectedPriority,
  type Priority,
  type RouterModel,
} from "./model-router-preview"

export function ModelRouterRoutes(props: {
  form: ModelRouterFormState
  setForm: SetStoreFunction<ModelRouterFormState>
  catalog: RouterModel[]
  agents: string[]
  onPriority: (task: TaskName, priority: Priority) => void
  onModels: () => void
}) {
  const language = useLanguage()
  const unused = createMemo(() =>
    props.agents.filter((agent) => !props.form.agentTasks.some((row) => row.agent === agent)),
  )
  const previews = createMemo(
    () => new Map(TASK_NAMES.map((task) => [task, previewTask(props.form, props.catalog, task)])),
  )
  const selectable = createMemo(() =>
    props.catalog.filter((model) => modelAvailability(props.form, model) === "available"),
  )
  // A saved pin can point outside the current scope or vanish from the catalog.
  // Keep it selectable so the control reflects the stored value instead of
  // silently implying "Automatic".
  const orphan = (task: TaskName) => {
    const key = props.form.taskModels[task]
    if (!key || selectable().some((model) => model.key === key)) return undefined
    return key
  }
  const setPinned = (task: TaskName, key: string) =>
    props.setForm(
      "taskModels",
      produce((draft) => {
        if (key === "") delete draft[task]
        else draft[task] = key
      }),
    )
  return (
    <>
      <section class="model-router-section">
        <div class="model-router-section-heading">
          <div>
            <h3>{language.t("settings.modelRouter.agents.routing")}</h3>
            <p class="model-router-muted">{language.t("settings.modelRouter.agents.help")}</p>
          </div>
          <select
            class="model-router-select"
            aria-label={language.t("settings.modelRouter.agents.add")}
            disabled={!unused().length}
            value=""
            onChange={(event) => {
              const agent = event.currentTarget.value
              if (!agent) return
              props.setForm("agentTasks", (rows) => [...rows, { agent, task: "coding" }])
              event.currentTarget.value = ""
            }}
          >
            <option value="">{language.t("settings.modelRouter.agents.add")}</option>
            <For each={unused()}>{(agent) => <option value={agent}>{agent}</option>}</For>
          </select>
        </div>
        <p class="model-router-notice">{language.t("settings.modelRouter.preview.help")}</p>
        <Show when={!props.form.autoRoute}>
          <p class="model-router-notice">{language.t("settings.modelRouter.preview.paused")}</p>
        </Show>
        <div class="model-router-agent-list">
          <For
            each={props.form.agentTasks}
            fallback={<p class="model-router-notice">{language.t("settings.modelRouter.agents.empty")}</p>}
          >
            {(row, index) => (
              <article
                class="model-router-agent-row"
                aria-label={language.t("settings.modelRouter.agentRoute", { agent: row.agent })}
              >
                <div class="model-router-agent-name">
                  <span class="model-router-eyebrow">{language.t("settings.modelRouter.agent")}</span>
                  <bdi>{row.agent}</bdi>
                </div>
                <label class="model-router-field">
                  <span>{language.t("settings.modelRouter.taskType")}</span>
                  <select
                    class="model-router-select"
                    aria-label={language.t("settings.modelRouter.agentTask", { agent: row.agent })}
                    value={row.task}
                    onChange={(event) =>
                      props.setForm("agentTasks", index(), "task", event.currentTarget.value as TaskName)
                    }
                  >
                    <For each={TASK_NAMES}>
                      {(task) => <option value={task}>{language.t(`settings.modelRouter.task.${task}`)}</option>}
                    </For>
                  </select>
                </label>
                <div class="model-router-match model-router-agent-match">
                  <span class="model-router-eyebrow">{language.t("settings.modelRouter.preview.top")}</span>
                  <bdi>
                    {previews().get(row.task)?.[0]?.model.name ?? language.t("settings.modelRouter.preview.empty")}
                  </bdi>
                </div>
                <ButtonV2
                  size="small"
                  variant="ghost-muted"
                  aria-label={language.t("settings.modelRouter.agents.remove", { agent: row.agent })}
                  onClick={() =>
                    props.setForm(
                      produce((draft) => {
                        draft.agentTasks.splice(index(), 1)
                      }),
                    )
                  }
                >
                  {language.t("settings.modelRouter.remove")}
                </ButtonV2>
              </article>
            )}
          </For>
        </div>
      </section>

      <section class="model-router-section">
        <div>
          <h3>{language.t("settings.modelRouter.priorities.title")}</h3>
          <p class="model-router-muted">{language.t("settings.modelRouter.priorities.description")}</p>
        </div>
        <div class="model-router-task-grid">
          <For each={TASK_NAMES}>
            {(task) => {
              const matches = () => previews().get(task) ?? []
              const priority = () => selectedPriority(task, props.form.taskWeights[task])
              return (
                <article
                  class="model-router-card model-router-task-card"
                  aria-label={language.t(`settings.modelRouter.task.${task}`)}
                >
                  <div class="model-router-section-heading">
                    <h4>{language.t(`settings.modelRouter.task.${task}`)}</h4>
                    <select
                      class="model-router-select"
                      aria-label={language.t("settings.modelRouter.priorityLabel", {
                        task: language.t(`settings.modelRouter.task.${task}`),
                      })}
                      value={priority()}
                      onChange={(event) => props.onPriority(task, event.currentTarget.value as Priority)}
                    >
                      <Show when={priority() === "custom"}>
                        <option value="custom" disabled>
                          {language.t("settings.modelRouter.priority.custom")}
                        </option>
                      </Show>
                      <For each={PRIORITIES}>
                        {(value) => (
                          <option value={value}>{language.t(`settings.modelRouter.priority.${value}`)}</option>
                        )}
                      </For>
                    </select>
                  </div>
                  <div class="model-router-match">
                    <span class="model-router-eyebrow">{language.t("settings.modelRouter.preview.top")}</span>
                    <Show
                      when={matches()[0]}
                      fallback={
                        <span class="model-router-muted">{language.t("settings.modelRouter.preview.empty")}</span>
                      }
                    >
                      {(winner) => (
                        <>
                          <strong>
                            <bdi>{winner().model.name}</bdi>
                          </strong>
                          <span class="model-router-muted">
                            <bdi>{winner().model.provider}</bdi>
                          </span>
                        </>
                      )}
                    </Show>
                  </div>
                  <label class="model-router-field">
                    <span>{language.t("settings.modelRouter.taskModel.label", { task: language.t(`settings.modelRouter.task.${task}`) })}</span>
                    <select
                      class="model-router-select"
                      aria-label={language.t("settings.modelRouter.taskModel.label", {
                        task: language.t(`settings.modelRouter.task.${task}`),
                      })}
                      value={props.form.taskModels[task] ?? ""}
                      onChange={(event) => setPinned(task, event.currentTarget.value)}
                    >
                      <option value="">{language.t("settings.modelRouter.taskModel.automatic")}</option>
                      <Show when={orphan(task)}>
                        {(key) => <option value={key()}>{key()}</option>}
                      </Show>
                      <For each={selectable()}>
                        {(model) => (
                          <option value={model.key}>
                            {model.name} - {model.provider}
                          </option>
                        )}
                      </For>
                    </select>
                    <span class="model-router-muted">{language.t("settings.modelRouter.taskModel.help")}</span>
                  </label>
                  <Show when={!matches().length}>
                    <button type="button" class="model-router-link" onClick={props.onModels}>
                      {language.t("settings.modelRouter.reviewModels")}
                    </button>
                  </Show>
                </article>
              )
            }}
          </For>
        </div>
      </section>
    </>
  )
}
