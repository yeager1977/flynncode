import { dict } from "./en"

// Provider-edit translations are pending. Locale entries override this explicit
// English fallback as verified translations become available.
export const providerEditFallback = Object.fromEntries(
  Object.entries(dict).filter(([key]) => key.startsWith("provider.edit.")),
)