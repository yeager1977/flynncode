import { expect } from "bun:test"
import { PermissionV1 } from "@flynncode/core/v1/permission"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { HooksRunner } from "../../src/hooks/runner"
import { testLayerWithHooks } from "../lib/hooks"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import type { Hooks } from "@flynncode/plugin"
import { AppNodeBuilder } from "@flynncode/core/effect/app-node-builder"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { testEffect } from "../lib/effect"
import path from "path"
import { pathToFileURL } from "url"
import { Plugin } from "../../src/plugin/index"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { TestInstance } from "../fixture/fixture"
import { Auth } from "../../src/auth"
import { AuthTest } from "../fake/auth"
import { Account } from "../../src/account/account"
import { AccountTest } from "../fake/account"
import { Npm } from "@flynncode/core/npm"
import { NpmTest } from "../fake/npm"
import { Session } from "@/session/session"
import { SessionProjector } from "@flynncode/core/session/projector"
import { SessionFolders } from "@flynncode/core/session/folders"
import { SessionTools } from "@/session/tools"
import { Agent } from "@/agent/agent"
import { Project } from "@/project/project"
import { Config } from "@/config/config"
import { ToolRegistry } from "@/tool/registry"
import { MCP } from "@/mcp"
import { Truncate } from "@/tool/truncate"
import { Provider } from "@/provider/provider"
import { ProviderV2 } from "@flynncode/core/provider"
import { ModelV2 } from "@flynncode/core/model"
import { MessageID } from "@/session/schema"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

const askCalls: Array<Record<string, unknown>> = []
const fallthroughCalls: Array<Record<string, unknown>> = []
const toolPermissionCalls: Array<Record<string, unknown>> = []

const envWithHooks = (hooks: Array<Hooks>) =>
  AppNodeBuilder.build(
    LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
    [
      [InstanceStore.bootstrapNode, noopBootstrap],
      [HooksRunner.node, testLayerWithHooks(hooks)],
    ],
  )

const denyEnv = envWithHooks([
  {
    "permission.ask": async (input, output) => {
      askCalls.push(input as unknown as Record<string, unknown>)
      output.status = "deny"
    },
  },
  {
    "tool.permission": async (input, output) => {
      toolPermissionCalls.push(input as unknown as Record<string, unknown>)
      output.decision = "allow"
    },
  },
])
const denyIt = testEffect(denyEnv)

const allowEnv = envWithHooks([
  {
    "permission.ask": async (input, output) => {
      fallthroughCalls.push(input as unknown as Record<string, unknown>)
      output.status = "allow"
    },
  },
])
const allowIt = testEffect(allowEnv)

const denyWinsEnv = envWithHooks([
  {
    "permission.ask": async (_input, output) => {
      output.status = "allow"
    },
  },
  {
    "permission.ask": async (_input, output) => {
      output.status = "deny"
    },
  },
])
const denyWinsIt = testEffect(denyWinsEnv)

const askStatusEnv = envWithHooks([
  {
    "permission.ask": async (_input, output) => {
      output.status = "ask"
    },
  },
])
const askStatusIt = testEffect(askStatusEnv)

const throwEnv = envWithHooks([
  {
    "permission.ask": async (_input, _output) => {
      throw new Error("plugin permission.ask hook crashed")
    },
  },
])
const throwIt = testEffect(throwEnv)

// Production coverage: the tests above run the in-memory stub double; this
// environment installs the real Plugin machinery so the aggregation and the
// hook payload built by Plugin.triggerPermissionAsk are exercised end to end
// through HooksRunner, exactly as Permission.ask consumes it in production.
const prodEnv = AppNodeBuilder.build(
  LayerNode.group([Plugin.node, Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node,
    Session.node, SessionProjector.node, SessionFolders.node, Agent.node, Project.node, Config.node,
    ToolRegistry.node, MCP.node, Truncate.node, Provider.node, HooksRunner.node, RuntimeFlags.node]),
  [
    [InstanceStore.bootstrapNode, noopBootstrap],
    [Auth.node, Layer.mock(Auth.Service, { all: () => Effect.succeed({}), get: () => Effect.succeed(undefined) })],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
    [MCP.node, Layer.mock(MCP.Service, { clients: () => Effect.succeed({}), tools: () => Effect.succeed({}), instructions: () => Effect.succeed([]) })],
  ],
)
const prodIt = testEffect(prodEnv)

const request = (ruleset: PermissionV1.Rule[]) => ({
  sessionID: SessionID.make("session_test"),
  permission: "bash",
  patterns: ["rm -rf build"],
  metadata: {},
  always: [],
  ruleset,
  hook: { tool: "bash", args: { command: "rm -rf build" } },
})

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const list = yield* Effect.gen(function* () {
      while (true) {
        const pending = yield* permission.list()
        if (pending.length === count) return pending
        yield* Effect.sleep("10 millis")
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () => Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`)),
      }),
    )
    return list
  })

const failOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    throw new Error("expected the effect to fail")
  })

const subscribeAsked = () =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    let asked = 0
    const unsub = yield* events.listen(() => Effect.sync(() => asked++))
    yield* Effect.addFinalizer(() => unsub)
    return () => asked
  })

// Writes the plugin module and its config registration into the test
// instance directory, then runs the body (trigger.test.ts harness style).
const withPlugin = <A, E, R>(
  source: (dir: string) => string,
  self: (dir: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const file = path.join(test.directory, "plugin.ts")
    yield* Effect.all(
      [
        Effect.promise(() => Bun.write(file, source(test.directory))),
        Effect.promise(() =>
          Bun.write(
            path.join(test.directory, "opencode.json"),
            JSON.stringify({ plugin: [pathToFileURL(file).href] }, null, 2),
          ),
        ),
      ],
      { discard: true, concurrency: 2 },
    )
    return yield* self(test.directory)
  })

denyIt.instance(
  "a plugin permission.ask deny is evaluated before the approval auto shortcut",
  () =>
    Effect.gen(function* () {
      askCalls.length = 0
      const permission = yield* Permission.Service
      // reviewer "allow" would auto-approve under approval "auto"; the plugin
      // hook runs first, so its deny must win anyway.
      const error = yield* failOf(permission.ask({ ...request([]), approval: "auto", reviewer: "allow" }))
      expect(error).toBeInstanceOf(PermissionV1.DeniedError)
      expect(askCalls).toHaveLength(1)
      expect(yield* permission.list()).toHaveLength(0)
    }),
)

denyIt.instance(
  "a plugin permission.ask deny is evaluated before the accept-edits shortcut",
  () =>
    Effect.gen(function* () {
      askCalls.length = 0
      const permission = yield* Permission.Service
      // "edit" is auto-approved under accept-edits; the plugin hook runs first.
      const error = yield* failOf(
        permission.ask({ ...request([]), permission: "edit", approval: "accept-edits" }),
      )
      expect(error).toBeInstanceOf(PermissionV1.DeniedError)
      expect(askCalls).toHaveLength(1)
      expect(yield* permission.list()).toHaveLength(0)
    }),
)

denyIt.instance(
  "a plugin permission.ask deny wins for an always-ask tool",
  () =>
    Effect.gen(function* () {
      askCalls.length = 0
      const permission = yield* Permission.Service
      const error = yield* failOf(permission.ask({ ...request([]), permission: "computer_use", approval: "auto" }))
      expect(error).toBeInstanceOf(PermissionV1.DeniedError)
      expect(askCalls).toHaveLength(1)
    }),
)

denyIt.instance(
  "a plugin permission.ask deny short-circuits the prompt",
  () =>
    Effect.gen(function* () {
      askCalls.length = 0
      toolPermissionCalls.length = 0
      const permission = yield* Permission.Service
      const countAsked = yield* subscribeAsked()
      const error = yield* failOf(permission.ask(request([])))
      expect(error).toBeInstanceOf(PermissionV1.DeniedError)
      expect(yield* permission.list()).toHaveLength(0)
      // The plugin ask hook runs before the PermissionRequest hook: the
      // tool.permission hook never answered, and no prompt was published.
      expect(countAsked()).toBe(0)
      expect(toolPermissionCalls).toHaveLength(0)
      expect(askCalls).toHaveLength(1)
      expect(askCalls[0]).toMatchObject({
        permission: "bash",
        patterns: ["rm -rf build"],
        sessionID: SessionID.make("session_test"),
        tool: "bash",
        args: { command: "rm -rf build" },
      })
    }),
)

denyIt.instance(
  "a config deny is evaluated before the plugin permission.ask hook",
  () =>
    Effect.gen(function* () {
      askCalls.length = 0
      toolPermissionCalls.length = 0
      const permission = yield* Permission.Service
      const error = yield* failOf(permission.ask(request([{ permission: "bash", pattern: "rm *", action: "deny" }])))
      expect(error).toBeInstanceOf(PermissionV1.DeniedError)
      expect(askCalls).toHaveLength(0)
      expect(yield* permission.list()).toHaveLength(0)
    }),
)

denyWinsIt.instance(
  "a plugin permission.ask deny wins over an earlier plugin allow",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const error = yield* failOf(permission.ask(request([])))
      expect(error).toBeInstanceOf(PermissionV1.DeniedError)
      expect(yield* permission.list()).toHaveLength(0)
    }),
)

allowIt.instance(
  "a plugin permission.ask allow falls through to the pending prompt",
  () =>
    Effect.gen(function* () {
      fallthroughCalls.length = 0
      const permission = yield* Permission.Service
      const countAsked = yield* subscribeAsked()
      const fiber = yield* permission.ask(request([])).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)
      expect(pending).toHaveLength(1)
      expect(countAsked()).toBe(1)
      expect(fallthroughCalls).toHaveLength(1)
      yield* permission.reply({ requestID: pending[0].id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
    }),
)

askStatusIt.instance(
  "a plugin permission.ask ask status falls through to the pending prompt",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const fiber = yield* permission.ask(request([])).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)
      expect(pending).toHaveLength(1)
      yield* permission.reply({ requestID: pending[0].id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      // Fail open: the ask status reaches the user, no DeniedError.
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
    }),
)

throwIt.instance(
  "a throwing plugin permission.ask hook fails open to the prompt",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const fiber = yield* permission.ask(request([])).pipe(Effect.forkScoped)
      const pending = yield* waitForPending(1)
      expect(pending).toHaveLength(1)
      // Fail open: a crashing hook cannot deny by throwing. The prompt the
      // user would see is reached, so the reply is a user RejectedError,
      // never the plugin's crash or a DeniedError.
      yield* permission.reply({ requestID: pending[0].id, reply: "reject" })
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
    }),
)

const prodRecorderSource = (mark: string) =>
  [
    "export const deny = async () => ({",
    '  "permission.ask": async (input, output) => {',
    `    const mark = ${JSON.stringify(mark)}`,
    '    const prev = await Bun.file(mark).text().catch(() => "")',
    "    await Bun.write(mark, prev + JSON.stringify({ keys: Object.keys(input), input }) + \"\\n\")",
    '    output.status = "deny"',
    "  },",
    "})",
    "",
  ].join("\n")

for (const approval of ["manual", "auto", "accept-edits"] as const) {
  prodIt.instance(`production: ${approval} static read shortcuts cannot bypass plugin deny for would-ask calls`, () =>
    withPlugin(dir => prodRecorderSource(path.join(dir, "marks.jsonl")), dir => Effect.gen(function* () {
      const file = path.join(dir, "safe.txt")
      yield* Effect.promise(() => Bun.write(file, "safe"))
      const plugin = pathToFileURL(path.join(dir, "plugin.ts")).href
      yield* Effect.promise(() => Bun.write(path.join(dir, "opencode.json"), JSON.stringify({
        plugin: [plugin], permission: { approval }, lsp: false, formatter: false,
        provider: { test: { npm: "@ai-sdk/openai-compatible", models: { "test-model": { name: "Test", limit: { context: 100000, output: 10000 } } } } },
      })))
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ permission: [{ permission: "*", pattern: "*", action: "ask" }] })
      const agents = yield* Agent.Service
      const agent = yield* agents.get("build")
      if (!agent) throw new Error("missing build")
      const providers = yield* Provider.Service
      const model = yield* providers.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
      const tools = yield* SessionTools.resolve({ agent, model, session, messages: [], bypassAgentCheck: false, promptOps: {} as never,
        processor: { message: { id: MessageID.ascending(), sessionID: session.id } as never, updateToolCall: () => Effect.void as never, completeToolCall: () => Effect.void } })
      for (const [name, args] of [["read", { filePath: file }], ["glob", { pattern: "*.txt", path: dir }], ["grep", { pattern: "safe", path: dir }]] as const) {
        const execute = tools[name].execute
        if (!execute) throw new Error(`missing ${name}`)
        const error = yield* failOf(Effect.promise(() => execute(args, { toolCallId: `call-${name}`, messages: [], abortSignal: new AbortController().signal })))
        expect(error).toBeInstanceOf(PermissionV1.DeniedError)
      }
      const permission = yield* Permission.Service
      // A config-allowed list never asks, so the plugin deny hook is skipped and it succeeds.
      yield* permission.ask({ ...request([{ permission: "list", pattern: "*", action: "allow" }]), permission: "list", approval })
      expect(yield* permission.list()).toEqual([])
    })),
  )
}

denyIt.instance("explicit config allow skips plugin permission.ask hooks", () => Effect.gen(function* () {
  askCalls.length = 0
  const permission = yield* Permission.Service
  yield* permission.ask(request([{ permission: "bash", pattern: "*", action: "allow" }]))
  expect(askCalls).toHaveLength(0)
}))

denyIt.instance("a rule-allowed request never invokes plugin permission.ask hooks", () =>
  Effect.gen(function* () {
    askCalls.length = 0
    const permission = yield* Permission.Service
    for (const approval of ["manual", "accept-edits", "auto"] as const)
      yield* permission.ask({ ...request([{ permission: "*", pattern: "*", action: "allow" }]), approval })
    expect(askCalls).toHaveLength(0)
    expect(yield* permission.list()).toHaveLength(0)
  }),
)

denyIt.instance("a plugin deny beats staticApproval for a call that would ask", () =>
  Effect.gen(function* () {
    askCalls.length = 0
    const permission = yield* Permission.Service
    const error = yield* failOf(
      permission.ask({ ...request([{ permission: "bash", pattern: "*", action: "ask" }]), staticApproval: "allow" }),
    )
    expect(error).toBeInstanceOf(PermissionV1.DeniedError)
    expect(askCalls).toHaveLength(1)
  }),
)

prodIt.instance("production: static read approval remains cheap without a plugin deny", () =>
  withPlugin(() => "export const noop = async () => ({})", () => Effect.gen(function* () {
    const permission = yield* Permission.Service
    yield* permission.ask({ ...request([{ permission: "read", pattern: "*", action: "ask" }]), permission: "read", staticApproval: "allow" })
    expect(yield* permission.list()).toEqual([])
  })),
)

prodIt.instance(
  "production: plugin deny short-circuits the prompt and wins over an earlier plugin allow",
  () =>
    withPlugin(
      () =>
        [
          "export const allow = async () => ({",
          '  "permission.ask": (_input, output) => {',
          '    output.status = "allow"',
          "  },",
          "})",
          "export const deny = async () => ({",
          '  "permission.ask": (_input, output) => {',
          '    output.status = "deny"',
          "  },",
          "})",
          "",
        ].join("\n"),
      () =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          const error = yield* failOf(permission.ask(request([])))
          expect(error).toBeInstanceOf(PermissionV1.DeniedError)
          expect(yield* permission.list()).toHaveLength(0)
        }),
    ),
)

prodIt.instance(
  "production: a throwing plugin hook fails open to the prompt",
  () =>
    withPlugin(
      () =>
        [
          "export const crash = async () => ({",
          '  "permission.ask": async (_input, _output) => {',
          '    throw new Error("plugin permission.ask crashed")',
          "  },",
          "})",
          "",
        ].join("\n"),
      () =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          const fiber = yield* permission.ask(request([])).pipe(Effect.forkScoped)
          const pending = yield* waitForPending(1)
          expect(pending).toHaveLength(1)
          yield* permission.reply({ requestID: pending[0].id, reply: "reject" })
          const exit = yield* Fiber.await(fiber)
          expect(Exit.isFailure(exit)).toBe(true)
          // The crash falls open to the user prompt, not a plugin deny.
          if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
        }),
    ),
)

prodIt.instance(
  "production: no-op and ask-status hooks fall through to the pending prompt",
  () =>
    withPlugin(
      () =>
        [
          "export const noop = async () => ({",
          '  "permission.ask": (_input, _output) => {},',
          "})",
          "export const askStands = async () => ({",
          '  "permission.ask": (_input, output) => {',
          '    output.status = "ask"',
          "  },",
          "})",
          "",
        ].join("\n"),
      () =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          const fiber = yield* permission.ask(request([])).pipe(Effect.forkScoped)
          const pending = yield* waitForPending(1)
          expect(pending).toHaveLength(1)
          yield* permission.reply({ requestID: pending[0].id, reply: "reject" })
          const exit = yield* Fiber.await(fiber)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.RejectedError)
        }),
    ),
)

prodIt.instance(
  "production: hook payload carries the ask fields and omits absent response identity",
  () =>
    withPlugin(
      (dir) => prodRecorderSource(path.join(dir, "marks.jsonl")),
      (dir) =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          // Single pattern, no tool call identity.
          const errorOne = yield* failOf(
            permission.ask({
              ...request([]),
              patterns: ["ls"],
            }),
          )
          expect(errorOne).toBeInstanceOf(PermissionV1.DeniedError)
          // Multiple patterns: the singular `pattern` field mirrors the array.
          const errorTwo = yield* failOf(
            permission.ask({
              ...request([]),
              permission: "edit",
              patterns: ["a.ts", "b.ts"],
            }),
          )
          expect(errorTwo).toBeInstanceOf(PermissionV1.DeniedError)
          // Tool call identity present: id/messageID/callID follow the call.
          const errorThree = yield* failOf(
            permission.ask({
              ...request([]),
              tool: { messageID: "msg_y", callID: "call_y" },
              hook: { tool: "bash", args: { command: "git push" } },
            }),
          )
          expect(errorThree).toBeInstanceOf(PermissionV1.DeniedError)

          const lines = (yield* Effect.promise(() => Bun.file(path.join(dir, "marks.jsonl")).text()))
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as { keys: string[]; input: Record<string, unknown> })
          expect(lines).toHaveLength(3)
          expect(lines[0].input).toMatchObject({
            type: "bash",
            permission: "bash",
            patterns: ["ls"],
            pattern: "ls",
            sessionID: "session_test",
            title: "bash",
            tool: "bash",
            args: { command: "rm -rf build" },
          })
          expect((lines[0].input.time as { created: number }).created).toBeGreaterThan(0)
          // No fabricated sentinels: absent identity fields are omitted keys.
          expect(lines[0].keys).not.toContain("id")
          expect(lines[0].keys).not.toContain("messageID")
          expect(lines[0].keys).not.toContain("callID")
          expect(lines[1].input).toMatchObject({
            permission: "edit",
            patterns: ["a.ts", "b.ts"],
            pattern: ["a.ts", "b.ts"],
          })
          expect(lines[1].keys).not.toContain("id")
          expect(lines[2].input).toMatchObject({
            id: "call_y",
            messageID: "msg_y",
            callID: "call_y",
            type: "bash",
            permission: "bash",
            patterns: ["rm -rf build"],
            pattern: "rm -rf build",
            title: "bash",
            tool: "bash",
            args: { command: "git push" },
          })
          for (const key of ["id", "messageID", "callID", "tool", "args"]) {
            expect(lines[2].keys).toContain(key)
          }
        }),
    ),
)
