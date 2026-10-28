import { SessionStatusLine } from "@flynncode/schema/session-statusline"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { SessionID } from "@/session/schema"
import { ApiNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

export const SessionStatusLinePaths = {
  get: "/session/:sessionID/statusline",
} as const

export const SessionStatusLineApi = HttpApi.make("session-statusline")
  .add(
    HttpApiGroup.make("session-statusline")
      .add(
        HttpApiEndpoint.get("get", SessionStatusLinePaths.get, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(SessionStatusLine.Result, "The session's last status line output"),
          error: ApiNotFoundError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.statusline.get",
            summary: "Get the status line",
            description:
              "Return the last output of the configured status line command for this session, and start a run when it is stale or missing. Later output arrives as session.statusline events.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "session-statusline",
          description: "Output of the status line command, run per session.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode session-statusline HttpApi",
      version: "0.0.1",
      description: "Session status line surface.",
    }),
  )
