import type { Session } from "@opencode-ai/sdk/v2/client"
import { preloadMarkdown } from "@opencode-ai/session-ui/markdown-cache"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useQuery } from "@tanstack/solid-query"
import { DateTime } from "luxon"
import { useParams } from "@solidjs/router"
import {
  type Accessor,
  createEffect,
  createMemo,
  createRoot,
  type JSX,
  onCleanup,
  Show,
  startTransition,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useCommand } from "@/context/command"
import {
  loadHomeSessionIndex,
  retainHomeSessions,
  type HomeSessionEvents,
} from "@/context/global-sync/home-session-index"
import type { LocalProject } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import { sessionHasOpenTab, useTabs } from "@/context/tabs"
import { compareSessionTime, displayName, errorMessage, projectForSession } from "@/pages/layout/helpers"
import { useSessionTabAvatarState } from "@/pages/layout/project-avatar-state"
import { pathKey } from "@/utils/path-key"
import { showToast } from "@/utils/toast"
import { Binary } from "@opencode-ai/core/util/binary"
import { archiveHomeSession } from "../home-session-archive"
import {
  cleanupCandidates,
  confirmIDs,
  parentLinks,
  presetDays,
  protectedRootIDs,
  selectLoaded,
  selectRange,
  toggleID,
  type BulkPreset,
} from "../session/session-bulk"
import { BulkConfirmDialog } from "../session/session-bulk-dialog"
import { runSessionBulk, type BulkOp } from "../session/session-bulk-run"
import type { HomeController } from "./home-controller"

const HOME_SESSION_LIMIT = 64
export type HomeSessionRecord = {
  session: Session
  project: LocalProject
  projectName: string
}

export type HomeSessionGroup = {
  id: "today" | "yesterday" | "older"
  title: string
  sessions: HomeSessionRecord[]
}

export type OpenSessionOptions = { background?: boolean }

export function createHomeSessionsController(home: HomeController) {
  const params = useParams()
  const tabs = useTabs()
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()
  const projectDirectories = createMemo(() => {
    const project = home.project.selected()
    if (!project) return home.project.list().flatMap(directories)
    return directories(project)
  })
  const projectByID = createMemo(
    () => new Map(home.project.list().flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
  )
  const homeSessions = () => home.server.focusedSync().homeSessions
  const sessionEventLoad = useQuery(() => ({
    queryKey: homeSessions().eventsKey,
    queryFn: async (): Promise<HomeSessionEvents> => ({ sequence: 0, entries: [] }),
    initialData: { sequence: 0, entries: [] } satisfies HomeSessionEvents,
    enabled: false,
  }))
  const sessionLoad = useQuery(() => ({
    queryKey: homeSessions().indexKey,
    enabled: !!home.server.focusedContext(),
    queryFn: async ({ signal }) => {
      const ctx = home.server.focusedContext()
      if (!ctx) return { sessions: [], eventSequence: 0 }
      const cache = homeSessions()
      const eventSequence = cache.eventSequence()
      const index = await loadHomeSessionIndex(
        (input, options) => ctx.sdk.client.v2.session.list(input, options),
        eventSequence,
        signal,
      )
      cache.complete(eventSequence)
      return index
    },
    retry: false,
    staleTime: 30_000,
    refetchOnMount: true,
    refetchOnReconnect: true,
  }))
  const indexedSessions = createMemo(() =>
    retainHomeSessions(
      homeSessions().sessions(sessionLoad.data, sessionEventLoad.data),
      HOME_SESSION_LIMIT,
      Date.now(),
    ),
  )
  const allRecords = createMemo(() =>
    buildHomeSessionRecords({
      sessions: indexedSessions,
      projectDirectories,
      projects: home.project.list,
      projectByID,
    }),
  )
  const records = createMemo(() => allRecords().slice(0, HOME_SESSION_LIMIT))
  const groups = createMemo(() => groupSessions(records(), language))
  const prefetched = new Set<string>()

  createEffect(() => {
    const ctx = home.server.focusedContext()
    const conn = home.server.focused()
    if (!ctx || !conn) return
    records()
      .slice(0, 2)
      .forEach((record) => {
        const key = `${ServerConnection.key(conn)}\0${record.session.id}`
        if (prefetched.has(key)) return
        prefetched.add(key)
        createRoot((dispose) => {
          try {
            void ctx.sync.session
              .sync(record.session.id)
              .then(() =>
                Promise.all(
                  (ctx.sync.session.data.message[record.session.id] ?? []).flatMap((message) =>
                    (ctx.sync.session.data.part[message.id] ?? []).flatMap((part) => {
                      if (part.type !== "text" || !part.text) return []
                      return preloadMarkdown(part.text, part.id)
                    }),
                  ),
                ),
              )
              .catch(() => {})
              .finally(dispose)
          } catch {
            dispose()
          }
        })
      })
  })

  command.register("home.palette", () => [
    {
      id: "command.palette",
      title: language.t("command.palette"),
      hidden: true,
      onSelect: async () => {
        const conn = home.server.focused()
        if (!conn) return
        const ctx = home.server.focusedContext()
        if (!ctx) return
        const { DialogHomeCommandPaletteV2 } = await import("@/components/dialog-command-palette-v2")
        void dialog.show(() => (
          <DialogHomeCommandPaletteV2
            server={conn}
            onSelectSession={(entry) => {
              if (!entry.sessionID || !entry.directory || !entry.server) return
              const sessionID = entry.sessionID
              const server = entry.server
              const directory = entry.project?.worktree ?? entry.directory
              ctx.projects.open(directory)
              ctx.projects.touch(directory)
              void startTransition(() => {
                const tab = tabs.addSessionTab({ server, sessionId: sessionID })
                tabs.select(tab)
              })
            }}
          />
        ))
      },
    },
  ])

  const [bulk, setBulk] = createStore({
    selecting: false,
    selected: [] as string[],
    anchor: undefined as string | undefined,
    busy: false,
  })
  let generation = 0
  let confirmEpoch = 0
  let suppressDismiss = false
  let retained: readonly Session[] = []
  const marker = `bulk-${Math.random().toString(36).slice(2)}`
  const oursShowing = () => {
    if (typeof document === "undefined") return false
    const layers = document.querySelectorAll("[data-dialog-layer]")
    const top = layers.item(layers.length - 1)
    return !!top?.querySelector(`[data-bulk-confirm="${marker}"]`)
  }
  const invalidateConfirm = () => {
    generation += 1
    setBulk("busy", false)
  }
  const closeConfirm = () => {
    if (!oursShowing()) return
    dialog.close()
  }
  const showConfirm = (element: () => JSX.Element) => {
    const epoch = ++confirmEpoch
    if (oursShowing()) dialog.close()
    dialog.show(
      () => (
        <div data-bulk-confirm={marker} style={{ display: "contents" }}>
          {element()}
        </div>
      ),
      () => {
        if (epoch !== confirmEpoch) return
        if (suppressDismiss) return
        invalidateConfirm()
      },
    )
  }
  const dismissConfirm = () => {
    invalidateConfirm()
    closeConfirm()
  }
  const clearBulk = () => {
    generation += 1
    retained = []
    closeConfirm()
    setBulk({ selecting: false, selected: [], anchor: undefined, busy: false })
  }
  const serverKey = () => {
    const conn = home.server.focused()
    if (conn) return ServerConnection.key(conn)
    return home.selection.value().server
  }
  const indexSessions = () => homeSessions().sessions(sessionLoad.data, sessionEventLoad.data)
  const pending = (id: string) => {
    const data = home.server.focusedSync().session.data
    return (data.permission[id]?.length ?? 0) > 0 || (data.question[id]?.length ?? 0) > 0
  }
  const openTabIDs = (list: readonly Session[]) => {
    const key = serverKey()
    const ids = new Set<string>()
    for (const tab of tabs.store) {
      if (tab.type === "session" && tab.server === key) ids.add(tab.sessionId)
    }
    for (const session of list) {
      if (sessionHasOpenTab(tabs.store, key, session)) ids.add(session.id)
    }
    return ids
  }
  const parentLinkMap = () => {
    const sync = home.server.focusedSync()
    const data = sync.session.data
    const ids = openTabIDs([])
    if (params.id) ids.add(params.id)
    for (const id of Object.keys(data.session_status)) {
      if (data.session_working(id)) ids.add(id)
    }
    for (const [id, items] of Object.entries(data.permission)) {
      if ((items?.length ?? 0) > 0) ids.add(id)
    }
    for (const [id, items] of Object.entries(data.question)) {
      if ((items?.length ?? 0) > 0) ids.add(id)
    }
    return parentLinks(ids, (id) => sync.session.peek(id)?.parentID)
  }
  const blockedFor = (list: readonly Session[]) =>
    protectedRootIDs(list, {
      openRouteID: params.id,
      openTabIDs: openTabIDs(list),
      working: (id) => home.server.focusedSync().session.data.session_working(id),
      pending,
      parentID: parentLinkMap(),
    })
  const allowed = createMemo(() => {
    const blocked = blockedFor(indexSessions())
    return new Set(records().map((record) => record.session.id).filter((id) => !blocked.has(id)))
  })
  const protectedNow = (id: string, extra: readonly Session[]) => {
    const list = mergeSessions(indexSessions(), extra)
    if (params.id === id) return true
    if (openTabIDs(list).has(id)) return true
    if (home.server.focusedSync().session.data.session_working(id)) return true
    if (pending(id)) return true
    return blockedFor(list).has(id)
  }
  const run = async (op: BulkOp, ids: readonly string[], extra: readonly Session[], ticket: number) => {
    if (ticket !== generation) return
    if (bulk.busy) return
    const ctx = home.server.focusedContext()
    const conn = home.server.focused()
    if (!ctx || !conn) return
    const sync = ctx.sync
    const sdk = ctx.sdk
    const key = ServerConnection.key(conn)
    const forget = (id: string, directory: string) => {
      const [, setStore] = sync.child(directory, { bootstrap: false })
      setStore(
        produce((draft) => {
          const match = Binary.search(draft.session, id, (item) => item.id)
          if (match.found) draft.session.splice(match.index, 1)
        }),
      )
      sync.homeSessions.remove(id)
      notifySessionTabsRemoved({ server: key, directory, sessionIDs: [id] })
    }
    const directoryFor = (id: string) => {
      const directory = extra.find((session) => session.id === id)?.directory
      if (!directory) throw new Error("missing session")
      return directory
    }
    setBulk("busy", true)
    suppressDismiss = true
    closeConfirm()
    suppressDismiss = false
    const result = await runSessionBulk({
      ids,
      op,
      isProtected: (id) => {
        if (ticket !== generation) throw new Error("cancelled")
        return protectedNow(id, extra)
      },
      archive: async (id) => {
        if (ticket !== generation) throw new Error("cancelled")
        const directory = directoryFor(id)
        await sdk.client.session.update({ sessionID: id, directory, time: { archived: Date.now() } })
        forget(id, directory)
      },
      remove: async (id) => {
        if (ticket !== generation) throw new Error("cancelled")
        const directory = directoryFor(id)
        await sdk.api.session.remove({ sessionID: id })
        forget(id, directory)
      },
    })
    if (ticket !== generation) {
      setBulk("busy", false)
      return
    }
    if (result.failed) {
      retained = extra
      showToast({ title: language.plural("session.bulk.failed", result.pending.length + 1) })
      setBulk({
        selecting: true,
        selected: [result.failed, ...result.pending],
        anchor: result.failed,
        busy: false,
      })
      return
    }
    clearBulk()
  }
  const confirm = (op: BulkOp) => {
    if (bulk.busy) return
    const ticket = generation
    const loaded = new Set(records().map((record) => record.session.id))
    const ids = confirmIDs(bulk.selected, loaded, allowed(), blockedFor(indexSessions()))
    if (ids.length === 0) return
    const frozen = [...ids]
    const extra = mergeSessions(indexSessions(), retained)
    showConfirm(() => (
      <BulkConfirmDialog
        op={op}
        count={frozen.length}
        busy={bulk.busy}
        onCancel={dismissConfirm}
        onConfirm={() => {
          void run(op, frozen, extra, ticket)
        }}
      />
    ))
  }
  const cleanup = (id: BulkPreset) => {
    if (bulk.busy) return
    const ticket = generation
    if (sessionLoad.isError) {
      showToast({ title: language.t("common.requestFailed") })
      return
    }
    if ((sessionLoad.isPending || sessionLoad.isFetching) && !sessionLoad.data) return
    if (!sessionLoad.data) return
    const sessions = homeSessions().sessions(sessionLoad.data, sessionEventLoad.data)
    const now = Date.now()
    const extra = mergeSessions(sessions, retained)
    const found = cleanupCandidates(sessions, now, presetDays(id), blockedFor(extra))
    if (found.match.length === 0) {
      showConfirm(() => (
        <BulkConfirmDialog
          op="archive"
          count={0}
          empty
          busy={bulk.busy}
          onCancel={dismissConfirm}
          onConfirm={() => {}}
        />
      ))
      return
    }
    const ids = found.match.map((session) => session.id)
    const period = language.t(`session.bulk.period.${id}`)
    const matchLabel = language.plural("session.bulk.cleanup.match", found.match.length, { period })
    const skippedLabel =
      found.skipped.length > 0 ? language.plural("session.bulk.cleanup.skipped", found.skipped.length) : undefined
    showConfirm(() => (
      <CleanupConfirm
        count={ids.length}
        matchLabel={matchLabel}
        skippedLabel={skippedLabel}
        busy={bulk.busy}
        onCancel={dismissConfirm}
        onRun={(op) => {
          void run(op, ids, extra, ticket)
        }}
      />
    ))
  }
  const toggleSelect = () => {
    if (bulk.busy) return
    if (bulk.selecting) {
      clearBulk()
      return
    }
    setBulk("selecting", true)
  }
  const selectAll = () => {
    if (bulk.busy) return
    const loaded = records().map((record) => record.session.id)
    const loadedIDs = new Set(loaded)
    setBulk("selected", [...selectLoaded(loaded, allowed()), ...bulk.selected.filter((item) => !loadedIDs.has(item))])
  }
  const onToggle = (id: string, event: MouseEvent) => {
    if (bulk.busy) return
    if (event.shiftKey) {
      const next = selectRange({
        order: records().map((record) => record.session.id),
        selected: bulk.selected,
        anchor: bulk.anchor,
        id,
        allowed: allowed(),
      })
      setBulk("selected", next.selected)
      setBulk("anchor", next.anchor)
      return
    }
    setBulk("selected", toggleID(bulk.selected, id, allowed()))
    setBulk("anchor", id)
  }

  createEffect(() => {
    if (!bulk.selecting) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (oursShowing()) return
      event.preventDefault()
      clearBulk()
    }
    window.addEventListener("keydown", onKeyDown)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown))
  })

  let seenServer = false
  let serverKeySeen = ""
  createEffect(() => {
    const next = serverKey()
    if (seenServer && serverKeySeen !== next) clearBulk()
    serverKeySeen = next
    seenServer = true
  })

  onCleanup(() => {
    generation += 1
    closeConfirm()
  })

  return {
    copy: {
      language,
    },
    data: {
      records,
      groups,
      loading: () => sessionLoad.isLoading,
      searchRecords: allRecords,
    },
    session: {
      showProjectName: () => !home.project.selected(),
      server: () => home.selection.value().server,
      canCreate: () => !!home.project.newSession(),
      create: home.project.openNewSession,
      open: (session: Session, options?: OpenSessionOptions) => {
        const directoryKey = pathKey(session.directory)
        const project =
          home.project
            .list()
            .find(
              (item) =>
                pathKey(item.worktree) === directoryKey ||
                item.sandboxes?.some((sandbox) => pathKey(sandbox) === directoryKey),
            ) ?? projectForSession(session, home.project.list(), projectByID())
        const conn = home.server.focused()
        if (!conn) return
        const directory = project?.worktree ?? session.directory
        const ctx = home.server.focusedContext()
        if (!ctx) return
        ctx.projects.open(directory)
        if (options?.background) {
          tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
          return
        }
        ctx.projects.touch(directory)
        void startTransition(() => {
          const tab = tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
          tabs.select(tab)
        })
      },
      archive: async (session: Session) => {
        const conn = home.server.focused()
        const ctx = home.server.focusedContext()
        if (!conn || !ctx) return
        const [, setStore] = ctx.sync.child(session.directory)
        if ((await ctx.sdk.protocol) !== "v1") return
        await archiveHomeSession({
          server: ServerConnection.key(conn),
          session,
          archive: (sessionID) =>
            ctx.sdk.client.session.update({
              sessionID,
              directory: session.directory,
              time: { archived: Date.now() },
            }),
          remove: () => {
            setStore(
              produce((draft) => {
                const match = Binary.search(draft.session, session.id, (item) => item.id)
                if (match.found) draft.session.splice(match.index, 1)
              }),
            )
            homeSessions().remove(session.id)
          },
          onError: (cause) =>
            showToast({
              title: language.t("common.requestFailed"),
              description: errorMessage(cause, language.t("common.requestFailed")),
            }),
        })
      },
    },
    tab: {
      isOpen: (record: HomeSessionRecord) =>
        sessionHasOpenTab(tabs.store, home.selection.value().server, record.session),
    },
    select: {
      active: () => bulk.selecting,
      busy: () => bulk.busy,
      count: () => bulk.selected.length,
      selected: (id: string) => bulk.selected.includes(id),
      locked: (id: string) => !allowed().has(id),
      toggleMode: toggleSelect,
      selectAll,
      archive: () => confirm("archive"),
      remove: () => confirm("delete"),
      cancel: clearBulk,
      cleanup,
      toggle: onToggle,
    },
  }
}

function mergeSessions(left: readonly Session[], right: readonly Session[]) {
  return [...new Map([...left, ...right].map((session) => [session.id, session])).values()]
}

function CleanupConfirm(props: {
  count: number
  matchLabel: string
  skippedLabel?: string
  busy: boolean
  onCancel: () => void
  onRun: (op: BulkOp) => void
}) {
  const [step, setStep] = createStore({ op: undefined as BulkOp | undefined })
  return (
    <Show
      when={step.op}
      fallback={
        <BulkConfirmDialog
          op="archive"
          count={props.count}
          matchLabel={props.matchLabel}
          skippedLabel={props.skippedLabel}
          busy={props.busy}
          onCancel={props.onCancel}
          onConfirm={() => {}}
          onArchive={() => setStep("op", "archive")}
          onDelete={() => setStep("op", "delete")}
        />
      }
    >
      {(op) => (
        <BulkConfirmDialog
          op={op()}
          count={props.count}
          matchLabel={props.matchLabel}
          skippedLabel={props.skippedLabel}
          busy={props.busy}
          onCancel={props.onCancel}
          onConfirm={() => props.onRun(op())}
        />
      )}
    </Show>
  )
}

function directories(project: LocalProject) {
  return [project.worktree, ...(project.sandboxes ?? [])]
}

function buildHomeSessionRecords(input: {
  sessions: () => Session[]
  projectDirectories: () => string[]
  projects: () => LocalProject[]
  projectByID: () => Map<string, LocalProject>
}) {
  const directories = new Set(input.projectDirectories().map(pathKey))
  const sessions = input.sessions().filter((session) => directories.has(pathKey(session.directory)))
  return [...new Map(sessions.map((session) => [session.id, session] as const)).values()]
    .sort(compareSessionTime)
    .flatMap((session) => {
      const directory = pathKey(session.directory)
      const project =
        input
          .projects()
          .find(
            (item) =>
              pathKey(item.worktree) === directory || item.sandboxes?.some((sandbox) => pathKey(sandbox) === directory),
          ) ?? projectForSession(session, input.projects(), input.projectByID())
      if (!project) return []
      return { session, project, projectName: displayName(project) }
    })
}

export function homeSessionSearchKey(record: HomeSessionRecord) {
  return `${pathKey(record.session.directory)}:${record.session.id}`
}

function groupSessions(records: HomeSessionRecord[], language: ReturnType<typeof useLanguage>): HomeSessionGroup[] {
  const now = DateTime.local()
  const yesterday = now.minus({ days: 1 })
  const todaySessions = records.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(now, "day"),
  )
  const yesterdaySessions = records.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(yesterday, "day"),
  )
  const olderSessions = records.filter((record) => {
    const time = DateTime.fromMillis(record.session.time.updated ?? record.session.time.created)
    return !time.hasSame(now, "day") && !time.hasSame(yesterday, "day")
  })
  const olderTitle =
    todaySessions.length === 0 && yesterdaySessions.length === 0
      ? language.t("sidebar.project.recentSessions")
      : language.t("home.sessions.group.older")
  return [
    { id: "today" as const, title: language.t("home.sessions.group.today"), sessions: todaySessions },
    { id: "yesterday" as const, title: language.t("home.sessions.group.yesterday"), sessions: yesterdaySessions },
    { id: "older" as const, title: olderTitle, sessions: olderSessions },
  ].filter((group) => group.sessions.length > 0)
}

export type HomeSessionsController = ReturnType<typeof createHomeSessionsController>

export function HomeSessionStatusController(props: {
  server: Accessor<ServerConnection.Key>
  record: HomeSessionRecord
  isOpenTab: (record: HomeSessionRecord) => boolean
  render: (state: { unread: Accessor<boolean>; loading: Accessor<boolean>; open: Accessor<boolean> }) => JSX.Element
}) {
  const avatar = useSessionTabAvatarState(
    props.server,
    () => props.record.session.directory,
    () => props.record.session.id,
  )
  return props.render({
    unread: avatar.unread,
    loading: avatar.loading,
    open: () => props.isOpenTab(props.record),
  })
}
