import { expect } from "bun:test"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { SessionFolders } from "@flynncode/core/session/folders"
import { SessionProjector } from "@flynncode/core/session/projector"
import { ProviderV2 } from "@flynncode/core/provider"
import { ModelV2 } from "@flynncode/core/model"
import { Agent } from "@/agent/agent"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceRef } from "@/effect/instance-ref"
import { Session } from "@/session/session"
import { SessionTools } from "@/session/tools"
import { SystemPrompt } from "@/session/system"
import { Instruction } from "@/session/instruction"
import { MessageID } from "@/session/schema"
import { Provider } from "@/provider/provider"
import { ToolRegistry } from "@/tool/registry"
import { Permission } from "@/permission"
import { HooksRunner } from "@/hooks/runner"
import { Project } from "@/project/project"
import { MCP } from "@/mcp"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Config } from "@/config/config"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(LayerNode.group([
  Session.node, SessionProjector.node, SessionFolders.node, ToolRegistry.node, Permission.node, HooksRunner.node,
  Project.node, SystemPrompt.node, Provider.node, CrossSpawnSpawner.node, RuntimeFlags.node,
  Agent.node, InstanceStore.node, Instruction.node, Config.node, MCP.node, Truncate.node,
]), [[InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, { run: Effect.void })], [MCP.node, Layer.mock(MCP.Service, {
  clients: () => Effect.succeed({}), tools: () => Effect.succeed({}), instructions: () => Effect.succeed([]),
})]]))

it.instance("same-directory sessions authorize only their own attachments", () => Effect.gen(function* () {
  const test = yield* TestInstance
  const extraA = yield* tmpdirScoped()
  const extraB = yield* tmpdirScoped()
  yield* Effect.promise(() => Bun.write(path.join(extraA, "file.txt"), "A secret"))
  yield* Effect.promise(() => Bun.write(path.join(extraB, "file.txt"), "B secret"))
  yield* Effect.promise(() => Bun.write(path.join(extraA, "AGENTS.md"), "A instructions"))
  yield* Effect.promise(() => Bun.write(path.join(extraB, "AGENTS.md"), "B instructions"))
  const sessions = yield* Session.Service
  const folders = yield* SessionFolders.Service
  const store = yield* InstanceStore.Service
  const a = yield* sessions.create({ additionalDirectories: [extraA], permission: [{ permission: "external_directory", pattern: "*", action: "deny" }] })
  const b = yield* sessions.create({ additionalDirectories: [extraB], permission: [{ permission: "external_directory", pattern: "*", action: "deny" }] })
  const shared = yield* store.setAdditionalDirectories(test.directory, yield* folders.forDirectory(test.directory))
  expect(shared.additionalDirectories).toEqual([extraA, extraB])
  const agents = yield* Agent.Service
  const providers = yield* Provider.Service
  const model = yield* providers.getModel(ProviderV2.ID.make("test"), ModelV2.ID.make("test-model"))
  const agent = yield* agents.get("build")
  if (!agent) throw new Error("missing build agent")
  for (const [owner, own, other] of [[a, extraA, extraB], [b, extraB, extraA]] as const) {
    const tools = yield* SessionTools.resolve({
      agent, model, session: owner, messages: [], bypassAgentCheck: false, promptOps: {} as never,
      processor: { message: { id: MessageID.ascending(), sessionID: owner.id } as never, updateToolCall: () => Effect.void as never, completeToolCall: () => Effect.void },
    }).pipe(Effect.provideService(InstanceRef, shared))
    const call = (name: string, args: Record<string, unknown>) => Effect.promise(() => {
      const execute = tools[name]?.execute
      if (!execute) throw new Error(`missing ${name}`)
      return execute(args, { toolCallId: "call-folder", messages: [], abortSignal: new AbortController().signal })
    })
    expect(yield* call("read", { filePath: path.join(own, "file.txt") })).toMatchObject({ output: expect.stringContaining("secret") })
    for (const [name, args] of [
      ["read", { filePath: path.join(other, "file.txt") }],
      ["glob", { path: other, pattern: "*.txt" }],
      ["grep", { path: other, pattern: "secret" }],
      ["bash", { workdir: other, command: "pwd" }],
      ["write", { filePath: path.join(other, "write.txt"), content: "forbidden" }],
    ] as const) {
      const result = yield* call(name, args).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(String(Cause.squash(result.cause))).toMatch(/denied|sandbox/i)
    }
    yield* call("write", { filePath: path.join(own, "write.txt"), content: "authorized" })
    expect(yield* Effect.promise(() => Bun.file(path.join(own, "write.txt")).text())).toBe("authorized")
    const system = yield* SystemPrompt.Service
    const environment = yield* system.environment(model, owner.id)
    expect(environment.join("\n")).toContain(own)
    expect(environment.join("\n")).not.toContain(other)
    const instruction = yield* Instruction.Service
    expect((yield* instruction.resolve([], path.join(own, "file.txt"), MessageID.ascending(), owner.id)).map(x => x.content).join("\n")).toContain("instructions")
    expect(yield* instruction.resolve([], path.join(other, "file.txt"), MessageID.ascending(), owner.id)).toEqual([])
  }
}), { git: true, config: { formatter: false, lsp: false, permission: { sandbox: "workspace-write", edit: "allow" }, provider: { test: { name: "Test", npm: "@ai-sdk/openai-compatible", models: { "test-model": { name: "Test", limit: { context: 100000, output: 10000 } } } } } } })
