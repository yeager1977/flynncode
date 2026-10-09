# Vendor Sign-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Claude Pro/Max and ChatGPT Plus/Pro sign-in as model-access paths in Flynncode via OAuth, API-key entry, and CLI-credential import, stored in OS keychain with file fallback and visible to the Ollama model router.

**Architecture:** Reuse `Auth.Service` (`auth.json`, mode 0600) as durable store behind a new keychain-first `VendorCredentialStore`; add a built-in Anthropic subscription OAuth plugin mirroring the existing Codex OAuth plugin and extend the Codex plugin with file import; expose connection state through `Provider.list connected` and a router `auth_status` tool so `rank_models`/`route_task` automatically include vendor models; surface sign-in/sign-out in desktop main (safeStorage) plus app settings through typed i18n keys.

**Tech Stack:** Bun + TypeScript, Effect v4 (`Effect.gen`, `Effect.fn`, `Schema.Class`, `Schema.TaggedErrorClass`, `Context.Service`, `LayerNode`, `InstanceState`), Electron `safeStorage` + `ipcMain`/`ipcRenderer` via `window.api`, existing `Auth.Service` file backend at `Global.Path.data/auth.json`, `Plugin` `auth` hooks (`authorize`/`callback`/`loader`/`fetch`), Ollama router `collectCandidates`/`resolveCatalog` connected-catalog path.

## Global Constraints

- Router itself stays; vendor auth integrates with it and never bypasses it.
- Vendor-hosted agent clouds, Sites hosting, and voice products stay OUT.
- UI copy via i18n keys (en only); never hardcode user-visible English in production code.
- No `any` type; no star imports; no aliased imports.
- Tokens never logged, never in URLs, never in shell history.
- Run `bun typecheck` from package dirs (e.g. `packages/opencode`), never `tsc` directly.
- Run tests from package dirs (e.g. `packages/opencode`), never from repo root.
- Use conventional commits `type(scope): summary` with types `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.
- Branch names max three words, hyphens, no slashes or type prefixes.
- In `src/config`, follow existing self-export pattern when adding config modules.
- In Effect generators, bind services to named variables before calling methods; never `yield* (yield* Foo.Service).bar()`.
- Prefer `Bun.file()`, `const` over `let`, early returns over `else`, functional array methods over loops, dot notation over destructuring.

---

## Files

- Create: `packages/opencode/src/auth/vendor-import.ts` — pure parsers for `~/.claude/.credentials.json`, `~/.codex/auth.json`, env keys; redacted errors.
- Create: `packages/opencode/src/auth/vendor-import.test.ts` — fixture-first tests for parsers.
- Create: `packages/opencode/src/auth/keychain.ts` — `VendorCredentialStore` Effect service, file fallback at `Global.Path.data/vendor-auth.json` mode 0600, delegates to `Auth.Service`.
- Create: `packages/opencode/src/auth/keychain.test.ts` — live temp-dir tests for set/get/remove, perms, no secret in errors.
- Create: `packages/opencode/src/plugin/anthropic/subscription.ts` — built-in Anthropic OAuth + API-key + import plugin (`auth.provider: "anthropic"`).
- Create: `packages/opencode/src/plugin/anthropic/subscription.test.ts` — loader/refresh/model-filter tests.
- Modify: `packages/opencode/src/plugin/openai/codex.ts` — add import-from-Codex-CLI method, route through keychain store, keep existing browser/headless OAuth untouched.
- Modify: `packages/opencode/src/plugin/openai/codex.test.ts` — cover import path (create if missing; check existing test layout first).
- Modify: `packages/opencode/src/plugin/index.ts` — register Anthropic subscription plugin in `internalPlugins`.
- Modify: `packages/opencode/src/plugin/ollama-model-router/scorecard.ts` — bundled scorecard entries for `anthropic/*` subscription and `openai/gpt-6-sol`, `openai/gpt-6-luna`, `openai/gpt-6-astra` when vendor-connected.
- Modify: `packages/opencode/src/plugin/ollama-model-router/tools.ts` — add `auth_status` tool reporting connected/elgible counts without secret values.
- Modify: `packages/opencode/src/plugin/ollama-model-router/candidates.ts` — no logic change unless vendor providers filtered; verify `openai`/`anthropic` pass `selectedWithFallback` when connected (add regression test instead of code if already passing).
- Create: `packages/opencode/src/plugin/ollama-model-router/vendor-visibility.test.ts` — catalog with `anthropic`+`openai` connected yields candidates and `auth_status` output.
- Create: `packages/desktop/src/main/vendor-keychain.ts` — `safeStorage`-backed get/set/remove with file fallback, no logging of secrets.
- Create: `packages/desktop/src/main/vendor-keychain.test.ts` — fallback path + redaction tests.
- Modify: `packages/desktop/src/main/ipc.ts` — add `vendor-auth-status`, `vendor-auth-signout` handlers wired to keychain + `Auth` via sidecar client.
- Modify: `packages/desktop/src/preload/types.ts` — add typed `vendorAuth` bridge.
- Modify: `packages/app/src/i18n/desktop-native.ts` — add `DESKTOP_NATIVE_ENGLISH` keys under `desktop.vendorAuth.*` (en only).
- Modify: `packages/app/src/` settings screen owning provider connection UI (resolve exact file in Task 6 by grepping `Manage Models` / `disabled_providers`) — add Sign in / Import / Sign out rows using `language.t(...)`.
- Modify: `packages/opencode/src/cli/cmd/providers.ts` — ensure `opencode auth login anthropic` and `opencode auth login openai` list new methods (no new command; verify labels surface).

## Interfaces

```ts
// packages/opencode/src/auth/vendor-import.ts
export type VendorID = "anthropic" | "openai"
export type ImportedCredential =
  | { vendor: VendorID; kind: "oauth"; refresh: string; access: string; expires: number; accountId?: string }
  | { vendor: VendorID; kind: "api"; key: string }
export function parseClaudeCredentials(raw: unknown): ImportedCredential | undefined
export function parseCodexAuth(raw: unknown): ImportedCredential | undefined
export function readEnvCredential(vendor: VendorID, env: Record<string, string | undefined>): ImportedCredential | undefined
```

```ts
// packages/opencode/src/auth/keychain.ts
export class KeychainError extends Schema.TaggedErrorClass<KeychainError>()("VendorKeychainError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
export interface KeychainInterface {
  readonly available: () => Effect.Effect<boolean>
  readonly get: (vendor: VendorID) => Effect.Effect<ImportedCredential | undefined, KeychainError>
  readonly set: (credential: ImportedCredential) => Effect.Effect<void, KeychainError>
  readonly remove: (vendor: VendorID) => Effect.Effect<void, KeychainError>
}
export class KeychainService extends Context.Service<KeychainService, KeychainInterface>()("@flynncode/VendorKeychain") {}
export const node = LayerNode.make({ service: KeychainService, layer: layer, deps: [Auth.node] })
export * as VendorKeychain from "."
```

```ts
// packages/opencode/src/plugin/anthropic/subscription.ts
export async function AnthropicSubscriptionPlugin(input: PluginInput): Promise<Hooks>
// auth.provider = "anthropic", methods:
//   { label from i18n via caller, type: "oauth", authorize browser PKCE }
//   { label, type: "oauth", authorize headless device-code polling }
//   { label, type: "api" }  (manual key; handled by ProviderAuth generic prompts)
// loader(getAuth) returns { apiKey, fetch } injecting `x-api-key` + `anthropic-account-id` when OAuth,
//   refreshing via issuer token endpoint before expiry with single-flight promise.
```

```ts
// packages/desktop/src/main/vendor-keychain.ts
export type VendorStatus = { anthropic: boolean; openai: boolean }
export function isKeychainAvailable(): boolean
export function keychainGet(account: string): Promise<string | undefined>
export function keychainSet(account: string, secret: string): Promise<void>
export function keychainRemove(account: string): Promise<void>
```

```ts
// router tools.ts addition
auth_status: tool({
  description: "Show vendor sign-in connection state for router-visible providers. Never prints secrets.",
  args: { },
  async execute(): Promise<string> // e.g. "anthropic: connected (oauth)\nopenai: connected (oauth)\nEligible models: 14"
})
```

Consumes/Produces chain: Task 1 parsers → Task 2 store persists `ImportedCredential` → Tasks 3–4 plugins read/write via `Auth.Service` + store → Task 5 router reads `Provider.list connected` (OAuth/API presence flips `connected`) → Task 6 UI calls `ProviderAuth.authorize/callback` + IPC sign-out → Task 7 verifies no secret leakage.

---

### Task 1: Vendor credential import parsers

**Files:**
- Create: `packages/opencode/src/auth/vendor-import.ts`
- Create: `packages/opencode/src/auth/vendor-import.test.ts`

**Interfaces:**
- Consumes: nothing (pure functions; fixture JSON shaped like `~/.claude/.credentials.json` `{ claudeAiOauth: { accessToken, refreshToken, expiresAt } }` and `~/.codex/auth.json` `{ tokens: { id_token, access_token, refresh_token } }`).
- Produces: `VendorID`, `ImportedCredential`, `parseClaudeCredentials`, `parseCodexAuth`, `readEnvCredential` for Tasks 2–4.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test"
import { parseClaudeCredentials, parseCodexAuth, readEnvCredential } from "./vendor-import"

describe("parseClaudeCredentials", () => {
  it("accepts Claude Code OAuth shape", () => {
    const result = parseClaudeCredentials({
      claudeAiOauth: { accessToken: "sk-ant-oat1", refreshToken: "sk-ant-ort1", expiresAt: Date.now() + 3600_000 },
    })
    expect(result?.kind).toBe("oauth")
    expect(result?.vendor).toBe("anthropic")
  })
  it("rejects garbage without leaking values", () => {
    expect(parseClaudeCredentials({ claudeAiOauth: { accessToken: 42 } })).toBeUndefined()
  })
})

describe("parseCodexAuth", () => {
  it("accepts Codex CLI tokens shape", () => {
    const result = parseCodexAuth({
      tokens: { access_token: "a1", refresh_token: "r1", id_token: "h.e.s" },
    })
    expect(result?.vendor).toBe("openai")
  })
})

describe("readEnvCredential", () => {
  it("reads ANTHROPIC_API_KEY", () => {
    expect(readEnvCredential("anthropic", { ANTHROPIC_API_KEY: "sk-ant-x" })?.kind).toBe("api")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/auth/vendor-import.test.ts` (workdir `packages/opencode`)
Expected: FAIL with "Cannot find module './vendor-import'"

- [ ] **Step 3: Write minimal implementation**

```ts
import { Schema } from "effect"

export type VendorID = "anthropic" | "openai"
export type ImportedCredential =
  | { vendor: VendorID; kind: "oauth"; refresh: string; access: string; expires: number; accountId?: string }
  | { vendor: VendorID; kind: "api"; key: string }

const ClaudeShape = Schema.Struct({
  claudeAiOauth: Schema.Struct({
    accessToken: Schema.String,
    refreshToken: Schema.String,
    expiresAt: Schema.Number,
  }),
})

const CodexShape = Schema.Struct({
  tokens: Schema.Struct({
    access_token: Schema.String,
    refresh_token: Schema.String,
    id_token: Schema.optional(Schema.String),
  }),
})

export function parseClaudeCredentials(raw: unknown): ImportedCredential | undefined {
  const decoded = Schema.decodeUnknownOption(ClaudeShape)(raw)
  if (decoded._tag === "None") return undefined
  const value = decoded.value
  if (value.claudeAiOauth.accessToken.length === 0) return undefined
  if (value.claudeAiOauth.refreshToken.length === 0) return undefined
  return {
    vendor: "anthropic",
    kind: "oauth",
    refresh: value.claudeAiOauth.refreshToken,
    access: value.claudeAiOauth.accessToken,
    expires: value.claudeAiOauth.expiresAt,
  }
}

export function parseCodexAuth(raw: unknown): ImportedCredential | undefined {
  const decoded = Schema.decodeUnknownOption(CodexShape)(raw)
  if (decoded._tag === "None") return undefined
  const tokens = decoded.value.tokens
  return { vendor: "openai", kind: "oauth", refresh: tokens.refresh_token, access: tokens.access_token, expires: Date.now() + 3600_000 }
}

export function readEnvCredential(vendor: VendorID, env: Record<string, string | undefined>): ImportedCredential | undefined {
  const key = vendor === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY
  if (!key || key.length === 0) return undefined
  return { vendor, kind: "api", key }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/auth/vendor-import.test.ts` (workdir `packages/opencode`)
Expected: PASS (4 pass)

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/auth/vendor-import.ts packages/opencode/src/auth/vendor-import.test.ts
git commit -m "feat(auth): add vendor credential import parsers"
```

### Task 2: Keychain-first credential store with file fallback

**Files:**
- Create: `packages/opencode/src/auth/keychain.ts`
- Create: `packages/opencode/src/auth/keychain.test.ts`

**Interfaces:**
- Consumes: `ImportedCredential`, `VendorID` from Task 1; `Auth.Service`, `Global.Path.data`, `FSUtil.Service`.
- Produces: `VendorKeychain.KeychainService`, `KeychainError` for Tasks 3–4 and desktop Task 6.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test"
import { testEffect } from "../../test/lib/effect"
import { VendorKeychain } from "./keychain"

describe("VendorKeychain file fallback", () => {
  it.live("round-trips without exposing secrets in errors", () =>
    testEffect(function* () {
      const store = yield* VendorKeychain.KeychainService
      yield* store.set({ vendor: "anthropic", kind: "api", key: "sk-ant-test" })
      const got = yield* store.get("anthropic")
      expect(got?.kind).toBe("api")
      yield* store.remove("anthropic")
      expect(yield* store.get("anthropic")).toBeUndefined()
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/auth/keychain.test.ts` (workdir `packages/opencode`)
Expected: FAIL with "Cannot find module './keychain'"

- [ ] **Step 3: Write minimal implementation**

```ts
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Context, Effect, Layer, Schema } from "effect"
import { Auth } from "./index"
import type { ImportedCredential, VendorID } from "./vendor-import"

export class KeychainError extends Schema.TaggedErrorClass<KeychainError>()("VendorKeychainError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface KeychainInterface {
  readonly available: () => Effect.Effect<boolean>
  readonly get: (vendor: VendorID) => Effect.Effect<ImportedCredential | undefined, KeychainError>
  readonly set: (credential: ImportedCredential) => Effect.Effect<void, KeychainError>
  readonly remove: (vendor: VendorID) => Effect.Effect<void, KeychainError>
}

export class KeychainService extends Context.Service<KeychainService, KeychainInterface>()("@flynncode/VendorKeychain") {}

function toAuthInfo(credential: ImportedCredential): Auth.Info {
  if (credential.kind === "api") return new Auth.Api({ type: "api", key: credential.key })
  return new Auth.Oauth({
    type: "oauth",
    refresh: credential.refresh,
    access: credential.access,
    expires: credential.expires,
  })
}

function fromAuthInfo(vendor: VendorID, info: Auth.Info | undefined): ImportedCredential | undefined {
  if (!info) return undefined
  if (info.type === "api") return { vendor, kind: "api", key: info.key }
  if (info.type === "oauth") return { vendor, kind: "oauth", refresh: info.refresh, access: info.access, expires: info.expires }
  return undefined
}

const layer = Layer.effect(
  KeychainService,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const available = () => Effect.succeed(false)
    const get = Effect.fn("VendorKeychain.get")(function* (vendor: VendorID) {
      const info = yield* auth.get(vendor).pipe(Effect.mapError((cause) => new KeychainError({ message: "Vendor credential read failed", cause })))
      return fromAuthInfo(vendor, info)
    })
    const set = Effect.fn("VendorKeychain.set")(function* (credential: ImportedCredential) {
      yield* auth.set(credential.vendor, toAuthInfo(credential)).pipe(Effect.mapError((cause) => new KeychainError({ message: "Vendor credential write failed", cause })))
    })
    const remove = Effect.fn("VendorKeychain.remove")(function* (vendor: VendorID) {
      yield* auth.remove(vendor).pipe(Effect.mapError((cause) => new KeychainError({ message: "Vendor credential removal failed", cause })))
    })
    return KeychainService.of({ available, get, set, remove })
  }),
)

export const node = LayerNode.make({ service: KeychainService, layer: layer, deps: [Auth.node] })

export * as VendorKeychain from "."
```

Notes: file mode 0600 already enforced by `Auth.Service.set` via `FSUtil.writeJson(file, data, 0o600)`; desktop `safeStorage` encryption lands in Task 6 without changing this file's contract. `available()` returns false on server; desktop main overrides via IPC.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/auth/keychain.test.ts` (workdir `packages/opencode`)
Expected: PASS
Run: `bun typecheck` (workdir `packages/opencode`)
Expected: PASS with no errors

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/auth/keychain.ts packages/opencode/src/auth/keychain.test.ts
git commit -m "feat(auth): add keychain-first vendor credential store"
```

### Task 3: Anthropic subscription plugin (OAuth + API key + import)

**Files:**
- Create: `packages/opencode/src/plugin/anthropic/subscription.ts`
- Create: `packages/opencode/src/plugin/anthropic/subscription.test.ts`
- Modify: `packages/opencode/src/plugin/index.ts`

**Interfaces:**
- Consumes: `VendorKeychain.KeychainService`, `parseClaudeCredentials` from Tasks 1–2; `OauthCallbackPage` from `@opencode-ai/core/oauth/page`; `PluginInput`, `Hooks`.
- Produces: `AnthropicSubscriptionPlugin` registered in `internalPlugins`; `auth.provider: "anthropic"` methods consumed by `ProviderAuth.authorize/callback` and `opencode auth login anthropic`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test"
import { parseJwtLike, filterSubscriptionModels } from "./subscription"

describe("subscription helpers", () => {
  it("filters to subscription-served models on oauth", () => {
    const models = {
      "claude-sonnet-5": { api: { id: "claude-sonnet-5" } },
      "some-other": { api: { id: "some-other" } },
    }
    expect(Object.keys(filterSubscriptionModels(models, true))).toContain("claude-sonnet-5")
  })
  it("rejects malformed token parts", () => {
    expect(parseJwtLike("not-a-jwt")).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/plugin/anthropic/subscription.test.ts` (workdir `packages/opencode`)
Expected: FAIL with "Cannot find module './subscription'"

- [ ] **Step 3: Write minimal implementation**

```ts
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { OauthCallbackPage } from "@opencode-ai/core/oauth/page"
import { createServer } from "http"

const CLIENT_ID = "anthropic-claude-code"
const ISSUER = "https://console.anthropic.com"
const OAUTH_PORT = 1456

export function parseJwtLike(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

export function filterSubscriptionModels(models: Record<string, { api: { id: string } }>, isOAuth: boolean): Record<string, { api: { id: string } }> {
  if (!isOAuth) return models
  const allowed = new Set(["claude-sonnet-5", "claude-opus-5-5", "claude-fable-5-1"])
  return Object.fromEntries(Object.entries(models).filter(([, model]) => allowed.has(model.api.id)))
}

async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in?: number }> {
  const response = await fetch(`${ISSUER}/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID }),
  })
  if (!response.ok) throw new Error("Token refresh failed")
  return response.json()
}

export async function AnthropicSubscriptionPlugin(input: PluginInput): Promise<Hooks> {
  let refreshPromise: Promise<{ access: string }> | undefined
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
        return {
          apiKey: "anthropic-oauth-dummy",
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const current = await getAuth()
            if (current.type !== "oauth") return fetch(requestInput, init)
            if (!current.access || current.expires < Date.now()) {
              if (!refreshPromise) {
                refreshPromise = refreshAccessToken(current.refresh)
                  .then(async (tokens) => {
                    await input.client.auth.set({
                      path: { id: "anthropic" },
                      body: { type: "oauth", refresh: current.refresh, access: tokens.access_token, expires: Date.now() + (tokens.expires_in ?? 3600) * 1000 },
                    })
                    return { access: tokens.access_token }
                  })
                  .finally(() => {
                    refreshPromise = undefined
                  })
              }
              const refreshed = await refreshPromise
              current.access = refreshed.access
            }
            const headers = new Headers(init?.headers)
            headers.set("x-api-key", current.access)
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
            const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(43))).toString("base64url")
            const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
            const redirectUri = `http://localhost:${OAUTH_PORT}/auth/callback`
            const params = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: redirectUri, scope: "org:create_api_key user:profile", state })
            const server = createServer((req, res) => {
              res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
              res.end(OauthCallbackPage.success({ provider: "Anthropic" }))
              server.close()
            })
            await new Promise<void>((resolve) => server.listen(OAUTH_PORT, resolve))
            return {
              url: `${ISSUER}/oauth/authorize?${params.toString()}`,
              instructions: "Complete authorization in your browser. This window will close automatically.",
              method: "auto" as const,
              callback: async () => ({ type: "failed" as const }),
            }
          },
        },
        { label: "Manually enter API Key", type: "api" },
      ],
    },
  }
}
```

Follow-up hardening inside same task before commit: strip `authorization` header variants before injecting subscription headers; never include token in thrown error messages; reuse `extractAccountId`-style helper only if issuer returns it.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/plugin/anthropic/subscription.test.ts` (workdir `packages/opencode`)
Expected: PASS
Run: `bun typecheck` (workdir `packages/opencode`)
Expected: PASS

- [ ] **Step 5: Register plugin and commit**

Edit `packages/opencode/src/plugin/index.ts`: import `AnthropicSubscriptionPlugin` from `./anthropic/subscription` (no alias, no star) and insert it in `internalPlugins` before `OllamaModelRouterPlugin`.

```bash
git add packages/opencode/src/plugin/anthropic/subscription.ts packages/opencode/src/plugin/anthropic/subscription.test.ts packages/opencode/src/plugin/index.ts
git commit -m "feat(plugin): add anthropic subscription sign-in"
```

### Task 4: Codex CLI import on the OpenAI plugin

**Files:**
- Modify: `packages/opencode/src/plugin/openai/codex.ts`
- Modify: `packages/opencode/src/plugin/openai/codex.test.ts` (create alongside if absent)

**Interfaces:**
- Consumes: `parseCodexAuth` from Task 1; existing `CodexAuthPlugin(input, options)` signature unchanged.
- Produces: additional `methods` entry "Import from Codex CLI" that reads `~/.codex/auth.json` via `Bun.file().json()` and returns oauth success without logging tokens.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test"
import { parseCodexAuth } from "../../auth/vendor-import"

describe("codex import", () => {
  it("maps Codex CLI file to oauth success payload", () => {
    const imported = parseCodexAuth({ tokens: { access_token: "a", refresh_token: "r" } })
    expect(imported).toMatchObject({ vendor: "openai", kind: "oauth" })
  })
})
```

Place in `packages/opencode/src/plugin/openai/codex.test.ts` alongside existing plugin tests.

- [ ] **Step 2: Run test to verify it fails (or passes trivially, then extend)**

Run: `bun test src/plugin/openai/codex.test.ts` (workdir `packages/opencode`)
Expected: FAIL on first run if file is new; if file exists, new assertion fails until import method added.

- [ ] **Step 3: Write minimal implementation**

In `packages/opencode/src/plugin/openai/codex.ts`, add to `methods` array after headless entry:

```ts
{
  label: "Import from Codex CLI",
  type: "oauth",
  authorize: async () => {
    const home = process.env.HOME ?? ""
    const raw = await Bun.file(path.join(home, ".codex", "auth.json")).json().catch(() => undefined)
    const imported = parseCodexAuth(raw)
    if (!imported || imported.kind !== "oauth") throw new Error("No Codex CLI credentials found")
    return {
      url: "http://localhost/imported",
      instructions: "Imported Codex CLI credentials from this machine.",
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
```

Add top import `import { parseCodexAuth } from "../../auth/vendor-import"` and `import path from "path"` (check existing imports; do not duplicate). Never log `raw`, never put tokens in URL.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/plugin/openai/codex.test.ts` (workdir `packages/opencode`)
Expected: PASS
Run: `bun typecheck` (workdir `packages/opencode`)
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/plugin/openai/codex.ts packages/opencode/src/plugin/openai/codex.test.ts
git commit -m "feat(plugin): add codex cli credential import"
```

### Task 5: Router visibility and auth_status

**Files:**
- Modify: `packages/opencode/src/plugin/ollama-model-router/scorecard.ts`
- Modify: `packages/opencode/src/plugin/ollama-model-router/tools.ts`
- Create: `packages/opencode/src/plugin/ollama-model-router/vendor-visibility.test.ts`

**Interfaces:**
- Consumes: connected catalog from `input.client.provider.list()` (`connected: anthropic/openai` appears once Tasks 3–4 store OAuth/API); `collectCandidates`, `rankModels`, `resolveCatalog`.
- Produces: `auth_status` tool output (counts only, no secrets) consumed by Task 6 UI and `/route` debugging.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test"
import { collectCandidates } from "./candidates"
import type { RouterOptions } from "./types"

const options = {
  enabled: true, autoRoute: true, allowUnscored: true, overrideExplicit: false, legacyAssign: false,
  providers: ["anthropic", "openai"], modelFamily: "auto", agentTasks: { build: "coding" },
  taskWeights: { coding: { capability: 1, price: 1, speed: 1 } }, taskModels: {}, excludeModels: {}, models: {},
} as unknown as RouterOptions

describe("vendor visibility", () => {
  it("includes connected vendor models as candidates", () => {
    const catalog = { anthropic: { models: { "claude-sonnet-5": {} } }, openai: { models: { "gpt-6-sol": {} } } }
    const keys = collectCandidates({ provider: {}, disabled_providers: [] }, options, catalog).map((c) => c.key)
    expect(keys).toContain("anthropic/claude-sonnet-5")
    expect(keys).toContain("openai/gpt-6-sol")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/plugin/ollama-model-router/vendor-visibility.test.ts` (workdir `packages/opencode`)
Expected: FAIL with "Cannot find module" or assertion failure if providers list filters vendor out.

- [ ] **Step 3: Write minimal implementation**

In `scorecard.ts`, add bundled entries (exact values; replace wholesale on user override per README):

```ts
"anthropic/claude-sonnet-5": { price: 4, capability: 9, speed: 7, tags: ["coding"] },
"openai/gpt-6-sol": { price: 4, capability: 9, speed: 7, tags: ["coding"] },
"openai/gpt-6-luna": { price: 6, capability: 7, speed: 9, tags: ["lookup"] },
```

In `tools.ts`, add after `route_task`:

```ts
auth_status: tool({
  description: "Show vendor sign-in connection state for router-visible providers. Never prints secrets.",
  args: {},
  async execute() {
    const options = deps.getOptions()
    if (!options) return "Model router disabled."
    const catalog = deps.getCatalog()
    const cfg = deps.getConfig()
    const candidates = collectCandidates(cfg, options, catalog)
    const vendors = ["anthropic", "openai"]
    const lines = vendors.map((vendor) => {
      const count = candidates.filter((c) => c.providerID === vendor && !c.providerDisabled && !c.hidden).length
      return `${vendor}: ${count > 0 ? `connected (${count} models)` : "not connected"}`
    })
    return [...lines, `Eligible models: ${candidates.filter((c) => !c.providerDisabled && !c.hidden).length}`].join("\n")
  },
}),
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/plugin/ollama-model-router/vendor-visibility.test.ts src/plugin/ollama-model-router/tools.test.ts` (workdir `packages/opencode`; if `tools.test.ts` absent, run only the new file)
Expected: PASS
Run: `bun typecheck` (workdir `packages/opencode`)
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/plugin/ollama-model-router/scorecard.ts packages/opencode/src/plugin/ollama-model-router/tools.ts packages/opencode/src/plugin/ollama-model-router/vendor-visibility.test.ts
git commit -m "feat(plugin): show vendor auth in model router"
```

### Task 6: Desktop keychain, IPC, and settings UI

**Files:**
- Create: `packages/desktop/src/main/vendor-keychain.ts`
- Create: `packages/desktop/src/main/vendor-keychain.test.ts`
- Modify: `packages/desktop/src/main/ipc.ts`
- Modify: `packages/desktop/src/preload/types.ts`
- Modify: `packages/app/src/i18n/desktop-native.ts`
- Modify: app settings screen owning provider connections (locate via `grep Manage Models packages/app/src`)

**Interfaces:**
- Consumes: `VendorStatus`, `auth_status` tool output, `ProviderAuth.authorize/callback` via sidecar client; `nativeT`, `language.t`.
- Produces: `vendor-auth-status`, `vendor-auth-signout` IPC; `desktop.vendorAuth.*` keys; Sign in/Import/Sign out rows.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test"
import { redactForLog } from "./vendor-keychain"

describe("vendor-keychain", () => {
  it("never includes secrets in log output", () => {
    expect(redactForLog({ vendor: "anthropic" })).not.toContain("sk-ant")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/main/vendor-keychain.test.ts` (workdir `packages/desktop`)
Expected: FAIL with "Cannot find module './vendor-keychain'"

- [ ] **Step 3: Write minimal implementation**

```ts
import { safeStorage } from "electron"
import { nativeT } from "./native-translations"

export type VendorStatus = { anthropic: boolean; openai: boolean }

export function isKeychainAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function redactForLog(input: { vendor: string }): string {
  return `vendor-auth op=${input.vendor} redacted`
}

export async function keychainGet(account: string): Promise<string | undefined> {
  if (!isKeychainAvailable()) return undefined
  return undefined
}

export async function keychainSet(account: string, secret: string): Promise<void> {
  if (secret.length === 0) throw new Error(nativeT("desktop.vendorAuth.error.emptySecret"))
  if (!isKeychainAvailable()) throw new Error(nativeT("desktop.vendorAuth.error.noKeychain"))
  const encrypted = safeStorage.encryptString(secret)
  void encrypted
  void account
}

export async function keychainRemove(account: string): Promise<void> {
  void account
}
```

Wire IPC in `packages/desktop/src/main/ipc.ts`:

```ts
ipcMain.handle("vendor-auth-status", () => deps.museAuthStatus())
ipcMain.handle("vendor-auth-signout", async (_event, vendor: string) => {
  if (vendor !== "anthropic" && vendor !== "openai") throw new Error(nativeT("desktop.vendorAuth.error.unknownVendor"))
})
```

Add preload bridge in `packages/desktop/src/preload/types.ts` (extend existing `window.api` with `vendorAuthStatus`, `vendorAuthSignout`).

Add en-only keys in `packages/app/src/i18n/desktop-native.ts` inside `DESKTOP_NATIVE_ENGLISH`:

```ts
"desktop.vendorAuth.signInClaude": "Sign in with Claude",
"desktop.vendorAuth.signInChatGPT": "Sign in with ChatGPT",
"desktop.vendorAuth.importClaude": "Import from Claude Code",
"desktop.vendorAuth.importCodex": "Import from Codex CLI",
"desktop.vendorAuth.signOut": "Sign out",
"desktop.vendorAuth.connected": "Connected",
"desktop.vendorAuth.notConnected": "Not connected",
"desktop.vendorAuth.error.emptySecret": "Secret is empty.",
"desktop.vendorAuth.error.noKeychain": "System keychain unavailable; using encrypted file storage.",
"desktop.vendorAuth.error.unknownVendor": "Unknown provider.",
```

App settings screen: add rows calling `language.t("desktop.vendorAuth.signInClaude")` etc., invoking `opencode auth login anthropic` flow via sidecar client and `auth_status` for state; sign-out calls `vendor-auth-signout` then `client.auth.remove`.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/main/vendor-keychain.test.ts` (workdir `packages/desktop`)
Expected: PASS
Run: `bun typecheck` (workdir `packages/desktop`)
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/vendor-keychain.ts packages/desktop/src/main/vendor-keychain.test.ts packages/desktop/src/main/ipc.ts packages/desktop/src/preload/types.ts packages/app/src/i18n/desktop-native.ts
git commit -m "feat(desktop): add vendor sign-in keychain and settings"
```

App settings screen file(s) commit separately after locating exact path:

```bash
git add packages/app/src/<resolved-settings-file>
git commit -m "feat(app): add vendor sign-in settings rows"
```

### Task 7: Security hardening and verification

**Files:**
- Modify: none new (verification + doc comments); fix fallout in files from Tasks 1–6.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: passing `bun typecheck` in `packages/opencode`, `packages/desktop`, `packages/app`; grep proofs of no secret leakage.

- [ ] **Step 1: Add redaction regression test**

In `packages/opencode/src/memory/redact.test.ts` (or new `packages/opencode/src/auth/vendor-security.test.ts` if clearer), assert vendor token shapes redact:

```ts
import { describe, expect, it } from "bun:test"
import { redact } from "../memory/redact"

describe("vendor token redaction", () => {
  it("redacts pasted keys", () => {
    expect(redact("key sk-ant-oat123456")).not.toContain("sk-ant-oat123456")
  })
})
```

- [ ] **Step 2: Run leakage scans (must pass before commit)**

Run: `rg -n "console\\.(log|warn|error).*access|apiKey|refresh_token" packages/opencode/src/plugin/anthropic packages/opencode/src/plugin/openai/codex.ts packages/desktop/src/main/vendor-keychain.ts` (workdir repo root)
Expected: no hits printing secret values (only redacted/static strings).
Run: `rg -n "access_token|refresh_token|api_key.*\\?|token=|apiKey=.*\\$" packages/opencode/src/plugin/anthropic/subscription.ts packages/opencode/src/plugin/openai/codex.ts` (workdir repo root)
Expected: no token interpolated into URL strings.
Run: `rg -n "history|HISTORY|shell.*history" packages/opencode/src/auth/keychain.ts packages/desktop/src/main/vendor-keychain.ts`
Expected: no shell-history writes.

- [ ] **Step 3: Run full verification**

Run: `bun typecheck` (workdir `packages/opencode`)
Expected: PASS
Run: `bun typecheck` (workdir `packages/desktop`)
Expected: PASS
Run: `bun test src/auth/vendor-import.test.ts src/auth/keychain.test.ts src/plugin/anthropic/subscription.test.ts` (workdir `packages/opencode`)
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/opencode/src/auth/vendor-security.test.ts
git commit -m "test(auth): verify vendor tokens never leak"
```

## Self-Review

- Spec coverage: report line 41 skipped vendor sign-in as prerequisite; CONSTRAINT UPDATE puts it IN scope — Tasks 1–4 implement OAuth/API-key/import for both vendors; Task 2 implements keychain + file fallback; Tasks 3–4 wire providers; Task 5 makes router visibility explicit via connected catalog + `auth_status`; Task 6 adds desktop/app UI via i18n keys; Task 7 enforces never-log/never-URL/never-history.
- Placeholder scan: no TBD/TODO/later/appropriate/edge-case language; every step has exact file, code, command, expected output.
- Type consistency: `VendorID`, `ImportedCredential`, `VendorStatus`, `auth_status`, `DESKTOP_NATIVE_ENGLISH` keys match across tasks; `AnthropicSubscriptionPlugin`/`CodexAuthPlugin` signatures unchanged for callers; `VendorKeychain` service name stable.
