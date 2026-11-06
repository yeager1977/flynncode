import { expect, test } from "@playwright/test"
import { base64Encode } from "@flynncode/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Flynncode/SidebarKeyboard"
const projectID = "proj_sidebar_keyboard"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

// The sidebar lists root sessions newest first. The child session sits between A and B by time, but the sidebar does
// not list it, so the shortcuts must step over it the way the list does.
const sessions = [
  session("ses_keyboard_a", "Keyboard A", 1_700_000_003_000),
  session("ses_keyboard_child", "Keyboard hidden child", 1_700_000_002_500, "ses_keyboard_a"),
  session("ses_keyboard_b", "Keyboard B", 1_700_000_002_000),
  session("ses_keyboard_c", "Keyboard C", 1_700_000_001_000),
]

test("session shortcuts follow the order the sidebar lists", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "sidebar-keyboard",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions,
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript((directory) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
        lastProject: { local: directory },
      }),
    )
  }, directory)

  await page.goto(href("ses_keyboard_a"))
  await expectSessionTitle(page, "Keyboard A")
  await expect(page.getByRole("navigation", { name: "Projects and sessions" }).getByRole("link")).toHaveText([
    "Keyboard A",
    "Keyboard B",
    "Keyboard C",
  ])

  await page.keyboard.press("Alt+ArrowDown")
  await expect(page).toHaveURL(href("ses_keyboard_b"))
  await expectSessionTitle(page, "Keyboard B")

  await page.keyboard.press("Alt+ArrowDown")
  await expect(page).toHaveURL(href("ses_keyboard_c"))
  await expectSessionTitle(page, "Keyboard C")

  await page.keyboard.press("Alt+ArrowUp")
  await expect(page).toHaveURL(href("ses_keyboard_b"))
  await expectSessionTitle(page, "Keyboard B")
})

function session(id: string, title: string, updated: number, parentID?: string) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    parentID,
    time: { created: updated, updated },
  }
}

function href(sessionID: string) {
  return `/server/${base64Encode(server)}/session/${sessionID}`
}
