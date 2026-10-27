import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigHooksV1 } from "@flynncode/core/v1/config/hooks"
import { HooksConfig } from "../../src/hooks/config"

test("decodes PreToolUse Bash group", () => {
  const decoded = Schema.decodeUnknownSync(ConfigHooksV1.Info)({
    PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "python3 hooks/check.py" }] }],
  })
  expect(decoded.PreToolUse?.length).toBe(1)
})

test("empty matcher matches all, regex filters", () => {
  expect(HooksConfig.matchesMatcher("read", undefined)).toBe(true)
  expect(HooksConfig.matchesMatcher("read", "")).toBe(true)
  expect(HooksConfig.matchesMatcher("read", "*")).toBe(true)
  expect(HooksConfig.matchesMatcher("Bash", "^Bash$")).toBe(true)
  expect(HooksConfig.matchesMatcher("read", "^Bash$")).toBe(false)
})

test("invalid matcher never matches instead of throwing", () => {
  expect(HooksConfig.matchesMatcher("([invalid", "([invalid")).toBe(false)
})

test("whole-value placeholder preserves JSON type", () => {
  const out = HooksConfig.expandMcpInput({ count: "${tool_input.count}" }, { tool_input: { count: 3 } })
  expect(out).toEqual({ count: 3 })
})

test("decodes the disableAllHooks kill switch", () => {
  const decoded = Schema.decodeUnknownSync(ConfigHooksV1.Info)({ disableAllHooks: true })
  expect(decoded.disableAllHooks).toBe(true)
  expect(decoded.PreToolUse).toBeUndefined()
})

test("disableAllHooks fails safe across layer merges", () => {
  expect(HooksConfig.mergeHooksConfigs({}, { disableAllHooks: true }).disableAllHooks).toBe(true)
  expect(HooksConfig.mergeHooksConfigs({ disableAllHooks: true }, {}).disableAllHooks).toBe(true)
})
