// Auto-approve allow-list starts read-only per controller ruling: no
// expansion (no webfetch/websearch/lsp) without later telemetry.
const AUTO_ALLOW = ["read", "glob", "grep", "list"]

export function review(input: { permission: string; patterns: readonly string[] }): "allow" | "defer" {
  if (AUTO_ALLOW.includes(input.permission)) return "allow"
  return "defer"
}

export * as Reviewer from "./reviewer"
