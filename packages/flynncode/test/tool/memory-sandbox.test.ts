import { expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Global } from "@flynncode/core/global"
import { SessionProjector } from "@flynncode/core/session/projector"
import { SessionFolders } from "@flynncode/core/session/folders"
import { ProviderV2 } from "@flynncode/core/provider"
import { ModelV2 } from "@flynncode/core/model"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import { SessionTools } from "@/session/tools"
import { MessageID } from "@/session/schema"
import { ToolRegistry } from "@/tool/registry"
import { Memory } from "@/memory/memory"
import { Permission } from "@/permission"
import { Sandbox } from "@/permission/sandbox"
import { HooksRunner } from "@/hooks/runner"
import { Provider } from "@/provider/provider"
import { MCP } from "@/mcp"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import type { Tool } from "ai"

const it = testEffect(LayerNode.compile(CrossSpawnSpawner.node))
const env = (dir: string, data: string) => LayerNode.compile(LayerNode.group([
  Agent.node, Config.node, Project.node, Session.node, SessionProjector.node, SessionFolders.node,
  ToolRegistry.node, Memory.node, Permission.node, HooksRunner.node, Provider.node, MCP.node, Truncate.node, RuntimeFlags.node,
]), [
  [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })],
  [Global.node, Global.layerWith({ home: dir, config: dir, data })],
  [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  [MCP.node, Layer.mock(MCP.Service, { clients: () => Effect.succeed({}), tools: () => Effect.succeed({}), instructions: () => Effect.succeed([]) })],
])
const fixture = <A, E, R>(body: Effect.Effect<A, E, R>) => provideTmpdirInstance(dir => Effect.gen(function* () {
  const data = yield* tmpdirScoped()
  yield* body.pipe(Effect.provide(env(dir, data)))
}), { git: true, config: { memory: { enabled: true }, lsp: false, formatter: false, provider: { test: { npm: "@ai-sdk/openai-compatible", models: { "test-model": { name: "Test", limit: { context: 100000, output: 10000 } } } } } } })

const setup = (consent = false) => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ permission: [{ permission: "memory", pattern: "*", action: consent ? "ask" : "allow" }] })
  const agents = yield* Agent.Service
  const agent = yield* agents.get("build")
  if (!agent) throw new Error("missing build")
  const providers = yield* Provider.Service
  const model = yield* providers.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
  const resolve = (sandbox: "readonly" | "workspace-write" | "full-access") => SessionTools.resolve({
    agent, model, session: { ...session, metadata: { sandbox } }, messages: [], bypassAgentCheck: false, promptOps: {} as never,
    processor: { message: { id: MessageID.ascending(), sessionID: session.id } as never, updateToolCall: () => Effect.void as never, completeToolCall: () => Effect.void },
  })
  const call = (tools: Record<string, Tool>, action: "save" | "remove", scope: "project" | "global", slug = "topic") => Effect.promise(() => {
    const execute = tools.memory?.execute
    if (!execute) throw new Error("missing memory")
    return execute({ action, scope, slug, text: "new convention" }, { toolCallId: "call-memory", messages: [], abortSignal: new AbortController().signal })
  })
  return { resolve, call, session }
})

for (const sandbox of ["readonly", "workspace-write"] as const) {
  it.live(`${sandbox} rejects memory writes outside its authority before consent`, () => fixture(Effect.gen(function* () {
    const { resolve, call } = yield* setup()
    const memory = yield* Memory.Service
    const permission = yield* Permission.Service
    for (const scope of sandbox === "readonly" ? ["project", "global"] as const : ["global"] as const) {
      yield* memory.update({ scope, slug: "topic", text: "original" })
      const tools = yield* resolve(sandbox)
      for (const action of ["save", "remove"] as const) {
        const exit = yield* call(tools, action, scope).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Sandbox.SandboxViolationError)
        expect(yield* permission.list()).toEqual([])
      }
      expect((yield* memory.load()).map(item => item.content).join("\n")).toContain("original")
    }
  })))
}

for (const [sandbox, scope] of [["workspace-write", "project"], ["full-access", "global"]] as const) {
  it.live(`${sandbox} permits ${scope} memory only after dedicated sticky consent`, () => fixture(Effect.gen(function* () {
    const { resolve, call, session } = yield* setup(true)
    const permission = yield* Permission.Service
    const tools = yield* resolve(sandbox)
    const save = yield* call(tools, "save", scope).pipe(Effect.forkChild)
    const pending = yield* pollWithTimeout(permission.list().pipe(Effect.map(list => list[0])), "memory consent missing")
    expect(pending.permission).toBe("memory")
    expect(pending.patterns).toEqual([scope])
    expect(pending.always).toEqual([scope])
    yield* permission.reply({ requestID: pending.id, reply: "always" })
    yield* Fiber.join(save)
    yield* call(tools, "save", scope, "second")
    const readonly = yield* resolve("readonly")
    expect(Exit.isFailure(yield* call(readonly, "remove", scope).pipe(Effect.exit))).toBe(true)
    const memory = yield* Memory.Service
    if (scope === "global") {
      const workspace = yield* resolve("workspace-write")
      expect(Exit.isFailure(yield* call(workspace, "remove", scope).pipe(Effect.exit))).toBe(true)
      const folders = yield* SessionFolders.Service
      yield* folders.replace(session.id, [yield* memory.globalDir()])
      const attached = yield* resolve("workspace-write")
      yield* call(attached, "save", scope, "attached")
      yield* call(attached, "remove", scope, "attached")
    }
    yield* call(tools, "remove", scope)
    expect(yield* memory.load()).toHaveLength(1)
    expect(yield* permission.list()).toEqual([])
  })))
}
