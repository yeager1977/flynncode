import { dict } from "./en"

// Session handoff-move translations are pending. Locale entries override this
// English source.
export const sessionHandoffFallback = Object.fromEntries(
  Object.entries(dict).filter(([key]) => key.startsWith("session.handoff.")),
)