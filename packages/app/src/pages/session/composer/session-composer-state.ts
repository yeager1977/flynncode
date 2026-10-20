import { createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { PermissionRequest, QuestionRequest, Todo } from "@flynncode/sdk/v2"
import { useParams } from "@solidjs/router"
import { showToast } from "@/utils/toast"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import type { ApprovalMode, SandboxLevel } from "@/context/permission"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import {
  sessionPermissionRequest,
  sessionQuestionRequest,
  sessionWaitingTerminal,
} from "./session-request-tree"

export const todoState = (input: {
  count: number
  done: boolean
  live: boolean
}): "hide" | "clear" | "open" | "close" => {
  if (input.count === 0) return "hide"
  if (!input.live) return "clear"
  if (!input.done) return "open"
  return "close"
}

// Prospective badge: under readonly the server hard-denies bash and edit
// tools, so a pending ask of those kinds cannot be granted without a sandbox
// change. Level and permission kinds only — the whole-tool denial happens
// upstream, so pending ask patterns do not need inspection here.
export const permissionSandboxBlocked = (level: SandboxLevel, permission: string) => {
  if (level !== "readonly") return false
  return permission === "bash" || permission === "edit"
}

export const todoDockAtBoundary = (state: ReturnType<typeof todoState>) => state === "open"

const idle = { type: "idle" as const }

export function createSessionComposerController(options?: { closeMs?: number | (() => number) }) {
  const params = useParams()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const language = useLanguage()
  const permission = usePermission()

  const questionRequest = createMemo((): QuestionRequest | undefined => {
    return sessionQuestionRequest(sync().data.session, sync().data.question, params.id)
  })

  const permissionRequest = createMemo((): PermissionRequest | undefined => {
    return sessionPermissionRequest(sync().data.session, sync().data.permission, params.id, (item) => {
      return !permission.autoResponds(item, sdk().directory)
    })
  })

  // A subagent waiting on terminal input: the main session shows it so the
  // terminal is reachable without opening the subagent's session. The server
  // lists only live terminals, so a finished shell drops the card.
  const waitingCandidate = createMemo(() => {
    const id = params.id
    if (!id) return undefined
    return sessionWaitingTerminal(sync().data.session, sync().data.message, sync().data.part, id)
  })

  // A Set inside a Solid store is not tracked, so the live ids are a plain
  // array and the membership check reads it.
  const [liveTerminals, setLiveTerminals] = createStore<{ ids: string[] }>({ ids: [] })

  const refreshLiveTerminals = async () => {
    const candidate = waitingCandidate()
    if (!candidate) return
    try {
      const live = await sdk()
        .client.pty.list({ directory: sdk().directory })
        .then((result) => result.data?.map((pty) => pty.id) ?? [])
        .catch(() => [] as string[])
      setLiveTerminals("ids", live)
    } catch {
      setLiveTerminals("ids", [])
    }
  }

  createEffect(() => {
    const candidate = waitingCandidate()
    if (!candidate) {
      setLiveTerminals("ids", [])
      return
    }
    void refreshLiveTerminals()
    // A waiting shell can run for minutes; poll while it is pending so the
    // card disappears when the terminal finally goes away.
    const timer = window.setInterval(() => void refreshLiveTerminals(), 5_000)
    onCleanup(() => window.clearInterval(timer))
  })

  const waitingTerminal = createMemo(() => {
    const candidate = waitingCandidate()
    if (!candidate) return undefined
    if (!liveTerminals.ids.includes(candidate.ptyID)) return undefined
    return candidate
  })

  const blocked = createMemo(() => {
    const id = params.id
    if (!id) return false
    return !!permissionRequest() || !!questionRequest()
  })

  const todos = createMemo((): Todo[] => {
    const id = params.id
    if (!id) return []
    return serverSync().session.data.todo[id] ?? []
  })

  const done = createMemo(
    () => todos().length > 0 && todos().every((todo) => todo.status === "completed" || todo.status === "cancelled"),
  )

  const live = createMemo(() => sync().data.session_working(params.id ?? "") || blocked())

  const [store, setStore] = createStore({
    sessionID: params.id,
    responding: undefined as string | undefined,
    dock: todos().length > 0 && !done() && live(),
    closing: false,
    opening: false,
  })

  const permissionResponding = createMemo(() => {
    const perm = permissionRequest()
    if (!perm) return false
    return store.responding === perm.id
  })

  const decide = (response: "once" | "always" | "reject") => {
    const perm = permissionRequest()
    if (!perm) return
    if (store.responding === perm.id) return

    setStore("responding", perm.id)
    sdk()
      .api.permission.reply({ sessionID: perm.sessionID, requestID: perm.id, reply: response })
      .catch((err: unknown) => {
        const description = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description })
      })
      .finally(() => {
        setStore("responding", (id) => (id === perm.id ? undefined : id))
      })
  }

  const permissionSandbox = createMemo((): SandboxLevel => permission.sandboxLevel(sdk().directory))

  const permissionApprovalMode = createMemo((): ApprovalMode => {
    const id = params.id
    if (!id) return "manual"
    return permission.approvalMode(id, sdk().directory)
  })

  const setPermissionApprovalMode = (mode: ApprovalMode) => {
    const id = params.id
    if (!id) return
    permission.setApprovalMode(id, sdk().directory, mode)
  }

  let timer: number | undefined
  let raf: number | undefined

  const closeMs = () => {
    const value = options?.closeMs
    if (typeof value === "function") return Math.max(0, value())
    if (typeof value === "number") return Math.max(0, value)
    return 400
  }

  const scheduleClose = () => {
    if (timer) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      setStore({ dock: false, closing: false })
      timer = undefined
    }, closeMs())
  }

  // Keep stale turn todos from reopening if the model never clears them.
  const clear = () => {
    const id = params.id
    if (!id) return
    sync().set("todo", id, [])
  }

  createEffect(
    on(
      () => [params.id, todos().length, done(), live()] as const,
      ([id, count, complete, active], previous) => {
        if (raf) cancelAnimationFrame(raf)
        raf = undefined

        const next = todoState({
          count,
          done: complete,
          live: active,
        })

        if (!previous || previous[0] !== id) {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          setStore({ sessionID: id, dock: todoDockAtBoundary(next), closing: false, opening: false })
          if (next === "clear") clear()
          return
        }

        if (next === "hide") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          setStore({ dock: false, closing: false, opening: false })
          return
        }

        if (next === "clear") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          clear()
          return
        }

        if (next === "open") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          const hidden = !store.dock || store.closing
          setStore({ dock: true, closing: false })
          if (hidden) {
            setStore("opening", true)
            raf = requestAnimationFrame(() => {
              setStore("opening", false)
              raf = undefined
            })
            return
          }
          setStore("opening", false)
          return
        }

        setStore({ dock: true, opening: false, closing: true })
        if (!timer) scheduleClose()
      },
    ),
  )

  onCleanup(() => {
    if (!timer) return
    window.clearTimeout(timer)
  })

  onCleanup(() => {
    if (!raf) return
    cancelAnimationFrame(raf)
  })

  return {
    blocked,
    questionRequest,
    permissionRequest,
    permissionResponding,
    waitingTerminal,
    decide,
    permissionSandbox,
    permissionApprovalMode,
    setPermissionApprovalMode,
    todos,
    dock: () =>
      store.sessionID === params.id
        ? store.dock
        : todoDockAtBoundary(todoState({ count: todos().length, done: done(), live: live() })),
    closing: () => store.sessionID === params.id && store.closing,
    opening: () => store.sessionID === params.id && store.opening,
  }
}

export type SessionComposerController = ReturnType<typeof createSessionComposerController>
