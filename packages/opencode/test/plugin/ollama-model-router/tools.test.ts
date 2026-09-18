import { describe, expect, test } from "bun:test"
import { formatRankTable } from "../../../src/plugin/ollama-model-router/tools"

describe("formatRankTable", () => {
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
