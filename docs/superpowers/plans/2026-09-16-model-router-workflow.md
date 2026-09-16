# Model Router Workflow Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. The user requested direct inline execution; do not pause for additional design or execution-choice approval.

**Goal:** Replace the flat model-router config form with an understandable, responsive model-selection and routing workflow.

**Architecture:** Retain the current global config API and plugin behavior. Split UI editing into routing and model components, with pure preview/catalog helpers and page-owned draft/save state. Validate preview compatibility against the plugin in tests without importing server code into the app runtime.

**Tech Stack:** SolidJS, Kobalte, existing V2 UI primitives, Bun, Playwright, CSS design tokens.

## Global Constraints

- All new visible text goes through typed i18n.
- Use existing design tokens and logical CSS.
- Do not restart the running app/server.
- Run tests/typechecking from package directories; use `bun typecheck`.
- Preserve unrelated workspace changes. Do not commit unless requested.

---

### Task 1: Draft validation and preview contract

**Files:**
- Modify `packages/app/src/components/settings-v2/model-router-payload.ts`
- Modify `packages/app/src/components/settings-v2/model-router-payload.test.ts`
- Create `packages/app/src/components/settings-v2/model-router-preview.ts`
- Create `packages/app/src/components/settings-v2/model-router-preview.test.ts`
- Create `packages/app/test-browser/model-router-contract.test.ts` for cross-package contract imports outside the app's composite TypeScript build.

**Interfaces:** Preview exports `RouterModel`, `RouterSource`, `routerCatalog`, `modelAvailability`, `previewTask`, `PRIORITIES`, `priorityWeights`, and `selectedPriority`. Payload retains `ModelRouterFormState` and existing serialization.

- [x] Add validation regressions for duplicate agents and negative/non-finite weights:

```ts
const form = emptyForm()
form.agentTasks.push({ agent: "build", task: "review" })
expect(validateForm(form).ok).toBe(false)
form.taskWeights.coding.speed = Number.NaN
expect(validateForm(form).ok).toBe(false)
```

- [x] Run `bun test src/components/settings-v2/model-router-payload.test.ts`; verify new regressions fail.
- [x] Validate all task-weight dimensions and duplicate agent names before serialization.
- [x] Add preview tests using explicit provider definitions with scored/unscored,
      disabled, out-of-scope, missing, and task-restricted models. Compare the
      ordered keys and scores with real `collectCandidates` / `rankModels` from
      the plugin. Assert known winning keys independently.
- [x] Implement catalog/availability and advisory ranking, including exact tie
      breaking. Presets normalize proportional weights and preserve custom
      configurations until a preset is explicitly chosen.
- [x] Run both focused test files and the separate test-browser contract test.

### Task 2: Workflow editor

**Files:**
- Replace `packages/app/src/components/settings-v2/model-router.tsx`
- Create `packages/app/src/components/settings-v2/model-router-models.tsx`
- Create `packages/app/src/components/settings-v2/model-router-routes.tsx`
- Create `packages/app/src/components/settings-v2/model-router.css`
- Modify `packages/app/src/i18n/en.ts`

**Interfaces:** Page owns `ModelRouterFormState` and its Solid store setter.
Child components receive the form, setter, catalog, and action callbacks.
Preview model identity is always `providerID/modelID`.

- [x] Add isolated browser regression for the new bulk-add → rate → select
      task → preview → save flow. Confirm the current editor lacks that flow.
- [x] Build persistent Save/Discard header with dirty/error state. Observe config
      only while pristine; disable form during writes; retain failed edits.
- [x] Add accessible Routing/Models/Advanced tabs. Put auto-routing and readable
      task/agent mapping cards on Routing with presets and advisory top matches.
- [x] Build searchable scored model cards and bulk-add dialog with provider
      names. Use native labeled range inputs and task toggle buttons; retain
      unavailable saved models. Avoid typing comma-separated validated tags.
- [x] Add provider-selection checkboxes and a clear automatic Ollama scope mode.
      Offer only actual provider IDs from the Map and configured providers.
- [x] Move fallback/override and exact weights to Advanced. Preserve raw numeric
      drafts, annotate invalid fields, block saves, and make Discard available.
- [x] Add localization keys and component-scoped responsive logical CSS.

### Task 3: Verification and review

**Files:** Create `packages/app/e2e/regression/model-router.spec.ts` using existing
mock-server utilities and package Playwright configuration.

- [x] Run focused browser regressions against an isolated fixture with no live
      config writes. Exercise saving errors and recovery, discard, custom
      providers, tab persistence, and score/task-dependent previews.
- [x] Check English LTR/RTL and narrow layouts for overflow, correct focus/tab
      navigation, portaled picker behavior, and mixed-direction model names.
- [x] Run `bun typecheck` and focused payload/preview tests from `packages/app`.
- [x] Review `git diff --check` and final diff; address regressions and document
      any environment-limited checks accurately.

## Review follow-up

The read-only review identified a stale-baseline issue when configuration
refreshes during editing. Two SSE-driven browser regressions reproduced it:
after editing a weight to 0.8 while the server changes its saved value from 0.6
to 0.2, both Discard and manual undo incorrectly restored 0.6. Incoming config
is now retained while editing and adopted when the editor becomes pristine;
successful writes establish their own baseline. Both regressions pass. The
follow-up review confirmed the blocking finding is addressed.

The four `.d.ts` files emitted outside the app by the initial cross-package
test imports were removed. Contract imports now live only in `test-browser`.

## Final verification

Run from `packages/app`:

- `bun typecheck` — passed.
- `bun run typecheck:e2e` — passed.
- `bun test src/components/settings-v2/model-router-payload.test.ts src/components/settings-v2/model-router-preview.test.ts` — 37 passed.
- `bun test --conditions=browser --preload ./happydom.ts ./test-browser/model-router-contract.test.ts` — 1 passed, 72 parity assertions.
- `PLAYWRIGHT_PORT=4456 bunx playwright test e2e/regression/model-router.spec.ts --reporter=line --output=/tmp/opencode/router-test-results` — 10 passed.
- Prettier check of the new/rebuilt UI, preview, CSS, and browser tests — passed.

`git diff --check` passed. Browser verification used the existing Playwright
runner and isolated API fixtures. Screenshots were inspected for desktop and
narrow layouts; keyboard tabs were tested in English LTR/RTL and mixed-script
model labels in the Arabic locale. The installed desktop app was not restarted
or rebuilt.
