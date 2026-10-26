import { Effect, Schema } from "effect"
import { Tool } from "./tool"
import DESCRIPTION from "./kill-shell.txt"
import { BackgroundShells } from "@/shell/background/service"
import { ShellBackground } from "./shell/background"

export const Parameters = Schema.Struct({
  id: Schema.String.annotate({ description: "The background shell id to stop" }),
})

type Metadata = {
  shellId: string
  missing?: true
  status?: BackgroundShells.Status
  exitCode?: number
}

export const KillShellTool = Tool.define<typeof Parameters, Metadata, BackgroundShells.Service>(
  "kill_shell",
  Effect.gen(function* () {
    const shells = yield* BackgroundShells.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const shell = yield* shells.kill({ sessionID: ctx.sessionID, id: params.id })
          if (!shell) return ShellBackground.missing(params.id)
          return {
            title: `${shell.id} ${shell.status}`,
            metadata: { shellId: shell.id, status: shell.status, exitCode: shell.exitCode },
            output:
              shell.status === "killed"
                ? `Killed background shell ${shell.id} (${shell.command}).`
                : `Background shell ${shell.id} had already finished: ${ShellBackground.status(shell)}`,
          }
        }),
    }
  }),
)
