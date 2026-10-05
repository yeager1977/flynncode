import { dict } from "./en"

// Preview server translations are pending. Locale entries override this
// explicit English fallback as verified translations become available.
export const previewFallback = Object.fromEntries(
  Object.entries(dict).filter(([key]) => key.startsWith("preview.") || key === "settings.tab.preview"),
)