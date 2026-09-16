import { describe, expect, test } from "bun:test"
import { groupSessions, loadLauncher, projectLabel, relativeTime, sessionSlug } from "../src/launcher.ts"

const session = (id: string, directory: string | undefined, updated: number, title = id, subagent = false) => ({
  id,
  title,
  directory,
  updated,
  subagent,
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

  test("omits subagent sessions from recent groups", () => {
    const data = groupSessions({
      sessions: [session("main", "/a", 100), session("helper", "/a", 900, "helper", true)],
      running: [],
    })
    expect(data.groups[0].sessions.map((item) => item.id)).toEqual(["main"])
  })

  test("still shows a running subagent so activity stays visible", () => {
    const data = groupSessions({
      sessions: [session("main", "/a", 100), session("helper", "/a", 900, "helper", true)],
      running: ["helper"],
    })
    expect(data.running.map((item) => item.id)).toEqual(["helper"])
    expect(data.running[0].subagent).toBe(true)
    expect(data.groups[0].sessions.map((item) => item.id)).toEqual(["main"])
  })
})

const upstreamWith = (fetch: (request: Request) => Response | Promise<Response>) =>
  Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })

const AUTH = `Basic ${Buffer.from("opencode:secret").toString("base64")}`

describe("loadLauncher", () => {
  test("loads running and recent sessions", async () => {
    const upstream = upstreamWith((request) => {
      const path = new URL(request.url).pathname
      if (request.headers.get("authorization") !== AUTH) return new Response("no", { status: 401 })
      if (path === "/api/session/active") return Response.json({ data: { ses_1: { type: "running" } } })
      if (path === "/api/session") {
        return Response.json({
          data: [
            {
              id: "ses_1",
              title: "Running one",
              location: { directory: "/work/a" },
              time: { updated: 500 },
            },
            {
              id: "ses_2",
              title: "Recent one",
              location: { directory: "/work/a" },
              time: { updated: 400 },
            },
          ],
        })
      }
      return new Response("not found", { status: 404 })
    })

    const result = await loadLauncher({ upstream: `http://127.0.0.1:${upstream.port}`, authorization: AUTH })
    upstream.stop(true)

    expect(result.kind).toBe("loaded")
    if (result.kind !== "loaded") return
    expect(result.partial).toBe(false)
    expect(result.data.running.map((item) => item.id)).toEqual(["ses_1"])
    expect(result.data.groups[0].sessions.map((item) => item.id)).toEqual(["ses_2"])
  })

  test("sends the limit and order query the endpoint expects", async () => {
    const seen: string[] = []
    const upstream = upstreamWith((request) => {
      const url = new URL(request.url)
      if (url.pathname === "/api/session") {
        seen.push(url.search)
        return Response.json({ data: [] })
      }
      return Response.json({ data: {} })
    })

    await loadLauncher({ upstream: `http://127.0.0.1:${upstream.port}`, authorization: AUTH })
    upstream.stop(true)

    expect(seen).toEqual(["?limit=30&order=desc"])
  })

  test("reports unreachable when both calls fail", async () => {
    const result = await loadLauncher({ upstream: "http://127.0.0.1:1", authorization: AUTH })
    expect(result).toEqual({ kind: "unreachable" })
  })

  test("reports partial when one call fails", async () => {
    const upstream = upstreamWith((request) => {
      const path = new URL(request.url).pathname
      if (path === "/api/session/active") return new Response("boom", { status: 500 })
      return Response.json({ data: [] })
    })

    const result = await loadLauncher({ upstream: `http://127.0.0.1:${upstream.port}`, authorization: AUTH })
    upstream.stop(true)

    expect(result.kind).toBe("loaded")
    if (result.kind !== "loaded") return
    expect(result.partial).toBe(true)
  })

  test("drops malformed session entries without throwing", async () => {
    const upstream = upstreamWith((request) => {
      const path = new URL(request.url).pathname
      if (path === "/api/session") {
        return Response.json({
          data: [null, 42, { title: "no id" }, { id: "ok", time: { updated: "nope" } }],
        })
      }
      return Response.json({ data: {} })
    })

    const result = await loadLauncher({ upstream: `http://127.0.0.1:${upstream.port}`, authorization: AUTH })
    upstream.stop(true)

    expect(result.kind).toBe("loaded")
    if (result.kind !== "loaded") return
    expect(result.data.groups[0].sessions).toHaveLength(1)
    expect(result.data.groups[0].sessions[0].id).toBe("ok")
    expect(result.data.groups[0].sessions[0].updated).toBe(0)
    expect(result.data.groups[0].sessions[0].title).toBe("ok")
    expect(result.data.groups[0].sessions[0].subagent).toBe(false)
  })

  test("marks a session with a parentID as a subagent and filters it from groups", async () => {
    const upstream = upstreamWith((request) => {
      const path = new URL(request.url).pathname
      if (path === "/api/session") {
        return Response.json({
          data: [
            { id: "main", title: "Main", location: { directory: "/a" }, time: { updated: 5 } },
            {
              id: "child",
              parentID: "main",
              title: "Child",
              location: { directory: "/a" },
              time: { updated: 9 },
            },
          ],
        })
      }
      return Response.json({ data: {} })
    })

    const result = await loadLauncher({ upstream: `http://127.0.0.1:${upstream.port}`, authorization: AUTH })
    upstream.stop(true)

    expect(result.kind).toBe("loaded")
    if (result.kind !== "loaded") return
    expect(result.data.groups[0].sessions.map((item) => item.id)).toEqual(["main"])
  })

  test("drops archived sessions the way the app's home list does", async () => {
    const upstream = upstreamWith((request) => {
      const path = new URL(request.url).pathname
      if (path === "/api/session") {
        return Response.json({
          data: [
            { id: "visible", title: "Visible", location: { directory: "/a" }, time: { updated: 9 } },
            {
              id: "archived",
              title: "Archived",
              location: { directory: "/a" },
              time: { updated: 99, archived: 1234 },
            },
          ],
        })
      }
      return Response.json({ data: {} })
    })

    const result = await loadLauncher({ upstream: `http://127.0.0.1:${upstream.port}`, authorization: AUTH })
    upstream.stop(true)

    expect(result.kind).toBe("loaded")
    if (result.kind !== "loaded") return
    expect(result.data.groups[0].sessions.map((item) => item.id)).toEqual(["visible"])
  })

  test("does not follow redirects", async () => {
    const upstream = upstreamWith(() => new Response(null, { status: 302, headers: { location: "http://elsewhere" } }))
    const result = await loadLauncher({ upstream: `http://127.0.0.1:${upstream.port}`, authorization: AUTH })
    upstream.stop(true)
    expect(result).toEqual({ kind: "unreachable" })
  })

  test("honors a base path prefix on the upstream", async () => {
    const seen: string[] = []
    const upstream = upstreamWith((request) => {
      const url = new URL(request.url)
      seen.push(url.pathname)
      if (url.pathname.endsWith("/api/session/active")) return Response.json({ data: {} })
      return Response.json({ data: [] })
    })

    await loadLauncher({ upstream: `http://127.0.0.1:${upstream.port}/base`, authorization: AUTH })
    upstream.stop(true)

    expect(seen).toEqual(["/base/api/session/active", "/base/api/session"])
  })

  test("reports unauthorized when the session endpoint rejects the credential", async () => {
    const upstream = upstreamWith((request) => {
      const path = new URL(request.url).pathname
      if (path === "/api/session") return new Response("no", { status: 401 })
      return Response.json({ data: {} })
    })

    const result = await loadLauncher({ upstream: `http://127.0.0.1:${upstream.port}`, authorization: AUTH })
    upstream.stop(true)

    expect(result).toEqual({ kind: "unauthorized" })
  })

  test("reports unauthorized when only the active endpoint rejects the credential", async () => {
    const upstream = upstreamWith((request) => {
      const path = new URL(request.url).pathname
      if (path === "/api/session/active") return new Response("no", { status: 401 })
      return Response.json({ data: [] })
    })

    const result = await loadLauncher({ upstream: `http://127.0.0.1:${upstream.port}`, authorization: AUTH })
    upstream.stop(true)

    expect(result).toEqual({ kind: "unauthorized" })
  })

  test("keeps a server error on the session endpoint partial instead of unauthorized", async () => {
    const upstream = upstreamWith((request) => {
      const path = new URL(request.url).pathname
      if (path === "/api/session") return new Response("boom", { status: 500 })
      return Response.json({ data: {} })
    })

    const result = await loadLauncher({ upstream: `http://127.0.0.1:${upstream.port}`, authorization: AUTH })
    upstream.stop(true)

    expect(result.kind).toBe("loaded")
    if (result.kind !== "loaded") return
    expect(result.partial).toBe(true)
  })
})