import { AppProcess } from "@flynncode/core/process"
import { FSUtil } from "@flynncode/core/fs-util"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { httpClient, path } from "@flynncode/core/effect/app-node-platform"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { ChildProcess } from "effect/unstable/process"
import { Context, Effect, Layer, Path, Schema, Scope } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Config } from "@/config/config"
import { ConfigPreview, type ServerSettings } from "@/config/preview"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"

const PREFIX = "[preview]"
const READY_TIMEOUT_MS = 15_000
const READY_POLL = "250 millis"

export class UnknownServerError extends Schema.TaggedErrorClass<UnknownServerError>()("PreviewUnknownServerError", {
  message: Schema.String,
}) {}

export class StartFailedError extends Schema.TaggedErrorClass<StartFailedError>()("PreviewStartFailedError", {
  message: Schema.String,
}) {}

export class NoRunningServerError extends Schema.TaggedErrorClass<NoRunningServerError>()(
  "PreviewNoRunningServerError",
  {
    message: Schema.String,
  },
) {}

export type Error = UnknownServerError | StartFailedError | NoRunningServerError

export const State = Schema.Literals(["running", "stopped", "starting", "failed"])
export type StateType = Schema.Schema.Type<typeof State>

export const Info = Schema.Struct({
  name: Schema.String,
  state: State,
  port: Schema.optional(Schema.Number),
  url: Schema.optional(Schema.String),
  pid: Schema.optional(Schema.Number),
  attach: Schema.optional(Schema.Boolean),
  autoVerify: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "PreviewServer" })
export type InfoType = Schema.Schema.Type<typeof Info>

export const VerifyResult = Schema.Struct({
  url: Schema.String,
  httpStatus: Schema.Number,
  title: Schema.optional(Schema.String),
  errorCount: Schema.optional(Schema.Number),
}).annotate({ identifier: "PreviewVerifyResult" })
export type VerifyResultType = Schema.Schema.Type<typeof VerifyResult>

type Entry = {
  settings: ServerSettings
  state: StateType
  handle?: ChildProcessHandle
  pid?: number
  port?: number
  url?: string
  // Set on file.edited and on each verify; lets callers detect staleness.
  editedAt?: number
  verifiedAt?: number
}

type InstanceServers = {
  // The instance-state scope: spawned handles attach here so a disposed
  // instance kills its preview servers even without an explicit stop.
  scope: Scope.Scope
  servers: Map<string, Entry>
}

export interface Interface {
  readonly list: () => Effect.Effect<InfoType[]>
  readonly start: (name: string) => Effect.Effect<InfoType, Error>
  readonly stop: (name: string) => Effect.Effect<InfoType, Error>
  readonly restart: (name: string) => Effect.Effect<InfoType, Error>
  readonly verify: (name?: string) => Effect.Effect<VerifyResultType, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Preview") {}

const layer: Layer.Layer<
  Service,
  never,
  Config.Service | AppProcess.Service | FSUtil.Service | Path.Path | HttpClient.HttpClient | EventV2Bridge.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const appProcess = yield* AppProcess.Service
    const fs = yield* FSUtil.Service
    const pathSvc = yield* Path.Path
    const http = yield* HttpClient.HttpClient
    const events = yield* EventV2Bridge.Service

    // Per-directory server registry.
    const state = yield* InstanceState.make<InstanceServers>(
      Effect.fn("Preview.state")(function* (ctx) {
        const parsed = ConfigPreview.settings(yield* config.get())
        for (const warning of parsed.warnings) yield* Effect.logWarning(`${PREFIX} ${warning}`)
        const entryScope = yield* Scope.Scope
        const servers = new Map(
          parsed.value.servers.map(
            (server): [string, Entry] => [
              server.name,
              { settings: server, state: "stopped", ...(server.url ? { url: server.url } : {}) },
            ],
          ),
        )
        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== "file.edited" || event.location?.directory !== ctx.directory) return Effect.void
          const now = Date.now()
          for (const entry of servers.values()) entry.editedAt = now
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsubscribe)
        return { scope: entryScope, servers }
      }),
    )

    const entry = Effect.fn("Preview.entry")(function* (name: string) {
      const servers = yield* InstanceState.get(state)
      const found = servers.servers.get(name)
      if (!found) return yield* new UnknownServerError({ message: `No preview server named "${name}"` })
      return found
    })

    const info = Effect.fn("Preview.info")(function* (found: Entry) {
      const pid = found.handle?.pid
      return {
        name: found.settings.name,
        state: found.state,
        ...(found.port !== undefined ? { port: found.port } : {}),
        ...(found.url ? { url: found.url } : {}),
        ...(pid !== undefined ? { pid } : {}),
        ...(found.settings.command === undefined && found.settings.url !== undefined ? { attach: true } : {}),
        ...(found.settings.autoVerify !== undefined ? { autoVerify: found.settings.autoVerify } : {}),
      }
    })

    const freePort = Effect.fnUntraced(function* () {
      // Bind port 0, read the assigned port, then release inside an inner
      // scope. Between release and the child's bind another process could
      // take the port; the readiness poll then fails as a start error.
      return yield* Effect.scoped(
        Effect.acquireRelease(
          Effect.sync(() => {
            const server = Bun.serve({ port: 0, fetch: () => new Response("ok") })
            return { server, port: server.port }
          }),
          (allocated) =>
            Effect.sync(() => {
              allocated.server.stop(true)
            }),
        ).pipe(
          Effect.flatMap((allocated) =>
            allocated.port === undefined
              ? new StartFailedError({ message: "failed to allocate a free port" })
              : Effect.succeed(allocated.port),
          ),
        ),
      )
    })

    const resolvePort = Effect.fn("Preview.resolvePort")(function* (entry: Entry) {
      if (entry.settings.port !== undefined) return entry.settings.port
      // Managed servers default to auto-port allocation unless explicitly
      // disabled with autoPort: false (then the child must pick its own port).
      if (entry.settings.command !== undefined && entry.settings.autoPort !== false) return yield* freePort()
      return undefined
    })

    const kill = Effect.fnUntraced(function* (found: Entry) {
      if (!found.handle) return
      yield* found.handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.catch(() => Effect.void))
    })

    const resolveCwd = Effect.fn("Preview.resolveCwd")(function* (ctx: { worktree: string }, cwd: string) {
      const target = pathSvc.isAbsolute(cwd) ? cwd : pathSvc.join(ctx.worktree, cwd)
      if (!(yield* fs.existsSafe(target))) {
        return yield* new StartFailedError({ message: `preview server cwd does not exist: ${cwd}` })
      }
      return target
    })

    const spawnServer = Effect.fn("Preview.spawnServer")(function* (
      ctx: { directory: string; worktree: string },
      found: Entry,
      port: number | undefined,
    ) {
      const command = found.settings.command
      if (!command) return
      const cwd = found.settings.cwd ? yield* resolveCwd(ctx, found.settings.cwd) : ctx.directory
      const env: Record<string, string | undefined> = port !== undefined ? { PORT: String(port) } : {}
      const handle = yield* appProcess
        .spawn(
          ChildProcess.make(command, found.settings.args ?? [], {
            cwd,
            extendEnv: true,
            env,
            stdin: "ignore",
            detached: true,
          }),
        )
        .pipe(
          Effect.mapError(
            (error) =>
              new StartFailedError({
                message: `failed to spawn preview server "${found.settings.name}": ${error}`,
              }),
          ),
        )
      found.handle = handle
      found.pid = handle.pid
      found.state = "starting"
      if (port !== undefined) {
        found.port = port
        found.url = `http://localhost:${port}/`
      }
    })

    // Poll the server URL until it answers; the first successful response
    // flips the entry to running. A child exit before readiness fails.
    const waitReady = Effect.fnUntraced(function* (found: Entry) {
      if (!found.url) return
      const request = HttpClientRequest.get(found.url)
      const deadline = Date.now() + READY_TIMEOUT_MS
      while (true) {
        if (found.handle) {
          const alive = yield* found.handle.isRunning.pipe(Effect.orDie)
          if (!alive) {
            const code = yield* found.handle.exitCode.pipe(Effect.catch(() => Effect.succeed(-1)))
            found.state = "failed"
            found.handle = undefined
            return yield* new StartFailedError({
              message: `preview server "${found.settings.name}" exited with code ${code} before becoming ready`,
            })
          }
        }
        const probe = yield* http.execute(request).pipe(Effect.option)
        if (probe._tag === "Some") {
          found.state = "running"
          return
        }
        if (Date.now() > deadline) {
          found.state = "failed"
          yield* kill(found)
          found.handle = undefined
          return yield* new StartFailedError({
            message: `preview server "${found.settings.name}" did not become ready within ${Math.round(READY_TIMEOUT_MS / 1000)}s`,
          })
        }
        yield* Effect.sleep(READY_POLL)
      }
    })

    const startEntry = Effect.fn("Preview.startEntry")(function* (found: Entry) {
      if (found.state === "running" || found.state === "starting") return yield* info(found)
      if (found.settings.command === undefined) {
        // Attach-only: nothing to spawn, the configured URL is the truth.
        found.state = found.url ? "running" : "failed"
        return yield* info(found)
      }
      const ctx = yield* InstanceState.context
      yield* kill(found)
      found.handle = undefined
      found.pid = undefined
      found.port = undefined
      found.url = found.settings.url
      const instanceState = yield* InstanceState.get(state)
      const port = yield* resolvePort(found)
      // The handle attaches to the instance-state scope so the server dies
      // with the instance; `spawnServer` runs within that scope.
      yield* spawnServer(ctx, found, port).pipe(Effect.provideService(Scope.Scope, instanceState.scope))
      yield* waitReady(found).pipe(Effect.forkIn(instanceState.scope), Effect.catchCause(Effect.logError))
      return yield* info(found)
    })

    const stopEntry = Effect.fn("Preview.stopEntry")(function* (found: Entry) {
      if (found.state === "stopped") return yield* info(found)
      yield* kill(found)
      found.state = "stopped"
      found.handle = undefined
      found.pid = undefined
      found.port = found.settings.port
      found.url = found.settings.url
      return yield* info(found)
    })

    const verifyEntry = Effect.fnUntraced(function* (found: Entry) {
      const url = found.url
      if (!url || found.state !== "running") {
        return yield* new NoRunningServerError({
          message: `No preview server is running${found.state === "starting" ? " (still starting)" : ""}`,
        })
      }
      const response = yield* http
        .execute(HttpClientRequest.get(url))
        .pipe(
          Effect.mapError((error) => new NoRunningServerError({ message: `preview server did not respond: ${error}` })),
        )
      const body = yield* response.text.pipe(
        Effect.mapError(
          (error) => new NoRunningServerError({ message: `failed to read preview server response: ${error}` }),
        ),
      )
      const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(body)
      const errorCount = ["console.error", "Uncaught", "SyntaxError", "TypeError"].reduce(
        (count, needle) => count + (body.includes(needle) ? 1 : 0),
        0,
      )
      found.verifiedAt = Date.now()
      return {
        url,
        httpStatus: response.status,
        ...(titleMatch?.[1] ? { title: titleMatch[1].trim() } : {}),
        errorCount,
      }
    })

    const pickEntry = Effect.fn("Preview.pickEntry")(function* (name: string | undefined) {
      if (name) return yield* entry(name)
      const servers = yield* InstanceState.get(state)
      const running = [...servers.servers.values()].find((candidate) => candidate.state === "running")
      if (running) return running
      const starting = [...servers.servers.values()].find((candidate) => candidate.state === "starting")
      if (starting) return yield* new NoRunningServerError({ message: "preview server is still starting" })
      return yield* new NoRunningServerError({ message: "No preview server is running" })
    })

    return Service.of({
      list: Effect.fn("Preview.list")(function* () {
        const servers = yield* InstanceState.get(state)
        return yield* Effect.forEach([...servers.servers.values()], (candidate) => info(candidate), {
          concurrency: 1,
        })
      }),
      start: Effect.fn("Preview.start")(function* (name: string) {
        return yield* Effect.flatMap(entry(name), startEntry)
      }),
      stop: Effect.fn("Preview.stop")(function* (name: string) {
        return yield* Effect.flatMap(entry(name), stopEntry)
      }),
      restart: Effect.fn("Preview.restart")(function* (name: string) {
        const found = yield* entry(name)
        yield* stopEntry(found)
        return yield* startEntry(found)
      }),
      verify: Effect.fn("Preview.verify")(function* (name: string | undefined) {
        return yield* Effect.flatMap(pickEntry(name), verifyEntry)
      }),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, AppProcess.node, FSUtil.node, path, httpClient, EventV2Bridge.node],
})

export * as Preview from "./preview"