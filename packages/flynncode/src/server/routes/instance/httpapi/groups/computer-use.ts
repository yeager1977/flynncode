import { ComputerUseExecutor } from "@/computer-use"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { described } from "./metadata"

const root = "/computer-use"

export const ComputerUseApi = HttpApi.make("computer-use")
  .add(
    HttpApiGroup.make("computer-use")
      .add(
        HttpApiEndpoint.get("requests", `${root}/requests`, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(ComputerUseExecutor.Request), "List of pending computer-use requests"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "computer-use.requests",
            summary: "List pending computer-use requests",
            description: "Get all pending computer-use executor requests across all sessions.",
          }),
        ),
        HttpApiEndpoint.post("reply", `${root}/execute/reply`, {
          query: WorkspaceRoutingQuery,
          payload: ComputerUseExecutor.Reply,
          success: described(Schema.Boolean, "Result recorded"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "computer-use.reply",
            summary: "Reply to a computer-use request",
            description: "Deliver the desktop executor's result for a pending computer-use request.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "computer-use",
          description: "Computer-use executor routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode HttpApi",
      version: "0.0.1",
      description: "Effect HttpApi surface for instance routes.",
    }),
  )