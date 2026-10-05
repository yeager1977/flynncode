export type PrCloseState = "MERGED" | "CLOSED" | "OPEN" | "DRAFT" | string

export type AutoArchiveInput = {
  /** Latest PR state observed for the session's branch. */
  prState: string | undefined
  /** Whether the session currently has running work. */
  sessionRunning: boolean
  /** Whether the session is already archived. */
  sessionArchived: boolean
  /** Settings toggle, default OFF. */
  settingEnabled: boolean
}

export type AutoArchiveDecision = "archive" | "wait" | "none"

/**
 * Decide whether the session should be auto-archived after its PR merged or
 * closed. Pure so the strip's effect stays trivial: observe the PR state on
 * each refresh, archive once, never touch a running or archived session.
 */
export function autoArchiveAfterPrClose(input: AutoArchiveInput): AutoArchiveDecision {
  if (!input.settingEnabled) return "none"
  if (input.sessionArchived) return "none"
  if (input.sessionRunning) return "wait"
  if (input.prState !== "MERGED" && input.prState !== "CLOSED") return "wait"
  return "archive"
}