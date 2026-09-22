import { describe, expect, test } from "bun:test"
import { applyOpenCodeBans, applyPluginPatch, openCodeFile, pluginFile, readPlugin } from "@/config/omo-files"

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
