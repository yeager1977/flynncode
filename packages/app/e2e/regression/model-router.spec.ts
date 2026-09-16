import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"

const server = `http://127.0.0.1:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
const directory = "/model-router-fixture"

async function openRouter(
  page: Page,
  options: { rtl?: boolean; locale?: string; modelName?: string; config?: Record<string, unknown> } = {},
) {
  const state = { config: {} as Record<string, unknown>, writes: [] as Record<string, unknown>[], fail: false }
  const providers = [
    {
      id: "ollama-local",
      name: "Local Ollama",
      models: { smart: { name: options.modelName ?? "Smart model" }, fast: { name: "Fast model" } },
    },
    { id: "cloud", name: "Cloud provider", models: { remote: { name: "Cloud model" } } },
  ]
  state.config.provider = Object.fromEntries(providers.map((provider) => [provider.id, { models: provider.models }]))
  if (options.config) state.config.model_router = options.config
  await mockOpenCodeServer(page, {
    directory,
    project: { id: "project-router", worktree: directory, vcs: "git", time: { created: 1, updated: 1 }, sandboxes: [] },
    sessions: [
      {
        id: "ses_router",
        projectID: "project-router",
        directory,
        title: "Router fixture",
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    provider: {
      all: providers.map((provider) => ({
        ...provider,
        models: Object.fromEntries(
          Object.entries(provider.models).map(([id, model]) => [
            id,
            {
              ...model,
              id,
              providerID: provider.id,
              family: id,
              release_date: "2026-01-01",
              limit: { context: 32000, output: 4096 },
            },
          ]),
        ),
      })),
      connected: providers.map((provider) => provider.id),
      default: { "ollama-local": "smart" },
    },
  })
  await page.route("**/global/config", async (route) => {
    if (route.request().method() === "PATCH") {
      if (state.fail)
        return route.fulfill({
          status: 500,
          json: { message: "Save failed" },
          headers: { "access-control-allow-origin": "*" },
        })
      const patch = route.request().postDataJSON() as Record<string, unknown>
      state.writes.push(patch)
      Object.assign(state.config, patch)
    }
    return route.fulfill({ json: state.config, headers: { "access-control-allow-origin": "*" } })
  })
  await page.route("**/pty/shells*", (route) =>
    route.fulfill({ json: [], headers: { "access-control-allow-origin": "*" } }),
  )
  await page.addInitScript((locale) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale }))
  }, options.locale ?? "en")
  await page.goto(`/server/${base64Encode(server)}/session/ses_router`)
  await expect(page.locator('[contenteditable="true"]')).toBeEditable()
  if (options.rtl) await page.getByRole("button", { name: "DIR: LTR", exact: true }).click()
  await page.keyboard.press("Control+,")
  const dialog = page.locator(".settings-v2-dialog")
  await dialog.locator('[role="tab"][data-value="model-router"]').click()
  const router = dialog.locator(".model-router")
  await expect(router.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  return { router, state }
}

test("bulk model selection, ratings and task choices save a usable router configuration", async ({
  page,
}, testInfo) => {
  const { router, state } = await openRouter(page)
  await router.getByRole("tab", { name: "Models", exact: true }).click()
  await router.getByRole("button", { name: "Add models", exact: true }).click()
  const picker = page.getByRole("dialog", { name: "Add models", exact: true })
  await picker.getByRole("checkbox", { name: "Smart model", exact: true }).check()
  await picker.getByRole("checkbox", { name: "Fast model", exact: true }).check()
  await picker.getByRole("button", { name: "Add selected", exact: true }).click()
  const smart = router.getByRole("article", { name: "Smart model", exact: true })
  await smart.getByRole("button", { name: "Edit scores", exact: true }).click()
  await smart.getByRole("slider", { name: "Smart model: Capability", exact: true }).fill("10")
  await smart.getByRole("button", { name: "Coding", exact: true }).click()
  await expect(smart.getByRole("button", { name: "Coding", exact: true })).toHaveAttribute("aria-pressed", "true")
  await page.screenshot({ path: testInfo.outputPath("models.png") })
  const fast = router.getByRole("article", { name: "Fast model", exact: true })
  await fast.getByRole("button", { name: "Edit scores", exact: true }).click()
  await fast.getByRole("slider", { name: "Fast model: Speed", exact: true }).fill("10")
  await router.getByRole("tab", { name: "Routing", exact: true }).click()
  const coding = router.getByRole("article", { name: "Coding", exact: true })
  await expect(coding.getByText("Smart model", { exact: true })).toBeVisible()
  await coding.getByRole("combobox", { name: "Priority for Coding", exact: true }).selectOption("speed")
  await expect(coding.getByText("Fast model", { exact: true })).toBeVisible()
  await expect(router.getByRole("article", { name: "Agent build", exact: true })).toContainText("Fast model")
  await page.screenshot({ path: testInfo.outputPath("routing.png") })
  await router.getByRole("button", { name: "Save", exact: true }).click()
  await expect(router.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  await expect.poll(() => state.writes.length).toBe(1)
  expect(state.writes[0].model_router).toMatchObject({
    models: {
      "ollama-local/smart": { capability: 10, price: 5, speed: 5, tags: ["coding"] },
      "ollama-local/fast": { capability: 5, price: 5, speed: 10 },
    },
  })
})

test("provider scope uses readable catalog names and controls the bulk picker", async ({ page }) => {
  const { router, state } = await openRouter(page)
  await router.getByRole("tab", { name: "Advanced", exact: true }).click()
  await router.getByRole("checkbox", { name: "Cloud provider", exact: true }).check()
  await router.getByRole("tab", { name: "Models", exact: true }).click()
  await router.getByRole("button", { name: "Add models", exact: true }).click()
  const picker = page.getByRole("dialog", { name: "Add models", exact: true })
  await expect(picker.getByRole("checkbox", { name: "Cloud model", exact: true })).toBeEnabled()
  await expect(picker.getByRole("checkbox", { name: "Smart model", exact: true })).toHaveCount(0)
  await picker.getByRole("checkbox", { name: "Cloud model", exact: true }).check()
  await picker.getByRole("button", { name: "Add selected", exact: true }).click()
  await router.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.writes.length).toBe(1)
  expect(state.writes[0].model_router).toMatchObject({ providers: ["cloud"] })
  await router.getByRole("tab", { name: "Advanced", exact: true }).click()
  await router.getByRole("button", { name: "Use automatic scope", exact: true }).click()
  await router.getByRole("tab", { name: "Models", exact: true }).click()
  await expect(router.getByRole("article", { name: "Cloud model", exact: true })).toContainText(
    "Outside your provider scope",
  )
  await router.getByRole("button", { name: "Add models", exact: true }).click()
  await expect(picker.getByRole("checkbox", { name: "Smart model", exact: true })).toBeEnabled()
})

test("failed saves preserve the draft and successful saves survive reopening", async ({ page }) => {
  const { router, state } = await openRouter(page)
  await router.getByRole("tab", { name: "Advanced", exact: true }).click()
  const fallback = router.getByRole("switch", { name: "Allow unscored models", exact: true })
  await fallback.focus()
  await fallback.press("Space")
  await expect(fallback).toBeChecked()
  state.fail = true
  await router.getByRole("button", { name: "Save", exact: true }).click()
  await expect(router.getByRole("alert")).toContainText("Your changes are still here")
  await expect(fallback).toBeChecked()
  await expect(router.getByRole("button", { name: "Save", exact: true })).toBeEnabled()
  await fallback.focus()
  await fallback.press("Space")
  await expect(router.getByRole("alert")).toHaveCount(0)
  await expect(router.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  await fallback.press("Space")
  state.fail = false
  await router.getByRole("button", { name: "Save", exact: true }).click()
  await expect(router.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  await expect.poll(() => state.writes.length).toBe(1)
  await page.reload()
  await expect(page.locator('[contenteditable="true"]')).toBeEditable()
  await page.keyboard.press("Control+,")
  await page.locator('.settings-v2-dialog [role="tab"][data-value="model-router"]').click()
  await router.getByRole("tab", { name: "Advanced", exact: true }).click()
  await expect(fallback).toBeChecked()
})

test("removing a model is reversible until saved and deletes it from the payload", async ({ page }) => {
  const { router, state } = await openRouter(page, {
    config: { models: { "ollama-local/smart": { capability: 9, price: 2, speed: 7 } } },
  })
  await router.getByRole("tab", { name: "Models", exact: true }).click()
  await router.getByRole("button", { name: "Remove Smart model", exact: true }).click()
  await expect(router.getByRole("article", { name: "Smart model", exact: true })).toHaveCount(0)
  await router.getByRole("button", { name: "Discard", exact: true }).click()
  await expect(router.getByRole("article", { name: "Smart model", exact: true })).toBeVisible()
  await router.getByRole("button", { name: "Remove Smart model", exact: true }).click()
  await router.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.writes.length).toBe(1)
  expect(state.writes[0].model_router).not.toHaveProperty("models")
})

for (const direction of ["ltr", "rtl"] as const) {
  test(`narrow ${direction} layout keeps controls in bounds and supports keyboard tabs`, async ({ page }, testInfo) => {
    const { router } = await openRouter(page, { rtl: direction === "rtl" })
    await page.setViewportSize({ width: 520, height: 780 })
    await expect(page.locator("html")).toHaveAttribute("dir", direction)
    const routing = router.getByRole("tab", { name: "Routing", exact: true })
    await routing.focus()
    await routing.press(direction === "ltr" ? "ArrowRight" : "ArrowLeft")
    await expect(router.getByRole("tab", { name: "Models", exact: true })).toHaveAttribute("aria-selected", "true")
    await expect(router.getByRole("button", { name: "Add models", exact: true })).toBeEnabled()
    await router.getByRole("button", { name: "Add models", exact: true }).click()
    const picker = page.getByRole("dialog", { name: "Add models", exact: true })
    await picker.getByRole("checkbox", { name: "Smart model", exact: true }).check()
    await picker.getByRole("button", { name: "Add selected", exact: true }).click()
    const smart = router.getByRole("article", { name: "Smart model", exact: true })
    await smart.getByRole("button", { name: "Edit scores", exact: true }).click()
    await expect(smart.getByRole("slider", { name: "Smart model: Capability", exact: true })).toBeEnabled()
    await expect.poll(() => router.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await expect
      .poll(() =>
        router.locator(".model-router-body").evaluate((element) => element.scrollWidth <= element.clientWidth),
      )
      .toBe(true)
    await expect(router.getByRole("button", { name: "Save", exact: true })).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath(`narrow-${direction}.png`) })
  })
}

test("Arabic locale preserves mixed-script names and LTR model identifiers", async ({ page }, testInfo) => {
  const name = "نموذج Qwen 3 — مراجعة"
  const { router } = await openRouter(page, { locale: "ar", modelName: name })
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl")
  await expect(page.locator("html")).toHaveAttribute("lang", /^ar/)
  await router.getByRole("tab", { name: "Models", exact: true }).click()
  await router.getByRole("button", { name: "Add models", exact: true }).click()
  const picker = page.getByRole("dialog", { name: "Add models", exact: true })
  await picker.getByRole("checkbox", { name, exact: true }).check()
  await picker.getByRole("button", { name: "Add selected", exact: true }).click()
  const model = router.getByRole("article", { name, exact: true })
  await model.getByRole("button", { name: "Edit scores", exact: true }).click()
  await expect(model.locator("code")).toHaveAttribute("dir", "ltr")
  await expect(model.locator("code")).toHaveText("ollama-local/smart")
  await page.screenshot({ path: testInfo.outputPath("arabic-models.png") })
})

test("invalid weights remain editable across tabs and can be discarded", async ({ page }) => {
  const { router, state } = await openRouter(page)
  await router.getByRole("tab", { name: "Advanced", exact: true }).click()
  const weight = router.getByRole("textbox", { name: "Coding: Capability", exact: true })
  await weight.fill("-")
  await expect(weight).toHaveAttribute("aria-invalid", "true")
  await expect(router.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  await router.getByRole("tab", { name: "Models", exact: true }).click()
  await router.getByRole("tab", { name: "Advanced", exact: true }).click()
  await expect(weight).toHaveValue("-")
  await router.getByRole("button", { name: "Discard", exact: true }).click()
  await expect(weight).toHaveValue("0.6")
  await expect(weight).not.toHaveAttribute("aria-invalid", "true")
  expect(state.writes).toEqual([])
})

for (const action of ["discard", "undo"] as const) {
  test(`external config refresh preserves a draft and is adopted after ${action}`, async ({ page }) => {
    const transport = await installSseTransport(page, { server })
    const { router, state } = await openRouter(page)
    await router.getByRole("tab", { name: "Advanced", exact: true }).click()
    const weight = router.getByRole("textbox", { name: "Coding: Capability", exact: true })
    await weight.fill("0.8")
    state.config.model_router = { taskWeights: { coding: { capability: 0.2, price: 0.3, speed: 0.5 } } }
    state.config.provider = {
      ...(state.config.provider as Record<string, unknown>),
      "ollama-external": { name: "External provider", models: {} },
    }
    await transport.waitForConnection()
    await transport.send({
      directory: "global",
      payload: { id: "evt_router_config", type: "config.updated", properties: {} },
    })
    // This control proves the refreshed config has reached the actual editor.
    await expect(router.getByRole("checkbox", { name: "External provider", exact: true })).toBeEnabled()
    await expect(weight).toHaveValue("0.8")
    if (action === "discard") await router.getByRole("button", { name: "Discard", exact: true }).click()
    if (action === "undo") await weight.fill("0.6")
    await expect(weight).toHaveValue("0.2")
    await expect(router.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
    expect(state.writes).toEqual([])
  })
}
