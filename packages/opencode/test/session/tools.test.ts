import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
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
import { Plugin } from "@/plugin"
import { HooksRunner } from "@/hooks/runner"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Effect, Cause, Exit, Layer, Schema } from "effect"
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
  Layer.succeed(Plugin.Service, fakePlugin),
  HooksRunner.testLayerWithHooks([]),
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
