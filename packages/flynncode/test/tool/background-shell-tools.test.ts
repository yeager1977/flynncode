import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Cause, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { AppProcess } from "@flynncode/core/process"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { FSUtil } from "@flynncode/core/fs-util"
import { locationServiceMapLayer } from "@flynncode/core/location-services"
import type { PermissionV1 } from "@flynncode/core/v1/permission"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { BackgroundShells } from "@/shell/background/service"
import { BackgroundRegistry } from "@/shell/background/registry"
import { GlobalBus } from "@/bus/global"
import { Session } from "@/session/session"
import { SessionProjector } from "@flynncode/core/session/projector"
import { Database } from "@flynncode/core/database/database"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { ShellTool } from "@/tool/shell"
import { BashOutputTool } from "@/tool/bash-output"
import { KillShellTool } from "@/tool/kill-shell"
import { MonitorTool } from "@/tool/monitor"
import { ShellBackground } from "@/tool/shell/background"
import type { TaskPromptOps } from "@/tool/task"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID, SessionID } from "@/session/schema"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        CrossSpawnSpawner.node,
        FSUtil.node,
        Plugin.node,
        Truncate.node,
        Config.node,
        Agent.node,
        RuntimeFlags.node,
        AppProcess.node,
        BackgroundShells.node,
        Session.node,
        SessionProjector.node,
        Database.node,
      ]),
    ),
    testInstanceStoreLayer,
    locationServiceMapLayer,
  ),
)

// Safety net: every started group is SIGKILLed even when a test fails before the layer finalizer runs.
const started = new Set<number>()
afterEach(() => {
  started.forEach((pid) => {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {}
  })
  started.clear()
})

type Prompted = { input: SessionPrompt.PromptInput; directory: string | undefined }

// The prompt never resolves: the real one runs a whole turn, and the notifier must not wait for it.
const recorder = () => {
  const prompts: Prompted[] = []
  const ops: TaskPromptOps = {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.gen(function* () {
        const instance = yield* InstanceRef
        prompts.push({ input, directory: instance?.directory })
        return yield* Effect.never
      }),
  }
  return { prompts, ops }
}

const context = (input: {
  sessionID?: string
  ops?: TaskPromptOps
  ask?: Tool.Context["ask"]
  callID?: string
  metadata?: Tool.Context["metadata"]
  abort?: AbortSignal
}): Tool.Context => ({
  sessionID: SessionID.make(input.sessionID ?? "ses_bg_a"),
  messageID: MessageID.make("msg_bg"),
  callID: input.callID ?? "",
  agent: "build",
  abort: input.abort ?? AbortSignal.any([]),
  messages: [],
  extra: input.ops ? { promptOps: input.ops } : {},
  metadata: input.metadata ?? (() => Effect.void),
  ask: input.ask ?? (() => Effect.void),
})

const bash = Effect.fn("BackgroundShellToolsTest.bash")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  ctx: Tool.Context,
) {
  const tool = yield* (yield* ShellTool).init()
  const result = yield* tool.execute(args, ctx)
  if (result.metadata.background === true) started.add(result.metadata.pid)
  return result
})

const output = Effect.fn("BackgroundShellToolsTest.output")(function* (
  args: Tool.InferParameters<typeof BashOutputTool>,
  ctx: Tool.Context,
) {
  const tool = yield* (yield* BashOutputTool).init()
  return yield* tool.execute(args, ctx)
})

const kill = Effect.fn("BackgroundShellToolsTest.kill")(function* (
  args: Tool.InferParameters<typeof KillShellTool>,
  ctx: Tool.Context,
) {
  const tool = yield* (yield* KillShellTool).init()
  return yield* tool.execute(args, ctx)
})

const monitor = Effect.fn("BackgroundShellToolsTest.monitor")(function* (
  args: Tool.InferParameters<typeof MonitorTool>,
  ctx: Tool.Context,
) {
  const tool = yield* (yield* MonitorTool).init()
  return yield* tool.execute(args, ctx)
})

const failure = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* self.pipe(Effect.exit)
    if (Exit.isSuccess(exit)) throw new Error("expected the tool call to fail")
    const error = Cause.squash(exit.cause)
    return error instanceof Error ? error.message : String(error)
  })

const background = (args: { command: string; timeout?: number }, ctx: Tool.Context) =>
  bash({ ...args, run_in_background: true }, ctx).pipe(
    Effect.map((result) => {
      if (result.metadata.background !== true) throw new Error("expected a background start")
      return result.metadata
    }),
  )

// bash_output's first line is the status line, which repeats the command.
const body = (text: string) => text.split("\n").slice(1).join("\n")

const readUntil = (id: string, ctx: Tool.Context, match: (text: string) => boolean, collected = { text: "" }) =>
  pollWithTimeout(
    output({ id }, ctx).pipe(
      Effect.map((result) => {
        collected.text += result.output + "\n"
        return match(result.output) ? result.output : undefined
      }),
    ),
    `bash_output for ${id} never matched; saw:\n${collected.text}`,
    "8 seconds",
  )

const prompted = (prompts: Prompted[], count = 1) =>
  pollWithTimeout(
    Effect.sync(() => (prompts.length >= count ? prompts : undefined)),
    `expected ${count} prompt(s)`,
    "8 seconds",
  )

const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

describe("background shell tools", () => {
  it.instance(
    "starts a background shell, reads it with bash_output and stops it with kill_shell",
    () =>
      Effect.gen(function* () {
        const ctx = context({})
        const result = yield* bash({ command: "echo hello-bg; sleep 30", run_in_background: true }, ctx)
        expect(result.title).toBe("started in background")
        if (result.metadata.background !== true) throw new Error("expected a background start")
        const meta = result.metadata
        expect(meta.shellId.startsWith("bash_")).toBe(true)
        expect(meta.pid).toBeGreaterThan(0)
        expect(meta.outputPath).toContain(path.join("tool-output", "tool_"))
        expect(result.output).toContain(`${meta.shellId} started (pid ${meta.pid}). Output: ${meta.outputPath}.`)
        expect(result.output).toContain("bash_output")
        expect(groupAlive(meta.pid)).toBe(true)

        const read = yield* readUntil(meta.shellId, ctx, (text) => body(text).includes("hello-bg"))
        expect(read.split("\n")[0]).toBe(
          `[background shell ${meta.shellId} running (pid ${meta.pid})] echo hello-bg; sleep 30`,
        )
        const again = yield* output({ id: meta.shellId }, ctx)
        expect(body(again.output)).toBe("(no new output)")

        const killed = yield* kill({ id: meta.shellId }, ctx)
        expect(killed.output).toContain(`Killed background shell ${meta.shellId}`)
        expect(killed.metadata.status).toBe("killed")
        expect(groupAlive(meta.pid)).toBe(false)
        const after = yield* output({ id: meta.shellId }, ctx)
        expect(after.output.split("\n")[0]).toContain(`${meta.shellId} killed]`)
      }),
    20_000,
  )

  it.instance(
    "reports the exit status and code, and filters new output",
    () =>
      Effect.gen(function* () {
        const ctx = context({})
        const meta = yield* background({ command: "echo alpha; echo beta; echo alphabet; exit 3" }, ctx)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const service = yield* BackgroundShells.Service
            const shells = yield* service.list(ctx.sessionID)
            return shells.find((shell) => shell.id === meta.shellId && shell.status !== "running")
          }),
          "shell never finished",
          "8 seconds",
        )
        const read = yield* output({ id: meta.shellId, filter: "^alpha" }, ctx)
        expect(read.output.split("\n")[0]).toContain("exited (code 3)")
        expect(body(read.output).trim().split("\n")).toEqual(["alpha", "alphabet"])
        expect(read.metadata.status).toBe("exited")
        expect(read.metadata.exitCode).toBe(3)

        const invalid = yield* failure(output({ id: meta.shellId, filter: "(" }, ctx))
        expect(invalid).toContain("invalid filter regex")
      }),
    20_000,
  )

  it.instance(
    "notifies the session through promptOps with a queued synthetic prompt when the shell exits",
    () =>
      Effect.gen(function* () {
        const sink = recorder()
        const ctx = context({ ops: sink.ops })
        const directory = (yield* InstanceState.context).directory
        const meta = yield* background({ command: "echo goodbye-bg" }, ctx)
        const prompts = yield* prompted(sink.prompts)
        expect(prompts).toHaveLength(1)
        const prompt = prompts[0]
        expect(prompt.input.sessionID).toBe(ctx.sessionID)
        expect(prompt.input.delivery).toBe("queue")
        expect(prompt.input.parts).toHaveLength(1)
        const part = prompt.input.parts[0]
        if (part.type !== "text") throw new Error("expected a text part")
        expect(part.synthetic).toBe(true)
        expect(part.text).toContain(`[background shell ${meta.shellId} exited (code 0)]`)
        expect(part.text).toContain("goodbye-bg")
        // The service notifies from its own fibers; the prompt still runs in the tool call's instance.
        expect(prompt.directory).toBe(directory)
      }),
    20_000,
  )

  it.instance("a notification prompt runs in the calling instance even from a fiber without one", () =>
    Effect.gen(function* () {
      const sink = recorder()
      const ctx = context({ ops: sink.ops })
      const directory = (yield* InstanceState.context).directory
      const notify = yield* ShellBackground.notifier(ctx, yield* Scope.Scope)
      if (!notify) throw new Error("expected a notifier")
      yield* notify("from elsewhere").pipe(Effect.provideService(InstanceRef, undefined))
      const prompts = yield* prompted(sink.prompts)
      expect(prompts[0].directory).toBe(directory)
      expect(yield* ShellBackground.notifier(context({}), yield* Scope.Scope)).toBeUndefined()
    }),
  )

  it.instance(
    "monitor returns at once and the match arrives as a queued synthetic prompt",
    () =>
      Effect.gen(function* () {
        const sink = recorder()
        const ctx = context({ ops: sink.ops })
        const meta = yield* background({ command: "sleep 2; echo server-ready; sleep 30" }, ctx)
        const registered = yield* monitor({ id: meta.shellId, pattern: "ready$" }, ctx)
        expect(registered.output).toContain(`Monitoring background shell ${meta.shellId}`)
        expect(sink.prompts).toHaveLength(0)
        const prompts = yield* prompted(sink.prompts)
        const part = prompts[0].input.parts[0]
        if (part.type !== "text") throw new Error("expected a text part")
        expect(prompts[0].input.delivery).toBe("queue")
        expect(part.synthetic).toBe(true)
        expect(part.text).toContain("server-ready")
        expect(part.text).toContain(meta.shellId)

        const invalid = yield* failure(monitor({ id: meta.shellId, pattern: "(" }, ctx))
        expect(invalid).toContain("invalid monitor regex")
        yield* kill({ id: meta.shellId }, ctx)
      }),
    20_000,
  )

  it.instance("answers an unknown id with a result, not a failure", () =>
    Effect.gen(function* () {
      const sink = recorder()
      const ctx = context({ ops: sink.ops })
      const read = yield* output({ id: "bash_missing" }, ctx)
      expect(read.output).toMatch(/no such background shell/i)
      const killed = yield* kill({ id: "bash_missing" }, ctx)
      expect(killed.output).toMatch(/no such background shell/i)
      const watched = yield* monitor({ id: "bash_missing", pattern: "x" }, ctx)
      expect(watched.output).toMatch(/no such background shell/i)
    }),
  )

  it.instance(
    "keeps shells private to their session",
    () =>
      Effect.gen(function* () {
        const owner = context({ sessionID: "ses_bg_owner" })
        const other = context({ sessionID: "ses_bg_other" })
        const meta = yield* background({ command: "sleep 30" }, owner)
        expect((yield* output({ id: meta.shellId }, other)).output).toMatch(/no such background shell/i)
        expect((yield* kill({ id: meta.shellId }, other)).output).toMatch(/no such background shell/i)
        expect(groupAlive(meta.pid)).toBe(true)
        yield* kill({ id: meta.shellId }, owner)
      }),
    20_000,
  )

  it.instance("a bash deny rule for the command also denies run_in_background", () =>
    Effect.gen(function* () {
      const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      const rules: PermissionV1.Ruleset = [
        { permission: "*", pattern: "*", action: "allow" },
        { permission: "bash", pattern: "sleep *", action: "deny" },
      ]
      const ctx = context({
        ask: (request) =>
          Effect.gen(function* () {
            requests.push(request)
            const denied = request.patterns.some(
              (pattern) => Permission.evaluate(request.permission, pattern, rules).action === "deny",
            )
            if (denied) return yield* Effect.die(new Error(`denied: ${request.permission}`))
          }),
      })
      const message = yield* failure(bash({ command: "sleep 30", run_in_background: true }, ctx))
      expect(message).toContain("denied: bash")
      expect(requests.map((request) => request.permission)).toContain("bash")
      expect(requests.find((request) => request.permission === "bash")?.patterns).toEqual(["sleep 30"])
      const service = yield* BackgroundShells.Service
      expect(yield* service.list(ctx.sessionID)).toHaveLength(0)
    }),
  )

  it.instance("refuses an interactive command in the background without spawning it", () =>
    Effect.gen(function* () {
      const ctx = context({})
      const message = yield* failure(bash({ command: "echo hi", interactive: true, run_in_background: true }, ctx))
      expect(message).toContain("run_in_background")
      const service = yield* BackgroundShells.Service
      expect(yield* service.list(ctx.sessionID)).toHaveLength(0)
    }),
  )

  it.instance(
    "caps a background shell at background_shells.max_ms from config",
    () =>
      Effect.gen(function* () {
        const ctx = context({})
        const meta = yield* background({ command: "sleep 30", timeout: 60_000 }, ctx)
        const read = yield* readUntil(meta.shellId, ctx, (text) => text.includes("timed_out"))
        expect(read).toContain("timed_out")
        expect(groupAlive(meta.pid)).toBe(false)
      }),
    { config: { background_shells: { max_ms: 400 } } },
    20_000,
  )

  // Starts a foreground call and waits until it printed `marker`, so promotion happens mid-run.
  const foreground = (
    command: string,
    marker: string,
    input: { ops?: TaskPromptOps; sessionID?: string; abort?: AbortSignal },
  ) =>
    Effect.gen(function* () {
      const seen = { output: "" }
      const ctx = context({
        ...input,
        callID: "call_promote",
        metadata: (value) =>
          Effect.sync(() => {
            const output = value.metadata?.output
            if (typeof output === "string") seen.output = output
          }),
      })
      const fiber = yield* bash({ command }, ctx).pipe(Effect.forkChild)
      yield* pollWithTimeout(
        Effect.sync(() => (seen.output.includes(marker) ? true : undefined)),
        `foreground call never printed ${marker}`,
        "8 seconds",
      )
      return { ctx, fiber }
    })

  it.instance(
    "moves a running foreground call to the background without killing it",
    () =>
      Effect.gen(function* () {
        const sink = recorder()
        const service = yield* BackgroundShells.Service
        const call = yield* foreground("echo before; sleep 1; echo done", "before", { ops: sink.ops })
        const shell = yield* service.promote({ sessionID: call.ctx.sessionID, callID: "call_promote" })
        if (!shell) throw new Error("expected the running call to be promoted")
        const result = yield* Fiber.join(call.fiber)
        if (result.metadata.background !== true) throw new Error("expected a background result")
        started.add(result.metadata.pid)
        expect(result.metadata.shellId).toBe(shell.id)
        expect(result.output).toContain(`Moved to the background as ${shell.id}`)
        expect(groupAlive(shell.pid)).toBe(true)
        expect((yield* service.list(call.ctx.sessionID)).map((item) => item.id)).toEqual([shell.id])
        // A finished call is no longer offered.
        expect(yield* service.promote({ sessionID: call.ctx.sessionID, callID: "call_promote" })).toBeUndefined()

        const prompts = yield* prompted(sink.prompts)
        const part = prompts[0].input.parts[0]
        if (part.type !== "text") throw new Error("expected a text part")
        expect(part.text).toContain(`[background shell ${shell.id} exited (code 0)]`)
        expect(part.text).toContain("before\ndone")
        const read = yield* output({ id: shell.id }, call.ctx)
        expect(read.output.split("\n")[0]).toContain(`${shell.id} exited (code 0)`)
        expect(body(read.output).trim().split("\n")).toEqual(["before", "done"])
      }),
    20_000,
  )

  it.instance(
    "records a promoted shell for crash cleanup and stops it with its session",
    () =>
      Effect.gen(function* () {
        const service = yield* BackgroundShells.Service
        const call = yield* foreground("echo up; sleep 30", "up", { sessionID: "ses_bg_promote_kill" })
        const shell = yield* service.promote({ sessionID: call.ctx.sessionID, callID: "call_promote" })
        if (!shell) throw new Error("expected the running call to be promoted")
        started.add(shell.pid)
        yield* Fiber.join(call.fiber)
        const recorded = yield* Effect.promise(() => BackgroundRegistry.list(BackgroundShells.REGISTRY_DIR))
        expect(recorded.map((entry) => entry.id)).toContain(shell.id)
        expect(yield* service.killSession(call.ctx.sessionID)).toBe(1)
        expect(groupAlive(shell.pid)).toBe(false)
        const after = yield* Effect.promise(() => BackgroundRegistry.list(BackgroundShells.REGISTRY_DIR))
        expect(after.map((entry) => entry.id)).not.toContain(shell.id)
      }),
    20_000,
  )

  it.instance(
    "a foreground call that finishes on its own cannot be promoted afterwards",
    () =>
      Effect.gen(function* () {
        const service = yield* BackgroundShells.Service
        const call = yield* foreground("echo quick", "quick", { sessionID: "ses_bg_promote_late" })
        const result = yield* Fiber.join(call.fiber)
        expect(result.metadata.background).not.toBe(true)
        expect(result.output).toContain("quick")
        expect(yield* service.promote({ sessionID: call.ctx.sessionID, callID: "call_promote" })).toBeUndefined()
        expect(yield* service.list(call.ctx.sessionID)).toHaveLength(0)
      }),
    20_000,
  )

  // The shape SessionStatus publishes through the EventV2 bridge when a run ends.
  const idle = (sessionID: string) =>
    GlobalBus.emit("event", {
      directory: process.cwd(),
      payload: { id: "evt_idle", type: "session.status", properties: { sessionID, status: { type: "idle" } } },
    })

  it.instance(
    "a sub-agent's background shell is killed when its run ends; a root session's shell survives",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "parent" })
        const child = yield* sessions.create({ title: "child", parentID: parent.id })
        const sink = recorder()
        const fromChild = yield* background({ command: "sleep 60" }, context({ sessionID: child.id, ops: sink.ops }))
        const fromRoot = yield* background({ command: "sleep 60" }, context({ sessionID: parent.id }))
        idle(parent.id)
        idle(child.id)
        yield* pollWithTimeout(
          Effect.sync(() => (groupAlive(fromChild.pid) ? undefined : true)),
          "the child session's shell survived the end of its run",
          "8 seconds",
        )
        yield* Effect.sleep("300 millis")
        expect(groupAlive(fromRoot.pid)).toBe(true)
        // An explicit kill: the finished sub-agent is not woken by an exit notification.
        expect(sink.prompts).toHaveLength(0)
      }),
    20_000,
  )

  it.instance(
    "a shell moved to the background in a sub-agent's session is killed when its run ends",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const service = yield* BackgroundShells.Service
        const parent = yield* sessions.create({ title: "parent" })
        const child = yield* sessions.create({ title: "child", parentID: parent.id })
        const call = yield* foreground("echo up; sleep 60", "up", { sessionID: child.id })
        const shell = yield* service.promote({ sessionID: child.id, callID: "call_promote" })
        if (!shell) throw new Error("expected the running call to be promoted")
        started.add(shell.pid)
        yield* Fiber.join(call.fiber)
        idle(child.id)
        yield* pollWithTimeout(
          Effect.sync(() => (groupAlive(shell.pid) ? undefined : true)),
          "the promoted shell survived the end of the sub-agent's run",
          "8 seconds",
        )
      }),
    20_000,
  )

  it.instance("the notifier keeps the session it was created for, not a reference to the whole call context", () =>
    Effect.gen(function* () {
      const sink = recorder()
      const ctx = context({ sessionID: "ses_bg_notify_own", ops: sink.ops })
      const notify = yield* ShellBackground.notifier(ctx, yield* Scope.Scope)
      if (!notify) throw new Error("expected a notifier")
      // A context object reused or changed after the call must not redirect a later notification.
      Object.assign(ctx, { sessionID: SessionID.make("ses_bg_notify_other") })
      yield* notify("later")
      const prompts = yield* prompted(sink.prompts)
      expect(prompts[0].input.sessionID).toBe(SessionID.make("ses_bg_notify_own"))
    }),
  )

  it.instance(
    "aborting the call after promotion leaves the shell running until kill_shell removes every process",
    () =>
      Effect.gen(function* () {
        const service = yield* BackgroundShells.Service
        const controller = new AbortController()
        const call = yield* foreground("sh -c 'sleep 60 & echo up; sleep 60'", "up", {
          sessionID: "ses_bg_promote_abort",
          abort: controller.signal,
        })
        const shell = yield* service.promote({ sessionID: call.ctx.sessionID, callID: "call_promote" })
        if (!shell) throw new Error("expected the running call to be promoted")
        started.add(shell.pid)
        const result = yield* Fiber.join(call.fiber)
        expect(result.metadata.background).toBe(true)
        controller.abort()
        yield* Effect.sleep("500 millis")
        expect(groupAlive(shell.pid)).toBe(true)
        expect((yield* service.list(call.ctx.sessionID))[0]?.status).toBe("running")
        const killed = yield* kill({ id: shell.id }, call.ctx)
        expect(killed.metadata.status).toBe("killed")
        expect(groupAlive(shell.pid)).toBe(false)
      }),
    20_000,
  )

  it.instance(
    "a promoted shell outlives the foreground timeout and its time cap removes every process",
    () =>
      Effect.gen(function* () {
        const service = yield* BackgroundShells.Service
        const seen = { output: "" }
        const ctx = context({
          sessionID: "ses_bg_promote_cap",
          callID: "call_promote",
          metadata: (value) =>
            Effect.sync(() => {
              const output = value.metadata?.output
              if (typeof output === "string") seen.output = output
            }),
        })
        const fiber = yield* bash({ command: "sh -c 'sleep 60 & echo up; sleep 60'", timeout: 1_500 }, ctx).pipe(
          Effect.forkChild,
        )
        yield* pollWithTimeout(
          Effect.sync(() => (seen.output.includes("up") ? true : undefined)),
          "foreground call never printed up",
          "8 seconds",
        )
        const shell = yield* service.promote({ sessionID: ctx.sessionID, callID: "call_promote" })
        if (!shell) throw new Error("expected the running call to be promoted")
        started.add(shell.pid)
        yield* Fiber.join(fiber)
        // Past the foreground call's own timeout, the shell is still the service's and still running.
        yield* Effect.sleep("2 seconds")
        expect(groupAlive(shell.pid)).toBe(true)
        // The cap counts from the real start (config max_ms 4000).
        yield* pollWithTimeout(
          service
            .list(ctx.sessionID)
            .pipe(Effect.map((list) => (list[0]?.status === "timed_out" ? true : undefined))),
          "the promoted shell never hit its time cap",
          "10 seconds",
        )
        expect(groupAlive(shell.pid)).toBe(false)
      }),
    { config: { background_shells: { max_ms: 4_000 } } },
    25_000,
  )

  test("Permission.disabled hides the background shell tools when bash is denied", () => {
    const tools = ["bash", "bash_output", "kill_shell", "monitor", "read"]
    const hidden = Permission.disabled(tools, [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
    ])
    expect(Array.from(hidden).toSorted()).toEqual(["bash", "bash_output", "kill_shell", "monitor"])
    expect(Permission.disabled(tools, [{ permission: "*", pattern: "*", action: "allow" }]).size).toBe(0)
  })
})

const registry = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node]), [
    [Config.node, TestConfig.layer()],
    [RuntimeFlags.node, RuntimeFlags.layer()],
    [
      InstanceStore.bootstrapNode,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ]),
)

describe("background shell tool registration", () => {
  registry.instance("registers bash_output, kill_shell and monitor next to bash", () =>
    Effect.gen(function* () {
      const tools = yield* ToolRegistry.Service
      const ids = yield* tools.ids()
      expect(ids).toContain("bash")
      expect(ids).toContain("bash_output")
      expect(ids).toContain("kill_shell")
      expect(ids).toContain("monitor")
    }),
  )
})
