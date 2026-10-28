import { SessionRetention } from "@flynncode/schema/session-retention"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { ApiNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const SessionRetentionPaths = {
  get: "/session/retention",
  keep: "/session/:sessionID/keep",
} as const

export const KeepPayload = Schema.Struct({ keep: Schema.Boolean })

export const SessionRetentionApi = HttpApi.make("session-retention")
  .add(
    HttpApiGroup.make("session-retention")
      .add(
        HttpApiEndpoint.get("get", SessionRetentionPaths.get, {
          query: WorkspaceRoutingQuery,
          success: described(SessionRetention.Info, "The retention period and the sessions due for deletion"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.retention.get",
            summary: "Get session retention",
            description:
              "Return cleanupPeriodDays, the root sessions whose trees are deleted within 3 days, and a delayed first run. Changes arrive as session.retention.updated events.",
          }),
        ),
        HttpApiEndpoint.patch("keep", SessionRetentionPaths.keep, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: KeepPayload,
          success: described(Session.Info, "The updated session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.keep",
            summary: "Keep a session",
            description:
              "Set or clear `keep` in a root session's metadata, keeping the rest of it. A kept session and its sub-agent sessions are never deleted for inactivity. 400 for a sub-agent session.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "session-retention",
          description: "Automatic deletion of inactive session trees.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode session-retention HttpApi",
      version: "0.0.1",
      description: "Session retention surface.",
    }),
  )
