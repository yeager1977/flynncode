export type TaskName =
  | "coding"
  | "planning"
  | "review"
  | "lookup"
  | "writing"
  | "long-context"

export type ScoreEntry = {
  price: number
  capability: number
  speed: number
  tags?: TaskName[]
}

export type ModelMeta = {
  providerID: string
  modelID: string
  name?: string
  context?: number
  toolCall?: boolean
  reasoning?: boolean
  providerDisabled?: boolean
}

export type RouterOptions = {
  autoRoute: boolean
  allowUnscored: boolean
  overrideExplicit: boolean
  providers: string[]
  agentTasks: Record<string, TaskName>
  taskWeights: Record<TaskName, { capability: number; price: number; speed: number }>
  taskModels: Partial<Record<TaskName, string>>
  models: Record<string, ScoreEntry>
}

export type RankedModel = {
  key: string
  providerID: string
  modelID: string
  score: number
  reasons: string[]
  excluded?: string
}

export type RankResult = {
  task: TaskName
  ranked: RankedModel[]
  excluded: RankedModel[]
}
