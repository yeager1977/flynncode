#!/usr/bin/env bun
import { resolveOptions } from "./config.ts"
import { startGateway } from "./gateway.ts"

const resolved = resolveOptions(process.env)
if (!resolved.ok) {
  console.error(`[mobile-gateway] ${resolved.reason}`)
  process.exit(1)
}

const gateway = await startGateway({ options: resolved.value })
console.log(`[mobile-gateway] listening on http://${resolved.value.host}:${gateway.port}`)
console.log(`[mobile-gateway] upstream ${resolved.value.upstream}`)

const shutdown = () => {
  gateway.stop()
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

await new Promise(() => {})