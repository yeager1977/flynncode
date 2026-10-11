import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@flynncode/core/model"
import { SessionFolders } from "@flynncode/core/session/folders"
import { AbsolutePath } from "@flynncode/core/schema"
import { ProviderV2 } from "@flynncode/core/provider"
import { PermissionV1 } from "@flynncode/core/v1/permission"
import { SessionV1 } from "@flynncode/core/v1/session"
import { Agent } from "@/agent/agent"
import { AutoReviewer } from "@/permission/auto-reviewer"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Project } from "@/project/project"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { Sandbox } from "@/permission/sandbox"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { Plugin } from "@/plugin"
import { testLayerWithHooks } from "../lib/hooks"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Effect, Cause, Exit, Layer, Schema } from "effect"
import { ConfigV1 } from "@flynncode/core/v1/config/config"
import { testEffect } from "../lib/effect"

const callID = "call-test"
const sessionID = SessionID.make("ses_test")
const messageID = MessageID.ascending()
const partID = PartID.ascending()

const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}

const model = {
  providerID: ProviderV2.ID.make("test"),
  api: { id: "test-model" },
} as Provider.Model

function fakeMcp() {
  return MCP.Service.of({
    tools: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
  } as Partial<MCP.Interface> as MCP.Interface)
}

const fakePlugin = Plugin.Service.of({
  init: () => Effect.void,
  list: () => Effect.succeed([]),
  trigger: (_name, _input, output) => Effect.succeed(output),
  triggerDecision: (_input, output) => Effect.succeed(output),
  triggerPermissionAsk: (_input, output) => Effect.succeed(output),
} satisfies Plugin.Interface)

const fakePermission = Permission.Service.of({
  ask: () => Effect.void,
  reply: () => Effect.void,
  list: () => Effect.succeed([]),
} satisfies Permission.Interface)

const fakeTruncate = Truncate.Service.of({
  cleanup: () => Effect.void,
  write: () => Effect.succeed("output.txt"),
  output: (text: string) => Effect.succeed({ content: text, truncated: false }),
  limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
} satisfies Truncate.Interface)

const fakeConfig = Config.Service.of({
  get: () => Effect.succeed({}),
} as Partial<Config.Interface> as Config.Interface)

const fakeProject = Project.Service.of({
  sandboxes: () => Effect.succeed([]),
} as Partial<Project.Interface> as Project.Interface)

const layer = Layer.mergeAll(
  Layer.mock(SessionFolders.Service, { list: () => Effect.succeed([]) }),
  Layer.succeed(Plugin.Service, fakePlugin),
  testLayerWithHooks([]),
  Layer.succeed(Permission.Service, fakePermission),
  Layer.succeed(Config.Service, fakeConfig),
  Layer.succeed(Project.Service, fakeProject),
  Layer.succeed(MCP.Service, fakeMcp()),
  Layer.succeed(Truncate.Service, fakeTruncate),
  RuntimeFlags.layer(),
  Layer.succeed(
    ToolRegistry.Service,
    ToolRegistry.Service.of({
      ids: () => Effect.succeed(["timing"]),
      all: () => Effect.succeed([]),
      named: () => Effect.die("unused"),
      tools: () =>
        Effect.succeed([
          {
            id: "timing",
            description: "updates metadata more than once",
            parameters: Schema.Struct({}),
            jsonSchema: { type: "object", properties: {} },
            execute: (_args, ctx) =>
              Effect.gen(function* () {
                yield* ctx.metadata({ metadata: { output: "first" } })
                yield* ctx.metadata({ metadata: { output: "second" } })
                return { title: "timing", metadata: {}, output: "done" }
              }),
          } satisfies Tool.Def,
          {
            id: "writer",
            description: "asks edit permission for an allowed path and a sandbox-violating path",
            parameters: Schema.Struct({}),
            jsonSchema: { type: "object", properties: {} },
            execute: (_args, ctx) =>
              Effect.gen(function* () {
                yield* ctx.ask({
                  permission: "edit",
                  metadata: {},
                  patterns: ["/repo/src/ok.ts", "/etc/passwd"],
                  always: [],
                })
                return { title: "writer", metadata: {}, output: "done" }
              }),
          } satisfies Tool.Def,
          {
            id: "extra-writer",
            description: "asks edit permission for a path inside an attached additional directory",
            parameters: Schema.Struct({}),
            jsonSchema: { type: "object", properties: {} },
            execute: (_args, ctx) =>
              Effect.gen(function* () {
                yield* ctx.ask({
                  permission: "edit",
                  metadata: {},
                  patterns: ["/extra/src/ok.ts"],
                  always: [],
                })
                return { title: "extra-writer", metadata: {}, output: "done" }
              }),
          } satisfies Tool.Def,
          ...["read", "write"].map(
            (id) =>
              ({
                id,
                description: `${id} outside the workspace`,
                parameters: Schema.Struct({}),
                jsonSchema: { type: "object", properties: {} },
                execute: (_args, ctx) =>
                  Effect.gen(function* () {
                    yield* ctx.ask({
                      permission: "external_directory",
                      metadata: {},
                      patterns: ["/etc/*"],
                      always: [],
                    })
                    return { title: id, metadata: {}, output: "done" }
                  }),
              }) satisfies Tool.Def,
          ),
        ]),
    }),
  ),
)

const it = testEffect(layer)

it.effect("preserves running tool start time across metadata updates", () =>
  Effect.gen(function* () {
    const state: SessionV1.ToolPart = {
      id: partID,
      sessionID,
      messageID,
      type: "tool",
      tool: "timing",
      callID,
      state: {
        status: "running",
        input: {},
        time: { start: 100 },
      },
    }
    const updates: number[] = []
    const processor = {
      message: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      updateToolCall: (_toolCallID, update) =>
        Effect.sync(() => {
          const next = update(state)
          state.state = next.state
          if (state.state.status === "running") updates.push(state.state.time.start)
          return state
        }),
      completeToolCall: () => Effect.void,
    } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">

    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const execute = tools.timing.execute
    if (!execute) throw new Error("timing tool is missing execute")

    yield* Effect.promise(() =>
      execute(
        {},
        {
          toolCallId: callID,
          abortSignal: new AbortController().signal,
          messages: [],
        },
      ),
    )

    expect(updates).toEqual([100, 100])
    expect(state.state.status).toBe("running")
    if (state.state.status === "running") {
      expect(state.state.time.start).toBe(100)
    }
  }),
)

it.effect("sandbox gate checks every pattern, not just the first", () =>
  Effect.gen(function* () {
    const processor = {
      message: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/repo", root: "/repo" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      updateToolCall: () => Effect.succeed(undefined),
      completeToolCall: () => Effect.void,
    } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">

    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, directory: "/repo", permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const execute = tools.writer.execute
    if (!execute) throw new Error("writer tool is missing execute")

    const exit = yield* Effect.exit(
      Effect.promise(() =>
        execute(
          {},
          {
            toolCallId: callID,
            abortSignal: new AbortController().signal,
            messages: [],
          },
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const err = Cause.squash(exit.cause)
      expect(err).toBeInstanceOf(Sandbox.SandboxViolationError)
      expect((err as Sandbox.SandboxViolationError).path).toBe("/etc/passwd")
      expect((err as Error).message).toContain("/etc/passwd")
    }
  }),
)

it.effect("sandbox contains external_directory for write tools but not reads", () =>
  Effect.gen(function* () {
    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, directory: "/repo", permission: [] } as unknown as Session.Info,
      processor: {
        message: { id: messageID, sessionID } as SessionV1.Assistant,
        updateToolCall: () => Effect.succeed(undefined),
        completeToolCall: () => Effect.void,
      },
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const call = (name: string) => {
      const execute = tools[name]?.execute
      if (!execute) throw new Error(`${name} tool is missing execute`)
      return Effect.exit(
        Effect.promise(() =>
          execute({}, { toolCallId: callID, abortSignal: new AbortController().signal, messages: [] }),
        ),
      )
    }

    expect(Exit.isSuccess(yield* call("read"))).toBe(true)
    const write = yield* call("write")
    expect(Exit.isFailure(write)).toBe(true)
    if (Exit.isFailure(write)) {
      const err = Cause.squash(write.cause)
      expect(err).toBeInstanceOf(Sandbox.SandboxViolationError)
      expect((err as Error).message).toContain("/etc/*")
      expect((err as Error).message).toContain("workspace-write")
    }
  }),
)

it.effect("workspace-write allows edits inside a session's attached additional directory", () =>
  Effect.gen(function* () {
    const instanceCtx = {
      directory: "/repo",
      worktree: "/repo",
      project: { id: "p_test" } as Project.Info,
      additionalDirectories: ["/extra"],
    } satisfies InstanceContext
    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, directory: "/repo", permission: [] } as unknown as Session.Info,
      processor: {
        message: { id: messageID, sessionID } as SessionV1.Assistant,
        updateToolCall: () => Effect.succeed(undefined),
        completeToolCall: () => Effect.void,
      },
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    }).pipe(
      Effect.provideService(InstanceRef, instanceCtx),
      Effect.provide(Layer.mock(SessionFolders.Service, { list: () => Effect.succeed([AbsolutePath.make("/extra")]) })),
    )
    const call = (name: string) => {
      const execute = tools[name]?.execute
      if (!execute) throw new Error(`${name} tool is missing execute`)
      return Effect.exit(
        Effect.promise(() => execute({}, { toolCallId: callID, abortSignal: new AbortController().signal, messages: [] })),
      )
    }

    // The attached extra directory is inside this session's boundaries.
    expect(Exit.isSuccess(yield* call("extra-writer"))).toBe(true)
    // Writes outside every boundary still fail, even with extras attached.
    const blocked = yield* call("writer")
    expect(Exit.isFailure(blocked)).toBe(true)
    if (Exit.isFailure(blocked)) {
      const err = Cause.squash(blocked.cause)
      expect(err).toBeInstanceOf(Sandbox.SandboxViolationError)
      expect((err as Sandbox.SandboxViolationError).path).toBe("/etc/passwd")
    }
  }),
)

describe("resolveEffectiveArgs", () => {
  test("malformed bash rewrite keeps original args with a warning", () => {
    const original = { command: "ls" }
    const resolved = SessionTools.resolveEffectiveArgs("bash", original, {
      behavior: "allow",
      updatedInput: { command: 42 },
    })
    expect(resolved.effective).toBe(original)
    expect(resolved.warning).toContain("bash command must be a string")
  })

  test("well-formed rewrite replaces args without a warning", () => {
    const resolved = SessionTools.resolveEffectiveArgs("bash", { command: "ls" }, {
      behavior: "allow",
      updatedInput: { command: "ls --safe" },
    })
    expect(resolved.effective).toEqual({ command: "ls --safe" })
    expect(resolved.warning).toBeUndefined()
  })
})

// Auto-approval ("auto") environments: a recording permission service, the
// auto approval policy, and an optional AutoReviewer stub with a fixed
// verdict. When `verdict` is undefined no reviewer layer is provided at all.
function autoLayer(verdict: "allow" | "deny" | "defer" | undefined) {
  const asks: PermissionV1.AskInput[] = []
  return {
    asks,
    it: testEffect(
      Layer.mergeAll(
        Layer.mock(SessionFolders.Service, { list: () => Effect.succeed([]) }),
        Layer.succeed(Plugin.Service, fakePlugin),
        testLayerWithHooks([]),
        Layer.succeed(
          Permission.Service,
          Permission.Service.of({
            ask: (input) =>
              Effect.sync(() => {
                asks.push(input)
              }),
            reply: () => Effect.void,
            list: () => Effect.succeed([]),
          } satisfies Permission.Interface),
        ),
        Layer.succeed(
          Config.Service,
          Config.Service.of({
            get: () => Effect.succeed({ permission: { approval: "auto" } }),
          } as Partial<Config.Interface> as Config.Interface),
        ),
        Layer.succeed(Project.Service, fakeProject),
        Layer.succeed(MCP.Service, fakeMcp()),
        Layer.succeed(Truncate.Service, fakeTruncate),
        RuntimeFlags.layer(),
        ...(verdict === undefined
          ? []
          : [Layer.succeed(AutoReviewer.Service, AutoReviewer.Service.of({ request: () => Effect.succeed(verdict) }))]),
        Layer.succeed(
          ToolRegistry.Service,
          ToolRegistry.Service.of({
            ids: () => Effect.succeed(["asker"]),
            all: () => Effect.succeed([]),
            named: () => Effect.die("unused"),
            tools: () =>
              Effect.succeed([
                {
                  id: "asker",
                  description: "asks bash permission",
                  parameters: Schema.Struct({}),
                  jsonSchema: { type: "object", properties: {} },
                  execute: (_args, ctx) =>
                    Effect.gen(function* () {
                      yield* ctx.ask({
                        permission: "bash",
                        patterns: ["git status"],
                        metadata: {},
                        always: [],
                      })
                      return { title: "asker", metadata: {}, output: "done" }
                    }),
                } satisfies Tool.Def,
              ]),
          }),
        ),
      ),
    ),
  }
}

const resolveAsker = () =>
  Effect.gen(function* () {
    const processor = {
      message: { id: messageID, sessionID } as SessionV1.Assistant,
      updateToolCall: () => Effect.succeed(undefined),
      completeToolCall: () => Effect.void,
    }
    return yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
  })

const runAsker = () =>
  Effect.gen(function* () {
    const tools = yield* resolveAsker()
    const execute = tools.asker?.execute
    if (!execute) throw new Error("asker tool is missing execute")
    return yield* Effect.exit(
      Effect.promise(() => execute({}, { toolCallId: callID, abortSignal: new AbortController().signal, messages: [] })),
    )
  })

const allowEnv = autoLayer("allow")
allowEnv.it.effect("auto approval lets the LLM reviewer approve without prompting", () =>
  Effect.gen(function* () {
    const exit = yield* runAsker()
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(allowEnv.asks.length).toBe(1)
    expect(allowEnv.asks[0]?.reviewer).toBe("allow")
  }),
)

const denyEnv = autoLayer("deny")
denyEnv.it.effect("auto approval fails closed when the LLM reviewer denies", () =>
  Effect.gen(function* () {
    const exit = yield* runAsker()
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.DeniedError)
    }
    expect(denyEnv.asks.length).toBe(0)
  }),
)

const deferEnv = autoLayer("defer")
deferEnv.it.effect("auto approval falls back to the human prompt on reviewer defer", () =>
  Effect.gen(function* () {
    const exit = yield* runAsker()
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(deferEnv.asks.length).toBe(1)
    expect(deferEnv.asks[0]?.reviewer).toBe("defer")
  }),
)

const absentEnv = autoLayer(undefined)
absentEnv.it.effect("auto approval defers when the reviewer service is unavailable", () =>
  Effect.gen(function* () {
    const exit = yield* runAsker()
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(absentEnv.asks.length).toBe(1)
    expect(absentEnv.asks[0]?.reviewer).toBe("defer")
  }),
)

// Per-agent sandbox-mode override: the resolution precedence is session
// metadata (task-dispatched children) → agent config → global policy.
const sandboxConfig = (agent: NonNullable<Partial<ConfigV1.Info>["agent"]>) => ({
  permission: { sandbox: "workspace-write" as const },
  agent,
})

function sandboxEnv(config: Partial<ConfigV1.Info>, metadata?: Record<string, unknown>) {
  const registry = ToolRegistry.Service.of({
    ids: () => Effect.succeed(["asker", "writer"]),
    all: () => Effect.succeed([]),
    named: () => Effect.die("unused"),
    tools: () =>
      Effect.succeed([
        {
          id: "asker",
          description: "asks bash permission",
          parameters: Schema.Struct({}),
          jsonSchema: { type: "object", properties: {} },
          execute: (_args, ctx) =>
            Effect.gen(function* () {
              yield* ctx.ask({ permission: "bash", patterns: ["git status"], metadata: {}, always: [] })
              return { title: "asker", metadata: {}, output: "done" }
            }),
        } satisfies Tool.Def,
        {
          id: "writer",
          description: "asks edit permission outside the workspace",
          parameters: Schema.Struct({}),
          jsonSchema: { type: "object", properties: {} },
          execute: (_args, ctx) =>
            Effect.gen(function* () {
              yield* ctx.ask({ permission: "edit", patterns: ["/etc/passwd"], metadata: {}, always: [] })
              return { title: "writer", metadata: {}, output: "done" }
            }),
        } satisfies Tool.Def,
      ]),
  })
  const session = {
    id: sessionID,
    directory: "/repo",
    permission: [],
    ...(metadata ? { metadata } : {}),
  } as unknown as Session.Info
  return {
    session,
    it: testEffect(
      Layer.mergeAll(
        Layer.mock(SessionFolders.Service, { list: () => Effect.succeed([]) }),
        Layer.succeed(Plugin.Service, fakePlugin),
        testLayerWithHooks([]),
        Layer.succeed(Permission.Service, fakePermission),
        Layer.succeed(
          Config.Service,
          Config.Service.of({
            get: () => Effect.succeed(config),
          } as Partial<Config.Interface> as Config.Interface),
        ),
        Layer.succeed(Project.Service, fakeProject),
        Layer.succeed(MCP.Service, fakeMcp()),
        Layer.succeed(Truncate.Service, fakeTruncate),
        RuntimeFlags.layer(),
        Layer.succeed(ToolRegistry.Service, registry),
      ),
    ),
  }
}

const sandboxProcessor = {
  message: { id: messageID, sessionID } as SessionV1.Assistant,
  updateToolCall: () => Effect.succeed(undefined),
  completeToolCall: () => Effect.void,
} satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">

const runSandboxTool = (env: ReturnType<typeof sandboxEnv>, name: string) =>
  Effect.gen(function* () {
    const tools = yield* SessionTools.resolve({
      agent,
      model,
      session: env.session,
      processor: sandboxProcessor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const execute = tools[name]?.execute
    if (!execute) throw new Error(`${name} tool is missing execute`)
    return yield* Effect.exit(
      Effect.promise(() => execute({}, { toolCallId: callID, abortSignal: new AbortController().signal, messages: [] })),
    )
  })

{
  const env = sandboxEnv(sandboxConfig({ build: { sandbox: "readonly" } }))
  env.it.effect("agent config sandbox overrides the global policy", () =>
    Effect.gen(function* () {
      const exit = yield* runSandboxTool(env, "asker")
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).toBeInstanceOf(Sandbox.SandboxViolationError)
        expect((err as Error).message).toContain("readonly")
      }
    }),
  )
}

{
  const env = sandboxEnv(sandboxConfig({ build: { sandbox: "readonly" } }), { sandbox: "workspace-write" })
  env.it.effect("session metadata beats the agent config sandbox", () =>
    Effect.gen(function* () {
      expect(Exit.isSuccess(yield* runSandboxTool(env, "asker"))).toBe(true)
    }),
  )
}

{
  const env = sandboxEnv({}, { sandbox: "readonly" })
  env.it.effect("session metadata beats the global policy", () =>
    Effect.gen(function* () {
      const exit = yield* runSandboxTool(env, "asker")
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(Sandbox.SandboxViolationError)
      }
    }),
  )
}

{
  const env = sandboxEnv(sandboxConfig({ build: { sandbox: "full-access" } }))
  env.it.effect("agent config sandbox widens to full-access", () =>
    Effect.gen(function* () {
      expect(Exit.isSuccess(yield* runSandboxTool(env, "writer"))).toBe(true)
    }),
  )
}

{
  const env = sandboxEnv(sandboxConfig({ build: { sandbox: "restricted" } }))
  env.it.effect("agent config named profile keeps the global policy level", () =>
    Effect.gen(function* () {
      const exit = yield* runSandboxTool(env, "writer")
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect((Cause.squash(exit.cause) as Error).message).toContain("workspace-write")
      }
    }),
  )
}
