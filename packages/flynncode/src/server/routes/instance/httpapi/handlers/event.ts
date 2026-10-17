import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@flynncode/core/event"
import { Deferred, Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { EventApi } from "../groups/event"

// Events buffered for a connected reader before it counts as stalled. Token
// deltas and tool part bursts flow at high rate; thousands of events cover the
// bursty gaps between reads without growing past a few MB when a client wedges.
const EVENT_QUEUE_CAPACITY = 4_096

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function eventID() {
  return EventV2.ID.create()
}

function eventResponse(events: EventV2.Interface) {
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const workspaceID = yield* InstanceState.workspaceID
    // The queue is dropping-strategy and offered synchronously: offer never
    // suspends, so a stalled reader cannot park the event pump, and the
    // pre-filter below means it only ever buffers its own directory's events.
    // When the queue fills, this connection is interrupted instead of
    // buffering without bound — the client reconnects and resyncs, the same
    // recovery path as any dropped SSE connection.
    const queue = yield* Queue.dropping<EventV2.Payload>(EVENT_QUEUE_CAPACITY)
    const stalled = yield* Deferred.make<boolean>()
    const matches = (event: EventV2.Payload) =>
      event.location?.directory === instance.directory &&
      (event.location.workspaceID === undefined || event.location.workspaceID === workspaceID)
    // Listener registration is eager, so events published after this point cannot
    // be lost while the HTTP body fiber is starting or emitting server.connected.
    yield* events.listen((event) =>
      Effect.gen(function* () {
        if (!matches(event)) return
        if (!Queue.offerUnsafe(queue, event)) {
          yield* Effect.logWarning("event stream stalled; disconnecting the reader", { directory: instance.directory })
          yield* Deferred.succeed(stalled, true)
        }
      }),
    )
    const stream = Stream.fromQueue(queue).pipe(
      // Pre-filtered in the listener: the queue never holds other directories'
      // events, so a slow reader no longer accumulates the whole process's
      // traffic.
      Stream.map((event) => ({ id: event.id, type: event.type, properties: event.data })),
      // The stalled signal completes without a value; interrupting (instead of
      // failing) ends the SSE body the way a disconnect would.
      Stream.interruptWhen(Deferred.await(stalled)),
    )
    const disposed = Stream.callback<{ id: string; type: string; properties: unknown }>((queue) => {
      const listener = (event: {
        directory?: string
        payload: { id?: string; type?: string; properties?: unknown }
      }) => {
        if (event.directory !== instance.directory || event.payload.type !== "server.instance.disposed") return
        Queue.offerUnsafe(queue, {
          id: event.payload.id ?? eventID(),
          type: "server.instance.disposed",
          properties: event.payload.properties ?? {},
        })
      }
      return Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", listener)),
        () => Effect.sync(() => GlobalBus.off("event", listener)),
      )
    })
    const output = stream.pipe(
      Stream.merge(disposed, { haltStrategy: "left" }),
      Stream.takeUntil((event) => event.type === "server.instance.disposed"),
    )
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ id: eventID(), type: "server.heartbeat", properties: {} })),
    )

    yield* Effect.logInfo("event connected")
    return HttpServerResponse.stream(
      Stream.make({ id: eventID(), type: "server.connected", properties: {} }).pipe(
        Stream.concat(output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const eventHandlers = HttpApiBuilder.group(EventApi, "event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    return handlers.handleRaw(
      "subscribe",
      Effect.fn("EventHttpApi.subscribe")(function* () {
        return yield* eventResponse(events)
      }),
    )
  }),
)