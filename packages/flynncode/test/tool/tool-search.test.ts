import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { Session } from "@/session/session"
import { McpLoaded } from "@/mcp/loaded"
import { ToolSearch } from "../../src/tool/tool-search"
import { MessageID } from "../../src/session/schema"
import { Tool } from "../../src/tool/tool"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { Database } from "@flynncode/core/database/database"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Ripgrep } from "@flynncode/core/ripgrep"
import { SessionProjector } from "@flynncode/core/session/projector"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [],
  ),
)

const ctx = (sessionID: string) =>
  ({
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
    extra: {},
  }) as unknown as Tool.Context

const entry = (id: string, description: string, properties: Record<string, object> = {}) => ({
  id,
  description,
  inputSchema: { type: "object", properties },
})

const catalog = [
  entry("github_list_issues", "List issues in a GitHub repository", {
    repo: { type: "string", description: "owner/name" },
  }),
  entry("github_create_issue", "Create a new issue", { title: { type: "string" } }),
  entry("github_get_pull_request", "Fetch one pull request"),
  entry("browser_navigate", "Navigate the browser to a URL", { url: { type: "string" } }),
  entry("browser_click", "Click an element on the page", { selector: { type: "string" } }),
  entry("context7_resolve_library_id", "Resolve a package name to a library id"),
]

const run = (deferred: ReturnType<typeof entry>[], args: { query: string; max_results?: number }) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "lead" })
    const def = yield* Tool.init(yield* ToolSearch.make({ deferred }))
    const result = yield* def.execute(args, ctx(session.id))
    return { result, session: yield* sessions.get(session.id) }
  })

describe("tool.mcp_tool_search", () => {
  it.instance("select: loads exact names with description and schema", () =>
    Effect.gen(function* () {
      const out = yield* run(catalog, { query: "select:browser_click,github_list_issues" })
      expect(out.result.metadata.loaded).toEqual(["browser_click", "github_list_issues"])
      expect(out.result.metadata.query).toBe("select:browser_click,github_list_issues")
      expect(out.result.output).toContain("browser_click")
      expect(out.result.output).toContain("Click an element on the page")
      expect(out.result.output).toContain('"selector"')
      expect(out.result.output).toContain('"repo"')
      expect(out.result.output).not.toContain("browser_navigate")
      expect(McpLoaded.get(out.session).toSorted()).toEqual(["browser_click", "github_list_issues"])
    }),
  )

  it.instance("select: reports a stale name and still loads the others", () =>
    Effect.gen(function* () {
      const out = yield* run(catalog, { query: "select:github_gone, browser_click" })
      expect(out.result.output).toContain("no such tool: github_gone")
      expect(out.result.metadata.loaded).toEqual(["browser_click"])
      expect(McpLoaded.get(out.session)).toEqual(["browser_click"])
    }),
  )

  it.instance("keyword search ranks name matches above description matches", () =>
    Effect.gen(function* () {
      const out = yield* run([entry("notes_list", "Mentions issues in passing"), ...catalog], { query: "issues" })
      // Plural and singular name matches tie and fall back to id order.
      expect(out.result.metadata.loaded).toEqual(["github_create_issue", "github_list_issues", "notes_list"])
      expect(out.result.metadata.loaded).not.toContain("browser_click")
    }),
  )

  it.instance("max_results defaults to 5 and is capped at 20", () =>
    Effect.gen(function* () {
      const many = Array.from({ length: 30 }, (_, i) => entry(`svc_tool_${String(i).padStart(2, "0")}`, "svc helper"))
      const fallback = yield* run(many, { query: "svc" })
      expect(fallback.result.metadata.loaded).toHaveLength(5)
      const capped = yield* run(many, { query: "svc", max_results: 50 })
      expect(capped.result.metadata.loaded).toHaveLength(20)
      const small = yield* run(many, { query: "svc", max_results: 2 })
      expect(small.result.metadata.loaded).toEqual(["svc_tool_00", "svc_tool_01"])
    }),
  )

  it.instance("output over the cap lists names only and asks to narrow the query", () =>
    Effect.gen(function* () {
      const huge = Array.from({ length: 4 }, (_, i) =>
        entry(`big_tool_${i}`, "big helper", { blob: { type: "string", description: "x".repeat(10_000) } }),
      )
      const out = yield* run(huge, { query: "big" })
      expect(out.result.output.length).toBeLessThan(25_000)
      expect(out.result.output).toContain("big_tool_3")
      expect(out.result.output).not.toContain("xxxxxxxxxx")
      expect(out.result.output).toContain("narrow your query")
      expect(out.result.metadata.loaded).toHaveLength(4)
    }),
  )

  it.instance("select: with only stale names loads nothing and does not throw", () =>
    Effect.gen(function* () {
      const out = yield* run(catalog, { query: "select:github_gone,browser_missing" })
      expect(out.result.metadata.loaded).toEqual([])
      expect(out.result.output).toContain("no such tool: github_gone")
      expect(out.result.output).toContain("no such tool: browser_missing")
      expect(McpLoaded.get(out.session)).toEqual([])
    }),
  )

  it.instance("select: prefix is case-insensitive", () =>
    Effect.gen(function* () {
      const out = yield* run(catalog, { query: "  Select:browser_click" })
      expect(out.result.metadata.loaded).toEqual(["browser_click"])
    }),
  )

  it.instance("select: loads at most 20 names and notes the rest", () =>
    Effect.gen(function* () {
      const many = Array.from({ length: 25 }, (_, i) => entry(`svc_tool_${String(i).padStart(2, "0")}`, "svc helper"))
      const out = yield* run(many, { query: `select:${many.map((item) => item.id).join(",")}` })
      expect(out.result.metadata.loaded).toHaveLength(20)
      expect(out.result.metadata.loaded).not.toContain("svc_tool_20")
      expect(out.result.output).toContain("5 extra name(s) were ignored")
      expect(McpLoaded.get(out.session)).toHaveLength(20)
    }),
  )

  it.instance("output cap counts bytes, not characters", () =>
    Effect.gen(function* () {
      const wide = Array.from({ length: 3 }, (_, i) =>
        entry(`wide_tool_${i}`, "wide helper", { blob: { type: "string", description: "é".repeat(8_000) } }),
      )
      const out = yield* run(wide, { query: "wide" })
      // About 24k characters but about 48k bytes: must take the names-only path.
      expect(out.result.output).toContain("narrow your query")
      expect(out.result.output).not.toContain("éééé")
      expect(Buffer.byteLength(out.result.output)).toBeLessThan(25_000)
      expect(out.result.metadata.loaded).toHaveLength(3)
    }),
  )

  it.instance("no match against an empty catalog has no blank suggestion line", () =>
    Effect.gen(function* () {
      const out = yield* run([], { query: "anything" })
      expect(out.result.output).toBe('No deferred tools matched "anything".')
      const stale = yield* run([], { query: "select:gone" })
      expect(stale.result.output).toBe("no such tool: gone")
    }),
  )

  it.instance("no match suggests the closest names and loads nothing", () =>
    Effect.gen(function* () {
      const out = yield* run(catalog, { query: "browsr_clik" })
      expect(out.result.metadata.loaded).toEqual([])
      expect(out.result.output).toContain("No deferred tools matched")
      expect(out.result.output).toContain("browser_click")
      expect(McpLoaded.get(out.session)).toEqual([])
    }),
  )
})

describe("McpLoaded", () => {
  it.instance("merges loaded ids without clobbering other metadata keys", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "child" })
      yield* sessions.setMetadata({
        sessionID: session.id,
        metadata: { worktree: "/work/tree", sandbox: "workspace", disposable: true },
      })
      const first = yield* McpLoaded.add(sessions, session.id, ["a_one", "b_two"])
      const second = yield* McpLoaded.add(sessions, session.id, ["b_two", "c_three"])
      expect(first).toEqual(["a_one", "b_two"])
      expect(second).toEqual(["a_one", "b_two", "c_three"])
      const stored = yield* sessions.get(session.id)
      expect(stored.metadata).toEqual({
        worktree: "/work/tree",
        sandbox: "workspace",
        disposable: true,
        mcpLoaded: ["a_one", "b_two", "c_three"],
      })
      expect(McpLoaded.get(stored)).toEqual(["a_one", "b_two", "c_three"])
    }),
  )

  it.instance("concurrent adds keep every id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "parallel" })
      yield* Effect.all(
        ["a", "b", "c", "d"].map((id) => McpLoaded.add(sessions, session.id, [id])),
        { concurrency: "unbounded" },
      )
      expect(McpLoaded.get(yield* sessions.get(session.id)).toSorted()).toEqual(["a", "b", "c", "d"])
    }),
  )

  it.instance("get ignores malformed metadata", () =>
    Effect.sync(() => {
      expect(McpLoaded.get({ metadata: undefined })).toEqual([])
      expect(McpLoaded.get({ metadata: { mcpLoaded: "nope" } })).toEqual([])
      expect(McpLoaded.get({ metadata: { mcpLoaded: ["ok", 3, null] } })).toEqual(["ok"])
    }),
  )

  it.instance("mcp_tool_search keeps worktree and sandbox metadata", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "child" })
      yield* sessions.setMetadata({ sessionID: session.id, metadata: { worktree: "/w", sandbox: "readonly" } })
      const def = yield* Tool.init(yield* ToolSearch.make({ deferred: catalog }))
      yield* def.execute({ query: "select:browser_navigate" }, ctx(session.id))
      const stored = yield* sessions.get(session.id)
      expect(stored.metadata).toEqual({ worktree: "/w", sandbox: "readonly", mcpLoaded: ["browser_navigate"] })
    }),
  )

  it.instance("prune drops stale ids and keeps other metadata keys", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "prune" })
      yield* sessions.setMetadata({ sessionID: session.id, metadata: { worktree: "/w", sandbox: "readonly" } })
      yield* McpLoaded.add(sessions, session.id, ["a_one", "b_two", "c_three"])
      const kept = yield* McpLoaded.prune(sessions, session.id, (id) => ["a_one", "c_three", "d_new"].includes(id))
      expect(kept).toEqual(["a_one", "c_three"])
      const stored = yield* sessions.get(session.id)
      expect(stored.metadata).toEqual({ worktree: "/w", sandbox: "readonly", mcpLoaded: ["a_one", "c_three"] })
      // Adding after a prune keeps working on the pruned set.
      expect(yield* McpLoaded.add(sessions, session.id, ["b_two"])).toEqual(["a_one", "c_three", "b_two"])
    }),
  )

  it.instance("prune and add skip the write when nothing changes", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "quiet" })
      yield* McpLoaded.add(sessions, session.id, ["a_one", "b_two"])
      const before = (yield* sessions.get(session.id)).time.updated
      yield* Effect.promise(() => Bun.sleep(10))
      expect(yield* McpLoaded.prune(sessions, session.id, (id) => ["a_one", "b_two", "z"].includes(id))).toEqual([
        "a_one",
        "b_two",
      ])
      expect(yield* McpLoaded.add(sessions, session.id, ["a_one"])).toEqual(["a_one", "b_two"])
      expect((yield* sessions.get(session.id)).time.updated).toBe(before)
      // A real change does bump the updated time, so the assertion above is meaningful.
      yield* McpLoaded.prune(sessions, session.id, (id) => ["a_one"].includes(id))
      expect((yield* sessions.get(session.id)).time.updated).toBeGreaterThan(before)
    }),
  )
})
