import { base64Encode } from "@opencode-ai/core/util/encode"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { createQuery } from "@tanstack/solid-query"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { routinesFromConfig, type StoredRoutine } from "@/components/settings-v2/routines-edit"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useModels } from "@/context/models"
import { useNotification } from "@/context/notification"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useProviders } from "@/hooks/use-providers"
import { resolveDefaultModel } from "@/hooks/provider-catalog"
import { pathKey } from "@/utils/path-key"
import { inboxRowStatus, type ActivityStatus, type InboxKind } from "./activity-status"
import {
  dispatchRows,
  filterInbox,
  inboxUnread,
  routineRows,
  sessionRows,
  type InboxFilter,
  type InboxRow,
} from "./activity-inbox-rows"
import { useDispatchActivity } from "./dispatch-activity"
import { addDispatch, failDispatch, reconcileDispatch } from "./dispatch-store"

export function ActivityInboxPanel() {
  const language = useLanguage()
  const layout = useLayout()
  const models = useModels()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const dialog = useDialog()
  const navigate = useNavigate()
  const activity = useDispatchActivity()
  const notification = useNotification()
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
    filter: "all" as InboxFilter,
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
      .then(
        (active) => {
          setDesk("tasks", (current) => reconcileDispatch(current, new Set(Object.keys(active))))
        },
        () => undefined,
      )
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
    setDesk("tasks", (current) =>
      addDispatch(current, { sessionID: created.id, title: text, status: "running", directory, unread: false }),
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
          // Accepting the prompt only starts the task. It stays running until
          // the live-status watcher sees the session go idle (or reconcile
          // finds it inactive). Success clears the composed text; a failure
          // keeps it so the user can retry without retyping.
          setState({ sending: false, text: "" })
        },
        () => {
          setDesk("tasks", (current) => failDispatch(current, created.id))
          setState("error", language.t("dispatch.sendFailed"))
          setState({ sending: false, text })
        },
      )
  }

  const waitingFor = (sessionID: string) =>
    (serverSync().session.data.question[sessionID]?.length ?? 0) > 0 ||
    (serverSync().session.data.permission[sessionID]?.length ?? 0) > 0

  const liveDispatchStatus = (sessionID: string, stored: ActivityStatus): ActivityStatus => {
    const live = serverSync().session.data.session_status[sessionID]
    if (!live) return stored
    const waiting = waitingFor(sessionID)
    return inboxRowStatus("dispatch", stored, { type: live.type, blocked: waiting }, waiting)
  }

  // Plain sessions have no stored dispatch status; without live work they
  // are finished, so the fallback is "done" rather than "running".
  const liveSessionStatus = (sessionID: string): ActivityStatus => {
    const live = serverSync().session.data.session_status[sessionID]
    const waiting = waitingFor(sessionID)
    if (!live) return waiting ? "needs-input" : "done"
    return inboxRowStatus("session", "done", { type: live.type, blocked: waiting }, waiting)
  }

  const scheduleOf = (routine: StoredRoutine) =>
    routine.rrule ?? routine.dailyAt ?? routine.interval ?? language.t("settings.routines.manual")

  const routines = createMemo(() => routinesFromConfig(serverSync().data.config.routines))

  const rows = createMemo(() => {
    const tasks = desk.tasks
    const dispatched = new Set(tasks.map((task) => task.sessionID))
    const dispatchList = dispatchRows(
      tasks,
      (id) => {
        const task = tasks.find((item) => item.sessionID === id)
        if (!task) return "running"
        return liveDispatchStatus(id, task.status)
      },
      (id) => notification.session.unseenCount(id),
    )
    const routineList = routineRows(routines(), scheduleOf)
    const liveOnly = projects().flatMap((project) => {
      const sessions = serverSync().child(project.worktree, { bootstrap: false })[0].session ?? []
      return sessions.flatMap((session) => {
        if (dispatched.has(session.id)) return []
        if (session.parentID) return []
        if (session.time?.archived) return []
        // Only sessions that are working, waiting on the user, or carry
        // unseen activity belong in the inbox.
        const type = serverSync().session.data.session_status[session.id]?.type
        const working = type === "busy" || type === "retry"
        if (!working && !waitingFor(session.id) && notification.session.unseenCount(session.id) === 0) return []
        return [{ id: session.id, title: session.title || session.id, directory: session.directory }]
      })
    })
    const sessionList = sessionRows(liveOnly, liveSessionStatus, (id) => notification.session.unseenCount(id))
    return [...dispatchList, ...routineList, ...sessionList]
  })

  const visible = createMemo(() => filterInbox(rows(), state.filter))
  const unreadCount = createMemo(() => inboxUnread(rows()))

  const runCount = (row: InboxRow) => {
    if (row.kind !== "routine") return 0
    const id = row.key.slice("routine:".length)
    return routines().find((routine) => routine.id === id)?.recentRuns?.length ?? 0
  }

  const markRowRead = (row: InboxRow) => {
    const sessionID = row.sessionID
    if (!sessionID) return
    // Dispatch rows are unread from either the dispatch flag or unseen
    // session notifications, so marking read clears both.
    if (row.kind === "dispatch") activity.markRead(sessionID)
    notification.session.markViewed(sessionID)
  }

  const openRow = (row: InboxRow) => {
    if (row.kind === "routine") {
      dialog.close()
      void import("@/components/settings-v2").then((mod) => {
        void dialog.show(() => <mod.DialogSettings defaultValue="routines" />)
      })
      return
    }
    const sessionID = row.sessionID
    const directory = row.directory
    if (!sessionID || directory === undefined) return
    markRowRead(row)
    dialog.close()
    navigate(`/${base64Encode(directory)}/session/${sessionID}`)
  }

  return (
    <Dialog>
      <DialogTitle>
        {language.t("inbox.title")}
        <Show when={unreadCount() > 0}>
          <span class="ml-2 rounded-full bg-surface-raised px-2 py-0.5 text-12-regular text-text-strong">
            {unreadCount()}
          </span>
        </Show>
      </DialogTitle>
      <div class="flex flex-col gap-3 p-4">
        <div class="flex flex-col gap-1 text-12-regular text-text-weak">
          <span>{language.t("dispatch.project")}</span>
          <SelectV2
            data-action="inbox-project"
            options={projects()}
            current={projects().find((project) => project.worktree === state.directory)}
            value={(project) => project.worktree}
            label={(project) => project.worktree}
            placeholder={language.t("inbox.projectPlaceholder")}
            onSelect={(project) => project && setState("directory", project.worktree)}
          />
        </div>
        <div class="flex flex-col gap-1 text-12-regular text-text-weak">
          <span>{language.t("dispatch.agent")}</span>
          <SelectV2
            data-action="inbox-agent"
            options={agents()}
            current={agents().find((agent) => agent === state.agent)}
            placeholder={language.t("inbox.agentPlaceholder")}
            onSelect={(agent) => agent && setState("agent", agent)}
          />
        </div>
        <div class="flex flex-col gap-1 text-12-regular text-text-weak">
          <span>{language.t("dispatch.model")}</span>
          <SelectV2
            data-action="inbox-model"
            options={modelOptions()}
            current={selectedModel()}
            value={(model) => `${model.provider.id}/${model.id}`}
            label={(model) => `${model.provider.name} / ${model.name}`}
            placeholder={language.t("inbox.modelPlaceholder")}
            onSelect={(model) => model && setState("model", `${model.provider.id}/${model.id}`)}
          />
        </div>
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
          <For each={["all", "running", "needs-input", "blocked", "done", "failed", "unread"] as const}>
            {(tab) => (
              <button
                type="button"
                role="tab"
                aria-selected={state.filter === tab}
                class={
                  tab === state.filter
                    ? "rounded px-2 py-1 text-12-regular bg-surface-raised text-text-strong"
                    : "rounded px-2 py-1 text-12-regular text-text-weak"
                }
                onClick={() => setState("filter", tab)}
              >
                {language.t(filterKey(tab))}
              </button>
            )}
          </For>
        </div>
        <Show when={visible().length === 0}>
          <p class="text-14-regular text-text-weak">
            {state.filter === "all" ? language.t("inbox.empty") : language.t("inbox.emptyFilter")}
          </p>
        </Show>
        <ul class="flex flex-col gap-1">
          <For each={visible()}>
            {(row) => (
              <li class="flex flex-col gap-0.5">
                <div class="flex flex-row items-center gap-2">
                  <button
                    type="button"
                    data-action="inbox-open"
                    class="w-full truncate text-left text-14-regular"
                    onClick={() => openRow(row)}
                  >
                    {row.title} · {language.t(kindKey(row.kind))} · {statusText(row)}
                    <Show when={row.unread}>
                      <span class="ml-1 font-medium text-text-strong">•</span>
                    </Show>
                  </button>
                  <Show when={row.kind !== "routine" && row.unread}>
                    <button
                      type="button"
                      data-action="inbox-mark-read"
                      class="shrink-0 text-12-regular text-text-weak"
                      onClick={() => markRowRead(row)}
                    >
                      {language.t("inbox.markRead")}
                    </button>
                  </Show>
                </div>
                <p class="truncate text-12-regular text-text-weak">{row.subtitle}</p>
                <Show when={row.kind === "routine"}>
                  <p class="text-12-regular text-text-weak">
                    {language.t("inbox.routineHistory")}: {runCount(row)}
                  </p>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Dialog>
  )

  function statusText(row: InboxRow) {
    if (row.kind === "routine" && row.status === "failed") return language.t("inbox.failedRun")
    return language.t(statusKey(row.status))
  }
}

function filterKey(tab: InboxFilter) {
  switch (tab) {
    case "all":
      return "inbox.filterAll" as const
    case "unread":
      return "inbox.filterUnread" as const
    case "running":
      return "inbox.filterRunning" as const
    case "needs-input":
      return "inbox.filterNeedsInput" as const
    case "blocked":
      return "inbox.filterBlocked" as const
    case "done":
      return "inbox.filterDone" as const
    case "failed":
      return "inbox.filterFailed" as const
  }
}

function kindKey(kind: InboxKind) {
  switch (kind) {
    case "dispatch":
      return "inbox.kindDispatch" as const
    case "routine":
      return "inbox.kindRoutine" as const
    case "session":
      return "inbox.kindSession" as const
  }
}

function statusKey(status: ActivityStatus) {
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
