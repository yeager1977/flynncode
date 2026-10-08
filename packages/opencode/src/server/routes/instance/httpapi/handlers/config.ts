import { Config } from "@/config/config"
import { ConfigOmoFiles } from "@/config/omo-files"
import { Provider } from "@/provider/provider"
import { HooksTrust } from "@/hooks/trust"
import { HooksExecutor, enumerateHooks } from "@/hooks/executor"
import { HooksManaged } from "@/hooks/managed"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as InstanceState from "@/effect/instance-state"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ApiOmoConfigWriteError, OmoConfigPatch } from "../groups/global"
import { markInstanceForDisposal } from "../lifecycle"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service
    const trustSvc = yield* HooksTrust.Service
    const flags = yield* RuntimeFlags.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
      }
    })

    const omoGet = Effect.fn("ConfigHttpApi.omoGet")(function* () {
      const ctx = yield* InstanceState.context
      return yield* ConfigOmoFiles.readInfo(ctx.directory)
    })

    const omoPut = Effect.fn("ConfigHttpApi.omoPut")(function* (ctx: {
      payload: typeof OmoConfigPatch.Type
    }) {
      const instance = yield* InstanceState.context
      const patch: ConfigOmoFiles.PluginPatch = {
        agents: { ...ctx.payload.agents },
        categories: { ...ctx.payload.categories },
        disabledProviders: [...ctx.payload.disabledProviders],
        openCodeDisabledProviders: [...ctx.payload.openCodeDisabledProviders],
      }
      return yield* ConfigOmoFiles.write(instance.directory, patch).pipe(
        Effect.mapError(
          (error) => new ApiOmoConfigWriteError({ name: "OmoConfigWriteError", data: error }),
        ),
      )
    })

    // Configured hooks keyed by their project-bound trust identity, the same
    // identity the executor checks before running a hook.
    const boundHooks = Effect.fn("ConfigHttpApi.boundHooks")(function* () {
      const cfg = yield* configSvc.get()
      return yield* Effect.forEach(enumerateHooks(cfg.hooks), (item) =>
        HooksTrust.bindToInstance(item.def).pipe(
          Effect.map((bound) => ({ ...item, bound, hash: HooksTrust.hashDef(bound) })),
        ),
      )
    })

    const hooksEntries = Effect.fn("ConfigHttpApi.hooksEntries")(function* () {
      const stored = yield* trustSvc.list()
      const byHash = new Map(stored.map((entry) => [entry.hash, entry.trustedAt]))
      const maybeManaged = yield* Effect.serviceOption(HooksManaged.ManagedHooks)
      return {
        entries: (yield* boundHooks()).map((item) => {
          const managed = Option.isSome(maybeManaged) && maybeManaged.value.isManaged(item.def)
          const trustedAt = byHash.get(item.hash)
          return {
            hash: item.hash,
            event: item.event,
            matcher: item.matcher,
            summary: item.summary,
            trusted: managed || trustedAt !== undefined,
            trustedAt,
            managed,
          }
        }),
        managed: (def: HooksTrust.HookDef) =>
          Option.isSome(maybeManaged) && maybeManaged.value.isManaged(def),
      }
    })

    const hooksTrust = Effect.fn("ConfigHttpApi.hooksTrust")(function* () {
      const listed = yield* hooksEntries()
      return { hooks: listed.entries, bypass: flags.bypassHookTrust }
    })

    const hooksTrustOne = Effect.fn("ConfigHttpApi.hooksTrustOne")(function* (ctx: { payload: { hash: string } }) {
      const found = (yield* boundHooks()).find((item) => item.hash === ctx.payload.hash)
      if (!found) return yield* Effect.fail(new HttpApiError.BadRequest({}))
      yield* trustSvc.trust(found.bound)
      const listed = yield* hooksEntries()
      const entry = listed.entries.find((item) => item.hash === ctx.payload.hash)
      if (!entry) return yield* Effect.fail(new HttpApiError.BadRequest({}))
      return entry
    })

    const hooksRevoke = Effect.fn("ConfigHttpApi.hooksRevoke")(function* (ctx: { payload: { hash: string } }) {
      const found = (yield* boundHooks()).find((item) => item.hash === ctx.payload.hash)
      if (!found) return yield* Effect.fail(new HttpApiError.BadRequest({}))
      const listed = yield* hooksEntries()
      // Managed hooks are trusted by policy and cannot be disabled.
      if (listed.managed(found.def)) return yield* Effect.fail(new HttpApiError.BadRequest({}))
      yield* trustSvc.revoke(ctx.payload.hash)
      const refreshed = yield* hooksEntries()
      const entry = refreshed.entries.find((item) => item.hash === ctx.payload.hash)
      if (!entry) return yield* Effect.fail(new HttpApiError.BadRequest({}))
      return entry
    })

    return handlers
      .handle("get", get)
      .handle("update", update)
      .handle("providers", providers)
      .handle("omoGet", omoGet)
      .handle("omoPut", omoPut)
      .handle("hooksTrust", hooksTrust)
      .handle("hooksTrustOne", hooksTrustOne)
      .handle("hooksRevoke", hooksRevoke)
  }),
)
