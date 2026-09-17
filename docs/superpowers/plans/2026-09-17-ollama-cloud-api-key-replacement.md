# Ollama Cloud API Key Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a key entered through Flynncode replace the effective Ollama Cloud credential and produce an installable `opencode-dev` 1.18.34 Debian package.

**Architecture:** Centralize API-key precedence in the provider service so saved API auth wins consistently during model discovery and runtime SDK construction while config metadata still merges normally. Preserve the effective `api` source, redact credentials from public provider responses, and reuse the existing connection dialog from an Ollama Cloud Edit action in both Settings layouts.

**Tech Stack:** TypeScript, Effect v4, SolidJS, Bun test, Electron, electron-builder.

## Global Constraints

- A saved Flynncode API key is authoritative over config and environment keys.
- Config and environment credentials remain fallbacks when no saved API key exists.
- Never display, pre-fill, log, return, or commit an API key.
- Do not rewrite `opencode.jsonc`, shell startup files, or environment variables.
- Disconnect removes saved auth and disables config-defined Ollama Cloud so stale fallbacks do not activate silently.
- Use existing localized copy where possible; do not add unverified translations.
- Do not restart the running app or server automatically.
- Build the next local package as `opencode-dev` version `1.18.34` and copy it to `~/Downloads`.

---

### Task 1: Make Saved API Auth Authoritative

**Files:**

- Modify: `packages/opencode/src/provider/provider.ts:1583-1612, 1664-1724, 1803-1851, 2100-2120`
- Modify: `packages/opencode/test/provider/provider.test.ts:2088-2168`
- Modify: `packages/opencode/test/server/httpapi-provider.test.ts:45-53, 350-410`

**Interfaces:**

- Consumes: `Info.source`, `Info.key`, `Info.options.apiKey`, and `Auth.Info` API credentials.
- Produces: `effectiveApiKey(input: { source: Info["source"]; key?: string; configured: unknown }): string | undefined` as a file-local provider helper.
- Produces: public provider objects with no own `key` property.

- [ ] **Step 1: Write failing provider precedence tests**

Extend the discovery test server so it records the authorization header:

```ts
const discoveryModelsServer = {
  server: null as ReturnType<typeof Bun.serve> | null,
  url: "",
  authorization: undefined as string | undefined,
  start() {
    if (this.server) return
    this.server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url)
        if (url.pathname === "/v1/models") {
          this.authorization = req.headers.get("authorization") ?? undefined
          return Response.json({ object: "list", data: [{ id: "server-model-a", object: "model" }] })
        }
        return new Response("not found", { status: 404 })
      },
    })
    this.url = `${this.server.url.origin}/v1`
  },
}
```

Add a test with a stale configured key and a different saved key:

```ts
it.instance(
  "saved API auth overrides a configured API key",
  Effect.gen(function* () {
    yield* setProcessEnv(
      "OPENCODE_AUTH_CONTENT",
      JSON.stringify({ "discovery-provider": { type: "api", key: "saved-key" } }),
    )
    discoveryModelsServer.authorization = undefined

    const provider = (yield* list)[ProviderV2.ID.make("discovery-provider")]
    expect(provider.source).toBe("api")
    expect(discoveryModelsServer.authorization).toBe("Bearer saved-key")

    const service = yield* Provider.Service
    const model = yield* service.getModel(ProviderV2.ID.make("discovery-provider"), ModelV2.ID.make("server-model-a"))
    const language = yield* service.getLanguage(model)
    expect((language as { config: { apiKey?: string } }).config.apiKey).toBe("saved-key")
  }),
  {
    config: () => ({
      provider: {
        "discovery-provider": {
          name: "Discovery Provider",
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "stale-config-key", baseURL: discoveryModelsServer.url },
          models: { "configured-model": { name: "Configured" } },
        },
      },
    }),
  },
)
```

- [ ] **Step 2: Write a failing public-response redaction test**

In `httpapi-provider.test.ts`, request `/provider` with `OPENCODE_AUTH_CONTENT` containing a sentinel API key. Assert the provider remains connected and reports source `api`, but neither the provider object nor its serialized response contains the sentinel:

```ts
const provider = providerByID(body, "all", "anthropic")
expect(provider).toBeDefined()
expect(isRecord(provider) && provider.source).toBe("api")
expect(isRecord(provider) && Object.hasOwn(provider, "key")).toBe(false)
expect(JSON.stringify(body)).not.toContain("saved-provider-secret")
```

- [ ] **Step 3: Run the tests and verify they fail for the stale-key behavior**

Run:

```bash
cd packages/opencode
bun test test/provider/provider.test.ts --test-name-pattern "saved API auth overrides"
bun test test/server/httpapi-provider.test.ts --test-name-pattern "provider API keys"
```

Expected: the precedence test observes `stale-config-key` or source `config`, and the response test finds the private `key` field.

- [ ] **Step 4: Implement one credential resolver and preserve API source**

Add this file-local helper near the provider state implementation:

```ts
function effectiveApiKey(input: { source: Info["source"]; key?: string; configured: unknown }) {
  if (input.source === "api" && input.key) return input.key
  if (typeof input.configured === "string") return input.configured
  return input.key
}
```

Use it for discovery:

```ts
const source = storedAuth?.type === "api" ? "api" : "config"
const key = effectiveApiKey({
  source,
  key: storedAuth?.type === "api" ? storedAuth.key : undefined,
  configured: provider.options?.apiKey,
})
const found = await ProviderDiscover.discover(baseURL, key)
```

When config metadata is re-applied, retain a previously established API source:

```ts
const partial: Partial<Info> = providers[providerID]?.source === "api" ? {} : { source: "config" }
```

Use the same resolver before SDK construction:

```ts
const apiKey = effectiveApiKey({ source: provider.source, key: provider.key, configured: options.apiKey })
if (apiKey !== undefined) options.apiKey = apiKey
```

Replace the old `if (options["apiKey"] === undefined && provider.key)` fallback.

- [ ] **Step 5: Redact credentials from public provider objects**

In `toPublicInfo`, override the private field before JSON serialization:

```ts
{
  ...provider,
  key: undefined,
  models: Object.fromEntries(Object.entries(provider.models).filter(([, model]) => Schema.is(Model)(model))),
}
```

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
cd packages/opencode
bun test test/provider/provider.test.ts --test-name-pattern "saved API auth overrides"
bun test test/server/httpapi-provider.test.ts --test-name-pattern "provider API keys"
bun typecheck
```

Expected: all commands pass and no output contains either sentinel key.

- [ ] **Step 7: Commit the provider fix**

```bash
git add packages/opencode/src/provider/provider.ts packages/opencode/test/provider/provider.test.ts packages/opencode/test/server/httpapi-provider.test.ts
git commit -m "fix(opencode): prefer saved provider credentials"
```

---

### Task 2: Add Ollama Cloud Key Replacement Controls

**Files:**

- Modify: `packages/app/src/hooks/provider-catalog.ts`
- Modify: `packages/app/src/hooks/provider-catalog.test.ts`
- Modify: `packages/app/src/components/settings-v2/providers.tsx:44-47, 161-188`
- Modify: `packages/app/src/components/settings-providers.tsx:47-50, 169-189`
- Modify: `packages/app/src/components/dialog-connect-provider.tsx:813-939`

**Interfaces:**

- Produces: `canReplaceProviderApiKey(providerID: string): boolean` in `provider-catalog.ts`.
- Consumes: the existing `connect(providerID)` path and `DialogConnectProvider` API-key method.
- Uses: existing localized `common.edit` copy and `data-action="provider-replace-api-key"` as the browser/test contract.

- [ ] **Step 1: Write the failing replacement-policy test**

Add to `provider-catalog.test.ts`:

```ts
test("only Ollama Cloud exposes API key replacement", () => {
  expect(canReplaceProviderApiKey("ollama-cloud")).toBe(true)
  expect(canReplaceProviderApiKey("ollama-local")).toBe(false)
  expect(canReplaceProviderApiKey("openai")).toBe(false)
})
```

Import `canReplaceProviderApiKey` from `./provider-catalog`.

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
cd packages/app
bun test --conditions=solid --preload ./happydom.ts ./src/hooks/provider-catalog.test.ts
```

Expected: FAIL because `canReplaceProviderApiKey` is not exported.

- [ ] **Step 3: Add the replacement policy**

Add to `provider-catalog.ts`:

```ts
export function canReplaceProviderApiKey(providerID: string) {
  return providerID === "ollama-cloud"
}
```

- [ ] **Step 4: Add Edit actions to both Settings layouts**

Import the policy beside `completeProviderConnection`. In each connected-provider row, wrap the actions in an existing flex container and render:

```tsx
<Show when={canReplaceProviderApiKey(item.id)}>
  <ButtonV2 size="normal" variant="ghost-muted" data-action="provider-replace-api-key" onClick={() => connect(item.id)}>
    {language.t("common.edit")}
  </ButtonV2>
</Show>
```

Use the legacy `Button` variants in `settings-providers.tsx`. Keep Disconnect beside Edit and preserve the environment-source fallback hint for providers that cannot disconnect.

- [ ] **Step 5: Mask API-key inputs**

Set `type="password"` on both the V2 `TextInputV2` and classic `TextField` API-key controls. Keep `autocomplete="off"`, required validation, and empty initial values unchanged.

- [ ] **Step 6: Run focused app tests and typecheck**

Run:

```bash
cd packages/app
bun test --conditions=solid --preload ./happydom.ts ./src/hooks/provider-catalog.test.ts
bun run test:unit
bun run test:browser
bun typecheck
```

Expected: all tests and typecheck pass.

- [ ] **Step 7: Commit the Settings flow**

```bash
git add packages/app/src/hooks/provider-catalog.ts packages/app/src/hooks/provider-catalog.test.ts packages/app/src/components/settings-v2/providers.tsx packages/app/src/components/settings-providers.tsx packages/app/src/components/dialog-connect-provider.tsx
git commit -m "feat(app): replace Ollama Cloud API keys"
```

---

### Task 3: Verify and Package Revision 1.18.34

**Files:**

- Verify: `packages/opencode`
- Verify: `packages/app`
- Verify: `packages/session-ui`
- Verify: `packages/desktop`
- Build artifact: `packages/desktop/dist/opencode-desktop-linux-amd64.deb`
- Copy artifact: `~/Downloads/opencode-dev_1.18.34_amd64.deb`

**Interfaces:**

- Consumes: the committed provider and Settings changes from Tasks 1 and 2.
- Produces: a validated Debian package with package name `opencode-dev`, version `1.18.34`, architecture `amd64`.

- [ ] **Step 1: Run complete verification**

Run from each package directory, never from the repository root:

```bash
cd packages/opencode && bun test test/provider/provider.test.ts test/server/httpapi-provider.test.ts && bun typecheck
cd packages/app && bun run test:unit && bun run test:browser && bun typecheck
cd packages/session-ui && bun typecheck
cd packages/desktop && bun typecheck
```

Expected: zero test failures and zero type errors.

- [ ] **Step 2: Verify formatting and repository state**

Run:

```bash
git diff --check
git status --short
git log --oneline -10
```

Expected: no unstaged source changes and the two implementation commits are at HEAD.

- [ ] **Step 3: Build the complete desktop application**

From `packages/desktop`:

```bash
OPENCODE_CHANNEL=dev bun run build
```

Expected: embedded opencode server, desktop main/preload, and renderer builds complete successfully.

- [ ] **Step 4: Package the requested DEB as revision 1.18.34**

Temporarily set `packages/desktop/package.json` version to `1.18.34`, then run:

```bash
OPENCODE_CHANNEL=dev bunx electron-builder --linux deb --config electron-builder.config.ts
```

Restore `packages/desktop/package.json` to its committed version immediately after packaging. Do not commit the temporary packaging version.

- [ ] **Step 5: Validate and copy the artifact**

Run:

```bash
dpkg-deb --show dist/opencode-desktop-linux-amd64.deb '${Package}\t${Version}\t${Architecture}\n'
dpkg-deb --contents dist/opencode-desktop-linux-amd64.deb >/dev/null
sha256sum dist/opencode-desktop-linux-amd64.deb
cp --preserve=timestamps dist/opencode-desktop-linux-amd64.deb ~/Downloads/opencode-dev_1.18.34_amd64.deb
cmp --silent dist/opencode-desktop-linux-amd64.deb ~/Downloads/opencode-dev_1.18.34_amd64.deb
```

Expected metadata: `opencode-dev`, `1.18.34`, `amd64`; `cmp` exits 0.

- [ ] **Step 6: Final verification and handoff**

Run:

```bash
git status --short
sha256sum ~/Downloads/opencode-dev_1.18.34_amd64.deb
```

Expected: clean worktree and the copied artifact checksum matches Step 5. Tell the user to install the package, fully quit/reopen Flynncode, open Settings > Providers, click Edit for Ollama Cloud, and enter the new key once more. Do not request or print the key.
