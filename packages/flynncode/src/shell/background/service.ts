export * as BackgroundShells from "./service"

import fs from "fs/promises"
import path from "path"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope, Semaphore, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Global } from "@flynncode/core/global"
import { AppProcess } from "@flynncode/core/process"
import { Identifier } from "@/id/id"
import { ToolID } from "@/tool/schema"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"
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
const CMDLINE_WAIT_MS = 500
const CMDLINE_POLL_MS = 20

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

export type Event =
  | { type: "shell.background.started"; sessionID: string; id: string; command: string; pid: number; startedAt: number }
  | { type: "shell.background.output"; sessionID: string; id: string; bytes: number; tail: string }
  | { type: "shell.background.exited"; sessionID: string; id: string; status: Status; exitCode?: number }

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
  notify?: Notify
}

export interface Interface {
  readonly start: (input: StartInput) => Effect.Effect<Shell, ShellLimitError | SpawnError>
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
    const self = yield* Effect.promise(() => BackgroundRegistry.cmdline(process.pid))
    const state = { closing: false }

    const find = (sessionID: string, id: string) => sessions.get(sessionID)?.get(id)

    const launch = Effect.fnUntraced(function* (input: StartInput) {
      if (state.closing) return yield* new SpawnError({ message: "background shells are shutting down" })
      const running = Array.from(sessions.get(input.sessionID)?.values() ?? []).filter(
        (entry) => entry.shell.status === "running",
      )
      if (running.length >= MAX_RUNNING)
        return yield* new ShellLimitError({
          message: `This session already has ${MAX_RUNNING} running background shells; kill one with kill_shell first.`,
        })
      const cap = Math.min(input.capMs ?? MAX_MS, MAX_MS)
      const limit = Math.min(input.timeoutMs ?? cap, cap)
      yield* Effect.tryPromise({
        try: () => fs.mkdir(TRUNCATION_DIR, { recursive: true }),
        catch: (error) => new SpawnError({ message: `cannot create ${TRUNCATION_DIR}: ${String(error)}` }),
      })
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
      const outputPath = path.join(TRUNCATION_DIR, ToolID.ascending())
      const entry: Entry = {
        shell: {
          id: Identifier.create("bash", "ascending"),
          sessionID: input.sessionID,
          command: input.command,
          pid: handle.pid,
          outputPath,
          startedAt: Date.now(),
          status: "running",
        },
        directory: input.directory,
        handle,
        writer: BackgroundOutput.open(outputPath, { capBytes: CAP_BYTES, headBytes: HEAD_BYTES }),
        readOffset: 0,
        killed: false,
        natural: false,
        recorded: false,
        emittedAt: 0,
        watchers: new Set(),
        stopped: yield* Deferred.make<void>(),
        finished: yield* Deferred.make<void>(),
      }
      const pump = yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
        Effect.suspend(() => {
          entry.writer.write(chunk)
          entry.watchers.forEach((watcher) => scan(entry, watcher, chunk))
          const now = Date.now()
          if (now - entry.emittedAt < OUTPUT_EVENT_MS) return Effect.void
          entry.emittedAt = now
          const total = entry.writer.total()
          return emit(entry, {
            type: "shell.background.output",
            sessionID: entry.shell.sessionID,
            id: entry.shell.id,
            bytes: total,
            tail: entry.writer.readSince(total - TAIL_BYTES, { maxBytes: TAIL_BYTES }).text,
          })
        }),
      ).pipe(Effect.ignore, Effect.forkIn(fibers))
      yield* record(entry)
      yield* life(entry, scope, pump, limit, input.notify).pipe(Effect.forkIn(fibers))
      // Re-read at insert time: a killSession that ran meanwhile dropped the map this call started with.
      sessions.set(
        input.sessionID,
        (sessions.get(input.sessionID) ?? new Map<string, Entry>()).set(entry.shell.id, entry),
      )
      yield* emit(entry, {
        type: "shell.background.started",
        sessionID: entry.shell.sessionID,
        id: entry.shell.id,
        command: entry.shell.command,
        pid: entry.shell.pid,
        startedAt: entry.shell.startedAt,
      })
      return { ...entry.shell }
    })

    // The spawn event can fire before exec completes, when /proc/<pid>/cmdline is still empty or the parent's.
    // A wrong cmdline would make crash cleanup skip (or misjudge) the entry, and the command string is not what
    // /proc reports, so without a real cmdline nothing is recorded; the finalizer and killSession still cover it.
    // A leader that already exited needs no record: crash cleanup only acts on a live leader's cmdline.
    const record = Effect.fnUntraced(function* (entry: Entry) {
      if (process.platform !== "linux") return
      const result = yield* stableCmdline(entry.handle, self, Date.now() + CMDLINE_WAIT_MS)
      if (result.exited) return
      const cmdline = result.cmdline
      if (!cmdline) {
        yield* Effect.logWarning("background shell not recorded for crash cleanup: cmdline unavailable", {
          id: entry.shell.id,
          pid: entry.shell.pid,
        })
        return
      }
      yield* Effect.tryPromise(() =>
        BackgroundRegistry.add(REGISTRY_DIR, {
          id: entry.shell.id,
          sessionID: entry.shell.sessionID,
          pid: entry.shell.pid,
          cmdline,
          startedAt: entry.shell.startedAt,
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
      pump: Fiber.Fiber<void>,
      limit: number,
      notify: Notify | undefined,
    ) {
      const deadline = entry.shell.startedAt + limit
      const leader = yield* Effect.raceAll([
        entry.handle.exitCode.pipe(
          Effect.map((code) => ({ kind: "exit" as const, code: Number(code) })),
          Effect.catch(() => Effect.succeed({ kind: "signal" as const })),
        ),
        Effect.sleep(limit).pipe(Effect.as({ kind: "timeout" as const })),
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
      yield* emit(entry, {
        type: "shell.background.exited",
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

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => (state.closing = true)).pipe(
        Effect.andThen(killAll()),
        Effect.andThen(Scope.close(fibers, Exit.void)),
      ),
    )

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

// Task 6 publishes these on the instance bus for `entry.directory`; until then events go nowhere.
function emit(_entry: Entry, _event: Event) {
  return Effect.void
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

// Two equal non-empty reads that are not this server's own cmdline mean exec has completed.
function stableCmdline(
  handle: ChildProcessHandle,
  self: string | undefined,
  deadline: number,
  previous?: string,
): Effect.Effect<{ exited: boolean; cmdline?: string }> {
  return Effect.gen(function* () {
    if (!(yield* alive(handle))) return { exited: true }
    const value = yield* Effect.promise(() => BackgroundRegistry.cmdline(handle.pid))
    const current = value === self ? undefined : value
    if (current && current === previous) return { exited: false, cmdline: current }
    if (Date.now() >= deadline) return { exited: false }
    yield* Effect.sleep(CMDLINE_POLL_MS)
    return yield* stableCmdline(handle, self, deadline, current)
  })
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

function signalGroup(pgid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pgid, signal)
  } catch {}
}
