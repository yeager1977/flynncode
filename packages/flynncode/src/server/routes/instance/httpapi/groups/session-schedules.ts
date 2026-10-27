import { SessionSchedule } from "@flynncode/schema/session-schedule"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { SessionID } from "@/session/schema"
import { ApiNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/session/:sessionID/schedules"

export const SessionSchedulesPaths = {
  list: root,
  delete: `${root}/:jobID`,
} as const

export const SessionSchedulesApi = HttpApi.make("session-schedules")
  .add(
    HttpApiGroup.make("session-schedules")
      .add(
        HttpApiEndpoint.get("list", SessionSchedulesPaths.list, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(SessionSchedule.Info), "Scheduled prompts of the session"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.schedules.list",
            summary: "List scheduled prompts",
            description: "List the cron jobs and wakeups scheduled for this session, soonest first.",
          }),
        ),
        HttpApiEndpoint.delete("delete", SessionSchedulesPaths.delete, {
          params: { sessionID: SessionID, jobID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Whether the scheduled prompt was cancelled"),
          error: ApiNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.schedules.delete",
            summary: "Cancel a scheduled prompt",
            description: "Cancel a cron job or wakeup of this session. 404 when the session has no such job.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "session-schedules",
          description: "Prompts scheduled to run later in a session.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode session-schedules HttpApi",
      version: "0.0.1",
      description: "Session scheduled prompt surface.",
    }),
  )
