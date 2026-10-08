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

// No client executor runs pane-scoped GUI actions yet, so the tool must fail
// rather than report an action that never happened.
export class ComputerUseUnavailableError extends Schema.TaggedErrorClass<ComputerUseUnavailableError>()(
  "ComputerUseUnavailableError",
  { appID: Schema.String, action: Schema.String },
) {
  override get message() {
    return `Computer use is not available in this build: the ${this.action} action for ${this.appID} was not performed. Do not assume it happened; tell the user and continue another way.`
  }
}

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

type Metadata = Record<string, never>

const definition = Tool.define<typeof Parameters, Metadata, Config.Service>(
  "computer_use",
  Effect.gen(function* () {
    const config = yield* Config.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (input: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          const policy = ComputerUse.resolveComputerUse(cfg.computer_use ?? {})
          if (policy.enabled === false) return yield* new ComputerUseDisabledError({ appID: input.appID })
          if (ComputerUse.isAppAllowed(input.appID, policy.allowedApps) === false)
            return yield* new ComputerUseNotAllowedError({ appID: input.appID })
          // Asking for approval first would have the user consent to an action
          // that cannot run, so fail before the permission prompt.
          return yield* new ComputerUseUnavailableError({ appID: input.appID, action: input.action })
        }).pipe(Effect.orDie),
    }
  }),
)

export const ComputerUseTool = Object.assign(definition, { parameters: Parameters })

export * as ComputerUseToolModule from "./computer-use"
