import { dict } from "./en"

// Worktree settings translations are pending. Locale entries override this
// explicit English fallback as verified translations become available.
export const worktreeFallback = Object.fromEntries(
  Object.entries(dict).filter(
    ([key]) =>
      key.startsWith("settings.worktree.") ||
      key === "settings.tab.worktree" ||
      key.startsWith("session.worktree.") ||
      key.startsWith("session.subagents.") ||
      key.startsWith("toast.worktree."),
  ),
)