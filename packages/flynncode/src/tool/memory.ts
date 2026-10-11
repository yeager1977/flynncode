import DESCRIPTION from "./memory.txt"
import { Memory } from "@/memory/memory"
import { Effect, Schema } from "effect"
import { Tool } from "./tool"

// All action branches share one metadata shape so the union of return objects
// type-checks as a single ExecuteResult.
type Result = {
  title: string
  metadata: { scope?: string; slug?: string; count?: number; removed?: boolean }
  output: string
}

export const Parameters = Schema.Struct({
  action: Schema.Literals(["save", "remove", "list"]).annotate({
    description: "save: store a durable convention under a slug. remove: delete a saved memory. list: show saved memories.",
  }),
  scope: Schema.optional(Schema.Literals(["global", "project"])).annotate({
    description: "Memory scope. global lives outside the repo; project lives in .opencode/memories/. Required for save and remove.",
  }),
  slug: Schema.optional(Schema.String).annotate({
    description: "Short kebab-case topic key, e.g. \"test-runner\". Required for save and remove.",
  }),
  text: Schema.optional(Schema.String).annotate({
    description: "Memory body. Required for save (non-empty). Secrets are redacted automatically.",
  }),
})

export type Parameters = Schema.Schema.Type<typeof Parameters>

export const MemoryTool = Tool.define(
  "memory",
  Effect.gen(function* () {
    const memory = yield* Memory.Service

    const run = Effect.fn("MemoryTool.execute")(function* (params: Parameters, ctx: Tool.Context) {
      if (params.action === "list") {
        const found = yield* memory.listDetailed()
        return {
          title: "Memories",
          metadata: { count: found.length },
          output:
            found.length === 0
              ? "No memories saved."
              : found.map((item) => `- [${item.scope}] ${item.filepath}`).join("\n"),
        }
      }

      const scope = params.scope
      if (!scope) return yield* Effect.fail(new Error(`action "${params.action}" requires scope`))
      const slug = params.slug?.trim()
      if (!slug) return yield* Effect.fail(new Error(`action "${params.action}" requires a non-empty slug`))
      const filepath = yield* memory.target({ scope, slug })

      if (params.action === "remove") {
        // Writes always reach the permission check; an "always" reply approves
        // the whole scope session-wide via the reply mechanics.
        yield* ctx.ask({
          permission: "memory",
          patterns: [scope],
          always: [scope],
          metadata: { action: "remove", scope, slug, filepath },
        })
        const removed = yield* memory.remove({ scope, slug })
        return {
          title: removed ? "Removed" : "Not found",
          metadata: { scope, slug, removed },
          output: removed
            ? `Removed ${scope} memory "${slug}".`
            : `No memory named "${slug}" in ${scope} scope.`,
        }
      }

      const text = params.text?.trim()
      if (!text) return yield* Effect.fail(new Error('action "save" requires non-empty text'))
      yield* ctx.ask({
        permission: "memory",
        patterns: [scope],
        always: [scope],
        metadata: { action: "save", scope, slug, filepath },
      })
      const saved = yield* memory.update({ scope, slug, text })
      if (!saved) return yield* Effect.fail(new Error("Memory is disabled in config; nothing was saved"))
      return {
        title: "Saved",
        metadata: { scope, slug },
        output: `Saved ${scope} memory "${slug}" to ${saved} (secrets are redacted automatically).`,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Parameters, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie) as Effect.Effect<Result>,
    }
  }),
)
