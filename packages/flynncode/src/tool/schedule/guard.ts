import { Effect } from "effect"
import type { SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { Tool } from "../tool"

export const NOT_ROOT = "scheduling is only available in the main session, not in sub-agents"

// Scheduled prompts wake their session, and a finished sub-agent must never be woken, so only a root session may
// schedule. An unknown session is a defect: its jobs would be pruned at once.
export const requireRoot = Effect.fnUntraced(function* (
  sessions: Session.Interface,
  ctx: Tool.Context,
  sessionID: SessionID,
) {
  const info = yield* sessions.get(sessionID).pipe(Effect.orDie)
  if (info.parentID !== undefined) return yield* Effect.fail(new Error(NOT_ROOT))
  yield* ctx.ask({ permission: "schedule", patterns: ["*"], always: ["*"], metadata: {} })
  return info
})

export function when(time: number) {
  const date = new Date(time)
  const local = date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "long" })
  return `${date.toISOString()} (${local})`
}
