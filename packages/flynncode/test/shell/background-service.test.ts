import { afterEach, describe, expect, test } from "bun:test"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { AppProcess } from "@flynncode/core/process"
import { BackgroundShells } from "../../src/shell/background/service"
import { BackgroundRegistry } from "../../src/shell/background/registry"
import { pollWithTimeout, testEffect } from "../lib/effect"

const layer = LayerNode.compile(LayerNode.group([AppProcess.node, BackgroundShells.node]))
const it = testEffect(layer)

// Safety net: every started group is SIGKILLed even when a test fails before the layer finalizer runs.
const started = new Set<number>()
afterEach(() => {
  started.forEach((pid) => {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {}
  })
  started.clear()
})

const start = (
  service: BackgroundShells.Interface,
  input: {
    command: string
    sessionID?: string
    timeoutMs?: number
    notify?: (text: string) => Effect.Effect<void>
  },
) =>
  service
    .start({
      sessionID: "ses_a",
      cwd: process.cwd(),
      directory: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      shell: "/bin/sh",
      ...input,
    })
    .pipe(Effect.tap((shell) => Effect.sync(() => started.add(shell.pid))))

const collector = () => {
  const texts: string[] = []
  return { texts, notify: (text: string) => Effect.sync(() => void texts.push(text)) }
}

const statusOf = (
  service: BackgroundShells.Interface,
  sessionID: string,
  id: string,
  status: BackgroundShells.Status,
) =>
  pollWithTimeout(
    service
      .list(sessionID)
      .pipe(Effect.map((shells) => shells.find((shell) => shell.id === id && shell.status === status))),
    `shell ${id} never reached ${status}`,
    "8 seconds",
  )

const notified = (texts: string[], count = 1) =>
  pollWithTimeout(
    Effect.sync(() => (texts.length >= count ? texts : undefined)),
    `expected ${count} notification(s)`,
    "8 seconds",
  )

const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

const groupGone = (pgid: number) =>
  pollWithTimeout(
    Effect.sync(() => (groupAlive(pgid) ? undefined : true)),
    `process group ${pgid} still alive`,
    "6 seconds",
  )

describe("BackgroundShells", () => {
  it.live(
    "runs a command in the background, records its exit, and notifies once",
    () =>
      Effect.gen(function* () {
        const service = yield* BackgroundShells.Service
        const sink = collector()
        const shell = yield* start(service, { command: "sleep 0.2; echo done", notify: sink.notify })
        expect(shell.status).toBe("running")
        expect(shell.id.startsWith("bash_")).toBe(true)
        yield* statusOf(service, "ses_a", shell.id, "exited")
        const result = yield* service.read({ sessionID: "ses_a", id: shell.id })
        expect(result?.output).toContain("done")
        expect(result?.shell.status).toBe("exited")
        expect(result?.shell.exitCode).toBe(0)
        expect(result?.shell.endedAt).toBeNumber()
        const texts = yield* notified(sink.texts)
        yield* Effect.sleep("200 millis")
        expect(texts).toHaveLength(1)
        expect(texts[0]).toContain(shell.id)
        expect(texts[0]).toContain("done")
      }),
    15_000,
  )

  it.live(
    "kill terminates the whole process group without notifying",
    () =>
      Effect.gen(function* () {
        const service = yield* BackgroundShells.Service
        const sink = collector()
        const shell = yield* start(service, { command: "sh -c 'sleep 60 & sleep 60'", notify: sink.notify })
        yield* Effect.sleep("300 millis")
        const killed = yield* service.kill({ sessionID: "ses_a", id: shell.id })
        expect(killed?.status).toBe("killed")
        yield* groupGone(shell.pid)
        yield* Effect.sleep("200 millis")
        expect(sink.texts).toHaveLength(0)
        expect(yield* service.kill({ sessionID: "ses_other", id: shell.id })).toBeUndefined()
      }),
    15_000,
  )

  it.live(
    "times out at the caller's limit and notifies",
    () =>
      Effect.gen(function* () {
        const service = yield* BackgroundShells.Service
        const sink = collector()
        const shell = yield* start(service, { command: "sleep 30", timeoutMs: 300, notify: sink.notify })
        yield* statusOf(service, "ses_a", shell.id, "timed_out")
        const texts = yield* notified(sink.texts)
        expect(texts[0]).toContain(shell.id)
        expect(texts[0]).toContain("timed out")
        yield* groupGone(shell.pid)
      }),
    15_000,
  )

  it.live(
    "refuses a ninth running shell in one session but not in another",
    () =>
      Effect.gen(function* () {
        const service = yield* BackgroundShells.Service
        yield* Effect.forEach(Array.from({ length: 8 }), () => start(service, { command: "sleep 60" }))
        const error = yield* start(service, { command: "sleep 60" }).pipe(Effect.flip)
        expect(error).toBeInstanceOf(BackgroundShells.ShellLimitError)
        const other = yield* start(service, { command: "sleep 60", sessionID: "ses_b" })
        expect(other.status).toBe("running")
      }),
    20_000,
  )

  it.live(
    "read returns only output since the previous read and filters lines",
    () =>
      Effect.gen(function* () {
        const service = yield* BackgroundShells.Service
        const shell = yield* start(service, { command: "echo one; sleep 0.5; echo two; sleep 5" })
        const seen = (word: string) =>
          pollWithTimeout(
            service
              .output({ sessionID: "ses_a", id: shell.id, offset: 0 })
              .pipe(Effect.map((result) => (result?.text.includes(word) ? result : undefined))),
            `never saw ${word}`,
          )
        yield* seen("one")
        const first = yield* service.read({ sessionID: "ses_a", id: shell.id })
        expect(first?.output).toBe("one\n")
        expect(first?.truncated).toBe(false)
        yield* seen("two")
        const second = yield* service.read({ sessionID: "ses_a", id: shell.id })
        expect(second?.output).toBe("two\n")
        const output = yield* service.output({ sessionID: "ses_a", id: shell.id, offset: 0 })
        expect(output?.text).toBe("one\ntwo\n")
        expect(output?.offset).toBe(8)

        const fruit = yield* start(service, { command: "printf 'apple\\nbanana\\napricot\\n'" })
        yield* statusOf(service, "ses_a", fruit.id, "exited")
        const filtered = yield* service.read({ sessionID: "ses_a", id: fruit.id, filter: "^a" })
        expect(filtered?.output).toBe("apple\napricot\n")
        const invalid = yield* service.read({ sessionID: "ses_a", id: fruit.id, filter: "(" }).pipe(Effect.flip)
        expect(invalid).toBeInstanceOf(BackgroundShells.FilterError)
        expect(yield* service.read({ sessionID: "ses_b", id: fruit.id })).toBeUndefined()
      }),
    15_000,
  )

  it.live(
    "monitor notifies once on the first new matching line",
    () =>
      Effect.gen(function* () {
        const service = yield* BackgroundShells.Service
        const sink = collector()
        const shell = yield* start(service, { command: "sleep 0.2; echo ready; echo ready again; sleep 5" })
        yield* service.monitor({ sessionID: "ses_a", id: shell.id, pattern: "ready", notify: sink.notify })
        const texts = yield* notified(sink.texts)
        yield* Effect.sleep("300 millis")
        expect(texts).toHaveLength(1)
        expect(texts[0]).toContain(shell.id)
        expect(texts[0].endsWith(":\nready")).toBe(true)
      }),
    15_000,
  )

  it.live(
    "monitor rejects invalid patterns, reports a missed deadline, and caps monitors per session",
    () =>
      Effect.gen(function* () {
        const service = yield* BackgroundShells.Service
        const sink = collector()
        const shell = yield* start(service, { command: "sleep 10" })
        const invalid = yield* service
          .monitor({ sessionID: "ses_a", id: shell.id, pattern: "(", notify: sink.notify })
          .pipe(Effect.flip)
        expect(invalid).toBeInstanceOf(BackgroundShells.MonitorError)
        yield* service.monitor({
          sessionID: "ses_a",
          id: shell.id,
          pattern: "never",
          timeoutMs: 300,
          notify: sink.notify,
        })
        const texts = yield* notified(sink.texts)
        expect(texts[0]).toContain("pattern not seen")

        const quiet = collector()
        yield* Effect.forEach(Array.from({ length: 4 }), () =>
          service.monitor({ sessionID: "ses_a", id: shell.id, pattern: "never", notify: quiet.notify }),
        )
        const fifth = yield* service
          .monitor({ sessionID: "ses_a", id: shell.id, pattern: "never", notify: quiet.notify })
          .pipe(Effect.flip)
        expect(fifth).toBeInstanceOf(BackgroundShells.MonitorError)
        const unknown = yield* service
          .monitor({ sessionID: "ses_b", id: shell.id, pattern: "x", notify: quiet.notify })
          .pipe(Effect.flip)
        expect(unknown).toBeInstanceOf(BackgroundShells.MonitorError)
      }),
    15_000,
  )

  it.live(
    "killSession kills and drops only that session's shells",
    () =>
      Effect.gen(function* () {
        const service = yield* BackgroundShells.Service
        const mine = yield* start(service, { command: "sleep 60" })
        const done = yield* start(service, { command: "true" })
        const theirs = yield* start(service, { command: "sleep 60", sessionID: "ses_b" })
        yield* statusOf(service, "ses_a", done.id, "exited")
        expect(yield* service.killSession("ses_a")).toBe(1)
        yield* groupGone(mine.pid)
        expect(yield* service.list("ses_a")).toEqual([])
        expect(groupAlive(theirs.pid)).toBe(true)
        expect((yield* service.list("ses_b")).map((shell) => shell.status)).toEqual(["running"])
      }),
    15_000,
  )

  it.live(
    "records running shells in this server's registry and removes them on exit",
    () =>
      Effect.gen(function* () {
        const service = yield* BackgroundShells.Service
        const shell = yield* start(service, { command: "sleep 0.5" })
        const recorded = yield* Effect.promise(() => BackgroundRegistry.list(BackgroundShells.REGISTRY_DIR))
        const entry = recorded.find((item) => item.id === shell.id)
        expect(entry?.pid).toBe(shell.pid)
        expect(entry?.sessionID).toBe("ses_a")
        expect(entry?.cmdline).toContain("sleep 0.5")
        yield* statusOf(service, "ses_a", shell.id, "exited")
        const after = yield* Effect.promise(() => BackgroundRegistry.list(BackgroundShells.REGISTRY_DIR))
        expect(after.find((item) => item.id === shell.id)).toBeUndefined()
      }),
    15_000,
  )

  test("closing the layer kills every shell", async () => {
    const pids = await Effect.gen(function* () {
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(layer, scope)
      const service = Context.get(context, BackgroundShells.Service)
      const shells = yield* Effect.all([
        start(service, { command: "sh -c 'sleep 60 & sleep 60'" }),
        start(service, { command: "sleep 60", sessionID: "ses_b" }),
      ])
      yield* Effect.sleep("300 millis")
      yield* Scope.close(scope, Exit.void)
      return shells.map((shell) => shell.pid)
    }).pipe(Effect.runPromise)
    expect(pids.filter(groupAlive)).toEqual([])
  }, 15_000)
})
