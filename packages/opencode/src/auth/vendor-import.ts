import { Schema } from "effect"

export type VendorID = "anthropic" | "openai"
export type ImportedCredential =
  | { vendor: VendorID; kind: "oauth"; refresh: string; access: string; expires: number; accountId?: string }
  | { vendor: VendorID; kind: "api"; key: string }

// Mirrors ~/.claude/.credentials.json (claudeAiOauth.accessToken/refreshToken/expiresAt).
const ClaudeShape = Schema.Struct({
  claudeAiOauth: Schema.Struct({
    accessToken: Schema.String,
    refreshToken: Schema.String,
    expiresAt: Schema.Number,
  }),
})

// Mirrors ~/.codex/auth.json (tokens.access_token/refresh_token, optional id_token/account_id).
const CodexShape = Schema.Struct({
  tokens: Schema.Struct({
    access_token: Schema.String,
    refresh_token: Schema.String,
    id_token: Schema.optional(Schema.String),
    account_id: Schema.optional(Schema.String),
  }),
})

export function parseClaudeCredentials(raw: unknown): ImportedCredential | undefined {
  const decoded = Schema.decodeUnknownOption(ClaudeShape)(raw)
  if (decoded._tag === "None") return undefined
  const oauth = decoded.value.claudeAiOauth
  if (oauth.accessToken.length === 0) return undefined
  if (oauth.refreshToken.length === 0) return undefined
  return {
    vendor: "anthropic",
    kind: "oauth",
    refresh: oauth.refreshToken,
    access: oauth.accessToken,
    expires: oauth.expiresAt,
  }
}

export function parseCodexAuth(raw: unknown): ImportedCredential | undefined {
  const decoded = Schema.decodeUnknownOption(CodexShape)(raw)
  if (decoded._tag === "None") return undefined
  const tokens = decoded.value.tokens
  if (tokens.access_token.length === 0) return undefined
  if (tokens.refresh_token.length === 0) return undefined
  const accountId = tokens.account_id
  return {
    vendor: "openai",
    kind: "oauth",
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: Date.now() + 3600_000,
    ...(accountId ? { accountId } : {}),
  }
}

export function readEnvCredential(
  vendor: VendorID,
  env: Record<string, string | undefined>,
): ImportedCredential | undefined {
  const key = vendor === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY
  if (!key || key.length === 0) return undefined
  return { vendor, kind: "api", key }
}

export * as VendorImport from "./vendor-import"
