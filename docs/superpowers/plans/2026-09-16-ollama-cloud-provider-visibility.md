# Ollama Cloud Provider Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Ollama Cloud directly in the main Popular providers list.

**Architecture:** Keep `popularProviders` as the ordering policy used by Settings and its existing consumers. Add the existing `ollama-cloud` catalog ID to that ordering and protect its placement with a focused unit test; provider metadata and authentication remain catalog-driven.

**Tech Stack:** TypeScript, SolidJS, Bun test

## Global Constraints

- Preserve the existing provider catalog, connection flow, and authentication behavior.
- Do not add provider-specific rendering or provider metadata.
- Do not change unrelated provider ordering.
- Keep Ollama Local visibility unchanged.
- Do not restart the existing app or backend processes.
- Do not change the V2 provider API contract; separating V2 connection candidates from connected providers is outside this task.

---

### Task 1: Promote Ollama Cloud Into The Shared Popular Ordering

**Files:**
- Create: `packages/app/src/hooks/use-providers.test.ts`
- Modify: `packages/app/src/hooks/use-providers.ts:8-17`

**Interfaces:**
- Consumes: the existing provider catalog ID `ollama-cloud` and exported `popularProviders: string[]`.
- Produces: a shared ordering in which `ollama-cloud` appears immediately after `google` and before `openrouter`.

- [ ] **Step 1: Write the failing ordering test**

Create `packages/app/src/hooks/use-providers.test.ts`:

```ts
import { expect, test } from "bun:test"
import { popularProviders } from "./use-providers"

test("includes Ollama Cloud with the direct model providers", () => {
  const google = popularProviders.indexOf("google")
  const ollama = popularProviders.indexOf("ollama-cloud")
  const openrouter = popularProviders.indexOf("openrouter")

  expect(ollama).toBe(google + 1)
  expect(openrouter).toBe(ollama + 1)
})
```

- [ ] **Step 2: Run the test and verify the missing provider causes failure**

Run from `packages/app`:

```bash
bun test --conditions=solid --preload ./happydom.ts src/hooks/use-providers.test.ts
```

Expected: FAIL because `popularProviders.indexOf("ollama-cloud")` returns `-1`.

- [ ] **Step 3: Add Ollama Cloud to the shared ordering**

Update the relevant portion of `popularProviders` in `packages/app/src/hooks/use-providers.ts`:

```ts
  "openai",
  "google",
  "ollama-cloud",
  "openrouter",
  "vercel",
```

- [ ] **Step 4: Run focused tests**

Run from `packages/app`:

```bash
bun test --conditions=solid --preload ./happydom.ts src/hooks/use-providers.test.ts src/hooks/provider-catalog.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run the app typecheck**

Run from `packages/app`:

```bash
bun typecheck
```

Expected: exit code 0.

- [ ] **Step 6: Browser-check the main provider list**

Using the already-running app, open Settings > Providers. Confirm `Ollama Cloud`
appears in the initial Popular providers section between Google and OpenRouter,
without opening "Show more providers". Confirm the browser reports no failed
provider API requests. Do not restart the app or backend.

- [ ] **Step 7: Commit the implementation**

```bash
git add packages/app/src/hooks/use-providers.ts packages/app/src/hooks/use-providers.test.ts
git commit -m "fix(app): show Ollama Cloud in popular providers"
```
