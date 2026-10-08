import { Effect, Layer } from "effect"
import type { Hooks } from "@opencode-ai/plugin"
import { HooksRunner } from "../../src/hooks/runner"

// In-memory plugin hooks for HooksRunner tests: runs the given hook objects
// with the same aggregation as Plugin.trigger/triggerDecision.
function stubPlugin(hooks: Array<Hooks>): HooksRunner.TriggerLike {
  return {
    trigger: ((name: string, input: unknown, output: Record<string, unknown>) => {
      return Effect.promise(async () => {
        for (const hook of hooks) {
          const fn = (hook as Record<string, unknown>)[name] as
            | ((input: unknown, output: Record<string, unknown>) => Promise<void>)
            | undefined
          if (!fn) continue
          await fn(input, output)
        }
        return output as never
      })
    }) as HooksRunner.TriggerLike["trigger"],
    triggerDecision: (input, output) => {
      // Same aggregation as Plugin.triggerDecision: isolated per-hook
      // outputs, deny wins with short-circuit, allows merge updatedInput.
      return Effect.promise(async () => {
        const mergedUpdated: Record<string, unknown> = {}
        let sawRewrite = false
        for (const hook of hooks) {
          const fn = hook["tool.permission"]
          if (!fn) continue
          const perHook: {
            decision: "allow" | "deny" | "undecided"
            message?: string
            updatedInput?: Record<string, unknown>
          } = {
            decision: "undecided",
          }
          await fn(input, perHook)
          if (perHook.decision === "deny") {
            output.decision = "deny"
            output.message = perHook.message
            return output
          }
          if (perHook.decision !== "allow") continue
          output.decision = "allow"
          if (perHook.updatedInput) {
            sawRewrite = true
            Object.assign(mergedUpdated, perHook.updatedInput)
          }
        }
        if (sawRewrite) output.updatedInput = mergedUpdated
        return output
      })
    },
  }
}

export function testLayerWithHooks(hooks: Array<Hooks>, executor?: HooksRunner.ExecutorLike) {
  return Layer.succeed(HooksRunner.Service, HooksRunner.createRunner(stubPlugin(hooks), executor))
}

function defaultTestHooks(): Array<Hooks> {
  return [
    {
      "tool.execute.before": async (_input, output) => {
        const args = output.args as Record<string, unknown>
        if (args["command"] === "ls") output.args = { command: "ls --safe" }
      },
      "tool.permission": async (input, output) => {
        const args = input.args as Record<string, unknown>
        const haystack = JSON.stringify(args)
        if (haystack.includes("rm -rf")) {
          output.decision = "deny"
          output.message = "Denied by hook"
          return
        }
        if (haystack.includes("echo hi")) {
          output.decision = "allow"
          return
        }
      },
      "session.start": async (_input, output) => {
        output.additionalContext = "workspace conventions"
      },
    } satisfies Hooks,
    {
      "tool.permission": async (input, output) => {
        const args = input.args as Record<string, unknown>
        if (JSON.stringify(args).includes("rm -rf")) {
          output.decision = "deny"
          output.message = "Denied by hook"
        }
      },
    } satisfies Hooks,
  ]
}

export const testLayer = testLayerWithHooks(defaultTestHooks())
