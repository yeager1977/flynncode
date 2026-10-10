import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LLMEvent } from "@opencode-ai/llm"
import { Context, Effect, Layer, Option } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Provider } from "@/provider/provider"

// The hidden `auto-review` agent vets tool-use permission requests while the
// configured approval mode is "auto". Every failure path — missing agent,
// missing model, transport error, unparseable reply, timeout — defers to the
// human prompt: fail-open to ask, never fail-open to approval, never
// fail-closed.
export type Verdict = "allow" | "deny" | "defer"

const REQUEST_TIMEOUT = "15 seconds"
const PAYLOAD_MAX_CHARS = 4_000

const parseVerdict = (text: string): Verdict => {
  // Only explicit anchored verdict lines count; free-form text defers. Every
  // line is collected, and an ambiguous reply (both verdicts appear, or more
  // than one line total) must never approve, so ambiguity prefers deny.
  const verdicts = [...text.matchAll(/^VERDICT:\s*(allow|deny)\b/gm)].map((match) => match[1])
  if (verdicts.length > 1) return "deny"
  if (verdicts[0] === "allow") return "allow"
  if (verdicts[0] === "deny") return "deny"
  return "defer"
}

type RequestInput = {
  sessionID: SessionID
  tool: string
  args: Record<string, unknown>
  permission: string
  patterns: readonly string[]
}

const attempt = Effect.fn("AutoReviewer.attempt")(function* (input: RequestInput) {
  // Services are optional at request time so minimal environments (and unit
  // tests without the app graph) degrade to defer instead of failing.
  const agents = yield* Effect.serviceOption(Agent.Service)
  if (Option.isNone(agents)) return "defer"
  const provider = yield* Effect.serviceOption(Provider.Service)
  if (Option.isNone(provider)) return "defer"
  const sessions = yield* Effect.serviceOption(Session.Service)
  if (Option.isNone(sessions)) return "defer"
  const llm = yield* Effect.serviceOption(LLM.Service)
  if (Option.isNone(llm)) return "defer"

  const agent = yield* agents.value.get("auto-review").pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!agent) return "defer"

  // Model resolution mirrors the hidden title/summary agents: the agent's own
  // model when configured, otherwise the provider's small model anchored on
  // the session's model, falling back to the session model itself.
  const session = yield* sessions.value.get(input.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
  const anchor = session?.model
  if (!anchor) return "defer"
  const model = agent.model
    ? yield* provider.value.getModel(agent.model.providerID, agent.model.modelID).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
    : ((yield* provider.value.getSmallModel(anchor.providerID)) ??
      (yield* provider.value.getModel(anchor.providerID, anchor.id).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )))
  if (!model) return "defer"

  const user: SessionV1.User = {
    id: MessageID.ascending(),
    sessionID: input.sessionID,
    role: "user",
    agent: agent.name,
    model: { providerID: model.providerID, modelID: model.id },
    time: { created: Date.now() },
  }
  const payload = JSON.stringify({
    tool: input.tool,
    args: input.args,
    permission: input.permission,
    patterns: [...input.patterns],
  })
  // A truncated payload stays readable enough for a verdict; the reply, not
  // the payload, is what must be exact.
  const content =
    payload.length <= PAYLOAD_MAX_CHARS ? payload : payload.slice(0, PAYLOAD_MAX_CHARS) + "... [truncated]"

  const text = yield* llm.value
    .stream({
      // The hidden agent's `prompt` field supplies the system prompt through
      // LLMRequestPrep, so system stays empty (mirrors the title/summary agents).
      agent,
      user,
      system: [],
      small: true,
      tools: {},
      model,
      sessionID: input.sessionID,
      retries: 1,
      messages: [{ role: "user", content }],
    })
    .pipe(
      Stream.filter(LLMEvent.is.textDelta),
      Stream.map((event) => event.text),
      Stream.mkString,
      Effect.catch(() => Effect.succeed("")),
    )
  return parseVerdict(text)
})

export interface Interface {
  readonly request: (input: RequestInput) => Effect.Effect<Verdict>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AutoReviewer") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const request = Effect.fn("AutoReviewer.request")(function* (input: RequestInput) {
      return yield* attempt(input).pipe(
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.catchCause(() => Effect.succeed<Verdict>("defer")),
      )
    })
    return Service.of({ request })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [] })

export * as AutoReviewer from "./auto-reviewer"