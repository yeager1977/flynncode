import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ComputerUseV1 } from "@opencode-ai/schema/computer-use-v1"
import { Context, Deferred, Duration, Effect, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionID } from "@/session/schema"

export const Action = ComputerUseV1.Action
export type Action = typeof Action.Type
export const Args = ComputerUseV1.Args
export type Args = typeof Args.Type
export const Request = ComputerUseV1.Request
export type Request = typeof Request.Type
export const Result = ComputerUseV1.Result
export type Result = typeof Result.Type
export const Reply = ComputerUseV1.Reply
export type Reply = typeof Reply.Type
export const Event = ComputerUseV1.Event

export interface ExecuteRequest {
  readonly sessionID: SessionID
  readonly action: ComputerUseV1.Action
  readonly appID: string
  readonly args?: ComputerUseV1.Args
}

// The executor service itself is not part of this process's graph (no desktop
// bridge is installed), so nothing was ever requested and nothing performed.
// Tool call sites probe availability with Effect.serviceOption and raise this
// before asking the user for approval.
export class ComputerUseExecutorUnavailableError extends Schema.TaggedErrorClass<ComputerUseExecutorUnavailableError>()(
  "ComputerUseExecutorUnavailableError",
  { appID: Schema.String, action: Schema.String },
) {
  override get message() {
    return `No desktop executor answered the ${this.action} request for ${this.appID}; the action was not performed. Do not assume it happened; tell the user and continue another way.`
  }
}

// The request went out to desktop clients but no receipt came back, so the
// outcome is genuinely unknown: a desktop may be actuating right now. Callers
// must not claim either direction; the honest recovery is to re-verify on
// screen (e.g. request a screenshot) or ask the user.
export class ComputerUseOutcomeUnconfirmedError extends Schema.TaggedErrorClass<ComputerUseOutcomeUnconfirmedError>()(
  "ComputerUseOutcomeUnconfirmedError",
  { requestID: Schema.String, appID: Schema.String, action: Schema.String },
) {
  override get message() {
    return `The ${this.action} request for ${this.appID} expired without an executor receipt; it may or may not have been performed. Do not assume either way; re-verify on screen (for example request a screenshot), ask the user, and continue another way.`
  }
}

interface PendingEntry {
  request: ComputerUseV1.Request
  deferred: Deferred.Deferred<ComputerUseV1.Result, ComputerUseOutcomeUnconfirmedError>
}

interface State {
  pending: Map<string, PendingEntry>
}

export interface Interface {
  readonly execute: (request: ExecuteRequest) => Effect.Effect<
    Result,
    ComputerUseExecutorUnavailableError | ComputerUseOutcomeUnconfirmedError
  >
  readonly reply: (requestID: string, result: Result | { error: string }) => Effect.Effect<void>
  readonly list: () => Effect.Effect<ReadonlyArray<ComputerUseV1.Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ComputerUseExecutor") {}

// Short gate: the renderer listener is expected to answer within this window;
// otherwise the action is reported as unconfirmed, not as never happened.
export const BRIDGE_TIMEOUT = Duration.seconds(10)

const normalize = (result: Result | { error: string }): Result =>
  "ok" in result ? result : { ok: false, error: result.error }

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("ComputerUseExecutor.state")(function* () {
        const state = {
          pending: new Map<string, PendingEntry>(),
          id: Math.random().toString(36).slice(2, 8),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            // The instance is gone while requests were still pending; they were
            // published, so a desktop may have started actuating. The honest
            // outcome is "unconfirmed", not "never performed".
            for (const item of state.pending.values()) {
              yield* Deferred.fail(
                item.deferred,
                new ComputerUseOutcomeUnconfirmedError({
                  requestID: item.request.requestID,
                  appID: item.request.appID,
                  action: item.request.action,
                }),
              )
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const execute = Effect.fn("ComputerUseExecutor.execute")(function* (request: ExecuteRequest) {
      const requestID = ComputerUseV1.ID.ascending()
      const deferred = yield* Deferred.make<ComputerUseV1.Result, ComputerUseOutcomeUnconfirmedError>()
      const info: ComputerUseV1.Request = {
        requestID,
        sessionID: request.sessionID,
        action: request.action,
        appID: request.appID,
        ...(request.args ? { args: request.args } : {}),
        time: Date.now(),
      }
      // Insert, publish, and await all live inside one cleanup-covered,
      // deadline-bounded region: publication blocks on every listener, and
      // cancelling a fiber parked on a blocked publish must still remove the
      // pending entry (the review's own probe showed it leaking otherwise).
      const requestLifetime = Effect.gen(function* () {
        const pending = (yield* InstanceState.get(state)).pending
        pending.set(requestID, { request: info, deferred })
        yield* Effect.logInfo("computer-use requested", { requestID, action: request.action, appID: request.appID })
        yield* events.publish(Event.Requested, info)
        return yield* Deferred.await(deferred)
      })
      return yield* requestLifetime.pipe(
        Effect.ensuring(
          InstanceState.get(state).pipe(
            Effect.flatMap((s) => Effect.sync(() => s.pending.delete(requestID))),
          ),
        ),
        Effect.timeout(BRIDGE_TIMEOUT),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(
            new ComputerUseOutcomeUnconfirmedError({
              requestID,
              appID: request.appID,
              action: request.action,
            }),
          ),
        ),
      )
    })

    const reply = Effect.fn("ComputerUseExecutor.reply")(function* (
      requestID: string,
      result: Result | { error: string },
    ) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(requestID)
      if (!existing) {
        yield* Effect.logWarning("reply for unknown computer-use request", { requestID })
        return
      }
      pending.delete(requestID)
      const normalized = normalize(result)
      yield* Effect.logInfo("computer-use replied", { requestID, ok: normalized.ok })
      yield* Deferred.succeed(existing.deferred, normalized)
    })

    const list = Effect.fn("ComputerUseExecutor.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (x) => x.request)
    })

    return Service.of({ execute, reply, list })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as ComputerUseExecutor from "."