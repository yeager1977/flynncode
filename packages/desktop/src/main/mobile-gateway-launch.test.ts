import { afterEach, describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import { resolveOptions } from "@flynncode/mobile-gateway"
import { createSyncGate } from "@flynncode/mobile-gateway/sync-gate"
import {
  MOBILE_GATEWAY_PORT,
  mobileGatewayEnv,
  mobileGatewayUpstream,
  startMobileGateway,
  type MobileGatewayHandle,
} from "./mobile-gateway-launch"

describe("mobileGatewayUpstream", () => {
  test("builds upstream from sidecar host and port", () => {
    expect(mobileGatewayUpstream("127.0.0.1", 51234)).toBe("http://127.0.0.1:51234")
  })
})

describe("mobileGatewayEnv", () => {
  test("maps passwords, port, and relay token to gateway env", () => {
    expect(
      mobileGatewayEnv({ serverPassword: "upstream", phonePassword: "phone", port: 4097, relayToken: "relay" }),
    ).toEqual({
      OPENCODE_SERVER_PASSWORD: "upstream",
      OPENCODE_MOBILE_PASSWORD: "phone",
      OPENCODE_MOBILE_PORT: "4097",
      OPENCODE_RELAY_TOKEN: "relay",
    })
  })

  test("passes the bind host through when set", () => {
    expect(
      mobileGatewayEnv({
        serverPassword: "upstream",
        phonePassword: "phone",
        port: 4097,
        relayToken: "relay",
        host: "127.0.0.1",
      }).OPENCODE_MOBILE_HOST,
    ).toBe("127.0.0.1")
  })

  test("resolves the relay token into gateway options", () => {
    const resolved = resolveOptions(
      mobileGatewayEnv({ serverPassword: "upstream", phonePassword: "phone", port: 4097, relayToken: "relay" }),
    )
    expect(resolved.ok && resolved.value.relayToken).toBe("relay")
  })
})

describe("startMobileGateway", () => {
  const handles: MobileGatewayHandle[] = []
  afterEach(() => {
    while (handles.length) handles.pop()?.stop()
  })

  test("starts a gateway on an ephemeral port and serves status", async () => {
    expect(MOBILE_GATEWAY_PORT).toBe(4097)
    const handle = await startMobileGateway({
      serverPassword: "upstream-secret",
      phonePassword: "phone-secret",
      port: 0,
      upstream: "http://127.0.0.1:9",
      relayToken: "",
    })
    expect(handle).toBeDefined()
    if (!handle) return
    handles.push(handle)
    const response = await fetch(`http://127.0.0.1:${handle.port}/flynncode-mobile-status`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { launcherUrls: unknown }
    expect(Array.isArray(body.launcherUrls)).toBe(true)
  })

  test("resolves undefined when the port is occupied", async () => {
    const blocker = createServer((_req, res) => res.end())
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve))
    try {
      const address = blocker.address()
      const occupiedPort = typeof address === "object" && address ? address.port : 0
      expect(occupiedPort).toBeGreaterThan(0)
      const handle = await startMobileGateway({
        serverPassword: "upstream-secret",
        phonePassword: "phone-secret",
        port: occupiedPort,
        upstream: "http://127.0.0.1:9",
        relayToken: "",
      })
      expect(handle).toBeUndefined()
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  test("resolves undefined when disabled by empty server password", async () => {
    const handle = await startMobileGateway({
      serverPassword: "",
      phonePassword: "phone-secret",
      port: 0,
      upstream: "http://127.0.0.1:9",
      relayToken: "",
    })
    expect(handle).toBeUndefined()
  })

  test("reports why the gateway did not start when another one without sync holds the port", async () => {
    const plain = await startMobileGateway({
      serverPassword: "upstream-secret",
      phonePassword: "phone-secret",
      port: 0,
      upstream: "http://127.0.0.1:9",
      relayToken: "",
    })
    if (!plain) throw new Error("plain gateway did not start")
    handles.push(plain)
    const sync = createSyncGate({
      machineName: "challenger",
      gatewayPort: 4097,
      phoneAccess: false,
      paused: false,
      peer: undefined,
      prefs: undefined,
    })
    const errors: string[] = []
    const handle = await startMobileGateway({
      serverPassword: "upstream-secret",
      phonePassword: "phone-secret",
      port: 0,
      upstream: "http://127.0.0.1:9",
      relayToken: "",
      sync,
      onError: (message) => errors.push(message),
    })
    expect(handle).toBeUndefined()
    expect(errors).toEqual(["the LAN gateway is already running without machine sync"])
  })

  test("passes the sync gate through: phone routes 404 while sync stays token-gated", async () => {
    const sync = createSyncGate({
      machineName: "challenger",
      gatewayPort: 4097,
      phoneAccess: false,
      paused: false,
      peer: undefined,
      prefs: undefined,
    })
    const handle = await startMobileGateway({
      serverPassword: "upstream-secret",
      phonePassword: "phone-secret",
      port: 0,
      upstream: "http://127.0.0.1:9",
      relayToken: "",
      sync,
    })
    expect(handle).toBeDefined()
    if (!handle) return
    handles.push(handle)
    expect((await fetch(`http://127.0.0.1:${handle.port}/flynncode-mobile-status`)).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${handle.port}/flynncode-sync/manifest`)).status).toBe(401)
    sync.update({ phoneAccess: true })
    expect((await fetch(`http://127.0.0.1:${handle.port}/flynncode-mobile-status`)).status).toBe(200)
  })
})
