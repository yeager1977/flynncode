import { describe, expect, test } from "bun:test"
import { CleanupPage, LegacyHome, LegacyLayout, UsagePage } from "@/lazy-pages"

// The routes render these lazy wrappers, so each must load the same component the route used to import directly.
describe("lazy pages", () => {
  test("load the components their routes rendered before", async () => {
    const loaded = await Promise.all([
      LegacyLayout.preload(),
      LegacyHome.preload(),
      UsagePage.preload(),
      CleanupPage.preload(),
    ])
    const modules = await Promise.all([
      import("@/pages/layout"),
      import("@/pages/home/legacy-home"),
      import("@/pages/usage"),
      import("@/pages/cleanup"),
    ])

    const expected = [modules[0].default, modules[1].LegacyHome, modules[2].UsagePage, modules[3].CleanupPage]
    loaded.forEach((module, index) => expect(module.default).toBe(expected[index]))
  })
})
