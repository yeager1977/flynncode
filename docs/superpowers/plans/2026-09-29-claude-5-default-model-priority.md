# Claude 5 Default-Model Priority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the default-model priority list rank Claude 5.x models (Sonnet 5.5 first) instead of defaulting Anthropic users to claude-sonnet-4-6.

**Architecture:** One-line change to the hardcoded `priority` substring array in `packages/opencode/src/provider/provider.ts` (~line 2178), which drives `sort()` and default-model resolution. Under `sort()`'s verified descending findIndex semantics (last matching entry wins), `claude-sonnet` moves to the last position and `claude-opus-5` is inserted at index 1 as a Sonnet-less fallback.

**Tech Stack:** TypeScript, Bun test runner, remeda `sortBy` (existing).

**Spec:** `docs/superpowers/specs/2026-09-29-claude-5-default-model-priority-design.md` (amended: `380a13eeac`)

## Global Constraints

- Default branch is `dev`; diff against `dev` or `origin/dev` (`main` may not exist).
- Branch name: at most three hyphen-separated words, no slashes or type prefixes → use `claude-5-priority`.
- Conventional commits: `fix(provider): ...` / `test(provider): ...`.
- Tests MUST be run from `packages/opencode`, never the repo root.
- Type checking: `bun typecheck` from `packages/opencode`, never `tsc` directly.
- Do not commit anything beyond this plan's stated files (repo has unrelated pre-existing dirty files — leave them).
- No suppressions: no `as any` in new production code (the test file's local `as any[]` fixture convention is preserved, matching the existing test at line 996).

---

### Task 1: Re-rank `priority` array with TDD ranking tests

**Files:**
- Modify: `packages/opencode/src/provider/provider.ts:2178`
- Test: `packages/opencode/test/provider/provider.test.ts` (insert new tests directly after the existing `test("provider.sort prioritizes preferred models", ...)` block, which ends near line 1003)

**Interfaces:**
- Consumes: `Provider.sort` (exported at `provider.ts:2208-2215`, already imported by the test file — existing tests call `Provider.sort(models)` at line 998).
- Produces: reordered module-level `const priority: string[]`; no exported signatures change. Consumers unaffected structurally: `provider.ts:1200` (`closest()`), `provider.ts:2158` (`defaultModel`), `acp/directory.ts:70`, `acp/service.ts:811-814`, `provider.test.ts:998`.

- [ ] **Step 1: Create the branch**

```bash
git -C /home/yeager1977/GitHub/flynncode checkout dev
git -C /home/yeager1977/GitHub/flynncode checkout -b claude-5-priority
```

Expected: branch created from `dev`.

- [ ] **Step 2: Write the failing tests**

Insert three tests immediately after the closing `})` of
`test("provider.sort prioritizes preferred models", ...)` (ends ~line 1003), before
`it.instance(`"multiple providers can be configured simultaneously"...` (~line 1005).
Match the file's local fixture convention (`as any[]`):

```ts
test("provider.sort ranks newest Claude 5.x Sonnet above Sonnet 4.6 and Opus 5", () => {
  const models = [
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  ] as any[]

  const sorted = Provider.sort(models)
  expect(sorted[0].id).toBe("claude-sonnet-5-5")
  expect(sorted[1].id).toBe("claude-sonnet-4-6")
  expect(sorted[2].id).toBe("claude-opus-5")
})

test("provider.sort falls back to Claude Opus 5 when no Sonnet model exists", () => {
  const models = [
    { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
    { id: "aa-legacy-model", name: "Legacy" },
    { id: "claude-opus-5", name: "Claude Opus 5" },
  ] as any[]

  const sorted = Provider.sort(models)
  expect(sorted[0].id).toBe("claude-opus-5")
})

test("provider.sort prefers the Sonnet family over Opus even for dated legacy IDs", () => {
  const models = [
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5 snapshot" },
  ] as any[]

  const sorted = Provider.sort(models)
  expect(sorted[0].id).toBe("claude-sonnet-4-5-20250929")
})
```

Semantics being pinned (verified by dry run against the real `sort()` at
`provider.ts:2208-2215`; rank = `priority.findIndex(f => id.includes(f))`, **descending**
so the last matching entry wins; tiebreaks: `latest`-containing IDs first, then ID descending):

1. Both `claude-sonnet-5-5` and `claude-sonnet-4-6` share rank 4 (`claude-sonnet`,
   last entry); id-descending tiebreak puts `claude-sonnet-5-5` first. `claude-opus-5`
   ranks 1 → last.
2. `claude-opus-5` (rank 1) beats unranked models (`claude-fable-5-1` — deliberately
   excluded from `priority`, `some-legacy-model`). No `claude-sonnet` present, so Opus
   is the fallback default.
3. Dated `claude-sonnet-4-5-20250929` also matches `claude-sonnet` (rank 4) —
   Sonnet-first family preference outweighs Opus recency. Intentional per spec.

- [ ] **Step 3: Run the new tests to verify they FAIL**

Run from `packages/opencode` (never repo root):

```bash
cd packages/opencode && bun test test/provider/provider.test.ts -t "provider.sort"
```

Expected: FAIL — under the current array `["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]`, the 5.x models are unranked (rank -1), so test 1 sorts `claude-sonnet-5-5` into second place behind `claude-sonnet-4-6` (and test 2 puts `some-legacy-model` first). The existing test `provider.sort prioritizes preferred models` must PASS at this point (it is regression-neutral; if it already fails, STOP and investigate before proceeding).

- [ ] **Step 4: Update the `priority` array**

In `packages/opencode/src/provider/provider.ts` at line ~2178 (just above the
`familyWinner` comment block, below `Service`), replace:

```ts
const priority = ["gpt-5", "claude-sonnet-4", "big-pickle", "gemini-3-pro"]
```

with:

```ts
// Ranking substring list; sort() uses findIndex under a DESCENDING modifier,
// so the LAST matching entry wins. claude-sonnet sits last so every Sonnet
// generation outranks Opus in default-model selection; claude-opus-5 (rank 1)
// is the fallback when no Sonnet is in the catalog.
const priority = ["gpt-5", "claude-opus-5", "big-pickle", "gemini-3-pro", "claude-sonnet"]
```

Must-not-touch constraints for this task: `smallModelFamilyPriority` (line ~2179), the
`familyWinner` function body, `transform.ts` (already 5.x-correct),
`provider-family.ts` router tiers, `omo-catalog.ts`, and all files in `packages/app`,
`packages/core`, `packages/llm`.

- [ ] **Step 5: Run the new tests to verify they PASS**

```bash
cd packages/opencode && bun test test/provider/provider.test.ts -t "provider.sort"
```

Expected: PASS — all four `provider.sort` tests (three new + existing
"prioritizes preferred models", which is invariant under both arrays).

- [ ] **Step 6: Run the full provider test directory for regressions**

```bash
cd packages/opencode && bun test test/provider/
```

Expected: PASS. The default-model `it.instance` tests (e.g. "defaultModel uses
model_family openai tier model", "defaultModel respects config model setting")
must be unaffected: they pin OpenAI-family tier resolution (`familyWinner`) and
explicit `cfg.model`, not the `priority` array. If any test asserting a Claude
default fails, STOP — do not tune the test; re-check against the spec's
consequence table and consult before changing an assertion.

- [ ] **Step 7: Run the model-router suite (spec spot-check)**

```bash
cd packages/opencode && bun test test/plugin/ollama-model-router/
```

Expected: PASS unchanged — router tiers (`provider-family.ts`) are untouched by
this change and still resolve `claude-opus-5-5` (flagship) / `claude-sonnet-5`
(balanced) / `claude-fable-5-1` (balanced-writing).

- [ ] **Step 8: Typecheck**

```bash
cd packages/opencode && bun typecheck
```

Expected: exit 0, no new errors (an empty change-set must already be clean; if
pre-existing errors surface, note them and confirm they exist on `dev` before
proceeding).

- [ ] **Step 9: LSP diagnostics on the changed file**

Run LSP diagnostics on `packages/opencode/src/provider/provider.ts`.

Expected: no new errors or warnings attributable to the edit.

- [ ] **Step 10: Commit**

```bash
git -C /home/yeager1977/GitHub/flynncode add packages/opencode/src/provider/provider.ts packages/opencode/test/provider/provider.test.ts
git -C /home/yeager1977/GitHub/flynncode commit -m "fix(provider): rank Claude 5.x models in default-model priority"
```

Expected: exactly two files staged (leave unrelated pre-existing dirty files unstaged), commit on branch `claude-5-priority`.

---

## Self-Review

- **Spec coverage:** `priority` array change (Task 1 Step 4) ✓; three ranking
  assertions incl. the spec's consequence table rows A, B, C (Step 2) ✓;
  invariant guard on existing sort test (Step 2's neighbor + Step 5 expectation)
  ✓; full provider regression run (Step 6) ✓; router spot-check (Step 7) ✓;
  typecheck (Step 8) ✓; no-SDK-regen/no-schema notes honored (nothing to do) ✓.
- **Placeholder scan:** no TBDs; every code step shows actual code; every run
  step shows the exact command and expected result.
- **Type consistency:** all three new tests use the same fixture shape and
  `Provider.sort` call as the existing test at line 990-1003 (import already
  present in the file).