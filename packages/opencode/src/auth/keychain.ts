import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Auth } from "./index"
import type { ImportedCredential, VendorID } from "./vendor-import"

export class KeychainError extends Schema.TaggedErrorClass<KeychainError>()("VendorKeychainError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface KeychainInterface {
  readonly available: () => Effect.Effect<boolean>
  readonly get: (vendor: VendorID) => Effect.Effect<ImportedCredential | undefined, KeychainError>
  readonly set: (credential: ImportedCredential) => Effect.Effect<void, KeychainError>
  readonly remove: (vendor: VendorID) => Effect.Effect<void, KeychainError>
}

export class KeychainService extends Context.Service<KeychainService, KeychainInterface>()("@flynncode/VendorKeychain") {}

function toAuthInfo(credential: ImportedCredential): Auth.Info {
  if (credential.kind === "api") return new Auth.Api({ type: "api", key: credential.key })
  const info: typeof Auth.Oauth.Type = {
    type: "oauth",
    refresh: credential.refresh,
    access: credential.access,
    expires: credential.expires,
    ...(credential.accountId ? { accountId: credential.accountId } : {}),
  }
  return new Auth.Oauth(info)
}

function fromAuthInfo(vendor: VendorID, info: Auth.Info | undefined): ImportedCredential | undefined {
  if (!info) return undefined
  if (info.type === "api") return { vendor, kind: "api", key: info.key }
  if (info.type === "oauth")
    return {
      vendor,
      kind: "oauth",
      refresh: info.refresh,
      access: info.access,
      expires: info.expires,
      ...(info.accountId ? { accountId: info.accountId } : {}),
    }
  return undefined
}

// Auth.Service persists to auth.json mode 0600; desktop safeStorage encryption
// is layered in the desktop main process without changing this contract.
const layer = Layer.effect(
  KeychainService,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const available = () => Effect.succeed(false)
    const get = Effect.fn("VendorKeychain.get")(function* (vendor: VendorID) {
      const info = yield* auth.get(vendor).pipe(
        Effect.mapError((cause) => new KeychainError({ message: "Vendor credential read failed", cause })),
      )
      return fromAuthInfo(vendor, info)
    })
    const set = Effect.fn("VendorKeychain.set")(function* (credential: ImportedCredential) {
      yield* auth.set(credential.vendor, toAuthInfo(credential)).pipe(
        Effect.mapError((cause) => new KeychainError({ message: "Vendor credential write failed", cause })),
      )
    })
    const remove = Effect.fn("VendorKeychain.remove")(function* (vendor: VendorID) {
      yield* auth.remove(vendor).pipe(
        Effect.mapError((cause) => new KeychainError({ message: "Vendor credential removal failed", cause })),
      )
    })
    return KeychainService.of({ available, get, set, remove })
  }),
)

export const node = LayerNode.make({ service: KeychainService, layer: layer, deps: [Auth.node] })

export * as VendorKeychain from "./keychain"
