import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const NAMES = ["alpha-service", "bravo-web", "charlie-api", "delta-tools", "echo-infra", "foxtrot-docs"]
const worktrees = NAMES.map((name) => `/opencode-demo/${name}`)

// The sixth project sits outside the five-item recent cap, so it is only reachable if the
// dialog hands every recent project to the list filter instead of a pre-truncated slice.
const OUTSIDE_CAP = "foxtrot-docs"

// Every row is scoped to the picker dialog, so the sidebar's own project sections (which list the same six
// projects) can never be counted as a picker row.
const picker = (page: Page) => page.getByRole("dialog", { name: "Open project", exact: true })
const rows = (page: Page) => picker(page).locator("[data-directory-path]")
const row = (page: Page, name: string) => picker(page).locator(`[data-directory-path*="${name}"]`)

async function openProjectDialog(page: Page) {
  await mockOpenCodeServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
    fileList: () => [],
    findFiles: () => [],
  })
  await page.addInitScript((dirs) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { local: dirs.map((worktree: string) => ({ worktree, expanded: false })) },
        lastProject: {},
      }),
    )
  }, worktrees)
  await page.goto("/")
  // There is no Home page in the current layout: the sidebar footer is the way into the picker.
  const open = page
    .getByRole("navigation", { name: "Projects and sessions" })
    .getByRole("button", { name: "Open project", exact: true })
  await expectAppVisible(open)
  await open.click()
  await expect(rows(page)).toHaveCount(5)
  return picker(page).getByRole("textbox", { name: "Search folders", exact: true })
}

test("searches every recent project, not just the five most recent", async ({ page }) => {
  const search = await openProjectDialog(page)
  await expect(row(page, OUTSIDE_CAP)).toHaveCount(0)

  await search.fill("foxtrot")

  await expect(row(page, OUTSIDE_CAP)).toHaveCount(1)
})

test("still caps the idle recent list at five projects", async ({ page }) => {
  await openProjectDialog(page)

  await expect(row(page, NAMES[4])).toHaveCount(1)
  await expect(row(page, OUTSIDE_CAP)).toHaveCount(0)
})
