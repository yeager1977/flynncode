import { LayerNode } from "@flynncode/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@flynncode/core/schema"
import { Global } from "@flynncode/core/global"
import { FSUtil } from "@flynncode/core/fs-util"

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

export const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const decode = Schema.decodeUnknownOption(Info)

    const all = Effect.fn("Auth.all")(function* () {
      if (process.env.OPENCODE_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
        } catch (err) {}
      }

      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    // Several writers share auth.json (token refreshes here, auth plugins, the
    // Muse sync script). A write must start from the file's exact contents: a
    // missing file is empty, but an unreadable one (another writer mid-write)
    // fails the write instead of being treated as empty, and entries this
    // build cannot decode are carried over untouched. Reading it leniently
    // here replaced every stored credential with the one being saved.
    const stored = Effect.fnUntraced(function* () {
      const text = yield* fsys.readFileStringSafe(file).pipe(Effect.mapError(fail("Failed to read auth data")))
      if (text === undefined) return {} as Record<string, unknown>
      const parsed = yield* Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: fail("Auth data is not valid JSON; refusing to overwrite it"),
      })
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return yield* new AuthError({ message: "Auth data is not a JSON object; refusing to overwrite it" })
      return parsed as Record<string, unknown>
    })

    // Write a sibling temp file and rename it over auth.json, so concurrent
    // readers see either the old or the new file, never a truncated one.
    const persist = Effect.fnUntraced(function* (data: Record<string, unknown>) {
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`
      yield* fsys.writeFileString(temp, JSON.stringify(data, null, 2), { mode: 0o600 }).pipe(
        Effect.andThen(fsys.chmod(temp, 0o600)),
        Effect.andThen(fsys.rename(temp, file)),
        Effect.tapError(() => fsys.remove(temp).pipe(Effect.ignore)),
        Effect.mapError(fail("Failed to write auth data")),
      )
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* stored()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      yield* persist({ ...data, [norm]: info })
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* stored()
      delete data[key]
      delete data[norm]
      yield* persist(data)
    })

    return Service.of({ get, all, set, remove })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })

export * as Auth from "."
