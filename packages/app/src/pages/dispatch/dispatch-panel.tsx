import { base64Encode } from "@opencode-ai/core/util/encode"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { createQuery } from "@tanstack/solid-query"
import { useNavigate } from "@solidjs/router"
import { createEffect, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { useModels } from "@/context/models"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { Persist, persisted } from "@/utils/persist"
import { pathKey } from "@/utils/path-key"
import {
  addDispatch,
  completeDispatch,
  failDispatch,
  migrateDispatch,
  reconcileDispatch,
  type DispatchStatus,
  type DispatchTask,
} from "./dispatch-store"

export function DispatchPanel() {
  const language = useLanguage()
  const layout = useLayout()
  const local = useLocal()
  const models = useModels()
  const sdk = useSDK()
  const serverSync = useServerSync()
  const dialog = useDialog()
  const navigate = useNavigate()
  const [desk, setDesk, , ready] = persisted(
    { ...Persist.global("dispatch.v1"), migrate: migrateDispatch },
    createStore({ tasks: [] as DispatchTask[] }),
  )
  const [state, setState] = createStore({
    text: "",
    sending: false,
    error: "",
    directory: "",
    agent: "build",
    model: "",
  })
  const projects = () => layout.projects.list()
  const modelOptions = () => models.list()
  const agentsQuery = createQuery(() => {
    const directory = state.directory || "/"
    return {
      ...serverSync().queryOptions.agents(pathKey(directory)),
      enabled: state.directory.length > 0,
    }
  })
  const agents = () => {
    const names = agentsQuery.data?.map((agent) => agent.name).filter((name) => name.length > 0) ?? []
    return names.length > 0 ? names : ["build"]
  }

  createEffect(() => {
    const current = projects()[0]?.worktree
    if (!state.directory && current) setState("directory", current)
  })

  createEffect(() => {
    const names = agents()
    if (names.includes(state.agent)) return
    const next = names[0]
    if (next) setState("agent", next)
  })

  createEffect(() => {
    const current = local.model.current()
    if (state.model || !current) return
    setState("model", `${current.provider.id}/${current.id}`)
  })

  createEffect(() => {
    if (!ready()) return
    void sdk()
      .api.session.active()
      .then((active) => {
        setDesk("tasks", (current) => reconcileDispatch(current, new Set(Object.keys(active))))
      }, () => undefined)
  })

  const selectedModel = () => {
    const slash = state.model.indexOf("/")
    if (slash <= 0) return
    const providerID = state.model.slice(0, slash)
    const modelID = state.model.slice(slash + 1)
    if (!modelID) return
    return modelOptions().find((model) => model.provider.id === providerID && model.id === modelID)
  }

  const send = async () => {
    const text = state.text.trim()
    const directory = state.directory
    if (!text || !directory || state.sending || !ready()) return
    setState({ sending: true, error: "" })
    const model = selectedModel()
    const agent = state.agent || "build"
    const created = await sdk()
      .api.session.create({
        agent,
        model: model ? { id: model.id, providerID: model.provider.id } : undefined,
        location: { directory },
      })
      .catch(() => undefined)
    if (!created?.id) {
      setState({ sending: false, error: language.t("dispatch.sendFailed") })
      return
    }
    setDesk(
      "tasks",
      (current) => addDispatch(current, { sessionID: created.id, title: text, status: "running", directory }),
    )
    await sdk()
      .api.session.prompt({
        sessionID: created.id,
        agent,
        model: model ? { providerID: model.provider.id, modelID: model.id } : undefined,
        text,
      })
      .then(
        () => setDesk("tasks", (current) => completeDispatch(current, created.id)),
        () => {
          setDesk("tasks", (current) => failDispatch(current, created.id))
          setState("error", language.t("dispatch.sendFailed"))
        },
      )
    setState({ sending: false, text: "" })
  }

  const openTask = (task: DispatchTask) => {
    dialog.close()
    navigate(`/${base64Encode(task.directory)}/session/${task.sessionID}`)
  }

  return (
    <Dialog>
      <DialogTitle>{language.t("dispatch.title")}</DialogTitle>
      <div class="flex flex-col gap-3 p-4">
        <label class="flex flex-col gap-1 text-12-regular text-text-weak">
          {language.t("dispatch.project")}
          <select
            class="rounded border border-border-weak bg-surface-base px-2 py-1 text-14-regular text-text-strong"
            value={state.directory}
            onChange={(event) => setState("directory", event.currentTarget.value)}
          >
            <For each={projects()}>
              {(project) => <option value={project.worktree}>{project.worktree}</option>}
            </For>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-12-regular text-text-weak">
          {language.t("dispatch.agent")}
          <select
            class="rounded border border-border-weak bg-surface-base px-2 py-1 text-14-regular text-text-strong"
            value={state.agent}
            onChange={(event) => setState("agent", event.currentTarget.value)}
          >
            <For each={agents()}>{(agent) => <option value={agent}>{agent}</option>}</For>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-12-regular text-text-weak">
          {language.t("dispatch.model")}
          <select
            class="rounded border border-border-weak bg-surface-base px-2 py-1 text-14-regular text-text-strong"
            value={state.model}
            onChange={(event) => setState("model", event.currentTarget.value)}
          >
            <For each={modelOptions()}>
              {(model) => (
                <option value={`${model.provider.id}/${model.id}`}>
                  {model.provider.name} / {model.name}
                </option>
              )}
            </For>
          </select>
        </label>
        <textarea
          class="min-h-24 w-full rounded border border-border-weak bg-surface-base p-2 text-14-regular"
          aria-label={language.t("dispatch.placeholder")}
          placeholder={language.t("dispatch.placeholder")}
          value={state.text}
          onInput={(event) => setState("text", event.currentTarget.value)}
        />
        <ButtonV2
          disabled={!ready() || state.sending || state.text.trim() === "" || state.directory === ""}
          onClick={() => void send()}
        >
          {language.t("dispatch.send")}
        </ButtonV2>
        <Show when={state.error}>
          <p class="text-text-critical">{state.error}</p>
        </Show>
        <ul class="flex flex-col gap-1">
          <For each={desk.tasks}>
            {(task) => (
              <li>
                <button type="button" class="w-full truncate text-left text-14-regular" onClick={() => openTask(task)}>
                  {task.title} · {language.t(statusKey(task.status))}
                </button>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Dialog>
  )
}

function statusKey(status: DispatchStatus) {
  switch (status) {
    case "running":
      return "dispatch.running" as const
    case "done":
      return "dispatch.done" as const
    case "failed":
      return "dispatch.failed" as const
  }
}
