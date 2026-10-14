import type { AssistantMessage, Message } from "@flynncode/sdk/v2"
import { usageLimit } from "@flynncode/core/session/usage-limit"
import { DateTime } from "luxon"

// True when a session's newest assistant turn ended on a provider usage limit.
// Sessions stop (go idle) on a limit, so callers pair this with an idle status.
export function endedOnUsageLimit(messages: readonly Message[] | undefined) {
  const last = messages?.findLast((message): message is AssistantMessage => message.role === "assistant")
  return usageLimit(last?.error) !== undefined
}

// A reset later today shows only the time; any other day also shows the date.
export function usageLimitResetTime(resetAt: number, locale: string, now = Date.now()) {
  const reset = DateTime.fromMillis(resetAt).setLocale(locale)
  if (reset.hasSame(DateTime.fromMillis(now), "day")) return reset.toLocaleString(DateTime.TIME_SIMPLE)
  return reset.toLocaleString(DateTime.DATETIME_MED)
}
