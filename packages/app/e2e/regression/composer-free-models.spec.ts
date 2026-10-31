import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@flynncode/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

// OpenCode's free models stay on offer long after release, so they must be listed regardless of age
// (upstream anomalyco/opencode#60047) and apart from their paid twins (upstream #55712).
const directory = "/composer-free-models"
const projectID = "proj_composer_free_models"
const sessionID = "ses_composer_free_models"

const daysAgo = (value: number) => new Date(Date.now() - value * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

type FixtureModel = {
  id: string
  name: string
  family: string
  release_date: string
  cost: { input: number; output: number }
}

async function openModelPicker(page: Page, models: FixtureModel[]) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "composer-free-models",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "Flynncode",
          models: Object.fromEntries(
            models.map((model) => [
              model.id,
              { ...model, providerID: "opencode", limit: { context: 32_000 } },
            ]),
          ),
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "new-paid" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "composer-free-models",
        projectID,
        directory,
        title: "Composer free models",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
        model: { providerID: "opencode", modelID: "new-paid" },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-component="prompt-input-v2"]')
  await expectAppVisible(composer)
  await composer.locator('[data-action="prompt-model"]').click()
}

test("lists OpenCode's free models in the model picker however old they are", async ({ page }) => {
  await openModelPicker(page, [
    { id: "new-paid", name: "New Paid", family: "grok", release_date: daysAgo(7), cost: { input: 1, output: 1 } },
    { id: "old-paid", name: "Old Paid", family: "grok", release_date: daysAgo(365), cost: { input: 1, output: 1 } },
    { id: "big-pickle", name: "Big Pickle", family: "pickle", release_date: daysAgo(365), cost: { input: 0, output: 0 } },
  ])

  await expect(page.locator('[data-option-key="opencode:new-paid"]')).toBeVisible()
  await expect(page.locator('[data-option-key="opencode:big-pickle"]')).toBeVisible()
  await expect(page.locator('[data-option-key="opencode:old-paid"]')).toHaveCount(0)
})

test("lists an old free model alongside a newer free model of the same family", async ({ page }) => {
  await openModelPicker(page, [
    { id: "grok-code", name: "Grok Code", family: "grok", release_date: daysAgo(30), cost: { input: 0, output: 0 } },
    { id: "big-pickle", name: "Big Pickle", family: "grok", release_date: daysAgo(365), cost: { input: 0, output: 0 } },
    { id: "old-paid", name: "Old Paid", family: "grok", release_date: daysAgo(365), cost: { input: 1, output: 1 } },
  ])

  await expect(page.locator('[data-option-key="opencode:grok-code"]')).toBeVisible()
  await expect(page.locator('[data-option-key="opencode:big-pickle"]')).toBeVisible()
  await expect(page.locator('[data-option-key="opencode:old-paid"]')).toHaveCount(0)
})