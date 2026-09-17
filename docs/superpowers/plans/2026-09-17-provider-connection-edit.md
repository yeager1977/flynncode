# Provider Connection Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user edit the connection settings of any connected provider from the v2 Settings providers page.

**Architecture:** Add a server-side config-patch exception so a `provider` entry replaces that provider's subtree (needed so removing a header or blanking a base URL persists). Add a pure helper module for prefill, auth-kind detection, validation, and patch building. Add a new `DialogEditProvider` component and open it from every connected row on the v2 settings page under the v1 protocol.

**Tech Stack:** TypeScript, SolidJS, Effect, Bun test, existing `@opencode-ai/ui` dialog primitives, existing i18n parity machinery.

## Global Constraints

- Never hardcode user-visible English strings. Use `language.t(...)` keys and mirror every new key across all locale dictionaries in `packages/app/src/i18n/`.
- The i18n parity test requires every locale to contain every English key and preserve placeholders.
- Edit is available only under the v1 protocol. The app reads and writes config only under v1.
- Secrets must never be displayed, pre-filled, logged, or included in error messages. The API key field is write-only.
- No new runtime dependencies.
- Edits persist to global config (`global.config.update`), matching `DialogCustomProvider`.
- Do not run tests from the repo root. Run from package directories.
- Do not use `export namespace`, star imports, or aliased imports.

---

### Task 1: Replace provider subtrees in global config patches

**Files:**
- Modify: `packages/opencode/src/config/config.ts:150-174` (`patchJsonc`)
- Modify: `packages/opencode/src/config/config.ts:668-696` (`updateGlobal`)
- Create: `packages/opencode/test/config/fixtures/v2-compat/update-global/provider-replace-input.jsonc`
- Create: `packages/opencode/test/config/fixtures/v2-compat/update-global/provider-replace-patch.json`
- Create (generated): `packages/opencode/test/config/fixtures/v2-compat/update-global/provider-replace-output.jsonc`
- Create (generated): `packages/opencode/test/config/fixtures/v2-compat/update-global/provider-replace-normalized.json`
- Create: `packages/opencode/test/config/fixtures/v2-compat/update-global/provider-replace-json-input.json`
- Create: `packages/opencode/test/config/fixtures/v2-compat/update-global/provider-replace-json-patch.json`
- Create (generated): `packages/opencode/test/config/fixtures/v2-compat/update-global/provider-replace-json-output.json`
- Create (generated): `packages/opencode/test/config/fixtures/v2-compat/update-global/provider-replace-json-normalized.json`
- Test: `packages/opencode/test/config/config.test.ts` (existing fixture runner at lines 443-462 discovers the new fixtures automatically)

**Interfaces:**
- Consumes: existing `mergeDeep` (remeda), `isRecord` (`@/util/record`), `modify`/`applyEdits` (`jsonc-parser`).
- Produces: `updateGlobal` semantics where a patch containing `provider: { <id>: <entry> }` replaces each named provider's subtree while preserving sibling providers and all other config keys.

- [ ] **Step 1: Write the failing fixtures**

Create `packages/opencode/test/config/fixtures/v2-compat/update-global/provider-replace-input.jsonc`. This input has an `example` provider with headers, a base URL, an API key, and models, plus an `other` provider that must survive untouched:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  // The provider entry for `example` is replaced as a whole, so removed headers disappear.
  "username": "before",
  "provider": {
    "example": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Example",
      "options": {
        "baseURL": "https://old.example.com/v1",
        "apiKey": "fixture-secret",
        "headers": { "X-Old": "old" }
      },
      "models": { "old-model": { "name": "Old Model" } }
    },
    "other": {
      "options": { "baseURL": "https://other.example.com/v1" }
    }
  }
}
```

Create `packages/opencode/test/config/fixtures/v2-compat/update-global/provider-replace-patch.json`. The `example` entry is complete (as the edit dialog will send it), omits the old headers and old model, and includes a new base URL and new model:

```json
{
  "provider": {
    "example": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Example",
      "options": {
        "apiKey": "fixture-secret",
        "baseURL": "https://new.example.com/v1"
      },
      "models": { "new-model": { "name": "New Model" } }
    }
  }
}
```

Create the non-jsonc input `packages/opencode/test/config/fixtures/v2-compat/update-global/provider-replace-json-input.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "username": "before",
  "provider": {
    "example": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Example",
      "options": {
        "baseURL": "https://old.example.com/v1",
        "apiKey": "fixture-secret",
        "headers": { "X-Old": "old" }
      }
    },
    "other": {
      "options": { "baseURL": "https://other.example.com/v1" }
    }
  }
}
```

Create `packages/opencode/test/config/fixtures/v2-compat/update-global/provider-replace-json-patch.json`:

```json
{
  "provider": {
    "example": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Example",
      "options": {
        "apiKey": "fixture-secret",
        "baseURL": "https://new.example.com/v1"
      }
    }
  }
}
```

- [ ] **Step 2: Generate expected outputs and confirm the failure**

Run from `packages/opencode`:

```sh
UPDATE_CONFIG_FIXTURES=1 bun test test/config/config.test.ts test/config/v2-compat.test.ts --timeout 30000
```

Expected: the new fixtures run and write their `-output.*` and `-normalized.json` files. Inspect `provider-replace-output.jsonc` and confirm the current (unfixed) behavior keeps `"headers": { "X-Old": "old" }` and keeps `old-model`, because `patchJsonc` only writes leaves present in the patch. This is the bug the next step fixes.

Also inspect `provider-replace-json-output.json` and confirm `mergeDeep` keeps the old base URL/headers for the same reason.

- [ ] **Step 3: Implement provider subtree replacement in `patchJsonc`**

In `packages/opencode/src/config/config.ts`, add a `provider` branch next to the existing `model_router` branch in `patchJsonc`:

```ts
function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
  if (!isRecord(patch)) {
    const edits = modify(input, path, patch, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    return applyEdits(input, edits)
  }

  return Object.entries(patch).reduce((result, [key, value]) => {
    // model_router is swapped as a whole subtree so removing nested keys (e.g. scorecard models) persists.
    if (path.length === 0 && key === "model_router") {
      const edits = modify(result, [key], value, {
        formattingOptions: {
          insertSpaces: true,
          tabSize: 2,
        },
      })
      return applyEdits(result, edits)
    }
    // A provider entry is swapped as a whole subtree so removed headers, models,
    // and a cleared base URL persist, while sibling providers stay untouched.
    if (path.length === 0 && key === "provider" && isRecord(value)) {
      return Object.entries(value).reduce((current, [id, entry]) => {
        const edits = modify(current, [key, id], entry, {
          formattingOptions: {
            insertSpaces: true,
            tabSize: 2,
          },
        })
        return applyEdits(current, edits)
      }, result)
    }
    return patchJsonc(result, value, [...path, key])
  }, input)
}
```

- [ ] **Step 4: Implement provider subtree replacement in `updateGlobal`**

In `packages/opencode/src/config/config.ts`, replace the inline `model_router` conditional in `updateGlobal` with a shared helper. Add this helper above `patchJsonc` (after `globalConfigFile`):

```ts
function mergeWholeSubtrees(base: Record<string, unknown>, patch: Record<string, unknown>) {
  const merged = mergeDeep(base, patch) as Record<string, unknown>
  // model_router is swapped as a whole subtree so removing nested keys (e.g. scorecard models) persists.
  if (Object.hasOwn(patch, "model_router")) merged.model_router = patch.model_router
  // A provider entry is swapped as a whole subtree so removed headers, models,
  // and a cleared base URL persist, while sibling providers stay untouched.
  if (isRecord(patch.provider)) {
    merged.provider = {
      ...(isRecord(base.provider) ? base.provider : {}),
      ...patch.provider,
    }
  }
  return merged
}
```

Then in `updateGlobal`, replace these lines:

```ts
        // model_router is swapped as a whole subtree so removing nested keys (e.g. scorecard models) persists.
        const merged = Object.hasOwn(patch, "model_router")
          ? { ...mergeDeep(base, patch), model_router: patch.model_router }
          : mergeDeep(base, patch)
```

with:

```ts
        const merged = mergeWholeSubtrees(base, patch)
```

- [ ] **Step 5: Regenerate outputs and verify they are correct**

Run from `packages/opencode`:

```sh
UPDATE_CONFIG_FIXTURES=1 bun test test/config/config.test.ts test/config/v2-compat.test.ts --timeout 30000
```

Inspect `packages/opencode/test/config/fixtures/v2-compat/update-global/provider-replace-output.jsonc`. Verify:
- `example` no longer has `X-Old` headers.
- `example` has `"baseURL": "https://new.example.com/v1"`.
- `example.models` is `{ "new-model": { "name": "New Model" } }` only.
- `other` is byte-identical to the input.
- The comment and `username` line are preserved.

Inspect `provider-replace-json-output.json` and verify the same `example` replacement and untouched `other`.

- [ ] **Step 6: Run the config tests without regeneration**

Run from `packages/opencode`:

```sh
bun test test/config/config.test.ts test/config/v2-compat.test.ts --timeout 30000
```

Expected: PASS. The checked-in fixtures now assert the fixed behavior.

- [ ] **Step 7: Commit**

```bash
git add packages/opencode/src/config/config.ts packages/opencode/test/config/fixtures/v2-compat/update-global packages/opencode/test/config/config.test.ts
git commit -m "fix(opencode): replace provider config subtrees on update"
```

---

### Task 2: Add pure provider connection edit helpers

**Files:**
- Create: `packages/app/src/hooks/provider-connection-edit.ts`
- Test: `packages/app/src/hooks/provider-connection-edit.test.ts`

**Interfaces:**
- Consumes: `headerRow`, `modelRow`, and the `HeaderRow`/`ModelRow` types from `@/components/dialog-custom-provider-form`.
- Produces:
  - `isConfigCustomProvider(entry: unknown): boolean`
  - `providerAuthKind(source: string | undefined): "env" | "api" | "oauth"`
  - `canEditProvider(protocol: "v1" | "v2"): boolean`
  - `providerEditPrefill(input: { provider: unknown; configCustom: boolean }): { baseURL: string; headers: HeaderRow[]; models: ModelRow[] }`
  - `validateProviderEdit(input: { form: EditForm; t: Translator; configCustom: boolean; existing: unknown }): { err: { baseURL?: string }; headers: { key?: string; value?: string }[]; models: ModelErr[]; result?: { key?: string; provider?: Record<string, unknown> } }`
  - `EditForm` type: `{ baseURL: string; apiKey: string; headers: HeaderRow[]; models: ModelRow[] }`

- [ ] **Step 1: Write the failing tests**

Create `packages/app/src/hooks/provider-connection-edit.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import {
  canEditProvider,
  isConfigCustomProvider,
  providerAuthKind,
  providerEditPrefill,
  validateProviderEdit,
} from "./provider-connection-edit"

const t = (key: string) => key

const customEntry = {
  npm: "@ai-sdk/openai-compatible",
  name: "Example",
  options: {
    baseURL: "https://api.example.com/v1",
    apiKey: "config-secret",
    headers: { "X-Test": "enabled" },
  },
  models: { "model-a": { name: "Model A" } },
}

describe("providerAuthKind", () => {
  test("maps provider sources to edit auth kinds", () => {
    expect(providerAuthKind("env")).toBe("env")
    expect(providerAuthKind("custom")).toBe("oauth")
    expect(providerAuthKind("api")).toBe("api")
    expect(providerAuthKind("config")).toBe("api")
    expect(providerAuthKind(undefined)).toBe("api")
  })
})

describe("canEditProvider", () => {
  test("allows editing only under the v1 protocol", () => {
    expect(canEditProvider("v1")).toBe(true)
    expect(canEditProvider("v2")).toBe(false)
  })
})

describe("isConfigCustomProvider", () => {
  test("requires the openai-compatible package and a non-empty model list", () => {
    expect(isConfigCustomProvider(customEntry)).toBe(true)
    expect(isConfigCustomProvider({ ...customEntry, models: {} })).toBe(false)
    expect(isConfigCustomProvider({ ...customEntry, npm: "@ai-sdk/anthropic" })).toBe(false)
    expect(isConfigCustomProvider(undefined)).toBe(false)
  })
})

describe("providerEditPrefill", () => {
  test("extracts base URL, headers, and models for a custom provider", () => {
    const result = providerEditPrefill({ provider: customEntry, configCustom: true })

    expect(result.baseURL).toBe("https://api.example.com/v1")
    expect(result.headers.map((h) => [h.key, h.value])).toEqual([["X-Test", "enabled"]])
    expect(result.models.map((m) => [m.id, m.name])).toEqual([["model-a", "Model A"]])
  })

  test("omits models for a built-in provider", () => {
    const result = providerEditPrefill({ provider: customEntry, configCustom: false })

    expect(result.models).toEqual([])
  })

  test("returns empty values for a provider with no config entry", () => {
    const result = providerEditPrefill({ provider: undefined, configCustom: false })

    expect(result.baseURL).toBe("")
    expect(result.headers).toEqual([])
    expect(result.models).toEqual([])
  })
})

describe("validateProviderEdit", () => {
  test("allows an empty base URL for a built-in provider and preserves existing options", () => {
    const result = validateProviderEdit({
      form: {
        baseURL: "",
        apiKey: "",
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        models: [],
      },
      t,
      configCustom: false,
      existing: customEntry,
    })

    expect(result.err.baseURL).toBeUndefined()
    expect(result.result?.key).toBeUndefined()
    expect(result.result?.provider).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "Example",
      options: { apiKey: "config-secret" },
      models: { "model-a": { name: "Model A" } },
    })
  })

  test("requires a base URL for a custom provider", () => {
    const result = validateProviderEdit({
      form: {
        baseURL: "  ",
        apiKey: "",
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        models: [{ row: "m0", id: "model-a", name: "Model A", err: {} }],
      },
      t,
      configCustom: true,
      existing: customEntry,
    })

    expect(result.result).toBeUndefined()
    expect(result.err.baseURL).toBe("provider.custom.error.baseURL.required")
  })

  test("flags a malformed base URL", () => {
    const result = validateProviderEdit({
      form: {
        baseURL: "api.example.com",
        apiKey: "",
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        models: [],
      },
      t,
      configCustom: false,
      existing: undefined,
    })

    expect(result.result).toBeUndefined()
    expect(result.err.baseURL).toBe("provider.custom.error.baseURL.format")
  })

  test("flags duplicate headers and duplicate models", () => {
    const result = validateProviderEdit({
      form: {
        baseURL: "https://api.example.com/v1",
        apiKey: "",
        headers: [
          { row: "h0", key: "Authorization", value: "one", err: {} },
          { row: "h1", key: "authorization", value: "two", err: {} },
        ],
        models: [
          { row: "m0", id: "model-a", name: "Model A", err: {} },
          { row: "m1", id: "model-a", name: "Model A 2", err: {} },
        ],
      },
      t,
      configCustom: true,
      existing: customEntry,
    })

    expect(result.result).toBeUndefined()
    expect(result.headers[1]).toEqual({ key: "provider.custom.error.duplicate", value: undefined })
    expect(result.models[1]).toEqual({ id: "provider.custom.error.duplicate", name: undefined })
  })

  test("moves an entered key to the auth store and drops the config apiKey", () => {
    const result = validateProviderEdit({
      form: {
        baseURL: "https://api.example.com/v1",
        apiKey: "new-secret",
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        models: [{ row: "m0", id: "model-a", name: "Model A", err: {} }],
      },
      t,
      configCustom: true,
      existing: customEntry,
    })

    expect(result.result?.key).toBe("new-secret")
    expect(result.result?.provider).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "Example",
      options: { baseURL: "https://api.example.com/v1" },
      models: { "model-a": { name: "Model A" } },
    })
  })

  test("removes headers when the header rows are cleared", () => {
    const result = validateProviderEdit({
      form: {
        baseURL: "https://api.example.com/v1",
        apiKey: "",
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        models: [{ row: "m0", id: "model-a", name: "Model A", err: {} }],
      },
      t,
      configCustom: true,
      existing: customEntry,
    })

    expect(result.result?.provider.options).toEqual({
      apiKey: "config-secret",
      baseURL: "https://api.example.com/v1",
    })
  })

  test("omits the provider entry for a built-in provider with no config and only a key", () => {
    const result = validateProviderEdit({
      form: {
        baseURL: "",
        apiKey: "new-secret",
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        models: [],
      },
      t,
      configCustom: false,
      existing: undefined,
    })

    expect(result.result).toEqual({ key: "new-secret" })
  })

  test("omits both the provider entry and key when nothing changed", () => {
    const result = validateProviderEdit({
      form: {
        baseURL: "",
        apiKey: "",
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        models: [],
      },
      t,
      configCustom: false,
      existing: undefined,
    })

    expect(result.result).toEqual({ key: undefined })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `packages/app`:

```sh
bun test --conditions=solid --preload ./happydom.ts src/hooks/provider-connection-edit.test.ts
```

Expected: FAIL with "Cannot find module './provider-connection-edit'".

- [ ] **Step 3: Write the helper module**

Create `packages/app/src/hooks/provider-connection-edit.ts`:

```ts
import {
  headerRow,
  modelRow,
  type HeaderRow,
  type ModelErr,
  type ModelRow,
} from "@/components/dialog-custom-provider-form"

const OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible"

type Translator = (key: string, vars?: Record<string, string | number | boolean>) => string

export type EditForm = {
  baseURL: string
  apiKey: string
  headers: HeaderRow[]
  models: ModelRow[]
}

export type ProviderAuthKind = "env" | "api" | "oauth"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isConfigCustomProvider(entry: unknown) {
  if (!isRecord(entry)) return false
  if (entry.npm !== OPENAI_COMPATIBLE) return false
  if (!isRecord(entry.models) || Object.keys(entry.models).length === 0) return false
  return true
}

export function providerAuthKind(source: string | undefined): ProviderAuthKind {
  if (source === "env") return "env"
  if (source === "custom") return "oauth"
  return "api"
}

export function canEditProvider(protocol: "v1" | "v2") {
  return protocol === "v1"
}

export function providerEditPrefill(input: { provider: unknown; configCustom: boolean }) {
  const provider = isRecord(input.provider) ? input.provider : undefined
  const options = provider && isRecord(provider.options) ? provider.options : {}

  const baseURL = typeof options.baseURL === "string" ? options.baseURL : ""
  const headers = isRecord(options.headers)
    ? Object.entries(options.headers)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([key, value]) => ({ ...headerRow(), key, value }))
    : []
  const models =
    input.configCustom && provider && isRecord(provider.models)
      ? Object.entries(provider.models).map(([id, model]) => ({
          ...modelRow(),
          id,
          name: isRecord(model) && typeof model.name === "string" ? model.name : "",
        }))
      : []

  return { baseURL, headers, models }
}

export function validateProviderEdit(input: {
  form: EditForm
  t: Translator
  configCustom: boolean
  existing: unknown
}) {
  const baseURL = input.form.baseURL.trim()
  const apiKey = input.form.apiKey.trim()

  const urlError =
    input.configCustom && !baseURL
      ? input.t("provider.custom.error.baseURL.required")
      : baseURL && !/^https?:\/\//.test(baseURL)
        ? input.t("provider.custom.error.baseURL.format")
        : undefined

  const seenHeaders = new Set<string>()
  const headers = input.form.headers.map((h) => {
    const key = h.key.trim()
    const value = h.value.trim()

    if (!key && !value) return {}
    const keyError = !key
      ? input.t("provider.custom.error.required")
      : seenHeaders.has(key.toLowerCase())
        ? input.t("provider.custom.error.duplicate")
        : (() => {
            seenHeaders.add(key.toLowerCase())
            return undefined
          })()
    const valueError = !value ? input.t("provider.custom.error.required") : undefined
    return { key: keyError, value: valueError }
  })
  const headersValid = headers.every((h) => !h.key && !h.value)
  const headerConfig = Object.fromEntries(
    input.form.headers
      .map((h) => ({ key: h.key.trim(), value: h.value.trim() }))
      .filter((h) => !!h.key && !!h.value)
      .map((h) => [h.key, h.value]),
  )

  const seenModels = new Set<string>()
  const models = input.configCustom
    ? input.form.models.map((m) => {
        const id = m.id.trim()
        const idError = !id
          ? input.t("provider.custom.error.required")
          : seenModels.has(id)
            ? input.t("provider.custom.error.duplicate")
            : (() => {
                seenModels.add(id)
                return undefined
              })()
        const nameError = !m.name.trim() ? input.t("provider.custom.error.required") : undefined
        return { id: idError, name: nameError }
      })
    : input.form.models.map((): ModelErr => ({}))
  const modelsValid = models.every((m) => !m.id && !m.name)
  const modelConfig = Object.fromEntries(input.form.models.map((m) => [m.id.trim(), { name: m.name.trim() }]))

  const err = { baseURL: urlError }
  const ok = !urlError && headersValid && modelsValid
  if (!ok) return { err, headers, models }

  const existing = isRecord(input.existing) ? input.existing : {}
  const existingOptions = isRecord(existing.options) ? existing.options : {}
  const options: Record<string, unknown> = { ...existingOptions }
  if (baseURL) options.baseURL = baseURL
  else delete options.baseURL
  if (Object.keys(headerConfig).length) options.headers = headerConfig
  else delete options.headers

  const key = apiKey || undefined
  if (key) delete options.apiKey

  const provider: Record<string, unknown> = { ...existing, options }
  if (input.configCustom) provider.models = modelConfig

  // Only persist a provider entry when there is a config entry to update or
  // something to write. Writing an empty entry for a built-in provider with no
  // config would flip its effective source from `api` to `config`.
  const hasSomething = Object.keys(existing).length > 0 || !!baseURL || !!key || Object.keys(headerConfig).length > 0
  if (!hasSomething) return { err, headers, models, result: { key } }

  return { err, headers, models, result: { key, provider } }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run from `packages/app`:

```sh
bun test --conditions=solid --preload ./happydom.ts src/hooks/provider-connection-edit.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/hooks/provider-connection-edit.ts packages/app/src/hooks/provider-connection-edit.test.ts
git commit -m "feat(app): add provider connection edit helpers"
```

---

### Task 3: Add edit-provider i18n keys across all locales

**Files:**
- Modify: `packages/app/src/i18n/en.ts` (after the `provider.custom.error.duplicate` line, around line 211)
- Create: `packages/app/src/i18n/provider-edit-fallback.ts`
- Modify: every `packages/app/src/i18n/<locale>.ts` that spreads `...modelRouterFallback` (all locales except `en.ts`)
- Test: `packages/app/src/i18n/parity.test.ts` (existing, no changes needed)

**Interfaces:**
- Consumes: `dict` from `@/i18n/en`.
- Produces: keys `provider.edit.title`, `provider.edit.auth.oauth`, `provider.edit.auth.useApiKey`, `provider.edit.apiKey.description`, `provider.edit.toast.saved.title`, `provider.edit.toast.saved.description`.

- [ ] **Step 1: Add the English keys**

In `packages/app/src/i18n/en.ts`, directly after the `"provider.custom.error.duplicate"` line, add:

```ts
  "provider.edit.title": "Edit {{provider}}",
  "provider.edit.auth.oauth": "Connected with OAuth",
  "provider.edit.auth.useApiKey": "Use an API key instead",
  "provider.edit.apiKey.description": "Leave empty to keep the current key.",
  "provider.edit.toast.saved.title": "{{provider}} updated",
  "provider.edit.toast.saved.description": "Your provider connection settings were saved.",
```

- [ ] **Step 2: Run the parity test to verify it fails**

Run from `packages/app`:

```sh
bun test --conditions=solid --preload ./happydom.ts src/i18n/parity.test.ts
```

Expected: FAIL. Every locale is reported as `missing` the six new `provider.edit.*` keys.

- [ ] **Step 3: Create the English fallback module**

Create `packages/app/src/i18n/provider-edit-fallback.ts`, mirroring the existing `model-router-fallback.ts` pattern:

```ts
import { dict } from "./en"

// Provider-edit translations are pending. Locale entries override this explicit
// English fallback as verified translations become available.
export const providerEditFallback = Object.fromEntries(
  Object.entries(dict).filter(([key]) => key.startsWith("provider.edit.")),
)
```

- [ ] **Step 4: Spread the fallback into every locale**

Run from the repo root. This inserts the import and the spread into every locale file that already uses the model-router fallback, and it is idempotent to inspect afterwards:

```sh
cd packages/app/src/i18n
for f in $(grep -l '\.\.\.modelRouterFallback,' *.ts); do
  perl -0pi -e 's/(import \{ modelRouterFallback \} from "\.\/model-router-fallback"\n)/$1import { providerEditFallback } from ".\/provider-edit-fallback"\n/' "$f"
  perl -0pi -e 's/(\.\.\.modelRouterFallback,\n)/$1  ...providerEditFallback,\n/' "$f"
done
```

- [ ] **Step 5: Verify the wiring and run the parity test**

Run from the repo root:

```sh
grep -c "providerEditFallback" packages/app/src/i18n/*.ts | grep -v ":2" || true
```

Expected: no output. Every file that has the import also has the spread (count 2).

Run from `packages/app`:

```sh
bun test --conditions=solid --preload ./happydom.ts src/i18n/parity.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/i18n
git commit -m "feat(app): add provider edit locale keys"
```

---

### Task 4: Build the edit provider dialog

**Files:**
- Create: `packages/app/src/components/dialog-edit-provider.tsx`

**Interfaces:**
- Consumes: `isConfigCustomProvider`, `providerAuthKind`, `providerEditPrefill`, `validateProviderEdit` from `@/hooks/provider-connection-edit`; `headerRow`, `modelRow` from `@/components/dialog-custom-provider-form`; `useServerSync`, `useServerSDK`, `useLanguage`, `useDialog`, `showToast`.
- Produces: `DialogEditProvider` component accepting `{ providerID: string; providerName: string; source?: string; onBack: () => void }`.

- [ ] **Step 1: Write the component**

Create `packages/app/src/components/dialog-edit-provider.tsx`:

```tsx
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { useMutation } from "@tanstack/solid-query"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@/utils/toast"
import { batch, For, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { headerRow, modelRow, type FormState } from "./dialog-custom-provider-form"
import {
  isConfigCustomProvider,
  providerAuthKind,
  providerEditPrefill,
  validateProviderEdit,
} from "@/hooks/provider-connection-edit"

type Props = {
  providerID: string
  providerName: string
  source?: string
  onBack: () => void
}

export function DialogEditProvider(props: Props) {
  const language = useLanguage()

  return (
    <Dialog
      class="h-full"
      title={
        <IconButton
          tabIndex={-1}
          icon="arrow-left"
          variant="ghost"
          onClick={props.onBack}
          aria-label={language.t("common.goBack")}
        />
      }
      transition
    >
      <EditProviderForm {...props} />
    </Dialog>
  )
}

function EditProviderForm(props: Props) {
  const dialog = useDialog()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const language = useLanguage()

  const entry = () => serverSync().data.config.provider?.[props.providerID]
  const configCustom = () => isConfigCustomProvider(entry())
  const authKind = () => providerAuthKind(props.source)
  const prefill = providerEditPrefill({ provider: entry(), configCustom: configCustom() })

  const [form, setForm] = createStore<FormState>({
    providerID: props.providerID,
    name: props.providerName,
    baseURL: prefill.baseURL,
    apiKey: "",
    models: prefill.models.length ? prefill.models : [modelRow()],
    headers: prefill.headers.length ? prefill.headers : [headerRow()],
    err: {},
  })
  const [ui, setUi] = createStore({ revealKey: authKind() !== "oauth" })

  const addModel = () => {
    setForm(
      "models",
      produce((rows) => {
        rows.push(modelRow())
      }),
    )
  }

  const removeModel = (index: number) => {
    if (form.models.length <= 1) return
    setForm(
      "models",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
  }

  const addHeader = () => {
    setForm(
      "headers",
      produce((rows) => {
        rows.push(headerRow())
      }),
    )
  }

  const removeHeader = (index: number) => {
    if (form.headers.length <= 1) return
    setForm(
      "headers",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
  }

  const setField = (key: "baseURL" | "apiKey", value: string) => {
    setForm(key, value)
    if (key === "apiKey") return
    setForm("err", key, undefined)
  }

  const setModel = (index: number, key: "id" | "name", value: string) => {
    batch(() => {
      setForm("models", index, key, value)
      setForm("models", index, "err", key, undefined)
    })
  }

  const setHeader = (index: number, key: "key" | "value", value: string) => {
    batch(() => {
      setForm("headers", index, key, value)
      setForm("headers", index, "err", key, undefined)
    })
  }

  const validate = () => {
    const output = validateProviderEdit({
      form: {
        baseURL: form.baseURL,
        apiKey: form.apiKey,
        headers: form.headers,
        models: form.models,
      },
      t: language.t,
      configCustom: configCustom(),
      existing: entry(),
    })
    batch(() => {
      setForm("err", output.err)
      output.models.forEach((err, index) => setForm("models", index, "err", err))
      output.headers.forEach((err, index) => setForm("headers", index, "err", err))
    })
    return output.result
  }

  const saveMutation = useMutation(() => ({
    mutationFn: async (result: NonNullable<ReturnType<typeof validate>>) => {
      if (result.key) {
        await serverSDK().client.auth.set({
          providerID: props.providerID,
          auth: { type: "api", key: result.key },
        })
      }
      const disabled = serverSync().data.config.disabled_providers ?? []
      await serverSync().updateConfig({
        ...(result.provider ? { provider: { [props.providerID]: result.provider } } : {}),
        disabled_providers: disabled.filter((id) => id !== props.providerID),
      })
    },
    onSuccess: () => {
      dialog.close()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("provider.edit.toast.saved.title", { provider: props.providerName }),
        description: language.t("provider.edit.toast.saved.description", { provider: props.providerName }),
      })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("common.requestFailed"), description: message })
    },
  }))

  const save = (e: SubmitEvent) => {
    e.preventDefault()
    if (saveMutation.isPending) return

    const result = validate()
    if (!result) return
    saveMutation.mutate(result)
  }

  return (
    <div class="flex flex-col gap-6 px-2.5 pb-3 overflow-y-auto max-h-[60vh]">
      <div class="px-2.5 flex gap-4 items-center">
        <ProviderIcon id={props.providerID} class="size-5 shrink-0 icon-strong-base" />
        <div class="text-16-medium text-text-strong">
          {language.t("provider.edit.title", { provider: props.providerName })}
        </div>
      </div>

      <form onSubmit={save} class="px-2.5 pb-6 flex flex-col gap-6">
        <div class="flex flex-col gap-4">
          <Show when={authKind() === "env"}>
            <p class="text-14-regular text-text-base">
              {language.t("settings.providers.connected.environmentDescription")}
            </p>
          </Show>

          <Show when={authKind() === "oauth" && !ui.revealKey}>
            <div class="flex flex-col gap-2">
              <p class="text-14-regular text-text-base">{language.t("provider.edit.auth.oauth")}</p>
              <Button
                type="button"
                size="small"
                variant="ghost"
                class="self-start"
                onClick={() => setUi("revealKey", true)}
              >
                {language.t("provider.edit.auth.useApiKey")}
              </Button>
            </div>
          </Show>

          <Show when={authKind() !== "env" && ui.revealKey}>
            <TextField
              label={language.t("provider.custom.field.apiKey.label")}
              placeholder={language.t("provider.custom.field.apiKey.placeholder")}
              description={language.t("provider.edit.apiKey.description")}
              value={form.apiKey}
              onChange={(v) => setField("apiKey", v)}
            />
          </Show>

          <TextField
            label={language.t("provider.custom.field.baseURL.label")}
            placeholder={language.t("provider.custom.field.baseURL.placeholder")}
            value={form.baseURL}
            onChange={(v) => setField("baseURL", v)}
            validationState={form.err.baseURL ? "invalid" : undefined}
            error={form.err.baseURL}
          />
        </div>

        <Show when={configCustom()}>
          <div class="flex flex-col gap-3">
            <label class="text-12-medium text-text-weak">{language.t("provider.custom.models.label")}</label>
            <For each={form.models}>
              {(m, i) => (
                <div class="flex gap-2 items-start" data-row={m.row}>
                  <div class="flex-1">
                    <TextField
                      label={language.t("provider.custom.models.id.label")}
                      hideLabel
                      placeholder={language.t("provider.custom.models.id.placeholder")}
                      value={m.id}
                      onChange={(v) => setModel(i(), "id", v)}
                      validationState={m.err.id ? "invalid" : undefined}
                      error={m.err.id}
                    />
                  </div>
                  <div class="flex-1">
                    <TextField
                      label={language.t("provider.custom.models.name.label")}
                      hideLabel
                      placeholder={language.t("provider.custom.models.name.placeholder")}
                      value={m.name}
                      onChange={(v) => setModel(i(), "name", v)}
                      validationState={m.err.name ? "invalid" : undefined}
                      error={m.err.name}
                    />
                  </div>
                  <IconButton
                    type="button"
                    icon="trash"
                    variant="ghost"
                    class="mt-1.5"
                    onClick={() => removeModel(i())}
                    disabled={form.models.length <= 1}
                    aria-label={language.t("provider.custom.models.remove")}
                  />
                </div>
              )}
            </For>
            <Button type="button" size="small" variant="ghost" icon="plus-small" onClick={addModel} class="self-start">
              {language.t("provider.custom.models.add")}
            </Button>
          </div>
        </Show>

        <div class="flex flex-col gap-3">
          <label class="text-12-medium text-text-weak">{language.t("provider.custom.headers.label")}</label>
          <For each={form.headers}>
            {(h, i) => (
              <div class="flex gap-2 items-start" data-row={h.row}>
                <div class="flex-1">
                  <TextField
                    label={language.t("provider.custom.headers.key.label")}
                    hideLabel
                    placeholder={language.t("provider.custom.headers.key.placeholder")}
                    value={h.key}
                    onChange={(v) => setHeader(i(), "key", v)}
                    validationState={h.err.key ? "invalid" : undefined}
                    error={h.err.key}
                  />
                </div>
                <div class="flex-1">
                  <TextField
                    label={language.t("provider.custom.headers.value.label")}
                    hideLabel
                    placeholder={language.t("provider.custom.headers.value.placeholder")}
                    value={h.value}
                    onChange={(v) => setHeader(i(), "value", v)}
                    validationState={h.err.value ? "invalid" : undefined}
                    error={h.err.value}
                  />
                </div>
                <IconButton
                  type="button"
                  icon="trash"
                  variant="ghost"
                  class="mt-1.5"
                  onClick={() => removeHeader(i())}
                  disabled={form.headers.length <= 1}
                  aria-label={language.t("provider.custom.headers.remove")}
                />
              </div>
            )}
          </For>
          <Button type="button" size="small" variant="ghost" icon="plus-small" onClick={addHeader} class="self-start">
            {language.t("provider.custom.headers.add")}
          </Button>
        </div>

        <Button
          class="w-auto self-start"
          type="submit"
          size="large"
          variant="primary"
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? language.t("common.saving") : language.t("common.submit")}
        </Button>
      </form>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck the app package**

Run from `packages/app`:

```sh
bun typecheck
```

Expected: PASS with no errors from `dialog-edit-provider.tsx`.

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/components/dialog-edit-provider.tsx
git commit -m "feat(app): add provider connection edit dialog"
```

---

### Task 5: Wire the Edit action into the v2 providers settings

**Files:**
- Modify: `packages/app/src/components/settings-v2/providers.tsx:11` (imports), `:90-96` (`isConfigCustom`), `:178-187` (Edit button)

**Interfaces:**
- Consumes: `canEditProvider`, `isConfigCustomProvider` from `@/hooks/provider-connection-edit`; `DialogEditProvider`.
- Produces: an Edit action on every connected row under v1, opening `DialogEditProvider`.

- [ ] **Step 1: Update imports**

In `packages/app/src/components/settings-v2/providers.tsx`, replace:

```ts
import { canReplaceProviderApiKey } from "@/hooks/provider-catalog"
import { DialogConnectProvider, useProviderConnectController } from "../dialog-connect-provider"
import { DialogCustomProvider } from "../dialog-custom-provider"
```

with:

```ts
import { canEditProvider, isConfigCustomProvider } from "@/hooks/provider-connection-edit"
import { DialogConnectProvider, useProviderConnectController } from "../dialog-connect-provider"
import { DialogCustomProvider } from "../dialog-custom-provider"
import { DialogEditProvider } from "../dialog-edit-provider"
```

- [ ] **Step 2: Delegate `isConfigCustom` to the shared helper**

Replace:

```ts
  const isConfigCustom = (providerID: string) => {
    const provider = serverSync().data.config.provider?.[providerID]
    if (!provider) return false
    if (provider.npm !== "@ai-sdk/openai-compatible") return false
    if (!provider.models || Object.keys(provider.models).length === 0) return false
    return true
  }
```

with:

```ts
  const isConfigCustom = (providerID: string) =>
    isConfigCustomProvider(serverSync().data.config.provider?.[providerID])
```

- [ ] **Step 3: Add the edit opener and replace the Edit button**

Add the `edit` function directly after the existing `source` function (it references `source`, so it must be declared below it):

```tsx
  const edit = (item: ProviderItem) => {
    dialog.show(() => (
      <DialogEditProvider
        providerID={item.id}
        providerName={item.name}
        source={source(item)}
        onBack={dialog.close}
      />
    ))
  }
```

Replace the Edit button block:

```tsx
                      <Show when={canReplaceProviderApiKey(item.id)}>
                        <ButtonV2
                          size="normal"
                          variant="ghost-muted"
                          data-action="provider-replace-api-key"
                          onClick={() => connect(item.id)}
                        >
                          {language.t("common.edit")}
                        </ButtonV2>
                      </Show>
```

with:

```tsx
                      <Show when={canEditProvider(protocol())}>
                        <ButtonV2
                          size="normal"
                          variant="ghost-muted"
                          data-action="provider-edit"
                          onClick={() => edit(item)}
                        >
                          {language.t("common.edit")}
                        </ButtonV2>
                      </Show>
```

- [ ] **Step 4: Verify the legacy layout still compiles**

Confirm `packages/app/src/components/settings-providers.tsx` still imports and uses `canReplaceProviderApiKey` unchanged. Do not modify it.

Run from `packages/app`:

```sh
bun typecheck
```

Expected: PASS. No unused-import error for `canReplaceProviderApiKey` because the legacy file still uses it.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/settings-v2/providers.tsx
git commit -m "feat(app): open provider connection edit from settings"
```

---

### Task 6: Verify the whole change

**Files:**
- No file changes. This task verifies Tasks 1-5.

- [ ] **Step 1: Run the opencode config tests**

Run from `packages/opencode`:

```sh
bun test test/config/config.test.ts test/config/v2-compat.test.ts --timeout 30000
```

Expected: PASS, including the two `provider-replace` fixtures.

- [ ] **Step 2: Run the opencode typecheck**

Run from `packages/opencode`:

```sh
bun typecheck
```

Expected: PASS.

- [ ] **Step 3: Run the app unit tests and typecheck**

Run from `packages/app`:

```sh
bun test --conditions=solid --preload ./happydom.ts src/hooks/provider-connection-edit.test.ts src/hooks/provider-catalog.test.ts src/i18n/parity.test.ts src/components/dialog-custom-provider.test.ts
bun typecheck
```

Expected: PASS. The existing `provider-catalog.test.ts` assertion that only Ollama Cloud exposes API key replacement still passes because `canReplaceProviderApiKey` is unchanged.

- [ ] **Step 4: Browser check**

Start the backend from `packages/opencode`:

```sh
bun run ./src/index.ts serve --port 4096
```

Start the app from `packages/app` in a second shell:

```sh
bun dev -- --port 4444
```

Open `http://localhost:4444`, go to Settings > Providers, and verify:
- Every connected provider row shows Edit next to Disconnect.
- Editing a provider with a config entry pre-fills the base URL, headers, and models.
- The API key field is empty and masked; leaving it empty and saving preserves the existing credential.
- Removing a header and saving removes it from the global config file.
- The OAuth provider shows "Connected with OAuth" and "Use an API key instead".

- [ ] **Step 5: Commit any verification fixes**

If verification required changes, commit them with a `fix(app):` or `fix(opencode):` message. Otherwise, this task adds no commit.

---

## Self-Review

**Spec coverage:**
- Edit action on every connected row (v2): Task 5.
- New dialog with auth, connection, and models sections: Task 4.
- Prefill from global config, secrets never displayed: Tasks 2, 4.
- OAuth read-only plus "use an API key instead": Task 2 (`providerAuthKind`) and Task 4.
- Save via `auth.set` plus global `updateConfig`: Task 4.
- `provider` subtree replacement so removal persists: Task 1.
- Validation reuse: Task 2.
- i18n keys mirrored across locales: Task 3.
- Testing and verification: Tasks 1, 2, 6.
- Legacy layout unchanged, non-v1 hidden, project config out of scope: Task 5 Step 4 and Task 2 (`canEditProvider`).

**Placeholder scan:** No TBD/TODO. Every code step contains full code. Fixture outputs are generated by the documented `UPDATE_CONFIG_FIXTURES=1` workflow, which the repo's own README defines as the intended method.

**Type consistency:** `EditForm`, `HeaderRow`, `ModelRow`, `HeaderErr`, `ModelErr` are defined in Task 2 and reused in Task 4. `providerAuthKind` returns `"env" | "api" | "oauth"` and Task 4 compares against those exact values. `canEditProvider` and `isConfigCustomProvider` names match between Tasks 2, 4, and 5. i18n key names in Task 3 match those used in Task 4.
