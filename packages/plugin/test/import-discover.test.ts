import { describe, expect, it } from "bun:test"
import { discover } from "../src/import/discover"

const files: Record<string, string> = {
  "/home/u/.claude/projects/-work/aaa.jsonl": [
    JSON.stringify({
      type: "user",
      uuid: "u1",
      sessionId: "aaa",
      cwd: "/work",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "First prompt" },
    }),
  ].join("\n"),
  "/home/u/.claude/projects/-work/notes.txt": "ignore me",
}

const dirs: Record<string, string[]> = {
  "/home/u/.claude/projects": ["/home/u/.claude/projects/-work"],
  "/home/u/.claude/projects/-work": [
    "/home/u/.claude/projects/-work/aaa.jsonl",
    "/home/u/.claude/projects/-work/notes.txt",
  ],
}

const codexFiles: Record<string, string> = {
  "/home/u/.codex/sessions/2026/01/05/rollout-a.jsonl": [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-01-05T10:00:00.000Z",
      payload: { id: "01a", cwd: "/repo-a" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-01-05T10:00:01.000Z",
      payload: { type: "user_message", message: "Codex one" },
    }),
  ].join("\n"),
  "/home/u/.codex/sessions/2026/01/05/rollout-b.jsonl": [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-01-05T11:00:00.000Z",
      payload: { id: "01b", cwd: "/repo-b" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-01-05T11:00:01.000Z",
      payload: { type: "user_message", message: "Codex two" },
    }),
  ].join("\n"),
}

const codexDirs: Record<string, string[]> = {
  "/home/u/.codex/sessions": ["/home/u/.codex/sessions/2026"],
  "/home/u/.codex/sessions/2026": ["/home/u/.codex/sessions/2026/01"],
  "/home/u/.codex/sessions/2026/01": ["/home/u/.codex/sessions/2026/01/05"],
  "/home/u/.codex/sessions/2026/01/05": [
    "/home/u/.codex/sessions/2026/01/05/rollout-a.jsonl",
    "/home/u/.codex/sessions/2026/01/05/rollout-b.jsonl",
  ],
}

describe("discover", () => {
  it("lists claude code sessions with titles and counts", async () => {
    const found = await discover({
      source: "claude-code",
      home: "/home/u",
      read: async (path) => files[path],
      list: async (dir) => dirs[dir] ?? [],
    })
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      source: "claude-code",
      sourceSessionID: "aaa",
      title: "First prompt",
      cwd: "/work",
      messageCount: 1,
    })
  })

  it("returns an empty list when the source root is missing", async () => {
    const found = await discover({
      source: "claude-code",
      home: "/home/u",
      read: async () => undefined,
      list: async (dir) => dirs[dir] ?? [],
    })
    expect(found.filter((item) => item.sourceSessionID === "aaa")).toHaveLength(0)
  })

  it("walks nested codex date directories and sorts newest first", async () => {
    const found = await discover({
      source: "codex",
      home: "/home/u",
      read: async (path) => codexFiles[path],
      list: async (dir) => codexDirs[dir] ?? [],
    })
    expect(found).toHaveLength(2)
    expect(found.map((item) => item.sourceSessionID)).toEqual(["01b", "01a"])
    expect(found[0]).toMatchObject({
      source: "codex",
      title: "Codex two",
      cwd: "/repo-b",
      messageCount: 1,
    })
  })
})