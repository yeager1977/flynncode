import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdirSync } from "fs"
import os from "os"
import path from "path"
import { Database } from "@flynncode/core/database/database"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { InstallationVersion } from "@flynncode/core/installation/version"
import { ModelV2 } from "@flynncode/core/model"
import { ProviderV2 } from "@flynncode/core/provider"
import { SessionProjector } from "@flynncode/core/session/projector"
import type { SessionV1 } from "@flynncode/core/v1/session"
import { SessionStatusLine } from "@flynncode/schema/session-statusline"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ClaudeTranscript } from "@/hooks/claude-transcript"
import { HooksTrust } from "@/hooks/trust"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { StatusLine } from "@/statusline/service"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { testProviderConfig } from "../lib/test-provider"

// Real scripts, a real database and real sessions; only the clock is injected. Each test builds its own service with
// `StatusLine.make` and drives time with `clock.advance`.

// os.tmpdir() falls back to /tmp, a quota-limited tmpfs, when TMPDIR is unset.
process.env.TMPDIR ??= path.join(os.homedir(), ".cache", "flynncode-test-tmp")
mkdirSync(process.env.TMPDIR, { recursive: true })

// The real bootstrap loads config before tests write their files.
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionProjector.node,
      InstanceStore.node,
      Config.node,
      Provider.node,
      HooksTrust.node,
      RuntimeFlags.node,
      Database.node,
    ]),
    [[InstanceStore.bootstrapNode, noopBootstrap]],
  ),
)

const savedTrust = process.env.FLYNNCODE_HOOKS_TRUST_FILE
const trustPath = path.join(process.env.TMPDIR, `flynncode-statusline-trust-${process.pid}.json`)

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
})

// A clock whose time only moves when the test says so; sleepers wake once it reaches their deadline.
function manualClock() {
  const state = { now: 1_000_000, waiters: [] as Array<{ at: number; wake: () => void }> }
  return {
    now: () => state.now,
    sleep: (ms: number) =>
      Effect.callback<void>((resume) => {
        const waiter = { at: state.now + ms, wake: () => resume(Effect.void) }
        state.waiters.push(waiter)
        return Effect.sync(() => {
          state.waiters = state.waiters.filter((item) => item !== waiter)
        })
      }),
    advance: (ms: number) =>
      Effect.sync(() => {
        state.now += ms
        const due = state.waiters.filter((item) => item.at <= state.now)
        state.waiters = state.waiters.filter((item) => item.at > state.now)
        due.forEach((item) => item.wake())
      }),
  }
}

// Real time, for what real processes do.
const until = (check: () => boolean | Promise<boolean>, message: string, ms = 5_000) =>
  Effect.promise(async () => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await check()) return
      await Bun.sleep(10)
    }
    throw new Error(message)
  })

const pause = (ms: number) => Effect.promise(() => Bun.sleep(ms))

const waitFor = <A, E>(effect: Effect.Effect<A, E>, check: (value: A) => boolean, message: string, ms = 5_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const value = yield* effect
      if (check(value)) return value
      yield* pause(10)
    }
    return yield* Effect.die(new Error(message))
  })

const runs = (dir: string) =>
  Bun.file(path.join(dir, "runs.log"))
    .text()
    .then((text) => text.split("\n").filter(Boolean).length)
    .catch(() => 0)

const script = (dir: string, body: string) => Effect.promise(() => Bun.write(path.join(dir, "status.sh"), body))

const configured = {
  ...testProviderConfig("http://127.0.0.1:9"),
  statusLine: { type: "command" as const, command: "sh ./status.sh" },
}

const statusEvents = () => {
  const events: Array<{ sessionID: string; lines: string[] }> = []
  const listener = (event: GlobalEvent) => {
    if (event.payload?.type === SessionStatusLine.Event.Updated.type) events.push(event.payload.properties)
  }
  return Effect.acquireRelease(
    Effect.sync(() => {
      GlobalBus.on("event", listener)
      return events
    }),
    () => Effect.sync(() => void GlobalBus.off("event", listener)),
  )
}

const addMessages = Effect.fn("Test.addMessages")(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  const user = MessageID.ascending()
  yield* sessions.updateMessage({
    id: user,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
  } as SessionV1.Info)
  const created = Date.now()
  const assistant = MessageID.ascending()
  const tokens = { input: 1_000, output: 200, reasoning: 0, cache: { read: 300, write: 0 } }
  yield* sessions.updateMessage({
    id: assistant,
    sessionID,
    role: "assistant",
    time: { created, completed: created + 1_500 },
    parentID: user,
    modelID: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test"),
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0.25,
    tokens,
  } as SessionV1.Info)
  // The session's cost total is projected from step-finish parts.
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: assistant,
    type: "step-finish",
    reason: "stop",
    cost: 0.25,
    tokens,
  })
})

describe("StatusLine", () => {
  it.instance(
    "gives the script Claude's status JSON with real session values and keeps two lines",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const clock = manualClock()
        const service = yield* StatusLine.make({ clock })
        yield* script(
          dir,
          [
            "cat > input.json",
            'printf "%s" "$CLAUDE_PROJECT_DIR" > project-dir.txt',
            "pwd > cwd.txt",
            "echo run >> runs.log",
            String.raw`printf '\n   \nfirst \033[31mred\033[0m\nsecond\nthird\n'`,
          ].join("\n"),
        )
        const session = yield* sessions.create({ title: "Status input" })
        yield* addMessages(session.id)
        yield* sessions.setSummary({ sessionID: session.id, summary: { additions: 7, deletions: 3, files: 2 } })

        expect(yield* service.get(session.id)).toEqual({ lines: [] })
        yield* until(() => runs(dir).then((count) => count === 1), "the script never ran")
        yield* waitFor(service.get(session.id), (result) => result.lines.length === 2, "the lines never arrived")
        expect(yield* service.get(session.id)).toEqual({
          lines: ["first \x1b[31mred\x1b[0m", "second"],
          updatedAt: clock.now(),
        })
        const input = yield* Effect.promise(() => Bun.file(path.join(dir, "input.json")).json())
        expect(input).toEqual({
          hook_event_name: "Status",
          session_id: session.id,
          transcript_path: ClaudeTranscript.path(session.id),
          cwd: dir,
          version: InstallationVersion,
          model: { id: "test-model", display_name: "Test Model" },
          workspace: { current_dir: dir, project_dir: dir },
          output_style: { name: "build" },
          cost: {
            total_cost_usd: 0.25,
            total_duration_ms: expect.any(Number),
            total_api_duration_ms: 1_500,
            total_lines_added: 7,
            total_lines_removed: 3,
          },
          exceeds_200k_tokens: false,
          context: { used_tokens: 1_500, limit: 100_000 },
        })
        expect(yield* Effect.promise(() => Bun.file(ClaudeTranscript.path(session.id)).exists())).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(path.join(dir, "project-dir.txt")).text())).toBe(dir)
        expect((yield* Effect.promise(() => Bun.file(path.join(dir, "cwd.txt")).text())).trim()).toBe(dir)
      }),
    { git: true, config: configured },
  )

  it.instance(
    "runs at most once per 300 ms per session and skips a run while one is in flight",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const clock = manualClock()
        const service = yield* StatusLine.make({ clock })
        // Blocks while `hold` exists, so the test decides when a run finishes.
        yield* script(
          dir,
          ["echo run >> runs.log", "while [ -f hold ]; do sleep 0.02; done", "echo line $(wc -l < runs.log)"].join(
            "\n",
          ),
        )
        const session = yield* sessions.create({ title: "Throttle" })
        yield* service.get(session.id)
        yield* until(() => runs(dir).then((count) => count === 1), "the first run never started")
        yield* waitFor(
          service.get(session.id),
          (result) => result.lines[0] === "line 1",
          "the first run never finished",
        )

        // Rapid changes inside one window: no run until the window ends, then exactly one.
        yield* Effect.forEach(["a", "b", "c", "d"], (title) => sessions.setTitle({ sessionID: session.id, title }))
        yield* pause(150)
        expect(yield* Effect.promise(() => runs(dir))).toBe(1)
        yield* clock.advance(299)
        yield* pause(100)
        expect(yield* Effect.promise(() => runs(dir))).toBe(1)
        yield* clock.advance(1)
        yield* until(() => runs(dir).then((count) => count === 2), "the trailing run never started")
        yield* pause(150)
        expect(yield* Effect.promise(() => runs(dir))).toBe(2)

        // A run that is still going when the next is due makes that one skip; the final state still gets a run.
        yield* Effect.promise(() => Bun.write(path.join(dir, "hold"), ""))
        yield* clock.advance(300)
        yield* sessions.setTitle({ sessionID: session.id, title: "e" })
        yield* until(() => runs(dir).then((count) => count === 3), "the held run never started")
        yield* sessions.setTitle({ sessionID: session.id, title: "f" })
        yield* clock.advance(300)
        yield* sessions.setTitle({ sessionID: session.id, title: "g" })
        yield* clock.advance(300)
        yield* pause(150)
        expect(yield* Effect.promise(() => runs(dir))).toBe(3)
        yield* Effect.promise(() => Bun.file(path.join(dir, "hold")).delete())
        yield* until(() => runs(dir).then((count) => count === 4), "no trailing run after the held one")
        yield* waitFor(
          service.get(session.id),
          (result) => result.lines[0] === "line 4",
          "the trailing run's lines never arrived",
        )
        yield* pause(150)
        expect(yield* Effect.promise(() => runs(dir))).toBe(4)
      }),
    { git: true, config: configured },
  )

  it.instance(
    "a get starts a run only when the last one is older than STALE_MS",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const clock = manualClock()
        const service = yield* StatusLine.make({ clock })
        yield* script(dir, "echo run >> runs.log\necho run $(wc -l < runs.log)")
        const session = yield* sessions.create({ title: "Stale" })
        yield* service.get(session.id)
        yield* waitFor(service.get(session.id), (result) => result.lines[0] === "run 1", "the first run never finished")
        yield* clock.advance(StatusLine.STALE_MS - 1)
        yield* service.get(session.id)
        yield* pause(150)
        expect(yield* Effect.promise(() => runs(dir))).toBe(1)
        yield* clock.advance(1)
        expect((yield* service.get(session.id)).lines).toEqual(["run 1"])
        yield* waitFor(service.get(session.id), (result) => result.lines[0] === "run 2", "the stale result never reran")
        expect(yield* Effect.promise(() => runs(dir))).toBe(2)
      }),
    { git: true, config: configured },
  )

  it.instance(
    "kills a hanging script and its children after 5 s",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const clock = manualClock()
        const service = yield* StatusLine.make({ clock })
        yield* script(dir, ["echo run >> runs.log", "sleep 30 &", "echo $! > child.pid", "wait"].join("\n"))
        const session = yield* sessions.create({ title: "Timeout" })
        yield* service.get(session.id)
        yield* until(() => Bun.file(path.join(dir, "child.pid")).exists(), "the script never started")
        const pid = Number((yield* Effect.promise(() => Bun.file(path.join(dir, "child.pid")).text())).trim())
        const alive = () => {
          const result = Effect.runSync(
            Effect.try({ try: () => process.kill(pid, 0), catch: () => "gone" }).pipe(Effect.option),
          )
          return result._tag === "Some"
        }
        expect(alive()).toBe(true)
        yield* clock.advance(4_999)
        yield* pause(150)
        expect(alive()).toBe(true)
        yield* clock.advance(1)
        yield* until(() => !alive(), "the timed-out script's child is still running")
        expect(yield* service.get(session.id)).toEqual({ lines: [] })
      }),
    { git: true, config: configured },
  )

  it.instance(
    "keeps the last good lines through failures for 60 s, then clears them",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const events = yield* statusEvents()
        const clock = manualClock()
        const service = yield* StatusLine.make({ clock })
        yield* script(
          dir,
          [
            "echo run >> runs.log",
            "if [ -f fail ]; then echo broken >&2; exit 1; fi",
            "if [ -f quiet ]; then exit 0; fi",
            "echo good",
          ].join("\n"),
        )
        const session = yield* sessions.create({ title: "Failures" })
        yield* service.get(session.id)
        yield* until(() => events.length === 1, "no event for the good run")
        expect(events[0]).toEqual({ sessionID: session.id, lines: ["good"] })

        yield* Effect.promise(() => Bun.write(path.join(dir, "fail"), ""))
        yield* clock.advance(30_000)
        yield* sessions.setTitle({ sessionID: session.id, title: "fail" })
        yield* until(() => runs(dir).then((count) => count === 2), "the failing run never happened")
        yield* pause(100)
        expect((yield* service.get(session.id)).lines).toEqual(["good"])

        // Empty output is a failure too.
        yield* Effect.promise(() => Bun.file(path.join(dir, "fail")).delete())
        yield* Effect.promise(() => Bun.write(path.join(dir, "quiet"), ""))
        yield* clock.advance(1_000)
        yield* sessions.setTitle({ sessionID: session.id, title: "quiet" })
        yield* until(() => runs(dir).then((count) => count === 3), "the quiet run never happened")
        yield* pause(100)
        expect((yield* service.get(session.id)).lines).toEqual(["good"])
        expect(events).toHaveLength(1)

        // 60 s after the good run the lines go, without another run.
        yield* clock.advance(28_999)
        yield* pause(100)
        expect((yield* service.get(session.id)).lines).toEqual(["good"])
        yield* clock.advance(1)
        yield* until(() => events.length === 2, "the stale lines were never cleared")
        expect(events[1]).toEqual({ sessionID: session.id, lines: [] })
        expect((yield* service.get(session.id)).lines).toEqual([])
      }),
    { git: true, config: configured },
  )

  it.instance(
    "without a status line nothing runs and nothing subscribes",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const clock = manualClock()
        yield* script(dir, "echo run >> runs.log\necho never")
        const session = yield* sessions.create({ title: "Unconfigured" })
        const listeners = GlobalBus.listenerCount("event")
        const service = yield* StatusLine.make({ clock })
        expect(yield* service.get(session.id)).toEqual({ lines: [] })
        yield* sessions.setTitle({ sessionID: session.id, title: "changed" })
        yield* clock.advance(1_000)
        yield* pause(200)
        expect(GlobalBus.listenerCount("event")).toBe(listeners)
        expect(yield* Effect.promise(() => runs(dir))).toBe(0)
      }),
    { git: true, config: testProviderConfig("http://127.0.0.1:9") },
  )

  it.instance(
    "a project status line from Claude settings runs only once trusted",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const trust = yield* HooksTrust.Service
        yield* Effect.promise(() =>
          Bun.write(
            path.join(dir, ".claude", "settings.json"),
            JSON.stringify({ statusLine: { type: "command", command: "sh ./status.sh" } }),
          ),
        )
        yield* script(dir, "echo run >> runs.log\necho from claude")
        const clock = manualClock()
        const service = yield* StatusLine.make({ clock })
        const session = yield* sessions.create({ title: "Claude" })

        expect(yield* service.get(session.id)).toEqual({ lines: [] })
        yield* pause(300)
        expect(yield* Effect.promise(() => runs(dir))).toBe(0)

        const line = (yield* Config.Service.use((config) => config.get())).statusLine
        if (!line) throw new Error("the Claude status line was not loaded")
        expect(line.source).toBe(`claude:project:${path.join(dir, ".claude")}`)
        yield* trust.trust(yield* HooksTrust.bindToInstance(StatusLine.hookDef(line)))
        yield* clock.advance(StatusLine.STALE_MS)
        yield* service.get(session.id)
        yield* waitFor(
          service.get(session.id),
          (result) => result.lines[0] === "from claude",
          "the trusted Claude status line never ran",
        )
      }),
    { git: true, config: testProviderConfig("http://127.0.0.1:9") },
  )
})
