import { ConfigV1 } from "@flynncode/core/v1/config/config"
import { Database } from "@flynncode/core/database/database"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { SessionProjector } from "@flynncode/core/session/projector"
import { FSUtil } from "@flynncode/core/fs-util"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { Ripgrep } from "@flynncode/core/ripgrep"
import { expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Option, Tracer } from "effect"
import path from "path"
import { pathToFileURL } from "url"
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
import { SessionID } from "@/session/schema"
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
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

// Blocking Stop, SubagentStop and UserPromptSubmit hooks, run through real
// command hooks, the test LLM server and real child sessions from the task
// tool. Trust is bypassed so project hooks run unprompted.

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
    startAuth: () => Effect.die("unexpected MCP auth in stop-hook tests"),
    authenticate: () => Effect.die("unexpected MCP auth in stop-hook tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in stop-hook tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

// The real bootstrap loads config before tests write their opencode.json.
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

const llmServer = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

// HooksRunner is a root so idle transitions, which find it in the caller's
// context as the app runtime provides it, can reach it.
const hooked = testEffect(
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
      llmServer,
      HooksRunner.node,
    ]),
    [
      [SessionSummary.node, summary],
      [LSP.node, lsp],
      [MCP.node, mcp],
      [
        RuntimeFlags.node,
        RuntimeFlags.layer({
          experimentalEventSystem: true,
          bypassHookTrust: true,
          experimentalBackgroundSubagents: true,
        }),
      ],
      [InstanceStore.bootstrapNode, noopBootstrap],
    ],
  ),
)
const unix = process.platform !== "win32" ? hooked.instance : hooked.instance.skip

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

const setup = Effect.fn("test.setup")(function* (hooksConfig: Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeText(
    path.join(dir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...provider(llm.url), ...hooksConfig }),
  )
  const config = yield* Config.Service
  yield* config.get()
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({
    title: "Pinned",
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })
  return { dir, llm, chat, sessions, prompt: yield* SessionPrompt.Service }
})

const command = (text: string) => ({ type: "command" as const, command: text })
const printJson = (value: unknown) => `printf '%s' '${JSON.stringify(value)}'`
// Appends each hook's stdin as one JSON line.
const appendStdin = (file: string) => `{ cat; echo; } >> "${file}"`
// Appends its stdin, then blocks the first time only: exit 2 with the reason
// on stderr, remembered by a state file.
const blockOnce = (log: string, flag: string, reason: string) =>
  `${appendStdin(log)}; [ -e "${flag}" ] && exit 0; touch "${flag}"; echo '${reason}' >&2; exit 2`

const readLines = (file: string) =>
  Effect.promise(async () => {
    const handle = Bun.file(file)
    if (!(await handle.exists())) return []
    return (await handle.text())
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  })

// The model requests, as JSON, without title requests.
const requests = (llm: { inputs: Effect.Effect<Record<string, unknown>[]> }) =>
  llm.inputs.pipe(
    Effect.map((inputs) =>
      inputs
        .map((input) => JSON.stringify(input))
        .filter((body) => !body.includes("Generate a title for this conversation")),
    ),
  )

const go = (sessionID: SessionID, text = "go") =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    return yield* prompt.prompt({ sessionID, agent: "build", parts: [{ type: "text", text }] })
  })

// Appends its stdin, then the first time only waits for `release` (at most
// about 20 s) and blocks with the reason.
const blockOnceAfter = (log: string, flag: string, release: string, reason: string) =>
  `${appendStdin(log)}; [ -e "${flag}" ] && exit 0; touch "${flag}"; i=0; ` +
  `while [ ! -e "${release}" ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done; echo '${reason}' >&2; exit 2`

const waitForLines = (file: string, count: number) =>
  pollWithTimeout(
    readLines(file).pipe(Effect.map((lines) => (lines.length >= count ? lines : undefined))),
    `fewer than ${count} lines in ${file}`,
  )

const userTexts = (sessions: Session.Interface, sessionID: SessionID) =>
  sessions
    .messages({ sessionID })
    .pipe(
      Effect.map((items) =>
        items
          .filter((item) => item.info.role === "user")
          .map((item) => item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")),
      ),
    )

unix(
  "a Claude Stop hook that blocks once continues the turn with its reason",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const stops = path.join(dir, "stops.jsonl")
      const prompts = path.join(dir, "prompts.jsonl")
      yield* writeText(
        path.join(dir, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            Stop: [{ hooks: [command(blockOnce(stops, path.join(dir, "stop.flag"), "run the tests first"))] }],
            UserPromptSubmit: [{ hooks: [command(appendStdin(prompts))] }],
          },
        }),
      )
      const { llm, chat, sessions } = yield* setup({})
      yield* llm.text("first answer")
      yield* llm.text("second answer")

      const result = yield* go(chat.id)

      const sent = yield* requests(llm)
      expect(sent).toHaveLength(2)
      expect(sent[0]).not.toContain("run the tests first")
      expect(sent[1]).toContain("run the tests first")
      expect(result.parts.some((part) => part.type === "text" && part.text === "second answer")).toBe(true)

      const inputs = yield* readLines(stops)
      expect(inputs.map((line) => [line["hook_event_name"], line["stop_hook_active"]])).toEqual([
        ["Stop", false],
        ["Stop", true],
      ])
      // The continuation is a synthetic prompt, and it runs no UserPromptSubmit hook.
      expect(yield* readLines(prompts)).toHaveLength(1)
      const users = (yield* sessions.messages({ sessionID: chat.id })).filter((item) => item.info.role === "user")
      expect(users).toHaveLength(2)
      const continuation = users[1]!.parts.flatMap((part) => (part.type === "text" ? [part] : []))
      expect(continuation.every((part) => part.synthetic === true)).toBe(true)
      expect(continuation.map((part) => part.text).join("\n")).toContain("run the tests first")
    }),
  { git: true },
  30_000,
)

unix(
  "a Stop hook that always blocks is allowed to stop after 8 continuations",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const stops = path.join(dir, "stops.jsonl")
      const { llm, chat, sessions } = yield* setup({
        hooks: {
          Stop: [
            { hooks: [command(`${appendStdin(stops)}; ${printJson({ behavior: "deny", message: "never done" })}`)] },
          ],
        },
      })

      yield* go(chat.id)

      expect(yield* requests(llm)).toHaveLength(9)
      const inputs = yield* readLines(stops)
      expect(inputs.map((line) => line["stopHookActive"])).toEqual([false, ...Array(8).fill(true)])
      const status = yield* SessionStatus.Service
      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect(
        (yield* sessions.messages({ sessionID: chat.id })).filter((item) => item.info.role === "user"),
      ).toHaveLength(9)
    }),
  { git: true },
  60_000,
)

unix(
  "a new user prompt resets the continuation count and stop_hook_active",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const stops = path.join(dir, "stops.jsonl")
      const flag = path.join(dir, "stop.flag")
      const { llm, chat } = yield* setup({
        hooks: { Stop: [{ hooks: [command(blockOnce(stops, flag, "once more"))] }] },
      })

      yield* go(chat.id)
      yield* Effect.promise(() => Bun.file(flag).delete())
      yield* go(chat.id, "again")

      expect(yield* requests(llm)).toHaveLength(4)
      expect((yield* readLines(stops)).map((line) => line["stopHookActive"])).toEqual([false, true, false, true])
    }),
  { git: true },
  30_000,
)

unix(
  "a SubagentStop block continues the child before the parent gets its result",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const subagentStops = path.join(dir, "subagent-stops.jsonl")
      const stops = path.join(dir, "stops.jsonl")
      const { llm, chat, sessions } = yield* setup({
        hooks: {
          SubagentStop: [{ hooks: [command(blockOnce(subagentStops, path.join(dir, "sub.flag"), "check your work"))] }],
          Stop: [{ hooks: [command(appendStdin(stops))] }],
        },
      })
      yield* llm.tool("task", { description: "inspect bug", prompt: "look into it", subagent_type: "general" })
      yield* llm.text("child first")
      yield* llm.text("child second")
      yield* llm.text("parent done")

      yield* go(chat.id)

      const sent = yield* requests(llm)
      expect(sent).toHaveLength(4)
      expect(sent[2]).toContain("check your work")
      expect(sent[3]).toContain("child second")
      const children = yield* sessions.children(chat.id)
      expect(children).toHaveLength(1)
      const inputs = yield* readLines(subagentStops)
      expect(inputs.map((line) => [line["sessionID"], line["agentType"], line["stopHookActive"]])).toEqual([
        [children[0]!.id, "general", false],
        [children[0]!.id, "general", true],
      ])
      // Stop is for the root session only.
      expect((yield* readLines(stops)).map((line) => line["sessionID"])).toEqual([chat.id])
    }),
  { git: true },
  30_000,
)

unix(
  "SubagentStop fires exactly once for a foreground and for a background child",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const subagentStops = path.join(dir, "subagent-stops.jsonl")
      const { llm, chat, sessions } = yield* setup({
        hooks: { SubagentStop: [{ hooks: [command(appendStdin(subagentStops))] }] },
      })
      yield* llm.tool("task", { description: "inspect bug", prompt: "look into it", subagent_type: "general" })
      yield* llm.text("child done")
      yield* llm.text("parent done")

      yield* go(chat.id)
      const foreground = (yield* sessions.children(chat.id))[0]!
      expect((yield* readLines(subagentStops)).map((line) => line["sessionID"])).toEqual([foreground.id])

      // The background child and the parent then ask the model concurrently;
      // both get the server's default answer.
      yield* llm.tool("task", {
        description: "inspect more",
        prompt: "look further",
        subagent_type: "general",
        background: true,
      })
      yield* go(chat.id, "again")
      const background = (yield* sessions.children(chat.id)).find((child) => child.id !== foreground.id)!
      // The parent's turn answering the injected background result ends idle.
      const status = yield* SessionStatus.Service
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const texts = yield* userTexts(sessions, chat.id)
          const last = (yield* sessions.messages({ sessionID: chat.id })).at(-1)
          const done =
            texts.some((text) => text.includes("Background task completed")) &&
            last?.info.role === "assistant" &&
            last.info.finish !== undefined &&
            (yield* status.get(chat.id)).type === "idle"
          return done ? true : undefined
        }),
        "the background result never reached the parent",
      )
      expect((yield* readLines(subagentStops)).map((line) => line["sessionID"])).toEqual([foreground.id, background.id])
    }),
  { git: true },
  60_000,
)

unix(
  "a throwing subagent.stop plugin lets the child's finished turn through",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const plugin = path.join(dir, "plugin.ts")
      const marker = path.join(dir, "plugin-ran")
      yield* writeText(
        plugin,
        [
          "export default async () => ({",
          '  "subagent.stop": async () => {',
          `    await Bun.write(${JSON.stringify(marker)}, "ran")`,
          '    throw new Error("plugin boom")',
          "  },",
          "})",
          "",
        ].join("\n"),
      )
      const { llm, chat } = yield* setup({ plugin: [pathToFileURL(plugin).href] })
      yield* llm.tool("task", { description: "inspect bug", prompt: "look into it", subagent_type: "general" })
      yield* llm.text("child done")
      yield* llm.text("parent done")

      const result = yield* go(chat.id)

      const sent = yield* requests(llm)
      expect(sent).toHaveLength(3)
      expect(sent[2]).toContain("child done")
      expect(result.parts.some((part) => part.type === "text" && part.text === "parent done")).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(true)
    }),
  { git: true },
  30_000,
)

unix(
  "a turn end without Stop hooks does no hook work",
  () =>
    Effect.gen(function* () {
      const { llm, chat } = yield* setup({})
      yield* llm.text("done")
      // A real tracer records every span: whatever the drain does after its
      // last loop shows up as a direct child of its span.
      const spans = new Map<string, { name: string; parent?: string }>()
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.set(span.spanId, {
            name: options.name,
            parent: Option.isSome(options.parent) ? options.parent.value.spanId : undefined,
          })
          return span
        },
      })

      yield* go(chat.id).pipe(Effect.withTracer(tracer))

      const runs = [...spans.entries()].filter((entry) => entry[1].name === "SessionPrompt.run")
      expect(runs).toHaveLength(1)
      const children = [...spans.values()].filter((span) => span.parent === runs[0]![0]).map((span) => span.name)
      expect(children).toEqual(["SessionPrompt.runLoopOnce", "SessionPrompt.hasNewerUser", "HooksRunner.hasStop"])
    }),
  { git: true },
  30_000,
)

unix(
  "the continuation cap holds across an auto-compaction",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const stops = path.join(dir, "stops.jsonl")
      const { llm, chat, sessions } = yield* setup({
        hooks: {
          Stop: [
            { hooks: [command(`${appendStdin(stops)}; ${printJson({ behavior: "deny", message: "never done" })}`)] },
          ],
        },
      })
      yield* llm.text("one")
      yield* llm.text("two")
      // Past the model's context: the next step compacts first, and the
      // compaction admits its own synthetic "Continue" prompt.
      yield* llm.text("three", { usage: { input: 200_000, output: 10 } })

      yield* go(chat.id)

      const texts = yield* userTexts(sessions, chat.id)
      expect(texts.some((text) => text.startsWith("Continue if you have next steps"))).toBe(true)
      expect((yield* readLines(stops)).map((line) => line["stopHookActive"])).toEqual([false, ...Array(8).fill(true)])
      const status = yield* SessionStatus.Service
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
  { git: true },
  60_000,
)

unix(
  "a steer sent while a blocking Stop hook runs takes over from the continuation",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const stops = path.join(dir, "stops.jsonl")
      const release = path.join(dir, "release")
      const { llm, chat, sessions, prompt } = yield* setup({
        hooks: {
          Stop: [{ hooks: [command(blockOnceAfter(stops, path.join(dir, "stop.flag"), release, "hook wants more"))] }],
        },
      })
      yield* llm.text("first answer")
      yield* llm.text("steer answer")

      const running = yield* go(chat.id).pipe(Effect.forkChild)
      yield* waitForLines(stops, 1)
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        delivery: "steer",
        parts: [{ type: "text", text: "steer now" }],
      })
      yield* writeText(release, "")
      yield* Fiber.join(running)

      const sent = yield* requests(llm)
      expect(sent).toHaveLength(2)
      expect(sent[1]).toContain("steer now")
      expect(sent[1]).not.toContain("hook wants more")
      const texts = yield* userTexts(sessions, chat.id)
      expect(texts).toEqual(["go", "steer now"])
      // The steer is a new prompt: its own Stop is not a forced one.
      expect((yield* readLines(stops)).map((line) => line["stopHookActive"])).toEqual([false, false])
    }),
  { git: true },
  30_000,
)

unix(
  "a cancel during a Stop hook leaves no continuation",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const stops = path.join(dir, "stops.jsonl")
      const release = path.join(dir, "release")
      const { llm, chat, sessions, prompt } = yield* setup({
        hooks: {
          Stop: [{ hooks: [command(blockOnceAfter(stops, path.join(dir, "stop.flag"), release, "hook wants more"))] }],
        },
      })
      yield* llm.text("first answer")

      const running = yield* go(chat.id).pipe(Effect.forkChild)
      yield* waitForLines(stops, 1)
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(running)

      expect(yield* requests(llm)).toHaveLength(1)
      expect(yield* userTexts(sessions, chat.id)).toEqual(["go"])
      const status = yield* SessionStatus.Service
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
  { git: true },
  30_000,
)

unix(
  "a cancel just after a Stop hook blocks removes the continuation",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const stops = path.join(dir, "stops.jsonl")
      const { llm, chat, sessions, prompt } = yield* setup({
        hooks: { Stop: [{ hooks: [command(blockOnce(stops, path.join(dir, "stop.flag"), "hook wants more"))] }] },
      })
      yield* llm.text("first answer")
      // Listeners run inside the publishing fiber: this one sees the
      // continuation's part being written, starts a cancel and holds the
      // admission long enough for the cancel to reach the drain, so the
      // cancel lands before the continuation's step can start.
      const events = yield* EventV2Bridge.Service
      const seen = { cancelled: false }
      const unsubscribe = yield* events.listen((event) => {
        if (seen.cancelled || event.type !== MessageV2.Event.PartUpdated.type) return Effect.void
        const part = (event.data as typeof MessageV2.Event.PartUpdated.data.Type).part
        if (part.type !== "text" || !part.text.startsWith("Stop hook feedback")) return Effect.void
        seen.cancelled = true
        return prompt.cancel(chat.id).pipe(Effect.forkDetach, Effect.andThen(Effect.sleep("200 millis")))
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* go(chat.id).pipe(Effect.exit)

      expect(seen.cancelled).toBe(true)
      expect(yield* requests(llm)).toHaveLength(1)
      expect(yield* userTexts(sessions, chat.id)).toEqual(["go"])
      const status = yield* SessionStatus.Service
      yield* pollWithTimeout(
        status.get(chat.id).pipe(Effect.map((current) => (current.type === "idle" ? true : undefined))),
        "the session never went idle",
      )
    }),
  { git: true },
  30_000,
)

unix(
  "a Claude PermissionRequest continue:false ends the turn after the tool step",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* writeText(
        path.join(dir, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            PermissionRequest: [
              { matcher: "Bash", hooks: [command(printJson({ continue: false, stopReason: "halt now" }))] },
            ],
          },
        }),
      )
      const { llm, sessions } = yield* setup({})
      const asking = yield* sessions.create({
        title: "Asks for bash",
        permission: [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "bash", pattern: "*", action: "ask" },
        ],
      })
      yield* llm.tool("bash", { command: "printf ran", description: "Print" })
      yield* llm.text("never requested")

      yield* go(asking.id)

      expect(yield* requests(llm)).toHaveLength(1)
      const part = (yield* sessions.messages({ sessionID: asking.id }))
        .flatMap((item) => item.parts)
        .find((item) => item.type === "tool")
      expect(part?.type === "tool" && part.state.status).toBe("error")
    }),
  { git: true },
  30_000,
)

unix(
  "a synthetic prompt runs no UserPromptSubmit hook",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompts = path.join(dir, "prompts.jsonl")
      const { llm, chat, prompt } = yield* setup({
        hooks: {
          UserPromptSubmit: [
            { hooks: [command(`${appendStdin(prompts)}; ${printJson({ behavior: "deny", message: "no" })}`)] },
          ],
        },
      })

      yield* prompt.prompt({
        sessionID: chat.id,
        parts: [{ type: "text", synthetic: true, text: "[background shell sh_1 exited (code 0)] make test" }],
      })

      expect(yield* requests(llm)).toHaveLength(1)
      expect(yield* readLines(prompts)).toEqual([])
    }),
  { git: true },
  30_000,
)

unix(
  "a Claude UserPromptSubmit exit 2 keeps the prompt out and returns the reason",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* writeText(
        path.join(dir, ".claude", "settings.json"),
        JSON.stringify({
          hooks: { UserPromptSubmit: [{ hooks: [command("echo 'no secrets in prompts' >&2; exit 2")] }] },
        }),
      )
      const { llm, chat, sessions } = yield* setup({})

      const exit = yield* go(chat.id, "my password is hunter2").pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(HooksRunner.HookDeniedError)
      expect(error instanceof Error && error.message).toBe("no secrets in prompts")
      expect(yield* sessions.messages({ sessionID: chat.id })).toEqual([])
      expect(yield* llm.calls).toBe(0)
    }),
  { git: true },
  30_000,
)

unix(
  "a native UserPromptSubmit deny blocks the prompt",
  () =>
    Effect.gen(function* () {
      const { llm, chat, sessions } = yield* setup({
        hooks: { UserPromptSubmit: [{ hooks: [command(printJson({ behavior: "deny", message: "not today" }))] }] },
      })

      const exit = yield* go(chat.id).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(HooksRunner.HookDeniedError)
      expect(Exit.isFailure(exit) && (Cause.squash(exit.cause) as Error).message).toBe("not today")
      expect(yield* sessions.messages({ sessionID: chat.id })).toEqual([])
      expect(yield* llm.calls).toBe(0)
    }),
  { git: true },
  30_000,
)

unix(
  "a Claude PreToolUse continue:false ends the turn after the tool step",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const stops = path.join(dir, "stops.jsonl")
      yield* writeText(
        path.join(dir, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [command(printJson({ continue: false, stopReason: "halt now" }))] }],
            Stop: [{ hooks: [command(appendStdin(stops))] }],
          },
        }),
      )
      const { llm, chat, sessions } = yield* setup({})
      yield* llm.tool("bash", { command: "printf ran", description: "Print" })
      yield* llm.text("never requested")

      yield* go(chat.id)

      expect(yield* requests(llm)).toHaveLength(1)
      const part = (yield* sessions.messages({ sessionID: chat.id }))
        .flatMap((item) => item.parts)
        .find((item) => item.type === "tool")
      expect(part?.type === "tool" && part.state.status === "error" && part.state.error).toContain("halt now")
      expect(yield* readLines(stops)).toEqual([])
    }),
  { git: true },
  30_000,
)

unix(
  "a Claude PostToolUse continue:false ends the turn after the tool step",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* writeText(
        path.join(dir, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            PostToolUse: [
              { matcher: "Bash", hooks: [command(printJson({ continue: false, stopReason: "halt now" }))] },
            ],
          },
        }),
      )
      const { llm, chat, sessions } = yield* setup({})
      yield* llm.tool("bash", { command: "printf ran", description: "Print" })
      yield* llm.text("never requested")

      yield* go(chat.id)

      expect(yield* requests(llm)).toHaveLength(1)
      const part = (yield* sessions.messages({ sessionID: chat.id }))
        .flatMap((item) => item.parts)
        .find((item) => item.type === "tool")
      expect(part?.type === "tool" && part.state.status === "completed" && part.state.output).toContain("halt now")
    }),
  { git: true },
  30_000,
)

unix(
  "a bare idle transition no longer runs Stop hooks",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const stops = path.join(dir, "stops.jsonl")
      const notes = path.join(dir, "notes.jsonl")
      const { chat } = yield* setup({
        hooks: {
          Stop: [{ hooks: [command(appendStdin(stops))] }],
          Notification: [{ matcher: "idle", hooks: [command(`sleep 0.3; ${appendStdin(notes)}`)] }],
        },
      })
      const status = yield* SessionStatus.Service
      yield* status.set(chat.id, { type: "busy" })
      yield* status.set(chat.id, { type: "idle" })

      // Both used to fire detached from the same transition; the slower
      // Notification hook landing means a Stop hook would have too.
      yield* pollWithTimeout(
        readLines(notes).pipe(Effect.map((lines) => (lines.length > 0 ? true : undefined))),
        "no idle Notification",
      )
      expect(yield* readLines(stops)).toEqual([])
    }),
  { git: true },
  30_000,
)
