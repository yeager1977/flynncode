export * as SessionImport from "./import"

import { createHash } from "crypto"
import { eq } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { EventV2 } from "../event"
import { Database } from "../database/database"
import { Location } from "../location"
import { SessionEvent } from "./event"
import { Prompt } from "./prompt"
import { SessionMessage } from "./message"
import type { SessionSchema } from "./schema"
import { SessionImportRegistry } from "./import-registry"
import { SessionTable } from "./sql"
import { SessionV2 } from "../session"
import { SessionV1 } from "../v1/session"
import { ProviderV2 } from "../provider"
import { ModelV2 } from "../model"

export type ImportedMessage =
  | { readonly role: "user"; readonly text: string; readonly time: number }
  | { readonly role: "assistant"; readonly text: string; readonly time: number }

const importedAgent = "imported"
const importedProviderID = ProviderV2.ID.make("import")
const importedModelID = ModelV2.ID.make("import")

// Message/part IDs are globally unique PKs, so they must include the target
// session identity to keep re-imports deterministic yet collision-free across
// sessions. The hash keeps IDs short and bounded; stable per (session, ordinal).
const hash = (input: string) => createHash("sha256").update(`${input}`).digest("hex").slice(0, 32)
const messageID = (sessionID: SessionSchema.ID, ordinal: number) =>
  SessionMessage.ID.make(`msg_import_${hash(sessionID)}_${ordinal}`)
const partID = (sessionID: SessionSchema.ID, index: number) =>
  SessionV1.PartID.make(`prt_import_${hash(sessionID)}_${index}`)

export const importTranscript = (
  events: EventV2.Interface,
  input: { readonly sessionID: SessionSchema.ID; readonly transcript: ReadonlyArray<ImportedMessage> },
) =>
  Effect.gen(function* () {
    // The V1 projection requires every assistant message to hang off a user
    // message. Transcripts routinely contain several assistant turns in a row
    // for one user prompt, so every assistant parents to the nearest preceding
    // user rather than to the previous item.
    const firstUserIndex = input.transcript.findIndex((item) => item.role === "user")
    // A transcript with no user turn cannot produce valid V1 parents. Such
    // sessions are machine runs, not human work, and are dropped upstream;
    // bail out rather than fabricate a turn or emit an unresolvable parent.
    if (firstUserIndex < 0) return
    let lastUserID = messageID(input.sessionID, firstUserIndex)

    for (let index = 0; index < input.transcript.length; index++) {
      const item = input.transcript[index]
      if (!item) continue
      const id = messageID(input.sessionID, index)
      const textID = `text-import-${hash(input.sessionID)}_${index}`
      const timestamp = DateTime.makeUnsafe(item.time)
      if (item.role === "user") {
        lastUserID = id
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
            id: partID(input.sessionID, index),
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
        textID,
      })
      yield* events.publish(SessionEvent.Text.Ended, {
        sessionID: input.sessionID,
        assistantMessageID: id,
        timestamp,
        textID,
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
          parentID: SessionV1.MessageID.ascending(lastUserID),
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
          id: partID(input.sessionID, index),
          sessionID: input.sessionID,
          messageID: SessionV1.MessageID.ascending(id),
          type: "text",
          text: item.text,
        }),
      })
    }
  })

export const importSession = (input: {
  readonly location: Location.Ref
  readonly source: "claude-code" | "codex"
  readonly sourceSessionID: string
  readonly sourcePath: string
  readonly title: string
  readonly transcript: ReadonlyArray<ImportedMessage>
}) =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service

    const bounds = input.transcript.reduce(
      (acc, item) => ({
        created: Math.min(acc.created, item.time),
        updated: Math.max(acc.updated, item.time),
      }),
      { created: Number.POSITIVE_INFINITY, updated: 0 },
    )
    const now = Date.now()

    const session = yield* sessions.create({
      location: input.location,
      metadata: SessionImportRegistry.encodeProvenance({
        source: input.source,
        sourceSessionID: input.sourceSessionID,
        sourcePath: input.sourcePath,
        importedAt: now,
      }),
    })

    yield* importTranscript(events, { sessionID: session.id, transcript: input.transcript })

    // A single update: drizzle's $onUpdate hook would stamp wall-clock now over
    // time_updated if this column were omitted from any separate title update.
    const created = Number.isFinite(bounds.created) ? bounds.created : now
    const updated = bounds.updated > 0 ? bounds.updated : now
    yield* db
      .update(SessionTable)
      .set({ title: input.title, time_created: created, time_updated: updated })
      .where(eq(SessionTable.id, session.id))
      .run()
      .pipe(Effect.orDie)

    return yield* sessions.get(session.id)
  })
