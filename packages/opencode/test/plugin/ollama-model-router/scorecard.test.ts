import { describe, expect, test } from "bun:test"
import {
  DEFAULT_AGENT_TASKS,
  parseModelKey,
  parseOptions,
  parseTaskVariant,
} from "../../../src/plugin/ollama-model-router/scorecard"

describe("parseOptions", () => {
  test("applies defaults for empty options", () => {
    const result = parseOptions(undefined)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.options.autoRoute).toBe(true)
    expect(result.options.allowUnscored).toBe(true)
    expect(result.options.overrideExplicit).toBe(false)
    expect(result.options.providers).toEqual([])
    expect(result.options.agentTasks).toEqual(DEFAULT_AGENT_TASKS)
    expect(result.options.taskModels).toEqual({})
  })

  test("defaults enabled to true", () => {
    const result = parseOptions({})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.options.enabled).toBe(true)
  })

  test("parses enabled false", () => {
    const result = parseOptions({ enabled: false })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.options.enabled).toBe(false)
  })

  test("parses bundled xAI defaults with exactly six scored keys", () => {
    const result = parseOptions({})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.options.models).toEqual({
      "xai/grok-4.6": { capability: 9, price: 7, speed: 4, tags: ["coding", "planning", "architecture"] },
      "xai/grok-4.5": { capability: 9, price: 7, speed: 4, tags: ["coding", "planning", "review"] },
      "xai/grok-4.20-0309-reasoning": { capability: 8, price: 4, speed: 5, tags: ["coding", "long-context"] },
      "xai/grok-4.20-0309-non-reasoning": { capability: 7, price: 3, speed: 7, tags: ["coding", "lookup"] },
      "xai/grok-4.3": { capability: 8, price: 4, speed: 5, tags: ["coding", "long-context"] },
      "xai/grok-build-0.1": { capability: 7, price: 3, speed: 6, tags: ["coding"] },
    })
    expect(result.options.taskModels).toEqual({})
  })

  test("user scorecard entries override bundled keys wholesale and add new keys", () => {
    const result = parseOptions({
      models: {
        "xai/grok-4.6": { capability: 10, price: 1, speed: 1 },
        "custom/foo": { price: 2, capability: 6, speed: 8, tags: ["writing"] },
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.options.models["xai/grok-4.6"]).toEqual({ price: 1, capability: 10, speed: 1 })
    expect(result.options.models["custom/foo"]).toEqual({
      price: 2,
      capability: 6,
      speed: 8,
      tags: ["writing"],
    })
    expect(result.options.models["xai/grok-4.5"]).toEqual({
      capability: 9,
      price: 7,
      speed: 4,
      tags: ["coding", "planning", "review"],
    })
  })

  test("parses explicit per-task model overrides", () => {
    const result = parseOptions({ taskModels: { coding: "ollama-cloud/glm-5.3-flash" } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.options.taskModels.coding).toBe("ollama-cloud/glm-5.3-flash")
  })

  test("rejects unknown task names and malformed keys in taskModels", () => {
    const unknown = parseOptions({ taskModels: { nope: "p/a" } })
    expect(unknown.ok).toBe(false)
    const malformed = parseOptions({ taskModels: { coding: "no-slash" } })
    expect(malformed.ok).toBe(false)
  })

  test("parses excludeModels and rejects malformed entries", () => {
    const result = parseOptions({ excludeModels: ["ollama-cloud/hidden"] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.options.excludeModels).toContain("ollama-cloud/hidden")
    expect(parseOptions({ excludeModels: ["no-slash"] }).ok).toBe(false)
  })

  test("unions bundled excludeModels with the user list", () => {
    const result = parseOptions({ excludeModels: ["ollama-cloud/hidden"] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.options.excludeModels).toEqual([
      "xai/grok-imagine-image",
      "xai/grok-imagine-video",
      "xai/grok-imagine-video-1.5",
      "xai/grok-4.20-multi-agent-0309",
      "ollama-cloud/hidden",
    ])
    const empty = parseOptions({})
    expect(empty.ok).toBe(true)
    if (!empty.ok) return
    expect(empty.options.excludeModels).toEqual([
      "xai/grok-imagine-image",
      "xai/grok-imagine-video",
      "xai/grok-imagine-video-1.5",
      "xai/grok-4.20-multi-agent-0309",
    ])
  })

  test("accepts a valid scorecard", () => {
    const result = parseOptions({
      providers: ["ollama-cloud"],
      models: {
        "ollama-cloud/glm-5.3-flash:cloud": { price: 3, capability: 8, speed: 9, tags: ["coding"] },
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.options.models["ollama-cloud/glm-5.3-flash:cloud"].capability).toBe(8)
  })

  test("rejects out-of-range scores", () => {
    const result = parseOptions({
      models: { "p/a": { price: 0, capability: 11, speed: 5 } },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.length).toBe(2)
  })

  test("rejects unknown task in agentTasks", () => {
    const result = parseOptions({ agentTasks: { build: "nope" } })
    expect(result.ok).toBe(false)
  })

  test("rejects model keys without provider prefix", () => {
    const result = parseOptions({ models: { "glm-5.3": { price: 3, capability: 8, speed: 9 } } })
    expect(result.ok).toBe(false)
  })

  test("never throws on symbol values", () => {
    const result = parseOptions({ taskWeights: { coding: { capability: Symbol("x"), price: 1, speed: 1 } } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.length).toBeGreaterThan(0)
  })

  test("never throws on throwing getters", () => {
    const hostile: Record<string, unknown> = {}
    Object.defineProperty(hostile, "p/a", {
      enumerable: true,
      get() {
        throw new Error("boom")
      },
    })
    const result = parseOptions({ models: hostile })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.length).toBeGreaterThan(0)
  })
})

describe("parseModelKey", () => {
  test("splits on first slash", () => {
    expect(parseModelKey("ollama-cloud/glm-5.3-flash:cloud")).toEqual({
      providerID: "ollama-cloud",
      modelID: "glm-5.3-flash:cloud",
    })
  })

  test("returns undefined without a slash", () => {
    expect(parseModelKey("glm-5.3")).toBeUndefined()
  })
})

describe("parseTaskVariant", () => {
  test("parses a plain task name", () => {
    expect(parseTaskVariant("coding")).toEqual({ task: "coding", value: false })
  })

  test("parses a value variant", () => {
    expect(parseTaskVariant("coding-value")).toEqual({ task: "coding", value: true })
    expect(parseTaskVariant("long-context-value")).toEqual({ task: "long-context", value: true })
  })

  test("rejects unknown tasks and stray suffixes", () => {
    expect(parseTaskVariant("nope")).toBeUndefined()
    expect(parseTaskVariant("nope-value")).toBeUndefined()
    expect(parseTaskVariant("-value")).toBeUndefined()
    expect(parseTaskVariant(undefined)).toBeUndefined()
  })
})
