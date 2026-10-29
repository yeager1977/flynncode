import { ProviderAuth } from "@/provider/auth"
import { Config } from "@/config/config"
import { ModelsDev } from "@flynncode/core/models-dev"
import { Provider } from "@/provider/provider"
import { Auth } from "@/auth"

import { mapValues } from "remeda"
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProviderAuthApiError } from "../groups/provider"
import { ProviderV2 } from "@flynncode/core/provider"
import { Integration } from "@flynncode/core/integration"
import { EventV2Bridge } from "@/event-v2-bridge"

function mapProviderAuthError<A, R>(self: Effect.Effect<A, ProviderAuth.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => {
      if (error instanceof ProviderAuth.OauthMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCodeMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCallbackFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: {} })
      }
      if (error instanceof ProviderAuth.ValidationFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: { field: error.field, message: error.message } })
      }
      return new ProviderAuthApiError({ name: "BadRequest", data: {} })
    }),
  )
}

type ListInput = {
  config: { readonly enabled_providers?: readonly string[]; readonly disabled_providers?: readonly string[] }
  catalog: Record<string, ModelsDev.Provider>
  connected: Record<ProviderV2.ID, Provider.Info>
  credentials: Record<string, unknown>
}

type Serialized = { body: string; etag: string }

type Revision = {
  input: ListInput
  credentials: string
  full?: Serialized
  slim?: Serialized
}

// Keyed by the provider state record: it is rebuilt per directory when config, the models.dev catalog or
// integrations change, so a new record (or new config, catalog or credential set) is a new revision.
const revisions = new WeakMap<object, Revision>()

function revisionFor(input: ListInput) {
  const credentials = Object.keys(input.credentials).sort().join("\n")
  const cached = revisions.get(input.connected)
  if (
    cached &&
    cached.input.config === input.config &&
    cached.input.catalog === input.catalog &&
    cached.credentials === credentials
  )
    return cached
  const next: Revision = { input, credentials }
  revisions.set(input.connected, next)
  return next
}

function fullList(input: ListInput): Provider.ListResult {
  const providers = Object.assign(
    mapValues(enabledCatalog(input), (item) => Provider.fromModelsDevProvider(item)),
    input.connected,
  )
  return {
    all: Object.values(providers).map(Provider.toPublicInfo),
    default: Provider.defaultModelIDs(providers),
    connected: connectedIDs(input),
  }
}

// Only the connected providers, built without touching the rest of the catalog. Options, headers and variant
// settings are server-side request details that clients never read.
function slimList(input: ListInput): Provider.ListResult {
  const catalog = enabledCatalog(input)
  const connected = connectedIDs(input)
  const providers = Object.fromEntries(
    connected.map((id) => [
      id,
      Provider.toPublicInfo(input.connected[ProviderV2.ID.make(id)] ?? Provider.fromModelsDevProvider(catalog[id])),
    ]),
  )
  return {
    all: Object.values(providers).map((item) => ({
      ...item,
      options: {},
      models: mapValues(item.models, (model) => ({
        ...model,
        options: {},
        headers: {},
        ...(model.variants ? { variants: mapValues(model.variants, () => ({})) } : {}),
      })),
    })),
    default: Provider.defaultModelIDs(providers),
    connected,
  }
}

function enabledCatalog(input: ListInput) {
  const enabled = input.config.enabled_providers ? new Set(input.config.enabled_providers) : undefined
  return Object.fromEntries(Object.entries(input.catalog).filter(([key]) => (enabled ? enabled.has(key) : true)))
}

function connectedIDs(input: ListInput) {
  const disabled = new Set(input.config.disabled_providers ?? [])
  return [...new Set([...Object.keys(enabledCatalog(input)), ...Object.keys(input.connected)])].filter(
    (id) => !disabled.has(id) && (id in input.connected || input.credentials[id]),
  )
}

const encodeList = Schema.encodeSync(Provider.ListResult)

function serialize(list: Provider.ListResult): Serialized {
  const body = JSON.stringify(encodeList(list))
  return { body, etag: `"${Bun.hash(body).toString(36)}"` }
}

function respond(request: HttpServerRequest.HttpServerRequest, list: Serialized) {
  const headers = { etag: list.etag, "cache-control": "no-cache" }
  const match = (request.headers["if-none-match"] ?? "")
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .some((tag) => tag === list.etag || tag === "*")
  if (match) return HttpServerResponse.empty({ status: 304, headers })
  return HttpServerResponse.text(list.body, { contentType: "application/json", headers })
}

export const providerHandlers = HttpApiBuilder.group(InstanceHttpApi, "provider", (handlers) =>
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const provider = yield* Provider.Service
    const svc = yield* ProviderAuth.Service
    const authStore = yield* Auth.Service
    const events = yield* EventV2Bridge.Service

    const revision = Effect.fn("ProviderHttpApi.revision")(function* () {
      const config = yield* cfg.get()
      const catalog = yield* ModelsDev.Service.use((s) => s.get())
      const connected = yield* provider.list()
      const credentials = yield* authStore.all().pipe(Effect.orDie)
      return revisionFor({ config, catalog, connected, credentials })
    })

    const list = Effect.fn("ProviderHttpApi.list")(function* (ctx: { request: HttpServerRequest.HttpServerRequest }) {
      const current = yield* revision()
      current.full ??= serialize(fullList(current.input))
      return respond(ctx.request, current.full)
    })

    const connectedList = Effect.fn("ProviderHttpApi.connected")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const current = yield* revision()
      current.slim ??= serialize(slimList(current.input))
      return respond(ctx.request, current.slim)
    })

    const auth = Effect.fn("ProviderHttpApi.auth")(function* () {
      return yield* svc.methods()
    })

    const usage = Effect.fn("ProviderHttpApi.usage")(function* () {
      return yield* svc.usage()
    })

    const authorize = Effect.fn("ProviderHttpApi.authorize")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.AuthorizeInput
    }) {
      return yield* mapProviderAuthError(
        svc.authorize({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          inputs: ctx.payload.inputs,
        }),
      )
    })

    const authorizeRaw = Effect.fn("ProviderHttpApi.authorizeRaw")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProviderAuth.AuthorizeInput))(body).pipe(
        Effect.mapError(() => new ProviderAuthApiError({ name: "BadRequest", data: {} })),
      )
      // Match legacy route behavior: when authorize() resolves without a
      // result (e.g. no further redirect), serialize as JSON `null` instead
      // of an empty body so clients can `.json()` parse the response.
      const result = yield* authorize({ params: ctx.params, payload })
      return HttpServerResponse.jsonUnsafe(result ?? null)
    })

    const callback = Effect.fn("ProviderHttpApi.callback")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.CallbackInput
    }) {
      const existing = yield* authStore.get(ctx.params.providerID).pipe(Effect.orDie)
      yield* mapProviderAuthError(
        svc.callback({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          code: ctx.payload.code,
        }),
      )
      // A sign-in that adds a provider changes the connected set every client lists.
      if (!existing && (yield* authStore.get(ctx.params.providerID).pipe(Effect.orDie)))
        yield* events.publish(Integration.Event.ConnectionUpdated, {
          integrationID: Integration.ID.make(ctx.params.providerID),
        })
      return true
    })

    return handlers
      .handleRaw("list", list)
      .handleRaw("connected", connectedList)
      .handle("auth", auth)
      .handle("usage", usage)
      .handleRaw("authorize", authorizeRaw)
      .handle("callback", callback)
  }),
)
