import { ConfigV1 } from "@flynncode/core/v1/config/config"
import { SessionV1 } from "@flynncode/core/v1/session"
import { Database } from "@flynncode/core/database/database"
import { SessionScheduleTable } from "@flynncode/core/session/sql"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { SessionProjector } from "@flynncode/core/session/projector"
import { FSUtil } from "@flynncode/core/fs-util"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { Ripgrep } from "@flynncode/core/ripgrep"
import { ProviderV2 } from "@flynncode/core/provider"
import { ModelV2 } from "@flynncode/core/model"
import { expect } from "bun:test"
import { Deferred, Effect, Exit, Layer, Scope } from "effect"
import path from "path"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Env } from "@/env"
import { Git } from "@/git"
import { Image } from "@/image/image"
import { Question } from "@/question"
import { Todo } from "@/session/todo"
import { Session } from "@/session/session"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { SessionCompaction } from "@/session/compaction"
import { SessionSummary } from "@/session/summary"
import { Instruction } from "@/session/instruction"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { MessageID, SessionID } from "@/session/schema"
import { Skill } from "@/skill"
import { SystemPrompt } from "@/session/system"
import { Snapshot } from "@/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Format } from "@/format"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { HooksRunner } from "@/hooks/runner"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Scheduler } from "@/schedule/scheduler"
import { ScheduleStore } from "@/schedule/store"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

// Scheduled prompts delivered through the real SessionPrompt, the real
// database and the test LLM server. Each test drives `tick(now)` directly.

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    start: () => Effect.succeed("unavailable"),
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    instructions: () => Effect.succeed([]),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    resourceTemplates: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in scheduler tests"),
    authenticate: () => Effect.die("unexpected MCP auth in scheduler tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in scheduler tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

// The real bootstrap loads config before tests write their opencode.json.
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

const llmServer = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Plugin.node,
      SessionPrompt.node,
      Session.node,
      SessionProjector.node,
      MessageV2.node,
      Snapshot.node,
      LLM.node,
      Env.node,
      Agent.node,
      Command.node,
      Permission.node,
      Config.node,
      Provider.node,
      LSP.node,
      MCP.node,
      FSUtil.node,
      BackgroundJob.node,
      SessionStatus.node,
      SessionRunState.node,
      Database.node,
      EventV2Bridge.node,
      Question.node,
      Todo.node,
      ToolRegistry.node,
      Skill.node,
      Git.node,
      Ripgrep.node,
      Format.node,
      Truncate.node,
      SessionProcessor.node,
      Image.node,
      SessionCompaction.node,
      SessionRevert.node,
      Instruction.node,
      SystemPrompt.node,
      CrossSpawnSpawner.node,
      RuntimeFlags.node,
      ScheduleStore.node,
      llmServer,
      HooksRunner.node,
    ]),
    [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, mcp],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true, bypassHookTrust: true })],
      [InstanceStore.bootstrapNode, noopBootstrap],
    ],
  ),
)
const unix = process.platform !== "win32" ? it.instance : it.instance.skip

const MINUTE = 60_000
const start = new Date("2026-10-27T10:00:30")
// The first */5 match after `start`.
const due = new Date("2026-10-27T10:05:00")

const provider = (url: string) => ({
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: url },
    },
  },
  model: "test/test-model",
})

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const readLines = (file: string) =>
  Effect.promise(async () => {
    const handle = Bun.file(file)
    if (!(await handle.exists())) return []
    return (await handle.text()).split("\n").filter((line) => line.trim() !== "")
  })

// A session that already had one ordinary turn, with a UserPromptSubmit hook
// recording every prompt it sees.
const setup = Effect.fn("test.setup")(function* () {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  const hooked = path.join(dir, "prompts.jsonl")
  yield* writeText(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      ...provider(llm.url),
    } satisfies Partial<ConfigV1.Info>),
  )
  yield* writeText(
    path.join(dir, ".claude", "settings.json"),
    JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `{ cat; echo; } >> "${hooked}"` }] }] },
    }),
  )
  const config = yield* Config.Service
  yield* config.get()
  // The test process shares one database; earlier tests' jobs would otherwise come due in this one's ticks.
  const { db } = yield* Database.Service
  yield* db.delete(SessionScheduleTable).run()
  const sessions = yield* Session.Service
  const prompt = yield* SessionPrompt.Service
  const store = yield* ScheduleStore.Service
  const chat = yield* sessions.create({
    title: "Pinned",
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })
  yield* llm.text("first answer")
  yield* prompt.prompt({ sessionID: chat.id, agent: "plan", parts: [{ type: "text", text: "start" }] })
  return { dir, llm, chat, sessions, prompt, store, hooked }
})

const cron = (sessionID: SessionID, input?: { recurring?: boolean }) => ({
  sessionID,
  kind: "cron" as const,
  cron: "*/5 * * * *",
  prompt: "check the build",
  recurring: input?.recurring ?? true,
  now: start,
})

const scheduled = (message: SessionV1.WithParts) =>
  message.parts.flatMap((part) => (part.type === "text" && part.metadata?.schedule ? [part] : []))

const scheduledMessages = (sessions: Session.Interface, sessionID: SessionID) =>
  sessions
    .messages({ sessionID })
    .pipe(Effect.map((items) => items.filter((item) => item.info.role === "user" && scheduled(item).length > 0)))

// Waits until the session has `count` finished assistant messages and is idle.
const settled = (sessionID: SessionID, count: number) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const items = yield* sessions.messages({ sessionID })
      const finished = items.filter((item) => item.info.role === "assistant" && item.info.time.completed !== undefined)
      if (finished.length < count) return undefined
      return (yield* status.get(sessionID)).type === "idle" ? items : undefined
    }),
    `session ${sessionID} never settled with ${count} assistant messages`,
    "10 seconds",
  )

const lastUserText = (input: Record<string, unknown> | undefined) => {
  const messages = input?.messages
  if (!Array.isArray(messages)) throw new Error("expected LLM messages")
  const last = messages.at(-1)
  expect(last?.role).toBe("user")
  return JSON.stringify(last?.content)
}

unix(
  "a due job fires into an idle session as a queued synthetic prompt",
  () =>
    Effect.gen(function* () {
      const { llm, chat, sessions, store } = yield* setup()
      yield* settled(chat.id, 1)
      const job = yield* store.create(cron(chat.id))
      const scheduler = yield* Scheduler.make({ now: () => due })

      yield* llm.text("scheduled answer")
      yield* scheduler.tick()
      yield* settled(chat.id, 2)

      expect(yield* llm.calls).toBe(2)
      expect(lastUserText((yield* llm.inputs).at(-1))).toContain("check the build")
      const [message] = yield* scheduledMessages(sessions, chat.id)
      expect(message?.info.role === "user" && message.info.agent).toBe("plan")
      expect(message && scheduled(message)).toEqual([
        expect.objectContaining({
          synthetic: true,
          text: "check the build",
          metadata: { schedule: { id: job.id, kind: "cron", cron: "*/5 * * * *" } },
        }),
      ])
      const [stored] = yield* store.list(chat.id)
      expect(stored?.next_run_at).toBe(new Date("2026-10-27T10:10:00").getTime())
      expect(stored?.pending_message_id).toBe(message?.info.id ?? null)
      expect(stored?.lease_until).toBeNull()

      // The first prompt was answered, so the next slot delivers again.
      yield* llm.text("second scheduled answer")
      yield* scheduler.tick(new Date("2026-10-27T10:10:00"))
      yield* settled(chat.id, 3)
      expect(yield* scheduledMessages(sessions, chat.id)).toHaveLength(2)
    }),
  30_000,
)

unix(
  "a scheduled prompt runs no UserPromptSubmit hook",
  () =>
    Effect.gen(function* () {
      const { llm, chat, store, hooked } = yield* setup()
      yield* settled(chat.id, 1)
      expect(yield* readLines(hooked)).toHaveLength(1)
      yield* store.create(cron(chat.id))
      const scheduler = yield* Scheduler.make({ now: () => due })

      yield* llm.text("scheduled answer")
      yield* scheduler.tick()
      yield* settled(chat.id, 2)

      expect(yield* readLines(hooked)).toHaveLength(1)
    }),
  30_000,
)

unix(
  "a busy session gets the prompt after its turn, and a still-pending prompt skips the next firing",
  () =>
    Effect.gen(function* () {
      const { llm, chat, sessions, prompt, store } = yield* setup()
      yield* settled(chat.id, 1)
      const gate = yield* Deferred.make<void>()
      yield* llm.hold("busy answer", Effect.runPromise(Deferred.await(gate)))
      yield* llm.text("scheduled answer")
      yield* prompt
        .prompt({ sessionID: chat.id, agent: "plan", parts: [{ type: "text", text: "keep working" }] })
        .pipe(Effect.forkScoped)
      yield* llm.wait(2)

      const job = yield* store.create(cron(chat.id))
      const scheduler = yield* Scheduler.make({ now: () => due })
      yield* scheduler.tick()
      expect(yield* scheduledMessages(sessions, chat.id)).toHaveLength(1)

      // The next slot comes while the first scheduled prompt still waits for the turn.
      const next = new Date("2026-10-27T10:10:00")
      yield* scheduler.tick(next)
      expect(yield* scheduledMessages(sessions, chat.id)).toHaveLength(1)
      const [skipped] = yield* store.list(chat.id)
      expect(skipped?.id).toBe(job.id)
      expect(skipped?.next_run_at).toBe(new Date("2026-10-27T10:15:00").getTime())
      expect(skipped?.lease_until).toBeNull()

      yield* Deferred.succeed(gate, undefined)
      yield* settled(chat.id, 3)
      expect(yield* llm.calls).toBe(3)
      expect(lastUserText((yield* llm.inputs).at(-1))).toContain("check the build")
    }),
  30_000,
)

unix(
  "a missed recurring job fires once and moves to the next match after now",
  () =>
    Effect.gen(function* () {
      const { llm, chat, sessions, store } = yield* setup()
      yield* settled(chat.id, 1)
      yield* store.create(cron(chat.id))
      // An hour after the first slot: twelve slots were missed while nothing ran.
      const late = new Date(due.getTime() + 60 * MINUTE + 30_000)
      const scheduler = yield* Scheduler.make({ now: () => late })

      yield* llm.text("scheduled answer")
      yield* scheduler.tick()
      yield* settled(chat.id, 2)
      yield* scheduler.tick()

      expect(yield* scheduledMessages(sessions, chat.id)).toHaveLength(1)
      expect(yield* llm.calls).toBe(2)
      const [stored] = yield* store.list(chat.id)
      expect(stored?.next_run_at).toBe(new Date("2026-10-27T11:10:00").getTime())
    }),
  30_000,
)

unix(
  "a missed one-shot job fires once and is deleted",
  () =>
    Effect.gen(function* () {
      const { llm, chat, sessions, store } = yield* setup()
      yield* settled(chat.id, 1)
      yield* store.create(cron(chat.id, { recurring: false }))
      const scheduler = yield* Scheduler.make({ now: () => new Date(due.getTime() + 24 * 60 * MINUTE) })

      yield* llm.text("scheduled answer")
      yield* scheduler.tick()
      yield* settled(chat.id, 2)
      yield* scheduler.tick()

      expect(yield* scheduledMessages(sessions, chat.id)).toHaveLength(1)
      expect(yield* store.list(chat.id)).toEqual([])
    }),
  30_000,
)

unix(
  "only the scheduler holding the leader lock ticks",
  () =>
    Effect.gen(function* () {
      const { llm, chat, sessions, store } = yield* setup()
      yield* settled(chat.id, 1)
      yield* store.create(cron(chat.id))
      const lock = `schedule-test:${chat.id}`
      const first = yield* Scheduler.make({ now: () => due, lock })
      const second = yield* Scheduler.make({ now: () => due, lock })

      yield* llm.text("scheduled answer")
      const ticked = yield* Effect.all([first.poll(), second.poll()], { concurrency: "unbounded" })
      expect(ticked.filter((value) => value)).toHaveLength(1)
      yield* settled(chat.id, 2)
      expect(yield* scheduledMessages(sessions, chat.id)).toHaveLength(1)
      expect(yield* llm.calls).toBe(2)

      // The follower keeps trying and keeps losing while the leader lives.
      const follower = ticked[0] ? second : first
      expect(yield* follower.poll(new Date("2026-10-27T10:10:00"))).toBe(false)
      const [stored] = yield* store.list(chat.id)
      expect(stored?.next_run_at).toBe(new Date("2026-10-27T10:10:00").getTime())
    }),
  30_000,
)

unix(
  "another scheduler takes over when the leader exits",
  () =>
    Effect.gen(function* () {
      const { llm, chat, sessions, store } = yield* setup()
      yield* settled(chat.id, 1)
      yield* store.create(cron(chat.id))
      const lock = `schedule-test:${chat.id}`
      const scope = yield* Scope.make()
      const leader = yield* Scheduler.make({ now: () => start, lock }).pipe(Scope.provide(scope))
      const follower = yield* Scheduler.make({ now: () => due, lock })

      expect(yield* leader.poll()).toBe(true)
      expect(yield* follower.poll()).toBe(false)
      expect(yield* scheduledMessages(sessions, chat.id)).toHaveLength(0)

      yield* Scope.close(scope, Exit.void)
      yield* llm.text("scheduled answer")
      expect(yield* follower.poll()).toBe(true)
      yield* settled(chat.id, 2)
      expect(yield* scheduledMessages(sessions, chat.id)).toHaveLength(1)
    }),
  30_000,
)

unix(
  "a session busy in another process only gets the prompt admitted, and an idle one with a stranded prompt is drained",
  () =>
    Effect.gen(function* () {
      const { dir, llm, chat, sessions, store } = yield* setup()
      yield* settled(chat.id, 1)
      const user = (yield* sessions.messages({ sessionID: chat.id })).find((item) => item.info.role === "user")!
      // Another process is mid-turn: its unfinished assistant row is all this process can see of it.
      const running = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        sessionID: chat.id,
        mode: "plan",
        agent: "plan",
        path: { cwd: dir, root: dir },
        cost: 0,
        tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        parentID: user.info.id,
        time: { created: Date.now() },
      })
      const job = yield* store.create(cron(chat.id))
      const scheduler = yield* Scheduler.make({ now: () => due })

      yield* scheduler.tick()
      const [admitted] = yield* scheduledMessages(sessions, chat.id)
      expect(admitted).toBeDefined()
      expect((yield* store.list(chat.id))[0]?.pending_message_id).toBe(admitted?.info.id ?? null)
      const status = yield* SessionStatus.Service
      expect((yield* status.get(chat.id)).type).toBe("idle")

      // Still busy at the next slot: the firing is skipped and nothing starts a turn.
      yield* scheduler.tick(new Date("2026-10-27T10:10:00"))
      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect(yield* llm.calls).toBe(1)
      expect((yield* store.list(chat.id))[0]?.next_run_at).toBe(new Date("2026-10-27T10:15:00").getTime())

      // That process died without answering; once its turn is finished the prompt is stranded, and the next slot
      // drains it instead of delivering again.
      yield* sessions.updateMessage({ ...running, time: { created: running.time.created, completed: Date.now() } })
      yield* llm.text("scheduled answer")
      yield* scheduler.tick(new Date("2026-10-27T10:15:00"))
      yield* settled(chat.id, 3)
      expect(yield* llm.calls).toBe(2)
      expect(lastUserText((yield* llm.inputs).at(-1))).toContain("check the build")
      expect(yield* scheduledMessages(sessions, chat.id)).toHaveLength(1)
      expect((yield* store.list(chat.id))[0]?.id).toBe(job.id)
    }),
  30_000,
)

unix(
  "a job whose delivery fails three times in a row is deleted",
  () =>
    Effect.gen(function* () {
      const { llm, chat, sessions, store } = yield* setup()
      yield* settled(chat.id, 1)
      // A queued prompt keeps the conversation's agent, so an agent that no longer exists fails admission.
      const user = (yield* sessions.messages({ sessionID: chat.id })).find((item) => item.info.role === "user")!
      if (user.info.role !== "user") throw new Error("expected a user message")
      yield* sessions.updateMessage({ ...user.info, agent: "ghost" })
      const job = yield* store.create(cron(chat.id))
      const scheduler = yield* Scheduler.make({ now: () => due })

      yield* scheduler.tick()
      expect((yield* store.list(chat.id))[0]).toEqual(
        expect.objectContaining({ id: job.id, failures: 1, lease_until: null }),
      )
      yield* scheduler.tick()
      expect((yield* store.list(chat.id))[0]?.failures).toBe(2)
      yield* scheduler.tick()

      expect(yield* store.list(chat.id)).toEqual([])
      expect(yield* scheduledMessages(sessions, chat.id)).toHaveLength(0)
      expect(yield* llm.calls).toBe(1)
    }),
  30_000,
)

unix(
  "a pending revert defers the firing until it is resolved",
  () =>
    Effect.gen(function* () {
      const { llm, chat, sessions, store } = yield* setup()
      yield* settled(chat.id, 1)
      const assistant = (yield* sessions.messages({ sessionID: chat.id })).find(
        (item) => item.info.role === "assistant",
      )!
      yield* sessions.setRevert({ sessionID: chat.id, revert: { messageID: assistant.info.id }, summary: undefined })
      const job = yield* store.create(cron(chat.id))
      const scheduler = yield* Scheduler.make({ now: () => due })

      yield* scheduler.tick()
      expect(yield* scheduledMessages(sessions, chat.id)).toHaveLength(0)
      expect((yield* sessions.get(chat.id)).revert).toEqual({ messageID: assistant.info.id })
      expect(yield* store.list(chat.id)).toEqual([job])

      yield* sessions.clearRevert(chat.id)
      yield* llm.text("scheduled answer")
      yield* scheduler.tick()
      yield* settled(chat.id, 2)
      expect(yield* scheduledMessages(sessions, chat.id)).toHaveLength(1)
    }),
  30_000,
)

unix(
  "deleting or archiving a session removes its jobs and announces it",
  () =>
    Effect.gen(function* () {
      const { chat, sessions, store } = yield* setup()
      yield* settled(chat.id, 1)
      const other = yield* sessions.create({ title: "Other" })
      yield* store.create(cron(chat.id))
      yield* store.create(cron(other.id))

      const seen: string[] = []
      const listen = (event: GlobalEvent) => {
        if (event.payload?.type === "session.schedule.updated") seen.push(event.payload.properties.sessionID)
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", listen)),
        () => Effect.sync(() => GlobalBus.off("event", listen)),
      )

      yield* sessions.setArchived({ sessionID: chat.id, time: Date.now() })
      expect(yield* store.list(chat.id)).toEqual([])

      yield* sessions.remove(other.id)
      expect(yield* store.list(other.id)).toEqual([])
      expect(seen).toEqual([chat.id, other.id])

      // Without jobs there is nothing to announce.
      const empty = yield* sessions.create({ title: "Empty" })
      yield* sessions.setArchived({ sessionID: empty.id, time: Date.now() })
      yield* sessions.remove(empty.id)
      expect(seen).toEqual([chat.id, other.id])
    }),
  30_000,
)

unix(
  "a job whose session is gone is deleted on the next tick",
  () =>
    Effect.gen(function* () {
      const { llm, store } = yield* setup()
      const missing = SessionID.make("ses_schedule_missing_session")
      yield* store.create(cron(missing))
      const scheduler = yield* Scheduler.make({ now: () => due })

      yield* scheduler.tick()

      expect(yield* store.list(missing)).toEqual([])
      expect(yield* llm.calls).toBe(1)
    }),
  30_000,
)

unix(
  "firing a job publishes session.schedule.updated in the session's directory",
  () =>
    Effect.gen(function* () {
      const { llm, chat, store } = yield* setup()
      yield* settled(chat.id, 1)
      yield* store.create(cron(chat.id))
      const scheduler = yield* Scheduler.make({ now: () => due })
      const seen: GlobalEvent[] = []
      const listen = (event: GlobalEvent) => {
        if (event.payload?.type === "session.schedule.updated") seen.push(event)
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", listen)),
        () => Effect.sync(() => GlobalBus.off("event", listen)),
      )

      yield* llm.text("scheduled answer")
      yield* scheduler.tick()
      yield* settled(chat.id, 2)

      expect(seen).toContainEqual(
        expect.objectContaining({
          directory: chat.directory,
          payload: expect.objectContaining({ type: "session.schedule.updated", properties: { sessionID: chat.id } }),
        }),
      )
    }),
  30_000,
)
