import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigHooksV1 } from "@opencode-ai/core/v1/config/hooks"

test("decodes PreToolUse Bash group", () => {
  const decoded = Schema.decodeUnknownSync(ConfigHooksV1.Info)({
    PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "python3 hooks/check.py" }] }],
  })
  expect(decoded.PreToolUse?.length).toBe(1)
})
