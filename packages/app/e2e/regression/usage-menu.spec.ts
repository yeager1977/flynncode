import { base64Encode } from "@flynncode/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer, type MockServerConfig } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/Flynncode/UsageMenuRegression"
const projectID = "proj_usage_menu_regression"
const sessionID = "ses_usage_menu_regression"
const title = "Usage menu regression"
const hour = 3_600_000

// Anthropic reports usage but is not connected, so the menu must still say it is not connected.
const providerUsage = () => ({
  openai: {
    windows: [
      { id: "session", percent: 42, resetsAt: Date.now() + 2 * hour },
      { id: "weekly", percent: 91, resetsAt: Date.now() + 72 * hour },
    ],
  },
  anthropic: { windows: [{ id: "session", percent: 7, resetsAt: Date.now() + hour }] },
  "ollama-cloud": {
    windows: [
      { id: "daily", count: 1_423 },
      { id: "monthly", count: 20_500 },
    ],
  },
})

const providers = {
  all: [
    { id: "openai", name: "OpenAI", models: { "gpt-5": { id: "gpt-5", name: "GPT-5", limit: { context: 400_000 } } } },
    {
      id: "anthropic",
      name: "Anthropic",
      models: { "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } } },
    },
    {
      id: "ollama-cloud",
      name: "Ollama Cloud",
      models: { "glm-5": { id: "glm-5", name: "GLM-5", limit: { context: 200_000 } } },
    },
  ],
  connected: ["openai", "ollama-cloud"],
  default: { providerID: "openai", modelID: "gpt-5" },
}

function userMessage(id: string, created: number) {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created },
      summary: { diffs: [] },
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5" },
    },
    parts: [{ id: `prt_${id}`, sessionID, messageID: id, type: "text", text: "Keep going." }],
  }
}

function assistantMessage(input: {
  id: string
  parentID: string
  created: number
  providerID: string
  modelID: string
  cost: number
  tokens: { input: number; output: number; reasoning: number; read: number }
}) {
  return {
    info: {
      id: input.id,
      sessionID,
      role: "assistant",
      time: { created: input.created, completed: input.created + 1_000 },
      parentID: input.parentID,
      providerID: input.providerID,
      modelID: input.modelID,
      mode: "build",
      agent: "build",
      path: { cwd: directory, root: directory },
      cost: input.cost,
      tokens: {
        input: input.tokens.input,
        output: input.tokens.output,
        reasoning: input.tokens.reasoning,
        cache: { read: input.tokens.read, write: 0 },
      },
    },
    parts: [
      { id: `prt_${input.id}`, sessionID, messageID: input.id, type: "text", text: `Answered with ${input.modelID}.` },
    ],
  }
}

// GLM-5 answers first; GPT-5 answers last, so GPT-5 is the model doing the work now. The newest GPT-5 turn holds
// 62,000 + 3,000 + 1,000 + 14,000 = 80,000 tokens of its 400,000-token window (20%).
function chatMessages(newestTokens = { input: 62_000, output: 3_000, reasoning: 1_000, read: 14_000 }) {
  return [
    userMessage("msg_1000_user", 1_700_000_000_000),
    assistantMessage({
      id: "msg_1001_assistant",
      parentID: "msg_1000_user",
      created: 1_700_000_001_000,
      providerID: "ollama-cloud",
      modelID: "glm-5",
      cost: 0.02,
      tokens: { input: 10_000, output: 800, reasoning: 0, read: 2_000 },
    }),
    userMessage("msg_1002_user", 1_700_000_010_000),
    assistantMessage({
      id: "msg_1003_assistant",
      parentID: "msg_1002_user",
      created: 1_700_000_011_000,
      providerID: "openai",
      modelID: "gpt-5",
      cost: 0.3,
      tokens: { input: 30_000, output: 2_000, reasoning: 1_000, read: 5_000 },
    }),
    userMessage("msg_1004_user", 1_700_000_020_000),
    assistantMessage({
      id: "msg_1005_assistant",
      parentID: "msg_1004_user",
      created: 1_700_000_021_000,
      providerID: "openai",
      modelID: "gpt-5",
      cost: 0.5,
      tokens: newestTokens,
    }),
  ]
}

async function openSession(page: Page, input: Partial<MockServerConfig> = {}) {
  const usageRequests: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/provider/usage") usageRequests.push(request.url())
  })
  await page.setViewportSize({ width: 1400, height: 900 })
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "usage-menu-regression",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: providers,
    providerUsage,
    sessions: [
      {
        id: sessionID,
        slug: "usage-menu-regression",
        projectID,
        directory,
        title,
        version: "dev",
        cost: 0.82,
        time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      },
    ],
    pageMessages: () => ({ items: chatMessages() }),
    ...input,
  })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  return {
    usageRequests,
    trigger: page.locator('[data-action="titlebar-usage"]'),
    menu: page.getByRole("dialog", { name: "Usage", exact: true }),
  }
}

test("the titlebar shows the current model's context fill and fetches usage only once opened", async ({ page }) => {
  const { usageRequests, trigger, menu } = await openSession(page)

  // The context window of the newest GPT-5 turn is visible without opening anything.
  await expect(trigger).toBeVisible()
  await expect(trigger).toContainText("Usage")
  await expect(trigger).toContainText("20%")
  await expect(trigger.getByText("20%")).not.toHaveClass(/text-v2-state-fg-danger/)
  expect(usageRequests).toEqual([])

  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/provider/usage")
  await trigger.click()
  await response
  await expect(menu).toBeVisible()
  expect(usageRequests).toHaveLength(1)

  const chat = menu.getByRole("region", { name: "This chat", exact: true })
  await expect(chat.getByText("GPT-5", { exact: true })).toBeVisible()
  await expect(chat.getByText("OpenAI", { exact: true })).toBeVisible()
  const context = chat.getByRole("progressbar", { name: "Context", exact: true })
  await expect(context).toHaveAttribute("aria-valuenow", "20")
  await expect(chat.getByText("80,000 of 400,000 tokens", { exact: true })).toBeVisible()
  // GPT-5 spent 38,000 + 80,000 tokens over its two turns; the chat cost is the session's, across both models.
  await expect(chat.getByRole("term")).toHaveText(["Tokens", "Cost"])
  await expect(chat.getByRole("definition")).toHaveText(["118,000", "$0.82"])
  const others = chat.getByRole("table")
  await expect(others.getByRole("columnheader", { name: "Other models in this chat" })).toBeVisible()
  await expect(others.getByRole("row", { name: /GLM-5 12,800 \$0\.02/ })).toBeVisible()

  const openai = menu.getByRole("region", { name: "OpenAI", exact: true })
  await expect(openai.getByRole("progressbar", { name: "Session", exact: true })).toHaveAttribute("aria-valuenow", "42")
  await expect(openai.getByRole("progressbar", { name: "Weekly", exact: true })).toHaveAttribute("aria-valuenow", "91")
  await expect(openai.getByText("42%", { exact: true })).not.toHaveClass(/text-v2-state-fg-danger/)
  await expect(openai.getByText("91%", { exact: true })).toHaveClass(/text-v2-state-fg-danger/)
  await expect(openai.getByText(/^Resets /)).toHaveCount(2)

  const anthropic = menu.getByRole("region", { name: "Anthropic", exact: true })
  await expect(anthropic.getByText("Not connected", { exact: true })).toBeVisible()
  await expect(anthropic.getByRole("progressbar")).toHaveCount(0)

  const ollama = menu.getByRole("region", { name: "Ollama.com", exact: true })
  await expect(ollama.getByText("Daily 1.4k requests", { exact: true })).toBeVisible()
  await expect(ollama.getByText("Monthly 20.5k requests", { exact: true })).toBeVisible()
  await expect(ollama.getByRole("progressbar")).toHaveCount(0)
})

test("refreshes on the 60 second clock only while open and never blanks the timeline", async ({ page }) => {
  await page.clock.install()
  const { usageRequests, trigger, menu } = await openSession(page)
  // A refresh that suspended the route would detach the virtual timeline from the document.
  await expect(page.locator("[data-timeline-virtual-content]")).toHaveCount(1)
  await watchTimelineDetach(page)

  await trigger.click()
  await expect(menu.getByRole("progressbar", { name: "Session", exact: true })).toBeVisible()
  expect(usageRequests).toHaveLength(1)

  // fastForward fires every timer that came due once, which is all a polling check needs.
  await page.clock.fastForward(61_000)
  await expect.poll(() => usageRequests.length).toBe(2)
  await expect(menu.getByRole("progressbar", { name: "Session", exact: true })).toBeVisible()

  // Closed, nothing polls: two more minutes pass without a request.
  await page.keyboard.press("Escape")
  await expect(menu).toBeHidden()
  await page.clock.fastForward(130_000)
  expect(usageRequests).toHaveLength(2)
  expect(await timelineDetachCount(page)).toBe(0)
})

test("no usage rings or header meters are rendered any more, and the Usage page link stays", async ({ page }) => {
  const { usageRequests } = await openSession(page)
  const sidebar = page.locator("#project-sidebar")

  // The footer rendered, so an empty result below is not just an unrendered sidebar.
  await expect(sidebar.locator('[data-action="sidebar-usage"]')).toBeVisible()
  await expect(sidebar.locator('[data-action="sidebar-cleanup"]')).toBeVisible()
  await expect(sidebar.getByRole("img", { name: /usage/i })).toHaveCount(0)
  // The header strip's circles read "<provider> 42% used" and "<provider> 5 requests used".
  await expect(page.getByRole("img", { name: /% used|requests used/i })).toHaveCount(0)
  expect(usageRequests).toEqual([])
})

test("refreshing from the menu requests usage again and View all opens the Usage page", async ({ page }) => {
  const { usageRequests, trigger, menu } = await openSession(page)

  await trigger.click()
  await expect(menu.getByRole("progressbar", { name: "Session", exact: true })).toBeVisible()
  expect(usageRequests).toHaveLength(1)

  const refreshed = page.waitForResponse((item) => new URL(item.url()).pathname === "/provider/usage")
  await menu.getByRole("button", { name: "Refresh usage", exact: true }).click()
  await refreshed
  expect(usageRequests).toHaveLength(2)

  await menu.getByRole("link", { name: "View all", exact: true }).click()
  await expect(page).toHaveURL(/\/usage$/)
  await expect(menu).toBeHidden()
  await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible()
  await expect(page.locator('[data-component="usage-provider-card"]').filter({ hasText: "OpenAI" })).toBeVisible()
})

test("the Usage page loads its own data from the sidebar and lists every connected provider's limits", async ({
  page,
}) => {
  const { usageRequests, menu } = await openSession(page)
  expect(usageRequests).toEqual([])

  await page.locator("#project-sidebar").locator('[data-action="sidebar-usage"]').click()
  await expect(page).toHaveURL(/\/usage$/)
  await expect(menu).toBeHidden()

  const card = (name: string) => page.locator('[data-component="usage-provider-card"]').filter({ hasText: name })
  await expect(card("OpenAI")).toContainText("Connected")
  await expect(card("OpenAI")).toContainText("Session 42%")
  await expect(card("OpenAI")).toContainText("Weekly 91%")
  await expect(card("Ollama Cloud")).toContainText("Daily 1.4k requests")
  await expect(card("Ollama Cloud")).toContainText("Monthly 20.5k requests")
  expect(usageRequests).toHaveLength(1)
})

test("shows a loading line until the first response and an error line when the request fails", async ({ page }) => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { trigger, menu } = await openSession(page, {
    providerUsage: async () => {
      await gate
      return providerUsage()
    },
  })

  await trigger.click()
  const openai = menu.getByRole("region", { name: "OpenAI", exact: true })
  await expect(openai.getByText("Loading...", { exact: true })).toBeVisible()
  await expect(menu.getByRole("region", { name: "Ollama.com", exact: true }).getByText("Loading...")).toBeVisible()
  // A provider that is not connected has nothing to load.
  await expect(menu.getByRole("region", { name: "Anthropic", exact: true }).getByText("Not connected")).toBeVisible()

  release()
  await expect(openai.getByRole("progressbar", { name: "Session", exact: true })).toHaveAttribute("aria-valuenow", "42")
  await expect(openai.getByText("Loading...")).toHaveCount(0)
})

test("says so when the usage request fails", async ({ page }) => {
  const { trigger, menu } = await openSession(page)
  await page.route("**/provider/usage", (route) =>
    route.fulfill({ status: 500, headers: { "access-control-allow-origin": "*" }, body: "{}" }),
  )

  await trigger.click()
  await expect(
    menu.getByRole("region", { name: "OpenAI", exact: true }).getByText("Could not load usage", { exact: true }),
  ).toBeVisible()
  await expect(
    menu.getByRole("region", { name: "Ollama.com", exact: true }).getByText("Could not load usage", { exact: true }),
  ).toBeVisible()
})

test("a connected provider without a reported limit says no account limit was reported", async ({ page }) => {
  const { trigger, menu } = await openSession(page, { providerUsage: { openai: { windows: [] } } })

  await trigger.click()
  await expect(
    menu.getByRole("region", { name: "OpenAI", exact: true }).getByText("No account limit reported", { exact: true }),
  ).toBeVisible()
  await expect(
    menu
      .getByRole("region", { name: "Ollama.com", exact: true })
      .getByText("No account limit reported", { exact: true }),
  ).toBeVisible()
})

test("the context percent turns danger at 90% and above", async ({ page }) => {
  // 320,000 + 20,000 + 10,000 + 10,000 = 360,000 of 400,000 tokens.
  const { trigger } = await openSession(page, {
    pageMessages: () => ({
      items: chatMessages({ input: 320_000, output: 20_000, reasoning: 10_000, read: 10_000 }),
    }),
  })

  await expect(trigger.getByText("90%", { exact: true })).toHaveClass(/text-v2-state-fg-danger/)
})

// An old chat can name a provider that is no longer connected. The connected list leaves it out, so its model name
// and context limit come from the full catalog the app loads on demand.
test("names the model and fills the context bar for a provider that is no longer connected", async ({ page }) => {
  const retired = {
    id: "retired-provider",
    name: "Retired Provider",
    models: { "retired-model": { id: "retired-model", name: "Retired Model", limit: { context: 100_000 } } },
  }
  const { trigger, menu } = await openSession(page, {
    providerCatalog: { ...providers, all: [...providers.all, retired] },
    pageMessages: () => ({
      items: [
        userMessage("msg_2000_user", 1_700_000_000_000),
        assistantMessage({
          id: "msg_2001_assistant",
          parentID: "msg_2000_user",
          created: 1_700_000_001_000,
          providerID: "retired-provider",
          modelID: "retired-model",
          cost: 0.04,
          tokens: { input: 20_000, output: 3_000, reasoning: 0, read: 2_000 },
        }),
      ],
    }),
  })

  // 20,000 + 3,000 + 2,000 = 25,000 of the 100,000-token window, known only once the catalog has loaded.
  await expect(trigger).toContainText("25%")
  await trigger.click()
  const chat = menu.getByRole("region", { name: "This chat", exact: true })
  await expect(chat.getByText("Retired Model", { exact: true })).toBeVisible()
  await expect(chat.getByText("Retired Provider", { exact: true })).toBeVisible()
  await expect(chat.getByRole("progressbar", { name: "Context", exact: true })).toHaveAttribute("aria-valuenow", "25")
  await expect(chat.getByText("25,000 of 100,000 tokens", { exact: true })).toBeVisible()
})

test("outside a session the menu shows the provider limits without a chat section", async ({ page }) => {
  await openSession(page)
  await page.goto("/")
  const trigger = page.locator('[data-action="titlebar-usage"]')
  const menu = page.getByRole("dialog", { name: "Usage", exact: true })

  await expect(trigger).toBeVisible()
  await expect(trigger).not.toContainText("%")
  await trigger.click()
  await expect(menu.getByRole("region", { name: "OpenAI", exact: true })).toBeVisible()
  await expect(menu.getByRole("region", { name: "This chat", exact: true })).toHaveCount(0)
})

test("fills the usage bars from the inline start in a right-to-left layout", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale: "ar" }))
  })
  const { trigger, menu } = await openSession(page)
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl")

  await trigger.click()
  const bar = menu.getByRole("region", { name: "OpenAI", exact: true }).getByRole("progressbar", { name: "Session" })
  await expect(bar).toHaveAttribute("aria-valuenow", "42")

  // The fill hugs the right edge of its track when the layout is right-to-left. The popover is still animating open
  // when the bar first appears, so the two boxes agree only once it settles; a fill anchored to the left would stay
  // hundreds of pixels away instead.
  const gap = async () => {
    const track = await bar.boundingBox()
    const fill = await bar.locator("> div").boundingBox()
    if (!track || !fill) return Number.POSITIVE_INFINITY
    return Math.abs(fill.x + fill.width - (track.x + track.width))
  }
  await expect.poll(gap).toBeLessThan(0.5)

  const track = await bar.boundingBox()
  const fill = await bar.locator("> div").boundingBox()
  if (!track || !fill) throw new Error("usage bar is not laid out")
  expect(fill.width).toBeGreaterThan(0)
  expect(fill.width).toBeLessThan(track.width)
})

async function watchTimelineDetach(page: Page) {
  await page.evaluate(() => {
    const target = window as typeof window & { __timelineDetached?: number }
    target.__timelineDetached = 0
    new MutationObserver((records) => {
      records.forEach((record) =>
        record.removedNodes.forEach((node) => {
          if (!(node instanceof Element)) return
          if (node.matches("[data-timeline-virtual-content]") || node.querySelector("[data-timeline-virtual-content]"))
            target.__timelineDetached = (target.__timelineDetached ?? 0) + 1
        }),
      )
    }).observe(document.body, { childList: true, subtree: true })
  })
}

function timelineDetachCount(page: Page) {
  return page.evaluate(() => (window as typeof window & { __timelineDetached?: number }).__timelineDetached ?? -1)
}
