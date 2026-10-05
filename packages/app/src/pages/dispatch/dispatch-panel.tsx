import { base64Encode } from "@opencode-ai/core/util/encode"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { createQuery } from "@tanstack/solid-query"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useModels } from "@/context/models"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useProviders } from "@/hooks/use-providers"
import { resolveDefaultModel } from "@/hooks/provider-catalog"
import { pathKey } from "@/utils/path-key"
import { inboxStatus } from "./activity-status"
import { useDispatchActivity } from "./dispatch-activity"
import {
  addDispatch,
  completeDispatch,
  failDispatch,
  markDispatchRead,
  reconcileDispatch,
  type DispatchFilter,
  type DispatchStatus,
  type DispatchTask,
} from "./dispatch-store"

export function DispatchPanel() {
  const language = useLanguage()
  const layout = useLayout()
  const models = useModels()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const dialog = useDialog()
  const navigate = useNavigate()
  const activity = useDispatchActivity()
  // Sidebar dialogs render under server-scoped providers only — no
  // SDKProvider/LocalProvider here, so resolve models from the global catalog.
  const providers = useProviders(() => undefined)
  const { desk, setDesk, ready } = activity
  const [state, setState] = createStore({
    text: "",
    sending: false,
    error: "",
    directory: "",
    agent: "build",
    model: "",
    filter: "all" as DispatchFilter,
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
    const model = resolveDefaultModel(providers.defaultModel(), serverSync().data.config.model)
    if (state.model || !model) return
    setState("model", `${model.providerID}/${model.modelID}`)
  })

  createEffect(() => {
    if (!ready()) return
    void serverSDK()
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
    const created = await serverSDK()
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
      (current) => addDispatch(current, { sessionID: created.id, title: text, status: "running", directory, unread: false }),
    )
    await serverSDK()
      .api.session.prompt({
        sessionID: created.id,
        agent,
        model: model ? { providerID: model.provider.id, modelID: model.id } : undefined,
        text,
      })
      .then(
        () => {
          setDesk("tasks", (current) => completeDispatch(current, created.id))
          // Success clears the composed text; a failure keeps it so the
          // user can retry without retyping.
          setState({ sending: false, text: "" })
        },
        () => {
          setDesk("tasks", (current) => failDispatch(current, created.id))
          setState("error", language.t("dispatch.sendFailed"))
          setState({ sending: false, text })
        },
      )
  }

  const liveStatus = (task: DispatchTask) => {
    const status = serverSync().session.data.session_status[task.sessionID]
    if (!status) return task.status
    const waiting =
      (serverSync().session.data.question[task.sessionID]?.length ?? 0) > 0 ||
      (serverSync().session.data.permission[task.sessionID]?.length ?? 0) > 0
    return inboxStatus(task.status, { type: status.type, blocked: waiting })
  }

  const filteredTasks = createMemo(() => {
    const tasks = desk.tasks
    switch (state.filter) {
      case "unread":
        return tasks.filter((task) => task.unread)
      case "running":
        return tasks.filter((task) => liveStatus(task) === "running")
      case "waiting":
        return tasks.filter((task) => {
          const status = liveStatus(task)
          return status === "needs-input" || status === "blocked"
        })
      default:
        return tasks
    }
  })
  const unreadCount = createMemo(() => activity.unreadCount())

  const openTask = (task: DispatchTask) => {
    setDesk("tasks", (current) => markDispatchRead(current, task.sessionID))
    dialog.close()
    navigate(`/${base64Encode(task.directory)}/session/${task.sessionID}`)
  }

  return (
    <Dialog>
      <DialogTitle>
        {language.t("dispatch.title")}
        <Show when={unreadCount() > 0}>
          <span class="ml-2 rounded-full bg-surface-raised px-2 py-0.5 text-12-regular text-text-strong">
            {unreadCount()}
          </span>
        </Show>
      </DialogTitle>
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
        <div class="flex flex-row gap-1" role="tablist">
          <For each={["all", "unread", "running", "waiting"] as const}>
            {(tab) => (
              <button
                type="button"
                role="tab"
                aria-selected={state.filter === tab}
                class={tab === state.filter ? "rounded px-2 py-1 text-12-regular bg-surface-raised text-text-strong" : "rounded px-2 py-1 text-12-regular text-text-weak"}
                onClick={() => setState("filter", tab)}
              >
                {language.t(filterKey(tab))}
              </button>
            )}
          </For>
        </div>
        <ul class="flex flex-col gap-1">
          <For each={filteredTasks()}>
            {(task) => (
              <li>
                <button type="button" class="w-full truncate text-left text-14-regular" onClick={() => openTask(task)}>
                  {task.title} · {language.t(statusKey(liveStatus(task)))}
                  <Show when={task.unread}>
                    <span class="ml-1 font-medium text-text-strong">•</span>
                  </Show>
                </button>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Dialog>
  )
}

function filterKey(tab: DispatchFilter) {
  switch (tab) {
    case "all":
      return "dispatch.filterAll" as const
    case "unread":
      return "dispatch.filterUnread" as const
    case "running":
      return "dispatch.filterRunning" as const
    case "waiting":
      return "dispatch.filterWaiting" as const
  }
}

function statusKey(status: DispatchStatus) {
  switch (status) {
    case "running":
      return "dispatch.running" as const
    case "done":
      return "dispatch.done" as const
    case "failed":
      return "dispatch.failed" as const
    case "needs-input":
      return "dispatch.needsInput" as const
    case "blocked":
      return "dispatch.blocked" as const
  }
}
