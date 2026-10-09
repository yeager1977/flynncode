import { createEffect, createMemo, createResource, on, onCleanup, onMount, ParentProps, Show, untrack } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useNavigate, useParams } from "@solidjs/router"
import { useLayout } from "@/context/layout"
import { useServerSync } from "@/context/server-sync"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { decode64 } from "@/utils/base64"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Button } from "@opencode-ai/ui/button"
import { getFilename } from "@opencode-ai/core/util/path"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { createStore } from "solid-js/store"
import { dismissToast, setV2Toast, showToast, ToastRegion } from "@/utils/toast"
import { useServerSDK } from "@/context/server-sdk"
import { useInboxBadge } from "@/pages/dispatch/activity-inbox-button"
import { usePermission } from "@/context/permission"
import { playSoundById } from "@/utils/sound"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { setSessionHandoff } from "@/pages/session/handoff"
import { SessionRouteKey, SessionStateKey } from "@/utils/server-scope"

import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme/context"
import { useCommand, type CommandOption } from "@/context/command"
import { DebugBar } from "@/components/debug-bar"
import { TabsInfoPopup } from "@/components/help-button"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { useServer } from "@/context/server"
import { useLanguage, type Locale } from "@/context/language"
import { pathKey } from "@/utils/path-key"
import {
  buildNewSessionDeepLink,
  collectNewSessionDeepLinks,
  collectOpenProjectDeepLinks,
  deepLinkEvent,
  drainPendingDeepLinks,
} from "./layout/deep-links"
import { createSidebarController } from "./layout/sidebar-controller"
import { SidebarContent } from "./layout/sidebar-shell"

export default function LegacyLayout(props: ParentProps) {
  const serverSDK = useServerSDK()
  const params = useParams()
  const serverSync = useServerSync()
  const layout = useLayout()
  const platform = usePlatform()
  const settings = useSettings()
  const server = useServer()
  const permission = usePermission()
  const navigate = useNavigate()
  const dialog = useDialog()
  const command = useCommand()
  const theme = useTheme()
  const language = useLanguage()
  createEffect(() => setV2Toast(false))
  const initialDirectory = decode64(params.dir)
  const route = createMemo(() => {
    const slug = params.dir
    if (!slug) return { slug, dir: "" }
    const dir = decode64(slug)
    if (!dir) return { slug, dir: "" }
    const store = serverSync().peek(dir, { bootstrap: false })
    return {
      slug,
      store,
      dir: store[0].path.directory || dir,
    }
  })
  const availableThemeEntries = createMemo(() => theme.ids().map((id) => [id, theme.themes()[id]] as const))
  const colorSchemeOrder: ColorScheme[] = ["system", "light", "dark"]
  const colorSchemeKey: Record<ColorScheme, "theme.scheme.system" | "theme.scheme.light" | "theme.scheme.dark"> = {
    system: "theme.scheme.system",
    light: "theme.scheme.light",
    dark: "theme.scheme.dark",
  }
  const colorSchemeLabel = (scheme: ColorScheme) => language.t(colorSchemeKey[scheme])
  const currentDir = createMemo(() => route().dir)

  const sidebar = createSidebarController({
    currentDir,
    sessionID: () => params.id,
    tabs: false,
    openSession: (directory, id) => navigate(`/${base64Encode(directory)}/session/${id}`),
    newSession: (directory) => navigate(`/${base64Encode(directory)}/session`),
    newSessionHref: (directory) => `/${base64Encode(directory)}/session`,
    home: () => navigate("/"),
  })

  const [state, setState] = createStore({
    autoselect: !initialDirectory,
    sizing: false,
    debugTools: true,
    quickEntry: false,
    quickEntryText: "",
  })

  let dialogRun = 0
  let dialogDead = false

  const updateVersion = () => {
    const state = platform.updater?.state()
    if (state?.status !== "ready") return
    return state.version
  }
  const installUpdate = () => void platform.updater?.install()
  const titlebarUpdate: TitlebarUpdate = {
    version: updateVersion,
    installing: () => platform.updater?.state().status === "installing",
    install: installUpdate,
  }

  let sizet: number | undefined

  onCleanup(() => {
    dialogDead = true
    dialogRun += 1
    if (sizet !== undefined) clearTimeout(sizet)
  })

  onMount(() => {
    const stop = () => setState("sizing", false)
    makeEventListener(window, "pointerup", stop)
    makeEventListener(window, "pointercancel", stop)
    makeEventListener(window, "blur", stop)
  })

  createEffect(() => {
    if (!state.autoselect) return
    const dir = params.dir
    if (!dir) return
    const directory = decode64(dir)
    if (!directory) return
    setState("autoselect", false)
  })

  const navigateWithSidebarReset = (href: string) => sidebar.go(() => navigate(href))

  function cycleTheme(direction = 1) {
    const ids = availableThemeEntries().map(([id]) => id)
    if (ids.length === 0) return
    const currentIndex = ids.indexOf(theme.themeId())
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + ids.length) % ids.length
    const nextThemeId = ids[nextIndex]
    theme.setTheme(nextThemeId)
    showToast({
      title: language.t("toast.theme.title"),
      description: theme.name(nextThemeId),
    })
  }

  function cycleColorScheme(direction = 1) {
    const current = theme.colorScheme()
    const currentIndex = colorSchemeOrder.indexOf(current)
    const nextIndex =
      currentIndex === -1 ? 0 : (currentIndex + direction + colorSchemeOrder.length) % colorSchemeOrder.length
    const next = colorSchemeOrder[nextIndex]
    theme.setColorScheme(next)
    showToast({
      title: language.t("toast.scheme.title"),
      description: colorSchemeLabel(next),
    })
  }

  function setLocale(next: Locale) {
    if (next === language.locale()) return
    language.setLocale(next)
    showToast({
      title: language.t("toast.language.title"),
      description: language.t("toast.language.description", { language: language.label(next) }),
    })
  }

  function cycleLanguage(direction = 1) {
    const locales = language.locales
    const currentIndex = locales.indexOf(language.locale())
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + locales.length) % locales.length
    const next = locales[nextIndex]
    if (!next) return
    setLocale(next)
  }

  const useSDKNotificationToasts = () =>
    onMount(() => {
      const toastBySession = new Map<string, number>()
      const alertedAtBySession = new Map<string, number>()
      const cooldownMs = 5000

      const dismissSessionAlert = (sessionKey: string) => {
        const toastId = toastBySession.get(sessionKey)
        if (toastId === undefined) return
        dismissToast(toastId)
        toastBySession.delete(sessionKey)
        alertedAtBySession.delete(sessionKey)
      }

      const unsub = serverSDK().event.listen((e) => {
        // The sidebar controller clears its busy flag on these too.
        if (e.details?.type === "worktree.ready") {
          WorktreeState.ready(serverSDK().scope, e.name)
          return
        }

        if (e.details?.type === "worktree.failed") {
          WorktreeState.failed(
            serverSDK().scope,
            e.name,
            e.details.properties?.message ?? language.t("common.requestFailed"),
          )
          return
        }

        if (
          e.details?.type === "question.replied" ||
          e.details?.type === "question.rejected" ||
          e.details?.type === "permission.replied"
        ) {
          const props = e.details.properties as { sessionID: string }
          const sessionKey = `${e.name}:${props.sessionID}`
          dismissSessionAlert(sessionKey)
          return
        }

        if (e.details?.type !== "permission.asked" && e.details?.type !== "question.asked") return
        const title =
          e.details.type === "permission.asked"
            ? language.t("notification.permission.title")
            : language.t("notification.question.title")
        const icon = e.details.type === "permission.asked" ? ("checklist" as const) : ("bubble-5" as const)
        const directory = e.name
        const props = e.details.properties
        if (e.details.type === "permission.asked" && permission.autoResponds(e.details.properties, directory)) return

        const [store] = serverSync().child(directory, { bootstrap: false })
        const session = store.session.find((s) => s.id === props.sessionID)
        const sessionKey = `${directory}:${props.sessionID}`

        const sessionTitle = session?.title ?? language.t("command.session.new")
        const projectName = getFilename(directory)
        const description =
          e.details.type === "permission.asked"
            ? language.t("notification.permission.description", { sessionTitle, projectName })
            : language.t("notification.question.description", { sessionTitle, projectName })
        const href = `/${base64Encode(directory)}/session/${props.sessionID}`

        const now = Date.now()
        const lastAlerted = alertedAtBySession.get(sessionKey) ?? 0
        if (now - lastAlerted < cooldownMs) return
        alertedAtBySession.set(sessionKey, now)

        if (e.details.type === "permission.asked") {
          if (settings.sounds.permissionsEnabled()) {
            void playSoundById(settings.sounds.permissions())
          }
          if (settings.notifications.permissions()) {
            void platform.notify(title, description, () => navigate(href))
          }
        }

        if (e.details.type === "question.asked") {
          if (settings.notifications.agent()) {
            void platform.notify(title, description, () => navigate(href))
          }
        }

        const currentSession = params.id
        if (pathKey(directory) === pathKey(currentDir()) && props.sessionID === currentSession) return
        if (pathKey(directory) === pathKey(currentDir()) && session?.parentID === currentSession) return

        dismissSessionAlert(sessionKey)

        const toastId = showToast({
          persistent: true,
          icon,
          title,
          description,
          actions: [
            {
              label: language.t("notification.action.goToSession"),
              onClick: () => navigate(href),
            },
            {
              label: language.t("common.dismiss"),
              onClick: "dismiss",
            },
          ],
        })
        toastBySession.set(sessionKey, toastId)
      })
      onCleanup(unsub)

      createEffect(() => {
        const currentSession = params.id
        if (!currentDir() || !currentSession) return
        const sessionKey = `${currentDir()}:${currentSession}`
        dismissSessionAlert(sessionKey)
        const [store] = serverSync().child(currentDir(), { bootstrap: false })
        const childSessions = store.session.filter((s) => s.parentID === currentSession)
        for (const child of childSessions) {
          dismissSessionAlert(`${currentDir()}:${child.id}`)
        }
      })
    })

  useSDKNotificationToasts()

  const [autoselecting] = createResource(async () => {
    await sidebar.ready.promise
    await layout.ready.promise
    if (!untrack(() => state.autoselect)) return

    const list = layout.projects.list()
    const last = server.projects.last()

    if (list.length === 0) {
      if (!last) return
      await sidebar.openProject(last, true)
    } else {
      const next = list.find((project) => project.worktree === last) ?? list[0]
      if (!next) return
      await sidebar.openProject(next.worktree, true)
    }
  })

  command.register("layout", () => {
    const commands: CommandOption[] = [
      {
        id: "sidebar.toggle",
        title: language.t("command.sidebar.toggle"),
        category: language.t("command.category.view"),
        keybind: "mod+b",
        onSelect: () => layout.sidebar.toggle(),
      },
      {
        id: "project.open",
        title: language.t("command.project.open"),
        category: language.t("command.category.project"),
        keybind: "mod+o",
        onSelect: () => sidebar.chooseProject(),
      },
      {
        id: "project.previous",
        title: language.t("command.project.previous"),
        category: language.t("command.category.project"),
        keybind: "mod+alt+arrowup",
        onSelect: () => sidebar.navigateProjectByOffset(-1),
      },
      {
        id: "project.next",
        title: language.t("command.project.next"),
        category: language.t("command.category.project"),
        keybind: "mod+alt+arrowdown",
        onSelect: () => sidebar.navigateProjectByOffset(1),
      },
      {
        id: "provider.connect",
        title: language.t("command.provider.connect"),
        category: language.t("command.category.provider"),
        onSelect: () => connectProvider(),
      },
      {
        id: "server.switch",
        title: language.t("command.server.switch"),
        category: language.t("command.category.server"),
        onSelect: () => openServer(),
      },
      {
        id: "settings.open",
        title: language.t("command.settings.open"),
        category: language.t("command.category.settings"),
        keybind: "mod+comma",
        onSelect: () => openSettings(),
      },
      {
        id: "session.previous",
        title: language.t("command.session.previous"),
        category: language.t("command.category.session"),
        keybind: "alt+arrowup",
        onSelect: () => sidebar.navigateSessionByOffset(-1),
      },
      {
        id: "session.next",
        title: language.t("command.session.next"),
        category: language.t("command.category.session"),
        keybind: "alt+arrowdown",
        onSelect: () => sidebar.navigateSessionByOffset(1),
      },
      {
        id: "session.previous.unseen",
        title: language.t("command.session.previous.unseen"),
        category: language.t("command.category.session"),
        keybind: "shift+alt+arrowup",
        onSelect: () => sidebar.navigateSessionByUnseen(-1),
      },
      {
        id: "session.next.unseen",
        title: language.t("command.session.next.unseen"),
        category: language.t("command.category.session"),
        keybind: "shift+alt+arrowdown",
        onSelect: () => sidebar.navigateSessionByUnseen(1),
      },
      {
        id: "workspace.new",
        title: language.t("workspace.new"),
        category: language.t("command.category.workspace"),
        keybind: "mod+shift+w",
        disabled: !sidebar.workspaceSetting(),
        onSelect: () => {
          const project = sidebar.currentProject()
          if (!project) return
          return sidebar.createWorkspace(project)
        },
      },
      {
        id: "workspace.toggle",
        title: language.t("command.workspace.toggle"),
        description: language.t("command.workspace.toggle.description"),
        category: language.t("command.category.workspace"),
        slash: "workspace",
        disabled: !sidebar.currentProject() || sidebar.currentProject()?.vcs !== "git",
        onSelect: () => {
          const project = sidebar.currentProject()
          if (!project) return
          if (project.vcs !== "git") return
          const wasEnabled = layout.sidebar.workspaces(project.worktree)()
          layout.sidebar.toggleWorkspaces(project.worktree)
          showToast({
            title: wasEnabled
              ? language.t("toast.workspace.disabled.title")
              : language.t("toast.workspace.enabled.title"),
            description: wasEnabled
              ? language.t("toast.workspace.disabled.description")
              : language.t("toast.workspace.enabled.description"),
          })
        },
      },
      {
        id: "theme.cycle",
        title: language.t("command.theme.cycle"),
        category: language.t("command.category.theme"),
        keybind: "mod+shift+t",
        onSelect: () => cycleTheme(1),
      },
    ]

    Array.from({ length: 9 }, (_, i) => {
      const index = i
      const number = index + 1
      commands.push({
        id: `project.${number}`,
        category: language.t("command.category.project"),
        title: `Open Project {number}`,
        keybind: `mod+${number}`,
        disabled: layout.projects.list().length <= index,
        hidden: true,
        onSelect: () => sidebar.navigateToProjectIndex(index),
      })
    })

    for (const [id] of availableThemeEntries()) {
      commands.push({
        id: `theme.set.${id}`,
        title: language.t("command.theme.set", { theme: theme.name(id) }),
        category: language.t("command.category.theme"),
        onSelect: () => theme.commitPreview(),
        onHighlight: () => {
          theme.previewTheme(id)
          return () => theme.cancelPreview()
        },
      })
    }

    commands.push({
      id: "theme.scheme.cycle",
      title: language.t("command.theme.scheme.cycle"),
      category: language.t("command.category.theme"),
      keybind: "mod+shift+s",
      onSelect: () => cycleColorScheme(1),
    })

    for (const scheme of colorSchemeOrder) {
      commands.push({
        id: `theme.scheme.${scheme}`,
        title: language.t("command.theme.scheme.set", { scheme: colorSchemeLabel(scheme) }),
        category: language.t("command.category.theme"),
        onSelect: () => theme.commitPreview(),
        onHighlight: () => {
          theme.previewColorScheme(scheme)
          return () => theme.cancelPreview()
        },
      })
    }

    commands.push({
      id: "language.cycle",
      title: language.t("command.language.cycle"),
      category: language.t("command.category.language"),
      onSelect: () => cycleLanguage(1),
    })

    for (const locale of language.locales) {
      commands.push({
        id: `language.set.${locale}`,
        title: language.t("command.language.set", { language: language.label(locale) }),
        category: language.t("command.category.language"),
        onSelect: () => setLocale(locale),
      })
    }

    return commands
  })

  function connectProvider() {
    const run = ++dialogRun
    void import("@/components/dialog-connect-provider").then((x) => {
      if (dialogDead || dialogRun !== run) return
      void dialog.show(() => <x.DialogConnectProvider />)
    })
  }

  function openServer() {
    const run = ++dialogRun
    void import("@/components/dialog-select-server").then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogSelectServer />)
    })
  }

  function openDispatch() {
    const run = ++dialogRun
    void import("@/pages/dispatch/dispatch-panel").then((mod) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <mod.DispatchPanel />)
    })
  }

  function openSettings() {
    const run = ++dialogRun
    const module = settings.general.newLayoutDesigns()
      ? import("@/components/settings-v2")
      : import("@/components/dialog-settings")
    void module.then((x) => {
      if (dialogDead || dialogRun !== run) return
      dialog.show(() => <x.DialogSettings />)
    })
  }

  const handleDeepLinks = (urls: string[]) => {
    if (!server.isLocal()) return

    for (const directory of collectOpenProjectDeepLinks(urls)) {
      void sidebar.openProject(directory)
    }

    for (const link of collectNewSessionDeepLinks(urls)) {
      void sidebar.openProject(link.directory, false)
      const slug = base64Encode(link.directory)
      if (link.prompt) {
        setSessionHandoff(SessionStateKey.from(server.scope(), SessionRouteKey.fromLegacy(slug)), {
          prompt: link.prompt,
        })
      }
      const href = link.prompt ? `/${slug}/session?prompt=${encodeURIComponent(link.prompt)}` : `/${slug}/session`
      navigateWithSidebarReset(href)
    }
  }

  onMount(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ urls: string[] }>).detail
      const urls = detail?.urls ?? []
      if (urls.length === 0) return
      handleDeepLinks(urls)
    }

    handleDeepLinks(drainPendingDeepLinks(window))
    makeEventListener(window, deepLinkEvent, handler as EventListener)
    makeEventListener(window, "opencode:quick-entry", () => {
      setState("quickEntry", true)
    })
  })

  const activeRoute = {
    session: "",
    sessionProject: "",
    directory: "",
  }

  createEffect(
    on(
      () => {
        return [sidebar.ready(), route().slug, params.id, sidebar.currentProject()?.worktree, currentDir()] as const
      },
      ([ready, slug, id, root, dir]) => {
        if (!ready || !slug || !dir) {
          activeRoute.session = ""
          activeRoute.sessionProject = ""
          activeRoute.directory = ""
          return
        }

        if (!id) {
          activeRoute.session = ""
          activeRoute.sessionProject = ""
          activeRoute.directory = ""
          return
        }

        const session = `${slug}/${id}`

        if (!root) {
          activeRoute.session = session
          activeRoute.directory = dir
          activeRoute.sessionProject = ""
          return
        }

        if (server.projects.last() !== root) server.projects.touch(root)

        const changed = session !== activeRoute.session || dir !== activeRoute.directory
        if (changed) {
          activeRoute.session = session
          activeRoute.directory = dir
          activeRoute.sessionProject = sidebar.syncSessionRoute(dir, id, root)
          return
        }

        if (root === activeRoute.sessionProject) return
        activeRoute.directory = dir
        activeRoute.sessionProject = sidebar.rememberSessionRoute(dir, id, root)
      },
    ),
  )

  createEffect(() => {
    document.documentElement.style.setProperty(
      "--dialog-left-margin",
      `${layout.sidebar.opened() ? layout.sidebar.width() : 48}px`,
    )
  })

  const side = createMemo(() => Math.max(layout.sidebar.width(), 244))
  const panel = createMemo(() => Math.max(side() - 64, 0))

  const inboxBadge = useInboxBadge()
  const sidebarContent = (mobile?: boolean) => (
    <SidebarContent
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
      settingsLabel={() => language.t("sidebar.settings")}
      settingsKeybind={() => command.keybind("settings.open")}
      onOpenSettings={openSettings}
      dispatchLabel={() => language.t("inbox.title")}
      dispatchUnread={inboxBadge}
      onOpenDispatch={openDispatch}
      helpLabel={() => language.t("sidebar.help")}
      onOpenHelp={() => platform.openExternal("https://opencode.ai/desktop-feedback")}
      renderPanel={() =>
        mobile ? (
          <sidebar.SidebarPanel project={sidebar.currentProject} variant="classic" mobile />
        ) : (
          <sidebar.SidebarPanel project={sidebar.currentProject} variant="classic" merged width={panel()} />
        )
      }
    />
  )

  return (
    <div class="relative bg-background-base flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text">
      {autoselecting() ?? ""}
      <Show when={state.quickEntry}>
        <form
          class="absolute inset-x-0 top-12 z-50 mx-auto flex w-[min(32rem,calc(100%-2rem))] gap-2 rounded-md border border-border-weak-base bg-background-base p-2"
          data-component="quick-entry"
          onSubmit={(event) => {
            event.preventDefault()
            const directory = currentDir()
            const prompt = state.quickEntryText.trim()
            if (!directory || !prompt) return
            handleDeepLinks([buildNewSessionDeepLink(directory, prompt)])
            setState({ quickEntry: false, quickEntryText: "" })
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setState({ quickEntry: false, quickEntryText: "" })
          }}
        >
          <Show
            when={currentDir()}
            fallback={<p class="min-w-0 flex-1 px-2 py-1 text-14-regular">{language.t("quickEntry.empty")}</p>}
          >
            <input
              class="min-w-0 flex-1 rounded-md border border-border-weak-base bg-transparent px-2 py-1 text-14-regular"
              value={state.quickEntryText}
              ref={(el) => queueMicrotask(() => el.focus())}
              aria-label={language.t("quickEntry.placeholder")}
              placeholder={language.t("quickEntry.placeholder")}
              onInput={(event) => setState("quickEntryText", event.currentTarget.value)}
            />
            <Button type="submit" size="small">
              {language.t("quickEntry.send")}
            </Button>
          </Show>
        </form>
      </Show>
      <Titlebar
        update={titlebarUpdate}
        debugTools={
          import.meta.env.DEV && import.meta.env.VITE_DISABLE_DEBUG_BAR !== "1"
            ? { visible: state.debugTools, toggle: () => setState("debugTools", (value) => !value) }
            : undefined
        }
      />
      <Show when={updateVersion() !== undefined}>
        <UpdateAvailableToast version={updateVersion() ?? ""} install={installUpdate} language={language} />
      </Show>
      <div class="flex-1 min-h-0 min-w-0 flex">
        <div class="flex-1 min-h-0 relative">
          <div class="size-full relative overflow-x-hidden">
            <nav
              aria-label={language.t("sidebar.nav.projectsAndSessions")}
              data-component="sidebar-nav-desktop"
              classList={{
                "hidden xl:block": true,
                "absolute inset-y-0 start-0": true,
                "z-10": true,
              }}
              style={{ width: `${side()}px` }}
              ref={(el) => sidebar.setNav(el)}
              onMouseEnter={() => {
                sidebar.disarm()
              }}
              onMouseLeave={() => {
                sidebar.aim.reset()
                if (!sidebar.sidebarHovering()) return

                sidebar.arm()
              }}
            >
              <div class="@container w-full h-full contain-strict">{sidebarContent()}</div>
            </nav>

            <Show when={layout.sidebar.opened()}>
              <div
                class="hidden xl:block absolute inset-y-0 z-30 w-0 overflow-visible"
                style={{ "inset-inline-start": `${side()}px` }}
                onPointerDown={() => setState("sizing", true)}
              >
                <ResizeHandle
                  direction="horizontal"
                  size={layout.sidebar.width()}
                  min={244}
                  max={typeof window === "undefined" ? 1000 : window.innerWidth * 0.3 + 64}
                  onResize={(w) => {
                    setState("sizing", true)
                    if (sizet !== undefined) clearTimeout(sizet)
                    sizet = window.setTimeout(() => setState("sizing", false), 120)
                    layout.sidebar.resize(w)
                  }}
                />
              </div>
            </Show>

            <div
              class="hidden xl:block pointer-events-none absolute top-0 end-0 z-0 border-t border-border-weaker-base"
              style={{ "inset-inline-start": "calc(4rem + 12px)" }}
            />

            <div class="xl:hidden">
              <div
                classList={{
                  "fixed inset-x-0 top-10 bottom-0 z-40 transition-opacity duration-200": true,
                  "opacity-100 pointer-events-auto": layout.mobileSidebar.opened(),
                  "opacity-0 pointer-events-none": !layout.mobileSidebar.opened(),
                }}
                onClick={(e) => {
                  if (e.target === e.currentTarget) layout.mobileSidebar.hide()
                }}
              />
              <nav
                aria-label={language.t("sidebar.nav.projectsAndSessions")}
                data-component="sidebar-nav-mobile"
                classList={{
                  "@container fixed top-10 bottom-0 start-0 z-50 w-full max-w-[400px] overflow-hidden border-e border-border-weaker-base bg-background-base transition-transform duration-200 ease-out": true,
                  "translate-x-0": layout.mobileSidebar.opened(),
                  "ltr:-translate-x-full rtl:translate-x-full": !layout.mobileSidebar.opened(),
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {sidebarContent(true)}
              </nav>
            </div>

            <div
              classList={{
                "absolute inset-0": true,
                "xl:inset-y-0 xl:end-0 xl:start-[var(--main-left)]": true,
                "z-20": true,
                "transition-[inset-inline-start] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[inset-inline-start] motion-reduce:transition-none":
                  !state.sizing,
              }}
              style={{
                "--main-left": layout.sidebar.opened() ? `${side()}px` : "4rem",
              }}
            >
              <main
                classList={{
                  "size-full overflow-x-hidden flex flex-col items-start contain-strict border-t border-border-weak-base bg-background-base xl:border-s xl:rounded-ss-[12px]": true,
                }}
              >
                <Show when={!autoselecting.loading} fallback={<div class="size-full" />}>
                  {props.children}
                </Show>
              </main>
            </div>

            <div
              classList={{
                "hidden xl:flex absolute inset-y-0 start-16 z-30": true,
                "opacity-100 translate-x-0 pointer-events-auto": sidebar.state.peeked && !layout.sidebar.opened(),
                "opacity-0 ltr:-translate-x-2 rtl:translate-x-2 pointer-events-none":
                  !sidebar.state.peeked || layout.sidebar.opened(),
                "transition-[opacity,transform] motion-reduce:transition-none": true,
                "duration-180 ease-out": sidebar.state.peeked && !layout.sidebar.opened(),
                "duration-120 ease-in": !sidebar.state.peeked || layout.sidebar.opened(),
              }}
              onMouseMove={sidebar.disarm}
              onMouseEnter={() => {
                sidebar.disarm()
                sidebar.aim.reset()
              }}
              onPointerDown={sidebar.disarm}
              onMouseLeave={() => {
                sidebar.arm()
              }}
            >
              <Show when={sidebar.peekProject()}>
                <sidebar.SidebarPanel project={sidebar.peekProject} variant="classic" merged={false} width={panel()} />
              </Show>
            </div>

            <div
              classList={{
                "hidden xl:block pointer-events-none absolute inset-y-0 end-0 z-25 overflow-hidden": true,
                "opacity-100 translate-x-0": sidebar.state.peeked && !layout.sidebar.opened(),
                "opacity-0 ltr:-translate-x-2 rtl:translate-x-2": !sidebar.state.peeked || layout.sidebar.opened(),
                "transition-[opacity,transform] motion-reduce:transition-none": true,
                "duration-180 ease-out": sidebar.state.peeked && !layout.sidebar.opened(),
                "duration-120 ease-in": !sidebar.state.peeked || layout.sidebar.opened(),
              }}
              style={{ "inset-inline-start": `calc(4rem + ${panel()}px)` }}
            >
              <div class="h-full w-px" style={{ "box-shadow": "var(--shadow-sidebar-overlay)" }} />
            </div>
          </div>
        </div>
        {import.meta.env.DEV && import.meta.env.VITE_DISABLE_DEBUG_BAR !== "1" && state.debugTools && <DebugBar />}
      </div>
      <TabsInfoPopup />
      <ToastRegion v2={false} />
    </div>
  )
}

function UpdateAvailableToast(props: {
  version: string
  install: () => void
  language: ReturnType<typeof useLanguage>
}) {
  let toastId: number | undefined

  onMount(() => {
    toastId = showToast({
      persistent: true,
      icon: "download",
      title: props.language.t("toast.update.title"),
      description: props.language.t("toast.update.description", { version: props.version }),
      actions: [
        {
          label: props.language.t("toast.update.action.installRestart"),
          onClick: props.install,
        },
        {
          label: props.language.t("toast.update.action.notYet"),
          onClick: "dismiss",
        },
      ],
    })
  })

  onCleanup(() => {
    if (toastId === undefined) return
    dismissToast(toastId)
  })

  return null
}
