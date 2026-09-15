export type TaskName =
  | "coding"
  | "planning"
  | "review"
  | "lookup"
  | "writing"
  | "long-context"

export const TASK_NAMES: TaskName[] = [
  "coding",
  "planning",
  "review",
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

export type TaskWeights = Record<TaskName, { capability: number; price: number; speed: number }>

export const DEFAULT_TASK_WEIGHTS: TaskWeights = {
  coding: { capability: 0.6, price: 0.25, speed: 0.15 },
  planning: { capability: 0.7, price: 0.2, speed: 0.1 },
  review: { capability: 0.65, price: 0.25, speed: 0.1 },
  lookup: { capability: 0.3, price: 0.3, speed: 0.4 },
  writing: { capability: 0.5, price: 0.3, speed: 0.2 },
  "long-context": { capability: 0.6, price: 0.3, speed: 0.1 },
}

export type AgentTaskRow = { agent: string; task: TaskName }

export type ModelScoreRow = { key: string; tags: TaskName[]; price: number; capability: number; speed: number }

export type ModelRouterFormState = {
  autoRoute: boolean
  allowUnscored: boolean
  providers: string[]
  agentTasks: AgentTaskRow[]
  taskWeights: TaskWeights
  models: ModelScoreRow[]
}

export function emptyForm(): ModelRouterFormState {
  return {
    autoRoute: true,
    allowUnscored: false,
    providers: [],
    agentTasks: Object.entries(DEFAULT_AGENT_TASKS).map(([agent, task]) => ({ agent, task })),
    taskWeights: structuredClone(DEFAULT_TASK_WEIGHTS),
    models: [],
  }
}

export function formFromConfig(config: Record<string, unknown> | undefined): ModelRouterFormState {
  const raw = config ?? {}
  return {
    autoRoute: typeof raw.autoRoute === "boolean" ? raw.autoRoute : true,
    allowUnscored: typeof raw.allowUnscored === "boolean" ? raw.allowUnscored : false,
    providers: providersFrom(raw.providers),
    agentTasks: agentTasksFrom(raw.agentTasks),
    taskWeights: weightsFrom(raw.taskWeights),
    models: modelsFrom(raw.models),
  }
}

export function serializeForm(form: ModelRouterFormState): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    autoRoute: form.autoRoute,
    allowUnscored: form.allowUnscored,
    providers: [...form.providers],
    agentTasks: Object.fromEntries(form.agentTasks.map((row) => [row.agent, row.task])),
    taskWeights: Object.fromEntries(TASK_NAMES.map((task) => [task, { ...form.taskWeights[task] }])),
  }
  if (form.models.length > 0) {
    payload.models = Object.fromEntries(
      form.models.map((model) => [
        model.key,
        {
          price: model.price,
          capability: model.capability,
          speed: model.speed,
          ...(model.tags.length > 0 ? { tags: [...model.tags] } : {}),
        },
      ]),
    )
  }
  return payload
}

export function validateForm(
  form: ModelRouterFormState,
): { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] } {
  const errors: string[] = []
  form.providers.forEach((provider, index) => {
    if (provider.trim() === "") errors.push(`providers.${index}`)
  })
  for (const row of form.agentTasks) {
    const agent = row.agent.trim()
    if (agent === "") errors.push("agentTasks..agent")
    if (!isTaskName(row.task)) errors.push(`agentTasks.${agent}.task`)
  }
  const seen = new Set<string>()
  for (const model of form.models) {
    if (parseModelKey(model.key) === undefined) errors.push(`models.${model.key}.key`)
    if (seen.has(model.key)) errors.push("models.duplicate")
    seen.add(model.key)
    if (model.tags.some((tag) => !isTaskName(tag))) errors.push(`models.${model.key}.tags`)
    for (const dim of ["price", "capability", "speed"] as const) {
      if (!isScore(model[dim])) errors.push(`models.${model.key}.${dim}`)
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: serializeForm(form) }
}

function isTaskName(value: unknown): value is TaskName {
  return typeof value === "string" && (TASK_NAMES as string[]).includes(value)
}

function parseModelKey(key: string): { providerID: string; modelID: string } | undefined {
  const idx = key.indexOf("/")
  if (idx <= 0 || idx === key.length - 1) return undefined
  return { providerID: key.slice(0, idx), modelID: key.slice(idx + 1) }
}

function isScore(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 10
}

function providersFrom(raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.every((provider) => typeof provider === "string")) return []
  return raw as string[]
}

function agentTasksFrom(raw: unknown): AgentTaskRow[] {
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return Object.entries(DEFAULT_AGENT_TASKS).map(([agent, task]) => ({ agent, task }))
  }
  return Object.entries(raw as Record<string, unknown>)
    .filter((entry): entry is [string, TaskName] => isTaskName(entry[1]))
    .map(([agent, task]) => ({ agent, task }))
}

function weightsFrom(raw: unknown): TaskWeights {
  const weights = structuredClone(DEFAULT_TASK_WEIGHTS)
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) return weights
  for (const [task, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isTaskName(task) || value === null || typeof value !== "object" || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    for (const dim of ["capability", "price", "speed"] as const) {
      const v = entry[dim]
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) weights[task][dim] = v
    }
  }
  return weights
}

function modelsFrom(raw: unknown): ModelScoreRow[] {
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) return []
  return Object.entries(raw as Record<string, unknown>)
    .filter(([key]) => parseModelKey(key) !== undefined)
    .map(([key, entry]) => {
      const obj = entry !== null && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {}
      return {
        key,
        tags: Array.isArray(obj.tags) ? obj.tags.filter((tag): tag is TaskName => isTaskName(tag)) : [],
        price: scoreFrom(obj.price),
        capability: scoreFrom(obj.capability),
        speed: scoreFrom(obj.speed),
      }
    })
}

function scoreFrom(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10 ? value : 5
}