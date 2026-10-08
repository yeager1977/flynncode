import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session as SessionNs } from "@/session/session"
import { shouldDispose } from "../../src/worktree/session-binding"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

describe("handoff rebind", () => {
  it.instance("rebinds the session directory to the handoff target", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({ title: "handoff-rebind" })
      const target = `${created.directory}-handoff-target`

      yield* session.setDirectory({ sessionID: created.id, directory: target })

      expect((yield* session.get(created.id)).directory).toBe(target)
    }),
  )

  test("source disposable worktree is eligible for disposal after handoff completes", () => {
    const binding = { sessionID: "ses_1", directory: "/w/old", disposable: true }
    expect(shouldDispose(binding, { archived: false, running: false })).toBe(false)
    expect(shouldDispose({ ...binding }, { archived: true, running: false })).toBe(true)
  })
})
