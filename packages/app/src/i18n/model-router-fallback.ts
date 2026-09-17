import { dict } from "./en"

// Model-router translations are pending. Locale entries override this explicit
// English fallback as verified translations become available.
export const modelRouterFallback = Object.fromEntries(
  Object.entries(dict).filter(([key]) => key.startsWith("settings.modelRouter.")),
)
