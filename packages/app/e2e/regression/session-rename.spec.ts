import { base64Encode } from "@flynncode/core/util/encode"
import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { APP_READY_TIMEOUT, expectAppVisible } from "../utils/waits"

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Projects and sessions" })
const sessionLink = (page: Page, title: string) => sidebar(page).getByRole("link", { name: title, exact: true })
const sessionHeading = (page: Page, title: string) => page.getByRole("heading", { name: title, exact: true })
const sessionPath = (sessionID: string) => `/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`
const headingInput = (page: Page) => page.locator('input[data-slot="session-title-child"]')
const rowInput = (page: Page) => sidebar(page).getByRole("textbox", { name: "Rename", exact: true })

test.beforeEach(async ({ page }) => {
  const sessions = fixture.sessions.map((session) => ({ ...session }))
  // The server publishes session.updated after every successful PATCH. The sidebar list and the open session read
  // their titles from that event, so the mock delivers it on the next event-stream connection like the real server.
  const events: unknown[] = []
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
    events: () => events.splice(0),
  })
  await page.route(/\/session\/[^/]+(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback()
    const id = new URL(route.request().url()).pathname.split("/").at(-1)
    const session = sessions.find((item) => item.id === id)
    const payload: unknown = route.request().postDataJSON()
    if (
      !session ||
      !payload ||
      typeof payload !== "object" ||
      !("title" in payload) ||
      typeof payload.title !== "string"
    )
      throw new Error("Invalid rename request")
    session.title = payload.title
    events.push({
      directory: fixture.directory,
      payload: { type: "session.updated", properties: { sessionID: session.id, info: { ...session } } },
    })
    await route.fulfill({ json: session, headers: { "access-control-allow-origin": "*" } })
  })
  await page.addInitScript((directory) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
        lastProject: { local: directory },
      }),
    )
  }, fixture.directory)
  await page.goto("/")
  // "/" has no page of its own: the app settles on a draft session, and only then is a sidebar click not
  // overtaken by that redirect.
  await expect(page).toHaveURL(/\/new-session\?draftId=/, { timeout: APP_READY_TIMEOUT })
  const target = sessionLink(page, fixture.expected.targetTitle)
  await expectAppVisible(target)
  await target.click()
  await expect(page).toHaveURL(sessionPath(fixture.targetID))
  await expect(sessionHeading(page, fixture.expected.targetTitle)).toBeVisible()
})

for (const commit of ["Enter", "blur", "click outside"]) {
  test(`saves the session heading on ${commit}`, async ({ page }) => {
    await sessionHeading(page, fixture.expected.targetTitle).click()
    const input = headingInput(page)
    await expect(input).toBeFocused()
    await input.fill("Renamed session")
    if (commit === "Enter") await input.press("Enter")
    if (commit === "blur") await input.press("Tab")
    if (commit === "click outside") await page.getByRole("textbox", { name: "Prompt", exact: true }).click()
    await expect(sessionHeading(page, "Renamed session")).toBeVisible()
    await expect(sessionLink(page, "Renamed session")).toBeVisible()
    await expect(sessionLink(page, fixture.expected.targetTitle)).toHaveCount(0)
    await page.reload()
    await expectAppVisible(sessionHeading(page, "Renamed session"))
    await expect(sessionLink(page, "Renamed session")).toBeVisible()
  })
}

test("cancels the session heading with Escape", async ({ page }) => {
  await sessionHeading(page, fixture.expected.targetTitle).click()
  const input = headingInput(page)
  await expect(input).toBeFocused()
  await input.fill("Discard this title")
  await input.press("Escape")
  await expect(sessionHeading(page, fixture.expected.targetTitle)).toBeVisible()
  await expect(sessionLink(page, fixture.expected.targetTitle)).toBeVisible()
  await expect(sessionLink(page, "Discard this title")).toHaveCount(0)
  await page.reload()
  await expectAppVisible(sessionHeading(page, fixture.expected.targetTitle))
})

test("keeps the draft when saving the session heading fails", async ({ page }) => {
  await page.route(/\/session\/[^/]+(?:\?.*)?$/, (route) => {
    if (route.request().method() !== "PATCH") return route.fallback()
    return route.fulfill({ status: 500, headers: { "access-control-allow-origin": "*" } })
  })
  await sessionHeading(page, fixture.expected.targetTitle).click()
  const input = headingInput(page)
  await expect(input).toBeFocused()
  await input.fill("Retry this title")
  await input.press("Tab")
  await expect(page.getByText("Request failed", { exact: true })).toBeVisible()
  await expect(input).toBeEnabled()
  await expect(input).toHaveValue("Retry this title")
  await expect(sessionLink(page, fixture.expected.targetTitle)).toBeVisible()
  await expect(sessionLink(page, "Retry this title")).toHaveCount(0)
})

test("does not save an empty session heading", async ({ page }) => {
  await sessionHeading(page, fixture.expected.targetTitle).click()
  const input = headingInput(page)
  await expect(input).toBeFocused()
  await input.fill("   ")
  await input.press("Tab")
  await expect(sessionHeading(page, fixture.expected.targetTitle)).toBeVisible()
  await expect(sessionLink(page, fixture.expected.targetTitle)).toBeVisible()
  await page.reload()
  await expectAppVisible(sessionHeading(page, fixture.expected.targetTitle))
})

// The sidebar row's context menu is the successor of the retired titlebar tab menu: its Rename swaps the row link for
// an inline input. The row reads that state in JSX, so the rename state has to be reactive (session-sidebar-rename.ts).
test("renames the open session from its sidebar row context menu", async ({ page }) => {
  const row = sessionLink(page, fixture.expected.targetTitle)
  const rename = page.getByRole("menuitem", { name: "Rename", exact: true })
  await row.click({ button: "right" })
  await expect(rename).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(rename).toBeHidden()
  await expect(row).toBeFocused()
  await row.press("Shift+F10")
  await rename.click()
  const input = rowInput(page)
  await expect(input).toBeFocused()
  await input.fill("Renamed from row")
  await input.press("Enter")
  await expect(sessionHeading(page, "Renamed from row")).toBeVisible()
  await expect(sessionLink(page, "Renamed from row")).toBeVisible()
  await expect(sessionLink(page, fixture.expected.targetTitle)).toHaveCount(0)
  await expect(page).toHaveURL(sessionPath(fixture.targetID))
  await page.reload()
  await expectAppVisible(sessionHeading(page, "Renamed from row"))
  await expect(sessionLink(page, "Renamed from row")).toBeVisible()
})

test("renames an inactive session from its sidebar row without switching sessions", async ({ page }) => {
  await sessionLink(page, fixture.expected.sourceTitle).click()
  await expect(page).toHaveURL(sessionPath(fixture.sourceID))
  await expect(sessionHeading(page, fixture.expected.sourceTitle)).toBeVisible()
  await sessionLink(page, fixture.expected.targetTitle).click({ button: "right" })
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
  const input = rowInput(page)
  await expect(input).toBeFocused()
  await input.fill("Inactive session renamed")
  await input.press("Tab")
  await expect(sessionLink(page, "Inactive session renamed")).toBeVisible()
  await expect(sessionLink(page, fixture.expected.targetTitle)).toHaveCount(0)
  await expect(sessionHeading(page, fixture.expected.sourceTitle)).toBeVisible()
  await expect(page).toHaveURL(sessionPath(fixture.sourceID))
  await sessionLink(page, "Inactive session renamed").click()
  await expect(page).toHaveURL(sessionPath(fixture.targetID))
  await expect(sessionHeading(page, "Inactive session renamed")).toBeVisible()
  await page.reload()
  await expectAppVisible(sessionHeading(page, "Inactive session renamed"))
})
