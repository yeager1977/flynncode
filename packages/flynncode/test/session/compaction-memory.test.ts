import { describe, expect } from "bun:test"
import { ConfigV1 } from "@flynncode/core/v1/config/config"
import { Database } from "@flynncode/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import * as Stream from "effect/Stream"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@flynncode/core/effect/app-node-builder"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { LLMEvent, Usage } from "@flynncode/llm"
import { ModelV2 } from "@flynncode/core/model"
import { ProviderV2 } from "@flynncode/core/provider"
import { SessionProjector } from "@flynncode/core/session/projector"
import { LLM } from "../../src/session/llm"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionMemoryCurate } from "../../src/session/memory-curate"
import { Memory } from "@/memory/memory"
import { Provider } from "@/provider/provider"
import { Session as SessionNs } from "@/session/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import * as SessionProcessorModule from "../../src/session/processor"
import { ProviderTest } from "../fake/provider"
import { TestConfig } from "../fixture/config"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const basicUsage = () => new Usage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })

// Fixed extraction reply the stub LLM always produces. The capture array lets
// tests reset and count the extraction calls made through the compact/idle
// triggers.
const EXTRACTION_REPLY = "SLUG: test-runner\n- always use bun"
const capture: { calls: LLM.StreamInput[] } = { calls: [] }

const llmStub = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: (input) => {
      capture.calls.push(input)
      return Stream.make(
        LLMEvent.textStart({ id: "txt-0" }),
        LLMEvent.textDelta({ id: "txt-0", text: EXTRACTION_REPLY }),
        LLMEvent.textEnd({ id: "txt-0" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop", usage: basicUsage() }),
        LLMEvent.finish({ reason: "stop", usage: basicUsage() }),
      ).pipe(Stream.mapEffect((event) => Effect.succeed(event)))
    },
  }),
)

function fake(
  input: Parameters<SessionProcessorModule.SessionProcessor.Interface["create"]>[0],
  result: "continue" | "compact",
) {
  const msg = input.assistantMessage
  return {
    get message() {
      return msg
    },
    updateToolCall: Effect.fn("TestSessionProcessor.updateToolCall")(() => Effect.succeed(undefined)),
    completeToolCall: Effect.fn("TestSessionProcessor.completeToolCall")(() => Effect.void),
    process: Effect.fn("TestSessionProcessor.process")(() => Effect.succeed(result)),
  } satisfies SessionProcessorModule.SessionProcessor.Handle
}

function processorLayer(result: "continue" | "compact") {
  return Layer.succeed(
    SessionProcessorModule.SessionProcessor.Service,
    SessionProcessorModule.SessionProcessor.Service.of({
      create: Effect.fn("TestSessionProcessor.create")((input) => Effect.succeed(fake(input, result))),
    }),
  )
}

function cfg(memory: unknown = { enabled: true, min_turns: 2 }) {
  const base = Schema.decodeUnknownSync(ConfigV1.Info)({}) as ConfigV1.Info
  return Layer.succeed(
    Config.Service,
    TestConfig.make({ get: () => Effect.succeed({ ...base, memory }) as Effect.Effect<never> as never }),
  )
}

function createModel() {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: { context: 100_000, output: 32_000 },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

const env = AppNodeBuilder.build(
  LayerNode.group([
    SessionCompaction.node,
    SessionNs.node,
    SessionProjector.node,
    SessionMemoryCurate.node,
    Memory.node,
    SessionStatus.node,
    Database.node,
    EventV2Bridge.node,
    CrossSpawnSpawner.node,
  ]),
  [
    [Provider.node, ProviderTest.fake({ model: createModel() }).layer],
    [SessionProcessorModule.SessionProcessor.node, processorLayer("continue")],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
    [SessionSummary.node, summary],
    [Config.node, cfg()],
    [LLM.node, llmStub],
  ],
)

const it = testEffect(env)

function createUserMessage(sessionID: SessionID, text: string) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const msg = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "text",
      text,
    })
    return msg
  })
}

const waitForMemory = (needle: string) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const loaded = yield* (yield* Memory.Service).load()
      return loaded.some((m) => m.content.includes(needle)) ? (true as const) : undefined
    }),
    `memory extraction never wrote a topic containing ${needle}`,
  )

describe("session memory triggers", () => {
  it.instance(
    "compaction triggers memory extraction above min_turns",
    Effect.gen(function* () {
      capture.calls.length = 0
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "we always run bun test in this repo")
      yield* createUserMessage(session.id, "prefer bun over node everywhere")
      const msgs = yield* ssn.messages({ sessionID: session.id })
      const first = msgs.find((msg) => msg.info.role === "user")!
      expect(first.info.role).toBe("user")

      const result = yield* SessionCompaction.use.process({
        parentID: first.info.id,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })
      expect(result).toBe("continue")

      yield* waitForMemory("always use bun")
      expect(capture.calls.length).toBe(1)
      const prompt = (capture.calls[0]?.messages as [{ role: string; content: string }])[0]?.content ?? ""
      expect(prompt).toContain("prefer bun over node everywhere")
    }),
  )

  it.instance(
    "compaction skips extraction below min_turns",
    Effect.gen(function* () {
      capture.calls.length = 0
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "only one turn")
      const msgs = yield* ssn.messages({ sessionID: session.id })
      const first = msgs.find((msg) => msg.info.role === "user")!

      const exit = yield* Effect.exit(
        SessionCompaction.use.process({
          parentID: first.info.id,
          messages: msgs,
          sessionID: session.id,
          auto: false,
        }),
      )
      expect(Exit.isSuccess(exit)).toBe(true)

      // Give any wrongly-spawned extraction fiber time to reach the LLM stub.
      yield* Effect.sleep("300 millis")
      expect(capture.calls.length).toBe(0)
      expect(yield* (yield* Memory.Service).load()).toEqual([])
    }),
  )

  it.instance(
    "idle transition triggers memory extraction above min_turns",
    Effect.gen(function* () {
      capture.calls.length = 0
      const status = yield* SessionStatus.Service
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "we always run bun test in this repo")
      yield* createUserMessage(session.id, "prefer bun over node everywhere")

      yield* status.set(session.id, { type: "busy" })
      yield* status.set(session.id, { type: "idle" })

      yield* waitForMemory("always use bun")
      expect(capture.calls.length).toBeGreaterThanOrEqual(1)
    }),
  )

  it.instance(
    "idle transition skips extraction below min_turns",
    Effect.gen(function* () {
      capture.calls.length = 0
      const status = yield* SessionStatus.Service
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "only one turn")

      yield* status.set(session.id, { type: "busy" })
      yield* status.set(session.id, { type: "idle" })

      yield* Effect.sleep("300 millis")
      expect(capture.calls.length).toBe(0)
      expect(yield* (yield* Memory.Service).load()).toEqual([])
    }),
  )

  it.instance(
    "extraction dedupes the same topic at compact and idle boundaries",
    Effect.gen(function* () {
      capture.calls.length = 0
      const status = yield* SessionStatus.Service
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      yield* createUserMessage(session.id, "we always run bun test in this repo")
      yield* createUserMessage(session.id, "prefer bun over node everywhere")
      const msgs = yield* ssn.messages({ sessionID: session.id })
      const first = msgs.find((msg) => msg.info.role === "user")!

      const compacted = yield* SessionCompaction.use.process({
        parentID: first.info.id,
        messages: msgs,
        sessionID: session.id,
        auto: false,
      })
      expect(compacted).toBe("continue")
      yield* waitForMemory("always use bun")

      yield* status.set(session.id, { type: "busy" })
      yield* status.set(session.id, { type: "idle" })
      yield* Effect.sleep("300 millis")

      // The identical snapshot is coalesced before inference, not just at write.
      const memory = yield* Memory.Service
      const loaded = yield* memory.load()
      expect(loaded).toHaveLength(1)
      expect(loaded[0]?.content).toContain("always use bun")
      expect(capture.calls.length).toBe(1)
    }),
  )
})
