import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { Npm } from "@flynncode/core/npm"
import path from "path"
import { pathToFileURL } from "url"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"

import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { ProviderV2 } from "@flynncode/core/provider"
import { ModelV2 } from "@flynncode/core/model"
import { AppNodeBuilder } from "@flynncode/core/effect/app-node-builder"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { ModelsDev } from "@flynncode/core/models-dev"
import { EventV2 } from "@flynncode/core/event"
import { Location } from "@flynncode/core/location"
import { Project } from "@flynncode/core/project"
import { AbsolutePath } from "@flynncode/core/schema"
import { pollWithTimeout } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Plugin.node, CrossSpawnSpawner.node, EventV2.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)
const systemHook = "experimental.chat.system.transform"

function withProject<A, E, R>(source: string, self: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const test = yield* TestInstance
    const file = path.join(test.directory, "plugin.ts")
    yield* Effect.all(
      [
        Effect.promise(() => Bun.write(file, source)),
        Effect.promise(() =>
          Bun.write(
            path.join(test.directory, "opencode.json"),
            JSON.stringify(
              {
                $schema: "https://opencode.ai/config.json",
                plugin: [pathToFileURL(file).href],
              },
              null,
              2,
            ),
          ),
        ),
      ],
      { discard: true, concurrency: 2 },
    )
    return yield* self
  })
}

const triggerSystemTransform = Effect.fn("PluginTriggerTest.triggerSystemTransform")(function* () {
  const plugin = yield* Plugin.Service
  const out = { system: [] as string[] }
  yield* plugin.trigger(
    systemHook,
    {
      model: {
        providerID: ProviderV2.ID.anthropic,
        modelID: ModelV2.ID.make("claude-sonnet-4-6"),
      },
    },
    out,
  )
  return out.system
})

describe("plugin.trigger", () => {
  it.instance("runs synchronous hooks without crashing", () =>
    withProject(
      [
        "export default async () => ({",
        `  ${JSON.stringify(systemHook)}: (_input, output) => {`,
        '    output.system.unshift("sync")',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual(["sync"])
      }),
    ),
  )

  it.instance("awaits asynchronous hooks", () =>
    withProject(
      [
        "export default async () => ({",
        `  ${JSON.stringify(systemHook)}: async (_input, output) => {`,
        "    await Bun.sleep(1)",
        '    output.system.unshift("async")',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual(["async"])
      }),
    ),
  )
})

describe("plugin event delivery", () => {
  const recorded = (test: { directory: string }, name: string) => {
    const file = path.join(test.directory, name)
    const read = Effect.gen(function* () {
      const text = yield* Effect.promise(() =>
        Bun.file(file)
          .text()
          .catch(() => ""),
      )
      return text
    })
    return { read, file }
  }

  const source = (eventsFile: string) =>
    [
      "export default async () => ({",
      `  event: async ({ event }) => {`,
      `    await Bun.write(${JSON.stringify(eventsFile)}, (event.type + " " + String(event.location?.directory ?? "global") + "\\n"), { append: true })`,
      `  },`,
      `})`,
      "",
    ].join("\n")

  // The listener registers during the Plugin.Service state build, which is
  // lazy per directory — force it with a harmless trigger before publishing.
  const loadHooks = Effect.gen(function* () {
    const pluginSvc = yield* Plugin.Service
    yield* pluginSvc.trigger("experimental.chat.system.transform", {}, { system: [] as string[] })
  })

  it.instance("location-less v2 events reach plugin event hooks", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { read, file } = recorded(test, "events-global.txt")
      // Use the raw EventV2.Service (not EventV2Bridge) so the publish has no
      // ambient InstanceRef location attached — EventV2Bridge.publish fills in
      // the current instance's directory when one is in scope, which this
      // test (running inside it.instance) always has, so it could never
      // produce a genuinely location-less event. ModelsDev itself publishes
      // through the raw EventV2.Service for exactly this reason.
      const events = yield* EventV2.Service
      yield* withProject(
        source(file),
        Effect.gen(function* () {
          yield* loadHooks
          yield* events.publish(ModelsDev.Event.Refreshed, {})
        }),
      )
      yield* pollWithTimeout(
        Effect.flatMap(read, (text) =>
          text.includes("models-dev.refreshed") ? Effect.succeed(true) : Effect.succeed(undefined),
        ),
        "plugin event hook never saw the location-less refresh event",
      )
    }),
  )

  it.instance("events scoped to another directory stay filtered", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { read, file } = recorded(test, "events-other.txt")
      const events = yield* EventV2.Service
      yield* withProject(
        source(file),
        Effect.gen(function* () {
          yield* loadHooks
          yield* events.publish(
            ModelsDev.Event.Refreshed,
            {},
            {
              location: new Location.Info({
                directory: AbsolutePath.make("/other-directory"),
                project: { id: Project.ID.make("other-project"), directory: AbsolutePath.make("/other-directory") },
              }),
            },
          )
        }),
      )
      yield* Effect.sleep("300 millis")
      const text = yield* read
      expect(text).not.toContain("models-dev.refreshed")
    }),
  )
})
