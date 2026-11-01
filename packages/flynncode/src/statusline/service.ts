export * as StatusLine from "./service"

import { spawn, type ChildProcess } from "child_process"
import type { Readable } from "stream"
import { Cause, Context, Effect, Exit, Layer, Option, Scope, Semaphore } from "effect"
import { Database } from "@flynncode/core/database/database"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import type { ConfigV1 } from "@flynncode/core/v1/config/config"
import { SessionStatusLine } from "@flynncode/schema/session-statusline"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { HooksManaged } from "@/hooks/managed"
import { HooksTrust } from "@/hooks/trust"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
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
/** A watch no GET has renewed for this long ends once its session is idle. */
export const WATCH_MS = 5 * 60_000
/** Sessions watched at once in this process; a new one evicts the least recently requested. */
export const MAX_WATCHED = 8
/** Commands running at once in this process, across all sessions. */
export const MAX_RUNS = 2
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

// Kept in step with `sanitizeAnsi` in packages/ui/src/theme/ansi.ts, which clients apply again. In order: SGR (kept),
// any other CSI, OSC/DCS/SOS/PM/APC strings up to BEL or ST (or the end of the line), a CSI cut short, any other
// escape, then C0, DEL, C1 and the bidi overrides and isolates. Anything else is one visible character.
const SGR = /\u001b\[[0-9;:]*m/g
const TOKEN =
  /(\u001b\[[0-9;:]*m)|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|(?:\u001b[\]PX^_]|[\u0090\u0098\u009d-\u009f])[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)|(?:\u001b\[|\u009b)[0-?]*[ -/]*|\u001b[ -/]*[0-~]?|[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]|([\s\S])/gu

export type Clock = {
  readonly now: () => number
  readonly sleep: (ms: number) => Effect.Effect<void>
}

export interface Interface {
  /**
   * The session's last result. A session whose instance has a status line is watched from then on (each get renews
   * the watch for WATCH_MS), and a run starts when none is pending and the last one started more than STALE_MS ago
   * (or never).
   */
  readonly get: (sessionID: SessionID) => Effect.Effect<SessionStatusLine.Result, Session.NotFound>
  /** Runs every watched session again, for a change no session event reports, such as a trust decision. */
  readonly refresh: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@flynncode/StatusLine") {}

/** The trust identity of a status line command; the Hooks settings page lists it as the event `StatusLine`. */
export function hookDef(line: ConfigV1.StatusLine) {
  return HooksTrust.fromHandler("StatusLine", undefined, { type: "command", command: line.command }, line.source)
}

/** The status line to run: none when unset, or when `hooks.disableAllHooks` turns every hook command off. */
export function active(cfg: Pick<ConfigV1.Info, "statusLine" | "hooks">) {
  return cfg.hooks?.disableAllHooks === true ? undefined : cfg.statusLine
}

type Entry = {
  sessionID: SessionID
  directory: string
  lines: string[]
  /** The last run that produced lines. */
  updatedAt?: number
  /** The start of the last run. */
  started?: number
  /** The last get. */
  seen: number
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

type Outcome =
  | { kind: "unconfigured" }
  | { kind: "expired" }
  | { kind: "untrusted"; error: string }
  | { kind: "failed"; error: string }
  | { kind: "lines"; lines: string[] }

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
  const status = yield* SessionStatus.Service
  const scope = yield* Scope.Scope
  const permits = yield* Semaphore.make(MAX_RUNS)
  const runFork = Effect.runForkWith(yield* Effect.context<Database.Service | Provider.Service | Session.Service>())
  // In least recently requested order: a get moves its entry to the end.
  const entries = new Map<string, Entry>()
  // When this process first served each session's status line: the start of Claude's `total_duration_ms`.
  const firstSeen = new Map<string, number>()

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
    const oldest = entries.size >= MAX_WATCHED ? entries.values().next().value : undefined
    if (oldest) forget(oldest)
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

  const report = Effect.fnUntraced(function* (entry: Entry, error: string) {
    if (entry.errors.has(error)) return
    entry.errors.add(error)
    yield* Effect.logWarning("status line run failed (logged once per session and error)", {
      "session.id": entry.sessionID,
      error,
    })
  })

  const failed = Effect.fnUntraced(function* (entry: Entry, error: string) {
    entry.failing = true
    yield* report(entry, error)
    yield* expire(entry)
  })

  // Every status line needs trust, whichever config it comes from, checked the way the hooks executor checks a hook:
  // per project, covering the project scripts it names, with managed hooks and the bypass flag pre-trusted.
  const resolve = Effect.fnUntraced(function* () {
    const line = active(yield* config.get())
    if (!line) return undefined
    const def = hookDef(line)
    const managed = yield* Effect.serviceOption(HooksManaged.ManagedHooks)
    if ((Option.isSome(managed) && managed.value.isManaged(def)) || flags.bypassHookTrust)
      return { line, trusted: true }
    const bound = yield* HooksTrust.bindToInstance(def)
    return { line, trusted: yield* trust.isTrusted(bound).pipe(Effect.orElseSucceed(() => false)) }
  })

  const attempt = Effect.fnUntraced(function* (session: Session.Info, entry: Entry) {
    // An unrenewed watch keeps running only while its session works, so a turn in progress still updates the line.
    if (clock.now() - entry.seen >= WATCH_MS && (yield* status.get(session.id)).type === "idle")
      return { kind: "expired" } satisfies Outcome
    const resolved = yield* resolve()
    if (!resolved) return { kind: "unconfigured" } satisfies Outcome
    if (!resolved.trusted)
      return {
        kind: "untrusted",
        error: `skipped untrusted status line${resolved.line.source ? ` from ${resolved.line.source}` : ""}: ${resolved.line.command}`,
      } satisfies Outcome
    const input = yield* StatusLineInput.build(session, {
      duration: clock.now() - (firstSeen.get(session.id) ?? clock.now()),
    })
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
    const outcome: Outcome = yield* instances.provide({ directory: found.value.directory }, attempt(found.value, entry))
    if (outcome.kind === "expired") return forget(entry)
    if (outcome.kind === "unconfigured") {
      forget(entry)
      return yield* update(entry, [])
    }
    // Watched still, so trusting it on the Hooks page brings it back.
    if (outcome.kind === "untrusted") {
      yield* report(entry, outcome.error)
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

  // A failure never escapes: it is logged against the session and the session goes on. At most MAX_RUNS commands
  // run at once; a run waiting for its turn counts as running, so it is not scheduled twice.
  const start = (entry: Entry): Effect.Effect<void, never, Database.Service | Provider.Service | Session.Service> =>
    Effect.suspend(() => {
      if (entries.get(entry.sessionID) !== entry) return Effect.void
      entry.running = true
      return permits
        .withPermit(
          Effect.suspend(() => {
            if (entries.get(entry.sessionID) !== entry) return Effect.void
            entry.dirty = false
            entry.started = clock.now()
            return run(entry)
          }),
        )
        .pipe(
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
      // node:child_process, not Bun.spawn: the desktop app runs this server under Node.
      Effect.sync(() => {
        const proc = spawn("sh", ["-c", command], {
          cwd,
          // The hooks executor's policy: the server's environment plus CLAUDE_PROJECT_DIR.
          env: { ...process.env, CLAUDE_PROJECT_DIR: project },
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        })
        proc.stdin.on("error", () => undefined)
        proc.stdin.end(input)
        return proc
      }),
      (proc) =>
        Effect.raceFirst(
          Effect.promise(() => Promise.all([capped(proc.stdout), capped(proc.stderr), exited(proc)])).pipe(
            Effect.map((result) => ({ stdout: result[0], stderr: result[1], code: result[2] })),
          ),
          clock.sleep(TIMEOUT_MS).pipe(Effect.as(undefined)),
        ),
      (proc, exit) =>
        Exit.isSuccess(exit) && exit.value !== undefined
          ? Effect.void
          : Effect.try({ try: () => process.kill(-(proc.pid ?? 0), "SIGKILL"), catch: () => "no group" }).pipe(
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
      Effect.map((cfg) => active(cfg) !== undefined),
      Effect.catchCause((cause) =>
        Effect.logWarning("status line config failed", { "session.id": sessionID, cause: Cause.pretty(cause) }).pipe(
          Effect.as(false),
        ),
      ),
    )
    if (!configured) {
      if (!existing) return { lines: [] }
      forget(existing)
      yield* update(existing, [])
      return { lines: [] }
    }
    if (!firstSeen.has(sessionID)) firstSeen.set(sessionID, clock.now())
    const entry = existing ?? {
      sessionID,
      directory: session.directory,
      seen: clock.now(),
      lines: [],
      running: false,
      dirty: false,
      waiting: false,
      failing: false,
      expiring: false,
      errors: new Set<string>(),
    }
    if (existing) {
      existing.seen = clock.now()
      entries.delete(sessionID)
      entries.set(sessionID, existing)
    }
    if (!existing) watch(entry)
    if (!entry.running && !entry.waiting && (entry.started === undefined || clock.now() - entry.started >= STALE_MS))
      runFork(schedule(entry))
    return entry.updatedAt === undefined ? { lines: entry.lines } : { lines: entry.lines, updatedAt: entry.updatedAt }
  })

  const refresh = () => Effect.sync(() => Array.from(entries.values()).forEach((entry) => runFork(schedule(entry))))

  return Service.of({ get, refresh })
})

/**
 * The first MAX_LINES lines with visible text, sanitized to printable text and SGR, each cut to MAX_CHARS visible
 * characters and then indented by `padding` spaces.
 */
export function parse(stdout: string, padding: number) {
  return stdout
    .split("\n")
    .map((line) => sanitize(line, MAX_CHARS).trimEnd())
    .filter((line) => line.replace(SGR, "").trim() !== "")
    .slice(0, MAX_LINES)
    .map((line) => " ".repeat(padding) + line)
}

/**
 * Only printable text and SGR sequences are kept, cut to `limit` visible characters; SGR sequences do not count and
 * are never cut in half.
 */
export function sanitize(line: string, limit: number) {
  return Array.from(line.matchAll(TOKEN)).reduce(
    (acc, match) => {
      if (match[1]) return { text: acc.text + match[1], visible: acc.visible }
      if (!match[2] || acc.visible >= limit) return acc
      return { text: acc.text + match[2], visible: acc.visible + 1 }
    },
    { text: "", visible: 0 },
  ).text
}

// Reads at most MAX_OUTPUT bytes and then lets go of the pipe, so a script that keeps printing gets SIGPIPE instead
// of filling memory.
function capped(stream: Readable) {
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = []
    const state = { size: 0 }
    const done = () => resolve(Buffer.concat(chunks).toString("utf8"))
    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk)
      state.size += chunk.length
      if (state.size < MAX_OUTPUT) return
      stream.destroy()
      done()
    })
    stream.on("end", done)
    stream.on("close", done)
    stream.on("error", done)
  })
}

// "error" fires instead of "close" when the shell cannot be started.
function exited(proc: ChildProcess) {
  return new Promise<number | null>((resolve) => {
    proc.on("close", (code) => resolve(code))
    proc.on("error", () => resolve(null))
  })
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
    SessionStatus.node,
    Database.node,
  ],
})
