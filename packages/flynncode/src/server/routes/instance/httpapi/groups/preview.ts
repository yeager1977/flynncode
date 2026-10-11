import { Preview, VerifyResult } from "@/preview/preview"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

export class PreviewApiError extends Schema.ErrorClass<PreviewApiError>("PreviewError")(
  {
    name: Schema.Union([
      Schema.Literal("PreviewUnknownServerError"),
      Schema.Literal("PreviewStartFailedError"),
      Schema.Literal("PreviewNoRunningServerError"),
    ]),
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}

export const StartPayload = Schema.Struct({ name: Schema.String }).annotate({
  identifier: "PreviewStartPayload",
})
export const VerifyPayload = Schema.Struct({ name: Schema.optional(Schema.String) }).annotate({
  identifier: "PreviewVerifyPayload",
})

export const PreviewPaths = {
  servers: "/preview/servers",
  start: "/preview/servers/start",
  stop: "/preview/servers/stop",
  restart: "/preview/servers/restart",
  verify: "/preview/servers/verify",
} as const

export const PreviewApi = HttpApi.make("preview")
  .add(
    HttpApiGroup.make("preview")
      .add(
        HttpApiEndpoint.get("servers", PreviewPaths.servers, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Preview.Info), "Preview servers and their lifecycle state"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "preview.servers.list",
            summary: "List preview servers",
            description: "Get the configured preview servers, their state, and any running process metadata.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("serverStart", PreviewPaths.start, {
          query: WorkspaceRoutingQuery,
          payload: StartPayload,
          success: described(Preview.Info, "Started preview server"),
          error: PreviewApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "preview.servers.start",
            summary: "Start a preview server",
            description: "Start a configured managed preview server, or mark an attach-only server as active.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("serverStop", PreviewPaths.stop, {
          query: WorkspaceRoutingQuery,
          payload: StartPayload,
          success: described(Preview.Info, "Stopped preview server"),
          error: PreviewApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "preview.servers.stop",
            summary: "Stop a preview server",
            description: "Stop a running preview server and kill its process group.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("serverRestart", PreviewPaths.restart, {
          query: WorkspaceRoutingQuery,
          payload: StartPayload,
          success: described(Preview.Info, "Restarted preview server"),
          error: PreviewApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "preview.servers.restart",
            summary: "Restart a preview server",
            description: "Stop and start a configured preview server.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("serverVerify", PreviewPaths.verify, {
          query: WorkspaceRoutingQuery,
          payload: VerifyPayload,
          success: described(VerifyResult, "Verification of the running preview server"),
          error: PreviewApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "preview.servers.verify",
            summary: "Verify a preview server",
            description:
              "Fetch the running preview server URL and return the HTTP status, page title, and a heuristic console-error count.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "preview",
          description: "Preview-server lifecycle routes for the review browser.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode preview HttpApi",
      version: "0.0.1",
      description: "Preview server lifecycle surface.",
    }),
  )