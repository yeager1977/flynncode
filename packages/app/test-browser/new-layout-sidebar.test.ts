import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import {
  legacyDraftTarget,
  openProjectDirectory,
  openSidebarByDefault,
  projectDraft,
  sidebarCommands,
  sidebarDirectory,
  type SidebarCommandInput,
  worktreeClosing,
} from "@/pages/layout/new-layout-sidebar"
import type { ServerConnection } from "@/context/server"
import type { Tab } from "@/context/tabs"

// Needs the browser build of Solid so effects run:
// bun test --conditions=browser --preload ./happydom.ts ./test-browser/new-layout-sidebar.test.ts

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const local = "local" as ServerConnection.Key
const remote = "remote" as ServerConnection.Key

// The persisted layout store as the layout context exposes it.
function sidebarStore(initial: { opened: boolean; defaulted: boolean }) {
  const [store, setStore] = createStore({ sidebar: { ...initial } })
  const [ready, setReady] = createSignal(false)
  const dispose = createRoot((dispose) => {
    openSidebarByDefault({
      ready,
      defaulted: () => store.sidebar.defaulted,
      open: () => setStore("sidebar", { opened: true, defaulted: true }),
    })
    return dispose
  })
  return { store, setStore, setReady, dispose }
}

describe("openSidebarByDefault", () => {
  test("opens the sidebar once the persisted layout has loaded", async () => {
    const sidebar = sidebarStore({ opened: false, defaulted: false })
    await tick()
    expect(sidebar.store.sidebar.opened).toBe(false)

    sidebar.setReady(true)
    await tick()
    expect(sidebar.store.sidebar).toEqual({ opened: true, defaulted: true })
    sidebar.dispose()
  })

  test("keeps a later close", async () => {
    const sidebar = sidebarStore({ opened: false, defaulted: false })
    sidebar.setReady(true)
    await tick()
    sidebar.setStore("sidebar", "opened", false)
    await tick()
    expect(sidebar.store.sidebar.opened).toBe(false)
    sidebar.dispose()
  })

  test("leaves a closed sidebar closed on the next launch", async () => {
    const sidebar = sidebarStore({ opened: false, defaulted: true })
    sidebar.setReady(true)
    await tick()
    expect(sidebar.store.sidebar.opened).toBe(false)
    sidebar.dispose()
  })
})

describe("sidebarDirectory", () => {
  const tabs: Tab[] = [
    { type: "draft", draftID: "d1", server: local, directory: "/repo/app" },
    { type: "session", server: local, sessionId: "s1" },
  ]
  const directory = (route: Parameters<typeof sidebarDirectory>[0]["route"]) =>
    sidebarDirectory({
      route,
      server: local,
      tabs,
      sessionDirectory: (id) => (id === "s1" ? "/repo/api" : undefined),
    })

  test("follows the routed session or draft", () => {
    expect(directory({ type: "session", sessionId: "s1", server: local })).toBe("/repo/api")
    expect(directory({ type: "draft", draftID: "d1", server: local })).toBe("/repo/app")
    expect(directory({ type: "draft", draftID: "missing", server: local })).toBeUndefined()
  })

  test("ignores tabs from another server", () => {
    expect(directory({ type: "session", sessionId: "s1", server: remote })).toBeUndefined()
  })

  test("has no routed directory on Home", () => {
    expect(directory({ type: "home" })).toBeUndefined()
  })
})

describe("openProjectDirectory", () => {
  const projects = [{ worktree: "/repo/app", sandboxes: ["/repo/app-wt"] }, { worktree: "C:\\repo\\web" }]

  test("takes the first candidate inside an open project", () => {
    expect(openProjectDirectory([undefined, "/repo/app-wt/", "/repo/app"], projects)).toBe("/repo/app-wt/")
    expect(openProjectDirectory(["C:/repo/web"], projects)).toBe("C:/repo/web")
  })

  test("skips a closed project's directory", () => {
    expect(openProjectDirectory(["/repo/closed", "/repo/app"], projects)).toBe("/repo/app")
    expect(openProjectDirectory(["/repo/closed"], [])).toBeUndefined()
  })
})

describe("projectDraft", () => {
  const tabs: Tab[] = [
    { type: "draft", draftID: "old", server: local, directory: "/repo" },
    { type: "draft", draftID: "notes", server: local, directory: "/repo", kind: "knowledge" },
    { type: "draft", draftID: "new", server: local, directory: "/repo" },
    { type: "draft", draftID: "other", server: remote, directory: "/repo" },
  ]

  test("reuses the latest code draft for the project on this server", () => {
    expect(projectDraft(tabs, local, "/repo")?.draftID).toBe("new")
    expect(projectDraft(tabs, remote, "/repo")?.draftID).toBe("other")
    expect(projectDraft(tabs, local, "/elsewhere")).toBeUndefined()
  })

  test("matches the directory by path key", () => {
    expect(projectDraft(tabs, local, "/repo/")?.draftID).toBe("new")
  })
})

describe("legacyDraftTarget", () => {
  const projects = [{ worktree: "/repo" }]
  const target = (directory: string | undefined, tabs: Tab[] = [], prompt?: string) =>
    legacyDraftTarget({ directory, prompt, tabs, server: local, projects })

  test("sends a non-path segment Home", () => {
    expect(target(undefined)).toEqual({ type: "home" })
    expect(target("settings")).toEqual({ type: "home" })
  })

  test("opens a draft for an absolute path or an open project", () => {
    expect(target("/elsewhere")).toEqual({ type: "new", directory: "/elsewhere" })
    expect(target("C:\\work")).toEqual({ type: "new", directory: "C:\\work" })
  })

  test("reuses the draft a first visit opened, so Back does not open another", () => {
    const first = target("/repo")
    expect(first).toEqual({ type: "new", directory: "/repo" })
    const tabs: Tab[] = [{ type: "draft", draftID: "made", server: local, directory: "/repo" }]
    expect(target("/repo", tabs)).toEqual({ type: "select", draft: tabs[0] })
  })

  test("opens a fresh draft to deliver a prompt", () => {
    const tabs: Tab[] = [{ type: "draft", draftID: "made", server: local, directory: "/repo" }]
    expect(target("/repo", tabs, "fix it")).toEqual({ type: "new", directory: "/repo" })
  })
})

describe("worktreeClosing", () => {
  const tabs: Tab[] = [
    { type: "draft", draftID: "d-in", server: local, directory: "/repo/wt/" },
    { type: "draft", draftID: "d-out", server: local, directory: "/repo" },
    { type: "draft", draftID: "d-remote", server: remote, directory: "/repo/wt" },
  ]
  const directories: Record<string, string> = { in: "/repo/wt", out: "/repo" }
  const closing = (route: Parameters<typeof worktreeClosing>[0]["route"], drafts = true) =>
    worktreeClosing({
      tabs,
      server: local,
      directory: "/repo/wt",
      drafts,
      route,
      sessionDirectory: (id) => directories[id],
    })

  test("finds this server's drafts in the worktree", () => {
    expect(closing({ type: "home" })).toEqual({ drafts: ["d-in"], showing: false })
  })

  test("keeps the drafts when a reset keeps the worktree", () => {
    expect(closing({ type: "draft", draftID: "d-in", server: local }, false)).toEqual({ drafts: [], showing: false })
  })

  test("flags the routed session or draft inside the worktree", () => {
    expect(closing({ type: "session", sessionId: "in", server: local }).showing).toBe(true)
    expect(closing({ type: "draft", draftID: "d-in", server: local }).showing).toBe(true)
    expect(closing({ type: "session", sessionId: "out", server: local }).showing).toBe(false)
    expect(closing({ type: "session", sessionId: "in", server: remote }).showing).toBe(false)
    expect(closing({ type: "session", sessionId: "unknown", server: local }).showing).toBe(false)
  })
})

describe("sidebarCommands", () => {
  const setup = (count = 3) => {
    const calls: string[] = []
    const input: SidebarCommandInput = {
      t: (key, params) => (params ? `${key}:${params.index}` : key),
      category: { view: "View", project: "Project", session: "Session" },
      projectCount: () => count,
      toggle: () => calls.push("toggle"),
      project: (offset) => calls.push(`project:${offset}`),
      projectIndex: (index) => calls.push(`projectIndex:${index}`),
      session: (offset) => calls.push(`session:${offset}`),
      unseen: (offset) => calls.push(`unseen:${offset}`),
    }
    const commands = sidebarCommands(input)
    const find = (id: string) => commands.find((item) => item.id === id)
    return { calls, commands, find }
  }

  test("registers the desktop menu's sidebar commands", () => {
    const { find } = setup()
    for (const id of [
      "sidebar.toggle",
      "project.previous",
      "project.next",
      "session.previous",
      "session.next",
      "session.previous.unseen",
      "session.next.unseen",
    ]) {
      expect(find(id)).toBeDefined()
    }
  })

  test("routes each command to its handler", () => {
    const { calls, find } = setup()
    for (const id of [
      "sidebar.toggle",
      "project.previous",
      "project.next",
      "project.2",
      "session.previous",
      "session.next",
      "session.previous.unseen",
      "session.next.unseen",
    ]) {
      find(id)?.onSelect?.()
    }
    expect(calls).toEqual([
      "toggle",
      "project:-1",
      "project:1",
      "projectIndex:1",
      "session:-1",
      "session:1",
      "unseen:-1",
      "unseen:1",
    ])
  })

  test("keeps the classic keybinds that are free in the new layout", () => {
    const { find } = setup()
    expect(find("sidebar.toggle")?.keybind).toBe("mod+b")
    expect(find("project.previous")?.keybind).toBe("mod+alt+arrowup")
    expect(find("project.next")?.keybind).toBe("mod+alt+arrowdown")
    expect(find("session.previous")?.keybind).toBe("alt+arrowup")
    expect(find("session.next.unseen")?.keybind).toBe("shift+alt+arrowdown")
  })

  test("leaves mod+1-9 to the tab strip", () => {
    const { commands, find } = setup()
    expect(commands.some((item) => item.keybind && /^mod\+[1-9]$/.test(item.keybind))).toBe(false)
    expect(find("project.1")?.title).toBe("command.project.index:1")
    expect(find("project.1")?.hidden).toBeUndefined()
  })

  test("disables project shortcuts past the open projects", () => {
    const { find } = setup(2)
    expect(find("project.2")?.disabled).toBe(false)
    expect(find("project.3")?.disabled).toBe(true)
  })
})
