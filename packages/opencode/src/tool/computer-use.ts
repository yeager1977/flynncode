import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./computer-use.txt"
import { ComputerUse } from "@/config/computer-use"
import { Config } from "@/config/config"

export class ComputerUseDisabledError extends Schema.TaggedErrorClass<ComputerUseDisabledError>()(
  "ComputerUseDisabledError",
  { appID: Schema.String },
) {}

export class ComputerUseNotAllowedError extends Schema.TaggedErrorClass<ComputerUseNotAllowedError>()(
  "ComputerUseNotAllowedError",
  { appID: Schema.String },
) {}

export const Parameters = Schema.Struct({
  action: Schema.Literals(["screenshot", "click", "type", "keypress", "scroll"]).annotate({
    description: "Exactly one pane-scoped GUI action per call",
  }),
  appID: Schema.String.annotate({ description: "Allowlisted GUI app id owning the target pane" }),
  x: Schema.optional(Schema.Number).annotate({ description: "X point in CSS pixels relative to the pane" }),
  y: Schema.optional(Schema.Number).annotate({ description: "Y point in CSS pixels relative to the pane" }),
  text: Schema.optional(Schema.String).annotate({ description: "Text for the type action" }),
  key: Schema.optional(Schema.String).annotate({ description: "Key for the keypress action" }),
  deltaX: Schema.optional(Schema.Number).annotate({ description: "Horizontal scroll delta" }),
  deltaY: Schema.optional(Schema.Number).annotate({ description: "Vertical scroll delta" }),
})

type Metadata = {
  acknowledged: boolean
}

const definition = Tool.define<typeof Parameters, Metadata, Config.Service>(
  "computer_use",
  Effect.gen(function* () {
    const config = yield* Config.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (input: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          const policy = ComputerUse.resolveComputerUse(cfg.computer_use ?? {})
          if (policy.enabled === false) return yield* new ComputerUseDisabledError({ appID: input.appID })
          if (ComputerUse.isAppAllowed(input.appID, policy.allowedApps) === false)
            return yield* new ComputerUseNotAllowedError({ appID: input.appID })
          yield* ctx.ask({
            permission: "computer_use",
            patterns: [input.appID, input.action],
            always: [],
            metadata: {
              appID: input.appID,
              action: input.action,
            },
          })
          return {
            title: "Computer use action acknowledged",
            output: `Acknowledged ${input.action} for ${input.appID}. Pane-scoped execution happens client-side after approval.`,
            metadata: {
              acknowledged: true,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const ComputerUseTool = Object.assign(definition, { parameters: Parameters })

export * as ComputerUseToolModule from "./computer-use"
