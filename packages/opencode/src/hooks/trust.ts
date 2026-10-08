import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { createHash } from "crypto"
import os from "os"
import path from "path"

export type HookDef = {
  event: string
  matcher: string
  type: string
  command: string
}

export function canonicalize(def: HookDef) {
  return JSON.stringify({ event: def.event, matcher: def.matcher, type: def.type, command: def.command })
}

export function hashDef(def: HookDef) {
  return createHash("sha256").update(canonicalize(def)).digest("hex")
}

export interface TrustInterface {
  readonly hashDef: (def: HookDef) => string
  readonly isTrusted: (def: HookDef) => Effect.Effect<boolean>
  readonly trust: (def: HookDef) => Effect.Effect<void>
  readonly revoke: (hash: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, TrustInterface>()("@opencode/HooksTrust") {}

export function trustFile() {
  const override = process.env["FLYNNCODE_HOOKS_TRUST_FILE"]
  if (override) return override
  return path.join(os.homedir(), ".local", "share", "flynncode", "hooks-trust.json")
}

const TrustFileSchema = Schema.Array(Schema.Struct({ hash: Schema.String, trustedAt: Schema.Number }))

function readHashes(): Promise<Set<string>> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const file = Bun.file(trustFile())
      const exists = yield* Effect.promise(() => file.exists())
      if (!exists) return new Set<string>()
      const raw = yield* Effect.promise(() => file.json()).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (raw === undefined) return new Set<string>()
      const decoded = Option.getOrElse(Schema.decodeUnknownOption(TrustFileSchema)(raw), () => [])
      return new Set(decoded.map((entry) => entry.hash))
    }).pipe(
      // Fail closed: any unexpected defect means untrusted.
      Effect.catch(() => Effect.succeed(new Set<string>())),
    ),
  )
}

function writeHashes(hashes: Set<string>): Promise<void> {
  const payload = Array.from(hashes).map((hash) => ({ hash, trustedAt: Date.now() }))
  return Bun.write(trustFile(), JSON.stringify(payload, null, 2)).then(() => undefined)
}

export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      return Service.of({
        hashDef,
        isTrusted: (def) => Effect.promise(() => readHashes().then((hashes) => hashes.has(hashDef(def)))),
        trust: (def) =>
          Effect.promise(async () => {
            const hashes = await readHashes()
            hashes.add(hashDef(def))
            await writeHashes(hashes)
          }),
        revoke: (hash) =>
          Effect.promise(async () => {
            const hashes = await readHashes()
            hashes.delete(hash)
            await writeHashes(hashes)
          }),
      })
    }),
  ),
  deps: [],
})

export * as HooksTrust from "./trust"
