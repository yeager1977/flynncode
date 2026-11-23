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
  // The static lineup is what OAuth users see whenever live discovery cannot run, so a
  // model missing here is hidden from the picker even though the catalog has it.
  it("keeps every current Claude model in the static lineup", () => {
    const ids = [
      "claude-fable-5",
      "claude-fable-5-1",
      "claude-fable-5-2",
      "claude-sonnet-5",
      "claude-sonnet-5-5",
      "claude-opus-5",
      "claude-opus-5-5",
      "claude-haiku-5-5",
    ]
    const models = Object.fromEntries(ids.map((id) => [id, { api: { id } }]))
    expect(Object.keys(filterSubscriptionModels(models, true))).toEqual(ids)
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

type BrowserMethod = {
  authorize: () => Promise<{ url: string; callback: () => Promise<{ type: string; access?: string; refresh?: string }> }>
}

// Anthropic rejected the old `http://localhost:1456/auth/callback` redirect with "Redirect URI ... is not
// supported by client". Claude Code 2.1.321 (same client id) listens on a random loopback port and
// redirects to `/callback`; these pin that shape.
describe("subscription browser sign-in", () => {
  it("redirects to a loopback /callback like Claude Code and exchanges the code against the same redirect", async () => {
    const bodies: Record<string, string>[] = []
    const agents: string[] = []
    const stub = createServer((req, res) => {
      agents.push(String(req.headers["user-agent"]))
      let raw = ""
      req.on("data", (chunk) => (raw += chunk))
      req.on("end", () => {
        bodies.push(JSON.parse(raw))
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ access_token: "acc", refresh_token: "ref", expires_in: 3600 }))
      })
    })
    await new Promise<void>((resolve) => stub.listen(0, resolve))
    try {
      const hooks = await AnthropicSubscriptionPlugin({} as never, {
        tokenEndpoint: `http://127.0.0.1:${(stub.address() as AddressInfo).port}/v1/oauth/token`,
      })
      const flow = await (hooks.auth!.methods[0] as unknown as BrowserMethod).authorize()
      const url = new URL(flow.url)
      expect(`${url.origin}${url.pathname}`).toBe("https://claude.com/cai/oauth/authorize")
      expect(url.searchParams.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e")
      expect(url.searchParams.get("code")).toBe("true")
      expect(url.searchParams.get("response_type")).toBe("code")
      expect(url.searchParams.get("code_challenge_method")).toBe("S256")
      const redirect = new URL(url.searchParams.get("redirect_uri")!)
      expect(redirect.hostname).toBe("localhost")
      expect(redirect.pathname).toBe("/callback")

      const done = flow.callback()
      const state = url.searchParams.get("state")!
      const reply = await fetch(`http://127.0.0.1:${redirect.port}/callback?code=the-code&state=${encodeURIComponent(state)}`)
      expect(reply.status).toBe(200)
      expect(await done).toMatchObject({ type: "success", access: "acc", refresh: "ref" })
      expect(bodies[0]).toMatchObject({
        grant_type: "authorization_code",
        code: "the-code",
        redirect_uri: url.searchParams.get("redirect_uri"),
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        state,
      })
      expect(bodies[0].code_verifier).toBeTruthy()
      // Anthropic rate-limits (HTTP 429) token requests that send a `claude-code/<version>` User-Agent.
      expect(agents[0]).not.toMatch(/claude-code/i)
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()))
    }
  })

  it("does not answer on the old /auth/callback path", async () => {
    const hooks = await AnthropicSubscriptionPlugin({} as never)
    const flow = await (hooks.auth!.methods[0] as unknown as BrowserMethod).authorize()
    const url = new URL(flow.url)
    const redirect = new URL(url.searchParams.get("redirect_uri")!)
    const done = flow.callback().catch((error: unknown) => error)
    const old = await fetch(`http://127.0.0.1:${redirect.port}/auth/callback?error=access_denied`)
    expect(old.status).toBe(404)
    // End the attempt so the loopback listener closes.
    await fetch(`http://127.0.0.1:${redirect.port}/callback?error=access_denied`)
    expect(String(await done)).toContain("access_denied")
  })
})

describe("subscription token endpoints and live model list", () => {
  // The plugin delegates to the ambient fetch, so replacing it is the only way to see which URLs it calls.
  async function withFetch<T>(handler: (url: string, init?: RequestInit) => Response, run: () => Promise<T>) {
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(input instanceof Request ? input.url : String(input), init)) as typeof fetch
    try {
      return await run()
    } finally {
      globalThis.fetch = original
    }
  }

  it("refreshes against platform.claude.com by default", async () => {
    const hooks = await AnthropicSubscriptionPlugin({ client: { auth: { set: async () => {} } } } as never)
    const wrapper = await hooks.auth?.loader!(
      (async () => ({ type: "oauth", access: "old", refresh: "r", expires: Date.now() - 1000 })) as never,
      undefined as never,
    )
    const urls: string[] = []
    await withFetch(
      (url) => {
        urls.push(url)
        return url.includes("/oauth/token") ? Response.json({ access_token: "new", expires_in: 3600 }) : new Response("{}")
      },
      () => wrapper!.fetch("https://api.anthropic.com/v1/messages", { body: "{}" }),
    )
    expect(urls[0]).toBe("https://platform.claude.com/v1/oauth/token")
  })

  it("refreshes an expired token so the live model list is used instead of the static fallback", async () => {
    const stored: unknown[] = []
    const hooks = await AnthropicSubscriptionPlugin({
      client: { auth: { set: async (arg: unknown) => void stored.push(arg) } },
    } as never)
    const provider = {
      models: {
        "claude-fable-5-9": { api: { id: "claude-fable-5-9" } },
        "claude-sonnet-5": { api: { id: "claude-sonnet-5" } },
      },
    }
    const bearer: string[] = []
    const result = await withFetch(
      (url, init) => {
        if (url.includes("/oauth/token")) return Response.json({ access_token: "fresh", refresh_token: "r2", expires_in: 3600 })
        bearer.push(new Headers(init?.headers).get("authorization") ?? "")
        return Response.json({ data: [{ id: "claude-fable-5-9" }] })
      },
      () =>
        hooks.provider!.models!(provider as never, {
          auth: { type: "oauth", access: "stale", refresh: "r", expires: Date.now() - 1000 },
        } as never),
    )
    expect(Object.keys(result)).toEqual(["claude-fable-5-9"])
    expect(bearer).toEqual(["Bearer fresh"])
    expect(stored).toHaveLength(1)
  })

  it("does not retry a failed refresh on every provider rebuild", async () => {
    const hooks = await AnthropicSubscriptionPlugin({ client: { auth: { set: async () => {} } } } as never)
    const provider = { models: { "claude-sonnet-5": { api: { id: "claude-sonnet-5" } } } }
    const ctx = { auth: { type: "oauth", access: "stale", refresh: "revoked", expires: Date.now() - 1000 } } as never
    let tokenCalls = 0
    const results = await withFetch(
      (url) => {
        if (!url.includes("/oauth/token")) return new Response("{}", { status: 500 })
        tokenCalls++
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
      },
      async () => [await hooks.provider!.models!(provider as never, ctx), await hooks.provider!.models!(provider as never, ctx)],
    )
    expect(tokenCalls).toBe(1)
    // Falls back to the static lineup rather than failing the provider rebuild.
    expect(results.map((models) => Object.keys(models))).toEqual([["claude-sonnet-5"], ["claude-sonnet-5"]])
  })
})

describe("subscription token refresh", () => {
  // platform.claude.com answers HTTP 429 "Rate limited" to any token request whose User-Agent is
  // `claude-code/<version>` (2026-11-23: sign-in "token exchange failed"); other agents get the normal 400.
  it("exchanges refresh token against a stub endpoint without a claude-code user agent", async () => {
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
      expect(seen[0]).not.toMatch(/claude-code/i)
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
      // The status is what tells a refused grant (400/401) from a throttle (429) in the server log.
      expect(String(error)).toContain("(401)")
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
