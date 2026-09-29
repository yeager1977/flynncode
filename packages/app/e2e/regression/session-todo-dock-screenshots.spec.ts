import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"
import path from "node:path"

const PATH_TODO_CONTENT =
  "[WHERE] src/utils/validation.ts: Add validateEmail() for input sanitization - expect returns boolean"
const PATH_TODO_SUMMARY = "Add validateEmail() for input sanitization"
const PLAIN_TODO_CONTENT = "Keep the dock visible across tabs"
const COMPLETED_TODO_CONTENT = "Implement login form validation"
const CANCELLED_TODO_CONTENT = "Migrate legacy auth module"

const directory = "C:/OpenCode/TodoDockScreenshots"
const projectID = "proj_todo_dock_screenshots"
const sessionID = "ses_todo_dock_screenshots"
const sessionTitle = "Todo dock screenshots"

const activeTodos = [
  { id: "todo-path", content: PATH_TODO_CONTENT, status: "in_progress", priority: "high" },
  { id: "todo-plain", content: PLAIN_TODO_CONTENT, status: "pending", priority: "medium" },
  { id: "todo-done", content: COMPLETED_TODO_CONTENT, status: "completed", priority: "medium" },
  { id: "todo-skip", content: CANCELLED_TODO_CONTENT, status: "cancelled", priority: "low" },
]

const evidenceDir = path.resolve(
  "/home/yeager1977/GitHub/flynncode/.omo/evidence/task-agent-reliability/ui",
)

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" })

test("capture LTR desktop list state", async ({ page }) => {
  const events: { directory: string; payload: Record<string, unknown> }[] = []
  const todos: typeof activeTodos = []
  await setupMock(page, { events: () => events.splice(0, 1), todos: () => todos })
  await page.goto(sessionHref())
  await expectSessionTitle(page, sessionTitle)

  const dock = page.locator('[data-component="session-todo-dock"]')
  events.push(statusEvent("busy"))
  todos.push(...activeTodos)
  events.push(todoEvent(activeTodos))
  await expect(dock).toBeVisible()
  await expect(dock.locator('[data-action="session-todo-toggle-button"]')).toHaveAttribute("data-collapsed", "false")

  // Verify completed and cancelled status rows are visible and correctly styled
  await expect(dock.locator('[data-status="completed"]')).toBeVisible()
  await expect(dock.locator('[data-status="cancelled"]')).toBeVisible()

  await page.screenshot({ path: path.join(evidenceDir, "ltr-desktop-list.png"), fullPage: false })
})

test("capture LTR desktop detail-open state", async ({ page }) => {
  const events: { directory: string; payload: Record<string, unknown> }[] = []
  const todos: typeof activeTodos = []
  await setupMock(page, { events: () => events.splice(0, 1), todos: () => todos })
  await page.goto(sessionHref())
  await expectSessionTitle(page, sessionTitle)

  const dock = page.locator('[data-component="session-todo-dock"]')
  events.push(statusEvent("busy"))
  todos.push(...activeTodos)
  events.push(todoEvent(activeTodos))
  await expect(dock).toBeVisible()

  const detailToggle = dock.locator('[data-action="session-todo-detail-toggle"]')
  await expect(detailToggle).toBeVisible()
  await detailToggle.click()
  await expect(dock.getByText(PATH_TODO_CONTENT)).toBeVisible()

  await page.screenshot({ path: path.join(evidenceDir, "ltr-desktop-detail.png"), fullPage: false })
})

test("capture LTR desktop collapsed-preview state", async ({ page }) => {
  const events: { directory: string; payload: Record<string, unknown> }[] = []
  const todos: typeof activeTodos = []
  await setupMock(page, { events: () => events.splice(0, 1), todos: () => todos })
  await page.goto(sessionHref())
  await expectSessionTitle(page, sessionTitle)

  const dock = page.locator('[data-component="session-todo-dock"]')
  events.push(statusEvent("busy"))
  todos.push(...activeTodos)
  events.push(todoEvent(activeTodos))
  await expect(dock).toBeVisible()

  const headerChevron = dock.locator('[data-action="session-todo-toggle-button"]')
  await headerChevron.click()
  // Header indicates collapsed state: chevron attribute flips and its label switches to "Expand".
  await expect(headerChevron).toHaveAttribute("data-collapsed", "true")
  await expect(headerChevron).toHaveAttribute("aria-label", "Expand")
  await expect(dock.locator('[data-action="session-todo-toggle"]')).toBeVisible()
  await expect(dock.locator('[data-slot="session-todo-preview"]')).toBeVisible()
  // Wait for list to actually be hidden (spring animation settles into visibility: hidden)
  const todoList = dock.locator('[data-slot="session-todo-list"]')
  await expect(todoList).toBeHidden()

  await page.screenshot({ path: path.join(evidenceDir, "ltr-desktop-collapsed.png"), fullPage: false })
})

test("capture RTL desktop detail state", async ({ page }) => {
  const events: { directory: string; payload: Record<string, unknown> }[] = []
  const todos: typeof activeTodos = []
  await setupMock(page, { events: () => events.splice(0, 1), todos: () => todos, rtl: true })
  await page.goto(sessionHref())
  await expectSessionTitle(page, sessionTitle)

  const dock = page.locator('[data-component="session-todo-dock"]')
  events.push(statusEvent("busy"))
  todos.push(...activeTodos)
  events.push(todoEvent(activeTodos))
  await expect(dock).toBeVisible()

  const detailToggle = dock.locator('[data-action="session-todo-detail-toggle"]')
  await expect(detailToggle).toBeVisible()
  await detailToggle.click()
  await expect(dock.getByText(PATH_TODO_CONTENT)).toBeVisible()

  // LanguageProvider must have set RTL direction from the fa locale
  await expect.poll(() => page.evaluate(() => document.documentElement.dir)).toBe("rtl")

  await page.screenshot({ path: path.join(evidenceDir, "rtl-desktop-detail.png"), fullPage: false })
})

test("capture RTL mobile detail state", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  const events: { directory: string; payload: Record<string, unknown> }[] = []
  const todos: typeof activeTodos = []
  await setupMock(page, { events: () => events.splice(0, 1), todos: () => todos, rtl: true })
  await page.goto(sessionHref())
  await expectSessionTitle(page, sessionTitle)

  const dock = page.locator('[data-component="session-todo-dock"]')
  events.push(statusEvent("busy"))
  todos.push(...activeTodos)
  events.push(todoEvent(activeTodos))
  await expect(dock).toBeVisible()

  const detailToggle = dock.locator('[data-action="session-todo-detail-toggle"]')
  await expect(detailToggle).toBeVisible()
  await detailToggle.click()
  await expect(dock.getByText(PATH_TODO_CONTENT)).toBeVisible()

  // LanguageProvider must have set RTL direction from the fa locale
  await expect.poll(() => page.evaluate(() => document.documentElement.dir)).toBe("rtl")

  await page.screenshot({ path: path.join(evidenceDir, "rtl-mobile-detail.png"), fullPage: false })

  // Prove the second todo is reachable by scrolling the inner list.
  // The real scroll container is the nested max-h-42 overflow-y-auto div inside
  // [data-slot="session-todo-list"] (wrapper > div.relative > scroller); the wrapper itself never scrolls.
  const todoList = dock.locator('[data-slot="session-todo-list"]')
  const innerScroller = todoList.locator("div.max-h-42.overflow-y-auto")
  await innerScroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  // Assert scroll position moved (proves the list content overflowed its max height)
  const scrollTop = await innerScroller.evaluate((el) => el.scrollTop)
  expect(scrollTop).toBeGreaterThan(0)
  // toBeInViewport uses IntersectionObserver with the viewport as root, so unlike toBeVisible
  // it accounts for clipping by ancestor scroll containers.
  const secondTodo = todoList.getByRole("group", { name: PLAIN_TODO_CONTENT })
  await expect(secondTodo).toBeInViewport()

  // Capture the scrolled state
  await page.screenshot({ path: path.join(evidenceDir, "rtl-mobile-detail-scrolled.png"), fullPage: false })
})

async function setupMock(
  page: Page,
  overrides: {
    events?: () => unknown[]
    todos?: (sessionID: string) => unknown[]
    rtl?: boolean
  },
) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "todo-dock-screenshots",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
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
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID,
        directory,
        title: sessionTitle,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    sessionStatus: { [sessionID]: { type: "busy" } },
    pageMessages: () => ({ items: [] }),
    events: overrides.events,
    eventRetry: 16,
    todos: overrides.todos ?? (() => []),
  })
  await page.addInitScript(
    ({ directory, dirBase64, server, sessionID, rtl }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, shouldDisplayTabsToast: false } }))
      localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale: rtl ? "fa" : "en" }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64, sessionId: sessionID }]),
      )
    },
    {
      directory,
      dirBase64: base64Encode(directory),
      server: `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`,
      sessionID,
      rtl: overrides.rtl ?? false,
    },
  )
}

function sessionHref() {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  return `/server/${base64Encode(server)}/session/${sessionID}`
}

function statusEvent(type: "busy" | "idle") {
  return {
    directory,
    payload: { type: "session.status", properties: { sessionID, status: { type } } },
  }
}

function todoEvent(next: typeof activeTodos) {
  return {
    directory,
    payload: { type: "todo.updated", properties: { sessionID, todos: next } },
  }
}
