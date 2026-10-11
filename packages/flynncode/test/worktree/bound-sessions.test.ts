import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@flynncode/core/effect/app-node-builder"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionProjector } from "@flynncode/core/session/projector"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session as SessionNs } from "@/session/session"
import { boundSessions, canonicalDir } from "../../src/worktree/bound-sessions"
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

describe("boundSessions", () => {
  it.instance("returns archived and unarchived sessions bound to the directory", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const target = "/w/bound-target"
      const first = yield* session.create({ title: "bound-one" })
      const second = yield* session.create({ title: "bound-two" })
      const other = yield* session.create({ title: "elsewhere" })
      void other
      yield* session.setDirectory({ sessionID: first.id, directory: target })
      yield* session.setDirectory({ sessionID: second.id, directory: target })
      yield* session.setArchived({ sessionID: second.id, time: Date.now() })

      const bound = yield* boundSessions(session, target)
      expect(bound.map((item) => item.id).sort()).toEqual([first.id, second.id].sort())
    }),
  )

  it.instance("canonicalDir strips trailing slashes", () =>
    Effect.gen(function* () {
      expect(canonicalDir("/w/a/")).toBe(canonicalDir("/w/a"))
      expect(canonicalDir("/w/a")).toBe("/w/a")
    }),
  )
})
