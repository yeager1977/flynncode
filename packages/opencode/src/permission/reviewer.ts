import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { evaluate } from "./evaluate"

// Auto-approve allow-list starts read-only per controller ruling: no
// expansion (no webfetch/websearch/lsp) without later telemetry.
const AUTO_ALLOW = ["read", "glob", "grep", "list"]

export function review(input: {
  permission: string
  patterns: readonly string[]
  ruleset: PermissionV1.Ruleset
  // The triggering tool call, so a richer static rule (and the LLM
  // auto-reviewer) can see the full request. Unused by the AUTO_ALLOW
  // allow-list itself.
  tool?: string
  args?: Record<string, unknown>
}): "allow" | "defer" {
  if (!AUTO_ALLOW.includes(input.permission)) return "defer"
  // Defer to the permission service whenever the merged ruleset has an
  // opinion: a deny must still deny, and a specific (non-`*`) "ask" rule such
  // as the default `read: { "*.env": "ask" }` is a deliberate prompt the
  // reviewer must not override. Only the catch-all ask is auto-approved.
  const opinionated = input.patterns.some((pattern) => {
    const rule = evaluate(input.permission, pattern, input.ruleset)
    return rule.action === "deny" || (rule.action === "ask" && rule.pattern !== "*")
  })
  return opinionated ? "defer" : "allow"
}

export * as Reviewer from "./reviewer"
