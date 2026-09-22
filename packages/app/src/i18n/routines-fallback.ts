import { dict } from "./en"

// Routines translations are pending. Locale entries override this Locale entries override this
// explicit English fallback as verified translations become available.
export const routinesFallback = Object.fromEntries(
  Object.entries(dict).filter(([key]) => key.startsWith("settings.routines.") || key === "settings.tab.routines"),
)
