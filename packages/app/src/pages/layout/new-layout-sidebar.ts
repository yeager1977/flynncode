import { createEffect, type Accessor } from "solid-js"
import type { CommandOption } from "@/context/command"
import type { LayoutRoute } from "@/context/layout"
import type { ServerConnection } from "@/context/server"
import type { DraftTab, Tab } from "@/context/tabs"
import { pathKey } from "@/utils/path-key"

// Logic behind the new layout's project sidebar, kept out of JSX so it runs
// under test with real Solid effects.

// The sidebar opens on the new layout's first run. The flag persists with the
// layout store, so a later close (or open) is the user's choice and sticks.
export function openSidebarByDefault(input: {
  ready: Accessor<boolean>
  defaulted: Accessor<boolean>
  open: () => void
}) {
  createEffect(() => {
    if (!input.ready()) return
    if (input.defaulted()) return
    input.open()
  })
}

// Directory of the routed session or draft when it belongs to this server;
// undefined on Home.
export function sidebarDirectory(input: {
  route: LayoutRoute
  server: ServerConnection.Key
  tabs: Tab[]
  sessionDirectory: (sessionID: string) => string | undefined
}) {
  const route = input.route
  if (route.type === "home") return
  if (route.server !== undefined && route.server !== input.server) return
  if (route.type === "session") return input.sessionDirectory(route.sessionId)
  if (route.type === "dir-new-sesssion") return route.dir
  return input.tabs.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === route.draftID)?.directory
}

// The directory the panel shows: the first candidate inside an open project,
// so closing the active project moves the panel on instead of blanking it.
export function openProjectDirectory(
  candidates: (string | undefined)[],
  projects: { worktree: string; sandboxes?: string[] }[],
) {
  return candidates.find((directory): directory is string => {
    if (!directory) return false
    const key = pathKey(directory)
    return projects.some(
      (project) => pathKey(project.worktree) === key || !!project.sandboxes?.some((item) => pathKey(item) === key),
    )
  })
}

// Selecting a project reuses its open code draft rather than stacking another.
export function projectDraft(tabs: Tab[], server: ServerConnection.Key, directory: string) {
  const key = pathKey(directory)
  return tabs.findLast(
    (tab): tab is DraftTab =>
      tab.type === "draft" && tab.server === server && pathKey(tab.directory) === key && tab.kind !== "knowledge",
  )
}

// Where an old `/:dir/session` link lands in the new layout: Home unless the
// segment names an absolute path or an open project; otherwise the directory's
// open draft (only without a `?prompt=` to deliver) or a fresh one.
export function legacyDraftTarget(input: {
  directory: string | undefined
  prompt: string | undefined
  tabs: Tab[]
  server: ServerConnection.Key
  projects: { worktree: string; sandboxes?: string[] }[]
}) {
  const directory = input.directory
  if (!directory) return { type: "home" as const }
  const absolute = /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(directory)
  if (!absolute && !openProjectDirectory([directory], input.projects)) return { type: "home" as const }
  const draft = input.prompt ? undefined : projectDraft(input.tabs, input.server, directory)
  if (draft) return { type: "select" as const, draft }
  return { type: "new" as const, directory }
}

// Tabs left pointing into a removed (or reset) worktree.
export function directoryTabs(
  tabs: Tab[],
  server: ServerConnection.Key,
  directory: string,
  sessionDirectory: (sessionID: string) => string | undefined,
) {
  const key = pathKey(directory)
  const inside = (value: string | undefined) => value !== undefined && pathKey(value) === key
  return {
    sessions: tabs.flatMap((tab) =>
      tab.type === "session" && tab.server === server && inside(sessionDirectory(tab.sessionId)) ? [tab.sessionId] : [],
    ),
    drafts: tabs.flatMap((tab) =>
      tab.type === "draft" && tab.server === server && inside(tab.directory) ? [tab.draftID] : [],
    ),
  }
}

export type SidebarCommandInput = {
  t: (key: SidebarCommandKey, params?: { index: number }) => string
  category: { view: string; project: string; session: string }
  projectCount: () => number
  toggle: () => void
  project: (offset: number) => void
  projectIndex: (index: number) => void
  session: (offset: number) => void
  unseen: (offset: number) => void
}

type SidebarCommandKey =
  | "command.sidebar.toggle"
  | "command.project.previous"
  | "command.project.next"
  | "command.project.index"
  | "command.session.previous"
  | "command.session.next"
  | "command.session.previous.unseen"
  | "command.session.next.unseen"

// The classic layout's sidebar commands with keybinds that fit the new
// layout: mod+1-9 jump to the Nth sidebar session, so project.1-9 have no
// default keybind (to avoid colliding) and stay in the palette and keybind
// settings instead.
export function sidebarCommands(input: SidebarCommandInput): CommandOption[] {
  return [
    {
      id: "sidebar.toggle",
      title: input.t("command.sidebar.toggle"),
      category: input.category.view,
      keybind: "mod+b",
      onSelect: input.toggle,
    },
    {
      id: "project.previous",
      title: input.t("command.project.previous"),
      category: input.category.project,
      keybind: "mod+alt+arrowup",
      onSelect: () => input.project(-1),
    },
    {
      id: "project.next",
      title: input.t("command.project.next"),
      category: input.category.project,
      keybind: "mod+alt+arrowdown",
      onSelect: () => input.project(1),
    },
    ...Array.from({ length: 9 }, (_, index) => ({
      id: `project.${index + 1}`,
      title: input.t("command.project.index", { index: index + 1 }),
      category: input.category.project,
      disabled: input.projectCount() <= index,
      onSelect: () => input.projectIndex(index),
    })),
    {
      id: "session.previous",
      title: input.t("command.session.previous"),
      category: input.category.session,
      keybind: "alt+arrowup",
      onSelect: () => input.session(-1),
    },
    {
      id: "session.next",
      title: input.t("command.session.next"),
      category: input.category.session,
      keybind: "alt+arrowdown",
      onSelect: () => input.session(1),
    },
    {
      id: "session.previous.unseen",
      title: input.t("command.session.previous.unseen"),
      category: input.category.session,
      keybind: "shift+alt+arrowup",
      onSelect: () => input.unseen(-1),
    },
    {
      id: "session.next.unseen",
      title: input.t("command.session.next.unseen"),
      category: input.category.session,
      keybind: "shift+alt+arrowdown",
      onSelect: () => input.unseen(1),
    },
  ]
}

// Mod+1-9 order: what the sidebar shows, top to bottom.
export function visibleSessionOrder<T>(groups: readonly { expanded: boolean; sessions: readonly T[] }[]): T[] {
  return groups.flatMap((group) => (group.expanded ? [...group.sessions] : []))
}
