import { ShellBackground } from "@flynncode/schema/shell-background"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { SessionID } from "@/session/schema"
import { ApiNotFoundError, ConflictError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/session/:sessionID/shells"

export const OutputQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  offset: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
})

export const BackgroundShellsPaths = {
  list: root,
  output: `${root}/:id/output`,
  stop: `${root}/:id/stop`,
  promote: `${root}/promote`,
} as const

export const PromotePayload = Schema.Struct({
  callID: Schema.String.annotate({ description: "Call id of the running foreground bash tool call" }),
})

export const BackgroundShellsApi = HttpApi.make("background-shells")
  .add(
    HttpApiGroup.make("background-shells")
      .add(
        HttpApiEndpoint.get("list", BackgroundShellsPaths.list, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(ShellBackground.Info), "Background shells of the session"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.shells.list",
            summary: "List background shells",
            description: "List the background shells the agent started in this session, running and finished.",
          }),
        ),
        HttpApiEndpoint.get("output", BackgroundShellsPaths.output, {
          params: { sessionID: SessionID, id: Schema.String },
          query: OutputQuery,
          success: described(ShellBackground.Chunk, "Output from the requested offset"),
          error: ApiNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.shells.output",
            summary: "Read background shell output",
            description:
              "Read a background shell's output from a logical stream offset (default 0). Pass the returned offset to continue. Does not move the agent's own read position.",
          }),
        ),
        HttpApiEndpoint.post("stop", BackgroundShellsPaths.stop, {
          params: { sessionID: SessionID, id: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(ShellBackground.Info, "The shell after stopping"),
          error: ApiNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.shells.stop",
            summary: "Stop background shell",
            description:
              "Kill a background shell's process group (SIGTERM, then SIGKILL after 5 seconds) and return the shell. A shell that already finished is returned unchanged.",
          }),
        ),
        HttpApiEndpoint.post("promote", BackgroundShellsPaths.promote, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: PromotePayload,
          success: described(ShellBackground.Info, "The background shell the call became"),
          error: [ApiNotFoundError, ConflictError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.shells.promote",
            summary: "Move a running shell to the background",
            description:
              "Hand a running foreground bash tool call over to the session's background shells without stopping it. The call returns at once with the new shell id; output printed so far stays readable. 404 when no such call is running, 409 when the session is at its background shell limit.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "background-shells",
          description: "Background shells started by the agent in a session.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode background-shells HttpApi",
      version: "0.0.1",
      description: "Session background shell surface.",
    }),
  )
