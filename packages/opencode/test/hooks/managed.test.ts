import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import os from "os"
import path from "path"
import { testEffect } from "../lib/effect"
import { HooksManaged } from "../../src/hooks/managed"
import { HooksExecutor } from "../../src/hooks/executor"
import { HooksTrust } from "../../src/hooks/trust"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"

const dir = path.join(os.tmpdir(), `opencode-managed-${process.pid}`)
const trustPath = path.join(os.tmpdir(), `opencode-managed-trust-${process.pid}.json`)
const markerPath = path.join(dir, "marker.txt")
const managedScript = path.join(dir, "managed.sh")

const MANAGED_COMMAND = managedScript

beforeEach(async () => {
  process.env["OPENCODE_TEST_MANAGED_CONFIG_DIR"] = dir
  process.env["FLYNNCODE_HOOKS_TRUST_FILE"] = trustPath
  await Bun.write(trustPath, "[]")
  await Bun.write(
    path.join(dir, "opencode.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: MANAGED_COMMAND }] }] } }),
  )
  await Bun.write(managedScript, `#!/bin/sh\necho ran > "${markerPath}"\n`)
  await Bun.write(markerPath, "pristine")
  const { chmod } = await import("node:fs/promises")
  await chmod(managedScript, 0o755)
})

afterEach(async () => {
  delete process.env["OPENCODE_TEST_MANAGED_CONFIG_DIR"]
  await Bun.write(trustPath, "[]")
})

const it = testEffect(LayerNode.compile(HooksManaged.node))

const execIt = testEffect(
  LayerNode.compile(LayerNode.group([HooksExecutor.node, HooksManaged.node]), [
    [
      Config.node,
      Layer.succeed(Config.Service, {
        get: () =>
          Effect.succeed({
            hooks: { PreToolUse: [{ hooks: [{ type: "command", command: MANAGED_COMMAND }] }] },
          }),
      } as Partial<Config.Interface> as Config.Interface),
    ],
    [RuntimeFlags.node, RuntimeFlags.layer({})],
  ]),
)

describe("managed hooks policy", () => {
  it.effect("marks managed definitions trusted by policy", () =>
    Effect.gen(function* () {
      const policy = yield* HooksManaged.ManagedHooks
      const managed = HooksTrust.fromHandler("PreToolUse", undefined, { type: "command", command: MANAGED_COMMAND })
      expect(policy.isManaged(managed)).toBe(true)
      expect(policy.isManaged({ event: "PreToolUse", matcher: "", type: "command", command: "other.sh" })).toBe(false)
    }),
  )

  execIt.effect("managed hooks execute without per-definition trust", () =>
    Effect.gen(function* () {
      const executor = yield* HooksExecutor.Service
      const decision = yield* executor.runDecision({
        event: "PreToolUse",
        matchName: "Bash",
        tool: "Bash",
        sessionID: "ses_1",
        callID: "c1",
        args: { command: "ls" },
      })
      expect(decision.behavior).toBe("undecided")
      expect(yield* Effect.promise(() => Bun.file(markerPath).text())).toBe("ran\n")
    }),
  )
})
