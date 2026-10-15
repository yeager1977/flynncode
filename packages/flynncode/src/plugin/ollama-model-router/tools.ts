import { tool } from "@flynncode/plugin"
import type { Hooks, PluginInput } from "@flynncode/plugin"
import {
  collectCandidates,
  collectMeta,
  findUnmatchedScorecardKeys,
  resolveCatalog,
  type CatalogLike,
} from "./candidates"
import { resolveFamilyModel, taskFamilyTier } from "./provider-family"
import { rankModels } from "./rank"
import { TASK_NAMES, isTaskName } from "./scorecard"
import type { ModelMeta, RankResult, RouterOptions, TaskName } from "./types"

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

// The rank table's excluded section: everything past this becomes a count, so
// a big catalog cannot push a multi-KB tool result into the transcript.
const EXCLUDED_LIMIT = 5

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
    for (const e of result.excluded.slice(0, EXCLUDED_LIMIT)) lines.push(`- ${e.key}${metaLine(meta, e.key)}: ${e.excluded}`)
    const rest = result.excluded.length - EXCLUDED_LIMIT
    if (rest > 0) lines.push(`+ ${rest} more excluded`)
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
  // Loads the connected provider catalog (no-op once loaded); tools await it
  // so they rank the same models prompt-time routing sees.
  loadCatalog: () => Promise<void>
  getAssignments: () => Record<string, string>
}

function disabledMessage(errors: string[] | undefined): string {
  const lines = errors && errors.length > 0 ? errors : ["options failed to parse; check opencode logs"]
  return `Model router disabled: invalid options:\n- ${lines.join("\n- ")}`
}

// Mirrors assign.taskWinners so the displayed table and the route_task pick
// honor the family the same way prompt-time resolution does. Tools never pass
// a value-lane override, so the pin is the only suppressor here.
function familyWinnerFor(
  cfg: any,
  candidates: ReturnType<typeof collectCandidates>,
  options: RouterOptions,
  task: TaskName,
  catalog: CatalogLike | undefined,
): string | undefined {
  if (!options.modelFamily || options.modelFamily === "auto") return undefined
  if (options.taskModels?.[task]) return undefined
  const available = new Set(candidates.filter((c) => !c.providerDisabled && !c.hidden).map((c) => c.key))
  return resolveFamilyModel({
    family: options.modelFamily,
    tier: taskFamilyTier(task),
    catalog: resolveCatalog(cfg, catalog),
    available,
  })
}

// Exported for the plugin's small_model hook, which ranks the same pool with
// the same honor-the-family rule prompt-time routing uses.
export function rankFor(
  cfg: any,
  candidates: ReturnType<typeof collectCandidates>,
  options: RouterOptions,
  task: TaskName,
  catalog: CatalogLike | undefined,
) {
  return rankModels(candidates, task, options.taskWeights[task], {
    allowUnscored: options.allowUnscored,
    pinned: options.taskModels?.[task],
    familyWinner: familyWinnerFor(cfg, candidates, options, task, catalog),
  })
}

// Compact no-arg view: one winner per task. Seven full tables would push a
// multi-KB block into the transcript only to be re-sent on every later turn;
// models that want the details pass a task and get the full table.
function winnersView(
  cfg: any,
  candidates: ReturnType<typeof collectCandidates>,
  options: RouterOptions,
  catalog: CatalogLike | undefined,
): string {
  const lines: string[] = ["Winners per task (use rank_models with a task for the full table):"]
  for (const task of TASK_NAMES) {
    const result = rankFor(cfg, candidates, options, task, catalog)
    const winner = result.ranked[0]
    lines.push(`${task} → ${winner ? `${winner.key} (${winner.score.toFixed(2)})` : "none"}`)
  }
  return lines.join("\n")
}

export function createTools(deps: Deps): Hooks["tool"] {
  const inFlight = new Set<string>()
  return {
    rank_models: tool({
      description: "Show ranked models per task type (best/cheapest/fastest pick).",
      args: {
        task: tool.schema.string().optional().describe(`One of: ${TASK_NAMES.join("|")}`),
      },
      async execute(args, ctx) {
        const options = deps.getOptions()
        if (options?.enabled === false) return "Model router disabled."
        if (!options) return disabledMessage(deps.getOptionsError())
        if (args.task !== undefined && !isTaskName(args.task)) {
          return `Unknown task "${args.task}". Valid tasks: ${TASK_NAMES.join(", ")}`
        }
        await deps.loadCatalog()
        const cfg = deps.getConfig()
        const catalog = deps.getCatalog()
        const candidates = collectCandidates(cfg, options, catalog)
        const meta = collectMeta(cfg, options, catalog)
        const sections: string[] = []
        if (args.task !== undefined) {
          sections.push(formatRankTable(rankFor(cfg, candidates, options, args.task, catalog), 10, meta))
        } else {
          // Explicit task beats the calling agent's mapping; an unmapped agent
          // gets the compact winners view instead of seven full tables.
          const agentTask = typeof ctx.agent === "string" ? options.agentTasks[ctx.agent] : undefined
          if (agentTask) {
            sections.push(formatRankTable(rankFor(cfg, candidates, options, agentTask, catalog), 10, meta))
          } else {
            sections.push(winnersView(cfg, candidates, options, catalog))
          }
        }
        const unmatched = findUnmatchedScorecardKeys(cfg, options, catalog)
        if (unmatched.length > 0) {
          sections.push("Scorecard entries with no matching model (check for typos):", ...unmatched.map((k) => `- ${k}`))
        }
        const assignments = deps.getAssignments()
        if (Object.keys(assignments).length > 0) {
          sections.push("Agent assignments: " + Object.entries(assignments).map(([a, m]) => `${a}→${m}`).join(", "))
        }
        return sections.join("\n\n")
      },
    }),

    route_task: tool({
      description: "Run a task on the best-ranked model; execute:true launches a background child session.",
      args: {
        task: tool.schema.string().describe(`One of: ${TASK_NAMES.join("|")}`),
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
        await deps.loadCatalog()
        const cfg = deps.getConfig()
        const catalog = deps.getCatalog()
        const candidates = collectCandidates(cfg, options, catalog)
        const meta = collectMeta(cfg, options, catalog)
        const result = rankFor(cfg, candidates, options, args.task, catalog)
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
    auth_status: tool({
      description: "Show vendor sign-in connection state for router-visible providers. Never prints secrets.",
      args: {},
      async execute() {
        const options = deps.getOptions()
        if (options?.enabled === false) return "Model router disabled."
        if (!options) return disabledMessage(deps.getOptionsError())
        await deps.loadCatalog()
        const cfg = deps.getConfig()
        const catalog = deps.getCatalog()
        const candidates = collectCandidates(cfg, options, catalog)
        const vendors = ["anthropic", "openai"]
        const lines = vendors.map((vendor) => {
          const count = candidates.filter((c) => c.providerID === vendor && !c.providerDisabled && !c.hidden).length
          return `${vendor}: ${count > 0 ? `connected (${count} models)` : "not connected"}`
        })
        return [...lines, `Eligible models: ${candidates.filter((c) => !c.providerDisabled && !c.hidden).length}`].join(
          "\n",
        )
      },
    }),
  }
}
