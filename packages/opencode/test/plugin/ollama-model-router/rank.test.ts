import { describe, expect, test } from "bun:test"
import { normalizeWeights, rankModels, scoreModel } from "../../../src/plugin/ollama-model-router/rank"

const weights = { capability: 0.6, price: 0.25, speed: 0.15 }

describe("normalizeWeights", () => {
  test("normalizes to sum 1", () => {
    const w = normalizeWeights({ capability: 2, price: 1, speed: 1 })
    expect(w.capability).toBeCloseTo(0.5)
    expect(w.price).toBeCloseTo(0.25)
    expect(w.speed).toBeCloseTo(0.25)
  })

  test("falls back to equal weights when all zero", () => {
    const w = normalizeWeights({ capability: 0, price: 0, speed: 0 })
    expect(w.capability).toBeCloseTo(1 / 3)
    expect(w.price).toBeCloseTo(1 / 3)
    expect(w.speed).toBeCloseTo(1 / 3)
  })
})

describe("scoreModel", () => {
  test("computes weighted score with inverted price", () => {
    const { score, reasons } = scoreModel(
      { price: 3, capability: 8, speed: 9 },
      weights,
      "coding",
    ) as { score: number; reasons: string[] }
    // 0.6*8 + 0.25*7 + 0.15*9 = 4.8 + 1.75 + 1.35 = 7.9
    expect(score).toBeCloseTo(7.9)
    expect(reasons.length).toBe(3)
  })

  test("excludes models not tagged for the task", () => {
    const result = scoreModel(
      { price: 3, capability: 8, speed: 9, tags: ["lookup"] },
      weights,
      "coding",
    )
    expect(result).toEqual({ excluded: "not tagged for coding" })
  })

  test("includes models tagged for the task", () => {
    const result = scoreModel(
      { price: 3, capability: 8, speed: 9, tags: ["coding", "lookup"] },
      weights,
      "coding",
    )
    expect("score" in result).toBe(true)
  })

  test("unscored models score 5/5/5 when allowed", () => {
    const result = scoreModel(
      { price: 5, capability: 5, speed: 5 },
      weights,
      "coding",
    )
    expect((result as { score: number }).score).toBeCloseTo(5)
  })
})

describe("rankModels", () => {
  test("sorts descending by score and applies tie-breaks", () => {
    const result = rankModels(
      [
        { key: "p/a", providerID: "p", modelID: "a", entry: { price: 3, capability: 8, speed: 9 } },
        { key: "p/b", providerID: "p", modelID: "b", entry: { price: 1, capability: 8, speed: 9 } },
        { key: "p/c", providerID: "p", modelID: "c", entry: { price: 1, capability: 7, speed: 9 } },
      ],
      "coding",
      weights,
      { allowUnscored: false },
    )
    // b and c tie on score? b = 0.6*8+0.25*9+0.15*9=8.4; c=0.6*7+0.25*9+0.15*9=7.8; a=0.6*8+0.25*7+0.15*9=7.9
    expect(result.ranked.map((r) => r.key)).toEqual(["p/b", "p/a", "p/c"])
  })

  test("tie-break: cheaper wins, then faster, then key", () => {
    const result = rankModels(
      [
        { key: "p/z", providerID: "p", modelID: "z", entry: { price: 2, capability: 5, speed: 5 } },
        { key: "p/a", providerID: "p", modelID: "a", entry: { price: 2, capability: 5, speed: 5 } },
      ],
      "coding",
      weights,
      { allowUnscored: false },
    )
    expect(result.ranked.map((r) => r.key)).toEqual(["p/a", "p/z"])
  })

  test("excludes disabled providers", () => {
    const result = rankModels(
      [{ key: "p/a", providerID: "p", modelID: "a", entry: { price: 3, capability: 8, speed: 9 }, providerDisabled: true }],
      "coding",
      weights,
      { allowUnscored: false },
    )
    expect(result.ranked).toEqual([])
    expect(result.excluded[0].excluded).toBe("provider disabled")
  })

  test("excludes unscored when allowUnscored is false", () => {
    const result = rankModels(
      [{ key: "p/a", providerID: "p", modelID: "a" }],
      "coding",
      weights,
      { allowUnscored: false },
    )
    expect(result.ranked).toEqual([])
    expect(result.excluded[0].excluded).toBe("unscored")
  })

  test("includes unscored at 5/5/5 when allowUnscored is true", () => {
    const result = rankModels(
      [{ key: "p/a", providerID: "p", modelID: "a" }],
      "coding",
      weights,
      { allowUnscored: true },
    )
    expect(result.ranked.length).toBe(1)
    expect(result.ranked[0].score).toBeCloseTo(5)
  })
})
