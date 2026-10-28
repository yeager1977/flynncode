import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Fiber, Layer } from "effect"
import { Database } from "@flynncode/core/database/database"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { SessionProjector } from "@flynncode/core/session/projector"
import { FSUtil } from "@flynncode/core/fs-util"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { Ripgrep } from "@flynncode/core/ripgrep"
import type { SessionV1 } from "@flynncode/core/v1/session"
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
import type { SessionID } from "@/session/schema"
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
import { BackgroundShells } from "@/shell/background/service"
import { Worktree } from "@/worktree"
import { disposeSessionWorktree } from "@/worktree/dispose-bound"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { raw, TestLLMServer } from "../lib/llm-server"

// enter_worktree / exit_worktree driven by the test LLM server through the
// real prompt loop: the turn goes on in the session's new folder.

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
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

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
      SessionSummary.node,
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
      BackgroundShells.node,
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
      Worktree.node,
      InstanceStore.node,
      llmServer,
      HooksRunner.node,
    ]),
    [
      [LSP.node, lsp],
      [MCP.node, mcp],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
      [InstanceStore.bootstrapNode, noopBootstrap],
    ],
  ),
)
const unix = process.platform !== "win32" ? it.live : it.live.skip

const provider = (url: string) => ({
  $schema: "https://opencode.ai/config.json",
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

const allowAll = [{ permission: "*", pattern: "*", action: "allow" as const }]

const git = (cwd: string, ...args: string[]) =>
  Effect.gen(function* () {
    const gitSvc = yield* Git.Service
    const result = yield* gitSvc.run(args, { cwd })
    return { code: result.exitCode, text: result.stdout.toString("utf8").trim() }
  })

const exists = (target: string) =>
  Effect.promise(() =>
    fs.stat(target).then(
      () => true,
      () => false,
    ),
  )

const inFolder = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    return yield* store.provide({ directory }, effect)
  })

// A git repository whose committed config points at the test LLM server, so
// a worktree checked out from it talks to the same model.
const repo = Effect.gen(function* () {
  const dir = yield* tmpdirScoped({ git: true })
  const llm = yield* TestLLMServer
  yield* Effect.promise(() => Bun.write(path.join(dir, "opencode.json"), JSON.stringify(provider(llm.url))))
  yield* git(dir, "add", "opencode.json")
  yield* git(dir, "commit", "-m", "config")
  return { dir, llm }
})

const createSession = (permission: Session.Info["permission"] = allowAll) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return yield* sessions.create({ title: "worktree switch", permission })
  })

const go = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    return yield* prompt.prompt({ sessionID, agent: "build", parts: [{ type: "text", text: "go" }] })
  })

const toolParts = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return (yield* sessions.messages({ sessionID })).flatMap((message) =>
      message.parts.filter((part): part is SessionV1.ToolPart => part.type === "tool"),
    )
  })

const outputOf = (part: SessionV1.ToolPart | undefined) =>
  part?.state.status === "completed" ? part.state.output : part?.state.status === "error" ? part.state.error : ""

const enteredPath = (parts: SessionV1.ToolPart[]) => {
  const part = parts.find((item) => item.tool === "enter_worktree" && item.state.status === "completed")
  const worktree = part?.state.status === "completed" ? part.state.metadata?.worktree : undefined
  if (!worktree || typeof worktree !== "object") throw new Error("enter_worktree did not complete")
  return worktree as { path: string; branch?: string }
}

// The model requests, as JSON, without title requests.
const requests = (llm: TestLLMServer["Service"]) =>
  llm.inputs.pipe(
    Effect.map((inputs) =>
      inputs
        .map((input) => JSON.stringify(input))
        .filter((body) => !body.includes("Generate a title for this conversation")),
    ),
  )

const chunk = (delta: Record<string, unknown>, finish?: string) => ({
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }],
})

// One model reply calling several tools in the same step.
const parallelTools = (calls: [string, unknown][]) =>
  raw({
    head: [chunk({ role: "assistant" })],
    tail: [
      ...calls.map(([name, input], index) =>
        chunk({
          tool_calls: [
            { index, id: `call_${index + 1}`, type: "function", function: { name, arguments: JSON.stringify(input) } },
          ],
        }),
      ),
      chunk({}, "tool_calls"),
    ],
  })

const busyIn = (directory: string, sessionID: SessionID) =>
  inFolder(
    directory,
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      return (yield* status.get(sessionID)).type !== "idle"
    }),
  )

const worktreeCount = (dir: string) =>
  git(dir, "worktree", "list", "--porcelain").pipe(
    Effect.map((result) => result.text.split("\n").filter((line) => line.startsWith("worktree ")).length),
  )

describe("a folder switch continues the turn", () => {
  unix(
    "enter runs the next call in the worktree, exit runs the one after in the original folder",
    () =>
      Effect.gen(function* () {
        const { dir, llm } = yield* repo
        yield* inFolder(
          dir,
          Effect.gen(function* () {
            const chat = yield* createSession()
            yield* llm.tool("enter_worktree", { name: "feature" })
            yield* llm.tool("bash", { command: "pwd", description: "Print the directory" })
            yield* llm.tool("exit_worktree", { action: "keep" })
            yield* llm.tool("bash", { command: "pwd", description: "Print the directory" })
            yield* llm.text("done")

            yield* go(chat.id)

            const parts = yield* toolParts(chat.id)
            const entered = enteredPath(parts)
            const shells = parts.filter((part) => part.tool === "bash")
            expect(shells).toHaveLength(2)
            expect(outputOf(shells[0]).trim()).toBe(yield* Effect.promise(() => fs.realpath(entered.path)))
            expect(outputOf(shells[1]).trim()).toBe(dir)

            const sessions = yield* Session.Service
            const after = yield* sessions.get(chat.id)
            expect(after.directory).toBe(dir)
            expect(after.metadata?.enteredFrom).toBeUndefined()
            expect(yield* exists(entered.path)).toBe(true)

            // The note rides on the request right after each switch only.
            const sent = yield* requests(llm)
            expect(sent).toHaveLength(5)
            const into = `Working directory is now ${entered.path} (branch ${entered.branch}).`
            expect(sent[1]).toContain(into)
            expect(sent[2]).not.toContain(into)
            const branch = (yield* git(dir, "symbolic-ref", "--short", "HEAD")).text
            const back = `Working directory is now ${dir} (branch ${branch}).`
            expect(sent[3]).toContain(back)
            expect(sent[4]).not.toContain(back)

            // Idle everywhere the turn ran, with no runner left behind.
            expect(yield* busyIn(dir, chat.id)).toBe(false)
            expect(yield* busyIn(entered.path, chat.id)).toBe(false)
            const state = yield* SessionRunState.Service
            yield* state.assertNotBusy(chat.id)
            yield* inFolder(entered.path, state.assertNotBusy(chat.id))
          }),
        )
      }),
    60_000,
  )

  unix(
    "a second switch in the same step is refused",
    () =>
      Effect.gen(function* () {
        const { dir, llm } = yield* repo
        yield* inFolder(
          dir,
          Effect.gen(function* () {
            const chat = yield* createSession()
            yield* llm.push(
              parallelTools([
                ["enter_worktree", { name: "one" }],
                ["enter_worktree", { name: "two" }],
              ]),
            )
            yield* llm.text("done")

            yield* go(chat.id)

            const parts = (yield* toolParts(chat.id)).filter((part) => part.tool === "enter_worktree")
            expect(parts.map((part) => part.state.status).sort()).toEqual(["completed", "error"])
            expect(outputOf(parts.find((part) => part.state.status === "error"))).toMatch(
              /already changed in this step|already in the worktree/,
            )
            expect(yield* worktreeCount(dir)).toBe(2)
          }),
        )
      }),
    60_000,
  )

  unix(
    "cancel from the new folder stops the turn and leaves the session idle",
    () =>
      Effect.gen(function* () {
        const { dir, llm } = yield* repo
        const state = yield* SessionRunState.Service
        const prompt = yield* SessionPrompt.Service
        yield* inFolder(
          dir,
          Effect.gen(function* () {
            const chat = yield* createSession()
            yield* llm.tool("enter_worktree", { name: "cancel" })
            yield* llm.hang

            const fiber = yield* go(chat.id).pipe(Effect.forkChild)
            yield* llm.wait(2)
            const sessions = yield* Session.Service
            const worktree = yield* pollWithTimeout(
              sessions.get(chat.id).pipe(Effect.map((info) => (info.directory !== dir ? info.directory : undefined))),
              "the session never moved",
            )
            yield* pollWithTimeout(
              busyIn(worktree, chat.id).pipe(Effect.map((busy) => (busy ? true : undefined))),
              "the session never looked busy in the worktree",
            )
            // The app now addresses the session through its new folder: it reads busy there, and a prompt there joins
            // the running turn instead of starting a second one.
            const busy = yield* inFolder(worktree, state.assertNotBusy(chat.id)).pipe(Effect.exit)
            expect(Exit.isFailure(busy)).toBe(true)

            yield* inFolder(worktree, prompt.cancel(chat.id))
            const exit = yield* Fiber.await(fiber)
            expect(Exit.isSuccess(exit)).toBe(true)

            expect(yield* busyIn(dir, chat.id)).toBe(false)
            expect(yield* busyIn(worktree, chat.id)).toBe(false)
            yield* inFolder(worktree, state.assertNotBusy(chat.id))
            yield* state.assertNotBusy(chat.id)

            // The next prompt runs in the worktree.
            yield* llm.tool("bash", { command: "pwd", description: "Print the directory" })
            yield* llm.text("again")
            yield* inFolder(worktree, go(chat.id))
            const shells = (yield* toolParts(chat.id)).filter((part) => part.tool === "bash")
            expect(outputOf(shells.at(-1)).trim()).toBe(yield* Effect.promise(() => fs.realpath(worktree)))
          }),
        )
      }),
    60_000,
  )

  unix(
    "exit with remove deletes the worktree once the turn has left it",
    () =>
      Effect.gen(function* () {
        const { dir, llm } = yield* repo
        yield* inFolder(
          dir,
          Effect.gen(function* () {
            const chat = yield* createSession()
            yield* llm.tool("enter_worktree", { name: "gone" })
            yield* llm.tool("exit_worktree", { action: "remove" })
            yield* llm.text("done")

            yield* go(chat.id)

            const entered = enteredPath(yield* toolParts(chat.id))
            yield* pollWithTimeout(
              exists(entered.path).pipe(Effect.map((present) => (present ? undefined : true))),
              "the worktree was never removed",
              "10 seconds",
            )
            expect(yield* worktreeCount(dir)).toBe(1)
            // A safe removal keeps the branch.
            expect((yield* git(dir, "rev-parse", "--verify", "--quiet", `refs/heads/${entered.branch}`)).code).toBe(0)
          }),
        )
      }),
    60_000,
  )

  unix(
    "after entering, a write lands in the worktree and the session diff shows it",
    () =>
      Effect.gen(function* () {
        const { dir, llm } = yield* repo
        yield* inFolder(
          dir,
          Effect.gen(function* () {
            const chat = yield* createSession()
            yield* llm.tool("enter_worktree", { name: "diff" })
            yield* llm.tool("write", { filePath: "note.txt", content: "from the worktree\n" })
            yield* llm.text("done")

            const result = yield* go(chat.id)
            const userID = result.info.role === "assistant" ? result.info.parentID : result.info.id

            const entered = enteredPath(yield* toolParts(chat.id))
            expect(yield* exists(path.join(entered.path, "note.txt"))).toBe(true)
            expect(yield* exists(path.join(dir, "note.txt"))).toBe(false)
            const summary = yield* SessionSummary.Service
            const files = yield* pollWithTimeout(
              inFolder(entered.path, summary.diff({ sessionID: chat.id, messageID: userID })).pipe(
                Effect.map((diffs) => {
                  const names = diffs.map((item) => item.file)
                  return names.includes("note.txt") ? names : undefined
                }),
              ),
              "the session diff never showed note.txt",
              "10 seconds",
            )
            expect(files).toEqual(["note.txt"])
          }),
        )
      }),
    60_000,
  )

  unix(
    "a background shell started before entering keeps running",
    () =>
      Effect.gen(function* () {
        const { dir, llm } = yield* repo
        const shells = yield* BackgroundShells.Service
        yield* inFolder(
          dir,
          Effect.gen(function* () {
            const chat = yield* createSession()
            yield* Effect.addFinalizer(() => shells.killSession(chat.id).pipe(Effect.ignore))
            yield* llm.tool("bash", { command: "sleep 30", description: "Wait", run_in_background: true })
            yield* llm.tool("enter_worktree", { name: "shell" })
            yield* llm.tool("bash", { command: "pwd", description: "Print the directory" })
            yield* llm.text("done")

            yield* go(chat.id)

            const parts = yield* toolParts(chat.id)
            enteredPath(parts)
            const running = yield* shells.list(chat.id)
            expect(running.map((shell) => shell.status)).toEqual(["running"])
          }),
        )
      }),
    60_000,
  )

  unix(
    "a denied enter leaves nothing on disk",
    () =>
      Effect.gen(function* () {
        const { dir, llm } = yield* repo
        const permission = yield* Permission.Service
        yield* inFolder(
          dir,
          Effect.gen(function* () {
            const chat = yield* createSession([...allowAll, { permission: "worktree", pattern: "*", action: "ask" }])
            yield* llm.tool("enter_worktree", { name: "denied" })
            yield* llm.text("done")

            const fiber = yield* go(chat.id).pipe(Effect.forkChild)
            const asked = yield* pollWithTimeout(
              permission.list().pipe(Effect.map((list) => list.find((item) => item.permission === "worktree"))),
              "enter_worktree never asked",
            )
            yield* permission.reply({ requestID: asked.id, reply: "reject" })
            yield* Fiber.await(fiber)

            expect(yield* exists(path.join(dir, ".opencode", "worktrees"))).toBe(false)
            const exclude = yield* Effect.promise(() =>
              fs.readFile(path.join(dir, ".git", "info", "exclude"), "utf8").catch(() => ""),
            )
            expect(exclude).not.toContain("worktrees")
            expect(yield* worktreeCount(dir)).toBe(1)
            expect((yield* git(dir, "branch", "--list", "*denied*")).text).toBe("")
          }),
        )
      }),
    60_000,
  )
})

describe("archiving a session inside an entered worktree", () => {
  unix(
    "disposes the worktree only when nothing would be lost",
    () =>
      Effect.gen(function* () {
        const { dir, llm } = yield* repo
        const sessions = yield* Session.Service
        const worktrees = yield* Worktree.Service
        const store = yield* InstanceStore.Service
        const status = yield* SessionStatus.Service
        const fsys = yield* FSUtil.Service
        yield* inFolder(
          dir,
          Effect.gen(function* () {
            const chat = yield* createSession()
            yield* llm.tool("enter_worktree", { name: "archived" })
            yield* llm.text("done")
            yield* go(chat.id)
            const entered = enteredPath(yield* toolParts(chat.id))
            yield* sessions.setArchived({ sessionID: chat.id, time: Date.now() })

            // The route runs in the session's own folder, the worktree.
            const dispose = inFolder(
              entered.path,
              Effect.gen(function* () {
                return yield* disposeSessionWorktree({
                  sessions,
                  worktrees,
                  store,
                  status,
                  fs: fsys,
                  info: yield* sessions.get(chat.id),
                })
              }),
            )

            yield* Effect.promise(() => Bun.write(path.join(entered.path, "wip.txt"), "unsaved\n"))
            expect(yield* dispose).toBeUndefined()
            expect(yield* exists(path.join(entered.path, "wip.txt"))).toBe(true)

            yield* Effect.promise(() => fs.rm(path.join(entered.path, "wip.txt")))
            expect(yield* dispose).toBe(entered.path)
            expect(yield* exists(entered.path)).toBe(false)
            expect((yield* store.loadedDirectories()).has(entered.path)).toBe(false)
          }),
        )
      }),
    60_000,
  )
})
