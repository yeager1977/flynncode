import { dict } from "./en"

// Import-sessions translations are pending. Locale entries override this
// explicit English fallback as verified translations become available.
export const importSessionsFallback = Object.fromEntries(
  Object.entries(dict).filter(
    ([key]) => key.startsWith("settings.import.") || key === "settings.tab.importSessions",
  ),
)