import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Database } from "@flynncode/core/database/database"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { SessionProjector } from "@flynncode/core/session/projector"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { Ripgrep } from "@flynncode/core/ripgrep"
import { FSUtil } from "@flynncode/core/fs-util"
import { ProviderV2 } from "@flynncode/core/provider"
import { ModelV2 } from "@flynncode/core/model"
import { Effect, Exit, Fiber, Queue } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { Provider } from "@/provider/provider"
import { Todo } from "@/session/todo"
import { MessageID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Question } from "../../src/question"
import { Permission } from "../../src/permission"
import { EnterPlanModeTool, ExitPlanModeTool } from "../../src/tool/plan"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { Worktree } from "../../src/worktree"
import { InstanceStore } from "../../src/project/instance-store"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

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
      ToolRegistry.node,
      Question.node,
      FSUtil.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
      Worktree.node,
      Provider.node,
      Todo.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer()],
      [InstanceStore.bootstrapNode, InstanceBootstrap.node],
    ],
  ),
)

const seed = Effect.fn("PlanToolTest.seed")(function* (agent: string, parentID?: SessionID) {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "plan", ...(parentID ? { parentID } : {}) })
  yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent,
    model: { ...ref, variant: "high" },
    time: { created: Date.now() },
  })
  return chat
})

const ctx = (sessionID: SessionID, agent: string) => ({
  sessionID,
  messageID: MessageID.ascending(),
  callID: "call-plan",
  agent,
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const lastUser = Effect.fn("PlanToolTest.lastUser")(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  const messages = yield* sessions.messages({ sessionID })
  return messages.findLast((item) => item.info.role === "user")
})

const pending = Effect.fn("PlanToolTest.pending")(function* () {
  const question = yield* Question.Service
  const events = yield* EventV2Bridge.Service
  const asked = yield* Queue.unbounded<void>()
  const off = yield* events.listen((event) => {
    if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(asked, undefined)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)
  for (;;) {
    const item = (yield* question.list())[0]
    if (item) return item
    yield* Queue.take(asked).pipe(Effect.timeout("2 seconds"))
  }
})

// Starts exit_plan_mode, waits for its question and settles it with `answer`
// (or dismisses it when `answer` is undefined).
const exitWith = Effect.fn("PlanToolTest.exitWith")(function* (sessionID: SessionID, answer: string | undefined) {
  const question = yield* Question.Service
  const def = yield* (yield* ExitPlanModeTool).init()
  const fiber = yield* def.execute({ plan: "# Plan\n\n- step one" }, ctx(sessionID, "plan")).pipe(Effect.forkScoped)
  const item = yield* pending()
  if (answer === undefined) yield* question.reject(item.id)
  if (answer !== undefined) yield* question.reply({ requestID: item.id, answers: [[answer]] })
  return { item, result: yield* Fiber.join(fiber) }
})

const planPath = Effect.fn("PlanToolTest.planPath")(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  return Session.plan(yield* sessions.get(sessionID), yield* InstanceState.context)
})

describe("tool.enter_plan_mode", () => {
  it.instance(
    "switches the next loop turn to the plan agent",
    () =>
      Effect.gen(function* () {
        const chat = yield* seed("build")
        const def = yield* (yield* EnterPlanModeTool).init()
        const result = yield* def.execute({ reason: "touches the auth flow" }, ctx(chat.id, "build"))

        expect(result.output).toContain("Switched to plan mode")
        expect(result.metadata).toMatchObject({ mode: "plan", reason: "touches the auth flow", previousAgent: "build" })
        const user = yield* lastUser(chat.id)
        expect(user?.info.role === "user" && user.info.agent).toBe("plan")
        expect(user?.info.role === "user" && user.info.model).toEqual({ ...ref, variant: "high" })
        const text = user?.parts.find((part) => part.type === "text")
        expect(text?.type === "text" && text.synthetic).toBe(true)
        expect(text?.type === "text" && text.text).toContain("touches the auth flow")
      }),
    { git: true },
  )

  it.instance(
    "is refused in a child session",
    () =>
      Effect.gen(function* () {
        const parent = yield* seed("build")
        const child = yield* seed("general", parent.id)
        const def = yield* (yield* EnterPlanModeTool).init()
        const exit = yield* def.execute({ reason: "x" }, ctx(child.id, "build")).pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        const user = yield* lastUser(child.id)
        expect(user?.info.role === "user" && user.info.agent).toBe("general")
      }),
    { git: true },
  )

  it.instance(
    "is refused when the agent is already plan",
    () =>
      Effect.gen(function* () {
        const chat = yield* seed("plan")
        const def = yield* (yield* EnterPlanModeTool).init()
        const exit = yield* def.execute({ reason: "x" }, ctx(chat.id, "plan")).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    { git: true },
  )
})

describe("tool.exit_plan_mode", () => {
  it.instance(
    "writes the plan file before asking with the three approval options",
    () =>
      Effect.gen(function* () {
        const chat = yield* seed("plan")
        const question = yield* Question.Service
        const def = yield* (yield* ExitPlanModeTool).init()
        const fiber = yield* def.execute({ plan: "# Plan\n\n- step one" }, ctx(chat.id, "plan")).pipe(Effect.forkScoped)
        const item = yield* pending()
        const file = yield* planPath(chat.id)

        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("# Plan\n\n- step one")
        expect(item.questions[0]?.custom).toBe(true)
        expect(item.questions[0]?.options.map((option) => option.label)).toEqual([
          "Approve — auto-accept edits",
          "Approve — ask for each edit",
          "Keep planning",
        ])
        expect(item.tool).toEqual({ messageID: expect.any(String), callID: "call-plan" })
        yield* question.reject(item.id)
        yield* Fiber.join(fiber)
      }),
    { git: true },
  )

  it.instance(
    "approve with auto-accept edits switches to build",
    () =>
      Effect.gen(function* () {
        const chat = yield* seed("plan")
        const done = yield* exitWith(chat.id, "Approve — auto-accept edits")
        const file = yield* planPath(chat.id)

        expect(done.result.metadata).toMatchObject({ approved: true, approval: "accept-edits", planPath: file })
        const user = yield* lastUser(chat.id)
        expect(user?.info.role === "user" && user.info.agent).toBe("build")
        const text = user?.parts.find((part) => part.type === "text")
        expect(text?.type === "text" && text.text).toContain(path.join(".opencode", "plans", path.basename(file)))
        expect(text?.type === "text" && text.text).toContain("has been approved; implement it.")
      }),
    { git: true },
  )

  it.instance(
    "approve asking for each edit switches to build with manual approval",
    () =>
      Effect.gen(function* () {
        const chat = yield* seed("plan")
        const done = yield* exitWith(chat.id, "Approve — ask for each edit")

        expect(done.result.metadata).toMatchObject({ approved: true, approval: "manual" })
        const user = yield* lastUser(chat.id)
        expect(user?.info.role === "user" && user.info.agent).toBe("build")
      }),
    { git: true },
  )

  it.instance(
    "keep planning stays in plan without feedback",
    () =>
      Effect.gen(function* () {
        const chat = yield* seed("plan")
        const done = yield* exitWith(chat.id, "Keep planning")

        expect(done.result.metadata.approved).toBe(false)
        expect(done.result.metadata).not.toHaveProperty("feedback")
        expect(done.result.output).toContain("keep planning")
        const user = yield* lastUser(chat.id)
        expect(user?.info.role === "user" && user.info.agent).toBe("plan")
      }),
    { git: true },
  )

  it.instance(
    "a custom answer is returned to the model as feedback",
    () =>
      Effect.gen(function* () {
        const chat = yield* seed("plan")
        const done = yield* exitWith(chat.id, "Also cover the migration")

        expect(done.result.metadata).toMatchObject({ approved: false, feedback: "Also cover the migration" })
        expect(done.result.output).toContain("Also cover the migration")
        const user = yield* lastUser(chat.id)
        expect(user?.info.role === "user" && user.info.agent).toBe("plan")
      }),
    { git: true },
  )

  it.instance(
    "dismissing the question keeps planning without an error",
    () =>
      Effect.gen(function* () {
        const chat = yield* seed("plan")
        const done = yield* exitWith(chat.id, undefined)

        expect(done.result.metadata.approved).toBe(false)
        expect(done.result.metadata).not.toHaveProperty("feedback")
        const user = yield* lastUser(chat.id)
        expect(user?.info.role === "user" && user.info.agent).toBe("plan")
      }),
    { git: true },
  )
})

describe("plan mode permissions", () => {
  it.instance("build may enter plan mode and only plan may exit it", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      const plan = yield* agents.get("plan")
      const general = yield* agents.get("general")
      const explore = yield* agents.get("explore")

      expect(Permission.evaluate("enter_plan_mode", "*", build.permission).action).toBe("allow")
      expect(Permission.evaluate("exit_plan_mode", "*", build.permission).action).toBe("deny")
      expect(Permission.evaluate("exit_plan_mode", "*", plan.permission).action).toBe("allow")
      expect(Permission.evaluate("enter_plan_mode", "*", plan.permission).action).toBe("deny")
      for (const agent of [general, explore]) {
        expect(Permission.evaluate("enter_plan_mode", "*", agent.permission).action).toBe("deny")
        expect(Permission.evaluate("exit_plan_mode", "*", agent.permission).action).toBe("deny")
      }
    }),
  )

  it.instance(
    "legacy plan_enter and plan_exit config keys still apply",
    () =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        const build = yield* agents.get("build")
        const plan = yield* agents.get("plan")
        expect(Permission.evaluate("enter_plan_mode", "*", build.permission).action).toBe("deny")
        expect(Permission.evaluate("exit_plan_mode", "*", plan.permission).action).toBe("ask")
      }),
    { config: { permission: { plan_enter: "deny", plan_exit: "ask" } } },
  )

  it.instance("the registry offers enter to primary agents and exit to plan only", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const ids = Effect.fnUntraced(function* (name: string) {
        const tools = yield* registry.tools({ ...ref, agent: yield* agents.get(name) })
        return tools.map((tool) => tool.id)
      })

      const build = yield* ids("build")
      expect(build).toContain("enter_plan_mode")
      expect(build).not.toContain("exit_plan_mode")
      const plan = yield* ids("plan")
      expect(plan).toContain("exit_plan_mode")
      expect(plan).not.toContain("enter_plan_mode")
      const general = yield* ids("general")
      expect(general).not.toContain("enter_plan_mode")
      expect(general).not.toContain("exit_plan_mode")
    }),
  )
})
