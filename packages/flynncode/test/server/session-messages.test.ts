import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@flynncode/core/v1/session"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"

import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@flynncode/core/provider"
import { ModelV2 } from "@flynncode/core/model"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(SessionNs.node), httpApiLayer))

const model = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test"),
}

afterEach(async () => {
  await disposeAllInstances()
})

const withoutWatcher = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  if (process.platform !== "win32") return effect
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
      process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
        else process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = previous
      }),
  )
}

// The unpaged-read cap is read from the environment at request time, so a tiny value exercises it without a huge session.
const withUnpagedCap = <A, E, R>(bytes: number, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_SESSION_UNPAGED_MAX_BYTES
      process.env.OPENCODE_SESSION_UNPAGED_MAX_BYTES = String(bytes)
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_SESSION_UNPAGED_MAX_BYTES
        else process.env.OPENCODE_SESSION_UNPAGED_MAX_BYTES = previous
      }),
  )

const sessionScoped = Effect.acquireRelease(SessionNs.use.create({}), (session) =>
  SessionNs.use.remove(session.id).pipe(Effect.ignore),
)

const fill = Effect.fn("SessionMessagesTest.fill")(function* (
  sessionID: SessionID,
  count: number,
  time = (i: number) => Date.now() + i,
  text = (i: number) => `m${i}`,
) {
  const session = yield* SessionNs.Service
  return yield* Effect.forEach(
    Array.from({ length: count }, (_, i) => i),
    (i) =>
      Effect.gen(function* () {
        const id = MessageID.ascending()
        yield* session.updateMessage({
          id,
          sessionID,
          role: "user",
          time: { created: time(i) },
          agent: "test",
          model,
          tools: {},
        } satisfies SessionV1.User)
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text: text(i),
        } satisfies SessionV1.TextPart)
        return id
      }),
  )
})

function request(path: string) {
  return TestInstance.pipe(Effect.flatMap((test) => requestInDirectory(path, test.directory)))
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((body) => body as T))
}

describe("session messages endpoint", () => {
  it.instance(
    "returns cursor headers for older pages",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 5)

        const a = yield* request(`/session/${session.id}/message?limit=2`)
        expect(a.status).toBe(200)
        const aBody = yield* json<SessionV1.WithParts[]>(a)
        expect(aBody.map((item) => item.info.id)).toEqual(ids.slice(-2))
        const cursor = a.headers["x-next-cursor"]
        expect(cursor).toBeTruthy()
        expect(a.headers["link"]).toContain('rel="next"')

        const b = yield* request(`/session/${session.id}/message?limit=2&before=${encodeURIComponent(cursor!)}`)
        expect(b.status).toBe(200)
        const bBody = yield* json<SessionV1.WithParts[]>(b)
        expect(bBody.map((item) => item.info.id)).toEqual(ids.slice(-4, -2))
      }),
    ),
    { git: true },
  )

  it.instance(
    "keeps full-history responses when limit is omitted",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 3)

        const res = yield* request(`/session/${session.id}/message`)
        expect(res.status).toBe(200)
        const body = yield* json<SessionV1.WithParts[]>(res)
        expect(body.map((item) => item.info.id)).toEqual(ids)
      }),
    ),
    { git: true },
  )

  it.instance(
    "refuses unpaged reads of a session above the cap but still serves pages",
    withoutWatcher(
      withUnpagedCap(
        2_000,
        Effect.gen(function* () {
          const session = yield* sessionScoped
          const ids = yield* fill(session.id, 3, undefined, () => "x".repeat(1_000))

          const unpaged = yield* request(`/session/${session.id}/message`)
          expect(unpaged.status).toBe(413)
          const body = yield* json<{ name: string; data: { message: string } }>(unpaged)
          expect(body.name).toBe("SessionTooLargeError")
          expect(body.data.message).toContain("limit")

          const zero = yield* request(`/session/${session.id}/message?limit=0`)
          expect(zero.status).toBe(413)

          const paged = yield* request(`/session/${session.id}/message?limit=2`)
          expect(paged.status).toBe(200)
          const pagedBody = yield* json<SessionV1.WithParts[]>(paged)
          expect(pagedBody.map((item) => item.info.id)).toEqual(ids.slice(-2))
        }),
      ),
    ),
    { git: true },
  )

  it.instance(
    "serves unpaged reads of a session under the cap",
    withoutWatcher(
      withUnpagedCap(
        1_000_000,
        Effect.gen(function* () {
          const session = yield* sessionScoped
          const ids = yield* fill(session.id, 3, undefined, () => "x".repeat(1_000))

          const res = yield* request(`/session/${session.id}/message`)
          expect(res.status).toBe(200)
          const body = yield* json<SessionV1.WithParts[]>(res)
          expect(body.map((item) => item.info.id)).toEqual(ids)
        }),
      ),
    ),
    { git: true },
  )

  it.instance(
    "rejects invalid cursors and missing sessions",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped

        const bad = yield* request(`/session/${session.id}/message?limit=2&before=bad`)
        expect(bad.status).toBe(400)

        const miss = yield* request(`/session/ses_missing/message?limit=2`)
        expect(miss.status).toBe(404)
      }),
    ),
    { git: true },
  )

  it.instance(
    "does not truncate large legacy limit requests",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        yield* fill(session.id, 520)

        const res = yield* request(`/session/${session.id}/message?limit=510`)
        expect(res.status).toBe(200)
        const body = yield* json<SessionV1.WithParts[]>(res)
        expect(body).toHaveLength(510)
      }),
    ),
    { git: true },
    { timeout: 15_000 },
  )

  it.instance(
    "accepts directory query used by workspace routing",
    withoutWatcher(
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const session = yield* sessionScoped
        yield* fill(session.id, 1)

        const res = yield* request(
          `/session/${session.id}/message?limit=80&directory=${encodeURIComponent(tmp.directory)}`,
        )
        expect(res.status).toBe(200)
        const body = yield* json<unknown[]>(res)
        expect(Array.isArray(body)).toBe(true)
        expect(body).toHaveLength(1)
      }),
    ),
    { git: true },
  )
})
