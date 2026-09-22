import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { EventV2 } from "@opencode-ai/core/event"
import { EventManifest } from "@/event-manifest"
import { InstanceDisposed } from "@/server/event"
import "@opencode-ai/core/account"
import "@/server/event"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import semver from "semver"
import { described } from "./metadata"

const GlobalHealth = Schema.Struct({
  healthy: Schema.Literal(true),
  version: Schema.String,
})

const SyncEventSchemas = EventManifest.Latest.values()
  .flatMap((definition) => {
    if (!definition.durable) return []
    return [
      Schema.Struct({
        type: Schema.Literal("sync"),
        id: EventV2.ID,
        syncEvent: Schema.Struct({
          type: Schema.Literal(EventV2.versionedType(definition.type, definition.durable.version)),
          id: EventV2.ID,
          seq: Schema.Finite,
          aggregateID: Schema.String,
          data: definition.data,
        }),
      }).annotate({ identifier: `SyncEvent.${definition.type}` }),
    ]
  })
  .toArray()

const GlobalEventSchema = Schema.Struct({
  directory: Schema.String,
  project: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  payload: Schema.Union([
    ...EventManifest.Latest.values()
      .map((definition) =>
        Schema.Struct({ id: EventV2.ID, type: Schema.Literal(definition.type), properties: definition.data }),
      )
      .toArray(),
    InstanceDisposed,
    ...SyncEventSchemas,
  ]),
}).annotate({ identifier: "GlobalEvent" })

export const GlobalUpgradeInput = Schema.Struct({
  target: Schema.String.check(
    Schema.makeFilter((value) => (semver.valid(value) === null ? "Expected a semantic version" : undefined)),
  ),
})

const GlobalUpgradeResult = Schema.Union([
  Schema.Struct({
    success: Schema.Literal(true),
    version: Schema.String,
  }),
  Schema.Struct({
    success: Schema.Literal(false),
    error: Schema.String,
  }),
])

export const OmoConfigInfo = Schema.Struct({
  path: Schema.NullOr(Schema.String),
  parseError: Schema.optional(Schema.String),
  agents: Schema.Record(Schema.String, Schema.Unknown),
  categories: Schema.Record(Schema.String, Schema.Unknown),
  disabledProviders: Schema.Array(Schema.String),
  openCodeDisabledProviders: Schema.Array(Schema.String),
}).annotate({ identifier: "OmoConfigInfo" })

export const OmoConfigPatch = Schema.Struct({
  agents: Schema.Record(Schema.String, Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  categories: Schema.Record(Schema.String, Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  disabledProviders: Schema.Array(Schema.String),
}).annotate({ identifier: "OmoConfigPatch" })

// Custom 400 with the failing path in the body so a client can point the
// user at the exact file that broke; the built-in `HttpApiError.BadRequest`
// is empty and cannot carry that context.
export class ApiOmoConfigWriteError extends Schema.ErrorClass<ApiOmoConfigWriteError>("OmoConfigWriteError")(
  {
    name: Schema.Literal("OmoConfigWriteError"),
    data: Schema.Struct({
      message: Schema.String,
      path: Schema.String,
    }),
  },
  { httpApiStatus: 400 },
) {}

export const GlobalPaths = {
  health: "/global/health",
  event: "/global/event",
  config: "/global/config",
  omoConfig: "/global/omo-config",
  dispose: "/global/dispose",
  upgrade: "/global/upgrade",
} as const

export const GlobalApi = HttpApi.make("global").add(
  HttpApiGroup.make("global")
    .add(
      HttpApiEndpoint.get("health", GlobalPaths.health, {
        success: described(GlobalHealth, "Health information"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.health",
          summary: "Get health",
          description: "Get health information about the OpenCode server.",
        }),
      ),
      HttpApiEndpoint.get("event", GlobalPaths.event, {
        success: GlobalEventSchema,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.event",
          summary: "Get global events",
          description: "Subscribe to global events from the OpenCode system using server-sent events.",
        }),
      ),
      HttpApiEndpoint.get("configGet", GlobalPaths.config, {
        success: described(ConfigV1.Info, "Get global config info"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.get",
          summary: "Get global configuration",
          description: "Retrieve the current global OpenCode configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.patch("configUpdate", GlobalPaths.config, {
        payload: ConfigV1.Info,
        success: described(ConfigV1.Info, "Successfully updated global config"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.update",
          summary: "Update global configuration",
          description: "Update global OpenCode configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.get("omoConfigGet", GlobalPaths.omoConfig, {
        success: described(OmoConfigInfo, "Get global Oh My OpenCode config info"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.omoConfig.get",
          summary: "Get global Oh My OpenCode configuration",
          description:
            "Retrieve the current global Oh My OpenCode plugin configuration along with OpenCode's disabled providers.",
        }),
      ),
      HttpApiEndpoint.put("omoConfigPut", GlobalPaths.omoConfig, {
        payload: OmoConfigPatch,
        success: described(OmoConfigInfo, "Successfully updated global Oh My OpenCode config"),
        error: ApiOmoConfigWriteError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.omoConfig.update",
          summary: "Update global Oh My OpenCode configuration",
          description:
            "Update global Oh My OpenCode plugin configuration and OpenCode disabled providers in one call.",
        }),
      ),
      HttpApiEndpoint.post("dispose", GlobalPaths.dispose, {
        success: described(Schema.Boolean, "Global disposed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.dispose",
          summary: "Dispose instance",
          description: "Clean up and dispose all OpenCode instances, releasing all resources.",
        }),
      ),
      HttpApiEndpoint.post("upgrade", GlobalPaths.upgrade, {
        payload: GlobalUpgradeInput,
        success: described(GlobalUpgradeResult, "Upgrade result"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.upgrade",
          summary: "Upgrade opencode",
          description: "Upgrade opencode to the specified version.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "global", description: "Global server routes." })),
)
