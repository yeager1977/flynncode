import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { assignAgents, resolveTaskModel } from "./assign"
import { ROUTER_MODEL_ID, ROUTER_MODEL_KEY, ROUTER_PROVIDER_ID, type CatalogLike } from "./candidates"
import { parseOptions, parseTaskVariant, ROUTER_VARIANTS, VALUE_TASK_WEIGHTS } from "./scorecard"
import { createTools } from "./tools"
import type { RouterOptions, TaskName } from "./types"

const PREFIX = "[ollama-model-router]"

function readTupleOptions(options: PluginOptions | undefined): Record<string, unknown> | undefined {
  if (!options || typeof options !== "object" || Array.isArray(options)) return undefined
  return options as Record<string, unknown>
}

/**
 * Built-in Ollama model router.
 *
 * Options come from `model_router` in the merged opencode config. When the
 * plugin is loaded externally (path or npm spec), the options tuple is used as
 * a fallback so existing installations keep working during migration.
 */
export const OllamaModelRouterPlugin = async (input: PluginInput, options?: PluginOptions): Promise<Hooks> => {
  const tupleOptions = readTupleOptions(options)
  let currentOptions: RouterOptions | undefined
  let optionsError: string[] | undefined
  let currentConfig: any
  let assignments: Record<string, string> = {}

  const getOptions = () => currentOptions
  const getOptionsError = () => optionsError

  // The connected catalog (models.dev providers resolved by the server) is the
  // same source the model picker uses. Raw config is the fallback so headless
  // and unit-test callers keep working.
  let catalog: CatalogLike | undefined
  let catalogLoaded = false
  const getCatalog = (): CatalogLike | undefined => catalog
  const loadCatalog = async () => {
    if (catalogLoaded) return
    catalogLoaded = true
    try {
      const result = await input.client.provider.list()
      const all = result.data?.all ?? []
      catalog = Object.fromEntries(
        all.map((provider: any) => [provider.id, { name: provider.name, models: provider.models ?? {} }]),
      ) as CatalogLike
    } catch (error) {
      console.warn(`${PREFIX} connected catalog unavailable; using config providers`, error)
      catalog = undefined
    }
  }

  const resolveOptions = (cfg: any): { raw: Record<string, unknown> | undefined; source: string } => {
    const fromConfig = cfg && typeof cfg === "object" ? (cfg as Record<string, unknown>).model_router : undefined
    if (fromConfig !== undefined) {
      return {
        raw:
          fromConfig && typeof fromConfig === "object" && !Array.isArray(fromConfig)
            ? (fromConfig as Record<string, unknown>)
            : {},
        source: "config.model_router",
      }
    }
    return { raw: tupleOptions, source: "plugin options" }
  }

  // Selecting "Model Router" in the picker must not reach a provider API. When
  // the sentinel is present, resolve it to the concrete winner for the chosen
  // task (variant) or the active agent's task, and rewrite the transcript
  // message. The session preference keeps the sentinel so the picker stays put.
  const resolveSentinel = (event: {
    sessionID: string
    agent?: string
    model?: { providerID: string; modelID: string }
    variant?: string
  }): { task: TaskName; model: string } | undefined => {
    if (!currentOptions) return undefined
    if (event.model?.providerID !== ROUTER_PROVIDER_ID) return undefined
    const parsed = parseTaskVariant(event.variant)
    const task: TaskName | undefined =
      parsed?.task ?? (event.agent ? currentOptions.agentTasks[event.agent] : undefined)
    if (!task) return undefined
    // A `<task>-value` variant asks for the cheap lane, so it uses value weights
    // and ignores the task pin (a pin would otherwise re-impose the premium
    // model for tasks like review).
    const value = parsed?.value === true
    const model = resolveTaskModel(currentConfig, currentOptions, task, getCatalog(), {
      weights: value ? VALUE_TASK_WEIGHTS : undefined,
      ignorePin: value,
    })
    return model ? { task, model } : undefined
  }

  return {
    config: async (cfg) => {
      try {
        currentConfig = cfg
        const { raw, source } = resolveOptions(cfg)
        if (raw === undefined) {
          // Built-in plugin with no `model_router` config and no options tuple:
          // stay silently inert so unconfigured users see no warnings.
          currentOptions = undefined
          optionsError = undefined
          return
        }
        const parsed = parseOptions(raw)
        if (!parsed.ok) {
          currentOptions = undefined
          optionsError = parsed.errors
          console.warn(`${PREFIX} invalid options (${source}); routing disabled:\n- ${parsed.errors.join("\n- ")}`)
          return
        }
        currentOptions = parsed.options
        optionsError = undefined

        injectRouterProvider(cfg)

        // Assignment mutates agent models and is legacy-only. Normal activation
        // is selecting Model Router, resolved at prompt time.
        const result = assignAgents(cfg, parsed.options)
        assignments = result.assignments
        for (const warning of result.warnings) console.warn(`${PREFIX} ${warning}`)
        if (Object.keys(result.assignments).length > 0) {
          console.info(
            `${PREFIX} agent routing: ` +
              Object.entries(result.assignments)
                .map(([agent, model]) => `${agent}→${model}`)
                .join(", "),
          )
        }
      } catch (error) {
        console.error(`${PREFIX} config hook failed; routing disabled`, error)
        currentOptions = undefined
      }
    },
    "chat.message": async (event, output) => {
      // Another plugin may have already replaced the sentinel; never touch a
      // concrete model.
      if (output.message.model.providerID !== ROUTER_PROVIDER_ID) return
      if (event.model?.providerID !== ROUTER_PROVIDER_ID) return
      try {
        await loadCatalog()
        const resolved = resolveSentinel(event)
        if (!resolved) {
          // Failing here is safer than letting the sentinel reach a provider
          // API. The prompt surfaces this message to the user.
          const task = event.variant ?? (event.agent ? currentOptions?.agentTasks[event.agent] : undefined) ?? "?"
          throw new Error(
            `Model Router has no eligible model for task "${task}". ` +
              `Check model_router providers, scorecards, and excludeModels.`,
          )
        }
        const index = resolved.model.indexOf("/")
        output.message.model = {
          ...output.message.model,
          providerID: resolved.model.slice(0, index),
          modelID: resolved.model.slice(index + 1),
        }
      } catch (error) {
        console.error(`${PREFIX} chat.message hook failed`, error)
        throw error
      }
    },
    tool: createTools({
      client: input.client,
      directory: input.directory,
      getOptions,
      getOptionsError,
      getConfig: () => currentConfig,
      getCatalog,
      getAssignments: () => assignments,
    }),
  }

  function injectRouterProvider(cfg: any) {
    if (!cfg || typeof cfg !== "object") return
    if (!cfg.provider || typeof cfg.provider !== "object") cfg.provider = {}
    if (cfg.provider[ROUTER_PROVIDER_ID]) return
    cfg.provider[ROUTER_PROVIDER_ID] = {
      name: "Model Router",
      models: {
        [ROUTER_MODEL_ID]: {
          name: "Model Router",
          tool_call: true,
          reasoning: true,
          limit: { context: 1000000, output: 65536 },
          variants: ROUTER_VARIANTS,
        },
      },
    }
  }
}

export default {
  id: "ollama-model-router",
  server: OllamaModelRouterPlugin,
}
