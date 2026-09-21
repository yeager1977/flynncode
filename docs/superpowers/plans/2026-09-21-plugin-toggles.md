# Plugin Toggles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Settings+config on/off switches for Model Router and Oh My OpenCode, default this machine to router off and OMO on, without deleting either system.

**Architecture:** Parse `model_router.enabled` in the built-in plugin. When false, skip sentinel injection, agent assignment, and sentinel rewrite; tools stay declared (plugin hooks are returned at load) but execute reports disabled. Settings serializes `enabled` and retargets `model-router/auto` to `small_model`. A pure helper adds/removes `oh-my-openagent` from `plugin[]`. OMO is installed on this machine only.

**Tech Stack:** Bun, TypeScript, SolidJS settings v2, jsonc via existing `updateConfig`.

## Global Constraints

- Do not vendor Oh My OpenCode into the Flynncode repo.
- Do not delete scorecards, `~/.omo/`, or the router plugin.
- English UI copy is source; add keys to `packages/app/src/i18n/en.ts` only (locales inherit via `model-router-fallback.ts`).
- Never hardcode user-visible English in production UI.
- Tests run from package dirs (`packages/opencode`, `packages/app`), never repo root.
- Branch names: at most three hyphenated words. Commits: `type(scope): summary`.
- Config is load-once; Settings already says routing applies after restart.

## File map

- Modify: `packages/opencode/src/plugin/ollama-model-router/types.ts` — `enabled` on `RouterOptions`
- Modify: `packages/opencode/src/plugin/ollama-model-router/scorecard.ts` — parse `enabled`
- Modify: `packages/opencode/src/plugin/ollama-model-router/index.ts` — skip inject/assign when disabled
- Modify: `packages/opencode/src/plugin/ollama-model-router/tools.ts` — execute-time disabled message
- Modify: `packages/opencode/src/plugin/ollama-model-router/README.md`
- Test: `packages/opencode/test/plugin/ollama-model-router/scorecard.test.ts`
- Test: `packages/opencode/test/plugin/ollama-model-router/plugin.test.ts`
- Modify: `packages/app/src/components/settings-v2/model-router-payload.ts` — form `enabled` + retarget helpers
- Test: `packages/app/src/components/settings-v2/model-router-payload.test.ts`
- Create: `packages/app/src/components/settings-v2/omo-plugin.ts`
- Test: `packages/app/src/components/settings-v2/omo-plugin.test.ts`
- Modify: `packages/app/src/components/settings-v2/model-router.tsx` — two master switches
- Modify: `packages/app/src/i18n/en.ts` — new keys
- Local only: `~/.config/opencode/opencode.jsonc`

---

### Task 1: Parse `model_router.enabled`

**Files:**
- Modify: `packages/opencode/src/plugin/ollama-model-router/types.ts`
- Modify: `packages/opencode/src/plugin/ollama-model-router/scorecard.ts`
- Test: `packages/opencode/test/plugin/ollama-model-router/scorecard.test.ts`

**Interfaces:**
- Consumes: existing `parseOptions`
- Produces: `RouterOptions.enabled: boolean` (default `true` when omitted)

- [ ] **Step 1: Write the failing tests**

Add to `describe("parseOptions")` in `scorecard.test.ts`:

```ts
test("defaults enabled to true", () => {
  const result = parseOptions({})
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.options.enabled).toBe(true)
})

test("parses enabled false", () => {
  const result = parseOptions({ enabled: false })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.options.enabled).toBe(false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/plugin/ollama-model-router/scorecard.test.ts` from `packages/opencode`

Expected: FAIL because `enabled` is not on options.

- [ ] **Step 3: Minimal implementation**

In `types.ts`, add `enabled: boolean` as the first field of `RouterOptions`.

In `scorecard.ts` `parseOptions`, next to the other booleans:

```ts
const enabled = typeof r.enabled === "boolean" ? r.enabled : true
```

Include `enabled` in the returned `options` object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/plugin/ollama-model-router/scorecard.test.ts` from `packages/opencode`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/plugin/ollama-model-router/types.ts packages/opencode/src/plugin/ollama-model-router/scorecard.ts packages/opencode/test/plugin/ollama-model-router/scorecard.test.ts
git commit -m "feat(plugin): parse model_router.enabled"
```

---

### Task 2: Make the plugin inert when `enabled` is false

**Files:**
- Modify: `packages/opencode/src/plugin/ollama-model-router/index.ts`
- Modify: `packages/opencode/src/plugin/ollama-model-router/tools.ts`
- Test: `packages/opencode/test/plugin/ollama-model-router/plugin.test.ts`

**Interfaces:**
- Consumes: `RouterOptions.enabled` from Task 1
- Produces: config hook skips `injectRouterProvider` and `assignAgents` when `enabled` is false; `chat.message` returns without rewrite; `rank_models` / `route_task` execute returns `Model router disabled.`

Note: tools stay on the hooks object because they are returned at plugin load, before config. Execute-time disable satisfies the spec test "Tools report disabled".

- [ ] **Step 1: Write the failing tests**

Add to `plugin.test.ts`:

```ts
test("enabled false does not inject the sentinel or assign agents", async () => {
  const hooks = await plugin.server(fakeInput, {
    enabled: false,
    autoRoute: true,
    legacyAssign: true,
    providers: ["ollama-cloud"],
    models: { "ollama-cloud/a": { price: 1, capability: 10, speed: 10 } },
  })
  const cfg: any = {
    model_router: {
      enabled: false,
      autoRoute: true,
      legacyAssign: true,
      providers: ["ollama-cloud"],
      models: { "ollama-cloud/a": { price: 1, capability: 10, speed: 10 } },
    },
    provider: { "ollama-cloud": { models: { a: {} } } },
    agent: {},
  }
  await hooks.config?.(cfg)
  expect(cfg.provider["model-router"]).toBeUndefined()
  expect(cfg.agent).toEqual({})
})

test("enabled false leaves the sentinel unrewritten", async () => {
  const hooks = await plugin.server(fakeInput)
  const cfg: any = {
    model_router: { enabled: false, providers: ["ollama-cloud"] },
    provider: { "ollama-cloud": { models: { a: {} } } },
    agent: {},
  }
  await hooks.config?.(cfg)
  const message: any = { model: { providerID: "model-router", modelID: "auto" } }
  await hooks["chat.message"]?.(
    { sessionID: "s", agent: "build", model: { providerID: "model-router", modelID: "auto" } },
    { message, parts: [] },
  )
  expect(message.model).toEqual({ providerID: "model-router", modelID: "auto" })
})

test("rank_models reports disabled when enabled is false", async () => {
  const hooks = await plugin.server(fakeInput)
  await hooks.config?.({ model_router: { enabled: false } })
  const output = await hooks.tool!.rank_models.execute({ task: "coding" } as any, { sessionID: "s" } as any)
  expect(String(output)).toBe("Model router disabled.")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/plugin/ollama-model-router/plugin.test.ts` from `packages/opencode`

Expected: FAIL (sentinel still injected; rank_models still ranks).

- [ ] **Step 3: Minimal implementation**

In `index.ts` config hook, after a successful `parseOptions`:

```ts
currentOptions = parsed.options
optionsError = undefined
if (!parsed.options.enabled) {
  assignments = {}
  return
}
injectRouterProvider(cfg)
```

Keep the existing `assignAgents` call after that guard.

In `chat.message`, after the existing providerID checks:

```ts
if (!currentOptions?.enabled) return
```

In `tools.ts` `createTools`, at the start of both `rank_models.execute` and `route_task.execute`:

```ts
const options = deps.getOptions()
if (!options || options.enabled === false) {
  if (options && options.enabled === false) return "Model router disabled."
  return disabledMessage(deps.getOptionsError())
}
```

Do not call `getOptions()` twice in a confusing way. Use:

```ts
const options = deps.getOptions()
if (options?.enabled === false) return "Model router disabled."
if (!options) return disabledMessage(deps.getOptionsError())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/plugin/ollama-model-router` from `packages/opencode`

Expected: all pass, including the three new tests.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/plugin/ollama-model-router/index.ts packages/opencode/src/plugin/ollama-model-router/tools.ts packages/opencode/test/plugin/ollama-model-router/plugin.test.ts
git commit -m "feat(plugin): no-op model router when disabled"
```

---

### Task 3: Settings payload `enabled` and model retarget

**Files:**
- Modify: `packages/app/src/components/settings-v2/model-router-payload.ts`
- Test: `packages/app/src/components/settings-v2/model-router-payload.test.ts`

**Interfaces:**
- Consumes: none from Task 1 beyond the field name `enabled`
- Produces:
  - `ModelRouterFormState.enabled: boolean`
  - `emptyForm().enabled === true`
  - `formFromConfig` / `serializeForm` round-trip `enabled`
  - `isRouterModel(model: unknown): boolean`
  - `modelAfterDisable(model: unknown, smallModel: unknown): unknown` — if `model` is the sentinel, return `smallModel` when it is a non-sentinel string; otherwise return `model` unchanged

- [ ] **Step 1: Write the failing tests**

In `model-router-payload.test.ts`:

```ts
test("defaults enabled to true", () => {
  expect(emptyForm().enabled).toBe(true)
  expect(formFromConfig({}).enabled).toBe(true)
})

test("parses and serializes enabled false", () => {
  const form = formFromConfig({ enabled: false })
  expect(form.enabled).toBe(false)
  expect(serializeForm(form).enabled).toBe(false)
})

test("isRouterModel detects the sentinel", () => {
  expect(isRouterModel("model-router/auto")).toBe(true)
  expect(isRouterModel("model-router/coding")).toBe(true)
  expect(isRouterModel("ollama-cloud/glm-5.3-flash")).toBe(false)
})

test("modelAfterDisable retargets sentinel to small_model", () => {
  expect(modelAfterDisable("model-router/auto", "ollama-cloud/glm-5.3-flash")).toBe("ollama-cloud/glm-5.3-flash")
})

test("modelAfterDisable leaves model unchanged without small_model", () => {
  expect(modelAfterDisable("model-router/auto", undefined)).toBe("model-router/auto")
})

test("modelAfterDisable leaves a concrete model unchanged", () => {
  expect(modelAfterDisable("xai/grok-4.6", "ollama-cloud/glm-5.3-flash")).toBe("xai/grok-4.6")
})
```

Update the existing `emptyForm` / `serializeForm` equality tests to include `enabled: true`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/components/settings-v2/model-router-payload.test.ts` from `packages/app`

Expected: FAIL (`enabled` missing; helpers not exported).

- [ ] **Step 3: Minimal implementation**

Add `enabled: boolean` to `ModelRouterFormState`. Default `true` in `emptyForm` and `formFromConfig` (`typeof raw.enabled === "boolean" ? raw.enabled : true`). Put `enabled: form.enabled` first in the `serializeForm` payload object.

```ts
export function isRouterModel(model: unknown): boolean {
  return typeof model === "string" && (model === "model-router/auto" || model.startsWith("model-router/"))
}

export function modelAfterDisable(model: unknown, smallModel: unknown) {
  if (!isRouterModel(model)) return model
  if (typeof smallModel === "string" && smallModel.length > 0 && !isRouterModel(smallModel)) return smallModel
  return model
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/components/settings-v2/model-router-payload.test.ts` from `packages/app`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/settings-v2/model-router-payload.ts packages/app/src/components/settings-v2/model-router-payload.test.ts
git commit -m "feat(app): serialize model router enabled flag"
```

---

### Task 4: Oh My OpenCode plugin-array helper

**Files:**
- Create: `packages/app/src/components/settings-v2/omo-plugin.ts`
- Test: `packages/app/src/components/settings-v2/omo-plugin.test.ts`

**Interfaces:**
- Consumes: none
- Produces:
  - `export const OMO_PLUGIN_IDS = ["oh-my-openagent", "oh-my-opencode"]`
  - `export function pluginId(entry: unknown): string | undefined`
  - `export function hasOmoPlugin(plugin: unknown): boolean`
  - `export function setOmoPlugin(plugin: unknown, enabled: boolean): unknown[]`

- [ ] **Step 1: Write the failing test file**

```ts
import { describe, expect, test } from "bun:test"
import { hasOmoPlugin, setOmoPlugin } from "./omo-plugin"

describe("setOmoPlugin", () => {
  test("adds oh-my-openagent without dropping others", () => {
    expect(setOmoPlugin(["opencode-wakatime"], true)).toEqual(["opencode-wakatime", "oh-my-openagent"])
  })

  test("removes both current and legacy names", () => {
    expect(setOmoPlugin(["oh-my-opencode", "foo", ["oh-my-openagent", { x: 1 }]], false)).toEqual(["foo"])
  })

  test("does not duplicate when already present", () => {
    expect(setOmoPlugin(["oh-my-openagent", "foo"], true)).toEqual(["oh-my-openagent", "foo"])
  })

  test("treats missing plugin as empty", () => {
    expect(setOmoPlugin(undefined, true)).toEqual(["oh-my-openagent"])
    expect(hasOmoPlugin(undefined)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/components/settings-v2/omo-plugin.test.ts` from `packages/app`

Expected: FAIL (module missing).

- [ ] **Step 3: Minimal implementation**

```ts
export const OMO_PLUGIN_IDS = ["oh-my-openagent", "oh-my-opencode"]

export function pluginId(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0]
  return undefined
}

export function hasOmoPlugin(plugin: unknown): boolean {
  if (!Array.isArray(plugin)) return false
  return plugin.some((entry) => {
    const id = pluginId(entry)
    return id === "oh-my-openagent" || id === "oh-my-opencode"
  })
}

export function setOmoPlugin(plugin: unknown, enabled: boolean): unknown[] {
  const list = Array.isArray(plugin) ? [...plugin] : []
  const without = list.filter((entry) => {
    const id = pluginId(entry)
    return id !== "oh-my-openagent" && id !== "oh-my-opencode"
  })
  if (!enabled) return without
  if (hasOmoPlugin(list)) return list
  return [...without, "oh-my-openagent"]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/components/settings-v2/omo-plugin.test.ts` from `packages/app`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/settings-v2/omo-plugin.ts packages/app/src/components/settings-v2/omo-plugin.test.ts
git commit -m "feat(app): add oh-my-openagent plugin array helper"
```

---

### Task 5: Settings UI switches

**Files:**
- Modify: `packages/app/src/i18n/en.ts`
- Modify: `packages/app/src/components/settings-v2/model-router.tsx`

**Interfaces:**
- Consumes: `form.enabled`, `serializeForm`, `modelAfterDisable` from Task 3; `hasOmoPlugin`, `setOmoPlugin` from Task 4
- Produces: Model Router tab shows Enable Model Router (saved with the existing Save path) and Enable Oh My OpenCode (writes `plugin` immediately via `updateConfig`)

- [ ] **Step 1: Add i18n keys** in `packages/app/src/i18n/en.ts` immediately after `settings.modelRouter.autoRoute.description`:

```ts
"settings.modelRouter.enabled.title": "Enable Model Router",
"settings.modelRouter.enabled.description": "When off, keep the scorecard but do not inject or resolve Model Router.",
"settings.modelRouter.omo.title": "Enable Oh My OpenCode",
"settings.modelRouter.omo.description": "Load the oh-my-openagent plugin. Turning off removes it from plugin without deleting ~/.omo.",
```

Do not add keys to other locale files; `model-router-fallback.ts` already copies `settings.modelRouter.*` from English.

- [ ] **Step 2: Wire the router enable switch**

In `model-router.tsx`, above the existing autoRoute card inside the routing tab, add a Switch bound to `form.enabled` using the same `model-router-enable model-router-card` layout as autoRoute.

In `save()`, when `form.enabled` is false, include a retargeted `model` in `updateConfig`:

```ts
const config = serverSync().data.config
const nextModel = modelAfterDisable(config.model, config.small_model)
const patch: Record<string, unknown> = { model_router: result.value }
if (nextModel !== config.model) patch.model = nextModel
await serverSync().updateConfig(patch)
```

- [ ] **Step 3: Wire the OMO switch**

Same routing-tab header area, second card. `checked={hasOmoPlugin(serverSync().data.config.plugin)}`. On change:

```ts
void serverSync().updateConfig({
  plugin: setOmoPlugin(serverSync().data.config.plugin, checked),
})
```

Do not wait for the Model Router Save button for this switch.

- [ ] **Step 4: Typecheck**

Run: `bun typecheck` from `packages/app` and `packages/opencode`

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/i18n/en.ts packages/app/src/components/settings-v2/model-router.tsx
git commit -m "feat(app): add model router and oh-my-openagent toggles"
```

---

### Task 6: Router README

**Files:**
- Modify: `packages/opencode/src/plugin/ollama-model-router/README.md`

**Interfaces:**
- Consumes: `enabled` from Task 1
- Produces: docs for the master switch

- [ ] **Step 1: Document `enabled`**

In the jsonc example, add `"enabled": true,` before `autoRoute`. After the inert-without-key bullet, add:

```
- `enabled` (default true) is the master switch. `false` keeps the scorecard
  but does not inject Model Router, rewrite prompts, or rank models.
```

- [ ] **Step 2: Commit**

```bash
git add packages/opencode/src/plugin/ollama-model-router/README.md
git commit -m "docs(plugin): document model_router.enabled"
```

---

### Task 7: This-machine install and defaults

**Files:**
- Local only: `~/.config/opencode/opencode.jsonc`
- Do not commit this file.

**Interfaces:**
- Consumes: installer; Task 1 `enabled`; Task 3 retarget rule
- Produces: OMO in `plugin[]`, `model_router.enabled: false`, `model` not `model-router/auto`

- [ ] **Step 1: Install OMO first**

```bash
bunx oh-my-openagent install
```

If that binary is missing, `bunx oh-my-opencode install`. Follow the installer. Do not vendor the package into this repo.

- [ ] **Step 2: Patch user config after the installer**

Using the repo jsonc parser (`packages/opencode/src/config/parse.ts` `ConfigParse.jsonc`) to validate after edits:

- Ensure `plugin` includes `oh-my-openagent` or `oh-my-opencode`.
- Set `model_router.enabled` to `false`. Keep every other `model_router` field.
- If `model` is `model-router/auto` or starts with `model-router/`, set `model` to `small_model` (`ollama-cloud/glm-5.3-flash`). Preserve comments.

- [ ] **Step 3: Verify**

```bash
# from packages/opencode
bun -e '
import { ConfigParse } from "./src/config/parse.ts"
const data = ConfigParse.jsonc(await Bun.file("/home/yeager1977/.config/opencode/opencode.jsonc").text(), "opencode.jsonc")
const plugin = data.plugin ?? []
const ids = plugin.map((e) => typeof e === "string" ? e : e[0])
if (!ids.includes("oh-my-openagent") && !ids.includes("oh-my-opencode")) throw new Error("omo missing")
if (data.model_router.enabled !== false) throw new Error("router still enabled")
if (String(data.model).startsWith("model-router/")) throw new Error("sentinel model")
console.log("ok")
'
```

Expected: `ok`. Do not print secrets.

- [ ] **Step 4: Tell the user to quit and restart OpenCode**

No git commit for the home config.

---

## Spec coverage

- `model_router.enabled` parsed — Task 1
- Inert when false (no sentinel, no assign, no rewrite) — Task 2
- Tools report disabled — Task 2
- Settings switch + serialize — Tasks 3 and 5
- OMO plugin add/remove helper — Task 4
- OMO Settings switch — Task 5
- Install this machine, router off, OMO on, retarget model — Task 7
- README — Task 6
- Not bundled — Task 7 constraint
