export function buildDetachedReviewText(args: string) {
  const trimmed = args.trim()
  return trimmed.length > 0 ? `/review ${trimmed}` : "/review"
}

// Composer prefill handed to a session the app navigates to (detached
// review forks, worktree handoff); the session page consumes it once.
export function sessionPrefillKey(sessionID: string) {
  return `flynncode.review-prefill:${sessionID}`
}
