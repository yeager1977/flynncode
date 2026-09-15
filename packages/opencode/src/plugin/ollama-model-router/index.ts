import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { assignAgents } from "./assign"
import { parseOptions } from "./scorecard"
import { createTools } from "./tools"
import type { RouterOptions } from "./types"

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

  const getOptions = () => currentOptions
  const getOptionsError = () => optionsError

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
    tool: createTools({
      client: input.client,
      directory: input.directory,
      getOptions,
      getOptionsError,
      getConfig: () => currentConfig,
      getAssignments: () => assignments,
    }),
  }
}

export default {
  id: "ollama-model-router",
  server: OllamaModelRouterPlugin,
}
