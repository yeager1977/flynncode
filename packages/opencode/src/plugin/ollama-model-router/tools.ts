import { tool } from "@opencode-ai/plugin"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import {
  collectCandidates,
  collectMeta,
  findUnmatchedScorecardKeys,
  type CatalogLike,
} from "./candidates"
import { rankModels } from "./rank"
import { TASK_NAMES, isTaskName } from "./scorecard"
import type { ModelMeta, RankResult, RouterOptions } from "./types"

function metaLine(meta: Map<string, ModelMeta> | undefined, key: string): string {
  const m = meta?.get(key)
  if (!m) return ""
  const fields: string[] = []
  if (m.name) fields.push(m.name)
  if (m.context) fields.push(`ctx ${Math.round(m.context / 1000)}k`)
  if (m.toolCall) fields.push("tools")
  if (m.reasoning) fields.push("reasoning")
  if (m.providerDisabled) fields.push("provider disabled")
  return fields.length > 0 ? ` (${fields.join(", ")})` : ""
}

export function formatRankTable(result: RankResult, limit = 10, meta?: Map<string, ModelMeta>): string {
  const lines: string[] = [`Task: ${result.task}`]
  if (result.ranked.length === 0) {
    lines.push("No eligible models.")
  } else {
    lines.push("", "Rank | Model | Score | Reasons", "---- | ----- | ----- | -------")
    result.ranked.slice(0, limit).forEach((r, i) => {
      lines.push(`${i + 1} | ${r.key}${metaLine(meta, r.key)} | ${r.score.toFixed(2)} | ${r.reasons.join("; ")}`)
    })
  }
  if (result.excluded.length > 0) {
    lines.push("", "Excluded:")
    for (const e of result.excluded) lines.push(`- ${e.key}${metaLine(meta, e.key)}: ${e.excluded}`)
  }
  return lines.join("\n")
}

type Deps = {
  client: PluginInput["client"]
  directory: string
  getOptions: () => RouterOptions | undefined
  getOptionsError: () => string[] | undefined
  getConfig: () => any
  getCatalog: () => CatalogLike | undefined
  getAssignments: () => Record<string, string>
}

function disabledMessage(errors: string[] | undefined): string {
  const lines = errors && errors.length > 0 ? errors : ["options failed to parse; check opencode logs"]
  return `Model router disabled: invalid options:\n- ${lines.join("\n- ")}`
}

export function createTools(deps: Deps): Hooks["tool"] {
  const inFlight = new Set<string>()
  return {
    rank_models: tool({
      description:
        "Show ranked Ollama models per task type. Use to inspect which model routing considers best/cheapest/fastest.",
      args: {
        task: tool.schema.string().optional().describe(`One of: ${TASK_NAMES.join(", ")}`),
      },
      async execute(args) {
        const options = deps.getOptions()
        if (options?.enabled === false) return "Model router disabled."
        if (!options) return disabledMessage(deps.getOptionsError())
        const cfg = deps.getConfig()
        const catalog = deps.getCatalog()
        const candidates = collectCandidates(cfg, options, catalog)
        const meta = collectMeta(cfg, options, catalog)
        const tasks = args.task ? [args.task] : TASK_NAMES
        const blocks: string[] = []
        for (const task of tasks) {
          if (!isTaskName(task)) {
            return `Unknown task "${task}". Valid tasks: ${TASK_NAMES.join(", ")}`
          }
          const result = rankModels(candidates, task, options.taskWeights[task], {
            allowUnscored: options.allowUnscored,
            pinned: options.taskModels?.[task],
          })
          blocks.push(formatRankTable(result, 10, meta))
        }
        const unmatched = findUnmatchedScorecardKeys(cfg, options, catalog)
        if (unmatched.length > 0) {
          blocks.push("", "Scorecard entries with no matching model (check for typos):", ...unmatched.map((k) => `- ${k}`))
        }
        const assignments = deps.getAssignments()
        if (Object.keys(assignments).length > 0) {
          blocks.push("", "Agent assignments: " + Object.entries(assignments).map(([a, m]) => `${a}→${m}`).join(", "))
        }
        return blocks.join("\n\n")
      },
    }),

    route_task: tool({
      description:
        "Pick the best model for a task and optionally run the prompt on it. Use execute:true to launch a background child session.",
      args: {
        task: tool.schema.string().describe(`One of: ${TASK_NAMES.join(", ")}`),
        prompt: tool.schema.string().describe("The prompt to run"),
        execute: tool.schema.boolean().optional().describe("Run the prompt in a child session (default false)"),
        wait: tool.schema.boolean().optional().describe("Wait for the response instead of returning immediately"),
      },
      async execute(args, ctx) {
        const options = deps.getOptions()
        if (options?.enabled === false) return "Model router disabled."
        if (!options) return disabledMessage(deps.getOptionsError())
        if (!isTaskName(args.task)) {
          return `Unknown task "${args.task}". Valid tasks: ${TASK_NAMES.join(", ")}`
        }
        const cfg = deps.getConfig()
        const catalog = deps.getCatalog()
        const candidates = collectCandidates(cfg, options, catalog)
        const meta = collectMeta(cfg, options, catalog)
        const result = rankModels(candidates, args.task, options.taskWeights[args.task], {
          allowUnscored: options.allowUnscored,
          pinned: options.taskModels?.[args.task],
        })
        if (result.ranked.length === 0) {
          return `No eligible models for "${args.task}".\n\n` + formatRankTable(result, 10, meta)
        }
        const pick = result.ranked[0]
        const runnerUp = result.ranked[1]
        const summary = [
          `Selected: ${pick.key} (score ${pick.score.toFixed(2)})`,
          `Why: ${pick.reasons.join("; ")}`,
          runnerUp ? `Runner-up: ${runnerUp.key} (${runnerUp.score.toFixed(2)})` : "",
        ]
          .filter(Boolean)
          .join("\n")

        if (!args.execute) return summary

        if (inFlight.has(ctx.sessionID)) {
          return `${summary}\n\nA route_task execution is already in flight for this session. Wait for it to finish before starting another.`
        }
        inFlight.add(ctx.sessionID)
        try {
          const created = await deps.client.session.create({
            body: { parentID: ctx.sessionID, title: `route_task: ${args.task}` },
            query: { directory: deps.directory },
          })
          const session = created.data
          if (!session?.id) return `${summary}\n\nFailed to create child session.`

          const body = {
            model: { providerID: pick.providerID, modelID: pick.modelID },
            agent: "general",
            parts: [{ type: "text" as const, text: args.prompt }],
          }
          if (args.wait) {
            const response = await deps.client.session.prompt({
              path: { id: session.id },
              query: { directory: deps.directory },
              body,
            })
            const parts = response.data?.parts ?? []
            const text = parts
              .filter((p: any) => p.type === "text")
              .map((p: any) => p.text)
              .join("\n")
            return `${summary}\n\nChild session: ${session.id}\n\n${text || "(no text response)"}`
          }

          await deps.client.session.promptAsync({
            path: { id: session.id },
            query: { directory: deps.directory },
            body,
          })
          return `${summary}\n\nRunning in background child session: ${session.id}`
        } finally {
          inFlight.delete(ctx.sessionID)
        }
      },
    }),
  }
}
