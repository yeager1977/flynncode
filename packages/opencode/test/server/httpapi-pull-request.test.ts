import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Stream } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import fs from "fs/promises"
import path from "path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"
import { PullRequestPaths } from "../../src/server/routes/instance/httpapi/groups/pull-request"
import { Gh } from "../../src/git/gh"

const encoder = new TextEncoder()

const fakeSink = {
  [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId"),
} as never

const respond = (code: number, stdout = "", stderr = "") =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(0),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: fakeSink,
    stdout: Stream.make(encoder.encode(stdout)),
    stderr: Stream.make(encoder.encode(stderr)),
    all: Stream.empty,
    getInputFd: () => fakeSink,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  })

const prOk = {
  number: 42,
  state: "OPEN",
  mergeable: "MERGEABLE",
  url: "https://example.test/pr/42",
  statusCheckRollup: [
    { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", message: "boom" },
  ],
}

// Canned gh per scenario, keyed by scenario tag in the request directory's
// `.gh-scenario` file (mirrors the service-level contract test).
const cannedByScenario: Record<
  string,
  (args: readonly string[]) => { code: number; stdout?: string; stderr?: string }
> = {
  ok: (args) => {
    if (args[0] === "pr" && args[1] === "view") return { code: 0, stdout: JSON.stringify(prOk) }
    if (args[0] === "pr" && args[1] === "merge") return { code: 0 }
    if (args[0] === "auth") return { code: 0 }
    return { code: 64, stderr: "unexpected invocation" }
  },
  "no-pr": (args) => {
    if (args[0] === "pr" && args[1] === "view") return { code: 1, stderr: "no pull requests found for branch" }
    if (args[0] === "auth") return { code: 0 }
    return { code: 64, stderr: "unexpected invocation" }
  },
}

const fakeGhLayer = (scenario: string) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      const canned = cannedByScenario[scenario]
      return ChildProcessSpawner.make(
        Effect.fnUntraced(function* (command) {
          const std = ChildProcess.isStandardCommand(command) ? command : undefined
          if (!std || std.command !== "gh") return yield* real.spawn(command)
          if (!canned) return respond(64, "", `no canned gh for scenario ${scenario}`)
          const result = canned(std.args)
          return respond(result.code, result.stdout ?? "", result.stderr ?? "")
        }),
      )
    }),
  ).pipe(Layer.provide(LayerNode.compile(CrossSpawnSpawner.node)))

const tagScenario = Effect.fn("PullRequestHttpApi.scenario")(function* (directory: string, scenario: string) {
  yield* Effect.promise(() => fs.writeFile(path.join(directory, ".gh-scenario"), scenario))
})

const runScenario = (name: string) =>
  testEffect(
    Layer.mergeAll(
      LayerNode.compile(LayerNode.group([Gh.node]), [[CrossSpawnSpawner.node, fakeGhLayer(name)]]),
      httpApiLayer,
    ),
  )

function makeSuite(name: string) {
  const it = runScenario(name)
  afterEach(async () => {
    await disposeAllInstances()
    await resetDatabase()
  })
  return it
}

const get = (directory: string) => requestInDirectory(PullRequestPaths.status, directory)
const post = (directory: string, path2: string) =>
  requestInDirectory(path2, directory, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })

describe("pull-request HttpApi", () => {
  const it = makeSuite("ok")

  it.instance(
    "returns the PR and CI checks for the routed directory",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        yield* tagScenario(tmp.directory, "ok")
        const response = yield* get(tmp.directory)
        expect(response.status).toBe(200)
        const body = (yield* (response.json as Effect.Effect<unknown, never, never>)) as {
          pr: { number: number; state: string; url: string }
          checks: Array<{ name: string; state: string; detail?: string }>
        }
        expect(body.pr.number).toBe(42)
        expect(body.pr.state).toBe("OPEN")
        expect(body.pr.url).toBe("https://example.test/pr/42")
        expect(body.checks).toEqual([
          { name: "build", state: "SUCCESS" },
          { name: "test", state: "FAILURE", detail: "boom" },
        ])
      }),
  )

  it.instance(
    "merge schedules the squash auto-merge",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        yield* tagScenario(tmp.directory, "ok")
        const response = yield* post(tmp.directory, PullRequestPaths.merge)
        expect(response.status).toBe(200)
        expect(yield* (response.json as Effect.Effect<unknown, never, never>)).toBe(true)
      }),
  )
})

describe("pull-request HttpApi — no PR", () => {
  const it = makeSuite("no-pr")

  it.instance(
    "fails with a typed no-PR error instead of a missing-route storm",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        yield* tagScenario(tmp.directory, "no-pr")
        const response = yield* get(tmp.directory)
        expect(response.status).toBe(400)
        const body = (yield* (response.json as Effect.Effect<unknown, never, never>)) as {
          name: string
          data: { message: string }
        }
        expect(body.name).toBe("GhNoPrError")
        expect(body.data.message).toContain("no pull requests")
      }),
  )
})