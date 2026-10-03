import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/HeaderTerminalToggleRegression"
const projectID = "proj_header_terminal_toggle_regression"
const sessionID = "ses_header_terminal_toggle_regression"
const title = "Header terminal toggle regression"

test("v2 header terminal button toggles the terminal panel", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "header-terminal-toggle-regression",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { test: { id: "test", name: "Test", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "header-terminal-toggle-regression",
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/api/pty*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        location: { directory, project: { id: projectID, directory } },
        data: {
          id: "pty_header_terminal_toggle",
          title: "Terminal 1",
          command: "cmd.exe",
          args: [],
          cwd: directory,
          status: "running",
          pid: 1,
        },
      }),
    }),
  )
  await page.route("**/api/pty/pty_header_terminal_toggle*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        location: { directory, project: { id: projectID, directory } },
        data: {
          id: "pty_header_terminal_toggle",
          title: "Terminal 1",
          command: "cmd.exe",
          args: [],
          cwd: directory,
          status: "running",
          pid: 1,
        },
      }),
    }),
  )
  await page.route("**/api/pty/pty_header_terminal_toggle/connect-token*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        location: { directory, project: { id: projectID, directory } },
        data: { ticket: "e2e-ticket", expires_in: 60 },
      }),
    }),
  )
  await page.routeWebSocket("**/api/pty/pty_header_terminal_toggle/connect", () => undefined)

  const button = page.locator('[data-action="session-terminal-toggle"]')
  const panel = page.locator("#terminal-panel")

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  await expect(button).toBeVisible()
  await expect(button).toHaveAttribute("aria-expanded", "false")
  await expect(page.locator('[data-component="terminal"]')).toHaveCount(0)

  await button.click()
  await expect(button).toHaveAttribute("aria-expanded", "true")
  await expect(panel).toHaveAttribute("aria-hidden", "false")
  await expect(page.locator('[data-component="terminal"]')).toBeVisible()

  await button.click()
  await expect(button).toHaveAttribute("aria-expanded", "false")
  await expect(page.locator('[data-component="terminal"]')).toHaveCount(0)
})

function base64Encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}