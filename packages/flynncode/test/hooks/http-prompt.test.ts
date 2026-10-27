import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { Database } from "@flynncode/core/database/database"
import { SessionProjector } from "@flynncode/core/session/projector"
import { FSUtil } from "@flynncode/core/fs-util"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import os from "os"
import path from "path"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { HooksExecutor } from "../../src/hooks/executor"
import { HooksTrust } from "../../src/hooks/trust"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { Auth } from "@/auth"
import { EventV2Bridge } from "@/event-v2-bridge"
import { MessageV2 } from "@/session/message-v2"

const dir = path.join(os.tmpdir(), `flynncode-hooks-http-prompt-${process.pid}`)
const trustPath = path.join(dir, "trust.json")

beforeEach(async () => {
  process.env["FLYNNCODE_HOOKS_TRUST_FILE"] = trustPath
  await Bun.write(trustPath, "[]")
})

afterEach(() => {
  delete process.env["HOOK_ALLOWED"]
  delete process.env["HOOK_BLOCKED"]
})

const decisionInput = {
  event: "PreToolUse" as const,
  matchName: "Bash",
  tool: "Bash",
  sessionID: "ses_1",
  callID: "c1",
  args: { command: "ls" },
}

function stubConfig(hooks: Record<string, unknown>) {
  return LayerNode.compile(HooksExecutor.node, [
    [
      Config.node,
      Layer.succeed(Config.Service, {
        get: () => Effect.succeed({ hooks }),
      } as Partial<Config.Interface> as Config.Interface),
    ],
    [RuntimeFlags.node, RuntimeFlags.layer({ bypassHookTrust: true })],
  ])
}

type Seen = { method: string; headers: Headers; body: string }

// A real local server that records each request and answers with `respond`.
async function withServer<A>(
  respond: (req: Request) => Response | Promise<Response>,
  run: (url: string, seen: Seen[]) => Promise<A>,
) {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.push({ method: req.method, headers: req.headers, body: await req.text() })
      return respond(req)
    },
  })
  try {
    return await run(`http://127.0.0.1:${server.port}/hook`, seen)
  } finally {
    await server.stop(true)
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const httpHooks = (handler: Record<string, unknown>, claude = false, event = "PreToolUse") => ({
  [event]: [{ ...(claude && { format: "claude" }), hooks: [{ type: "http", ...handler }] }],
})

describe("http handler", () => {
  test("native: a 2xx JSON decision is honored and the body is the hook input", async () => {
    await withServer(
      () => json({ behavior: "deny", message: "nope" }),
      async (url, seen) => {
        const decision = await Effect.runPromise(
          Effect.gen(function* () {
            return yield* (yield* HooksExecutor.Service).runDecision(decisionInput)
          }).pipe(Effect.provide(stubConfig(httpHooks({ url })))),
        )
        expect(decision).toEqual({ behavior: "deny", message: "nope" })
        expect(seen).toHaveLength(1)
        expect(seen[0]!.method).toBe("POST")
        expect(seen[0]!.headers.get("content-type")).toContain("application/json")
        const body = JSON.parse(seen[0]!.body)
        expect(body.event).toBe("PreToolUse")
        expect(body.tool).toBe("Bash")
        expect(body.args).toEqual({ command: "ls" })
      },
    )
  })

  test("claude: the body is Claude's input and Claude's JSON output is read", async () => {
    await withServer(
      () =>
        json({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "claude says no",
          },
        }),
      async (url, seen) => {
        const decision = await Effect.runPromise(
          Effect.gen(function* () {
            return yield* (yield* HooksExecutor.Service).runDecision(decisionInput)
          }).pipe(Effect.provide(stubConfig(httpHooks({ url }, true)))),
        )
        expect(decision).toEqual({ behavior: "deny", message: "claude says no" })
        const body = JSON.parse(seen[0]!.body)
        expect(body.hook_event_name).toBe("PreToolUse")
        expect(body.tool_name).toBe("Bash")
        expect(body.tool_input).toEqual({ command: "ls" })
        expect(body.session_id).toBe("ses_1")
      },
    )
  })

  test("a Claude block on Stop is returned from runObserve", async () => {
    await withServer(
      () => json({ decision: "block", reason: "keep going" }),
      async (url) => {
        const out = await Effect.runPromise(
          Effect.gen(function* () {
            return yield* (yield* HooksExecutor.Service).runObserve({
              event: "Stop",
              matchName: "",
              sessionID: "ses_1",
              payload: {},
            })
          }).pipe(Effect.provide(stubConfig(httpHooks({ url }, true, "Stop")))),
        )
        expect(out.block).toEqual({ reason: "keep going" })
      },
    )
  })

  test("headers interpolate only the names in allowedEnvVars", async () => {
    process.env["HOOK_ALLOWED"] = "allowed-secret"
    process.env["HOOK_BLOCKED"] = "blocked-secret"
    await withServer(
      () => json({ behavior: "undecided" }),
      async (url, seen) => {
        await Effect.runPromise(
          Effect.gen(function* () {
            return yield* (yield* HooksExecutor.Service).runDecision(decisionInput)
          }).pipe(
            Effect.provide(
              stubConfig(
                httpHooks({
                  url,
                  allowedEnvVars: ["HOOK_ALLOWED"],
                  headers: {
                    authorization: "Bearer $HOOK_ALLOWED",
                    "x-braced": "${HOOK_ALLOWED}!",
                    "x-blocked": "v=${HOOK_BLOCKED}",
                    "x-blocked-bare": "v=$HOOK_BLOCKED",
                  },
                }),
              ),
            ),
          ),
        )
        const headers = seen[0]!.headers
        expect(headers.get("authorization")).toBe("Bearer allowed-secret")
        expect(headers.get("x-braced")).toBe("allowed-secret!")
        expect(headers.get("x-blocked")).toBe("v=")
        expect(headers.get("x-blocked-bare")).toBe("v=")
      },
    )
  })

  test("a non-2xx status is ignored, even on a native decision hook", async () => {
    await withServer(
      () => json({ behavior: "deny", message: "ignored" }, 500),
      async (url, seen) => {
        const decision = await Effect.runPromise(
          Effect.gen(function* () {
            return yield* (yield* HooksExecutor.Service).runDecision(decisionInput)
          }).pipe(Effect.provide(stubConfig(httpHooks({ url })))),
        )
        expect(seen).toHaveLength(1)
        expect(decision).toEqual({ behavior: "undecided" })
      },
    )
  })

  test("a non-JSON body is ignored, even on a native decision hook", async () => {
    await withServer(
      () => new Response("all good", { status: 200 }),
      async (url) => {
        const decision = await Effect.runPromise(
          Effect.gen(function* () {
            return yield* (yield* HooksExecutor.Service).runDecision(decisionInput)
          }).pipe(Effect.provide(stubConfig(httpHooks({ url })))),
        )
        expect(decision).toEqual({ behavior: "undecided" })
      },
    )
  })

  test("a timeout is ignored", async () => {
    await withServer(
      async () => {
        await Bun.sleep(1500)
        return json({ behavior: "deny", message: "too late" })
      },
      async (url) => {
        const started = Date.now()
        const decision = await Effect.runPromise(
          Effect.gen(function* () {
            return yield* (yield* HooksExecutor.Service).runDecision(decisionInput)
          }).pipe(Effect.provide(stubConfig(httpHooks({ url, timeout: 0.2 })))),
        )
        expect(decision).toEqual({ behavior: "undecided" })
        expect(Date.now() - started).toBeLessThan(1400)
      },
    )
  })

  test("a connection error is ignored and later handlers still run", async () => {
    const decision = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* HooksExecutor.Service).runDecision(decisionInput)
      }).pipe(
        Effect.provide(
          stubConfig({
            PreToolUse: [{ hooks: [{ type: "http", url: "http://127.0.0.1:1/never" }] }],
          }),
        ),
      ),
    )
    expect(decision).toEqual({ behavior: "undecided" })
  })

  test("a PostToolUse http hook can block the output", async () => {
    await withServer(
      () => json({ blockedOutput: "redacted" }),
      async (url) => {
        const out = await Effect.runPromise(
          Effect.gen(function* () {
            return yield* (yield* HooksExecutor.Service).runPostTool({
              tool: "Bash",
              matchName: "Bash",
              sessionID: "ses_1",
              callID: "c1",
              args: {},
              output: "secret",
            })
          }).pipe(Effect.provide(stubConfig(httpHooks({ url }, false, "PostToolUse")))),
        )
        expect(out).toEqual({ blocked: true, reason: "redacted" })
      },
    )
  })
})

describe("trust hash", () => {
  const base = { event: "PreToolUse", matcher: "", type: "http" as const, url: "https://a.example/hook" }

  test("changes with the url, headers and prompt", () => {
    expect(HooksTrust.hashDef(base)).not.toBe(HooksTrust.hashDef({ ...base, url: "https://b.example/hook" }))
    expect(HooksTrust.hashDef({ ...base, headers: { a: "1" } })).not.toBe(
      HooksTrust.hashDef({ ...base, headers: { a: "2" } }),
    )
    const prompt = { event: "Stop", matcher: "", type: "prompt" as const, prompt: "is it done?" }
    expect(HooksTrust.hashDef(prompt)).not.toBe(HooksTrust.hashDef({ ...prompt, prompt: "is it really done?" }))
  })

  test("fromHandler carries the url through to the hash", () => {
    const a = HooksTrust.fromHandler("PreToolUse", undefined, { type: "http", url: "https://a.example/hook" })
    const b = HooksTrust.fromHandler("PreToolUse", undefined, { type: "http", url: "https://b.example/hook" })
    expect(HooksTrust.hashDef(a)).not.toBe(HooksTrust.hashDef(b))
  })
})

// The prompt handler runs one real LLM request, so these tests use the app
// graph with the test LLM server standing in for the provider.
const llmServer = LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })

const hooked = testEffect(
  LayerNode.compile(
    LayerNode.group([
      HooksExecutor.node,
      Plugin.node,
      Session.node,
      SessionProjector.node,
      MessageV2.node,
      LLM.node,
      Agent.node,
      Permission.node,
      Config.node,
      Provider.node,
      Auth.node,
      EventV2Bridge.node,
      Database.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      RuntimeFlags.node,
      llmServer,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer({ bypassHookTrust: true })]],
  ),
)
const unix = process.platform !== "win32" ? hooked.instance : hooked.instance.skip

const model = (id: string) => ({
  id,
  name: id,
  attachment: false,
  reasoning: false,
  temperature: false,
  tool_call: true,
  release_date: "2025-01-01",
  limit: { context: 100000, output: 10000 },
  cost: { input: 0, output: 0 },
  options: {},
})

const setup = Effect.fn("test.setup")(function* (extra: Record<string, unknown>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* Effect.promise(() =>
    Bun.write(
      path.join(dir, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        provider: {
          test: {
            name: "Test",
            id: "test",
            env: [],
            npm: "@ai-sdk/openai-compatible",
            models: { "test-model": model("test-model"), "alt-model": model("alt-model"), "small-model": model("small-model") },
            options: { apiKey: "test-key", baseURL: llm.url },
          },
        },
        model: "test/test-model",
        ...extra,
      }),
    ),
  )
  yield* (yield* Config.Service).get()
  const chat = yield* (yield* Session.Service).create({ title: "Pinned" })
  return { dir, llm, chat, executor: yield* HooksExecutor.Service }
})

const promptHooks = (handler: Record<string, unknown>, event = "PreToolUse") => ({
  hooks: { [event]: [{ hooks: [{ type: "prompt", ...handler }] }] },
})

// The hook's own request: the one that is not a title request.
const hookRequests = (llm: { inputs: Effect.Effect<Record<string, unknown>[]> }) =>
  llm.inputs.pipe(
    Effect.map((inputs) =>
      inputs.filter((input) => !JSON.stringify(input).includes("Generate a title for this conversation")),
    ),
  )

const decide = (executor: HooksExecutor.ExecutorInterface, sessionID: string) =>
  executor.runDecision({ ...decisionInput, sessionID, args: { command: "marker-xyz --flag" } })

unix(
  "prompt ok:false denies PreToolUse with the reason",
  () =>
    Effect.gen(function* () {
      const { llm, chat, executor } = yield* setup(promptHooks({ prompt: "Is this command safe? $ARGUMENTS" }))
      yield* llm.text('{"ok": false, "reason": "rm is dangerous"}')
      expect(yield* decide(executor, chat.id)).toEqual({ behavior: "deny", message: "rm is dangerous" })
    }),
  { git: true },
  30_000,
)

unix(
  "prompt ok:true is undecided and fenced JSON is accepted",
  () =>
    Effect.gen(function* () {
      const { llm, chat, executor } = yield* setup(promptHooks({ prompt: "Is this command safe? $ARGUMENTS" }))
      yield* llm.text('```json\n{"ok": true}\n```')
      expect(yield* decide(executor, chat.id)).toEqual({ behavior: "undecided" })
    }),
  { git: true },
  30_000,
)

unix(
  "prompt substitutes $ARGUMENTS with the input JSON, else appends it",
  () =>
    Effect.gen(function* () {
      const first = yield* setup(promptHooks({ prompt: "Check: $ARGUMENTS (end)" }))
      yield* first.llm.text('{"ok": true}')
      yield* decide(first.executor, first.chat.id)
      const sent = JSON.stringify(yield* hookRequests(first.llm))
      expect(sent).toContain("marker-xyz --flag")
      expect(sent).not.toContain("$ARGUMENTS")
      expect(sent).toContain("(end)")
    }),
  { git: true },
  30_000,
)

unix(
  "prompt appends the input JSON when $ARGUMENTS is absent",
  () =>
    Effect.gen(function* () {
      const { llm, chat, executor } = yield* setup(promptHooks({ prompt: "Judge this call." }))
      yield* llm.text('{"ok": true}')
      yield* decide(executor, chat.id)
      const sent = JSON.stringify(yield* hookRequests(llm))
      expect(sent).toContain("Judge this call.")
      expect(sent).toContain("marker-xyz --flag")
    }),
  { git: true },
  30_000,
)

unix(
  "prompt invalid JSON and model errors are ignored",
  () =>
    Effect.gen(function* () {
      const { llm, chat, executor } = yield* setup(promptHooks({ prompt: "Is this safe? $ARGUMENTS" }))
      yield* llm.text("I think it is probably fine")
      expect(yield* decide(executor, chat.id)).toEqual({ behavior: "undecided" })
      yield* llm.text('{"ok": "maybe"}')
      expect(yield* decide(executor, chat.id)).toEqual({ behavior: "undecided" })
      yield* llm.error(500, { error: { message: "boom" } })
      expect(yield* decide(executor, chat.id)).toEqual({ behavior: "undecided" })
    }),
  { git: true },
  60_000,
)

unix(
  "prompt ok:false blocks Stop, SubagentStop and UserPromptSubmit but only logs on SessionStart",
  () =>
    Effect.gen(function* () {
      const { llm, chat, executor } = yield* setup({
        hooks: {
          Stop: [{ hooks: [{ type: "prompt", prompt: "Done? $ARGUMENTS" }] }],
          SubagentStop: [{ hooks: [{ type: "prompt", prompt: "Done? $ARGUMENTS" }] }],
          UserPromptSubmit: [{ hooks: [{ type: "prompt", prompt: "Allowed? $ARGUMENTS" }] }],
          SessionStart: [{ hooks: [{ type: "prompt", prompt: "Fine? $ARGUMENTS" }] }],
        },
      })
      const observe = (event: "Stop" | "SubagentStop" | "UserPromptSubmit" | "SessionStart") =>
        executor.runObserve({ event, matchName: "", sessionID: chat.id, payload: {} })
      yield* llm.text('{"ok": false, "reason": "run the tests"}')
      expect((yield* observe("Stop")).block).toEqual({ reason: "run the tests" })
      yield* llm.text('{"ok": false, "reason": "not finished"}')
      expect((yield* observe("SubagentStop")).block).toEqual({ reason: "not finished" })
      yield* llm.text('{"ok": false, "reason": "off topic"}')
      expect((yield* observe("UserPromptSubmit")).block).toEqual({ reason: "off topic" })
      yield* llm.text('{"ok": false, "reason": "ignored"}')
      expect((yield* observe("SessionStart")).block).toBeUndefined()
      yield* llm.text('{"ok": true}')
      expect((yield* observe("Stop")).block).toBeUndefined()
    }),
  { git: true },
  60_000,
)

unix(
  "a Claude-format prompt hook blocks Stop",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, ".claude", "settings.json"),
          JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "prompt", prompt: "Done? $ARGUMENTS" }] }] } }),
        ),
      )
      const { llm, chat, executor } = yield* setup({})
      yield* llm.text('{"ok": false, "reason": "claude: not done"}')
      const out = yield* executor.runObserve({ event: "Stop", matchName: "", sessionID: chat.id, payload: {} })
      expect(out.block).toEqual({ reason: "claude: not done" })
      // The input is Claude's.
      expect(JSON.stringify(yield* hookRequests(llm))).toContain("hook_event_name")
    }),
  { git: true },
  30_000,
)

unix(
  "prompt model: the handler's model wins over small_model",
  () =>
    Effect.gen(function* () {
      const { llm, chat, executor } = yield* setup({
        ...promptHooks({ prompt: "Ok? $ARGUMENTS", model: "test/alt-model" }),
        small_model: "test/small-model",
      })
      yield* llm.text('{"ok": true}')
      yield* decide(executor, chat.id)
      expect((yield* hookRequests(llm)).map((input) => input["model"])).toEqual(["alt-model"])
    }),
  { git: true },
  30_000,
)

unix(
  "prompt model falls back to small_model",
  () =>
    Effect.gen(function* () {
      const { llm, chat, executor } = yield* setup({
        ...promptHooks({ prompt: "Ok? $ARGUMENTS" }),
        small_model: "test/small-model",
      })
      yield* llm.text('{"ok": true}')
      yield* decide(executor, chat.id)
      expect((yield* hookRequests(llm)).map((input) => input["model"])).toEqual(["small-model"])
    }),
  { git: true },
  30_000,
)

unix(
  "prompt model falls back to the session model without a small_model",
  () =>
    Effect.gen(function* () {
      const { llm, chat, executor } = yield* setup(promptHooks({ prompt: "Ok? $ARGUMENTS" }))
      yield* llm.text('{"ok": true}')
      yield* decide(executor, chat.id)
      const models = (yield* hookRequests(llm)).map((input) => input["model"])
      expect(models).toEqual(["test-model"])
    }),
  { git: true },
  30_000,
)
