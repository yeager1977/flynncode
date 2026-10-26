import { Effect, Schema } from "effect"
import { Tool } from "./tool"
import DESCRIPTION from "./bash-output.txt"
import { BackgroundShells } from "@/shell/background/service"
import { ShellBackground } from "./shell/background"

export const Parameters = Schema.Struct({
  id: Schema.String.annotate({ description: "The background shell id returned by bash with run_in_background" }),
  filter: Schema.optional(Schema.String).annotate({
    description:
      "Optional regular expression. Only new output lines that match are returned; lines that do not match are still consumed.",
  }),
})

type Metadata = {
  shellId: string
  missing?: true
  status?: BackgroundShells.Status
  exitCode?: number
}

export const BashOutputTool = Tool.define<typeof Parameters, Metadata, BackgroundShells.Service>(
  "bash_output",
  Effect.gen(function* () {
    const shells = yield* BackgroundShells.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const result = yield* shells
            .read({ sessionID: ctx.sessionID, id: params.id, filter: params.filter })
            .pipe(Effect.orDie)
          if (!result) return ShellBackground.missing(params.id)
          return {
            title: `${result.shell.id} ${result.shell.status}`,
            metadata: {
              shellId: result.shell.id,
              status: result.shell.status,
              exitCode: result.shell.exitCode,
            },
            output: [
              ShellBackground.status(result.shell),
              result.output || "(no new output)",
              ...(result.truncated
                ? [`[output exceeded the cap: ${result.shell.outputPath} keeps the first 1 MiB and the latest output]`]
                : []),
            ].join("\n"),
          }
        }),
    }
  }),
)
