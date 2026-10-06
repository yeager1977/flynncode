import { afterEach, describe, expect, test } from "bun:test"
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
})
