import { describe, expect, test } from "bun:test"
import path from "path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import {
  applyOpenCodeBans,
  applyPluginPatch,
  ConfigOmoFiles,
  openCodeFile,
  pluginFile,
  readPlugin,
} from "@/config/omo-files"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

describe("pluginFile", () => {
  test("prefers oh-my-openagent.jsonc, then legacy names", () => {
    const exists = (path: string) => path.endsWith("oh-my-opencode.json")
    expect(pluginFile("/cfg", exists)).toBe("/cfg/oh-my-opencode.json")
    expect(pluginFile("/cfg", () => false)).toBeUndefined()
  })
})

describe("openCodeFile", () => {
  test("returns the .opencode/opencode.jsonc default when no candidate exists", () => {
    expect(openCodeFile("/work", () => false)).toBe("/work/.opencode/opencode.jsonc")
  })

  test(".opencode/opencode.jsonc wins over a root opencode.json", () => {
    const exists = (path: string) => path === "/work/.opencode/opencode.jsonc" || path === "/work/opencode.json"
    expect(openCodeFile("/work", exists)).toBe("/work/.opencode/opencode.jsonc")
  })

  test("falls through to a root opencode.json when the .opencode/ dir is empty", () => {
    expect(openCodeFile("/work", (path) => path === "/work/opencode.json")).toBe("/work/opencode.json")
  })

  test("never returns a path ending in config.json", () => {
    expect(openCodeFile("/work", (path) => path.endsWith("config.json"))).toBe("/work/.opencode/opencode.jsonc")
  })
})

describe("applyPluginPatch", () => {
  test("removes an automatic model and keeps an unknown key", () => {
    const result = applyPluginPatch(
      `{
        // keep
        "agents": { "sisyphus": { "temperature": 0.2, "model": "openai/gpt-5.6-sol" } },
        "experimental": { "task_system": true }
      }`,
      { agents: { sisyphus: { temperature: 0.2 } }, categories: {}, disabledProviders: ["xai"] },
    )
    expect(result.text).toContain("temperature")
    expect(result.text).not.toContain("gpt-5.6-sol")
    expect(result.text).toContain("task_system")
    expect(result.text).toContain("xai")
    expect(result.empty).toBe(false)
  })
})

describe("applyOpenCodeBans", () => {
  test("replaces disabled_providers and keeps other keys", () => {
    const text = applyOpenCodeBans(`{ "model": "ollama-cloud/glm-5.3-flash", "disabled_providers": ["ollama-local"] }`, [
      "ollama-local",
      "xai",
    ])
    expect(text).toContain("glm-5.3-flash")
    expect(text).toContain("xai")
    expect(text).not.toContain("config.json")
  })
})

describe("readPlugin", () => {
  test("invalid JSONC is an error and is not rewritten by the caller contract", () => {
    expect(readPlugin("{")).toEqual({ parseError: expect.any(String) })
  })
})

const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node, CrossSpawnSpawner.node])))

describe("ConfigOmoFiles.write", () => {
  it.live("a project save writes both files with merged bans and never touches config.json", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const fs = yield* FSUtil.Service

      const info = yield* ConfigOmoFiles.write(dir, {
        agents: {},
        categories: {},
        disabledProviders: ["ollama-local", "xai"],
      })

      expect(info.path).toBe(path.join(dir, "oh-my-openagent.jsonc"))
      expect(info.disabledProviders).toEqual(["ollama-local", "xai"])
      expect(info.openCodeDisabledProviders).toEqual(["ollama-local", "xai"])

      const openCodePath = path.join(dir, ".opencode", "opencode.jsonc")
      const openCodeText = yield* fs.readFileString(openCodePath)
      expect(openCodeText).toContain("ollama-local")
      expect(openCodeText).toContain("xai")

      expect(yield* fs.existsSafe(path.join(dir, "config.json"))).toBe(false)
    }),
  )
})
