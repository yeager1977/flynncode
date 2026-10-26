import { LayerNode } from "@flynncode/core/effect/layer-node"
import { FSUtil } from "@flynncode/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import * as LSPClient from "./client"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import * as LSPServer from "./server"
import { Config } from "@/config/config"
import { LSPLaunch } from "./launch"
import { Clock, Duration, Effect, Layer, Context, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { containsPath, type InstanceContext } from "@/project/instance-context"
import { NonNegativeInt } from "@flynncode/core/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LspEvent } from "@flynncode/schema/lsp-event"

export const Event = LspEvent

const Position = Schema.Struct({
  line: NonNegativeInt,
  character: NonNegativeInt,
})

export const Range = Schema.Struct({
  start: Position,
  end: Position,
}).annotate({ identifier: "Range" })
export type Range = typeof Range.Type

export const Symbol = Schema.Struct({
  name: Schema.String,
  kind: NonNegativeInt,
  location: Schema.Struct({
    uri: Schema.String,
    range: Range,
  }),
}).annotate({ identifier: "Symbol" })
export type Symbol = typeof Symbol.Type

export const DocumentSymbol = Schema.Struct({
  name: Schema.String,
  detail: Schema.optional(Schema.String),
  kind: NonNegativeInt,
  range: Range,
  selectionRange: Range,
}).annotate({ identifier: "DocumentSymbol" })
export type DocumentSymbol = typeof DocumentSymbol.Type

export const Status = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root: Schema.String,
  status: Schema.Literals(["connected", "error"]),
}).annotate({ identifier: "LSPStatus" })
export type Status = typeof Status.Type

enum SymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

const kinds = [
  SymbolKind.Class,
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Interface,
  SymbolKind.Variable,
  SymbolKind.Constant,
  SymbolKind.Struct,
  SymbolKind.Enum,
]

const filterExperimentalServers = (servers: Record<string, LSPServer.Info>, flags: RuntimeFlags.Info) => {
  if (flags.experimentalLspTy) {
    if (servers["pyright"]) {
      delete servers["pyright"]
    }
  } else {
    if (servers["ty"]) {
      delete servers["ty"]
    }
  }
}

type LocInput = { file: string; line: number; character: number }

// `lsp` absent → "lazy": built-ins start only for an explicit `start` (the lsp tool), never
// from read/edit warm-ups, and are never downloaded. `true`/object → "eager" (warm-ups start
// servers). `false` → "off".
type Mode = "off" | "lazy" | "eager"

export type StartResult = "disabled" | "unavailable" | "ready"

const IDLE_TIMEOUT = Duration.minutes(10)
const IDLE_SWEEP_INTERVAL = Duration.minutes(1)
// Process-wide, across every open instance: language servers are memory-heavy and
// runaway children have swap-thrashed the owner's machine.
const MAX_RUNNING = 3

interface State {
  mode: Mode
  closed: boolean
  clients: LSPClient.Info[]
  servers: Record<string, LSPServer.Info>
  broken: Set<string>
  spawning: Map<string, Promise<LSPClient.Info | undefined>>
}

type Running = { state: State; ctx: InstanceContext; pid: number | undefined; used: number }

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly status: () => Effect.Effect<Status[]>
  readonly hasClients: (file: string) => Effect.Effect<boolean>
  readonly touchFile: (input: string, diagnostics?: "document" | "full") => Effect.Effect<void>
  readonly start: (input: string, diagnostics?: "document" | "full") => Effect.Effect<StartResult>
  readonly diagnostics: () => Effect.Effect<Record<string, LSPClient.Diagnostic[]>>
  readonly hover: (input: LocInput) => Effect.Effect<any>
  readonly definition: (input: LocInput) => Effect.Effect<any[]>
  readonly references: (input: LocInput) => Effect.Effect<any[]>
  readonly implementation: (input: LocInput) => Effect.Effect<any[]>
  readonly documentSymbol: (uri: string) => Effect.Effect<(DocumentSymbol | Symbol)[]>
  readonly workspaceSymbol: (query: string) => Effect.Effect<Symbol[]>
  readonly prepareCallHierarchy: (input: LocInput) => Effect.Effect<any[]>
  readonly incomingCalls: (input: LocInput) => Effect.Effect<any[]>
  readonly outgoingCalls: (input: LocInput) => Effect.Effect<any[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LSP") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const events = yield* EventV2Bridge.Service

    // Least recently used first: `touch` re-inserts a client on every use.
    const running = new Map<LSPClient.Info, Running>()
    const starting = { count: 0 }

    const release = (client: LSPClient.Info) => {
      const entry = running.get(client)
      running.delete(client)
      if (entry) entry.state.clients = entry.state.clients.filter((item) => item !== client)
      return entry
    }

    const stopClient = async (client: LSPClient.Info) => {
      const entry = release(client)
      await client.shutdown().catch(() => {})
      return entry
    }

    const touch = (clients: LSPClient.Info[], now: number) =>
      clients.forEach((client) => {
        const entry = running.get(client)
        if (!entry) return
        running.delete(client)
        running.set(client, { ...entry, used: now })
      })

    // Reserves a slot for one more server, stopping least recently used clients outside `keep`.
    // The slot is taken synchronously after the last check so concurrent spawns cannot overshoot.
    const reserve = async (keep: LSPClient.Info[], evicted: InstanceContext[]) => {
      while (running.size + starting.count >= MAX_RUNNING) {
        const victim = [...running.keys()].find((client) => !keep.includes(client))
        if (!victim) return false
        const entry = await stopClient(victim)
        if (entry) evicted.push(entry.ctx)
      }
      starting.count++
      return true
    }

    const announce = (ctx: InstanceContext) =>
      events.publish(Event.Updated, {}).pipe(Effect.provideService(InstanceRef, ctx))

    const sweep = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const idle = [...running].filter(([, entry]) => now - entry.used >= Duration.toMillis(IDLE_TIMEOUT))
      yield* Effect.forEach(
        idle,
        ([client, entry]) => Effect.promise(() => stopClient(client)).pipe(Effect.andThen(announce(entry.ctx))),
        { discard: true },
      )
    })
    yield* Effect.forever(Effect.sleep(IDLE_SWEEP_INTERVAL).pipe(Effect.andThen(sweep))).pipe(
      Effect.forkScoped({ startImmediately: true }),
    )

    // A process that exits without running finalizers still signals every server group;
    // "exit" listeners must be synchronous, so there is no SIGKILL follow-up here.
    const onExit = () =>
      running.forEach((entry) => {
        if (entry.pid) LSPLaunch.signal(entry.pid, "SIGTERM")
      })
    process.on("exit", onExit)
    yield* Effect.addFinalizer(() => Effect.sync(() => void process.off("exit", onExit)))

    const state = yield* InstanceState.make<State>(
      Effect.fn("LSP.state")(function* (ctx) {
        const cfg = yield* config.get()

        const servers: Record<string, LSPServer.Info> = {}
        const mode: Mode = cfg.lsp === false ? "off" : cfg.lsp === undefined ? "lazy" : "eager"

        if (mode === "off") yield* Effect.logInfo("all LSPs are disabled")
        if (mode !== "off") {
          for (const server of Object.values(LSPServer)) {
            servers[server.id] = server
          }

          filterExperimentalServers(servers, flags)

          if (typeof cfg.lsp === "object") {
            for (const [name, item] of Object.entries(cfg.lsp)) {
              const existing = servers[name]
              if (item.disabled) {
                yield* Effect.logInfo(`LSP server ${name} is disabled`)
                delete servers[name]
                continue
              }
              servers[name] = {
                ...existing,
                id: name,
                root: existing?.root ?? (async (_file, ctx) => ctx.directory),
                extensions: item.extensions ?? existing?.extensions ?? [],
                spawn: async (root) => ({
                  process: LSPLaunch.spawn(item.command[0], item.command.slice(1), {
                    cwd: root,
                    env: { ...process.env, ...item.env },
                  }),
                  initialization: item.initialization,
                }),
              }
            }
          }

          yield* Effect.logInfo("enabled LSP servers", {
            mode,
            serverIds: Object.values(servers)
              .map((server) => server.id)
              .join(", "),
          })
        }

        const s: State = {
          mode,
          closed: false,
          clients: [],
          servers,
          broken: new Set(),
          spawning: new Map(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            s.closed = true
            await Promise.all([...s.clients].map(stopClient))
          }),
        )

        return s
      }),
    )

    // `explicit` callers (the lsp tool) may start servers in lazy mode; everyone else only
    // reaches servers that are already running unless the config asked for eager warm-ups.
    const getClients = Effect.fnUntraced(function* (file: string, explicit: boolean) {
      const ctx = yield* InstanceState.context
      if (!containsPath(file, ctx)) return [] as LSPClient.Info[]
      const s = yield* InstanceState.get(state)
      const spawn = explicit || s.mode === "eager"
      const now = yield* Clock.currentTimeMillis
      const clients = yield* Effect.promise(async () => {
        const extension = path.parse(file).ext || file
        const result: LSPClient.Info[] = []
        const evicted: InstanceContext[] = []
        let updated = 0

        async function schedule(server: LSPServer.Info, root: string, key: string) {
          // Lazy mode only uses servers that are already installed; downloads need an explicit `lsp` config.
          const handle = await server
            .spawn(root, ctx, s.mode === "lazy" ? { ...flags, disableLspDownload: true } : flags)
            .then((value) => {
              if (!value) s.broken.add(key)
              return value
            })
            .catch(() => {
              s.broken.add(key)
              return undefined
            })

          if (!handle) return undefined
          const client = await LSPClient.create({
            serverID: server.id,
            server: handle,
            root,
            directory: ctx.directory,
            instance: ctx,
          }).catch(async () => {
            s.broken.add(key)
            await LSPLaunch.stop(handle.process)
            return undefined
          })

          if (!client) return undefined

          const existing = s.clients.find((x) => x.root === root && x.serverID === server.id)
          if (existing || s.closed) {
            await client.shutdown()
            return existing
          }

          s.clients.push(client)
          running.set(client, { state: s, ctx, pid: handle.process.pid, used: now })
          // A server that dies on its own is reaped and marked broken so warm-ups cannot respawn it in a loop.
          const onExit = () => {
            if (!running.has(client)) return
            release(client)
            s.broken.add(key)
            if (handle.process.pid) LSPLaunch.signal(handle.process.pid, "SIGTERM")
          }
          handle.process.once("exit", onExit)
          if (handle.process.exitCode !== null || handle.process.signalCode !== null) onExit()
          return client
        }

        for (const server of Object.values(s.servers)) {
          if (server.extensions.length && !server.extensions.includes(extension)) continue

          const root = await server.root(file, ctx)
          if (!root) continue
          if (s.broken.has(root + server.id)) continue

          const match = s.clients.find((x) => x.root === root && x.serverID === server.id)
          if (match) {
            result.push(match)
            continue
          }

          const inflight = s.spawning.get(root + server.id)
          if (inflight) {
            const client = await inflight
            if (!client) continue
            result.push(client)
            continue
          }

          if (!spawn) continue
          if (!(await reserve(result, evicted))) continue

          const task = schedule(server, root, root + server.id)
          s.spawning.set(root + server.id, task)

          task.finally(() => {
            starting.count--
            if (s.spawning.get(root + server.id) === task) {
              s.spawning.delete(root + server.id)
            }
          })

          const client = await task
          if (!client) continue

          result.push(client)
          updated++
        }

        return { result, updated, evicted }
      })
      touch(clients.result, now)
      yield* Effect.forEach(Array.from({ length: clients.updated }), () => events.publish(Event.Updated, {}), {
        discard: true,
      })
      yield* Effect.forEach(clients.evicted, announce, { discard: true })
      return clients.result
    })

    const run = Effect.fnUntraced(function* <T>(file: string, fn: (client: LSPClient.Info) => Promise<T>) {
      const clients = yield* getClients(file, false)
      return yield* Effect.promise(() => Promise.all(clients.map((x) => fn(x))))
    })

    const open = (clients: LSPClient.Info[], input: string, diagnostics?: "document" | "full") =>
      Effect.promise(() =>
        Promise.all(
          clients.map(async (client) => {
            const after = Date.now()
            const version = await client.notify.open({ path: input })
            if (!diagnostics) return
            return client.waitForDiagnostics({
              path: input,
              version,
              mode: diagnostics,
              after,
            })
          }),
        ).catch(() => {}),
      )

    const runAll = Effect.fnUntraced(function* <T>(fn: (client: LSPClient.Info) => Promise<T>) {
      const s = yield* InstanceState.get(state)
      return yield* Effect.promise(() => Promise.all(s.clients.map((x) => fn(x))))
    })

    const init = Effect.fn("LSP.init")(function* () {
      yield* InstanceState.get(state)
    })

    const status = Effect.fn("LSP.status")(function* () {
      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      const result: Status[] = []
      for (const client of s.clients) {
        result.push({
          id: client.serverID,
          name: s.servers[client.serverID].id,
          root: path.relative(ctx.directory, client.root),
          status: "connected",
        })
      }
      return result
    })

    const hasClients = Effect.fn("LSP.hasClients")(function* (file: string) {
      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      return yield* Effect.promise(async () => {
        const extension = path.parse(file).ext || file
        for (const server of Object.values(s.servers)) {
          if (server.extensions.length && !server.extensions.includes(extension)) continue
          const root = await server.root(file, ctx)
          if (!root) continue
          if (s.broken.has(root + server.id)) continue
          return true
        }
        return false
      })
    })

    const touchFile = Effect.fn("LSP.touchFile")(function* (input: string, diagnostics?: "document" | "full") {
      yield* Effect.logInfo("touching file", { file: input })
      yield* open(yield* getClients(input, false), input, diagnostics)
    })

    const start = Effect.fn("LSP.start")(function* (input: string, diagnostics?: "document" | "full") {
      const s = yield* InstanceState.get(state)
      if (s.mode === "off") return "disabled" satisfies StartResult
      const clients = yield* getClients(input, true)
      if (!clients.length) return "unavailable" satisfies StartResult
      yield* open(clients, input, diagnostics)
      return "ready" satisfies StartResult
    })

    const diagnostics = Effect.fn("LSP.diagnostics")(function* () {
      const results: Record<string, LSPClient.Diagnostic[]> = {}
      const all = yield* runAll(async (client) => client.diagnostics)
      for (const result of all) {
        for (const [p, diags] of result.entries()) {
          const arr = results[p] || []
          arr.push(...diags)
          results[p] = arr
        }
      }
      return results
    })

    const hover = Effect.fn("LSP.hover")(function* (input: LocInput) {
      return yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/hover", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
    })

    const definition = Effect.fn("LSP.definition")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/definition", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
      return results.flat().filter(Boolean)
    })

    const references = Effect.fn("LSP.references")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/references", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
            context: { includeDeclaration: true },
          })
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    const implementation = Effect.fn("LSP.implementation")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/implementation", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
      return results.flat().filter(Boolean)
    })

    const documentSymbol = Effect.fn("LSP.documentSymbol")(function* (uri: string) {
      const file = fileURLToPath(uri)
      const results = yield* run(file, (client) =>
        client.connection.sendRequest("textDocument/documentSymbol", { textDocument: { uri } }).catch(() => []),
      )
      return (results.flat() as (DocumentSymbol | Symbol)[]).filter(Boolean)
    })

    const workspaceSymbol = Effect.fn("LSP.workspaceSymbol")(function* (query: string) {
      touch((yield* InstanceState.get(state)).clients, yield* Clock.currentTimeMillis)
      const results = yield* runAll((client) =>
        client.connection
          .sendRequest<Symbol[]>("workspace/symbol", { query })
          .then((result) => result.filter((x) => kinds.includes(x.kind)).slice(0, 10))
          .catch(() => [] as Symbol[]),
      )
      return results.flat()
    })

    const prepareCallHierarchy = Effect.fn("LSP.prepareCallHierarchy")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/prepareCallHierarchy", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    const callHierarchyRequest = Effect.fnUntraced(function* (
      input: LocInput,
      direction: "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls",
    ) {
      const results = yield* run(input.file, async (client) => {
        const items = await client.connection
          .sendRequest<unknown[] | null>("textDocument/prepareCallHierarchy", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => [] as unknown[])
        if (!items?.length) return []
        return client.connection.sendRequest(direction, { item: items[0] }).catch(() => [])
      })
      return results.flat().filter(Boolean)
    })

    const incomingCalls = Effect.fn("LSP.incomingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/incomingCalls")
    })

    const outgoingCalls = Effect.fn("LSP.outgoingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/outgoingCalls")
    })

    return Service.of({
      init,
      status,
      hasClients,
      touchFile,
      start,
      diagnostics,
      hover,
      definition,
      references,
      implementation,
      documentSymbol,
      workspaceSymbol,
      prepareCallHierarchy,
      incomingCalls,
      outgoingCalls,
    })
  }),
)

export * as Diagnostic from "./diagnostic"

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, RuntimeFlags.node, FSUtil.node, EventV2Bridge.node],
})

export * as LSP from "./lsp"
