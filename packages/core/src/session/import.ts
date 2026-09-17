export * as SessionImport from "./import"

import { DateTime, Effect } from "effect"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { Prompt } from "./prompt"
import { SessionMessage } from "./message"
import type { SessionSchema } from "./schema"
import { SessionV1 } from "../v1/session"
import { ProviderV2 } from "../provider"
import { ModelV2 } from "../model"

export type ImportedMessage =
  | { readonly role: "user"; readonly text: string; readonly time: number }
  | { readonly role: "assistant"; readonly text: string; readonly time: number }

const importedAgent = "imported"
const importedProviderID = ProviderV2.ID.make("import")
const importedModelID = ModelV2.ID.make("import")

const messageID = (ordinal: number) => SessionMessage.ID.make(`msg_import_${ordinal}`)

export const importTranscript = (
  events: EventV2.Interface,
  input: { readonly sessionID: SessionSchema.ID; readonly transcript: ReadonlyArray<ImportedMessage> },
) =>
  Effect.gen(function* () {
    for (let index = 0; index < input.transcript.length; index++) {
      const item = input.transcript[index]
      if (!item) continue
      const id = messageID(index)
      const timestamp = DateTime.makeUnsafe(item.time)
      if (item.role === "user") {
        yield* events.publish(SessionEvent.Prompted, {
          sessionID: input.sessionID,
          messageID: id,
          timestamp,
          prompt: Prompt.make({ text: item.text }),
          delivery: "steer",
        })
        yield* events.publish(SessionV1.Event.MessageUpdated, {
          sessionID: input.sessionID,
          info: SessionV1.User.make({
            id: SessionV1.MessageID.ascending(id),
            sessionID: input.sessionID,
            role: "user",
            time: { created: item.time },
            agent: importedAgent,
            model: { providerID: importedProviderID, modelID: importedModelID },
          }),
        })
        yield* events.publish(SessionV1.Event.PartUpdated, {
          sessionID: input.sessionID,
          time: item.time,
          part: SessionV1.TextPart.make({
            id: SessionV1.PartID.ascending(`prt_import_${index}`),
            sessionID: input.sessionID,
            messageID: SessionV1.MessageID.ascending(id),
            type: "text",
            text: item.text,
          }),
        })
        continue
      }

      const model = { id: importedModelID, providerID: importedProviderID }
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: input.sessionID,
        assistantMessageID: id,
        timestamp,
        agent: importedAgent,
        model,
      })
      yield* events.publish(SessionEvent.Text.Started, {
        sessionID: input.sessionID,
        assistantMessageID: id,
        timestamp,
        textID: `text-import-${index}`,
      })
      yield* events.publish(SessionEvent.Text.Ended, {
        sessionID: input.sessionID,
        assistantMessageID: id,
        timestamp,
        textID: `text-import-${index}`,
        text: item.text,
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: input.sessionID,
        assistantMessageID: id,
        timestamp,
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID: input.sessionID,
        info: SessionV1.Assistant.make({
          id: SessionV1.MessageID.ascending(id),
          sessionID: input.sessionID,
          role: "assistant",
          time: { created: item.time, completed: item.time },
          parentID: SessionV1.MessageID.ascending(messageID(index - 1)),
          modelID: importedModelID,
          providerID: importedProviderID,
          mode: importedAgent,
          agent: importedAgent,
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        }),
      })
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID: input.sessionID,
        time: item.time,
        part: SessionV1.TextPart.make({
          id: SessionV1.PartID.ascending(`prt_import_${index}`),
          sessionID: input.sessionID,
          messageID: SessionV1.MessageID.ascending(id),
          type: "text",
          text: item.text,
        }),
      })
    }
  })