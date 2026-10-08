import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import os from "os"
import path from "path"
import { testEffect } from "../lib/effect"
import { HooksTrust } from "../../src/hooks/trust"

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
      const def = { event: "PreToolUse", matcher: "^Bash$", type: "command", command: "python3 hooks/check.py" }
      expect(yield* svc.isTrusted(def)).toBe(false)
      yield* svc.trust(def)
      expect(yield* svc.isTrusted(def)).toBe(true)
      yield* svc.revoke(svc.hashDef(def))
      expect(yield* svc.isTrusted(def)).toBe(false)
    }),
  )
})
