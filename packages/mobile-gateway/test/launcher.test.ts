import { describe, expect, test } from "bun:test"
import { groupSessions, projectLabel, relativeTime, sessionSlug } from "../src/launcher.ts"

const session = (id: string, directory: string | undefined, updated: number, title = id) => ({
  id,
  title,
  directory,
  updated,
})

describe("sessionSlug", () => {
  test("matches the app's URL-safe base64 encoding", () => {
    expect(sessionSlug("/home/yeager1977/GitHub/flynncode")).toBe("L2hvbWUveWVhZ2VyMTk3Ny9HaXRIdWIvZmx5bm5jb2Rl")
  })

  test("encodes the root directory without padding", () => {
    expect(sessionSlug("/")).toBe("Lw")
  })

  test("produces url-safe characters only", () => {
    expect(sessionSlug("/tmp/a+b?c/d")).not.toMatch(/[+/=]/)
  })
})

describe("projectLabel", () => {
  test("uses the final path segment", () => {
    expect(projectLabel("/home/yeager1977/GitHub/flynncode")).toBe("flynncode")
  })

  test("renders the root directory as a slash", () => {
    expect(projectLabel("/")).toBe("/")
  })

  test("ignores trailing slashes", () => {
    expect(projectLabel("/home/yeager1977/GitHub/flynncode/")).toBe("flynncode")
  })

  test("names a missing directory", () => {
    expect(projectLabel(undefined)).toBe("Unknown project")
  })
})

describe("relativeTime", () => {
  const now = 1_700_000_000_000

  test("describes recent updates", () => {
    expect(relativeTime(now - 5_000, now)).toBe("just now")
    expect(relativeTime(now - 12 * 60_000, now)).toBe("12m ago")
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago")
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago")
  })

  test("never reports a negative age", () => {
    expect(relativeTime(now + 60_000, now)).toBe("just now")
  })
})

describe("groupSessions", () => {
  test("groups sessions by directory, newest group first", () => {
    const data = groupSessions({
      sessions: [
        session("s1", "/a", 100),
        session("s2", "/b", 300),
        session("s3", "/a", 200),
      ],
      running: [],
    })
    expect(data.groups.map((group) => group.directory)).toEqual(["/b", "/a"])
    expect(data.groups[0].label).toBe("b")
    expect(data.groups[1].sessions.map((item) => item.id)).toEqual(["s3", "s1"])
  })

  test("orders sessions inside a group newest first", () => {
    const data = groupSessions({
      sessions: [session("old", "/a", 100), session("new", "/a", 500)],
      running: [],
    })
    expect(data.groups[0].sessions.map((item) => item.id)).toEqual(["new", "old"])
  })

  test("separates running sessions from recent ones", () => {
    const data = groupSessions({
      sessions: [session("s1", "/a", 100), session("s2", "/a", 200)],
      running: ["s1"],
    })
    expect(data.running.map((item) => item.id)).toEqual(["s1"])
    expect(data.groups[0].sessions.map((item) => item.id)).toEqual(["s2"])
  })

  test("includes a running session missing from the recent list", () => {
    const data = groupSessions({ sessions: [], running: ["ses_abcdef123456"] })
    expect(data.running).toHaveLength(1)
    expect(data.running[0].directory).toBeUndefined()
    expect(data.running[0].title).toBe("ses_abcdef12")
  })

  test("places sessions without a directory last", () => {
    const data = groupSessions({
      sessions: [session("s1", undefined, 999), session("s2", "/a", 1)],
      running: [],
    })
    expect(data.groups.map((group) => group.directory)).toEqual(["/a", ""])
    expect(data.groups[1].label).toBe("Unknown project")
  })

  test("returns empty results for no sessions", () => {
    const data = groupSessions({ sessions: [], running: [] })
    expect(data).toEqual({ running: [], groups: [] })
  })
})