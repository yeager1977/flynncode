import { Effect, Option, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./computer-use.txt"
import { ComputerUse } from "@/config/computer-use"
import { Config } from "@/config/config"
import { ComputerUseExecutor } from "@/computer-use"

export class ComputerUseDisabledError extends Schema.TaggedErrorClass<ComputerUseDisabledError>()(
  "ComputerUseDisabledError",
  { appID: Schema.String },
) {}

export class ComputerUseNotAllowedError extends Schema.TaggedErrorClass<ComputerUseNotAllowedError>()(
  "ComputerUseNotAllowedError",
  { appID: Schema.String },
) {}

// The tier covering this action is disabled in config; like the other
// fail-closed gates this happens before the permission ask, so the user is
// never prompted for an action that cannot run.
export class ComputerUseTierDisabledError extends Schema.TaggedErrorClass<ComputerUseTierDisabledError>()(
  "ComputerUseTierDisabledError",
  { appID: Schema.String, action: Schema.String, tier: Schema.String },
) {
  override get message() {
    return `Computer use is enabled for ${this.appID}, but the ${this.tier} tier is disabled in config, so the ${this.action} action was not performed. Enable the ${this.tier} tier (computer_use.tiers.${this.tier}.enabled) or ask the user to do so.`
  }
}

// No executor bridge is installed in this build/process (e.g. headless run), so
// nothing was requested and nothing performed.
export class ComputerUseUnavailableError extends Schema.TaggedErrorClass<ComputerUseUnavailableError>()(
  "ComputerUseUnavailableError",
  { appID: Schema.String, action: Schema.String },
) {
  override get message() {
    return `Computer use is not available in this build: the ${this.action} action for ${this.appID} was not performed. Do not assume it happened; tell the user and continue another way.`
  }
}

// The desktop executor itself declined to run the action (refused allowlist,
// malformed call, dead pane); the action was definitely not performed.
export class ComputerUseRefusedError extends Schema.TaggedErrorClass<ComputerUseRefusedError>()(
  "ComputerUseRefusedError",
  { appID: Schema.String, action: Schema.String, detail: Schema.String },
) {
  override get message() {
    return `The desktop executor declined the ${this.action} action for ${this.appID} (${this.detail}), so the action was not performed. Tell the user and continue another way.`
  }
}

// The action went through the bridge but no confirmed receipt came back: never
// claim it happened, never claim it did not.
export class ComputerUseUnconfirmedError extends Schema.TaggedErrorClass<ComputerUseUnconfirmedError>()(
  "ComputerUseUnconfirmedError",
  { appID: Schema.String, action: Schema.String },
) {
  override get message() {
    return `The ${this.action} action for ${this.appID} went to a desktop executor but came back unconfirmed: it may or may not have been performed. Do not assume either way; re-verify on screen (for example request a screenshot) or ask the user.`
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

type Metadata = { action: string; appID: string }

const args = (input: Schema.Schema.Type<typeof Parameters>): ComputerUseExecutor.Args => ({
  ...(input.x !== undefined ? { x: input.x } : {}),
  ...(input.y !== undefined ? { y: input.y } : {}),
  ...(input.text !== undefined ? { text: input.text } : {}),
  ...(input.key !== undefined ? { key: input.key } : {}),
  ...(input.deltaX !== undefined ? { deltaX: input.deltaX } : {}),
  ...(input.deltaY !== undefined ? { deltaY: input.deltaY } : {}),
})

const definition = Tool.define<typeof Parameters, Metadata, Config.Service>(
  "computer_use",
  Effect.gen(function* () {
    const config = yield* Config.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (input: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          const policy = ComputerUse.resolveComputerUse(cfg.computer_use ?? {})
          if (policy.enabled === false) return yield* new ComputerUseDisabledError({ appID: input.appID })
          if (ComputerUse.isAppAllowed(input.appID, policy.allowedApps) === false)
            return yield* new ComputerUseNotAllowedError({ appID: input.appID })
          // Tiers tighten only: a disabled tier fails closed before the ask so
          // the user is never prompted for an action that cannot run.
          if (ComputerUse.isTierAllowed(input.action, policy.tiers) === false) {
            return yield* new ComputerUseTierDisabledError({
              appID: input.appID,
              action: input.action,
              tier: ComputerUse.actionTier(input.action),
            })
          }
          // Fail before the ask when no executor bridge is installed, so the
          // user never consents to an action that cannot run.
          const executor = yield* Effect.serviceOption(ComputerUseExecutor.Service)
          if (Option.isNone(executor)) {
            return yield* new ComputerUseUnavailableError({ appID: input.appID, action: input.action })
          }
          // Consent stays entirely at the human: the reviewer defers this
          // permission and nothing auto-approves it.
          yield* ctx.ask({
            permission: "computer_use",
            patterns: [input.appID, input.action],
            metadata: { action: input.action, appID: input.appID },
            always: [],
          })
          const result = yield* executor.value.execute({
            sessionID: ctx.sessionID,
            action: input.action,
            appID: input.appID,
            ...(Object.keys(args(input)).length > 0 ? { args: args(input) } : {}),
          })
          if (!result.ok) {
            if (result.unconfirmed === true) {
              return yield* new ComputerUseUnconfirmedError({ appID: input.appID, action: input.action })
            }
            return yield* new ComputerUseRefusedError({
              appID: input.appID,
              action: input.action,
              detail: result.error,
            })
          }
          return {
            title: `${input.action} on ${input.appID}`,
            metadata: { action: input.action, appID: input.appID },
            output: result.output ?? `Captured a screenshot of ${input.appID}`,
            attachments: result.screenshot
              ? [{ type: "file" as const, mime: "image/png", url: result.screenshot }]
              : undefined,
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const ComputerUseTool = Object.assign(definition, { parameters: Parameters })

export * as ComputerUseToolModule from "./computer-use"