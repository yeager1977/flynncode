import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/TodoSessionIsolation"
const projectID = "proj_todo_session_isolation"
const sessionA = { id: "ses_todo_a", title: "Todo session A" }
const sessionB = { id: "ses_todo_b", title: "Todo session B" }
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const firstTodos = [
  { content: "A first task", status: "in_progress", priority: "high" },
  { content: "A stale task", status: "pending", priority: "medium" },
]
const secondTodos = [
  { content: "B first task", status: "in_progress", priority: "high" },
  { content: "B second task", status: "pending", priority: "medium" },
]

test("shrinking one session todo list leaves the other session unchanged", async ({ page }) => {
  const events = [
    statusEvent(sessionA.id),
    todoEvent(sessionA.id, firstTodos),
  ]
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "todo-session-isolation",
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
    sessions: [sessionA, sessionB].map((item) => ({
      id: item.id,
      slug: item.id,
      projectID,
      directory,
      title: item.title,
      version: "dev",
      time: { created: 1700000000000, updated: 1700000000000 },
    })),
    sessionStatus: { [sessionA.id]: { type: "busy" }, [sessionB.id]: { type: "busy" } },
    pageMessages: () => ({ items: [] }),
    events: () => events.splice(0),
    eventRetry: 16,
    todos: (sessionID) => (sessionID === sessionA.id ? firstTodos : secondTodos),
  })
  await page.addInitScript(
    ({ directory, dirBase64, sessionA, sessionB, server }) => {
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
        JSON.stringify([
          { type: "session", server, dirBase64, sessionId: sessionA },
          { type: "session", server, dirBase64, sessionId: sessionB },
        ]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sessionA: sessionA.id, sessionB: sessionB.id, server },
  )

  await page.goto(`/${base64Encode(server)}/session/${sessionA.id}`)
  await expectSessionTitle(page, sessionA.title)
  const dock = page.locator('[data-component="session-todo-dock"]')
  const list = dock.locator('[data-slot="session-todo-list"]')
  await expect(list).toContainText("A first task")
  await expect(list).toContainText("A stale task")

  events.push(todoEvent(sessionA.id, [{ content: "A replacement task", status: "in_progress", priority: "high" }]))
  await expect(list).toContainText("A replacement task")
  await expect(list).not.toContainText("A stale task")
  await expect(list.locator('[role="group"]')).toHaveCount(1)

  await page.getByRole("link", { name: sessionB.title, exact: true }).click()
  await expectSessionTitle(page, sessionB.title)
  await expect(list).toContainText("B first task")
  await expect(list).toContainText("B second task")
  await expect(list).not.toContainText("A replacement task")
  await expect(list.locator('[role="group"]')).toHaveCount(2)
})

function statusEvent(sessionID: string) {
  return {
    directory,
    payload: { type: "session.status", properties: { sessionID, status: { type: "busy" } } },
  }
}

function todoEvent(sessionID: string, todos: { content: string; status: string; priority: string }[]) {
  return { directory, payload: { type: "todo.updated", properties: { sessionID, todos } } }
}
