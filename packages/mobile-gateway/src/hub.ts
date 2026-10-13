#!/usr/bin/env bun
// Headless sync-hub runner: serves the /flynncode-sync/* surface to spokes
// through the gateway (HMAC-signed pairing tokens) and forwards to the local
// server as upstream. The hub never pulls — spokes pull from and push to it.
//
// All spokes share one hub token: createSyncGate mints pairing tokens via the
// injected `token` factory, so a fixed factory yields a fixed hub token and
// every paired spoke verifies. Pairing codes are single-use; after each
// successful pairing a fresh code is minted and LOGGED for the next spoke.
// A brute-force lockout clears the code — restart the process for a new
// window (the HUB_PAIRING_CODE env value is restored).
//
// Env:
//   HUB_SYNC_TOKEN    64-hex-char shared spoke token (required)
//   HUB_PAIRING_CODE  initial 6-digit pairing code (required to allow pairing)
//   HUB_MACHINE_NAME  hub name reported to spokes (default "hub")
//   OPENCODE_SERVER_PASSWORD (required, gateway upstream auth — see config.ts)
//   OPENCODE_MOBILE_UPSTREAM (default http://127.0.0.1:4096)
//   OPENCODE_MOBILE_PORT     (default 4097)
import { randomInt } from "node:crypto"
import { resolveOptions } from "./config.ts"
import { startGateway } from "./gateway.ts"
import { createSyncGate } from "./sync-gate.ts"

const token = process.env.HUB_SYNC_TOKEN ?? ""
if (!/^[0-9a-f]{64}$/.test(token)) {
  console.error("[hub] HUB_SYNC_TOKEN must be 64 hex chars")
  process.exit(1)
}

const resolved = resolveOptions(process.env)
if (!resolved.ok) {
  console.error(`[hub] ${resolved.reason}`)
  process.exit(1)
}

const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0")

const gate = createSyncGate({
  machineName: process.env.HUB_MACHINE_NAME ?? "hub",
  gatewayPort: resolved.value.port,
  phoneAccess: false,
  paused: false,
  peer: { name: "hub", url: `http://127.0.0.1:${resolved.value.port}`, token },
  prefs: undefined,
  hubMode: true,
  token: () => token,
  onPaired: (peer) => {
    // Single-use codes: mint the next one immediately and log it for the
    // next spoke owner. Anyone with pod-log access can read pairing codes;
    // codes alone only grant one pairing each, and requests stay HMAC-bound.
    const next = newCode()
    gate.setPairingCode({ code: next, expiresAt: Number.MAX_SAFE_INTEGER })
    console.log(`[hub] paired spoke ${peer.name}; next pairing code: ${next}`)
  },
  onUnpaired: () => {
    // Revoking the shared token disconnects every spoke until one re-pairs
    // (which restores the same token). Logged loudly on purpose.
    console.log("[hub] unpaired — all spokes must re-pair to reconnect")
  },
})

const initial = process.env.HUB_PAIRING_CODE ?? ""
if (!/^\d{6}$/.test(initial)) {
  console.error("[hub] HUB_PAIRING_CODE must be 6 digits")
  process.exit(1)
}
gate.setPairingCode({ code: initial, expiresAt: Number.MAX_SAFE_INTEGER })
console.log(`[hub] pairing code: ${initial}`)

const gateway = await startGateway({ options: resolved.value, sync: gate })
console.log(`[hub] sync gateway on http://${resolved.value.host}:${gateway.port} -> ${resolved.value.upstream}`)

const shutdown = () => {
  gateway.stop()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

await new Promise(() => {})
