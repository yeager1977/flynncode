import { LayerNode } from "@flynncode/core/effect/layer-node"
import { makeGlobalNode, Node } from "@flynncode/core/effect/app-node"
import { GlobalBus } from "@/bus/global"
import { serviceUse } from "@flynncode/core/effect/service-use"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance as runDisposers } from "@/effect/instance-registry"
import { FSUtil } from "@flynncode/core/fs-util"
import { Watcher } from "@flynncode/core/filesystem/watcher"
import { normalizeFolders } from "@flynncode/core/project/folders"
import { SessionFolders } from "@flynncode/core/session/folders"
import { Context, Deferred, Duration, Effect, Exit, Layer, Schedule, Scope } from "effect"
import * as Stream from "effect/Stream"
import { type InstanceContext } from "./instance-context"
import { InstanceBootstrap } from "./bootstrap-service"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatus } from "@/session/status"
import * as Project from "./project"

export interface LoadInput {
  directory: string
  worktree?: string
  project?: Project.Info
  additionalDirectories?: string[]
}

export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly reload: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly dispose: (ctx: InstanceContext) => Effect.Effect<void>
  readonly disposeDirectory: (directory: string) => Effect.Effect<void>
  readonly disposeAll: () => Effect.Effect<void>
  /** Global sweep that lets sessions finish: busy instances dispose on idle. */
  readonly disposeAllDeferringBusy: () => Effect.Effect<void>
  readonly loadedDirectories: () => Effect.Effect<ReadonlySet<string>>
  readonly setAdditionalDirectories: (directory: string, extras: string[]) => Effect.Effect<InstanceContext>
  readonly provide: <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceStore") {}

export const use = serviceUse(Service)

interface Entry {
  readonly deferred: Deferred.Deferred<InstanceContext>
}

interface Parked {
  readonly entry: Entry
  readonly ctx: InstanceContext
  readonly parkedAt: number
}

// A parked disposal expires after this long even when the instance never
// reports idle: a wedged busy status must not pin the instance (and its LSP /
// MCP children) forever. Generous — it only covers crash-style wedges.
const PARKED_DISPOSAL_TTL_MS = 24 * 60 * 60 * 1000
// Idle instances the toucher stopped visiting long ago get reclaimed hourly,
// so closing a workspace's last tab frees its LSP/MCP children and watchers
// even when no explicit dispose arrives. Only instances with no running work
// (probe below) and no request in the idle window are reclaimable.
const IDLE_INSTANCE_TTL_MS = 30 * 60 * 1000
const IDLE_INSTANCE_SWEEP_INTERVAL = "10 minutes"

const layer: Layer.Layer<
  Service,
  never,
  Project.Service | InstanceBootstrap.Service | EventV2Bridge.Service | SessionFolders.Service | SessionStatus.Service
> =
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const project = yield* Project.Service
      const folders = yield* SessionFolders.Service
      const bootstrap = yield* InstanceBootstrap.Service
      const events = yield* EventV2Bridge.Service
      const scope = yield* Scope.Scope
      const cache = new Map<string, Entry>()
      const lastTouched = new Map<string, number>()
      const parking = new Map<string, Parked>()
      // The status service is a stateless wrapper; its state is per-directory
      // through the InstanceRef, so capture the service once here and probe
      // any directory with it.
      const status = yield* SessionStatus.Service

      // Whether an instance still has work in flight: non-idle session
      // statuses (deleted exactly on idle). Disposal skips these so a config
      // refresh never aborts a running turn.
      const instanceBusy = (ctx: InstanceContext) =>
        status.list().pipe(
          Effect.provideService(InstanceRef, ctx),
          Effect.map((running) => running.size > 0),
        )

      const extraSubs = yield* InstanceState.make(
        Effect.fn("InstanceStore.extraRoots")(function* () {
          const subscribed = new Map<string, () => Promise<void>>()
          yield* Effect.addFinalizer(() =>
            Effect.promise(() =>
              Promise.allSettled([...subscribed.values()].map((unsubscribe) => unsubscribe())),
            ).pipe(Effect.asVoid, Effect.ignore),
          )
          return { subscribed }
        }),
      )

      // Multifold: extra roots get native file-watcher subscriptions without
      // Location nodes. Location.Ref stays the sole placement key; this only
      // forwards file events into the instance stream. Extras attached through
      // the V2 server surface reach this sync through SessionFolders.Live.
      const syncExtraRoots = Effect.fn("InstanceStore.syncExtraRoots")(function* () {
        const ctx = yield* InstanceState.context
        const state = yield* InstanceState.get(extraSubs)
        const bridge = yield* EffectBridge.make()
        const wanted = new Set(normalizeFolders(ctx.directory, ctx.additionalDirectories))
        for (const [root, unsubscribe] of state.subscribed) {
          if (wanted.has(root)) continue
          yield* Effect.promise(() => unsubscribe()).pipe(Effect.ignore)
          state.subscribed.delete(root)
        }
        const fresh = [...wanted].filter((root) => !state.subscribed.has(root))
        if (fresh.length === 0) return
        const cleanups = yield* Watcher.subscribeRoots(fresh, (update) => {
          bridge.fork(events.publish(Watcher.Event.Updated, { file: update.file, event: update.event }))
        })
        for (const [root, unsubscribe] of cleanups) state.subscribed.set(root, unsubscribe)
      })

      const boot = (input: LoadInput & { directory: string }) =>
        Effect.gen(function* () {
          // Instances are shared per directory, so the live boundary is the
          // union of extras attached by every session placed here.
          const additionalDirectories = input.additionalDirectories ?? (yield* folders.forDirectory(input.directory))
          const ctx: InstanceContext =
            input.project && input.worktree
              ? {
                  directory: input.directory,
                  worktree: input.worktree,
                  project: input.project,
                  additionalDirectories,
                }
              : yield* project.fromDirectory(input.directory).pipe(
                  Effect.map((result) => ({
                    directory: input.directory,
                    worktree: result.sandbox,
                    project: result.project,
                    additionalDirectories,
                  })),
                )
        yield* bootstrap.run.pipe(Effect.provideService(InstanceRef, ctx))
        yield* syncExtraRoots().pipe(
          Effect.provideService(InstanceRef, ctx),
          Effect.catchCause((cause) => Effect.logWarning("extra roots watch failed", { cause })),
        )
        return ctx
        }).pipe(Effect.withSpan("InstanceStore.boot"))

    const removeEntry = (directory: string, entry: Entry) =>
      Effect.sync(() => {
        if (cache.get(directory) !== entry) return false
        cache.delete(directory)
        return true
      })

    const completeLoad = (directory: string, input: LoadInput, entry: Entry) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(boot({ ...input, directory }))
        if (Exit.isFailure(exit)) yield* removeEntry(directory, entry)
        yield* Deferred.done(entry.deferred, exit).pipe(Effect.asVoid)
      })

    const emitDisposed = (input: { directory: string; project?: string }) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: input.directory,
          project: input.project,
          workspace: WorkspaceContext.workspaceID,
          payload: {
            type: "server.instance.disposed",
            properties: {
              directory: input.directory,
            },
          },
        }),
      )

    const disposeContext = Effect.fn("InstanceStore.disposeContext")(function* (ctx: InstanceContext) {
      yield* Effect.logInfo("disposing instance", { directory: ctx.directory })
      yield* Effect.promise(() => runDisposers(ctx.directory))
      yield* emitDisposed({ directory: ctx.directory, project: ctx.project.id })
    })

    const disposeEntry = Effect.fnUntraced(function* (directory: string, entry: Entry, ctx: InstanceContext) {
      if (cache.get(directory) !== entry) return false
      yield* disposeContext(ctx)
      if (cache.get(directory) !== entry) return false
      cache.delete(directory)
      return true
    })

    const load = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = FSUtil.resolve(input.directory)
      lastTouched.set(directory, Date.now())
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const existing = cache.get(directory)
          if (existing) return yield* restore(Deferred.await(existing.deferred))

          const entry: Entry = { deferred: Deferred.makeUnsafe<InstanceContext>() }
          cache.set(directory, entry)
          yield* Effect.gen(function* () {
            yield* Effect.logInfo("creating instance", { directory: directory })
            yield* completeLoad(directory, input, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          return yield* restore(Deferred.await(entry.deferred))
        }),
      ).pipe(Effect.withSpan("InstanceStore.load"))
    }

    const reload = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const previous = cache.get(directory)
          const entry: Entry = { deferred: Deferred.makeUnsafe<InstanceContext>() }
          cache.set(directory, entry)
          yield* Effect.gen(function* () {
            yield* Effect.logInfo("reloading instance", { directory: directory })
            if (previous) {
              yield* Deferred.await(previous.deferred).pipe(Effect.ignore)
              yield* Effect.promise(() => runDisposers(directory))
              yield* emitDisposed({ directory, project: input.project?.id })
            }
            yield* completeLoad(directory, input, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          return yield* restore(Deferred.await(entry.deferred))
        }),
      ).pipe(Effect.withSpan("InstanceStore.reload"))
    }

    const dispose = Effect.fn("InstanceStore.dispose")(function* (ctx: InstanceContext) {
      const entry = cache.get(ctx.directory)
      if (!entry) return yield* disposeContext(ctx)

      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(ctx.directory, entry).pipe(Effect.asVoid)
      if (exit.value !== ctx) return
      yield* disposeEntry(ctx.directory, entry, ctx).pipe(Effect.asVoid)
    })

    const disposeDirectory = Effect.fn("InstanceStore.disposeDirectory")(function* (input: string) {
      const directory = FSUtil.resolve(input)
      const entry = cache.get(directory)
      if (!entry) return
      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(directory, entry).pipe(Effect.asVoid)
      yield* disposeEntry(directory, entry, exit.value).pipe(Effect.asVoid)
    })

    const disposeAllOnce = Effect.fnUntraced(function* () {
      yield* Effect.logInfo("disposing all instances")
      yield* Effect.forEach(
        [...cache.entries()],
        (item) =>
          Effect.gen(function* () {
            const exit = yield* Deferred.await(item[1].deferred).pipe(Effect.exit)
            if (Exit.isFailure(exit)) {
              yield* Effect.logWarning("instance dispose failed", { key: item[0], cause: exit.cause })
              yield* removeEntry(item[0], item[1])
              return
            }
            yield* disposeEntry(item[0], item[1], exit.value)
          }),
        { discard: true },
      )
    })

    const disposeAllDeferredOnce = Effect.fnUntraced(function* () {
      yield* Effect.logInfo("disposing all instances (deferring busy ones)")
      for (const [directory, entry] of [...cache.entries()]) {
        const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
        if (Exit.isFailure(exit)) {
          yield* Effect.logWarning("instance dispose failed", { key: directory, cause: exit.cause })
          yield* removeEntry(directory, entry)
          continue
        }
        // Config/global changes refresh instances so they boot with the new
        // options — except instances whose sessions are mid-turn: aborting
        // them to apply config would throw away the user's work, so park the
        // disposal and let the idle hook below finish it.
        const busy = yield* instanceBusy(exit.value)
        if (busy) {
          parking.set(directory, { entry, ctx: exit.value, parkedAt: Date.now() })
          continue
        }
        yield* disposeEntry(directory, entry, exit.value)
      }
    })

    const cachedDisposeAll = yield* Effect.cachedWithTTL(disposeAllOnce(), Duration.zero)
    const disposeAll = Effect.fn("InstanceStore.disposeAll")(function* () {
      return yield* cachedDisposeAll
    })

    const cachedDisposeAllDeferred = yield* Effect.cachedWithTTL(disposeAllDeferredOnce(), Duration.zero)
    const disposeAllDeferringBusy = Effect.fn("InstanceStore.disposeAllDeferringBusy")(function* () {
      return yield* cachedDisposeAllDeferred
    })

    const provide = <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      load(input).pipe(Effect.flatMap((ctx) => effect.pipe(Effect.provideService(InstanceRef, ctx))))

    const loadedDirectories = () => Effect.succeed(new Set(cache.keys()) as ReadonlySet<string>)

    const setAdditionalDirectories = Effect.fn("InstanceStore.setAdditionalDirectories")(function* (
      directory: string,
      extras: string[],
    ) {
      const ctx = yield* load({ directory })
      ctx.additionalDirectories = [...extras]
      yield* syncExtraRoots().pipe(
        Effect.provideService(InstanceRef, ctx),
        Effect.catchCause((cause) => Effect.logWarning("extra roots watch failed", { cause })),
      )
      return ctx
    })

    yield* Effect.addFinalizer(() => disposeAll().pipe(Effect.ignore))

    const idleHook = Effect.fn("InstanceStore.idleHook")(function* (directory: string) {
      const parked = parking.get(directory)
      if (parked) {
        if (Date.now() - parked.parkedAt < PARKED_DISPOSAL_TTL_MS && (yield* instanceBusy(parked.ctx))) return
        parking.delete(directory)
        yield* disposeEntry(directory, parked.entry, parked.ctx).pipe(Effect.ignore)
        return
      }
      const entry = cache.get(directory)
      if (!entry) return
      const touched = lastTouched.get(directory) ?? 0
      if (Date.now() - touched < IDLE_INSTANCE_TTL_MS) return
      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(directory, entry).pipe(Effect.asVoid)
      // A workspace the user left long ago keeps its LSP/MCP children and
      // watchers alive for nothing; reclaim it unless work is running.
      if (yield* instanceBusy(exit.value)) return
      yield* Effect.logInfo("reclaiming idle instance", { directory })
      yield* disposeEntry(directory, entry, exit.value).pipe(Effect.ignore)
      lastTouched.delete(directory)
    })

    const idleClock = Effect.repeat(
      Effect.sleep(IDLE_INSTANCE_SWEEP_INTERVAL).pipe(
        Effect.andThen(
          Effect.forEach([...cache.keys()], (directory) => idleHook(directory).pipe(Effect.ignore), { discard: true }),
        ),
      ),
      Schedule.spaced(IDLE_INSTANCE_SWEEP_INTERVAL),
    )

    // Sessions going idle drive both parked-config disposals and reclaims.
    // The idle event is location-scoped, so it names the directory directly.
    yield* events.subscribe(SessionStatus.Event.Idle).pipe(
      Stream.runForEach((event) => {
        const directory = event.location?.directory
        if (directory === undefined) return Effect.void
        return idleHook(directory).pipe(Effect.ignore)
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
    // The same reclamation also runs on a clock for instances whose idles are
    // missed (no live subscription replay) — e.g. disposal arrived while the
    // last session was still busy with no further events after.
    yield* idleClock.pipe(Effect.forkScoped({ startImmediately: true }))

    return Service.of({
      load,
      reload,
      dispose,
      disposeDirectory,
      disposeAll,
      disposeAllDeferringBusy,
      loadedDirectories,
      setAdditionalDirectories,
      provide,
    })
  }),
)

export const bootstrapNode = LayerNode.unbound(InstanceBootstrap.Service, Node.tags.values.global)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [Project.node, bootstrapNode, EventV2Bridge.node, SessionFolders.node, SessionStatus.node],
})

// Re-applies the per-session folder union to an already running instance.
// Directories without a loaded instance pick the union up on their next boot.
export const foldersNode = makeGlobalNode({
  service: SessionFolders.Live,
  layer: Layer.effect(
    SessionFolders.Live,
    Effect.gen(function* () {
      const store = yield* Service
      const folders = yield* SessionFolders.Service
      return SessionFolders.Live.of({
        refresh: Effect.fn("InstanceStore.refreshFolders")(function* (input: string) {
          const directory = FSUtil.resolve(input)
          if (!(yield* store.loadedDirectories()).has(directory)) return
          yield* store.setAdditionalDirectories(directory, yield* folders.forDirectory(directory))
        }),
      })
    }),
  ),
  deps: [node, SessionFolders.node],
})

export * as InstanceStore from "./instance-store"
