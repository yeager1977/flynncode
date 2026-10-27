import { afterEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Database } from "@flynncode/core/database/database"
import { SessionProjector } from "@flynncode/core/session/projector"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { Ripgrep } from "@flynncode/core/ripgrep"
import type { PermissionV1 } from "@flynncode/core/v1/permission"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ScheduleStore } from "@/schedule/store"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { MessageID } from "@/session/schema"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { CronCreateTool } from "@/tool/cron-create"
import { CronListTool } from "@/tool/cron-list"
import { CronDeleteTool } from "@/tool/cron-delete"
import { ScheduleWakeupTool } from "@/tool/schedule-wakeup"
import { NOT_ROOT } from "@/tool/schedule/guard"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
      ScheduleStore.node,
    ]),
    [],
  ),
)

type Ask = { permission: string; patterns: string[] }

const ctx = (sessionID: string, asks: Ask[] = [], ruleset: PermissionV1.Ruleset = []) =>
  ({
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    // The real ask evaluates the agent's ruleset; a deny fails the call.
    ask: (req: Ask) =>
      Effect.gen(function* () {
        asks.push({ permission: req.permission, patterns: req.patterns })
        if (Permission.evaluate(req.permission, req.patterns[0], ruleset).action === "deny")
          return yield* Effect.die(new Error(`denied ${req.permission}`))
      }),
    extra: {} as { [key: string]: unknown },
  }) as unknown as Tool.Context

const tools = Effect.gen(function* () {
  return {
    create: yield* Tool.init(yield* CronCreateTool),
    list: yield* Tool.init(yield* CronListTool),
    remove: yield* Tool.init(yield* CronDeleteTool),
    wakeup: yield* Tool.init(yield* ScheduleWakeupTool),
  }
})

const failure = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  return Cause.pretty(exit.cause)
}

describe("schedule tools", () => {
  it.instance("cron_create stores a recurring job and reports the next run", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const store = yield* ScheduleStore.Service
      const session = yield* sessions.create({ title: "root" })
      const t = yield* tools
      const before = Date.now()
      const result = yield* t.create.execute({ cron: "*/5 * * * *", prompt: "check the build" }, ctx(session.id))

      const [job] = yield* store.list(session.id)
      expect(job).toMatchObject({ kind: "cron", cron: "*/5 * * * *", prompt: "check the build", recurring: true })
      expect(job.expires_at).toBeGreaterThan(before)
      expect(job.next_run_at).toBeGreaterThan(before)
      expect(job.next_run_at).toBeLessThanOrEqual(before + 5 * 60_000 + 1000)
      expect(result.metadata.jobId).toBe(job.id)
      expect(result.output).toContain(job.id)
      expect(result.output).toContain(new Date(job.next_run_at).toISOString())
      expect(result.output).toContain("Next run:")
    }),
  )

  it.instance("cron_create with recurring: false stores a one-shot without expiry", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const store = yield* ScheduleStore.Service
      const session = yield* sessions.create({ title: "root" })
      const t = yield* tools
      yield* t.create.execute({ cron: "0 9 * * *", prompt: "once", recurring: false }, ctx(session.id))
      const [job] = yield* store.list(session.id)
      expect(job.recurring).toBe(false)
      expect(job.expires_at).toBeNull()
    }),
  )

  it.instance("cron_create refuses an invalid cron and stores nothing", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const store = yield* ScheduleStore.Service
      const session = yield* sessions.create({ title: "root" })
      const t = yield* tools
      for (const cron of ["nonsense", "*/5 * * *", "61 * * * *"]) {
        const message = failure(yield* t.create.execute({ cron, prompt: "x" }, ctx(session.id)).pipe(Effect.exit))
        expect(message).toContain("Invalid cron expression")
        expect(message).toContain(cron)
      }
      expect(yield* store.list(session.id)).toHaveLength(0)
    }),
  )

  it.instance("cron_create refuses a recurring job that would first fire after its 7-day expiry", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const store = yield* ScheduleStore.Service
      const session = yield* sessions.create({ title: "root" })
      const t = yield* tools
      // February 29th is always more than 7 days away, except in the week before one.
      const message = failure(
        yield* t.create.execute({ cron: "0 0 29 2 *", prompt: "leap day" }, ctx(session.id)).pipe(Effect.exit),
      )
      expect(message).toContain("would never fire")
      expect(message).toContain("recurring false")
      expect(yield* store.list(session.id)).toHaveLength(0)
      yield* t.create.execute({ cron: "0 0 29 2 *", prompt: "leap day", recurring: false }, ctx(session.id))
      expect(yield* store.list(session.id)).toHaveLength(1)
    }),
  )

  it.instance("jobs created in a process that never leads belong to the desktop sidecar", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const store = yield* ScheduleStore.Service
      const session = yield* sessions.create({ title: "root" })
      const t = yield* tools
      expect(ScheduleStore.processOwner()).toBeUndefined()
      yield* t.create.execute({ cron: "*/5 * * * *", prompt: "poll" }, ctx(session.id))
      yield* t.wakeup.execute({ delaySeconds: 120, prompt: "look", reason: "wait" }, ctx(session.id))
      expect((yield* store.list(session.id)).map((job) => job.owner)).toEqual(["sidecar", "sidecar"])
    }),
  )

  it.instance("cron_create refuses the 21st job; a wakeup counts toward the limit", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const store = yield* ScheduleStore.Service
      const session = yield* sessions.create({ title: "root" })
      const t = yield* tools
      yield* t.wakeup.execute({ delaySeconds: 600, prompt: "later", reason: "wait" }, ctx(session.id))
      for (let i = 0; i < ScheduleStore.MAX_JOBS - 1; i++)
        yield* t.create.execute({ cron: "0 * * * *", prompt: `job ${i}` }, ctx(session.id))
      const message = failure(
        yield* t.create.execute({ cron: "0 * * * *", prompt: "one too many" }, ctx(session.id)).pipe(Effect.exit),
      )
      expect(message).toContain(`${ScheduleStore.MAX_JOBS} scheduled jobs`)
      expect(yield* store.list(session.id)).toHaveLength(ScheduleStore.MAX_JOBS)
    }),
  )

  it.instance("cron_list shows the session's jobs and nothing from other sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const mine = yield* sessions.create({ title: "mine" })
      const other = yield* sessions.create({ title: "other" })
      const t = yield* tools
      const empty = yield* t.list.execute({}, ctx(mine.id))
      expect(empty.output).toBe("No scheduled jobs in this session.")
      yield* t.create.execute({ cron: "*/10 * * * *", prompt: "poll the deploy" }, ctx(mine.id))
      yield* t.wakeup.execute({ delaySeconds: 120, prompt: "look again", reason: "build running" }, ctx(mine.id))
      yield* t.create.execute({ cron: "0 8 * * *", prompt: "not mine" }, ctx(other.id))
      const result = yield* t.list.execute({}, ctx(mine.id))
      expect(result.metadata.count).toBe(2)
      expect(result.output).toContain("*/10 * * * *")
      expect(result.output).toContain("poll the deploy")
      expect(result.output).toContain("build running")
      expect(result.output).not.toContain("not mine")
    }),
  )

  it.instance("cron_delete removes a job; an unknown id or another session's job is no such job", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const store = yield* ScheduleStore.Service
      const mine = yield* sessions.create({ title: "mine" })
      const other = yield* sessions.create({ title: "other" })
      const t = yield* tools
      yield* t.create.execute({ cron: "0 * * * *", prompt: "a" }, ctx(mine.id))
      yield* t.create.execute({ cron: "0 * * * *", prompt: "b" }, ctx(other.id))
      const [job] = yield* store.list(mine.id)
      const [foreign] = yield* store.list(other.id)

      expect((yield* t.remove.execute({ id: "sch_missing" }, ctx(mine.id))).output).toBe("no such job")
      expect((yield* t.remove.execute({ id: foreign.id }, ctx(mine.id))).output).toBe("no such job")
      expect(yield* store.list(other.id)).toHaveLength(1)

      const removed = yield* t.remove.execute({ id: job.id }, ctx(mine.id))
      expect(removed.output).toContain(job.id)
      expect(yield* store.list(mine.id)).toHaveLength(0)
    }),
  )

  it.instance("schedule_wakeup clamps the delay to 60-3600 seconds", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const store = yield* ScheduleStore.Service
      const session = yield* sessions.create({ title: "root" })
      const t = yield* tools
      const at = (delaySeconds: number) =>
        Effect.gen(function* () {
          const before = Date.now()
          const result = yield* t.wakeup.execute({ delaySeconds, prompt: "again", reason: "pace" }, ctx(session.id))
          const [job] = yield* store.list(session.id)
          return { result, job, before, after: Date.now() }
        })

      const low = yield* at(5)
      expect(low.result.metadata.delaySeconds).toBe(60)
      expect(low.job.next_run_at).toBeGreaterThanOrEqual(low.before + 60_000)
      expect(low.job.next_run_at).toBeLessThanOrEqual(low.after + 60_000)
      expect(low.result.output).toContain("clamped")
      expect(low.result.output).toContain(new Date(low.job.next_run_at).toISOString())

      const high = yield* at(86_400)
      expect(high.result.metadata.delaySeconds).toBe(3600)
      expect(high.job.next_run_at).toBeGreaterThanOrEqual(high.before + 3_600_000)
      expect(high.job.next_run_at).toBeLessThanOrEqual(high.after + 3_600_000)

      const inside = yield* at(300)
      expect(inside.result.metadata.delaySeconds).toBe(300)
      expect(inside.result.output).not.toContain("clamped")
      expect(inside.job).toMatchObject({ kind: "wakeup", reason: "pace", recurring: false, cron: null })
    }),
  )

  it.instance("a second schedule_wakeup replaces the first", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const store = yield* ScheduleStore.Service
      const session = yield* sessions.create({ title: "root" })
      const t = yield* tools
      yield* t.wakeup.execute({ delaySeconds: 600, prompt: "first", reason: "one" }, ctx(session.id))
      yield* t.wakeup.execute({ delaySeconds: 900, prompt: "second", reason: "two" }, ctx(session.id))
      const jobs = yield* store.list(session.id)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]).toMatchObject({ prompt: "second", reason: "two" })
    }),
  )

  it.instance("a sub-agent session is refused by every tool and stores nothing", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const store = yield* ScheduleStore.Service
      const parent = yield* sessions.create({ title: "parent" })
      const child = yield* sessions.create({ title: "child", parentID: parent.id })
      const t = yield* tools
      const calls: Effect.Effect<unknown>[] = [
        t.create.execute({ cron: "*/5 * * * *", prompt: "x" }, ctx(child.id)),
        t.list.execute({}, ctx(child.id)),
        t.remove.execute({ id: "sch_any" }, ctx(child.id)),
        t.wakeup.execute({ delaySeconds: 60, prompt: "x", reason: "y" }, ctx(child.id)),
      ]
      for (const call of calls) expect(failure(yield* call.pipe(Effect.exit))).toContain(NOT_ROOT)
      expect(NOT_ROOT).toBe("scheduling is only available in the main session, not in sub-agents")
      expect(yield* store.list(child.id)).toHaveLength(0)
    }),
  )

  it.instance("the tools ask the schedule permission; a deny on schedule blocks them", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const store = yield* ScheduleStore.Service
      const session = yield* sessions.create({ title: "root" })
      const t = yield* tools
      const asks: Ask[] = []
      yield* t.create.execute({ cron: "0 * * * *", prompt: "x" }, ctx(session.id, asks))
      yield* t.list.execute({}, ctx(session.id, asks))
      expect(asks.map((ask) => ask.permission)).toEqual(["schedule", "schedule"])

      const deny = Permission.fromConfig({ "*": "allow", schedule: "deny" })
      const before = (yield* store.list(session.id)).length
      const exit = yield* t.create
        .execute({ cron: "0 * * * *", prompt: "y" }, ctx(session.id, [], deny))
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* store.list(session.id)).toHaveLength(before)

      // The denied tools are hidden from the model as well, and allowed by default.
      const ids = ["cron_create", "cron_list", "cron_delete", "schedule_wakeup"]
      expect([...Permission.disabled(ids, deny)].toSorted()).toEqual(ids.toSorted())
      expect(Permission.disabled(ids, Permission.fromConfig({ "*": "allow" })).size).toBe(0)
    }),
  )
})
