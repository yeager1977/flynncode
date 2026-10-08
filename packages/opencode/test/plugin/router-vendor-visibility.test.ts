import { describe, expect, it } from "bun:test"
import { collectCandidates } from "../../src/plugin/ollama-model-router/candidates"
import { DEFAULT_AGENT_TASKS, DEFAULT_MODELS, DEFAULT_TASK_WEIGHTS } from "../../src/plugin/ollama-model-router/scorecard"
import { createTools } from "../../src/plugin/ollama-model-router/tools"
import type { RouterOptions } from "../../src/plugin/ollama-model-router/types"

const options: RouterOptions = {
  enabled: true,
  autoRoute: true,
  allowUnscored: true,
  overrideExplicit: false,
  legacyAssign: false,
  providers: ["anthropic", "openai"],
  modelFamily: "auto",
  agentTasks: { ...DEFAULT_AGENT_TASKS },
  taskWeights: structuredClone(DEFAULT_TASK_WEIGHTS),
  taskModels: {},
  excludeModels: [],
  models: structuredClone(DEFAULT_MODELS),
}

const catalog = {
  anthropic: { models: { "claude-sonnet-5": {}, "claude-opus-5-5": {} } },
  openai: { models: { "gpt-6-sol": {} } },
}

describe("vendor visibility", () => {
  it("includes connected vendor models as candidates", () => {
    const keys = collectCandidates({ provider: {}, disabled_providers: [] }, options, catalog).map((c) => c.key)
    expect(keys).toContain("anthropic/claude-sonnet-5")
    expect(keys).toContain("openai/gpt-6-sol")
  })
  it("ships bundled scorecard entries for vendor subscription models", () => {
    expect(options.models["anthropic/claude-sonnet-5"]).toBeDefined()
    expect(options.models["openai/gpt-6-sol"]).toBeDefined()
    expect(options.models["openai/gpt-6-luna"]).toBeDefined()
  })
  it("reports connection state without secrets", async () => {
    const tools = createTools({
      client: {} as never,
      directory: "/tmp",
      getOptions: () => options,
      getOptionsError: () => undefined,
      getConfig: () => ({ provider: {}, disabled_providers: [] }),
      getCatalog: () => catalog,
      getAssignments: () => ({}),
    })
    const output = await tools?.auth_status?.execute?.({}, {} as never)
    expect(output).toContain("anthropic: connected (2 models)")
    expect(output).toContain("openai: connected (1 models)")
    expect(output).toContain("Eligible models: 3")
    expect(output).not.toContain("sk-ant")
  })
})
