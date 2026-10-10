// Mirrors packages/opencode/src/command/review-preset.ts (server twin) —
// kept in the app because app runtime must not import from packages/opencode.
export type ReviewPreset = "uncommitted" | "base-branch" | "commit"

export function presetArgs(preset: ReviewPreset, target?: string) {
  const trimmed = target?.trim() ?? ""
  if (preset === "base-branch" || preset === "commit") return trimmed
  return ""
}

export function buildDetachedReviewText(args: string) {
  const trimmed = args.trim()
  return trimmed.length > 0 ? `/review ${trimmed}` : "/review"
}

// Composer prefill handed to a session the app navigates to (detached
// review forks, worktree handoff); the session page consumes it once.
export function sessionPrefillKey(sessionID: string) {
  return `flynncode.review-prefill:${sessionID}`
}
