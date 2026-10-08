import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Agent } from "./agent"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent session's deny rules and external_directory rules.
 *    Parent agent restrictions only govern that agent; the subagent's own
 *    permissions determine its capabilities.
 * 2. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  return [
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}

/**
 * Resolve an agent `sandbox` profile to concrete `external_directory` rules
 * scoped to the isolated worktree directory. The ruleset evaluates last
 * match wins, so appending these confines the child even where inherited
 * rules allow more.
 *
 * Only `restricted` confines: deny file access outside the worktree, then
 * re-allow the worktree itself. Unknown profiles degrade to no extra rules
 * instead of failing, matching tolerant config behavior elsewhere.
 */
export function sandboxRules(input: { sandbox: string; directory: string }): PermissionV1.Ruleset {
  if (input.sandbox !== "restricted") return []
  return [
    { permission: "external_directory" as const, pattern: "*" as const, action: "deny" as const },
    { permission: "external_directory" as const, pattern: `${input.directory}/*`, action: "allow" as const },
  ]
}
