export * as StatusLineInput from "./input"

import { and, desc, eq, isNotNull, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@flynncode/core/database/database"
import { InstallationVersion } from "@flynncode/core/installation/version"
import { MessageTable, PartTable } from "@flynncode/core/session/sql"
import { ProviderV2 } from "@flynncode/core/provider"
import { InstanceState } from "@/effect/instance-state"
import { ClaudeTranscript } from "@/hooks/claude-transcript"
import { Provider } from "@/provider/provider"
import type { Session } from "@/session/session"

/** Claude Code reports `exceeds_200k_tokens` against this many context tokens. */
export const LARGE_CONTEXT = 200_000

/**
 * Claude Code's status line JSON for a session, plus Flynncode's `context`. Runs in the session's instance, which
 * owns the provider catalog and the project. Totals come from the same places the app's session summary and usage
 * meters read: the session's projected cost and line counts, and the newest assistant message that reported tokens.
 *
 * Where Flynncode has no exact equivalent of Claude's value:
 * - `total_duration_ms` is `duration`: wall time since this server process first served the session's status line.
 *   Claude counts from the start of its own process's session, so a restart resets both.
 * - `total_api_duration_ms` sums each finished assistant message's time minus the span its tools ran in. Text the
 *   model streams while tools run is not counted.
 * - `exceeds_200k_tokens` checks the input and cache tokens of the newest assistant message that reported tokens.
 */
export const build = Effect.fn("StatusLineInput.build")(function* (
  session: Session.Info,
  options: { duration: number },
) {
  const database = yield* Database.Service
  const providers = yield* Provider.Service
  const ctx = yield* InstanceState.context
  const field = <T>(key: string) => sql<T>`json_extract(${MessageTable.data}, ${`$.${key}`})`
  const role = (name: "user" | "assistant") => sql`${field("role")} = ${name}`
  const latest = desc(MessageTable.time_created)
  const prompt = yield* database.db
    .select({
      providerID: field<string>("model.providerID"),
      modelID: field<string>("model.modelID"),
      agent: field<string>("agent"),
    })
    .from(MessageTable)
    .where(and(eq(MessageTable.session_id, session.id), role("user")))
    .orderBy(latest, desc(MessageTable.id))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  const context = sql<number>`coalesce(${field("tokens.input")}, 0) + coalesce(${field("tokens.cache.read")}, 0) + coalesce(${field("tokens.cache.write")}, 0)`
  const tokens = sql<number>`${context} + coalesce(${field("tokens.output")}, 0) + coalesce(${field("tokens.reasoning")}, 0)`
  // The message still streaming has no tokens yet; the meters show the last one that has.
  const usage = yield* database.db
    .select({
      providerID: field<string>("providerID"),
      modelID: field<string>("modelID"),
      agent: field<string>("agent"),
      tokens,
      context,
    })
    .from(MessageTable)
    .where(and(eq(MessageTable.session_id, session.id), role("assistant"), sql`${tokens} > 0`))
    .orderBy(latest, desc(MessageTable.id))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  const part = (key: string) => sql`json_extract(${PartTable.data}, ${`$.${key}`})`
  // Parallel tools overlap, so a message's tool time is the span from the first start to the last end.
  const tools = sql`(select max(${part("state.time.end")}) - min(${part("state.time.start")}) from ${PartTable} where ${PartTable.message_id} = ${MessageTable.id} and ${part("type")} = 'tool' and ${part("state.time.end")} is not null)`
  const api = yield* database.db
    .select({
      total: sql<
        number | null
      >`sum(max(0, ${field("time.completed")} - ${field("time.created")} - coalesce(${tools}, 0)))`,
    })
    .from(MessageTable)
    .where(and(eq(MessageTable.session_id, session.id), role("assistant"), isNotNull(field("time.completed"))))
    .get()
    .pipe(Effect.orDie)
  // The model the next turn uses: the session's pick, else the latest prompt's, else the latest answer's.
  const model = session.model
    ? { providerID: session.model.providerID, id: session.model.id }
    : prompt
      ? { providerID: prompt.providerID, id: prompt.modelID }
      : usage
        ? { providerID: usage.providerID, id: usage.modelID }
        : undefined
  const catalog = model ? (yield* providers.list())[ProviderV2.ID.make(model.providerID)]?.models[model.id] : undefined
  const used = usage?.tokens ?? 0
  return {
    hook_event_name: "Status",
    session_id: session.id,
    transcript_path: yield* ClaudeTranscript.sync({ sessionID: session.id }),
    cwd: session.directory,
    version: InstallationVersion,
    model: { id: model?.id ?? "", display_name: catalog?.name ?? model?.id ?? "" },
    workspace: { current_dir: session.directory, project_dir: ctx.worktree === "/" ? ctx.directory : ctx.worktree },
    output_style: { name: session.agent ?? prompt?.agent ?? usage?.agent ?? "default" },
    cost: {
      total_cost_usd: session.cost ?? 0,
      total_duration_ms: Math.max(0, options.duration),
      total_api_duration_ms: api?.total ?? 0,
      total_lines_added: session.summary?.additions ?? 0,
      total_lines_removed: session.summary?.deletions ?? 0,
    },
    exceeds_200k_tokens: (usage?.context ?? 0) > LARGE_CONTEXT,
    context: { used_tokens: used, limit: catalog?.limit.context ?? null },
  }
})
