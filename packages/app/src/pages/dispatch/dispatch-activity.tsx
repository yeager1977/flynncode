import { createEffect } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@flynncode/ui/context"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@flynncode/core/util/encode"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSync } from "@/context/server-sync"
import { Persist, persisted } from "@/utils/persist"
import { endedOnUsageLimit } from "@/utils/usage-limit"
import { inboxStatus } from "./activity-status"
import {
  markDispatchRead,
  migrateDispatch,
  resolvedTransition,
  type DispatchStatus,
  type DispatchTask,
} from "./dispatch-store"

// Persistently mounted watcher for dispatch task transitions: flags tasks
// unread in the dispatch store and fires OS notifications on done|failed
// transitions. Lives outside the DispatchPanel modal so finished work
// resurfaces even while the panel is closed, and owns the persisted dispatch
// store so the panel and this watcher share one reactive task list.
export const { use: useDispatchActivity, provider: DispatchActivityProvider } = createSimpleContext({
  name: "DispatchActivity",
  gate: false,
  init: () => {
    const language = useLanguage()
    const platform = usePlatform()
    const serverSync = useServerSync()
    const navigate = useNavigate()
    const [desk, setDesk, , ready] = persisted(
      { ...Persist.global("dispatch.v1"), migrate: migrateDispatch },
      createStore({ tasks: [] as DispatchTask[] }),
    )

    const liveStatus = (task: DispatchTask): DispatchStatus => {
      const status = serverSync().session.data.session_status[task.sessionID]
      const limited = endedOnUsageLimit(serverSync().session.data.message[task.sessionID])
      if (!status) return inboxStatus(task.status, undefined, limited)
      const waiting =
        (serverSync().session.data.question[task.sessionID]?.length ?? 0) > 0 ||
        (serverSync().session.data.permission[task.sessionID]?.length ?? 0) > 0
      return inboxStatus(task.status, { type: status.type, blocked: waiting }, limited)
    }

    const statusKey = (status: DispatchStatus) => {
      switch (status) {
        case "done":
          return "dispatch.done" as const
        case "failed":
          return "dispatch.failed" as const
        case "running":
          return "dispatch.running" as const
        case "needs-input":
          return "dispatch.needsInput" as const
        case "blocked":
          return "dispatch.blocked" as const
      }
    }

    const openTask = (task: DispatchTask) => {
      setDesk("tasks", (current) => markDispatchRead(current, task.sessionID))
      navigate(`/${base64Encode(task.directory)}/session/${task.sessionID}`)
    }

    const previous = new Map<string, DispatchStatus>()
    let primed = false

    createEffect(() => {
      const current = new Map<string, DispatchStatus>()
      let changed = false
      for (const task of desk.tasks) {
        const status = liveStatus(task)
        current.set(task.sessionID, status)
        const before = previous.get(task.sessionID)
        if (!primed || !before || before === status) continue
        if (!resolvedTransition(before, status)) continue
        changed = true
        void platform.notify(language.t(statusKey(status)), task.title, () => openTask(task))
      }
      if (changed) {
        setDesk("tasks", (existing) =>
          existing.map((task) => {
            const status = current.get(task.sessionID)
            if (!status || !resolvedTransition(previous.get(task.sessionID) ?? status, status)) return task
            // Persist the resolved status so a later reconcile does not
            // re-flag a task the user already marked read.
            return { ...task, status, unread: true }
          }),
        )
      }
      previous.clear()
      current.forEach((status, id) => previous.set(id, status))
      primed = true
    })

    return {
      desk,
      setDesk,
      ready,
      unreadCount: () => desk.tasks.filter((task) => task.unread).length,
      markRead: (sessionID: string) => setDesk("tasks", (current) => markDispatchRead(current, sessionID)),
    }
  },
})
