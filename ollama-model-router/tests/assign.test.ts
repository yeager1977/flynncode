import { describe, expect, test } from "bun:test"
import { assignAgents } from "../src/assign"
import { parseOptions } from "../src/scorecard"

function makeOptions(overrides: Record<string, unknown> = {}) {
  const result = parseOptions({
    providers: ["ollama-cloud"],
    models: {
      "ollama-cloud/big": { price: 8, capability: 10, speed: 3 },
      "ollama-cloud/cheap": { price: 1, capability: 6, speed: 9 },
    },
    ...overrides,
  })
  if (!result.ok) throw new Error(result.errors.join(", "))
  return result.options
}

const cfgBase = () => ({
  provider: {
    "ollama-cloud": {
      models: { big: { name: "Big" }, cheap: { name: "Cheap" } },
    },
  },
  agent: {},
})

describe("assignAgents", () => {
  test("assigns cheapest-per-task model by default weights", () => {
    const cfg = cfgBase()
    const { assignments } = assignAgents(cfg, makeOptions())
    expect(assignments.build).toBe("ollama-cloud/cheap")
    expect(assignments.explore).toBe("ollama-cloud/cheap")
    expect(assignments.plan).toBe("ollama-cloud/big")
    expect(cfg.agent.build.model).toBe("ollama-cloud/cheap")
  })

  test("respects existing explicit agent models", () => {
    const cfg = cfgBase()
    cfg.agent = { build: { model: "ollama-cloud/big" } as any }
    const { assignments } = assignAgents(cfg, makeOptions())
    expect(assignments.build).toBeUndefined()
    expect(cfg.agent.build.model).toBe("ollama-cloud/big")
  })

  test("overrides explicit models when overrideExplicit is true", () => {
    const cfg = cfgBase()
    cfg.agent = { build: { model: "ollama-cloud/big" } as any }
    const { assignments } = assignAgents(cfg, makeOptions({ overrideExplicit: true }))
    expect(assignments.build).toBe("ollama-cloud/cheap")
  })

  test("skips disabled agents", () => {
    const cfg = cfgBase()
    cfg.agent = { build: { disable: true } as any }
    const { assignments } = assignAgents(cfg, makeOptions())
    expect(assignments.build).toBeUndefined()
    expect((cfg.agent.build as any).model).toBeUndefined()
  })

  test("reports agents it cannot route without throwing", () => {
    const cfg = { provider: { "ollama-cloud": { models: {} } }, agent: {} }
    const { assignments, warnings } = assignAgents(cfg, makeOptions())
    expect(assignments).toEqual({})
    expect(warnings.length).toBeGreaterThan(0)
  })
})
