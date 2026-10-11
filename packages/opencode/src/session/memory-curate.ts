import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigMemoryV1 } from "@opencode-ai/core/v1/config/memory"
import { LLMEvent } from "@opencode-ai/llm"
import { Context, Effect, Fiber, Layer, Scope, ScopedCache, Semaphore, Stream } from "effect"
import { InstanceState } from "@/effect/instance-state"
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

type Snapshot = { signature: string; token: object; work: Effect.Effect<void> }

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const memory = yield* Memory.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const llm = yield* LLM.Service
    const state = yield* InstanceState.make(() => ScopedCache.make({
      capacity: 64,
      timeToLive: "30 minutes",
      lookup: (_sessionID: SessionID) => Effect.gen(function* () {
        const entry = {
          scope: yield* Scope.Scope,
          lock: yield* Semaphore.make(1),
          latest: { time: 0, id: "" },
          active: undefined as Snapshot | undefined,
          valid: true,
        }
        yield* Effect.addFinalizer(() => Effect.sync(() => {
          entry.valid = false
          entry.active = undefined
        }))
        return entry
      }),
    }))

    // Core extraction over an already-loaded message history. Every caller
    // (drain completion, compaction, idle) passes its own snapshot here; the
    // min_turns gate and enabled flag are enforced inside, unchanged.
    const extractSnapshot = Effect.fn("SessionMemoryCurate.extractSnapshot")(function* (
      sessionID: SessionID,
      all: SessionV1.WithParts[],
      current: () => boolean,
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
      const before = yield* memory.snapshot("project")
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
      if (!current()) return
      yield* memory.reconcile({
        scope: "project", before, current,
        topics: MemoryExtract.parseExtractionTopics(cleaned).map(topic => ({ slug: topic.slug, text: MemoryRedact.redactSecrets(topic.text) })),
      })
    })

    const extractFor = Effect.fn("SessionMemoryCurate.extractFor")(function* (sessionID: SessionID, all: SessionV1.WithParts[]) {
      const cache = yield* InstanceState.get(state)
      const entry = yield* ScopedCache.get(cache, sessionID)
      const signature = new Bun.CryptoHasher("sha256").update(JSON.stringify(all)).digest("hex")
      const latest = all.reduce((latest, message) =>
        message.info.time.created > latest.time || (message.info.time.created === latest.time && message.info.id > latest.id)
          ? { time: message.info.time.created, id: message.info.id }
          : latest, { time: 0, id: "" })
      const work = yield* entry.lock.withPermit(Effect.gen(function* () {
        if (latest.time < entry.latest.time || (latest.time === entry.latest.time && latest.id < entry.latest.id)) return Effect.void
        if (entry.active?.signature === signature) return entry.active.work
        const token = {}
        const current = () => entry.valid && entry.active?.token === token
        const work = yield* Effect.cached(Effect.acquireUseRelease(
          extractSnapshot(sessionID, all, current).pipe(Effect.forkIn(entry.scope)),
          Fiber.join,
          Fiber.interrupt,
        ).pipe(Effect.onInterrupt(() => Effect.sync(() => {
          if (entry.active?.token === token) entry.active = undefined
        }))))
        entry.latest = latest
        entry.active = { signature, token, work }
        return work
      }))
      yield* work
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
