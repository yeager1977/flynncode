import { describe, expect, test } from "bun:test"
import { createPreviewTools, inertMessage, resolveRunning } from "../../src/plugin/preview"

const list = (servers: { name: string; state: string; url?: string }[]) =>
  Promise.resolve(servers as never)

describe("preview plugin tool", () => {
  const ctx = { directory: "/tmp/project", sessionID: "s", messageID: "m", agent: "build", worktree: "/tmp/project", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} }
  const execute = (tools: ReturnType<typeof createPreviewTools>, args: object) =>
    tools.verify_page.execute(args as never, ctx as never) as Promise<string>

  test("is inert when no preview servers are configured", async () => {
    const tools = createPreviewTools({
      list: () => list([]),
      post: () => Promise.resolve(undefined),
    })
    const result = await execute(tools, {})
    expect(result).toContain("No preview servers are configured")
    expect(result).toContain("preview.servers")
  })

  test("is inert when servers exist but none is running", async () => {
    const tools = createPreviewTools({
      list: () => list([{ name: "web", state: "stopped" }]),
      post: () => Promise.resolve(undefined),
    })
    const ctx = { directory: "/tmp/project" } as never
    const result = await execute(tools, {})
    expect(result).toBe(inertMessage())
  })

  test("names the server when a target is starting", async () => {
    const tools = createPreviewTools({
      list: () => list([{ name: "web", state: "starting" }]),
      post: () => Promise.resolve(undefined),
    })
    const result = (await tools.verify_page.execute({}, { directory: "/tmp/project" } as never)) as string
    expect(result).toContain('"web" is starting')
  })

  test("reports an unknown server name", async () => {
    const tools = createPreviewTools({
      list: () => list([{ name: "web", state: "stopped" }]),
      post: () => Promise.resolve(undefined),
    })
    const result = (await tools.verify_page.execute({ name: "other" }, { directory: "/tmp/project" } as never)) as string
    expect(result).toContain('Unknown preview server "other"')
    expect(result).toContain("web")
  })

  test("reports the fetched verify result for a running server", async () => {
    const tools = createPreviewTools({
      list: () => list([{ name: "web", state: "running", url: "http://localhost:4519/" }]),
      post: (path) => {
        expect(path).toBe("/preview/servers/verify")
        return Promise.resolve({ url: "http://localhost:4519/", httpStatus: 200, title: "ok page", errorCount: 0 })
      },
    })
    const result = (await tools.verify_page.execute({}, { directory: "/tmp/project" } as never)) as string
    expect(result).toContain("URL: http://localhost:4519/")
    expect(result).toContain("HTTP status: 200")
    expect(result).toContain("Title: ok page")
    expect(result).toContain("Error markers: 0")
  })

  test("flags an HTTP error status", async () => {
    const tools = createPreviewTools({
      list: () => list([{ name: "web", state: "running", url: "http://localhost:4519/" }]),
      post: () => Promise.resolve({ url: "http://localhost:4519/", httpStatus: 500, errorCount: 1 }),
    })
    const result = (await tools.verify_page.execute({}, { directory: "/tmp/project" } as never)) as string
    expect(result).toContain("HTTP status: 500")
    expect(result).toContain("HTTP error")
  })

  test("resolveRunning prefers an explicit name over a running server", () => {
    const servers = [
      { name: "a", state: "running" },
      { name: "b", state: "stopped" },
    ]
    expect(resolveRunning(servers as never, "b")).toEqual({ name: "b", state: "stopped" })
  })

  test("resolveRunning falls back to the first running server", () => {
    const servers = [
      { name: "a", state: "stopped" },
      { name: "b", state: "running" },
    ]
    expect((resolveRunning(servers as never) as { name: string } | undefined)?.name).toBe("b")
    expect(resolveRunning([] as never)).toBeUndefined()
  })

  test("resolveRunning reports a missing name distinctly", () => {
    expect(resolveRunning([] as never, "ghost")).toEqual({ missing: "ghost" })
  })
})