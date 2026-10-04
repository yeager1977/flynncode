import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("./prompt-input-v2.tsx", import.meta.url), "utf8")

describe("PromptInputV2Composer project control", () => {
  test("resolves the project from the route directory and hides when absent", () => {
    expect(source).toContain("projectControl={")
    expect(source).toContain('"data-action": "prompt-project"')
    expect(source).toContain('language.t("session.project.open")')
    expect(source).toContain('language.plural("session.project.sessions"')
    expect(source).toContain('language.t("session.project.path")')
  })

  test("shows the project's total sessions only after the sessions query loads", () => {
    expect(source).toContain("sessionTotal")
    expect(source).toContain('queryOptions().sessions(pathKey(')
    expect(source).toContain("fetching() && store.sessionTotal === 0")
  })
})
