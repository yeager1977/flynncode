import { resolveOptions } from "@flynncode/mobile-gateway"
import { startGateway } from "@flynncode/mobile-gateway/gateway"
import type { SyncGate } from "@flynncode/mobile-gateway/sync-gate"

export const MOBILE_GATEWAY_PORT = 4097

export function mobileGatewayUpstream(hostname: string, port: number) {
  return `http://${hostname}:${port}`
}

export function mobileGatewayEnv(input: {
  serverPassword: string
  phonePassword: string
  port: number
  relayToken: string
  host?: string
}) {
  return {
    OPENCODE_SERVER_PASSWORD: input.serverPassword,
    OPENCODE_MOBILE_PASSWORD: input.phonePassword,
    OPENCODE_MOBILE_PORT: String(input.port),
    OPENCODE_RELAY_TOKEN: input.relayToken,
    ...(input.host ? { OPENCODE_MOBILE_HOST: input.host } : {}),
  }
}

export type MobileGatewayHandle = { port: number; stop(): void }

export async function startMobileGateway(input: {
  serverPassword: string
  phonePassword: string
  port: number
  upstream: string
  relayToken: string
  host?: string
  sync?: SyncGate
}): Promise<MobileGatewayHandle | undefined> {
  try {
    const resolved = resolveOptions(mobileGatewayEnv(input), input.upstream)
    if (!resolved.ok) {
      console.warn(`[mobile-gateway] disabled: ${resolved.reason}`)
      return
    }
    const gateway = await startGateway({ options: resolved.value, sync: input.sync })
    console.log(`[mobile-gateway] listening on http://${resolved.value.host}:${gateway.port}`)
    return gateway
  } catch (error) {
    console.warn(`[mobile-gateway] failed to start: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
}
