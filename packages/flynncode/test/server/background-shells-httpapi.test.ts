import { afterEach, describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Schema } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { AppProcess } from "@flynncode/core/process"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { FSUtil } from "@flynncode/core/fs-util"
import { locationServiceMapLayer } from "@flynncode/core/location-services"
import { ShellBackground } from "@flynncode/schema/shell-background"
import { BackgroundShellsPaths } from "../../src/server/routes/instance/httpapi/groups/background-shells"
import { BackgroundShells } from "../../src/shell/background/service"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin"
import { Session } from "../../src/session/session"
import { MessageID, SessionID } from "../../src/session/schema"
import { ShellTool } from "../../src/tool/shell"
import type { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffectShared } from "../lib/effect"
import { route } from "./httpapi-exercise/dsl"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// Built through the shared memoMap so the test and the served routes see the same global BackgroundShells service.
const it = testEffectShared(
  Layer.mergeAll(
    httpApiLayer,
    LayerNode.compile(
      LayerNode.group([
        AppProcess.node,
        BackgroundShells.node,
        CrossSpawnSpawner.node,
        FSUtil.node,
        Plugin.node,
        Truncate.node,
        Config.node,
        Agent.node,
        RuntimeFlags.node,
        Session.node,
      ]),
    ),
    locationServiceMapLayer,
  ),
)

// Safety net: every started group is SIGKILLed even when a test fails before the layer finalizer runs.
const started = new Set<number>()
afterEach(async () => {
  started.forEach((pid) => {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {}
  })
  started.clear()
  await disposeAllInstances()
  await resetDatabase()
})

const start = (sessionID: string, command: string, directory: string) =>
  Effect.gen(function* () {
    const shells = yield* BackgroundShells.Service
    const shell = yield* shells.start({
      sessionID,
      command,
      cwd: directory,
      directory,
      env: { PATH: process.env.PATH ?? "" },
      shell: "/bin/sh",
    })
    started.add(shell.pid)
    return shell
  })

// Responses are decoded with the published schemas, so a test also fails on a wire shape the SDK would not describe.
const decode =
  <S extends Schema.Top>(schema: S) =>
  (response: HttpClientResponse.HttpClientResponse) =>
    HttpClientResponse.schemaBodyJson(schema)(response).pipe(Effect.orDie)

const outputPath = (sessionID: string, id: string, offset?: string) =>
  route(BackgroundShellsPaths.output, { sessionID, id }) + (offset === undefined ? "" : `?offset=${offset}`)

const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

// A real foreground bash call with a call id the app can name; resolves once it printed `marker`.
const foreground = (sessionID: string, callID: string, command: string, marker: RegExp) =>
  Effect.gen(function* () {
    const seen = { output: "" }
    const controller = new AbortController()
    const ctx: Tool.Context = {
      sessionID: SessionID.make(sessionID),
      messageID: MessageID.make("msg_promote_route"),
      callID,
      agent: "build",
      abort: controller.signal,
      messages: [],
      extra: {},
      metadata: (value) =>
        Effect.sync(() => {
          const output = value.metadata?.output
          if (typeof output === "string") seen.output = output
        }),
      ask: () => Effect.void,
    }
    const tool = yield* (yield* ShellTool).init()
    const fiber = yield* tool.execute({ command }, ctx).pipe(Effect.forkChild)
    const match = yield* pollWithTimeout(
      Effect.sync(() => seen.output.match(marker) ?? undefined),
      `foreground call never printed ${marker}`,
      "8 seconds",
    )
    return { fiber, controller, match }
  })

const outputOf = (directory: string, sessionID: string, id: string, offset?: string) =>
  requestInDirectory(outputPath(sessionID, id, offset), directory).pipe(Effect.flatMap(decode(ShellBackground.Chunk)))

describe("background shells HttpApi", () => {
  it.instance(
    "lists only the shells of the requested session",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const own = yield* start("ses_shells_a", "sleep 30", tmp.directory)
        yield* start("ses_shells_b", "sleep 30", tmp.directory)
        const response = yield* requestInDirectory(
          route(BackgroundShellsPaths.list, { sessionID: "ses_shells_a" }),
          tmp.directory,
        )
        expect(response.status).toBe(200)
        const body = yield* decode(Schema.Array(ShellBackground.Info))(response)
        expect(body).toEqual([
          {
            id: own.id,
            sessionID: "ses_shells_a",
            command: "sleep 30",
            pid: own.pid,
            outputPath: own.outputPath,
            startedAt: own.startedAt,
            status: "running",
          },
        ])
        const empty = yield* requestInDirectory(
          route(BackgroundShellsPaths.list, { sessionID: "ses_shells_none" }),
          tmp.directory,
        )
        expect(yield* decode(Schema.Array(ShellBackground.Info))(empty)).toEqual([])
      }),
    15_000,
  )

  it.instance(
    "reads output from a logical offset without advancing the agent's read position",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const shells = yield* BackgroundShells.Service
        const shell = yield* start("ses_shells_out", "printf 'alpha\\nbeta\\n'", tmp.directory)
        yield* pollWithTimeout(
          shells.list("ses_shells_out").pipe(Effect.map((list) => (list[0]?.status === "exited" ? true : undefined))),
          "shell never exited",
          "8 seconds",
        )
        expect(yield* outputOf(tmp.directory, "ses_shells_out", shell.id)).toEqual({
          text: "alpha\nbeta\n",
          offset: 11,
          skipped: 0,
          truncated: false,
        })
        expect(yield* outputOf(tmp.directory, "ses_shells_out", shell.id, "6")).toEqual({
          text: "beta\n",
          offset: 11,
          skipped: 0,
          truncated: false,
        })
        expect((yield* outputOf(tmp.directory, "ses_shells_out", shell.id, "11")).text).toBe("")
        const agent = yield* shells.read({ sessionID: "ses_shells_out", id: shell.id })
        expect(agent?.output).toBe("alpha\nbeta\n")
      }),
    15_000,
  )

  it.instance(
    "rejects an invalid offset and reports unknown or foreign shells as not found",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const shell = yield* start("ses_shells_bad", "sleep 30", tmp.directory)
        const statuses = yield* Effect.forEach(["-1", "1.5", "abc"], (offset) =>
          requestInDirectory(outputPath("ses_shells_bad", shell.id, offset), tmp.directory).pipe(
            Effect.map((response) => response.status),
          ),
        )
        expect(statuses).toEqual([400, 400, 400])
        const missing = yield* requestInDirectory(outputPath("ses_shells_bad", "bash_missing"), tmp.directory)
        expect(missing.status).toBe(404)
        const foreign = yield* requestInDirectory(outputPath("ses_shells_other", shell.id), tmp.directory)
        expect(foreign.status).toBe(404)
      }),
    15_000,
  )

  it.instance(
    "stop kills a running shell of the session and returns it",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const shell = yield* start("ses_shells_stop", "sleep 30", tmp.directory)
        const post = (sessionID: string, id: string) =>
          requestInDirectory(route(BackgroundShellsPaths.stop, { sessionID, id }), tmp.directory, { method: "POST" })
        const foreign = yield* post("ses_shells_other", shell.id)
        expect(foreign.status).toBe(404)
        const missing = yield* post("ses_shells_stop", "bash_missing")
        expect(missing.status).toBe(404)
        const response = yield* post("ses_shells_stop", shell.id)
        expect(response.status).toBe(200)
        const body = yield* decode(ShellBackground.Info)(response)
        expect(body.id).toBe(shell.id)
        expect(body.status).toBe("killed")
        expect(body.endedAt).toBeNumber()
      }),
    15_000,
  )

  it.instance(
    "promote moves a real running call to the background, answers 409 at the shell limit and 404 for an unknown call",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const shells = yield* BackgroundShells.Service
        const sessionID = "ses_shells_promote_real"
        const post = (callID: string) =>
          requestInDirectory(route(BackgroundShellsPaths.promote, { sessionID }), tmp.directory, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ callID }),
          })
        expect((yield* post("call_unknown")).status).toBe(404)

        const moved = yield* foreground(sessionID, "call_real", "echo up; sleep 60", /up/)
        const response = yield* post("call_real")
        expect(response.status).toBe(200)
        const shell = yield* decode(ShellBackground.Info)(response)
        started.add(shell.pid)
        expect(shell.status).toBe("running")
        const result = yield* Fiber.join(moved.fiber)
        expect(result.metadata.background).toBe(true)
        expect(groupAlive(shell.pid)).toBe(true)

        yield* Effect.forEach(Array.from({ length: 7 }), () => start(sessionID, "sleep 60", tmp.directory))
        const blocked = yield* foreground(sessionID, "call_full", "echo pid=$$; sleep 60", /pid=(\d+)/)
        const pid = Number(blocked.match[1])
        expect((yield* post("call_full")).status).toBe(409)
        // A refused promotion leaves the call in the foreground, where its abort still ends the process.
        expect(groupAlive(pid)).toBe(true)
        blocked.controller.abort()
        const aborted = yield* Fiber.join(blocked.fiber)
        expect(aborted.metadata.background).not.toBe(true)
        expect(aborted.output).toContain("User aborted the command")
        expect(groupAlive(pid)).toBe(false)
        expect((yield* shells.list(sessionID)).filter((item) => item.status === "running")).toHaveLength(8)
        yield* shells.killSession(sessionID)
        expect(groupAlive(shell.pid)).toBe(false)
      }),
    30_000,
  )

  it.instance(
    "promote runs the offered promotion of a running call and maps its failures",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const shells = yield* BackgroundShells.Service
        const shell = yield* start("ses_shells_promote", "sleep 30", tmp.directory)
        const post = (callID: string) =>
          requestInDirectory(route(BackgroundShellsPaths.promote, { sessionID: "ses_shells_promote" }), tmp.directory, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ callID }),
          })
        expect((yield* post("call_missing")).status).toBe(404)
        yield* shells.offer({ sessionID: "ses_shells_promote", callID: "call_ok", promote: Effect.succeed(shell) })
        const response = yield* post("call_ok")
        expect(response.status).toBe(200)
        expect((yield* decode(ShellBackground.Info)(response)).id).toBe(shell.id)
        yield* shells.offer({
          sessionID: "ses_shells_promote",
          callID: "call_full",
          promote: Effect.fail(new BackgroundShells.ShellLimitError({ message: "too many" })),
        })
        expect((yield* post("call_full")).status).toBe(409)
        // A withdrawn offer is gone.
        yield* shells.withdraw({ sessionID: "ses_shells_promote", callID: "call_ok" })
        expect((yield* post("call_ok")).status).toBe(404)
      }),
    15_000,
  )
})
