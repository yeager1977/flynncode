import { base64Encode } from "@flynncode/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Flynncode/TodoDockNavigation"
const projectID = "proj_todo_dock_navigation"
const sourceID = "ses_todo_dock_source"
const otherID = "ses_todo_dock_other"
const sourceTitle = "Todo dock animation"
const otherTitle = "Separate session"

const activeTodos = [
  { id: "todo-1", content: "Receive todos in the active session", status: "completed", priority: "high" },
  { id: "todo-2", content: "Keep the dock visible across tabs", status: "completed", priority: "high" },
  { id: "todo-3", content: "Close after the final todo", status: "in_progress", priority: "high" },
]

type EventPayload = {
  directory: string
  payload: Record<string, unknown>
}

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" })

test("animates todo lifecycle without replaying it across sessions", async ({ page }) => {
  test.setTimeout(90_000)
  const events: EventPayload[] = []
  const todos: Record<string, typeof activeTodos> = { [sourceID]: [], [otherID]: [] }
  const sessionStatus: Record<string, { type: "busy" | "idle" }> = {}

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "todo-dock-navigation",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "Flynncode",
          models: {
            "claude-opus-4-6": {
              id: "claude-opus-4-6",
              name: "Claude Opus 4.6",
              limit: { context: 200_000 },
            },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(sourceID, sourceTitle, 1700000000000), session(otherID, otherTitle, 1700000001000)],
    pageMessages: () => ({ items: [] }),
    events: () => events.splice(0, 1),
    eventRetry: 16,
    sessionStatus: () => sessionStatus,
    todos: (sessionID) => todos[sessionID] ?? [],
  })
  await configurePage(page)

  await page.goto(sessionHref(sourceID))
  await expectSessionTitle(page, sourceTitle)
  const dock = page.locator('[data-component="session-todo-dock"]')
  await expect(dock).toHaveCount(0)

  sessionStatus[sourceID] = { type: "busy" }
  events.push(statusEvent(sourceID, "busy"))
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible()

  await page.waitForTimeout(700)
  const opening = sampleDock(page, 1_000)
  todos[sourceID] = activeTodos
  events.push(todoEvent(sourceID, activeTodos))
  await expect(dock).toBeVisible()
  await expect(dock.locator('[data-state="in_progress"]')).toHaveCount(1)
  expect((await opening).some((sample) => sample.opacity > 0.05 && sample.opacity < 0.95)).toBe(true)

  await switchSession(page, otherID, otherTitle)
  await expect(dock).toHaveCount(0)

  const returningOpen = sampleDock(page, 700)
  await switchSession(page, sourceID, sourceTitle)
  const openSamples = (await returningOpen).filter((sample) => sample.present)
  expect(openSamples.length).toBeGreaterThan(0)
  // Returning must not replay the opening: from its first frame the dock is fully opaque and its header is never
  // clipped. The todo rows mount once the browser is idle, so the dock may start as its header alone, then settles open.
  expect(openSamples.filter((sample) => sample.opacity <= 0.98)).toEqual([])
  expect(openSamples.filter((sample) => sample.height < sample.header)).toEqual([])
  expect(openSamples.at(-1)!.height).toBeGreaterThan(70)
  await expect(dock.locator('[data-state="in_progress"]')).toHaveCount(1)

  const completedTodos = activeTodos.map((todo) => ({ ...todo, status: "completed" }))
  const closing = sampleDock(page, 1_000)
  todos[sourceID] = completedTodos
  events.push(todoEvent(sourceID, completedTodos))
  await expect(dock).toHaveCount(0)
  expect((await closing).some((sample) => sample.opacity > 0.05 && sample.opacity < 0.95)).toBe(true)
  todos[sourceID] = []
  events.push(todoEvent(sourceID, []))

  await switchSession(page, otherID, otherTitle)
  const returningEmpty = sampleDock(page, 700)
  await switchSession(page, sourceID, sourceTitle)
  await expect(dock).toHaveCount(0)
  expect((await returningEmpty).every((sample) => !sample.present)).toBe(true)
})

function session(id: string, title: string, created: number) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created, updated: created },
  }
}

function statusEvent(sessionID: string, type: "busy" | "idle"): EventPayload {
  return {
    directory,
    payload: { type: "session.status", properties: { sessionID, status: { type } } },
  }
}

function todoEvent(sessionID: string, next: typeof activeTodos): EventPayload {
  return {
    directory,
    payload: { type: "todo.updated", properties: { sessionID, todos: next } },
  }
}

async function configurePage(page: Page) {
  await page.addInitScript((directory) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    // The open project is what lists both sessions in the sidebar.
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
        lastProject: { local: directory },
      }),
    )
  }, directory)
}

function sessionHref(sessionID: string) {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  return `/server/${base64Encode(server)}/session/${sessionID}`
}

// Sessions have no tabs; the sidebar lists them and a click routes to one without reloading the app.
async function switchSession(page: Page, sessionID: string, title: string) {
  const link = page
    .getByRole("navigation", { name: "Projects and sessions" })
    .getByRole("link", { name: title, exact: true })
  await expect(link).toHaveAttribute("href", sessionHref(sessionID))
  await link.click()
  await expectSessionTitle(page, title)
}

function sampleDock(page: Page, duration: number) {
  return page.evaluate(async (duration) => {
    const samples: { present: boolean; height: number; header: number; opacity: number }[] = []
    const start = performance.now()
    while (performance.now() - start < duration) {
      const dock = document.querySelector<HTMLElement>('[data-component="session-todo-dock"]')
      const clip = dock?.parentElement?.parentElement
      const header = dock?.querySelector<HTMLElement>('[data-action="session-todo-toggle"]')
      const label = header?.querySelector<HTMLElement>("span[aria-label]")
      samples.push({
        present: !!dock,
        height: clip?.getBoundingClientRect().height ?? 0,
        header: header?.getBoundingClientRect().height ?? 0,
        opacity: label ? Number.parseFloat(getComputedStyle(label).opacity) : 0,
      })
      await new Promise(requestAnimationFrame)
    }
    return samples
  }, duration)
}
