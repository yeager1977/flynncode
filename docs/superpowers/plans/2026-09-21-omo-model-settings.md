# Oh My OpenCode Model Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Settings tab that pins Oh My OpenAgent agent and category models and bans providers globally or per project, and add an enable/disable switch on each configured provider row.

**Architecture:** Pure payload helpers decide what to write. A new server handler reads and patches the real plugin files and OpenCode `disabled_providers`. The app never writes those files itself. The Providers switch uses the existing global config update and only adds or removes one id. `Config.update` is not used, because it writes `<directory>/config.json`.

**Tech Stack:** Bun, TypeScript, Effect HttpApi, SolidJS settings v2, jsonc-parser, existing i18n fallback modules.

**Spec:** `docs/superpowers/specs/2026-09-21-omo-model-settings-design.md`

## Global Constraints

- Do not call `Config.update`. It writes `<directory>/config.json`, which is not project OpenCode config.
- Do not edit `packages/client/src/generated` or `src/generated-effect` by hand. After HttpApi changes, run `bun run generate` from `packages/client`.
- Do not import `oh-my-openagent` into the app. The fallback catalog is a static snapshot.
- Do not move the plugin on/off switch. It stays on the Model Router tab.
- Do not edit `model_router`.
- A project file cannot clear a global pin, and cannot un-ban a global provider.
- A project OpenCode `disabled_providers` write is the global OpenCode bans plus the project extras. Never write only `["xai"]`.
- JSONC edits use `jsonc-parser` `modify`. Unknown keys and comments stay. `disabled_providers` is replaced, not deep-merged.
- Visible UI copy uses `language.t`. English is added in `en.ts` and spread through a fallback module. Do not invent translations.
- Tests run from `packages/app` or `packages/opencode`, never the repo root.
- In Effect generators, bind services to named variables before calling methods.
- Branch names are at most three hyphenated words. Commits are `type(scope): summary`.
- Config is load-once. Copy must say quit and restart, and that a picker selection still wins until the next session.

## File map

- Create: `packages/app/src/components/settings-v2/provider-enabled.ts`
- Test: `packages/app/src/components/settings-v2/provider-enabled.test.ts`
- Modify: `packages/app/src/components/settings-v2/providers.tsx`
- Create: `packages/app/src/components/settings-v2/omo-catalog.ts`
- Create: `packages/app/src/components/settings-v2/omo-config-payload.ts`
- Test: `packages/app/src/components/settings-v2/omo-config-payload.test.ts`
- Create: `packages/opencode/src/config/omo-files.ts`
- Test: `packages/opencode/test/config/omo-files.test.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/global.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/config.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts`
- Create: `packages/app/src/components/settings-v2/omo-settings.tsx`
- Modify: `packages/app/src/components/settings-v2/dialog-settings-v2.tsx`
- Modify: `packages/app/src/i18n/en.ts`
- Create: `packages/app/src/i18n/omo-settings-fallback.ts`
- Modify: every `packages/app/src/i18n/*.ts` that already spreads `modelRouterFallback`

---

### Task 1: Provider enable helper

**Files:**
- Create: `packages/app/src/components/settings-v2/provider-enabled.ts`
- Test: `packages/app/src/components/settings-v2/provider-enabled.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `setProviderEnabled(disabled: readonly string[], providerID: string, enabled: boolean): string[]`
  - `providerRows(input: { connected: { id: string; name: string }[]; disabled: readonly string[]; configuredNames: Record<string, string> }): { id: string; name: string; enabled: boolean }[]`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { providerRows, setProviderEnabled } from "./provider-enabled"

describe("setProviderEnabled", () => {
  test("adds one id and keeps the rest", () => {
    expect(setProviderEnabled(["ollama-local"], "xai", false)).toEqual(["ollama-local", "xai"])
  })

  test("removes one id and keeps the rest", () => {
    expect(setProviderEnabled(["ollama-local", "xai"], "xai", true)).toEqual(["ollama-local"])
  })

  test("does not duplicate an existing ban", () => {
    expect(setProviderEnabled(["xai"], "xai", false)).toEqual(["xai"])
  })
})

describe("providerRows", () => {
  test("keeps a disabled id that the catalog omitted", () => {
    expect(
      providerRows({
        connected: [{ id: "ollama-cloud", name: "Ollama Cloud" }],
        disabled: ["xai", "ollama-local"],
        configuredNames: { xai: "xAI" },
      }),
    ).toEqual([
      { id: "ollama-cloud", name: "Ollama Cloud", enabled: true },
      { id: "xai", name: "xAI", enabled: false },
      { id: "ollama-local", name: "ollama-local", enabled: false },
    ])
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run from `packages/app`: `bun test src/components/settings-v2/provider-enabled.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the helper**

```ts
export function setProviderEnabled(disabled: readonly string[], providerID: string, enabled: boolean) {
  if (enabled) return disabled.filter((id) => id !== providerID)
  if (disabled.includes(providerID)) return [...disabled]
  return [...disabled, providerID]
}

export function providerRows(input: {
  connected: { id: string; name: string }[]
  disabled: readonly string[]
  configuredNames: Record<string, string>
}) {
  const seen = new Set(input.connected.map((item) => item.id))
  const disabled = new Set(input.disabled)
  const rows = input.connected.map((item) => ({
    id: item.id,
    name: item.name,
    enabled: !disabled.has(item.id),
  }))
  for (const id of input.disabled) {
    if (seen.has(id)) continue
    rows.push({ id, name: input.configuredNames[id] ?? id, enabled: false })
  }
  return rows
}
```

- [ ] **Step 4: Re-run the test**

Run from `packages/app`: `bun test src/components/settings-v2/provider-enabled.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/settings-v2/provider-enabled.ts packages/app/src/components/settings-v2/provider-enabled.test.ts
git commit -m "feat(app): add provider enable helper"
```

---

### Task 2: Providers screen switch

**Files:**
- Modify: `packages/app/src/components/settings-v2/providers.tsx`
- Modify: `packages/app/src/i18n/en.ts`
- Create: `packages/app/src/i18n/omo-settings-fallback.ts`
- Modify: every locale file that spreads `modelRouterFallback`

**Interfaces:**
- Consumes: `setProviderEnabled`, `providerRows`
- Produces: a switch on each configured row that calls `serverSync().updateConfig({ disabled_providers })`

- [ ] **Step 1: Add English keys**

In `packages/app/src/i18n/en.ts`, next to the existing `settings.providers` keys:

```ts
"settings.providers.enabled": "Enabled",
"settings.providers.enabled.description": "Turn this provider off without removing its key or config. Applies after you quit and restart.",
```

Create `packages/app/src/i18n/omo-settings-fallback.ts`:

```ts
import { dict } from "./en"

export const omoSettingsFallback = Object.fromEntries(
  Object.entries(dict).filter(([key]) => key.startsWith("settings.omo.") || key.startsWith("settings.providers.enabled")),
)
```

In every locale file that already has `...modelRouterFallback`, import `omoSettingsFallback` and spread it immediately after `modelRouterFallback`. Do not translate the values.

- [ ] **Step 2: Render disabled rows and the switch**

In `providers.tsx`:

- Import `Switch` from `@opencode-ai/ui/v2/switch-v2`.
- Import `providerRows` and `setProviderEnabled`.
- Build rows with `providerRows` from `connected()`, `serverSync().data.config.disabled_providers ?? []`, and names from `serverSync().data.config.provider`.
- Render that list instead of `connected()` alone, so a disabled id with no catalog entry still has a row.
- Keep Edit and Disconnect. Add the switch beside Edit.
- The switch is not gated on `protocol() === "v1"`.
- On change, copy the current `disabled_providers`, call `setProviderEnabled`, optimistic-set the store, then `updateConfig({ disabled_providers: next })`. On failure, restore the previous array and show `common.requestFailed`.
- Do not call `auth.remove`, and do not delete the `provider` config block.
- `hideLabel` on the switch, with `language.t("settings.providers.enabled")` as the accessible name.
- Add `data-action="provider-enabled"` on the switch.

- [ ] **Step 3: Check the helper test still passes**

Run from `packages/app`: `bun test src/components/settings-v2/provider-enabled.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/components/settings-v2/providers.tsx packages/app/src/i18n/en.ts packages/app/src/i18n/omo-settings-fallback.ts packages/app/src/i18n
git commit -m "feat(app): toggle configured providers without disconnecting"
```

---

### Task 3: Oh My OpenCode catalog and payload

**Files:**
- Create: `packages/app/src/components/settings-v2/omo-catalog.ts`
- Create: `packages/app/src/components/settings-v2/omo-config-payload.ts`
- Test: `packages/app/src/components/settings-v2/omo-config-payload.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1
- Produces:
  - `OMO_AGENTS`, `OMO_CATEGORIES`, `fallbackChain(kind, name)`
  - `type Pin = "automatic" | "inherit" | { model: string; variant?: string }`
  - `pluginPatch(input): { agents: Record<string, unknown>; categories: Record<string, unknown>; disabledProviders: string[] }`
  - `openCodeBans(input): string[]`
  - `fallbackLabel(chain, connected: ReadonlySet<string>): { model: string; connected: boolean }`

- [ ] **Step 1: Write the failing payload test**

```ts
import { describe, expect, test } from "bun:test"
import { fallbackLabel, openCodeBans, pluginPatch } from "./omo-config-payload"
import { fallbackChain } from "./omo-catalog"

const base = {
  scope: "global" as const,
  shownProviders: ["xai", "ollama-cloud"],
  checked: ["xai"],
  hiddenBans: ["ollama-local"],
  globalOpenCodeBans: ["ollama-local"],
  globalPluginBans: ["ollama-local"],
  agents: { sisyphus: { model: "ollama-cloud/glm-5.3", variant: "high" } as const },
  categories: { quick: "automatic" as const },
  existingAgents: { sisyphus: { temperature: 0.2, model: "openai/gpt-5.6-sol" } },
  existingCategories: {},
}

describe("pluginPatch", () => {
  test("writes a pin and drops an automatic model without dropping other keys", () => {
    const patch = pluginPatch({ ...base, categories: { quick: "automatic" } })
    expect(patch.agents.sisyphus).toEqual({ temperature: 0.2, model: "ollama-cloud/glm-5.3", variant: "high" })
    expect(patch.categories.quick).toBeNull()
  })

  test("project inherit omits the key and plugin bans are extras only", () => {
    const patch = pluginPatch({
      ...base,
      scope: "project",
      agents: { sisyphus: "inherit" },
      checked: ["xai", "ollama-local"],
    })
    expect(patch.agents.sisyphus).toBeNull()
    expect(patch.disabledProviders).toEqual(["xai"])
  })
})

describe("openCodeBans", () => {
  test("project file keeps global bans", () => {
    expect(openCodeBans({ ...base, scope: "project", checked: ["xai", "ollama-local"] })).toEqual([
      "ollama-local",
      "xai",
    ])
  })

  test("keeps a banned id the form did not show", () => {
    expect(openCodeBans(base)).toEqual(["ollama-local", "xai"])
  })
})

describe("fallbackLabel", () => {
  test("quick names the xAI grok entry when xAI is connected", () => {
    expect(fallbackChain("category", "quick").some((entry) => entry.providers.includes("xai"))).toBe(true)
    expect(fallbackLabel(fallbackChain("category", "quick"), new Set(["xai"]))).toEqual({
      model: "xai/grok-4.20-0309-non-reasoning",
      connected: true,
    })
  })

  test("sisyphus head is claude-opus-5 when nothing is connected", () => {
    expect(fallbackLabel(fallbackChain("agent", "sisyphus"), new Set())).toEqual({
      model: "anthropic/claude-opus-5",
      connected: false,
    })
  })
})
```

- [ ] **Step 2: Run it and confirm failure**

Run from `packages/app`: `bun test src/components/settings-v2/omo-config-payload.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Add the catalog**

`omo-catalog.ts` exports the eleven agents and eight categories from the spec, plus `fallbackChain`. Copy the chains from the installed package constants `AGENT_MODEL_REQUIREMENTS` and `CATEGORY_MODEL_REQUIREMENTS` in `~/.cache/opencode/packages/oh-my-openagent/node_modules/oh-my-openagent/dist/index.js` around the `fallbackChain` assignments. Each entry is `{ providers: string[]; model: string; variant?: string }`. Do not import that package.

The tests above lock two facts: Sisyphus starts at `anthropic/claude-opus-5`, and `quick` includes `xai/grok-4.20-0309-non-reasoning`.

- [ ] **Step 4: Implement the payload**

Rules to implement, matching the tests:

- `pluginPatch` values are the merged object, or `null` to delete that key. The PUT body uses the same `null`.
- Global pin writes `model`, and `variant` only when the trimmed variant is non-empty. Other existing keys on that object stay.
- Automatic removes `model` and `variant` only. If the object is then empty, the value is `null`.
- Project `"inherit"` is `null`.
- `openCodeBans` starts with `hiddenBans`, then `globalOpenCodeBans` on project scope, then checked ids. No duplicates.
- Project `pluginPatch.disabledProviders` is checked ids that are not in `globalPluginBans`.

- [ ] **Step 5: Re-run the test**

Run from `packages/app`: `bun test src/components/settings-v2/omo-config-payload.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/components/settings-v2/omo-catalog.ts packages/app/src/components/settings-v2/omo-config-payload.ts packages/app/src/components/settings-v2/omo-config-payload.test.ts
git commit -m "test(app): define Oh My OpenCode pin and ban payload"
```

---

### Task 4: Plugin file reader and writer

**Files:**
- Create: `packages/opencode/src/config/omo-files.ts`
- Test: `packages/opencode/test/config/omo-files.test.ts`

**Interfaces:**
- Consumes: payload shapes from Task 3, called by the handler in Task 5
- Produces:
  - `pluginFile(dir: string, exists: (path: string) => boolean): string | undefined`
  - `openCodeFile(dir: string, exists: (path: string) => boolean): string`
  - `applyPluginPatch(text: string | undefined, patch: PluginPatch): { text: string; empty: boolean }`
  - `applyOpenCodeBans(text: string | undefined, bans: string[]): string`
  - `readPlugin(text: string): { document: Record<string, unknown> } | { parseError: string }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { applyOpenCodeBans, applyPluginPatch, openCodeFile, pluginFile, readPlugin } from "@/config/omo-files"

describe("pluginFile", () => {
  test("prefers oh-my-openagent.jsonc, then legacy names", () => {
    const exists = (path: string) => path.endsWith("oh-my-opencode.json")
    expect(pluginFile("/cfg", exists)).toBe("/cfg/oh-my-opencode.json")
    expect(pluginFile("/cfg", () => false)).toBeUndefined()
  })
})

describe("openCodeFile", () => {
  test("prefers .opencode/opencode.jsonc and never returns config.json", () => {
    expect(openCodeFile("/work", () => false)).toBe("/work/.opencode/opencode.jsonc")
    expect(openCodeFile("/work", (path) => path === "/work/opencode.json")).toBe("/work/.opencode/opencode.jsonc")
    expect(openCodeFile("/work", (path) => path === "/work/.opencode/opencode.jsonc")).toBe(
      "/work/.opencode/opencode.jsonc",
    )
  })
})

describe("applyPluginPatch", () => {
  test("removes an automatic model and keeps an unknown key", () => {
    const result = applyPluginPatch(
      `{
        // keep
        "agents": { "sisyphus": { "temperature": 0.2, "model": "openai/gpt-5.6-sol" } },
        "experimental": { "task_system": true }
      }`,
      { agents: { sisyphus: { temperature: 0.2 } }, categories: {}, disabledProviders: ["xai"] },
    )
    expect(result.text).toContain("temperature")
    expect(result.text).not.toContain("gpt-5.6-sol")
    expect(result.text).toContain("task_system")
    expect(result.text).toContain("xai")
    expect(result.empty).toBe(false)
  })
})

describe("applyOpenCodeBans", () => {
  test("replaces disabled_providers and keeps other keys", () => {
    const text = applyOpenCodeBans(`{ "model": "ollama-cloud/glm-5.3-flash", "disabled_providers": ["ollama-local"] }`, [
      "ollama-local",
      "xai",
    ])
    expect(text).toContain("glm-5.3-flash")
    expect(text).toContain("xai")
    expect(text).not.toContain("config.json")
  })
})

describe("readPlugin", () => {
  test("invalid JSONC is an error and is not rewritten by the caller contract", () => {
    expect(readPlugin("{")).toEqual({ parseError: expect.any(String) })
  })
})
```

- [ ] **Step 2: Run it and confirm failure**

Run from `packages/opencode`: `bun test test/config/omo-files.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `omo-files.ts`**

Name order for `pluginFile`: `oh-my-openagent.jsonc`, `oh-my-openagent.json`, `oh-my-opencode.jsonc`, `oh-my-opencode.json`.

Name order for `openCodeFile`: `<dir>/.opencode/opencode.jsonc`, `<dir>/.opencode/opencode.json`, `<dir>/opencode.jsonc`, `<dir>/opencode.json`. If none exist, return `<dir>/.opencode/opencode.jsonc`. Never return `config.json`.

Use `jsonc-parser` `modify` / `applyEdits` for `.jsonc` text, including text that is undefined (start from `{}`). For a `.json` path, parse, replace the named keys, and `JSON.stringify` with two-space indent. `applyPluginPatch` does not need the path extension if it always emits JSONC-compatible text; the handler picks the existing file and passes its extension. If the path ends with `.json`, emit strict JSON. Otherwise emit JSONC.

`empty` is true only when the resulting document has no keys.

`readPlugin` uses `jsonc-parser` `parse` and returns `{ parseError }` when parse errors are non-empty. Do not throw.

- [ ] **Step 4: Re-run the test**

Run from `packages/opencode`: `bun test test/config/omo-files.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/config/omo-files.ts packages/opencode/test/config/omo-files.test.ts
git commit -m "feat(opencode): patch Oh My OpenCode config files"
```

---

### Task 5: HTTP endpoints

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/global.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/config.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts`
- Generate: `packages/client` via `bun run generate`

**Interfaces:**
- Consumes: `pluginFile`, `openCodeFile`, `applyPluginPatch`, `applyOpenCodeBans`, `readPlugin`
- Produces: `GET/PUT /global/omo-config` and `GET/PUT /config/omo`

- [ ] **Step 1: Declare the routes**

Add to `GlobalPaths`: `omoConfig: "/global/omo-config"`.
Add `GET omoConfigGet` and `PUT omoConfigPut` on `GlobalApi`.

Add `GET omoGet` and `PUT omoPut` at `/config/omo` on `ConfigApi`, with the same `WorkspaceRoutingQuery` as `config.get`.

Success schema:

```ts
{
  path: string | null
  parseError: optional string
  agents: Record<string, unknown>
  categories: Record<string, unknown>
  disabledProviders: string[]
  openCodeDisabledProviders: string[]
}
```

PUT payload:

```ts
{
  agents: Record<string, Record<string, unknown> | null>
  categories: Record<string, Record<string, unknown> | null>
  disabledProviders: string[]
}
```

`null` means omit that key. A record means replace that agent or category object with the record. The app sends the already-merged object from `pluginPatch`.

Error: `HttpApiError.BadRequest` with the failing path in the message. Do not use an empty error body.

- [ ] **Step 2: Implement the handlers**

Global handler reads `~/.config/opencode` through `Global.Path.config`.
Instance handler reads the settings directory from instance context, the same directory `Config.get` uses. Do not walk to a parent.

GET: missing plugin file returns an empty document and `path: null`. Invalid JSONC returns `parseError` and does not throw.

PUT order:

1. If the existing plugin file has `parseError`, fail before writing either file.
2. Write the plugin file. Create `oh-my-openagent.jsonc` when none exists. If the patch is empty and this call created the file, delete it. If the file already had unrelated keys, do not delete it.
3. Write OpenCode `disabled_providers` with `applyOpenCodeBans`. Create `.opencode/opencode.jsonc` only when `openCodeFile` says that path and it does not exist.
4. If step 3 fails, return BadRequest naming that path. Do not roll back step 2. The message must say the plugin file was saved and the provider may still appear in the picker.

Bind `FileSystem.FileSystem` and `Path.Path` once in the handler layer. Do not call `Config.update`.

- [ ] **Step 3: Add a handler test**

Extend `packages/opencode/test/config/omo-files.test.ts` only if the write logic stays in `omo-files.ts`. Add one Effect test beside the existing config tests if the handler grows a branch the pure module cannot see. The required assertion is: a project save with global bans `["ollama-local"]` and extra `xai` writes both files, the OpenCode file contains both ids, and `<directory>/config.json` does not exist.

- [ ] **Step 4: Generate the client**

Run from `packages/client`: `bun run generate`
Expected: generated client gains the new operations. Do not hand-edit generated files.

- [ ] **Step 5: Typecheck the server package**

Run from `packages/opencode`: `bun typecheck`
Expected: PASS, or only failures that already exist on `dev` and do not mention these files.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/server packages/opencode/src/config/omo-files.ts packages/opencode/test/config/omo-files.test.ts packages/client
git commit -m "feat(opencode): expose Oh My OpenCode config endpoints"
```

---

### Task 6: Oh My OpenCode settings tab

**Files:**
- Create: `packages/app/src/components/settings-v2/omo-settings.tsx`
- Modify: `packages/app/src/components/settings-v2/dialog-settings-v2.tsx`
- Modify: `packages/app/src/i18n/en.ts`

**Interfaces:**
- Consumes: generated `omoConfigGet` / `omoConfigPut` and instance `omoGet` / `omoPut`; `pluginPatch`, `openCodeBans`, `fallbackLabel`, `OMO_AGENTS`, `OMO_CATEGORIES`, `hasOmoPlugin`
- Produces: Settings tab `omo`

- [ ] **Step 1: Add the tab**

In `dialog-settings-v2.tsx`, add a Desktop trigger `value="omo"` beside `model-router`, icon `models`, label `language.t("settings.tab.omo")`. Render `SettingsOmoV2` with the same `directory` accessor the Providers tab receives.

- [ ] **Step 2: Add the remaining English keys**

```ts
"settings.tab.omo": "Oh My OpenCode",
"settings.omo.title": "Oh My OpenCode",
"settings.omo.description": "Pin agent and category models, or ban a provider. Applies after you quit and restart.",
"settings.omo.pluginOff": "Oh My OpenCode is off. These settings apply after you turn it on from Model Router.",
"settings.omo.scope.global": "Global",
"settings.omo.scope.project": "This project",
"settings.omo.bans": "Provider bans",
"settings.omo.bans.grok": "Grok",
"settings.omo.bans.locked": "Banned globally",
"settings.omo.agents": "Agents",
"settings.omo.categories": "Categories",
"settings.omo.automatic": "Automatic",
"settings.omo.inherit": "Inherit",
"settings.omo.variant": "Variant",
"settings.omo.fallback": "Known default: {{model}}",
"settings.omo.fallback.offline": "Known default: {{model}} (not connected)",
"settings.omo.notConnected": "Not connected",
"settings.omo.save": "Save",
"settings.omo.saved": "Oh My OpenCode settings saved",
"settings.omo.restart": "Quit and restart. A model already selected in the picker still wins until the next session.",
"settings.omo.unsaved": "Unsaved changes",
"settings.omo.parseError": "This config file could not be read, so it was not changed.",
"settings.omo.saveFailed": "Could not save {{path}}. The plugin file may already be saved, so a banned provider can still appear in the picker.",
```

The fallback module from Task 2 already filters `settings.omo.`, so new keys flow to locales after `en.ts` changes. No translations.

- [ ] **Step 3: Build the tab**

Follow `model-router.tsx`: header, body, footer Save. Use `createStore`. One scope control, then bans, agents, and categories.

Load global with the generated global GET. Load project with the generated instance GET for `directory()`. A missing file is an empty form. `parseError` disables Save and shows `settings.omo.parseError`.

If `hasOmoPlugin` is false, show `settings.omo.pluginOff`. Still allow editing.

Global model menu: Automatic or a connected `provider/model`. Variant input only when a model is chosen.
Project model menu: Inherit or a connected model. No Automatic.
A saved pin missing from the catalog stays selected and shows `settings.omo.notConnected`.

Bans: connected providers plus banned ids not connected. Seed checks from the union of OpenCode and plugin `disabledProviders` for that scope. Project scope locks ids banned in either global list. xAI's label includes `settings.omo.bans.grok`.

Save sends the PUT for the active scope only. The PUT body is `pluginPatch` plus `openCodeBans` from Task 3. The server writes both files; the client does not write files. On success, toast `settings.omo.saved` and description `settings.omo.restart`. On failure, keep the form dirty and show `settings.omo.saveFailed` with the path from the error.

Footer always shows `settings.omo.restart`.

- [ ] **Step 4: Run app tests**

Run from `packages/app`: `bun test src/components/settings-v2/omo-config-payload.test.ts src/components/settings-v2/provider-enabled.test.ts src/components/settings-v2/omo-plugin.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/settings-v2/omo-settings.tsx packages/app/src/components/settings-v2/dialog-settings-v2.tsx packages/app/src/i18n/en.ts
git commit -m "feat(app): add Oh My OpenCode model settings"
```

---

## Spec coverage

- Provider switch, disabled rows stay visible, Edit stays, no credential removal: Task 2.
- Global and project pins, inherit, automatic, variant: Tasks 3 and 6.
- Known fallback line, including the `quick` Grok entry: Task 3.
- Plugin file plus OpenCode ban, no `config.json`, no parent walk, no rollback: Tasks 4 and 5.
- Invalid JSONC blocks save: Tasks 4 and 6.
- i18n fallback, no invented translations: Tasks 2 and 6.
- Plugin off notice without a second switch: Task 6.

## Not in this plan

- Hot reload.
- Project scope on the Providers screen.
- Clearing a global pin from a project file.
- A browser end-to-end test.
