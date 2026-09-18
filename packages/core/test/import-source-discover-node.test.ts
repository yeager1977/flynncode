import { describe, expect, it, beforeAll, afterAll } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverFromHome } from "@opencode-ai/core/session/import-source/discover-node"

let home = ""

const line = (value: unknown) => JSON.stringify(value)

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "import-home-"))
  await mkdir(join(home, ".claude", "projects", "-work"), { recursive: true })
  await writeFile(
    join(home, ".claude", "projects", "-work", "aaa.jsonl"),
    line({
      type: "user",
      uuid: "u1",
      sessionId: "aaa",
      cwd: "/work",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "First prompt" },
    }),
  )
  await writeFile(join(home, ".claude", "projects", "-work", "notes.txt"), "ignore")

  await mkdir(join(home, ".codex", "sessions", "2026", "01", "01"), { recursive: true })
  await writeFile(
    join(home, ".codex", "sessions", "2026", "01", "01", "rollout-1.jsonl"),
    [
      line({ type: "session_meta", payload: { id: "01abc", cwd: "/repo" } }),
      line({ type: "event_msg", payload: { type: "user_message", message: "Hello" } }),
    ].join("\n"),
  )
})

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

describe("discoverFromHome", () => {
  it("finds claude code sessions and ignores non-jsonl files", async () => {
    const found = await discoverFromHome({ source: "claude-code", home })
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ sourceSessionID: "aaa", title: "First prompt", cwd: "/work" })
  })

  it("walks codex nested date directories", async () => {
    const found = await discoverFromHome({ source: "codex", home })
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ sourceSessionID: "01abc" })
  })

  it("returns an empty list when the source root is missing", async () => {
    const empty = await mkdtemp(join(tmpdir(), "import-home-empty-"))
    const found = await discoverFromHome({ source: "claude-code", home: empty })
    expect(found).toEqual([])
    await rm(empty, { recursive: true, force: true })
  })
})