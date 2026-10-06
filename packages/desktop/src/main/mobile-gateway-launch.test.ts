import { afterEach, describe, expect, test } from "bun:test"
import { createServer } from "node:http"
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
  test("maps passwords and port to gateway env", () => {
    expect(mobileGatewayEnv({ serverPassword: "upstream", phonePassword: "phone", port: 4097 })).toEqual({
      OPENCODE_SERVER_PASSWORD: "upstream",
      OPENCODE_MOBILE_PASSWORD: "phone",
      OPENCODE_MOBILE_PORT: "4097",
    })
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
    })
    expect(handle).toBeUndefined()
  })
})
