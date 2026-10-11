import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigMemoryV1 } from "@opencode-ai/core/v1/config/memory"
import { LLMEvent } from "@opencode-ai/llm"
import { Context, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { Memory } from "@/memory/memory"
import { MemoryExtract } from "@/memory/extract"
import { MemoryRedact } from "@/memory/redact"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Session } from "./session"
import { SessionID } from "./schema"
import { LLM } from "./llm"

export interface Interface {
  readonly extract: (sessionID: SessionID) => Effect.Effect<void>
  readonly extractFor: (sessionID: SessionID, messages: SessionV1.WithParts[]) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionMemoryCurate") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const memory = yield* Memory.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const llm = yield* LLM.Service

    // Core extraction over an already-loaded message history. Every caller
    // (drain completion, compaction, idle) passes its own snapshot here; the
    // min_turns gate and enabled flag are enforced inside, unchanged.
    const extractFor = Effect.fn("SessionMemoryCurate.extractFor")(function* (
      sessionID: SessionID,
      all: SessionV1.WithParts[],
    ) {
      const settings = ConfigMemoryV1.resolved((yield* config.get()).memory ?? {})
      if (!settings.enabled) return
      if (!MemoryExtract.shouldExtract({ messages: all, min_turns: settings.min_turns })) return
      const lastUser = [...all].reverse().find((item) => item.info.role === "user")
      if (!lastUser || lastUser.info.role !== "user") return
      const conversation = all
        .flatMap((msg) =>
          msg.info.role === "user"
            ? msg.parts.flatMap((part) => (part.type === "text" && part.text.trim() ? [part.text.trim()] : []))
            : [],
        )
        .join("\n")
        .slice(0, 6000)
      if (!conversation.trim()) return
      const ag = yield* agents.get("summary").pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!ag) return
      const mdl = ((yield* provider.getSmallModel(lastUser.info.model.providerID).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )) ??
        (yield* provider
          .getModel(lastUser.info.model.providerID, lastUser.info.model.modelID)
          .pipe(Effect.catch(() => Effect.succeed(undefined)))))
      if (!mdl) return
      const text = yield* llm
        .stream({
          agent: ag,
          user: lastUser.info,
          system: [],
          small: true,
          tools: {},
          model: mdl,
          sessionID,
          retries: 2,
          messages: [{ role: "user", content: MemoryExtract.buildExtractionPrompt({ conversation }) }],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.catch(() => Effect.succeed("")),
        )
      const cleaned = text.trim()
      if (!cleaned || cleaned === "NOTHING TO REMEMBER") return
      for (const topic of MemoryExtract.parseExtractionTopics(cleaned)) {
        // Belt and suspenders: re-redact at write even though the prompt forbids secrets.
        const body = MemoryRedact.redactSecrets(topic.text)
        if (!body.trim()) {
          yield* memory.remove({ scope: "project", slug: topic.slug }).pipe(Effect.catch(() => Effect.succeed(false)))
          continue
        }
        yield* memory.update({ scope: "project", slug: topic.slug, text: body }).pipe(Effect.catch(() => Effect.succeed("")))
      }
    })

    const extract = Effect.fn("SessionMemoryCurate.extract")(function* (sessionID: SessionID) {
      const all = yield* sessions.messages({ sessionID }).pipe(Effect.catch(() => Effect.succeed([])))
      yield* extractFor(sessionID, all)
    })

    return Service.of({ extract, extractFor })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, Memory.node, Agent.node, Provider.node, LLM.node, Session.node],
})

export * as SessionMemoryCurate from "./memory-curate"