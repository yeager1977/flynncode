import { describe, expect, test } from "bun:test"
import type { SessionExportData } from "@/utils/session-export"
import { deriveSessionHistory, filterHistoryEntries } from "./session-history"

function toolMessage(
  id: string,
  tool: string,
  input: Record<string, unknown>,
  status: "completed" | "error",
  created: number,
) {
  return {
    info: {
      id,
      sessionID: "ses_1",
      role: "assistant",
      time: { created },
      parentID: "parent",
      modelID: "model",
      providerID: "provider",
      mode: "mode",
      agent: "agent",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: `part_${id}`,
        sessionID: "ses_1",
        messageID: id,
        type: "tool",
        callID: `call_${id}`,
        tool,
        state: {
          status,
          input,
          output: "ok",
          title: tool,
          metadata: {},
          time: { start: created, end: created },
        },
      },
    ],
  } as unknown as SessionExportData["messages"][number]
}

describe("deriveSessionHistory", () => {
  test("maps bash runs, file changes, and notes in time order", () => {
    const entries = deriveSessionHistory({
      sessionID: "ses_1",
      messages: [
        toolMessage("m1", "bash", { command: "bun test" }, "completed", 10),
        toolMessage("m2", "edit", { file: "src/a.ts" }, "completed", 20),
      ],
      diffs: [{ file: "src/b.ts", patch: "", additions: 2, deletions: 1, status: "modified" }],
      stored: [{ id: "art_1", type: "note", sessionID: "ses_1", text: "ship it", created: 30 }],
    })
    expect(entries.map((entry) => entry.kind)).toEqual(["run", "change", "change", "note"])
    expect(entries[0].detail).toContain("bun test")
    expect(entries[1].file).toBe("src/a.ts")
  })

  test("counts permission prompts as approvals", () => {
    const entries = deriveSessionHistory({
      sessionID: "ses_1",
      messages: [
        {
          ...toolMessage("m3", "bash", { command: "rm -rf /tmp/x", permissionAsked: true }, "completed", 10),
        },
      ],
      diffs: [],
      stored: [],
    })
    expect(entries.map((entry) => entry.kind)).toEqual(["run", "approval"])
  })

  test("filters by text query across title, detail, and file", () => {
    const entries = deriveSessionHistory({
      sessionID: "ses_1",
      messages: [toolMessage("m1", "bash", { command: "bun test" }, "completed", 10)],
      diffs: [],
      stored: [],
    })
    expect(filterHistoryEntries(entries, "bun").length).toBe(1)
    expect(filterHistoryEntries(entries, "zzz").length).toBe(0)
    expect(filterHistoryEntries(entries, "").length).toBe(1)
  })
})
