import { describe, expect, test } from "bun:test"
import path from "path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Cause, Effect, Exit } from "effect"
import {
  applyOpenCodeBans,
  applyPluginPatch,
  ConfigOmoFiles,
  globalOpenCodeFile,
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

describe("globalOpenCodeFile", () => {
  test("mirrors globalConfigFile() order and returns opencode.jsonc when nothing exists", () => {
    expect(globalOpenCodeFile("/cfg", () => false)).toBe("/cfg/opencode.jsonc")
  })

  test("prefers an existing opencode.jsonc over legacy config.json", () => {
    const exists = (path: string) => path === "/cfg/opencode.jsonc" || path === "/cfg/config.json"
    expect(globalOpenCodeFile("/cfg", exists)).toBe("/cfg/opencode.jsonc")
  })

  test("keeps a legacy config.json target when it is the only file present", () => {
    expect(globalOpenCodeFile("/cfg", (path) => path === "/cfg/config.json")).toBe("/cfg/config.json")
  })

  test("never routes through a `.opencode/` subdirectory", () => {
    expect(
      globalOpenCodeFile("/cfg", (path) => path === "/cfg/.opencode/opencode.jsonc"),
    ).toBe("/cfg/opencode.jsonc")
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
      {
        agents: { sisyphus: { temperature: 0.2 } },
        categories: {},
        disabledProviders: ["xai"],
        openCodeDisabledProviders: ["xai"],
      },
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
        openCodeDisabledProviders: ["ollama-local", "xai"],
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

  it.live(
    "a project save splits plugin extras from OpenCode bans so the plugin file stays free of global-only ids",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const fs = yield* FSUtil.Service

        const info = yield* ConfigOmoFiles.write(dir, {
          agents: {},
          categories: {},
          disabledProviders: ["xai"],
          openCodeDisabledProviders: ["ollama-local", "xai"],
        })

        expect(info.path).toBe(path.join(dir, "oh-my-openagent.jsonc"))
        expect(info.disabledProviders).toEqual(["xai"])
        expect(info.openCodeDisabledProviders).toEqual(["ollama-local", "xai"])

        const pluginText = yield* fs.readFileString(path.join(dir, "oh-my-openagent.jsonc"))
        expect(pluginText).toContain("xai")
        expect(pluginText).not.toContain("ollama-local")

        const openCodeText = yield* fs.readFileString(path.join(dir, ".opencode", "opencode.jsonc"))
        expect(openCodeText).toContain("ollama-local")
        expect(openCodeText).toContain("xai")

        expect(yield* fs.existsSafe(path.join(dir, "config.json"))).toBe(false)
      }),
  )

  it.live(
    "a global save patches the existing opencode.jsonc in the global dir and never creates .opencode/",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const fs = yield* FSUtil.Service
        const globalOpenCodePath = path.join(dir, "opencode.jsonc")
        yield* fs.writeFileString(
          globalOpenCodePath,
          `{
  "model": "ollama-cloud/glm-5.3-flash"
}
`,
        )

        const info = yield* ConfigOmoFiles.write(
          dir,
          {
            agents: {},
            categories: {},
            disabledProviders: ["ollama-local"],
            openCodeDisabledProviders: ["ollama-local"],
          },
          "global",
        )

        expect(info.path).toBe(path.join(dir, "oh-my-openagent.jsonc"))
        expect(info.openCodeDisabledProviders).toEqual(["ollama-local"])

        const openCodeText = yield* fs.readFileString(globalOpenCodePath)
        expect(openCodeText).toContain("glm-5.3-flash")
        expect(openCodeText).toContain("ollama-local")

        expect(yield* fs.existsSafe(path.join(dir, ".opencode"))).toBe(false)
        expect(yield* fs.existsSafe(path.join(dir, ".opencode", "opencode.jsonc"))).toBe(false)
      }),
  )
})

describe("ConfigOmoFiles.readInfo", () => {
  it.live("a missing plugin file reads as an empty document with a null path", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()

      const info = yield* ConfigOmoFiles.readInfo(dir)

      expect(info.path).toBeNull()
      expect(info.parseError).toBeUndefined()
      expect(info.agents).toEqual({})
      expect(info.categories).toEqual({})
      expect(info.disabledProviders).toEqual([])
      expect(info.openCodeDisabledProviders).toEqual([])
    }),
  )

  it.live("an invalid JSONC plugin file refuses the write and does not overwrite the file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const fs = yield* FSUtil.Service
      const pluginPath = path.join(dir, "oh-my-openagent.jsonc")
      const original = `{ "agents": { "sisyphus": { "model": `
      yield* fs.writeFileString(pluginPath, original)

      const exit = yield* ConfigOmoFiles.write(dir, {
        agents: {},
        categories: {},
        disabledProviders: ["xai"],
        openCodeDisabledProviders: ["xai"],
      }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause) as { path: string; message: string }
        expect(error.path).toBe(pluginPath)
        expect(error.message).toContain("could not be parsed")
      }

      const after = yield* fs.readFileString(pluginPath)
      expect(after).toBe(original)
      expect(yield* fs.existsSafe(path.join(dir, ".opencode", "opencode.jsonc"))).toBe(false)
    }),
  )
})
