import { dict } from "./en"

// Side-chat and view-mode translations are pending. Locale entries override
// this English fallback as verified translations become available.
export const sideChatFallback = Object.fromEntries(
  Object.entries(dict).filter(
    ([key]) => key.startsWith("session.sidechat.") || key.startsWith("session.viewMode.") || key === "command.session.btw" || key === "command.session.btw.description",
  ),
)