import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { resolveOptions } from "./config"
import { startGateway } from "./gateway"

const id = "@flynncode/mobile-gateway"

async function server(_input: PluginInput, _options?: PluginOptions): Promise<Hooks> {
  const resolved = resolveOptions(process.env)
  if (!resolved.ok) {
    console.log(`[mobile-gateway] disabled: ${resolved.reason}`)
    return {}
  }

  try {
    const gateway = await startGateway({ options: resolved.value })
    console.log(`[mobile-gateway] listening on http://${resolved.value.host}:${gateway.port}`)
    return {
      async dispose() {
        gateway.stop()
      },
    }
  } catch (error) {
    console.log(`[mobile-gateway] failed to start: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

export default { id, server }
export { id }