import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Schema } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { mkdirSync } from "fs"
import os from "os"
import path from "path"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { locationServiceMapLayer } from "@flynncode/core/location-services"
import { SessionStatusLine } from "@flynncode/schema/session-statusline"
import { HooksTrustList } from "../../src/server/routes/instance/httpapi/groups/config"
import { SessionStatusLinePaths } from "../../src/server/routes/instance/httpapi/groups/session-statusline"
import { Session } from "../../src/session/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { waitGlobalBusEvent } from "../server/global-bus"
import { route } from "../server/httpapi-exercise/dsl"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"

// os.tmpdir() falls back to /tmp, a quota-limited tmpfs, when TMPDIR is unset.
process.env.TMPDIR ??= path.join(os.homedir(), ".cache", "flynncode-test-tmp")
mkdirSync(process.env.TMPDIR, { recursive: true })

// The served app's own status line service, with the real clock.
const it = testEffectShared(
  Layer.mergeAll(httpApiLayer, LayerNode.compile(LayerNode.group([Session.node])), locationServiceMapLayer),
)

const savedTrust = process.env.FLYNNCODE_HOOKS_TRUST_FILE
const trustPath = path.join(process.env.TMPDIR, `flynncode-statusline-route-trust-${process.pid}.json`)

beforeEach(async () => {
  process.env.FLYNNCODE_HOOKS_TRUST_FILE = trustPath
  await Bun.write(trustPath, "[]")
})

afterEach(async () => {
  if (savedTrust === undefined) delete process.env.FLYNNCODE_HOOKS_TRUST_FILE
  else process.env.FLYNNCODE_HOOKS_TRUST_FILE = savedTrust
  await Bun.file(trustPath)
    .delete()
    .catch(() => undefined)
  await disposeAllInstances()
  await resetDatabase()
})

const decode =
  <S extends Schema.Top>(schema: S) =>
  (response: HttpClientResponse.HttpClientResponse) =>
    HttpClientResponse.schemaBodyJson(schema)(response).pipe(Effect.orDie)

const listHooks = (dir: string) =>
  Effect.gen(function* () {
    return yield* decode(HooksTrustList)(yield* requestInDirectory("/config/hooks/trust", dir))
  })

const approve = (dir: string, hash: string) =>
  requestInDirectory("/config/hooks/trust", dir, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hash }),
  })

const statusLineEvent = (sessionID: string) =>
  waitGlobalBusEvent({
    predicate: (item) =>
      item.payload.type === SessionStatusLine.Event.Updated.type && item.payload.properties.sessionID === sessionID,
    timeout: 5_000,
  }).pipe(Effect.forkChild)

describe("session status line HttpApi", () => {
  it.instance(
    "a native status line awaits review, runs once trusted, and the next GET returns its lines",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        yield* Effect.promise(() =>
          Bun.write(path.join(dir, "status.sh"), "echo run >> runs.log\necho '  left'\necho right"),
        )
        const session = yield* sessions.create({ title: "Status route" })
        const get = (sessionID: string) => requestInDirectory(route(SessionStatusLinePaths.get, { sessionID }), dir)

        const entry = (yield* listHooks(dir)).hooks.find((item) => item.event === "StatusLine")
        expect(entry).toMatchObject({ event: "StatusLine", matcher: "", summary: "sh ./status.sh", trusted: false })
        expect(entry?.source).toBeUndefined()
        if (!entry) throw new Error("the status line is not listed")

        // Untrusted: watched, but nothing runs.
        const first = yield* get(session.id)
        expect(first.status).toBe(200)
        expect(yield* decode(SessionStatusLine.Result)(first)).toEqual({ lines: [] })
        yield* Effect.promise(() => Bun.sleep(400))
        expect(yield* Effect.promise(() => Bun.file(path.join(dir, "runs.log")).exists())).toBe(false)

        // Trusting it runs the watched session without waiting for a change.
        const event = yield* statusLineEvent(session.id)
        yield* Effect.yieldNow
        expect((yield* approve(dir, entry.hash)).status).toBe(200)
        const published = yield* Fiber.join(event)
        expect(published.directory).toBe(dir)
        // `padding` puts its spaces before each line, after the script's own.
        expect(published.payload.properties).toEqual({ sessionID: session.id, lines: ["    left", "  right"] })

        const second = yield* decode(SessionStatusLine.Result)(yield* get(session.id))
        expect(second.lines).toEqual(["    left", "  right"])
        expect(second.updatedAt).toBeNumber()

        expect((yield* get("ses_statusline_missing")).status).toBe(404)
      }),
    { git: true, config: { statusLine: { type: "command", command: "sh ./status.sh", padding: 2 } } },
  )

  it.instance(
    "an untrusted Claude status line awaits review on the hooks page and runs once trusted",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const entry = (yield* listHooks(dir)).hooks.find((item) => item.event === "StatusLine")
        expect(entry).toMatchObject({
          event: "StatusLine",
          matcher: "",
          summary: "sh ./claude-status.sh",
          trusted: false,
          source: `claude:project:${path.join(dir, ".claude")}`,
        })
        if (!entry) throw new Error("the status line is not listed")

        const session = yield* sessions.create({ title: "Claude status" })
        const get = () => requestInDirectory(route(SessionStatusLinePaths.get, { sessionID: session.id }), dir)
        expect(yield* decode(SessionStatusLine.Result)(yield* get())).toEqual({ lines: [] })

        const event = yield* statusLineEvent(session.id)
        yield* Effect.yieldNow
        expect((yield* approve(dir, entry.hash)).status).toBe(200)
        expect((yield* Fiber.join(event)).payload.properties.lines).toEqual(["trusted line"])
      }),
    {
      git: true,
      // Before the instance loads its config.
      init: (dir) =>
        Effect.promise(async () => {
          await Bun.write(
            path.join(dir, ".claude", "settings.json"),
            JSON.stringify({ statusLine: { type: "command", command: "sh ./claude-status.sh" } }),
          )
          await Bun.write(path.join(dir, "claude-status.sh"), "echo trusted line")
        }),
    },
  )
})
