import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

describe("computer-use consent panel", () => {
  test("session view wires explicit enable plus per-action consent", async () => {
    const source = await readFile(path.join(import.meta.dir, "..", "session.tsx"), "utf8")
    expect(source).toContain("computerUse.title")
    expect(source).toContain("computerUse.consent.allowOnce")
  })

  test("permission dock renders computer-use consent copy", async () => {
    const source = await readFile(path.join(import.meta.dir, "composer", "session-permission-dock.tsx"), "utf8")
    expect(source).toContain("computerUse.consent.title")
  })

  test("english dict carries computer-use keys", async () => {
    const source = await readFile(path.join(import.meta.dir, "..", "..", "i18n", "en.ts"), "utf8")
    expect(source).toContain("computerUse.enable")
    expect(source).toContain("computerUse.consent.note")
  })
})
