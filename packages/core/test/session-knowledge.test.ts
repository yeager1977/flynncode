import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, FileSystem } from "effect"
import { LayerNode } from "@flynncode/core/effect/layer-node"
import { LayerNodePlatform } from "@flynncode/core/effect/app-node-platform"
import { FSUtil } from "@flynncode/core/fs-util"
import { SessionKnowledge, buildKnowledgePrologue, parseKnowledgeTitle } from "@flynncode/core/session/knowledge"
import { testEffect } from "./lib/effect"

describe("buildKnowledgePrologue", () => {
  test("empty entries yield empty prologue", () => {
    expect(buildKnowledgePrologue([])).toBe("")
  })

  test("entries yield titled bullets", () => {
    const out = buildKnowledgePrologue([{ slug: "onboarding", title: "Onboarding" }])
    expect(out).toContain("Onboarding")
    expect(out).toContain("onboarding")
  })

  test("bodies never leak into the prologue", () => {
    const out = buildKnowledgePrologue([{ slug: "secret", title: "Secret" }])
    expect(out).not.toContain("Secret body")
  })
})

describe("parseKnowledgeTitle", () => {
  test("reads the frontmatter title", () => {
    expect(parseKnowledgeTitle("---\ntitle: Onboarding\n---\n# Hello", "onboarding")).toBe("Onboarding")
  })

  test("falls back to slug without frontmatter", () => {
    expect(parseKnowledgeTitle("# Just a note", "note")).toBe("note")
  })
})

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, LayerNodePlatform.filesystem])))

describe("SessionKnowledge.listTitles", () => {
  it.effect("lists titles without bodies in slug order", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const files = yield* FileSystem.FileSystem
      const directory = yield* files.makeTempDirectoryScoped()
      yield* files.makeDirectory(path.join(directory, ".opencode", "knowledge"), { recursive: true })
      yield* files.writeFileString(
        path.join(directory, ".opencode", "knowledge", "b-note.md"),
        "---\ntitle: Bee\n---\nBee body",
      )
      yield* files.writeFileString(path.join(directory, ".opencode", "knowledge", "a-note.md"), "# No frontmatter")

      const titles = yield* SessionKnowledge.listTitles(fs, directory)

      expect(titles).toEqual([
        { slug: "a-note", title: "a-note" },
        { slug: "b-note", title: "Bee" },
      ])
    }),
  )

  it.effect("returns empty when the knowledge folder is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const files = yield* FileSystem.FileSystem
      const directory = yield* files.makeTempDirectoryScoped()

      expect(yield* SessionKnowledge.listTitles(fs, directory)).toEqual([])
    }),
  )
})
