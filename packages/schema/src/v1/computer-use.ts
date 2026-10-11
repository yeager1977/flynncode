export * as ComputerUseV1 from "./computer-use"

import { Schema } from "effect"
import { define, inventory } from "../event"
import { ascending } from "../identifier"
import { optional, statics } from "../schema"
import { SessionID } from "../session-id"

export const ID = Schema.String.check(Schema.isStartsWith("cue_")).pipe(
  Schema.brand("ComputerUseRequestID"),
  statics((schema) => {
    const create = () => schema.make("cue_" + ascending())
    return {
      create,
      ascending: (id?: string) => (id === undefined ? create() : schema.make(id)),
    }
  }),
)
export type ID = typeof ID.Type

export const Action = Schema.Literals(["screenshot", "click", "type", "keypress", "scroll"]).annotate({
  identifier: "ComputerUseAction",
})
export type Action = typeof Action.Type

export const Args = Schema.Struct({
  x: optional(Schema.Number).annotate({ description: "X point in CSS pixels relative to the pane" }),
  y: optional(Schema.Number).annotate({ description: "Y point in CSS pixels relative to the pane" }),
  text: optional(Schema.String).annotate({ description: "Text for the type action" }),
  key: optional(Schema.String).annotate({ description: "Key for the keypress action" }),
  deltaX: optional(Schema.Number).annotate({ description: "Horizontal scroll delta" }),
  deltaY: optional(Schema.Number).annotate({ description: "Vertical scroll delta" }),
}).annotate({ identifier: "ComputerUseArgs" })
export type Args = typeof Args.Type

export const Request = Schema.Struct({
  requestID: ID,
  sessionID: SessionID,
  action: Action,
  appID: Schema.String.annotate({ description: "Allowlisted GUI app id owning the target pane" }),
  args: optional(Args).annotate({ description: "Action arguments; required fields depend on the action" }),
  time: Schema.Number.annotate({ description: "Request epoch time in milliseconds" }),
}).annotate({ identifier: "ComputerUseRequest" })
export type Request = typeof Request.Type

export const Result = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    screenshot: optional(Schema.String).annotate({ description: "PNG data URL of the captured pane" }),
    output: optional(Schema.String).annotate({ description: "Human-readable execution output" }),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.String.annotate({ description: "Why the action could not be performed" }),
  }),
]).annotate({ identifier: "ComputerUseResult" })
export type Result = typeof Result.Type

export const Reply = Schema.Struct({
  requestID: ID,
  result: Result,
}).annotate({ identifier: "ComputerUseReply" })
export type Reply = typeof Reply.Type

const Requested = define({ type: "computer_use.requested", schema: Request.fields })
export const Event = { Requested, Definitions: inventory(Requested) }