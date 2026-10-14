import { describe, expect, test } from "bun:test"
import { inboxStatus } from "./activity-status"
import { addDispatch, completeDispatch, failDispatch, markDispatchRead, migrateDispatch, reconcileDispatch, resolvedTransition, resumeDispatch, type DispatchStatus, type DispatchTask } from "./dispatch-store"

const task = {
  sessionID: "ses_1",
  title: "Fix tests",
  status: "running" as const,
  directory: "/proj",
  unread: false,
}

describe("dispatch store", () => {
  test("adds a running task at the front", () => {
    expect(addDispatch([], task)).toEqual([task])
  })

  test("marks a task done", () => {
    expect(completeDispatch([task], "ses_1")[0]?.status).toBe("done")
  })

  test("marks a failed send without treating it as still running", () => {
    expect(failDispatch([task], "ses_1")[0]?.status).toBe("failed")
  })

  test("keeps a restarted task running only while its session is active", () => {
    const idle = reconcileDispatch([task], new Set())
    const input = [task]
    const live = reconcileDispatch(input, new Set(["ses_1"]))
    expect(idle[0]?.status).toBe("done")
    expect(live).toBe(input)
  })

  test("restores a saved list and drops a corrupt row", () => {
    const restored = migrateDispatch({
      tasks: [task, { sessionID: "bad" }],
    })
    expect(restored.tasks).toEqual([task])
  })

  test("flags a transition from running to done as unread", () => {
    expect(completeDispatch([task], "ses_1")[0]?.unread).toBe(true)
  })

  test("flags a transition from blocked to failed as unread", () => {
    const blocked = { ...task, status: "blocked" as const }
    expect(failDispatch([blocked], "ses_1")[0]?.unread).toBe(true)
  })

  test("flags a needs-input to done transition and stays quiet when already done", () => {
    const input = [{ ...task, status: "needs-input" as const }]
    expect(completeDispatch(input, "ses_1")[0]?.unread).toBe(true)
    const same = completeDispatch([{ ...task, status: "done" as const, unread: false }], "ses_1")
    expect(same[0]?.unread).toBe(false)
  })

  test("flags a reconcile transition to done as unread", () => {
    expect(reconcileDispatch([task], new Set())[0]?.unread).toBe(true)
  })

  test("preserves unread across persistence and clears it on read", () => {
    const saved = migrateDispatch({ tasks: [{ ...task, unread: true }] })
    expect(saved.tasks[0]?.unread).toBe(true)
    const restored = migrateDispatch({ tasks: [task] })
    expect(restored.tasks[0]?.unread).toBe(false)
    const read = markDispatchRead([{ ...task, unread: true }], "ses_1")
    expect(read[0]?.unread).toBe(false)
  })
})

describe("resumed usage-limited task", () => {
  const limited: DispatchTask = { ...task, status: "failed", unread: true }

  test("persists running when a finished task's session works again, without touching unread", () => {
    const live = new Map<string, DispatchStatus>([[task.sessionID, "running"]])
    expect(resumeDispatch([limited], live)).toEqual([{ ...limited, status: "running" }])
    expect(resumeDispatch([{ ...task, status: "done" }], live)[0]?.status).toBe("running")
  })

  test("leaves tasks alone unless a finished one is live again", () => {
    const tasks: DispatchTask[] = [task, limited]
    expect(resumeDispatch(tasks, new Map<string, DispatchStatus>([[limited.sessionID, "failed"]]))).toBe(tasks)
    expect(resumeDispatch(tasks, new Map<string, DispatchStatus>())).toBe(tasks)
  })

  test("failed -> running -> idle ok resolves once to done, not failed", () => {
    // Mirrors the watcher: a live status is derived each pass, resume is
    // persisted, and only an active -> terminal transition notifies.
    let tasks: DispatchTask[] = [limited]
    const notified: string[] = []
    let before: ReturnType<typeof inboxStatus> | undefined
    const pass = (live: { type: string } | undefined, limitedNow: boolean) => {
      const status = inboxStatus(tasks[0]!.status, live, limitedNow)
      if (before && before !== status && resolvedTransition(before, status)) {
        notified.push(status)
        tasks = tasks.map((item) => ({ ...item, status, unread: true }))
      }
      tasks = [...resumeDispatch(tasks, new Map<string, DispatchStatus>([[task.sessionID, status]]))]
      before = status
    }

    pass(undefined, true) // after reload: still failed on the limit
    expect(tasks[0]?.status).toBe("failed")
    pass({ type: "busy" }, false) // resumed on another model
    expect(tasks[0]?.status).toBe("running")
    pass({ type: "busy" }, false)
    pass({ type: "idle" }, false) // finished fine
    expect(tasks[0]?.status).toBe("done")
    expect(notified).toEqual(["done"])
  })
})
