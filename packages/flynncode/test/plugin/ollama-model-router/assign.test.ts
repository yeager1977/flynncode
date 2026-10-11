import { describe, expect, test } from "bun:test"
import { assignAgents, resolveTaskModel } from "../../../src/plugin/ollama-model-router/assign"
import { parseOptions } from "../../../src/plugin/ollama-model-router/scorecard"

// These tests cover legacy startup assignment, which is off unless requested.
function makeOptions(overrides: Record<string, unknown> = {}) {
  const result = parseOptions({
    legacyAssign: true,
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

const cfgBase = (): any => ({
  provider: {
    "ollama-cloud": {
      models: { big: { name: "Big" }, cheap: { name: "Cheap" } },
    },
  },
  agent: {},
})

describe("assignAgents", () => {
  test("assigns the top model per task under the default weights", () => {
    const cfg = cfgBase()
    const { assignments } = assignAgents(cfg, makeOptions())
    // Coding is capability-dominant, so the high-capability model wins it,
    // while lookup stays cost/speed driven.
    expect(assignments.build).toBe("ollama-cloud/big")
    expect(assignments.explore).toBe("ollama-cloud/cheap")
    expect(assignments.plan).toBe("ollama-cloud/big")
    expect(cfg.agent.build.model).toBe("ollama-cloud/big")
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
    cfg.agent = { build: { model: "ollama-cloud/cheap" } as any }
    const { assignments } = assignAgents(cfg, makeOptions({ overrideExplicit: true }))
    expect(assignments.build).toBe("ollama-cloud/big")
  })

  test("skips disabled agents", () => {
    const cfg = cfgBase()
    cfg.agent = { build: { disable: true } as any }
    const { assignments } = assignAgents(cfg, makeOptions())
    expect(assignments.build).toBeUndefined()
    expect((cfg.agent.build as any).model).toBeUndefined()
  })

  test("skips hidden agents", () => {
    const cfg = cfgBase()
    cfg.agent = { build: { hidden: true } as any }
    const { assignments } = assignAgents(cfg, makeOptions())
    expect(assignments.build).toBeUndefined()
    expect((cfg.agent.build as any).model).toBeUndefined()
  })

  test("skips and warns for unknown non-builtin agents", () => {
    const cfg = cfgBase()
    const { assignments, warnings } = assignAgents(cfg, makeOptions({ agentTasks: { planner: "coding" } }))
    expect(assignments.planner).toBeUndefined()
    expect(cfg.agent.planner).toBeUndefined()
    expect(warnings.some((w) => w.includes("planner"))).toBe(true)
  })

  test("reports agents it cannot route without throwing", () => {
    const cfg = { provider: { "ollama-cloud": { models: {} } }, agent: {} }
    const { assignments, warnings } = assignAgents(cfg, makeOptions())
    expect(assignments).toEqual({})
    expect(warnings.length).toBeGreaterThan(0)
  })

  test("does not mutate agents unless legacyAssign is set", () => {
    const cfg = cfgBase()
    const { assignments } = assignAgents(cfg, makeOptions({ legacyAssign: false }))
    expect(assignments).toEqual({})
    expect(cfg.agent).toEqual({})
  })

  test("resolveTaskModel returns the winner without mutating agents", () => {
    const cfg = cfgBase()
    expect(resolveTaskModel(cfg, makeOptions({ legacyAssign: false }), "coding")).toBe("ollama-cloud/big")
    expect(cfg.agent).toEqual({})
  })

  test("value override uses value weights and ignores the pin", () => {
    const cfg = cfgBase()
    const options = makeOptions({
      legacyAssign: false,
      taskModels: { coding: "ollama-cloud/big" },
    })
    expect(resolveTaskModel(cfg, options, "coding")).toBe("ollama-cloud/big")
    expect(resolveTaskModel(cfg, options, "coding", undefined, { weights: { capability: 0.25, price: 0.65, speed: 0.1 }, ignorePin: true })).toBe(
      "ollama-cloud/cheap",
    )
  })
})
