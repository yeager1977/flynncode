import { describe, expect, it } from "bun:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import {
  AnthropicSubscriptionPlugin,
  fetchAnthropicUsage,
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

  it("maps usage buckets to windows and ignores internal codename buckets", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          five_hour: { utilization: 42.5, resets_at: "2026-10-15T05:00:00+00:00" },
          seven_day: { utilization: 10, resets_at: null },
          seven_day_sonnet: null,
          iguana_necktie: { utilization: 87, resets_at: "2026-11-05T07:59:00+00:00" },
        }),
        { status: 200 },
      )) as unknown as typeof fetch
    const usage = await fetchAnthropicUsage({ fetchImpl, token: "t", apiBaseUrl: "https://example.test" })
    expect(usage).toEqual({
      windows: [
        { id: "session", percent: 42.5, resetsAt: Date.parse("2026-10-15T05:00:00+00:00") },
        { id: "weekly", percent: 10 },
      ],
    })
  })

  it("returns undefined for usage when the endpoint fails or has no windows", async () => {
    const denied = (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch
    expect(await fetchAnthropicUsage({ fetchImpl: denied, token: "t" })).toBeUndefined()
    const empty = (async () =>
      new Response(JSON.stringify({ seven_day: null }), { status: 200 })) as unknown as typeof fetch
    expect(await fetchAnthropicUsage({ fetchImpl: empty, token: "t" })).toBeUndefined()
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

  // Anthropic reads the client version from a billing header carried as the
  // first system block; without it the request is served as the legacy floor
  // ("Claude Code 2.1.280") and newer models are refused.
  it("identifies the subscription client and bearer-auths its fetch wrapper", async () => {
    const hooks = await AnthropicSubscriptionPlugin({} as never)
    const getAuth = async () => ({
      type: "oauth",
      access: "tok",
      refresh: "r",
      expires: Date.now() + 60_000,
    })
    const wrapper = await hooks.auth?.loader!(getAuth as never, undefined as never)
    // The wrapper delegates to the ambient fetch; this is the only way to
    // observe the headers and body it rewrites.
    const original = globalThis.fetch
    const seen: { headers: Headers; body: unknown }[] = []
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push({ headers: new Headers(init?.headers), body: init?.body })
      return new Response("{}", { status: 200 })
    }) as typeof fetch
    try {
      await wrapper?.fetch("https://api.anthropic.com/v1/messages", {
        headers: { "User-Agent": "opencode/1.18.34", "x-api-key": "dummy" },
        body: JSON.stringify({ model: "claude-fable-5-2", system: "You are Flynncode." }),
      })
    } finally {
      globalThis.fetch = original
    }
    const request = seen[0]
    expect(request).toBeDefined()
    expect(request!.headers.get("user-agent")).toMatch(/^claude-code\/\d+\.\d+\.\d+/)
    expect(request!.headers.get("authorization")).toBe("Bearer tok")
    expect(request!.headers.get("anthropic-beta")).toContain("oauth-2025-04-20")
    expect(request!.headers.get("x-api-key")).toBeNull()
    const body = JSON.parse(String(request!.body)) as { system: string }
    expect(body.system).toMatch(/^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+; cc_entrypoint=cli;/)
    expect(body.system).toContain("You are Flynncode.")
  })
})

describe("subscription token refresh", () => {
  it("exchanges refresh token against a stub endpoint and presents the client identity", async () => {
    const seen: string[] = []
    const server = createServer((req, res) => {
      seen.push(String(req.headers["user-agent"]))
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
      expect(seen[0]).toMatch(/^claude-code\/\d+\.\d+\.\d+/)
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
