import { dict } from "./en"

// Subagent rename/archive and task-chip translations are pending. Locale
// entries override this English source.
export const sessionManageFallback = Object.fromEntries(
  Object.entries(dict).filter(
    ([key]) =>
      key.startsWith("session.subagents.archive") ||
      key.startsWith("session.subagents.archiving") ||
      key === "session.subagents.taskChip.open",
  ),
)