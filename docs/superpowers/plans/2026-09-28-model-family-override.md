# Model Family Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global `model_family` override (Ollama / OpenAI / Anthropic) that re-points model selection across the router and default-model resolution, plus GPT-6 baseline chains in the OMO UI snapshot.

**Architecture:** A new top-level `model_family` config key is declared in the Effect Schema config and read by a new `provider-family.ts` module inside the ollama-model-router plugin for per-class candidate resolution, and by `Provider.defaultModel`/`getSmallModel` for global default-model selection. The GPT-6 baseline is authored as static chains in `omo-catalog.ts` and, separately, as a user-config edit to `~/.omo/omo.jsonc`.

**Tech Stack:** TypeScript, Effect (packages/core, packages/opencode), SolidJS (packages/app), Bun test.

## Global Constraints

- Test commands run from package directories, never repo root: `bun test --timeout 30000 --only-failures` (packages/opencode), `bun test --conditions=solid --preload ./happydom.ts ./src` (packages/app), `bun typecheck` (both).
- The default branch is `dev`; use `dev` or `origin/dev` for diffs.
- Conventional commits: `type(scope): summary` with scope `core`, `opencode`, `app`, or `plugin`.
- No `as any`, no `@ts-ignore`, no `try`/`catch` where avoidable, no star/aliased imports.
- i18n: all new user-visible copy needs `language.t(...)` keys in every locale dictionary.
- `model_family` values: `"auto" | "ollama" | "openai" | "anthropic"`; default/absent = `"auto"` (current behavior).
- Family fallback order when the selected family is unavailable: Ollama → OpenAI → Anthropic.
- Precedence: explicit pins (taskModels, agent model, session selection) > `model_family` override > existing rank/class defaults.
- Class-to-model mapping (approved):
  | Class | Tier | OpenAI | Anthropic |
  | --- | --- | --- | --- |
  | architecture, review | flagship | gpt-6-astra | claude-opus-5-5 |
  | coding | balanced | gpt-6-sol | claude-sonnet-5 |
  | planning, writing | balanced-writing | gpt-6-sol | claude-fable-5-1 |
  | lookup, long-context | fast | gpt-6-sol-fast | claude-sonnet-5 |
  | quick fallback | fast | gpt-6-luna-fast | claude-haiku-4-5 |
  - Ollama is not tier-mapped; existing `rank.ts` scoring picks per class.
- Deepseek/glm chains are never re-pointed.
- Do not commit `~/.omo/omo.jsonc` changes (user config, outside repo) as part of code commits; it is a runtime edit, not repo content.

---

### Task 1: Config schema — `model_family`

**Files:**
- Modify: `packages/core/src/v1/config/config.ts` (near `small_model`, currently ~L84)
- Test: `packages/opencode/test/provider/provider.test.ts` (existing config-parse coverage; add a focused assertion)

**Interfaces:**
- Produces: `ConfigV1.Info` accepts optional `model_family: "auto" | "ollama" | "openai" | "anthropic"`. Later tasks read it via `cfg.model_family`.
- Consumes: existing `Schema.optional(Schema.Literals([...]))` pattern used elsewhere in the file.

- [ ] **Step 1: Write the failing test**

Add to `packages/opencode/test/provider/provider.test.ts` near the existing `defaultModel respects config model setting` test (L359-368), using that file's established fixture helpers:

```ts
test("defaultModel honors model_family override without config model", async () => {
  // Fixture with model_family set and no cfg.model; assert defaultModel resolves
  // to the provider-family winner instead of the first sorted model.
  // Exact fixture code mirrors the "defaultModel returns first available model" test at L350.
})
```

Write the real test body mirroring `defaultModel respects config model setting` (L359-368), replacing `cfg.model` with `cfg.model_family = "openai"`. It must fail because `model_family` is unknown to the schema and resolution ignores it.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test --timeout 30000 --only-failures test/provider/provider.test.ts`
Expected: FAIL — schema rejects or ignores `model_family`.

- [ ] **Step 3: Declare the key in ConfigV1.Info**

In `packages/core/src/v1/config/config.ts`, after `small_model` (L84-86):

```ts
model_family: Schema.optional(
  Schema.Literals(["auto", "ollama", "openai", "anthropic"]),
).annotate({
  description:
    "Preferred model family for default and per-task model selection. Ollama, OpenAI, or Anthropic. Defaults to auto, which preserves current behavior",
}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test --timeout 30000 --only-failures test/provider/provider.test.ts`
Expected: schema accepts the key; the resolution half still needs Task 2, so keep this step's test scoped to schema acceptance (config parse with `model_family` does not throw and preserves the value). The full resolution assertion moves to Task 3.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/v1/config/config.ts packages/opencode/test/provider/provider.test.ts
git commit -m "feat(core): declare model_family config key"
```

### Task 2: Provider-family resolution module

**Files:**
- Create: `packages/opencode/src/plugin/ollama-model-router/provider-family.ts`
- Test: `packages/opencode/test/plugin/ollama-model-router/provider-family.test.ts`

**Interfaces:**
- Produces:
  - `type ModelFamily = "auto" | "ollama" | "openai" | "anthropic"`
  - `type FamilyTier = "flagship" | "balanced" | "balanced-writing" | "fast"`
  - `resolveFamilyModel(input: { family: Exclude<ModelFamily, "auto">; tier: FamilyTier; catalog: CatalogLike; available: Set<string> }): string | undefined` — returns a `providerID/modelID` key or undefined when no family member matches.
  - `nextFamily(family: Exclude<ModelFamily, "auto">): Exclude<ModelFamily, "auto"> | undefined` — Ollama → OpenAI → Anthropic order.
  - `familyProviders(family): string[]` — provider-ID predicates: ollama → `id.startsWith("ollama")`, openai → `["openai", "github-copilot", "vercel", "opencode"]`, anthropic → `["anthropic", "anthropic-api", "opencode", "vercel"]`.
- Consumes: `CatalogLike` shape from `candidates.ts` (`Record<string, { id: string; models: Record<string, unknown> }>`); key format `providerID/modelID` from `parseModelKey` (scorecard.ts L71).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { nextFamily, resolveFamilyModel } from "./provider-family"

const catalog = {
  openai: { id: "openai", models: { "gpt-6-astra": {}, "gpt-6-sol": {}, "gpt-6-luna-fast": {} } },
  anthropic: { id: "anthropic", models: { "claude-opus-5-5": {}, "claude-sonnet-5": {} } },
  "ollama-cloud": { id: "ollama-cloud", models: { "glm-5.3-flash": {} } },
}

describe("nextFamily", () => {
  test("falls through ollama, openai, anthropic", () => {
    expect(nextFamily("ollama")).toBe("openai")
    expect(nextFamily("openai")).toBe("anthropic")
    expect(nextFamily("anthropic")).toBeUndefined()
  })
})

describe("resolveFamilyModel", () => {
  test("picks the tier model from the selected family", () => {
    const available = new Set(["openai/gpt-6-sol"])
    expect(resolveFamilyModel({ family: "openai", tier: "balanced", catalog, available })).toBe("openai/gpt-6-sol")
  })

  test("returns undefined when the family lacks the tier", () => {
    const available = new Set<string>()
    expect(resolveFamilyModel({ family: "ollama", tier: "flagship", catalog, available })).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test --timeout 30000 --only-failures test/plugin/ollama-model-router/provider-family.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the module**

```ts
import type { CatalogLike } from "./candidates"

export type ModelFamily = "auto" | "ollama" | "openai" | "anthropic"
export type FamilyTier = "flagship" | "balanced" | "balanced-writing" | "fast"

const TIER_MODELS: Record<"openai" | "anthropic", Record<FamilyTier, string>> = {
  openai: {
    flagship: "gpt-6-astra",
    balanced: "gpt-6-sol",
    "balanced-writing": "gpt-6-sol",
    fast: "gpt-6-sol-fast",
  },
  anthropic: {
    flagship: "claude-opus-5-5",
    balanced: "claude-sonnet-5",
    "balanced-writing": "claude-fable-5-1",
    fast: "claude-sonnet-5",
  },
}

export const FAMILY_ORDER: Exclude<ModelFamily, "auto">[] = ["ollama", "openai", "anthropic"]

export function nextFamily(family: Exclude<ModelFamily, "auto">): Exclude<ModelFamily, "auto"> | undefined {
  return FAMILY_ORDER[ FAMILY_ORDER.indexOf(family) + 1 ]
}

export function familyProviders(family: Exclude<ModelFamily, "auto">): string[] {
  if (family === "ollama") return ["ollama"]
  if (family === "openai") return ["openai", "github-copilot", "opencode", "vercel"]
  return ["anthropic", "anthropic-api", "opencode", "vercel"]
}

export function resolveFamilyModel(input: {
  family: Exclude<ModelFamily, "auto">
  tier: FamilyTier
  catalog: CatalogLike
  available: Set<string>
}): string | undefined {
  if (family === "ollama") return undefined
  const model = TIER_MODELS[family][input.tier]
  const providers = familyProviders(family)
  for (const providerID of providers) {
    const entry = input.catalog[providerID]
    if (!entry?.models?.[model]) continue
    const key = `${providerID}/${model}`
    if (input.available.size > 0 && !input.available.has(key)) continue
    return key
  }
  return undefined
}
```

Note: the catalog type import must match `candidates.ts`'s actual export name; verify before writing (`CatalogLike` is constructed in `index.ts` L38-51 from `input.client.provider.list()`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test --timeout 30000 --only-failures test/plugin/ollama-model-router/provider-family.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/plugin/ollama-model-router/provider-family.ts packages/opencode/test/plugin/ollama-model-router/provider-family.test.ts
git commit -m "feat(plugin): add provider family tier resolution"
```

### Task 3: Router consumes `model_family`

**Files:**
- Modify: `packages/opencode/src/plugin/ollama-model-router/index.ts` (resolveOptions L53-65; catalog load L38-51)
- Modify: `packages/opencode/src/plugin/ollama-model-router/candidates.ts` (`selected()` L28-33)
- Modify: `packages/opencode/src/plugin/ollama-model-router/rank.ts` (`rankModels` L40, pin handling L69-74)
- Test: `packages/opencode/test/plugin/ollama-model-router/plugin.test.ts`

**Interfaces:**
- Consumes: `ConfigV1.Info.model_family` (Task 1), `resolveFamilyModel`/`familyProviders` (Task 2).
- Produces: the router honors `cfg.model_family` when picking winners; sentinel `model-router/auto` resolution is unchanged for `auto`.

- [ ] **Step 1: Write the failing test**

In `plugin.test.ts`, following the existing sentinel-routing test shape (L14-317):

```ts
test("model_family openai routes coding to the tier model", async () => {
  // Fixture: connected catalog includes openai/gpt-6-sol and ollama models;
  // config sets model_family: "openai"; sentinel message routed to openai/gpt-6-sol.
})
```

Write the real test body using the existing fixture helpers in that file (they already build a catalog and send a sentinel message). Also assert `model_family: "auto"` preserves the exact current winner, and an explicit `taskModels` pin beats `model_family`.

- [ ] **Step 2: Run to verify FAIL**

Run: `bun test --timeout 30000 --only-failures test/plugin/ollama-model-router/plugin.test.ts`
Expected: the new test fails; existing tests still pass.

- [ ] **Step 3: Implement**

In `index.ts` `resolveOptions`, also read `cfg.model_family` (validate against the four literals; invalid → `"auto"` + warning log, matching the existing `parseOptions` failure handling at index.ts L107-111). Pass it into `parseOptions`'s return as `modelFamily`.

In `candidates.ts` `selected()`, when `options.modelFamily` is set and not `"auto"`, replace the current default (`providerID.startsWith("ollama")`, L28-33) with a `familyProviders()` membership check plus the family order fallback.

In `rank.ts`, when ranking for task `X` with `modelFamily` set, prepend the `resolveFamilyModel` winner for that task's tier to the ranked list ahead of scoring, but behind an explicit `taskModels` pin.

- [ ] **Step 4: Run to verify PASS**

Run: `bun test --timeout 30000 --only-failures test/plugin/ollama-model-router/`
Expected: PASS, all existing tests unbroken.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/plugin/ollama-model-router/
git commit -m "feat(plugin): honor model_family in task routing"
```

### Task 4: Global default-model resolution

**Files:**
- Modify: `packages/opencode/src/provider/provider.ts` (`getSmallModel` L2041, `defaultModel` L2110)
- Test: `packages/opencode/test/provider/provider.test.ts`

**Interfaces:**
- Consumes: `ConfigV1.Info.model_family` (Task 1), `resolveFamilyModel` (Task 2 — import path `@/plugin/ollama-model-router/provider-family`).
- Produces: `defaultModel()` and `getSmallModel()` consult `model_family` after explicit `cfg.model`/`cfg.small_model` and recent-model state, before first-sorted/first-provider fallback.

- [ ] **Step 1: Write the failing test**

Extend the Task 1 test into real resolution assertions (mirroring fixture code from `defaultModel respects config model setting`, L359-368):

```ts
test("defaultModel uses model_family openai tier model", async () => {
  // cfg: { model_family: "openai" }, connected catalog contains openai/gpt-6-sol
  // assert result equals { providerID: openai, modelID: gpt-6-sol }
})
test("getSmallModel falls through families when tier model missing", async () => {
  // cfg: { model_family: "anthropic" }, catalog lacks claude-haiku-4-5,
  // assert small model resolves to the next family's fast-tier model
})
```

- [ ] **Step 2: Run to verify FAIL**

Run: `bun test --timeout 30000 --only-failures test/provider/provider.test.ts`
Expected: FAIL (resolution ignores `model_family`).

- [ ] **Step 3: Implement**

In `defaultModel` (after the `cfg.model` early return, before the recent-models read): if `cfg.model_family` is set and not `"auto"`, use `resolveFamilyModel` against the catalog plus `new Set(recent-validated keys)` and, if found, return it; on `undefined`, walk `nextFamily`.

In `getSmallModel` (after the `cfg.small_model` branch, before the plugin hook): when `cfg.model_family` is set and not `"auto"`, resolve the `fast` tier through the same helper; the existing family-priority loop becomes the final fallback only.

- [ ] **Step 4: Run to verify PASS**

Run: `bun test --timeout 30000 --only-failures test/provider/provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/provider/provider.ts packages/opencode/test/provider/provider.test.ts
git commit -m "feat(provider): honor model_family in default model resolution"
```

### Task 5: Settings UI toggle

**Files:**
- Modify: `packages/app/src/components/settings-v2/model-router-payload.ts` (form schema/serialization; `formFromConfig` L73, `serializeForm` L90)
- Modify: `packages/app/src/components/settings-v2/model-router.tsx` (form + save L137-160)
- Test: `packages/app/src/components/settings-v2/model-router-payload.test.ts`
- i18n: every `packages/app/src/i18n/*.ts` (62 files) for the new label + description keys

**Interfaces:**
- Consumes: `model_router` config read/write path (`serverSync().updateConfig(patch)`).
- Produces: a dropdown writing top-level `model_family` alongside the existing `model_router` patch. Form field name: `modelFamily` with values `"auto" | "ollama" | "openai" | "anthropic"`.

- [ ] **Step 1: Write the failing payload test**

```ts
test("modelFamily round-trips through the form", () => {
  const form = formFromConfig({ model_family: "openai" }, existingRouterOptions)
  expect(form.modelFamily).toBe("openai")
  const patch = serializeForm({ ...form, modelFamily: "anthropic" })
  expect(patch.model_family).toBe("anthropic")
  expect(patch.model_family !== undefined ? patch : { ...patch, model_family: undefined }).toHaveProperty("model_family")
})
```

Adjust to the actual helper signatures in `model-router-payload.ts` (L73, L90) before running.

- [ ] **Step 2: Run to verify FAIL**

Run: `bun test --conditions=solid --preload ./happydom.ts src/components/settings-v2/model-router-payload.test.ts`
Expected: FAIL — `modelFamily` field unknown.

- [ ] **Step 3: Implement the payload field and dropdown**

Extend `formFromConfig` to read `config.model_family` (default `"auto"`), `serializeForm` to emit top-level `model_family` only when not `"auto"` (omit the key entirely for `"auto"`). Add the dropdown to `model-router.tsx` near the existing controls with i18n keys:

- `settings.modelRouter.family.title`: "Model family override"
- `settings.modelRouter.family.auto/ollama/openai/anthropic`: display labels

Add every new key to all locale dictionaries (the session already added `session.subagents.empty` across 62 locales — reuse that workflow: add to `en.ts`, run parity test, then add to each locale).

- [ ] **Step 4: Run to verify PASS**

Run: `bun test --conditions=solid --preload ./happydom.ts src/components/settings-v2/ src/i18n/parity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/settings-v2/ packages/app/src/i18n/
git commit -m "feat(app): add model family override toggle"
```

### Task 6: GPT-6 baseline in the UI snapshot

**Files:**
- Modify: `packages/app/src/components/settings-v2/omo-catalog.ts` (`AGENT_FALLBACKS` L35, `CATEGORY_FALLBACKS` L139)
- Test: `packages/app/src/components/settings-v2/omo-config-payload.test.ts` (extend; it already consumes `fallbackChain`)

**Interfaces:**
- Consumes: `FallbackChain`/`FallbackEntry` types in `omo-catalog.ts`.
- Produces: chains whose lead rung is GPT-6 for all non-deepseek/glm chains, with existing variants preserved where the tier matches.

- [ ] **Step 1: Write the failing skip-rule test**

```ts
describe("omo catalog gpt-6 baseline", () => {
  test("chains without deepseek or glm lead with a gpt-6 model", () => {
    const converted = ["visual-engineering", "ultrabrain", "deep", "artistry", "unspecified-high", "writing"]
    for (const name of converted) {
      const chain = fallbackChain("category", name)
      expect(chain[0]?.model).toMatch(/^gpt-6/)
    }
  })

  test("deepseek or glm chains stay untouched", () => {
    for (const name of ["quick", "unspecified-low"]) {
      const chain = fallbackChain("category", name)
      expect(chain.some((entry) => entry.model.includes("deepseek"))).toBe(true)
      expect(chain[0]?.model).not.toMatch(/^gpt-6/)
    }
  })
})
```

- [ ] **Step 2: Run to verify FAIL**

Run: `bun test --conditions=solid --preload ./happydom.ts src/components/settings-v2/omo-config-payload.test.ts`
Expected: FAIL — current leads are `claude-*`/`gpt-5.6-*`.

- [ ] **Step 3: Edit the chains**

Categories (all currently lead non-GPT): `visual-engineering` → `gpt-6-astra` (variant `max`), `ultrabrain` → `gpt-6-sol` (`max`), `deep` → `gpt-6-sol` (`medium`), `artistry` → `gpt-6-astra` (`xhigh`), `unspecified-high` → `gpt-6-sol` (`high`), `writing` → `gpt-6-sol` (`low`). Keep each edited rung's existing provider list. Skip `quick` and `unspecified-low` (deepseek rungs).

Agents: `sisyphus` → `gpt-6-astra` (`max`), `prometheus` → `gpt-6-sol` (`high`), `metis` → `gpt-6-sol` (`high`), `atlas` → `gpt-6-sol` (`medium`), `sisyphus-junior` → `gpt-6-sol` (`medium`), `hephaestus` → `gpt-6-sol` (`medium`), `oracle` → `gpt-6-astra` (`xhigh`), `momus` → `gpt-6-sol` (`xhigh`). Skip `librarian` and `explore` (deepseek rungs).

- [ ] **Step 4: Run to verify PASS**

Run: `bun test --conditions=solid --preload ./happydom.ts src/components/settings-v2/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/settings-v2/omo-catalog.ts packages/app/src/components/settings-v2/omo-config-payload.test.ts
git commit -m "feat(app): lead OMO chains with GPT-6 models"
```

### Task 7: Re-point user pins at runtime

**Files:**
- Modify: `~/.omo/omo.jsonc` (runtime user config — NOT a repo file, never committed)

**Interfaces:**
- Consumes: the approved mapping table.
- Produces: runtime GPT-6 defaults for agents/categories whose pins do not reference deepseek or glm.

- [ ] **Step 1: Read the live pins**

```bash
cat ~/.omo/omo.jsonc
```

- [ ] **Step 2: Back it up**

```bash
cp ~/.omo/omo.jsonc ~/.omo/omo.jsonc.bak.$(date +%Y%m%dT%H%M%S)
```

- [ ] **Step 3: Re-point the non-deepseek/glm pins**

Only entries whose `model`/`models` do not reference `deepseek` or `glm` change; deepseek/glm entries are left exactly as-is. Per the approved mapping:

- `agents.sisyphus.model`: `openai/gpt-5.6-sol` → `openai/gpt-6-sol`
- `agents.oracle.model`: `ollama-cloud/deepseek-v4.1-flash` → leave (deepseek)
- `agents.prometheus.model`: `anthropic/claude-opus-5-5` → `openai/gpt-6-astra`
- `agents.metis.model`: `anthropic/claude-opus-5` → `openai/gpt-6-sol`
- `agents.momus.models`: anthropic-only chain → lead `openai/gpt-6-astra`, keep `anthropic/claude-sonnet-4-6` as fallback
- `agents.atlas.models`: deepseek lead → leave
- `agents.hephaestus`, `librarian`, `explore`, `multimodal-looker`, `sisyphus-junior`: chains reference `ollama-cloud/glm-5.3-flash` or deepseek → leave
- `categories.visual-engineering.model`: `anthropic/claude-opus-5-5` → `openai/gpt-6-astra`
- `categories.ultrabrain.model`: `openai/gpt-5.6-sol` → `openai/gpt-6-sol`
- `categories.artistry.model`: `anthropic/claude-opus-5` → `openai/gpt-6-astra`
- `categories.quick`, `unspecified-low`, `unspecified-high`, `writing`, `deep-low`: chains reference glm/deepseek → leave

- [ ] **Step 4: Verify the file parses**

```bash
bun -e "const fs = require('fs'); const s = require('fs').readFileSync(process.env.HOME + '/.omo/omo.jsonc', 'utf8'); JSON.parse(s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')); console.log('parses')"
```

- [ ] **Step 5: Commit (repo-side note only)**

This task changes runtime config outside the repo; the plan records it so the implementer knows it is part of the deliverable, but no repo commit is made for the file itself.

### Task 7: Verify and package

**Files:**
- No source changes expected.

- [ ] **Step 1: Run the opencode suites**

```bash
cd packages/opencode && bun test --timeout 30000 --only-failures test/provider test/plugin/ollama-model-router test/config
```
Expected: 0 failures.

- [ ] **Step 2: Run the app suite and typecheck**

```bash
cd packages/app && bun test --conditions=solid --preload ./happydom.ts ./src && bun typecheck
```
Expected: 0 failures, typecheck exit 0.

- [ ] **Step 3: Full opencode typecheck**

```bash
cd packages/opencode && bun typecheck
```
Expected: exit 0.

- [ ] **Step 4: End-to-end sanity**

Start a dev backend and confirm the model picker lists GPT-6 models for OpenAI and the current Ollama models for `ollama-local` after a catalog refresh; confirm a `model_family: "openai"` config flips default-model resolution. Do not restart the app or server processes — verify against a fresh dev instance.

---

## Self-Review

**Spec coverage:** GPT-6 baseline → Tasks 6-7. Provider override + fallback order → Tasks 2-4. UI toggle → Task 5. Precedence (pins > override > defaults) → Tasks 3-4 tests. Error handling (unknown value → auto) → Task 1/3. Catalog poll already implemented in commits `b77ca6a274`/`52b64c063a` — not re-planned.

**Placeholder scan:** Task 1 Step 1 and Task 3 Step 1 contain test sketches that reference existing fixture helpers by location rather than full code — the implementer must mirror those fixtures. Acceptable: the helpers are large and copy-pasting them risks drift; the referenced test lines give exact shapes.

**Type consistency:** `ModelFamily`/`FamilyTier`/`resolveFamilyModel`/`nextFamily`/`familyProviders` are defined once in Task 2 and consumed in Tasks 3-4 under the same names. `formFromConfig`/`serializeForm` signatures are Task 5's contract with the existing payload module.