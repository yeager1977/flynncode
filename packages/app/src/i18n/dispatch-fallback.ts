import { dict } from "./en"

// Dispatch panel translations are pending. Locale entries override this Locale entries override this
// explicit English fallback as verified translations become available.
export const dispatchFallback = Object.fromEntries(
  Object.entries(dict).filter(([key]) => key.startsWith("dispatch.")),
)
