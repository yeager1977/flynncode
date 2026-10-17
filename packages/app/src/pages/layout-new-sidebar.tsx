import { createEffect, createMemo, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { useDialog } from "@flynncode/ui/context/dialog"
import { ResizeHandle } from "@flynncode/ui/resize-handle"
import { ButtonV2 } from "@flynncode/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@flynncode/ui/v2/dialog-v2"
import { DividerV2 } from "@flynncode/ui/v2/divider-v2"
import { IconButtonV2 } from "@flynncode/ui/v2/icon-button-v2"
import { Icon } from "@flynncode/ui/v2/icon"
import { KeybindV2 } from "@flynncode/ui/v2/keybind-v2"
import { TooltipV2 } from "@flynncode/ui/v2/tooltip-v2"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout, type LocalProject } from "@/context/layout"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useTabs } from "@/context/tabs"
import { pathKey } from "@/utils/path-key"
import { sessionHref } from "@/utils/session-route"
import { showToast } from "@/utils/toast"
import type { Session } from "@flynncode/sdk/v2/client"
import { displayName, sortedRootSessions } from "./layout/helpers"
import { createSidebarController } from "./layout/sidebar-controller"
import { SessionSidebar, SIDEBAR_SESSION_PREVIEW } from "./layout/session-sidebar"
import { createSidebarSessions, type SidebarGroup } from "./layout/sidebar-sessions"
import {
  listedWorktree,
  openProjectDirectory,
  openSidebarByDefault,
  projectDraft,
  sidebarCommands,
  sidebarDirectory,
  visibleSessionOrder,
  worktreeClosing,
} from "./layout/new-layout-sidebar"

const MIN_WIDTH = 244
const MOBILE = "(max-width: 767px)"

// Phones get a drawer (layout.mobileSidebar); wider windows the docked sidebar.
function useSidebarToggle() {
  const layout = useLayout()
  const mobile = createMediaQuery(MOBILE)
  return {
    opened: () => (mobile() ? layout.mobileSidebar.opened() : layout.sidebar.opened()),
    toggle: () => (mobile() ? layout.mobileSidebar.toggle() : layout.sidebar.toggle()),
  }
}

export function SidebarToggle() {
  const command = useCommand()
  const language = useLanguage()
  const sidebar = useSidebarToggle()
  return (
    <TooltipV2
      placement="bottom"
      value={
        <>
          {language.t("command.sidebar.toggle")}
          <KeybindV2 keys={command.keybindParts("sidebar.toggle")} variant="neutral" />
        </>
      }
      class="shrink-0"
    >
      <IconButtonV2
        type="button"
        variant="ghost-muted"
        size="large"
        class="!w-9 shrink-0"
        data-action="sidebar-toggle"
        icon={<Icon name="sidebar-left" />}
        onClick={sidebar.toggle}
        aria-label={language.t("command.sidebar.toggle")}
        aria-expanded={sidebar.opened()}
        aria-controls="project-sidebar"
      />
    </TooltipV2>
  )
}

// The session sidebar hosted in the new layout: every open project is a
// collapsible header with its sessions underneath, and selecting a session
// only routes. Collapsed, the column hides entirely.
export function ProjectSidebar() {
  const layout = useLayout()
  const tabs = useTabs()
  const server = useServer()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const navigate = useNavigate()
  const command = useCommand()
  const language = useLanguage()
  const toggle = useSidebarToggle()
  const [state, setState] = createStore({
    remembered: undefined as string | undefined,
    sizing: false,
    showAll: {} as Record<string, boolean>,
  })
  let sizet: number | undefined

  const sessionDirectory = (id: string) => serverSync().session.get(id)?.directory
  const routed = createMemo(() =>
    sidebarDirectory({ route: layout.route(), server: server.key, tabs: tabs.store, sessionDirectory }),
  )
  const sessionID = () => {
    const route = layout.route()
    if (route.type !== "session") return
    if (route.server !== undefined && route.server !== server.key) return
    return route.sessionId
  }
  createEffect(() => {
    const directory = routed()
    if (directory) setState("remembered", directory)
  })
  const currentDir = createMemo(
    () =>
      openProjectDirectory(
        [
          routed(),
          layout.home.selection().server === server.key ? layout.home.selection().directory : undefined,
          state.remembered,
          server.projects.last(),
          layout.projects.list()[0]?.worktree,
        ],
        layout.projects.list(),
      ) ?? "",
  )

  // New session reuses the directory's open draft rather than stacking another.
  const openDraft = (directory: string) => {
    const draft = projectDraft(tabs.store, server.key, directory)
    if (draft) {
      tabs.select(draft)
      return
    }
    void tabs.newDraft({ server: server.key, directory })
  }

  const sidebar = createSidebarController({
    currentDir,
    routedDir: routed,
    sessionID,
    tabs: true,
    openSession: (_, id) => navigate(sessionHref(server.key, id)),
    closeTabs: async (input) => {
      const closing = worktreeClosing({
        tabs: tabs.store,
        server: server.key,
        directory: input.directory,
        drafts: input.drafts,
        route: layout.route(),
        sessionDirectory,
      })
      // Like the session header's worktree menu: land on a draft in the main
      // checkout before the removed worktree's drafts go away.
      // A reset keeps the worktree, so its replacement draft stays there.
      if (closing.showing)
        await tabs.newDraft({ server: server.key, directory: input.drafts ? input.root : input.directory })
      for (const draftID of closing.drafts) {
        const index = tabs.store.findIndex((tab) => tab.type === "draft" && tab.draftID === draftID)
        if (index !== -1) tabs.removeTab(index)
      }
    },
    newSession: openDraft,
    openProject: openDraft,
    sessionHref: (session) => sessionHref(server.key, session.id),
    home: () => navigate("/"),
  })

  const dialog = useDialog()

  const showEditProjectDialog = (project: LocalProject) => {
    const conn = server.current
    if (!conn) return
    void import("@/components/dialog-edit-project-v2").then(({ DialogEditProjectV2 }) => {
      void dialog.show(() => <DialogEditProjectV2 server={conn} project={project} />)
    })
  }

  const hideProject = (worktree: string) => {
    layout.projects.hide(worktree)
  }

  const unhideProject = (worktree: string) => {
    layout.projects.unhide(worktree)
  }

  const forgetProject = (project: LocalProject) => {
    dialog.show(() => (
      <DialogForgetProject
        name={displayName(project)}
        onCancel={() => dialog.close()}
        onConfirm={() => {
          dialog.close()
          layout.projects.forget(project.worktree)
        }}
      />
    ))
  }

  // Remember the routed session's project so New session and Home target it.
  createEffect(
    on([routed, sidebar.ready] as const, ([directory, ready]) => {
      if (!ready || !directory) return
      const root = sidebar.projectRoot(directory)
      if (server.projects.last() !== root) server.projects.touch(root)
    }),
  )

  // Opening a session, draft or artifact from the phone drawer closes it.
  createEffect(
    on(
      () => layout.route(),
      () => layout.mobileSidebar.hide(),
      { defer: true },
    ),
  )

  openSidebarByDefault({
    ready: layout.ready,
    defaulted: layout.sidebar.defaulted,
    open: layout.sidebar.openByDefault,
  })

  command.register("sidebar", () =>
    sidebarCommands({
      t: language.t,
      category: {
        view: language.t("command.category.view"),
        project: language.t("command.category.project"),
        session: language.t("command.category.session"),
      },
      projectCount: () => layout.projects.list().length,
      toggle: toggle.toggle,
      project: sidebar.navigateProjectByOffset,
      projectIndex: sidebar.navigateToProjectIndex,
      session: sidebar.navigateSessionByOffset,
      unseen: sidebar.navigateSessionByUnseen,
    }),
  )

  const listing = createSidebarSessions()
  const archive = async (session: Session) => {
    const ok = await serverSDK()
      .client.session.update({ sessionID: session.id, directory: session.directory, time: { archived: Date.now() } })
      .then(() => true)
      .catch(() => false)
    if (!ok) {
      showToast({ title: language.t("common.requestFailed") })
      return
    }
    serverSync().homeSessions.remove(session.id)
    // Archiving the open session leaves it; "/" starts a new one in this project.
    if (sessionID() === session.id) navigate("/")
  }
  // A project shows its newest sessions; the routed one stays listed even past the preview.
  const shown = (group: SidebarGroup) => {
    if (state.showAll[group.project.worktree]) return group.sessions
    const preview = group.sessions.slice(0, SIDEBAR_SESSION_PREVIEW)
    const active = group.sessions.find((session) => session.id === sessionID())
    if (!active || preview.includes(active)) return preview
    return [...preview, active]
  }
  // Mod+1-9 open the Nth session as listed; nothing is bound while the sidebar is closed.
  const visible = createMemo(() => {
    if (!toggle.opened()) return []
    return visibleSessionOrder(listing.groups().map((group) => ({ expanded: true, sessions: shown(group) })))
  })
  command.register("sidebar-session-index", () =>
    visible()
      .slice(0, 9)
      .map((session, index) => ({
        id: `session.index.${index + 1}`,
        category: language.t("command.category.session"),
        title: session.title,
        keybind: `mod+${index + 1}`,
        hidden: true,
        onSelect: () => navigate(sessionHref(server.key, session.id)),
      })),
  )

  onMount(() => {
    const stop = () => setState("sizing", false)
    makeEventListener(window, "pointerup", stop)
    makeEventListener(window, "pointercancel", stop)
    makeEventListener(window, "blur", stop)
    makeEventListener(window, "keydown", (event) => {
      if (event.key !== "Escape" || !layout.mobileSidebar.opened()) return
      layout.mobileSidebar.hide()
    })
  })
  onCleanup(() => {
    if (sizet !== undefined) clearTimeout(sizet)
  })

  const side = createMemo(() => Math.max(layout.sidebar.width(), MIN_WIDTH))

  const content = () => (
    <SessionSidebar
      groups={listing.groups}
      activeSessionID={sessionID}
      currentDirectory={() => currentDir() || undefined}
      sessionHref={(session) => sessionHref(server.key, session.id)}
      onNewSession={openDraft}
      onOpenProject={() => sidebar.chooseProject()}
      onArchive={(session) => void archive(session)}
      onEditProject={showEditProjectDialog}
      onHideProject={hideProject}
      onUnhideProject={unhideProject}
      onForgetProject={forgetProject}
      hiddenProjects={layout.projects.hidden}
      shown={shown}
      showingAll={(worktree) => !!state.showAll[worktree]}
      showAll={(worktree, value) => setState("showAll", worktree, value)}
    />
  )

  return (
    <>
      <nav
        id="project-sidebar"
        aria-label={language.t("sidebar.nav.projectsAndSessions")}
        data-component="sidebar-v2"
        class="relative hidden md:block shrink-0 h-full overflow-hidden"
        classList={{
          "transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none":
            !state.sizing,
        }}
        style={{ width: `${layout.sidebar.opened() ? side() : 0}px` }}
        // Collapsed it is 0 wide but still mounted: keep it out of focus and the accessibility tree.
        inert={!layout.sidebar.opened()}
        aria-hidden={layout.sidebar.opened() ? undefined : "true"}
        ref={(el) => sidebar.setNav(el)}
      >
        <div class="@container h-full contain-strict" style={{ width: `${side()}px` }}>
          {content()}
        </div>
      </nav>

      <Show when={layout.sidebar.opened()}>
        <div class="relative hidden md:block w-0 shrink-0 z-30" onPointerDown={() => setState("sizing", true)}>
          <ResizeHandle
            direction="horizontal"
            size={layout.sidebar.width()}
            min={MIN_WIDTH}
            max={typeof window === "undefined" ? 1000 : window.innerWidth * 0.3}
            onResize={(width) => {
              setState("sizing", true)
              if (sizet !== undefined) clearTimeout(sizet)
              sizet = window.setTimeout(() => setState("sizing", false), 120)
              layout.sidebar.resize(width)
            }}
          />
        </div>
      </Show>

      <div class="md:hidden">
        <div
          class="fixed inset-0 z-40 bg-v2-overlay-simple-overlay-scrim transition-opacity duration-200"
          classList={{
            "opacity-100 pointer-events-auto": layout.mobileSidebar.opened(),
            "opacity-0 pointer-events-none": !layout.mobileSidebar.opened(),
          }}
          onClick={() => layout.mobileSidebar.hide()}
        />
        <nav
          aria-label={language.t("sidebar.nav.projectsAndSessions")}
          data-component="sidebar-v2"
          class="@container fixed inset-y-0 start-0 z-50 flex w-[85vw] max-w-[400px] overflow-hidden bg-v2-background-bg-deep transition-transform duration-200 ease-out"
          classList={{
            "translate-x-0": layout.mobileSidebar.opened(),
            "ltr:-translate-x-full rtl:translate-x-full": !layout.mobileSidebar.opened(),
          }}
          style={{
            "padding-top": "env(safe-area-inset-top, 0px)",
            "padding-bottom": "env(safe-area-inset-bottom, 0px)",
          }}
        >
          {content()}
        </nav>
      </div>
    </>
  )
}

// "Forget" removes the project from the app entirely — files and sessions stay
// on disk and the project can return by opening the folder again.
function DialogForgetProject(props: { name: string; onCancel: () => void; onConfirm: () => void }) {
  const language = useLanguage()
  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{language.t("sidebar.project.forget.title")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex flex-col gap-1 px-4 pb-1">
        <span class="text-14-regular text-v2-text-text-base">
          {language.t("sidebar.project.forget.confirm", { name: props.name })}
        </span>
        <span class="text-12-regular text-v2-text-text-muted">
          {language.t("sidebar.project.forget.description")}
        </span>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 type="button" variant="neutral" onClick={props.onCancel}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 type="button" variant="danger" onClick={props.onConfirm}>
          {language.t("sidebar.project.forget.action")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
