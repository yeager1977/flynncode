import { dict } from "./en"

// Provider enable/disable translations are pending. Locale entries override this
// explicit English fallback as verified translations become available.
export const providerEnabledFallback = Object.fromEntries(
  Object.entries(dict).filter(([key]) => key.startsWith("settings.providers.enabled")),
)
