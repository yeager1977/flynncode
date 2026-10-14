import { describe, expect, it, afterAll } from "bun:test"
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverFromHome, resolveSourceFile } from "@flynncode/core/session/import-source/discover-node"

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
    expect(found[0]).toMatchObject({ sourceSessionID: "aaa", title: "First prompt", cwd: "/work" })
    expect(found.some((candidate) => candidate.path.endsWith("evil.jsonl"))).toBe(false)
    expect(found.some((candidate) => candidate.sourceSessionID === "evil")).toBe(false)
    const codex = await discoverFromHome({ source: "codex", home })
    expect(codex).toHaveLength(1)
    expect(codex[0]?.sourceSessionID).toBe("01abc")
  })
})

describe("discoverFromHome summaries", () => {
  const claudeLine = (sessionId: string, cwd: string, content: string, timestamp: string) =>
    line({ type: "user", sessionId, cwd, timestamp, message: { role: "user", content } })

  it("filters by cwd, including nested directories, for both sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "import-cwd-"))
    await mkdir(join(root, ".claude", "projects", "-repo"), { recursive: true })
    await mkdir(join(root, ".claude", "projects", "-repo-sub"), { recursive: true })
    await mkdir(join(root, ".claude", "projects", "-other"), { recursive: true })
    await writeFile(join(root, ".claude", "projects", "-repo", "a.jsonl"), claudeLine("a", "/repo", "A", "2026-01-01T00:00:00.000Z"))
    await writeFile(join(root, ".claude", "projects", "-repo-sub", "b.jsonl"), claudeLine("b", "/repo/sub", "B", "2026-01-02T00:00:00.000Z"))
    await writeFile(join(root, ".claude", "projects", "-other", "c.jsonl"), claudeLine("c", "/other", "C", "2026-01-03T00:00:00.000Z"))
    await mkdir(join(root, ".codex", "sessions", "2026"), { recursive: true })
    await writeFile(
      join(root, ".codex", "sessions", "2026", "r1.jsonl"),
      [
        line({ type: "session_meta", payload: { id: "r1", cwd: "/repo" } }),
        line({ type: "event_msg", payload: { type: "user_message", message: "Hi" } }),
      ].join("\n"),
    )
    await writeFile(
      join(root, ".codex", "sessions", "2026", "r2.jsonl"),
      [
        line({ type: "session_meta", payload: { id: "r2", cwd: "/repository" } }),
        line({ type: "event_msg", payload: { type: "user_message", message: "Hi" } }),
      ].join("\n"),
    )

    const claude = await discoverFromHome({ source: "claude-code", home: root, cwd: "/repo" })
    expect(claude.map((item) => item.sourceSessionID)).toEqual(["b", "a"])
    expect(claude[0]).toMatchObject({ messageCount: 1, time: Date.parse("2026-01-02T00:00:00.000Z"), cwd: "/repo/sub" })
    const codex = await discoverFromHome({ source: "codex", home: root, cwd: "/repo" })
    expect(codex.map((item) => item.sourceSessionID)).toEqual(["r1"])
    expect((await discoverFromHome({ source: "claude-code", home: root })).map((item) => item.sourceSessionID)).toEqual([
      "c",
      "b",
      "a",
    ])
    await rm(root, { recursive: true, force: true })
  })

  it("re-reads a file only after it changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "import-cache-"))
    const file = join(root, ".claude", "projects", "-work", "s.jsonl")
    await mkdir(join(root, ".claude", "projects", "-work"), { recursive: true })
    await writeFile(file, claudeLine("s", "/work", "First", "2026-01-01T00:00:00.000Z"))
    expect((await discoverFromHome({ source: "claude-code", home: root }))[0]?.messageCount).toBe(1)
    await writeFile(
      file,
      [
        claudeLine("s", "/work", "First", "2026-01-01T00:00:00.000Z"),
        claudeLine("s", "/work", "Second", "2026-01-01T00:01:00.000Z"),
      ].join("\n"),
    )
    expect((await discoverFromHome({ source: "claude-code", home: root }))[0]?.messageCount).toBe(2)
    await rm(root, { recursive: true, force: true })
  })
})

describe("resolveSourceFile", () => {
  it.skipIf(!symlinksSupported)("accepts files under a symlinked source root", async () => {
    const real = await mkdtemp(join(tmpdir(), "import-real-claude-"))
    const linkedHome = await mkdtemp(join(tmpdir(), "import-linked-home-"))
    await mkdir(join(real, "projects", "-work"), { recursive: true })
    await writeFile(join(real, "projects", "-work", "s.jsonl"), line({ type: "user" }))
    await symlink(real, join(linkedHome, ".claude"))
    const resolved = await resolveSourceFile({
      source: "claude-code",
      home: linkedHome,
      path: join(linkedHome, ".claude", "projects", "-work", "s.jsonl"),
    })
    expect(resolved?.path.endsWith("s.jsonl")).toBe(true)
    await rm(real, { recursive: true, force: true })
    await rm(linkedHome, { recursive: true, force: true })
  })

  it("accepts a jsonl file inside the source store", async () => {
    const resolved = await resolveSourceFile({
      source: "claude-code",
      home,
      path: join(home, ".claude", "projects", "-work", "aaa.jsonl"),
    })
    expect(resolved).toBeDefined()
    expect(resolved?.source).toBe("claude-code")
    expect(resolved?.path.endsWith("aaa.jsonl")).toBe(true)
  })

  it("rejects a path outside the source store", async () => {
    const resolved = await resolveSourceFile({ source: "claude-code", home, path: join(outside, "secret.jsonl") })
    expect(resolved).toBeUndefined()
  })

  it("rejects a symlink inside the store pointing outside", async () => {
    const resolved = await resolveSourceFile({
      source: "claude-code",
      home,
      path: join(home, ".claude", "projects", "-work", "evil.jsonl"),
    })
    expect(resolved).toBeUndefined()
  })

  it("rejects a non-jsonl file", async () => {
    const resolved = await resolveSourceFile({
      source: "claude-code",
      home,
      path: join(home, ".claude", "projects", "-work", "notes.txt"),
    })
    expect(resolved).toBeUndefined()
  })

  it("rejects a missing file", async () => {
    const resolved = await resolveSourceFile({
      source: "claude-code",
      home,
      path: join(home, ".claude", "projects", "-work", "missing.jsonl"),
    })
    expect(resolved).toBeUndefined()
  })

  it("rejects a path from a different source store", async () => {
    const resolved = await resolveSourceFile({ source: "codex", home, path: join(home, ".claude", "projects", "-work", "aaa.jsonl") })
    expect(resolved).toBeUndefined()
  })
})
describe("discoverFromHome codex thread names", () => {
  it("titles codex sessions from session_index.jsonl, falling back to the first prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "import-names-"))
    const dir = join(root, ".codex", "sessions", "2026", "10", "13")
    await mkdir(dir, { recursive: true })
    const rollout = (id: string, prompt: string) =>
      [
        line({ type: "session_meta", payload: { id, cwd: "/repo" } }),
        line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } }),
      ].join("\n")
    await writeFile(join(dir, "rollout-a.jsonl"), rollout("01named", "Long first prompt about adapters"))
    await writeFile(join(dir, "rollout-b.jsonl"), rollout("01unnamed", "Unnamed prompt"))
    await writeFile(
      join(root, ".codex", "session_index.jsonl"),
      [
        line({ id: "01named", thread_name: "Old name" }),
        line({ id: "01named", thread_name: "Add standalone EIDO adapter package" }),
      ].join("\n"),
    )
    const found = await discoverFromHome({ source: "codex", home: root })
    expect(Object.fromEntries(found.map((item) => [item.sourceSessionID, item.title]))).toEqual({
      "01named": "Add standalone EIDO adapter package",
      "01unnamed": "Unnamed prompt",
    })
    await rm(root, { recursive: true, force: true })
  })
})
