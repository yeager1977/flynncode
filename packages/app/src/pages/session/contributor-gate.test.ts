import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const local = readFileSync(new URL("../../context/local.tsx", import.meta.url), "utf8")
const selection = readFileSync(new URL("./composer/prompt-model-selection.tsx", import.meta.url), "utf8")
const helpers = readFileSync(new URL("./session-model-helpers.ts", import.meta.url), "utf8")

describe("contributor selection gate", () => {
  test("both ModelSelection.set implementations gate Contributor models", () => {
    for (const source of [local, selection]) {
      expect(source).toContain("isContributorModel")
      expect(source).toContain("DialogMetaContributor")
      expect(source).toContain("queueMicrotask")
    }
  })

  test("Cancel path applies no selection side effects", () => {
    expect(local).toContain("onCancel={() => {}}")
  })

  test("programmatic restores bypass the dialog", () => {
    expect(helpers).toContain("silent: true")
    expect(local).toContain("silent")
    expect(selection).toContain("silent")
  })
})
