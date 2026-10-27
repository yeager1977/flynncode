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

  it.effect("lists due jobs without claiming them, and claims a due job once within its lease", () =>
    Effect.gen(function* () {
      const store = yield* ScheduleStore.Service
      const id = session("claim")
      const job = yield* store.create(cron(id))
      const due = new Date(job.next_run_at)
      const mine = (jobs: ScheduleStore.Job[]) => jobs.filter((item) => item.session_id === id).map((item) => item.id)

      expect(mine(yield* store.due(new Date(job.next_run_at - 1)))).toEqual([])
      expect(yield* store.claim(job.id, new Date(job.next_run_at - 1))).toBeUndefined()
      expect(mine(yield* store.due(due))).toEqual([job.id])
      expect(mine(yield* store.due(due))).toEqual([job.id])

      const first = yield* store.claim(job.id, due)
      expect(first?.lease_until).toBe(due.getTime() + MINUTE)
      expect(mine(yield* store.due(new Date(due.getTime() + 30_000)))).toEqual([])
      expect(yield* store.claim(job.id, new Date(due.getTime() + 30_000))).toBeUndefined()

      // A crashed claimant's lease expires and the job is claimable again.
      const third = yield* store.claim(job.id, new Date(due.getTime() + MINUTE + 1))
      expect(third?.id).toBe(job.id)
    }),
  )

  it.effect("lets exactly one of several concurrent claims win", () =>
    Effect.gen(function* () {
      const store = yield* ScheduleStore.Service
      const job = yield* store.create(cron(session("race")))
      const due = new Date(job.next_run_at)
      const claims = yield* Effect.all(
        Array.from({ length: 5 }, () => store.claim(job.id, due)),
        { concurrency: "unbounded" },
      )
      expect(claims.filter((item) => item !== undefined)).toHaveLength(1)
    }),
  )

  it.effect("summarizes the table in one read", () =>
    Effect.gen(function* () {
      const store = yield* ScheduleStore.Service
      const before = yield* store.summary()
      const job = yield* store.create(cron(session("summary"), new Date("2020-01-01T00:00:30")))
      const after = yield* store.summary()
      expect(after.count).toBe(before.count + 1)
      expect(after.next).toBe(job.next_run_at)
      expect(after.expires).toBe(job.expires_at)
      yield* store.removeSession(session("summary"))
    }),
  )

  it.effect("advances a recurring job on complete and deletes a one-shot", () =>
    Effect.gen(function* () {
      const store = yield* ScheduleStore.Service
      const { db } = yield* Database.Service
      const id = session("complete")
      const recurring = yield* store.create(cron(id))
      const once = yield* store.create({ ...cron(id), recurring: false })
      const due = new Date(recurring.next_run_at)
      // Failures from earlier ticks are forgotten once a delivery succeeds.
      yield* db.update(SessionScheduleTable).set({ failures: 2 }).where(eq(SessionScheduleTable.id, recurring.id)).run()
      const claimed = [yield* store.claim(recurring.id, due), yield* store.claim(once.id, due)]

      const late = new Date(due.getTime() + 12 * MINUTE)
      expect(yield* store.complete(claimed[0]!, { now: late, messageID: "msg_a" })).toBe(true)
      expect(yield* store.complete(claimed[1]!, { now: late, messageID: "msg_b" })).toBe(true)

      const jobs = yield* store.list(id)
      expect(jobs.map((job) => job.id)).toEqual([recurring.id])
      expect(jobs[0]!.next_run_at).toBe(new Date("2026-10-27T10:20:00").getTime())
      expect(jobs[0]!.lease_until).toBeNull()
      expect(jobs[0]!.failures).toBe(0)
      expect(jobs[0]!.pending_message_id).toBe("msg_a")
    }),
  )

  it.effect("applies complete, skip and fail only while the claimed lease is still the job's lease", () =>
    Effect.gen(function* () {
      const store = yield* ScheduleStore.Service
      const id = session("fence")
      const job = yield* store.create(cron(id))
      const due = new Date(job.next_run_at)
      const first = (yield* store.claim(job.id, due))!
      // The first claimant stalls past its lease, and another process claims the job again and delivers it.
      const second = (yield* store.claim(job.id, new Date(due.getTime() + MINUTE + 1)))!
      expect(second.lease_until).not.toBe(first.lease_until)

      expect(yield* store.complete(first, { now: due, messageID: "msg_stale" })).toBe(false)
      expect(yield* store.skip(first, due)).toBe(false)
      expect(yield* store.fail(first)).toBe(false)
      const untouched = (yield* store.list(id))[0]!
      expect(untouched.lease_until).toBe(second.lease_until)
      expect(untouched.next_run_at).toBe(job.next_run_at)
      expect(untouched.failures).toBe(0)
      expect(untouched.pending_message_id).toBeNull()

      expect(yield* store.complete(second, { now: due, messageID: "msg_live" })).toBe(true)
      expect((yield* store.list(id))[0]!.pending_message_id).toBe("msg_live")
      // An unclaimed copy holds no lease.
      expect(yield* store.complete(job, { now: due, messageID: "msg_unclaimed" })).toBe(false)
    }),
  )

  it.effect("skip advances a recurring job without recording a delivery", () =>
    Effect.gen(function* () {
      const store = yield* ScheduleStore.Service
      const id = session("skip")
      const job = yield* store.create(cron(id))
      yield* store.complete((yield* store.claim(job.id, new Date(job.next_run_at)))!, { now, messageID: "msg_prev" })
      const current = (yield* store.list(id))[0]!
      const mine = (yield* store.claim(job.id, new Date(current.next_run_at)))!

      expect(yield* store.skip(mine, new Date(current.next_run_at))).toBe(true)
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
      const fail = Effect.gen(function* () {
        return yield* store.fail((yield* store.claim(job.id, due))!)
      })

      expect(yield* fail).toBe(true)
      const once = (yield* store.list(id))[0]!
      expect(once.failures).toBe(1)
      expect(once.lease_until).toBeNull()

      yield* fail
      expect((yield* store.list(id))[0]!.failures).toBe(2)
      yield* fail
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
      expect(yield* store.removeSession(id)).toBe(2)
      expect(yield* store.removeSession(id)).toBe(0)
      expect(yield* store.list(id)).toEqual([])
      expect(yield* store.list(session("purge-keep"))).toHaveLength(1)
    }),
  )
})
