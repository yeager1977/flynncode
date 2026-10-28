import { describe, expect, mock, test } from "bun:test"
import type { PartGroup } from "@flynncode/session-ui/message-part"
import { TimelineRow } from "./timeline-row"

// Bun cannot load Vite's `?worker&url` imports, which the real message-part module pulls in.
const sessionUI = new URL("../../../../../session-ui/src/", import.meta.url).pathname
mock.module(`${sessionUI}components/markdown.worker.ts?worker&url`, () => ({ default: "" }))
mock.module("@pierre/diffs/worker/worker.js?worker&url", () => ({ default: "" }))

const { reuseTimelineRows } = await import("./row-reconciliation")

const context = (key: string, partIDs: string[], userMessageID = "user-1") =>
  new TimelineRow.AssistantPart({
    userMessageID,
    group: {
      key,
      type: "context",
      refs: partIDs.map((partID) => ({ messageID: "assistant-1", partID })),
    } satisfies PartGroup,
    previousAssistantPart: false,
  })

const user = (userMessageID = "user-1") => new TimelineRow.UserMessage({ userMessageID, anchor: true })
const keys = (rows: TimelineRow.TimelineRow[]) => rows.map(TimelineRow.key)

describe("reuseTimelineRows", () => {
  test.each([
    {
      name: "reuses an unchanged context group",
      previous: [context("context:a", ["a", "b"])],
      rows: [context("context:a", ["a", "b"])],
      expected: ["assistant-part:user-1:context:a"],
      reused: [[0, 0]],
    },
    {
      name: "preserves the group key when a member is appended",
      previous: [context("context:a", ["a"])],
      rows: [context("context:a", ["a", "b"])],
      expected: ["assistant-part:user-1:context:a"],
      reused: [],
    },
    {
      name: "preserves the group key when the first member is removed",
      previous: [context("context:a", ["a", "b"])],
      rows: [context("context:b", ["b"])],
      expected: ["assistant-part:user-1:context:a"],
      reused: [],
    },
    {
      name: "lets only the natural owner retain an old key after a split",
      previous: [context("context:a", ["a", "b"])],
      rows: [context("context:a", ["a"]), context("context:b", ["b"])],
      expected: ["assistant-part:user-1:context:a", "assistant-part:user-1:context:b"],
      reused: [],
    },
    {
      name: "chooses the earliest prior key when groups merge",
      previous: [context("context:a", ["a"]), context("context:b", ["b"])],
      rows: [context("context:b", ["b", "a"])],
      expected: ["assistant-part:user-1:context:a"],
      reused: [],
    },
    {
      name: "reserves an old key for its natural owner when two new groups compete",
      previous: [context("context:a", ["a", "b"])],
      rows: [context("context:b", ["b"]), context("context:a", ["a"])],
      expected: ["assistant-part:user-1:context:b", "assistant-part:user-1:context:a"],
      reused: [],
    },
    {
      name: "does not reuse context identity across user messages",
      previous: [context("context:a", ["a", "b"], "user-1")],
      rows: [context("context:b", ["b"], "user-2")],
      expected: ["assistant-part:user-2:context:b"],
      reused: [],
    },
    {
      name: "reuses an unaffected ordinary row",
      previous: [user()],
      rows: [user()],
      expected: ["user-message:user-1"],
      reused: [[0, 0]],
    },
    {
      name: "does not create accidental key collisions",
      previous: [context("context:a", ["a", "b", "c"])],
      rows: [context("context:b", ["b"]), context("context:a", ["a"]), context("context:c", ["c"])],
      expected: [
        "assistant-part:user-1:context:b",
        "assistant-part:user-1:context:a",
        "assistant-part:user-1:context:c",
      ],
      reused: [],
    },
  ])("$name", ({ previous, rows, expected, reused }) => {
    const result = reuseTimelineRows([...previous], [...rows])

    expect(keys(result)).toEqual([...expected])
    expect(new Set(keys(result)).size).toBe(result.length)
    reused.forEach(([resultIndex, previousIndex]) => expect(result[resultIndex]).toBe(previous[previousIndex]))
  })
})

const rowsOfEveryTag = () => [
  new TimelineRow.TurnGap({ userMessageID: "user-1" }),
  new TimelineRow.CommentStrip({ userMessageID: "user-1" }),
  new TimelineRow.UserMessage({ userMessageID: "user-1", anchor: true }),
  new TimelineRow.TurnDivider({
    userMessageID: "user-1",
    label: "background",
    hookEvent: "Stop",
    hookReason: "reason",
    scheduleKind: "cron",
    scheduleDetail: "* * * * *",
  }),
  context("context:a", ["a", "b"]),
  new TimelineRow.AssistantPart({
    userMessageID: "user-1",
    group: { key: "part:assistant-1:c", type: "part", ref: { messageID: "assistant-1", partID: "c" } },
    previousAssistantPart: true,
    verbose: true,
    hideTrailingSuggestion: true,
  }),
  new TimelineRow.Thinking({ userMessageID: "user-1", reasoningHeading: "Planning" }),
  new TimelineRow.DiffSummary({
    userMessageID: "user-1",
    diffs: [{ file: "a.ts", patch: "@@", additions: 1, deletions: 2, status: "modified" }],
  }),
  new TimelineRow.Error({
    userMessageID: "user-1",
    text: "limit",
    usageLimit: { providerID: "provider", modelID: "model", resetAt: 1 },
  }),
  new TimelineRow.Retry({ userMessageID: "user-1" }),
  new TimelineRow.TaskSuggestion({ userMessageID: "user-1", title: "Next", prompt: "Do it", note: "why" }),
]

// One changed field per row, in rowsOfEveryTag order.
const changedRows = () => [
  new TimelineRow.TurnGap({ userMessageID: "user-2" }),
  new TimelineRow.CommentStrip({ userMessageID: "user-2" }),
  new TimelineRow.UserMessage({ userMessageID: "user-1", anchor: false }),
  new TimelineRow.TurnDivider({
    userMessageID: "user-1",
    label: "background",
    hookEvent: "Stop",
    hookReason: "other reason",
    scheduleKind: "cron",
    scheduleDetail: "* * * * *",
  }),
  context("context:a", ["a", "c"]),
  new TimelineRow.AssistantPart({
    userMessageID: "user-1",
    group: { key: "part:assistant-1:c", type: "part", ref: { messageID: "assistant-1", partID: "c" } },
    previousAssistantPart: true,
    verbose: true,
    hideTrailingSuggestion: undefined,
  }),
  new TimelineRow.Thinking({ userMessageID: "user-1", reasoningHeading: "Coding" }),
  new TimelineRow.DiffSummary({
    userMessageID: "user-1",
    diffs: [{ file: "a.ts", patch: "@@", additions: 3, deletions: 2, status: "modified" }],
  }),
  new TimelineRow.Error({
    userMessageID: "user-1",
    text: "limit",
    usageLimit: { providerID: "provider", modelID: "model", resetAt: 2 },
  }),
  new TimelineRow.Retry({ userMessageID: "user-2" }),
  new TimelineRow.TaskSuggestion({ userMessageID: "user-1", title: "Next", prompt: "Do it", note: "because" }),
]

describe("reuseTimelineRows row comparison", () => {
  test("reuses a freshly built but unchanged row of every tag", () => {
    const previous = rowsOfEveryTag()
    const result = reuseTimelineRows(previous, rowsOfEveryTag())

    expect(result).toBe(previous)
  })

  test("replaces a row when any of its fields change and keeps its key", () => {
    const previous = rowsOfEveryTag()
    const next = changedRows()
    const result = reuseTimelineRows(previous, next)

    result.forEach((row, index) => {
      expect(row).toBe(next[index]!)
      if (next[index]!.userMessageID === previous[index]!.userMessageID)
        expect(TimelineRow.key(row)).toBe(TimelineRow.key(previous[index]!))
    })
  })

  test("keeps earlier row identities when the active turn gains rows", () => {
    const previous = [user("user-1"), context("context:a", ["a"]), user("user-2")]
    const result = reuseTimelineRows(previous, [
      user("user-1"),
      context("context:a", ["a"]),
      user("user-2"),
      context("context:b", ["b"], "user-2"),
    ])

    expect(keys(result)).toEqual([
      "user-message:user-1",
      "assistant-part:user-1:context:a",
      "user-message:user-2",
      "assistant-part:user-2:context:b",
    ])
    previous.forEach((row, index) => expect(result[index]).toBe(row))
  })
})
