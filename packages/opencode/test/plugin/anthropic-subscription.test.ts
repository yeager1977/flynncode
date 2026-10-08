import { describe, expect, it } from "bun:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import {
  AnthropicSubscriptionPlugin,
  filterSubscriptionModels,
  parseJwtLike,
  refreshSubscriptionToken,
} from "../../src/plugin/anthropic/subscription"

function createTestJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

describe("subscription helpers", () => {
  it("filters to subscription-served models on oauth", () => {
    const models = {
      "claude-sonnet-5": { api: { id: "claude-sonnet-5" } },
      "some-other": { api: { id: "some-other" } },
    }
    expect(Object.keys(filterSubscriptionModels(models, true))).toContain("claude-sonnet-5")
    expect(Object.keys(filterSubscriptionModels(models, true))).not.toContain("some-other")
  })
  it("passes all models through on api key", () => {
    const models = {
      "claude-sonnet-5": { api: { id: "claude-sonnet-5" } },
      "some-other": { api: { id: "some-other" } },
    }
    expect(Object.keys(filterSubscriptionModels(models, false))).toHaveLength(2)
  })
  it("rejects malformed token parts", () => {
    expect(parseJwtLike("not-a-jwt")).toBeUndefined()
  })
  it("parses jwt payload", () => {
    expect(parseJwtLike(createTestJwt({ sub: "user-1" }))).toMatchObject({ sub: "user-1" })
  })
})

describe("subscription plugin shape", () => {
  it("registers anthropic auth with browser, import, and api methods", async () => {
    const hooks = await AnthropicSubscriptionPlugin({} as never)
    expect(hooks.auth?.provider).toBe("anthropic")
    expect(hooks.auth?.methods.map((method) => method.label)).toEqual([
      "Claude Pro/Max (browser)",
      "Import from Claude Code",
      "Manually enter API Key",
    ])
  })
})

describe("subscription token refresh", () => {
  it("exchanges refresh token against a stub endpoint", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ access_token: "stub-access", expires_in: 3600 }))
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    try {
      const port = (server.address() as AddressInfo).port
      const tokens = await refreshSubscriptionToken("stub-refresh", {
        tokenEndpoint: `http://localhost:${port}/v1/oauth/token`,
        clientId: "stub-client",
      })
      expect(tokens.access_token).toBe("stub-access")
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  it("fails without leaking the refresh token", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "invalid_grant" }))
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    try {
      const port = (server.address() as AddressInfo).port
      const error = await refreshSubscriptionToken("secret-refresh-value", {
        tokenEndpoint: `http://localhost:${port}/v1/oauth/token`,
        clientId: "stub-client",
      }).then(
        () => undefined,
        (err: unknown) => err,
      )
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).not.toContain("secret-refresh-value")
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
