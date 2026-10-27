import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import os from "os"
import path from "path"
import { testEffect } from "../lib/effect"
import { HooksExecutor, resolveTimeoutMs } from "../../src/hooks/executor"
import { HooksTrust } from "../../src/hooks/trust"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID } from "@/session/schema"
import { SessionProjector } from "@flynncode/core/session/projector"
import type { SessionV1 } from "@flynncode/core/v1/session"
import { ClaudeTranscript } from "../../src/hooks/claude-transcript"

const dir = path.join(os.tmpdir(), `opencode-hooks-exec-${process.pid}`)
const trustPath = path.join(dir, "trust.json")
const capturePath = path.join(dir, "capture.json")
const markerPath = path.join(dir, "marker.txt")
const allowScript = path.join(dir, "allow.sh")
const captureScript = path.join(dir, "capture.sh")
const denyScript = path.join(dir, "deny2.sh")
const denyStderrScript = path.join(dir, "deny2-stderr.sh")
const markScript = path.join(dir, "mark.sh")
const observeTextScript = path.join(dir, "observe-text.sh")
const observeJsonScript = path.join(dir, "observe-json.sh")

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
  await Bun.write(denyStderrScript, `#!/bin/sh\necho "stdout says no"\necho "stderr reason" >&2\nexit 2\n`)
  await Bun.write(markScript, `#!/bin/sh\necho ran > "${markerPath}"\n`)
  await Bun.write(observeTextScript, `#!/bin/sh\nprintf 'Build docs live in ./docs'\n`)
  await Bun.write(
    observeJsonScript,
    `#!/bin/sh\nprintf '{"additionalContext":"from json","systemMessage":"sm"}'\n`,
  )
  const { chmod } = await import("node:fs/promises")
  for (const script of [allowScript, captureScript, denyScript, denyStderrScript, markScript, observeTextScript, observeJsonScript]) {
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

function configLayer(hooks: Record<string, unknown>, permission?: Record<string, unknown>) {
  return Layer.succeed(
    Config.Service,
    { get: () => Effect.succeed({ hooks, ...(permission && { permission }) }) } as Partial<Config.Interface> as Config.Interface,
  )
}

function executorLayer(hooks: Record<string, unknown>, bypass = false, permission?: Record<string, unknown>) {
  return LayerNode.compile(HooksExecutor.node, [
    [Config.node, configLayer(hooks, permission)],
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

  testEffect(executorLayer({ PreToolUse: [{ hooks: [{ type: "command", command: denyStderrScript }] }] })).effect(
    "exit-2 deny reason prefers stderr over stdout",
    () =>
      Effect.gen(function* () {
        const def = HooksTrust.fromHandler("PreToolUse", undefined, { type: "command", command: denyStderrScript })
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
        expect(decision).toEqual({ behavior: "deny", message: "stderr reason" })
      }),
  )

  testEffect(
    executorLayer({ SessionStart: [{ hooks: [{ type: "command", command: observeTextScript }] }] }),
  ).effect("observe events promote plain stdout to additionalContext", () =>
    Effect.gen(function* () {
      const def = HooksTrust.fromHandler("SessionStart", undefined, { type: "command", command: observeTextScript })
      yield* Effect.promise(() => trustDef(def))
      const executor = yield* HooksExecutor.Service
      const out = yield* executor.runObserve({
        event: "SessionStart",
        matchName: "startup",
        sessionID: "ses_1",
        payload: { source: "startup" },
      })
      expect(out.additionalContext).toBe("Build docs live in ./docs")
    }),
  )

  testEffect(
    executorLayer({
      SessionStart: [{ hooks: [{ type: "command", command: observeTextScript, additionalContextLimit: 5 }] }],
    }),
  ).effect("plain observe stdout respects additionalContextLimit", () =>
    Effect.gen(function* () {
      const def = HooksTrust.fromHandler("SessionStart", undefined, {
        type: "command",
        command: observeTextScript,
        additionalContextLimit: 5,
      })
      yield* Effect.promise(() => trustDef(def))
      const executor = yield* HooksExecutor.Service
      const out = yield* executor.runObserve({
        event: "SessionStart",
        matchName: "startup",
        sessionID: "ses_1",
        payload: { source: "startup" },
      })
      expect(out.additionalContext).toBe("Build")
    }),
  )

  testEffect(executorLayer({ SessionStart: [{ hooks: [{ type: "command", command: "true" }] }] })).effect(
    "empty observe stdout carries no additionalContext",
    () =>
      Effect.gen(function* () {
        const def = HooksTrust.fromHandler("SessionStart", undefined, { type: "command", command: "true" })
        yield* Effect.promise(() => trustDef(def))
        const executor = yield* HooksExecutor.Service
        const out = yield* executor.runObserve({
          event: "SessionStart",
          matchName: "startup",
          sessionID: "ses_1",
          payload: { source: "startup" },
        })
        expect(out).toEqual({})
      }),
  )

  testEffect(
    executorLayer({ SessionStart: [{ hooks: [{ type: "command", command: observeJsonScript }] }] }),
  ).effect("JSON observe output is still parsed as before", () =>
    Effect.gen(function* () {
      const def = HooksTrust.fromHandler("SessionStart", undefined, { type: "command", command: observeJsonScript })
      yield* Effect.promise(() => trustDef(def))
      const executor = yield* HooksExecutor.Service
      const out = yield* executor.runObserve({
        event: "SessionStart",
        matchName: "startup",
        sessionID: "ses_1",
        payload: { source: "startup" },
      })
      expect(out.additionalContext).toBe("from json")
      expect(out.systemMessage).toBe("sm")
    }),
  )

  const exitBlock = "echo 'tests are failing' >&2; exit 2"
  const denyBlock = `printf '%s' '${JSON.stringify({ behavior: "deny", message: "not this prompt" })}'`
  const blockingHooks = {
    Stop: [{ hooks: [{ type: "command", command: exitBlock }] }],
    SubagentStop: [{ hooks: [{ type: "command", command: exitBlock }, { type: "command", command: denyBlock }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: denyBlock }] }],
    SessionStart: [{ hooks: [{ type: "command", command: exitBlock }] }],
  }
  testEffect(executorLayer(blockingHooks, true)).effect(
    "native exit 2 and behavior deny block UserPromptSubmit, Stop and SubagentStop only",
    () =>
      Effect.gen(function* () {
        const executor = yield* HooksExecutor.Service
        const observe = (event: "Stop" | "SubagentStop" | "UserPromptSubmit" | "SessionStart") =>
          executor.runObserve({ event, matchName: "", sessionID: "ses_1", payload: {} })
        expect(yield* observe("Stop")).toEqual({ block: { reason: "tests are failing" } })
        // Every blocking hook's reason is kept.
        expect(yield* observe("SubagentStop")).toEqual({ block: { reason: "tests are failing\n\nnot this prompt" } })
        expect(yield* observe("UserPromptSubmit")).toEqual({ block: { reason: "not this prompt" } })
        expect(yield* observe("SessionStart")).toEqual({})
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

  testEffect(
    executorLayer(
      {
        PreToolUse: [
          {
            hooks: [
              { type: "http", url: "http://127.0.0.1:1/never" },
              { type: "prompt", prompt: "is this fine? $ARGUMENTS" },
              { type: "command", command: markScript },
            ],
          },
        ],
      },
      true,
    ),
  ).effect("http and prompt handlers are skipped without stopping the handlers after them", () =>
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
      expect(yield* Effect.promise(() => Bun.file(markerPath).text())).toBe("ran\n")
    }),
  )

  testEffect(
    executorLayer({ disableAllHooks: true, PreToolUse: [{ hooks: [{ type: "command", command: markScript }] }] }, true),
  ).effect(
    "kill switch disables trusted hooks and wins over the bypass flag",
    () =>
      Effect.gen(function* () {
        const def = HooksTrust.fromHandler("PreToolUse", undefined, { type: "command", command: markScript })
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
        // Skipped entirely: no spawn, no deny, default undecided.
        expect(decision).toEqual({ behavior: "undecided" })
        expect(yield* Effect.promise(() => Bun.file(markerPath).text())).toBe("pristine")
      }),
  )

  testEffect(executorLayer({ PreToolUse: [{ hooks: [{ type: "command", command: captureScript }] }] })).effect(
    "decision payload carries cwd, model, and permission_mode when available",
    () =>
      Effect.gen(function* () {
        const def = HooksTrust.fromHandler("PreToolUse", undefined, { type: "command", command: captureScript })
        yield* Effect.promise(() => trustDef(def))
        const executor = yield* HooksExecutor.Service
        const input = {
          event: "PreToolUse" as const,
          matchName: "Bash",
          tool: "Bash",
          sessionID: "ses_1",
          callID: "c1",
          args: { command: "ls" },
          model: "prov/claude-x",
          permissionMode: "auto",
        }
        yield* executor.runDecision(input)
        const payload = JSON.parse(yield* Effect.promise(() => Bun.file(capturePath).text()))
        expect(payload.cwd).toBe(process.cwd())
        expect(payload.model).toBe("prov/claude-x")
        expect(payload.permission_mode).toBe("auto")

        yield* Effect.promise(() => Bun.write(capturePath, ""))
        const { model: _model, permissionMode: _permissionMode, ...rest } = input
        yield* executor.runDecision(rest)
        const absent = JSON.parse(yield* Effect.promise(() => Bun.file(capturePath).text()))
        expect(absent.cwd).toBe(process.cwd())
        // Unknown values are omitted entirely, never set to null/undefined.
        expect("model" in absent).toBe(false)
        expect("permission_mode" in absent).toBe(false)
      }),
  )

  testEffect(executorLayer({ PostToolUse: [{ hooks: [{ type: "command", command: captureScript }] }] })).effect(
    "post payload carries cwd, model, and permission_mode when available",
    () =>
      Effect.gen(function* () {
        const def = HooksTrust.fromHandler("PostToolUse", undefined, { type: "command", command: captureScript })
        yield* Effect.promise(() => trustDef(def))
        const executor = yield* HooksExecutor.Service
        yield* executor.runPostTool({
          tool: "Bash",
          matchName: "Bash",
          sessionID: "ses_1",
          callID: "c1",
          args: { command: "ls" },
          output: "ok",
          model: "prov/claude-x",
          permissionMode: "accept-edits",
        })
        const payload = JSON.parse(yield* Effect.promise(() => Bun.file(capturePath).text()))
        expect(payload.event).toBe("PostToolUse")
        expect(payload.cwd).toBe(process.cwd())
        expect(payload.model).toBe("prov/claude-x")
        expect(payload.permission_mode).toBe("accept-edits")
      }),
  )

  testEffect(executorLayer({ SessionStart: [{ hooks: [{ type: "command", command: captureScript }] }] })).effect(
    "observe payload carries cwd",
    () =>
      Effect.gen(function* () {
        const def = HooksTrust.fromHandler("SessionStart", undefined, { type: "command", command: captureScript })
        yield* Effect.promise(() => trustDef(def))
        const executor = yield* HooksExecutor.Service
        const out = yield* executor.runObserve({
          event: "SessionStart",
          matchName: "startup",
          sessionID: "ses_1",
          payload: { source: "startup" },
        })
        expect(out).toEqual({})
        const payload = JSON.parse(yield* Effect.promise(() => Bun.file(capturePath).text()))
        expect(payload.event).toBe("SessionStart")
        expect(payload.cwd).toBe(process.cwd())
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

  testEffect(
    executorLayer(
      {
        SessionStart: [
          {
            hooks: Array.from({ length: 8 }, () => ({ type: "command", command: "sleep 5", async: true, timeout: 10 })),
          },
        ],
        PreToolUse: [{ hooks: [{ type: "command", command: "true" }] }],
      },
      true,
    ),
  ).effect("sync hooks never queue behind a session's async hooks", () =>
    Effect.gen(function* () {
      const executor = yield* HooksExecutor.Service
      yield* executor.runObserve({
        event: "SessionStart",
        matchName: "startup",
        sessionID: "ses_1",
        payload: { source: "startup" },
      })
      const start = Date.now()
      const decision = yield* executor.runDecision({
        event: "PreToolUse",
        matchName: "Bash",
        tool: "Bash",
        sessionID: "ses_1",
        callID: "c1",
        args: { command: "ls" },
      })
      expect(decision).toEqual({ behavior: "undecided" })
      expect(Date.now() - start).toBeLessThan(2_000)
      yield* executor.cancelSession("ses_1")
    }),
  )

  testEffect(executorLayer({ PreToolUse: [{ hooks: [{ type: "command", command: "true" }] }] })).effect(
    "empty hook output expresses no opinion",
    () =>
      Effect.gen(function* () {
        const def = HooksTrust.fromHandler("PreToolUse", undefined, { type: "command", command: "true" })
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
        expect(decision).toEqual({ behavior: "undecided" })
      }),
  )

  testEffect(executorLayer({ PreToolUse: [{ hooks: [{ type: "command", command: "echo 'not json'" }] }] })).effect(
    "non-empty garbage fails closed to deny",
    () =>
      Effect.gen(function* () {
        const def = HooksTrust.fromHandler("PreToolUse", undefined, { type: "command", command: "echo 'not json'" })
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
})

const nativeAsk = `printf '%s' '${JSON.stringify({ behavior: "ask", message: "check with the user" })}'`
const nativeDeny = `printf '%s' '${JSON.stringify({ behavior: "deny", message: "never" })}'`
const nativeAllow = `printf '%s' '${JSON.stringify({ behavior: "allow" })}'`
const nativeGroup = (commands: Array<string>) => ({
  PreToolUse: [{ hooks: commands.map((command) => ({ type: "command" as const, command })) }],
})
const trustNative = (commands: Array<string>) =>
  Effect.promise(() =>
    Bun.write(
      trustPath,
      JSON.stringify(
        commands.map((command) => ({
          hash: HooksTrust.hashDef(HooksTrust.fromHandler("PreToolUse", undefined, { type: "command", command })),
          trustedAt: Date.now(),
        })),
      ),
    ),
  )

describe("hooks executor: ask", () => {
  testEffect(executorLayer(nativeGroup([nativeAllow, nativeAsk]))).effect("native ask beats allow", () =>
    Effect.gen(function* () {
      yield* trustNative([nativeAllow, nativeAsk])
      const executor = yield* HooksExecutor.Service
      const decision = yield* executor.runDecision({
        event: "PreToolUse",
        matchName: "bash",
        tool: "bash",
        sessionID: "ses_1",
        callID: "c1",
        args: { command: "ls" },
      })
      expect(decision).toEqual({ behavior: "ask", message: "check with the user" })
    }),
  )

  testEffect(executorLayer(nativeGroup([nativeAsk, nativeDeny]))).effect("deny beats ask", () =>
    Effect.gen(function* () {
      yield* trustNative([nativeAsk, nativeDeny])
      const executor = yield* HooksExecutor.Service
      const decision = yield* executor.runDecision({
        event: "PreToolUse",
        matchName: "bash",
        tool: "bash",
        sessionID: "ses_1",
        callID: "c1",
        args: { command: "ls" },
      })
      expect(decision).toEqual({ behavior: "deny", message: "never" })
    }),
  )
})

const claudeSource = "claude:plugin:demo@market"
const claudeEnvPath = path.join(dir, "claude-env.txt")
const claudeCapture = (stdout = "") =>
  `cat > "${capturePath}"; printf '%s' "$CLAUDE_PLUGIN_ROOT" > "${claudeEnvPath}"; printf '%s' '${stdout}'`

type Command = string | { type: "command"; command: string; timeout?: number }
const handler = (command: Command) => (typeof command === "string" ? { type: "command" as const, command } : command)

function claudeGroup(event: string, matcher: string | undefined, commands: Array<Command>) {
  return {
    [event]: [
      {
        ...(matcher === undefined ? {} : { matcher }),
        format: "claude",
        source: claudeSource,
        env: { CLAUDE_PLUGIN_ROOT: dir, CLAUDE_PROJECT_DIR: dir },
        hooks: commands.map(handler),
      },
    ],
  }
}

// Trust is checked against the instance-bound def, so trust what the executor will ask about.
const trustClaude = Effect.fn("Test.trustClaude")(function* (event: string, matcher: string | undefined, commands: Array<Command>) {
  const defs = yield* Effect.forEach(commands, (command) =>
    HooksTrust.bindToInstance(HooksTrust.fromHandler(event, matcher, handler(command), claudeSource)),
  )
  yield* Effect.promise(() =>
    Bun.write(trustPath, JSON.stringify(defs.map((def) => ({ hash: HooksTrust.hashDef(def), trustedAt: Date.now() })))),
  )
})

const readCapture = Effect.promise(async () => JSON.parse(await Bun.file(capturePath).text()) as Record<string, unknown>)

const preToolUse = (tool: string, args: Record<string, unknown>, permissionMode?: string) =>
  Effect.gen(function* () {
    const executor = yield* HooksExecutor.Service
    return yield* executor.runDecision({
      event: "PreToolUse",
      matchName: tool,
      tool,
      sessionID: "ses_1",
      callID: "c1",
      args,
      ...(permissionMode === undefined ? {} : { permissionMode }),
    })
  })

describe("hooks executor: Claude format", () => {
  const editHook = claudeCapture()
  testEffect(executorLayer(claudeGroup("PreToolUse", "Edit|Write", [editHook]))).effect(
    "stdin carries Claude's fields and an Edit|Write matcher matches edit",
    () =>
      Effect.gen(function* () {
        yield* trustClaude("PreToolUse", "Edit|Write", [editHook])
        const decision = yield* preToolUse("edit", { filePath: "/a.ts", oldString: "x", newString: "y" }, "accept-edits")
        expect(decision).toEqual({ behavior: "undecided" })
        expect(yield* readCapture).toEqual({
          session_id: "ses_1",
          transcript_path: "",
          cwd: process.cwd(),
          permission_mode: "acceptEdits",
          hook_event_name: "PreToolUse",
          tool_name: "Edit",
          tool_input: { file_path: "/a.ts", old_string: "x", new_string: "y" },
          tool_use_id: "c1",
        })
        expect(yield* Effect.promise(() => Bun.file(claudeEnvPath).text())).toBe(dir)
      }),
  )

  testEffect(executorLayer(claudeGroup("PreToolUse", "Edit|Write", [markScript]))).effect(
    "Claude matchers test the Claude tool name, not the Flynncode id",
    () =>
      Effect.gen(function* () {
        yield* trustClaude("PreToolUse", "Edit|Write", [markScript])
        yield* preToolUse("bash", { command: "ls" })
        expect(yield* Effect.promise(() => Bun.file(markerPath).text())).toBe("pristine")
      }),
  )

  const allowHook = `printf '%s' '${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { file_path: "/b.ts", old_string: "x", new_string: "z", bogus: true },
    },
  })}'`
  testEffect(executorLayer(claudeGroup("PreToolUse", "Edit", [allowHook]))).effect(
    "permissionDecision allow rewrites the input in Flynncode's argument names",
    () =>
      Effect.gen(function* () {
        yield* trustClaude("PreToolUse", "Edit", [allowHook])
        expect(yield* preToolUse("edit", { filePath: "/a.ts", oldString: "x", newString: "y" })).toEqual({
          behavior: "allow",
          updatedInput: { filePath: "/b.ts", oldString: "x", newString: "z" },
        })
      }),
  )

  const denyHook = `printf '%s' '${JSON.stringify({
    hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "protected file" },
  })}'`
  testEffect(executorLayer(claudeGroup("PreToolUse", "Edit", [denyHook]))).effect("permissionDecision deny denies", () =>
    Effect.gen(function* () {
      yield* trustClaude("PreToolUse", "Edit", [denyHook])
      expect(yield* preToolUse("edit", { filePath: "/a.ts" })).toEqual({ behavior: "deny", message: "protected file" })
    }),
  )

  const askHook = `printf '%s' '${JSON.stringify({ hookSpecificOutput: { permissionDecision: "ask" } })}'`
  const plainAllowHook = `printf '%s' '${JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } })}'`
  testEffect(executorLayer(claudeGroup("PreToolUse", undefined, [plainAllowHook, askHook]))).effect(
    "ask beats allow",
    () =>
      Effect.gen(function* () {
        yield* trustClaude("PreToolUse", undefined, [plainAllowHook, askHook])
        expect(yield* preToolUse("bash", { command: "ls" })).toEqual({ behavior: "ask" })
      }),
  )

  const askRewriteHook = `printf '%s' '${JSON.stringify({
    hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "look first", updatedInput: { file_path: "/b.ts" } },
  })}'`
  testEffect(executorLayer(claudeGroup("PreToolUse", "Edit", [askRewriteHook]))).effect(
    "ask carries its reason and a rewritten input in Flynncode's argument names",
    () =>
      Effect.gen(function* () {
        yield* trustClaude("PreToolUse", "Edit", [askRewriteHook])
        expect(yield* preToolUse("edit", { filePath: "/a.ts" })).toEqual({
          behavior: "ask",
          message: "look first",
          updatedInput: { filePath: "/b.ts" },
        })
      }),
  )

  const failureHook = `${claudeCapture()}; echo "retry with -v" >&2; exit 2`
  testEffect(executorLayer(claudeGroup("PostToolUseFailure", "Bash", [failureHook]))).effect(
    "PostToolUseFailure gets error and is_interrupt, and exit 2 sends stderr to the model",
    () =>
      Effect.gen(function* () {
        yield* trustClaude("PostToolUseFailure", "Bash", [failureHook])
        const executor = yield* HooksExecutor.Service
        const outcome = yield* executor.runPostTool({
          event: "PostToolUseFailure",
          tool: "bash",
          matchName: "bash",
          sessionID: "ses_1",
          callID: "c1",
          args: { command: "make" },
          error: "make: *** [all] Error 1",
          interrupted: false,
        })
        expect(outcome).toEqual({ blocked: true, reason: "retry with -v" })
        const stdin = yield* readCapture
        expect(stdin["hook_event_name"]).toBe("PostToolUseFailure")
        expect(stdin["tool_name"]).toBe("Bash")
        expect(stdin["tool_input"]).toEqual({ command: "make" })
        expect(stdin["error"]).toBe("make: *** [all] Error 1")
        expect(stdin["is_interrupt"]).toBe(false)
        expect(stdin).not.toHaveProperty("tool_response")
      }),
  )

  const notificationHook = claudeCapture()
  testEffect(executorLayer(claudeGroup("Notification", "permission_prompt", [notificationHook]))).effect(
    "Notification matches notification_type and gets message",
    () =>
      Effect.gen(function* () {
        yield* trustClaude("Notification", "permission_prompt", [notificationHook])
        const executor = yield* HooksExecutor.Service
        yield* executor.runObserve({
          event: "Notification",
          matchName: "idle",
          sessionID: "ses_1",
          payload: { message: "waiting", notificationType: "idle" },
        })
        expect(yield* Effect.promise(() => Bun.file(capturePath).text())).toBe("")
        yield* executor.runObserve({
          event: "Notification",
          matchName: "permission_prompt",
          sessionID: "ses_1",
          payload: { message: "Flynncode needs your permission to use bash", notificationType: "permission_prompt" },
        })
        const stdin = yield* readCapture
        expect(stdin["hook_event_name"]).toBe("Notification")
        expect(stdin["message"]).toBe("Flynncode needs your permission to use bash")
        expect(stdin["notification_type"]).toBe("permission_prompt")
      }),
  )

  testEffect(executorLayer(claudeGroup("Notification", "idle_prompt", [notificationHook]))).effect(
    "Notification speaks Claude's type names and tool names",
    () =>
      Effect.gen(function* () {
        yield* trustClaude("Notification", "idle_prompt", [notificationHook])
        const executor = yield* HooksExecutor.Service
        yield* executor.runObserve({
          event: "Notification",
          matchName: "idle",
          sessionID: "ses_1",
          payload: { message: "waiting", notificationType: "idle" },
        })
        expect((yield* readCapture)["notification_type"]).toBe("idle_prompt")
      }),
  )

  testEffect(executorLayer(claudeGroup("Notification", undefined, [notificationHook]))).effect(
    "Notification maps question to elicitation_dialog and names the Claude tool",
    () =>
      Effect.gen(function* () {
        yield* trustClaude("Notification", undefined, [notificationHook])
        const executor = yield* HooksExecutor.Service
        yield* executor.runObserve({
          event: "Notification",
          matchName: "question",
          sessionID: "ses_1",
          payload: { message: "Which color?", notificationType: "question" },
        })
        expect((yield* readCapture)["notification_type"]).toBe("elicitation_dialog")
        yield* executor.runObserve({
          event: "Notification",
          matchName: "permission_prompt",
          sessionID: "ses_1",
          payload: {
            message: "Flynncode needs your permission to use bash",
            notificationType: "permission_prompt",
            tool: "bash",
          },
        })
        const stdin = yield* readCapture
        expect(stdin["notification_type"]).toBe("permission_prompt")
        expect(stdin["message"]).toBe("Flynncode needs your permission to use Bash")
      }),
  )

  const exit2Hook = `echo "on stdout"; echo "rm is not allowed" >&2; exit 2`
  testEffect(executorLayer(claudeGroup("PreToolUse", "Bash", [exit2Hook]))).effect("exit 2 denies with stderr", () =>
    Effect.gen(function* () {
      yield* trustClaude("PreToolUse", "Bash", [exit2Hook])
      expect(yield* preToolUse("bash", { command: "rm -rf /" })).toEqual({ behavior: "deny", message: "rm is not allowed" })
    }),
  )

  const exit1Hook = `echo "broken hook" >&2; exit 1`
  const slowHook = { type: "command" as const, command: "sleep 30", timeout: 0.05 }
  testEffect(executorLayer(claudeGroup("PreToolUse", "Bash", [exit1Hook, slowHook, "exit 7"]))).effect(
    "other exits and timeouts are ignored",
    () =>
      Effect.gen(function* () {
        yield* trustClaude("PreToolUse", "Bash", [exit1Hook, slowHook, "exit 7"])
        expect(yield* preToolUse("bash", { command: "ls" })).toEqual({ behavior: "undecided" })
      }),
  )

  testEffect(executorLayer({ PreToolUse: [{ hooks: [{ type: "command", command: exit1Hook }] }] })).effect(
    "native exit 1 still denies",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => trustDef(HooksTrust.fromHandler("PreToolUse", undefined, { type: "command", command: exit1Hook })))
        expect(yield* preToolUse("bash", { command: "ls" })).toEqual({ behavior: "deny", message: "broken hook" })
      }),
  )

  testEffect(executorLayer(claudeGroup("SessionStart", "startup", [observeTextScript]))).effect(
    "SessionStart plain stdout becomes context",
    () =>
      Effect.gen(function* () {
        yield* trustClaude("SessionStart", "startup", [observeTextScript])
        const executor = yield* HooksExecutor.Service
        const out = yield* executor.runObserve({
          event: "SessionStart",
          matchName: "startup",
          sessionID: "ses_1",
          payload: { source: "startup" },
        })
        expect(out).toEqual({ additionalContext: "Build docs live in ./docs" })
      }),
  )

  const contextHook = `printf '%s' '${JSON.stringify({
    systemMessage: "hello",
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "use superpowers" },
  })}'`
  testEffect(executorLayer(claudeGroup("SessionStart", undefined, [contextHook]))).effect(
    "SessionStart JSON context and systemMessage reach the observe result",
    () =>
      Effect.gen(function* () {
        yield* trustClaude("SessionStart", undefined, [contextHook])
        const executor = yield* HooksExecutor.Service
        const out = yield* executor.runObserve({
          event: "SessionStart",
          matchName: "startup",
          sessionID: "ses_1",
          payload: { source: "startup" },
        })
        expect(out).toEqual({ additionalContext: "use superpowers", systemMessage: "hello" })
      }),
  )

  const runPost = Effect.gen(function* () {
    const executor = yield* HooksExecutor.Service
    return yield* executor.runPostTool({
      tool: "bash",
      matchName: "bash",
      sessionID: "ses_1",
      callID: "c1",
      args: { command: "ls" },
      output: "a.txt",
    })
  })

  const postBlockHook = `printf '%s' '${JSON.stringify({ decision: "block", reason: "lint failed" })}'`
  testEffect(executorLayer(claudeGroup("PostToolUse", "Bash", [postBlockHook]))).effect(
    "PostToolUse decision block keeps the output and appends the reason",
    () =>
      Effect.gen(function* () {
        yield* trustClaude("PostToolUse", "Bash", [postBlockHook])
        expect(yield* runPost).toEqual({ blocked: true, reason: "a.txt\n\n[PostToolUse hook blocked: lint failed]" })
      }),
  )

  const nativeBlockHook = `printf '%s' '${JSON.stringify({ blockedOutput: "redacted" })}'`
  testEffect(executorLayer({ PostToolUse: [{ hooks: [{ type: "command", command: nativeBlockHook }] }] })).effect(
    "native blockedOutput still replaces the output",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          trustDef(HooksTrust.fromHandler("PostToolUse", undefined, { type: "command", command: nativeBlockHook })),
        )
        expect(yield* runPost).toEqual({ blocked: true, reason: "redacted" })
      }),
  )

  const postStopHook = `printf '%s' '${JSON.stringify({ continue: false, stopReason: "stop here", systemMessage: "note" })}'`
  testEffect(executorLayer(claudeGroup("PostToolUse", "Bash", [postStopHook]))).effect(
    "PostToolUse continue:false blocks the result with stopReason and ends the turn",
    () =>
      Effect.gen(function* () {
        yield* trustClaude("PostToolUse", "Bash", [postStopHook])
        expect(yield* runPost).toEqual({
          blocked: true,
          reason: "a.txt\n\n[PostToolUse hook blocked: stop here]",
          stop: true,
        })
      }),
  )

  const stopHook = `printf '%s' '${JSON.stringify({
    continue: false,
    stopReason: "halt: prod creds detected",
    hookSpecificOutput: { permissionDecision: "allow" },
  })}'`
  testEffect(executorLayer(claudeGroup("PreToolUse", "Bash", [stopHook]))).effect(
    "PreToolUse continue:false denies the call with stopReason and ends the turn",
    () =>
      Effect.gen(function* () {
        yield* trustClaude("PreToolUse", "Bash", [stopHook])
        expect(yield* preToolUse("bash", { command: "ls" })).toEqual({
          behavior: "deny",
          message: "halt: prod creds detected",
          stop: true,
        })
      }),
  )

  testEffect(executorLayer(claudeGroup("PermissionRequest", "Bash", [stopHook]))).effect(
    "PermissionRequest continue:false denies the call with stopReason",
    () =>
      Effect.gen(function* () {
        yield* trustClaude("PermissionRequest", "Bash", [stopHook])
        const executor = yield* HooksExecutor.Service
        const decision = yield* executor.runDecision({
          event: "PermissionRequest",
          matchName: "bash",
          tool: "bash",
          sessionID: "ses_1",
          callID: "c1",
          args: { command: "ls" },
        })
        expect(decision).toEqual({ behavior: "deny", message: "halt: prod creds detected", stop: true })
      }),
  )

  const modeHook = claudeCapture()
  testEffect(executorLayer(claudeGroup("SessionStart", undefined, [modeHook]), false, { approval: "accept-edits" })).effect(
    "non-tool events carry the session policy's permission_mode",
    () =>
      Effect.gen(function* () {
        yield* trustClaude("SessionStart", undefined, [modeHook])
        const executor = yield* HooksExecutor.Service
        yield* executor.runObserve({ event: "SessionStart", matchName: "startup", sessionID: "ses_1", payload: { source: "startup" } })
        expect((yield* readCapture)["permission_mode"]).toBe("acceptEdits")
      }),
  )
})

const mcpFixture = path.join(import.meta.dir, "../fixture/mcp-lifecycle-stdio.ts")
const mcpHook = claudeCapture()
const withMcp = testEffect(
  LayerNode.compile(LayerNode.group([HooksExecutor.node, MCP.node]), [
    [Config.node, configLayer({
      PreToolUse: [
        { matcher: "mcp__.*", format: "claude", source: claudeSource, hooks: [{ type: "command", command: mcpHook }] },
      ],
    })],
    [RuntimeFlags.node, RuntimeFlags.layer({ bypassHookTrust: false })],
  ]),
)

describe("hooks executor: Claude format with MCP", () => {
  withMcp.instance("an mcp__.* matcher matches an MCP tool under its Claude name", () =>
    Effect.gen(function* () {
      yield* trustClaude("PreToolUse", "mcp__.*", [mcpHook])
      const mcp = yield* MCP.Service
      yield* mcp.add("demo-srv", { type: "local", command: [process.execPath, mcpFixture] })
      const id = Object.keys(yield* mcp.tools()).find((key) => key.endsWith("current_directory"))
      expect(id).toBeDefined()
      yield* preToolUse(id ?? "", {})
      const stdin = yield* readCapture
      expect(stdin["tool_name"]).toBe("mcp__demo-srv__current_directory")
      expect(stdin["tool_input"]).toEqual({})
    }),
  )
})

const transcriptHook = claudeCapture()
const withSession = testEffect(
  LayerNode.compile(LayerNode.group([HooksExecutor.node, Session.node, MessageV2.node, SessionProjector.node]), [
    [Config.node, configLayer(claudeGroup("UserPromptSubmit", undefined, [transcriptHook]))],
    [RuntimeFlags.node, RuntimeFlags.layer({ bypassHookTrust: false })],
  ]),
)

describe("hooks executor: Claude format with a session", () => {
  withSession.instance("transcript_path points at the session's up-to-date transcript", () =>
    Effect.gen(function* () {
      yield* trustClaude("UserPromptSubmit", undefined, [transcriptHook])
      const session = yield* Session.Service
      const created = yield* session.create({})
      const messageID = MessageID.ascending()
      yield* session.updateMessage({
        id: messageID,
        sessionID: created.id,
        role: "user",
        time: { created: Date.now() },
        agent: "test",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as unknown as SessionV1.Info)
      yield* session.updatePart({ id: PartID.ascending(), sessionID: created.id, messageID, type: "text", text: "hello" })
      const executor = yield* HooksExecutor.Service
      yield* executor.runObserve({
        event: "UserPromptSubmit",
        matchName: "",
        sessionID: created.id,
        payload: { prompt: "hello" },
      })
      const stdin = yield* readCapture
      expect(stdin["prompt"]).toBe("hello")
      expect(stdin["transcript_path"]).toBe(ClaudeTranscript.path(created.id))
      const lines = (yield* Effect.promise(() => Bun.file(ClaudeTranscript.path(created.id)).text())).trim().split("\n")
      expect(JSON.parse(lines[0] ?? "{}").uuid).toBe(messageID)
      yield* session.remove(created.id)
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
