import { dict } from "./en"

// Sidebar artifacts/history translations are pending. Locale entries override this
// explicit English fallback as verified translations become available.
export const artifactsSidebarFallback = Object.fromEntries(
  Object.entries(dict).filter(([key]) => key.startsWith("sidebar.") || key.startsWith("history.")),
)
