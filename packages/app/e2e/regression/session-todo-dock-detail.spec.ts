import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

// Path-pattern todo: summary strips the path prefix and expect clause.
// Full content: "[WHERE] src/utils/validation.ts: Add validateEmail() for input sanitization - expect returns boolean"
// Summary:      "Add validateEmail() for input sanitization"
// Detail:       verbatim full string (detail !== summary → toggle shown)
const PATH_TODO_CONTENT =
  "[WHERE] src/utils/validation.ts: Add validateEmail() for input sanitization - expect returns boolean"
const PATH_TODO_SUMMARY = "Add validateEmail() for input sanitization"

// Plain todo: summary === detail → no toggle shown
const PLAIN_TODO_CONTENT = "Keep the dock visible across tabs"

const directory = "C:/OpenCode/TodoDockDetail"
const projectID = "proj_todo_dock_detail"
const sessionID = "ses_todo_dock_detail"
const sessionTitle = "Todo dock detail regression"

const activeTodos = [
  { id: "todo-path", content: PATH_TODO_CONTENT, status: "in_progress", priority: "high" },
  { id: "todo-plain", content: PLAIN_TODO_CONTENT, status: "pending", priority: "medium" },
]

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" })

test("summary/detail toggle: click opens detail without collapsing dock", async ({ page }) => {
  const events: { directory: string; payload: Record<string, unknown> }[] = []
  const todos: typeof activeTodos = []

  await setupMock(page, { events: () => events.splice(0, 1), todos: () => todos })
  await page.goto(sessionHref())
  await expectSessionTitle(page, sessionTitle)

  const dock = page.locator('[data-component="session-todo-dock"]')
  await expect(dock).toHaveCount(0)

  // Inject busy status + todos via SSE
  events.push(statusEvent("busy"))
  todos.push(...activeTodos)
  events.push(todoEvent(activeTodos))

  await expect(dock).toBeVisible()

  // Dock must be expanded (data-collapsed="false" on the header chevron button)
  const headerChevron = dock.locator('[data-action="session-todo-toggle-button"]')
  await expect(headerChevron).toHaveAttribute("data-collapsed", "false")

  // Kobalte Checkbox renders as role="group" with aria-label set to parts().summary.
  // This is the correct contract locator: the group name IS the summary text.
  const summaryGroup = dock.locator('[data-slot="session-todo-list"]').getByRole("group", { name: PATH_TODO_SUMMARY })
  await expect(summaryGroup).toBeVisible()
  // Full path-heavy content must not appear anywhere in the dock
  await expect(dock.getByText(PATH_TODO_CONTENT)).toHaveCount(0)

  // Detail toggle button is present for the path-pattern todo
  const detailToggle = dock.locator('[data-action="session-todo-detail-toggle"]')
  await expect(detailToggle).toHaveCount(1)

  // Plain todo has no detail toggle (summary === detail)
  // The single toggle belongs to the path-pattern todo only
  await expect(detailToggle).toHaveAttribute("aria-label", "Expand")

  // Click the detail toggle
  await detailToggle.click()

  // Dock must still be expanded after clicking the detail toggle
  await expect(headerChevron).toHaveAttribute("data-collapsed", "false")

  // Full verbatim content is now visible in the detail panel
  await expect(dock.getByText(PATH_TODO_CONTENT)).toBeVisible()
  // Expanded detail span must carry dir="auto" for correct bidi rendering of mixed-script content
  // (e.g. LTR file paths in a Persian RTL context)
  const detailSpan = dock.locator('span[dir="auto"]')
  await expect(detailSpan).toBeVisible()
  await expect(detailSpan).toHaveAttribute("dir", "auto")
  await expect(detailSpan).toContainText(PATH_TODO_CONTENT)

  // Toggle aria-label flips to Collapse
  await expect(detailToggle).toHaveAttribute("aria-label", "Collapse")

  // Click again to close detail
  await detailToggle.click()
  await expect(dock.getByText(PATH_TODO_CONTENT)).toHaveCount(0)
  await expect(detailToggle).toHaveAttribute("aria-label", "Expand")

  // Dock still expanded
  await expect(headerChevron).toHaveAttribute("data-collapsed", "false")
})

test("summary/detail toggle: keyboard Enter opens detail without collapsing dock", async ({ page }) => {
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
  await expect(headerChevron).toHaveAttribute("data-collapsed", "false")

  const detailToggle = dock.locator('[data-action="session-todo-detail-toggle"]')
  await expect(detailToggle).toBeVisible()

  // Focus and activate with Enter
  await detailToggle.focus()
  await page.keyboard.press("Enter")

  // Dock must still be expanded
  await expect(headerChevron).toHaveAttribute("data-collapsed", "false")

  // Detail content visible
  await expect(dock.getByText(PATH_TODO_CONTENT)).toBeVisible()

  // Close with Space
  await page.keyboard.press("Space")
  await expect(dock.getByText(PATH_TODO_CONTENT)).toHaveCount(0)

  // Dock still expanded
  await expect(headerChevron).toHaveAttribute("data-collapsed", "false")
})

test("collapsed preview shows concise summary not full path-heavy content", async ({ page }) => {
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

  // Collapse the dock via the header chevron
  const headerChevron = dock.locator('[data-action="session-todo-toggle-button"]')
  await expect(headerChevron).toHaveAttribute("data-collapsed", "false")
  await headerChevron.click()
  await expect(headerChevron).toHaveAttribute("data-collapsed", "true")

  // The preview slot shows the summary, not the full path-heavy string.
  // Scope to the preview slot to avoid matching the opacity-hidden list items still in DOM.
  const preview = dock.locator('[data-slot="session-todo-preview"]')
  await expect(preview).toBeVisible()
  await expect(preview.getByText(PATH_TODO_SUMMARY, { exact: false })).toBeVisible()
  await expect(preview.getByText(PATH_TODO_CONTENT, { exact: false })).toHaveCount(0)
})

// ── helpers ──────────────────────────────────────────────────────────────────

async function setupMock(
  page: Page,
  overrides: {
    events?: () => unknown[]
    todos?: (sessionID: string) => unknown[]
  },
) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "todo-dock-detail",
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
    ({ directory, dirBase64, server, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
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
