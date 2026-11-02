import { expect } from "bun:test"
import path from "path"
import { Effect, FileSystem, Layer, Stream } from "effect"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { LayerNodePlatform } from "@flynncode/core/effect/app-node-platform"
import { SessionProjector } from "@flynncode/core/session/projector"
import { ProviderV2 } from "@flynncode/core/provider"
import { ModelV2 } from "@flynncode/core/model"
import { LLMEvent } from "@flynncode/llm"
import { CrossSpawnSpawner } from "@flynncode/core/cross-spawn-spawner"
import { SessionMemoryCurate } from "@/session/memory-curate"
import { Session } from "@/session/session"
import { Memory } from "@/memory/memory"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MessageID, PartID } from "@/session/schema"
import { ProviderTest } from "../fake/provider"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

// The model restates a covered fact under a fresh slug, adds a new fact to an
// existing topic, and emits a placeholder: only the new fact may reach disk.
const reply = [
  "SLUG: workflow-habits",
  "- Commit fixes once confirmed and merge completed work to dev",
  "SLUG: mobile-connector",
  "- The gateway relays phone traffic over a Cloudflare tunnel",
  "SLUG: tmp-key",
  "- temporary note",
].join("\n")
const compression = { reply: "" }
const prompts: string[] = []
const llm = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: (input) =>
      Stream.fromEffect(
        Effect.sync(() => {
          const prompt = JSON.stringify(input.messages)
          prompts.push(prompt)
          return LLMEvent.textDelta({
            id: "memory",
            text: prompt.includes("Compress the memory topic") ? compression.reply : reply,
          })
        }),
      ),
  }),
)

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      SessionMemoryCurate.node,
      Memory.node,
      Session.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      LayerNodePlatform.filesystem,
    ]),
    [
      [
        Config.node,
        Layer.succeed(
          Config.Service,
          TestConfig.make({ get: () => Effect.succeed({ memory: { enabled: true, min_turns: 1 } }) }),
        ),
      ],
      [Provider.node, ProviderTest.fake({ model: { id: "test-model", providerID: "test" } as Provider.Model }).layer],
      [LLM.node, llm],
    ],
  ),
)

it.instance(
  "extraction against the consolidated set adds no duplicate topic",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const memory = yield* Memory.Service
      const dir = yield* memory.projectDir()
      const fixtures = path.join(import.meta.dir, "..", "memory", "fixtures", "consolidated")
      const seeded = (yield* fs.readDirectory(fixtures)).toSorted()
      yield* fs.makeDirectory(dir, { recursive: true })
      yield* Effect.forEach(seeded, (file) => fs.copyFile(path.join(fixtures, file), path.join(dir, file)))

      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const message = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: message.id,
        type: "text",
        text: "commit them and merge to dev; the phone gateway goes over cloudflared",
      })
      yield* (yield* SessionMemoryCurate.Service).extractFor(
        session.id,
        yield* sessions.messages({ sessionID: session.id }),
      )

      expect(prompts.at(-1)).toContain("SLUG: user-working-style")
      expect((yield* fs.readDirectory(dir)).toSorted()).toEqual(seeded)
      const original = yield* fs.readFileString(path.join(fixtures, "mobile-connector.md"))
      expect(yield* fs.readFileString(path.join(dir, "mobile-connector.md"))).toBe(
        `${original.trimEnd()}\n- The gateway relays phone traffic over a Cloudflare tunnel`,
      )
      expect(yield* fs.readFileString(path.join(dir, "user-working-style.md"))).toBe(
        yield* fs.readFileString(path.join(fixtures, "user-working-style.md")),
      )
    }),
  { git: true },
)

// A topic already near max_chars_per_file (4000 by default) goes over it once
// the extraction appends a bullet.
const oversized = Array.from({ length: 100 }, (_, i) => `- archived pairing code slot ${i} maps to device ${i}`).join(
  "\n",
)

const extractOverOversized = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const memory = yield* Memory.Service
  const dir = yield* memory.projectDir()
  yield* fs.makeDirectory(dir, { recursive: true })
  yield* fs.writeFileString(path.join(dir, "mobile-connector.md"), oversized)
  const sessions = yield* Session.Service
  const session = yield* sessions.create({})
  const message = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: session.id,
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
    time: { created: Date.now() },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: session.id,
    messageID: message.id,
    type: "text",
    text: "the phone gateway goes over cloudflared",
  })
  const curate = yield* SessionMemoryCurate.Service
  yield* curate.extractFor(session.id, yield* sessions.messages({ sessionID: session.id }))
  return yield* fs.readFileString(path.join(dir, "mobile-connector.md"))
})

it.instance(
  "compresses a topic the append pushes over max_chars_per_file",
  () =>
    Effect.gen(function* () {
      compression.reply = "- Pairing code slots 0-99 map to devices 0-99\n- The gateway relays phone traffic over a Cloudflare tunnel"
      expect(yield* extractOverOversized).toBe(compression.reply)
      expect(prompts.at(-1)).toContain("Compress the memory topic")
      expect(prompts.at(-1)).toContain("- The gateway relays phone traffic over a Cloudflare tunnel")
    }),
  { git: true },
)

it.instance(
  "keeps the newest lines when compression fails",
  () =>
    Effect.gen(function* () {
      compression.reply = ""
      const text = yield* extractOverOversized
      expect(text.length).toBeLessThanOrEqual(3000)
      expect(text.endsWith("- The gateway relays phone traffic over a Cloudflare tunnel")).toBe(true)
      expect(text).not.toContain("slot 0 maps")
    }),
  { git: true },
)
