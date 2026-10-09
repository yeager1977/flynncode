import { createEffect, createMemo, For, on, onCleanup, onMount, Show, untrack, type Accessor } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import { Binary } from "@opencode-ai/core/util/binary"
import { Session } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLayout, type LocalProject } from "@/context/layout"
import { useServerSync } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { useServer } from "@/context/server"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { usePlatform } from "@/context/platform"
import { normalizeProjectInfo } from "@/context/global-sync/utils"
import { pickSessionCacheEvictions } from "@/context/global-sync/session-cache"
import { clearWorkspaceTerminals } from "@/context/terminal"
import { useDirectoryPicker } from "@/components/directory-picker"
import { notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"
import { dismissToast, showToast } from "@/utils/toast"
import { createAim } from "@/utils/aim"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { listAllSessions } from "@/utils/session"
import { pathKey } from "@/utils/path-key"
import { ConstrainDragXAxis, getDraggableId } from "@/utils/solid-dnd"
import { displayName, effectiveWorkspaceOrder, errorMessage, latestRootSession, sortedRootSessions } from "./helpers"
import { createInlineEditorController } from "./inline-editor"
import { LocalWorkspace, SortableWorkspace, WorkspaceDragOverlay, type WorkspaceSidebarContext } from "./sidebar-workspace"
import { ProjectDragOverlay, SortableProject, type ProjectSidebarContext } from "./sidebar-project"
import { SidebarArtifacts } from "./sidebar-artifacts-section"
import { adjacentProject, adjacentSession, adjacentUnseenSession } from "./sidebar-navigation"

// How a layout routes the sidebar's navigation. The classic layout maps
// sessions and new sessions to `/:dir/session` URLs; the new layout opens them
// as tabs (`tabs: true`), where selecting a project starts a new draft and
// closing the active project leaves its open tabs alone.
export type SidebarHost = {
  // Directory of the routed session or draft, or "" when nothing is routed.
  currentDir: Accessor<string>
  sessionID: Accessor<string | undefined>
  tabs: boolean
  openSession: (directory: string, id: string) => void
  newSession: (directory: string) => void
  home: () => void
  // Link targets. Without them the sidebar links to the classic
  // `/:dir/session[/:id]` routes of the listed directory.
  sessionHref?: (session: { directory: string; id: string }) => string
  newSessionHref?: (directory: string) => string
}

export type SidebarVariant = "classic" | "v2"

const PREFETCH_CHUNK = 200
const PREFETCH_CONCURRENCY = 2
const PREFETCH_PENDING_LIMIT = 10
const PREFETCH_SPAN = 4
const PREFETCH_MAX_SESSIONS_PER_DIR = 10

type PrefetchQueue = {
  inflight: Set<string>
  pending: string[]
  pendingSet: Set<string>
  running: number
}

export function createSidebarController(host: SidebarHost) {
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const layout = useLayout()
  const platform = usePlatform()
  const pickDirectory = useDirectoryPicker()
  const server = useServer()
  const notification = useNotification()
  const providers = useProviders(() => undefined)
  const dialog = useDialog()
  const language = useLanguage()
  const editor = createInlineEditorController()

  const [store, setStore, , ready] = persisted(
    Persist.serverGlobal(serverSDK().scope, "layout.page", ["layout.page.v1"]),
    createStore({
      lastProjectSession: {} as { [directory: string]: { directory: string; id: string; at: number } },
      activeProject: undefined as string | undefined,
      activeWorkspace: undefined as string | undefined,
      workspaceOrder: {} as Record<string, string[]>,
      workspaceName: {} as Record<string, string>,
      workspaceBranchName: {} as Record<string, Record<string, string>>,
      workspaceExpanded: {} as Record<string, boolean>,
      gettingStartedDismissed: false,
    }),
  )
  const pageReady = createMemo(() => ready())
  const layoutReady = createMemo(() => layout.ready())

  const [state, setState] = createStore({
    busyWorkspaces: {} as Record<string, boolean>,
    hoverProject: undefined as string | undefined,
    scrollSessionKey: undefined as string | undefined,
    nav: undefined as HTMLElement | undefined,
    sortNow: Date.now(),
    peek: undefined as string | undefined,
    peeked: false,
  })

  let scrollContainerRef: HTMLDivElement | undefined
  let dialogRun = 0
  let dialogDead = false
  let peekt: number | undefined
  let sortNowInterval: ReturnType<typeof setInterval> | undefined
  const navLeave = { current: undefined as number | undefined }
  const sortNow = () => state.sortNow
  const sortNowTimeout = setTimeout(
    () => {
      setState("sortNow", Date.now())
      sortNowInterval = setInterval(() => setState("sortNow", Date.now()), 60_000)
    },
    60_000 - (Date.now() % 60_000),
  )

  const setBusy = (directory: string, value: boolean) => {
    const key = pathKey(directory)
    if (value) {
      setState("busyWorkspaces", key, true)
      return
    }
    setState(
      "busyWorkspaces",
      produce((draft) => {
        delete draft[key]
      }),
    )
  }
  const isBusy = (directory: string) => !!state.busyWorkspaces[pathKey(directory)]

  const aim = createAim({
    enabled: () => !layout.sidebar.opened(),
    active: () => state.hoverProject,
    el: () => state.nav?.querySelector<HTMLElement>("[data-component='sidebar-rail']") ?? state.nav,
    onActivate: (directory) => {
      serverSync().child(directory)
      setState("hoverProject", directory)
    },
  })

  onCleanup(() => {
    dialogDead = true
    dialogRun += 1
    if (navLeave.current !== undefined) clearTimeout(navLeave.current)
    clearTimeout(sortNowTimeout)
    if (sortNowInterval) clearInterval(sortNowInterval)
    if (peekt !== undefined) clearTimeout(peekt)
    aim.reset()
  })

  onMount(() => {
    const hide = () => {
      if (document.visibilityState !== "hidden") return
      reset()
    }
    makeEventListener(window, "blur", () => reset())
    makeEventListener(document, "visibilitychange", hide)
  })

  // Worktree creation marks the directory busy until the server reports back.
  onMount(() => {
    const unsub = serverSDK().event.listen((event) => {
      if (event.details?.type !== "worktree.ready" && event.details?.type !== "worktree.failed") return
      setBusy(event.name, false)
    })
    onCleanup(unsub)
  })

  const sidebarHovering = createMemo(() => !layout.sidebar.opened() && state.hoverProject !== undefined)
  const sidebarExpanded = createMemo(() => layout.sidebar.opened() || sidebarHovering())
  const setHoverProject = (value: string | undefined) => {
    setState("hoverProject", value)
    if (value !== undefined) return
    aim.reset()
  }
  const clearHoverProjectSoon = () => queueMicrotask(() => setHoverProject(undefined))

  const disarm = () => {
    if (navLeave.current === undefined) return
    clearTimeout(navLeave.current)
    navLeave.current = undefined
  }

  const reset = () => {
    disarm()
    setHoverProject(undefined)
  }

  const arm = () => {
    if (layout.sidebar.opened()) return
    if (state.hoverProject === undefined) return
    disarm()
    navLeave.current = window.setTimeout(() => {
      navLeave.current = undefined
      setHoverProject(undefined)
    }, 300)
  }

  const hoverProjectData = createMemo(() => {
    const id = state.hoverProject
    if (!id) return
    return layout.projects.list().find((project) => project.worktree === id)
  })

  const peekProject = createMemo(() => {
    const id = state.peek
    if (!id) return
    return layout.projects.list().find((project) => project.worktree === id)
  })

  createEffect(() => {
    const p = hoverProjectData()
    if (p) {
      if (peekt !== undefined) {
        clearTimeout(peekt)
        peekt = undefined
      }
      setState("peek", p.worktree)
      setState("peeked", true)
      return
    }

    setState("peeked", false)
    if (state.peek === undefined) return
    if (peekt !== undefined) clearTimeout(peekt)
    peekt = window.setTimeout(() => {
      peekt = undefined
      setState("peek", undefined)
    }, 180)
  })

  createEffect(() => {
    if (!layout.sidebar.opened()) return
    setHoverProject(undefined)
  })

  const clearSidebarHoverState = () => {
    if (layout.sidebar.opened()) return
    reset()
  }

  // Every sidebar navigation drops the hover peek and the mobile drawer.
  const go = (navigate: () => void) => {
    clearSidebarHoverState()
    navigate()
    layout.mobileSidebar.hide()
  }
  const openSession = (directory: string, id: string) => go(() => host.openSession(directory, id))
  const newSession = (directory: string) => go(() => host.newSession(directory))

  function scrollToSession(sessionId: string, sessionKey: string) {
    if (!scrollContainerRef) return
    if (state.scrollSessionKey === sessionKey) return
    const element = scrollContainerRef.querySelector(`[data-session-id="${sessionId}"]`)
    if (!element) return
    const containerRect = scrollContainerRef.getBoundingClientRect()
    const elementRect = element.getBoundingClientRect()
    if (elementRect.top >= containerRect.top && elementRect.bottom <= containerRect.bottom) {
      setState("scrollSessionKey", sessionKey)
      return
    }
    setState("scrollSessionKey", sessionKey)
    element.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }

  const currentProject = createMemo(() => {
    const directory = host.currentDir()
    if (!directory) return
    const key = pathKey(directory)

    const projects = layout.projects.list()

    const sandbox = projects.find((p) => p.sandboxes?.some((item) => pathKey(item) === key))
    if (sandbox) return sandbox

    const direct = projects.find((p) => pathKey(p.worktree) === key)
    if (direct) return direct

    const [child] = serverSync().child(directory, { bootstrap: false })
    const id = child.project
    if (!id) return

    const meta = serverSync().data.project.find((p) => p.id === id)
    const root = meta?.worktree
    if (!root) return

    return projects.find((p) => p.worktree === root)
  })

  const workspaceName = (directory: string, projectId?: string, branch?: string) => {
    const key = pathKey(directory)
    const direct = store.workspaceName[key] ?? store.workspaceName[directory]
    if (direct) return direct
    if (!projectId) return
    if (!branch) return
    return store.workspaceBranchName[projectId]?.[branch]
  }

  const setWorkspaceName = (directory: string, next: string, projectId?: string, branch?: string) => {
    const key = pathKey(directory)
    setStore("workspaceName", key, next)
    if (!projectId) return
    if (!branch) return
    if (!store.workspaceBranchName[projectId]) {
      setStore("workspaceBranchName", projectId, {})
    }
    setStore("workspaceBranchName", projectId, branch, next)
  }

  const workspaceLabel = (directory: string, branch?: string, projectId?: string) =>
    workspaceName(directory, projectId, branch) ?? branch ?? getFilename(directory)

  const workspaceSetting = createMemo(() => {
    const project = currentProject()
    if (!project) return false
    if (project.vcs !== "git") return false
    return layout.sidebar.workspaces(project.worktree)()
  })

  const visibleSessionDirs = createMemo(() => {
    const project = currentProject()
    if (!project) return [] as string[]
    if (!workspaceSetting()) return [project.worktree]

    const activeDir = host.currentDir()
    return workspaceIds(project).filter((directory) => {
      const expanded = store.workspaceExpanded[directory] ?? directory === project.worktree
      const active = pathKey(directory) === pathKey(activeDir)
      return expanded || active
    })
  })

  createEffect(() => {
    if (!pageReady()) return
    if (!layoutReady()) return
    const projects = layout.projects.list()
    for (const [directory, expanded] of Object.entries(store.workspaceExpanded)) {
      if (!expanded) continue
      const key = pathKey(directory)
      const project = projects.find(
        (item) => pathKey(item.worktree) === key || item.sandboxes?.some((sandbox) => pathKey(sandbox) === key),
      )
      if (!project) continue
      if (project.vcs === "git" && layout.sidebar.workspaces(project.worktree)()) continue
      setStore("workspaceExpanded", directory, false)
    }
  })

  const currentSessions = createMemo(() => {
    const now = Date.now()
    return visibleSessionDirs().flatMap((dir) => sortedRootSessions(serverSync().child(dir, { bootstrap: true })[0], now))
  })

  const prefetchToken = { value: 0 }
  const prefetchQueues = new Map<string, PrefetchQueue>()
  const prefetchedByDir = new Map<string, Set<string>>()

  const lruFor = (directory: string) => {
    const existing = prefetchedByDir.get(directory)
    if (existing) return existing
    const created = new Set<string>()
    prefetchedByDir.set(directory, created)
    return created
  }

  const markPrefetched = (directory: string, sessionID: string) => {
    const current = host.sessionID()
    return pickSessionCacheEvictions({
      seen: lruFor(directory),
      keep: sessionID,
      limit: PREFETCH_MAX_SESSIONS_PER_DIR,
      preserve: current && pathKey(directory) === pathKey(host.currentDir()) ? [current] : undefined,
    })
  }

  createEffect(() => {
    const active = new Set(visibleSessionDirs())
    for (const directory of prefetchedByDir.keys()) {
      if (active.has(directory)) continue
      prefetchedByDir.delete(directory)
    }
  })

  createEffect(() => {
    host.currentDir()
    serverSDK().url

    prefetchToken.value += 1
    prefetchQueues.clear()
  })

  createEffect(() => {
    const visible = new Set(visibleSessionDirs())
    for (const [directory, q] of prefetchQueues) {
      if (visible.has(directory)) continue
      q.pending.length = 0
      q.pendingSet.clear()
      if (q.running === 0) prefetchQueues.delete(directory)
    }
  })

  const queueFor = (directory: string) => {
    const existing = prefetchQueues.get(directory)
    if (existing) return existing

    const created: PrefetchQueue = {
      inflight: new Set(),
      pending: [],
      pendingSet: new Set(),
      running: 0,
    }
    prefetchQueues.set(directory, created)
    return created
  }

  async function prefetchMessages(directory: string, sessionID: string, token: number) {
    await serverSync()
      .session.prefetch(sessionID, PREFETCH_CHUNK)
      .catch(() => {})
    if (prefetchToken.value !== token) return
    for (const stale of markPrefetched(directory, sessionID)) serverSync().session.evict(stale)
  }

  const pumpPrefetch = (directory: string) => {
    const q = queueFor(directory)
    if (q.running >= PREFETCH_CONCURRENCY) return

    const sessionID = q.pending.shift()
    if (!sessionID) return

    q.pendingSet.delete(sessionID)
    q.inflight.add(sessionID)
    q.running += 1

    const token = prefetchToken.value

    void prefetchMessages(directory, sessionID, token).finally(() => {
      q.running -= 1
      q.inflight.delete(sessionID)
      pumpPrefetch(directory)
    })
  }

  const prefetchSession = (session: Session, priority: "high" | "low" = "low") => {
    const directory = session.directory
    if (!directory) return

    const cached = untrack(() => !serverSync().session.shouldPrefetch(session.id, PREFETCH_CHUNK))
    if (cached) return

    const q = queueFor(directory)
    if (q.inflight.has(session.id)) return
    if (q.pendingSet.has(session.id)) {
      if (priority !== "high") return
      const index = q.pending.indexOf(session.id)
      if (index > 0) {
        q.pending.splice(index, 1)
        q.pending.unshift(session.id)
      }
      return
    }

    const lru = lruFor(directory)
    const known = lru.has(session.id)
    if (!known && lru.size >= PREFETCH_MAX_SESSIONS_PER_DIR && priority !== "high") return

    if (priority === "high") q.pending.unshift(session.id)
    if (priority !== "high") q.pending.push(session.id)
    q.pendingSet.add(session.id)

    while (q.pending.length > PREFETCH_PENDING_LIMIT) {
      const dropped = q.pending.pop()
      if (!dropped) continue
      q.pendingSet.delete(dropped)
    }

    pumpPrefetch(directory)
  }

  const warm = (sessions: Session[], index: number) => {
    for (let offset = 1; offset <= PREFETCH_SPAN; offset++) {
      const next = sessions[index + offset]
      if (next) prefetchSession(next, offset === 1 ? "high" : "low")

      const prev = sessions[index - offset]
      if (prev) prefetchSession(prev, offset === 1 ? "high" : "low")
    }
  }

  createEffect(() => {
    const sessions = currentSessions()
    if (sessions.length === 0) return

    const current = host.sessionID()
    const index = current ? sessions.findIndex((s) => s.id === current) : 0
    if (index === -1) return

    if (!current) {
      const first = sessions[index]
      if (first) prefetchSession(first, "high")
    }

    warm(sessions, index)
  })

  const openWarm = (target: { session: Session; index: number } | undefined) => {
    if (!target) return
    prefetchSession(target.session, "high")
    warm(currentSessions(), target.index)
    navigateToSession(target.session)
  }

  function navigateSessionByOffset(offset: number) {
    openWarm(adjacentSession(currentSessions(), host.sessionID(), offset))
  }

  function navigateSessionByUnseen(offset: number) {
    openWarm(
      adjacentUnseenSession(
        currentSessions(),
        host.sessionID(),
        offset,
        (session) => notification.session.unseenCount(session.id) > 0,
      ),
    )
  }

  function navigateProjectByOffset(offset: number) {
    const current = currentProject()?.worktree
    const fallback = host.currentDir() ? projectRoot(host.currentDir()) : undefined
    const target = adjacentProject(layout.projects.list(), current ?? fallback, offset)
    if (!target) return

    // warm up child store to prevent flicker
    serverSync().child(target.worktree)
    void openProject(target.worktree)
  }

  function navigateToProjectIndex(index: number) {
    const target = layout.projects.list()[index]
    if (!target) return

    serverSync().child(target.worktree)
    void openProject(target.worktree)
  }

  async function archiveSession(session: Session) {
    if ((await serverSDK().protocol) !== "v1") return
    const [store, setStore] = serverSync().child(session.directory)
    const sessions = store.session ?? []
    const index = sessions.findIndex((s) => s.id === session.id)
    const nextSession = sessions[index + 1] ?? sessions[index - 1]

    await serverSDK().client.session.update({
      sessionID: session.id,
      directory: session.directory,
      time: { archived: Date.now() },
    })
    setStore(
      produce((draft) => {
        const match = Binary.search(draft.session, session.id, (s) => s.id)
        if (match.found) draft.session.splice(match.index, 1)
      }),
    )
    // Tabs close themselves (and move to a neighbour) on this event.
    if (host.tabs) {
      notifySessionTabsRemoved({ directory: session.directory, sessionIDs: [session.id] })
      return
    }
    if (session.id !== host.sessionID()) return
    if (nextSession) {
      host.openSession(host.currentDir(), nextSession.id)
      return
    }
    host.newSession(host.currentDir())
  }

  function connectProvider() {
    const run = ++dialogRun
    void import("@/components/dialog-connect-provider").then((x) => {
      if (dialogDead || dialogRun !== run) return
      void dialog.show(() => <x.DialogConnectProvider />)
    })
  }

  function projectRoot(directory: string) {
    const key = pathKey(directory)
    const project = layout.projects
      .list()
      .find((item) => pathKey(item.worktree) === key || item.sandboxes?.some((sandbox) => pathKey(sandbox) === key))
    if (project) return project.worktree

    const known = Object.entries(store.workspaceOrder).find(
      ([root, dirs]) => pathKey(root) === key || dirs.some((item) => pathKey(item) === key),
    )
    if (known) return known[0]

    const [child] = serverSync().child(directory, { bootstrap: false })
    const id = child.project
    if (!id) return directory

    const meta = serverSync().data.project.find((item) => item.id === id)
    return meta?.worktree ?? directory
  }

  function activeProjectRoot(directory: string) {
    return currentProject()?.worktree ?? projectRoot(directory)
  }

  function rememberSessionRoute(directory: string, id: string, root = activeProjectRoot(directory)) {
    setStore("lastProjectSession", root, { directory, id, at: Date.now() })
    return root
  }

  function clearLastProjectSession(root: string) {
    if (!store.lastProjectSession[root]) return
    setStore(
      "lastProjectSession",
      produce((draft) => {
        delete draft[root]
      }),
    )
  }

  function syncSessionRoute(directory: string, id: string, root = activeProjectRoot(directory)) {
    rememberSessionRoute(directory, id, root)
    notification.session.markViewed(id)
    const expanded = untrack(() => store.workspaceExpanded[directory])
    if (expanded === false) {
      setStore("workspaceExpanded", directory, true)
    }
    requestAnimationFrame(() => scrollToSession(id, `${directory}:${id}`))
    return root
  }

  async function navigateToProject(directory: string | undefined) {
    if (!directory) return
    const root = projectRoot(directory)
    server.projects.touch(root)
    // Tabbed layouts start a fresh draft for the project instead of resuming.
    if (host.tabs) {
      newSession(root)
      return
    }
    const project = layout.projects.list().find((item) => item.worktree === root)
    let dirs = project
      ? effectiveWorkspaceOrder(root, [root, ...(project.sandboxes ?? [])], store.workspaceOrder[root])
      : [root]
    const canOpen = (value: string | undefined) => {
      if (!value) return false
      return dirs.some((item) => pathKey(item) === pathKey(value))
    }
    const refreshDirs = async (target?: string) => {
      if (!target || target === root || canOpen(target)) return canOpen(target)
      const listed = await Promise.resolve(
        project?.id ?? serverSDK().api.project.current({ location: { directory: root } }),
      )
        .then((value) => (typeof value === "string" ? value : value.id))
        .then((projectID) => serverSDK().api.project.directories({ projectID, location: { directory: root } }))
        .then((items) => items.map((item) => item.directory).filter((item) => pathKey(item) !== pathKey(root)))
        .catch(() => [] as string[])
      dirs = effectiveWorkspaceOrder(root, [root, ...listed], store.workspaceOrder[root])
      return canOpen(target)
    }
    const resume = async (target: { directory: string; id: string }) => {
      if (!canOpen(target.directory)) return false
      const sync = serverSync().ensureDirSyncContext(target.directory)
      if (sync.session.get(target.id)) {
        setStore("lastProjectSession", root, { directory: target.directory, id: target.id, at: Date.now() })
        openSession(target.directory, target.id)
        return true
      }
      const resolved = await sync.session
        .sync(target.id)
        .then(() => sync.session.get(target.id))
        .catch(() => undefined)
      if (!resolved?.directory) return false
      if (!canOpen(resolved.directory)) return false
      setStore("lastProjectSession", root, { directory: resolved.directory, id: resolved.id, at: Date.now() })
      openSession(resolved.directory, resolved.id)
      return true
    }

    const projectSession = store.lastProjectSession[root]
    if (projectSession?.id) {
      await refreshDirs(projectSession.directory)
      const opened = await resume(projectSession)
      if (opened) return
      clearLastProjectSession(root)
    }

    const latest = latestRootSession(
      dirs.map((item) => serverSync().child(item, { bootstrap: false })[0]),
      Date.now(),
    )
    if (latest && (await resume(latest))) {
      return
    }

    const fetched = latestRootSession(
      await Promise.all(
        dirs.map(async (item) => ({
          path: { directory: item },
          session: await listAllSessions(serverSDK().api.session, {
            directory: item,
            parentID: null,
            order: "desc",
          }).then((r) => r.sessions, () => []),
        })),
      ),
      Date.now(),
    )
    if (fetched && (await resume(fetched))) {
      return
    }

    newSession(root)
  }

  function navigateToSession(session: Session | undefined) {
    if (!session) return
    openSession(session.directory, session.id)
  }

  function openProject(directory: string, navigate = true) {
    layout.projects.open(directory)
    if (navigate) return navigateToProject(directory)
  }

  async function renameProject(project: LocalProject, next: string) {
    const current = displayName(project)
    if (next === current) return
    const name = next === getFilename(project.worktree) ? "" : next

    if (project.id && project.id !== "global") {
      const sdk = serverSDK()
      if ((await sdk.protocol) !== "v1") return
      const result = await sdk.client.project
        .update({ projectID: project.id, directory: project.worktree, name })
        .then((response) => response.data)
      if (!result) return
      serverSync().set("project", (items) =>
        items.map((item) => (item.id === result.id ? normalizeProjectInfo(result) : item)),
      )
      return
    }

    serverSync().project.meta(project.worktree, { name })
  }

  const renameWorkspace = (directory: string, next: string, projectId?: string, branch?: string) => {
    const current = workspaceName(directory, projectId, branch) ?? branch ?? getFilename(directory)
    if (current === next) return
    setWorkspaceName(directory, next, projectId, branch)
  }

  function closeProject(directory: string) {
    const list = layout.projects.list()
    const key = pathKey(directory)
    const index = list.findIndex((x) => pathKey(x.worktree) === key)
    const active = pathKey(currentProject()?.worktree ?? "") === key
    if (index === -1) return

    if (!active || host.tabs) {
      layout.projects.close(directory)
      return
    }

    if (list.length === 1) {
      layout.projects.close(directory)
      host.home()
      return
    }

    const next = list[index + 1] ?? list[index - 1]

    newSession(next.worktree)
    layout.projects.close(directory)
    queueMicrotask(() => {
      void navigateToProject(next.worktree)
    })
  }

  function toggleProjectWorkspaces(project: LocalProject) {
    const enabled = layout.sidebar.workspaces(project.worktree)()
    if (enabled) {
      layout.sidebar.toggleWorkspaces(project.worktree)
      return
    }
    if (project.vcs !== "git") return
    layout.sidebar.toggleWorkspaces(project.worktree)
  }

  const showEditProjectDialog = (project: LocalProject) => {
    const conn = server.current
    if (!conn) return
    const run = ++dialogRun
    void import("@/components/dialog-edit-project").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogEditProject server={conn} project={project} />)
    })
  }

  function chooseProject() {
    const conn = server.current
    if (!conn) return
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        for (const directory of result) {
          void openProject(directory, false)
        }
        void navigateToProject(result[0])
      } else if (result) {
        void openProject(result)
      }
    }

    pickDirectory({
      server: conn,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: resolve,
    })
  }

  const routed = () => !!host.currentDir()

  const deleteWorkspace = async (root: string, directory: string, leaveDeletedWorkspace = false) => {
    if (directory === root) return

    const currentKey = pathKey(host.currentDir())
    const deletedKey = pathKey(directory)
    const shouldLeave = leaveDeletedWorkspace || (routed() && currentKey === deletedKey)
    if (!leaveDeletedWorkspace && shouldLeave) {
      newSession(root)
    }

    setBusy(directory, true)

    const result = await serverSDK()
      .client.worktree.remove({ directory: root, worktreeRemoveInput: { directory } })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.delete.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return false
      })

    setBusy(directory, false)

    if (!result) return

    if (pathKey(store.lastProjectSession[root]?.directory ?? "") === pathKey(directory)) {
      clearLastProjectSession(root)
    }

    serverSync().set(
      "project",
      produce((draft) => {
        const project = draft.find((item) => item.worktree === root)
        if (!project) return
        project.sandboxes = (project.sandboxes ?? []).filter((sandbox) => sandbox !== directory)
      }),
    )
    setStore("workspaceOrder", root, (order) => (order ?? []).filter((workspace) => workspace !== directory))

    layout.projects.close(directory)
    layout.projects.open(root)

    if (shouldLeave) return

    const nextCurrent = host.currentDir()
    const nextKey = pathKey(nextCurrent)
    const project = layout.projects.list().find((item) => item.worktree === root)
    const dirs = project
      ? effectiveWorkspaceOrder(root, [root, ...(project.sandboxes ?? [])], store.workspaceOrder[root])
      : [root]
    const valid = dirs.some((item) => pathKey(item) === nextKey)

    if (routed() && projectRoot(nextCurrent) === root && !valid) {
      newSession(root)
    }
  }

  const resetWorkspace = async (root: string, directory: string) => {
    if (directory === root) return
    setBusy(directory, true)

    const progress = showToast({
      persistent: true,
      title: language.t("workspace.resetting.title"),
      description: language.t("workspace.resetting.description"),
    })
    const dismiss = () => dismissToast(progress)

    const sessions = await listAllSessions(serverSDK().api.session, { directory, order: "desc" }).then(
      (r) => r.sessions,
      () => [],
    )

    clearWorkspaceTerminals(
      directory,
      sessions.map((s) => s.id),
      platform,
      serverSDK().scope,
    )
    await serverSDK()
      .client.instance.dispose({ directory })
      .catch(() => undefined)

    const result = await serverSDK()
      .client.worktree.reset({ directory: root, worktreeResetInput: { directory } })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.reset.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return false
      })

    if (!result) {
      setBusy(directory, false)
      dismiss()
      return
    }

    if ((await serverSDK().protocol) === "v1")
      await Promise.all(
        sessions
          .filter((session) => session.time.archived === undefined)
          .map((session) =>
            serverSDK()
              .client.session.update({
                sessionID: session.id,
                directory: session.directory,
                time: { archived: Date.now() },
              })
              .catch(() => undefined),
          ),
      )

    setBusy(directory, false)
    dismiss()

    showToast({
      title: language.t("workspace.reset.success.title"),
      description: language.t("workspace.reset.success.description"),
      actions: [
        {
          label: language.t("command.session.new"),
          onClick: () => {
            host.newSession(directory)
            layout.mobileSidebar.hide()
          },
        },
        {
          label: language.t("common.dismiss"),
          onClick: "dismiss",
        },
      ],
    })
  }

  function DialogDeleteWorkspace(props: { root: string; directory: string }) {
    const name = createMemo(() => getFilename(props.directory))
    const [data, setData] = createStore({
      status: "loading" as "loading" | "ready" | "error",
      dirty: false,
    })

    onMount(() => {
      serverSDK()
        .api.vcs.status({ location: { directory: props.directory } })
        .then((result) => {
          const files = result.data
          const dirty = files.length > 0
          setData({ status: "ready", dirty })
        })
        .catch(() => {
          setData({ status: "error", dirty: false })
        })
    })

    const handleDelete = () => {
      const leaveDeletedWorkspace = routed() && pathKey(host.currentDir()) === pathKey(props.directory)
      if (leaveDeletedWorkspace) {
        newSession(props.root)
      }
      dialog.close()
      void deleteWorkspace(props.root, props.directory, leaveDeletedWorkspace)
    }

    const description = () => {
      if (data.status === "loading") return language.t("workspace.status.checking")
      if (data.status === "error") return language.t("workspace.status.error")
      if (!data.dirty) return language.t("workspace.status.clean")
      return language.t("workspace.status.dirty")
    }

    return (
      <Dialog title={language.t("workspace.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("workspace.delete.confirm", { name: name() })}
            </span>
            <span class="text-12-regular text-text-weak">{description()}</span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" disabled={data.status === "loading"} onClick={handleDelete}>
              {language.t("workspace.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  function DialogResetWorkspace(props: { root: string; directory: string }) {
    const name = createMemo(() => getFilename(props.directory))
    const [state, setState] = createStore({
      status: "loading" as "loading" | "ready" | "error",
      dirty: false,
      sessions: [] as Session[],
    })

    const refresh = async () => {
      const sessions = await listAllSessions(serverSDK().api.session, {
        directory: props.directory,
        order: "desc",
      }).then((r) => r.sessions, () => [])
      const active = sessions.filter((session) => session.time.archived === undefined)
      setState({ sessions: active })
    }

    onMount(() => {
      serverSDK()
        .api.vcs.status({ location: { directory: props.directory } })
        .then((result) => {
          const files = result.data
          const dirty = files.length > 0
          setState({ status: "ready", dirty })
          void refresh()
        })
        .catch(() => {
          setState({ status: "error", dirty: false })
        })
    })

    const handleReset = () => {
      dialog.close()
      void resetWorkspace(props.root, props.directory)
    }

    const archivedCount = () => state.sessions.length

    const description = () => {
      if (state.status === "loading") return language.t("workspace.status.checking")
      if (state.status === "error") return language.t("workspace.status.error")
      if (!state.dirty) return language.t("workspace.status.clean")
      return language.t("workspace.status.dirty")
    }

    const archivedLabel = () => {
      const count = archivedCount()
      if (count === 0) return language.t("workspace.reset.archived.none")
      if (count === 1) return language.t("workspace.reset.archived.one")
      return language.t("workspace.reset.archived.many", { count })
    }

    return (
      <Dialog title={language.t("workspace.reset.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("workspace.reset.confirm", { name: name() })}
            </span>
            <span class="text-12-regular text-text-weak">
              {description()} {archivedLabel()} {language.t("workspace.reset.note")}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" disabled={state.status === "loading"} onClick={handleReset}>
              {language.t("workspace.reset.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  const loadedSessionDirs = new Set<string>()

  createEffect(
    on(
      visibleSessionDirs,
      (dirs) => {
        if (dirs.length === 0) {
          loadedSessionDirs.clear()
          return
        }

        const next = new Set(dirs)
        for (const directory of next) {
          if (loadedSessionDirs.has(directory)) continue
          void serverSync().project.loadSessions(directory)
        }

        loadedSessionDirs.clear()
        for (const directory of next) {
          loadedSessionDirs.add(directory)
        }
      },
      { defer: true },
    ),
  )

  function handleDragStart(event: unknown) {
    const id = getDraggableId(event)
    if (!id) return
    setHoverProject(undefined)
    setStore("activeProject", id)
  }

  function handleDragOver(event: DragEvent) {
    const { draggable, droppable } = event
    if (draggable && droppable) {
      const projects = layout.projects.list()
      const fromIndex = projects.findIndex((p) => p.worktree === draggable.id.toString())
      const toIndex = projects.findIndex((p) => p.worktree === droppable.id.toString())
      if (fromIndex !== toIndex && toIndex !== -1) {
        layout.projects.move(draggable.id.toString(), toIndex)
      }
    }
  }

  function handleDragEnd() {
    setStore("activeProject", undefined)
  }

  function workspaceIds(project: LocalProject | undefined) {
    if (!project) return []
    const local = project.worktree
    const dirs = [local, ...(project.sandboxes ?? [])]
    const active = currentProject()
    const directory = pathKey(active?.worktree ?? "") === pathKey(project.worktree) ? host.currentDir() : undefined
    const extra =
      directory && pathKey(directory) !== pathKey(local) && !dirs.some((item) => pathKey(item) === pathKey(directory))
        ? directory
        : undefined
    const pending = extra ? WorktreeState.get(serverSDK().scope, extra)?.status === "pending" : false

    const ordered = effectiveWorkspaceOrder(local, dirs, store.workspaceOrder[project.worktree])
    if (pending && extra) return [local, extra, ...ordered.filter((item) => item !== local)]
    if (!extra) return ordered
    if (pending) return ordered
    return [...ordered, extra]
  }

  const sidebarProject = createMemo(() => {
    if (layout.sidebar.opened()) return currentProject()
    const hovered = hoverProjectData()
    if (hovered) return hovered
    return currentProject()
  })

  function handleWorkspaceDragStart(event: unknown) {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeWorkspace", id)
  }

  function handleWorkspaceDragOver(event: DragEvent) {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const project = sidebarProject()
    if (!project) return

    const ids = workspaceIds(project)
    const fromIndex = ids.findIndex((dir) => dir === draggable.id.toString())
    const toIndex = ids.findIndex((dir) => dir === droppable.id.toString())
    if (fromIndex === -1 || toIndex === -1) return
    if (fromIndex === toIndex) return

    const result = ids.slice()
    const [item] = result.splice(fromIndex, 1)
    if (!item) return
    result.splice(toIndex, 0, item)
    setStore(
      "workspaceOrder",
      project.worktree,
      result.filter((directory) => pathKey(directory) !== pathKey(project.worktree)),
    )
  }

  function handleWorkspaceDragEnd() {
    setStore("activeWorkspace", undefined)
  }

  const createWorkspace = async (project: LocalProject) => {
    clearSidebarHoverState()
    const created = await serverSDK()
      .client.worktree.create({ directory: project.worktree })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.create.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return undefined
      })

    if (!created?.directory) return

    setWorkspaceName(created.directory, created.branch ?? getFilename(created.directory), project.id, created.branch)

    const local = project.worktree
    const key = pathKey(created.directory)
    const root = pathKey(local)

    setBusy(created.directory, true)
    WorktreeState.pending(serverSDK().scope, created.directory)
    setStore("workspaceExpanded", key, true)
    if (key !== created.directory) {
      setStore("workspaceExpanded", created.directory, true)
    }
    setStore("workspaceOrder", project.worktree, (prev) => {
      const existing = prev ?? []
      const next = existing.filter((item) => {
        const id = pathKey(item)
        return id !== root && id !== key
      })
      return [created.directory, ...next]
    })

    serverSync().child(created.directory)
    newSession(created.directory)
  }

  const sessionHref = host.sessionHref

  const workspaceSidebarCtx: WorkspaceSidebarContext = {
    currentDir: host.currentDir,
    navList: currentSessions,
    sidebarExpanded,
    sidebarHovering,
    clearHoverProjectSoon,
    prefetchSession,
    archiveSession,
    sessionHref,
    newSessionHref: (directory) => host.newSessionHref?.(directory),
    newSession,
    workspaceName,
    renameWorkspace,
    editorOpen: editor.editorOpen,
    openEditor: editor.openEditor,
    closeEditor: editor.closeEditor,
    setEditor: editor.setEditor,
    InlineEditor: editor.InlineEditor,
    isBusy,
    workspaceExpanded: (directory, local) => store.workspaceExpanded[directory] ?? local,
    setWorkspaceExpanded: (directory, value) => setStore("workspaceExpanded", directory, value),
    showResetWorkspaceDialog: (root, directory) =>
      dialog.show(() => <DialogResetWorkspace root={root} directory={directory} />),
    showDeleteWorkspaceDialog: (root, directory) =>
      dialog.show(() => <DialogDeleteWorkspace root={root} directory={directory} />),
    setScrollContainerRef: (el, mobile) => {
      if (!mobile) scrollContainerRef = el
    },
  }

  const projectSidebarCtx: ProjectSidebarContext = {
    currentDir: host.currentDir,
    currentProject,
    sidebarOpened: () => layout.sidebar.opened(),
    sidebarHovering,
    hoverProject: () => state.hoverProject,
    onProjectMouseEnter: (worktree, event) => aim.enter(worktree, event),
    onProjectMouseLeave: (worktree) => aim.leave(worktree),
    onProjectFocus: (worktree) => aim.activate(worktree),
    onHoverOpenChanged: (worktree, hoverOpen) => {
      if (!hoverOpen && state.hoverProject && state.hoverProject !== worktree) return
      setState("hoverProject", hoverOpen ? worktree : undefined)
    },
    navigateToProject,
    openSidebar: () => layout.sidebar.open(),
    closeProject,
    showEditProjectDialog,
    toggleProjectWorkspaces,
    workspacesEnabled: (project) => project.vcs === "git" && layout.sidebar.workspaces(project.worktree)(),
    workspaceIds,
    workspaceLabel,
    sessionProps: {
      navList: currentSessions,
      sidebarExpanded,
      clearHoverProjectSoon,
      prefetchSession,
      archiveSession,
      href: sessionHref,
    },
  }

  const SidebarPanel = (panelProps: {
    project: Accessor<LocalProject | undefined>
    variant: SidebarVariant
    mobile?: boolean
    merged?: boolean
    width?: number
  }) => {
    const project = panelProps.project
    const v2 = panelProps.variant === "v2"
    const merged = createMemo(() => panelProps.mobile || (panelProps.merged ?? layout.sidebar.opened()))
    const hover = createMemo(() => !panelProps.mobile && panelProps.merged === false && !layout.sidebar.opened())
    const empty = createMemo(() => !routed() && layout.projects.list().length === 0)
    const projectName = createMemo(() => {
      const item = project()
      if (!item) return ""
      return item.name || getFilename(item.worktree)
    })
    const projectId = createMemo(() => project()?.id ?? "")
    const worktree = createMemo(() => project()?.worktree ?? "")
    const slug = createMemo(() => {
      const dir = worktree()
      if (!dir) return ""
      return base64Encode(dir)
    })
    const workspaces = createMemo(() => {
      const item = project()
      if (!item) return [] as string[]
      return workspaceIds(item)
    })
    const unseenCount = createMemo(() =>
      workspaces().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
    )
    const clearNotifications = () =>
      workspaces()
        .filter((directory) => notification.project.unseenCount(directory) > 0)
        .forEach((directory) => notification.project.markViewed(directory))
    const workspacesEnabled = createMemo(() => {
      const item = project()
      if (!item) return false
      if (item.vcs !== "git") return false
      return layout.sidebar.workspaces(item.worktree)()
    })
    const canToggle = createMemo(() => {
      const item = project()
      if (!item) return false
      return item.vcs === "git" || layout.sidebar.workspaces(item.worktree)()
    })
    const homedir = createMemo(() => serverSync().data.path.home)
    const artifactPath = (id: string) => sessionHref?.({ directory: worktree(), id })
    const artifacts = () => (
      <SidebarArtifacts
        directory={() => worktree() || undefined}
        sidebarExpanded={sidebarExpanded}
        clearHoverProjectSoon={clearHoverProjectSoon}
        sessionPath={sessionHref ? artifactPath : undefined}
      />
    )
    const primary = (input: { icon: "edit" | "plus"; label: string; onClick: () => void }) =>
      v2 ? (
        <ButtonV2
          variant="outline"
          size="large"
          class="w-full justify-center"
          icon={input.icon}
          onClick={input.onClick}
        >
          {input.label}
        </ButtonV2>
      ) : (
        <Button
          size="large"
          class="w-full"
          icon={input.icon === "plus" ? "plus-small" : undefined}
          onClick={input.onClick}
        >
          <Show when={input.icon === "edit"}>
            <IconV2 name="edit" size="small" />
          </Show>
          {input.label}
        </Button>
      )

    return (
      <div
        classList={{
          "flex flex-col min-h-0 min-w-0 box-border": true,
          "rounded-tl-[12px] px-3": !v2,
          "border border-b-0 border-border-weak-base": !v2 && !merged(),
          "border-l border-t border-border-weaker-base": !v2 && merged(),
          "bg-background-base": !v2 && (merged() || hover()),
          "bg-background-stronger": !v2 && !merged() && !hover(),
          "px-2 bg-v2-background-bg-deep": v2,
          "rounded-[10px] shadow-[var(--v2-elevation-raised)]": v2 && hover(),
          "flex-1 min-w-0": panelProps.mobile,
          "max-w-full overflow-hidden": panelProps.mobile,
        }}
        style={{
          width: panelProps.mobile ? undefined : `${panelProps.width ?? 0}px`,
        }}
      >
        <Show
          when={project()}
          fallback={
            <Show when={empty()}>
              <div class="flex-1 min-h-0 -mt-4 flex items-center justify-center px-6 pb-64 text-center">
                <div class="mt-8 flex max-w-60 flex-col items-center gap-6 text-center">
                  <div class="flex flex-col gap-3">
                    <div class="text-14-medium text-text-strong">{language.t("sidebar.empty.title")}</div>
                    <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                      {language.t("sidebar.empty.description")}
                    </div>
                  </div>
                  <Show
                    when={v2}
                    fallback={
                      <Button size="large" icon="folder-add-left" onClick={chooseProject}>
                        {language.t("command.project.open")}
                      </Button>
                    }
                  >
                    <ButtonV2
                      variant="outline"
                      size="large"
                      icon="folder-add-left"
                      onClick={chooseProject}
                    >
                      {language.t("command.project.open")}
                    </ButtonV2>
                  </Show>
                </div>
              </div>
            </Show>
          }
          keyed
        >
          {(project) => (
            <>
              <div class="shrink-0" classList={{ "pl-1 py-1": !v2, "pt-1": v2 }}>
                <div
                  class="group/project flex items-start justify-between gap-2"
                  classList={{ "py-2 pl-2 pr-0": !v2, "py-1.5 pl-1.5 pr-0": v2 }}
                >
                  <div class="flex flex-col min-w-0">
                    <editor.InlineEditor
                      id={`project:${projectId()}`}
                      value={projectName}
                      onSave={(next) => {
                        void renameProject(project, next)
                      }}
                      class="text-14-medium text-text-strong truncate"
                      displayClass="text-14-medium text-text-strong truncate"
                      stopPropagation
                    />

                    <Tooltip
                      placement="bottom"
                      gutter={2}
                      value={worktree()}
                      class="shrink-0"
                      contentStyle={{
                        "max-width": "640px",
                        transform: "translate3d(52px, 0, 0)",
                      }}
                    >
                      <span class="text-12-regular text-text-base truncate select-text">
                        {worktree().replace(homedir(), "~")}
                      </span>
                    </Tooltip>
                  </div>

                  <DropdownMenu modal={!sidebarHovering()}>
                    <DropdownMenu.Trigger
                      as={IconButton}
                      icon="dot-grid"
                      variant="ghost"
                      data-action="project-menu"
                      data-project={slug()}
                      class="shrink-0 size-6 rounded-md transition-opacity data-[expanded]:bg-surface-base-active"
                      classList={{
                        "opacity-100": panelProps.mobile || merged(),
                        "opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 data-[expanded]:opacity-100":
                          !panelProps.mobile && !merged(),
                      }}
                      aria-label={language.t("common.moreOptions")}
                    />
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content class="mt-1">
                        <DropdownMenu.Item onSelect={() => showEditProjectDialog(project)}>
                          <DropdownMenu.ItemLabel>{language.t("common.edit")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          data-action="project-workspaces-toggle"
                          data-project={slug()}
                          disabled={!canToggle()}
                          onSelect={() => {
                            toggleProjectWorkspaces(project)
                          }}
                        >
                          <DropdownMenu.ItemLabel>
                            {workspacesEnabled()
                              ? language.t("sidebar.workspaces.disable")
                              : language.t("sidebar.workspaces.enable")}
                          </DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          data-action="project-clear-notifications"
                          data-project={slug()}
                          disabled={unseenCount() === 0}
                          onSelect={clearNotifications}
                        >
                          <DropdownMenu.ItemLabel>
                            {language.t("sidebar.project.clearNotifications")}
                          </DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator />
                        <DropdownMenu.Item
                          data-action="project-close-menu"
                          data-project={slug()}
                          onSelect={() => {
                            const dir = worktree()
                            if (!dir) return
                            closeProject(dir)
                          }}
                        >
                          <DropdownMenu.ItemLabel>{language.t("common.close")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                </div>
              </div>

              <div class="flex-1 min-h-0 flex flex-col">
                <Show
                  when={workspacesEnabled()}
                  fallback={
                    <>
                      <div class="shrink-0" classList={{ "py-4": !v2, "pt-2 pb-3": v2 }}>
                        {primary({
                          icon: "edit",
                          label: language.t("command.session.new"),
                          onClick: () => {
                            const dir = worktree()
                            if (!dir) return
                            newSession(dir)
                          },
                        })}
                      </div>
                      <div class="flex-1 min-h-0 flex flex-col">
                        {artifacts()}
                        <div class="flex-1 min-h-0">
                          <LocalWorkspace
                            ctx={workspaceSidebarCtx}
                            project={project}
                            sortNow={sortNow}
                            mobile={panelProps.mobile}
                          />
                        </div>
                      </div>
                    </>
                  }
                >
                  <>
                    <div class="shrink-0" classList={{ "py-4": !v2, "pt-2 pb-3": v2 }}>
                      {primary({
                        icon: "plus",
                        label: language.t("workspace.new"),
                        onClick: () => {
                          void createWorkspace(project)
                        },
                      })}
                    </div>
                    <div class="relative flex-1 min-h-0">
                      <DragDropProvider
                        onDragStart={handleWorkspaceDragStart}
                        onDragEnd={handleWorkspaceDragEnd}
                        onDragOver={handleWorkspaceDragOver}
                        collisionDetector={closestCenter}
                      >
                        <DragDropSensors />
                        <ConstrainDragXAxis />
                        <div
                          ref={(el) => {
                            if (!panelProps.mobile) scrollContainerRef = el
                          }}
                          class="size-full flex flex-col py-2 gap-4 overflow-y-auto no-scrollbar [overflow-anchor:none]"
                        >
                          <SortableProvider ids={workspaces()}>
                            <For each={workspaces()}>
                              {(directory) => (
                                <SortableWorkspace
                                  ctx={workspaceSidebarCtx}
                                  directory={directory}
                                  project={project}
                                  sortNow={sortNow}
                                  mobile={panelProps.mobile}
                                />
                              )}
                            </For>
                          </SortableProvider>
                          {artifacts()}
                        </div>
                        <DragOverlay>
                          <WorkspaceDragOverlay
                            sidebarProject={sidebarProject}
                            activeWorkspace={() => store.activeWorkspace}
                            workspaceLabel={workspaceLabel}
                          />
                        </DragOverlay>
                      </DragDropProvider>
                    </div>
                  </>
                </Show>
              </div>
            </>
          )}
        </Show>

        <Show when={!v2}>
          <div
            class="shrink-0 px-3 py-3"
            classList={{
              hidden: store.gettingStartedDismissed || !(providers.all().size > 0 && providers.paid().length === 0),
            }}
          >
            <div class="rounded-xl bg-background-base shadow-xs-border-base" data-component="getting-started">
              <div class="p-3 flex flex-col gap-6">
                <div class="flex flex-col gap-2">
                  <div class="text-14-medium text-text-strong">{language.t("sidebar.gettingStarted.title")}</div>
                  <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                    {language.t("sidebar.gettingStarted.line1")}
                  </div>
                  <div class="text-14-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                    {language.t("sidebar.gettingStarted.line2")}
                  </div>
                </div>
                <div data-component="getting-started-actions">
                  <Button size="large" icon="plus-small" onClick={connectProvider}>
                    {language.t("command.provider.connect")}
                  </Button>
                  <Button size="large" variant="ghost" onClick={() => setStore("gettingStartedDismissed", true)}>
                    {language.t("toast.update.action.notYet")}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </Show>
      </div>
    )
  }

  const projects = () => layout.projects.list()
  const projectOverlay = () => <ProjectDragOverlay projects={projects} activeProject={() => store.activeProject} />
  const renderProject = (project: LocalProject, mobile?: boolean) => (
    <SortableProject ctx={projectSidebarCtx} project={project} sortNow={sortNow} mobile={mobile} />
  )

  return {
    ready,
    state,
    go,
    setNav: (el: HTMLElement | undefined) => setState("nav", el),
    aim,
    arm,
    disarm,
    sidebarHovering,
    sidebarExpanded,
    peekProject,
    currentProject,
    currentSessions,
    workspaceSetting,
    projects,
    projectOverlay,
    renderProject,
    SidebarPanel,
    setBusy,
    openProject,
    navigateToProject,
    chooseProject,
    createWorkspace,
    toggleProjectWorkspaces,
    navigateSessionByOffset,
    navigateSessionByUnseen,
    navigateProjectByOffset,
    navigateToProjectIndex,
    rememberSessionRoute,
    syncSessionRoute,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
  }
}
