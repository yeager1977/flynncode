import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { HooksTrust } from "@/hooks/trust"
import { HooksExecutor, enumerateHooks } from "@/hooks/executor"
import { HooksManaged } from "@/hooks/managed"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as InstanceState from "@/effect/instance-state"
import { FSUtil } from "@flynncode/core/fs-util"
import { Effect, Option } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service
    const trustSvc = yield* HooksTrust.Service
    const flags = yield* RuntimeFlags.Service
    const fs = yield* FSUtil.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const projectGet = Effect.fn("ConfigHttpApi.projectGet")(function* () {
      return yield* configSvc.getProject()
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
            source: item.def.source,
          }
        }),
        managed: (def: HooksTrust.HookDef) => Option.isSome(maybeManaged) && maybeManaged.value.isManaged(def),
      }
    })

    // Claude Code hook sources as the config loader sees them, including
    // sources switched off by claude_hooks.disabled.
    const claudeHooks = Effect.fn("ConfigHttpApi.claudeHooks")(function* () {
      if (flags.disableClaudeHooks) return { sources: [], warnings: [] }
      const cfg = yield* configSvc.get()
      return yield* Config.loadClaudeHookSet(yield* InstanceState.context, cfg.claude_hooks?.disabled ?? []).pipe(
        Effect.provideService(FSUtil.Service, fs),
      )
    })

    const hooksTrust = Effect.fn("ConfigHttpApi.hooksTrust")(function* () {
      const listed = yield* hooksEntries()
      const claude = yield* claudeHooks()
      const global = new Set((yield* configSvc.getGlobal()).claude_hooks?.disabled ?? [])
      return {
        hooks: listed.entries,
        bypass: flags.bypassHookTrust,
        claudeSources: claude.sources.map((source) =>
          source.enabled || global.has(source.id) ? source : { ...source, disabledByProject: true },
        ),
        claudeWarnings: claude.warnings,
        claudeDisabled: flags.disableClaudeHooks,
      }
    })

    // The switch writes the global config file, so a source turned off here is
    // off in every project.
    const hooksClaudeToggle = Effect.fn("ConfigHttpApi.hooksClaudeToggle")(function* (ctx: {
      payload: { id: string; enabled: boolean }
    }) {
      if (!ctx.payload.id.startsWith("claude:")) return yield* Effect.fail(new HttpApiError.BadRequest({}))
      const global = yield* configSvc.getGlobal()
      const current = global.claude_hooks?.disabled ?? []
      const disabled = ctx.payload.enabled
        ? current.filter((id) => id !== ctx.payload.id)
        : Array.from(new Set([...current, ctx.payload.id]))
      yield* configSvc.updateGlobal({ claude_hooks: { ...global.claude_hooks, disabled } })
      return yield* hooksTrust()
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
      .handle("projectGet", projectGet)
      .handle("update", update)
      .handle("providers", providers)
      .handle("hooksTrust", hooksTrust)
      .handle("hooksTrustOne", hooksTrustOne)
      .handle("hooksRevoke", hooksRevoke)
      .handle("hooksClaudeToggle", hooksClaudeToggle)
  }),
)
