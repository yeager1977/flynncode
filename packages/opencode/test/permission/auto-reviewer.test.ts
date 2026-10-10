import { expect } from "bun:test"
import { LLMEvent } from "@opencode-ai/llm"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "../../src/agent/agent"
import { AutoReviewer } from "../../src/permission/auto-reviewer"
import { Provider } from "../../src/provider/provider"
import { LLM } from "../../src/session/llm"
import { SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { testEffect } from "../lib/effect"

const sessionID = SessionID.make("ses_test")

const request = {
  sessionID,
  tool: "bash",
  args: { command: "git status" },
  permission: "bash",
  patterns: ["git *"],
}

// No Agent/Provider/Session/LLM services in scope: every dependency the
// reviewer resolves is missing, so the request must defer (fail-open to ask).
const bare = testEffect(AutoReviewer.layer)

bare.effect("defers when the reviewer agent and its services are unavailable", () =>
  Effect.gen(function* () {
    const reviewer = yield* AutoReviewer.Service
    const verdict = yield* reviewer.request(request)
    expect(verdict).toBe("defer")
  }),
)

const reviewAgent: Agent.Info = {
  name: "auto-review",
  mode: "primary",
  native: true,
  hidden: true,
  options: {},
  permission: [],
}

const stubModel = { providerID: ProviderV2.ID.make("test"), api: { id: "test-model" } } as Provider.Model

const stubSession = {
  id: sessionID,
  model: { id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test") },
} as unknown as Session.Info

const agentLayer = Layer.succeed(
  Agent.Service,
  Agent.Service.of({
    get: () => Effect.succeed(reviewAgent),
  } as Partial<Agent.Interface> as Agent.Interface),
)

const sessionLayer = Layer.succeed(
  Session.Service,
  Session.Service.of({
    get: () => Effect.succeed(stubSession),
  } as Partial<Session.Interface> as Session.Interface),
)

const providerLayer = Layer.succeed(
  Provider.Service,
  Provider.Service.of({
    getSmallModel: () => Effect.succeed(stubModel),
    getModel: () => Effect.succeed(stubModel),
  } as Partial<Provider.Interface> as Provider.Interface),
)

const llmLayer = (stream: Stream.Stream<LLMEvent, unknown>) =>
  Layer.succeed(
    LLM.Service,
    LLM.Service.of({
      stream: () => stream,
    } as Partial<LLM.Interface> as LLM.Interface),
  )

const text = (content: string) => Stream.make(LLMEvent.textDelta({ id: "text-0", text: content }))

// Each verdict case gets its own layer + runner because the stubbed transport
// varies per test.
const harness = (stream: Stream.Stream<LLMEvent, unknown>) =>
  testEffect(Layer.mergeAll(AutoReviewer.layer, agentLayer, sessionLayer, providerLayer, llmLayer(stream)))

harness(text("VERDICT: deny\nThe command rewrites the git index")).effect(
  "returns deny for an explicit deny verdict",
  () =>
    Effect.gen(function* () {
      const reviewer = yield* AutoReviewer.Service
      const verdict = yield* reviewer.request(request)
      expect(verdict).toBe("deny")
    }),
)

harness(text("VERDICT: allow\nRead-only inspection command")).effect(
  "returns allow for an explicit allow verdict",
  () =>
    Effect.gen(function* () {
      const reviewer = yield* AutoReviewer.Service
      const verdict = yield* reviewer.request(request)
      expect(verdict).toBe("allow")
    }),
)

harness(text("I am honestly not sure what the right call is here.")).effect(
  "defers when the reply carries no verdict line",
  () =>
    Effect.gen(function* () {
      const reviewer = yield* AutoReviewer.Service
      const verdict = yield* reviewer.request(request)
      expect(verdict).toBe("defer")
    }),
)

harness(Stream.fail(new Error("provider down"))).effect("defers when the LLM transport fails", () =>
  Effect.gen(function* () {
    const reviewer = yield* AutoReviewer.Service
    const verdict = yield* reviewer.request(request)
    expect(verdict).toBe("defer")
  }),
)