import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

const ReviewItem = Schema.Struct({
  path: Schema.String,
  project: Schema.String,
  repo: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  head: Schema.optional(Schema.String),
  detached: Schema.optional(Schema.Boolean),
  dirty: Schema.optional(Schema.Finite),
  unpushed: Schema.optional(Schema.Finite),
  ignored: Schema.optional(Schema.Finite),
  ignoredExample: Schema.optional(Schema.String),
  nested: Schema.optional(Schema.Array(Schema.String)),
  bytes: Schema.Finite,
  capped: Schema.Boolean,
  lastActivity: Schema.Finite,
  reason: Schema.Literals(["dirty", "unpushed", "scratch", "recent", "error"]),
  detail: Schema.optional(Schema.String),
}).annotate({ identifier: "WorktreeCleanupReviewItem" })

const CleanedItem = Schema.Struct({
  path: Schema.String,
  bytes: Schema.Finite,
  time: Schema.Finite,
  kind: Schema.Literals(["worktree", "junk", "scratch"]),
  rescued: Schema.optional(Schema.String),
}).annotate({ identifier: "WorktreeCleanupCleanedItem" })

const Report = Schema.Struct({
  items: Schema.Array(ReviewItem),
  cleaned: Schema.Array(CleanedItem),
  scanning: Schema.Boolean,
  lastScan: Schema.optional(Schema.Finite),
}).annotate({ identifier: "WorktreeCleanupReport" })

export const WorktreeCleanupRemoveInput = Schema.Struct({
  paths: Schema.Array(Schema.String),
})

const RemoveResult = Schema.Struct({
  path: Schema.String,
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
  rescued: Schema.optional(Schema.String),
}).annotate({ identifier: "WorktreeCleanupRemoveResult" })

const RemoveResponse = Schema.Struct({
  results: Schema.Array(RemoveResult),
}).annotate({ identifier: "WorktreeCleanupRemoveResponse" })

export const WorktreeCleanupPaths = {
  report: "/worktree/cleanup",
  scan: "/worktree/cleanup/scan",
  remove: "/worktree/cleanup/remove",
} as const

export const WorktreeCleanupApi = HttpApi.make("worktreeCleanup").add(
  HttpApiGroup.make("worktreeCleanup")
    .add(
      HttpApiEndpoint.get("report", WorktreeCleanupPaths.report, {
        success: described(Report, "Worktree cleanup report"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "worktreeCleanup.report",
          summary: "Get worktree cleanup report",
          description: "Get the worktrees and folders awaiting review, and what the janitor cleaned recently.",
        }),
      ),
      HttpApiEndpoint.post("scan", WorktreeCleanupPaths.scan, {
        success: described(Report, "Worktree cleanup report"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "worktreeCleanup.scan",
          summary: "Scan for stale worktrees",
          description: "Scan all known projects for stale worktrees now and return the updated report.",
        }),
      ),
      HttpApiEndpoint.post("remove", WorktreeCleanupPaths.remove, {
        payload: WorktreeCleanupRemoveInput,
        success: described(RemoveResponse, "Removal results"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "worktreeCleanup.remove",
          summary: "Remove worktrees",
          description: "Remove worktrees or folders from the cleanup review list.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "worktree-cleanup", description: "Worktree cleanup routes." })),
)
