import { describe, expect, it } from "bun:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import {
  AnthropicSubscriptionPlugin,
  fetchSubscriptionModelIDs,
  filterSubscriptionModels,
  oauthState,
  refreshSubscriptionToken,
  waitForOAuthCallback,
} from "../../src/plugin/anthropic/subscription"
import { jwtExpiry, parseCodexAuth } from "../../src/auth/vendor-import"

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
  it("falls back to the static lineup, which includes sonnet-5-5", () => {
    const models = {
      "claude-sonnet-5-5": { api: { id: "claude-sonnet-5-5" } },
      "some-other": { api: { id: "some-other" } },
    }
    expect(Object.keys(filterSubscriptionModels(models, true))).toContain("claude-sonnet-5-5")
    expect(Object.keys(filterSubscriptionModels(models, true))).not.toContain("some-other")
  })
  it("filters against a discovered set when provided", () => {
    const models = {
      "claude-sonnet-5-5": { api: { id: "claude-sonnet-5-5" } },
      "claude-sonnet-5": { api: { id: "claude-sonnet-5" } },
    }
    expect(Object.keys(filterSubscriptionModels(models, true, new Set(["claude-sonnet-5-5"])))).toEqual([
      "claude-sonnet-5-5",
    ])
  })
  it("reads a JWT's exp claim and rejects malformed tokens", () => {
    expect(jwtExpiry("not-a-jwt")).toBeUndefined()
    expect(jwtExpiry(createTestJwt({ sub: "user-1" }))).toBeUndefined()
    expect(jwtExpiry(createTestJwt({ exp: 1_800_000_000 }))).toBe(1_800_000_000_000)
  })
  it("imports Codex credentials with the access token's own expiry", () => {
    const access = createTestJwt({ exp: 1_700_000_000 })
    const imported = parseCodexAuth({ tokens: { access_token: access, refresh_token: "r" } })
    expect(imported).toMatchObject({ kind: "oauth", expires: 1_700_000_000_000 })
  })
})

describe("subscription model discovery", () => {
  it("collects accessible ids across pages", async () => {
    const pages = [
      { data: [{ id: "claude-sonnet-5-5" }, { id: "claude-opus-5-5" }], has_more: true, last_id: "claude-opus-5-5" },
      { data: [{ id: "claude-haiku-5-5" }], has_more: false },
    ]
    const urls: string[] = []
    const fetchImpl = (async (url: unknown) => {
      urls.push(String(url))
      return new Response(JSON.stringify(pages.shift()), { status: 200 })
    }) as typeof fetch
    const ids = await fetchSubscriptionModelIDs({ fetchImpl, token: "t", apiBaseUrl: "https://example.test" })
    expect([...ids!].sort()).toEqual(["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"])
    expect(urls).toEqual([
      "https://example.test/v1/models?limit=1000",
      "https://example.test/v1/models?limit=1000&after_id=claude-opus-5-5",
    ])
  })

  it("returns undefined when discovery fails so callers fall back", async () => {
    const denied = (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch
    expect(await fetchSubscriptionModelIDs({ fetchImpl: denied, token: "t" })).toBeUndefined()
    const boom = (async () => {
      throw new Error("network")
    }) as unknown as typeof fetch
    expect(await fetchSubscriptionModelIDs({ fetchImpl: boom, token: "t" })).toBeUndefined()
    const empty = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch
    expect(await fetchSubscriptionModelIDs({ fetchImpl: empty, token: "t" })).toBeUndefined()
    const badShape = (async () =>
      new Response(JSON.stringify({ nope: true }), { status: 200 })) as unknown as typeof fetch
    expect(await fetchSubscriptionModelIDs({ fetchImpl: badShape, token: "t" })).toBeUndefined()
  })
})

describe("subscription oauth attempts", () => {
  const pkce = { verifier: "v", challenge: "c" }

  it("an abandoned attempt's timeout does not clear a newer pending attempt", async () => {
    const abandoned = waitForOAuthCallback(pkce, "old", {}, 20)
    const newer = waitForOAuthCallback(pkce, "new", {}, 60_000)
    newer.catch(() => {})
    await expect(abandoned).rejects.toThrow("superseded")
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(oauthState().pending).toBe(true)
    // Supersede the long-lived attempt with one that times out immediately.
    await waitForOAuthCallback(pkce, "cleanup", {}, 1).catch(() => {})
    expect(oauthState().pending).toBe(false)
  })

  it("an attempt's own timeout clears it", async () => {
    const attempt = waitForOAuthCallback(pkce, "solo", {}, 10)
    await expect(attempt).rejects.toThrow("timeout")
    expect(oauthState().pending).toBe(false)
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
