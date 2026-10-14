import { createEffect, createMemo, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { ResizeHandle } from "@flynncode/ui/resize-handle"
import { IconButtonV2 } from "@flynncode/ui/v2/icon-button-v2"
import { Icon } from "@flynncode/ui/v2/icon"
import { KeybindV2 } from "@flynncode/ui/v2/keybind-v2"
import { TooltipV2 } from "@flynncode/ui/v2/tooltip-v2"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { tabKey, useTabs } from "@/context/tabs"
import { sessionHref } from "@/utils/session-route"
import { sortedRootSessions } from "./layout/helpers"
import { createSidebarController } from "./layout/sidebar-controller"
import { SessionSidebar } from "./layout/session-sidebar"
import {
  directoryTabs,
  openProjectDirectory,
  openSidebarByDefault,
  projectDraft,
  sidebarCommands,
  sidebarDirectory,
  visibleSessionOrder,
} from "./layout/new-layout-sidebar"

const RAIL_WIDTH = 64
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
  const navigate = useNavigate()
  const command = useCommand()
  const language = useLanguage()
  const toggle = useSidebarToggle()
  const [state, setState] = createStore({ remembered: undefined as string | undefined, sizing: false })
  let sizet: number | undefined

  const sessionDirectory = (id: string) =>
    serverSync().session.get(id)?.directory ??
    tabs.info[tabKey({ type: "session", server: server.key, sessionId: id })]?.directory
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

  const sidebar = createSidebarController({
    currentDir,
    routedDir: routed,
    sessionID,
    tabs: true,
    openSession: (_, id) => navigate(sessionHref(server.key, id)),
    closeTabs: async (input) => {
      const found = directoryTabs(tabs.store, server.key, input.directory, sessionDirectory)
      const drafts = input.drafts ? found.drafts : []
      const route = layout.route()
      const showing =
        (route.type === "session" && found.sessions.includes(route.sessionId)) ||
        (route.type === "draft" && drafts.includes(route.draftID))
      // Like the session header's worktree menu: land on a draft in the main
      // checkout before the removed worktree's tabs go away.
      // A reset keeps the worktree, so its replacement draft stays there.
      if (showing) await tabs.newDraft({ server: server.key, directory: input.drafts ? input.root : input.directory })
      if (found.sessions.length > 0)
        tabs.removeSessions({ server: server.key, directory: input.directory, sessionIDs: found.sessions })
      for (const draftID of drafts) {
        const index = tabs.store.findIndex((tab) => tab.type === "draft" && tab.draftID === draftID)
        if (index !== -1) tabs.removeTab(index)
      }
    },
    newSession: (directory) => void tabs.newDraft({ server: server.key, directory }),
    openProject: (root) => {
      const draft = projectDraft(tabs.store, server.key, root)
      if (draft) {
        tabs.select(draft)
        return
      }
      void tabs.newDraft({ server: server.key, directory: root })
    },
    sessionHref: (session) => sessionHref(server.key, session.id),
    home: () => navigate("/"),
  })

  // Follow tab switches: reveal the routed session in the list and remember
  // its project, as the classic layout does on route changes.
  createEffect(
    on([routed, sessionID, sidebar.ready] as const, ([directory, id, ready]) => {
      if (!ready || !directory) return
      const root = sidebar.projectRoot(directory)
      if (server.projects.last() !== root) server.projects.touch(root)
      if (!id) return
      // A routed session under a collapsed project header would stay hidden.
      if (layout.projects.list().some((project) => project.worktree === root && !project.expanded))
        layout.projects.expand(root)
      sidebar.revealSession(directory, id)
    }),
  )

  // Opening a session, draft or artifact from the phone drawer closes it.
  createEffect(on(() => layout.route(), () => layout.mobileSidebar.hide(), { defer: true }))

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

  // Mod+1-9 open the Nth session as listed: same per-project source and order
  // as the rendered list, skipping collapsed projects.
  const visible = createMemo(() =>
    visibleSessionOrder(
      layout.projects.list().map((project) => ({
        expanded: project.expanded,
        sessions: sortedRootSessions(serverSync().child(project.worktree)[0], sidebar.sortNow()),
      })),
    ),
  )
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

  const content = (mobile?: boolean) => (
    <SessionSidebar
      sidebar={sidebar}
      mobile={mobile}
      onNewSession={(directory) => void tabs.newDraft({ server: server.key, directory })}
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
        ref={(el) => sidebar.setNav(el)}
      >
        <div class="@container h-full contain-strict" style={{ width: `${side()}px` }}>
          {content()}
        </div>
      </nav>

      <Show when={layout.sidebar.opened()}>
        <div
          class="relative hidden md:block w-0 shrink-0 z-30"
          onPointerDown={() => setState("sizing", true)}
        >
          <ResizeHandle
            direction="horizontal"
            size={layout.sidebar.width()}
            min={MIN_WIDTH}
            max={typeof window === "undefined" ? 1000 : window.innerWidth * 0.3 + RAIL_WIDTH}
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
          {content(true)}
        </nav>
      </div>
    </>
  )
}
