import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Context, Effect, Layer, Option, Schema } from "effect"
import path from "path"
import { parse as parseJsonc } from "jsonc-parser"
import { ConfigManaged } from "@/config/managed"
import { ConfigHooksV1 } from "@flynncode/core/v1/config/hooks"
import { HooksTrust } from "@/hooks/trust"
import { isRecord } from "@/util/record"

// Managed hooks policy: hook definitions declared in managed (MDM/system)
// configuration are trusted by policy. They execute without per-definition
// review and cannot be disabled from the user trust browser (revoke refuses
// managed hashes). Missing or unreadable managed config fails closed: fewer
// policy bypasses, never more.

export interface ManagedPolicy {
  readonly isManaged: (def: HooksTrust.HookDef) => boolean
}

export class ManagedHooks extends Context.Service<ManagedHooks, ManagedPolicy>()("@opencode/HooksManaged") {}

const decodeHooks = Schema.decodeUnknownOption(ConfigHooksV1.Info)

function hooksFromText(text: string, jsonc: boolean): ConfigHooksV1.Info | undefined {
  const parsed = jsonc ? parseJsonc(text) : JSON.parse(text)
  if (!isRecord(parsed)) return undefined
  return Option.getOrUndefined(decodeHooks(parsed["hooks"]))
}

function collectDefs(info: ConfigHooksV1.Info | undefined): Array<HooksTrust.HookDef> {
  if (!info) return []
  return Object.entries(info).flatMap((entry) => {
    const event = entry[0]
    // disableAllHooks is the kill-switch flag, not an event: skip non-array
    // values when walking the event table.
    const groups = entry[1] as Array<ConfigHooksV1.HookGroup> | undefined
    if (!Array.isArray(groups)) return []
    return groups.flatMap((group) =>
      group.hooks.map((handler) => HooksTrust.fromHandler(event, group.matcher, handler)),
    )
  })
}

const loadManagedHashes = Effect.fn("HooksManaged.load")(function* () {
  const hashes = new Set<string>()
  const consider = (info: ConfigHooksV1.Info | undefined) => {
    for (const def of collectDefs(info)) hashes.add(HooksTrust.hashDef(def))
  }
  const readText = (filepath: string, jsonc: boolean) =>
    Effect.gen(function* () {
      const exists = yield* Effect.promise(() => Bun.file(filepath).exists())
      if (!exists) return undefined
      const text = yield* Effect.promise(() => Bun.file(filepath).text())
      try {
        return hooksFromText(text, jsonc)
      } catch {
        return undefined
      }
    }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
  const dir = ConfigManaged.managedConfigDir()
  consider(yield* readText(path.join(dir, "opencode.json"), false))
  consider(yield* readText(path.join(dir, "opencode.jsonc"), true))
  consider(yield* readText(path.join(dir, "hooks.json"), false))
  const preferences = yield* Effect.promise(() => ConfigManaged.readManagedPreferences()).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  )
  if (preferences && isRecord(preferences)) {
    const text = (preferences as Record<string, unknown>)["text"]
    if (typeof text === "string") {
      try {
        consider(hooksFromText(text, false))
      } catch {
        return hashes
      }
    }
  }
  return hashes
})

export const node = LayerNode.make({
  service: ManagedHooks,
  layer: Layer.effect(
    ManagedHooks,
    Effect.gen(function* () {
      const hashes = yield* loadManagedHashes()
      return ManagedHooks.of({ isManaged: (def) => hashes.has(HooksTrust.hashDef(def)) })
    }),
  ),
  deps: [],
})

export * as HooksManaged from "./managed"
