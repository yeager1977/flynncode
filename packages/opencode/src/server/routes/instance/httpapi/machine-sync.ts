import { Effect, Option, Schema } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
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

const decodeSessionID = Schema.decodeUnknownOption(SessionID)

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status })

// Machine sync is Flynncode-internal: the LAN gateway forwards only the
// read-only manifest/session/settings routes for a pairing-token peer, and the
// local sync worker calls the rest over loopback. Keeping them as raw routes
// leaves the public HttpApi and the generated SDK untouched.
export const machineSyncRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const store = yield* MachineSyncStore.Service

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
        if (Option.isNone(sessionID) || !isRecord(body) || typeof body.timeDeleted !== "number")
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
        if (Option.isNone(sessionID) || !isRecord(body) || typeof body.timeArchived !== "number")
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
  }),
)
