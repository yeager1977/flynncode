import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { assignAgents } from "./src/assign"
import { parseOptions } from "./src/scorecard"
import { createTools } from "./src/tools"
import type { RouterOptions } from "./src/types"

const PREFIX = "[ollama-model-router]"

export default {
  id: "ollama-model-router",
  server: async (input: PluginInput, options?: PluginOptions): Promise<Hooks> => {
    const parsed = parseOptions(options)
    let currentOptions: RouterOptions | undefined
    let currentConfig: any
    let assignments: Record<string, string> = {}
    const optionsError = parsed.ok ? undefined : parsed.errors

    if (parsed.ok) {
      currentOptions = parsed.options
      // An empty providers list means "every provider whose id starts with
      // ollama" — resolved in collectCandidates/collectMeta against the live
      // config. Do not hardcode provider ids here.
    } else {
      console.warn(`${PREFIX} invalid options; routing disabled:\n- ${parsed.errors.join("\n- ")}`)
    }

    const getOptions = () => currentOptions
    const getOptionsError = () => optionsError
    const getConfig = () => currentConfig
    const getAssignments = () => assignments

    return {
      config: async (cfg) => {
        try {
          currentConfig = cfg
          if (!currentOptions) return
          const result = assignAgents(cfg, currentOptions)
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
        getConfig,
        getAssignments,
      }),
    }
  },
}
