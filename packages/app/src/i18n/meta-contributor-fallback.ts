import { dict } from "./en"

// Meta contributor data-sharing translations are pending. Locale
// entries override this English source.
export const metaContributorFallback = Object.fromEntries(
  Object.entries(dict).filter(([key]) => key.startsWith("dialog.metaContributor.")),
)