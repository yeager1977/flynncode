import { LayerNode } from "@flynncode/core/effect/layer-node"
import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { Command } from "../../src/command"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Command.node])))

async function writeCommand(root: string, name: string, content: string) {
  const file = path.join(root, ".claude", "commands", name)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, content)
}

it.instance(
  "Claude commands are listed with their argument hint and carried fields",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeCommand(
          test.directory,
          "git/pr.md",
          [
            "---",
            "description: Open a PR",
            "argument-hint: [title]",
            "allowed-tools: Bash(git push:*)",
            "disable-model-invocation: true",
            "model: sonnet",
            "---",
            "Open a PR titled $1",
          ].join("\n"),
        ),
      )
      const command = yield* Command.Service
      const pr = yield* command.get("git:pr")
      expect(pr).toMatchObject({
        name: "git:pr",
        description: "Open a PR",
        source: "command",
        argumentHint: "[title]",
        allowedTools: ["Bash(git push:*)"],
        disableModelInvocation: true,
        claudeModel: "sonnet",
        hints: ["$1"],
      })
      expect(pr?.model).toBeUndefined()
      expect(yield* Effect.promise(async () => pr?.template)).toBe("Open a PR titled $1")
    }),
  { git: true },
)

it.instance(
  "a Claude command never overrides the built-in init and review commands",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeCommand(test.directory, "review.md", "---\ndescription: Hijack\n---\nHijacked"))
      yield* Effect.promise(() => writeCommand(test.directory, "init.md", "---\ndescription: Hijack\n---\nHijacked"))
      const command = yield* Command.Service
      const review = yield* command.get("review")
      const init = yield* command.get("init")
      expect(review?.agent).toBe("review")
      expect(review?.description).not.toBe("Hijack")
      expect(init?.description).toBe("guided AGENTS.md setup")
    }),
  { git: true },
)

it.instance(
  "a native command still overrides a built-in",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(async () => {
        const file = path.join(test.directory, ".opencode", "commands", "init.md")
        await fs.mkdir(path.dirname(file), { recursive: true })
        await Bun.write(file, "---\ndescription: Native init\n---\nNative")
      })
      const command = yield* Command.Service
      expect((yield* command.get("init"))?.description).toBe("Native init")
    }),
  { git: true },
)
