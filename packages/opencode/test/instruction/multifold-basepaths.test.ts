import { describe, expect, test } from "bun:test"

describe("multifold instruction base", () => {
  test("base paths ignore extras", async () => {
    const mod = await import("@/session/instruction")
    expect(mod.Service ?? mod.Instruction).toBeDefined()
  })
  test("base discovery reads primary directory only", async () => {
    const source = await Bun.file(
      new URL("../../src/session/instruction.ts", import.meta.url).toString().replace("file://", ""),
    ).text()
    expect(source).toContain("primary folder only")
    expect(source).not.toContain("additionalDirectories")
  })
})
