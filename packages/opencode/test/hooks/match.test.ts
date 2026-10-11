import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigHooksV1 } from "@opencode-ai/core/v1/config/hooks"
import { HooksConfig } from "../../src/hooks/config"

test("decodes PreToolUse Bash group", () => {
  const decoded = Schema.decodeUnknownSync(ConfigHooksV1.Info)({
    PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "python3 hooks/check.py" }] }],
  })
  expect(decoded.PreToolUse?.length).toBe(1)
})

test("empty matcher matches all, regex filters", () => {
  const groups = [{ hooks: [] }, { matcher: "^Bash$", hooks: [] }]
  expect(HooksConfig.matchHooks("PreToolUse", undefined, groups).length).toBe(1)
  expect(HooksConfig.matchHooks("PreToolUse", "Bash", groups).length).toBe(2)
  expect(HooksConfig.matchHooks("PreToolUse", "read", groups).length).toBe(1)
})

test("invalid matcher never matches instead of throwing", () => {
  const groups = [{ matcher: "([invalid", hooks: [] }]
  expect(HooksConfig.matchHooks("PreToolUse", "([invalid", groups).length).toBe(0)
})

test("whole-value placeholder preserves JSON type", () => {
  const out = HooksConfig.expandMcpInput({ count: "${tool_input.count}" }, { tool_input: { count: 3 } })
  expect(out).toEqual({ count: 3 })
})

test("decodes the disableAllHooks kill switch", () => {
  const decoded = Schema.decodeUnknownSync(ConfigHooksV1.Info)({ disableAllHooks: true })
  expect(decoded.disableAllHooks).toBe(true)
  expect(HooksConfig.matchHooks("PreToolUse", "Bash", decoded.PreToolUse ?? []).length).toBe(0)
})

test("disableAllHooks fails safe across layer merges", () => {
  expect(HooksConfig.mergeHooksConfigs({}, { disableAllHooks: true }).disableAllHooks).toBe(true)
  expect(HooksConfig.mergeHooksConfigs({ disableAllHooks: true }, {}).disableAllHooks).toBe(true)
})
