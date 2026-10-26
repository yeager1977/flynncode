import { afterEach, describe, expect } from "bun:test"
import { Database } from "@flynncode/core/database/database"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { FSUtil } from "@flynncode/core/fs-util"
import { AppProcess } from "@flynncode/core/process"
import { SessionProjector } from "@flynncode/core/session/projector"
import { Effect } from "effect"
import { GlobalBus } from "../../src/bus/global"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Session } from "../../src/session/session"
import { BackgroundShells } from "../../src/shell/background/service"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      AppProcess.node,
      BackgroundShells.node,
      Session.node,
      SessionProjector.node,
      Database.node,
      FSUtil.node,
    ]),
    [[InstanceStore.bootstrapNode, InstanceBootstrap.node]],
  ),
)

// Safety net: every started group is SIGKILLed even when a test fails before the layer finalizer runs.
const started = new Set<number>()
afterEach(async () => {
  started.forEach((pid) => {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {}
  })
  started.clear()
  await disposeAllInstances()
})

const start = (service: BackgroundShells.Interface, sessionID: string) =>
  service
    .start({
      sessionID,
      command: "sleep 120",
      cwd: process.cwd(),
      directory: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      shell: "/bin/sh",
    })
    .pipe(Effect.tap((shell) => Effect.sync(() => started.add(shell.pid))))

const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

const groupGone = (pgid: number) =>
  pollWithTimeout(
    Effect.sync(() => (groupAlive(pgid) ? undefined : true)),
    `process group ${pgid} still alive`,
    "8 seconds",
  )

// The lifecycle kill runs on a forked fiber, so a survivor can only be proven after giving it time to act.
const settle = Effect.sleep("500 millis")

describe("BackgroundShells session lifecycle", () => {
  it.instance(
    "kills a deleted session's shells and leaves other sessions alone",
    () =>
      Effect.gen(function* () {
        const service = yield* BackgroundShells.Service
        const sessions = yield* Session.Service
        const doomed = yield* sessions.create({ title: "doomed" })
        const survivor = yield* sessions.create({ title: "survivor" })
        const gone = yield* start(service, doomed.id)
        const kept = yield* start(service, survivor.id)

        yield* sessions.remove(doomed.id)

        yield* groupGone(gone.pid)
        yield* settle
        expect(yield* service.list(doomed.id)).toEqual([])
        expect(groupAlive(kept.pid)).toBe(true)
        expect((yield* service.list(survivor.id))[0]?.status).toBe("running")
      }),
    { timeout: 30_000 },
  )

  it.instance(
    "kills the shells of child sessions removed with their parent",
    () =>
      Effect.gen(function* () {
        const service = yield* BackgroundShells.Service
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ title: "parent" })
        const child = yield* sessions.create({ title: "child", parentID: parent.id })
        const shell = yield* start(service, child.id)

        yield* sessions.remove(parent.id)

        yield* groupGone(shell.pid)
      }),
    { timeout: 30_000 },
  )

  it.instance(
    "kills an archived session's shells and leaves other sessions alone",
    () =>
      Effect.gen(function* () {
        const service = yield* BackgroundShells.Service
        const sessions = yield* Session.Service
        const archived = yield* sessions.create({ title: "archived" })
        const other = yield* sessions.create({ title: "other" })
        const gone = yield* start(service, archived.id)
        const kept = yield* start(service, other.id)

        yield* sessions.setArchived({ sessionID: archived.id, time: Date.now() })

        yield* groupGone(gone.pid)
        yield* settle
        expect(groupAlive(kept.pid)).toBe(true)
      }),
    { timeout: 30_000 },
  )

  it.instance(
    "keeps shells on ordinary updates and when a session is unarchived",
    () =>
      Effect.gen(function* () {
        const service = yield* BackgroundShells.Service
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "busy" })
        const shell = yield* start(service, session.id)

        yield* sessions.setTitle({ sessionID: session.id, title: "renamed" })
        yield* sessions.setArchived({ sessionID: session.id, time: undefined })
        yield* settle

        expect(groupAlive(shell.pid)).toBe(true)
      }),
    { timeout: 30_000 },
  )

  it.live(
    "kills shells when machine sync archives or deletes a session through the global bus",
    () =>
      Effect.gen(function* () {
        const service = yield* BackgroundShells.Service
        const archived = yield* start(service, "ses_sync_archived")
        const deleted = yield* start(service, "ses_sync_deleted")
        const kept = yield* start(service, "ses_sync_kept")
        // The shape machine-sync/store.ts emits for a peer's archive and delete.
        const send = (type: string, sessionID: string, archivedAt?: number) =>
          GlobalBus.emit("event", {
            directory: process.cwd(),
            payload: { type, properties: { sessionID, info: { id: sessionID, time: { archived: archivedAt } } } },
          })

        send("session.updated", "ses_sync_kept")
        send("session.updated", "ses_sync_archived", Date.now())
        send("session.deleted", "ses_sync_deleted")

        yield* groupGone(archived.pid)
        yield* groupGone(deleted.pid)
        yield* settle
        expect(groupAlive(kept.pid)).toBe(true)
      }),
    30_000,
  )
})
