export function buildDetachedReviewText(args: string) {
  const trimmed = args.trim()
  return trimmed.length > 0 ? `/review ${trimmed}` : "/review"
}

export function reviewDetachedPrefillKey(sessionID: string) {
  return `flynncode.review-prefill:${sessionID}`
}
