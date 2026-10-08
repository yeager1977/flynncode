import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import os from "os"
import path from "path"
import { testEffect } from "../lib/effect"
import { HooksTrust } from "../../src/hooks/trust"
import { HooksConfig } from "../../src/hooks/config"

const it = testEffect(LayerNode.compile(HooksTrust.node))

const trustPath = path.join(os.tmpdir(), `opencode-hooks-trust-${process.pid}.json`)

beforeEach(async () => {
  process.env["FLYNNCODE_HOOKS_TRUST_FILE"] = trustPath
  const file = Bun.file(trustPath)
  if (await file.exists()) await Bun.write(trustPath, "[]")
})

afterEach(async () => {
  try {
    await Bun.write(trustPath, "[]")
  } catch {
    return
  }
})

describe("hooks trust", () => {
  it.effect("untrusted by default, trusted after trust, revoked after revoke", () =>
    Effect.gen(function* () {
      const svc = yield* HooksTrust.Service
      const def = { event: "PreToolUse", matcher: "^Bash$", type: "command", command: "python3 hooks/check.py" } as const
      expect(yield* svc.isTrusted(def)).toBe(false)
      yield* svc.trust(def)
      expect(yield* svc.isTrusted(def)).toBe(true)
      yield* svc.revoke(svc.hashDef(def))
      expect(yield* svc.isTrusted(def)).toBe(false)
    }),
  )

  it.effect("changed definition requires re-review", () =>
    Effect.gen(function* () {
      const svc = yield* HooksTrust.Service
      const before = { event: "PreToolUse", matcher: "^Bash$", type: "command", command: "python3 hooks/check.py" } as const
      const after = { event: "PreToolUse", matcher: "^Bash$", type: "command", command: "python3 hooks/check.py --strict" } as const
      yield* svc.trust(before)
      expect(yield* svc.isTrusted(before)).toBe(true)
      // Fail closed: edited command has a different hash and is untrusted.
      expect(yield* svc.isTrusted(after)).toBe(false)
      yield* svc.revoke(svc.hashDef(before))
    }),
  )
})

test("timeout edits re-trigger review", () => {
  const base = { event: "PreToolUse", matcher: "", type: "command", command: "check.sh" } as const
  expect(HooksTrust.hashDef({ ...base, timeout: 1000 })).not.toBe(HooksTrust.hashDef({ ...base, timeout: 2000 }))
  expect(HooksTrust.hashDef({ ...base })).not.toBe(HooksTrust.hashDef({ ...base, timeout: 1000 }))
})

test("type change changes the hash", () => {
  expect(
    HooksTrust.hashDef({ event: "PreToolUse", matcher: "", type: "command", command: "check.sh" }),
  ).not.toBe(
    HooksTrust.hashDef({ event: "PreToolUse", matcher: "", type: "mcp_tool", server: "s", tool: "t" }),
  )
})

test("mcp_tool input edits re-trigger review", () => {
  const base = { event: "PreToolUse", matcher: "", type: "mcp_tool", server: "s", tool: "t" } as const
  expect(HooksTrust.hashDef({ ...base, input: { a: 1 } })).not.toBe(HooksTrust.hashDef({ ...base, input: { a: 2 } }))
})

test("canonical form is key-order stable", () => {
  const left = { event: "PreToolUse", matcher: "", type: "command", command: "a", timeout: 5 } as const
  const right = { timeout: 5, command: "a", type: "command", matcher: "", event: "PreToolUse" } as const
  expect(HooksTrust.hashDef(left)).toBe(HooksTrust.hashDef(right))
})

test("fromHandler captures the full normative model", () => {
  const def = HooksTrust.fromHandler("PreToolUse", "^Bash$", {
    type: "command",
    command: "check.sh",
    timeout: 5000,
    async: true,
  })
  expect(def).toMatchObject({ event: "PreToolUse", matcher: "^Bash$", type: "command", timeout: 5000, async: true })
  const mcp = HooksTrust.fromHandler("PostToolUse", undefined, { type: "mcp_tool", server: "s", tool: "t" })
  expect(mcp).toMatchObject({ event: "PostToolUse", matcher: "", type: "mcp_tool", server: "s", tool: "t" })
})

test("project and global hooks merge without replacing", () => {
  const merged = HooksConfig.mergeHooksConfigs(
    { PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "global.py" }] }] },
    { PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "project.py" }] }] },
  )
  expect(merged.PreToolUse?.length).toBe(2)
})
