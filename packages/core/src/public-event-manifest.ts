export * as PublicEventManifest from "./public-event-manifest"

import { Event } from "@flynncode/schema/event"
import { EventManifest } from "@flynncode/schema/event-manifest"

export const Definitions = EventManifest.ServerDefinitions
export const Latest = Event.latest(Definitions)
