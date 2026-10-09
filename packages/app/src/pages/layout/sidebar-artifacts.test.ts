import { beforeEach, describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import {
  artifactMatchesFilter,
  artifactSessionHref,
  artifactTargetHref,
  artifactVersionSignal,
  filterArtifactGroups,
  groupSessionArtifacts,
  loadArtifactFilter,
  loadStoredArtifacts,
  saveArtifactFilter,
  storeArtifact,
  type Artifact,
  type ArtifactGroup,
  type ArtifactInput,
  type SessionDiffData,
  type StoredArtifact,
} from "./sidebar-artifacts"

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

const stored = (artifact: ArtifactInput, id = "art_1", created = 1): StoredArtifact => ({ ...artifact, id, created })

describe("sidebar artifacts", () => {
  test("returns empty list without diffs", () => {
    const result = groupSessionArtifacts(store("/proj", [session({ id: "s1", directory: "/proj", title: "One" })], {}), "/proj")
    expect(result).toEqual([])
  })

  test("returns empty list for empty sessions", () => {
    const result = groupSessionArtifacts(store("/proj", [], { s1: [diff("a.ts")] }), "/proj")
    expect(result).toEqual([])
  })

  test("groups diffs under their session as typed diff artifacts", () => {
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
    expect(result[0]?.artifacts.map((item) => item.type)).toEqual(["diff", "diff"])
    expect(result[0]?.artifacts.map((item) => item.type === "diff" && item.file)).toEqual(["src/a.ts", "src/b.ts"])
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

  test("caps grouped sessions at 20 newest diffs", () => {
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

describe("typed artifact union", () => {
  test("merges stored screenshot and note artifacts into their session group", () => {
    const result = groupSessionArtifacts(
      store(
        "/proj",
        [session({ id: "s1", directory: "/proj", title: "One", time: { created: 1, updated: 5, archived: undefined } })],
        { s1: [diff("a.ts")] },
      ),
      "/proj",
      [
        stored({ type: "screenshot", sessionID: "s1", url: "http://127.0.0.1:3000", note: "hero", thumbnail: "data:image/png;base64,AAA" }, "art_s", 2),
        stored({ type: "note", sessionID: "s1", text: "too wide" }, "art_n", 3),
      ],
    )
    expect(result.length).toBe(1)
    expect(result[0]?.artifacts.map((item) => item.type)).toEqual(["diff", "screenshot", "note"])
    const shot = result[0]?.artifacts[1]
    expect(shot?.type === "screenshot" && shot.thumbnail).toBe("data:image/png;base64,AAA")
    const note = result[0]?.artifacts[2]
    expect(note?.type === "note" && note.text).toBe("too wide")
  })

  test("creates a group for stored artifacts without diffs", () => {
    const result = groupSessionArtifacts(
      store(
        "/proj",
        [session({ id: "s1", directory: "/proj", title: "Shots", time: { created: 1, updated: 5, archived: undefined } })],
        {},
      ),
      "/proj",
      [stored({ type: "screenshot", sessionID: "s1", url: "http://localhost:4444" })],
    )
    expect(result.length).toBe(1)
    expect(result[0]?.title).toBe("Shots")
    expect(result[0]?.artifacts[0]?.type).toBe("screenshot")
  })

  test("keeps stored groups beyond the 20 diff group cap", () => {
    const sessions = Array.from({ length: 30 }, (_, index) =>
      session({ id: `s${index}`, directory: "/proj", title: `S${index}`, time: { created: index, updated: index, archived: undefined } }),
    )
    const diffs: Record<string, FileDiffInfo[]> = {}
    for (const item of sessions) diffs[item.id] = [diff("a.ts")]
    const result = groupSessionArtifacts(store("/proj", sessions, diffs), "/proj", [
      stored({ type: "note", sessionID: "s0", text: "oldest session note" }),
    ])
    expect(result.length).toBe(21)
    const oldest = result.find((group) => group.sessionID === "s0")
    expect(oldest?.artifacts.map((item) => item.type)).toEqual(["note"])
  })

  test("drops stored artifacts for archived or unknown sessions", () => {
    const result = groupSessionArtifacts(
      store(
        "/proj",
        [session({ id: "s1", directory: "/proj", title: "Archived", time: { created: 1, updated: 2, archived: 2 } })],
        {},
      ),
      "/proj",
      [
        stored({ type: "note", sessionID: "s1", text: "hidden" }),
        stored({ type: "note", sessionID: "ghost", text: "hidden" }),
      ],
    )
    expect(result).toEqual([])
  })
})

describe("artifact filter", () => {
  const artifacts: Artifact[] = [
    { type: "diff", sessionID: "s1", file: "a.ts", additions: 1, deletions: 0 },
    { type: "file", sessionID: "s1", file: "b.ts" },
    { type: "screenshot", sessionID: "s1", url: "http://localhost" },
    { type: "note", sessionID: "s1", text: "note" },
  ]

  test("matches every artifact for all", () => {
    expect(artifacts.filter((artifact) => artifactMatchesFilter(artifact, "all")).length).toBe(4)
  })

  test("matches diff and file artifacts for changed", () => {
    expect(artifacts.filter((artifact) => artifactMatchesFilter(artifact, "changed")).map((item) => item.type)).toEqual(["diff", "file"])
  })

  test("matches screenshot artifacts for screenshots", () => {
    expect(artifacts.filter((artifact) => artifactMatchesFilter(artifact, "screenshots")).map((item) => item.type)).toEqual(["screenshot"])
  })

  test("matches note artifacts for notes", () => {
    expect(artifacts.filter((artifact) => artifactMatchesFilter(artifact, "notes")).map((item) => item.type)).toEqual(["note"])
  })

  test("filterArtifactGroups drops empty groups and keeps matching artifacts", () => {
    const groups: ArtifactGroup[] = [
      { sessionID: "s1", title: "One", directory: "/proj", updated: 1, artifacts },
      { sessionID: "s2", title: "Two", directory: "/proj", updated: 2, artifacts: [{ type: "note", sessionID: "s2", text: "only note" }] },
    ]
    const changed = filterArtifactGroups(groups, "changed")
    expect(changed.map((group) => group.sessionID)).toEqual(["s1"])
    expect(changed[0]?.artifacts.length).toBe(2)
    const notes = filterArtifactGroups(groups, "notes")
    expect(notes.map((group) => group.sessionID)).toEqual(["s1", "s2"])
    expect(filterArtifactGroups(groups, "all")).toBe(groups)
  })
})

describe("artifact persistence", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test("filter defaults to all and roundtrips through localStorage", () => {
    expect(loadArtifactFilter()).toBe("all")
    saveArtifactFilter("screenshots")
    expect(loadArtifactFilter()).toBe("screenshots")
  })

  test("filter ignores invalid stored values", () => {
    localStorage.setItem("opencode.sidebar-artifacts.filter", "bogus")
    expect(loadArtifactFilter()).toBe("all")
  })

  test("stored artifacts roundtrip per directory", () => {
    const shot = storeArtifact("/proj", { type: "screenshot", sessionID: "s1", url: "http://localhost:3000", note: "hero" })
    const note = storeArtifact("/proj", { type: "note", sessionID: "s1", text: "too wide" })
    expect(shot?.id).toBeString()
    expect(shot?.created).toBeNumber()
    const loaded = loadStoredArtifacts("/proj")
    expect(loaded.map((item) => item.id)).toEqual([note!.id, shot!.id])
    expect(loaded[1]?.type === "screenshot" && loaded[1].note).toBe("hero")
    expect(loadStoredArtifacts("/other")).toEqual([])
  })

  test("tolerates invalid stored payloads", () => {
    localStorage.setItem("opencode.sidebar-artifacts./proj", "not json")
    expect(loadStoredArtifacts("/proj")).toEqual([])
    localStorage.setItem("opencode.sidebar-artifacts./proj", JSON.stringify([{ type: "note" }, { bogus: true }]))
    expect(loadStoredArtifacts("/proj")).toEqual([])
  })

  test("caps stored artifacts at 100 dropping oldest", () => {
    for (let index = 0; index < 105; index++) storeArtifact("/proj", { type: "note", sessionID: "s1", text: `n${index}` })
    const loaded = loadStoredArtifacts("/proj")
    expect(loaded.length).toBe(100)
    expect(loaded[0]?.type === "note" && loaded[0].text).toBe("n104")
    expect(loaded.some((item) => item.type === "note" && item.text === "n0")).toBe(false)
  })

  test("bumps the version signal on each storeArtifact write", () => {
    const before = artifactVersionSignal()
    storeArtifact("/proj", { type: "note", sessionID: "s1", text: "versioned" })
    expect(artifactVersionSignal()).toBeGreaterThan(before)
    storeArtifact("/proj", { type: "note", sessionID: "s1", text: "versioned again" })
    expect(artifactVersionSignal()).toBeGreaterThan(before + 1)
  })
})

describe("artifactSessionHref", () => {
  test("points at the session and the changed file", () => {
    expect(artifactSessionHref("abc", "ses_1", "src/a.ts")).toBe("/abc/session/ses_1?file=src%2Fa.ts")
  })
})

describe("artifactTargetHref", () => {
  test("adds the file query for diff and file artifacts", () => {
    expect(
      artifactTargetHref("/server/a/session/ses_1", { type: "diff", sessionID: "ses_1", file: "src/a b.ts", additions: 1, deletions: 0 }),
    ).toBe("/server/a/session/ses_1?file=src%2Fa%20b.ts")
    expect(artifactTargetHref("/server/a/session/ses_1", { type: "file", sessionID: "ses_1", file: "x.ts" })).toBe(
      "/server/a/session/ses_1?file=x.ts",
    )
  })
  test("opens the session itself for screenshots and notes", () => {
    expect(artifactTargetHref("/server/a/session/ses_1", { type: "note", sessionID: "ses_1", text: "hi" })).toBe(
      "/server/a/session/ses_1",
    )
    expect(
      artifactTargetHref("/server/a/session/ses_1", { type: "screenshot", sessionID: "ses_1", url: "http://x" }),
    ).toBe("/server/a/session/ses_1")
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
    expect(group?.artifacts.length).toBe(2)
    const first = group?.artifacts[0]
    const second = group?.artifacts[1]
    expect(first?.type === "diff" && first.additions).toBe(3)
    expect(second?.type === "diff" && second.deletions).toBe(2)
  })
})
