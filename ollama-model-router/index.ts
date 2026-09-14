import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"

export default {
  id: "ollama-model-router",
  server: async (_input: PluginInput, _options?: PluginOptions): Promise<Hooks> => {
    return {}
  },
}
