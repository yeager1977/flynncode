export * as BackgroundShells from "./service"

import fs from "fs/promises"
import path from "path"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope, Semaphore, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Global } from "@flynncode/core/global"
import type { Event } from "@flynncode/schema/event"
import { ShellBackground } from "@flynncode/schema/shell-background"
import { AppProcess } from "@flynncode/core/process"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Identifier } from "@/id/id"
import { ToolID } from "@/tool/schema"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"
import { isRecord } from "@/util/record"
import { BackgroundOutput } from "./output"
import { BackgroundRegistry } from "./registry"

export const REGISTRY_DIR = path.join(Global.Path.state, "background-shells")
export const MAX_MS = 7_200_000
export const MAX_RUNNING = 8
export const MAX_MONITORS = 4
export const MONITOR_DEFAULT_MS = 600_000
export const MONITOR_MAX_MS = 1_800_000

const KEEP_FINISHED = 50
const KEEP_FINISHED_TOTAL = 200
const GROUP_POLL_MS = 1_000
const KILL_GRACE_MS = 5_000
const CAP_BYTES = 8 * 1024 * 1024
const HEAD_BYTES = 1024 * 1024
const EXIT_LINES = 20
const OUTPUT_EVENT_MS = 1_000
const TAIL_BYTES = 4 * 1024
const PARTIAL_LINE_BYTES = 64 * 1024

export type Status = "running" | "exited" | "killed" | "timed_out"

export type Shell = {
  id: string
  sessionID: string
  command: string
  pid: number
  outputPath: string
  startedAt: number
  status: Status
  exitCode?: number
  endedAt?: number
}

export class ShellLimitError extends Schema.TaggedErrorClass<ShellLimitError>()("BackgroundShellLimitError", {
  message: Schema.String,
}) {}

export class SpawnError extends Schema.TaggedErrorClass<SpawnError>()("BackgroundShellSpawnError", {
  message: Schema.String,
}) {}

export class FilterError extends Schema.TaggedErrorClass<FilterError>()("BackgroundShellFilterError", {
  message: Schema.String,
}) {}

export class MonitorError extends Schema.TaggedErrorClass<MonitorError>()("BackgroundShellMonitorError", {
  message: Schema.String,
}) {}

type Notify = (text: string) => Effect.Effect<void>

export type StartInput = {
  sessionID: string
  command: string
  cwd: string
  env: Record<string, string>
  shell: string
  // Instance directory the shell was started from; events are routed by it.
  directory: string
  timeoutMs?: number
  // `shell.backgroundMaxMs` from the caller's instance config; config is instance-scoped and this service is not.
  capMs?: number
  // The session is a sub-agent's (it has a parent): its shells die when its run ends, see `onEvent`.
  child?: boolean
  notify?: Notify
}

// A foreground process handed over while it runs. The caller spawned it into `scope` and keeps pumping its output
// through `pump`; after adoption it sends every chunk to the returned `write` instead of its own buffers.
export type AdoptInput = {
  sessionID: string
  command: string
  directory: string
  handle: ChildProcessHandle
  scope: Scope.Closeable
  pump: Fiber.Fiber<unknown, unknown>
  startedAt: number
  // Output the caller already received; it starts the shell's stream so bash_output returns it.
  initial: string
  capMs?: number
  child?: boolean
  notify?: Notify
}

export type Promotion = Effect.Effect<Shell | undefined, ShellLimitError | SpawnError>

export interface Interface {
  readonly start: (input: StartInput) => Effect.Effect<Shell, ShellLimitError | SpawnError>
  readonly adopt: (
    input: AdoptInput,
  ) => Effect.Effect<{ shell: Shell; write: (chunk: string) => Effect.Effect<void> }, ShellLimitError | SpawnError>
  // A running foreground call registers how to promote it; `promote` runs that for a user's request.
  readonly offer: (input: { sessionID: string; callID: string; promote: Promotion }) => Effect.Effect<void>
  readonly withdraw: (input: { sessionID: string; callID: string }) => Effect.Effect<void>
  readonly promote: (input: { sessionID: string; callID: string }) => Promotion
  readonly read: (input: {
    sessionID: string
    id: string
    filter?: string
  }) => Effect.Effect<{ shell: Shell; output: string; truncated: boolean } | undefined, FilterError>
  readonly output: (input: {
    sessionID: string
    id: string
    offset: number
  }) => Effect.Effect<{ text: string; offset: number; skipped: number; truncated: boolean } | undefined>
  readonly kill: (input: { sessionID: string; id: string }) => Effect.Effect<Shell | undefined>
  readonly monitor: (input: {
    sessionID: string
    id: string
    pattern: string
    timeoutMs?: number
    notify: Notify
  }) => Effect.Effect<void, MonitorError>
  readonly list: (sessionID: string) => Effect.Effect<Shell[]>
  readonly killSession: (sessionID: string) => Effect.Effect<number>
  readonly killAll: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@flynncode/BackgroundShells") {}

type Watcher = { regex: RegExp; partial: string; line?: string; wake: Deferred.Deferred<void> }

type Entry = {
  shell: Shell
  directory: string
  handle: ChildProcessHandle
  writer: BackgroundOutput.Writer
  readOffset: number
  killed: boolean
  // The whole group exited on its own before any stop; a later stop must not relabel it as killed.
  natural: boolean
  recorded: boolean
  emittedAt: number
  // writer.total() when the last output event went out, and whether a trailing event is already scheduled.
  emittedBytes: number
  trailing: boolean
  watchers: Set<Watcher>
  stopped: Deferred.Deferred<void>
  finished: Deferred.Deferred<void>
}

// Global on purpose: instances are disposed after idle time, and that must not kill a session's dev server.
// Processes are spawned into per-shell scopes owned here, never into the calling tool's scope.
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service
    const sessions = new Map<string, Map<string, Entry>>()
    const monitors = new Map<string, number>()
    const lock = yield* Semaphore.make(1)
    // Lifecycle and monitor fibers live here rather than in the layer scope so the finalizer can kill and
    // drain every shell before they are interrupted.
    const fibers = yield* Scope.make()
    const state = { closing: false }

    const offers = new Map<string, Promotion>()
    // Sub-agent sessions that started a shell; their shells are killed when the session goes idle.
    const children = new Set<string>()

    const find = (sessionID: string, id: string) => sessions.get(sessionID)?.get(id)

    const admit = Effect.fnUntraced(function* (sessionID: string) {
      if (state.closing) return yield* new SpawnError({ message: "background shells are shutting down" })
      const running = Array.from(sessions.get(sessionID)?.values() ?? []).filter(
        (entry) => entry.shell.status === "running",
      )
      if (running.length >= MAX_RUNNING)
        return yield* new ShellLimitError({
          message: `This session already has ${MAX_RUNNING} running background shells; kill one with kill_shell first.`,
        })
      yield* Effect.tryPromise({
        try: () => fs.mkdir(TRUNCATION_DIR, { recursive: true }),
        catch: (error) => new SpawnError({ message: `cannot create ${TRUNCATION_DIR}: ${String(error)}` }),
      })
    })

    const launch = Effect.fnUntraced(function* (input: StartInput) {
      yield* admit(input.sessionID)
      const cap = Math.min(input.capMs ?? MAX_MS, MAX_MS)
      const limit = Math.min(input.timeoutMs ?? cap, cap)
      const scope = yield* Scope.make()
      const handle = yield* appProcess
        .spawn(
          ChildProcess.make(input.command, [], {
            shell: input.shell,
            cwd: input.cwd,
            env: input.env,
            stdin: "ignore",
            detached: process.platform !== "win32",
          }),
        )
        .pipe(
          Scope.provide(scope),
          Effect.catch((error) =>
            Scope.close(scope, Exit.void).pipe(
              Effect.andThen(
                Effect.fail(new SpawnError({ message: `failed to start background shell: ${String(error)}` })),
              ),
            ),
          ),
        )
      if (state.closing) {
        yield* terminate(handle, handle.pid)
        yield* release(handle, scope)
        return yield* new SpawnError({ message: "background shells are shutting down" })
      }
      const entry = yield* track({ ...input, handle, startedAt: Date.now(), initial: "" })
      const pump = yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) => ingest(entry, chunk)).pipe(
        Effect.ignore,
        Effect.forkIn(fibers),
      )
      yield* record(entry)
      yield* life(entry, scope, pump, limit, input.notify).pipe(Effect.forkIn(fibers))
      return { ...entry.shell }
    })

    const adopt = Effect.fnUntraced(function* (input: AdoptInput) {
      yield* admit(input.sessionID)
      const limit = Math.min(input.capMs ?? MAX_MS, MAX_MS)
      const entry = yield* track(input)
      yield* record(entry)
      yield* life(entry, input.scope, input.pump, limit, input.notify).pipe(Effect.forkIn(fibers))
      return { shell: { ...entry.shell }, write: (chunk: string) => ingest(entry, chunk) }
    })

    const track = Effect.fnUntraced(function* (input: {
      sessionID: string
      command: string
      directory: string
      handle: ChildProcessHandle
      startedAt: number
      initial: string
      child?: boolean
    }) {
      const outputPath = path.join(TRUNCATION_DIR, ToolID.ascending())
      const entry: Entry = {
        shell: {
          id: Identifier.create("bash", "ascending"),
          sessionID: input.sessionID,
          command: input.command,
          pid: input.handle.pid,
          outputPath,
          startedAt: input.startedAt,
          status: "running",
        },
        directory: input.directory,
        handle: input.handle,
        writer: BackgroundOutput.open(outputPath, { capBytes: CAP_BYTES, headBytes: HEAD_BYTES }),
        readOffset: 0,
        killed: false,
        natural: false,
        recorded: false,
        emittedAt: 0,
        emittedBytes: 0,
        trailing: false,
        watchers: new Set(),
        stopped: yield* Deferred.make<void>(),
        finished: yield* Deferred.make<void>(),
      }
      if (input.initial) entry.writer.write(input.initial)
      if (input.child) children.add(input.sessionID)
      // Re-read at insert time: a killSession that ran meanwhile dropped the map this call started with. Listed and
      // announced before output is pumped, so `started` precedes every output and exit event of the shell.
      sessions.set(
        input.sessionID,
        (sessions.get(input.sessionID) ?? new Map<string, Entry>()).set(entry.shell.id, entry),
      )
      yield* emit(entry, ShellBackground.Event.Started, {
        sessionID: entry.shell.sessionID,
        id: entry.shell.id,
        command: entry.shell.command,
        pid: entry.shell.pid,
        startedAt: entry.shell.startedAt,
      })
      return entry
    })

    // At most one output event per second; a chunk that arrives inside the window schedules one trailing event at
    // its end, so the last output before a quiet spell still reaches the app.
    const ingest = (entry: Entry, chunk: string) =>
      Effect.suspend(() => {
        entry.writer.write(chunk)
        entry.watchers.forEach((watcher) => scan(entry, watcher, chunk))
        const wait = entry.emittedAt + OUTPUT_EVENT_MS - Date.now()
        if (wait <= 0) return publishOutput(entry)
        if (entry.trailing) return Effect.void
        entry.trailing = true
        return Effect.sleep(wait).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              entry.trailing = false
              // A finished shell's last output goes out from `life`, before its exit event.
              return entry.shell.status === "running" ? publishOutput(entry) : Effect.void
            }),
          ),
          Effect.forkIn(fibers),
          Effect.asVoid,
        )
      })

    const publishOutput = (entry: Entry) =>
      Effect.suspend(() => {
        const total = entry.writer.total()
        if (total === entry.emittedBytes) return Effect.void
        entry.emittedAt = Date.now()
        entry.emittedBytes = total
        return emit(entry, ShellBackground.Event.Output, {
          sessionID: entry.shell.sessionID,
          id: entry.shell.id,
          bytes: total,
          tail: entry.writer.readSince(total - TAIL_BYTES, { maxBytes: TAIL_BYTES }).text,
        })
      })

    // Crash cleanup identifies the group by its start time, which /proc has as soon as the process exists, so the
    // record is written at once, even for a leader that exits immediately and leaves members behind
    // (`server >log 2>&1 &`). Without /proc (or once the whole group is gone) nothing is recorded; the finalizer and
    // killSession still cover the shell.
    const record = Effect.fnUntraced(function* (entry: Entry) {
      const start = yield* Effect.promise(() => BackgroundRegistry.groupStart(entry.shell.pid))
      if (start === undefined) {
        yield* Effect.logDebug("background shell not recorded for crash cleanup: no process start time", {
          id: entry.shell.id,
          pid: entry.shell.pid,
        })
        return
      }
      yield* Effect.tryPromise(() =>
        BackgroundRegistry.add(REGISTRY_DIR, {
          id: entry.shell.id,
          sessionID: entry.shell.sessionID,
          pgid: entry.shell.pid,
          start,
          startedAt: entry.shell.startedAt,
          command: entry.shell.command,
        }),
      ).pipe(
        Effect.tap(() => Effect.sync(() => (entry.recorded = true))),
        Effect.catch((error) =>
          Effect.logWarning("background shell registry add failed", { id: entry.shell.id, error }),
        ),
      )
    })

    const life = Effect.fnUntraced(function* (
      entry: Entry,
      scope: Scope.Closeable,
      pump: Fiber.Fiber<unknown, unknown>,
      limit: number,
      notify: Notify | undefined,
    ) {
      // An adopted shell started before it was handed over; the cap counts from its real start.
      const deadline = entry.shell.startedAt + limit
      const leader = yield* Effect.raceAll([
        entry.handle.exitCode.pipe(
          Effect.map((code) => ({ kind: "exit" as const, code: Number(code) })),
          Effect.catch(() => Effect.succeed({ kind: "signal" as const })),
        ),
        Effect.sleep(Math.max(0, deadline - Date.now())).pipe(Effect.as({ kind: "timeout" as const })),
        Deferred.await(entry.stopped).pipe(Effect.as({ kind: "stopped" as const })),
      ])
      // Members the leader left behind (`server >log 2>&1 &`) keep the shell running until the group is gone.
      const outcome =
        leader.kind === "exit" || leader.kind === "signal"
          ? yield* Effect.raceAll([
              groupExit(entry).pipe(Effect.as(leader)),
              Effect.sleep(Math.max(0, deadline - Date.now())).pipe(Effect.as({ kind: "timeout" as const })),
              Deferred.await(entry.stopped).pipe(Effect.as({ kind: "stopped" as const })),
            ])
          : leader
      if (outcome.kind === "timeout") yield* terminate(entry.handle, entry.shell.pid)
      // Output still buffered when the pipes close is drained before the shell is reported finished.
      yield* Fiber.join(pump).pipe(Effect.timeout("1 second"), Effect.ignore)
      yield* Fiber.interrupt(pump)
      yield* release(entry.handle, scope)
      if (entry.recorded)
        yield* Effect.tryPromise(() => BackgroundRegistry.remove(REGISTRY_DIR, entry.shell.id)).pipe(
          Effect.catch((error) =>
            Effect.logWarning("background shell registry remove failed", { id: entry.shell.id, error }),
          ),
        )
      yield* Effect.promise(() => entry.writer.close())
      entry.shell.status = finalStatus(entry, outcome.kind)
      if (outcome.kind === "exit") entry.shell.exitCode = outcome.code
      entry.shell.endedAt = Date.now()
      entry.watchers.forEach((watcher) => {
        if (watcher.partial) scan(entry, watcher, "\n")
        Deferred.doneUnsafe(watcher.wake, Exit.void)
      })
      yield* Deferred.succeed(entry.finished, undefined)
      // Output not yet announced goes out before the exit, still at most one output event per second.
      if (entry.writer.total() !== entry.emittedBytes) {
        yield* Effect.sleep(Math.max(0, entry.emittedAt + OUTPUT_EVENT_MS - Date.now()))
        yield* publishOutput(entry)
      }
      yield* emit(entry, ShellBackground.Event.Exited, {
        sessionID: entry.shell.sessionID,
        id: entry.shell.id,
        status: entry.shell.status,
        exitCode: entry.shell.exitCode,
      })
      prune(entry.shell.sessionID)
      if (entry.killed || !notify) return
      yield* deliver(notify, exitSummary(entry, limit)).pipe(Effect.forkIn(fibers))
    })

    // Finished shells stay readable until their session is dropped, within a per-session and a global cap.
    const prune = (sessionID: string) => {
      const drop = (entry: Entry) => {
        const session = sessions.get(entry.shell.sessionID)
        session?.delete(entry.shell.id)
        if (session?.size === 0) sessions.delete(entry.shell.sessionID)
      }
      const own = finished(Array.from(sessions.get(sessionID)?.values() ?? []))
      own.slice(0, Math.max(0, own.length - KEEP_FINISHED)).forEach(drop)
      const all = finished(Array.from(sessions.values()).flatMap((session) => Array.from(session.values())))
      all.slice(0, Math.max(0, all.length - KEEP_FINISHED_TOTAL)).forEach(drop)
    }

    // Waits for the last member of the leader's group; only a group that ends before any stop is a natural exit.
    const groupExit = Effect.fnUntraced(function* (entry: Entry) {
      while (!groupGone(entry.shell.pid)) yield* Effect.sleep(GROUP_POLL_MS)
      if (!entry.killed) entry.natural = true
    })

    const stop = Effect.fnUntraced(function* (entry: Entry) {
      if (entry.shell.status !== "running") return false
      const leaderRunning = yield* alive(entry.handle)
      // The group already ended on its own and only the bookkeeping is pending: report that, not a kill.
      if (entry.natural || (!leaderRunning && groupGone(entry.shell.pid))) {
        yield* Deferred.await(entry.finished).pipe(Effect.timeout("5 seconds"), Effect.ignore)
        return false
      }
      entry.killed = true
      yield* terminate(entry.handle, entry.shell.pid)
      yield* Deferred.succeed(entry.stopped, undefined)
      yield* Deferred.await(entry.finished).pipe(Effect.timeout("5 seconds"), Effect.ignore)
      return true
    })

    const read = Effect.fn("BackgroundShells.read")(function* (input: {
      sessionID: string
      id: string
      filter?: string
    }) {
      const entry = find(input.sessionID, input.id)
      if (!entry) return undefined
      const filter = input.filter
      const regex =
        filter === undefined
          ? undefined
          : yield* Effect.try({
              try: () => new RegExp(filter),
              catch: (error) => new FilterError({ message: `invalid filter regex: ${String(error)}` }),
            })
      const result = entry.writer.readSince(entry.readOffset, { filter: regex })
      entry.readOffset = result.offset
      return { shell: { ...entry.shell }, output: result.text, truncated: entry.writer.truncated() }
    })

    const output = Effect.fn("BackgroundShells.output")(function* (input: {
      sessionID: string
      id: string
      offset: number
    }) {
      const entry = find(input.sessionID, input.id)
      if (!entry) return undefined
      return { ...entry.writer.readSince(input.offset), truncated: entry.writer.truncated() }
    })

    const kill = Effect.fn("BackgroundShells.kill")(function* (input: { sessionID: string; id: string }) {
      const entry = find(input.sessionID, input.id)
      if (!entry) return undefined
      yield* stop(entry)
      return { ...entry.shell }
    })

    const monitor = Effect.fn("BackgroundShells.monitor")(function* (input: {
      sessionID: string
      id: string
      pattern: string
      timeoutMs?: number
      notify: Notify
    }) {
      const entry = find(input.sessionID, input.id)
      if (!entry) return yield* new MonitorError({ message: `no background shell ${input.id} in this session` })
      const regex = yield* Effect.try({
        try: () => new RegExp(input.pattern),
        catch: (error) => new MonitorError({ message: `invalid monitor regex: ${String(error)}` }),
      })
      const active = monitors.get(input.sessionID) ?? 0
      if (active >= MAX_MONITORS)
        return yield* new MonitorError({
          message: `This session already has ${MAX_MONITORS} active monitors; wait for one to fire first.`,
        })
      const timeoutMs = Math.min(input.timeoutMs ?? MONITOR_DEFAULT_MS, MONITOR_MAX_MS)
      const watcher: Watcher = { regex, partial: "", wake: yield* Deferred.make<void>() }
      monitors.set(input.sessionID, active + 1)
      entry.watchers.add(watcher)
      if (entry.shell.status !== "running") Deferred.doneUnsafe(watcher.wake, Exit.void)
      yield* Effect.gen(function* () {
        const woke = yield* Deferred.await(watcher.wake).pipe(Effect.timeoutOption(timeoutMs))
        const label = `background shell ${entry.shell.id} (${entry.shell.command})`
        if (watcher.line !== undefined)
          return yield* deliver(
            input.notify,
            `Monitor: ${label} printed a line matching /${input.pattern}/:\n${watcher.line}`,
          )
        if (woke._tag === "None")
          return yield* deliver(
            input.notify,
            `Monitor: pattern not seen: /${input.pattern}/ did not appear in ${label} within ${timeoutMs} ms; the shell is still running.`,
          )
        if (entry.killed) return undefined
        return yield* deliver(
          input.notify,
          `Monitor: ${label} ${outcomeText(entry.shell, timeoutMs)} before /${input.pattern}/ appeared.\nLast ${EXIT_LINES} lines:\n${entry.writer.lastLines(EXIT_LINES)}`,
        )
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            entry.watchers.delete(watcher)
            const count = (monitors.get(input.sessionID) ?? 1) - 1
            if (count > 0) return void monitors.set(input.sessionID, count)
            monitors.delete(input.sessionID)
          }),
        ),
        Effect.forkIn(fibers),
      )
    })

    const list = Effect.fn("BackgroundShells.list")(function* (sessionID: string) {
      return Array.from(sessions.get(sessionID)?.values() ?? []).map((entry) => ({ ...entry.shell }))
    })

    // Both take the start lock so a start in flight either finishes first (and is killed) or starts afterwards.
    const killSession = Effect.fn("BackgroundShells.killSession")(function* (sessionID: string) {
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const entries = Array.from(sessions.get(sessionID)?.values() ?? [])
          const stopped = yield* Effect.forEach(entries, stop, { concurrency: "unbounded" })
          sessions.delete(sessionID)
          children.delete(sessionID)
          return stopped.filter(Boolean).length
        }),
      )
    })

    const killAll = Effect.fn("BackgroundShells.killAll")(function* () {
      yield* lock.withPermit(
        Effect.suspend(() =>
          Effect.forEach(
            Array.from(sessions.values()).flatMap((session) => Array.from(session.values())),
            stop,
            { concurrency: "unbounded", discard: true },
          ),
        ),
      )
    })

    // A process that exits without running finalizers (process.exit, an uncaught error, a forced quit) still
    // signals every running group; "exit" listeners must be synchronous, so there is no SIGKILL follow-up here.
    // Added before the finalizer below so it is removed only after that finalizer killed everything.
    const onExit = () =>
      terminateGroups(
        Array.from(sessions.values()).flatMap((session) =>
          Array.from(session.values()).flatMap((entry) => (entry.shell.status === "running" ? [entry.shell.pid] : [])),
        ),
      )
    process.on("exit", onExit)
    yield* Effect.addFinalizer(() => Effect.sync(() => void process.off("exit", onExit)))

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => (state.closing = true)).pipe(
        Effect.andThen(killAll()),
        Effect.andThen(Scope.close(fibers, Exit.void)),
      ),
    )

    // Deleted and archived sessions stop their shells. This service is global, so it listens on the process-wide
    // GlobalBus, which also carries events machine sync writes directly (it bypasses the session service). Child
    // sessions are deleted with their own event; unarchiving restarts nothing. A sub-agent's session also stops
    // its shells when its run ends (`session.status` idle): nobody watches them afterwards, and an exit
    // notification would wake the finished sub-agent. That kill is explicit, so it notifies nobody.
    const runFork = Effect.runForkWith(yield* Effect.context<never>())
    const onEvent = (event: GlobalEvent) => {
      const payload: unknown = event.payload
      if (!isRecord(payload) || !isRecord(payload.properties)) return
      const sessionID = payload.properties.sessionID
      if (typeof sessionID !== "string") return
      if (payload.type === "session.status") {
        const status = payload.properties.status
        if (!children.has(sessionID) || !isRecord(status) || status.type !== "idle") return
        children.delete(sessionID)
        return void runFork(killSession(sessionID))
      }
      if (payload.type === "session.deleted") return void runFork(killSession(sessionID))
      if (payload.type !== "session.updated") return
      const info = payload.properties.info
      if (isRecord(info) && isRecord(info.time) && typeof info.time.archived === "number")
        runFork(killSession(sessionID))
    }
    GlobalBus.on("event", onEvent)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", onEvent)))

    // Background shells of servers that died without running finalizers.
    yield* Effect.tryPromise(() => BackgroundRegistry.reap(REGISTRY_DIR)).pipe(
      Effect.tap((result) =>
        result.killed.length + result.skipped.length > 0
          ? Effect.logInfo("reaped orphaned background shells", {
              killed: result.killed.length,
              skipped: result.skipped.length,
            })
          : Effect.void,
      ),
      Effect.catch((error) => Effect.logWarning("background shell reap failed", { error })),
      Effect.forkIn(fibers),
    )

    return Service.of({
      start: (input) =>
        lock.withPermit(Effect.uninterruptible(launch(input))).pipe(Effect.withSpan("BackgroundShells.start")),
      adopt: (input) =>
        lock.withPermit(Effect.uninterruptible(adopt(input))).pipe(Effect.withSpan("BackgroundShells.adopt")),
      offer: (input) => Effect.sync(() => void offers.set(offerKey(input), input.promote)),
      withdraw: (input) => Effect.sync(() => void offers.delete(offerKey(input))),
      promote: (input) =>
        Effect.suspend(() => offers.get(offerKey(input)) ?? Effect.succeed(undefined)).pipe(
          Effect.withSpan("BackgroundShells.promote"),
        ),
      read,
      output,
      kill,
      monitor,
      list,
      killSession,
      killAll,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [AppProcess.node] })

// This service has no instance context, so events go straight onto the process-wide bus, routed by the directory the
// shell was started from, the way EventV2Bridge forwards instance events. A failing listener never affects the shell.
function emit<D extends Event.Definition>(entry: Entry, definition: D, properties: Schema.Codec.Encoded<D["data"]>) {
  return Effect.sync(() =>
    GlobalBus.emit("event", { directory: entry.directory, payload: { type: definition.type, properties } }),
  ).pipe(
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Effect.logWarning("background shell event failed", { type: definition.type, cause: Cause.pretty(cause) }),
    ),
  )
}

function offerKey(input: { sessionID: string; callID: string }) {
  return `${input.sessionID}\u0000${input.callID}`
}

function scan(entry: Entry, watcher: Watcher, chunk: string) {
  if (watcher.line !== undefined) return
  const lines = (watcher.partial + chunk).split("\n")
  watcher.partial = (lines.pop() ?? "").slice(-PARTIAL_LINE_BYTES)
  const line = lines.find((item) => {
    watcher.regex.lastIndex = 0
    return watcher.regex.test(item)
  })
  if (line === undefined) return
  watcher.line = line
  entry.watchers.delete(watcher)
  Deferred.doneUnsafe(watcher.wake, Exit.void)
}

// SIGTERM to the group, SIGKILL after the grace period. The leader can exit (closing the pipes, which ends
// handle.kill early) while group members that ignore SIGTERM live on, so the group itself is checked too.
function terminate(handle: ChildProcessHandle, pgid: number) {
  return Effect.gen(function* () {
    const deadline = Date.now() + KILL_GRACE_MS
    yield* handle
      .kill({ forceKillAfter: `${KILL_GRACE_MS} millis` })
      .pipe(Effect.timeout(KILL_GRACE_MS + 2_000), Effect.ignore)
    if (process.platform === "win32") return
    while (groupAlive(pgid) && Date.now() < deadline) yield* Effect.sleep("50 millis")
    if (groupAlive(pgid)) signalGroup(pgid, "SIGKILL")
  })
}

// Closing a scope whose process is still attached waits for it forever (a process that left the group can hold
// the pipes open), so that close is detached instead of blocking this service.
function release(handle: ChildProcessHandle, scope: Scope.Closeable) {
  return Effect.gen(function* () {
    if (yield* alive(handle)) return yield* Scope.close(scope, Exit.void).pipe(Effect.forkDetach, Effect.asVoid)
    yield* Scope.close(scope, Exit.void)
  })
}

function finished(entries: Entry[]) {
  return entries
    .filter((entry) => entry.shell.status !== "running")
    .sort((a, b) => (a.shell.endedAt ?? 0) - (b.shell.endedAt ?? 0))
}

function finalStatus(entry: Entry, outcome: "exit" | "signal" | "timeout" | "stopped"): Status {
  if (entry.killed) return "killed"
  if (outcome === "timeout") return "timed_out"
  if (outcome === "exit") return "exited"
  return "killed"
}

function outcomeText(shell: Shell, limit: number) {
  if (shell.status === "timed_out") return `timed out after ${limit} ms and was killed`
  if (shell.status === "killed") return "was killed by a signal"
  return `exited with code ${shell.exitCode ?? "unknown"}`
}

// The first line carries the literal status so the model can match it against bash_output's status field.
function exitSummary(entry: Entry, limit: number) {
  const tail = entry.writer.lastLines(EXIT_LINES)
  return [
    `[background shell ${entry.shell.id} ${entry.shell.status} (${statusDetail(entry.shell, limit)})]`,
    `Command: ${entry.shell.command}`,
    tail ? `Last ${EXIT_LINES} lines:\n${tail}` : "No output.",
  ].join("\n")
}

function statusDetail(shell: Shell, limit: number) {
  if (shell.status === "timed_out") return `after ${limit} ms; the process group was killed`
  if (shell.status === "killed") return "by a signal"
  return `code ${shell.exitCode ?? "unknown"}`
}

// A failed notification must never affect the shell.
function deliver(notify: Notify, text: string) {
  return Effect.suspend(() => notify(text)).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("background shell notification failed", { cause: Cause.pretty(cause) }),
    ),
  )
}

// The handle reports an unknown state as a failure; treating it as still running errs toward killing.
function alive(handle: ChildProcessHandle) {
  return handle.isRunning.pipe(Effect.orElseSucceed(() => true))
}

function groupGone(pgid: number) {
  return process.platform === "win32" || !groupAlive(pgid)
}

function groupAlive(pgid: number) {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

// Synchronous so it can run from a process "exit" listener. A group that is already gone (ESRCH) is skipped.
export function terminateGroups(pgids: number[]) {
  if (process.platform === "win32") return
  pgids.forEach((pgid) => signalGroup(pgid, "SIGTERM"))
}

function signalGroup(pgid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pgid, signal)
  } catch {}
}
