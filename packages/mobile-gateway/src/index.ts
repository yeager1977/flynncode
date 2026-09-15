import type { Hooks, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import { resolveOptions } from "./config.ts"
import { startGateway } from "./gateway.ts"

const id = "@flynncode/mobile-gateway"

async function server(input: PluginInput, options?: PluginOptions): Promise<Hooks> {
  const env = { ...process.env }
  if (typeof options?.password === "string" && options.password) env.OPENCODE_MOBILE_PASSWORD = options.password
  const resolved = resolveOptions(env, input.serverUrl?.toString())
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