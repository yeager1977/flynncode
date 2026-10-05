import { dict } from "./en"

// V2 review-actions and dispatch status translations are pending. Locale
// entries override this English source.
export const sessionReviewFallback = Object.fromEntries(
  Object.entries(dict).filter(
    ([key]) =>
      key === "common.reconnect" ||
      key === "common.previewUnavailable" ||
      key === "settings.modelRouter.family.unavailable" ||
      key === "dispatch.needsInput" ||
      key === "dispatch.blocked" ||
      key === "session.review.annotate.add" ||
      key === "session.review.revertHunk" ||
      key === "session.review.stageHunk" ||
      key === "session.review.unstageHunk" ||
      key === "session.review.markPreview" ||
      key === "session.review.recheckPage" ||
      key === "session.todo.status.pending" ||
      key === "session.todo.status.in_progress" ||
      key === "session.todo.status.completed" ||
      key === "session.todo.status.cancelled" ||
      key === "session.tasks.resize" ||
      key.startsWith("session.project."),
  ),
)

// Pending translation. Locale entries override this English source. Plural
// families beyond `.one`/`.other` need locale-specific categories.
export const sessionProjectPluralFallback = {
  es: {
    "session.project.sessions.many": "{{count}} sessions",
  },
  fr: {
    "session.project.sessions.many": "{{count}} sessions",
  },
  pl: {
    "session.project.sessions.few": "{{count}} sessions",
    "session.project.sessions.many": "{{count}} sessions",
  },
  ru: {
    "session.project.sessions.few": "{{count}} sessions",
    "session.project.sessions.many": "{{count}} sessions",
  },
  uk: {
    "session.project.sessions.few": "{{count}} sessions",
    "session.project.sessions.many": "{{count}} sessions",
  },
  bs: {
    "session.project.sessions.few": "{{count}} sessions",
  },
  ar: {
    "session.project.sessions.zero": "{{count}} sessions",
    "session.project.sessions.two": "{{count}} sessions",
    "session.project.sessions.few": "{{count}} sessions",
    "session.project.sessions.many": "{{count}} sessions",
  },
  br: {
    "session.project.sessions.many": "{{count}} sessions",
  },
  it: {
    "session.project.sessions.many": "{{count}} sessions",
  },
  ca: {
    "session.project.sessions.many": "{{count}} sessions",
  },
  cs: {
    "session.project.sessions.few": "{{count}} sessions",
    "session.project.sessions.many": "{{count}} sessions",
  },
  hr: {
    "session.project.sessions.few": "{{count}} sessions",
  },
  lt: {
    "session.project.sessions.few": "{{count}} sessions",
    "session.project.sessions.many": "{{count}} sessions",
  },
  lv: {
    "session.project.sessions.zero": "{{count}} sessions",
  },
  ro: {
    "session.project.sessions.few": "{{count}} sessions",
  },
  sk: {
    "session.project.sessions.few": "{{count}} sessions",
    "session.project.sessions.many": "{{count}} sessions",
  },
  sl: {
    "session.project.sessions.two": "{{count}} sessions",
    "session.project.sessions.few": "{{count}} sessions",
  },
  sr: {
    "session.project.sessions.few": "{{count}} sessions",
  },
} as const