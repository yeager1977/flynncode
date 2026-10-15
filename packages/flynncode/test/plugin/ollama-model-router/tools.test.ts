import { describe, expect, test } from "bun:test"
import { DEFAULT_TASK_WEIGHTS } from "../../../src/plugin/ollama-model-router/scorecard"
import { formatRankTable } from "../../../src/plugin/ollama-model-router/tools"

describe("formatRankTable", () => {
  test("caps the excluded list at five entries", () => {
    const excluded = ["p/1", "p/2", "p/3", "p/4", "p/5", "p/6", "p/7"].map((modelID) => ({
      key: `p/${modelID.slice(2)}`,
      providerID: "p",
      modelID,
      score: 0,
      reasons: [],
      excluded: "unscored",
    }))
    const text = formatRankTable({ task: "coding", ranked: [], excluded })
    const listed = text.split("\n").filter((line) => line.startsWith("- "))
    expect(listed).toHaveLength(5)
    expect(text).toContain("+ 2 more excluded")
  })
  test("renders ranked rows with scores and reasons", () => {
    const text = formatRankTable({
      task: "coding",
      ranked: [
        { key: "p/a", providerID: "p", modelID: "a", score: 7.9, reasons: ["capability 8×0.60"] },
      ],
      excluded: [{ key: "p/b", providerID: "p", modelID: "b", score: 0, reasons: [], excluded: "unscored" }],
    })
    expect(text).toContain("coding")
    expect(text).toContain("p/a")
    expect(text).toContain("7.90")
    expect(text).toContain("p/b")
    expect(text).toContain("unscored")
  })

  test("says so when there are no candidates", () => {
    const text = formatRankTable({ task: "coding", ranked: [], excluded: [] })
    expect(text).toContain("No eligible models")
  })

  test("shows provider metadata for excluded unscored models", () => {
    const meta = new Map([
      [
        "p/b",
        {
          providerID: "p",
          modelID: "b",
          name: "Bee Model",
          context: 262144,
          toolCall: true,
          reasoning: true,
        },
      ],
    ])
    const text = formatRankTable(
      {
        task: "coding",
        ranked: [],
        excluded: [{ key: "p/b", providerID: "p", modelID: "b", score: 0, reasons: [], excluded: "unscored" }],
      },
      10,
      meta,
    )
    expect(text).toContain("Bee Model")
    expect(text).toContain("ctx 262k")
    expect(text).toContain("tools")
    expect(text).toContain("reasoning")
  })
})

import { createTools } from "../../../src/plugin/ollama-model-router/tools"

test("route_task caps concurrent executions per session", async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const calls: string[] = []
  const client = {
    session: {
      create: async () => {
        calls.push("create")
        await gate
        return { data: { id: "child-1" } }
      },
      promptAsync: async () => ({}),
      prompt: async () => ({ data: { parts: [] } }),
    },
  } as any
  const options = {
    autoRoute: false,
    allowUnscored: false,
    overrideExplicit: false,
    providers: ["p"],
    agentTasks: {},
    taskWeights: { coding: { capability: 1, price: 1, speed: 1 } },
    models: { "p/a": { price: 1, capability: 5, speed: 5 } },
  } as any
  const tools = createTools({
    client,
    directory: "/tmp",
    getOptions: () => options,
    getOptionsError: () => undefined,
    getConfig: () => ({ provider: { p: { models: { a: {} } } } }),
    getCatalog: () => undefined,
    loadCatalog: async () => {},
    getAssignments: () => ({}),
  })
  const ctx = { sessionID: "s1" } as any
  const first = tools!.route_task.execute({ task: "coding", prompt: "x", execute: true }, ctx)
  const second = await tools!.route_task.execute({ task: "coding", prompt: "y", execute: true }, ctx)
  expect(second).toContain("already in flight")
  release()
  await first
  expect(calls).toEqual(["create"])
})

test("rank_models reports unmatched scorecard keys", async () => {
  const options = {
    autoRoute: false, allowUnscored: false, overrideExplicit: false, providers: ["p"],
    agentTasks: {}, taskWeights: { coding: { capability: 1, price: 1, speed: 1 } },
    models: { "p/a": { price: 1, capability: 5, speed: 5 }, "p/ghost": { price: 1, capability: 5, speed: 5 } },
  } as any
  const tools = createTools({
    client: {} as any, directory: "/tmp",
    getOptions: () => options,
    getOptionsError: () => undefined,
    getConfig: () => ({ provider: { p: { models: { a: {} } } } }),
    getCatalog: () => undefined,
    loadCatalog: async () => {},
    getAssignments: () => ({}),
  })
  const out = await tools!.rank_models.execute({ task: "coding" } as any, { sessionID: "s" } as any)
  expect(String(out)).toContain("p/ghost")
  expect(String(out)).toContain("no matching model")
})

test("tools report parse errors when options are invalid", async () => {
  const tools = createTools({
    client: {} as any,
    directory: "/tmp",
    getOptions: () => undefined,
    getOptionsError: () => ["models.bad must be an integer 1-10", "provider missing"],
    getConfig: () => ({ provider: {} }),
    getCatalog: () => undefined,
    loadCatalog: async () => {},
    getAssignments: () => ({}),
  })
  const rank = await tools!.rank_models.execute({} as any, { sessionID: "s" } as any)
  expect(String(rank)).toBe(
    "Model router disabled: invalid options:\n- models.bad must be an integer 1-10\n- provider missing",
  )
  const route = await tools!.route_task.execute({ task: "coding", prompt: "x" } as any, { sessionID: "s" } as any)
  expect(String(route)).toContain("Model router disabled: invalid options:")
  expect(String(route)).toContain("models.bad must be an integer 1-10")
})

test("router tools load the connected catalog before ranking", async () => {
  const catalog: Record<string, { models: Record<string, object> }> = {}
  const options = {
    autoRoute: false, allowUnscored: true, overrideExplicit: false, providers: ["p"],
    agentTasks: {}, taskWeights: { coding: { capability: 1, price: 1, speed: 1 } },
    models: {},
  } as any
  const tools = createTools({
    client: {} as any,
    directory: "/tmp",
    getOptions: () => options,
    getOptionsError: () => undefined,
    getConfig: () => ({ provider: {} }),
    getCatalog: () => (Object.keys(catalog).length > 0 ? catalog : undefined),
    loadCatalog: async () => {
      catalog.p = { models: { connected: {} } }
    },
    getAssignments: () => ({}),
  })
  const out = await tools!.rank_models.execute({ task: "coding" } as any, { sessionID: "s" } as any)
  expect(String(out)).toContain("p/connected")
})

test("rank_models without a task shows a compact winners view", async () => {
  const options = {
    autoRoute: false, allowUnscored: false, overrideExplicit: false, providers: ["p"],
    agentTasks: {},
    taskWeights: structuredClone(DEFAULT_TASK_WEIGHTS),
    taskModels: {},
    models: { "p/a": { price: 1, capability: 5, speed: 5 }, "p/b": { price: 5, capability: 9, speed: 5 } },
  } as any
  const tools = createTools({
    client: {} as any, directory: "/tmp",
    getOptions: () => options,
    getOptionsError: () => undefined,
    getConfig: () => ({ provider: { p: { models: { a: {}, b: {} } } } }),
    getCatalog: () => undefined,
    loadCatalog: async () => {},
    getAssignments: () => ({}),
  })
  const out = await tools!.rank_models.execute({} as any, { sessionID: "s", agent: "custom" } as any)
  const text = String(out)
  expect(text).toContain("Winners per task")
  expect(text).toContain("coding → p/b")
  expect(text).toContain("lookup → p/a")
  // The compact view does not include the full-table header.
  expect(text).not.toContain("---- | ----- | ----- | -------")
})

test("rank_models defaults to the calling agent's task when mapped", async () => {
  const options = {
    autoRoute: false, allowUnscored: false, overrideExplicit: false, providers: ["p"],
    agentTasks: { explore: "lookup" },
    taskWeights: structuredClone(DEFAULT_TASK_WEIGHTS),
    taskModels: {},
    models: { "p/fast": { price: 1, capability: 5, speed: 9 }, "p/slow": { price: 1, capability: 9, speed: 1 } },
  } as any
  const tools = createTools({
    client: {} as any, directory: "/tmp",
    getOptions: () => options,
    getOptionsError: () => undefined,
    getConfig: () => ({ provider: { p: { models: { fast: {}, slow: {} } } } }),
    getCatalog: () => undefined,
    loadCatalog: async () => {},
    getAssignments: () => ({}),
  })
  const out = await tools!.rank_models.execute({} as any, { sessionID: "s", agent: "explore" } as any)
  const text = String(out)
  expect(text).toContain("Task: lookup")
  expect(text).toContain("p/fast")
  expect(text).not.toContain("Task: coding")
})
