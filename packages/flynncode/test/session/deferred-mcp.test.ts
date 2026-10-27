import { ConfigV1 } from "@flynncode/core/v1/config/config"
import { SessionV1 } from "@flynncode/core/v1/session"
import { PermissionV1 } from "@flynncode/core/v1/permission"
import { Database } from "@flynncode/core/database/database"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { SessionProjector } from "@flynncode/core/session/projector"
import { FSUtil } from "@flynncode/core/fs-util"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { Ripgrep } from "@flynncode/core/ripgrep"
import { ProviderV2 } from "@flynncode/core/provider"
import { ModelV2 } from "@flynncode/core/model"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { EventV2Bridge } from "@/event-v2-bridge"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Agent } from "../../src/agent/agent"
import { Command } from "../../src/command"
import { MCP } from "../../src/mcp"
import { McpLoaded } from "../../src/mcp/loaded"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SystemPrompt } from "../../src/session/system"
import { Skill } from "../../src/skill"
import { Snapshot } from "../../src/snapshot"
import { Format } from "../../src/format"
import { InstanceStore } from "../../src/project/instance-store"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    start: () => Effect.succeed("unavailable"),
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

// The real bootstrap loads config before the test writes opencode.json.
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Env.node,
  Agent.node,
  Command.node,
  Permission.node,
  Plugin.node,
  Config.node,
  Provider.node,
  LSP.node,
  MCP.node,
  FSUtil.node,
  BackgroundJob.node,
  SessionStatus.node,
  SessionRunState.node,
  Database.node,
  EventV2Bridge.node,
  Question.node,
  Todo.node,
  ToolRegistry.node,
  Skill.node,
  Git.node,
  Ripgrep.node,
  Format.node,
  Truncate.node,
  SessionProcessor.node,
  Image.node,
  SessionCompaction.node,
  SessionRevert.node,
  Instruction.node,
  SystemPrompt.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])

function harness(flags: Partial<RuntimeFlags.Info> = {}) {
  return testEffect(
    LayerNode.compile(root, [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, ...flags })],
      [InstanceStore.bootstrapNode, noopBootstrap],
    ]),
  )
}

const it = harness()
const codeMode = harness({ experimentalCodeMode: true })
const disabled = harness({ disableMcpDefer: true })

// A real streamable-HTTP MCP server exposing `count` tools named tool_00, tool_01, ...
function mcpServer(name: string, count: number) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const protocol = new Server({ name, version: "1.0.0" }, { capabilities: { tools: {} } })
      protocol.setRequestHandler(ListToolsRequestSchema, () =>
        Promise.resolve({
          tools: Array.from({ length: count }, (_, index) => ({
            name: `tool_${String(index).padStart(2, "0")}`,
            description: `${name} fixture tool number ${index}`,
            inputSchema: { type: "object" as const, properties: { note: { type: "string" } } },
          })),
        }),
      )
      protocol.setRequestHandler(CallToolRequestSchema, (request) =>
        Promise.resolve({ content: [{ type: "text" as const, text: `called ${name}/${request.params.name}` }] }),
      )
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      await protocol.connect(transport)
      const http = Bun.serve({ port: 0, fetch: (request) => transport.handleRequest(request) })
      return { url: http.url.toString(), protocol, http }
    }),
    (server) =>
      Effect.promise(async () => {
        await server.protocol.close().catch(() => {})
        server.http.stop(true)
      }),
  )
}

// Two servers, 17 MCP tools in total: over the default threshold of 15.
const setup = Effect.fn("test.setup")(function* (input?: {
  config?: Partial<ConfigV1.Info>
  mcp?: Record<string, { defer?: boolean }>
}) {
  const instance = yield* TestInstance
  const llm = yield* TestLLMServer
  const alpha = yield* mcpServer("alpha", 9)
  const zeta = yield* mcpServer("zeta", 8)
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(
    path.join(instance.directory, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      provider: {
        test: {
          name: "Test",
          id: "test",
          env: [],
          npm: "@ai-sdk/openai-compatible",
          models: {
            "test-model": {
              id: "test-model",
              name: "Test Model",
              attachment: false,
              reasoning: false,
              temperature: false,
              tool_call: true,
              release_date: "2025-01-01",
              limit: { context: 100000, output: 10000 },
              cost: { input: 0, output: 0 },
              options: {},
            },
          },
          options: { apiKey: "test-key", baseURL: llm.url },
        },
      },
      mcp: {
        alpha: { type: "remote", url: alpha.url, oauth: false, ...input?.mcp?.alpha },
        zeta: { type: "remote", url: zeta.url, oauth: false, ...input?.mcp?.zeta },
      },
      ...input?.config,
    }),
  )
  return { llm }
})

const start = Effect.fn("test.start")(function* (permission: PermissionV1.Ruleset = []) {
  const sessions = yield* Session.Service
  return yield* sessions.create({
    title: "Deferred MCP",
    permission: [{ permission: "*", pattern: "*", action: "allow" }, ...permission],
  })
})

const ask = Effect.fn("test.ask")(function* (sessionID: SessionID, text: string) {
  const prompt = yield* SessionPrompt.Service
  yield* prompt.prompt({ sessionID, agent: "build", noReply: true, parts: [{ type: "text", text }] })
  return yield* prompt.loop({ sessionID })
})

// Provider requests made by the loop, skipping background title generation.
const requests = Effect.fn("test.requests")(function* () {
  const llm = yield* TestLLMServer
  return (yield* llm.inputs)
    .filter((body) => !JSON.stringify(body).includes("Generate a title for this conversation"))
    .map((body) => ({
      tools: (Array.isArray(body.tools) ? body.tools : []).flatMap((item) =>
        typeof item?.function?.name === "string" ? [item.function.name as string] : [],
      ),
      system: (Array.isArray(body.messages) ? body.messages : [])
        .filter((message) => message?.role === "system")
        .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
        .join("\n"),
    }))
})

const ids = (server: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${server}_tool_${String(index).padStart(2, "0")}`)
const ALL = [...ids("alpha", 9), ...ids("zeta", 8)]

const toolParts = Effect.fn("test.toolParts")(function* (sessionID: SessionID) {
  const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
  return msgs.flatMap((msg) => msg.parts).filter((part): part is SessionV1.ToolPart => part.type === "tool")
})

function output(part: SessionV1.ToolPart | undefined) {
  return part?.state.status === "completed" ? part.state.output : undefined
}

describe("deferred MCP tools", () => {
  it.instance("defers MCP tools over the threshold and lists them in the system prompt", () =>
    Effect.gen(function* () {
      const { llm } = yield* setup()
      const session = yield* start()
      yield* llm.text("done")
      yield* ask(session.id, "hello")

      const [first] = yield* requests()
      expect(first?.tools).toContain("tool_search")
      expect(first?.tools.filter((name) => ALL.includes(name))).toEqual([])
      const end = "</deferred_mcp_tools>"
      const block = first?.system.slice(
        first.system.indexOf("<deferred_mcp_tools>"),
        first.system.indexOf(end) + end.length,
      )
      expect(block).toBe(
        [
          "<deferred_mcp_tools>",
          'These MCP tools are deferred: only their names are listed. Load a tool with tool_search (query "select:<name>" or keywords) before calling it; loaded tools stay available for the rest of the session.',
          '  <server name="alpha">',
          ...ids("alpha", 9).map((id) => `    ${id}`),
          "  </server>",
          '  <server name="zeta">',
          ...ids("zeta", 8).map((id) => `    ${id}`),
          "  </server>",
          "</deferred_mcp_tools>",
        ].join("\n"),
      )
    }),
  )

  it.instance("loads a tool with tool_search and calls it in the same turn, then keeps it loaded", () =>
    Effect.gen(function* () {
      const { llm } = yield* setup()
      const session = yield* start()
      yield* llm.tool("tool_search", { query: "select:alpha_tool_03" })
      yield* llm.tool("alpha_tool_03", { note: "hi" })
      yield* llm.text("done")
      yield* ask(session.id, "use alpha tool 3")

      const turn = yield* requests()
      expect(turn).toHaveLength(3)
      expect(turn[0]?.tools).not.toContain("alpha_tool_03")
      expect(turn[1]?.tools).toContain("alpha_tool_03")
      expect(turn[1]?.tools).toContain("tool_search")
      expect(turn[1]?.tools).not.toContain("alpha_tool_04")
      // The deferred block ignores the loaded set so the prompt prefix stays cache-stable.
      expect(turn[1]?.system).toBe(turn[0]?.system)
      const parts = yield* toolParts(session.id)
      expect(output(parts.find((part) => part.tool === "alpha_tool_03"))).toBe("called alpha/tool_03")

      const sessions = yield* Session.Service
      expect(McpLoaded.get(yield* sessions.get(session.id))).toEqual(["alpha_tool_03"])

      // A new run reads the persisted loaded set.
      yield* llm.text("again")
      yield* ask(session.id, "next")
      expect((yield* requests()).at(-1)?.tools).toContain("alpha_tool_03")

      // Compaction keeps session metadata, so the tool stays loaded after it.
      const compaction = yield* SessionCompaction.Service
      const prompt = yield* SessionPrompt.Service
      yield* compaction.create({ sessionID: session.id, agent: "build", model: ref, auto: false })
      yield* llm.text("summary of the conversation")
      yield* prompt.loop({ sessionID: session.id })
      const compacted = yield* MessageV2.filterCompactedEffect(session.id)
      expect(compacted[0]?.parts.some((part) => part.type === "compaction")).toBe(true)
      yield* llm.text("after compaction")
      yield* ask(session.id, "after compaction")
      const last = (yield* requests()).at(-1)
      expect(last?.tools).toContain("alpha_tool_03")
      expect(last?.tools).toContain("tool_search")
    }),
  )

  it.instance("never lists or loads a denied tool", () =>
    Effect.gen(function* () {
      const { llm } = yield* setup()
      const session = yield* start([{ permission: "alpha_tool_01", pattern: "*", action: "deny" }])
      yield* llm.tool("tool_search", { query: "select:alpha_tool_01" })
      yield* llm.text("done")
      yield* ask(session.id, "load the denied tool")

      const turn = yield* requests()
      expect(turn[0]?.system).not.toContain("alpha_tool_01")
      expect(turn[0]?.system).toContain("alpha_tool_02")
      expect(turn[1]?.tools).not.toContain("alpha_tool_01")
      const parts = yield* toolParts(session.id)
      expect(output(parts.find((part) => part.tool === "tool_search"))).toContain("no such tool: alpha_tool_01")
      const sessions = yield* Session.Service
      expect(McpLoaded.get(yield* sessions.get(session.id))).toEqual([])
    }),
  )

  it.instance("starts a sub-agent session with an empty loaded set", () =>
    Effect.gen(function* () {
      const { llm } = yield* setup()
      const sessions = yield* Session.Service
      const parent = yield* start()
      yield* sessions.setMetadata({ sessionID: parent.id, metadata: { mcpLoaded: ["alpha_tool_03"] } })
      yield* llm.text("child done")
      yield* llm.text("parent done")
      const msg = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: parent.id,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: parent.id,
        type: "subtask",
        prompt: "look at alpha",
        description: "inspect alpha",
        agent: "general",
        model: ref,
      })
      const prompt = yield* SessionPrompt.Service
      yield* prompt.loop({ sessionID: parent.id })

      const kids = yield* sessions.children(parent.id)
      expect(kids).toHaveLength(1)
      expect(McpLoaded.get(kids[0]!)).toEqual([])
      const [child, after] = yield* requests()
      expect(child?.tools).toContain("tool_search")
      expect(child?.tools).not.toContain("alpha_tool_03")
      expect(after?.tools).toContain("alpha_tool_03")
    }),
  )

  it.instance("tells the model to load an unloaded deferred tool first", () =>
    Effect.gen(function* () {
      const { llm } = yield* setup()
      const session = yield* start()
      yield* llm.tool("zeta_tool_02", { note: "hi" })
      yield* llm.text("done")
      yield* ask(session.id, "call zeta tool 2")

      const parts = yield* toolParts(session.id)
      const hint = output(parts.find((part) => part.tool === "invalid"))
      expect(hint).toContain("zeta_tool_02")
      expect(hint).toContain("tool_search")
      expect(hint).toContain("select:zeta_tool_02")
    }),
  )

  it.instance("sends every MCP tool at or below the threshold", () =>
    Effect.gen(function* () {
      const { llm } = yield* setup({ config: { experimental: { mcp_defer_threshold: 17 } } })
      const session = yield* start()
      yield* llm.text("done")
      yield* ask(session.id, "hello")

      const [first] = yield* requests()
      expect(first?.tools).not.toContain("tool_search")
      expect(first?.tools.filter((name) => ALL.includes(name))).toEqual(ALL)
      expect(first?.system).not.toContain("<deferred_mcp_tools>")
    }),
  )

  it.instance("does not defer when the agent may not call tool_search", () =>
    Effect.gen(function* () {
      const { llm } = yield* setup()
      const session = yield* start([{ permission: "tool_search", pattern: "*", action: "deny" }])
      yield* llm.text("done")
      yield* ask(session.id, "hello")

      const [first] = yield* requests()
      expect(first?.tools).not.toContain("tool_search")
      expect(first?.tools.filter((name) => ALL.includes(name))).toEqual(ALL)
      expect(first?.system).not.toContain("<deferred_mcp_tools>")
    }),
  )

  it.instance("honors per-server defer overrides", () =>
    Effect.gen(function* () {
      const { llm } = yield* setup({ mcp: { zeta: { defer: false } } })
      const session = yield* start()
      yield* llm.text("done")
      yield* ask(session.id, "hello")

      const [first] = yield* requests()
      expect(first?.tools.filter((name) => ALL.includes(name))).toEqual(ids("zeta", 8))
      expect(first?.system).not.toContain('<server name="zeta">')
    }),
  )

  codeMode.instance("does not defer in code mode", () =>
    Effect.gen(function* () {
      const { llm } = yield* setup()
      const session = yield* start()
      yield* llm.text("done")
      yield* ask(session.id, "hello")

      const [first] = yield* requests()
      expect(first?.tools).not.toContain("tool_search")
      expect(first?.system).not.toContain("<deferred_mcp_tools>")
    }),
  )

  disabled.instance("does not defer when OPENCODE_DISABLE_MCP_DEFER is set", () =>
    Effect.gen(function* () {
      const { llm } = yield* setup()
      const session = yield* start()
      yield* llm.text("done")
      yield* ask(session.id, "hello")

      const [first] = yield* requests()
      expect(first?.tools).not.toContain("tool_search")
      expect(first?.tools.filter((name) => ALL.includes(name))).toEqual(ALL)
      expect(first?.system).not.toContain("<deferred_mcp_tools>")
    }),
  )
})
