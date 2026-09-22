import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import { groupSessionArtifacts, type ArtifactGroup, type SessionDiffData } from "./sidebar-artifacts"

const diff = (file: string, additions = 1, deletions = 0): FileDiffInfo => ({ file, patch: "", additions, deletions, status: "modified" })

const session = (input: Partial<Session> & Pick<Session, "id" | "directory">) =>
  ({
    title: "",
    version: "v2",
    parentID: undefined,
    messageCount: 0,
    permissions: { session: {}, share: {} },
    time: { created: 0, updated: 0, archived: undefined },
    ...input,
  }) as Session

const store = (directory: string, sessions: Session[], diffs: Record<string, FileDiffInfo[]>): SessionDiffData => ({
  path: { directory },
  session: sessions,
  session_diff: diffs,
})

describe("sidebar artifacts", () => {
  test("returns empty list without diffs", () => {
    const result = groupSessionArtifacts(store("/proj", [session({ id: "s1", directory: "/proj", title: "One" })], {}), "/proj")
    expect(result).toEqual([])
  })

  test("returns empty list for empty sessions", () => {
    const result = groupSessionArtifacts(store("/proj", [], { s1: [diff("a.ts")] }), "/proj")
    expect(result).toEqual([])
  })

  test("groups diffs under their session", () => {
    const result = groupSessionArtifacts(
      store(
        "/proj",
        [session({ id: "s1", directory: "/proj", title: "Fix bug", time: { created: 1, updated: 2, archived: undefined } })],
        { s1: [diff("src/a.ts"), diff("src/b.ts")] },
      ),
      "/proj",
    )
    expect(result.length).toBe(1)
    expect(result[0]?.sessionID).toBe("s1")
    expect(result[0]?.title).toBe("Fix bug")
    expect(result[0]?.files.map((item) => item.file)).toEqual(["src/a.ts", "src/b.ts"])
  })

  test("orders sessions newest first", () => {
    const result = groupSessionArtifacts(
      store(
        "/proj",
        [
          session({ id: "old", directory: "/proj", title: "Old", time: { created: 1, updated: 10, archived: undefined } }),
          session({ id: "new", directory: "/proj", title: "New", time: { created: 1, updated: 20, archived: undefined } }),
        ],
        { old: [diff("a.ts")], new: [diff("b.ts")] },
      ),
      "/proj",
    )
    expect(result.map((item) => item.sessionID)).toEqual(["new", "old"])
  })

  test("ignores sessions outside the active project directory", () => {
    const result = groupSessionArtifacts(
      store(
        "/proj",
        [
          session({ id: "in", directory: "/proj", title: "In", time: { created: 1, updated: 30, archived: undefined } }),
          session({ id: "out", directory: "/other", title: "Out", time: { created: 1, updated: 40, archived: undefined } }),
        ],
        { in: [diff("a.ts")], out: [diff("b.ts")] },
      ),
      "/proj",
    )
    expect(result.map((item) => item.sessionID)).toEqual(["in"])
  })

  test("ignores archived sessions", () => {
    const result = groupSessionArtifacts(
      store(
        "/proj",
        [session({ id: "s1", directory: "/proj", title: "Archived", time: { created: 1, updated: 2, archived: 2 } })],
        { s1: [diff("a.ts")] },
      ),
      "/proj",
    )
    expect(result).toEqual([])
  })

  test("caps grouped sessions at 20 newest", () => {
    const sessions = Array.from({ length: 30 }, (_, index) =>
      session({ id: `s${index}`, directory: "/proj", title: `S${index}`, time: { created: index, updated: index, archived: undefined } }),
    )
    const diffs: Record<string, FileDiffInfo[]> = {}
    for (const item of sessions) diffs[item.id] = [diff("a.ts")]
    const result = groupSessionArtifacts(store("/proj", sessions, diffs), "/proj")
    expect(result.length).toBe(20)
    expect(result[0]?.sessionID).toBe("s29")
  })

  test("tolerates missing session records for diff keys", () => {
    const result = groupSessionArtifacts(store("/proj", [], { ghost: [diff("a.ts")] }), "/proj")
    expect(result).toEqual([])
  })

  test("normalizes directory comparison through pathKey", () => {
    const result = groupSessionArtifacts(
      store(
        "/proj",
        [session({ id: "s1", directory: "/proj/", title: "Trailing", time: { created: 1, updated: 2, archived: undefined } })],
        { s1: [diff("a.ts")] },
      ),
      "/proj/",
    )
    expect(result.map((item) => item.sessionID)).toEqual(["s1"])
  })
})

describe("artifact group shape", () => {
  test("exposes newest file order and per-session file count", () => {
    const groups: ArtifactGroup[] = groupSessionArtifacts(
      store(
        "/proj",
        [session({ id: "s1", directory: "/proj", title: "One", time: { created: 1, updated: 5, archived: undefined } })],
        { s1: [diff("a.ts", 3, 1), diff("b.ts", 0, 2)] },
      ),
      "/proj",
    )
    const group = groups[0]
    expect(group?.updated).toBe(5)
    expect(group?.files.length).toBe(2)
    expect(group?.files[0]?.additions).toBe(3)
    expect(group?.files[1]?.deletions).toBe(2)
  })
})
