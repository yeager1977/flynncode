export * as StatusLine from "./service"

import { Cause, Context, Effect, Exit, Layer, Option, Scope } from "effect"
import { Database } from "@flynncode/core/database/database"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import type { ConfigV1 } from "@flynncode/core/v1/config/config"
import { SessionStatusLine } from "@flynncode/schema/session-statusline"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { HooksTrust } from "@/hooks/trust"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { isRecord } from "@/util/record"
import { StatusLineInput } from "./input"

/** At most one run per session in this window, measured from the start of the last run. */
export const THROTTLE_MS = 300
/** A run still going after this long is killed with its whole process group. */
export const TIMEOUT_MS = 5_000
/** After failed runs, the last good lines stay until this long after the run that produced them. */
export const KEEP_MS = 60_000
/** A client asking for a session whose last run started longer ago than this starts a new one. */
export const STALE_MS = 10_000
export const MAX_LINES = 2
/** Visible characters per line; SGR codes do not count. */
export const MAX_CHARS = 200
// Bytes read from each of stdout and stderr; a runaway script is cut off, not buffered.
const MAX_OUTPUT = 64 * 1024

// Changes to what a status line shows: the session's messages, its model, agent or folder (session.updated) and its
// run state.
const TRIGGERS = new Set([
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  "session.updated",
  "session.status",
])

const SGR = /\x1b\[[0-9;]*m/g

export type Clock = {
  readonly now: () => number
  readonly sleep: (ms: number) => Effect.Effect<void>
}

export interface Interface {
  /**
   * The session's last result. A session whose instance has a status line is watched from then on, and a run starts
   * when none is pending and the last one started more than STALE_MS ago (or never).
   */
  readonly get: (sessionID: SessionID) => Effect.Effect<SessionStatusLine.Result, Session.NotFound>
}

export class Service extends Context.Service<Service, Interface>()("@flynncode/StatusLine") {}

/** The trust identity of a status line command; the Hooks settings page lists it as the event `StatusLine`. */
export function hookDef(line: ConfigV1.StatusLine) {
  return HooksTrust.fromHandler("StatusLine", undefined, { type: "command", command: line.command }, line.source)
}

type Entry = {
  sessionID: SessionID
  directory: string
  lines: string[]
  /** The last run that produced lines. */
  updatedAt?: number
  /** The start of the last run. */
  started?: number
  running: boolean
  /** A change arrived since the last run started. */
  dirty: boolean
  /** A run is scheduled for the end of the throttle window. */
  waiting: boolean
  failing: boolean
  expiring: boolean
  /** Errors already logged since the last good run. */
  errors: Set<string>
}

type Outcome = { kind: "unconfigured" } | { kind: "failed"; error: string } | { kind: "lines"; lines: string[] }

/**
 * Builds the service. It holds per-session results in this process, subscribes to the process-wide bus only while it
 * watches a session, and forks runs into the caller's scope, whose closing kills any running command. Tests pass a
 * clock they drive.
 */
export const make = Effect.fn("StatusLine.make")(function* (options: { clock?: Clock } = {}) {
  const clock = options.clock ?? { now: () => Date.now(), sleep: (ms: number) => Effect.sleep(ms) }
  const sessions = yield* Session.Service
  const instances = yield* InstanceStore.Service
  const config = yield* Config.Service
  const trust = yield* HooksTrust.Service
  const flags = yield* RuntimeFlags.Service
  const scope = yield* Scope.Scope
  const runFork = Effect.runForkWith(yield* Effect.context<Database.Service | Provider.Service | Session.Service>())
  const entries = new Map<string, Entry>()

  const listener = (event: GlobalEvent) => {
    const payload: unknown = event.payload
    if (!isRecord(payload) || typeof payload.type !== "string" || !isRecord(payload.properties)) return
    const sessionID = payload.properties.sessionID
    const entry = typeof sessionID === "string" ? entries.get(sessionID) : undefined
    if (!entry) return
    if (payload.type === "session.deleted") return forget(entry)
    if (TRIGGERS.has(payload.type)) runFork(schedule(entry))
  }

  const watch = (entry: Entry) => {
    if (entries.size === 0) GlobalBus.on("event", listener)
    entries.set(entry.sessionID, entry)
  }

  const forget = (entry: Entry) => {
    if (entries.get(entry.sessionID) !== entry) return
    entries.delete(entry.sessionID)
    if (entries.size === 0) GlobalBus.off("event", listener)
  }

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      entries.clear()
      GlobalBus.off("event", listener)
    }),
  )

  // Like instance events, routed by the session's directory, so its clients see it.
  const update = (entry: Entry, lines: string[]) =>
    Effect.sync(() => {
      if (lines.length === entry.lines.length && lines.every((line, index) => line === entry.lines[index])) return
      entry.lines = lines
      GlobalBus.emit("event", {
        directory: entry.directory,
        payload: { type: SessionStatusLine.Event.Updated.type, properties: { sessionID: entry.sessionID, lines } },
      })
    })

  // A failing status line keeps its last good lines until KEEP_MS after the run that produced them, then clears
  // them, whether or not another run happens.
  const expire = (entry: Entry): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (entry.lines.length === 0 || entry.expiring) return Effect.void
      const left = (entry.updatedAt ?? 0) + KEEP_MS - clock.now()
      if (left <= 0) return update(entry, [])
      entry.expiring = true
      return clock.sleep(left).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            entry.expiring = false
            return entries.get(entry.sessionID) === entry && entry.failing ? expire(entry) : Effect.void
          }),
        ),
        Effect.forkIn(scope),
        Effect.asVoid,
      )
    })

  const failed = Effect.fnUntraced(function* (entry: Entry, error: string) {
    entry.failing = true
    if (!entry.errors.has(error)) {
      entry.errors.add(error)
      yield* Effect.logWarning("status line run failed (logged once per session and error)", {
        "session.id": entry.sessionID,
        error,
      })
    }
    yield* expire(entry)
  })

  // Only a command from Claude settings needs trust, checked the way a Claude hook's is: per project, covering the
  // project scripts it names.
  const resolve = Effect.fnUntraced(function* () {
    const line = (yield* config.get()).statusLine
    if (!line) return undefined
    if (!line.source || flags.bypassHookTrust) return { line, trusted: true }
    const bound = yield* HooksTrust.bindToInstance(hookDef(line))
    return { line, trusted: yield* trust.isTrusted(bound).pipe(Effect.orElseSucceed(() => false)) }
  })

  const attempt = Effect.fnUntraced(function* (session: Session.Info) {
    const resolved = yield* resolve()
    if (!resolved) return { kind: "unconfigured" } satisfies Outcome
    if (!resolved.trusted)
      return {
        kind: "failed",
        error: `skipped untrusted status line from ${resolved.line.source}: ${resolved.line.command}`,
      } satisfies Outcome
    const input = yield* StatusLineInput.build(session)
    const output = yield* exec(
      resolved.line.command,
      JSON.stringify(input),
      session.directory,
      input.workspace.project_dir,
    )
    if (!output) return { kind: "failed", error: `timed out after ${TIMEOUT_MS} ms` } satisfies Outcome
    if (output.code !== 0) {
      const detail = output.stderr.trim().split("\n")[0]
      return { kind: "failed", error: `exited with ${output.code}${detail ? `: ${detail}` : ""}` } satisfies Outcome
    }
    const lines = parse(output.stdout, resolved.line.padding ?? 0)
    if (lines.length === 0) return { kind: "failed", error: "printed nothing" } satisfies Outcome
    return { kind: "lines", lines } satisfies Outcome
  })

  const run = Effect.fnUntraced(function* (entry: Entry) {
    const found = yield* sessions.get(entry.sessionID).pipe(Effect.option)
    if (Option.isNone(found)) return forget(entry)
    entry.directory = found.value.directory
    const outcome: Outcome = yield* instances.provide({ directory: found.value.directory }, attempt(found.value))
    if (outcome.kind === "unconfigured") {
      forget(entry)
      return yield* update(entry, [])
    }
    if (outcome.kind === "failed") return yield* failed(entry, outcome.error)
    entry.updatedAt = clock.now()
    entry.failing = false
    entry.errors.clear()
    yield* update(entry, outcome.lines)
  })

  // Trailing-edge throttle: a change inside the window waits for its end, and a change during a run waits for that
  // run, so runs never overlap and the last change always gets one.
  const schedule = (entry: Entry): Effect.Effect<void, never, Database.Service | Provider.Service | Session.Service> =>
    Effect.suspend(() => {
      entry.dirty = true
      if (entry.waiting || entry.running) return Effect.void
      entry.waiting = true
      const wait = entry.started === undefined ? 0 : entry.started + THROTTLE_MS - clock.now()
      return (wait > 0 ? clock.sleep(wait) : Effect.void).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            entry.waiting = false
            return start(entry)
          }),
        ),
        Effect.forkIn(scope),
        Effect.asVoid,
      )
    })

  // A failure never escapes: it is logged against the session and the session goes on.
  const start = (entry: Entry): Effect.Effect<void, never, Database.Service | Provider.Service | Session.Service> =>
    Effect.suspend(() => {
      if (entries.get(entry.sessionID) !== entry) return Effect.void
      entry.dirty = false
      entry.running = true
      entry.started = clock.now()
      return run(entry).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.void : failed(entry, String(Cause.squash(cause))),
        ),
        Effect.ensuring(
          Effect.suspend(() => {
            entry.running = false
            return entry.dirty ? schedule(entry) : Effect.void
          }),
        ),
      )
    })

  // `sh -c` in its own process group, so a timeout kills the whole tree: a grandchild left behind would hold stdout
  // open. Resolves undefined on timeout.
  const exec = (command: string, input: string, cwd: string, project: string) =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.spawn(["sh", "-c", command], {
          cwd,
          env: { ...process.env, CLAUDE_PROJECT_DIR: project },
          stdin: new Blob([input]),
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        }),
      ),
      (proc) =>
        Effect.raceFirst(
          Effect.promise(() => Promise.all([capped(proc.stdout), capped(proc.stderr), proc.exited])).pipe(
            Effect.map((result) => ({ stdout: result[0], stderr: result[1], code: result[2] })),
          ),
          clock.sleep(TIMEOUT_MS).pipe(Effect.as(undefined)),
        ),
      (proc, exit) =>
        Exit.isSuccess(exit) && exit.value !== undefined
          ? Effect.void
          : Effect.try({ try: () => process.kill(-proc.pid, "SIGKILL"), catch: () => "no group" }).pipe(
              // No process groups (Windows) or the group is already gone.
              Effect.catch(() => Effect.try({ try: () => proc.kill("SIGKILL"), catch: () => "gone" })),
              Effect.ignore,
            ),
    )

  const get = Effect.fn("StatusLine.get")(function* (sessionID: SessionID) {
    const session = yield* sessions.get(sessionID)
    const existing = entries.get(sessionID)
    // A broken config reads as no status line; the session itself is not affected.
    const configured = yield* instances.provide({ directory: session.directory }, config.get()).pipe(
      Effect.map((cfg) => cfg.statusLine !== undefined),
      Effect.catchCause((cause) =>
        Effect.logWarning("status line config failed", { "session.id": sessionID, cause: Cause.pretty(cause) }).pipe(
          Effect.as(false),
        ),
      ),
    )
    if (!configured) {
      if (existing) forget(existing)
      return { lines: [] }
    }
    const entry = existing ?? {
      sessionID,
      directory: session.directory,
      lines: [],
      running: false,
      dirty: false,
      waiting: false,
      failing: false,
      expiring: false,
      errors: new Set<string>(),
    }
    if (!existing) watch(entry)
    if (!entry.running && !entry.waiting && (entry.started === undefined || clock.now() - entry.started >= STALE_MS))
      runFork(schedule(entry))
    return entry.updatedAt === undefined ? { lines: entry.lines } : { lines: entry.lines, updatedAt: entry.updatedAt }
  })

  return Service.of({ get })
})

/**
 * The first MAX_LINES lines with visible text, each cut to MAX_CHARS visible characters and indented by `padding`
 * spaces. SGR codes are kept and never cut in half.
 */
export function parse(stdout: string, padding: number) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.replace(SGR, "").trim() !== "")
    .slice(0, MAX_LINES)
    .map(
      (line) =>
        " ".repeat(padding) +
        (line.match(/\x1b\[[0-9;]*m|[\s\S]/gu) ?? []).reduce(
          (acc, token) => {
            if (token.length > 1 && token.startsWith("\x1b[")) return { text: acc.text + token, visible: acc.visible }
            if (acc.visible >= MAX_CHARS) return acc
            return { text: acc.text + token, visible: acc.visible + 1 }
          },
          { text: "", visible: 0 },
        ).text,
    )
}

// Reads at most MAX_OUTPUT bytes and then lets go of the pipe, so a script that keeps printing gets SIGPIPE instead
// of filling memory.
async function capped(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  const pump = async (size: number): Promise<void> => {
    const next = await reader.read()
    if (next.done) return
    chunks.push(next.value)
    if (size + next.value.length >= MAX_OUTPUT) return reader.cancel()
    return pump(size + next.value.length)
  }
  await pump(0)
  return Buffer.concat(chunks).toString("utf8")
}

/** The process-global service: idle (no subscription, no timers) until a client asks for a configured session. */
export const layer = Layer.effect(Service, make())

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Session.node,
    InstanceStore.node,
    Config.node,
    Provider.node,
    HooksTrust.node,
    RuntimeFlags.node,
    Database.node,
  ],
})
