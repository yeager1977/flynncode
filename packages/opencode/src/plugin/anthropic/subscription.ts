import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { OauthCallbackPage } from "@opencode-ai/core/oauth/page"
import { OAUTH_DUMMY_KEY } from "../../auth"
import { parseClaudeCredentials } from "../../auth/vendor-import"
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

export function parseJwtLike(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

// Subscription OAuth only serves the Claude Pro/Max lineup; API keys keep the
// full provider catalog.
const SUBSCRIPTION_MODELS = new Set(["claude-sonnet-5", "claude-opus-5-5", "claude-fable-5-1"])

export function filterSubscriptionModels<Model extends { api: { id: string } }>(
  models: Record<string, Model>,
  isOAuth: boolean,
): Record<string, Model> {
  if (!isOAuth) return models
  return Object.fromEntries(Object.entries(models).filter(([, model]) => SUBSCRIPTION_MODELS.has(model.api.id)))
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
  await new Promise<void>((resolve, reject) => {
    oauthServer!.listen(OAUTH_PORT, () => resolve())
    oauthServer!.on("error", reject)
  })
  return { redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
}

function stopOAuthServer() {
  if (oauthServer) {
    oauthServer.close(() => {})
    oauthServer = undefined
  }
}

function waitForOAuthCallback(pkce: PkceCodes, state: string, options: AnthropicSubscriptionOptions): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingOAuth) {
        pendingOAuth = undefined
        reject(new Error("OAuth callback timeout - authorization took too long"))
      }
    }, 5 * 60 * 1000)
    pendingOAuth = {
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
  })
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
        if (ctx.auth?.type !== "oauth") return provider.models
        return filterSubscriptionModels(provider.models, true)
      },
    },
    auth: {
      provider: "anthropic",
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
            return {
              url: buildAuthorizeUrl(redirectUri, pkce, state, options),
              instructions: "Complete authorization in your browser. This window will close automatically.",
              method: "auto" as const,
              callback: async () => {
                const tokens = await callbackPromise
                stopOAuthServer()
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
            const raw = await Bun.file(path.join(os.homedir(), ".claude", ".credentials.json"))
              .json()
              .catch(() => undefined)
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
