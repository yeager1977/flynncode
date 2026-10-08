import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

describe("computer-use consent panel", () => {
  test("session header exposes computer use as an icon menu, not an inline panel", async () => {
    const header = await readFile(
      path.join(import.meta.dir, "..", "..", "components", "session", "session-header.tsx"),
      "utf8",
    )
    const session = await readFile(path.join(import.meta.dir, "..", "session.tsx"), "utf8")
    expect(header).toContain("<ComputerUseMenu />")
    expect(session).not.toContain("ComputerUsePanel")
  })

  test("computer use menu toggles the config the server reads", async () => {
    const source = await readFile(
      path.join(import.meta.dir, "..", "..", "components", "session", "computer-use-menu.tsx"),
      "utf8",
    )
    expect(source).toContain("updateConfig({ computer_use: next })")
    // The desktop allowlist mirrors the config only after the server accepted it.
    expect(source.indexOf("updateConfig(")).toBeLessThan(source.indexOf("storeSet"))
    expect(source).toContain('language.t("computerUse.saveFailed")')
  })

  test("v2 header renders the menu with the neighbouring icon button style", async () => {
    const header = await readFile(
      path.join(import.meta.dir, "..", "..", "components", "session", "session-header.tsx"),
      "utf8",
    )
    const source = await readFile(
      path.join(import.meta.dir, "..", "..", "components", "session", "computer-use-menu.tsx"),
      "utf8",
    )
    expect(header).toContain('<ComputerUseMenu variant="v2" />')
    expect(source).toContain("triggerAs={IconButtonV2}")
    expect(source).toContain('variant: "ghost-muted"')
  })

  test("permission dock renders computer-use consent copy", async () => {
    const source = await readFile(path.join(import.meta.dir, "composer", "session-permission-dock.tsx"), "utf8")
    expect(source).toContain("computerUse.consent.title")
    // The footer already carries Deny / Allow once; the body must not repeat them.
    expect(source.match(/props\.onDecide\("once"\)/g)).toHaveLength(1)
    expect(source.match(/props\.onDecide\("reject"\)/g)).toHaveLength(1)
  })

  test("english dict carries computer-use keys", async () => {
    const source = await readFile(path.join(import.meta.dir, "..", "..", "i18n", "en.ts"), "utf8")
    expect(source).toContain("computerUse.enable")
    expect(source).toContain("computerUse.consent.note")
  })
})
