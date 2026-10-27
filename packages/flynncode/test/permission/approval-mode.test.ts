import { test, expect } from "bun:test"
import { DeniedError } from "@flynncode/core/v1/permission"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { AppNodeBuilder } from "@flynncode/core/effect/app-node-builder"
import { SessionID } from "../../src/session/schema"
import { pollWithTimeout, testEffect } from "../lib/effect"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

it.instance("auto approval resolves without prompting on a reviewer allow", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    // The approval shortcut now requires the LLM auto-reviewer verdict; this
    // fixture supplies an allow verdict the way the session tools gate does.
    yield* permission.ask({
      sessionID: SessionID.make("session_test"),
      permission: "bash",
      patterns: ["npm run build"],
      metadata: {},
      always: [],
      ruleset: [],
      approval: "auto",
      reviewer: "allow",
    })
    const pending = yield* permission.list()
    expect(pending.length).toBe(0)
  }),
)

it.instance("auto approval prompts when no reviewer verdict is supplied", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* permission
      .ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["npm run build"],
        metadata: {},
        always: [],
        ruleset: [],
        approval: "auto",
      })
      .pipe(Effect.forkScoped)
    yield* pollWithTimeout(
      permission.list().pipe(Effect.map((pending) => (pending.length === 1 ? true : undefined))),
      "auto approval without a reviewer verdict never prompted",
    )
    yield* Fiber.interrupt(fiber)
  }),
)

it.instance("auto approval fails closed on a reviewer deny", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const exit = yield* permission
      .ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["npm run build"],
        metadata: {},
        always: [],
        ruleset: [],
        approval: "auto",
        reviewer: "deny",
      })
      .pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(DeniedError)
    }
    expect((yield* permission.list()).length).toBe(0)
  }),
)

it.instance("accept-edits auto-resolves edit but prompts bash", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    yield* permission.ask({
      sessionID: SessionID.make("session_test"),
      permission: "edit",
      patterns: ["src/a.ts"],
      metadata: {},
      always: [],
      ruleset: [],
      approval: "accept-edits",
    })
    expect((yield* permission.list()).length).toBe(0)
    const fiber = yield* permission
      .ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["rm -rf /tmp/x"],
        metadata: {},
        always: [],
        ruleset: [],
        approval: "accept-edits",
      })
      .pipe(Effect.forkScoped)
    yield* Effect.gen(function* () {
      while (true) {
        const pending = yield* permission.list()
        if (pending.length === 1) return
        yield* Effect.sleep("10 millis")
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "1 second",
        orElse: () => Effect.fail(new Error("timed out waiting for 1 pending permission request")),
      }),
    )
    expect((yield* permission.list()).length).toBe(1)
    yield* Fiber.interrupt(fiber)
  }),
)

it.instance("auto approval still prompts for archive", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* permission
      .ask({
        sessionID: SessionID.make("session_test"),
        permission: "archive",
        patterns: ["ses_other"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "archive", pattern: "*", action: "ask" }],
        approval: "auto",
      })
      .pipe(Effect.forkScoped)
    yield* pollWithTimeout(
      permission.list().pipe(Effect.map((pending) => (pending.length === 1 ? true : undefined))),
      "archive never prompted",
    )
    yield* Fiber.interrupt(fiber)
  }),
)

const forcedPrompt = (input: Partial<Permission.AskInput>) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* permission
      .ask({
        sessionID: SessionID.make("session_test"),
        permission: "edit",
        patterns: ["src/a.ts"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "edit", pattern: "*", action: "allow" }],
        force: true,
        ...input,
      })
      .pipe(Effect.forkScoped)
    yield* pollWithTimeout(
      permission.list().pipe(Effect.map((pending) => (pending.length === 1 ? true : undefined))),
      "a forced ask never prompted",
    )
    yield* Fiber.interrupt(fiber)
  })

it.instance("a forced ask prompts although a rule allows it", () => forcedPrompt({}))

it.instance("a forced ask prompts under accept-edits and a static approval", () =>
  forcedPrompt({ approval: "accept-edits", staticApproval: "allow" }),
)

it.instance("a forced ask is still answered by the auto-reviewer's allow", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    yield* permission.ask({
      sessionID: SessionID.make("session_test"),
      permission: "bash",
      patterns: ["*"],
      metadata: {},
      always: [],
      ruleset: [],
      approval: "auto",
      reviewer: "allow",
      force: true,
    })
    expect(yield* permission.list()).toEqual([])
  }),
)

it.instance("a forced ask still fails on a deny rule", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const exit = yield* permission
      .ask({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["rm -rf /"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "rm *", action: "deny" }],
        force: true,
      })
      .pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(DeniedError)
  }),
)

const pendingAsk = (input: Partial<Permission.AskInput> & { patterns: string[] }) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const before = (yield* permission.list()).length
    const fiber = yield* permission
      .ask({
        sessionID: SessionID.make("session_test"),
        permission: "edit",
        metadata: {},
        always: ["*"],
        ruleset: [{ permission: "edit", pattern: "*", action: "ask" }],
        ...input,
      })
      .pipe(Effect.exit, Effect.forkScoped)
    const request = yield* pollWithTimeout(
      permission.list().pipe(Effect.map((pending) => (pending.length > before ? pending.at(-1) : undefined))),
      "the ask never prompted",
    )
    return { request, fiber }
  })

it.instance("an always reply to another prompt never resolves a forced prompt", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const forced = yield* pendingAsk({ patterns: ["src/.env"], force: true })
    expect(forced.request.always).toEqual([])
    const other = yield* pendingAsk({ patterns: ["src/a.ts"] })
    yield* permission.reply({ requestID: other.request.id, reply: "always" })
    expect(Exit.isSuccess(yield* Fiber.join(other.fiber))).toBe(true)
    expect((yield* permission.list()).map((item) => item.id)).toEqual([forced.request.id])
    yield* Fiber.interrupt(forced.fiber)
  }),
)

it.instance("an always reply to a forced prompt approves only that call", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const waiting = yield* pendingAsk({ patterns: ["src/b.ts"] })
    const forced = yield* pendingAsk({ patterns: ["src/a.ts"], always: ["*"], force: true })
    yield* permission.reply({ requestID: forced.request.id, reply: "always" })
    expect(Exit.isSuccess(yield* Fiber.join(forced.fiber))).toBe(true)
    expect((yield* permission.list()).map((item) => item.id)).toEqual([waiting.request.id])
    const next = yield* pendingAsk({ patterns: ["src/a.ts"] })
    expect(next.request.patterns).toEqual(["src/a.ts"])
    yield* Fiber.interrupt(waiting.fiber)
    yield* Fiber.interrupt(next.fiber)
  }),
)
