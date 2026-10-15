import type { Hooks, PluginInput, ProviderUsage } from "@flynncode/plugin"
import { OauthCallbackPage } from "@flynncode/core/oauth/page"
import { OAUTH_DUMMY_KEY } from "../../auth"
import { parseClaudeCredentials } from "../../auth/vendor-import"
import { Filesystem } from "../../util/filesystem"
import os from "os"
import path from "path"
import { createServer } from "http"

// Observed from Claude Code's public OAuth registration: authorization lives
// on claude.ai while token exchange lives on console.anthropic.com. Both are
// overridable so tests can point at a local stub listener.
const AUTHORIZE_ISSUER = "https://claude.ai"
const TOKEN_ISSUER = "https://console.anthropic.com"
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const OAUTH_PORT = 1456

export interface AnthropicSubscriptionOptions {
  authorizeIssuer?: string
  tokenIssuer?: string
  clientId?: string
  tokenEndpoint?: string
  // Base URL for live subscription model discovery (GET /v1/models).
  apiBaseUrl?: string
}

interface PkceCodes {
  verifier: string
  challenge: string
}

async function generatePKCE(): Promise<PkceCodes> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(43)))
    .map((b) => chars[b % chars.length])
    .join("")
  const challenge = base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// Subscription OAuth only serves the Claude Pro/Max lineup; API keys keep the
// full provider catalog. The servable set is discovered live from Anthropic's
// /v1/models endpoint (see fetchSubscriptionModelIDs); this static set is the
// fallback when discovery fails, so keep it to the current lineup only.
const SUBSCRIPTION_MODELS = new Set([
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-sonnet-5",
  "claude-sonnet-5-5",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-haiku-5-5",
])

export function filterSubscriptionModels<Model extends { api: { id: string } }>(
  models: Record<string, Model>,
  isOAuth: boolean,
  accessible: ReadonlySet<string> = SUBSCRIPTION_MODELS,
): Record<string, Model> {
  if (!isOAuth) return models
  return Object.fromEntries(Object.entries(models).filter(([, model]) => accessible.has(model.api.id)))
}

const MODELS_API_BASE_URL = "https://api.anthropic.com"
// A failed discovery must never stall provider state resolution; the static
// fallback covers transient errors.
const MODELS_FETCH_TIMEOUT_MS = 5_000
const MODELS_CACHE_TTL_MS = 5 * 60_000

/**
 * Fetch the model ids the given OAuth token can actually use. Returns
 * undefined on any failure (network, auth, unexpected shape) so callers fall
 * back to the static lineup.
 */
export async function fetchSubscriptionModelIDs(input: {
  fetchImpl: typeof fetch
  token: string
  apiBaseUrl?: string
}): Promise<ReadonlySet<string> | undefined> {
  const base = (input.apiBaseUrl ?? MODELS_API_BASE_URL).replace(/\/+$/, "")
  const ids = new Set<string>()
  let url: string | undefined = `${base}/v1/models?limit=1000`
  // Cap pagination so a misbehaving endpoint cannot loop forever.
  for (let page = 0; url && page < 5; page++) {
    const res = await input
      .fetchImpl(url, {
        method: "GET",
        signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${input.token}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
        },
      })
      .catch(() => undefined)
    if (!res || !res.ok) return undefined
    const body = (await res.json().catch(() => undefined)) as
      | { data?: Array<{ id?: unknown }>; has_more?: unknown; last_id?: unknown }
      | undefined
    if (!body || !Array.isArray(body.data)) return undefined
    for (const entry of body.data) {
      if (typeof entry.id === "string") ids.add(entry.id)
    }
    url =
      body.has_more === true && typeof body.last_id === "string"
        ? `${base}/v1/models?limit=1000&after_id=${encodeURIComponent(body.last_id)}`
        : undefined
  }
  return ids.size > 0 ? ids : undefined
}

let discovered: { ids: ReadonlySet<string>; expires: number } | undefined

// Provider state (and thus the models hook) rebuilds on a short TTL; align
// discovery caching with it so one list fetch serves a burst of rebuilds.
async function discoverSubscriptionModelIDs(input: {
  fetchImpl: typeof fetch
  token: string
  apiBaseUrl?: string
}): Promise<ReadonlySet<string> | undefined> {
  if (discovered && Date.now() < discovered.expires) return discovered.ids
  const ids = await fetchSubscriptionModelIDs(input)
  if (ids) discovered = { ids, expires: Date.now() + MODELS_CACHE_TTL_MS }
  return ids
}

/**
 * Fetch subscription usage windows from Anthropic's OAuth usage endpoint.
 * Returns undefined on any failure so callers can omit meters for this
 * provider instead of rendering stale or made-up numbers.
 */
export async function fetchAnthropicUsage(input: {
  fetchImpl: typeof fetch
  token: string
  apiBaseUrl?: string
}): Promise<ProviderUsage | undefined> {
  const base = (input.apiBaseUrl ?? MODELS_API_BASE_URL).replace(/\/+$/, "")
  const res = await input
    .fetchImpl(`${base}/api/oauth/usage`, {
      method: "GET",
      signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${input.token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
    })
    .catch(() => undefined)
  if (!res || !res.ok) return undefined
  const body = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined
  if (!body) return undefined
  // Only surface the named product windows; the response also carries
  // internal codename buckets that mean nothing in a UI.
  const named: Array<[string, string]> = [
    ["session", "five_hour"],
    ["weekly", "seven_day"],
    ["weekly-sonnet", "seven_day_sonnet"],
    ["weekly-opus", "seven_day_opus"],
  ]
  const windows = named.flatMap(([id, key]) => {
    const value = body[key]
    if (typeof value !== "object" || value === null) return []
    const record = value as Record<string, unknown>
    const percent = record.utilization
    if (typeof percent !== "number" || !Number.isFinite(percent)) return []
    const resetsAt = typeof record.resets_at === "string" ? Date.parse(record.resets_at) : Number.NaN
    return [{ id, percent, ...(Number.isFinite(resetsAt) ? { resetsAt } : {}) }]
  })
  if (windows.length === 0) return undefined
  return { windows }
}

interface RefreshResult {
  access_token: string
  expires_in?: number
  refresh_token?: string
}

export async function refreshSubscriptionToken(
  refreshToken: string,
  input: { tokenEndpoint: string; clientId: string },
): Promise<RefreshResult> {
  const response = await fetch(input.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: input.clientId }),
  })
  if (!response.ok) throw new Error("Anthropic subscription token refresh failed")
  return response.json()
}

function tokenEndpointFor(options: AnthropicSubscriptionOptions): string {
  if (options.tokenEndpoint) return options.tokenEndpoint
  return `${options.tokenIssuer ?? TOKEN_ISSUER}/v1/oauth/token`
}

async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  pkce: PkceCodes,
  options: AnthropicSubscriptionOptions,
): Promise<RefreshResult> {
  const response = await fetch(tokenEndpointFor(options), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: options.clientId ?? CLIENT_ID,
      code_verifier: pkce.verifier,
    }),
  })
  if (!response.ok) throw new Error("Anthropic subscription token exchange failed")
  return response.json()
}

interface TokenResponse extends RefreshResult {}

interface PendingOAuth {
  pkce: PkceCodes
  state: string
  options: AnthropicSubscriptionOptions
  resolve: (tokens: TokenResponse) => void
  reject: (error: Error) => void
}

let oauthServer: ReturnType<typeof createServer> | undefined
let pendingOAuth: PendingOAuth | undefined

async function startOAuthServer(): Promise<{ redirectUri: string }> {
  if (oauthServer) return { redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
  oauthServer = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${OAUTH_PORT}`)
    if (url.pathname === "/auth/callback") {
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      const error = url.searchParams.get("error")
      if (error) {
        pendingOAuth?.reject(new Error(url.searchParams.get("error_description") || error))
        pendingOAuth = undefined
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        res.end(OauthCallbackPage.error(error, { provider: "Anthropic" }))
        return
      }
      if (!code) {
        pendingOAuth?.reject(new Error("Missing authorization code"))
        pendingOAuth = undefined
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
        res.end(OauthCallbackPage.error("Missing authorization code", { provider: "Anthropic" }))
        return
      }
      if (!pendingOAuth || state !== pendingOAuth.state) {
        pendingOAuth?.reject(new Error("Invalid state - potential CSRF attack"))
        pendingOAuth = undefined
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
        res.end(OauthCallbackPage.error("Invalid state", { provider: "Anthropic" }))
        return
      }
      const current = pendingOAuth
      pendingOAuth = undefined
      exchangeCodeForTokens(code, `http://localhost:${OAUTH_PORT}/auth/callback`, current.pkce, current.options)
        .then((tokens) => current.resolve(tokens))
        .catch((err) => current.reject(err))
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(OauthCallbackPage.success({ provider: "Anthropic" }))
      return
    }
    res.writeHead(404)
    res.end("Not found")
  })
  const server = oauthServer
  // Loopback only: the callback carries an authorization code.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(OAUTH_PORT, "127.0.0.1", () => resolve())
  }).catch((error) => {
    // A failed listen (port in use) must not leave a dead server cached.
    if (oauthServer === server) oauthServer = undefined
    throw error
  })
  return { redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
}

// Keeps the server up while another attempt is still waiting on it, so a
// superseded attempt settling cannot strand the newer one.
function stopOAuthServer() {
  if (!oauthServer || pendingOAuth) return
  oauthServer.close(() => {})
  oauthServer = undefined
}

export function waitForOAuthCallback(
  pkce: PkceCodes,
  state: string,
  options: AnthropicSubscriptionOptions,
  timeoutMs = 5 * 60 * 1000,
): Promise<TokenResponse> {
  // A newer attempt supersedes an abandoned one instead of leaving it hanging.
  pendingOAuth?.reject(new Error("OAuth authorization superseded by a newer attempt"))
  return new Promise((resolve, reject) => {
    const attempt: PendingOAuth = {
      pkce,
      state,
      options,
      resolve: (tokens) => {
        clearTimeout(timeout)
        resolve(tokens)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    }
    // Only this attempt's own timeout may clear it; an abandoned attempt's
    // timer must not cancel a newer pending attempt or stop its server.
    const timeout = setTimeout(() => {
      if (pendingOAuth !== attempt) return
      pendingOAuth = undefined
      stopOAuthServer()
      reject(new Error("OAuth callback timeout - authorization took too long"))
    }, timeoutMs)
    pendingOAuth = attempt
  })
}

/** Test-only view of the pending authorization state. */
export function oauthState() {
  return { pending: pendingOAuth !== undefined, listening: oauthServer !== undefined }
}

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string, options: AnthropicSubscriptionOptions): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId ?? CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "org:create_api_key user:profile user:inference",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state,
  })
  return `${options.authorizeIssuer ?? AUTHORIZE_ISSUER}/oauth/authorize?${params.toString()}`
}

export async function AnthropicSubscriptionPlugin(
  input: PluginInput,
  options: AnthropicSubscriptionOptions = {},
): Promise<Hooks> {
  return {
    provider: {
      id: "anthropic",
      async models(provider, ctx) {
        const auth = ctx.auth
        if (auth?.type !== "oauth") return provider.models
        // The stored access token may be stale at state-build time; only
        // attempt discovery with a live one and fall back to the static
        // lineup otherwise (the loader refreshes on first request anyway).
        if (auth.access && auth.expires > Date.now()) {
          const ids = await discoverSubscriptionModelIDs({
            fetchImpl: fetch,
            token: auth.access,
            apiBaseUrl: options.apiBaseUrl,
          })
          if (ids) return filterSubscriptionModels(provider.models, true, ids)
        }
        return filterSubscriptionModels(provider.models, true)
      },
    },
    auth: {
      provider: "anthropic",
      async usage(getAuth): Promise<ProviderUsage | undefined> {
        const auth = await getAuth()
        if (auth.type !== "oauth") return undefined
        if (auth.access && auth.expires > Date.now()) {
          return fetchAnthropicUsage({ fetchImpl: fetch, token: auth.access, apiBaseUrl: options.apiBaseUrl })
        }
        // Usage is display-only, but an expired token would hide the meters
        // indefinitely; refresh and persist it the same way the loader does.
        const tokens = await refreshSubscriptionToken(auth.refresh, {
          tokenEndpoint: tokenEndpointFor(options),
          clientId: options.clientId ?? CLIENT_ID,
        }).catch(() => undefined)
        if (!tokens) return undefined
        await input.client.auth.set({
          path: { id: "anthropic" },
          body: {
            type: "oauth",
            refresh: tokens.refresh_token ?? auth.refresh,
            access: tokens.access_token,
            expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
          },
        })
        return fetchAnthropicUsage({ fetchImpl: fetch, token: tokens.access_token, apiBaseUrl: options.apiBaseUrl })
      },
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}
        let refreshPromise: Promise<{ access: string }> | undefined
        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization")
                init.headers.delete("x-api-key")
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(
                  ([key]) => key.toLowerCase() !== "authorization" && key.toLowerCase() !== "x-api-key",
                )
              } else {
                delete init.headers["authorization"]
                delete init.headers["Authorization"]
                delete init.headers["x-api-key"]
              }
            }
            const currentAuth = await getAuth()
            if (currentAuth.type !== "oauth") return fetch(requestInput, init)
            if (!currentAuth.access || currentAuth.expires < Date.now()) {
              if (!refreshPromise) {
                refreshPromise = refreshSubscriptionToken(currentAuth.refresh, {
                  tokenEndpoint: tokenEndpointFor(options),
                  clientId: options.clientId ?? CLIENT_ID,
                })
                  .then(async (tokens) => {
                    await input.client.auth.set({
                      path: { id: "anthropic" },
                      body: {
                        type: "oauth",
                        refresh: tokens.refresh_token ?? currentAuth.refresh,
                        access: tokens.access_token,
                        expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                      },
                    })
                    return { access: tokens.access_token }
                  })
                  .finally(() => {
                    refreshPromise = undefined
                  })
              }
              const refreshed = await refreshPromise
              currentAuth.access = refreshed.access
            }
            const headers = new Headers(init?.headers)
            headers.set("authorization", `Bearer ${currentAuth.access}`)
            headers.set("anthropic-beta", "oauth-2025-04-20")
            return fetch(requestInput, { ...init, headers })
          },
        }
      },
      methods: [
        {
          label: "Claude Pro/Max (browser)",
          type: "oauth",
          authorize: async () => {
            const { redirectUri } = await startOAuthServer()
            const pkce = await generatePKCE()
            const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
            const callbackPromise = waitForOAuthCallback(pkce, state, options)
            // An abandoned attempt (callback never awaited) still rejects on
            // timeout or supersession; keep that from surfacing as unhandled.
            callbackPromise.catch(() => {})
            return {
              url: buildAuthorizeUrl(redirectUri, pkce, state, options),
              instructions: "Complete authorization in your browser. This window will close automatically.",
              method: "auto" as const,
              callback: async () => {
                // Stop the loopback server whether the attempt succeeds or fails.
                const tokens = await callbackPromise.finally(stopOAuthServer)
                return {
                  type: "success" as const,
                  refresh: tokens.refresh_token ?? "",
                  access: tokens.access_token,
                  expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                }
              },
            }
          },
        },
        {
          label: "Import from Claude Code",
          type: "oauth",
          authorize: async () => {
            const raw = await Filesystem.readJson(path.join(os.homedir(), ".claude", ".credentials.json")).catch(
              () => undefined,
            )
            const imported = parseClaudeCredentials(raw)
            if (!imported || imported.kind !== "oauth") throw new Error("No Claude Code credentials found")
            return {
              url: "http://localhost/imported",
              instructions: "Imported Claude Code credentials from this machine.",
              method: "auto" as const,
              callback: async () => ({
                type: "success" as const,
                refresh: imported.refresh,
                access: imported.access,
                expires: imported.expires,
              }),
            }
          },
        },
        { label: "Manually enter API Key", type: "api" },
      ],
    },
  }
}

export * as AnthropicSubscription from "./subscription"
