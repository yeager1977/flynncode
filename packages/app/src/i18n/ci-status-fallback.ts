import { dict } from "./en"

// CI strip translations are pending. Locale entries override this explicit
// English fallback as verified translations become available.
export const ciStatusFallback = Object.fromEntries(
  Object.entries(dict).filter(([key]) => key.startsWith("session.ci.")),
)