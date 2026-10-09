import { Effect, Option, Schema } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ConfigErrorV1 } from "@opencode-ai/core/v1/config/error"
import { Config } from "@/config/config"
import { ConfigParse } from "@/config/parse"
import { MachineSyncConfig } from "@/machine-sync/config-sync"
import { MachineSyncStore } from "@/machine-sync/store"
import { SessionID } from "@/session/schema"
import { isRecord } from "@/util/record"

export const MachineSyncPaths = {
  manifest: "/flynncode-sync/manifest",
  session: "/flynncode-sync/session/:id",
  apply: "/flynncode-sync/apply",
  delete: "/flynncode-sync/delete/:id",
  archive: "/flynncode-sync/archive/:id",
  missing: "/flynncode-sync/missing",
  settings: "/flynncode-sync/settings",
  settingsApply: "/flynncode-sync/settings/apply",
} as const

// Largest timestamp a Date can represent.
const MAX_MTIME = 8.64e15

const decodeSessionID = Schema.decodeUnknownOption(SessionID)

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status })

// Machine sync is Flynncode-internal: the LAN gateway forwards only the
// read-only manifest/session/settings routes for a pairing-token peer, and the
// local sync worker calls the rest over loopback. Keeping them as raw routes
// leaves the public HttpApi and the generated SDK untouched.
export const machineSyncRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const store = yield* MachineSyncStore.Service
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service

    const modified = (file: string) =>
      fs.stat(file).pipe(
        Effect.map((info) =>
          Option.getOrElse(
            Option.map(info.mtime, (date) => date.getTime()),
            () => 0,
          ),
        ),
        Effect.orElseSucceed(() => 0),
      )

    yield* router.add("GET", MachineSyncPaths.manifest, () =>
      store.manifest().pipe(Effect.map((manifest) => json(manifest))),
    )

    yield* router.add("GET", MachineSyncPaths.session, () =>
      Effect.gen(function* () {
        const sessionID = decodeSessionID((yield* HttpRouter.params).id)
        if (Option.isNone(sessionID)) return json({ error: "not found" }, 404)
        const bundle = yield* store.bundle(sessionID.value)
        if (!bundle) return json({ error: "not found" }, 404)
        return json(bundle)
      }),
    )

    yield* router.add("POST", MachineSyncPaths.apply, (request) =>
      Effect.gen(function* () {
        const body: unknown = yield* request.json.pipe(Effect.orElseSucceed(() => undefined))
        if (!MachineSyncStore.isBundle(body)) return json({ error: "invalid bundle" }, 400)
        return yield* store.apply(body).pipe(
          Effect.as(json({ ok: true })),
          Effect.catchTag("MachineSyncBusyError", () => Effect.succeed(json({ error: "busy" }, 409))),
          Effect.catchTag("MachineSyncApplyError", (error) => Effect.succeed(json({ error: error.message }, 422))),
        )
      }),
    )

    yield* router.add("POST", MachineSyncPaths.delete, (request) =>
      Effect.gen(function* () {
        const sessionID = decodeSessionID((yield* HttpRouter.params).id)
        const body: unknown = yield* request.json.pipe(Effect.orElseSucceed(() => undefined))
        if (
          Option.isNone(sessionID) ||
          !isRecord(body) ||
          typeof body.timeDeleted !== "number" ||
          !Number.isInteger(body.timeDeleted)
        )
          return json({ error: "bad request" }, 400)
        return yield* store.remove({ sessionID: sessionID.value, timeDeleted: body.timeDeleted }).pipe(
          Effect.as(json({ ok: true })),
          Effect.catchTag("MachineSyncBusyError", () => Effect.succeed(json({ error: "busy" }, 409))),
        )
      }),
    )

    yield* router.add("POST", MachineSyncPaths.archive, (request) =>
      Effect.gen(function* () {
        const sessionID = decodeSessionID((yield* HttpRouter.params).id)
        const body: unknown = yield* request.json.pipe(Effect.orElseSucceed(() => undefined))
        if (
          Option.isNone(sessionID) ||
          !isRecord(body) ||
          typeof body.timeArchived !== "number" ||
          !Number.isInteger(body.timeArchived)
        )
          return json({ error: "bad request" }, 400)
        return yield* store.archive({ sessionID: sessionID.value, timeArchived: body.timeArchived }).pipe(
          Effect.as(json({ ok: true })),
          Effect.catchTag("MachineSyncBusyError", () => Effect.succeed(json({ error: "busy" }, 409))),
        )
      }),
    )

    yield* router.add("GET", MachineSyncPaths.missing, () =>
      store.missingDirectories().pipe(Effect.map((directories) => json({ directories }))),
    )

    yield* router.add("GET", MachineSyncPaths.settings, () =>
      Effect.gen(function* () {
        const file = Config.globalConfigFile()
        // Stat first so the mtime we send is never newer than the content we read.
        const mtime = yield* modified(file)
        const text = yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
        // "missing" lets a fresh machine accept the peer config; unparseable files stay untouched.
        if (text === undefined) return json({ config: null, mtime: 0, missing: true })
        const parsed = yield* Effect.try({
          try: () => ConfigParse.jsonc(text, file),
          catch: (error) => error,
        }).pipe(Effect.option)
        if (Option.isNone(parsed)) return json({ config: null, mtime: 0 })
        return json({ config: MachineSyncConfig.sanitizeConfig(parsed.value), mtime })
      }),
    )

    yield* router.add("POST", MachineSyncPaths.settingsApply, (request) =>
      Effect.gen(function* () {
        const body: unknown = yield* request.json.pipe(Effect.orElseSucceed(() => undefined))
        if (
          !isRecord(body) ||
          !isRecord(body.config) ||
          typeof body.mtime !== "number" ||
          !Number.isFinite(body.mtime) ||
          body.mtime < 0 ||
          body.mtime > MAX_MTIME
        )
          return json({ error: "bad request" }, 400)
        const peer = body.config
        const mtime = body.mtime
        const file = Config.globalConfigFile()
        // Newest edit wins by file mtime; a tie keeps the local file.
        if (mtime <= (yield* modified(file))) return json({ applied: false })
        const localText = (yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))) ?? "{}"
        return yield* Effect.try({
          try: () => {
            const next = MachineSyncConfig.applyPeerConfig({
              localText,
              local: ConfigParse.jsonc(localText, file),
              peer,
            })
            Config.validateText(next, file)
            return next
          },
          catch: describeFailure,
        }).pipe(
          Effect.flatMap((next) =>
            Effect.gen(function* () {
              if (next !== localText)
                yield* fs.writeWithDirs(file, next).pipe(Effect.mapError(() => "config could not be written"))
              // Stamp the peer's mtime so the next cycle on either side sees a tie.
              // The content is already applied, so a failed stamp only costs one extra cycle.
              yield* fs
                .utimes(file, new Date(mtime), new Date(mtime))
                .pipe(Effect.catch(() => Effect.logWarning("machine sync could not stamp the global config mtime")))
              yield* config.invalidate()
              return json({ applied: true })
            }),
          ),
          Effect.catch((reason) => Effect.succeed(json({ error: reason }, 422))),
        )
      }),
    )
  }),
)

// Config errors embed the file text (parse errors) or offending values
// (schema issues), and the local file holds secrets: report only a fixed
// message plus the paths of invalid fields.
function describeFailure(error: unknown) {
  if (ConfigErrorV1.JsonError.isInstance(error)) return "the config is not valid JSON"
  if (!ConfigErrorV1.InvalidError.isInstance(error)) return "the config could not be applied"
  const paths = (error.data.issues ?? []).flatMap((issue) => (issue.path.length > 0 ? [issue.path.join(".")] : []))
  return paths.length > 0 ? `the config is invalid at: ${paths.join(", ")}` : "the config is invalid"
}
