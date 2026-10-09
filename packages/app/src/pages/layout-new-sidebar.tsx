import { createEffect, createMemo, onCleanup, onMount, Show, startTransition } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { tabKey, useTabs } from "@/context/tabs"
import { sessionHref } from "@/utils/session-route"
import { createSidebarController } from "./layout/sidebar-controller"
import { SidebarContent } from "./layout/sidebar-shell"
import { openSidebarByDefault, projectDraft, sidebarCommands, sidebarDirectory } from "./layout/new-layout-sidebar"

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
        icon={<IconV2 name="sidebar-left" />}
        onClick={sidebar.toggle}
        aria-label={language.t("command.sidebar.toggle")}
        aria-expanded={sidebar.opened()}
        aria-controls="project-sidebar"
      />
    </TooltipV2>
  )
}

// The classic project sidebar hosted in the new layout: sessions open as tabs
// and selecting a project opens a draft for it. Collapsed, it is the project
// rail; hovering a project there peeks at its sessions.
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

  const routed = createMemo(() =>
    sidebarDirectory({
      route: layout.route(),
      server: server.key,
      tabs: tabs.store,
      sessionDirectory: (id) =>
        serverSync().session.get(id)?.directory ??
        tabs.info[tabKey({ type: "session", server: server.key, sessionId: id })]?.directory,
      homeDirectory: layout.home.selection().server === server.key ? layout.home.selection().directory : undefined,
    }),
  )
  createEffect(() => {
    const directory = routed()
    if (directory) setState("remembered", directory)
  })
  const currentDir = createMemo(
    () => routed() ?? state.remembered ?? server.projects.last() ?? layout.projects.list()[0]?.worktree ?? "",
  )

  const sidebar = createSidebarController({
    currentDir,
    sessionID: () => {
      const route = layout.route()
      if (route.type !== "session") return
      if (route.server !== undefined && route.server !== server.key) return
      return route.sessionId
    },
    tabs: true,
    openSession: (_, id) =>
      void startTransition(() => {
        tabs.select(tabs.addSessionTab({ server: server.key, sessionId: id }))
      }),
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
  const panel = createMemo(() => side() - RAIL_WIDTH)
  const peeking = () => sidebar.state.peeked && !layout.sidebar.opened()

  const content = (mobile?: boolean) => (
    <SidebarContent
      variant="v2"
      mobile={mobile}
      opened={() => layout.sidebar.opened()}
      aimMove={sidebar.aim.move}
      projects={sidebar.projects}
      renderProject={(project) => sidebar.renderProject(project, mobile)}
      handleDragStart={sidebar.handleDragStart}
      handleDragEnd={sidebar.handleDragEnd}
      handleDragOver={sidebar.handleDragOver}
      openProjectLabel={language.t("command.project.open")}
      openProjectKeybind={() => command.keybind("project.open")}
      onOpenProject={sidebar.chooseProject}
      renderProjectOverlay={sidebar.projectOverlay}
      renderPanel={() => (
        <sidebar.SidebarPanel
          project={sidebar.currentProject}
          variant="v2"
          mobile={mobile}
          merged={mobile ? undefined : true}
          width={panel()}
        />
      )}
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
        style={{ width: `${layout.sidebar.opened() ? side() : RAIL_WIDTH}px` }}
        ref={(el) => sidebar.setNav(el)}
        onMouseEnter={() => sidebar.disarm()}
        onMouseLeave={() => {
          sidebar.aim.reset()
          if (!sidebar.sidebarHovering()) return
          sidebar.arm()
        }}
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

      <div
        data-component="sidebar-v2"
        class="absolute top-2 bottom-2 z-30 hidden md:flex"
        classList={{
          "opacity-100 translate-x-0 pointer-events-auto": peeking(),
          "opacity-0 ltr:-translate-x-2 rtl:translate-x-2 pointer-events-none": !peeking(),
          "transition-[opacity,transform] motion-reduce:transition-none": true,
          "duration-180 ease-out": peeking(),
          "duration-120 ease-in": !peeking(),
        }}
        style={{ "inset-inline-start": `${RAIL_WIDTH}px` }}
        onMouseMove={() => sidebar.disarm()}
        onMouseEnter={() => {
          sidebar.disarm()
          sidebar.aim.reset()
        }}
        onPointerDown={() => sidebar.disarm()}
        onMouseLeave={() => sidebar.arm()}
      >
        <Show when={sidebar.peekProject()}>
          <sidebar.SidebarPanel project={sidebar.peekProject} variant="v2" merged={false} width={panel()} />
        </Show>
      </div>

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
