import { dict } from "./en"

// Muse CLI import copy is pending translation. Locale entries override this
// English source.
export const museImportFallback = Object.fromEntries(
  Object.entries(dict).filter(([key]) => key.startsWith("provider.connect.museImport")),
)
