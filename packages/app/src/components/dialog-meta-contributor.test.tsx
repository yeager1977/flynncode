import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("./dialog-meta-contributor.tsx", import.meta.url), "utf8")

describe("DialogMetaContributor", () => {
  test("renders the Meta warning copy from i18n keys", () => {
    expect(source).toContain("dialog.metaContributor.title")
    expect(source).toContain("dialog.metaContributor.description")
  })

  test("wires Continue and Cancel to caller callbacks", () => {
    expect(source).toContain("onContinue")
    expect(source).toContain("onCancel")
    expect(source).toContain("dialog.close()")
  })

  test("has no hardcoded user-visible English", () => {
    expect(source).not.toMatch(/>(Share|Continue|Cancel|Meta)[^<]*</)
  })
})
