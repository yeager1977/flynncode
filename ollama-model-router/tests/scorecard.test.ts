import { describe, expect, test } from "bun:test"
import { DEFAULT_AGENT_TASKS, parseModelKey, parseOptions } from "../src/scorecard"

describe("parseOptions", () => {
  test("applies defaults for empty options", () => {
    const result = parseOptions(undefined)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.options.autoRoute).toBe(true)
    expect(result.options.allowUnscored).toBe(false)
    expect(result.options.overrideExplicit).toBe(false)
    expect(result.options.providers).toEqual([])
    expect(result.options.agentTasks).toEqual(DEFAULT_AGENT_TASKS)
    expect(result.options.models).toEqual({})
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
