import { base64Encode } from "@flynncode/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { currentSession, mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/TaskCard"
const projectID = "proj_task_card"
const parentID = "ses_task_parent"
const childID = "ses_task_child"
const childMsgID = "msg_child_0001"
const parentTitle = "Parent session"
const childTitle = "Child task"
const eventPayload = (() => {
  const events: { directory: string; payload: Record<string, unknown> }[] = []
  return events
})()

test.use({ viewport: { width: 1440, height: 900 } })

test.beforeEach(() => {
  eventPayload.length = 0
})

test("task output keeps its scroll position across streaming updates", async ({ page }) => {
  await setup(page)
  await page.goto(sessionHref(parentID))
  await expectSessionTitle(page, parentTitle)

  await page.getByRole("button", { name: "Tasks" }).click()
  const card = page.locator('[data-action="session-task-chip"]').filter({ hasText: childTitle })
  await expect(card).toBeVisible()
  await card.locator('button[aria-expanded="false"]').click()

  const output = card.locator('[data-slot="session-task-output"]')
  await expect(output).toBeVisible()
  await expect(output.getByText("Line 59")).toBeVisible()

  await output.hover()
  await page.mouse.wheel(0, 600)
  await expect
    .poll(() => output.evaluate((element) => element.scrollTop), { timeout: 10_000 })
    .toBeGreaterThan(200)

  const scrolledTop = await output.evaluate((element) => element.scrollTop)
  await recordEvent({
    type: "message.part.updated",
    properties: {
      part: { id: "prt_child_text_0061", sessionID: childID, messageID: childMsgID, type: "text", text: "Line 60 streamed" },
    },
  })
  await expect(output.getByText("Line 60 streamed")).toBeVisible()
  await expect
    .poll(() => output.evaluate((element) => element.scrollTop), { timeout: 10_000 })
    .toBe(scrolledTop)
})

test("expanded card actions share one consistently styled row", async ({ page }) => {
  await setup(page)
  await page.goto(sessionHref(parentID))
  await expectSessionTitle(page, parentTitle)

  await page.getByRole("button", { name: "Tasks" }).click()
  const card = page.locator('[data-action="session-task-chip"]').filter({ hasText: childTitle })
  await expect(card).toBeVisible()
  await card.locator('button[aria-expanded="false"]').click()

  const rename = card.getByRole("button", { name: "Rename" })
  const stop = card.locator('[data-action="subagent-stop"]')
  await expect(rename).toBeVisible()
  await expect(stop).toBeVisible()

  const renameBox = await rename.boundingBox()
  const stopBox = await stop.boundingBox()
  expect(renameBox).not.toBeNull()
  expect(stopBox).not.toBeNull()
  expect(Math.abs(renameBox!.y - stopBox!.y)).toBeLessThan(2)

  const steerSend = card.getByRole("button", { name: "Steer", exact: true })
  const steerInput = card.locator("input")
  await expect(steerSend).toBeVisible()
  const sendBox = await steerSend.boundingBox()
  const inputBox = await steerInput.boundingBox()
  expect(sendBox).not.toBeNull()
  expect(inputBox).not.toBeNull()
  expect(Math.abs(sendBox!.y - inputBox!.y)).toBeLessThan(2)
  expect(sendBox!.y).toBeGreaterThan(stopBox!.y)
})

function childSession() {
  return {
    id: childID,
    slug: childID,
    projectID,
    parentID,
    directory,
    title: childTitle,
    version: "dev",
    time: { created: 1700000001000, updated: 1700000001500 },
  }
}

function parentSession() {
  return {
    id: parentID,
    slug: parentID,
    projectID,
    directory,
    title: parentTitle,
    version: "dev",
    time: { created: 1700000000000, updated: 1700000001500 },
  }
}

function parentMessages() {
  const userID = "msg_user_0001"
  const assistantID = "msg_assistant_0001"
  return [
    {
      info: {
        id: userID,
        sessionID: parentID,
        role: "user",
        time: { created: 1700000000000 },
        agent: "build",
      },
      parts: [{ id: "prt_user_text_0001", sessionID: parentID, messageID: userID, type: "text", text: "Research the codebase" }],
    },
    {
      info: {
        id: assistantID,
        sessionID: parentID,
        role: "assistant",
        time: { created: 1700000001000, completed: 1700000002000 },
        parentID: userID,
        modelID: "claude-opus-4-6",
        providerID: "opencode",
        agent: "build",
        cost: 0,
        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: "prt_tool_task_0001",
          sessionID: parentID,
          messageID: assistantID,
          type: "tool",
          callID: "call_task_0001",
          tool: "task",
          state: {
            status: "running",
            input: { description: childTitle, subagent_type: "explore" },
            output: `<task id="${childID}" state="running">working</task>`,
            title: childTitle,
            metadata: { sessionId: childID },
            time: { start: 1700000001000 },
          },
        },
      ],
    },
  ]
}

function childMessages() {
  return [
    {
      info: {
        id: childMsgID,
        sessionID: childID,
        role: "assistant",
        time: { created: 1700000001100 },
        modelID: "claude-opus-4-6",
        providerID: "opencode",
        agent: "explore",
        cost: 0,
        tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: "prt_child_text_0001",
          sessionID: childID,
          messageID: childMsgID,
          type: "text",
          text: Array.from({ length: 60 }, (_, index) => `Line ${index + 1}`).join("\n"),
        },
      ],
    },
  ]
}

async function recordEvent(payload: Record<string, unknown>) {
  eventPayload.push({ directory, payload })
}

async function setup(page: Page) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "task-card",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [parentSession(), childSession()],
    pageMessages: (sessionID) => ({ items: sessionID === childID ? childMessages() : [] }),
    sessionStatus: { [childID]: { type: "busy" } },
    events: () => eventPayload,
    eventRetry: 16,
  })
  await configurePage(page)
}

async function configurePage(page: Page) {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  await page.addInitScript(
    ({ directory, server, sessionId }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem("opencode.window.browser.dat:tabs", JSON.stringify([{ type: "session", server, sessionId }]))
    },
    { directory, server, sessionId: parentID },
  )
}

function sessionHref(sessionID: string) {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  return `/server/${base64Encode(server)}/session/${sessionID}`
}