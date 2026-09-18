import { collectCandidates, type CatalogLike } from "./candidates"
import { rankModels } from "./rank"
import type { RouterOptions, TaskName } from "./types"

const BUILTIN_AGENTS = new Set(["build", "plan", "general", "explore"])

type RankOverride = {
  weights?: RouterOptions["taskWeights"][TaskName]
  ignorePin?: boolean
}

export function taskWinners(
  cfg: any,
  options: RouterOptions,
  tasks: Iterable<TaskName>,
  catalog?: CatalogLike,
  override?: RankOverride,
): { winners: Map<TaskName, string>; warnings: string[] } {
  const warnings: string[] = []
  const winners = new Map<TaskName, string>()
  const candidates = collectCandidates(cfg, options, catalog)
  if (candidates.length === 0) {
    warnings.push("no candidate models found for configured providers")
    return { winners, warnings }
  }
  for (const task of tasks) {
    const result = rankModels(candidates, task, override?.weights ?? options.taskWeights[task], {
      allowUnscored: options.allowUnscored,
      pinned: override?.ignorePin ? undefined : options.taskModels?.[task],
    })
    if (result.ranked.length === 0) {
      warnings.push(`no eligible model for task "${task}"`)
      continue
    }
    winners.set(task, result.ranked[0].key)
  }
  return { winners, warnings }
}

export function resolveTaskModel(
  cfg: any,
  options: RouterOptions,
  task: TaskName,
  catalog?: CatalogLike,
  override?: RankOverride,
): string | undefined {
  return taskWinners(cfg, options, [task], catalog, override).winners.get(task)
}

export function assignAgents(
  cfg: any,
  options: RouterOptions,
  catalog?: CatalogLike,
): { assignments: Record<string, string>; warnings: string[] } {
  const warnings: string[] = []
  const assignments: Record<string, string> = {}

  // Selecting the virtual Model Router resolves at prompt time. Mutating agent
  // models at startup is legacy behavior, kept only behind `legacyAssign`.
  if (!options.autoRoute || !options.legacyAssign) return { assignments, warnings }

  const { winners, warnings: rankWarnings } = taskWinners(
    cfg,
    options,
    new Set(Object.values(options.agentTasks)),
    catalog,
  )
  warnings.push(...rankWarnings)

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
    cfg.agent[agent].model = winner
    assignments[agent] = winner
  }

  return { assignments, warnings }
}
