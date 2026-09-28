import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { expandSubagent, groupSubagents, mergeSubagents, subagentListState, subagentPreview, tasksFromParts } from "./subagent-list"

describe("Tasks visibility boundary", () => {
  test("keeps side-panel triggers unconditional while terminal docks remain session-gated", () => {
    const sidePanel = readFileSync(new URL("./session-side-panel.tsx", import.meta.url), "utf8")
    const terminalPanel = readFileSync(new URL("./terminal-panel.tsx", import.meta.url), "utf8")
    const terminalPanelV2 = readFileSync(new URL("./terminal-panel-v2.tsx", import.meta.url), "utf8")

    expect(sidePanel.match(/<Tabs\.Trigger value="tasks">/g)).toHaveLength(2)
    expect(sidePanel).not.toContain("sessionShowsSubagents")
    expect(sidePanel.match(/<Tabs\.Content value="tasks"/g)).toHaveLength(2)
    expect(sidePanel).not.toMatch(/<Show when=\{tasksSelected\(\)\}>\s*<Tabs\.Content value="tasks"/)
    expect(sidePanel.match(/<Tabs value=\{panelTab\(\)\} onChange=\{activateTab\}>/g)).toHaveLength(2)

    for (const source of [terminalPanel, terminalPanelV2]) {
      expect(source).toMatch(/const tasksOpen = createMemo\(\(\) =>\s*sessionShowsSubagents\(/)
      expect(source).toContain("<Show when={!opened() && tasksOpen()}>")
    }
  })
})

const child = (
  id: string,
  status: "busy" | "retry" | "idle" | undefined,
  updated: number,
  text = "",
) => ({ id, title: id, updated, status, text })

describe("groupSubagents", () => {
  test("puts busy and retry above idle, newest first", () => {
    const groups = groupSubagents([
      child("idle-old", "idle", 1),
      child("busy-old", "busy", 2),
      child("retry-new", "retry", 4),
      child("idle-new", "idle", 3),
      child("missing", undefined, 5),
    ])
    expect(groups.active.map((item) => item.id)).toEqual(["retry-new", "busy-old"])
    expect(groups.finished.map((item) => item.id)).toEqual(["missing", "idle-new", "idle-old"])
  })
})

describe("subagentListState", () => {
  test("shows the empty state until a child exists", () => {
    expect(subagentListState([])).toBe("empty")
    expect(subagentListState([child("child", "busy", 1)])).toBe("list")
  })
})

describe("subagentPreview", () => {
  test("uses the first line and drops extra whitespace", () => {
    expect(subagentPreview("  hello\nworld  ")).toBe("hello")
    expect(subagentPreview("")).toBe("")
    expect(subagentPreview("\n\n")).toBe("")
  })
})

describe("tasksFromParts", () => {
  test("keeps a background task visible while it is still running", () => {
    const running = tasksFromParts(
      [
        {
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            title: "Build packages",
            metadata: { sessionId: "ses_child", background: true },
            output: '<task id="ses_child" state="running">working</task>',
          },
        },
      ],
      10,
    )
    expect(running.map((item) => item.id)).toEqual(["ses_child"])
    expect(running[0]?.status).toBe("busy")
    expect(groupSubagents(running).active.map((item) => item.id)).toEqual(["ses_child"])
  })

  test("drops a background task after the completion notice", () => {
    const running = tasksFromParts(
      [
        {
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            title: "Build packages",
            metadata: { sessionId: "ses_child", background: true },
            output: '<task id="ses_child" state="running">working</task>',
          },
        },
        { type: "text", text: '<task id="ses_child" state="completed">done</task>' },
      ],
      11,
    )
    expect(running).toEqual([])
  })

  test("upgrades a child with no status when the parent task is still running", () => {
    const merged = mergeSubagents(
      [child("ses_child", undefined, 1, "")],
      tasksFromParts(
        [
          {
            type: "tool",
            tool: "task",
            state: { status: "running", title: "Build packages", metadata: { sessionId: "ses_child" } },
          },
        ],
        2,
      ),
    )
    expect(groupSubagents(merged).active.map((item) => item.id)).toEqual(["ses_child"])
    expect(groupSubagents(merged).finished).toEqual([])
  })
})

describe("expandSubagent", () => {
  test("replaces the expanded id and opens the finished group for a finished child", () => {
    expect(expandSubagent({ expandedID: "a", finishedOpen: false }, { id: "b", finished: false })).toEqual({
      expandedID: "b",
      finishedOpen: false,
    })
    expect(expandSubagent({ expandedID: "a", finishedOpen: false }, { id: "c", finished: true })).toEqual({
      expandedID: "c",
      finishedOpen: true,
    })
  })
})
