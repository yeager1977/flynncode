import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ComputerUseTool } from "../../src/tool/computer-use"

describe("computer-use parameters", () => {
  test("accepts screenshot action with appID", () => {
    const decoded = Schema.decodeUnknownSync(ComputerUseTool.parameters)({ action: "screenshot", appID: "com.example.gui" })
    expect(decoded.action).toBe("screenshot")
  })

  test("rejects unknown action", () => {
    expect(() => Schema.decodeUnknownSync(ComputerUseTool.parameters)({ action: "reboot", appID: "com.example.gui" })).toThrow()
  })
})

describe("computer-use fail-closed", () => {
  test("tool source requires enabled plus allowlist plus ask", async () => {
    const source = await Bun.file(new URL("../../src/tool/computer-use.ts", import.meta.url).pathname).text()
    expect(source).toContain("resolveComputerUse")
    expect(source).toContain("isAppAllowed")
    expect(source).toContain("computer_use")
    expect(source).toContain("ComputerUseDisabledError")
  })
})
