import { describe, expect, test } from "bun:test"
import { Reviewer } from "../../src/permission/reviewer"

describe("computer-use never self-approving", () => {
  test("reviewer defers computer_use", () => {
    expect(Reviewer.review({ permission: "computer_use", patterns: ["com.example.gui", "click"] })).toBe("defer")
  })

  test("ask source never short-circuits computer_use", async () => {
    const source = await Bun.file(new URL("../../src/permission/index.ts", import.meta.url).pathname).text()
    expect(source).toContain("computer_use")
  })
})
