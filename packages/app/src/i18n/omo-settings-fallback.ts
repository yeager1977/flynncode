import { dict } from "./en"

// Oh My OpenCode translations are pending. Locale entries override this
// explicit English fallback as verified translations become available.
export const omoSettingsFallback = Object.fromEntries(
  Object.entries(dict).filter(([key]) => key.startsWith("settings.omo.") || key.startsWith("settings.providers.enabled")),
)
