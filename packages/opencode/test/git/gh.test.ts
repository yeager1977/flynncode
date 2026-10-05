import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Gh } from "../../src/git/gh"
import { testEffect } from "../lib/effect"

const encoder = new TextEncoder()

type Invocation = { command: string; args: string[] }
const invocations: Invocation[] = []

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

const prOk = () => ({
  number: 42,
  state: "OPEN",
  mergeable: "MERGEABLE",
  url: "https://example.test/pr/42",
  headRefName: "feature/parity",
  statusCheckRollup: [
    { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", message: "3 tests failed" },
    { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS" },
    { __typename: "StatusContext", name: "docs", state: "SUCCESS" },
  ],
})

const prNoChecks = () => ({
  number: 7,
  state: "OPEN",
  url: "https://example.test/pr/7",
  statusCheckRollup: [],
})

// A canned gh per scenario; the fake handles every subcommand the service
// issues (auth status, pr view, pr merge) and rejects anything else.
const scenarios: Record<
  string,
  Record<string, (args: string[]) => { code: number; stdout?: string; stderr?: string }>
> = {
  ok: {
    "--version": () => ({ code: 0, stdout: "gh version 2.0.0-fake\n" }),
    auth: () => ({ code: 0 }),
    "pr view": () => ({ code: 0, stdout: JSON.stringify(prOk()) }),
    "pr merge": () => ({ code: 0 }),
  },
  "no-pr": {
    "--version": () => ({ code: 0, stdout: "gh version 2.0.0-fake\n" }),
    auth: () => ({ code: 0 }),
    "pr view": () => ({ code: 1, stderr: "no pull requests found for branch\n" }),
  },
  "auth-error": {
    "--version": () => ({ code: 0, stdout: "gh version 2.0.0-fake\n" }),
    auth: () => ({ code: 4, stderr: "gh: To get started with GitHub CLI, please run: gh auth login\n" }),
    "pr view": () => ({ code: 4, stderr: "gh: To get started with GitHub CLI, please run: gh auth login\n" }),
  },
  "merge-reject": {
    "--version": () => ({ code: 0, stdout: "gh version 2.0.0-fake\n" }),
    auth: () => ({ code: 0 }),
    "pr view": () => ({ code: 0, stdout: JSON.stringify(prOk()) }),
    "pr merge": () => ({
      code: 1,
      stderr: "Pull request is not mergeable: the merge commit cannot be cleanly created\n",
    }),
  },
  "not-installed": {},
}

const fakeGhLayer = (scenario: string) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      const canned = scenarios[scenario]
      return ChildProcessSpawner.make(
        Effect.fnUntraced(function* (command) {
          const std = ChildProcess.isStandardCommand(command) ? command : undefined
          if (!std || std.command !== "gh") return yield* real.spawn(command)
          invocations.push({ command: std.command, args: [...std.args] })
          // Subcommands arrive as `["pr", "view", ...]` / `["auth", "status"]`;
          // key the canned scenarios by the first two words joined.
          const key = [std.args[0], std.args[1]].filter((part) => part !== "status").join(" ")
          const handle = canned[key] ?? canned[std.args[0]]
          if (!handle) return respond(64, "", `unexpected gh invocation: ${std.args.join(" ")}`)
          const payload = std.args[0] === "pr" ? std.args.slice(2) : std.args.slice(1)
          const result = handle(payload)
          return respond(result.code, result.stdout ?? "", result.stderr ?? "")
        }),
      )
    }),
  ).pipe(Layer.provide(AppNodeBuilder.build(CrossSpawnSpawner.node)))

const prFields = "number,state,mergeable,statusCheckRollup,url,headRefName"

describe("Gh service contract", () => {
  const it = testEffect(
    LayerNode.compile(LayerNode.group([Gh.node]), [[CrossSpawnSpawner.node, fakeGhLayer("ok")]]),
  )

  it.live("prStatus maps the rollup to normalized checks", () =>
    Effect.gen(function* () {
      const gh = yield* Gh.Service
      const status = yield* gh.prStatus(".")
      expect(status.pr.number).toBe(42)
      expect(status.pr.state).toBe("OPEN")
      expect(status.pr.mergeable).toBe("MERGEABLE")
      expect(status.pr.url).toBe("https://example.test/pr/42")
      expect(status.pr.headRefName).toBe("feature/parity")
      expect(status.checks).toEqual([
        { name: "build", state: "SUCCESS" },
        { name: "test", state: "FAILURE", detail: "3 tests failed" },
        { name: "lint", state: "PENDING" },
        { name: "docs", state: "SUCCESS" },
      ])
    }),
  )

  it.live("prStatus requests exactly the documented JSON fields", () =>
    Effect.gen(function* () {
      invocations.length = 0
      const gh = yield* Gh.Service
      yield* gh.prStatus(".")
      const view = invocations.find((item) => item.args[0] === "pr")
      expect(view).toBeDefined()
      expect(view!.args).toEqual(["pr", "view", "--json", prFields])
    }),
  )

  it.live("authenticated passes when gh auth status exits zero", () =>
    Effect.gen(function* () {
      const gh = yield* Gh.Service
      expect(yield* gh.authenticated(".")).toBe(true)
    }),
  )

  it.live("installed() is true with the stub gh", () =>
    Effect.gen(function* () {
      const gh = yield* Gh.Service
      expect(yield* gh.installed()).toBe(true)
    }),
  )

  it.live("merge runs squash --auto and succeeds", () =>
    Effect.gen(function* () {
      invocations.length = 0
      const gh = yield* Gh.Service
      const result = yield* gh.merge(".")
      expect(result.merged).toBe(true)
      const mergeCall = invocations.find((item) => item.args[0] === "pr" && item.args[1] === "merge")
      expect(mergeCall).toBeDefined()
      expect(mergeCall!.args).toEqual(["pr", "merge", "--squash", "--auto"])
    }),
  )
})

describe("Gh service contract — no-PR branch", () => {
  const it = testEffect(
    LayerNode.compile(LayerNode.group([Gh.node]), [[CrossSpawnSpawner.node, fakeGhLayer("no-pr")]]),
  )

  it.live("prStatus fails with a typed no-PR error", () =>
    Effect.gen(function* () {
      const gh = yield* Gh.Service
      const error = yield* gh.prStatus(".").pipe(Effect.flip)
      expect(error._tag).toBe("GhNoPrError")
      expect(error.message).toContain("no pull requests")
    }),
  )
})

describe("Gh service contract — unauthenticated gh", () => {
  const it = testEffect(
    LayerNode.compile(LayerNode.group([Gh.node]), [[CrossSpawnSpawner.node, fakeGhLayer("auth-error")]]),
  )

  it.live("prStatus fails with a typed auth error", () =>
    Effect.gen(function* () {
      const gh = yield* Gh.Service
      const error = yield* gh.prStatus(".").pipe(Effect.flip)
      expect(error._tag).toBe("GhAuthError")
    }),
  )
})

describe("Gh service contract — merge rejection", () => {
  const it = testEffect(
    LayerNode.compile(LayerNode.group([Gh.node]), [[CrossSpawnSpawner.node, fakeGhLayer("merge-reject")]]),
  )

  it.live("merge surfaces the raw gh error with repo-setting hint intact", () =>
    Effect.gen(function* () {
      const gh = yield* Gh.Service
      const error = yield* gh.merge(".").pipe(Effect.flip)
      expect(error._tag).toBe("GhCommandError")
      expect(error.message).toContain("not mergeable")
    }),
  )
})

describe("Gh service contract — gh not installed", () => {
  const it = testEffect(
    LayerNode.compile(LayerNode.group([Gh.node]), [[CrossSpawnSpawner.node, fakeGhLayer("not-installed")]]),
  )

  it.live("installed() is false", () =>
    Effect.gen(function* () {
      const gh = yield* Gh.Service
      expect(yield* gh.installed()).toBe(false)
    }),
  )
})