import { afterEach, describe, expect, test } from "bun:test"
import { groupInbox, listNeedsInput } from "../src/inbox.ts"

describe("groupInbox", () => {
  test("marks permission and question kinds separately", () => {
    const items = groupInbox({
      sessions: [{ id: "ses_1", title: "Fix login", directory: "/repo/app", updated: 100 }],
      permissions: [{ sessionID: "ses_1", id: "perm_1" }],
      questions: [],
    })
    expect(items).toEqual([
      { sessionID: "ses_1", directory: "/repo/app", title: "Fix login", kind: "permission", updated: 100 },
    ])
  })
})

let stub: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  stub?.stop(true)
  stub = undefined
})

function serveUpstream(fetch: (request: Request) => Response | Promise<Response>) {
  stub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })
  return `http://127.0.0.1:${stub.port}`
}

const pendingPermission = { id: "per_1", sessionID: "ses_9" }

describe("listNeedsInput partial failure", () => {
  test("surfaces pending requests with fallback metadata when the session list fails", async () => {
    const upstream = serveUpstream((request) => {
      const path = new URL(request.url).pathname
      if (path === "/api/permission/request") return Response.json({ data: [pendingPermission] })
      if (path === "/api/question/request") return Response.json({ data: [] })
      return new Response("down", { status: 500 })
    })
    const loaded = await listNeedsInput({ upstream, authorization: "Basic eA==" })
    expect(loaded.kind).toBe("loaded")
    if (loaded.kind !== "loaded") return
    expect(loaded.partial).toBe(true)
    expect(loaded.items).toEqual([
      { sessionID: "ses_9", directory: undefined, title: "ses_9", kind: "permission", updated: 0 },
    ])
  })

  test("marks partial when pending sources fail but sessions load", async () => {
    const upstream = serveUpstream((request) => {
      const path = new URL(request.url).pathname
      if (path === "/api/session") {
        return Response.json({
          data: [{ id: "ses_1", title: "Fix login", location: { directory: "/repo/app" }, time: { updated: 100 } }],
        })
      }
      return new Response("down", { status: 500 })
    })
    const loaded = await listNeedsInput({ upstream, authorization: "Basic eA==" })
    expect(loaded.kind).toBe("loaded")
    if (loaded.kind !== "loaded") return
    expect(loaded.partial).toBe(true)
    expect(loaded.items).toEqual([])
  })

  test("loads complete results without the partial flag when all sources succeed", async () => {
    const upstream = serveUpstream((request) => {
      const path = new URL(request.url).pathname
      if (path === "/api/permission/request") return Response.json({ data: [pendingPermission] })
      if (path === "/api/question/request") return Response.json({ data: [] })
      return Response.json({
        data: [{ id: "ses_9", title: "Fix login", location: { directory: "/repo/app" }, time: { updated: 100 } }],
      })
    })
    const loaded = await listNeedsInput({ upstream, authorization: "Basic eA==" })
    expect(loaded).toEqual({
      kind: "loaded",
      partial: false,
      items: [{ sessionID: "ses_9", directory: "/repo/app", title: "Fix login", kind: "permission", updated: 100 }],
    })
  })

  test("reports unreachable when every source fails", async () => {
    const upstream = serveUpstream(() => new Response("down", { status: 500 }))
    const loaded = await listNeedsInput({ upstream, authorization: "Basic eA==" })
    expect(loaded).toEqual({ kind: "unreachable" })
  })
})
