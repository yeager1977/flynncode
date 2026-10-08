import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { Context, Effect, Exit, Layer, Option } from "effect"
import type { HooksRunner } from "@/hooks/runner"

// Per-session hook context: observe hooks return additionalContext; call
// sites store it here via observeAndStore and the prompt loop injects it into
// the assembled system prompt (the shared seam). Entries dedupe by equality
// and the per-session list is capped to bound growth; session removal clears
// the entry. Store absence (tests, minimal graphs) degrades to report-only.

export const MAX_ENTRIES = 100

export interface Interface {
  readonly append: (sessionID: string, text: string) => Effect.Effect<void>
  readonly get: (sessionID: string) => Effect.Effect<Array<string>>
  readonly clear: (sessionID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/HooksContext") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make<Map<string, Array<string>>>(
      Effect.fn("HooksContext.state")(() => Effect.succeed(new Map<string, Array<string>>())),
    )

    const append = Effect.fn("HooksContext.append")(function* (sessionID: string, text: string) {
      const data = yield* InstanceState.get(state)
      const existing = data.get(sessionID) ?? []
      if (existing.includes(text)) return
      data.set(sessionID, [...existing, text].slice(-MAX_ENTRIES))
    })

    const get = Effect.fn("HooksContext.get")(function* (sessionID: string) {
      return [...((yield* InstanceState.get(state)).get(sessionID) ?? [])]
    })

    const clear = Effect.fn("HooksContext.clear")(function* (sessionID: string) {
      const data = yield* InstanceState.get(state)
      data.delete(sessionID)
    })

    return Service.of({ append, get, clear })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [] })

// Pure assembly seam used by the prompt loop: hook context rides after the
// built-in system sections.
export function assembleSystem(base: Array<string>, hookContext: Array<string>) {
  return [...base, ...hookContext]
}

// Report hook output (systemMessage warnings) and store additionalContext for
// later system-prompt injection. Observe failures stay advisory.
export function observeAndStore(
  label: string,
  sessionID: string,
  self: Effect.Effect<HooksRunner.SessionObserve | void, unknown, never>,
) {
  return Effect.gen(function* () {
    const exit = yield* self.pipe(Effect.exit)
    if (Exit.isFailure(exit)) return
    const out = exit.value
    if (!out || typeof out !== "object") return
    if (out.systemMessage) yield* Effect.logWarning(label, { systemMessage: out.systemMessage })
    if (!out.additionalContext) return
    const maybeStore = yield* Effect.serviceOption(Service)
    if (Option.isSome(maybeStore)) yield* maybeStore.value.append(sessionID, out.additionalContext)
  })
}

export * as HooksContext from "./context"
