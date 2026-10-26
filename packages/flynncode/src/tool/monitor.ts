import { Effect, Schema, Scope } from "effect"
import { Tool } from "./tool"
import DESCRIPTION from "./monitor.txt"
import { PositiveInt } from "@flynncode/core/schema"
import { BackgroundShells } from "@/shell/background/service"
import { ShellBackground } from "./shell/background"

export const Parameters = Schema.Struct({
  id: Schema.String.annotate({ description: "The background shell id to watch" }),
  pattern: Schema.String.annotate({ description: "Regular expression matched against each new output line" }),
  timeout: Schema.optional(PositiveInt).annotate({
    description: `How long to watch in milliseconds (default ${BackgroundShells.MONITOR_DEFAULT_MS}, maximum ${BackgroundShells.MONITOR_MAX_MS})`,
  }),
})

type Metadata = {
  shellId: string
  missing?: true
  pattern?: string
  timeoutMs?: number
}

export const MonitorTool = Tool.define<typeof Parameters, Metadata, BackgroundShells.Service | Scope.Scope>(
  "monitor",
  Effect.gen(function* () {
    const shells = yield* BackgroundShells.Service
    const scope = yield* Scope.Scope

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const shell = (yield* shells.list(ctx.sessionID)).find((item) => item.id === params.id)
          if (!shell) return ShellBackground.missing(params.id)
          const notify = yield* ShellBackground.notifier(ctx, scope)
          if (!notify) return yield* Effect.die(new Error("monitor requires promptOps in ctx.extra"))
          const timeoutMs = Math.min(
            params.timeout ?? BackgroundShells.MONITOR_DEFAULT_MS,
            BackgroundShells.MONITOR_MAX_MS,
          )
          yield* shells
            .monitor({ sessionID: ctx.sessionID, id: shell.id, pattern: params.pattern, timeoutMs, notify })
            .pipe(Effect.orDie)
          return {
            title: `monitor ${shell.id}`,
            metadata: { shellId: shell.id, pattern: params.pattern, timeoutMs },
            output: [
              `Monitoring background shell ${shell.id} for /${params.pattern}/ for up to ${timeoutMs} ms.`,
              "You will be notified once: when a new line matches, when the shell exits first, or when the time runs out. Do not poll or sleep while waiting.",
            ].join("\n"),
          }
        }),
    }
  }),
)
