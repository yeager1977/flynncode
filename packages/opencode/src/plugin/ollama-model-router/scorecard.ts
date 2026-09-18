import type { RouterOptions, ScoreEntry, TaskName } from "./types"

export const TASK_NAMES: TaskName[] = [
  "coding",
  "planning",
  "review",
  "architecture",
  "lookup",
  "writing",
  "long-context",
]

export const DEFAULT_AGENT_TASKS: Record<string, TaskName> = {
  build: "coding",
  plan: "planning",
  explore: "lookup",
  general: "coding",
}

export const DEFAULT_TASK_WEIGHTS: Record<TaskName, { capability: number; price: number; speed: number }> = {
  // Coding is capability-dominant so the strongest model (Claude Opus 5) wins;
  // the `<task>-value` lane covers the cheap Flash alternatives.
  coding: { capability: 0.7, price: 0.1, speed: 0.2 },
  planning: { capability: 0.7, price: 0.2, speed: 0.1 },
  review: { capability: 0.65, price: 0.25, speed: 0.1 },
  architecture: { capability: 0.9, price: 0.05, speed: 0.05 },
  lookup: { capability: 0.3, price: 0.3, speed: 0.4 },
  writing: { capability: 0.5, price: 0.3, speed: 0.2 },
  "long-context": { capability: 0.6, price: 0.3, speed: 0.1 },
}

// Cost-dominant profile behind `<task>-value` variants, matching the settings
// editor's "Lower cost" preset.
export const VALUE_TASK_WEIGHTS = { capability: 0.25, price: 0.65, speed: 0.1 }

const VALUE_SUFFIX = "-value"

export function parseTaskVariant(variant: string | undefined): { task: TaskName; value: boolean } | undefined {
  if (!variant) return undefined
  if (variant.endsWith(VALUE_SUFFIX)) {
    const task = variant.slice(0, -VALUE_SUFFIX.length)
    return isTaskName(task) ? { task, value: true } : undefined
  }
  return isTaskName(variant) ? { task: variant, value: false } : undefined
}

export const ROUTER_VARIANTS: Record<string, Record<string, never>> = Object.fromEntries(
  TASK_NAMES.flatMap((task) => [
    [task, {}],
    [`${task}${VALUE_SUFFIX}`, {}],
  ]),
)

export function parseModelKey(key: string): { providerID: string; modelID: string } | undefined {
  const idx = key.indexOf("/")
  if (idx <= 0 || idx === key.length - 1) return undefined
  return { providerID: key.slice(0, idx), modelID: key.slice(idx + 1) }
}

export function isTaskName(value: unknown): value is TaskName {
  return typeof value === "string" && (TASK_NAMES as string[]).includes(value)
}

export function parseOptions(
  raw: Record<string, unknown> | undefined,
): { ok: true; options: RouterOptions } | { ok: false; errors: string[] } {
  try {
    const errors: string[] = []
    const r = raw ?? {}

    const autoRoute = typeof r.autoRoute === "boolean" ? r.autoRoute : true
    const allowUnscored = typeof r.allowUnscored === "boolean" ? r.allowUnscored : true
    const overrideExplicit = typeof r.overrideExplicit === "boolean" ? r.overrideExplicit : false
    const legacyAssign = typeof r.legacyAssign === "boolean" ? r.legacyAssign : false

    let providers: string[] = []
    if (r.providers !== undefined) {
      if (Array.isArray(r.providers) && r.providers.every((p) => typeof p === "string")) {
        providers = r.providers as string[]
      } else {
        errors.push("providers must be an array of strings")
      }
    }

    let agentTasks: Record<string, TaskName> = { ...DEFAULT_AGENT_TASKS }
    if (r.agentTasks !== undefined) {
      if (r.agentTasks === null || typeof r.agentTasks !== "object" || Array.isArray(r.agentTasks)) {
        errors.push("agentTasks must be an object mapping agent names to task names")
      } else {
        agentTasks = {}
        for (const [agent, task] of Object.entries(r.agentTasks as Record<string, unknown>)) {
          if (!isTaskName(task)) {
            errors.push(`agentTasks.${agent}: unknown task "${String(task)}" (valid: ${TASK_NAMES.join(", ")})`)
            continue
          }
          agentTasks[agent] = task
        }
      }
    }

    const taskWeights = structuredClone(DEFAULT_TASK_WEIGHTS)
    if (r.taskWeights !== undefined) {
      if (r.taskWeights === null || typeof r.taskWeights !== "object" || Array.isArray(r.taskWeights)) {
        errors.push("taskWeights must be an object keyed by task name")
      } else {
        for (const [task, w] of Object.entries(r.taskWeights as Record<string, unknown>)) {
          if (!isTaskName(task)) {
            errors.push(`taskWeights.${task}: unknown task (valid: ${TASK_NAMES.join(", ")})`)
            continue
          }
          if (w === null || typeof w !== "object" || Array.isArray(w)) {
            errors.push(`taskWeights.${task} must be an object with capability/price/speed`)
            continue
          }
          const obj = w as Record<string, unknown>
          for (const dim of ["capability", "price", "speed"] as const) {
            const v = obj[dim]
            if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
              errors.push(`taskWeights.${task}.${dim} must be a non-negative number`)
            } else {
              taskWeights[task][dim] = v
            }
          }
        }
      }
    }

    const taskModels: Partial<Record<TaskName, string>> = {}
    if (r.taskModels !== undefined) {
      if (r.taskModels === null || typeof r.taskModels !== "object" || Array.isArray(r.taskModels)) {
        errors.push("taskModels must be an object keyed by task name")
      } else {
        for (const [task, model] of Object.entries(r.taskModels as Record<string, unknown>)) {
          if (!isTaskName(task)) {
            errors.push(`taskModels.${task}: unknown task (valid: ${TASK_NAMES.join(", ")})`)
            continue
          }
          if (typeof model !== "string" || !parseModelKey(model)) {
            errors.push(`taskModels.${task}: must be a "providerID/modelID" string`)
            continue
          }
          taskModels[task] = model
        }
      }
    }

    let excludeModels: string[] = []
    if (r.excludeModels !== undefined) {
      if (Array.isArray(r.excludeModels) && r.excludeModels.every((key) => typeof key === "string" && parseModelKey(key))) {
        excludeModels = r.excludeModels as string[]
      } else {
        errors.push('excludeModels must be an array of "providerID/modelID" strings')
      }
    }

    const models: Record<string, ScoreEntry> = {}
    if (r.models !== undefined) {
      if (r.models === null || typeof r.models !== "object" || Array.isArray(r.models)) {
        errors.push("models must be an object keyed by providerID/modelID")
      } else {
        for (const [key, entry] of Object.entries(r.models as Record<string, unknown>)) {
          if (!parseModelKey(key)) {
            errors.push(`models."${key}": key must be "providerID/modelID"`)
            continue
          }
          if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
            errors.push(`models."${key}": entry must be an object`)
            continue
          }
          const obj = entry as Record<string, unknown>
          const parsed: ScoreEntry = { price: 5, capability: 5, speed: 5 }
          for (const dim of ["price", "capability", "speed"] as const) {
            const v = obj[dim]
            if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 10) {
              errors.push(`models."${key}".${dim} must be an integer 1-10`)
            } else {
              parsed[dim] = v
            }
          }
          if (obj.tags !== undefined) {
            if (Array.isArray(obj.tags) && obj.tags.every(isTaskName)) {
              parsed.tags = obj.tags as TaskName[]
            } else {
              errors.push(`models."${key}".tags must be an array of task names`)
            }
          }
          models[key] = parsed
        }
      }
    }

    if (errors.length > 0) return { ok: false, errors }
    return {
      ok: true,
      options: {
        autoRoute,
        allowUnscored,
        overrideExplicit,
        legacyAssign,
        providers,
        agentTasks,
        taskWeights,
        taskModels,
        excludeModels,
        models,
      },
    }
  } catch (e) {
    return { ok: false, errors: [String(e)] }
  }
}
