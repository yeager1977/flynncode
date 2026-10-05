import { Gh } from "@/git/gh"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

export class PullRequestApiError extends Schema.ErrorClass<PullRequestApiError>("PullRequestError")(
  {
    name: Schema.Union([
      Schema.Literal("GhMissingError"),
      Schema.Literal("GhAuthError"),
      Schema.Literal("GhNoPrError"),
      Schema.Literal("GhCommandError"),
    ]),
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}

export const PullRequestPaths = {
  status: "/pull-request/status",
  merge: "/pull-request/merge",
} as const

export const PullRequestApi = HttpApi.make("pull-request")
  .add(
    HttpApiGroup.make("pull-request")
      .add(
        HttpApiEndpoint.get("status", PullRequestPaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(Gh.PrStatus, "PR and CI-check snapshot for the current branch"),
          error: PullRequestApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "pull-request.status",
            summary: "Get pull request status",
            description:
              "Detect the pull request for the current branch of the routed directory and return its state, URL, and CI-check rollup. Fails with a typed error when gh is missing or unauthenticated, or the branch has no PR.",
          }),
        ),
      )
      .add(
        HttpApiEndpoint.post("merge", PullRequestPaths.merge, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Auto-merge scheduled"),
          error: PullRequestApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "pull-request.merge",
            summary: "Schedule auto-merge",
            description:
              "Run `gh pr merge --squash --auto` for the routed directory's current branch. Requires the repository's auto-merge setting to be enabled on GitHub.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "pull-request",
          description: "PR/CI monitoring via the gh CLI for the session workspace.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode pull-request HttpApi",
      version: "0.0.1",
      description: "Pull request status and auto-merge surface.",
    }),
  )