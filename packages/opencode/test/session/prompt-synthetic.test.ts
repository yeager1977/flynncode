/**
 * Ingestion-side synthetic classification for OMO internal prompts.
 *
 * The OMO orchestration plugin appends `<!-- OMO_INTERNAL_INITIATOR -->` as
 * the trailing line of its internal wake prompts without setting
 * `synthetic: true`. SessionPrompt.resolveUserPart classifies such parts as
 * synthetic at prompt admission so downstream consumers (e.g. title
 * generation) treat them as managed system activity.
 *
 * Provenance guard: only a marker that is the LAST non-empty line of the part
 * text counts. A part that merely quotes the marker mid-prose must stay
 * non-synthetic.
 *
 * Bootstrap mirrors test/session/snapshot-tool-race.test.ts, the smallest
 * proven layer graph for `SessionPrompt.prompt({ noReply: true })` admission.
 */
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Session } from "@/session/session"
import { SessionSummary } from "../../src/session/summary"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { SessionPrompt, type PromptInput } from "../../src/session/prompt"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
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

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  SessionSummary.node,
  Database.node,
  CrossSpawnSpawner.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])
const it = testEffect(
  LayerNode.compile(root, [
    [MCP.node, mcp],
    [LSP.node, lsp],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ]),
)

const admit = Effect.fnUntraced(function* (parts: PromptInput["parts"]) {
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "synthetic-classification" })
  yield* prompt.prompt({
    sessionID: chat.id,
    agent: "build",
    noReply: true,
    parts,
  })
  const [message] = yield* sessions.messages({ sessionID: chat.id })
  return message.parts[0]
})

it.live("classifies a part whose trailing line is the OMO initiator marker as synthetic", () =>
  provideTmpdirServer(() =>
    Effect.gen(function* () {
      const text = "wake task-agent-reliability\n<!-- OMO_INTERNAL_INITIATOR -->"
      const part = yield* admit([{ type: "text", text }])
      expect(part.type).toBe("text")
      if (part.type === "text") {
        expect(part.synthetic).toBe(true)
        expect(part.text).toBe(text)
      }
    }),
  ),
)

it.live("classifies a part whose trailing lines are initiator then NOREPLY as synthetic", () =>
  provideTmpdirServer(() =>
    Effect.gen(function* () {
      const text =
        "wake task-agent-reliability\n<!-- OMO_INTERNAL_INITIATOR -->\n<!-- OMO_INTERNAL_NOREPLY -->"
      const part = yield* admit([{ type: "text", text }])
      expect(part.type).toBe("text")
      if (part.type === "text") {
        expect(part.synthetic).toBe(true)
        expect(part.text).toBe(text)
      }
    }),
  ),
)

it.live("keeps a part whose trailing line is NOREPLY without a preceding initiator non-synthetic", () =>
  provideTmpdirServer(() =>
    Effect.gen(function* () {
      const text = "plain user text\n<!-- OMO_INTERNAL_NOREPLY -->"
      const part = yield* admit([{ type: "text", text }])
      expect(part.type).toBe("text")
      if (part.type === "text") {
        expect(part.synthetic).toBeFalsy()
        expect(part.text).toBe(text)
      }
    }),
  ),
)

it.live("keeps a part quoting the marker mid-text non-synthetic", () =>
  provideTmpdirServer(() =>
    Effect.gen(function* () {
      const text = 'a peer said "<!-- OMO_INTERNAL_INITIATOR -->" somewhere in the middle'
      const part = yield* admit([{ type: "text", text }])
      expect(part.type).toBe("text")
      if (part.type === "text") {
        expect(part.synthetic).toBeFalsy()
        expect(part.text).toBe(text)
      }
    }),
  ),
)

it.live("leaves an already-synthetic part unchanged", () =>
  provideTmpdirServer(() =>
    Effect.gen(function* () {
      const text = "internal wake with no marker"
      const part = yield* admit([{ type: "text", text, synthetic: true }])
      expect(part.type).toBe("text")
      if (part.type === "text") {
        expect(part.synthetic).toBe(true)
        expect(part.text).toBe(text)
      }
    }),
  ),
)

it.live("leaves a part without the marker unchanged", () =>
  provideTmpdirServer(() =>
    Effect.gen(function* () {
      const text = "hello there"
      const part = yield* admit([{ type: "text", text }])
      expect(part.type).toBe("text")
      if (part.type === "text") {
        expect(part.synthetic).toBeFalsy()
        expect(part.text).toBe(text)
      }
    }),
  ),
)
