import { describe, expect } from "bun:test"
import { Effect, FileSystem } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { Knowledge } from "../../src/knowledge/knowledge"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Knowledge.node, LayerNodePlatform.filesystem, LayerNodePlatform.path])),
)

function slugPath(worktree: string, slug: string) {
  return `${worktree}/.opencode/knowledge/${slug}.md`
}

describe("Knowledge service", () => {
  it.effect("save then get round-trips title and body", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const worktree = yield* fs.makeTempDirectoryScoped()
      const knowledge = yield* Knowledge.Service

      yield* knowledge.save({ worktree, slug: "onboarding", title: "Onboarding", body: "# Onboarding\nHello" })
      const entry = yield* knowledge.get({ worktree, slug: "onboarding" })

      expect(entry?.title).toBe("Onboarding")
      expect(entry?.body).toContain("Hello")
      expect(entry?.path).toBe(slugPath(worktree, "onboarding"))
    }),
  )

  it.effect("lists entries newest first and removes by slug", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const worktree = yield* fs.makeTempDirectoryScoped()
      const knowledge = yield* Knowledge.Service

      yield* knowledge.save({ worktree, slug: "first", title: "First", body: "one" })
      yield* knowledge.save({ worktree, slug: "second", title: "Second", body: "two" })
      const listed = yield* knowledge.list({ worktree })

      expect(listed.map((entry) => entry.slug).sort()).toEqual(["first", "second"])
      expect(listed[0]?.title).not.toBe("")

      yield* knowledge.remove({ worktree, slug: "first" })
      expect(yield* knowledge.get({ worktree, slug: "first" })).toBeUndefined()
      // Removing a missing slug is a no-op.
      yield* knowledge.remove({ worktree, slug: "first" })
    }),
  )

  it.effect("invalid slug fails with InvalidSlugError", () =>
    Effect.gen(function* () {
      const knowledge = yield* Knowledge.Service

      const result = yield* knowledge
        .save({ worktree: "/tmp/knowledge-test", slug: "../escape", title: "Bad", body: "x" })
        .pipe(Effect.flip)

      expect(result._tag).toBe("Knowledge.InvalidSlugError")
    }),
  )
})
