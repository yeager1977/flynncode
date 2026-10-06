import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Session } from "@/session/session"
import { SessionManageTool } from "../../src/tool/session-manage"
import { MessageID } from "../../src/session/schema"
import type { TaskPromptOps } from "../../src/tool/task"
import * as Tool from "../../src/tool/tool"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionProjector } from "@opencode-ai/core/session/projector"
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

const layer = () =>
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
  )

const it = testEffect(layer())

const ctx = (sessionID: string, asks: { permission: string; patterns: string[] }[] = []) =>
  ({
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (req: { permission: string; patterns: string[] }) =>
      Effect.sync(() => {
        asks.push({ permission: req.permission, patterns: req.patterns })
      }),
    extra: {} as { [key: string]: unknown },
  }) as unknown as Tool.Context

describe("tool.session_manage", () => {
  it.instance(
    "list excludes the asking session and archived sessions",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const self = yield* sessions.create({ title: "lead" })
        const other = yield* sessions.create({ title: "worker" })
        yield* sessions.create({ title: "hidden" })
        const archived = (yield* sessions.list({ limit: 20 })).find((item) => item.title === "hidden")
        if (archived) yield* sessions.setArchived({ sessionID: archived.id, time: Date.now() })

        const info = yield* SessionManageTool
        const def = yield* Tool.init(info)
        const result = yield* def.execute({ action: "list" }, ctx(self.id))

        expect(result.metadata.count).toBe(1)
        expect(result.output).toContain(other.id)
        expect(result.output).toContain("worker")
        expect(result.output).not.toContain("hidden")
        expect(result.output).not.toContain(self.id)
      }),
  )

  it.instance(
    "read returns a recent-turn digest",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const self = yield* sessions.create({ title: "lead" })
        const target = yield* sessions.create({ title: "worker" })
        const info = yield* SessionManageTool
        const def = yield* Tool.init(info)

        // An untouched session reports its emptiness rather than failing.
        const empty = yield* def.execute({ action: "read", session_id: target.id }, ctx(self.id))
        expect(empty.output).toContain("no recent text messages")

        const missing = yield* def.execute({ action: "read", session_id: "ses_missing" }, ctx(self.id)).pipe(Effect.exit)
        expect(Exit.isFailure(missing)).toBe(true)
      }),
  )

  it.instance(
    "rename validates non-empty titles",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const self = yield* sessions.create({ title: "lead" })
        const target = yield* sessions.create({ title: "worker" })
        const info = yield* SessionManageTool
        const def = yield* Tool.init(info)

        const blank = yield* def
          .execute({ action: "rename", session_id: target.id, title: "   " }, ctx(self.id))
          .pipe(Effect.exit)
        expect(Exit.isFailure(blank)).toBe(true)
        const unchanged = yield* sessions.get(target.id)
        expect(unchanged.title).toBe("worker")

        yield* def.execute({ action: "rename", session_id: target.id, title: "  Fix login  " }, ctx(self.id))
        const renamed = yield* sessions.get(target.id)
        expect(renamed.title).toBe("Fix login")
      }),
  )

  it.instance(
    "archive asks for permission and archives on approval",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const self = yield* sessions.create({ title: "lead" })
        const target = yield* sessions.create({ title: "worker" })
        const asks: { permission: string; patterns: string[] }[] = []
        const info = yield* SessionManageTool
        const def = yield* Tool.init(info)

        yield* def.execute({ action: "archive", session_id: target.id }, ctx(self.id, asks))

        expect(asks).toEqual([{ permission: "archive", patterns: [target.id] }])
        const archived = yield* sessions.get(target.id)
        expect(archived.time.archived).toBeDefined()

        // The archived session no longer shows up in list output.
        const listing = yield* def.execute({ action: "list" }, ctx(self.id))
        expect(listing.output).not.toContain(target.id)
      }),
  )

  it.instance(
    "archive without a session id fails",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const self = yield* sessions.create({ title: "lead" })
        const info = yield* SessionManageTool
        const def = yield* Tool.init(info)

        const exit = yield* def.execute({ action: "archive" }, ctx(self.id)).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
  )
})

describe("task-suggestion envelope parse", () => {
  const parse = (text: string) => {
    const match = text.match(/<task-suggestion\b([^>]*)>([\s\S]*?)<\/task-suggestion>/)
    if (!match) return
    const attrs: Record<string, string> = {}
    for (const item of (match[1] ?? "").matchAll(/([a-zA-Z_][\w-]*)="((?:[^"\\]|\\.)*)"/g)) {
      const name = item[1]
      if (!name) continue
      attrs[name] = (item[2] ?? "")
        .replace(/\\"/g, '"')
        .replace(/\\n/g, "\n")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
    }
    const title = (attrs.title ?? "").trim()
    const prompt = (attrs.prompt ?? "").trim()
    if (!title || !prompt) return
    const note = (match[2] ?? "").trim()
    return note ? { title, prompt, note } : { title, prompt }
  }

  test("parses title, prompt, and note", () => {
    const suggestion = parse('before <task-suggestion title="Fix flaky test" prompt="Stabilize suite-x flaky test">It keeps breaking CI.</task-suggestion>')
    expect(suggestion).toEqual({ title: "Fix flaky test", prompt: "Stabilize suite-x flaky test", note: "It keeps breaking CI." })
  })

  test("rejects missing title or prompt", () => {
    expect(parse('<task-suggestion prompt="only prompt">note</task-suggestion>')).toBeUndefined()
    expect(parse('<task-suggestion title="only title">note</task-suggestion>')).toBeUndefined()
    expect(parse("no envelope at all")).toBeUndefined()
  })

  test("handles escaped quotes and newlines in the prompt", () => {
    const suggestion = parse('<task-suggestion title="Chip" prompt="line one\\nline \\"two\\"">why</task-suggestion>')
    expect(suggestion?.prompt).toBe('line one\nline "two"')
  })
})