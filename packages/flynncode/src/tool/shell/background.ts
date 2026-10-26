import { Cause, Effect, Scope } from "effect"
import { Tool } from "../tool"
import type { TaskPromptOps } from "../task"
import type { BackgroundShells } from "@/shell/background/service"

// Builds the `notify` handed to BackgroundShells: each notification is a queued synthetic prompt in the calling
// session. The service delivers it from its own fibers, so the prompt runs with the context captured at the tool
// call (the session's instance) and is forked into the tool layer's scope so the service never waits for the turn
// it starts. Undefined when the caller has no promptOps (nothing to notify).
export const notifier = Effect.fnUntraced(function* (ctx: Tool.Context, scope: Scope.Scope) {
  const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
  if (!ops) return undefined
  const context = yield* Effect.context()
  const user = ctx.messages.findLast((message) => message.info.role === "user")?.info
  // Without a variant the queued prompt would reset the session to the agent's default variant.
  const variant = user?.role === "user" ? user.model.variant : undefined
  return (text: string) =>
    ops
      .prompt({
        sessionID: ctx.sessionID,
        variant,
        delivery: "queue",
        parts: [{ type: "text", synthetic: true, text }],
      })
      .pipe(
        Effect.provide(context),
        Effect.catchCause(warn("background shell notification prompt failed")),
        Effect.forkIn(scope, { startImmediately: true }),
        Effect.asVoid,
        Effect.catchCause(warn("background shell notification not delivered")),
      )
})

// Unknown ids are an answer, not a failure: the shell may belong to another session or have been dropped.
export function missing(id: string) {
  return {
    title: `no shell ${id}`,
    metadata: { shellId: id, missing: true as const },
    output: `No such background shell ${id} in this session.`,
  }
}

export function status(shell: BackgroundShells.Shell) {
  return `[background shell ${shell.id} ${detail(shell)}] ${shell.command}`
}

function detail(shell: BackgroundShells.Shell) {
  if (shell.status === "running") return `running (pid ${shell.pid})`
  if (shell.status === "exited") return `exited (code ${shell.exitCode ?? "unknown"})`
  if (shell.status === "timed_out") return "timed_out (time cap reached; the process group was killed)"
  return "killed"
}

function warn(message: string) {
  return (cause: Cause.Cause<unknown>) =>
    Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning(message, { cause: Cause.pretty(cause) })
}

export * as ShellBackground from "./background"
