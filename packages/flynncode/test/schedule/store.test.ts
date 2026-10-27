import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@flynncode/core/database/database"
import { AppNodeBuilder } from "@flynncode/core/effect/app-node-builder"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { SessionScheduleTable } from "@flynncode/core/session/sql"
import { eq } from "drizzle-orm"
import { ScheduleStore } from "@/schedule/store"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([ScheduleStore.node, Database.node])))

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const now = new Date("2026-10-27T10:00:30")
// Each test uses its own session so the shared test database never interferes.
const session = (name: string) => SessionID.make(`ses_schedule_${name}`)
const cron = (sessionID: SessionID, at = now, expression = "*/5 * * * *") => ({
  sessionID,
  kind: "cron" as const,
  cron: expression,
  prompt: "check the build",
  recurring: true,
  now: at,
})

describe("ScheduleStore.nextRun", () => {
  it.effect("returns the next match strictly after the given time", () =>
    Effect.sync(() => {
      expect(ScheduleStore.nextRun("*/5 * * * *", new Date("2026-10-27T10:00:30"))).toEqual(
        new Date("2026-10-27T10:05:00"),
      )
      expect(ScheduleStore.nextRun("*/5 * * * *", new Date("2026-10-27T10:05:00"))).toEqual(
        new Date("2026-10-27T10:10:00"),
      )
      // 2026-10-27 is a Tuesday; the next Monday is the 2nd.
      expect(ScheduleStore.nextRun("0 9 * * 1", new Date("2026-10-27T10:00:00"))).toEqual(
        new Date("2026-11-02T09:00:00"),
      )
    }),
  )

  it.effect("returns undefined for anything that is not a 5-field cron", () =>
    Effect.sync(() => {
      expect(ScheduleStore.nextRun("nonsense", now)).toBeUndefined()
      expect(ScheduleStore.nextRun("*/5 * * *", now)).toBeUndefined()
      expect(ScheduleStore.nextRun("* * * * * *", now)).toBeUndefined()
      expect(ScheduleStore.nextRun("@daily", now)).toBeUndefined()
      expect(ScheduleStore.nextRun("61 * * * *", now)).toBeUndefined()
    }),
  )
})

describe("ScheduleStore", () => {
  it.effect("creates, lists and removes jobs", () =>
    Effect.gen(function* () {
      const store = yield* ScheduleStore.Service
      const id = session("crud")
      const job = yield* store.create(cron(id))
      expect(job.id.startsWith("sch_")).toBe(true)
      expect(job.next_run_at).toBe(new Date("2026-10-27T10:05:00").getTime())
      expect(job.expires_at).toBe(now.getTime() + 7 * DAY)
      expect(job.time_created).toBe(now.getTime())
      expect(job.lease_until).toBeNull()
      expect(job.failures).toBe(0)

      const other = yield* store.create(cron(session("crud-other")))
      expect((yield* store.list(id)).map((item) => item.id)).toEqual([job.id])

      expect(yield* store.remove(id, other.id)).toBe(false)
      expect(yield* store.remove(id, job.id)).toBe(true)
      expect(yield* store.list(id)).toEqual([])
      expect(yield* store.list(session("crud-other"))).toHaveLength(1)
    }),
  )

  it.effect("gives one-shot cron jobs no expiry", () =>
    Effect.gen(function* () {
      const store = yield* ScheduleStore.Service
      const job = yield* store.create({ ...cron(session("oneshot")), recurring: false })
      expect(job.expires_at).toBeNull()
      expect(job.recurring).toBe(false)
    }),
  )

  it.effect("refuses the 21st job, counting wakeups", () =>
    Effect.gen(function* () {
      const store = yield* ScheduleStore.Service
      const id = session("limit")
      yield* Effect.forEach(Array.from({ length: 19 }), () => store.create(cron(id)))
      yield* store.create({
        sessionID: id,
        kind: "wakeup",
        prompt: "poll",
        reason: "waiting",
        recurring: false,
        runAt: new Date(now.getTime() + 5 * MINUTE),
        now,
      })
      expect(yield* store.list(id)).toHaveLength(20)

      const refused = yield* store.create(cron(id)).pipe(Effect.flip)
      expect(refused).toBeInstanceOf(ScheduleStore.LimitError)
      expect(yield* store.list(id)).toHaveLength(20)
    }),
  )

  it.effect("replaces the pending wakeup, even at the limit", () =>
    Effect.gen(function* () {
      const store = yield* ScheduleStore.Service
      const id = session("wakeup")
      const wakeup = (reason: string, minutes: number) =>
        store.create({
          sessionID: id,
          kind: "wakeup",
          prompt: `again ${reason}`,
          reason,
          recurring: false,
          runAt: new Date(now.getTime() + minutes * MINUTE),
          now,
        })
      const first = yield* wakeup("first", 5)
      expect(first.cron).toBeNull()
      expect(first.reason).toBe("first")
      expect(first.next_run_at).toBe(now.getTime() + 5 * MINUTE)

      yield* Effect.forEach(Array.from({ length: 19 }), () => store.create(cron(id)))
      const second = yield* wakeup("second", 10)
      const jobs = yield* store.list(id)
      expect(jobs).toHaveLength(20)
      expect(jobs.filter((job) => job.kind === "wakeup").map((job) => job.id)).toEqual([second.id])
    }),
  )

  it.effect("rejects an invalid cron and stores nothing", () =>
    Effect.gen(function* () {
      const store = yield* ScheduleStore.Service
      const id = session("invalid")
      const error = yield* store.create(cron(id, now, "every day")).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ScheduleStore.InvalidCronError)
      expect(yield* store.list(id)).toEqual([])
    }),
  )

  it.effect("claims a due job once and not again within the lease", () =>
    Effect.gen(function* () {
      const store = yield* ScheduleStore.Service
      const id = session("claim")
      const job = yield* store.create(cron(id))
      const due = new Date(job.next_run_at)

      expect((yield* store.claimDue(new Date(job.next_run_at - 1))).filter((item) => item.session_id === id)).toEqual(
        [],
      )

      const first = (yield* store.claimDue(due)).filter((item) => item.session_id === id)
      expect(first.map((item) => item.id)).toEqual([job.id])
      expect(first[0]!.lease_until).toBe(due.getTime() + MINUTE)

      const second = (yield* store.claimDue(new Date(due.getTime() + 30_000))).filter((item) => item.session_id === id)
      expect(second).toEqual([])

      // A crashed claimant's lease expires and the job is claimable again.
      const third = (yield* store.claimDue(new Date(due.getTime() + MINUTE + 1))).filter(
        (item) => item.session_id === id,
      )
      expect(third.map((item) => item.id)).toEqual([job.id])
    }),
  )

  it.effect("lets exactly one of several concurrent claims win", () =>
    Effect.gen(function* () {
      const store = yield* ScheduleStore.Service
      const id = session("race")
      const job = yield* store.create(cron(id))
      const due = new Date(job.next_run_at)
      const claims = yield* Effect.all(
        Array.from({ length: 5 }, () => store.claimDue(due)),
        { concurrency: "unbounded" },
      )
      expect(claims.flat().filter((item) => item.id === job.id)).toHaveLength(1)
    }),
  )

  it.effect("advances a recurring job on complete and deletes a one-shot", () =>
    Effect.gen(function* () {
      const store = yield* ScheduleStore.Service
      const db = (yield* Database.Service).db
      const id = session("complete")
      const recurring = yield* store.create(cron(id))
      const once = yield* store.create({ ...cron(id), recurring: false })
      const due = new Date(recurring.next_run_at)
      yield* store.claimDue(due)
      // Failures from earlier ticks are forgotten once a delivery succeeds.
      yield* db.update(SessionScheduleTable).set({ failures: 2 }).where(eq(SessionScheduleTable.id, recurring.id)).run()

      const late = new Date(due.getTime() + 12 * MINUTE)
      yield* store.complete(recurring, { now: late, messageID: "msg_a" })
      yield* store.complete(once, { now: late, messageID: "msg_b" })

      const jobs = yield* store.list(id)
      expect(jobs.map((job) => job.id)).toEqual([recurring.id])
      expect(jobs[0]!.next_run_at).toBe(new Date("2026-10-27T10:20:00").getTime())
      expect(jobs[0]!.lease_until).toBeNull()
      expect(jobs[0]!.failures).toBe(0)
      expect(jobs[0]!.pending_message_id).toBe("msg_a")
    }),
  )

  it.effect("skip advances a recurring job without recording a delivery", () =>
    Effect.gen(function* () {
      const store = yield* ScheduleStore.Service
      const id = session("skip")
      const job = yield* store.create(cron(id))
      yield* store.complete(job, { now, messageID: "msg_prev" })
      const current = (yield* store.list(id))[0]!
      const claimed = yield* store.claimDue(new Date(current.next_run_at))
      const mine = claimed.find((item) => item.id === job.id)!

      yield* store.skip(mine, new Date(current.next_run_at))
      const after = (yield* store.list(id))[0]!
      expect(after.next_run_at).toBe(current.next_run_at + 5 * MINUTE)
      expect(after.lease_until).toBeNull()
      expect(after.pending_message_id).toBe("msg_prev")
    }),
  )

  it.effect("deletes a job after 3 consecutive failures", () =>
    Effect.gen(function* () {
      const store = yield* ScheduleStore.Service
      const id = session("fail")
      const job = yield* store.create(cron(id))
      const due = new Date(job.next_run_at)

      yield* store.claimDue(due)
      yield* store.fail(job)
      const once = (yield* store.list(id))[0]!
      expect(once.failures).toBe(1)
      expect(once.lease_until).toBeNull()

      yield* store.fail(job)
      expect((yield* store.list(id))[0]!.failures).toBe(2)
      yield* store.fail(job)
      expect(yield* store.list(id)).toEqual([])
    }),
  )

  it.effect("expires jobs past expires_at and returns them", () =>
    Effect.gen(function* () {
      const store = yield* ScheduleStore.Service
      const id = session("expire")
      const recurring = yield* store.create(cron(id))
      const once = yield* store.create({ ...cron(id), recurring: false })

      const mine = (jobs: ScheduleStore.Job[]) => jobs.filter((job) => job.session_id === id).map((job) => job.id)
      expect(mine(yield* store.expire(new Date(now.getTime() + 6 * DAY)))).toEqual([])
      expect(mine(yield* store.expire(new Date(now.getTime() + 7 * DAY + 1)))).toEqual([recurring.id])
      expect((yield* store.list(id)).map((job) => job.id)).toEqual([once.id])
      expect(recurring.expires_at).not.toBeNull()
    }),
  )

  it.effect("removes every job of a session", () =>
    Effect.gen(function* () {
      const store = yield* ScheduleStore.Service
      const id = session("purge")
      yield* store.create(cron(id))
      yield* store.create(cron(id))
      yield* store.create(cron(session("purge-keep")))
      yield* store.removeSession(id)
      expect(yield* store.list(id)).toEqual([])
      expect(yield* store.list(session("purge-keep"))).toHaveLength(1)
    }),
  )
})
