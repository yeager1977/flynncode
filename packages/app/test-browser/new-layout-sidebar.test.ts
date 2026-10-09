import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import {
  openSidebarByDefault,
  projectDraft,
  sidebarCommands,
  sidebarDirectory,
  type SidebarCommandInput,
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
  const directory = (route: Parameters<typeof sidebarDirectory>[0]["route"], homeDirectory?: string) =>
    sidebarDirectory({
      route,
      server: local,
      tabs,
      sessionDirectory: (id) => (id === "s1" ? "/repo/api" : undefined),
      homeDirectory,
    })

  test("follows the routed session or draft", () => {
    expect(directory({ type: "session", sessionId: "s1", server: local })).toBe("/repo/api")
    expect(directory({ type: "draft", draftID: "d1", server: local })).toBe("/repo/app")
    expect(directory({ type: "draft", draftID: "missing", server: local })).toBeUndefined()
  })

  test("ignores tabs from another server", () => {
    expect(directory({ type: "session", sessionId: "s1", server: remote })).toBeUndefined()
  })

  test("uses Home's selected project on Home", () => {
    expect(directory({ type: "home" }, "/repo/web")).toBe("/repo/web")
    expect(directory({ type: "home" })).toBeUndefined()
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
