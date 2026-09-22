import { Config } from "@/config/config"
import { ConfigOmoFiles } from "@/config/omo-files"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ApiOmoConfigWriteError, OmoConfigPatch } from "../groups/global"
import { markInstanceForDisposal } from "../lifecycle"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service

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

    return handlers
      .handle("get", get)
      .handle("update", update)
      .handle("providers", providers)
      .handle("omoGet", omoGet)
      .handle("omoPut", omoPut)
  }),
)
