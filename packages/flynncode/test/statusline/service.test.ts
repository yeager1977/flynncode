import { afterEach, beforeEach, describe, expect, test } from "bun:test"
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
import { SessionStatus } from "@/session/status"
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
      SessionStatus.node,
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

// Every status line needs trust, native ones included.
const trustStatusLine = Effect.gen(function* () {
  const config = yield* Config.Service
  const trust = yield* HooksTrust.Service
  const line = (yield* config.get()).statusLine
  if (!line) return yield* Effect.die(new Error("no status line is configured"))
  yield* trust.trust(yield* HooksTrust.bindToInstance(StatusLine.hookDef(line)))
})

const writeConfig = (dir: string, config: object) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => Bun.write(path.join(dir, "opencode.json"), JSON.stringify(config)))
    const service = yield* Config.Service
    yield* service.invalidate()
  })

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

const addMessages = Effect.fn("Test.addMessages")(function* (
  sessionID: SessionID,
  tokens = { input: 1_000, output: 200, reasoning: 0, cache: { read: 300, write: 0 } },
) {
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
  // Two tools that overlap: 400 ms of the message's 1500 ms is tool time, not model time.
  yield* Effect.forEach([0, 1], (index) =>
    sessions.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: assistant,
      type: "tool",
      callID: `call_${index}`,
      tool: "bash",
      state: {
        status: "completed",
        input: {},
        output: "",
        title: "",
        metadata: {},
        time: { start: created + 500 + index * 100, end: created + 800 + index * 100 },
      },
    }),
  )
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
        yield* trustStatusLine
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
            // Since this process first served the session; the clock has not moved.
            total_duration_ms: 0,
            total_api_duration_ms: 1_100,
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
        yield* trustStatusLine
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
        yield* trustStatusLine
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
        yield* trustStatusLine
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
        yield* trustStatusLine
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

  it.instance(
    "every status line needs trust: untrusted is skipped and cleared, trusted runs, a changed command needs trust again",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const events = yield* statusEvents()
        const clock = manualClock()
        const service = yield* StatusLine.make({ clock })
        yield* script(dir, "echo run >> runs.log\necho trusted")
        const session = yield* sessions.create({ title: "Native trust" })

        expect(yield* service.get(session.id)).toEqual({ lines: [] })
        yield* pause(300)
        expect(yield* Effect.promise(() => runs(dir))).toBe(0)

        // Trusting it on the Hooks page refreshes the watched sessions at once.
        yield* trustStatusLine
        yield* clock.advance(StatusLine.THROTTLE_MS)
        yield* service.refresh()
        yield* until(() => events.length === 1, "the trusted status line never ran")
        expect(events[0]).toEqual({ sessionID: session.id, lines: ["trusted"] })

        // A different command is a different trust identity: it is skipped, and the old lines are cleared.
        yield* writeConfig(dir, { ...configured, statusLine: { type: "command", command: "sh ./status.sh --v2" } })
        yield* clock.advance(StatusLine.THROTTLE_MS)
        yield* sessions.setTitle({ sessionID: session.id, title: "changed command" })
        yield* until(() => events.length === 2, "the untrusted command's lines were never cleared")
        expect(events[1]).toEqual({ sessionID: session.id, lines: [] })
        expect(yield* Effect.promise(() => runs(dir))).toBe(1)

        yield* trustStatusLine
        yield* clock.advance(StatusLine.THROTTLE_MS)
        yield* service.refresh()
        yield* until(() => events.length === 3, "the trusted new command never ran")
        expect(events[2]).toEqual({ sessionID: session.id, lines: ["trusted"] })
        expect(yield* Effect.promise(() => runs(dir))).toBe(2)
      }),
    { git: true, config: configured },
  )

  it.instance(
    "hooks.disableAllHooks turns the status line off and clears what a watched session showed",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const events = yield* statusEvents()
        const clock = manualClock()
        yield* script(dir, "echo run >> runs.log\necho shown")
        yield* trustStatusLine
        const session = yield* sessions.create({ title: "Kill switch" })
        const listeners = GlobalBus.listenerCount("event")
        const service = yield* StatusLine.make({ clock })
        yield* service.get(session.id)
        yield* until(() => events.length === 1, "the status line never ran")

        yield* writeConfig(dir, { ...configured, hooks: { disableAllHooks: true } })
        expect(yield* service.get(session.id)).toEqual({ lines: [] })
        expect(events[1]).toEqual({ sessionID: session.id, lines: [] })
        expect(GlobalBus.listenerCount("event")).toBe(listeners)
        yield* clock.advance(StatusLine.STALE_MS)
        yield* sessions.setTitle({ sessionID: session.id, title: "off" })
        expect(yield* service.get(session.id)).toEqual({ lines: [] })
        yield* pause(200)
        expect(yield* Effect.promise(() => runs(dir))).toBe(1)
      }),
    { git: true, config: configured },
  )

  it.instance(
    "a watch no get renews for WATCH_MS ends once its session is idle",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service
        const clock = manualClock()
        yield* script(dir, "echo run >> runs.log\necho run $(wc -l < runs.log)")
        yield* trustStatusLine
        const session = yield* sessions.create({ title: "Lease" })
        const listeners = GlobalBus.listenerCount("event")
        const service = yield* StatusLine.make({ clock })
        yield* service.get(session.id)
        yield* until(() => runs(dir).then((count) => count === 1), "the first run never started")

        // Unrenewed but working: the line keeps updating through the turn.
        yield* clock.advance(StatusLine.THROTTLE_MS)
        yield* status.set(session.id, { type: "busy" })
        yield* until(() => runs(dir).then((count) => count === 2), "the busy run never started")
        yield* clock.advance(StatusLine.WATCH_MS)
        yield* sessions.setTitle({ sessionID: session.id, title: "still working" })
        yield* until(() => runs(dir).then((count) => count === 3), "a working session stopped updating")

        // Idle and unrenewed: the watch ends without another run.
        yield* clock.advance(StatusLine.THROTTLE_MS)
        yield* status.set(session.id, { type: "idle" })
        yield* until(() => GlobalBus.listenerCount("event") === listeners, "the expired watch was never dropped")
        yield* clock.advance(StatusLine.THROTTLE_MS)
        yield* sessions.setTitle({ sessionID: session.id, title: "nobody watching" })
        yield* pause(200)
        expect(yield* Effect.promise(() => runs(dir))).toBe(3)

        // A get starts a new watch.
        yield* service.get(session.id)
        yield* until(() => runs(dir).then((count) => count === 4), "a new get never ran it again")
      }),
    { git: true, config: configured },
  )

  it.instance(
    "watches at most MAX_WATCHED sessions, evicting the least recently requested",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const clock = manualClock()
        const service = yield* StatusLine.make({ clock })
        yield* script(dir, "echo run >> runs.log\necho ok")
        yield* trustStatusLine
        const created = yield* Effect.forEach(Array.from({ length: StatusLine.MAX_WATCHED + 1 }), (_, index) =>
          sessions.create({ title: `Watched ${index}` }),
        )
        const ids = created.map((session) => session.id)
        yield* Effect.forEach(ids.slice(0, StatusLine.MAX_WATCHED), (id) => service.get(id))
        yield* until(
          () => runs(dir).then((count) => count === StatusLine.MAX_WATCHED),
          "the watched sessions never ran",
        )
        // Renewing the first makes the second the least recently requested.
        yield* service.get(ids[0])
        yield* service.get(ids[StatusLine.MAX_WATCHED])
        yield* until(
          () => runs(dir).then((count) => count === StatusLine.MAX_WATCHED + 1),
          "the ninth session never ran",
        )

        yield* clock.advance(StatusLine.THROTTLE_MS)
        yield* sessions.setTitle({ sessionID: ids[1], title: "evicted" })
        yield* pause(200)
        expect(yield* Effect.promise(() => runs(dir))).toBe(StatusLine.MAX_WATCHED + 1)
        yield* sessions.setTitle({ sessionID: ids[0], title: "kept" })
        yield* until(
          () => runs(dir).then((count) => count === StatusLine.MAX_WATCHED + 2),
          "the renewed session stopped running",
        )
      }),
    { git: true, config: configured },
  )

  it.instance(
    "runs at most MAX_RUNS commands at once across sessions",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const clock = manualClock()
        const service = yield* StatusLine.make({ clock })
        const hold = path.join(dir, "hold")
        yield* script(dir, ["echo run >> runs.log", "while [ -f hold ]; do sleep 0.02; done", "echo ok"].join("\n"))
        yield* trustStatusLine
        yield* Effect.promise(() => Bun.write(hold, ""))
        const created = yield* Effect.forEach([0, 1, 2], (index) => sessions.create({ title: `Limit ${index}` }))
        yield* Effect.gen(function* () {
          yield* Effect.forEach(created, (session) => service.get(session.id))
          yield* until(() => runs(dir).then((count) => count === StatusLine.MAX_RUNS), "the first runs never started")
          yield* pause(300)
          expect(yield* Effect.promise(() => runs(dir))).toBe(StatusLine.MAX_RUNS)
        }).pipe(
          Effect.ensuring(
            Effect.promise(() =>
              Bun.file(hold)
                .delete()
                .catch(() => undefined),
            ),
          ),
        )
        yield* until(() => runs(dir).then((count) => count === 3), "the queued run never started")
        yield* waitFor(
          service.get(created[2].id),
          (result) => result.lines[0] === "ok",
          "the queued run's lines never arrived",
        )
      }),
    { git: true, config: configured },
  )

  it.instance(
    "exceeds_200k_tokens counts the input and cache tokens of the last request",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const sessions = yield* Session.Service
        const clock = manualClock()
        const service = yield* StatusLine.make({ clock })
        yield* script(dir, "cat > input.json\necho run >> runs.log\necho ok")
        yield* trustStatusLine
        const input = () => Effect.promise(() => Bun.file(path.join(dir, "input.json")).json())

        const output = yield* sessions.create({ title: "Mostly output" })
        yield* addMessages(output.id, { input: 150_000, output: 60_000, reasoning: 0, cache: { read: 0, write: 0 } })
        yield* service.get(output.id)
        yield* until(() => runs(dir).then((count) => count === 1), "the first run never happened")
        yield* waitFor(service.get(output.id), (result) => result.lines.length > 0, "the first run never finished")
        expect(yield* input()).toMatchObject({ exceeds_200k_tokens: false, context: { used_tokens: 210_000 } })

        const cached = yield* sessions.create({ title: "Mostly cache" })
        yield* addMessages(cached.id, {
          input: 150_000,
          output: 10,
          reasoning: 0,
          cache: { read: 40_000, write: 20_000 },
        })
        yield* service.get(cached.id)
        yield* until(() => runs(dir).then((count) => count === 2), "the second run never happened")
        yield* waitFor(service.get(cached.id), (result) => result.lines.length > 0, "the second run never finished")
        expect(yield* input()).toMatchObject({ exceeds_200k_tokens: true })
      }),
    { git: true, config: configured },
  )
})

describe("StatusLine.parse", () => {
  const ESC = "\u001b"

  test("keeps SGR and printable text and drops every other escape and control", () => {
    const line = [
      `${ESC}[2J${ESC}[H${ESC}[?25l`,
      `${ESC}]0;title\u0007${ESC}]52;c;Zm9v\u0007`,
      `${ESC}]8;;http://example.com${ESC}\\link${ESC}]8;;${ESC}\\`,
      `${ESC}P1$r${ESC}\\${ESC}_apc${ESC}\\${ESC}^pm${ESC}\\`,
      `${ESC}[48;2;10;20;30m seg ${ESC}[0m`,
      "\u009b2J\u009d0;t\u0007\u0085",
      "a\u0000b\u0007c\td\re",
      "x\u202ey\u2066z\u2069",
      `${ESC}7${ESC}(B`,
    ].join("")
    expect(StatusLine.parse(line, 0)).toEqual([`link${ESC}[48;2;10;20;30m seg ${ESC}[0mabcdexyz`])
  })

  test("the cap counts visible characters only and never cuts an escape", () => {
    const hyperlink = StatusLine.parse(`${ESC}]8;;http://example.com/${"p".repeat(300)}${ESC}\\${"x".repeat(250)}`, 0)
    expect(hyperlink).toEqual(["x".repeat(StatusLine.MAX_CHARS)])
    const styled = StatusLine.parse(`${ESC}[31m${"y".repeat(199)}${ESC}[1;48;5;4mzz${ESC}[0m`, 2)
    expect(styled).toEqual([`  ${ESC}[31m${"y".repeat(199)}${ESC}[1;48;5;4mz${ESC}[0m`])
  })

  test("a line left with nothing visible does not count as one of the two", () => {
    expect(StatusLine.parse(`${ESC}]0;only a title\u0007\n${ESC}[31m${ESC}[0m\none\ntwo\nthree`, 0)).toEqual([
      "one",
      "two",
    ])
  })
})
