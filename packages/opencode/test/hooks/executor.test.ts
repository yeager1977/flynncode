import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import os from "os"
import path from "path"
import { testEffect } from "../lib/effect"
import { HooksExecutor, resolveTimeoutMs } from "../../src/hooks/executor"
import { HooksTrust } from "../../src/hooks/trust"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"

const dir = path.join(os.tmpdir(), `opencode-hooks-exec-${process.pid}`)
const trustPath = path.join(dir, "trust.json")
const capturePath = path.join(dir, "capture.json")
const markerPath = path.join(dir, "marker.txt")
const allowScript = path.join(dir, "allow.sh")
const captureScript = path.join(dir, "capture.sh")
const denyScript = path.join(dir, "deny2.sh")
const markScript = path.join(dir, "mark.sh")

beforeEach(async () => {
  process.env["FLYNNCODE_HOOKS_TRUST_FILE"] = trustPath
  await Bun.write(trustPath, "[]")
  await Bun.write(capturePath, "")
  await Bun.write(markerPath, "pristine")
  await Bun.write(allowScript, `#!/bin/sh\nprintf '{"behavior":"allow","updatedInput":{"command":"ls --safe"}}'\n`)
  await Bun.write(
    captureScript,
    `#!/bin/sh\ncat > "${capturePath}"\nprintf '{"behavior":"allow"}'\n`,
  )
  await Bun.write(denyScript, `#!/bin/sh\necho no-allow\nexit 2\n`)
  await Bun.write(markScript, `#!/bin/sh\necho ran > "${markerPath}"\n`)
  const { chmod } = await import("node:fs/promises")
  for (const script of [allowScript, captureScript, denyScript, markScript]) {
    await chmod(script, 0o755)
  }
})

afterEach(async () => {
  delete process.env["HOOK_CAPTURE"]
  await Bun.write(trustPath, "[]")
})

function trustDef(def: HooksTrust.HookDef) {
  return Bun.write(trustPath, JSON.stringify([{ hash: HooksTrust.hashDef(def), trustedAt: Date.now() }]))
}

function configLayer(hooks: Record<string, unknown>) {
  return Layer.succeed(
    Config.Service,
    { get: () => Effect.succeed({ hooks }) } as Partial<Config.Interface> as Config.Interface,
  )
}

function executorLayer(hooks: Record<string, unknown>, bypass = false) {
  return LayerNode.compile(HooksExecutor.node, [
    [Config.node, configLayer(hooks)],
    [RuntimeFlags.node, RuntimeFlags.layer({ bypassHookTrust: bypass })],
  ])
}

describe("hooks executor", () => {
  testEffect(executorLayer({ PreToolUse: [{ hooks: [{ type: "command", command: allowScript }] }] })).effect(
    "command hook fires and allow+rewrite propagates",
    () =>
      Effect.gen(function* () {
        const def = HooksTrust.fromHandler("PreToolUse", undefined, { type: "command", command: allowScript })
        yield* Effect.promise(() => trustDef(def))
        const executor = yield* HooksExecutor.Service
        const decision = yield* executor.runDecision({
          event: "PreToolUse",
          matchName: "Bash",
          tool: "Bash",
          sessionID: "ses_1",
          callID: "c1",
          args: { command: "ls" },
        })
        expect(decision).toEqual({ behavior: "allow", updatedInput: { command: "ls --safe" } })
      }),
  )

  testEffect(executorLayer({ PreToolUse: [{ hooks: [{ type: "command", command: captureScript }] }] })).effect(
    "command hook receives the event input on stdin",
    () =>
      Effect.gen(function* () {
        const def = HooksTrust.fromHandler("PreToolUse", undefined, { type: "command", command: captureScript })
        yield* Effect.promise(() => trustDef(def))
        const executor = yield* HooksExecutor.Service
        yield* executor.runDecision({
          event: "PreToolUse",
          matchName: "Bash",
          tool: "Bash",
          sessionID: "ses_1",
          callID: "c1",
          args: { command: "ls" },
        })
        const payload = JSON.parse(yield* Effect.promise(() => Bun.file(capturePath).text()))
        expect(payload.event).toBe("PreToolUse")
        expect(payload.tool).toBe("Bash")
        expect(payload.args).toEqual({ command: "ls" })
      }),
  )

  testEffect(executorLayer({ PreToolUse: [{ hooks: [{ type: "command", command: denyScript }] }] })).effect(
    "exit-2 deny propagates with stdout message",
    () =>
      Effect.gen(function* () {
        const def = HooksTrust.fromHandler("PreToolUse", undefined, { type: "command", command: denyScript })
        yield* Effect.promise(() => trustDef(def))
        const executor = yield* HooksExecutor.Service
        const decision = yield* executor.runDecision({
          event: "PreToolUse",
          matchName: "Bash",
          tool: "Bash",
          sessionID: "ses_1",
          callID: "c1",
          args: { command: "rm -rf /" },
        })
        expect(decision).toEqual({ behavior: "deny", message: "no-allow" })
      }),
  )

  testEffect(executorLayer({ PreToolUse: [{ hooks: [{ type: "command", command: "sleep 30", timeout: 0.05 }] }] })).effect(
    "timeout kills the spawn and denies fail-closed",
    () =>
      Effect.gen(function* () {
        const def = HooksTrust.fromHandler("PreToolUse", undefined, {
          type: "command",
          command: "sleep 30",
          timeout: 0.05,
        })
        yield* Effect.promise(() => trustDef(def))
        const executor = yield* HooksExecutor.Service
        const start = Date.now()
        const decision = yield* executor.runDecision({
          event: "PreToolUse",
          matchName: "Bash",
          tool: "Bash",
          sessionID: "ses_1",
          callID: "c1",
          args: { command: "sleep 30" },
        })
        expect(Date.now() - start).toBeLessThan(10_000)
        expect(decision.behavior).toBe("deny")
        if (decision.behavior === "deny") expect(decision.message).toContain("timed out")
      }),
  )

  testEffect(executorLayer({ PreToolUse: [{ hooks: [{ type: "command", command: markScript }] }] })).effect(
    "untrusted hooks are skipped and never spawned",
    () =>
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
        expect(decision).toEqual({ behavior: "undecided" })
        expect(yield* Effect.promise(() => Bun.file(markerPath).text())).toBe("pristine")
      }),
  )

  testEffect(executorLayer({ PreToolUse: [{ hooks: [{ type: "command", command: markScript }] }] }, true)).effect(
    "bypass flag runs untrusted hooks for one invocation",
    () =>
      Effect.gen(function* () {
        const executor = yield* HooksExecutor.Service
        yield* executor.runDecision({
          event: "PreToolUse",
          matchName: "Bash",
          tool: "Bash",
          sessionID: "ses_1",
          callID: "c1",
          args: { command: "ls" },
        })
        expect(yield* Effect.promise(() => Bun.file(markerPath).text())).toBe("ran\n")
      }),
  )

  testEffect(executorLayer({ PreToolUse: [{ hooks: [{ type: "mcp_tool", server: "ghost", tool: "check" }] }] })).effect(
    "mcp_tool hook without MCP fails closed to deny",
    () =>
      Effect.gen(function* () {
        const def = HooksTrust.fromHandler("PreToolUse", undefined, {
          type: "mcp_tool",
          server: "ghost",
          tool: "check",
        })
        yield* Effect.promise(() => trustDef(def))
        const executor = yield* HooksExecutor.Service
        const decision = yield* executor.runDecision({
          event: "PreToolUse",
          matchName: "Bash",
          tool: "Bash",
          sessionID: "ses_1",
          callID: "c1",
          args: { command: "ls" },
        })
        expect(decision.behavior).toBe("deny")
      }),
  )

  testEffect(
    executorLayer({ SessionStart: [{ hooks: [{ type: "command", command: "sleep 30", async: true, timeout: 0.05 }] }] }),
  ).effect("async hooks do not block the turn", () =>
    Effect.gen(function* () {
      const def = HooksTrust.fromHandler("SessionStart", undefined, {
        type: "command",
        command: "sleep 30",
        async: true,
        timeout: 0.05,
      })
      yield* Effect.promise(() => trustDef(def))
      const executor = yield* HooksExecutor.Service
      const start = Date.now()
      const out = yield* executor.runObserve({
        event: "SessionStart",
        matchName: "startup",
        sessionID: "ses_1",
        payload: { source: "startup" },
      })
      expect(Date.now() - start).toBeLessThan(10_000)
      expect(out.additionalContext).toBeUndefined()
      yield* executor.cancelSession("ses_1")
    }),
  )
})

describe("hooks executor timeouts", () => {
  test("defaults to 600s and caps SessionEnd at 3s", () => {
    expect(resolveTimeoutMs(undefined, 600_000)).toBe(600_000)
    expect(resolveTimeoutMs(5, 600_000)).toBe(5_000)
    expect(resolveTimeoutMs(undefined, 1_000, 3_000)).toBe(1_000)
    expect(resolveTimeoutMs(600, 1_000, 3_000)).toBe(3_000)
  })
})
