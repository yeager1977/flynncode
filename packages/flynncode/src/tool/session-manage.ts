import DESCRIPTION from "./session-manage.txt"
import { Session } from "@/session/session"
import { Effect, Schema } from "effect"
import { SessionID } from "../session/schema"
import * as Tool from "./tool"

const LIST_LIMIT = 20

// All action branches share one metadata shape so the union of return objects
// type-checks as a single ExecuteResult.
type Result = {
  title: string
  metadata: { sessionID?: string; title?: string; count?: number }
  output: string
}

export const Parameters = Schema.Struct({
  action: Schema.Literals(["list", "read", "rename", "archive"]).annotate({
    description: "list: other sessions. read: recent turns of one session. rename: set a title. archive: hide a session.",
  }),
  session_id: Schema.optional(Schema.String).annotate({
    description: "Target session ID. Required for read, rename, and archive.",
  }),
  title: Schema.optional(Schema.String).annotate({
    description: "New title for the session. Required for rename (non-empty).",
  }),
})

export type Parameters = Schema.Schema.Type<typeof Parameters>

// Recent-turn digest for `read`: the last few user prompts and assistant
// replies, trimmed so the model sees thread shape without full transcripts.
const readSummary = (turns: { role: string; text: string }[], more: boolean) =>
  [
    ...(turns.length === 0 ? ["(no recent text messages)"] : []),
    ...(more ? ["(older messages omitted)"] : []),
    ...turns.map((item) => `[${item.role}] ${item.text}`),
  ].join("\n")

const truncateText = (value: string, max: number) => {
  const collapsed = value.replace(/\s+/g, " ").trim()
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed
}

export const SessionManageTool = Tool.define(
  "session_manage",
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    const run = Effect.fn("SessionManageTool.execute")(function* (params: Parameters, ctx: Tool.Context) {
      if (params.action === "list") {
        const all = yield* sessions.list({ limit: LIST_LIMIT + 1, roots: true })
        const visible = all
          .filter((item) => item.id !== ctx.sessionID && item.time.archived === undefined)
          .slice(0, LIST_LIMIT)
        return {
          title: "Sessions",
          metadata: { count: visible.length },
          output:
            visible.length === 0
              ? "No other active sessions."
              : visible
                  .map(
                    (item) =>
                      `- session_id: ${item.id}\n  title: ${item.title}\n  directory: ${item.directory}\n  updated: ${new Date(item.time.updated).toISOString()}`,
                  )
                  .join("\n"),
        }
      }

      const sessionID = params.session_id ? SessionID.make(params.session_id) : undefined
      if (!sessionID) return yield* Effect.fail(new Error(`action "${params.action}" requires session_id`))

      const target = yield* sessions
        .get(sessionID)
        .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (!target) return yield* Effect.fail(new Error(`Unknown session: ${params.session_id}`))

      if (params.action === "read") {
        const page = yield* sessions.messages({ sessionID, limit: 8 })
        const digest = page
          .filter((item) => item.info.role === "user" || item.info.role === "assistant")
          .map((item) => ({
            role: item.info.role,
            text: item.parts
              .filter((part) => part.type === "text")
              .map((part) => (part.type === "text" ? part.text : ""))
              .join(" "),
          }))
          .filter((item) => item.text.trim().length > 0)
          .map((item) => ({ role: item.role === "assistant" ? "assistant" : "user", text: truncateText(item.text, 400) }))
        return {
          title: target.title,
          metadata: { sessionID },
          output: readSummary(digest.slice(-6), digest.length > 6),
        }
      }

      if (params.action === "rename") {
        const title = params.title?.trim()
        if (!title) return yield* Effect.fail(new Error('action "rename" requires a non-empty title'))
        yield* sessions.setTitle({ sessionID, title })
        return {
          title: "Renamed",
          metadata: { sessionID, title },
          output: `Renamed session ${sessionID} to "${title}".`,
        }
      }

      // Archive always asks, in every permission mode: the request defaults to
      // "ask" unless the user has explicitly allowed it, matching the safety
      // model for hiding other people's sessions.
      yield* ctx.ask({
        permission: "archive",
        patterns: [sessionID],
        always: [sessionID],
        metadata: { sessionID, title: target.title },
      })
      if (target.time.archived !== undefined) {
        return {
          title: "Archive",
          metadata: { sessionID },
          output: `Session ${sessionID} is already archived.`,
        }
      }
      yield* sessions.setArchived({ sessionID, time: Date.now() })
      return {
        title: "Archived",
        metadata: { sessionID },
        output: `Archived session ${sessionID} (${target.title}).`,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Parameters, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie) as Effect.Effect<Result>,
    }
  }),
)