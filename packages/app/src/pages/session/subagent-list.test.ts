import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  expandSubagent,
  latestAssistantModel,
  limitedTaskIDs,
  groupSubagents,
  mergeSubagents,
  subagentListState,
  subagentPreview,
  subagentState,
  tasksFromParts,
} from "./subagent-list"

describe("Tasks visibility boundary", () => {
  test("mounts the task list only in the header Tasks side panel", () => {
    const sidePanel = readFileSync(new URL("./session-side-panel.tsx", import.meta.url), "utf8")
    const terminalPanel = readFileSync(new URL("./terminal-panel.tsx", import.meta.url), "utf8")
    const terminalPanelV2 = readFileSync(new URL("./terminal-panel-v2.tsx", import.meta.url), "utf8")

    expect(sidePanel.match(/<Tabs\.Trigger value="tasks">/g) ?? []).toHaveLength(0)
    expect(sidePanel).not.toContain("sessionShowsSubagents")
    expect(sidePanel.match(/<Tabs\.Content value="tasks"/g) ?? []).toHaveLength(0)
    expect(sidePanel).toContain('id="tasks-panel"')
    expect(sidePanel).toContain('aria-label={language.t("session.tasks.resize")}')
    expect(sidePanel).toContain('edge="start"')
    const header = readFileSync(new URL("../../components/session/session-header.tsx", import.meta.url), "utf8")
    expect(header.match(/data-action="session-tasks-toggle"/g)).toHaveLength(2)
    expect(sidePanel).not.toMatch(/<Show when=\{tasksSelected\(\)\}>\s*<Tabs\.Content value="tasks"/)
    expect(sidePanel.match(/<Tabs value=\{panelTab\(\)\} onChange=\{activateTab\}>/g)).toHaveLength(2)

    for (const source of [terminalPanel, terminalPanelV2]) {
      expect(source).not.toContain("SubagentList")
    }
  })
})

const child = (id: string, status: "busy" | "retry" | "idle" | undefined, updated: number, text = "") => ({
  id,
  title: id,
  updated,
  status,
  text,
})

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
      () => true,
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
      () => true,
    )
    expect(running).toEqual([])
  })

  test("treats a background task as finished once its child is no longer live", () => {
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
      () => false,
    )
    expect(running).toEqual([])
  })

  test("keeps a finished child finished when its task output is still running", () => {
    const merged = mergeSubagents(
      [child("ses_done", "idle", 4, "finished text"), child("ses_live", "busy", 5, "still working")],
      tasksFromParts(
        [
          {
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              title: "Done task",
              metadata: { sessionId: "ses_done", background: true },
              output: '<task id="ses_done" state="running">working</task>',
            },
          },
          {
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              title: "Live task",
              metadata: { sessionId: "ses_live", background: true },
              output: '<task id="ses_live" state="running">working</task>',
            },
          },
        ],
        9,
        (id) => id === "ses_live",
      ),
    )
    expect(groupSubagents(merged).active.map((item) => item.id)).toEqual(["ses_live"])
    expect(groupSubagents(merged).finished.map((item) => item.id)).toEqual(["ses_done"])
    expect(merged.find((item) => item.id === "ses_done")?.text).toBe("finished text")
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
        () => false,
      ),
    )
    expect(groupSubagents(merged).active.map((item) => item.id)).toEqual(["ses_child"])
    expect(groupSubagents(merged).finished).toEqual([])
  })
})

describe("latestAssistantModel", () => {
  const user = { role: "user" as const }
  const assistant = (providerID: string, modelID: string, completed?: number) => ({
    role: "assistant" as const,
    providerID,
    modelID,
    time: { created: 1, ...(completed === undefined ? {} : { completed }) },
  })

  test("labels the newest assistant turn with provider/model", () => {
    expect(latestAssistantModel([user, assistant("anthropic", "claude-sonnet-5", 2), user])).toBe(
      "anthropic/claude-sonnet-5",
    )
  })

  test("an in-progress turn keeps the model it started with", () => {
    expect(
      latestAssistantModel([assistant("openai", "gpt-6-luna", 2), user, assistant("meta", "muse-wonder-full-1.0")]),
    ).toBe("meta/muse-wonder-full-1.0")
  })

  test("returns undefined until an assistant turn exists", () => {
    expect(latestAssistantModel([user])).toBeUndefined()
    expect(latestAssistantModel([])).toBeUndefined()
    expect(latestAssistantModel(undefined)).toBeUndefined()
    expect(latestAssistantModel([assistant("", "")])).toBeUndefined()
  })

  test("a task row carries its requested model until the child reports its own", () => {
    const tasks = tasksFromParts(
      [
        {
          type: "tool",
          tool: "task",
          state: {
            status: "running",
            title: "Build packages",
            input: { model: "ollama-cloud/glm-5.3-flash" },
            metadata: { sessionId: "ses_child" },
          },
        },
      ],
      10,
      () => false,
    )
    expect(tasks[0]?.model).toBe("ollama-cloud/glm-5.3-flash")
    const merged = mergeSubagents(
      [{ id: "ses_child", title: "Child", updated: 1, status: "busy", text: "", model: "anthropic/claude-sonnet-5" }],
      tasks,
    )
    expect(merged[0]?.model).toBe("anthropic/claude-sonnet-5")
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
    expect(expandSubagent({ expandedID: "b", finishedOpen: true }, { id: "b", finished: false })).toEqual({
      expandedID: undefined,
      finishedOpen: true,
    })
  })
})

describe("subagentState", () => {
  test("reads a working child as running even after a usage limit", () => {
    expect(subagentState({ status: "busy", limited: true })).toBe("running")
    expect(subagentState({ status: "retry" })).toBe("running")
  })

  test("reads a stopped usage-limited child as usage-limit", () => {
    expect(subagentState({ status: "idle", limited: true })).toBe("usage-limit")
    expect(subagentState({ status: undefined, limited: true })).toBe("usage-limit")
  })

  test("reads other stopped children as idle", () => {
    expect(subagentState({ status: "idle" })).toBe("idle")
    expect(subagentState({ status: undefined, limited: false })).toBe("idle")
  })

  test("keeps the limited flag when a task row merges into its session row", () => {
    const merged = mergeSubagents(
      [{ id: "c1", title: "Child", updated: 1, status: "idle", text: "", limited: true }],
      [{ id: "c1", title: "Task", updated: 1, status: "busy", text: "out" }],
    )
    expect(merged[0]?.limited).toBe(true)
  })
})

describe("limitedTaskIDs", () => {
  const foreground = (id: string, state: "completed" | "error", text: string) => ({
    type: "tool",
    tool: "task",
    state: {
      status: "completed",
      output: `<task id="${id}" state="${state}">\n<task_${state === "error" ? "error" : "result"}>\n${text}\n</task_${
        state === "error" ? "error" : "result"
      }>\n</task>`,
      metadata: { sessionId: id },
    },
  })

  test("finds children whose task output reports a usage-limit stop", () => {
    const limited = limitedTaskIDs([
      foreground("c1", "error", "Subagent stopped: usage limit reached on anthropic/sonnet."),
      foreground("c2", "completed", "all done"),
    ])
    expect([...limited]).toEqual(["c1"])
  })

  test("finds background stops injected as synthetic text parts", () => {
    const limited = limitedTaskIDs([
      {
        text: '<task id="c3" state="error">\n<summary>Background task stopped (usage limit): x</summary>\n<task_error>\nSubagent stopped: usage limit reached\n</task_error>\n</task>',
      },
    ])
    expect(limited.has("c3")).toBe(true)
  })

  test("a later completed result for the same task clears the limit", () => {
    const limited = limitedTaskIDs([
      foreground("c1", "error", "Subagent stopped: usage limit reached"),
      foreground("c1", "completed", "finished on another model"),
    ])
    expect(limited.has("c1")).toBe(false)
  })
})
