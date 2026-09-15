import type { RankResult, RankedModel, ScoreEntry, TaskName } from "./types"

type Weights = { capability: number; price: number; speed: number }

export function normalizeWeights(w: Weights): Weights {
  const total = w.capability + w.price + w.speed
  if (total <= 0) return { capability: 1 / 3, price: 1 / 3, speed: 1 / 3 }
  return { capability: w.capability / total, price: w.price / total, speed: w.speed / total }
}

export function scoreModel(
  entry: ScoreEntry,
  weights: Weights,
  task: TaskName,
): { score: number; reasons: string[] } | { excluded: string } {
  if (entry.tags && entry.tags.length > 0 && !entry.tags.includes(task)) {
    return { excluded: `not tagged for ${task}` }
  }
  const w = normalizeWeights(weights)
  const priceScore = 10 - entry.price
  const score = w.capability * entry.capability + w.price * priceScore + w.speed * entry.speed
  const reasons = [
    `capability ${entry.capability}×${w.capability.toFixed(2)}`,
    `price ${entry.price}→${priceScore}×${w.price.toFixed(2)}`,
    `speed ${entry.speed}×${w.speed.toFixed(2)}`,
  ]
  if (entry.tags && entry.tags.length > 0) reasons.push(`tagged: ${entry.tags.join(", ")}`)
  return { score, reasons }
}

export type Candidate = {
  key: string
  providerID: string
  modelID: string
  entry?: ScoreEntry
  providerDisabled?: boolean
}

export function rankModels(
  candidates: Candidate[],
  task: TaskName,
  weights: Weights,
  opts: { allowUnscored: boolean },
): RankResult {
  const ranked: RankedModel[] = []
  const excluded: RankedModel[] = []

  for (const c of candidates) {
    const base: RankedModel = {
      key: c.key,
      providerID: c.providerID,
      modelID: c.modelID,
      score: 0,
      reasons: [],
    }
    if (c.providerDisabled) {
      excluded.push({ ...base, excluded: "provider disabled" })
      continue
    }
    if (!c.entry) {
      if (!opts.allowUnscored) {
        excluded.push({ ...base, excluded: "unscored" })
        continue
      }
      const { score, reasons } = scoreModel(
        { price: 5, capability: 5, speed: 5 },
        weights,
        task,
      ) as { score: number; reasons: string[] }
      ranked.push({ ...base, score, reasons: [...reasons, "unscored → neutral 5/5/5"] })
      continue
    }
    const result = scoreModel(c.entry, weights, task)
    if ("excluded" in result) {
      excluded.push({ ...base, excluded: result.excluded })
      continue
    }
    ranked.push({ ...base, score: result.score, reasons: result.reasons })
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const priceA = candidates.find((c) => c.key === a.key)?.entry?.price ?? 10
    const priceB = candidates.find((c) => c.key === b.key)?.entry?.price ?? 10
    if (priceA !== priceB) return priceA - priceB
    const speedA = candidates.find((c) => c.key === a.key)?.entry?.speed ?? 0
    const speedB = candidates.find((c) => c.key === b.key)?.entry?.speed ?? 0
    if (speedA !== speedB) return speedB - speedA
    return a.key.localeCompare(b.key)
  })

  return { task, ranked, excluded }
}
