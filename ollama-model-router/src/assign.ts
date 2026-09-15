import { collectCandidates } from "./candidates"
import { rankModels } from "./rank"
import type { RouterOptions } from "./types"

const BUILTIN_AGENTS = new Set(["build", "plan", "general", "explore"])

export function assignAgents(
  cfg: any,
  options: RouterOptions,
): { assignments: Record<string, string>; warnings: string[] } {
  const warnings: string[] = []
  const assignments: Record<string, string> = {}

  if (!options.autoRoute) return { assignments, warnings }

  const candidates = collectCandidates(cfg, options)
  if (candidates.length === 0) {
    warnings.push("no candidate models found for configured providers")
    return { assignments, warnings }
  }

  const winners = new Map<string, { key: string; score: number }>()
  for (const task of new Set(Object.values(options.agentTasks))) {
    const result = rankModels(candidates, task, options.taskWeights[task], {
      allowUnscored: options.allowUnscored,
    })
    if (result.ranked.length === 0) {
      warnings.push(`no eligible model for task "${task}"`)
      continue
    }
    winners.set(task, { key: result.ranked[0].key, score: result.ranked[0].score })
  }

  if (!cfg.agent) cfg.agent = {}

  for (const [agent, task] of Object.entries(options.agentTasks)) {
    const winner = winners.get(task)
    if (!winner) continue
    const existing = cfg.agent[agent]
    if (existing?.disable) continue
    if (existing?.hidden === true) continue
    if (existing === undefined && !BUILTIN_AGENTS.has(agent)) {
      warnings.push(`agent "${agent}" does not exist; skipping (add it to your config or use a built-in agent)`)
      continue
    }
    if (existing?.model && !options.overrideExplicit) {
      warnings.push(`agent "${agent}" has an explicit model; leaving it unchanged`)
      continue
    }
    if (!cfg.agent[agent]) cfg.agent[agent] = {}
    cfg.agent[agent].model = winner.key
    assignments[agent] = winner.key
  }

  return { assignments, warnings }
}
