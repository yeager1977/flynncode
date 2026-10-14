import { describe, expect, test } from "bun:test"
import { dispatchRows, filterInbox, inboxUnread, routineRows, sessionRows, type InboxRow } from "./activity-inbox-rows"

describe("dispatchRows", () => {
  test("keeps unread flags and resolves live status", () => {
    const rows = dispatchRows(
      [{ sessionID: "s1", title: "Build thing", status: "running", directory: "/repo", unread: true }],
      () => "running",
      () => 0,
    )
    expect(rows.length).toBe(1)
    const row = rows[0] as InboxRow
    expect(row.key).toBe("s1")
    expect(row.kind).toBe("dispatch")
    expect(row.status).toBe("running")
    expect(row.unread).toBe(true)
    expect(row.sessionID).toBe("s1")
    expect(row.directory).toBe("/repo")
  })

  test("preserves stored terminal status over idle live state", () => {
    const rows = dispatchRows(
      [{ sessionID: "s2", title: "Done thing", status: "done", directory: "/repo", unread: false }],
      () => "done",
      () => 0,
    )
    expect((rows[0] as InboxRow).status).toBe("done")
    expect((rows[0] as InboxRow).unread).toBe(false)
  })

  test("flags unread from notification unseen counts", () => {
    const rows = dispatchRows(
      [{ sessionID: "s3", title: "Quiet thing", status: "done", directory: "/repo", unread: false }],
      () => "done",
      (id) => (id === "s3" ? 2 : 0),
    )
    expect((rows[0] as InboxRow).unread).toBe(true)
  })
})

describe("routineRows", () => {
  test("maps a latest failed run onto failed and unread", () => {
    const rows = routineRows(
      [
        {
          id: "nightly",
          name: "Nightly",
          prompt: "run",
          enabled: true,
          recentRuns: [{ startedAt: "2026-10-07T01:00:00Z", endedAt: "2026-10-07T01:05:00Z", state: "error" }],
        },
      ],
      () => "daily 09:00",
      () => false,
    )
    expect(rows.length).toBe(1)
    const row = rows[0] as InboxRow
    expect(row.key).toBe("routine:nightly")
    expect(row.kind).toBe("routine")
    expect(row.status).toBe("failed")
    expect(row.unread).toBe(true)
    expect(row.subtitle).toBe("daily 09:00")
  })

  test("maps a routine with no runs onto done and read", () => {
    const rows = routineRows(
      [{ id: "morning", name: "Morning", prompt: "run", enabled: true }],
      () => "manual",
      () => false,
    )
    expect((rows[0] as InboxRow).status).toBe("done")
    expect((rows[0] as InboxRow).unread).toBe(false)
  })

  test("maps a latest ok run onto done and read", () => {
    const rows = routineRows(
      [
        {
          id: "hourly",
          name: "Hourly",
          prompt: "run",
          enabled: true,
          recentRuns: [{ startedAt: "2026-10-07T01:00:00Z", endedAt: "2026-10-07T01:05:00Z", state: "ok" }],
        },
      ],
      () => "every hour",
      () => false,
    )
    expect((rows[0] as InboxRow).status).toBe("done")
    expect((rows[0] as InboxRow).unread).toBe(false)
  })

  test("routine row is running when its latest run's session is live", () => {
    const rows = routineRows(
      [
        {
          id: "nightly-live",
          name: "Nightly",
          prompt: "run",
          enabled: true,
          recentRuns: [
            { sessionID: "sess_9", startedAt: "2026-10-07T01:00:00Z", endedAt: "2026-10-07T01:05:00Z", state: "ok" },
          ],
        },
      ],
      () => "daily 09:00",
      (id) => id === "sess_9",
    )
    expect((rows[0] as InboxRow).status).toBe("running")
  })

  test("routine row stays done when the latest run's session is idle", () => {
    const rows = routineRows(
      [
        {
          id: "nightly-idle",
          name: "Nightly",
          prompt: "run",
          enabled: true,
          recentRuns: [
            { sessionID: "sess_9", startedAt: "2026-10-07T01:00:00Z", endedAt: "2026-10-07T01:05:00Z", state: "ok" },
          ],
        },
      ],
      () => "daily 09:00",
      () => false,
    )
    expect((rows[0] as InboxRow).status).toBe("done")
    expect((rows[0] as InboxRow).unread).toBe(false)
  })
})

describe("sessionRows", () => {
  test("maps idle plus unseen onto needs-input and unread", () => {
    const rows = sessionRows(
      [{ id: "live1", title: "Live session", directory: "/repo" }],
      () => "needs-input",
      (id) => (id === "live1" ? 1 : 0),
    )
    expect(rows.length).toBe(1)
    const row = rows[0] as InboxRow
    expect(row.key).toBe("session:live1")
    expect(row.kind).toBe("session")
    expect(row.status).toBe("needs-input")
    expect(row.unread).toBe(true)
    expect(row.sessionID).toBe("live1")
  })

  test("marks sessions without unseen as read", () => {
    const rows = sessionRows(
      [{ id: "live2", title: "Quiet", directory: "/repo" }],
      () => "running",
      () => 0,
    )
    expect((rows[0] as InboxRow).unread).toBe(false)
    expect((rows[0] as InboxRow).status).toBe("running")
  })
})

describe("filterInbox", () => {
  const rows: InboxRow[] = [
    { key: "a", kind: "dispatch", title: "A", subtitle: "", status: "running", unread: false },
    { key: "b", kind: "session", title: "B", subtitle: "", status: "needs-input", unread: true },
    { key: "c", kind: "dispatch", title: "C", subtitle: "", status: "blocked", unread: false },
    { key: "d", kind: "routine", title: "D", subtitle: "", status: "done", unread: false },
  ]

  test("splits needs-input from blocked", () => {
    expect(filterInbox(rows, "needs-input").map((row) => row.key)).toEqual(["b"])
    expect(filterInbox(rows, "blocked").map((row) => row.key)).toEqual(["c"])
  })

  test("filters running, done, unread, and all", () => {
    expect(filterInbox(rows, "running").map((row) => row.key)).toEqual(["a"])
    expect(filterInbox(rows, "done").map((row) => row.key)).toEqual(["d"])
    expect(filterInbox(rows, "unread").map((row) => row.key)).toEqual(["b"])
    expect(filterInbox(rows, "all").length).toBe(4)
  })

  test("filters failed rows on their own tab", () => {
    const failed: InboxRow = { key: "e", kind: "dispatch", title: "E", subtitle: "", status: "failed", unread: true }
    expect(filterInbox([...rows, failed], "failed").map((row) => row.key)).toEqual(["e"])
    expect(filterInbox([...rows, failed], "done").map((row) => row.key)).toEqual(["d"])
  })

  test("sorts attention first with unread breaking ties", () => {
    const shuffled: InboxRow[] = [rows[3] as InboxRow, rows[0] as InboxRow, rows[2] as InboxRow, rows[1] as InboxRow]
    expect(filterInbox(shuffled, "all").map((row) => row.key)).toEqual(["b", "c", "a", "d"])
  })
})

describe("inboxUnread", () => {
  test("counts unread rows", () => {
    const rows: InboxRow[] = [
      { key: "a", kind: "dispatch", title: "A", subtitle: "", status: "running", unread: true },
      { key: "b", kind: "session", title: "B", subtitle: "", status: "done", unread: false },
      { key: "c", kind: "routine", title: "C", subtitle: "", status: "failed", unread: true },
    ]
    expect(inboxUnread(rows)).toBe(2)
  })
})

describe("capped dispatch list", () => {
  test("session rows still surface live sessions missing from the capped dispatch list", () => {
    const tasks = Array.from({ length: 40 }, (_, index) => ({
      sessionID: `capped-${index}`,
      title: `Task ${index}`,
      status: "done" as const,
      directory: "/repo",
      unread: false,
    }))
    const dispatched = dispatchRows(
      tasks,
      () => "done",
      () => 0,
    )
    const extra = sessionRows(
      [{ id: "live-overflow", title: "Overflow session", directory: "/repo" }],
      () => "running",
      () => 1,
    )
    const combined = [...dispatched, ...extra]
    expect(filterInbox(combined, "all").map((row) => row.key)).toContain("session:live-overflow")
    expect(filterInbox(combined, "unread").map((row) => row.key)).toEqual(["session:live-overflow"])
    expect(inboxUnread(combined)).toBe(1)
  })
})

describe("filterInbox usage limits", () => {
  test("lists usage-limited rows under failed", () => {
    const rows: InboxRow[] = [
      { key: "a", kind: "session", title: "A", subtitle: "", status: "usage-limit", unread: false },
      { key: "b", kind: "dispatch", title: "B", subtitle: "", status: "failed", unread: false },
      { key: "c", kind: "dispatch", title: "C", subtitle: "", status: "done", unread: false },
    ]
    expect(filterInbox(rows, "failed").map((row) => row.key)).toEqual(["a", "b"])
    expect(filterInbox(rows, "done").map((row) => row.key)).toEqual(["c"])
  })
})
