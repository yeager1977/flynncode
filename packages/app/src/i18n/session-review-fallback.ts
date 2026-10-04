import { dict } from "./en"

// V2 review-actions and dispatch status translations are pending. Locale
// entries override this English source.
export const sessionReviewFallback = Object.fromEntries(
  Object.entries(dict).filter(
    ([key]) =>
      key === "common.reconnect" ||
      key === "common.previewUnavailable" ||
      key === "dispatch.needsInput" ||
      key === "dispatch.blocked" ||
      key === "session.review.annotate.add" ||
      key === "session.review.revertHunk" ||
      key === "session.review.stageHunk" ||
      key === "session.review.unstageHunk" ||
      key === "session.review.markPreview" ||
      key === "session.todo.status.pending" ||
      key === "session.todo.status.in_progress" ||
      key === "session.todo.status.completed" ||
      key === "session.todo.status.cancelled" ||
      key === "session.tasks.resize",
  ),
)