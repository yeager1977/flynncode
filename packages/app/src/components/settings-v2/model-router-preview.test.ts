import { describe, expect, test } from "bun:test"
import { emptyForm } from "./model-router-payload"
import {
  modelAvailability,
  parseWeight,
  previewTask,
  priorityWeights,
  routerCatalog,
  selectedPriority,
} from "./model-router-preview"

const source = {
  provider: {
    "ollama-local": {
      name: "Local Ollama",
      models: { smart: { name: "Smart model" }, fast: { name: "Fast model" }, unscored: {}, writer: {} },
    },
    "ollama-offline": { models: { best: {} } },
    cloud: { name: "Cloud", models: { remote: {} } },
  },
  disabled_providers: ["ollama-offline"],
}

const form = () => {
  const value = emptyForm()
  value.models = [
    { key: "ollama-local/smart", capability: 10, price: 8, speed: 3, tags: [] },
    { key: "ollama-local/fast", capability: 5, price: 1, speed: 10, tags: [] },
    { key: "ollama-local/writer", capability: 10, price: 1, speed: 10, tags: ["writing"] },
    { key: "ollama-offline/best", capability: 10, price: 1, speed: 10, tags: [] },
    { key: "cloud/remote", capability: 10, price: 1, speed: 10, tags: [] },
    { key: "ollama-local/missing", capability: 10, price: 1, speed: 10, tags: [] },
  ]
  return value
}

describe("router preview", () => {
  test("only configured, enabled, in-scope models with matching tasks can win", () => {
    const catalog = routerCatalog(source)
    const draft = form()
    draft.allowUnscored = false
    const ranked = previewTask(draft, catalog, "coding")
    expect(ranked.map((item) => item.model.key)).toEqual(["ollama-local/smart", "ollama-local/fast"])
    // 0.7*10 + 0.1*(10-8) + 0.2*3 = 7.8 under the capability-dominant coding weights
    expect(ranked[0].score).toBeCloseTo(7.8)
    expect(catalog.find((model) => model.key === "ollama-local/smart")?.name).toBe("Smart model")
    expect(
      modelAvailability(
        form(),
        catalog.find((model) => model.key === "cloud/remote"),
      ),
    ).toBe("provider")
    expect(
      modelAvailability(
        form(),
        catalog.find((model) => model.key === "ollama-offline/best"),
      ),
    ).toBe("disabled")
    expect(modelAvailability(form(), undefined)).toBe("missing")
  })

  test("models hidden in Manage Models are unavailable and excluded from previews", () => {
    const catalog = routerCatalog(source, (providerID, modelID) => !(providerID === "ollama-local" && modelID === "fast"))
    expect(catalog.find((model) => model.key === "ollama-local/fast")?.enabled).toBe(false)
    expect(modelAvailability(form(), catalog.find((model) => model.key === "ollama-local/fast"))).toBe("hidden")
    expect(previewTask(form(), catalog, "coding").map((item) => item.model.key)).not.toContain("ollama-local/fast")
  })

  test("a pin cannot resurrect a hidden model, matching the runtime router", () => {
    const draft = form()
    draft.taskModels = { coding: "ollama-local/fast" }
    const catalog = routerCatalog(source, (providerID, modelID) => !(providerID === "ollama-local" && modelID === "fast"))
    expect(previewTask(draft, catalog, "coding").map((item) => item.model.key)).not.toContain("ollama-local/fast")
  })

  test("priorities change the top match instead of silently changing model scores", () => {
    const draft = form()
    draft.taskWeights.coding = priorityWeights("coding", "speed")
    expect(previewTask(draft, routerCatalog(source), "coding")[0].model.key).toBe("ollama-local/fast")
    expect(draft.models[0].capability).toBe(10)
  })

  test("unscored models are eligible by default", () => {
    const draft = form()
    expect(previewTask(draft, routerCatalog(source), "coding").map((item) => item.model.key)).toContain(
      "ollama-local/unscored",
    )
  })

  test("a pinned task model wins even when unscored or tagged away", () => {
    const draft = form()
    draft.taskModels = { coding: "ollama-local/writer" }
    expect(previewTask(draft, routerCatalog(source), "coding")[0].model.key).toBe("ollama-local/writer")
    const unscored = form()
    unscored.allowUnscored = false
    unscored.taskModels = { coding: "ollama-local/unscored" }
    expect(previewTask(unscored, routerCatalog(source), "coding")[0].model.key).toBe("ollama-local/unscored")
  })

  test("ties prefer lower price, then higher speed, then stable model identity", () => {
    const draft = emptyForm()
    draft.taskWeights.coding = { capability: 1, price: 0, speed: 0 }
    draft.models = [
      { key: "ollama/z", capability: 5, price: 5, speed: 5, tags: [] },
      { key: "ollama/a", capability: 5, price: 5, speed: 5, tags: [] },
      { key: "ollama/fast", capability: 5, price: 5, speed: 9, tags: [] },
      { key: "ollama/cheap", capability: 5, price: 1, speed: 1, tags: [] },
    ]
    const catalog = routerCatalog({ provider: { ollama: { models: { z: {}, a: {}, fast: {}, cheap: {} } } } })
    expect(previewTask(draft, catalog, "coding").map((item) => item.model.key)).toEqual([
      "ollama/cheap",
      "ollama/fast",
      "ollama/a",
      "ollama/z",
    ])
  })
})

describe("priority editing", () => {
  test("recognizes proportional presets without replacing custom weights", () => {
    expect(selectedPriority("coding", { capability: 70, price: 10, speed: 20 })).toBe("recommended")
    expect(selectedPriority("coding", { capability: 0, price: 0, speed: 0 })).toBe("balanced")
    expect(selectedPriority("coding", { capability: 8, price: 1, speed: 1 })).toBe("quality")
    expect(selectedPriority("coding", { capability: 2, price: 3, speed: 8 })).toBe("custom")
  })

  test("incomplete and invalid weight text is never coerced to a saved zero", () => {
    for (const value of ["", " ", "-", "-1", "abc", "1e", "Infinity"]) expect(parseWeight(value)).toBeUndefined()
    expect(parseWeight("0")).toBe(0)
    expect(parseWeight("0.25")).toBe(0.25)
  })
})
