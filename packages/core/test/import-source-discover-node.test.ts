import { describe, expect, it, afterAll } from "bun:test"
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverFromHome } from "@opencode-ai/core/session/import-source/discover-node"

const line = (value: unknown) => JSON.stringify(value)

const createSymlink = async (target: string, linkPath: string) => {
  try {
    await symlink(target, linkPath)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "ENOSYS")) return false
    throw error
  }
}

const home = await mkdtemp(join(tmpdir(), "import-home-"))
const outside = await mkdtemp(join(tmpdir(), "import-outside-"))

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

await writeFile(
  join(outside, "secret.jsonl"),
  line({
    type: "user",
    uuid: "evil",
    sessionId: "evil",
    cwd: "/tmp",
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: "Secret content" },
  }),
)
const symlinkFileOk = await createSymlink(
  join(outside, "secret.jsonl"),
  join(home, ".claude", "projects", "-work", "evil.jsonl"),
)
const symlinkDirOk = await createSymlink(outside, join(home, ".codex", "sessions", "linked"))
const symlinksSupported = symlinkFileOk && symlinkDirOk

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
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

  it.skipIf(!symlinksSupported)("rejects symlinks pointing outside the store", async () => {
    const found = await discoverFromHome({ source: "claude-code", home })
    expect(found).toHaveLength(1)
    expect(found[0]?.sourceSessionID).toBe("aaa")
    expect(found.some((candidate) => candidate.path.endsWith("evil.jsonl"))).toBe(false)
    expect(found.some((candidate) => candidate.sourceSessionID === "evil")).toBe(false)
    const codex = await discoverFromHome({ source: "codex", home })
    expect(codex).toHaveLength(1)
    expect(codex[0]?.sourceSessionID).toBe("01abc")
  })
})