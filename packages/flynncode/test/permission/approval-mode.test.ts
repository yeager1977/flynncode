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
